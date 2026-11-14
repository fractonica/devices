// The fr.camera panel's logic (DEVICE-SPEC §3, §4.3), pure and tested in node (test/camera-state.test.ts):
// - the live view's own state, a reducer over what the /app/stream client tells (api/stream.ts), and the panel's one
//   state name (`data-camera-state`) from it and the device, the hub and the running stream;
// - the words: each state's line, how a stream ended, the camera ops' errors, the Now rows' STATE word;
// - the card's room in frames, the recording lengths and paces offered, the paths a capture is served at;
// - where the sensor settings shown come from.
// Nothing here says an Earth unit in pure mode: the callers write spans and rates through the core.

import type { StreamEndedFrame, StreamInfo } from '@fractonica/sdk/wire';

// ---- the live view ----

export type LivePhase = 'off' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface LiveView {
  phase: LivePhase;
  /** This page asked for a live view (WATCH: the hello's `start`); false when it joined (a recording, PLAY). */
  own: boolean;
  /** The stream the socket is on (welcome or started). */
  stream: StreamInfo | null;
  /** Frames drawn since the socket opened. */
  frames: number;
  /** Frames this view did not show (the hub's backpressure and this page's own), since the socket opened. */
  skipped: number;
  /** The code of an `error` the hub sent after the hello (DEVICE_BUSY, NOT_FOUND, DEVICE_OFFLINE…), until a stream starts. */
  helloError: string | null;
  helloMessage: string | null;
  /** The close code of a final close (4400, 4401, 4409), else null. */
  closeCode: number | null;
  /** The tab is hidden: the socket was closed and reopens on return. */
  paused: boolean;
  /** How the last stream on this socket ended. */
  lastEnd: StreamEndedFrame | null;
  /** Date.now() of the open (the hello's time runs from it). */
  openedAt: number | null;
}

export const LIVE_OFF: LiveView = {
  phase: 'off',
  own: false,
  stream: null,
  frames: 0,
  skipped: 0,
  helloError: null,
  helloMessage: null,
  closeCode: null,
  paused: false,
  lastEnd: null,
  openedAt: null,
};

export type LiveAction =
  /** `resumed`: reopened as the tab shows again (the view says it was paused until a frame comes). */
  | { t: 'open'; own: boolean; at: number; resumed?: boolean }
  | { t: 'welcome'; stream: StreamInfo | null }
  | { t: 'started'; stream: StreamInfo }
  | { t: 'frame' }
  | { t: 'skipped'; frames: number }
  | { t: 'ended'; frame: StreamEndedFrame }
  | { t: 'error'; code: string; message: string }
  | { t: 'closed'; code: number; final: boolean }
  /** This page closed it (STOP, leaving, a photo). */
  | { t: 'stop' }
  | { t: 'pause' }
  | { t: 'resume' };

export function liveReducer(s: LiveView, a: LiveAction): LiveView {
  switch (a.t) {
    case 'open':
      return { ...LIVE_OFF, phase: 'connecting', own: a.own, openedAt: a.at, lastEnd: s.lastEnd, paused: a.resumed === true };
    case 'welcome':
      return { ...s, phase: 'open', stream: a.stream, closeCode: null };
    case 'started':
      return { ...s, phase: 'open', stream: a.stream, helloError: null, helloMessage: null };
    case 'frame':
      return { ...s, frames: s.frames + 1, paused: false };
    case 'skipped':
      return { ...s, skipped: s.skipped + a.frames };
    case 'ended':
      return { ...s, stream: null, lastEnd: a.frame };
    case 'error':
      return { ...s, helloError: a.code, helloMessage: a.message };
    case 'closed':
      if (s.phase === 'off') {
        return s;
      }
      return a.final ? { ...s, phase: 'closed', stream: null, closeCode: a.code } : { ...s, phase: 'reconnecting', stream: null };
    case 'stop':
      return { ...LIVE_OFF, lastEnd: s.lastEnd };
    case 'pause':
      return { ...LIVE_OFF, paused: true, own: s.own, lastEnd: s.lastEnd };
    case 'resume':
      return { ...s, paused: false };
    default:
      return s;
  }
}

// ---- the panel's state ----

export type CameraStateName =
  | 'offline'
  | 'suspect'
  | 'hub-down'
  | 'idle'
  | 'busy'
  | 'connecting'
  | 'starting'
  | 'stalled'
  | 'watching'
  | 'joined'
  | 'recording'
  | 'photo'
  | 'busy-hidden'
  | 'paused'
  | 'not-provisioned'
  | 'no-key'
  | 'bad-key'
  | 'old-page'
  | 'reconnecting';

