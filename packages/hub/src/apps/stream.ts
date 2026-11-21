// One `/app/stream` socket (design csi-c1 D12, §12; stream H): the binary live channel beside `/app`. The first text
// frame is a StreamHelloFrame within APP_HELLO_TIMEOUT_MS (the token only there; close codes as /app: 4400 a bad or
// missing hello, also a device or instance that is not there, 4401 a bad token, 4409 another protocol major); one
// subscription per socket, to {device, instance}: an fr.csi or an fr.camera instance (design camera-c1 D12; the device's
// only streaming one when unnamed). `start` begins a live stream (seconds 0) when none runs on the instance
// (csi/ops.ts beginCsiStream with source and peer; camera/ops.ts beginCameraStream with interval_ms, frame_size and
// quality, a live view to the hub; the hub stops it when its last such socket leaves); a running one is joined as
// it is, unless it is ending (then the socket waits and begins the next one once it ended) or is not published live (a
// csi_stream or camera_stream with live false: an `error` DEVICE_BUSY says so, and the socket waits for a live one). The
// hub answers StreamWelcomeFrame, then each block as one binary message (exactly the chunk's bytes), text
// frames stream.started / stream.ended / stream.gap, and ping / pong / error as /app.
// Backpressure (APP_LIMITS): a block is dropped, never queued, while the socket has more than highWater bytes
// buffered; the count goes out as stream.gap before the next block that is sent (or before stream.ended), so a slow
// browser loses blocks, never stalls the hub, and is never closed for it.
//
// Several hubs (design multi-hub-m2 §8, §17, step 2.4). A socket is attached to where the board is:
// - this hub holds it (or no hub does): as above;
// - another hub holds it: that hub runs the stream through the hubs' link (peers/streams.ts) with a socket of this
//   class on its side (`relayedFrom`: no token, the asking hub checked it; never relayed on), and this socket hands its
//   text frames and blocks to the client unchanged, dropping blocks for a slow client as above. A hub that relays no
//   streams (a version before step 2.4) is refused by name.
// - The board changes hub under the socket (a failover, a return to its default hub): the socket leaves where it was
//   (the hub there stops a stream this client started, through the board's new hub when it must) and attaches where
//   the board is now, by itself. The client hears `stream.ended` (net_lost) for what it was watching and
//   `stream.started` for what follows; `start` is asked again only when a stream was cut by the move (within
//   FOLLOW_START_MS), never for a board that merely came back much later. The board may still be ending the stream
//   its old hub ran when the new one asks (busy, or the new stream ends `error` before its first block): the start is
//   then asked again, up to FOLLOW_TRIES times. When the link to the board's hub is lost
//   the client hears `stream.ended` and an `error` HUB_UNREACHABLE, and the socket waits for the board to be somewhere.

import type { Socket } from 'node:net';

import type { WebSocket } from '@fastify/websocket';

import { CAMERA_FRAME_SIZES, CSI_SOURCES, FrError } from '@fractonica/protocol';
import { APP_PROTOCOL_V, type StreamEndedFrame, type StreamHelloFrame, type StreamHubFrame, type StreamInfo } from '@fractonica/sdk/wire';

import { beginCameraStream, CAMERA_CAP, cameraInstance } from '../camera/ops.ts';
import type { Device, HubContext } from '../context.ts';
import type { RelayHandle } from '../peers/streams.ts';
import { beginCsiStream, csiInstance, resolvePeer } from '../csi/ops.ts';
import { nowUs } from '../ring.ts';
import type { PortCap } from '../router/caps.ts';
import { instancesOf } from '../router/ops.ts';
import { liveStreams, type StreamSubscriber } from '../streams/live.ts';
import { appVisible } from './directory.ts';
import type { AppLimits } from './socket.ts';
import { tokenMatches } from './token.ts';

export interface StreamSocketHost {
  hub(): HubContext;
  token(): string | null;
  limits: AppLimits;
  gone(sock: StreamSocket): void;
  /**
   * This socket serves a client of another hub through the hubs' link (that hub's name): its hello carries no token
   * (that hub checked it), and it is never relayed on.
   */
  relayedFrom?: string;
}

