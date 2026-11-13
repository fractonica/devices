// PROVISION, routes `/provision` and `/provision/$job` (resumable). STUB of the stage 4 foundation, for the Provision
// page builder (HARDWARE-REVIEW §4 "Screens" 2): plug in (live port detection, a "listening" bead), network
// (network_list, add inline), board (probed chip -> profiles, build and provision), name (alias checked live, 31
// characters), flash (StageRing with PROVISION_STAGES, job output folded under it, Cancel), done (Open device,
// Identify). Blocks early with an in-page fix on busy_external or a leased port. Until then the old ports page, where
// provisioning starts from a port, is mounted here.

import { useParams } from '@tanstack/react-router';

import { LegacyMount } from '../legacy/mount.tsx';
import { PortsPage as LegacyPorts } from '../legacy/pages/ports.tsx';
import { Page, PROVISION_STAGES, Section, StageRing } from '../ui/index.ts';

export function ProvisionPage() {
  const { job } = useParams({ strict: false }) as { job?: string };
  return (
    <Page title="Provision" sub={job ? `Job ${job}` : 'Plug a board in'}>
      {job ? (
        <Section title="Stages">
          <StageRing stages={PROVISION_STAGES} current={0} label={`Provisioning job ${job}`} />
        </Section>
      ) : null}
      <LegacyMount>
        <LegacyPorts />
      </LegacyMount>
    </Page>
  );
}
