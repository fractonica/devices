// A new board, start to finish (HARDWARE-REVIEW §4 "Screens" 2): the dial on the left (on top at phone width), the
// six steps beside it. Each step done folds to one line with "Change"; the current one is open; the ones to come are
// engraved, so the whole path is visible before it starts. The wizard's rules are state/wizard.ts and
// state/provision.ts; this file runs the calls:
// - port_list (every 2 s while choosing: a program opening a port has no event), device_list, network_list,
//   profile_list, hub_status (the checkout to build from);
// - device_provision, or build_start then device_provision ("Build and provision"); the job followed through `/ws`
//   job frames with job_get as the fallback (store.ts), its page `/provision/<job>` so a reload resumes it;
// - device.online events and device_get for the board's first HELLO; job_cancel; node.identify.

import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { PortInfo } from '@fractonica/protocol/client';

import { OpError } from '../../api/rest.ts';
import { TERMINAL_JOB_STATUSES } from '../../api/types.ts';
import { useAct, useLive, useOp } from '../../hooks.ts';
import { hubClock, live, rest } from '../../runtime.ts';
import { pendingPrompts } from '../../state/live.ts';
import {
  aliasTaken,
  chainSearch,
  chipFromError,
  defaultAlias,
  errorFixKind,
  PAGE_STEP_WORDS,
  type PageStepStatus,
  pageSteps,
  profileChoices,
  provisionDial,
  stageWord,
} from '../../state/provision.ts';
import { earthless } from '../../state/pure-text.ts';
import { suggestPort } from '../../state/ports.ts';
import {
  buildReady,
  canSubmit,
  chosenNetwork,
  jobRunning,
  needsJobDetail,
  promptForWizard,
  provisionInput,
  type WizardError,
  wizardDeviceId,
  type WizardKnown,
} from '../../state/wizard.ts';
import { Bead, Button, ButtonRow, engrave, ErrorLine, FTime, Row, TextField, useMode } from '../../ui/index.ts';
import { ChoiceRow, Choices } from './choice.tsx';
import { Dial, type DialCentre } from './dial.tsx';
import { JobOutput } from './job-output.tsx';
import { NetworkStep } from './networks.tsx';
import { PortsStep } from './ports.tsx';
import { dispatch, getWizard, useFollowJob, useWizard } from './store.ts';
import { useSpan } from './time.ts';

const PHONE = '(max-width: 699.98px)';

/** Whether the page is at phone width (the dial's size follows it). */
export function usePhone(): boolean {
  return useSyncExternalStore(
    (l) => {
      const m = matchMedia(PHONE);
      m.addEventListener('change', l);
      return () => m.removeEventListener('change', l);
    },
    () => matchMedia(PHONE).matches,
    () => false,
  );
}

function Step({ n, status, title, summary, onChange, children }: { n: number; status: PageStepStatus; title: string; summary?: React.ReactNode; onChange?: () => void; children?: React.ReactNode }) {
  const open = status === 'current' || status === 'failed';
  return (
    <section className="prov-step" data-status={status} aria-current={open ? 'step' : undefined} aria-label={title}>
      <header className="prov-step-head">
        <span className="prov-step-n" aria-hidden="true">
          {n}
        </span>
        <h2 className="prov-step-title caps">{engrave(title)}</h2>
        {status === 'done' && summary ? <span className="prov-step-summary">{summary}</span> : null}
        {status === 'done' && onChange ? (
          <Button variant="quiet" onClick={onChange} aria-label={`Change the ${title.toLowerCase()}`}>
            Change
          </Button>
        ) : null}
      </header>
      {open && children ? children : null}
    </section>
  );
}

/** A WizardError as an OpError for ErrorLine; a CLI line is dropped when the page offers the fix itself. */
function asOpError(e: WizardError, hasFix: boolean, earth: boolean): OpError {
  const pure = (x: string) => (earth ? x : earthless(x));
  const human = hasFix ? e.human.filter((h) => !h.startsWith('run `')) : e.human;
  return new OpError({ code: e.code as never, message: pure(e.message), retryable: false, remediation: human.map((h) => ({ human: pure(h) })) });
}

