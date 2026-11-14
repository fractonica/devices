// The fr.camera instrument page (DEVICE-SPEC §3.4–§3.7, §4.3): the live view, the transport (WATCH is the page's one
// lumen action), the Record form in place, the Now rows, and the folds SENSOR SETTINGS and CARD RECORDINGS. Nothing
// here sends a raw stream_start: WATCH opens /app/stream with `start`, PHOTO runs camera_snap, RECORD camera_stream,
// PLAY camera_sd_fetch, and a recording or PLAY is watched by joining its live stream.

import { useNavigate, useSearch } from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import type { StreamStart } from '../../../../api/stream.ts';
import { rest, store } from '../../../../runtime.ts';
import { TERMINAL_JOB_STATUSES, type Job } from '../../../../api/types.ts';
import { BACKOFF_MS } from '../../../../api/ws.ts';
import { useAct, useLive, useOp } from '../../../../hooks.ts';
import { useLinkDown, usePresence } from '../../../../shell/link.ts';
import {
  cameraState,
  type CameraStateName,
  capturesUrl,
  endLine,
  FRAME_SIZES,
  type FrameSize,
  gapLine,
  keptFrameName,
  type RecordChoice,
  recordInput,
  roomForFrames,
  showsFrames,
  sizeWords,
  stateBead,
  stateLine,
  stateWord,
} from '../../../../state/camera.ts';
import { countText, rateText, spanText } from '../../../../state/device-units.ts';
import { heldPath } from '../../../../state/pure-text.ts';
import type { CapPanelProps } from '../../panels.ts';
import { CardRecordings } from './card.tsx';
import { asOpError, CamError } from './errors.tsx';
import { RecordForm } from './record.tsx';
import { SensorSettingsFold } from './settings.tsx';
import { Button, ButtonRow, CopyButton, instantOf, Row, Section, Span, StageRing, Toggle, useFractonica, useMode, useNowFor } from './ui.ts';
import { downloadFrame, LiveCanvas, useLiveView } from './view.tsx';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A camera job this page started and follows. */
interface OwnJob {
  id: string;
  kind: 'photo' | 'record' | 'play';
  /** record: its choices; play: the recording and its frames. */
  record?: RecordChoice;
  recording?: number;
  frames?: number;
  /** photo: the view to reopen after it (WATCH's start), when it was watching. */
  resume?: StreamStart | null;
  startedAt: number;
}

/** What the last job left: a line, a path, a card recording. */
interface Outcome {
  kind: OwnJob['kind'];
  line: string;
  path?: string;
  recording?: number;
  failed?: unknown;
}

/** The job, followed: its frames from /ws, its result from job_get (refetched while it runs). */
function useJob(id: string | null): Job | undefined {
  const status = useLive((s) => (id ? s.jobs[id]?.status : undefined));
  const ended = status !== undefined && TERMINAL_JOB_STATUSES.has(status);
  const q = useOp('job_get', { job_id: id ?? '' }, { enabled: id !== null, refetchInterval: id && !ended ? 1500 : false });
  return id ? (q.data as Job | undefined) : undefined;
}

/** Until camera_status says no stream runs on the instance (after this page closed its view), at most `ms`. */
async function streamGone(device: string, instance: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const s = await rest.op('camera_status', { device, instance });
      if (!s.stream) {
        return;
      }
    } catch {
      return;
    }
    await sleep(250);
  }
}

/** An op that starts a camera job, tried again on DEVICE_BUSY up to 3 times with the live link's backoff. */
async function startJob(run: () => Promise<unknown>): Promise<Job> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await run()) as Job;
    } catch (e) {
      if (asOpError(e).code !== 'DEVICE_BUSY' || attempt >= 3) {
        throw e;
      }
      await sleep(BACKOFF_MS[attempt]!);
    }
  }
}

