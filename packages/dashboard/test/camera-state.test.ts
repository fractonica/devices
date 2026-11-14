// The fr.camera panel's logic (src/state/camera.ts, DEVICE-SPEC §3, §4.3): the live view's reducer and the panel's one
// state; the words of each state, of how a stream ended and of the ops' errors; the card's room in frames; the
// recording lengths and paces as spans with no Earth unit; the settings' sources; the captures URL; and heldPath
// (src/state/pure-text.ts).

import { beforeAll, describe, expect, it } from 'vitest';

import { CATALOG } from '@fractonica/protocol/gen';
import { type Core, loadCore } from '@fractonica/time';

import {
  aboutFrames,
  adoptable,
  boardBusyLine,
  stateBead,
  failedViewJob,
  lastIssuedStream,
  type ListedJob,
  detailValueText,
  detailWord,
  frameUrl,
  headChanged,
  levelValueText,
  playEndLine,
  type RunningStream,
  transport,
  type TransportInput,
  viewEndLine,
  type CameraContext,
  cameraErrorLine,
  cameraState,
  capturesUrl,
  detailOf,
  endLine,
  gapLine,
  keptFrameName,
  LIVE_OFF,
  type LiveAction,
  liveReducer,
  type LiveView,
  newestFirst,
  PACES_S,
  qualityOf,
  RECORD_LENGTHS_S,
  recordDoes,
  recordInput,
  roomForFrames,
  settingsDefaults,
  settingsShown,
  sizeAllowed,
  sizeWords,
  stateLine,
  stateWord,
} from '../src/state/camera.ts';
import { spanText } from '../src/state/device-units.ts';
import { heldPath, pureSafe } from '../src/state/pure-text.ts';

let core: Core;
beforeAll(async () => {
  core = await loadCore();
});

const INFO = { stream_id: 7, kind: 'jpeg' as const, format: 'mjpg1' as const, to: 'hub' as const, interval_ms: 0, seconds: 0 };
const run = (...actions: LiveAction[]): LiveView => actions.reduce(liveReducer, LIVE_OFF);
const ctx = (over: Partial<CameraContext> = {}): CameraContext => ({ presence: 'online', hubDown: false, hasToken: true, running: null, ownJob: null, photo: false, sinceOpenMs: 0, ...over });
const ENDED = { t: 'stream.ended' as const, stream_id: 7, reason: 'stopped' as const, records: 3, dropped: 0 };