/** What a stream socket writes to: a WebSocket, or the hubs' link for another hub's client (peers/streams.ts StreamPipe). */
export interface StreamWs {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array, opts?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

/** After a board changed hub, a client that asked `start` gets its stream started again only this soon after one was cut. */
export const FOLLOW_START_MS = 20_000;
/** A change of where the board is settles for this long before the socket follows (its old hub says gone, its new one up). */
const FOLLOW_SETTLE_MS = 300;
/** A `start` that failed right after the board changed hub (the board is still ending the old stream) is asked again after this, */
const FOLLOW_RETRY_MS = 1500;
/** this many times at most. */
const FOLLOW_TRIES = 3;

type Place = { kind: 'here' } | { kind: 'peer'; id: string; name: string };
const isUp = (p: string) => p === 'online' || p === 'suspect';

const OPEN = 1;
const DEVICE_ID = /^[0-9a-f]{12}$/;
const CSI_CAP = 'fr.csi';
/** The capabilities whose instances stream on /app/stream (design csi-c1 D12, camera-c1 D12). */
const STREAMING_CAPS: readonly string[] = [CSI_CAP, CAMERA_CAP];
const isInt = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** A stream hello's shape, or why it is not one. */
function helloProblem(f: Record<string, unknown>): string | null {
  if (f.t !== 'stream.hello') {
    return 'the first frame must be a stream.hello';
  }
  if (typeof f.v !== 'number') {
    return 'stream.hello.v must be a number';
  }
  if (typeof f.token !== 'string') {
    return 'stream.hello.token must be a string';
  }
  if (typeof f.device !== 'string' || !f.device) {
    return 'stream.hello.device must be a device alias or id';
  }
  if (f.instance !== undefined && (typeof f.instance !== 'string' || !f.instance)) {
    return 'stream.hello.instance must be an instance name';
  }
  const st = f.start as Record<string, unknown> | undefined;
  if (st !== undefined) {
    if (typeof st !== 'object' || st === null || Array.isArray(st)) {
      return 'stream.hello.start must be {source?, peer?} (fr.csi) or {interval_ms?, frame_size?, quality?} (fr.camera)';
    }
    if (st.source !== undefined && !(CSI_SOURCES as readonly unknown[]).includes(st.source)) {
      return `stream.hello.start.source must be one of ${CSI_SOURCES.join(', ')}`;
    }
    if (st.peer !== undefined && (typeof st.peer !== 'string' || !st.peer)) {
      return 'stream.hello.start.peer must be a device or a MAC';
    }
    if (st.interval_ms !== undefined && !isInt(st.interval_ms, 0, 3_600_000)) {
      return 'stream.hello.start.interval_ms must be an integer 0..3600000';
    }
    if (st.frame_size !== undefined && !(CAMERA_FRAME_SIZES as readonly unknown[]).includes(st.frame_size)) {
      return `stream.hello.start.frame_size must be one of ${CAMERA_FRAME_SIZES.join(', ')}`;
    }
    if (st.quality !== undefined && !isInt(st.quality, 4, 63)) {
      return 'stream.hello.start.quality must be an integer 4..63';
    }
  }
  return null;
}

/** `start`'s fields against the instance's capability: a csi instance takes source and peer, a camera one the camera's. */
function startProblem(inst: PortCap, start: NonNullable<StreamHelloFrame['start']>): string | null {
  const csiFields = ['source', 'peer'].filter((k) => (start as Record<string, unknown>)[k] !== undefined);
  const camFields = ['interval_ms', 'frame_size', 'quality'].filter((k) => (start as Record<string, unknown>)[k] !== undefined);
  if (inst.cap === CSI_CAP && camFields.length) {
    return `${inst.name} is ${CSI_CAP}: start takes source and peer, not ${camFields.join(', ')}`;
  }
  if (inst.cap === CAMERA_CAP && csiFields.length) {
    return `${inst.name} is ${CAMERA_CAP}: start takes interval_ms, frame_size and quality, not ${csiFields.join(', ')}`;
  }
  return null;
}

/**
 * The device's `name` instance (checked to stream: fr.csi or fr.camera), else its only (first) streaming one; the
 * capability's own resolver says why when there is none.
 */
export function streamInstance(hub: HubContext, dev: Device, name: string | undefined): PortCap {
  const instances = instancesOf(hub, dev);
  if (name !== undefined) {
    const inst = instances?.find((c) => c.name === name);
    if (inst && STREAMING_CAPS.includes(inst.cap)) {
      return inst;
    }
    if (inst) {
      throw new FrError('INVALID_ARGS', `${dev.alias} ${inst.name} is ${inst.cap}, not a streaming instance (${STREAMING_CAPS.join(' or ')})`);
    }
    return csiInstance(hub, dev, name); // NOT_FOUND, naming the instances there are
  }
  const found = instances?.filter((c) => STREAMING_CAPS.includes(c.cap)) ?? [];
  if (found.length === 1) {
    return found[0];
  }
  if (found.length > 1) {
    throw new FrError('AMBIGUOUS_SELECTOR', `${dev.alias} has ${found.length} streaming instances (${found.map((c) => `${c.name} (${c.cap})`).join(', ')}): name one`);
  }
  return csiInstance(hub, dev, undefined); // CAPABILITY_UNSUPPORTED, naming the instances there are
}

export class StreamSocket implements StreamSubscriber {
  state: 'hello' | 'live' | 'closed' = 'hello';
  lastRx = Date.now();
  /** Messages written (binary and text). */
  written = 0;
  /** Blocks not sent (backpressure), since the socket opened. */
  gaps = 0;
  #pendingGap = 0;
  #ws: StreamWs;
  #host: StreamSocketHost;
  #helloTimer: ReturnType<typeof setTimeout> | null;
  #pingId = 0;
  #off: (() => void) | null = null;
  /** The stream this socket was told of (welcome or stream.started). */
  #known: number | null = null;
  /** What the client asked for, and the board it named, once its hello was taken. */
  #asked: StreamHelloFrame | null = null;
  #dev: Device | null = null;
  /** Where the socket is attached: this hub's own streams, or a relay at the hub that holds the board. */
  #place: Place | null = null;
  #relay: RelayHandle | null = null;
  /** Counts the relays this socket opened, so what a closed one still says is not taken for the current one's. */
  #relayN = 0;
  #welcomed = false;
  /** Date.now() when a stream this socket was watching was cut (the board moved, the link was lost). */
  #cutAt = 0;
  #unwatch: (() => void) | null = null;
  #settle: ReturnType<typeof setTimeout> | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  /** After the board changed hub: the `start` asked again where it is now, and how often it was tried. */
  #following: { start: NonNullable<StreamHelloFrame['start']>; tries: number; until: number } | null = null;
  /** Blocks of the stream the socket was told of that it was handed (sent or dropped): none yet means it never ran. */
  #blocks = 0;

