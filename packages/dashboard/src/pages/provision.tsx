// PROVISION, routes `/provision` and `/provision/$job` (HARDWARE-REVIEW §4 "Screens" 2, 4 and 5; design README "Hub").
// Three views on the one route, `?view=`:
//   (none)       a new board: plug in · network · board · name · flash · done, the dial beside them (provision/new-board.tsx)
//   firmware     the profiles with Build, the builds kept, the recent jobs (provision/firmware.tsx)
//   ota          over the air: preview, then deploy, and the recent updates (provision/ota.tsx)
// `/provision/<job>` is any job's page, resumable: a provisioning reopens in the steps (a build chained to one too, the
// chain in the URL's search), a build or an update shows its ring and output (provision/job.tsx).

import { useParams, useSearch } from '@tanstack/react-router';

import { engrave, Page } from '../ui/index.ts';
import { Firmware } from './provision/firmware.tsx';
import { JobRoute } from './provision/job.tsx';
import { ProvisionNav, type ProvisionView } from './provision/nav.tsx';
import { NewBoard } from './provision/new-board.tsx';
import { OverTheAir } from './provision/ota.tsx';
import './provision/provision.css';

const SUBS: Record<ProvisionView | 'job', string> = {
  board: 'A new board, start to finish',
  firmware: 'Builds and the jobs that made them',
  ota: 'Preview, then deploy',
  job: 'A job of the hub',
};

export function ProvisionPage() {
  const { job } = useParams({ strict: false }) as { job?: string };
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const view: ProvisionView = search.view === 'firmware' ? 'firmware' : search.view === 'ota' ? 'ota' : 'board';
  return (
    <Page
      title="Provision"
      sub={
        job ? (
          <>
            {engrave(SUBS.job)} <span className="mono prov-job-id">{job}</span>
          </>
        ) : (
          SUBS[view]
        )
      }
    >
      <ProvisionNav current={job ? undefined : view} />
      {job ? <JobRoute key={job} jobId={job} search={search} /> : view === 'firmware' ? <Firmware /> : view === 'ota' ? <OverTheAir /> : <NewBoard />}
    </Page>
  );
}
