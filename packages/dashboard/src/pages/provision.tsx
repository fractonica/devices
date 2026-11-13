// PROVISION, routes `/provision` and `/provision/$job` (HARDWARE-REVIEW §4 "Screens" 2, 4 and 5; design README "Hub").
// Three views on the one route, `?view=`:
//   (none)       a new board: plug in · network · board · name · flash · done, the dial beside them (provision/new-board.tsx)
//   firmware     the profiles with Build, the builds kept, the recent jobs (provision/firmware.tsx)
//   ota          over the air: preview, then deploy, and the recent updates (provision/ota.tsx)
// `/provision/<job>` is any job's page, resumable: a provisioning reopens in the steps (a build chained to one too, the
// chain in the URL's search), a build or an update shows its ring and output (provision/job.tsx).

import { Navigate, useParams, useSearch } from '@tanstack/react-router';

import { useOp } from '../hooks.ts';

import { engrave, Page } from '../ui/index.ts';
import { Firmware } from './provision/firmware.tsx';
import { JobRoute } from './provision/job.tsx';
import { ProvisionNav, type ProvisionView } from './provision/nav.tsx';
import { NewBoard } from './provision/new-board.tsx';
import { OverTheAir } from './provision/ota.tsx';
import './provision/provision.css';

const SUBS: Record<ProvisionView, string> = {
  board: 'A new board, start to finish',
  firmware: 'Builds and the jobs that made them',
  ota: 'Preview, then deploy',
};

const JOB_SUB: Record<string, string> = { provision: 'Provisioning', ota: 'Updating', build: 'Building', flash: 'Flashing', deploy: 'Deploying', reset: 'Resetting' };
/** The view a job belongs to (its sub-nav word is current on the job's page). */
const JOB_VIEW: Record<string, ProvisionView> = { provision: 'board', ota: 'ota', build: 'firmware', flash: 'firmware', deploy: 'ota', reset: 'board' };

/** A job's page subtitle: what it does and to what ("Provisioning porch-light"), by the device's name. */
function useJobTitle(jobId: string | undefined): { sub: string; view?: ProvisionView } {
  const job = useOp('job_get', { job_id: jobId ?? '' }, { enabled: !!jobId });
  const devices = useOp('device_list', {});
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const j = job.data;
  if (!j) {
    return { sub: 'A job of the hub' };
  }
  const alias = (id: string) => devices.data?.devices.find((d) => d.device_id === id)?.alias ?? id;
  const target = (typeof search.alias === 'string' && search.alias) || (typeof search.profile === 'string' && j.kind === 'build' ? search.profile : '') || j.targets.map(alias).join(', ');
  return { sub: `${JOB_SUB[j.kind] ?? j.kind}${target ? ` ${target}` : ''}`, view: JOB_VIEW[j.kind] };
}

export function ProvisionPage() {
  const { job } = useParams({ strict: false }) as { job?: string };
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const view: ProvisionView = search.view === 'firmware' ? 'firmware' : search.view === 'ota' ? 'ota' : 'board';
  const title = useJobTitle(job);
  // a view's name typed as a path (/provision/firmware) is that view, not a job
  if (job === 'firmware' || job === 'ota') {
    return <Navigate to="/provision" search={{ view: job } as never} replace />;
  }
  return (
    <Page title="Provision" sub={job ? engrave(title.sub) : SUBS[view]}>
      <ProvisionNav current={job ? title.view : view} />
      {job ? <JobRoute key={job} jobId={job} search={search} /> : view === 'firmware' ? <Firmware /> : view === 'ota' ? <OverTheAir /> : <NewBoard />}
    </Page>
  );
}
