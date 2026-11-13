// DEVICE, route `/devices/$id` (an alias or a device id). STUB of the stage 4 foundation, for the Device page builder
// (HARDWARE-REVIEW §4 "Screens" 3): header (alias, presence bead, board, profile, firmware; Identify, Rename), a
// LENS-style data column, capabilities as rows with typed controls generated from the catalog, a sparkline per
// property, logs on demand (Term), an "Engineering" disclosure, the face mirror. Until then the old device page is
// mounted here.

import { useParams } from '@tanstack/react-router';

import { LegacyMount } from '../legacy/mount.tsx';
import { DevicePage as LegacyDevice } from '../legacy/pages/device.tsx';
import { Page } from '../ui/index.ts';

export function DevicePage() {
  const { id } = useParams({ from: '/devices/$id' });
  return (
    <Page title={id}>
      <LegacyMount>
        <LegacyDevice />
      </LegacyMount>
    </Page>
  );
}