  constructor(ws: WebSocket | StreamWs, raw: Socket | undefined, host: StreamSocketHost) {
    this.#ws = ws as StreamWs;
    this.#host = host;
    raw?.setNoDelay(true);
    this.#helloTimer = setTimeout(() => this.close(4400, `no stream.hello within ${host.limits.helloTimeoutMs / 1000} s`), host.limits.helloTimeoutMs);
  }

  message(text: string): void {
    this.lastRx = Date.now();
    if (this.state === 'closed') {
      return;
    }
    let f: Record<string, unknown>;
    try {
      const v = JSON.parse(text) as unknown;
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        throw new Error('not an object');
      }
      f = v as Record<string, unknown>;
    } catch {
      if (this.state === 'hello') {
        this.close(4400, 'the first frame must be a JSON stream.hello');
      } else {
        this.control({ t: 'error', code: 'INVALID_ARGS', message: 'frames are JSON objects' });
      }
      return;
    }
    if (this.state === 'hello') {
      this.#hello(f);
      return;
    }
    switch (f.t) {
      case 'ping':
        this.control({ t: 'pong', id: Number(f.id), t_hub_us: Math.round(nowUs()) });
        return;
      case 'pong':
        return;
      default:
        this.control({ t: 'error', code: 'INVALID_ARGS', message: `unknown frame ${JSON.stringify(f.t)} (one subscription per socket: open another for another stream)` });
    }
  }

  /** Text frame. */
  control(f: StreamHubFrame): void {
    if (this.state !== 'closed' && this.#ws.readyState === OPEN) {
      this.#ws.send(JSON.stringify(f), { binary: false });
      this.written++;
    }
  }

  // ---- StreamSubscriber ----

  started(info: StreamInfo): void {
    if (this.#known !== info.stream_id) {
      this.#known = info.stream_id;
      this.#blocks = 0;
      this.control({ t: 'stream.started', stream: info });
    }
  }