export function NewBoard() {
  const s = useWizard();
  const navigate = useNavigate();
  const phone = usePhone();
  const { earth } = useMode();
  const choosing = s.step === 'closed' || s.step === 'detect';
  const ports = useOp('port_list', {}, { refetchInterval: choosing ? 2000 : false });
  const devices = useOp('device_list', {});
  const networks = useOp('network_list', {});
  const profiles = useOp('profile_list', {});
  const status = useOp('hub_status', {});
  const prompts = useLive((st) => st.prompts);
  const [times, setTimes] = useState<Record<string, { started?: string; ended?: string }>>({});

  // ---- what the page reads, into the reducer ----
  useEffect(() => {
    if (networks.data) {
      dispatch({ type: 'networks', networks: networks.data.networks.map((n) => ({ name: n.name, ssid: n.ssid, band: n.band, password_set: n.password_set, devices: n.devices })) });
    }
  }, [networks.data]);
  useEffect(() => {
    if (profiles.data) {
      dispatch({ type: 'profiles', profiles: profiles.data.profiles.map((p) => ({ profile: p.profile, board: p.board, chip: p.chip, built: p.newest_debug !== undefined })) });
    }
  }, [profiles.data]);
  const pendingNet = useRef<string | null>(null);
  useEffect(() => {
    const name = pendingNet.current;
    if (name && s.networks?.some((n) => n.name === name)) {
      pendingNet.current = null;
      dispatch({ type: 'useNetwork', name });
    }
  }, [s.networks]);

  const byId = useMemo(() => new Map((devices.data?.devices ?? []).map((d) => [d.device_id, d])), [devices.data]);
  const knownOf = (p: PortInfo): WizardKnown | null => {
    const d = p.device_id ? byId.get(p.device_id) : undefined;
    return d ? { device_id: d.device_id, alias: d.alias, profile: d.profile, presence: d.presence, chip: d.chip } : null;
  };
  const choose = (p: PortInfo) =>
    dispatch({ type: 'open', port: { path: p.path, usb_serial: p.usb_serial, device_id: p.device_id, state: p.state, holder: p.holder }, known: knownOf(p) });

  // ---- the board plugged in while the page is open: lit and chosen ----
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const offered = useRef<string | null>(null);
  useEffect(() => {
    const list = ports.data?.ports;
    if (!list) {
      return;
    }
    if (seen.current === null) {
      seen.current = new Set(list.map((p) => p.path));
    }
    const now = new Set(list.filter((p) => !seen.current!.has(p.path)).map((p) => p.path));
    setFresh((old) => (old.size === now.size && [...now].every((x) => old.has(x)) ? old : now));
    if (getWizard().step === 'closed' || (getWizard().step === 'detect' && now.size)) {
      const pick = suggestPort(list, seen.current, (p) => knownOf(p) !== null);
      if (pick && pick.path !== offered.current && pick.path !== getWizard().port?.path) {
        offered.current = pick.path;
        choose(pick);
      }
    }
    // knownOf follows devices; the ports decide when to look
  }, [ports.data]);

  // The registry answered after the board was chosen: what it knows of the board (its alias, profile, chip) joins it.
  useEffect(() => {
    const w = getWizard();
    const p = w.port && ports.data?.ports.find((x) => x.path === w.port!.path);
    if (w.step === 'detect' && p && !w.known && knownOf(p)) {
      choose(p);
    }
  }, [byId]);

  // ---- following the jobs ----
  const recordTimes = (j: { job_id: string; started_at?: string; ended_at?: string; created_at?: string }) =>
    setTimes((t) => {
      const v = { started: j.started_at ?? j.created_at, ended: j.ended_at };
      const old = t[j.job_id];
      return old && old.started === v.started && old.ended === v.ended ? t : { ...t, [j.job_id]: v };
    });
  const job = s.job;
  const build = s.build;
  useFollowJob(build?.job_id, s.step === 'flash' && build !== null && (!TERMINAL_JOB_STATUSES.has(build.status) || !build.detail), (j, full) => {
    dispatch({ type: 'build', job: j, full });
    if (full) {
      recordTimes(j as never);
    }
  });
  useFollowJob(job?.job_id, (s.step === 'flash' || s.step === 'done') && job !== null && (!TERMINAL_JOB_STATUSES.has(job.status) || needsJobDetail(s)), (j, full) => {
    dispatch({ type: 'job', job: j, full });
    if (full) {
      recordTimes(j as never);
    }
  });
  // The board's HELLO: device.online events, and device_get once the job is done (it may have come first).
  useEffect(() => {
    if (s.step !== 'flash' && s.step !== 'done') {
      return;
    }
    return live.listen({
      events: (batch, info) => {
        if (!info.snapshot) {
          for (const e of batch) {
            if (e.type === 'device.online' && e.device) {
              dispatch({ type: 'online', device_id: e.device });
            }
          }
        }
      },
    });
  }, [s.step]);
  const doneId = s.step === 'done' && !s.online ? s.result?.device_id : undefined;
  useEffect(() => {
    if (doneId) {
      rest.op('device_get', { device: `id:${doneId}` }).then(
        (d) => d.presence === 'online' && dispatch({ type: 'online', device_id: doneId }),
        () => {},
      );
    }
  }, [doneId]);
  // A probe that named the chip (an error) narrows the profiles.
  useEffect(() => {
    const chip = s.error ? chipFromError(s.error) : null;
    if (chip && chip !== s.chip) {
      dispatch({ type: 'chip', chip });
    }
  }, [s.error]);

  // ---- starting ----
  const startProvision = () => {
    dispatch({ type: 'submitted' });
    rest.op('device_provision', provisionInput(getWizard())).then(
      (j) => {
        dispatch({ type: 'job', job: j, full: true });
        recordTimes(j);
        void navigate({ to: '/provision/$job', params: { job: j.job_id }, replace: getWizard().build !== null });
      },
      (e: unknown) => dispatch({ type: 'failed', error: e instanceof OpError ? e.toToolError() : { code: 'INTERNAL', message: String(e), retryable: false } }),
    );
  };
  const sourceDir = status.data?.source_dir;
  const startBuild = () => {
    const st = getWizard();
    if (!sourceDir) {
      return;
    }
    dispatch({ type: 'buildSubmitted' });
    rest.op('build_start', { source_dir: sourceDir, profile: st.profile }).then(
      (j) => {
        dispatch({ type: 'build', job: j, full: true });
        recordTimes(j);
        const input = provisionInput(st);
        void navigate({ to: '/provision/$job', params: { job: j.job_id }, search: chainSearch({ port: input.port, profile: st.profile, alias: input.alias, network: input.network }) as never });
      },
      (e: unknown) => dispatch({ type: 'failed', error: e instanceof OpError ? e.toToolError() : { code: 'INTERNAL', message: String(e), retryable: false } }),
    );
  };
  // "Build and provision": once built, provision with the same ring.
  const chained = useRef<string | null>(null);
  useEffect(() => {
    if (buildReady(s) && s.build && chained.current !== s.build.job_id) {
      chained.current = s.build.job_id;
      startProvision();
    }
  });

  const cancel = useAct('job_cancel', { done: () => 'Cancelling', refresh: ['job_list'] });
  const identify = useAct('command_send', {
    done: (r) => (r.results[0]?.status === 'ok' ? 'The board shows itself' : { tone: 'warn', title: `Identify: ${r.results[0]?.status ?? 'no answer'}` }),
  });

  // ---- what the steps show ----
  const steps = pageSteps(s);
  const statusOf = (k: number) => (s.step === 'closed' && k === 0 ? 'current' : steps[k]!.status);
  const portRow = ports.data?.ports.find((p) => p.path === s.port?.path);
  const portName = (s.port?.path ?? '').split('/').pop();
  const net = chosenNetwork(s);
  const choices = profileChoices(s.profiles ?? [], s.chip);
  const picked = choices.find((p) => p.profile === s.profile);
  const needsBuild = picked !== undefined && !picked.built;
  const autoPick = choices.filter((p) => p.built && p.matches);
  // Built profiles (and the one picked) first; the rest behind one quiet word when there is a built one.
  const [showAll, setShowAll] = useState(false);
  const shownChoices = choices.some((p) => p.built) ? choices.filter((p) => p.built || p.profile === s.profile) : choices;
  const hidden = choices.length - shownChoices.length;
  const selfId = wizardDeviceId(s);
  const taken = aliasTaken(s.alias, devices.data?.devices ?? [], selfId);
  const fallbackAlias = defaultAlias(s);
  // Automatic with one built profile for the board: the name the hub would give it.
  const exampleAlias = !fallbackAlias && !s.profile && autoPick.length === 1 ? defaultAlias({ ...s, profile: autoPick[0]!.profile }) : null;
  const ready = canSubmit(s) && !taken && (!needsBuild || !!sourceDir);
  const runningJob = jobRunning(s) ? (s.job && !TERMINAL_JOB_STATUSES.has(s.job.status) ? s.job : s.build) : null;
  const prompt = Object.values(prompts).find((p) => promptForWizard(s, p) && pendingPrompts({ prompts }, hubClock.now()).includes(p));

  const dial = provisionDial(s);
  const resultOf = (k: string) => (s.result as unknown as Record<string, unknown> | null)?.[k] as string | undefined;
  // A job opened from its URL: its times come from job_get once (the follow is over).
  const timesOf = s.job && !times[s.job.job_id] ? s.job.job_id : '';
  const jobOnce = useOp('job_get', { job_id: timesOf }, { enabled: timesOf !== '' });
  useEffect(() => {
    if (jobOnce.data) {
      recordTimes(jobOnce.data);
    }
  }, [jobOnce.data]);
  const firstStart = s.build ? times[s.build.job_id]?.started : s.job ? times[s.job.job_id]?.started : undefined;
  const lastEnd = s.job ? times[s.job.job_id]?.ended : s.build && TERMINAL_JOB_STATUSES.has(s.build.status) && s.error ? times[s.build.job_id]?.ended : undefined;
  const elapsed = useSpan(firstStart, lastEnd);
  const idle = s.step !== 'flash' && s.step !== 'done';
  const pageStep = steps.find((x) => x.status === 'current')?.step ?? 'plug';
  const centre: DialCentre | undefined = idle
    ? s.step === 'closed' && ports.error && !ports.data
      ? { word: 'plug in', sub: 'no answer', bead: 'fault' }
      : s.step === 'closed' && !(ports.data?.ports.length ?? 0)
      ? { word: 'plug in', sub: 'listening', bead: 'waiting' }
      : { word: PAGE_STEP_WORDS[pageStep], sub: `step ${steps.findIndex((x) => x.step === pageStep) + 1} of 6` }
    : s.step === 'done' && s.result
      ? { word: s.result.wifi === 'not_joined' ? 'flashed' : 'done', sub: s.result.wifi === 'not_joined' ? 'not on wi-fi' : `${dial.stages.length} of ${dial.stages.length}`, ...(elapsed ? { reading: elapsed } : {}) }
      : {
          word: dial.word ?? (dial.current >= dial.stages.length ? 'done' : stageWord(dial.stages[Math.min(dial.current, dial.stages.length - 1)]!)),
          sub: dial.failed ? 'stopped' : `${Math.min(dial.current + 1, dial.stages.length)} of ${dial.stages.length}`,
          ...(elapsed ? { reading: elapsed } : {}),
        };

  const errorFix = (() => {
    const e = s.error;
    const kind = e ? errorFixKind(e) : null;
    if (kind === 'port') {
      return { label: 'Back to the port', onClick: () => dispatch({ type: 'goto', step: 'detect' }) };
    }
    if (kind === 'network') {
      return { label: 'Choose the network', onClick: () => dispatch({ type: 'goto', step: 'network' }) };
    }
    if (kind === 'profile') {
      return { label: 'Choose the profile', onClick: () => dispatch({ type: 'goto', step: 'profile' }) };
    }
    if (kind === 'retry') {
      return { label: 'Try again', onClick: () => (s.build && s.build.status !== 'completed' ? startBuild() : startProvision()) };
    }
    return undefined;
  })();

  return (
    <div className="prov-board" data-step={s.step}>
      <aside className="prov-instrument">
        {phone && idle ? null : <Dial view={dial} idle={idle} size={phone ? 232 : 320} centre={centre} label={portName ? `Provisioning on ${portName}` : 'Provisioning'} />}
        {s.step === 'flash' && runningJob && !s.error ? (
          <ButtonRow>
            <Button
              variant="destructive"
              confirm="Stop provisioning? The board may be left half written."
              confirmLabel="Stop"
              busy={cancel.isPending}
              onClick={() => cancel.mutate({ job_id: runningJob.job_id })}
              data-action="cancel"
            >
              Cancel
            </Button>
          </ButtonRow>
        ) : null}
      </aside>

      <div className="prov-steps">
        <Step n={1} status={statusOf(0)} title="Plug in" summary={<>{s.known?.alias ?? s.result?.alias ?? 'New board'} <span className="mono ash">{portName}</span></>} onChange={jobRunning(s) ? undefined : () => dispatch({ type: 'goto', step: 'detect' })}>
          <PortsStep
            ports={ports.data?.ports}
            error={ports.error}
            loading={ports.isLoading}
            known={(p) => knownOf(p)}
            chosen={s.port?.path ?? null}
            fresh={fresh}
            onChoose={choose}
            onRecheck={() => void ports.refetch()}
            onContinue={() => dispatch({ type: 'next' })}
            continueDisabled={s.network.state === 'loading' && networks.isLoading}
            note={
              s.known
                ? `${s.known.alias} is in the registry${s.known.profile ? ` as ${s.known.profile}` : ''}. Provisioning again erases it and writes it afresh; it keeps its name unless you change it.`
                : undefined
            }
          />
        </Step>

        <Step n={2} status={statusOf(1)} title="Network" summary={net?.ssid ?? resultOf('ssid')} onChange={jobRunning(s) ? undefined : () => dispatch({ type: 'goto', step: 'network' })}>
          <NetworkStep
            s={s}
            error={networks.error}
            onChoose={(name) => {
              pendingNet.current = name;
              dispatch({ type: 'useNetwork', name });
            }}
            onContinue={() => dispatch({ type: 'next' })}
            onRecheck={() => void networks.refetch()}
          />
        </Step>

        <Step n={3} status={statusOf(2)} title="Board" summary={s.result?.profile ?? (s.profile || 'automatic')} onChange={jobRunning(s) ? undefined : () => dispatch({ type: 'goto', step: 'profile' })}>
          <div className="prov-step-body">
            <p className="prov-lede">
              {s.chip
                ? `The board is an ${s.chip}. Profiles for it come first; built ones before the rest.`
                : 'The hub reads the chip when it starts. Automatic picks the one profile built for that chip.'}
            </p>
            <ErrorLine error={profiles.error} what="Profiles" fix={{ label: 'Try again', onClick: () => void profiles.refetch() }} />
            <Choices label="Firmware profile">
              <ChoiceRow
                id="auto"
                chosen={s.profile === ''}
                onChoose={() => dispatch({ type: 'profile', profile: '' })}
                name="Automatic"
                extra={s.chip && autoPick.length === 1 ? `${autoPick[0]!.profile}, the one built for ${s.chip}` : 'the profile built for the chip the hub reads'}
              />
              {(showAll ? choices : shownChoices).map((p) => (
                <ChoiceRow
                  key={p.profile}
                  id={p.profile}
                  chosen={s.profile === p.profile}
                  onChoose={() => dispatch({ type: 'profile', profile: p.profile })}
                  muted={!p.matches}
                  name={p.profile}
                  extra={`${p.board ?? ''}${p.chip ? ` · ${p.chip}` : ''}${p.matches ? '' : ' · another chip'}`}
                  value={p.built ? <ProfileBuilt profile={p.profile} data={profiles.data} /> : <span className="ash">not built yet</span>}
                />
              ))}
            </Choices>
            {!showAll && hidden > 0 ? (
              <ButtonRow>
                <Button variant="quiet" onClick={() => setShowAll(true)} data-action="all-profiles">
                  {`${hidden} more ${hidden === 1 ? 'profile' : 'profiles'}, not built yet`}
                </Button>
              </ButtonRow>
            ) : null}
            {needsBuild ? (
              <p className="prov-note">
                {sourceDir
                  ? `${picked!.profile} is not built yet. Build and provision builds it from the hub's checkout first, then flashes it; the ring shows both.`
                  : `${picked!.profile} is not built, and this hub has no source checkout to build from. Pick a built profile.`}
              </p>
            ) : null}
          </div>
        </Step>

        <Step n={4} status={statusOf(3)} title="Name" summary={s.result?.alias ?? (s.alias || fallbackAlias || 'the hub’s default')} onChange={jobRunning(s) ? undefined : () => dispatch({ type: 'goto', step: 'profile' })}>
          <div className="prov-step-body">
            <TextField
              label="Alias"
              value={s.alias}
              onChange={(v) => dispatch({ type: 'alias', alias: v })}
              placeholder={fallbackAlias ?? exampleAlias ?? 'kitchen-lamp'}
              maxLength={31}
              mono
              error={s.aliasError ?? taken}
              note={
                !s.alias && (fallbackAlias || exampleAlias)
                  ? `Empty: the hub names it ${fallbackAlias ?? exampleAlias}. Letters, digits and hyphens; 31 characters at most.`
                  : 'Letters, digits and hyphens; 31 characters at most.'
              }
              data-input="alias"
            />
            <p className="prov-note">
              Provisioning erases what the board runs, writes {s.profile ? `the newest build of ${s.profile}` : 'the newest build for its chip'} with {net ? `the ${net.ssid} network` : 'the network'}, resets it and waits for
              its first word to the hub.
            </p>
            <ButtonRow>
              <Button variant="primary" disabled={!ready} onClick={needsBuild ? startBuild : startProvision} data-action="provision">
                {needsBuild ? 'Build and provision' : 'Provision'}
              </Button>
            </ButtonRow>
          </div>
        </Step>

        <Step n={5} status={statusOf(4)} title="Flash" summary={s.job?.status === 'completed' ? `${dial.stages.length} stages` : undefined}>
          <div className="prov-step-body">
            {s.job || s.build ? (
              <Row
                label="Stage"
                value={
                  <span className="prov-stage-word" data-failed={dial.failed ? '' : undefined}>
                    {dial.failed ? `${dial.word ?? 'stopped'} at ${stageWord(dial.stages[Math.min(dial.current, dial.stages.length - 1)]!)}` : (centre?.word ?? '')}
                  </span>
                }
                extra={dial.fraction !== undefined ? runningJob?.progress?.message : undefined}
              />
            ) : (
              <Row label="Stage" value={s.error ? <span className="prov-stage-word" data-failed="">refused before it started</span> : <span className="ash">starting</span>} />
            )}
            {prompt ? <Row label="The hub asks" value={prompt.text} /> : null}
            {s.error ? (
              <>
                {s.job?.status === 'cancelled' || s.build?.status === 'cancelled' ? (
                  <ErrorLine
                    error={new OpError({ code: 'CANCELLED' as never, message: `Stopped at ${stageWord(dial.stages[Math.min(dial.current, dial.stages.length - 1)]!)}. The board may be half written: provision it again before using it.`, retryable: true })}
                    fix={errorFix}
                  />
                ) : (
                  <ErrorLine error={asOpError(s.error, errorFix !== undefined, earth)} what={s.build && s.build.status !== 'completed' ? 'Build' : 'Provision'} fix={errorFix} />
                )}
                {s.error.candidates.length ? (
                  <ButtonRow>
                    {s.error.candidates.map((c) => (
                      <Button key={c} onClick={() => dispatch({ type: 'pick', profile: c })} data-action="pick">
                        {`Use ${c}`}
                      </Button>
                    ))}
                  </ButtonRow>
                ) : null}
              </>
            ) : null}
            {s.build ? <JobOutput key={s.build.job_id} jobId={s.build.job_id} title="Build output" /> : null}
            {s.job ? <JobOutput key={s.job.job_id} jobId={s.job.job_id} title="Output" defaultOpen={!!s.error} /> : null}
          </div>
        </Step>

        <Step n={6} status={s.step === 'done' ? 'current' : statusOf(5)} title="Done">
          {s.step === 'done' ? <Done s={s} identify={() => s.result && identify.mutate({ selector: `id:${s.result.device_id}`, command: 'node.identify', args: { ms: 3000 } })} identifying={identify.isPending} /> : null}
        </Step>
      </div>
    </div>
  );
}

