// Live streams across the hubs' link (design multi-hub-m2 §8, §17, step 2.4): `/app/stream` at hub B for a board hub A
// holds. B opens a data channel of kind `stream` to A with the client's hello (never its token: B checked it); A runs
// the stream exactly as for a client of its own (apps/stream.ts, through the pipe this module gives it) and sends
// every frame down the channel; B hands them to its client unchanged.
//
// The channel is the files' (`open`, `accept`, `ack`, `close`, data frames), with other rules, for live data:
//   - A data frame's first byte says what follows: STREAM_TEXT (one JSON text frame, whole) or bytes of a block,
//     STREAM_BLOCK_MORE while more follow and STREAM_BLOCK_END for its last. A block crosses in pieces of at most
//     DATA_CHUNK, so a ping or a call written meanwhile waits behind one piece, not a camera frame.
//   - Nothing is queued and nothing waits. The pipe tells the stream how much it has sent that the other hub has not
//     taken (`ack`), or how much waits on the connection when that is more; while that is over the stream's high
//     water the stream drops the block (as it does for a slow client of its own) and says so in its next
//     `stream.gap`. A slow link or a slow hub loses blocks, the newest shown first when it recovers; it never makes
//     the holder buffer, and never slows the board.
//   - It ends from either side with `close`: the opener when its client left (the holder then stops a stream that
//     client started), the holder when it refuses or stops. A channel lives on one connection: when the link goes
//     away, or the pair's other connection takes its place, both ends give it up at once.
// This module is the transport and its bounds; what a stream is belongs to apps/stream.ts on both hubs.

import type { PeerLinks, PeerView } from './link.ts';
import { DATA_HIGH_WATER } from './link.ts';
import { type AcceptMsg, type AckMsg, type CloseMsg, DATA_CHUNK, type OpenMsg, type PeerMessage, STREAM_BLOCK_END, STREAM_BLOCK_MORE, STREAM_TEXT } from './wire.ts';

/** The kind of a relayed stream's channel. */
export const STREAM_CHANNEL = 'stream';
/** The opener acks at least this often (in bytes taken). */
const ACK_EVERY = 64 * 1024;
/** The largest block a relay carries (a jpeg frame is at most 1 MiB, a csi block 8 KiB). */
export const STREAM_BLOCK_MAX = 2 << 20;
/** A holder that has not answered an `open` after this is given up. */
const OPEN_MS = 10_000;

/** What the opening hub does with what arrives. */
export interface RelaySink {
  /** One text frame of the stream, as the holder wrote it for its client. */
  text(json: string): void;
  /** One block, whole, its exact bytes. */
  block(bytes: Buffer): void;
  /** The relay is over: the holder closed it (`code` a close code or an error code), or the link went away. */
  end(why: { code: string; message: string }): void;
}

export interface RelayHandle {
  /** Ends it from this side (the client left, or the board is followed elsewhere). */
  close(reason: string): void;
}

