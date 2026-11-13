// DEVICES, route `/devices`. STUB of the stage 4 foundation, for the Devices page builder (HARDWARE-REVIEW §4
// "Screens" 3): the fleet as rows (bead, alias, board, profile, firmware, last event), Identify and Rename. Until then
// the old devices grid is mounted here.

import { LegacyMount } from '../legacy/mount.tsx';
import { DevicesPage as LegacyDevices } from '../legacy/pages/devices.tsx';
import { Page } from '../ui/index.ts';

export function DevicesPage() {
  return (
    <Page title="Devices">
      <LegacyMount>
        <LegacyDevices />
      </LegacyMount>
    </Page>
  );
}
