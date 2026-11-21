// Data channels over the hubs' link (design multi-hub-m2 §3.3, §7.3): a file read at one hub and written at another
// (a recording pulled to where the command ran, a firmware image fetched by the hub that serves it to a board).
//
// The end that wants the bytes opens the channel: `open {ch, kind, ref}`. The other end, the provider, looks the
// reference up (a provider per kind is registered here by whoever owns the files: files.ts, firmware.ts) and answers
// `accept {ch, size}` followed by the bytes as data frames, then `close {ok, bytes, sha256}`; or `close {ok: false}`
// with why it sends nothing. Nothing is ever asked for by a path: a reference is a token, a spool entry or a hash
// that the provider itself resolves.
//
// - Chunks. A data frame carries at most DATA_CHUNK (64 KiB), so a ping or a control message written meanwhile waits
//   behind one chunk: the heartbeat of link.ts lives through a file of any size.
// - Backpressure, twice. The provider waits while more than DATA_HIGH_WATER is queued on its socket (link.ts
//   `drained`), and it keeps at most WINDOW bytes ahead of what the receiver said it has written (`ack`): a receiver
//   with a slow disk slows the file's reader, and nothing piles up in memory at either end.
// - The receiver writes under a temporary name beside the destination, checks the size it was told, the count and
//   SHA-256 the provider closes with and its own hash of what arrived (and a hash known beforehand, a blob's name),
//   and only then renames. A transfer cut by a lost link, a stall or a mismatch leaves no file under the final name
//   and removes the temporary one.
// - A channel lives on one connection: when the link goes away, or the pair's other connection takes its place, both
//   ends give it up.

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';

import { FrError } from '@fractonica/protocol';

import type { PeerLinks, PeerView } from './link.ts';
import { type AcceptMsg, type AckMsg, type CloseMsg, DATA_CHUNK, type OpenMsg, type PeerMessage } from './wire.ts';

/** The provider keeps at most this far ahead of the receiver's `ack`. */
export const WINDOW = 1 << 20;
/** The receiver acks at least this often (in bytes written). */
const ACK_EVERY = 128 * 1024;
/** A channel that moves nothing for this long is given up by the end that waits. */
export const STALL_MS = 15_000;
/** The largest file a channel carries (a recording of an hour is 115 MB). */
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/** What a provider serves for one reference: a regular file of this hub. */
export interface Served {
  path: string;
}

/** Resolves a reference of its kind to a file, or throws (FrError) why not. `peer` is the hub that asked. */
export type Provider = (peer: PeerView, ref: Record<string, unknown>) => Served | Promise<Served>;

export interface PullOptions {
  /** A hash known beforehand (a blob is named by it): the file is refused when what arrived differs. */
  sha256?: string;
  maxBytes?: number;
  signal?: AbortSignal;
  /** Stall time, for a test. */
  stallMs?: number;
}

export interface Pulled {
  bytes: number;
  sha256: string;
}

export interface ChannelsDeps {
  links: Pick<PeerLinks, 'send' | 'sendData' | 'drained'>;
  log?(line: Record<string, unknown>): void;
}

interface Incoming {
  peer: string;
  name: string;
  conn: number | null;
  what: string;
  dest: string;
  tmp: string;
  out: WriteStream | null;
  size: number | null;
  /** Bytes handed to the file, bytes it has written, bytes last acked. */
  got: number;
  written: number;
  acked: number;
  hash: ReturnType<typeof createHash>;
  want: string | undefined;
  maxBytes: number;
  closing: CloseMsg | null;
  stall: NodeJS.Timeout | null;
  stallMs: number;
  settled: boolean;
  resolve(p: Pulled): void;
  reject(e: Error): void;
  off(): void;
}

interface Outgoing {
  peer: string;
  conn: number | null;
  acked: number;
  cancelled: string | null;
  wake: (() => void) | null;
}

export interface ChannelCounters {
  pulls: number;
  pulls_failed: number;
  serves: number;
  serves_failed: number;
  bytes_in: number;
  bytes_out: number;
}

export class PeerChannels {
  #deps: ChannelsDeps;
  #providers = new Map<string, Provider>();
  /** Channels this hub opened: `<hub id>:<ch>`. */
  #in = new Map<string, Incoming>();
  /** Channels a peer opened here. */
  #out = new Map<string, Outgoing>();
  #n = 0;
  readonly counters: ChannelCounters = { pulls: 0, pulls_failed: 0, serves: 0, serves_failed: 0, bytes_in: 0, bytes_out: 0 };

  constructor(deps: ChannelsDeps) {
    this.#deps = deps;
  }

  /** Registers what serves `open` of `kind`. */
  provide(kind: string, fn: Provider): void {
    this.#providers.set(kind, fn);
  }

