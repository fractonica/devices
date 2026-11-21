// The hubs' link (design multi-hub-m2 §3): one TLS connection between every pair of hubs of a network, with the
// network key as its pre-shared key (no certificates). This module is the transport and nothing above it: a listener,
// a dialer per peer, the handshake (`hello`), the rule that leaves one connection per pair, the heartbeat, and frames
// in and out (wire.ts). Who the peers are, where to look for each and what the messages mean come from its owner
// (index.ts) through PeerLinksDeps, so it runs in a test with two instances and no hub.
//
// - Trust. `ECDHE-PSK-CHACHA20-POLY1305` on TLS 1.2: forward secrecy, and a wrong key fails the handshake (tried on
//   Node 24.22 / OpenSSL 3.5.8; TLS 1.3's wrong-key path was not, so 1.3 is not offered). The PSK identity is
//   `fr-net-<net id>`, so a hub of another network is refused before any key is tried. A hub that holds no key has no
//   link: the listener's callback answers no key, and nothing is dialled.
// - The handshake. Each end sends `hello` first. An end that takes the other's hello (its own network, a member it
//   knows) answers `ready`; one that does not answers `refuse` with the reason and closes. A connection is in use
//   only once both ends said `ready`, so a hub the other end refuses never counts that hub reachable.
// - One connection per pair. Both ends may dial (one of them may be unable to: a firewall, macOS's Local Network
//   permission). Of two connections between one pair the one the hub with the LOWER hub id dialled is kept; both ends
//   apply the rule to the same two connections, so they keep the same one. A second connection dialled by the same
//   end replaces the first (its owner would not dial again while the first lived).
// - Away. A ping every 2 s; a peer that sent nothing for 6 s is away: its connection is closed and its owner told.
//   Dialling starts again at once and backs off 0.25 s → 5 s while it fails.
// - Where a peer is (§3.2): its host name, then the address its link last came from, then the address in the member
//   list. Each attempt walks them in that order.

