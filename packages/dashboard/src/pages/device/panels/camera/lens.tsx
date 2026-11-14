// The fr.camera instrument page (DEVICE-SPEC §3.4–§3.7, §4.3): the live view, the transport, the Record form in place,
// the Now rows, and the folds SENSOR SETTINGS, CARD RECORDINGS and ON THE HUB. Nothing here sends a raw stream_start:
// WATCH opens /app/stream with `start`, PHOTO runs camera_snap, RECORD camera_stream, PLAY camera_sd_fetch, and a
// recording or PLAY is watched by joining its live stream.
//
// What runs is read from the hub: a recording or PLAY that camera_status shows (started here, on another page, by the
// CLI or an agent, or here before the page was left) is followed as this page's own, so it can be watched and stopped.
// The transport (which actions, which one is lit, what each does or why it waits) is state/camera.ts `transport`.
// A start the board refuses as busy while the hub runs nothing (a stream that went on after its link was lost) is said
// as such, from the hub's job error (never as a failed sensor), with STOP IT ON THE BOARD (BoardBusy).

import { useNavigate, useSearch } from '@tanstack/react-router';
import { type ReactNode, type Ref, useEffect, useRef, useState } from 'react';

import type { StreamStart } from '../../../../api/stream.ts';
import { queryClient, rest, store } from '../../../../runtime.ts';
import { TERMINAL_JOB_STATUSES, type Job } from '../../../../api/types.ts';
import { BACKOFF_MS } from '../../../../api/ws.ts';
import { useAct, useLive, useOp } from '../../../../hooks.ts';
import { useLinkDown, usePresence } from '../../../../shell/link.ts';
import {
  adoptable,
  boardBusyLine,
  cameraErrorLine,
  cameraState,
  type CameraStateName,
  capturesUrl,
  detailWord,
  endLine,
  failedViewJob,
  FRAME_SIZES,
  type FrameSize,
  frameUrl,
  gapLine,
  keptFrameName,
  lastIssuedStream,
  type ListedJob,
  playEndLine,
  type RecordChoice,
  recordInput,
  roomForFrames,
  showsFrames,
  sizeWords,
  stateBead,
  stateLine,
  stateWord,
  transport,
  type TransportAction,
  viewEndLine,
} from '../../../../state/camera.ts';
import { countText, rateText, spanText } from '../../../../state/device-units.ts';
import { viewClosed, viewOpened } from '../../../../state/quiet-toasts.ts';
import type { CapPanelProps } from '../../panels.ts';
import { CardRecordings } from './card.tsx';
import { asOpError, CamError } from './errors.tsx';
import { HubCaptures } from './hub-captures.tsx';
import { HeldPath } from './path.tsx';
import { RecordForm } from './record.tsx';
import { SensorSettingsFold } from './settings.tsx';
import { Button, ButtonRow, engrave, ErrorLine, instantOf, Row, Section, Span, StageRing, Toggle, useFractonica, useNowFor } from './ui.ts';
import { downloadFrame, LiveCanvas, useLiveView } from './view.tsx';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A camera job this page started, or took from camera_status, and follows. */
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

