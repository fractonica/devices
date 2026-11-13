// Firmware (`/provision?view=firmware`, HARDWARE-REVIEW §4 "Screens" 5): the profiles of the hub's checkout with their
// newest build and a Build action (build_start from hub_status.source_dir; its ring is the job's page), the built
// artifacts, and the recent jobs of this page (builds, provisions, flashes, updates) with their beads. Each job opens
// its own page, `/provision/<job>`, with the ring and the output.

import { Link, useNavigate } from '@tanstack/react-router';

import { useAct, useLive, useOp } from '../../hooks.ts';
import { firmwareJobs, jobBead, kindWord, stageWord } from '../../state/provision.ts';
import { Bead, Button, Caps, EmptyState, engrave, ErrorLine, FTime, Row, Section } from '../../ui/index.ts';

function Profiles() {
  const navigate = useNavigate();
  const status = useOp('hub_status', {});
  const q = useOp('profile_list', {});
  const sourceDir = status.data?.source_dir;
  const build = useAct('build_start', { done: (j) => `Building ${j.targets.join(', ')}`, refresh: ['job_list'] });
  const list = [...(q.data?.profiles ?? [])].sort((a, b) => Number(!!b.newest_debug) - Number(!!a.newest_debug) || a.profile.localeCompare(b.profile));
  return (
    <Section title="Profiles" aside={q.data ? <Caps>{`${list.filter((p) => p.newest_debug).length} of ${list.length} built`}</Caps> : undefined}>
      <ErrorLine error={q.error} what="Profiles" fix={{ label: 'Try again', onClick: () => void q.refetch() }} />
      {q.data && !list.length ? <EmptyState title="No profiles">The hub's checkout has no firmware profiles (firmware/profiles).</EmptyState> : null}
      {list.map((p) => (
        <Row
          key={p.profile}
          id={p.profile}
          lead={<Bead state={p.newest_debug ? 'online' : 'idle'} label={p.newest_debug ? 'built' : 'not built'} />}
          name={p.profile}
          sub={`${p.board} · ${p.chip} · ${Object.keys(p.instances).length} ${Object.keys(p.instances).length === 1 ? 'capability' : 'capabilities'}`}
          value={p.newest_debug ? <FTime at={p.newest_debug.built_at} form="relative" /> : <span className="ash">not built</span>}
          extra={p.newest_debug ? <span className="mono">{p.newest_debug.fw_id.slice(0, 12)}</span> : undefined}
          actions={
            <Button
              variant="quiet"
              disabled={!sourceDir}
              busy={build.isPending && build.variables?.profile === p.profile}
              onClick={() =>
                sourceDir &&
                build.mutate({ source_dir: sourceDir, profile: p.profile }, { onSuccess: (j) => void navigate({ to: '/provision/$job', params: { job: j.job_id } }) })
              }
              aria-label={`Build ${p.profile}`}
              data-action="build"
            >
              {p.newest_debug ? 'Rebuild' : 'Build'}
            </Button>
          }
        />
      ))}
      {status.data && !sourceDir ? <p className="prov-note">This hub runs without a source checkout, so it cannot build; it flashes the builds it has.</p> : null}
    </Section>
  );
}

function Artifacts() {
  const q = useOp('artifact_list', { limit: 30 });
  const rows = q.data?.artifacts ?? [];
  return (
    <Section title="Builds" aside={q.data ? <Caps>{`${rows.length} kept`}</Caps> : undefined}>
      <ErrorLine error={q.error} what="Builds" fix={{ label: 'Try again', onClick: () => void q.refetch() }} />
      {q.data && !rows.length ? <EmptyState title="Nothing built yet">Build a profile above; its image lands here and the hub can flash it.</EmptyState> : null}
      {rows.map((a) => (
        <Row
          key={a.build_id}
          id={a.build_id}
          lead={<Bead state={a.fault ? 'fault' : 'idle'} label={a.fault ? `fault build: ${a.fault}` : a.build_type} />}
          name={a.profile}
          sub={
            <>
              <span className="mono">{a.build_id}</span> · {a.build_type}
              {a.fault ? ` · fault build (${a.fault}): it never passes its health check` : ''}
            </>
          }
          value={<FTime at={a.built_at} form="relative" />}
          extra={<span className="mono">{a.fw_id.slice(0, 12)}</span>}
        />
      ))}
    </Section>
  );
}

/** The recent jobs of this page, the live frame's stage over the stored one. */
function Jobs() {
  const q = useOp('job_list', { limit: 40 }, { refetchInterval: 10_000 });
  const frames = useLive((s) => s.jobs);
  const devices = useOp('device_list', {});
  const aliasOf = new Map((devices.data?.devices ?? []).map((d) => [d.device_id, d.alias]));
  const jobs = firmwareJobs(q.data?.jobs ?? []).slice(0, 15);
  return (
    <Section title="Jobs" aside={<Caps>builds, flashes and updates</Caps>}>
      <ErrorLine error={q.error} what="Jobs" fix={{ label: 'Try again', onClick: () => void q.refetch() }} />
      {q.data && !jobs.length ? <EmptyState title="No jobs yet">A build, a provision or an update shows here with its ring.</EmptyState> : null}
      {jobs.map((j) => {
        const f = frames[j.job_id];
        const status = f && !['completed', 'failed', 'cancelled'].includes(j.status) ? f.status : j.status;
        const stage = f?.stage ?? j.stage;
        return (
          <Row
            key={j.job_id}
            id={j.job_id}
            to="/provision/$job"
            params={{ job: j.job_id }}
            bead={jobBead(status)}
            beadLabel={status === 'working' ? 'running' : status}
            name={
              <>
                {kindWord(j.kind)} <span className="ash">{j.targets.map((t) => aliasOf.get(t) ?? t).join(', ')}</span>
              </>
            }
            value={<FTime at={j.created_at} form="relative" />}
            extra={status === 'working' && stage ? stageWord(stage) : status === 'working' ? 'running' : status}
          />
        );
      })}
    </Section>
  );
}

export function Firmware() {
  return (
    <div className="prov-views">
      <Profiles />
      <Artifacts />
      <Jobs />
      <p className="prov-note">
        To flash a board for the first time, use <Link to="/provision">a new board</Link>; to update boards that run already, <Link to="/provision" search={{ view: 'ota' } as never}>over the air</Link>.
      </p>
    </div>
  );
}