/** Anything Earth (as the page tests check it): a clock time, a date, an Earth unit after a number, a per cent, ⊕. */
const EARTH = /⊕|\d{1,2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T|\b\d+\s?(h|min|s|ms|Hz|mV|dBm)\b|%/;

describe('the live view and the panel’s state (§4.3)', () => {
  it('walks WATCH: connecting, starting, watching; the hello’s time running out says no frame came', () => {
    let v = run({ t: 'open', own: true, at: 1 });
    expect(cameraState(v, ctx())).toBe('connecting');
    v = liveReducer(v, { t: 'welcome', stream: INFO });
    expect(cameraState(v, ctx({ sinceOpenMs: 1000 }))).toBe('starting');
    expect(cameraState(v, ctx({ sinceOpenMs: 6000 }))).toBe('stalled');
    v = liveReducer(v, { t: 'frame' });
    expect(cameraState(v, ctx())).toBe('watching');
    v = liveReducer(v, { t: 'skipped', frames: 12 });
    expect(v.skipped).toBe(12);
    expect(gapLine(v.skipped)).toBe('This view skipped 12 frames to keep up. A recording is not affected.');
    expect(gapLine(0)).toBeNull();
    v = liveReducer(v, { t: 'ended', frame: ENDED });
    expect(v.lastEnd).toEqual(ENDED);
    v = liveReducer(v, { t: 'stop' });
    expect(cameraState(v, ctx())).toBe('idle');
    expect(v.lastEnd).toEqual(ENDED); // kept for the line after the session
  });

  it('says joined for a view opened elsewhere, recording for this page’s recording, busy-hidden for a stream not shown live', () => {
    const joined = run({ t: 'open', own: false, at: 1 }, { t: 'welcome', stream: INFO }, { t: 'frame' });
    expect(cameraState(joined, ctx({ running: { stream_id: 7, to: 'hub', started_at: null, seconds: 0, job_id: 'j1' } }))).toBe('joined');
    expect(cameraState(joined, ctx({ running: { stream_id: 7, to: 'hub', started_at: null, seconds: 0, job_id: 'j1' }, ownJob: 'j1' }))).toBe('recording');
    const waiting = run({ t: 'open', own: true, at: 1 }, { t: 'welcome', stream: null }, { t: 'error', code: 'DEVICE_BUSY', message: 'not published live' });
    expect(cameraState(waiting, ctx())).toBe('busy-hidden');
    // a live stream starting later clears it
    expect(cameraState(liveReducer(waiting, { t: 'started', stream: INFO }), ctx())).toBe('starting');
    // no socket: this page's card recording, someone else's stream, a stream to the card
    expect(cameraState(LIVE_OFF, ctx({ running: { stream_id: 9, to: 'sd', started_at: null, seconds: 0, job_id: 'j9' }, ownJob: 'j9' }))).toBe('recording');
    expect(cameraState(LIVE_OFF, ctx({ running: { stream_id: 9, to: 'hub', started_at: null, seconds: 0, job_id: 'j9' } }))).toBe('busy');
    // another place's live view is a view this page may join, not a busy camera
    expect(cameraState(LIVE_OFF, ctx({ running: { stream_id: 9, to: 'hub', started_at: null, seconds: 0, job_id: 'j9', use: 'view', subscribers: 1 } }))).toBe('elsewhere');
    // the board refused a start as busy while the hub runs nothing: said as busy, not as idle (nor as a failed sensor)
    expect(cameraState(LIVE_OFF, ctx({ boardBusy: true }))).toBe('board-busy');
    expect(cameraState(LIVE_OFF, ctx({ boardBusy: true, presence: 'offline' }))).toBe('offline');
    expect(cameraState(LIVE_OFF, ctx({ running: { stream_id: 9, to: 'sd', started_at: null, seconds: 0 } }))).toBe('recording');
  });

  it('puts the device, the hub and the key first; pauses and resumes with the tab', () => {
    const watching = run({ t: 'open', own: true, at: 1 }, { t: 'welcome', stream: INFO }, { t: 'frame' });
    expect(cameraState(watching, ctx({ hubDown: true }))).toBe('hub-down');
    expect(cameraState(watching, ctx({ presence: 'offline' }))).toBe('offline');
    expect(cameraState(LIVE_OFF, ctx({ presence: 'suspect' }))).toBe('suspect');
    expect(cameraState(LIVE_OFF, ctx({ hasToken: false }))).toBe('no-key');
    expect(cameraState(run({ t: 'open', own: true, at: 1 }, { t: 'closed', code: 4401, final: true }), ctx())).toBe('bad-key');
    expect(cameraState(run({ t: 'open', own: true, at: 1 }, { t: 'closed', code: 4409, final: true }), ctx())).toBe('old-page');
    expect(cameraState(run({ t: 'open', own: true, at: 1 }, { t: 'error', code: 'NOT_FOUND', message: 'no provisioned device' }, { t: 'closed', code: 4400, final: true }), ctx())).toBe('not-provisioned');
    expect(cameraState(run({ t: 'open', own: true, at: 1 }, { t: 'closed', code: 1006, final: false }), ctx())).toBe('reconnecting');
    expect(cameraState(LIVE_OFF, ctx({ photo: true }))).toBe('photo');
    const paused = liveReducer(watching, { t: 'pause' });
    expect(cameraState(paused, ctx())).toBe('paused');
    const back = liveReducer(paused, { t: 'open', own: true, at: 2, resumed: true });
    expect(cameraState(back, ctx())).toBe('paused'); // until a frame comes again
    expect(cameraState(liveReducer(liveReducer(back, { t: 'welcome', stream: INFO }), { t: 'frame' }), ctx())).toBe('watching');
    // a close after this page stopped changes nothing
    expect(liveReducer(LIVE_OFF, { t: 'closed', code: 1006, final: false })).toBe(LIVE_OFF);
  });

  it('words every state and its STATE row, pure-safe', () => {
    const c = { alias: 'cam-esp32', instance: 'cam', lastWord: '8.4ν', startedAgo: '2ι', running: null };
    expect(stateLine('offline', c)).toBe('cam-esp32 is offline. The camera shows nothing until the board is back on the network.');
    expect(stateLine('stalled', c)).toBe('No frame came from cam. Its last word was 8.4ν ago; check that it is on the network.');
    expect(stateLine('joined', { ...c, running: { stream_id: 1, to: 'both', started_at: null, seconds: 0 } })).toBe('The recording started 2ι ago.');
    expect(stateLine('joined', c)).toBe('A view opened elsewhere.');
    expect(stateLine('recording', { ...c, running: { stream_id: 1, to: 'sd', started_at: null, seconds: 0 } })).toBe('Recording to the card. Frames stay on the card until you play them.');
    expect(stateLine('watching', c)).toBeNull();
    for (const s of ['offline', 'suspect', 'hub-down', 'idle', 'busy', 'elsewhere', 'board-busy', 'connecting', 'starting', 'stalled', 'joined', 'recording', 'photo', 'busy-hidden', 'paused', 'not-provisioned', 'no-key', 'bad-key', 'old-page', 'reconnecting'] as const) {
      const line = stateLine(s, c);
      expect(line === null || pureSafe(line), s).toBe(true);
    }
    expect(stateWord('recording', { stream_id: 1, to: 'sd', started_at: null, seconds: 0 })).toBe('recording to the card');
    expect(stateWord('recording', { stream_id: 1, to: 'hub', started_at: null, seconds: 0 })).toBe('recording to the hub');
    expect(stateWord('joined', { stream_id: 1, to: 'both', started_at: null, seconds: 0 })).toBe('watching the recording');
    expect(stateWord('photo', null)).toBe('taking a photo');
    expect(stateWord('busy-hidden', null)).toBe('busy');
    expect(stateWord('elsewhere', null)).toBe('watched in another place');
    expect(stateBead('elsewhere')).toBe('online');
    expect(stateLine('elsewhere', c)).toBe('The camera is watched in another place. WATCH shows it here too.');
    expect([stateWord('board-busy', null), stateBead('board-busy'), stateLine('board-busy', c)]).toEqual(['busy', 'waiting', 'The camera is busy with a stream this hub does not know of.']);
  });

  it('says how a stream ended and each op error in the panel’s words', () => {
    expect(endLine('stopped')).toBe('Stopped.');
    expect(endLine('stopped', { recording: true, frames: 40 })).toBe('Stopped; the 40 frames so far are kept.');
    expect(endLine('done')).toBe('Done: the length or the frame count was reached.');
    expect(endLine('net_lost')).toMatch(/lost its connection/);
    expect(endLine('overflow')).toMatch(/card is full/);
    expect(endLine('error')).toMatch(/sensor failed/);
    expect(endLine('timeout')).toMatch(/hub stopped waiting/);
    const c = { alias: 'cam-esp32', instance: 'cam', maxFrameSize: 'svga', frameSize: 'sxga', recording: 7 };
    expect(cameraErrorLine('DEVICE_BUSY', '', c)).toBe('The camera runs another stream (one at a time). Stop it first.');
    expect(cameraErrorLine('DEVICE_OFFLINE', '', c)).toBe('cam-esp32 is offline; nothing was sent.');
    expect(cameraErrorLine('INVALID_ARGS', 'frame_size sxga is above the build’s max_frame_size svga', c)).toBe('The board cannot take sxga: its frame buffers were made for up to svga.');
    expect(cameraErrorLine('INVALID_ARGS', 'to sd needs a card mounted', c)).toBe('There is no card mounted. Record to the hub, or put a card in and restart the board.');
    expect(cameraErrorLine('CAPABILITY_UNSUPPORTED', '', c)).toBe('This build does not use the card.');
    expect(cameraErrorLine('NOT_FOUND', '', c)).toBe('Recording 7 is no longer on the card.');
    expect(cameraErrorLine('TIMEOUT', '', c)).toBe('No frame arrived from cam.');
    expect(cameraErrorLine('DELIVERY_FAILED', '', c)).toMatch(/node port must be reachable/);
    expect(cameraErrorLine('INTERNAL', 'boom', c)).toBeNull();
  });
});

describe('the card, the recording choices, the settings (§3.5–§3.8)', () => {
  it('counts the card’s room in frames of the last frame’s size, to two figures', () => {
    expect(roomForFrames(3712, 38_400)).toBe(97_000);
    expect(roomForFrames(1, 40_000)).toBe(25);
    expect(roomForFrames(0, 40_000)).toBe(0);
    expect(roomForFrames(3712, null)).toBeNull();
    expect(roomForFrames(null, 38_400)).toBeNull();
    expect(roomForFrames(3712, 0)).toBeNull();
  });

  it('lists recordings newest first', () => {
    expect(newestFirst([{ id: 3, frames: 1, bytes: 1 }, { id: 9, frames: 2, bytes: 2 }, { id: 12, frames: 3, bytes: 3 }]).map((r) => r.id)).toEqual([12, 9, 3]);
  });

  it('writes the recording lengths and paces as spans with no Earth unit, and the does line from the choices', () => {
    expect(RECORD_LENGTHS_S).toEqual([0, 10, 60, 300, 1800, 3600]);
    expect(PACES_S).toEqual([1, 5, 30, 60, 300]);
    for (const s of [...RECORD_LENGTHS_S.filter((x) => x > 0), ...PACES_S]) {
      const t = spanText(core, s * 1e6, 2);
      expect(t, String(s)).not.toMatch(/\bs\b|sec|min|EARTH/);
      expect(EARTH.test(t), t).toBe(false);
      expect(t).toMatch(/[νλιη]/);
    }
    const span = (s: number) => spanText(core, s * 1e6, 2);
    const does = recordDoes({ to: 'sd', seconds: 300, intervalMs: 5000, live: true, maxFrames: 0 }, span);
    expect(does).toMatch(/^Records to the card for .+, one frame every .+\.$/);
    expect(does).not.toContain('shows it here'); // a card recording is never live
    expect(EARTH.test(does)).toBe(false);
    expect(recordDoes({ to: 'hub', seconds: 0, intervalMs: 0, live: true, maxFrames: 600 }, span)).toBe('Records to the hub until you stop it, as fast as it can, at most 600 frames, and shows it here.');
    expect(aboutFrames(300, 5000)).toBe(60);
    expect(aboutFrames(0, 5000)).toBeNull();
    expect(aboutFrames(60, 0)).toBeNull();
    expect(recordInput('id:a0', 'cam', { to: 'sd', seconds: 60, intervalMs: 0, live: true, maxFrames: 0 })).toEqual({ device: 'id:a0', instance: 'cam', seconds: 60, interval_ms: 0, max_frames: 0, to: 'sd', live: false, wait_s: 0 });
    expect(recordInput('id:a0', 'cam', { to: 'both', seconds: 0, intervalMs: 1000, live: true, maxFrames: 5 }, { frame_size: 'xga', quality: 10 })).toMatchObject({ to: 'both', live: true, frame_size: 'xga', quality: 10 });
  });

  it('offers the frame sizes the buffers take, in pixels; detail inverts quality', () => {
    expect(sizeAllowed('sxga', 'svga')).toBe(false);
    expect(sizeAllowed('svga', 'svga')).toBe(true);
    expect(sizeAllowed('uxga', null)).toBe(true);
    expect(sizeWords('svga')).toBe('800 × 600');
    expect(detailOf(63)).toBe(0);
    expect(detailOf(4)).toBe(59);
    expect(qualityOf(detailOf(12))).toBe(12);
  });

  it('shows the settings from the frame’s head, then what was set here, then how it starts', () => {
    const cam = CATALOG.capabilities.find((c) => c.name === 'fr.camera')!;
    const d = settingsDefaults(cam.config);
    expect(d).toEqual({ frame_size: 'svga', quality: 12, vflip: false, hmirror: false, brightness: 0, contrast: 0, saturation: 0 });
    const s = settingsShown({ frameSize: 'vga', quality: 20 }, { frame_size: 'xga', vflip: true }, d);
    expect(s.values).toMatchObject({ frame_size: 'vga', quality: 20, vflip: true, hmirror: false });
    expect(s.from).toMatchObject({ frame_size: 'frame', quality: 'frame', vflip: 'set-here', hmirror: 'start' });
    expect(settingsShown(null, null, d).from.frame_size).toBe('start');
  });

  it('serves a capture under FR_HOME/captures at /captures, nothing elsewhere; names a kept frame with no date', () => {
    expect(capturesUrl('/Users/x/.fractonica/captures/cam-esp32/20261114-020304.567.jpg')).toBe('captures/cam-esp32/20261114-020304.567.jpg');
    expect(capturesUrl('/tmp/fr-home/captures/cam-esp32/20261114-020304/000003.jpg')).toBe('captures/cam-esp32/20261114-020304/000003.jpg');
    expect(capturesUrl('/elsewhere/shot.jpg')).toBeNull();
    expect(capturesUrl('/h/captures/../secrets.json')).toBeNull();
    expect(capturesUrl(null)).toBeNull();
    expect(keptFrameName('cam-esp32', 'cam', 941, 12)).toBe('cam-esp32-cam-s941-f12.jpg');
  });
});

describe('heldPath (§3.9)', () => {
  it('replaces each capture stamp by ⊕ and keeps the rest of the path', () => {
    expect(heldPath('/Users/x/.fractonica/captures/cam-esp32/20261114-020304.567.jpg')).toBe('/Users/x/.fractonica/captures/cam-esp32/⊕.jpg');
    expect(heldPath('/h/captures/cam-esp32/20261114-020304.567-2/000003.jpg')).toBe('/h/captures/cam-esp32/⊕-2/000003.jpg');
    expect(heldPath('/h/captures/cam-esp32/sd-7/')).toBe('/h/captures/cam-esp32/sd-7/');
    expect(heldPath('/h/captures/cam-esp32/20261114-020304')).not.toMatch(/\d{8}-\d{6}/);
  });
});

describe('what runs is read from the hub; the transport for each state (review fixes)', () => {
  const rec = (over: Partial<RunningStream> = {}): RunningStream => ({ stream_id: 9, to: 'hub', started_at: null, seconds: 0, job_id: 'j9', live: true, use: 'record', subscribers: 0, ...over });
  const tIn = (over: Partial<TransportInput> = {}): TransportInput => ({ state: 'idle', running: null, own: null, active: false, viewOwn: false, framesShown: false, offline: false, hubDown: false, noWatch: null, ...over });
  const ids = (x: ReturnType<typeof transport>) => x.actions.map((a) => `${a.id}${a.variant === 'primary' ? '*' : ''}${a.disabled ? '-' : ''}`);

  it('takes up a recording or PLAY camera_status shows (not a live view or a photo)', () => {
    expect(adoptable(rec())).toEqual({ id: 'j9', kind: 'record' });
    expect(adoptable(rec({ use: 'play', recording: 7 }))).toEqual({ id: 'j9', kind: 'play', recording: 7 });
    expect(adoptable(rec({ use: 'view' }))).toBeNull();
    expect(adoptable(rec({ use: 'photo' }))).toBeNull();
    expect(adoptable(rec({ use: undefined }))).toBeNull(); // an older hub: not known
    expect(adoptable(rec({ job_id: undefined }))).toBeNull();
    expect(adoptable(null)).toBeNull();
  });

  it('a WATCH that joined a recording this page does not follow is joined, not this page’s own view', () => {
    const v = run({ t: 'open', own: true, at: 1 }, { t: 'welcome', stream: { ...INFO, stream_id: 9 } }, { t: 'frame' });
    expect(cameraState(v, ctx({ running: rec() }))).toBe('joined');
    expect(cameraState(v, ctx({ running: rec(), ownJob: 'j9' }))).toBe('recording');
    expect(cameraState(v, ctx({ running: rec({ use: 'play' }), ownJob: 'j9', playing: 7 }))).toBe('playing');
    expect(cameraState(v, ctx({ running: rec({ use: 'view' }) }))).toBe('watching');
    expect(cameraState(LIVE_OFF, ctx({ running: rec({ use: 'play' }), ownJob: 'j9', playing: 7 }))).toBe('playing');
    expect(stateWord('playing', rec(), 7)).toBe('playing recording 7 from the card');
  });

  it('a stream that ends on the socket is no longer stalled; a new stream counts its frames afresh; a new view forgets the last end', () => {
    let v = run({ t: 'open', own: true, at: 1 }, { t: 'welcome', stream: INFO }, { t: 'frame' }, { t: 'ended', frame: { ...ENDED, reason: 'stopped' } });
    expect(v.lastEnd?.reason).toBe('stopped');
    expect(v.lastEndOwn).toBe(true);
    v = liveReducer(v, { t: 'stop' });
    expect(cameraState(v, ctx())).toBe('idle');
    expect(v.lastEndOwn).toBe(true);
    expect(viewEndLine('stopped')).toBe('The live view was stopped from another place.');
    expect(viewEndLine('net_lost')).toBe('The live view ended. The camera lost its connection to the hub mid-stream. What arrived is kept.');
    expect(liveReducer(v, { t: 'open', own: true, at: 2 }).lastEnd).toBeNull();
    const two = run({ t: 'open', own: false, at: 1 }, { t: 'welcome', stream: INFO }, { t: 'frame' }, { t: 'started', stream: { ...INFO, stream_id: 8 } });
    expect(two.frames).toBe(0);
    const joinedEnd = run({ t: 'open', own: false, at: 1 }, { t: 'welcome', stream: INFO }, { t: 'ended', frame: ENDED });
    expect(joinedEnd.lastEndOwn).toBe(false);
  });

  it('idle: WATCH is lit; PHOTO and RECORD… say what they do; offline or with the hub down nothing starts and no action line is written', () => {
    const idle = transport(tIn());
    expect(ids(idle)).toEqual(['watch*', 'photo', 'record']);
    expect(idle.lines.map((l) => [l.labels.join('+'), l.text])).toEqual([
      ['Watch', 'Shows the camera live here. It stops when you leave this page.'],
      ['Photo', 'Takes one photo; the hub keeps it.'],
      ['Record…', 'Opens the recording settings.'],
    ]);
    const off = transport(tIn({ offline: true }));
    expect(ids(off)).toEqual(['watch*-', 'photo-', 'record-']);
    expect(off.lines).toEqual([]);
    // a view left open as the board went offline: it can be closed, nothing says "stop it first"
    const cut = transport(tIn({ offline: true, active: true, viewOwn: true, running: rec({ use: 'view', subscribers: 1 }) }));
    expect(cut.actions[0]).toMatchObject({ id: 'stop', label: 'Close the view', disabled: false });
    expect(cut.lines).toEqual([]);
  });

  it('watching its own view: STOP lit; PHOTO pauses it; KEEP THIS FRAME; watched in another place too, PHOTO and RECORD… wait at once', () => {
    const w = transport(tIn({ state: 'watching', active: true, viewOwn: true, framesShown: true, running: rec({ use: 'view', subscribers: 1 }) }));
    expect(ids(w)).toEqual(['stop*', 'photo', 'keep-frame', 'record']);
    expect(w.actions.find((a) => a.id === 'photo')!.does).toBe('Takes one photo; the hub keeps it. The view pauses for it.');
    const two = transport(tIn({ state: 'watching', active: true, viewOwn: true, framesShown: true, running: rec({ use: 'view', subscribers: 2 }) }));
    expect(ids(two)).toEqual(['stop*', 'photo-', 'keep-frame', 'record-']);
    expect(two.lines.find((l) => l.labels.includes('Photo'))).toEqual({ labels: ['Photo', 'Record…'], text: 'The camera is watched in another place too; they wait until that view closes.' });
  });

  it('a recording this page follows (started here or elsewhere): STOP RECORDING lit; WATCH joins it, or says why it cannot', () => {
    const r = transport(tIn({ state: 'recording', running: rec(), own: { kind: 'record', to: 'hub', live: true } }));
    expect(ids(r)).toEqual(['stop-recording*', 'watch']);
    expect(r.actions[0]!.confirm).toEqual({ question: 'Stop the recording?', yes: 'Stop', keep: 'Keep recording' });
    expect(r.actions[1]!.does).toBe('Shows the recording live here. It goes on when you leave.');
    const watching = transport(tIn({ state: 'recording', running: rec(), own: { kind: 'record', to: 'hub', live: true }, active: true, framesShown: true }));
    expect(ids(watching)).toEqual(['stop-recording*', 'stop-watching', 'keep-frame']);
    expect(watching.actions[1]!.does).toBe('Hides the view. The recording goes on.');
    const card = transport(tIn({ state: 'recording', running: rec({ to: 'sd', live: false }), own: { kind: 'record', to: 'sd' } }));
    expect(ids(card)).toEqual(['stop-recording*', 'watch-']);
    expect(card.actions[1]!.does).toBe('A card recording runs; its frames stay on the card until you play them.');
    const hidden = transport(tIn({ state: 'recording', running: rec({ live: false }), own: { kind: 'record', to: 'hub', live: false } }));
    expect(hidden.actions[1]!.does).toBe('This recording is not shown live.');
  });

  it('PLAY: STOP WATCHING or WATCH lit, and STOP PLAYING; nothing else starts', () => {
    const p = transport(tIn({ state: 'playing', running: rec({ use: 'play' }), own: { kind: 'play' }, active: true, framesShown: true }));
    expect(ids(p)).toEqual(['stop-watching*', 'stop-play', 'keep-frame']);
    expect(p.actions[1]!.does).toBe('Stops bringing it; what came so far stays on the hub, and the card keeps the recording.');
    expect(ids(transport(tIn({ state: 'playing', running: rec({ use: 'play' }), own: { kind: 'play' } })))).toEqual(['watch*', 'stop-play']);
  });

  it('another stream runs: STOP THAT STREAM sits beside "stop it first"; another place’s view is watched too, never stopped by a note alone', () => {
    const busy = transport(tIn({ state: 'busy', running: rec({ use: 'photo', live: false }) }));
    expect(ids(busy)).toEqual(['watch*-', 'photo-', 'record-', 'stop-other']);
    expect(busy.lines.find((l) => l.labels.includes('Photo'))!.text).toBe('The camera runs another stream; stop it first, or wait for it to end.');
    // another place's live view: WATCH joins it; nothing here stops someone's view (nothing of it is kept)
    const view = transport(tIn({ state: 'elsewhere', running: rec({ use: 'view', subscribers: 1 }) }));
    expect(ids(view)).toEqual(['watch*', 'photo-', 'record-']);
    expect(view.actions[0]!.does).toBe('Shows the camera live here; it is watched in another place too.');
    expect(view.lines.find((l) => l.labels.includes('Photo'))!.text).toBe('The camera is watched in another place; they wait until that view closes.');
    const noJob = transport(tIn({ state: 'busy', running: rec({ use: 'photo', live: false, job_id: undefined }) }));
    expect(noJob.actions.map((a) => a.id)).not.toContain('stop-other');
    expect(noJob.lines.find((l) => l.labels.includes('Photo'))!.text).toBe('The camera runs another stream; they wait for it to end.');
  });

  it('a board busy with a stream the hub does not know of: its words, the stream id to stop, the failed view job', () => {
    expect(boardBusyLine(true)).toBe('The camera is busy with a stream this hub does not know of; it may have gone on after its link was lost. STOP IT ON THE BOARD ends it.');
    expect(boardBusyLine(false)).toMatch(/Restart the board to end it, then try again\.$/);
    expect(pureSafe(boardBusyLine(true)) && pureSafe(boardBusyLine(false))).toBe(true);
    const ring = [
      { type: 'stream.started', device: 'd1', fields: { instance: 'cam', stream_id: 4 } },
      { type: 'stream.started', device: 'd2', fields: { instance: 'cam', stream_id: 5 } },
      { type: 'stream.started', device: 'd1', fields: { instance: 'csi', stream_id: 6 } },
      { type: 'stream.ended', device: 'd1', fields: { instance: 'cam', stream_id: 4 } },
    ];
    expect(lastIssuedStream(ring, 'd1', 'cam')).toBe(4);
    expect(lastIssuedStream(ring, 'd3', 'cam')).toBeNull();
    const at = Date.parse('2026-11-14T10:00:00Z');
    const job = (over: Partial<ListedJob> = {}): ListedJob => ({ kind: 'camera', status: 'failed', origin: 'app', targets: ['d1'], created_at: '2026-11-14T10:00:01Z', error: { code: 'DEVICE_BUSY', message: 'busy: another stream runs on it' }, ...over });
    expect(failedViewJob([job()], 'd1', at)).toEqual({ code: 'DEVICE_BUSY', message: 'busy: another stream runs on it' });
    expect(failedViewJob([job({ origin: 'dashboard' }), job({ status: 'completed' }), job({ targets: ['d2'] }), job({ kind: 'csi' })], 'd1', at)).toBeNull();
    expect(failedViewJob([job({ created_at: '2026-11-14T09:50:00Z' })], 'd1', at)).toBeNull(); // long before this view
    expect(failedViewJob([job({ error: undefined })], 'd1', at)).toEqual({ code: 'INTERNAL', message: '' });
  });

  it('words the detail and the levels (no internal number), PLAY’s end, a recording’s frame URLs', () => {
    expect(detailWord(12)).toBe('fine');
    expect(detailWord(25)).toBe('medium');
    expect(detailWord(50)).toBe('coarse');
    expect(detailValueText(detailOf(12))).toBe('fine detail');
    expect(detailValueText(null)).toBe('as the camera is set');
    expect([-2, -1, 0, 1, 2].map(levelValueText)).toEqual(['much less', 'less', 'as it starts', 'more', 'much more']);
    expect(playEndLine(7, '100', 100, 'done')).toBe('Recording 7 is on the hub: 100 frames.');
    expect(playEndLine(7, '40', 40, 'stopped')).toBe('Recording 7 is on the hub: 40 frames. Stopped; the 40 frames so far are kept.');
    expect(frameUrl('/h/captures/cam-esp32/20261114-101500/', 24)).toBe('captures/cam-esp32/20261114-101500/000024.jpg');
    expect(frameUrl('/elsewhere/x', 1)).toBeNull();
  });

  it('the head re-renders only when the frame size or quality changes', () => {
    expect(headChanged(null, { frameSize: 'svga', quality: 12 })).toBe(true);
    expect(headChanged({ frameSize: 'svga', quality: 12 }, { frameSize: 'svga', quality: 12 })).toBe(false);
    expect(headChanged({ frameSize: 'svga', quality: 12 }, { frameSize: 'vga', quality: 12 })).toBe(true);
    expect(headChanged({ frameSize: 'svga', quality: 12 }, { frameSize: 'svga', quality: 10 })).toBe(true);
  });

  it('a frame from before a setting was set here does not put the old value back', () => {
    const d = settingsDefaults(CATALOG.capabilities.find((c) => c.name === 'fr.camera')!.config);
    const before = settingsShown({ frameSize: 'svga', quality: 12, at: 100 }, { frame_size: 'vga' }, d, { frame_size: 200 });
    expect(before.values.frame_size).toBe('vga');
    expect(before.from.frame_size).toBe('set-here');
    const after = settingsShown({ frameSize: 'vga', quality: 12, at: 300 }, { frame_size: 'vga' }, d, { frame_size: 200 });
    expect(after.from.frame_size).toBe('frame');
  });
});
