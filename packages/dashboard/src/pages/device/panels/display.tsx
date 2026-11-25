// The fr.display panel (DEVICE-SPEC §2.1): the generic readings and actions, with today's panel block (snapshot, a tap
// on the picture, the layout preview) under the readings, and for an e-paper panel (trait epaper) its block: the glass,
// the ghost budget, the refreshes, a picture or text sent by the hub (design epaper-e1 D10). The snapshot commands are that block's, not forms. Builder
// PAGE.

import { isEpaper } from '../../../state/epaper.ts';
import { DisplayBlock, SNAPSHOT_COMMANDS, touchOf } from '../display.tsx';
import { EpaperBlock } from '../epaper.tsx';
import type { CapPanel, CapPanelProps } from '../panels.ts';
import { GENERIC_PANEL, GenericBody } from './generic.tsx';

/** What the e-paper block runs itself (design epaper-e1 D10): the refreshes, and hold and bitmap through the hub's picture ops. */
const EPAPER_COMMANDS = ['refresh', 'hold', 'bitmap'];

function DisplayLens(props: CapPanelProps) {
  const { detail, inst, instances, mirror } = props;
  const epaper = isEpaper(inst.traits);
  // Layouts are LVGL's: a panel whose trait ui is false answers them UNSUPPORTED, so they are not offered there.
  const noUi = inst.traits?.ui === false ? ['ui_load', 'ui_set'] : [];
  return (
    <GenericBody
      {...props}
      skip={[...SNAPSHOT_COMMANDS, ...(epaper ? EPAPER_COMMANDS : []), ...noUi]}
      extra={
        <>
          <DisplayBlock deviceId={detail.device_id} inst={inst.name} traits={inst.traits} touch={touchOf(inst, instances)} profile={detail.profile ?? null} />
          {epaper ? <EpaperBlock deviceId={detail.device_id} inst={inst.name} config={inst.config} mirror={mirror} /> : null}
        </>
      }
    />
  );
}

export const DISPLAY_PANEL: CapPanel = { Lens: DisplayLens, Headline: GENERIC_PANEL.Headline, covers: [...SNAPSHOT_COMMANDS, ...EPAPER_COMMANDS] };