/** camera_status.stream, as far as the panel reads it. */
export interface RunningStream {
  stream_id: number;
  to: 'hub' | 'sd' | 'both';
  started_at: string | null;
  seconds: number;
  job_id?: string;
}

export interface CameraContext {
  presence: string | null | undefined;
  /** The page's live link to the hub is down (shell/link.ts). */
  hubDown: boolean;
  hasToken: boolean;
  /** camera_status.stream. */
  running: RunningStream | null;
  /** The job id of a recording (camera_stream) or PLAY (camera_sd_fetch) this page started and that still runs. */
  ownJob: string | null;
  /** A photo (camera_snap) this page started is under way. */
  photo: boolean;
  /** ms since the socket opened (for the hello's time). */
  sinceOpenMs: number;
}

/** How long a WATCH waits for its first frame before it says none came (the hub's hello time). */
export const FIRST_FRAME_MS = 5000;

/** The panel's one state (data-camera-state), in the order the spec's table settles them. */
export function cameraState(v: LiveView, c: CameraContext): CameraStateName {
  if (c.hubDown) {
    return 'hub-down';
  }
  if (c.presence === 'offline') {
    return 'offline';
  }
  if (v.closeCode === 4401) {
    return 'bad-key';
  }
  if (v.closeCode === 4409) {
    return 'old-page';
  }
  if (v.helloError === 'NOT_FOUND' && (v.phase === 'closed' || v.phase === 'open')) {
    return 'not-provisioned';
  }
  if (c.photo) {
    return 'photo';
  }
  if (v.paused) {
    return 'paused';
  }
  const ownRun = c.running !== null && c.ownJob !== null && c.running.job_id === c.ownJob;
  switch (v.phase) {
    case 'connecting':
      return 'connecting';
    case 'reconnecting':
      return 'reconnecting';
    case 'open':
      if (v.helloError === 'DEVICE_BUSY' && !v.stream) {
        return 'busy-hidden';
      }
      if (ownRun) {
        return 'recording'; // this page's recording or PLAY, watched (joined, or WATCH joined it)
      }
      if (v.own) {
        if (v.frames > 0 && v.stream) {
          return 'watching';
        }
        return c.sinceOpenMs > FIRST_FRAME_MS ? 'stalled' : 'starting';
      }
      if (ownRun || (c.ownJob !== null && !v.stream)) {
        return 'recording';
      }
      return v.stream ? 'joined' : 'starting';
    default:
      break;
  }
  if (!c.hasToken && !c.running && c.ownJob === null) {
    return 'no-key';
  }
  if (ownRun || (c.ownJob !== null && c.running === null)) {
    return 'recording';
  }
  if (c.running) {
    return c.running.to === 'sd' ? 'recording' : 'busy';
  }
  return c.presence === 'suspect' ? 'suspect' : 'idle';
}

/** The view shows frames in these states. */
export function showsFrames(s: CameraStateName): boolean {
  return s === 'watching' || s === 'joined' || s === 'recording';
}

/** The STATE row's word (§3.7). */
export function stateWord(s: CameraStateName, running: RunningStream | null): string {
  switch (s) {
    case 'offline':
      return 'offline';
    case 'watching':
    case 'starting':
    case 'stalled':
    case 'connecting':
    case 'reconnecting':
      return 'watching';
    case 'joined':
      return running && running.to !== 'hub' ? 'watching the recording' : 'watching';
    case 'recording':
      return running?.to === 'sd' ? 'recording to the card' : running?.to === 'both' ? 'recording to the hub and the card' : 'recording to the hub';
    case 'photo':
      return 'taking a photo';
    case 'busy':
    case 'busy-hidden':
      return 'busy';
    case 'hub-down':
      return 'not known';
    default:
      return 'idle';
  }
}

export type CameraBead = 'online' | 'waiting' | 'offline' | 'fault' | 'idle';

export function stateBead(s: CameraStateName): CameraBead {
  switch (s) {
    case 'watching':
    case 'joined':
    case 'recording':
      return 'online';
    case 'connecting':
    case 'starting':
    case 'reconnecting':
    case 'photo':
    case 'busy':
    case 'busy-hidden':
    case 'suspect':
    case 'paused':
      return 'waiting';
    case 'offline':
      return 'offline';
    case 'stalled':
    case 'bad-key':
    case 'old-page':
      return 'fault';
    default:
      return 'idle';
  }
}