  open(): number {
    return this.#in.size + this.#out.size;
  }

  /**
   * Fetches the bytes `kind`/`ref` names at `peer` into `dest` (written under a temporary name, renamed when whole
   * and checked). Rejects with an FrError naming the hub; `dest` is then as it was before.
   */
  pull(peer: PeerView, kind: string, ref: Record<string, unknown>, dest: string, opts: PullOptions = {}): Promise<Pulled> {
    const what = `${kind} ${Object.values(ref).map(String).join(' ')}`.trim();
    if (!peer.reachable) {
      return Promise.reject(new FrError('HUB_UNREACHABLE', `hub ${peer.name} is not reachable: ${what} was not fetched from it`, { details: { hub: peer.name } }));
    }
    this.#n = (this.#n % 0x7ffffffe) + 1;
    const ch = this.#n;
    const key = `${peer.id}:${ch}`;
    this.counters.pulls++;
    return new Promise<Pulled>((resolve, reject) => {
      const onAbort = () => this.#failIn(key, new FrError('TIMEOUT', `fetching ${what} from hub ${peer.name} was given up`), true);
      const c: Incoming = {
        peer: peer.id,
        name: peer.name,
        conn: peer.conn,
        what,
        dest,
        tmp: `${dest}.part-${process.pid}-${randomBytes(4).toString('hex')}`,
        out: null,
        size: null,
        got: 0,
        written: 0,
        acked: 0,
        hash: createHash('sha256'),
        want: opts.sha256?.toLowerCase(),
        maxBytes: opts.maxBytes ?? MAX_FILE_BYTES,
        closing: null,
        stall: null,
        stallMs: opts.stallMs ?? STALL_MS,
        settled: false,
        resolve,
        reject,
        off: () => opts.signal?.removeEventListener('abort', onAbort),
      };
      this.#in.set(key, c);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.#armStall(key, c);
      if (opts.signal?.aborted) {
        onAbort();
      } else if (!this.#deps.links.send(peer.id, { t: 'open', v: 1, ch, kind, ref })) {
        this.#failIn(key, new FrError('HUB_UNREACHABLE', `hub ${peer.name} is not reachable: ${what} was not fetched from it`, { details: { hub: peer.name } }), false);
      }
    });
  }

  /** A channel message from `peer`; false for another message. */
  onMessage(peer: PeerView, msg: PeerMessage): boolean {
    switch (msg.t) {
      case 'open':
        void this.#serve(peer, msg);
        return true;
      case 'accept':
        this.#accept(peer, msg);
        return true;
      case 'ack':
        this.#ack(peer, msg);
        return true;
      case 'close':
        this.#close(peer, msg);
        return true;
      default:
        return false;
    }
  }

  /** Bytes of a channel this hub opened. */
  onData(peer: PeerView, ch: number, bytes: Buffer): void {
    const key = `${peer.id}:${ch}`;
    const c = this.#in.get(key);
    if (!c || c.settled || !c.out) {
      return;
    }
    if (c.size === null || c.got + bytes.length > c.size) {
      this.#failIn(key, new FrError('DELIVERY_FAILED', `hub ${peer.name} sent more of ${c.what} than the ${c.size} bytes it announced`), true);
      return;
    }
    c.got += bytes.length;
    this.counters.bytes_in += bytes.length;
    c.hash.update(bytes);
    this.#armStall(key, c);
    const n = bytes.length;
    // The chunk is this frame's own memory (wire.ts): the file keeps it until it is written, and the ack follows that.
    c.out.write(bytes, (err) => {
      if (err || c.settled) {
        return;
      }
      c.written += n;
      if (c.written - c.acked >= ACK_EVERY || c.written === c.size) {
        c.acked = c.written;
        this.#deps.links.send(peer.id, { t: 'ack', v: 1, ch, bytes: c.written });
      }
      this.#maybeDone(key, c);
    });
  }

