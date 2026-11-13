// Progress as light (design README "Hub" 6, DESIGN.md §5): a ring of one arc per stage from 12 o'clock. Completed
// stages are lit in lumen with the instrument's glow; the running stage is engraved and lit to its elapsed fraction (a
// flash's bytes, a compile's steps) with the point of now and the alidade at its edge; stages to come are engraved.
// Each stage's word is engraved along the bezel inside its arc, upright at the top and at the bottom; on the inner
// carrier one bead per stage counts the stages done (bone), as the instrument's sibling beads do. The centre says the
// running stage and "n of N", or what the caller puts there (a span, "listening"). No bar, no number for a fraction,
// nothing pulses: an unknown fraction leaves the arc engraved and the word lit. A failed stage is drawn in fault.
//
// One ring for every progress in the hub: provisioning (PROVISION_STAGES), builds and OTA on the Provision page, an
// update's devices side by side (`arcs`, one per device), a wiring guide's steps on the Bench (`arcs`, `bezel={false}`),
// and a 22 px mark in a row (`bare`).

import { type ReactNode, useId } from 'react';

import type { BeadState } from './bead.tsx';
import { engrave } from './text.tsx';

/** lease · probe · select · registry · render · flash · reset · hello · join (design README "Hub" 6). */
export const PROVISION_STAGES = ['lease', 'probe', 'select', 'registry', 'render', 'flash', 'reset', 'hello', 'join'] as const;

const TAU = Math.PI * 2;
const plainWord = (s: string) => s.replace(/_/g, ' ').toLowerCase();
const pt = (r: number, a: number) => [r * Math.cos(a), r * Math.sin(a)] as const;
const f2 = (n: number) => n.toFixed(2);

/** The hub's type scale (styles/base.css --fs-*), in px: a ring's text takes the largest size that fits. */
const SCALE = [7.5, 9, 11.5, 13, 15, 20] as const;
const onScale = (px: number) => [...SCALE].reverse().find((s) => s <= px) ?? SCALE[0];

