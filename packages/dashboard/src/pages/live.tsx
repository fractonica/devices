// LIVE, route `/live`. STUB of the stage 4 foundation, for the Live page builder (HARDWARE-REVIEW §4 "Screens" 6):
// the event stream as hairline rows, times in Fractonica notation (FTime: `29ι 21λ 3ν`, ⊕ HH:MM:SS.mmm in ash in
// Earth mode), filters by device beads and type chips, cursors behind "copy cursor". Until then the old live page is
// mounted here.

import { LegacyMount } from '../legacy/mount.tsx';
import { LivePage as LegacyLive } from '../legacy/pages/live.tsx';
import { Page } from '../ui/index.ts';

export function LivePage() {
  return (
    <Page title="Live">
      <LegacyMount>
        <LegacyLive />
      </LegacyMount>
    </Page>
  );
}
