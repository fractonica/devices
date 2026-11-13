// The fr.camera panel (DEVICE-SPEC §3): live view over /app/stream, photo, recording, sensor settings, card
// recordings. Builder CAMERA owns panels/camera/*. SEAM STUB: registered in ../../panels.ts; CAMERA replaces the
// bodies, keeps the export name CAMERA_PANEL and the CapPanel shape.

import { Section } from '../../../../ui/index.ts';
import type { CapPanel, CapPanelProps } from '../../panels.ts';

function CameraLens({ inst }: CapPanelProps) {
  return (
    <Section title={inst.name}>
      <p className="ash" data-lens="fr.camera">
        Not watching.
      </p>
    </Section>
  );
}

function CameraHeadline({ mirror }: CapPanelProps) {
  return <span>{mirror.streaming === true ? 'live' : 'idle'}</span>;
}

export const CAMERA_PANEL: CapPanel = {
  Lens: CameraLens,
  Headline: CameraHeadline,
  // the device commands this panel runs itself, through the hub's camera ops (§3.2)
  covers: ['stream_start', 'stream_stop', 'set', 'sd_list', 'sd_fetch', 'sd_delete'],
};
