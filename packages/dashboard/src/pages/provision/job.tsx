// A job's page, `/provision/<job>`: closing or reloading never loses a job, which runs on the hub. A provisioning job
// (or a build on its way to one, the chain kept in the URL) opens in the new-board steps; any other job opens here:
// its ring (a build's four stages, an update's rollout with one ring per device), what it did, its error with the
// fix, Cancel while it runs, and its output folded underneath.

import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import type { Job } from '@fractonica/protocol/client';

import { OpError } from '../../api/rest.ts';
import { TERMINAL_JOB_STATUSES } from '../../api/types.ts';
import { useAct, useOp } from '../../hooks.ts';
import { chainState, readChoices, jobBead, jobDial, kindWord, otaDial, otaFleetDial, readChain, stageWord } from '../../state/provision.ts';
import { Bead, Button, ButtonRow, Caps, engrave, ErrorLine, FTime, PROVISION_STAGES, Row, Section, useHubText } from '../../ui/index.ts';
import { Dial } from './dial.tsx';
import { JobOutput } from './job-output.tsx';
import { NewBoard, usePhone } from './new-board.tsx';
import { OtaLine } from './ota.tsx';
import { dispatch, getWizard, replace, useFollowJob, useWizard } from './store.ts';
import { useSpan } from './time.ts';

/** A job's error for ErrorLine (which says the hub's texts in the mode's units). */
function asOpError(e: unknown): OpError | null {
  const t = e as { code?: unknown; message?: unknown; hint?: unknown; remediation?: { human?: string }[] } | undefined;
  if (typeof t?.code !== 'string' || typeof t.message !== 'string') {
    return null;
  }
  return new OpError(e as never);
}

/** An update's per-device rows (ota_status for the job), read every 1.5 s while it runs (and on ota.job.state events). */
function useOtaRows(jobId: string, enabled: boolean, running: boolean) {
  return useOp('ota_status', { job: jobId }, { enabled, refetchInterval: running ? 1500 : false });
}

/** An update's devices, each as a ring with its name under it. */
function OtaRings({ jobId, running }: { jobId: string; running: boolean }) {
  const q = useOtaRows(jobId, true, running);
  const rows = q.data?.devices ?? [];
  if (!rows.length) {
    return null;
  }
  return (
    <>
      <Section title="Devices" aside={<Caps>{`${rows.filter((r) => r.state === 'SUCCEEDED').length} of ${rows.length} updated`}</Caps>}>
        <div className="prov-rings">
          {rows.map((r) => (
            <figure key={r.job} className="prov-ring" data-ota={r.alias} data-ota-state={r.state}>
              <Dial view={otaDial(r)} size={156} label={`${r.alias} update`} />
              <figcaption className="prov-ring-name">{r.alias}</figcaption>
            </figure>
          ))}
        </div>
      </Section>
      <Section title="Per device">
        {rows.map((r) => (
          <OtaLine key={r.job} row={r} />
        ))}
      </Section>
    </>
  );
}

