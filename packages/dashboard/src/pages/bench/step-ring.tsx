// A guide's progress as light (design README "Hub" 6): the shared StageRing (ui/stage-ring.tsx) with one arc per step,
// lit in lumen when the step is done and engraved while it is to come, in any order; never a bar or a percentage. Large
// on a guide's page with the count in its middle; a bare mark beside a guide in the list. A guide that disagrees with
// its profile says so in fault.

import { StageRing } from '../../ui/index.ts';

export interface StepRingProps {
  /** Done flags, in step order. */
  steps: readonly boolean[];
  /** Diameter in px. */
  size?: number;
  /** The count in the middle (a large ring). */
  showCount?: boolean;
  failed?: boolean;
  label: string;
}

export function StepRing({ steps, size = 22, showCount = false, failed = false, label }: StepRingProps) {
  const done = steps.filter(Boolean).length;
  return (
    <StageRing
      stages={steps.map((_, i) => `step ${i + 1}`)}
      current={done}
      arcs={steps.map((d) => ({ status: d ? 'done' : 'todo' }))}
      failed={failed}
      size={size}
      bare={!showCount}
      bezel={false}
      centre={showCount ? { word: String(done), sub: `of ${steps.length} steps` } : undefined}
      label={label}
    />
  );
}