  /** The link to `peer` went away or was replaced by the pair's other connection: its channels end. */
  onLink(peer: PeerView, why: string): void {
    for (const [key, c] of [...this.#in]) {
      if (c.peer === peer.id && (!peer.reachable || c.conn !== peer.conn)) {
        this.#failIn(key, new FrError('HUB_UNREACHABLE', `the link to hub ${c.name} was lost at ${c.got}${c.size !== null ? `/${c.size}` : ''} bytes of ${c.what} (${why}): nothing was kept`, { details: { hub: c.name } }), false);
      }
    }
    for (const [key, o] of [...this.#out]) {
      if (o.peer === peer.id && (!peer.reachable || o.conn !== peer.conn)) {
        o.cancelled = why;
        o.wake?.();
        this.#out.delete(key);
      }
    }
  }

  stop(): void {
    for (const key of [...this.#in.keys()]) {
      this.#failIn(key, new FrError('HUB_UNREACHABLE', 'this hub is stopping'), true);
    }
    for (const o of this.#out.values()) {
      o.cancelled = 'this hub is stopping';
      o.wake?.();
    }
    this.#out.clear();
  }

  // ---- the receiving end ----

  #armStall(key: string, c: Incoming): void {
    if (c.stall) {
      clearTimeout(c.stall);
    }
    c.stall = setTimeout(() => this.#failIn(key, new FrError('TIMEOUT', `hub ${c.name} sent nothing of ${c.what} for ${Math.round(c.stallMs / 1000)} s (at ${c.got}${c.size !== null ? `/${c.size}` : ''} bytes): nothing was kept`, { details: { hub: c.name } }), true), c.stallMs);
    c.stall.unref();
  }

  #accept(peer: PeerView, msg: AcceptMsg): void {
    const key = `${peer.id}:${msg.ch}`;
    const c = this.#in.get(key);
    if (!c || c.settled || c.size !== null) {
      return;
    }
    if (msg.size > c.maxBytes) {
      this.#failIn(key, new FrError('INVALID_ARGS', `${c.what} at hub ${peer.name} is ${msg.size} bytes, more than the ${c.maxBytes} a transfer takes`), true);
      return;
    }
    c.size = msg.size;
    try {
      mkdirSync(dirname(c.dest), { recursive: true });
      c.out = createWriteStream(c.tmp, { flags: 'wx', mode: 0o644 });
    } catch (e) {
      this.#failIn(key, new FrError('INTERNAL', `cannot write ${c.dest}: ${(e as Error).message}`), true);
      return;
    }
    c.out.on('error', (e) => this.#failIn(key, new FrError('INTERNAL', `cannot write ${c.dest}: ${e.message}`), true));
    this.#armStall(key, c);
  }

  #close(peer: PeerView, msg: CloseMsg): void {
    const key = `${peer.id}:${msg.ch}`;
    const c = this.#in.get(key);
    if (c && !c.settled) {
      if (!msg.ok) {
        const code = msg.code === 'NOT_FOUND' || msg.code === 'INVALID_ARGS' || msg.code === 'HUB_VERSION_MISMATCH' ? msg.code : 'DELIVERY_FAILED';
        this.#failIn(key, new FrError(code, `hub ${peer.name} does not send ${c.what}: ${msg.message ?? 'no reason given'}`, { details: { hub: peer.name } }), false);
        return;
      }
      c.closing = msg;
      this.#maybeDone(key, c);
      return;
    }
    // The receiver of a channel this hub serves gave it up.
    const o = this.#out.get(key);
    if (o) {
      o.cancelled = msg.message ?? 'the receiver closed it';
      o.wake?.();
    }
  }

  /** Whole when the provider closed and every byte it sent is in the file: checked, then renamed. */
  #maybeDone(key: string, c: Incoming): void {
    const end = c.closing;
    if (!end || c.settled || c.size === null || !c.out) {
      return;
    }
    if (c.got < c.size || (end.bytes !== undefined && end.bytes !== c.size)) {
      if (c.got === c.written) {
        this.#failIn(key, new FrError('DELIVERY_FAILED', `${c.what} from hub ${c.name} is short: ${c.got} of ${c.size} bytes arrived (the hub closed it at ${end.bytes ?? '?'}): nothing was kept`), false);
      }
      return;
    }
    if (c.written < c.size) {
      return; // the file is still taking the last chunks
    }
    c.settled = true;
    const sha = c.hash.digest('hex');
    const out = c.out;
    out.end(() => {
      const bad = end.sha256 && end.sha256.toLowerCase() !== sha ? `hub ${c.name} sent it with SHA-256 ${end.sha256.slice(0, 12)}…, what arrived has ${sha.slice(0, 12)}…` : c.want && c.want !== sha ? `it should have SHA-256 ${c.want.slice(0, 12)}…, what arrived has ${sha.slice(0, 12)}…` : null;
      this.#forget(key, c);
      if (bad) {
        rmSync(c.tmp, { force: true });
        this.counters.pulls_failed++;
        c.reject(new FrError('DELIVERY_FAILED', `${c.what} from hub ${c.name} arrived damaged (${bad}): nothing was kept`, { details: { hub: c.name } }));
        return;
      }
      try {
        renameSync(c.tmp, c.dest);
      } catch (e) {
        rmSync(c.tmp, { force: true });
        this.counters.pulls_failed++;
        c.reject(new FrError('INTERNAL', `cannot write ${c.dest}: ${(e as Error).message}`));
        return;
      }
      c.resolve({ bytes: c.size!, sha256: sha });
    });
  }

  #forget(key: string, c: Incoming): void {
    this.#in.delete(key);
    if (c.stall) {
      clearTimeout(c.stall);
      c.stall = null;
    }
    c.off();
  }

