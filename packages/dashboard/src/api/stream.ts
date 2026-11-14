// The dashboard's `/app/stream` client (DEVICE-SPEC §3.3; the hub side is packages/hub/src/apps/stream.ts): one socket
// to one fr.camera instance's live JPEG frames. DOM-free (the WebSocket factory, the timers and the decoder are
// injected), so it is tested in node with a fake socket (test/stream-client.test.ts).
// - The first frame is `stream.hello` with the /app token (api/app-token.ts) and, for WATCH, `start` (a live view the
//   hub ends when its last starter leaves); without `start` the socket joins a running stream or waits for the next.
// - The hub answers `stream.welcome`, then one binary message per frame (an mjpg1 block, @fractonica/sdk/camera),
//   `stream.started` / `stream.ended` / `stream.gap`, `error` and `ping` (answered `pong`, which also keeps the hub
//   from calling the socket dead).
// - Frames are decoded one at a time: a frame that arrives while one is decoding waits, and a newer one replaces it
//   (counted as skipped here). Nothing queues, so a slow tab shows the newest frame, never a growing backlog.
// - A close the client did not ask for reconnects with /ws's backoff, except 4400 (refused: a bad hello, a device or
//   instance that is not there), 4401 (a wrong token) and 4409 (a protocol this page does not speak).
// Only @fractonica/sdk/wire (types, APP_PROTOCOL_V) and @fractonica/sdk/camera (parseJpegBlock) are imported: neither
// pulls in the SDK's connection code or Zod.

import { type JpegBlock, parseJpegBlock } from '@fractonica/sdk/camera';
import { APP_PROTOCOL_V, APP_STREAM_PATH, type StreamEndedFrame, type StreamHelloFrame, type StreamInfo } from '@fractonica/sdk/wire';

import { BACKOFF_MS, type Timers } from './ws.ts';