/** The holder's end of a relayed stream, as a socket: what apps/stream.ts writes its client's frames to. */
export interface StreamPipe {
  /** 1 while open (a WebSocket's OPEN). */
  readonly readyState: number;
  /** Bytes sent that the other hub has not taken, or what waits on the connection when that is more. */
  readonly bufferedAmount: number;
  send(data: string | Uint8Array, opts?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

/** What serves a relayed stream at the holder: it reads the hello, writes to the pipe, and hears when the other hub gives up. */
export type StreamServer = (peer: PeerView, hello: Record<string, unknown>, pipe: StreamPipe) => { closed(): void; readonly gaps: number };

export interface StreamsDeps {
  links: Pick<PeerLinks, 'send' | 'sendData' | 'backlog'>;
  log?(line: Record<string, unknown>): void;
}

interface Incoming {
  peer: string;
  name: string;
  conn: number | null;
  sink: RelaySink;
  got: number;
  acked: number;
  parts: Buffer[];
  partBytes: number;
  timer: NodeJS.Timeout | null;
  done: boolean;
}

interface Outgoing {
  peer: string;
  conn: number | null;
  sent: number;
  acked: number;
  open: boolean;
  served: { closed(): void; readonly gaps: number } | null;
}

export interface StreamCounters {
  /** Relays this hub opened at a peer (its clients watching a peer's board) and served for one, since start. */
  streams_opened: number;
  streams_served: number;
  streams_refused: number;
  stream_bytes_in: number;
  stream_bytes_out: number;
  stream_blocks_in: number;
  stream_blocks_out: number;
  /** Blocks a holder did not send because the link or the other hub was behind. */
  stream_blocks_dropped: number;
}

export class PeerStreams {
  #deps: StreamsDeps;
  #server: StreamServer | null = null;
  /** Relays this hub opened: `<hub id>:<ch>`. */
  #in = new Map<string, Incoming>();
  /** Relays a peer opened here. */
  #out = new Map<string, Outgoing>();
  /** Channel numbers from the upper half, so they never meet the files' (channels.ts counts from 1). */
  #n = 0x40000000;
  readonly counters: StreamCounters = { streams_opened: 0, streams_served: 0, streams_refused: 0, stream_bytes_in: 0, stream_bytes_out: 0, stream_blocks_in: 0, stream_blocks_out: 0, stream_blocks_dropped: 0 };

  constructor(deps: StreamsDeps) {
    this.#deps = deps;
  }

  /** What serves the relays that arrive (apps/server.ts, once it runs). */
  serve(fn: StreamServer | null): void {
    this.#server = fn;
  }

  /** Relays open now: [opened here, served here]. */
  open(): { opened: number; served: number } {
    return { opened: this.#in.size, served: this.#out.size };
  }

  /** Per peer: relays open with it either way. */
  openWith(hubId: string): number {
    let n = 0;
    for (const c of this.#in.values()) {
      n += c.peer === hubId ? 1 : 0;
    }
    for (const o of this.#out.values()) {
      n += o.peer === hubId ? 1 : 0;
    }
    return n;
  }

  /**
   * Asks `peer` to run a stream for the hello `ref` and to send its frames here. The sink hears every frame, and the
   * end (also when nothing ever came: an `end` naming why).
   */
  relay(peer: PeerView, ref: Record<string, unknown>, sink: RelaySink): RelayHandle {
    this.#n = this.#n >= 0x7ffffffe ? 0x40000001 : this.#n + 1;
    const ch = this.#n;
    const key = `${peer.id}:${ch}`;
    const c: Incoming = { peer: peer.id, name: peer.name, conn: peer.conn, sink, got: 0, acked: 0, parts: [], partBytes: 0, timer: null, done: false };
    this.#in.set(key, c);
    this.counters.streams_opened++;
    const fail = (code: string, message: string) => queueMicrotask(() => this.#endIn(key, { code, message }, false));
    if (!peer.reachable || !this.#deps.links.send(peer.id, { t: 'open', v: 1, ch, kind: STREAM_CHANNEL, ref })) {
      fail('HUB_UNREACHABLE', `hub ${peer.name} is not reachable`);
    } else {
      c.timer = setTimeout(() => this.#endIn(key, { code: 'TIMEOUT', message: `hub ${peer.name} did not answer within ${OPEN_MS / 1000} s` }, true), OPEN_MS);
      c.timer.unref();
    }
    return { close: (reason) => this.#endIn(key, null, true, reason) };
  }

  /** A channel message that is a relayed stream's; false for another (a file's). */
  onMessage(peer: PeerView, msg: PeerMessage): boolean {
    if (msg.t === 'open') {
      if (msg.kind !== STREAM_CHANNEL || !this.#server) {
        return false; // the files' channels answer: a hub that serves no streams says so there
      }
      this.#serve(peer, msg);
      return true;
    }
    if (msg.t !== 'accept' && msg.t !== 'ack' && msg.t !== 'close') {
      return false;
    }
    const key = `${peer.id}:${msg.ch}`;
    const c = this.#in.get(key);
    const o = this.#out.get(key);
    if (!c && !o) {
      return false;
    }
    if (msg.t === 'accept') {
      this.#accepted(c, msg);
    } else if (msg.t === 'ack') {
      this.#acked(o, msg);
    } else {
      this.#closed(key, c, o, msg);
    }
    return true;
  }

  /** Bytes of a relayed stream this hub opened; false for another channel's. */
  onData(peer: PeerView, ch: number, bytes: Buffer): boolean {
    const key = `${peer.id}:${ch}`;
    const c = this.#in.get(key);
    if (!c) {
      return false;
    }
    if (c.done || bytes.length < 1) {
      return true;
    }
    c.got += bytes.length;
    this.counters.stream_bytes_in += bytes.length;
    const kind = bytes[0];
    const body = bytes.subarray(1);
    if (kind === STREAM_TEXT) {
      try {
        c.sink.text(body.toString('utf8'));
      } catch {
        // the sink's own
      }
    } else if (kind === STREAM_BLOCK_MORE || kind === STREAM_BLOCK_END) {
      if (c.partBytes + body.length > STREAM_BLOCK_MAX) {
        this.#endIn(key, { code: 'DELIVERY_FAILED', message: `hub ${c.name} sent a block of more than ${STREAM_BLOCK_MAX} bytes` }, true);
        return true;
      }
      // The frame's memory is the decoder's (wire.ts): a piece kept past this call is copied.
      c.parts.push(kind === STREAM_BLOCK_END && !c.parts.length ? body : Buffer.from(body));
      c.partBytes += body.length;
      if (kind === STREAM_BLOCK_END) {
        const block = c.parts.length === 1 ? c.parts[0] : Buffer.concat(c.parts, c.partBytes);
        c.parts = [];
        c.partBytes = 0;
        this.counters.stream_blocks_in++;
        try {
          c.sink.block(block);
        } catch {
          // the sink's own
        }
      }
    }
    if (!c.done && (c.got - c.acked >= ACK_EVERY || kind !== STREAM_BLOCK_MORE)) {
      c.acked = c.got;
      this.#deps.links.send(peer.id, { t: 'ack', v: 1, ch, bytes: c.got });
    }
    return true;
  }

  /** The link to `peer` went away or was replaced by the pair's other connection: its relays end at both ends. */
  onLink(peer: PeerView, why: string): void {
    for (const [key, c] of [...this.#in]) {
      if (c.peer === peer.id && (!peer.reachable || c.conn !== peer.conn)) {
        this.#endIn(key, { code: 'HUB_UNREACHABLE', message: `the link to hub ${c.name} was lost (${why})` }, false);
      }
    }
    for (const [key, o] of [...this.#out]) {
      if (o.peer === peer.id && (!peer.reachable || o.conn !== peer.conn)) {
        this.#endOut(key, o);
      }
    }
  }

  stop(): void {
    for (const key of [...this.#in.keys()]) {
      this.#endIn(key, { code: 'HUB_UNREACHABLE', message: 'this hub is stopping' }, true);
    }
    for (const [key, o] of [...this.#out]) {
      if (o.open) {
        this.#deps.links.send(o.peer, { t: 'close', v: 1, ch: Number(key.slice(key.indexOf(':') + 1)), ok: false, code: '1001', message: 'hub stopping' });
      }
      this.#endOut(key, o);
    }
  }

  // ---- the opening end ----

  #accepted(c: Incoming | undefined, _msg: AcceptMsg): void {
    if (c?.timer) {
      clearTimeout(c.timer);
      c.timer = null;
    }
  }

  /** Ends a relay this hub opened; `tell` says so to the holder (it stops serving); `why` null: this side closed it. */
  #endIn(key: string, why: { code: string; message: string } | null, tell: boolean, reason?: string): void {
    const c = this.#in.get(key);
    if (!c || c.done) {
      return;
    }
    c.done = true;
    this.#in.delete(key);
    if (c.timer) {
      clearTimeout(c.timer);
      c.timer = null;
    }
    c.parts = [];
    if (tell) {
      this.#deps.links.send(c.peer, { t: 'close', v: 1, ch: Number(key.slice(key.indexOf(':') + 1)), ok: false, message: (why?.message ?? reason ?? 'the client left').slice(0, 200) });
    }
    if (why) {
      try {
        c.sink.end(why);
      } catch {
        // the sink's own
      }
    }
  }

  // ---- the holder's end ----

  #acked(o: Outgoing | undefined, msg: AckMsg): void {
    if (o && msg.bytes > o.acked) {
      o.acked = msg.bytes;
    }
  }

  #closed(key: string, c: Incoming | undefined, o: Outgoing | undefined, msg: CloseMsg): void {
    if (c) {
      this.#endIn(key, { code: msg.code ?? 'DELIVERY_FAILED', message: msg.message ?? 'the hub closed the stream' }, false);
    }
    if (o) {
      this.#endOut(key, o); // the other hub's client left
    }
  }

  #endOut(key: string, o: Outgoing): void {
    if (this.#out.get(key) !== o) {
      return;
    }
    this.#out.delete(key);
    o.open = false;
    const served = o.served;
    o.served = null;
    if (served) {
      this.counters.stream_blocks_dropped += served.gaps;
      try {
        served.closed();
      } catch (e) {
        this.#deps.log?.({ event: 'peer_stream_close_failed', message: (e as Error).message });
      }
    }
  }

  #serve(peer: PeerView, msg: OpenMsg): void {
    const { links } = this.#deps;
    const key = `${peer.id}:${msg.ch}`;
    const conn = peer.conn ?? undefined;
    const old = this.#out.get(key);
    if (old) {
      this.#endOut(key, old); // a channel number used again: the first one is over
    }
    const o: Outgoing = { peer: peer.id, conn: peer.conn, sent: 0, acked: 0, open: true, served: null };
    this.#out.set(key, o);
    this.counters.streams_served++;
    if (!links.send(peer.id, { t: 'accept', v: 1, ch: msg.ch, size: 0 })) {
      this.#out.delete(key);
      return;
    }
    const counters = this.counters;
    const frame = (kind: number, body: Uint8Array): boolean => {
      const out = Buffer.allocUnsafe(1 + body.length);
      out[0] = kind;
      out.set(body, 1);
      if (!links.sendData(peer.id, msg.ch, out, conn)) {
        return false;
      }
      o.sent += out.length;
      counters.stream_bytes_out += out.length;
      return true;
    };
    const end = (code: string, reason: string) => {
      if (o.open) {
        o.open = false;
        links.send(peer.id, { t: 'close', v: 1, ch: msg.ch, ok: false, code, message: reason.slice(0, 300) });
        // What it serves is told once the socket's own close has run (it called this from inside it).
        queueMicrotask(() => this.#endOut(key, o));
      }
    };
    const pipe: StreamPipe = {
      get readyState() {
        return o.open ? 1 : 3;
      },
      get bufferedAmount() {
        const flight = Math.max(0, o.sent - o.acked);
        const backlog = links.backlog(peer.id, conn) ?? 0;
        return backlog > DATA_HIGH_WATER ? Math.max(flight, backlog) : flight;
      },
      send(data, opts) {
        if (!o.open) {
          return;
        }
        if (typeof data === 'string' || opts?.binary === false) {
          frame(STREAM_TEXT, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
          return;
        }
        for (let at = 0; at < data.length || at === 0; at += DATA_CHUNK - 1) {
          const last = at + DATA_CHUNK - 1 >= data.length;
          if (!frame(last ? STREAM_BLOCK_END : STREAM_BLOCK_MORE, data.subarray(at, at + DATA_CHUNK - 1))) {
            return;
          }
        }
        counters.stream_blocks_out++;
      },
      close(code, reason) {
        end(String(code ?? 1000), reason ?? '');
      },
      terminate() {
        end('1006', 'terminated');
      },
    };
    try {
      o.served = this.#server!(peer, msg.ref, pipe);
    } catch (e) {
      this.counters.streams_refused++;
      end('INTERNAL', (e as Error).message);
    }
  }
}