export interface StateLineContext {
  alias: string;
  instance: string;
  /** The device's last word, as a span text ("8.4ν") or null. */
  lastWord: string | null;
  /** The recording's or the running stream's start, as a span ago ("2ι"), or null. */
  startedAgo: string | null;
  running: RunningStream | null;
}

/** The line the view says in a state (§4.3); null when the frames say it. */
export function stateLine(s: CameraStateName, c: StateLineContext): string | null {
  switch (s) {
    case 'offline':
      return `${c.alias} is offline. The camera shows nothing until the board is back on the network.`;
    case 'suspect':
      return 'Its heartbeats are late; frames may stall.';
    case 'hub-down':
      return 'The hub is not answering; nothing can be started.';
    case 'idle':
      return 'Nothing shown yet. WATCH starts the camera.';
    case 'busy':
      return 'The camera runs a stream that is not shown here.';
    case 'connecting':
      return 'Asking the hub for the view…';
    case 'starting':
      return 'Waiting for the first frame…';
    case 'stalled':
      return `No frame came from ${c.instance}.${c.lastWord ? ` Its last word was ${c.lastWord} ago;` : ''} check that it is on the network.`;
    case 'joined':
      return c.running && c.running.to !== 'hub' ? `The recording started ${c.startedAgo ?? 'a moment'} ago.` : 'A view opened elsewhere.';
    case 'recording':
      return c.running?.to === 'sd' ? 'Recording to the card. Frames stay on the card until you play them.' : null;
    case 'photo':
      return 'Taking a photo…';
    case 'busy-hidden':
      return 'The camera is busy with a stream that is not shown live. The view starts by itself when it ends.';
    case 'paused':
      return 'Paused while this tab was hidden.';
    case 'not-provisioned':
      return 'Live view needs a device provisioned through this hub. Photos and recordings still work.';
    case 'no-key':
      return 'This page has no stream key. Reload it from the hub’s own address; if it repeats, run fr doctor --fix.';
    case 'bad-key':
      return 'The hub’s stream key changed. Reload this page.';
    case 'old-page':
      return 'This page is older than the hub. Reload it; if that does not help, run fr doctor --fix.';
    case 'reconnecting':
      return 'Reconnecting to the hub…';
    default:
      return null;
  }
}

/** The quiet line of frames this view skipped (§4.3 gaps); null for none. */
export function gapLine(skipped: number): string | null {
  return skipped > 0 ? `This view skipped ${skipped} frame${skipped === 1 ? '' : 's'} to keep up. A recording is not affected.` : null;
}

// ---- how a stream ended, and the ops' errors ----

export type EndReason = StreamEndedFrame['reason'];

/** How a stream ended, in words (§4.3). `recording`: a recording, whose frames so far are kept. */
export function endLine(reason: EndReason | string, o: { recording?: boolean; frames?: number } = {}): string {
  switch (reason) {
    case 'stopped':
      return o.recording ? `Stopped; the ${o.frames ?? 0} frame${o.frames === 1 ? '' : 's'} so far are kept.` : 'Stopped.';
    case 'done':
      return 'Done: the length or the frame count was reached.';
    case 'net_lost':
      return 'The camera lost its connection to the hub mid-stream. What arrived is kept.';
    case 'overflow':
      return 'The card is full or failed mid-recording. Free some space and try again.';
    case 'error':
      return 'The camera’s sensor failed. Restart the board, then try again.';
    case 'timeout':
      return 'No end came from the camera in time; the hub stopped waiting.';
    default:
      return 'Ended.';
  }
}

export interface ErrorContext {
  alias: string;
  instance: string;
  /** camera_status.max_frame_size. */
  maxFrameSize?: string | null;
  /** The frame size that was asked for. */
  frameSize?: string | null;
  recording?: number | null;
}

/** A camera op's error in the panel's words (§4.3); null: the hub's own message says it (ErrorLine). */
export function cameraErrorLine(code: string, message: string, c: ErrorContext): string | null {
  switch (code) {
    case 'DEVICE_BUSY':
      return 'The camera runs another stream (one at a time). Stop it first.';
    case 'DEVICE_OFFLINE':
    case 'DEVICE_UNREACHABLE':
      return `${c.alias} is offline; nothing was sent.`;
    case 'INVALID_ARGS':
      if (/frame.?size|max_frame_size|frame buffers?/i.test(message)) {
        return `The board cannot take ${c.frameSize ?? 'that frame size'}: its frame buffers were made for up to ${c.maxFrameSize ?? 'a smaller frame'}.`;
      }
      if (/card|sd\b|mounted/i.test(message)) {
        return 'There is no card mounted. Record to the hub, or put a card in and restart the board.';
      }
      return null;
    case 'CAPABILITY_UNSUPPORTED':
      return 'This build does not use the card.';
    case 'NOT_FOUND':
      return c.recording !== null && c.recording !== undefined ? `Recording ${c.recording} is no longer on the card.` : null;
    case 'TIMEOUT':
      return `No frame arrived from ${c.instance}.`;
    case 'DELIVERY_FAILED':
      return 'The camera could not send frames to the hub. The hub’s node port must be reachable from the board’s network.';
    default:
      return null;
  }
}