import type { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import tls from 'node:tls';

import { guarded } from '../crash.ts';
import { pskIdentity } from './key.ts';
import { encodeControl, encodeData, FrameDecoder, type Hello, PEER_WIRE, type PeerMessage, WireError } from './wire.ts';

const TLS_OPTIONS = { ciphers: 'ECDHE-PSK-CHACHA20-POLY1305', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' } as const;
/** One refusal of one hub (or address) is logged at most this often: a refused hub tries again every few seconds. */
const REFUSAL_LOG_MS = 60_000;
/** A listener that could not bind (the port still held by the hub this one replaces) is tried again this often. */
const LISTEN_RETRY_MS = 30_000;
/** Control messages queued on a connection past this are a peer that stopped reading: it is closed. */
const MAX_QUEUED_BYTES = 8 << 20;
/**
 * A sender of data frames waits (`drained`) while more than this is queued on the connection, so a file never fills
 * the queue: a ping or a control message written meanwhile waits behind at most this much, and MAX_QUEUED_BYTES is
 * never reached by data.
 */
export const DATA_HIGH_WATER = 512 * 1024;

export interface PeerLinkTiming {
  /** A ping this often on a connection that is up. */
  pingMs: number;
  /** Nothing received for this long: the peer is away. */
  awayMs: number;
  /** The wait before the next attempt to reach a peer, doubling from the first to the second. */
  backoffMinMs: number;
  backoffMaxMs: number;
  /** One candidate address may take this long to give a TLS session. */
  connectMs: number;
  /** A connection that says no hello within this is closed. */
  helloMs: number;
}

export const PEER_LINK_TIMING: PeerLinkTiming = { pingMs: 2000, awayMs: 6000, backoffMinMs: 250, backoffMaxMs: 5000, connectMs: 3000, helloMs: 5000 };

/** A hub to keep a connection with, and where to look for it, in order. */
export interface LinkTarget {
  id: string;
  name: string;
  candidates: { host: string; port: number }[];
}

/** One peer as its owner sees it. */
export interface PeerView {
  id: string;
  name: string;
  reachable: boolean;
  /** Unix ms it became reachable or went away; null before either. */
  since: number | null;
  /** Its last hello in this hub run. */
  hello: Hello | null;
  /** `<address>:<port>` of the connection in use, and which end dialled it. */
  address: string | null;
  direction: 'out' | 'in' | null;
  rtt_ms: number | null;
  /** Why the last attempt to reach it failed (cleared when it is reached). */
  last_error: string | null;
  /** Which connection is in use: it changes when another takes its place (a data channel does not outlive its own). */
  conn: number | null;
}

/** What a hub says of itself in a hello (wire.ts HelloSchema, without the envelope). */
export interface HelloInfo {
  hub_id: string;
  name: string;
  net: number;
  registry_hash: string;
  hub_epoch: number;
  members_version: number;
  link_port?: number;
  hub_version?: string;
  /** The `registry` message's version this hub speaks; left out by a hub that does not replicate. */
  registry?: number;
  /** The `event` message's and the `stream` channel's versions (step 2.4); left out by a hub that relays neither. */
  events?: number;
  streams?: number;
}

export interface PeerLinksDeps {
  /** Where the listener binds; port 0 takes any free one (a test hub). */
  listen: { host: string; port: number };
  /** The network key and its net id now; null on a hub that holds none. */
  key(): { key: Buffer; net: number } | null;
  /** What this hub says of itself in a hello, read at each one. */
  hello(): HelloInfo;
  /** Every member but this hub. */
  targets(): LinkTarget[];
  /** A connection with the peer is in use: at first contact, and again when another connection takes its place. */
  onUp(peer: PeerView): void;
  /** The peer went away (its connection closed or fell silent). */
  onDown(peer: PeerView, why: string): void;
  /** A message on the connection in use. */
  onMessage(peer: PeerView, msg: PeerMessage): void;
  /** Bytes of a data channel on the connection in use (a view of the received chunk: used or copied before returning). */
  onData?(peer: PeerView, ch: number, bytes: Buffer): void;
  /** Where a peer's link came from: remembered as the address it last had. */
  onSeen?(hubId: string, addr: string, port: number): void;
  timing?: Partial<PeerLinkTiming>;
  /** One JSON line for hub.log; never a key. */
  log?(line: Record<string, unknown>): void;
}

interface Conn {
  socket: tls.TLSSocket;
  /** This hub dialled it. */
  dialled: boolean;
  /** The peer a dial looks for (null on an accepted connection). */
  dialFor: PeerState | null;
  /** The peer it turned out to be, after its hello (this end then said `ready`). */
  peer: PeerState | null;
  /** The other end said `ready`: it took this hub's hello. */
  peerReady: boolean;
  hello: Hello | null;
  /** A dialled connection's attempt hears how it ended: it became the peer's connection, or it closed without. */
  dialDone: ((won: boolean) => void) | null;
  decoder: FrameDecoder;
  lastRx: number;
  lastPing: number;
  pingN: number;
  pingAt: number;
  helloTimer: NodeJS.Timeout | null;
  closed: boolean;
  why: string | null;
  address: string;
  /** Its number among this hub run's connections (PeerView.conn). */
  n: number;
}

interface PeerState {
  target: LinkTarget;
  conn: Conn | null;
  /** A dial attempt (a walk over the candidates) is under way. */
  dialing: boolean;
  timer: NodeJS.Timeout | null;
  backoff: number;
  reachable: boolean;
  since: number | null;
  hello: Hello | null;
  rtt: number | null;
  lastError: string | null;
}

export interface PeerLinkCounters {
  /** TLS handshakes this hub's listener refused (a wrong key, another network's identity, no key held). */
  handshake_refused: number;
  /** Connections closed after their hello: another network, an unknown hub, this hub itself, another framing. */
  hello_refused: number;
  /** Second connections of a pair closed by the lower-id rule. */
  duplicates_closed: number;
  /** Peers that fell silent past awayMs. */
  away: number;
  /** Control messages of a type or shape this step does not know, and data frames received (the channels', channels.ts). */
  unknown: number;
  data_frames: number;
}

const stripV4 = (addr: string | undefined) => (addr ?? '').replace(/^::ffff:/, '');

/** What went wrong with a socket, in words that carry no secret (OpenSSL's text names files and alerts, not keys). */
function describe(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC' || code === 'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC') {
    return 'the TLS handshake failed: the two hubs hold different network keys';
  }
  if (code === 'ERR_SSL_TLSV1_ALERT_UNKNOWN_PSK_IDENTITY' || code === 'ERR_SSL_PSK_IDENTITY_NOT_FOUND') {
    return 'the TLS handshake failed: that hub is in another network, or holds no network key';
  }
  return typeof code === 'string' ? code : e instanceof Error ? e.message.split('\n')[0].slice(0, 120) : String(e);
}

export class PeerLinks {
  #deps: PeerLinksDeps;
  #t: PeerLinkTiming;
  #server: tls.Server | null = null;
  #port: number | null = null;
  #listenError: string | null = null;
  /** The bind under way (two callers get one listener), and when the last one was tried. */
  #binding: Promise<number | null> | null = null;
  #listenTriedAt = 0;
  /** Every accepted TCP connection, its TLS handshake done or not: closing the listener ends them all. */
  #accepted = new Set<Socket>();
  #peers = new Map<string, PeerState>();
  #conns = new Set<Conn>();
  #ticker: NodeJS.Timeout | null = null;
  #stopped = true;
  /** When each refusal was last logged, by who and why (REFUSAL_LOG_MS). */
  #refusalLogged = new Map<string, number>();
  /** The key the connections in use were made with: another one (a join into another network) ends them all. */
  #keyed: Buffer | null = null;
  #connN = 0;
  readonly counters: PeerLinkCounters = { handshake_refused: 0, hello_refused: 0, duplicates_closed: 0, away: 0, unknown: 0, data_frames: 0 };

  constructor(deps: PeerLinksDeps) {
    this.#deps = deps;
    this.#t = { ...PEER_LINK_TIMING, ...deps.timing };
  }

  /** The bound port; null while the listener is not up. */
  port(): number | null {
    return this.#port;
  }

  listenError(): string | null {
    return this.#listenError;
  }

  /**
   * Binds the listener (once) and returns its port, or null when it cannot bind (listenError says why; the hub can
   * still dial). A join calls it before it holds a key, to tell the registrar a port that is really this hub's: until
   * the key is there the listener refuses every handshake.
   */
  listen(): Promise<number | null> {
    if (this.#server) {
      return Promise.resolve(this.#port);
    }
    this.#binding ??= this.#bind().finally(() => {
      this.#binding = null;
    });
    return this.#binding;
  }

  async #bind(): Promise<number | null> {
    this.#listenTriedAt = performance.now();
    const server = tls.createServer({
      ...TLS_OPTIONS,
      pskCallback: (_socket, identity) => {
        const k = this.#deps.key();
        return k && identity === pskIdentity(k.net) ? k.key : null;
      },
    });
    server.on('connection', (socket: Socket) => {
      this.#accepted.add(socket);
      socket.once('close', () => this.#accepted.delete(socket));
    });
    server.on('secureConnection', (socket) => this.#adopt(socket, null));
    server.on('tlsClientError', (e, socket) => {
      this.counters.handshake_refused++;
      const from = stripV4((socket as { remoteAddress?: string }).remoteAddress);
      const why = describe(e);
      this.#logRefusal(`tls ${from} ${why}`, { event: 'peer_handshake_refused', from, why, refused: this.counters.handshake_refused });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.#deps.listen.port, this.#deps.listen.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (e) {
      this.#listenError = `${this.#deps.listen.host}:${this.#deps.listen.port}: ${describe(e)}`;
      this.#log({ event: 'peer_link_failed', message: this.#listenError });
      return null;
    }
    server.on('error', (e) => this.#log({ event: 'peer_link_error', message: describe(e) }));
    this.#server = server;
    this.#listenError = null;
    this.#port = (server.address() as { port: number }).port;
    this.#log({ event: 'peer_link_listening', host: this.#deps.listen.host, port: this.#port });
    return this.#port;
  }

  /**
   * Brings the link in line with the key and the member list as they are now: called at the start and after each
   * change of either. With a key: the listener is up, every member has a peer entry and is dialled unless a connection
   * with it is in use, and peers that left the list are dropped. Without one: nothing listens and nothing is dialled.
   */
  async sync(): Promise<void> {
    this.#stopped = false;
    const k = this.#deps.key();
    if (!k) {
      this.#closeAll('no network key');
      await this.#unlisten();
      return;
    }
    if (this.#keyed && !this.#keyed.equals(k.key)) {
      this.#closeAll('the network key changed');
    }
    this.#keyed = k.key;
    await this.listen();
    const targets = new Map(this.#deps.targets().map((t) => [t.id, t]));
    for (const [id, p] of this.#peers) {
      if (!targets.has(id)) {
        this.#peers.delete(id);
        this.#clearTimer(p);
        if (p.conn) {
          this.#close(p.conn, 'no longer a member');
        }
      }
    }
    for (const t of targets.values()) {
      const have = this.#peers.get(t.id);
      if (have) {
        have.target = t;
      } else {
        const p: PeerState = { target: t, conn: null, dialing: false, timer: null, backoff: this.#t.backoffMinMs, reachable: false, since: null, hello: null, rtt: null, lastError: null };
        this.#peers.set(t.id, p);
        this.#schedule(p, 0);
      }
    }
    if (!this.#ticker) {
      const every = Math.max(20, Math.floor(Math.min(this.#t.pingMs, this.#t.awayMs) / 4));
      this.#ticker = setInterval(guarded('peers.tick', () => this.#tick()), every);
      this.#ticker.unref();
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#ticker) {
      clearInterval(this.#ticker);
      this.#ticker = null;
    }
    this.#closeAll('hub stopping');
    await this.#unlisten();
  }

  /** Open connections, the ones still in their handshake or about to close included (one per pair once settled). */
  connections(): number {
    return this.#conns.size;
  }

  views(): PeerView[] {
    return [...this.#peers.values()].map((p) => this.#view(p));
  }

  view(hubId: string): PeerView | null {
    const p = this.#peers.get(hubId);
    return p ? this.#view(p) : null;
  }

  /** One message to a peer over the connection in use; false when there is none. */
  send(hubId: string, msg: PeerMessage): boolean {
    const conn = this.#peers.get(hubId)?.conn;
    return conn ? this.#write(conn, msg) : false;
  }

  /** One control frame already encoded (wire.ts encodeControlJson) to a peer; false when there is no connection. */
  sendFrame(hubId: string, frame: Buffer): boolean {
    const conn = this.#peers.get(hubId)?.conn;
    return conn ? this.#writeFrame(conn, frame) : false;
  }

  /** Bytes of data channel `ch` to a peer over the connection in use; false when there is none (or it is another one than `conn`). */
  sendData(hubId: string, ch: number, bytes: Uint8Array, conn?: number): boolean {
    const c = this.#peers.get(hubId)?.conn;
    return c && (conn === undefined || c.n === conn) ? this.#writeFrame(c, encodeData(ch, bytes)) : false;
  }

  /**
   * Resolves once the connection to a peer has no more than DATA_HIGH_WATER queued (true), or is gone (false): what
   * a sender of data waits for between chunks, so the socket's queue is its backpressure.
   */
  drained(hubId: string, conn?: number): Promise<boolean> {
    const c = this.#peers.get(hubId)?.conn;
    if (!c || c.closed || (conn !== undefined && c.n !== conn)) {
      return Promise.resolve(false);
    }
    if (c.socket.writableLength <= DATA_HIGH_WATER) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        c.socket.off('drain', onDrain);
        c.socket.off('close', onClose);
        resolve(ok);
      };
      const onDrain = () => done(!c.closed);
      const onClose = () => done(false);
      c.socket.once('drain', onDrain);
      c.socket.once('close', onClose);
    });
  }

  /**
   * Bytes queued on the connection to a peer and not yet written (null without one): a sender of live data (events,
   * a stream's blocks) holds back or drops while it is high, so pings and calls never wait behind it.
   */
  backlog(hubId: string, conn?: number): number | null {
    const c = this.#peers.get(hubId)?.conn;
    return c && !c.closed && (conn === undefined || c.n === conn) ? c.socket.writableLength : null;
  }

  /** One message to every reachable peer; how many took it. */
  broadcast(msg: PeerMessage): number {
    let n = 0;
    const frame = encodeControl(msg);
    for (const p of this.#peers.values()) {
      if (p.conn && this.#writeFrame(p.conn, frame)) {
        n++;
      }
    }
    return n;
  }

  // ---- connections ----

  #adopt(socket: tls.TLSSocket, dialFor: PeerState | null): Conn {
    const now = performance.now();
    const conn: Conn = {
      socket,
      dialled: dialFor !== null,
      dialFor,
      peer: null,
      peerReady: false,
      hello: null,
      dialDone: null,
      decoder: new FrameDecoder(),
      lastRx: now,
      lastPing: now,
      pingN: 0,
      pingAt: 0,
      helloTimer: null,
      closed: false,
      why: null,
      address: `${stripV4(socket.remoteAddress)}:${socket.remotePort ?? 0}`,
      n: ++this.#connN,
    };
    this.#conns.add(conn);
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.#data(conn, chunk));
    socket.on('error', (e) => {
      conn.why ??= describe(e);
    });
    socket.on('close', () => this.#closed(conn));
    conn.helloTimer = setTimeout(() => this.#close(conn, conn.peer ? 'its hello was not answered' : 'no hello'), this.#t.helloMs);
    this.#write(conn, { t: 'hello', v: 1, wire: PEER_WIRE, ...this.#deps.hello() });
    return conn;
  }

  #data(conn: Conn, chunk: Buffer): void {
    if (conn.closed) {
      return;
    }
    conn.lastRx = performance.now();
    let frames;
    try {
      frames = conn.decoder.push(chunk);
    } catch (e) {
      this.#close(conn, e instanceof WireError ? `bad framing: ${e.message}` : 'bad framing');
      return;
    }
    for (const f of frames) {
      if (conn.closed) {
        return;
      }
      if (f.kind === 'data') {
        this.counters.data_frames++;
        const owner = conn.peer;
        if (owner && conn.peerReady && owner.conn === conn) {
          this.#deps.onData?.(this.#view(owner), f.ch, f.bytes);
        }
        continue;
      }
      if (f.kind === 'unknown') {
        this.counters.unknown++;
        continue;
      }
      const msg = f.msg;
      if (msg.t === 'refuse') {
        // Only an answer to this hub's hello: the peer closes next. Kept as the reason the dial failed.
        conn.why = `refused: ${msg.message}`;
        continue;
      }
      if (msg.t === 'hello') {
        if (!conn.peer) {
          this.#hello(conn, msg);
        }
        continue;
      }
      if (msg.t === 'ready') {
        if (!conn.peerReady) {
          conn.peerReady = true;
          this.#established(conn);
        }
        continue;
      }
      const p = conn.peer;
      if (!p || !conn.peerReady) {
        this.#close(conn, `${msg.t} before the hellos were taken`);
        return;
      }
      if (p.conn !== conn) {
        continue; // the pair's other connection is the one in use; this one is about to close
      }
      if (msg.t === 'ping') {
        this.#write(conn, { t: 'pong', v: 1, n: msg.n });
      } else if (msg.t === 'pong') {
        if (msg.n === conn.pingN) {
          p.rtt = Math.round((performance.now() - conn.pingAt) * 10) / 10;
        }
      } else {
        this.#deps.onMessage(this.#view(p), msg);
      }
    }
  }

  #hello(conn: Conn, hello: Hello): void {
    const own = this.#deps.hello();
    const refuse = (code: string, message: string) => {
      this.counters.hello_refused++;
      this.#logRefusal(`hello ${hello.hub_id} ${code}`, { event: 'peer_refused', code, hub: hello.name, id: hello.hub_id, from: conn.address, message });
      this.#write(conn, { t: 'refuse', v: 1, code, message });
      this.#close(conn, message, true);
    };
    if (hello.wire !== PEER_WIRE) {
      return refuse('wire', `hub ${own.name} speaks peer wire ${PEER_WIRE}, not ${hello.wire}`);
    }
    if (hello.net !== own.net) {
      return refuse('net', `hub ${own.name} is in network ${own.net}, not ${hello.net}`);
    }
    if (hello.hub_id === own.hub_id) {
      return refuse('self', `hub ${own.name} reached itself`);
    }
    const p = this.#peers.get(hello.hub_id);
    if (!p) {
      return refuse('unknown_hub', `hub ${hello.name} (${hello.hub_id}) is not in the member list of hub ${own.name} (version ${own.members_version})`);
    }
    if (conn.dialFor && conn.dialFor !== p) {
      // The address was another member's: not the hub this attempt looks for. That member has its own dialer.
      this.#close(conn, `${conn.address} is ${hello.name}, not ${conn.dialFor.target.name}`);
      return;
    }
    conn.peer = p;
    conn.hello = hello;
    this.#write(conn, { t: 'ready', v: 1 });
    this.#established(conn);
  }

  /**
   * Both ends took each other's hello (this end named the peer, the other said `ready`): the connection becomes the
   * pair's, unless the pair has one that the rule keeps.
   */
  #established(conn: Conn): void {
    const p = conn.peer;
    const hello = conn.hello;
    if (!p || !hello || !conn.peerReady || conn.closed || this.#peers.get(p.target.id) !== p) {
      return;
    }
    if (conn.helloTimer) {
      clearTimeout(conn.helloTimer);
      conn.helloTimer = null;
    }
    const own = this.#deps.hello();
    p.hello = hello;
    const other = p.conn;
    if (other && other !== conn) {
      // One connection per pair: the one the lower hub id dialled. Both ends see the same two and keep the same one.
      const dialler = (c: Conn) => (c.dialled ? own.hub_id : hello.hub_id);
      const keepNew = dialler(conn) === dialler(other) || dialler(conn) < dialler(other);
      this.counters.duplicates_closed++;
      if (!keepNew) {
        this.#close(conn, 'the pair already has a connection', true);
        return;
      }
      p.conn = conn; // before the close, so the old one's end is not taken for the peer going away
      this.#close(other, 'replaced by the pair\'s other connection', true);
    }
    p.conn = conn;
    conn.dialDone?.(true);
    conn.dialDone = null;
    this.#clearTimer(p);
    p.backoff = this.#t.backoffMinMs;
    p.lastError = null;
    const was = p.reachable;
    p.reachable = true;
    if (!was) {
      p.since = Date.now();
    }
    const addr = stripV4(conn.socket.remoteAddress);
    const port = conn.dialled ? conn.socket.remotePort : hello.link_port;
    if (addr && port) {
      this.#deps.onSeen?.(p.target.id, addr, port);
    }
    this.#log({ event: was ? 'peer_link_replaced' : 'peer_up', hub: hello.name, id: hello.hub_id, address: conn.address, dialled: conn.dialled });
    this.#deps.onUp(this.#view(p));
  }

  /** Ends a connection from this side; `flush` lets what was just written (a refusal) leave first. */
  #close(conn: Conn, why: string, flush = false): void {
    if (conn.closed) {
      return;
    }
    conn.closed = true;
    conn.why = why;
    if (conn.helloTimer) {
      clearTimeout(conn.helloTimer);
      conn.helloTimer = null;
    }
    if (flush) {
      conn.socket.end();
      // A peer that never reads must not hold the socket open.
      setTimeout(() => conn.socket.destroy(), 1000).unref();
    } else {
      conn.socket.destroy();
    }
    // The 'close' event follows; a connection that is the peer's own is handled now, so its owner never sees a
    // closed connection as reachable.
    this.#closed(conn);
  }

  #closed(conn: Conn): void {
    if (!this.#conns.delete(conn)) {
      return;
    }
    conn.closed = true;
    if (conn.helloTimer) {
      clearTimeout(conn.helloTimer);
      conn.helloTimer = null;
    }
    const why = conn.why ?? 'the connection closed';
    const done = conn.dialDone;
    conn.dialDone = null;
    const p = conn.peer ?? conn.dialFor;
    if (p && this.#peers.get(p.target.id) === p && p.conn === conn) {
      p.conn = null;
      p.reachable = false;
      p.since = Date.now();
      p.rtt = null;
      p.lastError = why;
      this.#log({ event: 'peer_down', hub: p.target.name, id: p.target.id, why });
      this.#deps.onDown(this.#view(p), why);
      if (!this.#stopped) {
        this.#schedule(p, this.#t.backoffMinMs);
      }
    }
    done?.(false);
  }

  #closeAll(why: string): void {
    for (const p of this.#peers.values()) {
      this.#clearTimer(p);
    }
    for (const conn of [...this.#conns]) {
      this.#close(conn, why);
    }
    this.#peers.clear();
    this.#keyed = null;
  }

  async #unlisten(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#port = null;
    if (server) {
      // A connection still in its handshake is no Conn yet; left open it would keep close() from ever calling back.
      for (const socket of this.#accepted) {
        socket.destroy();
      }
      await new Promise<void>((r) => server.close(() => r()));
      this.#log({ event: 'peer_link_closed' });
    }
  }

  // ---- dialling ----

  #clearTimer(p: PeerState): void {
    if (p.timer) {
      clearTimeout(p.timer);
      p.timer = null;
    }
  }

  #schedule(p: PeerState, ms: number): void {
    this.#clearTimer(p);
    p.timer = setTimeout(() => {
      p.timer = null;
      this.#dial(p);
    }, ms);
    p.timer.unref();
  }

  /** One attempt: the candidates in order until one gives a connection that passes its hello. */
  #dial(p: PeerState): void {
    if (this.#stopped || p.conn || p.dialing || this.#peers.get(p.target.id) !== p) {
      return;
    }
    const k = this.#deps.key();
    if (!k) {
      return;
    }
    p.dialing = true;
    const candidates = p.target.candidates;
    const next = (i: number, lastError: string | null) => {
      if (this.#stopped || this.#peers.get(p.target.id) !== p) {
        p.dialing = false;
        return;
      }
      if (p.conn) {
        p.dialing = false; // the peer dialled meanwhile, and that connection is in use
        return;
      }
      if (i >= candidates.length) {
        p.dialing = false;
        p.lastError = lastError ?? 'nowhere to look for it';
        const wait = p.backoff;
        p.backoff = Math.min(p.backoff * 2, this.#t.backoffMaxMs);
        this.#schedule(p, wait);
        return;
      }
      const c = candidates[i];
      const at = `${c.host}:${c.port}`;
      let settled = false;
      const fail = (why: string) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          next(i + 1, `${at}: ${why}`);
        }
      };
      const socket = tls.connect({
        ...TLS_OPTIONS,
        host: c.host,
        port: c.port,
        pskCallback: () => ({ psk: k.key, identity: pskIdentity(k.net) }),
        checkServerIdentity: () => undefined,
      });
      const timer = setTimeout(() => {
        socket.destroy();
        fail(`no TLS session within ${this.#t.connectMs} ms`);
      }, this.#t.connectMs);
      const onError = (e: unknown) => {
        socket.destroy();
        fail(describe(e));
      };
      socket.once('error', onError);
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        if (settled) {
          socket.destroy();
          return;
        }
        socket.off('error', onError);
        const conn = this.#adopt(socket, p);
        // The attempt ends here when this connection becomes the peer's; it goes on to the next candidate when the
        // connection closes without (refused, another hub at that address, lost to the pair's other connection:
        // `next` then sees that one in use and stops).
        conn.dialDone = (won) => {
          if (won) {
            settled = true;
            p.dialing = false;
          } else {
            fail(conn.why ?? 'closed before its hello');
          }
        };
      });
    };
    next(0, null);
  }

  // ---- heartbeat ----

  #tick(): void {
    const now = performance.now();
    if (!this.#server && this.#listenError && !this.#binding && now - this.#listenTriedAt >= LISTEN_RETRY_MS && this.#deps.key()) {
      void this.listen();
    }
    for (const p of this.#peers.values()) {
      const conn = p.conn;
      if (!conn) {
        continue;
      }
      const silent = now - conn.lastRx;
      if (silent >= this.#t.awayMs) {
        this.counters.away++;
        this.#close(conn, `silent for ${(silent / 1000).toFixed(1)} s`);
      } else if (now - conn.lastPing >= this.#t.pingMs) {
        conn.lastPing = now;
        conn.pingAt = now;
        this.#write(conn, { t: 'ping', v: 1, n: ++conn.pingN });
      }
    }
  }

  // ---- out ----

  #write(conn: Conn, msg: PeerMessage): boolean {
    return this.#writeFrame(conn, encodeControl(msg));
  }

  #writeFrame(conn: Conn, frame: Buffer): boolean {
    if (conn.closed || conn.socket.destroyed) {
      return false;
    }
    if (conn.socket.writableLength > MAX_QUEUED_BYTES) {
      this.#close(conn, 'the peer stopped reading');
      return false;
    }
    conn.socket.write(frame);
    return true;
  }

  #view(p: PeerState): PeerView {
    return {
      id: p.target.id,
      // The member list's name for it: a hub renamed since its hello is known by its new name at once.
      name: p.target.name,
      reachable: p.reachable,
      since: p.since,
      hello: p.hello,
      address: p.conn?.address ?? null,
      direction: p.conn ? (p.conn.dialled ? 'out' : 'in') : null,
      rtt_ms: p.rtt,
      last_error: p.reachable ? null : p.lastError,
      conn: p.conn?.n ?? null,
    };
  }

  #log(line: Record<string, unknown>): void {
    this.#deps.log?.(line);
  }

  /** A refusal, logged the first time and then at most once a minute for the same hub and reason (the counters count all). */
  #logRefusal(key: string, line: Record<string, unknown>): void {
    const now = performance.now();
    const last = this.#refusalLogged.get(key);
    if (last !== undefined && now - last < REFUSAL_LOG_MS) {
      return;
    }
    if (this.#refusalLogged.size > 256) {
      this.#refusalLogged.clear();
    }
    this.#refusalLogged.set(key, now);
    this.#log(line);
  }
}