/** A job that is not a provisioning: followed live, drawn as its ring. */
export function JobView({ job: first }: { job: Job }) {
  const phone = usePhone();
  const [job, setJob] = useState<Job>(first);
  const [seen, setSeen] = useState<string[]>(first.stage ? [first.stage] : []);
  const running = !TERMINAL_JOB_STATUSES.has(job.status);
  useFollowJob(job.job_id, running, (f, full) => {
    setJob((j) => (full ? (f as Job) : { ...j, status: f.status, stage: f.stage ?? j.stage, progress: f.progress ?? j.progress }));
    if (f.stage) {
      setSeen((s) => (s.at(-1) === f.stage ? s : [...s, f.stage!]));
    }
  });
  const cancel = useAct('job_cancel', { refresh: ['job_list'] });
  const ota = useOtaRows(job.job_id, job.kind === 'ota', running);
  const devices = useOp('device_list', {});
  const aliasOf = new Map((devices.data?.devices ?? []).map((d) => [d.device_id, d.alias]));
  const otaRows = ota.data?.devices ?? [];
  const view = job.kind === 'ota' && otaRows.length ? otaFleetDial(otaRows) : jobDial({ ...job, stages: seen }, seen);
  const span = useSpan(job.started_at ?? job.created_at, job.ended_at);
  const say = useHubText();
  const err = asOpError(job.error);
  const result = (job.result ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof result[k] === 'string' ? (result[k] as string) : undefined);
  const word = view.word ?? (view.current >= view.stages.length ? 'done' : stageWord(view.stages[Math.min(view.current, view.stages.length - 1)]!));
  const sub = view.arcs ? `${view.current} of ${view.stages.length} updated` : view.failed || view.stopped ? `at ${stageWord(view.stages[Math.min(view.current, view.stages.length - 1)]!)}` : `${Math.min(view.current + 1, view.stages.length)} of ${view.stages.length}`;
  return (
    <div className="prov-board" data-job={job.job_id} data-kind={job.kind} data-status={job.status}>
      <aside className="prov-instrument">
        <Dial
          view={view}
          size={phone ? 232 : 320}
          label={`${kindWord(job.kind)} ${job.targets.join(', ')}`}
          centre={{ word, sub, ...(span ? { reading: span } : {}) }}
        />
        {running ? (
          <ButtonRow>
            <Button variant="destructive" confirm={`Stop this ${kindWord(job.kind)}?`} confirmLabel="Stop" cancelLabel="Keep going" busy={cancel.isPending} onClick={() => cancel.mutate({ job_id: job.job_id })} data-action="cancel">
              Stop
            </Button>
          </ButtonRow>
        ) : null}
      </aside>
      <div className="prov-views">
        <Section title={kindWord(job.kind)} aside={<Bead state={jobBead(job.status)} label={job.status === 'working' ? 'running' : job.status} showLabel />}>
          <Row label="For" value={job.targets.map((t) => aliasOf.get(t) ?? t).join(', ') || '—'} />
          <Row label="Started" value={<FTime at={job.started_at ?? job.created_at} form="relative" />} />
          {job.ended_at ? <Row label="Took" value={span ?? '—'} /> : null}
          {job.progress?.message && running ? <Row label="Now" value={say(job.progress.message)} /> : null}
          {job.blocked_by ? <Row label="Waits for" value={<Link to="/provision/$job" params={{ job: job.blocked_by.holder_job }}>{`job ${job.blocked_by.holder_job}`}</Link>} /> : null}
          {str('build_id') ? <Row label="Build" value={<span className="mono">{str('build_id')}</span>} extra={str('fw_id') ? <span className="mono">{str('fw_id')!.slice(0, 12)}</span> : undefined} /> : null}
          {job.origin ? <Row label="Started by" value={job.origin === 'mcp' ? 'an agent' : job.origin} /> : null}
        </Section>
        {job.status === 'cancelled' ? (
          <Row id="stopped" bead="offline" beadLabel="stopped" label="Stopped" value={`at ${word === 'stopped' ? stageWord(view.stages[Math.min(view.current, view.stages.length - 1)]!) : word}`} extra="Stopped on request; nothing more runs." />
        ) : err ? (
          <ErrorLine error={err} what={engrave(kindWord(job.kind)).toLowerCase()} />
        ) : !running && job.status !== 'completed' ? (
          <ErrorLine message={`The ${kindWord(job.kind)} failed.`} />
        ) : null}
        {job.kind === 'ota' ? <OtaRings jobId={job.job_id} running={running} /> : null}
        {job.kind === 'build' && job.status === 'completed' ? (
          <ButtonRow>
            <Link to="/provision" className="ui-button" data-variant="primary">
              <span className="ui-button-text">{engrave('Provision a board')}</span>
            </Link>
            <Link to="/provision" search={{ view: 'ota', ...(str('profile') ? { profile: str('profile') } : {}) } as never} className="ui-button" data-variant="default">
              <span className="ui-button-text">{engrave('Update over the air')}</span>
            </Link>
          </ButtonRow>
        ) : null}
        <JobOutput key={job.job_id} jobId={job.job_id} defaultOpen={job.kind === 'build' || !!err} />
      </div>
    </div>
  );
}

/** `/provision/<job>`: the wizard's own job, a provisioning to resume, a build chained to one, or any job. */
export function JobRoute({ jobId, search }: { jobId: string; search: Record<string, unknown> }) {
  const s = useWizard();
  const phone = usePhone();
  const mine = s.job?.job_id === jobId || s.build?.job_id === jobId;
  const q = useOp('job_get', { job_id: jobId }, { enabled: !mine });
  const chain = readChain(search);
  const job = q.data;
  useEffect(() => {
    if (mine || !job) {
      return;
    }
    if (job.kind === 'provision') {
      dispatch({ type: 'resume', job, choices: readChoices(search) });
    } else if (job.kind === 'build' && chain) {
      replace(chainState(chain, getWizard()));
      dispatch({ type: 'build', job, full: true });
    }
  }, [job, mine]);
  if (mine) {
    return <NewBoard />;
  }
  if (q.error) {
    const gone = q.error.code === 'NOT_FOUND';
    return (
      <div className="prov-views">
        {gone ? <ErrorLine code="NOT_FOUND" message="The hub knows no such job: it may be from an earlier run of the hub, or the link is mistyped. Its recent jobs are under Firmware." /> : <ErrorLine error={q.error} what="The job" />}
        <ButtonRow>
          <Link to="/provision" search={{ view: 'firmware' } as never} className="ui-button" data-variant="primary">
            <span className="ui-button-text">{engrave('The recent jobs')}</span>
          </Link>
          <Link to="/provision" className="ui-button" data-variant="default">
            <span className="ui-button-text">{engrave('Provision a board')}</span>
          </Link>
        </ButtonRow>
      </div>
    );
  }
  if (!job || job.kind === 'provision' || (job.kind === 'build' && chain)) {
    return (
      <div className="prov-board" aria-busy="true">
        <aside className="prov-instrument">
          <Dial view={{ stages: PROVISION_STAGES, current: 0, failed: false }} idle size={phone ? 232 : 320} centre={{ word: 'reading', sub: 'the job' }} label="Reading the job" />
        </aside>
      </div>
    );
  }
  return <JobView key={job.job_id} job={job} />;
}