/** When the profile's newest build was made, in Fractonica notation. */
function ProfileBuilt({ profile, data }: { profile: string; data: { profiles: { profile: string; newest_debug?: { built_at: string } }[] } | undefined }) {
  const at = data?.profiles.find((p) => p.profile === profile)?.newest_debug?.built_at;
  return (
    <span className="prov-built">
      built <FTime at={at} form="relative" />
    </span>
  );
}

function Done({ s, identify, identifying }: { s: ReturnType<typeof useWizard>; identify: () => void; identifying: boolean }) {
  const navigate = useNavigate();
  const { earth } = useMode();
  const r = s.result;
  if (!r) {
    return (
      <div className="prov-step-body">
        <p className="prov-lede">Provisioned. The hub returned no details of the board.</p>
        <ButtonRow>
          <Link to="/devices" className="ui-button" data-variant="primary">
            <span className="ui-button-text">{engrave('Open devices')}</span>
          </Link>
        </ButtonRow>
      </div>
    );
  }
  const joined = r.wifi === 'joined' || r.wifi === 'off';
  return (
    <div className="prov-step-body" data-result={r.wifi}>
      <Row label="Name" value={r.alias} />
      <Row label="Profile" value={r.profile} extra={<span className="mono">{r.fw_id.slice(0, 12)}</span>} />
      <Row label="Wi-Fi" value={<Bead state={r.wifi === 'joined' ? 'online' : r.wifi === 'off' ? 'idle' : 'waiting'} label={r.wifi === 'joined' ? 'joined' : r.wifi === 'off' ? 'radio off' : 'not joined'} showLabel />} />
      <Row label="On the hub" value={<Bead state={s.online ? 'online' : 'waiting'} label={s.online ? 'online' : 'waiting for it'} showLabel />} />
      {!joined ? (
        <ErrorLine
          error={new OpError({ code: 'NOT_JOINED' as never, message: `${r.alias} answered over USB but did not reach the hub over Wi-Fi. Check the network's name and password, then look at its log on its page.`, retryable: true })}
        />
      ) : null}
      {r.warnings?.filter((w) => joined || !w.includes('over Wi-Fi')).map((w) => (
        <p key={w} className="prov-note">
          {earth ? w : earthless(w)}
        </p>
      ))}
      <ButtonRow>
        <Link to="/devices/$id" params={{ id: r.alias }} className="ui-button" data-variant="primary" data-action="open-device">
          <span className="ui-button-text">{engrave('Open device')}</span>
        </Link>
        <Button onClick={identify} busy={identifying} disabled={!s.online} data-action="identify">
          Identify
        </Button>
        <Button variant="quiet" onClick={() => {
            dispatch({ type: 'close' });
            void navigate({ to: '/provision' });
          }}
          data-action="another"
        >
          Provision another
        </Button>
      </ButtonRow>
    </div>
  );
}