// ---- the card ----

export interface Recording {
  id: number;
  frames: number;
  bytes: number;
}

/** The card's recordings newest first (the hub lists them oldest first; a later stream id is a later recording). */
export function newestFirst(list: readonly Recording[]): Recording[] {
  return list.map((r, i) => ({ r, i })).sort((a, b) => b.i - a.i).map((x) => x.r);
}

/** About how many more frames of the last frame's size the card holds (two significant figures), or null. */
export function roomForFrames(sdFreeMb: number | null | undefined, lastBytes: number | null | undefined): number | null {
  if (typeof sdFreeMb !== 'number' || typeof lastBytes !== 'number' || !(lastBytes > 0) || !(sdFreeMb >= 0)) {
    return null;
  }
  const n = Math.floor((sdFreeMb * 1e6) / lastBytes);
  if (n < 100) {
    return n;
  }
  const mag = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.round(n / mag) * mag;
}

// ---- recording choices ----

/** How long a recording runs: until stopped (0), then these seconds (§3.5). */
export const RECORD_LENGTHS_S: readonly number[] = [0, 10, 60, 300, 1800, 3600];
/** One frame every …: these seconds (§3.5); 0 is as fast as it can. */
export const PACES_S: readonly number[] = [1, 5, 30, 60, 300];

/** About how many frames a recording of `seconds` at one frame every `intervalMs` takes; null for "until stopped" or as fast as it can. */
export function aboutFrames(seconds: number, intervalMs: number): number | null {
  if (!(seconds > 0) || !(intervalMs > 0)) {
    return null;
  }
  return Math.max(1, Math.floor((seconds * 1000) / intervalMs));
}

export type RecordTarget = 'hub' | 'sd' | 'both';

export const TARGET_WORDS: Readonly<Record<RecordTarget, string>> = { hub: 'hub', sd: 'card', both: 'hub and card' };

export interface RecordChoice {
  to: RecordTarget;
  seconds: number;
  intervalMs: number;
  live: boolean;
  maxFrames: number;
}

/**
 * START RECORDING's does line from the choices: "Records to the hub for 3λ 18ν, as fast as it can, and shows it here."
 * `span(seconds)` writes a length as the core's span; `pace(ms)` the pace in words.
 */
export function recordDoes(c: RecordChoice, span: (s: number) => string): string {
  const where = c.to === 'sd' ? 'to the card' : c.to === 'both' ? 'to the hub and the card' : 'to the hub';
  const long = c.seconds > 0 ? `for ${span(c.seconds)}` : 'until you stop it';
  const pace = c.intervalMs > 0 ? `one frame every ${span(c.intervalMs / 1000)}` : 'as fast as it can';
  const cap = c.maxFrames > 0 ? `, at most ${c.maxFrames} frame${c.maxFrames === 1 ? '' : 's'}` : '';
  const here = c.live && c.to !== 'sd' ? ', and shows it here' : '';
  return `Records ${where} ${long}, ${pace}${cap}${here}.`;
}

/** The camera_stream input for the choices (frame_size and quality only when chosen). */
export function recordInput(device: string, instance: string, c: RecordChoice, extra: { frame_size?: string; quality?: number } = {}) {
  return {
    device,
    instance,
    seconds: c.seconds,
    interval_ms: c.intervalMs,
    max_frames: c.maxFrames,
    to: c.to,
    live: c.to === 'sd' ? false : c.live,
    ...(extra.frame_size ? { frame_size: extra.frame_size } : {}),
    ...(extra.quality !== undefined ? { quality: extra.quality } : {}),
    wait_s: 0,
  };
}

// ---- the sensor's settings ----

export const FRAME_SIZES = ['qvga', 'vga', 'svga', 'xga', 'sxga', 'uxga'] as const;
export type FrameSize = (typeof FRAME_SIZES)[number];
export const FRAME_PIXELS: Readonly<Record<FrameSize, readonly [number, number]>> = {
  qvga: [320, 240],
  vga: [640, 480],
  svga: [800, 600],
  xga: [1024, 768],
  sxga: [1280, 1024],
  uxga: [1600, 1200],
};