  block(bytes: Uint8Array, info: StreamInfo): void {
    // Only the stream it was told of (not the end of one that was stopping when it came).
    if (info.stream_id !== this.#known) {
      return;
    }
    this.#send(bytes, info.stream_id);
  }

  /** One block to the client, or dropped and counted while its socket is behind. */
  #send(bytes: Uint8Array, streamId: number): void {
    if (this.state !== 'live' || this.#ws.readyState !== OPEN) {
      return;
    }
    if (this.#blocks++ === 0) {
      this.#following = null; // the stream runs: nothing to ask again
    }
    if (this.#ws.bufferedAmount > this.#host.limits.highWater) {
      this.gaps++;
      this.#pendingGap++;
      return;
    }
    this.#flushGap(streamId);
    this.#ws.send(bytes, { binary: true });
    this.written++;
  }

  ended(frame: StreamEndedFrame): void {
    if (frame.stream_id !== this.#known) {
      return;
    }
    this.#known = null;
    if (frame.reason === 'net_lost') {
      this.#cutAt = Date.now(); // the board's connection went (it may be changing hub): a `start` follows it for a while
    }
    this.#flushGap(frame.stream_id);
    this.control(frame);
    if (frame.reason === 'error' && this.#blocks === 0) {
      this.#startAgain(); // a start asked after the board changed hub that never ran: once more in a moment
    }
  }

  /**
   * A `start` asked after the board changed hub did not run (busy, or its stream ended `error` before a block): asked
   * again a moment later, where the board is then. False when it is not such a start, or it was tried often enough.
   */
  #startAgain(): boolean {
    const f = this.#following;
    if (!f || f.tries >= FOLLOW_TRIES || Date.now() > f.until || this.state === 'closed' || this.#retry) {
      return false;
    }
    f.tries++;
    this.#retry = setTimeout(() => {
      this.#retry = null;
      if (this.state === 'closed' || this.#following !== f || this.#known !== null) {
        return;
      }
      this.#detach('asking again');
      this.#attach(this.#where(), f.start);
    }, FOLLOW_RETRY_MS);
    return true;
  }

  #flushGap(streamId: number): void {
    if (this.#pendingGap > 0) {
      const blocks = this.#pendingGap;
      this.#pendingGap = 0;
      this.control({ t: 'stream.gap', stream_id: streamId, blocks });
    }
  }

  // ---- life ----

  ping(): void {
    if (Date.now() - this.lastRx > this.#host.limits.deadMs) {
      this.#ws.terminate();
      return;
    }
    if (this.state === 'live') {
      this.control({ t: 'ping', id: ++this.#pingId });
    }
  }

  close(code: number, reason: string): void {
    if (this.state === 'closed') {
      return;
    }
    this.closed();
    try {
      this.#ws.close(code, reason.slice(0, 120));
    } catch {
      // already closing
    }
    setTimeout(() => this.#ws.terminate(), 1000).unref();
  }

  closed(): void {
    if (this.state === 'closed') {
      return;
    }
    this.state = 'closed';
    if (this.#helloTimer) {
      clearTimeout(this.#helloTimer);
      this.#helloTimer = null;
    }
    for (const t of [this.#settle, this.#retry]) {
      if (t) {
        clearTimeout(t);
      }
    }
    this.#settle = this.#retry = null;
    this.#unwatch?.();
    this.#unwatch = null;
    this.#detach('the client left'); // the last starter leaving stops an app's stream, here or at the hub that runs it
    this.#host.gone(this);
  }

  /** Leaves where the socket is attached: this hub's stream registry, or the relay at another hub (which then does the same there). */
  #detach(why: string): void {
    const off = this.#off;
    this.#off = null;
    off?.();
    const relay = this.#relay;
    this.#relay = null;
    this.#relayN++;
    relay?.close(why);
  }

  /** Refused at the hello: an error frame saying why, then 4400 (the SDK does not retry it). */
  #refuse(code: string, message: string): void {
    this.state = 'live'; // so the error frame goes out
    this.control({ t: 'error', code, message });
    this.close(4400, message);
  }

  #hello(f: Record<string, unknown>): void {
    const problem = helloProblem(f);
    if (problem) {
      this.close(4400, problem);
      return;
    }
    const hello = f as unknown as StreamHelloFrame;
    if (hello.v !== APP_PROTOCOL_V) {
      this.close(4409, `this hub speaks fr-app/${APP_PROTOCOL_V}, not ${hello.v}`);
      return;
    }
    if (this.#host.relayedFrom === undefined) {
      const token = this.#host.token();
      if (token === null || !tokenMatches(token, hello.token)) {
        this.close(4401, token === null ? 'the hub has no /app token (secrets.json unreadable)' : 'bad token');
        return;
      }
    }
    if (this.#helloTimer) {
      clearTimeout(this.#helloTimer);
      this.#helloTimer = null;
    }
    const hub = this.#host.hub();
    const reg = hub.registry;
    const found = DEVICE_ID.test(hello.device) ? reg.get(hello.device) : reg.byAlias(hello.device);
    const dev: Device | null = appVisible(found) ? found : null;
    if (!dev) {
      this.#refuse('NOT_FOUND', `no provisioned device ${JSON.stringify(hello.device)}`);
      return;
    }
    this.#asked = hello;
    this.#dev = dev;
    this.#attach(this.#where(), hello.start);
    if (this.state !== 'closed' && this.#host.relayedFrom === undefined && hub.peers) {
      this.#watch(hub, dev.device_id);
    }
  }

  // ---- where the board is (design multi-hub-m2 §8) ----

  /** Where the board's streams run now: this hub (it holds the board, or no hub does), or the peer that holds it. */
  #where(): Place {
    const hub = this.#host.hub();
    const id = this.#dev!.device_id;
    if (this.#host.relayedFrom !== undefined || !hub.peers || isUp(hub.router.presence(id))) {
      return { kind: 'here' };
    }
    const held = hub.peers.holder(id);
    return held ? { kind: 'peer', id: held.id, name: held.name } : { kind: 'here' };
  }

  #attach(place: Place, start: StreamHelloFrame['start']): void {
    this.#place = place;
    if (place.kind === 'peer') {
      this.#attachRelay(place, start);
    } else {
      this.#attachLocal(start);
    }
  }

  /** Follows the board: its session starting or ending here, and what the peers say of it. */
  #watch(hub: HubContext, deviceId: string): void {
    const moved = () => {
      if (this.state === 'closed' || this.#settle) {
        return;
      }
      this.#settle = setTimeout(() => {
        this.#settle = null;
        this.#follow();
      }, FOLLOW_SETTLE_MS);
    };
    const offBus = hub.events.subscribe((e) => {
      if (e.device === deviceId && (e.type === 'device.online' || e.type === 'device.offline')) {
        moved();
      }
    });
    const offPeers = hub.peers!.onRemote((e) => {
      if (e.device === deviceId) {
        moved();
      }
    });
    this.#unwatch = () => {
      offBus();
      offPeers();
    };
  }

  /** The board may be somewhere else now: when it is, the socket leaves where it was and attaches there. */
  #follow(): void {
    if (this.state === 'closed' || !this.#dev || !this.#asked) {
      return;
    }
    const hub = this.#host.hub();
    const now = this.#where();
    const was = this.#place;
    const attached = this.#off !== null || this.#relay !== null;
    const same = was !== null && was.kind === now.kind && (now.kind === 'here' || (was.kind === 'peer' && was.id === now.id));
    if (same && attached) {
      return;
    }
    // On no hub: what the socket is attached to is kept (the board may come back there); a relay that ended is not.
    const nowhere = now.kind === 'here' && !isUp(hub.router.presence(this.#dev.device_id));
    if (nowhere && attached) {
      return;
    }
    const watching = this.#known !== null;
    this.#detach(`${this.#dev.alias} is ${now.kind === 'peer' ? `at hub ${now.name}` : nowhere ? 'on no hub' : 'at this hub'} now`);
    this.#cut();
    if (nowhere) {
      this.#place = null; // on no hub: the socket waits, and follows when a hub holds the board
      return;
    }
    // A stream this client asked for and was watching is asked for again where the board is; one that merely waited is not.
    const again = this.#asked.start !== undefined && (watching || Date.now() - this.#cutAt < FOLLOW_START_MS);
    this.#following = again ? { start: this.#asked.start!, tries: 0, until: Date.now() + FOLLOW_START_MS } : null;
    this.#attach(now, again ? this.#asked.start : undefined);
  }

  /** The stream the client was watching is over for it (the board moved, the link was lost): told once. */
  #cut(): void {
    if (this.#known !== null) {
      const id = this.#known;
      this.#known = null;
      this.#cutAt = Date.now();
      this.#flushGap(id);
      this.control({ t: 'stream.ended', stream_id: id, reason: 'net_lost', records: 0, dropped: 0 });
    }
  }

  /** The welcome, once per socket; an attachment after the first tells a running stream as `stream.started`. */
  #welcome(dev: Device, instance: string, stream: StreamInfo | null): void {
    if (!this.#welcomed) {
      this.#welcomed = true;
      this.#known = stream?.stream_id ?? null;
      this.#blocks = 0;
      this.control({ t: 'stream.welcome', v: 1, device: dev.device_id, alias: dev.alias, instance, stream });
    } else if (stream) {
      this.started(stream);
    }
  }

  /** An error at an attachment: a refusal (4400) before the welcome, an `error` frame after it (the socket stays). */
  #problem(code: string, message: string): void {
    if (this.#welcomed) {
      this.control({ t: 'error', code, message });
    } else {
      this.#refuse(code, message);
    }
  }

  // ---- this hub's own streams ----

  #attachLocal(start: StreamHelloFrame['start']): void {
    const hub = this.#host.hub();
    const dev = this.#dev!;
    const hello = this.#asked!;
    let inst: PortCap;
    try {
      inst = streamInstance(hub, dev, hello.instance);
      const bad = start ? startProblem(inst, start) : null;
      if (bad) {
        throw new FrError('INVALID_ARGS', bad);
      }
    } catch (e) {
      this.#problem(e instanceof FrError ? e.code : 'INTERNAL', (e as Error).message);
      return;
    }
    const instName = inst.name;
    const live = liveStreams(hub);
    const running = live.get(dev.device_id, instName);
    let startError: { code: string; message: string } | null = null;
    let queued = false;
    if (start && running?.stopping) {
      queued = true; // ending: the next stream begins once it ended (below), not a join of what is left of it
    } else if (start && running && !running.live) {
      startError = {
        code: 'DEVICE_BUSY',
        message: `${dev.alias} ${instName} runs stream ${running.info.stream_id}${running.jobId ? ` (job ${running.jobId})` : ''}, which is not published live (${running.info.kind === 'jpeg' ? 'camera_stream' : 'csi_stream'} live false): no live stream starts while it runs; this socket gets the next live one`,
      };
    } else if (start && !running) {
      startError = this.#start(dev, instName, start);
    }
    this.state = 'live';
    this.#off = live.subscribe(dev.device_id, instName, this, start !== undefined);
    const s = queued ? null : live.liveStream(dev.device_id, instName);
    this.#welcome(dev, instName, s?.info ?? null);
    if (startError && !(startError.code === 'DEVICE_BUSY' && this.#startAgain())) {
      this.control({ t: 'error', ...startError });
    }
    if (queued) {
      const off = this.#off;
      live.afterEnd(dev.device_id, instName, () => {
        // Still here, and no other socket's queued start began it first (this one then heard stream.started).
        if (this.state === 'live' && this.#off === off && !live.get(dev.device_id, instName)) {
          const err = this.#start(dev, instName, start!);
          if (err) {
            this.control({ t: 'error', ...err });
          }
        }
      });
    }
  }

  // ---- a board another hub holds: that hub runs the stream, the hubs' link carries it ----

  #attachRelay(place: Extract<Place, { kind: 'peer' }>, start: StreamHelloFrame['start']): void {
    const hub = this.#host.hub();
    const dev = this.#dev!;
    const hello = this.#asked!;
    if (!hub.peers!.streams.speaks(place.id)) {
      this.#problem('CAPABILITY_UNSUPPORTED', `${dev.alias} is at hub ${place.name}, which does not relay live streams (it runs a version from before step 2.4 of the hubs' link): open the stream on hub ${place.name}, or update that hub and restart it`);
      return;
    }
    this.state = 'live';
    const n = ++this.#relayN;
    const mine = () => this.#relayN === n && this.state !== 'closed';
    this.#relay = hub.peers!.streams.relay(place.id, { v: hello.v, device: dev.device_id, ...(hello.instance !== undefined ? { instance: hello.instance } : {}), ...(start ? { start } : {}) }, {
      text: (json) => {
        if (!mine()) {
          return;
        }
        let f: StreamHubFrame;
        try {
          f = JSON.parse(json) as StreamHubFrame;
        } catch {
          return;
        }
        switch (f.t) {
          case 'stream.welcome':
            this.#welcome(dev, f.instance, f.stream);
            return;
          case 'stream.started':
            this.started(f.stream);
            return;
          case 'stream.ended':
            this.ended(f);
            return;
          case 'error':
            if (f.code === 'DEVICE_BUSY' && this.#known === null && this.#startAgain()) {
              return; // the board is still ending the stream its old hub ran: asked again in a moment
            }
            this.control(f);
            return;
          case 'stream.gap':
            // Blocks the holder did not send (the link, or this hub, was behind): the client's count, with its own.
            this.control(f);
            return;
          default:
            return; // ping, pong: each hub keeps its own client alive
        }
      },
      block: (bytes) => {
        if (mine() && this.#known !== null) {
          this.#send(bytes, this.#known);
        }
      },
      end: (why) => {
        if (!mine()) {
          return;
        }
        this.#relay = null;
        const code = /^\d+$/.test(why.code) ? Number(why.code) : null;
        if (!this.#welcomed) {
          // Refused before anything was shown: the holder's reason, with its close code when it gave one.
          if (code !== null && code >= 4000) {
            this.close(code, why.message);
          } else {
            this.#refuse(code !== null ? 'HUB_UNREACHABLE' : why.code === 'HUB_VERSION_MISMATCH' ? 'CAPABILITY_UNSUPPORTED' : why.code, `hub ${place.name}, which holds ${dev.alias}: ${why.message}`);
          }
          return;
        }
        this.#cut();
        if (code === null || code < 4000) {
          // The link, or that hub, went away. (A refusal, 4xxx, was said by that hub's own `error` frame just before.)
          this.control({
            t: 'error',
            code: code !== null || why.code === 'TIMEOUT' ? 'HUB_UNREACHABLE' : why.code,
            message: `the stream of ${dev.alias} through hub ${place.name} ended: ${why.message || 'that hub closed it'}; this socket follows the board when a hub holds it again`,
          });
        }
        // The board may already be somewhere else (a hub that stopped hands its boards over).
        if (!this.#settle) {
          this.#settle = setTimeout(() => {
            this.#settle = null;
            this.#follow();
          }, FOLLOW_SETTLE_MS);
        }
      },
    });
  }

  /** Begins an app's live stream on the instance (a csi stream, or a camera's live view to the hub); null, else why none started (the socket stays and waits). */
  #start(dev: Device, instName: string, start: NonNullable<StreamHelloFrame['start']>): { code: string; message: string } | null {
    const hub = this.#host.hub();
    try {
      const p = hub.router.presence(dev.device_id);
      if (p !== 'online' && p !== 'suspect') {
        // Asked of this hub because it held the board; it does not now (the asking hub follows the board by itself).
        const held = hub.peers?.holder(dev.device_id);
        throw new FrError('DEVICE_OFFLINE', held ? `${dev.alias} is at hub ${held.name} now, not at this hub` : `${dev.alias} is ${p}`);
      }
      const inst = streamInstance(hub, dev, instName);
      if (inst.cap === CAMERA_CAP) {
        beginCameraStream(hub, {
          dev,
          inst: cameraInstance(hub, dev, instName),
          seconds: 0,
          intervalMs: start.interval_ms ?? 0,
          maxFrames: 0,
          to: 'hub',
          live: true,
          ...(start.frame_size !== undefined ? { frameSize: start.frame_size } : {}),
          ...(start.quality !== undefined ? { quality: start.quality } : {}),
          appOwned: true,
          origin: 'app',
          ...(this.#host.relayedFrom !== undefined ? { via: this.#host.relayedFrom } : {}),
        });
        return null;
      }
      const peerMac = start.peer !== undefined ? resolvePeer(hub, start.peer) : undefined;
      beginCsiStream(hub, {
        dev,
        inst: csiInstance(hub, dev, instName),
        seconds: 0,
        live: true,
        ...(start.source !== undefined ? { source: start.source } : {}),
        ...(peerMac ? { peerMac } : {}),
        appOwned: true,
        origin: 'app',
        ...(this.#host.relayedFrom !== undefined ? { via: this.#host.relayedFrom } : {}),
      });
      return null;
    } catch (e) {
      return { code: e instanceof FrError ? e.code : 'INTERNAL', message: (e as Error).message };
    }
  }
}