/** What the last job left: a line, a path, a card recording, frames to look at. */
interface Outcome {
  kind: OwnJob['kind'];
  line: string;
  path?: string;
  recording?: number;
  /** A recording to the hub: its first and last frames under /captures. */
  first?: string | null;
  lastFrame?: string | null;
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

/** One transport button from its description. */
function TransportButton({
  a,
  onPress,
  busy,
  describedBy,
  primaryRef,
  controls,
}: {
  a: TransportAction;
  onPress: () => void;
  busy?: boolean;
  describedBy?: string;
  primaryRef?: Ref<HTMLButtonElement>;
  /** RECORD…: the form it opens in place, and whether it is open. */
  controls?: { id: string; expanded: boolean };
}) {
  return (
    <Button
      variant={a.variant}
      disabled={a.disabled}
      busy={busy}
      onClick={onPress}
      data-action={a.id}
      data-watch={a.variant === 'primary' ? '' : undefined}
      aria-describedby={describedBy}
      {...(a.confirm ? { confirm: a.confirm.question, confirmLabel: a.confirm.yes, cancelLabel: a.confirm.keep } : {})}
      {...(a.id === 'record' ? { 'data-opens': 'record' } : {})}
      {...(controls ? { 'aria-expanded': controls.expanded, ...(controls.expanded ? { 'aria-controls': controls.id } : {}) } : {})}
      {...(a.variant === 'primary' && primaryRef ? { ref: primaryRef } : {})}
    >
      {a.label}
    </Button>
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

  const [startedJob, setOwnJob] = useState<OwnJob | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [opError, setOpError] = useState<{ error: unknown; frameSize?: string | null; recording?: number } | null>(null);
  const [startingPlay, setStartingPlay] = useState<number | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const [withFlash, setWithFlash] = useState(false);
  const [busy, setBusy] = useState<null | 'photo' | 'record' | 'play'>(null);
  const [madeHere, setMadeHere] = useState<Record<number, number>>({});
  const [picture, setPicture] = useState<{ frame_size?: string; quality?: number }>({});
  /** Why the last start (WATCH's view, a photo, a recording, PLAY) failed, when the hub's job said so. */
  const [startFailure, setStartFailure] = useState<{ code: string; message: string } | null>(null);
  /** What the board said to STOP IT ON THE BOARD, once it stopped. */
  const [boardNote, setBoardNote] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const focusPrimary = useRef(false);
  /** Jobs that ended while followed here: camera_status may still show them a moment; they are not taken up again. */
  const endedJobs = useRef(new Set<string>());

  const handle = useLiveView(detail.device_id, inst.name);
  const { view } = handle;
  const running = useRef(false);
  const status = useOp('camera_status', { device, instance: inst.name }, { refetchInterval: running.current || handle.active || startedJob !== null ? 2000 : false });
  const st = status.data;
  running.current = !!st?.stream;
  const stream = st?.stream ?? null;
  // a recording or PLAY camera_status shows and this page did not start is followed as its own (it was started
  // elsewhere, or here before the page was left): its state, WATCH to join it and its stop are then this page's
  const adopt = adoptable(stream);
  const adopted: OwnJob | null =
    !startedJob && busy === null && startingPlay === null && adopt && stream && !endedJobs.current.has(adopt.id)
      ? adopt.kind === 'record'
        ? {
            id: adopt.id,
            kind: 'record',
            record: { to: stream.to, seconds: stream.seconds, intervalMs: stream.interval_ms ?? 0, live: stream.live !== false, maxFrames: 0 },
            startedAt: stream.started_at ? Date.parse(stream.started_at) : Date.now(),
          }
        : { id: adopt.id, kind: 'play', ...(adopt.recording !== undefined ? { recording: adopt.recording } : {}), startedAt: Date.now() }
      : null;
  // kept until its job ends, though camera_status may stop showing the stream first
  const kept = useRef<OwnJob | null>(null);
  if (adopted) {
    kept.current = adopted;
  } else if (kept.current && (startedJob || endedJobs.current.has(kept.current.id))) {
    kept.current = null;
  }
  const ownJob = startedJob ?? kept.current;
  const job = useJob(ownJob?.id ?? null);
  const cancel = useAct('job_cancel', { refresh: ['camera_status'] });

  // the jobs this page follows (a photo, a recording, PLAY, its own live views) end with a toast of the hub's; the page
  // says their outcome itself, a failure included (CamError, BoardBusy), so their toasts are dismissed while it shows
  const quiet = useRef(new Set<string>());
  if (ownJob) {
    quiet.current.add(ownJob.id);
  }
  if (handle.active && view.own && stream?.job_id && stream.use !== 'record' && stream.use !== 'play') {
    quiet.current.add(stream.job_id);
  }
  const toasts = useLive((s) => s.toasts);
  useEffect(() => {
    for (const t of toasts) {
      if (t.job_id && quiet.current.has(t.job_id)) {
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

  // while this page shows a view of its own, the hub's view job ends without a toast (state/quiet-toasts.ts): the page
  // says how it ended, and leaving the page is how a view stops
  const viewing = handle.active && view.own;
  useEffect(() => {
    if (!viewing) {
      return;
    }
    viewOpened(detail.device_id);
    return () => viewClosed(detail.device_id);
  }, [viewing, detail.device_id]);

  // this page's view ended with no frame and reason error: its start failed. The hub's job says why (DEVICE_BUSY: the
  // board runs a stream the hub does not know of), so the page does not guess a failed sensor.
  const openedAt = useRef<number | null>(null);
  if (view.openedAt !== null) {
    openedAt.current = view.openedAt;
  }
  useEffect(() => {
    const end = view.lastEnd;
    if (!end || !view.lastEndOwn || end.reason !== 'error' || end.records > 0) {
      return;
    }
    let alive = true;
    const since = openedAt.current ?? Date.now();
    void rest
      .op('job_list', { origin: 'app', limit: 20 })
      .then((r) => {
        const f = failedViewJob((r as { jobs: ListedJob[] }).jobs, detail.device_id, since);
        if (alive && f) {
          setStartFailure(f);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [view.lastEnd, view.lastEndOwn, detail.device_id]);

  const followed = ownJob && ownJob.kind !== 'photo' ? ownJob : null;
  // the board refused a start as busy while the hub runs nothing on it: a stream goes on there from before
  const boardBusy = startFailure?.code === 'DEVICE_BUSY' && !stream && !offline && !hubDown;
  const state: CameraStateName = cameraState(view, {
    boardBusy,
    presence,
    hubDown,
    hasToken: handle.hasToken,
    running: stream,
    ownJob: followed ? followed.id : null,
    playing: followed?.kind === 'play' ? (followed.recording ?? 0) : null,
    photo: busy === 'photo' || ownJob?.kind === 'photo',
    sinceOpenMs: view.openedAt ? Date.now() - view.openedAt : 0,
  });

  // a job this page follows has ended: say how, and reopen the view a photo paused
  useEffect(() => {
    if (!ownJob || !job || !TERMINAL_JOB_STATUSES.has(job.status)) {
      return;
    }
    endedJobs.current.add(ownJob.id);
    void status.refetch(); // the stream is over: Now and the folds read it again
    const r = (job.result ?? {}) as { reason?: string; frames?: number; device_frames?: number; path?: string; recording?: number; first_index?: number; last_index?: number };
    const o: Outcome = { kind: ownJob.kind, line: '' };
    if (job.status === 'failed') {
      o.failed = job.error;
      const e = (job.error ?? {}) as { code?: unknown; message?: unknown };
      if (e.code === 'DEVICE_BUSY') {
        // the board refused the start: what runs there is said with its stop (BoardBusy), not as a bare error
        setStartFailure({ code: 'DEVICE_BUSY', message: typeof e.message === 'string' ? e.message : '' });
      }
    } else if (ownJob.kind === 'photo') {
      o.line = 'The photo is on the hub.';
      if (r.path) {
        o.path = r.path;
      }
    } else if (ownJob.kind === 'record') {
      // to the card the hub receives nothing: the board's own count says what the card holds
      const toCard = ownJob.record?.to === 'sd';
      const n = (toCard ? r.device_frames : r.frames) ?? r.frames ?? 0;
      o.line = `${countText(core, n)} frame${n === 1 ? '' : 's'} ${toCard ? 'on the card' : 'came'}. ${endLine(job.status === 'cancelled' ? 'stopped' : (r.reason ?? 'stopped'), { recording: true, frames: n })}`;
      if (r.path) {
        o.path = r.path;
        o.first = typeof r.first_index === 'number' ? frameUrl(r.path, r.first_index) : null;
        o.lastFrame = typeof r.last_index === 'number' ? frameUrl(r.path, r.last_index) : null;
      }
      if (typeof r.recording === 'number') {
        o.recording = r.recording;
        setMadeHere((m) => ({ ...m, [r.recording!]: Date.now() }));
      }
      if (ownJob.record?.to !== 'hub') {
        void queryClient.invalidateQueries({ queryKey: ['camera_sd_list'] }); // the card holds a new recording
      }
    } else {
      const n = r.frames ?? 0;
      o.line = playEndLine(ownJob.recording, countText(core, n), n, job.status === 'cancelled' ? 'stopped' : (r.reason ?? 'done'));
      if (r.path) {
        o.path = r.path;
        o.first = typeof r.first_index === 'number' ? frameUrl(r.path, r.first_index) : null;
        o.lastFrame = typeof r.last_index === 'number' ? frameUrl(r.path, r.last_index) : null;
      }
    }
    setOutcome(o);
    const resume = ownJob.kind === 'photo' ? ownJob.resume : null;
    if (ownJob.kind !== 'photo' && handle.active) {
      handle.close(); // the recording's or PLAY's live stream is over
    }
    setOwnJob(null);
    if (resume) {
      handle.open(resume);
    }
    // the job's end is the only trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status]);

  // an outcome lands in sight (the view or the line under the transport), and is said once
  useEffect(() => {
    if (outcome) {
      requestAnimationFrame(() => outcomeRef.current?.scrollIntoView?.({ block: 'nearest' }));
    }
  }, [outcome]);

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

  /** WATCH: a live view of its own, or, while a recording or PLAY is followed, joining its stream. */
  const watch = () => {
    setOpError(null);
    setStartFailure(null);
    setBoardNote(null);
    if (followed) {
      handle.open();
      return;
    }
    setOutcome(null);
    handle.open(watchStart());
  };

  // ?watch=1 (the Overview's WATCH link): start once, then drop it from the URL; the focus goes to STOP
  const asked = useRef(false);
  useEffect(() => {
    if (search.watch !== undefined && !asked.current) {
      asked.current = true;
      if (!offline && handle.hasToken) {
        watch();
        focusPrimary.current = true;
      }
      void navigate({ search: {} as never, replace: true } as never);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.watch]);
  useEffect(() => {
    if (focusPrimary.current && handle.active && primaryRef.current) {
      focusPrimary.current = false;
      primaryRef.current.focus();
    }
  });

  /** Closes this page's view and waits for its stream to end, so the next op is not refused BUSY. */
  const freeCamera = async () => {
    if (handle.active) {
      handle.close();
      await streamGone(device, inst.name);
    }
  };

  const photo = async () => {
    setOpError(null);
    setStartFailure(null);
    setBoardNote(null);
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
    setStartFailure(null);
    setBoardNote(null);
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
    setStartFailure(null);
    setBoardNote(null);
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

  const onPicture = (next: { frame_size: string; quality: number }) => {
    setPicture(next);
    if (handle.active && view.own) {
      handle.open({ interval_ms: 0, frame_size: next.frame_size as FrameSize, quality: next.quality });
    }
  };

  // ---- what shows ----
  const live = showsFrames(state) && handle.last !== null && view.frames > 0;
  const head = live && handle.last ? { frameSize: handle.last.block.frameSize, quality: handle.last.block.quality, at: handle.last.at } : null;
  const configured = cap.config.find((c) => c.name === 'frame_size')?.default;
  const frameSize: FrameSize = (head?.frameSize as FrameSize | null) ?? (picture.frame_size as FrameSize | undefined) ?? (FRAME_SIZES.includes(String(configured) as FrameSize) ? (configured as FrameSize) : 'svga');
  const lastSeenUs = detail.last_seen ? (Date.now() - Date.parse(detail.last_seen)) * 1000 : null;
  const stillUrl = outcome?.kind === 'photo' && outcome.path ? capturesUrl(outcome.path) : null;
  const still = stillUrl && !live && !handle.active ? { url: stillUrl, alt: `the photo from ${inst.name}` } : null;
  const line = live || (state === 'idle' && handle.last !== null) ? null : stateLine(state, {
    alias,
    instance: inst.name,
    lastWord: core && lastSeenUs !== null && Number.isFinite(lastSeenUs) ? spanText(core, lastSeenUs) : null,
    startedAgo: core && stream?.started_at ? spanText(core, (Date.now() - Date.parse(stream.started_at)) * 1000) : null,
    unheard: presence === 'unknown',
    running: stream,
    viewing: handle.active,
    playing: followed?.kind === 'play' ? (followed.recording ?? null) : null,
  });
  const caption = followed?.kind === 'play' ? `from the card${followed.recording !== undefined ? `, recording ${followed.recording}` : ''}` : null;
  const sd = st?.sd ?? (typeof mirror.sd === 'string' ? (mirror.sd as 'none' | 'mounted' | 'error') : null);
  const cardIn = sd === 'mounted';
  const recordingNow = followed?.kind === 'record';
  const streamRuns = stream !== null || ownJob !== null;
  const noWatch = !handle.hasToken
    ? 'This page has no stream key; reload it.'
    : state === 'not-provisioned'
      ? 'Live view needs a device provisioned through this hub.'
      : state === 'bad-key' || state === 'old-page'
        ? 'Reload this page first.'
        : null;
  const errCtx = { alias, instance: inst.name, maxFrameSize: st?.max_frame_size ?? null, frameSize: opError?.frameSize ?? null, recording: opError?.recording ?? null };

  const t = transport({
    state,
    running: stream,
    own: followed ? { kind: followed.kind as 'record' | 'play', ...(followed.record ? { to: followed.record.to, live: followed.record.live } : {}) } : null,
    active: handle.active,
    viewOwn: view.own,
    framesShown: live,
    offline,
    hubDown,
    noWatch,
  });
  const press: Record<TransportAction['id'], () => void> = {
    watch,
    stop: () => handle.close(),
    'stop-watching': () => handle.close(),
    'stop-recording': () => followed && cancel.mutate({ job_id: followed.id }),
    'stop-play': () => followed && cancel.mutate({ job_id: followed.id }),
    photo: () => void photo(),
    'keep-frame': () => {
      const f = handle.lastFrame();
      if (f) {
        downloadFrame(f.block, keptFrameName(alias, inst.name, view.stream?.stream_id ?? null, f.block.index));
      }
    },
    record: () => setRecordOpen((o) => !o),
    'stop-other': () => stream?.job_id && cancel.mutate({ job_id: stream.job_id }),
  };
  const lineOf = (a: TransportAction): number | null => {
    const i = t.lines.findIndex((l) => l.text === a.does);
    return i >= 0 ? i : null;
  };
  const photoAction = t.actions.find((a) => a.id === 'photo');
  const recordAction = t.actions.find((a) => a.id === 'record');

  const elapsedFraction = (() => {
    if (!followed || followed.kind !== 'record' || !followed.record || followed.record.seconds === 0) {
      return undefined;
    }
    const started = stream?.started_at ? Date.parse(stream.started_at) : followed.startedAt;
    return Math.min(1, Math.max(0, (Date.now() - started) / (followed.record.seconds * 1000)));
  })();
  const playFraction = followed?.kind === 'play' && followed.frames ? Math.min(1, (stream?.frames ?? 0) / followed.frames) : undefined;

  const fpsHz = offline || hubDown || !stream ? null : typeof mirror.fps_x10 === 'number' ? mirror.fps_x10 / 10 : typeof st?.fps_x10 === 'number' ? st.fps_x10 / 10 : null;
  const lastBytesRaw = typeof mirror.last_bytes === 'number' ? mirror.last_bytes : (st?.last_bytes ?? null);
  const lastBytes = lastBytesRaw !== null && lastBytesRaw > 0 ? lastBytesRaw : null;
  const sdFree = typeof mirror.sd_free_mb === 'number' ? mirror.sd_free_mb : (st?.sd_free_mb ?? null);
  const room = roomForFrames(sdFree, lastBytes);
  const others = stream ? Math.max(0, (stream.subscribers ?? 0) - (handle.active ? 1 : 0)) : 0;
  const shownQuality = head?.quality ?? picture.quality ?? null;
  const boardStream = useLive((s) => lastIssuedStream(s.events, detail.device_id, inst.name));
  const viewEnded =
    view.lastEnd && view.lastEndOwn && !handle.active && !ownJob && !outcome && !boardBusy
      ? boardNote
        ? null
        : startFailure
        ? `The live view did not start. ${cameraErrorLine(startFailure.code, startFailure.message, errCtx) ?? endLine(view.lastEnd.reason)}`
        : viewEndLine(view.lastEnd.reason)
      : null;

  return (
    <div className="cam" data-camera-state={state} data-lens="fr.camera">
      <div className="cam-main">
        <LiveCanvas handle={handle} instance={inst.name} live={live} frameSize={frameSize} line={line} caption={caption} still={still} />
        <div className="cam-transport">
          <ButtonRow>
            {t.actions.map((a) => (
              <TransportButton
                key={a.id}
                a={a}
                onPress={press[a.id]}
                busy={a.id === 'photo' ? busy === 'photo' || ownJob?.kind === 'photo' : a.id === 'stop-recording' || a.id === 'stop-other' || a.id === 'stop-play' ? cancel.isPending : undefined}
                primaryRef={primaryRef}
                {...(a.id === 'record' ? { controls: { id: `cam-record-${inst.name}`, expanded: recordOpen && !recordingNow } } : {})}
                {...(lineOf(a) !== null ? { describedBy: `cam-does-${inst.name}-${lineOf(a)}` } : {})}
              />
            ))}
          </ButtonRow>
          {boardBusy ? (
            <BoardBusy
              deviceId={detail.device_id}
              instance={inst.name}
              streamId={boardStream}
              onStopped={() => {
                setStartFailure(null);
                setOutcome(null);
                setBoardNote('The board’s stream is stopped. WATCH starts the camera.');
              }}
            />
          ) : null}
          {t.lines.length ? (
            <div className="cam-does-list" data-does="">
              {t.lines.map((l, i) => (
                <p key={l.text} className="cam-does" id={`cam-does-${inst.name}-${i}`}>
                  <span className="caps cam-does-who">{l.labels.map((x) => engrave(x)).join(' · ')}</span>
                  <span>{l.text}</span>
                </p>
              ))}
            </div>
          ) : null}
          {flashLed && photoAction ? <Toggle label="with the flash" checked={withFlash} onChange={setWithFlash} states={['off', 'on']} disabled={photoAction.disabled} /> : null}
          {recordingNow ? (
            <div className="cam-progress">
              <StageRing bare size={22} stages={['recording']} current={0} fraction={elapsedFraction} label="recording" />
              <span>
                {followed.record && followed.record.seconds > 0 && core
                  ? `recording · ${spanText(core, Math.max(0, followed.record.seconds * 1e6 - (Date.now() - (stream?.started_at ? Date.parse(stream.started_at) : followed.startedAt)) * 1000))} left`
                  : 'recording until you stop it'}
              </span>
            </div>
          ) : null}
          {followed?.kind === 'play' ? (
            <div className="cam-progress">
              <StageRing bare size={22} stages={['play']} current={0} fraction={playFraction} label={`playing recording ${followed.recording ?? ''}`} />
              <span>{`bringing ${followed.recording !== undefined ? `recording ${followed.recording}` : 'the recording'} to the hub`}</span>
            </div>
          ) : null}
          {(state === 'bad-key' || state === 'old-page') && typeof location !== 'undefined' ? (
            <ButtonRow>
              <Button onClick={() => location.reload()}>Reload</Button>
            </ButtonRow>
          ) : null}
          {gapLine(view.skipped) && handle.active ? <p className="cam-note">{gapLine(view.skipped)}</p> : null}
          <div className="cam-said" role="status" ref={outcomeRef}>
            {viewEnded ? <p className="cam-note">{viewEnded}</p> : null}
            {boardNote ? <p className="cam-note" data-board-busy="stopped">{boardNote}</p> : null}
            {outcome && !(boardBusy && outcome.failed) ? <Outcomes outcome={outcome} errCtx={errCtx} stillUrl={stillUrl} stillInView={still !== null} onCard={() => openCard()} /> : null}
          </div>
        </div>
        {recordOpen && !recordingNow ? (
          <RecordForm
            id={`cam-record-${inst.name}`}
            cardIn={cardIn}
            maxFrameSize={st?.max_frame_size ?? null}
            busy={busy === 'record'}
            disabled={!recordAction || recordAction.disabled}
            why={recordAction?.disabled && !offline && !hubDown ? recordAction.does : null}
            onStart={(c, x) => void record(c, x)}
            onCancel={() => setRecordOpen(false)}
          />
        ) : null}
        {opError ? <CamError error={opError.error} ctx={errCtx} /> : null}
      </div>
      <div className="cam-side">
        <Section title="now">
          <Row label="state" bead={stateBead(state)} beadLabel={stateWord(state, stream, followed?.kind === 'play' ? (followed.recording ?? null) : null)} value={stateWord(state, stream, followed?.kind === 'play' ? (followed.recording ?? null) : null)} id="cam-state" />
          <Row label="frame" value={`${sizeWords(head?.frameSize ?? frameSize)}${shownQuality !== null ? ` · ${detailWord(shownQuality)} detail` : ''}`} id="cam-frame" />
          <Row
            label="rate"
            value={fpsHz && fpsHz > 0 && core ? rateText(core, fpsHz) : '—'}
            earth={fpsHz && fpsHz > 0 ? `${fpsHz.toFixed(1)} frames a second` : undefined}
            id="cam-rate"
          />
          <Row label="last frame" value={lastBytes !== null ? `${countText(core, lastBytes)} B` : '—'} earth={lastBytes !== null ? `${(lastBytes / 1024).toFixed(1)} KB` : undefined} id="cam-last" />
          {stream && !offline ? (
            <Row
              label="this stream"
              value={`${countText(core, stream.frames)} frame${stream.frames === 1 ? '' : 's'}`}
              extra={[stream.dropped ? `${countText(core, stream.dropped)} dropped by the camera` : null, view.skipped ? `${countText(core, view.skipped)} skipped here to keep up` : null].filter(Boolean).join(' · ') || undefined}
              id="cam-stream"
            />
          ) : null}
          {stream?.started_at && !offline ? <Row label="running for" value={<SinceSpan iso={stream.started_at} />} id="cam-running" /> : null}
          {stream && !offline ? (
            <Row label="watched" value={handle.active ? (others ? `here and in ${others} other place${others === 1 ? '' : 's'}` : 'here') : stream.subscribers ? `in ${stream.subscribers} place${stream.subscribers === 1 ? '' : 's'}` : 'nowhere'} id="cam-watched" />
          ) : null}
          <Row
            label="card"
            bead={sd === 'error' ? 'fault' : undefined}
            value={sd === 'mounted' ? (room !== null ? `in · room for about ${countText(core, room)} frames` : 'in') : sd === 'none' ? 'no card' : sd === 'error' ? 'failed' : '—'}
            earth={sd === 'mounted' && sdFree !== null ? `${countText(core, sdFree)} MB free` : undefined}
            {...(offline && sd ? { extra: 'as last seen' } : {})}
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
          streaming={streamRuns && !offline}
          offline={offline || hubDown}
          madeHere={madeHere}
          playing={followed?.kind === 'play' && followed.recording !== undefined ? { recording: followed.recording, received: stream?.frames ?? 0, frames: followed.frames ?? 0 } : null}
          starting={startingPlay}
          onPlay={(r, f) => void play(r, f)}
          open={cardOpen}
          onOpenChange={setCardOpen}
        />
        <HubCaptures deviceId={detail.device_id} instance={inst.name} />
      </div>
    </div>
  );

  function openCard() {
    setCardOpen(true);
    void queryClient.invalidateQueries({ queryKey: ['camera_sd_list'] });
    requestAnimationFrame(() => document.getElementById(`card-${inst.name}`)?.scrollIntoView({ block: 'nearest' }));
  }
}

function Outcomes({
  outcome,
  errCtx,
  stillUrl,
  stillInView,
  onCard,
}: {
  outcome: Outcome;
  errCtx: Parameters<typeof CamError>[0]['ctx'];
  stillUrl: string | null;
  /** The photo shows in the view itself; here only its line and path. */
  stillInView: boolean;
  onCard: () => void;
}) {
  if (outcome.failed) {
    return <CamError error={outcome.failed} ctx={errCtx} />;
  }
  let still: ReactNode = null;
  if (outcome.kind === 'photo' && !stillInView) {
    still = stillUrl ? (
      <figure className="cam-thumb">
        <img src={stillUrl} alt={`the photo from ${errCtx.instance}`} />
        <figcaption>
          <a className="ui-button" data-variant="quiet" href={stillUrl} download data-action="save-photo">
            <span className="ui-button-text">SAVE</span>
          </a>
        </figcaption>
      </figure>
    ) : (
      <p className="cam-note">kept on the hub</p>
    );
  }
  const frames = outcome.lastFrame ? (
    <figure className="cam-thumb">
      <img src={outcome.lastFrame} alt="the last frame of the recording" />
      <figcaption>
        <span className="cam-thumb-links">
          {outcome.first ? (
            <a className="ui-button" data-variant="quiet" href={outcome.first} target="_blank" rel="noreferrer" data-action="first-frame">
              <span className="ui-button-text">FIRST FRAME</span>
            </a>
          ) : null}
          <a className="ui-button" data-variant="quiet" href={outcome.lastFrame} target="_blank" rel="noreferrer" data-action="last-frame">
            <span className="ui-button-text">LAST FRAME</span>
          </a>
        </span>
      </figcaption>
    </figure>
  ) : null;
  return (
    <div className="cam-outcome" data-outcome={outcome.kind}>
      {still}
      <p>{outcome.line}</p>
      {frames}
      {outcome.path ? <HeldPath path={outcome.path} /> : null}
      {outcome.recording !== undefined ? (
        <Button variant="quiet" onClick={onCard} data-action="to-card">
          {`Recording ${outcome.recording} · in card recordings ›`}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The board refused a start as busy while the hub runs no stream on it (DEVICE_BUSY): a stream goes on there from
 * before, most likely one whose link was lost mid-stream. Its stop goes to the board itself (command_send stream_stop
 * with the last stream id the hub issued on the instance); without that id, or when the board runs another, a restart
 * ends it.
 */
function BoardBusy({ deviceId, instance, streamId, onStopped }: { deviceId: string; instance: string; streamId: number | null; onStopped(): void }) {
  const act = useAct('command_send', { quiet: () => true, refresh: ['camera_status'] });
  const res = act.data?.results[0];
  const stopped = res?.status === 'ok';
  useEffect(() => {
    if (stopped) {
      onStopped();
    }
    // the stop's answer is the only trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopped]);
  return (
    <div className="cam-board-busy" data-board-busy="">
      <ErrorLine code="DEVICE_BUSY" message={boardBusyLine(streamId !== null && res?.status !== 'not_found')} />
      {streamId !== null && res?.status !== 'not_found' ? (
        <ButtonRow>
          <Button
            variant="destructive"
            busy={act.isPending}
            confirm={`Stop stream ${streamId} on the board? Nothing of it reaches the hub now.`}
            confirmLabel="Stop"
            cancelLabel="Leave it"
            onClick={() => act.mutate({ selector: `id:${deviceId}`, command: `${instance}.stream_stop`, args: { stream_id: streamId } })}
            data-action="stop-board"
          >
            Stop it on the board
          </Button>
        </ButtonRow>
      ) : null}
      {res && res.status !== 'ok' ? (
        <p className="cam-note">
          {res.status === 'not_found' ? 'The board runs a stream this hub did not start. Restart the board to end it.' : `The board did not stop it (${res.status.replace(/_/g, ' ')}). Restart the board to end it.`}
        </p>
      ) : null}
      {act.error ? <ErrorLine error={act.error} what="The stop" /> : null}
    </div>
  );
}