/** SVG arc of radius r from a0 to a1 (radians, 0 = 3 o'clock, clockwise); `back` draws it from a1 to a0. */
function arc(r: number, a0: number, a1: number, back = false): string {
  if (a1 - a0 <= 1e-6) {
    return '';
  }
  const [x0, y0] = pt(r, back ? a1 : a0);
  const [x1, y1] = pt(r, back ? a0 : a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${f2(x0)} ${f2(y0)}A${f2(r)} ${f2(r)} 0 ${large} ${back ? 0 : 1} ${f2(x1)} ${f2(y1)}`;
}

export interface StageRingCentre {
  /** The big engraved word. */
  word: string;
  /** A caps line under it ("1 of 9", "listening"). */
  sub?: string;
  /** A reading under that (a Fractonica span: numerals bone, unit letters ash). */
  reading?: string;
  /** A status bead before the sub line. */
  bead?: BeadState;
}

/** One arc's own state, when the arcs go their own way (an update's devices side by side). */
export interface ArcState {
  status: 'done' | 'current' | 'todo' | 'failed';
  /** 0..1 of a current arc, when measured. */
  fraction?: number;
}

export interface StageRingProps {
  /** The stages' words, in order (or what each arc is: a device's alias). */
  stages: readonly string[];
  /** The index of the running stage; stages before it are complete. stages.length when all are done. */
  current: number;
  /** How much of the running stage has elapsed, 0..1; undefined when unknown (the arc stays engraved). */
  fraction?: number;
  /** The running stage failed: its arc and word turn fault. */
  failed?: boolean;
  /** Stopped by a person where it was (a cancel): not an error, so the running arc stays engraved and nothing is fault. */
  stopped?: boolean;
  /** Replaces the word in the middle ("cancelled", "updated"). */
  word?: string;
  /** Arcs that each go their own way, in place of one running stage; `current` is then the count done. */
  arcs?: readonly ArcState[];
  /** Outer diameter in px (default 168). */
  size?: number;
  /** What the centre says; default the running stage and "n of N". */
  centre?: StageRingCentre;
  /** Only the arcs: no words, beads or centre (a mark in a row, 22 px). */
  bare?: boolean;
  /** The stages' words along the bezel (default: from 200 px; off for many small steps, a wiring guide's). */
  bezel?: boolean;
  /** Before a job: every arc engraved, nothing lit. */
  idle?: boolean;
  /** A stage's word for people (default: underscores as spaces). */
  stageWord?: (stage: string) => string;
  /** What the ring is of, for assistive technology ("Provisioning desk-pad"). */
  label?: string;
}

/** A reading's runs: unit letters and # in ash. */
function readingSpans(text: string): ReactNode[] {
  return (text.match(/[α-ω#]+|[^α-ω#]+/g) ?? []).map((run, i) =>
    /[α-ω#]/.test(run) ? (
      <tspan key={i} className="u">
        {run}
      </tspan>
    ) : (
      <tspan key={i}>{run}</tspan>
    ),
  );
}

export function StageRing({ stages, current, fraction, failed = false, stopped = false, word, arcs: own, size = 168, centre, bare = false, bezel, idle = false, stageWord = plainWord, label = 'Progress' }: StageRingProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  // the words fit along the bezel from about 200 px; a smaller ring says only its middle
  const withWords = bezel ?? size >= 200;
  const n = Math.max(1, stages.length);
  const d = size;
  const r = d / 2 - (bare ? 2 : 8);
  const slot = TAU / n;
  const gap = Math.min(slot * 0.3, (bare ? 3 : 5) / r);
  const done = !idle && (own ? own.length > 0 && own.every((x) => x.status === 'done') : current >= n);
  const running = Math.min(current, n - 1);
  const frac = idle || fraction === undefined || !Number.isFinite(fraction) ? undefined : Math.max(0, Math.min(1, fraction));
  const rBand = r - Math.max(11, d * 0.042); // the bezel words' band
  const rCarrier = r * 0.7;
  const wordFs = onScale(Math.min(9, d * 0.026));
  const state = idle ? 'idle' : failed ? 'failed' : stopped ? 'stopped' : done ? 'done' : 'running';

  const arcs: ReactNode[] = [];
  const words: ReactNode[] = [];
  const beads: ReactNode[] = [];
  const defs: ReactNode[] = [];
  let now: { a: number } | null = null;
  for (let i = 0; i < n; i++) {
    const a0 = -Math.PI / 2 + i * slot + gap / 2;
    const a1 = a0 + slot - gap;
    let status: 'done' | 'current' | 'todo' | 'failed' = 'todo';
    let f = frac;
    if (own) {
      status = idle ? 'todo' : (own[i]?.status ?? 'todo');
      f = own[i]?.fraction;
    } else if (!idle) {
      status = done || i < current ? 'done' : i === current ? (failed ? 'failed' : stopped ? 'todo' : 'current') : 'todo';
    }
    if (status === 'current') {
      arcs.push(<path key={`b${i}`} className="ui-ring-arc base" d={arc(r, a0, a1)} />);
      if (f !== undefined && f > 0) {
        const at = a0 + (a1 - a0) * Math.min(1, f);
        arcs.push(<path key={`l${i}`} className="ui-ring-arc lit" d={arc(r, a0, at)} />);
        if (!own) {
          now = { a: at };
        }
      }
    } else {
      arcs.push(<path key={`a${i}`} className={`ui-ring-arc ${status}`} d={arc(r, a0, a1)} />);
    }
    if (bare) {
      continue;
    }
    // A bead on the carrier at the start of each stage: bone once the stage is done.
    const [bx, by] = pt(rCarrier, -Math.PI / 2 + i * slot);
    beads.push(<circle key={`d${i}`} className={`ui-ring-bead ${status === 'done' ? 'lit' : ''}`} cx={f2(bx)} cy={f2(by)} r={Math.max(1.6, d * 0.0068)} />);
    if (!withWords) {
      continue;
    }
    // The stage's word along the bezel, upright: clockwise on the top half, counter-clockwise on the bottom.
    const mid = (a0 + a1) / 2;
    const bottom = Math.sin(mid) > 0.05;
    const text = engrave(stageWord(stages[i]!));
    const len = (a1 - a0) * rBand;
    const fs = onScale(Math.min(wordFs, (len * 0.92) / (text.length * 0.9)));
    const cap = fs * 0.7;
    const rb = bottom ? rBand + cap / 2 : rBand - cap / 2;
    const id = `ui-ring-w-${uid}-${i}`;
    defs.push(<path key={id} id={id} d={arc(rb, a0 - 0.2, a1 + 0.2, bottom)} fill="none" />);
    words.push(
      <text key={`w${i}`} className={`ui-ring-word ${status}`} fontSize={fs}>
        <textPath href={`#${id}`} startOffset="50%" textAnchor="middle">
          {text}
        </textPath>
      </text>,
    );
  }

  const shown = centre ?? (own ? { word: word ?? '', sub: `${current} of ${n}` } : undefined) ?? {
    word: idle ? 'ready' : (word ?? (done ? 'done' : stageWord(stages[running] ?? ''))),
    sub: idle ? `${n} stages` : done ? `${n} of ${n}` : failed || stopped ? `at ${stageWord(stages[running] ?? '')}` : `${running + 1} of ${n}`,
  };
  const step = done ? n : running + 1;
  const aria = own
    ? `${label}: ${idle ? 'not started' : `${current} of ${n} done${word ? `, ${word}` : ''}`}`
    : stopped
      ? `${label}: ${word ?? 'stopped'} at ${stageWord(stages[running] ?? '')}`
      : `${label}: ${idle ? 'not started' : failed ? `${word ?? 'failed'} at ${stageWord(stages[running] ?? '')}` : done ? (word ?? 'done') : `${stageWord(stages[running] ?? '')}, stage ${step} of ${n}`}`;
  const big = onScale(Math.max(11.5, d * 0.062));
  const small = onScale(Math.max(7.5, d * 0.026));

  return (
    <figure className={`ui-ring${bare ? ' ui-ring-bare' : ''}`} data-state={state} data-stage={done ? 'done' : stages[running]} role="img" aria-label={aria} style={{ width: d, height: d }}>
      <svg width={d} height={d} viewBox={`${-d / 2} ${-d / 2} ${d} ${d}`} aria-hidden="true">
        {bare ? null : (
          <>
            <defs>{defs}</defs>
            <circle className="ui-ring-carrier" r={f2(rCarrier)} />
            {withWords ? <circle className="ui-ring-bezel" r={f2(rBand - Math.max(9, d * 0.034))} /> : null}
            {beads}
            {words}
          </>
        )}
        {arcs}
        {now && !bare ? (
          <g className="ui-ring-now">
            <line className="ui-ring-alidade" x1={f2(pt(rCarrier, now.a)[0])} y1={f2(pt(rCarrier, now.a)[1])} x2={f2(pt(r + 6, now.a)[0])} y2={f2(pt(r + 6, now.a)[1])} />
            <circle className="ui-ring-now-halo" cx={f2(pt(r, now.a)[0])} cy={f2(pt(r, now.a)[1])} r={6.8} />
            <circle className="ui-ring-now-disc" cx={f2(pt(r, now.a)[0])} cy={f2(pt(r, now.a)[1])} r={2.6} />
            <circle className="ui-ring-now-core" cx={f2(pt(r, now.a)[0])} cy={f2(pt(r, now.a)[1])} r={1.2} />
          </g>
        ) : null}
        {bare ? null : (
          <g className="ui-ring-centre">
            <text className="ui-ring-centre-word" y={shown.reading ? -big * 0.55 : -big * 0.15} fontSize={big}>
              {engrave(shown.word)}
            </text>
            {shown.sub ? (
              <g transform={`translate(0 ${shown.reading ? big * 0.45 : big * 0.85})`}>
                {shown.bead ? <circle className={`ui-ring-centre-bead ${shown.bead}`} cx={-(engrave(shown.sub).length * small * 0.47) - 7} cy={-small * 0.35} r={2.6} /> : null}
                <text className="ui-ring-centre-sub" fontSize={small}>
                  {engrave(shown.sub)}
                </text>
              </g>
            ) : null}
            {shown.reading ? (
              <text className="ui-ring-centre-reading" y={big * 1.55} fontSize={onScale(Math.max(11.5, d * 0.044))}>
                {readingSpans(shown.reading)}
              </text>
            ) : null}
          </g>
        )}
      </svg>
    </figure>
  );
}
