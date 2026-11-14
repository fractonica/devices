// The fr.led panel (DEVICE-SPEC §2.1): the generic instrument page, with a headline that says the light as it is (on
// or off, and its colour) and the on/off ring as the Overview row's one quick control (`set {on}`). Builder PAGE.

import { useAct } from '../../../hooks.ts';
import { ColourDisc, OnOff } from '../bits.tsx';
import { PropSwitch } from '../controls.tsx';
import type { CapPanel, CapPanelProps } from '../panels.ts';
import { GenericBody, isAway } from './generic.tsx';

function LedLens(props: CapPanelProps) {
  return <GenericBody {...props} />;
}

function LedHeadline({ mirror }: CapPanelProps) {
  if (typeof mirror.on !== 'boolean') {
    return <span className="ash">not reported yet</span>;
  }
  return (
    <span className="dev-headline">
      <OnOff value={mirror.on} />
      {mirror.on && typeof mirror.color === 'number' ? <ColourDisc value={mirror.color} size={10} /> : null}
    </span>
  );
}

/** The row's on/off ring: `set {on}` at once (the brightness and colour stay as they are). */
function LedQuick({ detail, inst, mirror }: CapPanelProps) {
  const act = useAct('command_send', {
    done: (r) => (r.results[0]?.status === 'ok' ? undefined : { tone: 'warn', title: `${inst.name}: ${r.results[0]?.status.replace(/_/g, ' ') ?? 'no answer'}`, ...(r.results[0]?.error ? { body: r.results[0].error } : {}) }),
  });
  return (
    <PropSwitch
      bare
      label={`${inst.name} on or off`}
      checked={mirror.on === true}
      disabled={isAway(detail.presence) || act.isPending}
      onChange={(on) => act.mutate({ selector: `id:${detail.device_id}`, command: `${inst.name}.set`, args: { on } })}
    />
  );
}

export const LED_PANEL: CapPanel = { Lens: LedLens, Headline: LedHeadline, Quick: LedQuick };