  /** Ends a channel this hub opened without its file; `tell` says so to the provider (it stops reading). */
  #failIn(key: string, err: Error, tell: boolean): void {
    const c = this.#in.get(key);
    if (!c || c.settled) {
      return;
    }
    c.settled = true;
    this.#forget(key, c);
    this.counters.pulls_failed++;
    if (tell) {
      this.#deps.links.send(c.peer, { t: 'close', v: 1, ch: Number(key.slice(key.indexOf(':') + 1)), ok: false, message: err.message.slice(0, 200) });
    }
    const done = () => {
      rmSync(c.tmp, { force: true });
      c.reject(err);
    };
    if (c.out && !c.out.closed) {
      c.out.once('close', done);
      c.out.destroy();
    } else {
      done();
    }
  }

  // ---- the providing end ----

  #ack(peer: PeerView, msg: AckMsg): void {
    const o = this.#out.get(`${peer.id}:${msg.ch}`);
    if (o && msg.bytes > o.acked) {
      o.acked = msg.bytes;
      o.wake?.();
    }
  }

  async #serve(peer: PeerView, msg: OpenMsg): Promise<void> {
    const { links } = this.#deps;
    const refuse = (code: string, message: string) => {
      this.counters.serves_failed++;
      links.send(peer.id, { t: 'close', v: 1, ch: msg.ch, ok: false, code, message: message.slice(0, 300) });
    };
    const provider = this.#providers.get(msg.kind);
    if (!provider) {
      return refuse('HUB_VERSION_MISMATCH', `it serves no ${msg.kind} channel`);
    }
    let path: string;
    let size: number;
    try {
      path = (await provider(peer, msg.ref)).path;
      const st = statSync(path);
      if (!st.isFile()) {
        throw new FrError('NOT_FOUND', 'not a regular file');
      }
      size = st.size;
    } catch (e) {
      return refuse(e instanceof FrError ? e.code : 'NOT_FOUND', e instanceof FrError ? e.message : 'it is not there any more');
    }
    const key = `${peer.id}:${msg.ch}`;
    const o: Outgoing = { peer: peer.id, conn: peer.conn, acked: 0, cancelled: null, wake: null };
    this.#out.set(key, o);
    this.counters.serves++;
    const conn = peer.conn ?? undefined;
    if (!links.send(peer.id, { t: 'accept', v: 1, ch: msg.ch, size })) {
      this.#out.delete(key);
      return;
    }
    const hash = createHash('sha256');
    let sent = 0;
    try {
      if (size > 0) {
        // `end` pins the read to the size announced: a file still growing is sent as it was when it was opened.
        for await (const chunk of createReadStream(path, { highWaterMark: DATA_CHUNK, end: size - 1 }) as AsyncIterable<Buffer>) {
          // The receiver's credit, then the socket's queue.
          while (!o.cancelled && sent + chunk.length - o.acked > WINDOW) {
            await new Promise<void>((resolve) => {
              const t = setTimeout(() => {
                o.cancelled ??= `the receiver took nothing for ${STALL_MS / 1000} s`;
                resolve();
              }, STALL_MS);
              o.wake = () => {
                clearTimeout(t);
                o.wake = null;
                resolve();
              };
            });
          }
          if (o.cancelled) {
            break;
          }
          if (!(await links.drained(peer.id, conn)) || !links.sendData(peer.id, msg.ch, chunk, conn)) {
            o.cancelled ??= 'the link went away';
            break;
          }
          hash.update(chunk);
          sent += chunk.length;
          this.counters.bytes_out += chunk.length;
        }
      }
    } catch (e) {
      o.cancelled ??= `reading it failed: ${(e as Error).message}`;
    }
    this.#out.delete(key);
    if (o.cancelled || sent !== size) {
      this.counters.serves_failed++;
      this.#deps.log?.({ event: 'peer_channel_cut', kind: msg.kind, to: peer.name, bytes: sent, size, why: o.cancelled ?? 'the file changed while it was read' });
      links.send(peer.id, { t: 'close', v: 1, ch: msg.ch, ok: false, code: 'DELIVERY_FAILED', message: o.cancelled ?? 'the file changed while it was read' });
      return;
    }
    links.send(peer.id, { t: 'close', v: 1, ch: msg.ch, ok: true, bytes: sent, sha256: hash.digest('hex') });
  }
}
