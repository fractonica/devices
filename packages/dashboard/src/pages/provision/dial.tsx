// The Provision page's rings: the shared StageRing (ui/stage-ring.tsx) over a DialView of state/provision.ts (a job's
// stages, its running stage and measured fraction, or an update's devices side by side), with the page's stage words.

import { StageRing, type StageRingCentre } from '../../ui/index.ts';
import { type DialView, stageWord } from '../../state/provision.ts';

export type DialCentre = StageRingCentre;

export interface DialProps {
  view: DialView;
  /** Outer diameter in px. */
  size?: number;
  centre?: DialCentre;
  /** Only the arcs (a mark in a row). */
  bare?: boolean;
  label: string;
  /** Before a job: every arc engraved. */
  idle?: boolean;
}

export function Dial({ view, size = 320, centre, bare, label, idle }: DialProps) {
  return <StageRing {...view} size={size} centre={centre} bare={bare} label={label} idle={idle} stageWord={stageWord} />;
}