/** Whether the board's frame buffers take `size` (max null: not known, every size offered). */
export function sizeAllowed(size: string, max: string | null | undefined): boolean {
  const i = FRAME_SIZES.indexOf(size as FrameSize);
  const m = max ? FRAME_SIZES.indexOf(max as FrameSize) : FRAME_SIZES.length - 1;
  return i >= 0 && i <= (m < 0 ? FRAME_SIZES.length - 1 : m);
}

/** The frame size as "800 × 600" (or the name when unknown). */
export function sizeWords(size: string | null | undefined): string {
  const px = size ? FRAME_PIXELS[size as FrameSize] : undefined;
  return px ? `${px[0]} × ${px[1]}` : (size ?? '—');
}

export interface SensorSettings {
  frame_size: FrameSize;
  quality: number;
  vflip: boolean;
  hmirror: boolean;
  brightness: number;
  contrast: number;
  saturation: number;
}

export type SettingKey = keyof SensorSettings;
export type SettingSource = 'frame' | 'set-here' | 'start';

/** The catalog's config defaults for the settings (how the board starts). */
export function settingsDefaults(config: readonly { name: string; default?: unknown }[]): SensorSettings {
  const d = (n: string) => config.find((c) => c.name === n)?.default;
  const size = d('frame_size');
  return {
    frame_size: (FRAME_SIZES as readonly string[]).includes(String(size)) ? (size as FrameSize) : 'svga',
    quality: typeof d('quality') === 'number' ? (d('quality') as number) : 12,
    vflip: d('vflip') === true,
    hmirror: d('hmirror') === true,
    brightness: typeof d('brightness') === 'number' ? (d('brightness') as number) : 0,
    contrast: typeof d('contrast') === 'number' ? (d('contrast') as number) : 0,
    saturation: typeof d('saturation') === 'number' ? (d('saturation') as number) : 0,
  };
}

/**
 * The settings shown and where each comes from (§3.6): the current frame's head (frame size and quality), then what
 * this page set last, then the build's defaults.
 */
export function settingsShown(
  head: { frameSize: string | null; quality: number } | null,
  setHere: Partial<SensorSettings> | null,
  defaults: SensorSettings,
): { values: SensorSettings; from: Record<SettingKey, SettingSource> } {
  const values = { ...defaults };
  const from = Object.fromEntries(Object.keys(defaults).map((k) => [k, 'start'])) as Record<SettingKey, SettingSource>;
  for (const [k, v] of Object.entries(setHere ?? {}) as [SettingKey, unknown][]) {
    if (k in values && v !== undefined && v !== null) {
      (values as Record<string, unknown>)[k] = v;
      from[k] = 'set-here';
    }
  }
  if (head) {
    if (head.frameSize && (FRAME_SIZES as readonly string[]).includes(head.frameSize)) {
      values.frame_size = head.frameSize as FrameSize;
      from.frame_size = 'frame';
    }
    if (head.quality >= 4 && head.quality <= 63) {
      values.quality = head.quality;
      from.quality = 'frame';
    }
  }
  return { values, from };
}

/** Quality 4..63 (lower is finer) as the Detail slider's position 0..59 (right is finer), and back. */
export const detailOf = (quality: number) => 63 - Math.min(63, Math.max(4, Math.round(quality)));
export const qualityOf = (detail: number) => 63 - Math.min(59, Math.max(0, Math.round(detail)));

// ---- captures ----

/** The /captures URL of a path the hub answered (FR_HOME/captures/<rest>), or null for a path elsewhere. */
export function capturesUrl(path: string | null | undefined): string | null {
  if (!path) {
    return null;
  }
  const norm = path.replace(/\\/g, '/');
  const at = norm.indexOf('/captures/');
  if (at < 0) {
    return null;
  }
  const rest = norm.slice(at + '/captures/'.length);
  if (!rest || rest.split('/').some((s) => s === '..' || s === '')) {
    return null;
  }
  return `captures/${rest.split('/').map(encodeURIComponent).join('/')}`;
}

/** KEEP THIS FRAME's file name: no date, the stream and the frame index. */
export function keptFrameName(alias: string, instance: string, streamId: number | null, index: number): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-');
  return `${safe(alias)}-${safe(instance)}-s${streamId ?? 0}-f${index}.jpg`;
}
