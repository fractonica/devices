// Progress as light (design README "Hub" 6): a ring of N arcs, one per stage, separated by small gaps and starting at
// 12 o'clock like a counter ring. Completed stages are lit in lumen (with the instrument's glow); the running stage's
// arc is engraved and lit to its elapsed fraction (a flash's bytes); stages to come are etch-2. The running stage's
// word is engraved in the middle with "n of N" under it. No bar, no percentage, nothing pulses: an unknown fraction
// leaves the arc engraved and the word lit. A failed stage is drawn in fault.
//
// Provisioning's nine stages are PROVISION_STAGES; builds and OTA pass their own.

import { engrave } from './text.tsx';

/** lease · probe · select · registry · render · flash · reset · hello · join (design README "Hub" 6). */
export const PROVISION_STAGES = ['lease', 'probe', 'select', 'registry', 'render', 'flash', 'reset', 'hello', 'join'] as const;

export interface StageRingProps {
  /** The stages' words, in order. */
  stages: readonly string[];
  /** The index of the running stage; stages before it are complete. stages.length when all are done. */
  current: number;
  /** How much of the running stage has elapsed, 0..1; undefined when unknown (the arc stays engraved). */
  fraction?: number;
  /** The running stage failed: its arc and word turn fault. */
  failed?: boolean;
  /** Outer diameter in px (default 168; at least 96). */
  size?: number;
  /** Replaces the word in the middle (e.g. "done", "cancelled"). */
  word?: string;
  /** What the ring is of, for assistive technology ("Provisioning desk-pad"). */
  label?: string;
}

const TAU = Math.PI * 2;
const at = (r: number, a: number) => [r * Math.cos(a), r * Math.sin(a)] as const;

/** SVG path of the arc of radius r from angle a0 to a1 (radians, 0 = 3 o'clock, clockwise). */
function arcPath(r: number, a0: number, a1: number): string {
  if (a1 - a0 <= 1e-6) {
    return '';
  }
  const [x0, y0] = at(r, a0);
  const [x1, y1] = at(r, a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function StageRing({ stages, current, fraction, failed = false, size = 168, word, label }: StageRingProps) {
  const n = Math.max(1, stages.length);
  const d = Math.max(96, size);
  const r = d / 2 - 6;
  const gap = Math.min(0.12, (4.5 / r) * 1); // about 4.5 px of gap at any size
  const slot = TAU / n;
  const done = current >= n;
  const state = failed ? 'failed' : done ? 'done' : 'running';
  const running = Math.min(current, n - 1);
  const f = fraction === undefined || !Number.isFinite(fraction) ? undefined : Math.max(0, Math.min(1, fraction));
  const shown = word ?? (done ? 'done' : (stages[running] ?? ''));
  const wordSize = Math.max(9, Math.round(d * 0.068));
  const arcs = [];
  for (let i = 0; i < n; i++) {
    const a0 = -Math.PI / 2 + i * slot + gap / 2;
    const a1 = a0 + slot - gap;
    if (i < current || done) {
      arcs.push(<path key={i} className="arc done" d={arcPath(r, a0, a1)} strokeWidth={1.4} />);
    } else if (i === current) {
      if (failed) {
        arcs.push(<path key={i} className="arc failed" d={arcPath(r, a0, a1)} strokeWidth={1.4} />);
      } else {
        arcs.push(<path key={`${i}b`} className="arc base" d={arcPath(r, a0, a1)} strokeWidth={0.9} />);
        if (f !== undefined && f > 0) {
          arcs.push(<path key={`${i}l`} className="arc lit" d={arcPath(r, a0, a0 + (a1 - a0) * f)} strokeWidth={1.4} />);
        }
      }
    } else {
      arcs.push(<path key={i} className="arc todo" d={arcPath(r, a0, a1)} strokeWidth={0.75} />);
    }
  }
  const step = done ? n : running + 1;
  const aria = `${label ? `${label}: ` : ''}${failed ? `failed at ${stages[running]}` : done ? 'done' : `${stages[running]}, stage ${step} of ${n}`}`;
  return (
    <figure className="ui-stage-ring" data-state={state} data-stage={done ? 'done' : stages[running]} role="img" aria-label={aria}>
      <svg width={d} height={d} viewBox={`${-d / 2} ${-d / 2} ${d} ${d}`} aria-hidden="true">
        <circle className="carrier" r={r * 0.71} strokeWidth={0.75} />
        {arcs}
        <text className="word" y={-wordSize * 0.35} fontSize={wordSize}>
          {engrave(shown)}
        </text>
        <text className="count" y={wordSize * 1.15} fontSize={Math.max(7, wordSize * 0.72)}>
          {engrave(`${step} of ${n}`)}
        </text>
      </svg>
    </figure>
  );
}
