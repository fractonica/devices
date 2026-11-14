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
  /** That stream was this page's own live view (opened with `start`), not a stream it joined. */
  lastEndOwn: boolean;
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
  lastEndOwn: false,
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
      // a new view forgets how the last one ended; one reopened as the tab shows again keeps it
      return { ...LIVE_OFF, phase: 'connecting', own: a.own, openedAt: a.at, lastEnd: a.resumed === true ? s.lastEnd : null, lastEndOwn: a.resumed === true && s.lastEndOwn, paused: a.resumed === true };
    case 'welcome':
      return { ...s, phase: 'open', stream: a.stream, closeCode: null };
    case 'started':
      // a new stream on the socket: its frames are counted afresh
      return { ...s, phase: 'open', stream: a.stream, frames: 0, helloError: null, helloMessage: null, lastEnd: null, lastEndOwn: false };
    case 'frame':
      return { ...s, frames: s.frames + 1, paused: false };
    case 'skipped':
      return { ...s, skipped: s.skipped + a.frames };
    case 'ended':
      return { ...s, stream: null, lastEnd: a.frame, lastEndOwn: s.own };
    case 'error':
      return { ...s, helloError: a.code, helloMessage: a.message };
    case 'closed':
      if (s.phase === 'off') {
        return s;
      }
      return a.final ? { ...s, phase: 'closed', stream: null, closeCode: a.code } : { ...s, phase: 'reconnecting', stream: null };
    case 'stop':
      return { ...LIVE_OFF, lastEnd: s.lastEnd, lastEndOwn: s.lastEndOwn };
    case 'pause':
      return { ...LIVE_OFF, paused: true, own: s.own, lastEnd: s.lastEnd, lastEndOwn: s.lastEndOwn };
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
  | 'playing'
  | 'photo'
  | 'busy-hidden'
  | 'paused'
  | 'not-provisioned'
  | 'no-key'
  | 'bad-key'
  | 'old-page'
  | 'reconnecting';

/** What a running stream is for (camera_status.stream.use): an app's live view, a photo, a recording, a card recording fetched. */
export type StreamUse = 'view' | 'photo' | 'record' | 'play';

/** camera_status.stream, as far as the panel reads it. */
export interface RunningStream {
  stream_id: number;
  to: 'hub' | 'sd' | 'both';
  started_at: string | null;
  seconds: number;
  interval_ms?: number;
  job_id?: string;
  /** Published on /app/stream (absent from an older hub: taken as published). */
  live?: boolean;
  /** Absent from an older hub. */
  use?: StreamUse;
  /** `use` play: the card's recording. */
  recording?: number;
  /** /app/stream sockets on it. */
  subscribers?: number;
}

/**
 * The job of a recording or PLAY to follow on this page, taken from camera_status (a recording started from another
 * page, the CLI, an agent, or this page before it was left), or null: the page shows its state and offers its stop.
 */
export function adoptable(running: RunningStream | null): { id: string; kind: 'record' | 'play'; recording?: number } | null {
  if (!running?.job_id) {
    return null;
  }
  if (running.use === 'record') {
    return { id: running.job_id, kind: 'record' };
  }
  if (running.use === 'play') {
    return { id: running.job_id, kind: 'play', ...(running.recording !== undefined ? { recording: running.recording } : {}) };
  }
  return null;
}

export interface CameraContext {
  presence: string | null | undefined;
  /** The page's live link to the hub is down (shell/link.ts). */
  hubDown: boolean;
  hasToken: boolean;
  /** camera_status.stream. */
  running: RunningStream | null;
  /** The job id of a recording (camera_stream) or PLAY (camera_sd_fetch) this page follows and that still runs. */
  ownJob: string | null;
  /** That job is PLAY of this card recording. */
  playing?: number | null;
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
  const ownWord: CameraStateName = c.playing !== null && c.playing !== undefined ? 'playing' : 'recording';
  switch (v.phase) {
    case 'connecting':
      return 'connecting';
    case 'reconnecting':
      return 'reconnecting';
    case 'open':
      if (v.helloError === 'DEVICE_BUSY' && !v.stream) {
        return 'busy-hidden';
      }
      if (ownRun || (c.ownJob !== null && !v.stream)) {
        return ownWord; // the recording or PLAY this page follows, watched
      }
      if (v.own) {
        // WATCH joined a recording this page does not follow: it is watched, not this page's own view
        if (v.stream && c.running?.use && c.running.use !== 'view' && c.running.stream_id === v.stream.stream_id) {
          return 'joined';
        }
        if (v.frames > 0 && v.stream) {
          return 'watching';
        }
        return c.sinceOpenMs > FIRST_FRAME_MS ? 'stalled' : 'starting';
      }
      return v.stream ? 'joined' : 'starting';
    default:
      break;
  }
  if (!c.hasToken && !c.running && c.ownJob === null) {
    return 'no-key';
  }
  if (ownRun || (c.ownJob !== null && c.running === null)) {
    return ownWord;
  }
  if (c.running) {
    return c.running.to === 'sd' ? 'recording' : 'busy';
  }
  return c.presence === 'suspect' ? 'suspect' : 'idle';
}