/** The part of a browser WebSocket the client uses (binary frames as ArrayBuffer). */
export interface StreamSocketLike {
  binaryType: string;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type StreamStart = NonNullable<StreamHelloFrame['start']>;

/** Closes after which the client does not reconnect: refused, a wrong token, a protocol mismatch. */
export const NO_RECONNECT: ReadonlySet<number> = new Set([4400, 4401, 4409]);

/** What the client tells its owner, in order. */
export type StreamClientEvent =
  | { type: 'connecting'; attempt: number }
  | { type: 'welcome'; stream: StreamInfo | null; alias: string; instance: string }
  | { type: 'started'; stream: StreamInfo }
  | { type: 'ended'; frame: StreamEndedFrame }
  /** Frames this view did not show: the hub's (backpressure) or this client's (a newer frame replaced a waiting one). */
  | { type: 'skipped'; frames: number; by: 'hub' | 'here' }
  | { type: 'error'; code: string; message: string }
  /** The socket closed; `final` when the client will not reconnect (stopped, or a NO_RECONNECT code). */
  | { type: 'closed'; code: number; reason: string; final: boolean };

/** A decoded frame and the block it came from. */
export interface StreamFrame<D> {
  image: D;
  block: JpegBlock;
  stream: StreamInfo | null;
}

export interface StreamClientOptions<D> {
  /** ws(s)://host/app/stream (streamUrl). */
  url: string;
  token: string;
  device: string;
  instance: string;
  /** WATCH: start a live view when none runs (a running one is joined as it is). */
  start?: StreamStart;
  connect: (url: string) => StreamSocketLike;
  /** The JPEG to something drawable (createImageBitmap in the browser). */
  decode: (jpeg: Uint8Array) => Promise<D>;
  onFrame: (frame: StreamFrame<D>) => void;
  onEvent?: (e: StreamClientEvent) => void;
  timers?: Timers;
  backoffMs?: readonly number[];
}

/** `ws(s)://<host>/app/stream` for the page's location. */
export function streamUrl(loc: { protocol: string; host: string }): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${APP_STREAM_PATH}`;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class StreamClient<D> {
  readonly #o: StreamClientOptions<D>;
  readonly #timers: Timers;
  #ws: StreamSocketLike | null = null;
  #stopped = false;
  #attempt = 0;
  #retry: unknown = null;
  #stream: StreamInfo | null = null;
  #decoding = false;
  #waiting: JpegBlock | null = null;
  /** Frames drawn, blocks the hub skipped, frames skipped here, blocks that were not mjpg1. */
  readonly counts = { frames: 0, hubSkipped: 0, hereSkipped: 0, bad: 0 };

  constructor(o: StreamClientOptions<D>) {
    this.#o = o;
    this.#timers = o.timers ?? realTimers;
  }

  /** The stream the socket is on now (welcome or started), null while none runs. */
  get stream(): StreamInfo | null {
    return this.#stream;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  /** Opens the socket (once; reconnects follow by themselves). */
  start(): this {
    this.#open();
    return this;
  }

  /** Leaves for good: the socket closes (a view this socket started ends when no other starter remains). */
  stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    if (this.#retry !== null) {
      this.#timers.clearTimeout(this.#retry);
      this.#retry = null;
    }
    const ws = this.#ws;
    this.#ws = null;
    this.#waiting = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close(1000, 'left');
      } catch {
        // already closing
      }
    }
    this.#emit({ type: 'closed', code: 1000, reason: 'left', final: true });
  }

  #emit(e: StreamClientEvent): void {
    this.#o.onEvent?.(e);
  }

  #open(): void {
    if (this.#stopped) {
      return;
    }
    this.#emit({ type: 'connecting', attempt: this.#attempt });
    let ws: StreamSocketLike;
    try {
      ws = this.#o.connect(this.#o.url);
    } catch {
      this.#closed(1006, 'could not open');
      return;
    }
    this.#ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      const hello: StreamHelloFrame = {
        t: 'stream.hello',
        v: APP_PROTOCOL_V as 1,
        token: this.#o.token,
        device: this.#o.device,
        instance: this.#o.instance,
        ...(this.#o.start ? { start: this.#o.start } : {}),
      };
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (ev) => this.#message(ev.data);
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (this.#ws === ws) {
        this.#ws = null;
        this.#closed(ev.code, ev.reason);
      }
    };
  }

  #closed(code: number, reason: string): void {
    this.#stream = null;
    this.#waiting = null;
    const final = this.#stopped || NO_RECONNECT.has(code);
    this.#emit({ type: 'closed', code, reason, final });
    if (final) {
      this.#stopped = true;
      return;
    }
    const b = this.#o.backoffMs ?? BACKOFF_MS;
    const delay = b[Math.min(this.#attempt, b.length - 1)]!;
    this.#attempt++;
    this.#retry = this.#timers.setTimeout(() => {
      this.#retry = null;
      this.#open();
    }, delay);
  }

  #message(data: unknown): void {
    if (typeof data === 'string') {
      this.#text(data);
      return;
    }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (!bytes) {
      this.counts.bad++;
      return;
    }
    let block: JpegBlock;
    try {
      block = parseJpegBlock(bytes);
    } catch {
      this.counts.bad++;
      return;
    }
    this.#frame(block);
  }

  #text(text: string): void {
    let f: Record<string, unknown>;
    try {
      f = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (f.t) {
      case 'stream.welcome':
        this.#attempt = 0;
        this.#stream = (f.stream as StreamInfo | null) ?? null;
        this.#emit({ type: 'welcome', stream: this.#stream, alias: String(f.alias ?? ''), instance: String(f.instance ?? '') });
        return;
      case 'stream.started':
        this.#stream = f.stream as StreamInfo;
        this.#emit({ type: 'started', stream: this.#stream });
        return;
      case 'stream.ended':
        this.#stream = null;
        this.#waiting = null;
        this.#emit({ type: 'ended', frame: f as unknown as StreamEndedFrame });
        return;
      case 'stream.gap': {
        const n = Number(f.blocks) || 0;
        this.counts.hubSkipped += n;
        this.#emit({ type: 'skipped', frames: n, by: 'hub' });
        return;
      }
      case 'error':
        this.#emit({ type: 'error', code: String(f.code ?? 'INTERNAL'), message: String(f.message ?? '') });
        return;
      case 'ping':
        this.#ws?.send(JSON.stringify({ t: 'pong', id: f.id }));
        return;
      default:
        return;
    }
  }

  #frame(block: JpegBlock): void {
    if (this.#decoding) {
      if (this.#waiting) {
        this.counts.hereSkipped++;
        this.#emit({ type: 'skipped', frames: 1, by: 'here' });
      }
      this.#waiting = block;
      return;
    }
    this.#decode(block);
  }

  #decode(block: JpegBlock): void {
    this.#decoding = true;
    const stream = this.#stream;
    this.#o
      .decode(block.jpeg)
      .then(
        (image) => {
          if (!this.#stopped) {
            this.counts.frames++;
            this.#o.onFrame({ image, block, stream });
          }
        },
        () => {
          this.counts.bad++;
        },
      )
      .finally(() => {
        this.#decoding = false;
        const next = this.#waiting;
        this.#waiting = null;
        if (next && !this.#stopped) {
          this.#decode(next);
        }
      });
  }
}
