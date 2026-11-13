// A status bead (design README "Hub" 5): online a filled lumen bead, waiting or suspect a hollow bone bead, offline
// etch-3, fault (errors only) a filled fault bead; `idle` a hollow etch-3 bead for "nothing yet". Never pulses.

import { engrave } from './text.tsx';

export type BeadState = 'online' | 'waiting' | 'offline' | 'fault' | 'idle';

/** A device presence (online, suspect, offline, unknown) as a bead. */
export function presenceBead(presence: string | undefined | null): BeadState {
  return presence === 'online' ? 'online' : presence === 'suspect' ? 'waiting' : presence === 'offline' ? 'offline' : 'idle';
}

export interface BeadProps {
  state: BeadState;
  /** What the bead says, for assistive technology (and as a caps word beside it with `showLabel`). */
  label?: string;
  showLabel?: boolean;
  /** Diameter in px (default 7). */
  size?: number;
}

const WORD: Record<BeadState, string> = { online: 'online', waiting: 'waiting', offline: 'offline', fault: 'fault', idle: 'unknown' };

export function Bead({ state, label, showLabel = false, size = 7 }: BeadProps) {
  const r = size / 2 - 0.5;
  const text = label ?? WORD[state];
  const svg = (
    <svg className="ui-bead" data-state={state} width={size} height={size} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} role="img" aria-label={showLabel ? undefined : text} aria-hidden={showLabel ? true : undefined}>
      <circle r={r} />
    </svg>
  );
  if (!showLabel) {
    return svg;
  }
  return (
    <span className="ui-bead-labelled" data-state={state}>
      {svg}
      <span className="caps">{engrave(text)}</span>
    </span>
  );
}
