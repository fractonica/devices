// The fr.display panel (DEVICE-SPEC §2.1): the generic readings and actions, with today's panel block (snapshot, a tap
// on the picture, the layout preview) under the readings. The snapshot commands are that block's, not forms. Builder
// PAGE.

import { DisplayBlock, SNAPSHOT_COMMANDS, touchOf } from '../display.tsx';
import type { CapPanel, CapPanelProps } from '../panels.ts';
import { GENERIC_PANEL, GenericBody } from './generic.tsx';

function DisplayLens(props: CapPanelProps) {
  const { detail, inst, instances } = props;
  return (
    <GenericBody
      {...props}
      skip={SNAPSHOT_COMMANDS}
      extra={<DisplayBlock deviceId={detail.device_id} inst={inst.name} traits={inst.traits} touch={touchOf(inst, instances)} profile={detail.profile ?? null} />}
    />
  );
}

export const DISPLAY_PANEL: CapPanel = { Lens: DisplayLens, Headline: GENERIC_PANEL.Headline, covers: SNAPSHOT_COMMANDS };