/** The span since an ISO time, redrawn as it changes. */
function SinceSpan({ iso }: { iso: string }) {
  const core = useFractonica();
  const origin = instantOf(iso);
  const now = useNowFor(core, origin);
  return <Span us={now !== null && origin !== null ? Math.max(0, Number(now - origin)) : null} />;
}

/** A capture's path: ⊕ for its stamp in pure mode, whole in Earth mode; the copy copies it whole. */
export function HeldPath({ path }: { path: string }) {
  const { earth } = useMode();
  return (
    <span className="cam-path">
      <span className="mono">
        {earth
          ? path
          : heldPath(path)
              .split(/(⊕)/)
              .map((part, i) => (part === '⊕' ? <span key={i} className="cam-held" aria-label="a time stamp, shown in Earth mode">⊕</span> : part))}
      </span>
      <CopyButton text={path} label="Copy path" what="the path on the hub" />
    </span>
  );
}

export function CameraLens({ detail, inst, cap, mirror, instances }: CapPanelProps) {
  const core = useFractonica();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const hubDown = useLinkDown();
  const presence = usePresence()(detail.presence);
  const device = `id:${detail.device_id}`;
  const alias = detail.alias;
  const offline = presence === 'offline' || presence === 'unknown';
  const flashLed = instances.find((i) => i.name === 'flash' && i.cap === 'fr.led');

  const [ownJob, setOwnJob] = useState<OwnJob | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [opError, setOpError] = useState<{ error: unknown; frameSize?: string | null; recording?: number } | null>(null);
  const [startingPlay, setStartingPlay] = useState<number | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const [withFlash, setWithFlash] = useState(false);
  const [busy, setBusy] = useState<null | 'photo' | 'record' | 'play'>(null);
  const [madeHere, setMadeHere] = useState<Record<number, number>>({});
  const [picture, setPicture] = useState<{ frame_size?: string; quality?: number }>({});
  const [, setTick] = useState(0);

  const handle = useLiveView(detail.device_id, inst.name);
  const { view } = handle;
  const running = useRef(false);
  const status = useOp('camera_status', { device, instance: inst.name }, { refetchInterval: running.current || handle.active || ownJob !== null ? 2000 : false });
  const st = status.data;
  running.current = !!st?.stream;
  const stream = st?.stream ?? null;
  const job = useJob(ownJob?.id ?? null);
  const cancel = useAct('job_cancel', { refresh: ['camera_status'] });

  // the jobs this page started (a photo, a recording, PLAY, its own live views) end with a toast of the hub's; the page
  // says their outcome itself, so their ordinary end toasts are dismissed (a failure's toast stays)
  const quiet = useRef(new Set<string>());
  if (ownJob) {
    quiet.current.add(ownJob.id);
  }
  if (handle.active && view.own && stream?.job_id) {
    quiet.current.add(stream.job_id);
  }
  const toasts = useLive((s) => s.toasts);
  useEffect(() => {
    for (const t of toasts) {
      if (t.job_id && quiet.current.has(t.job_id) && t.tone !== 'bad') {
        store.getState().dismiss(t.id);
      }
    }
  }, [toasts]);

  // the hello's time: re-render once it runs out, so a WATCH with no frame says so
  useEffect(() => {
    if (view.phase !== 'open' || !view.own || view.frames > 0) {
      return;
    }
    const t = setTimeout(() => setTick((n) => n + 1), 5200);
    return () => clearTimeout(t);
  }, [view.phase, view.own, view.frames]);

  const state: CameraStateName = cameraState(view, {
    presence,
    hubDown,
    hasToken: handle.hasToken,
    running: stream,
    ownJob: ownJob && ownJob.kind !== 'photo' ? ownJob.id : null,
    photo: busy === 'photo' || ownJob?.kind === 'photo',
    sinceOpenMs: view.openedAt ? Date.now() - view.openedAt : 0,
  });

  // a job this page started has ended: say how, and reopen the view a photo paused
  useEffect(() => {
    if (!ownJob || !job || !TERMINAL_JOB_STATUSES.has(job.status)) {
      return;
    }
    void status.refetch(); // the stream is over: Now and the card's fold read it again
    const r = (job.result ?? {}) as { reason?: string; frames?: number; device_frames?: number; path?: string; recording?: number };
    const o: Outcome = { kind: ownJob.kind, line: '' };
    if (job.status === 'failed') {
      o.failed = job.error;
      o.line = '';
    } else if (ownJob.kind === 'photo') {
      o.line = 'The photo is on the hub.';
      if (r.path) {
        o.path = r.path;
      }
    } else if (ownJob.kind === 'record') {
      // to the card the hub receives nothing: the board's own count says what the card holds
      const n = (ownJob.record?.to === 'sd' ? r.device_frames : r.frames) ?? r.frames ?? 0;
      o.line = `${countText(core, n)} frame${n === 1 ? '' : 's'} ${ownJob.record?.to === 'sd' ? 'on the card' : 'came'}. ${endLine(job.status === 'cancelled' ? 'stopped' : (r.reason ?? 'stopped'), { recording: true, frames: n })}`;
      if (r.path) {
        o.path = r.path;
      }
      if (typeof r.recording === 'number') {
        o.recording = r.recording;
        setMadeHere((m) => ({ ...m, [r.recording!]: Date.now() }));
      }
    } else {
      const n = r.frames ?? 0;
      o.line = `Recording ${ownJob.recording} came to the hub: ${countText(core, n)} frame${n === 1 ? '' : 's'}. ${endLine(r.reason ?? 'done')}`;
      if (r.path) {
        o.path = r.path;
      }
    }
    setOutcome(o);
    const resume = ownJob.kind === 'photo' ? ownJob.resume : null;
    if (ownJob.kind !== 'photo' && handle.active && !handle.view.own) {
      handle.close(); // the recording's or PLAY's live stream is over
    }
    setOwnJob(null);
    if (resume) {
      handle.open(resume);
    }
    // the job's end is the only trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status]);

  // busy-hidden: the hub starts no view of its own once the hidden stream ends, so this page asks again then
  const busySince = useRef<number | null>(null);
  useEffect(() => {
    if (state !== 'busy-hidden') {
      busySince.current = null;
      return;
    }
    if (busySince.current === null) {
      busySince.current = Date.now();
      void status.refetch();
      return;
    }
    // only a status read after it said busy counts: the cache may be older than the hidden stream
    if (status.dataUpdatedAt > busySince.current && status.data && !status.data.stream) {
      busySince.current = null;
      handle.open(watchStart());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, status.data, status.dataUpdatedAt]);

  const watchStart = (): StreamStart => ({ interval_ms: 0, ...(picture.frame_size ? { frame_size: picture.frame_size as FrameSize } : {}), ...(picture.quality !== undefined ? { quality: picture.quality } : {}) });

  const watch = () => {
    setOpError(null);
    setOutcome(null);
    handle.open(watchStart());
  };

  // ?watch=1 (the Overview's WATCH link): start once, then drop it from the URL
  const asked = useRef(false);
  useEffect(() => {
    if (search.watch !== undefined && !asked.current) {
      asked.current = true;
      if (!offline && handle.hasToken) {
        watch();
      }
      void navigate({ search: {} as never, replace: true } as never);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.watch]);

  /** Closes this page's view and waits for its stream to end, so the next op is not refused BUSY. */
  const freeCamera = async () => {
    if (handle.active) {
      handle.close();
      await streamGone(device, inst.name);
    }
  };

  const photo = async () => {
    setOpError(null);
    setOutcome(null);
    const resume = handle.active && view.own ? watchStart() : null;
    setBusy('photo');
    try {
      await freeCamera();
      const j = await startJob(() => rest.op('camera_snap', { device, instance: inst.name, flash: withFlash && !!flashLed, wait_s: 0 }));
      setOwnJob({ id: j.job_id, kind: 'photo', resume, startedAt: Date.now() });
    } catch (e) {
      setOpError({ error: e });
      if (resume) {
        handle.open(resume);
      }
    } finally {
      setBusy(null);
    }
  };

  const record = async (choice: RecordChoice, extra: { frame_size?: string; quality?: number }) => {
    setOpError(null);
    setOutcome(null);
    setBusy('record');
    try {
      await freeCamera();
      const j = await startJob(() => rest.op('camera_stream', recordInput(device, inst.name, choice, extra) as Parameters<typeof rest.op<'camera_stream'>>[1]));
      setOwnJob({ id: j.job_id, kind: 'record', record: choice, startedAt: Date.now() });
      setRecordOpen(false);
      if (choice.to !== 'sd' && choice.live) {
        handle.open(); // join the recording's live stream
      }
    } catch (e) {
      setOpError({ error: e, frameSize: extra.frame_size ?? null });
    } finally {
      setBusy(null);
    }
  };

  const play = async (recording: number, frames: number) => {
    setOpError(null);
    setOutcome(null);
    setStartingPlay(recording);
    try {
      await freeCamera();
      const j = await startJob(() => rest.op('camera_sd_fetch', { device, instance: inst.name, recording, live: true, wait_s: 0 }));
      setOwnJob({ id: j.job_id, kind: 'play', recording, frames, startedAt: Date.now() });
      handle.open(); // join PLAY's live stream
    } catch (e) {
      setOpError({ error: e, recording });
      if (asOpError(e).code === 'NOT_FOUND') {
        void status.refetch();
      }
    } finally {
      setStartingPlay(null);
    }
  };

  const stopRecording = () => {
    if (ownJob) {
      cancel.mutate({ job_id: ownJob.id });
    }
  };

  const onPicture = (next: { frame_size: string; quality: number }) => {
    setPicture(next);
    if (handle.active && view.own) {
      handle.open({ interval_ms: 0, frame_size: next.frame_size as FrameSize, quality: next.quality });
    }
  };

  // ---- what shows ----
  const live = showsFrames(state) && handle.last !== null && view.frames > 0;
  const head = handle.last ? { frameSize: handle.last.block.frameSize, quality: handle.last.block.quality } : null;
  const frameSize: FrameSize = (head?.frameSize as FrameSize | null) ?? (picture.frame_size as FrameSize | undefined) ?? (FRAME_SIZES.includes(String(cap.config.find((c) => c.name === 'frame_size')?.default) as FrameSize) ? (cap.config.find((c) => c.name === 'frame_size')!.default as FrameSize) : 'svga');
  const lastSeenUs = detail.last_seen ? (Date.now() - Date.parse(detail.last_seen)) * 1000 : null;
  const line = live || (state === 'idle' && handle.last !== null) ? null : stateLine(state, {
    alias,
    instance: inst.name,
    lastWord: core && lastSeenUs !== null && Number.isFinite(lastSeenUs) ? spanText(core, lastSeenUs) : null,
    startedAgo: core && stream?.started_at ? spanText(core, (Date.now() - Date.parse(stream.started_at)) * 1000) : null,
    running: stream,
  });
  const caption = ownJob?.kind === 'play' ? `from the card, recording ${ownJob.recording}` : null;
  const sd = st?.sd ?? (typeof mirror.sd === 'string' ? (mirror.sd as 'none' | 'mounted' | 'error') : null);
  const cardIn = sd === 'mounted';
  const recordingNow = ownJob?.kind === 'record';
  const watchingOwn = handle.active && view.own;
  const joinedOther = handle.active && !view.own;
  /** This page's own live view is what runs (a photo or a recording may close it and go ahead). */
  const ownView = watchingOwn && (state === 'watching' || state === 'starting' || state === 'stalled' || state === 'connecting');
  const streamRuns = stream !== null || ownJob !== null;
  const noWatch = offline || hubDown || !handle.hasToken || state === 'not-provisioned' || state === 'bad-key' || state === 'old-page';
  const errCtx = { alias, instance: inst.name, maxFrameSize: st?.max_frame_size ?? null, frameSize: opError?.frameSize ?? null, recording: opError?.recording ?? null };

  // the transport
  const primary = watchingOwn ? (
    <Button variant="primary" onClick={() => handle.close()} data-action="stop" data-watch="">
      Stop
    </Button>
  ) : joinedOther ? (
    <Button variant="primary" onClick={() => handle.close()} data-action="stop-watching" data-watch="">
      Stop watching
    </Button>
  ) : (
    <Button variant="primary" onClick={watch} disabled={noWatch || (recordingNow && ownJob?.record?.to === 'sd') || ownJob?.kind === 'play'} data-action="watch" data-watch="">
      Watch
    </Button>
  );
  const does: string = watchingOwn
    ? 'Stops the live view. Nothing is saved.'
    : joinedOther
      ? ownJob?.kind === 'play'
        ? 'Leaves this view. The recording still comes to the hub.'
        : 'Leaves this view. The recording goes on.'
      : 'Shows the camera live here. It stops when you leave this page.';

  const elapsedFraction = (() => {
    if (!ownJob || ownJob.kind !== 'record' || !ownJob.record || ownJob.record.seconds === 0) {
      return undefined;
    }
    const started = stream?.started_at ? Date.parse(stream.started_at) : ownJob.startedAt;
    return Math.min(1, Math.max(0, (Date.now() - started) / (ownJob.record.seconds * 1000)));
  })();
  const playFraction = ownJob?.kind === 'play' && ownJob.frames ? Math.min(1, (stream?.frames ?? 0) / ownJob.frames) : undefined;

  const stillUrl = outcome?.kind === 'photo' && outcome.path ? capturesUrl(outcome.path) : null;
  const fpsHz = !stream && mirror.streaming !== true ? null : typeof mirror.fps_x10 === 'number' ? mirror.fps_x10 / 10 : typeof st?.fps_x10 === 'number' ? st.fps_x10 / 10 : null;
  const lastBytes = typeof mirror.last_bytes === 'number' ? mirror.last_bytes : (st?.last_bytes ?? null);
  const sdFree = typeof mirror.sd_free_mb === 'number' ? mirror.sd_free_mb : (st?.sd_free_mb ?? null);
  const room = roomForFrames(sdFree, lastBytes);
  const others = stream ? Math.max(0, stream.subscribers - (handle.active ? 1 : 0)) : 0;

  return (
    <div className="cam" data-camera-state={state} data-lens="fr.camera">
      <div className="cam-main">
        <LiveCanvas handle={handle} instance={inst.name} live={live} frameSize={frameSize} line={line} caption={caption} />
        <div className="cam-transport">
          <ButtonRow>
            {primary}
            {recordingNow && ownJob?.kind === 'record' ? (
              <Button confirm="Stop the recording?" confirmLabel="Stop" cancelLabel="Keep recording" onClick={stopRecording} busy={cancel.isPending} data-action="stop-recording">
                Stop recording
              </Button>
            ) : (
              <Button onClick={() => void photo()} busy={busy === 'photo' || ownJob?.kind === 'photo'} disabled={offline || hubDown || recordingNow || ownJob?.kind === 'play' || (stream !== null && !ownView) || (handle.active && !ownView)} data-action="photo">
                Photo
              </Button>
            )}
            {handle.last && live ? (
              <Button variant="quiet" onClick={() => downloadFrame(handle.last!.block, keptFrameName(alias, inst.name, view.stream?.stream_id ?? null, handle.last!.block.index))} data-action="keep-frame">
                Keep this frame
              </Button>
            ) : null}
            {!recordingNow ? (
              <Button onClick={() => setRecordOpen((o) => !o)} disabled={offline || hubDown || ((streamRuns || handle.active) && !ownView)} data-opens="record" aria-expanded={recordOpen} data-action="record">
                Record…
              </Button>
            ) : null}
          </ButtonRow>
          <p className="cam-does" data-does="">
            {does}
          </p>
          {flashLed && !recordingNow ? <Toggle label="with the flash" checked={withFlash} onChange={setWithFlash} states={['off', 'on']} disabled={offline} /> : null}
          {(streamRuns || handle.active) && !ownView && !recordingNow && ownJob?.kind !== 'play' && !joinedOther ? <p className="cam-note">a stream runs; stop it first</p> : null}
          {recordingNow && ownJob?.kind === 'record' ? (
            <div className="cam-progress">
              <StageRing bare size={22} stages={['recording']} current={0} fraction={elapsedFraction} label="recording" />
              <span>
                {ownJob.record && ownJob.record.seconds > 0 && core ? (
                  <>
                    recording · {spanText(core, Math.max(0, ownJob.record.seconds * 1e6 - (Date.now() - (stream?.started_at ? Date.parse(stream.started_at) : ownJob.startedAt)) * 1000))} left
                  </>
                ) : (
                  'recording'
                )}
              </span>
            </div>
          ) : null}
          {ownJob?.kind === 'play' ? (
            <div className="cam-progress">
              <StageRing bare size={22} stages={['play']} current={0} fraction={playFraction} label={`playing recording ${ownJob.recording}`} />
              <span>{`bringing recording ${ownJob.recording} to the hub`}</span>
            </div>
          ) : null}
          {state === 'busy-hidden' && stream?.job_id ? (
            <ButtonRow>
              <Button variant="destructive" confirm={`Stop stream ${stream.stream_id}? What came so far is kept.`} confirmLabel="Stop" cancelLabel="Keep it going" onClick={() => cancel.mutate({ job_id: stream.job_id! })} busy={cancel.isPending}>
                Stop that stream
              </Button>
            </ButtonRow>
          ) : null}
          {(state === 'bad-key' || state === 'old-page') && typeof location !== 'undefined' ? (
            <ButtonRow>
              <Button onClick={() => location.reload()}>Reload</Button>
            </ButtonRow>
          ) : null}
          {gapLine(view.skipped) && handle.active ? <p className="cam-note">{gapLine(view.skipped)}</p> : null}
          {view.lastEnd && !handle.active && !ownJob && !outcome && view.lastEnd.reason !== 'stopped' ? <p className="cam-note">{endLine(view.lastEnd.reason)}</p> : null}
        </div>
        {recordOpen && !recordingNow ? (
          <RecordForm
            cardIn={cardIn}
            maxFrameSize={st?.max_frame_size ?? null}
            busy={busy === 'record'}
            disabled={offline || hubDown || ((streamRuns || handle.active) && !ownView)}
            why={(streamRuns || handle.active) && !ownView ? 'a stream runs; stop it first' : null}
            onStart={(c, x) => void record(c, x)}
            onCancel={() => setRecordOpen(false)}
          />
        ) : null}
        {opError ? <CamError error={opError.error} ctx={errCtx} /> : null}
        {outcome ? (
          <Outcomes
            outcome={outcome}
            errCtx={errCtx}
            stillUrl={stillUrl}
            onCard={() => {
              setCardOpen(true);
              requestAnimationFrame(() => document.getElementById(`card-${inst.name}`)?.scrollIntoView({ block: 'nearest' }));
            }}
          />
        ) : null}
      </div>
      <div className="cam-side">
        <Section title="now">
          <Row label="state" bead={stateBead(state)} value={stateWord(state, stream)} id="cam-state" />
          <Row label="frame" value={`${sizeWords(head?.frameSize ?? frameSize)}${head ? ` · detail ${head.quality}` : ''}`} id="cam-frame" />
          <Row
            label="rate"
            value={fpsHz && fpsHz > 0 && core ? rateText(core, fpsHz) : '—'}
            earth={fpsHz && fpsHz > 0 ? `${fpsHz.toFixed(1)} frames a second` : undefined}
            id="cam-rate"
          />
          <Row label="last frame" value={lastBytes !== null ? `${countText(core, lastBytes)} B` : '—'} earth={lastBytes !== null ? `${(lastBytes / 1024).toFixed(1)} KB` : undefined} id="cam-last" />
          {stream ? (
            <Row
              label="this stream"
              value={`${countText(core, stream.frames)} frame${stream.frames === 1 ? '' : 's'}`}
              extra={[stream.dropped ? `${countText(core, stream.dropped)} dropped by the camera` : null, view.skipped ? `${countText(core, view.skipped)} skipped here to keep up` : null].filter(Boolean).join(' · ') || undefined}
              id="cam-stream"
            />
          ) : null}
          {stream?.started_at ? <Row label="running for" value={<SinceSpan iso={stream.started_at} />} id="cam-running" /> : null}
          {stream ? (
            <Row label="watched" value={handle.active ? (others ? `here and in ${others} other place${others === 1 ? '' : 's'}` : 'here') : stream.subscribers ? `in ${stream.subscribers} place${stream.subscribers === 1 ? '' : 's'}` : 'nowhere'} id="cam-watched" />
          ) : null}
          <Row
            label="card"
            bead={sd === 'error' ? 'fault' : undefined}
            value={sd === 'mounted' ? (room !== null ? `in · room for about ${countText(core, room)} frames` : 'in') : sd === 'none' ? 'no card' : sd === 'error' ? 'failed' : '—'}
            earth={sd === 'mounted' && sdFree !== null ? `${countText(core, sdFree)} MB free` : undefined}
            id="cam-card"
          />
          <Row label="sensor" value={st?.sensor || st?.max_frame_size ? [st?.sensor ?? 'a camera', st?.max_frame_size ? `up to ${st.max_frame_size}` : null].filter(Boolean).join(' · ') : '—'} id="cam-sensor" />
          {status.error ? <CamError error={status.error} ctx={errCtx} what="The camera’s state" /> : null}
        </Section>
        <SensorSettingsFold
          deviceId={detail.device_id}
          alias={alias}
          instance={inst.name}
          config={cap.config}
          maxFrameSize={st?.max_frame_size ?? null}
          head={head}
          disabled={offline || hubDown}
          onPicture={onPicture}
        />
        <CardRecordings
          deviceId={detail.device_id}
          alias={alias}
          instance={inst.name}
          sd={sd}
          streaming={streamRuns}
          offline={offline || hubDown}
          madeHere={madeHere}
          playing={ownJob?.kind === 'play' ? { recording: ownJob.recording!, received: stream?.frames ?? 0, frames: ownJob.frames ?? 0 } : null}
          starting={startingPlay}
          onPlay={(r, f) => void play(r, f)}
          open={cardOpen}
          onOpenChange={setCardOpen}
        />
      </div>
    </div>
  );
}

function Outcomes({ outcome, errCtx, stillUrl, onCard }: { outcome: Outcome; errCtx: Parameters<typeof CamError>[0]['ctx']; stillUrl: string | null; onCard: () => void }) {
  if (outcome.failed) {
    return <CamError error={outcome.failed} ctx={errCtx} />;
  }
  let still: ReactNode = null;
  if (outcome.kind === 'photo') {
    still = stillUrl ? (
      <figure className="cam-still">
        <img src={stillUrl} alt={`photo from ${errCtx.instance}`} />
        <figcaption>
          <a className="ui-button" data-variant="quiet" href={stillUrl} download>
            <span className="ui-button-text">SAVE</span>
          </a>
        </figcaption>
      </figure>
    ) : (
      <p className="cam-note">kept on the hub</p>
    );
  }
  return (
    <div className="cam-outcome" data-outcome={outcome.kind}>
      {still}
      <p>{outcome.line}</p>
      {outcome.path ? <HeldPath path={outcome.path} /> : null}
      {outcome.recording !== undefined ? (
        <Button variant="quiet" onClick={onCard} data-action="to-card">
          {`Recording ${outcome.recording} · in card recordings ›`}
        </Button>
      ) : null}
    </div>
  );
}