/** The view shows frames in these states. */
export function showsFrames(s: CameraStateName): boolean {
  return s === 'watching' || s === 'joined' || s === 'recording' || s === 'playing';
}

/** The STATE row's word (§3.7); `playing` names the card recording PLAY brings. */
export function stateWord(s: CameraStateName, running: RunningStream | null, playing?: number | null): string {
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
    case 'playing':
      return playing !== null && playing !== undefined ? `playing recording ${playing} from the card` : 'playing a recording from the card';
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
    case 'playing':
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
  /** A socket is open or opening on the camera (this page shows, or waits for, its frames). */
  viewing?: boolean;
  /** PLAY's card recording. */
  playing?: number | null;
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
      if (c.running?.to === 'sd') {
        return 'Recording to the card. Frames stay on the card until you play them.';
      }
      if (c.viewing) {
        return 'Waiting for the recording’s frames…';
      }
      return c.running?.live === false ? 'Recording to the hub; it is not shown live.' : 'Recording to the hub. WATCH shows it here; it goes on when you leave.';
    case 'playing':
      return c.viewing ? 'Waiting for the recording’s frames…' : `Bringing ${c.playing !== null && c.playing !== undefined ? `recording ${c.playing}` : 'the recording'} to the hub. WATCH shows it here.`;
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

// ---- the transport ----

export type TransportId = 'watch' | 'stop' | 'stop-watching' | 'stop-recording' | 'photo' | 'keep-frame' | 'record' | 'stop-other';

export interface TransportAction {
  id: TransportId;
  label: string;
  variant: 'primary' | 'default' | 'quiet' | 'destructive';
  disabled: boolean;
  /** What it does, or why it waits (a disabled action). */
  does: string;
  /** Asks this in place first. */
  confirm?: { question: string; yes: string; keep: string };
}

export interface TransportInput {
  state: CameraStateName;
  running: RunningStream | null;
  /** The recording or PLAY this page follows (started here, or taken from camera_status). */
  own: { kind: 'record' | 'play'; to?: RecordTarget; live?: boolean } | null;
  /** A socket is open or opening. */
  active: boolean;
  /** It was opened with `start` (WATCH), not to join a stream. */
  viewOwn: boolean;
  /** Frames show now. */
  framesShown: boolean;
  offline: boolean;
  hubDown: boolean;
  /** Why no live view can open at all (no key, not provisioned, a changed key, an old page), or null. */
  noWatch: string | null;
}

export interface TransportLine {
  /** The actions it is about (their labels, engraved by the caller). */
  labels: string[];
  text: string;
}

/**
 * The transport for a state (DEVICE-SPEC §3.4, §4.3): which actions show, which one is lit, which wait and why, and a
 * line per action (actions that wait for the same reason share one). What runs is read from the hub (camera_status), so
 * a recording started elsewhere or before the page was left can be stopped here. Offline or with the hub down nothing
 * can start, the view's own line says why, and no action line is written.
 */
export function transport(t: TransportInput): { actions: TransportAction[]; lines: TransportLine[] } {
  const a: TransportAction[] = [];
  const down = t.hubDown || t.offline;
  const run = t.running;
  const keep = (): void => {
    if (t.framesShown) {
      a.push({ id: 'keep-frame', label: 'Keep this frame', variant: 'quiet', disabled: false, does: 'Saves the frame you see to this computer.' });
    }
  };
  if (t.own?.kind === 'record') {
    a.push({
      id: 'stop-recording',
      label: 'Stop recording',
      variant: 'primary',
      disabled: t.hubDown,
      does: 'Stops it; what came so far is kept.',
      confirm: { question: 'Stop the recording?', yes: 'Stop', keep: 'Keep recording' },
    });
    if (t.active) {
      a.push({ id: 'stop-watching', label: 'Stop watching', variant: 'default', disabled: false, does: 'Hides the view. The recording goes on.' });
    } else {
      const why =
        t.own.to === 'sd'
          ? 'A card recording runs; its frames stay on the card until you play them.'
          : t.own.live === false || run?.live === false
            ? 'This recording is not shown live.'
            : t.noWatch;
      a.push({ id: 'watch', label: 'Watch', variant: 'default', disabled: down || why !== null, does: why ?? 'Shows the recording live here. It goes on when you leave.' });
    }
    keep();
  } else if (t.own?.kind === 'play') {
    if (t.active) {
      a.push({ id: 'stop-watching', label: 'Stop watching', variant: 'primary', disabled: false, does: 'Leaves this view. The recording still comes to the hub.' });
    } else {
      const why = run?.live === false ? 'This recording is not shown live.' : t.noWatch;
      a.push({ id: 'watch', label: 'Watch', variant: 'primary', disabled: down || why !== null, does: why ?? 'Shows the recording here as it comes to the hub.' });
    }
    keep();
  } else {
    if (t.active && t.viewOwn) {
      a.push(
        down
          ? { id: 'stop', label: 'Close the view', variant: 'primary', disabled: false, does: 'Closes the view; nothing runs here.' }
          : t.state === 'busy-hidden'
            ? { id: 'stop', label: 'Stop', variant: 'primary', disabled: false, does: 'Stops waiting for the view.' }
            : { id: 'stop', label: 'Stop', variant: 'primary', disabled: false, does: 'Stops the live view. Nothing is saved.' },
      );
    } else if (t.active) {
      a.push({ id: 'stop-watching', label: 'Stop watching', variant: 'primary', disabled: false, does: 'Leaves this view. The stream goes on.' });
    } else {
      const hidden = run !== null && (run.live === false || run.to === 'sd');
      const why = hidden ? 'The camera runs a stream that is not shown live.' : t.noWatch;
      a.push({
        id: 'watch',
        label: 'Watch',
        variant: 'primary',
        disabled: down || why !== null,
        does: why ?? (run?.use === 'view' ? 'Shows the camera live here; it is watched in another place too.' : 'Shows the camera live here. It stops when you leave this page.'),
      });
    }
    // PHOTO and RECORD… need the camera free: this page's own view is closed for them, anything else must end first
    const mine = t.active && t.viewOwn;
    const others = run ? Math.max(0, (run.subscribers ?? 0) - (t.active ? 1 : 0)) : 0;
    const stoppable = run?.job_id !== undefined && !mine;
    let blocker: string | null = null;
    const view = run !== null && (run.use === 'view' || (run.use === undefined && mine));
    if (run && !(mine && view && others === 0)) {
      blocker = view
        ? 'The camera is watched in another place too; they wait until that view closes.'
          : stoppable
            ? 'The camera runs another stream; stop it first, or wait for it to end.'
            : 'The camera runs another stream; they wait for it to end.';
    } else if (t.active && !t.viewOwn) {
      blocker = 'A stream runs; they wait for it to end.';
    }
    a.push({
      id: 'photo',
      label: 'Photo',
      variant: 'default',
      disabled: down || blocker !== null,
      does: blocker ?? (mine ? 'Takes one photo; the hub keeps it. The view pauses for it.' : 'Takes one photo; the hub keeps it.'),
    });
    keep();
    a.push({ id: 'record', label: 'Record…', variant: 'default', disabled: down || blocker !== null, does: blocker ?? 'Opens the recording settings.' });
    if (stoppable && run) {
      a.push({
        id: 'stop-other',
        label: 'Stop that stream',
        variant: 'destructive',
        disabled: t.hubDown,
        does: 'Stops the stream that runs now; what came so far is kept.',
        confirm: { question: `Stop stream ${run.stream_id}? What came so far is kept.`, yes: 'Stop', keep: 'Keep it going' },
      });
    }
  }
  const lines: TransportLine[] = [];
  if (!down) {
    for (const x of a) {
      const same = lines.find((l) => l.text === x.does);
      if (same) {
        same.labels.push(x.label);
      } else {
        lines.push({ labels: [x.label], text: x.does });
      }
    }
  }
  return { actions: a, lines };
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

/** How this page's own live view ended when the hub ended it (a job_cancel elsewhere, the board's end), in words. */
export function viewEndLine(reason: EndReason | string): string {
  switch (reason) {
    case 'stopped':
      return 'The live view was stopped from another place.';
    case 'done':
      return 'The live view ended.';
    default:
      return `The live view ended. ${endLine(reason)}`;
  }
}

/** PLAY's end in words: the recording's frames on the hub. */
export function playEndLine(recording: number | undefined, frames: string, n: number, reason: EndReason | string): string {
  const head = `${recording !== undefined ? `Recording ${recording}` : 'The recording'} is on the hub: ${frames} frame${n === 1 ? '' : 's'}.`;
  return reason === 'done' ? head : `${head} ${endLine(reason, { recording: true, frames: n })}`;
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
  head: { frameSize: string | null; quality: number; at?: number } | null,
  setHere: Partial<SensorSettings> | null,
  defaults: SensorSettings,
  /** Date.now() of this page's last accepted set of each key: a frame from before it does not override it. */
  setAt: Partial<Record<SettingKey, number>> = {},
): { values: SensorSettings; from: Record<SettingKey, SettingSource> } {
  const values = { ...defaults };
  const from = Object.fromEntries(Object.keys(defaults).map((k) => [k, 'start'])) as Record<SettingKey, SettingSource>;
  for (const [k, v] of Object.entries(setHere ?? {}) as [SettingKey, unknown][]) {
    if (k in values && v !== undefined && v !== null) {
      (values as Record<string, unknown>)[k] = v;
      from[k] = 'set-here';
    }
  }
  const newer = (k: SettingKey) => setAt[k] === undefined || (head?.at !== undefined && head.at > setAt[k]!);
  if (head) {
    if (head.frameSize && (FRAME_SIZES as readonly string[]).includes(head.frameSize) && newer('frame_size')) {
      values.frame_size = head.frameSize as FrameSize;
      from.frame_size = 'frame';
    }
    if (head.quality >= 4 && head.quality <= 63 && newer('quality')) {
      values.quality = head.quality;
      from.quality = 'frame';
    }
  }
  return { values, from };
}

/** Quality 4..63 (lower is finer) as the Detail slider's position 0..59 (right is finer), and back. */
export const detailOf = (quality: number) => 63 - Math.min(63, Math.max(4, Math.round(quality)));
export const qualityOf = (detail: number) => 63 - Math.min(59, Math.max(0, Math.round(detail)));

/** A quality as the Detail slider's word (no number: right is finer, as on the slider). */
export function detailWord(quality: number): string {
  const d = detailOf(quality);
  return d >= 50 ? 'fine' : d >= 35 ? 'medium' : 'coarse';
}

/** The Detail slider's position read aloud (aria-valuetext): a word, never the internal number. */
export function detailValueText(detail: number | null): string {
  if (detail === null) {
    return 'as the camera is set';
  }
  const w = detailWord(qualityOf(detail));
  return `${w} detail`;
}

/** A −2..2 sensor slider read aloud: less, as it starts, more. */
export function levelValueText(v: number): string {
  return v === 0 ? 'as it starts' : v < 0 ? (v <= -2 ? 'much less' : 'less') : v >= 2 ? 'much more' : 'more';
}

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

/** The /captures URL of frame `index` of a recording's directory (`<index 6 digits>.jpg`), or null. */
export function frameUrl(dir: string, index: number): string | null {
  return capturesUrl(`${dir.replace(/[\\/]+$/, '')}/${String(index).padStart(6, '0')}.jpg`);
}

/**
 * Whether a frame changes the head the page shows (Now › FRAME, the sensor settings): its size or quality differs from
 * the last shown. The view re-renders on that, not per frame; KEEP THIS FRAME reads the newest frame itself.
 */
export function headChanged(prev: { frameSize: string | null; quality: number } | null, next: { frameSize: string | null; quality: number }): boolean {
  return prev === null || prev.frameSize !== next.frameSize || prev.quality !== next.quality;
}

/** KEEP THIS FRAME's file name: no date, the stream and the frame index. */
export function keptFrameName(alias: string, instance: string, streamId: number | null, index: number): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '-');
  return `${safe(alias)}-${safe(instance)}-s${streamId ?? 0}-f${index}.jpg`;
}
