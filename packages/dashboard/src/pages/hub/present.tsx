// The present in words beside the instrument, as the site's NOW column sets it: the date words (the innermost major
// and its quarter), the reading (the fine terms smaller, in ash), the ⊕ date line in Earth mode only, and the two
// countdowns with their bead counters. All of it is the core's NOW reading (useReading), redrawn at each Blink:
// this component is kept small for that.

import type { NowReading } from '@fractonica/time/browser';

import { Earth, engrave, Reading, useMode, useReading } from '../../ui/index.ts';

/** A bead counter: `count` beads, lit (bone) through `lit` (the sibling counter of DESIGN.md §5). */
export function BeadCounter({ count, lit }: { count: number; lit: number }) {
  const pitch = 7;
  const width = Math.max(1, count) * pitch;
  return (
    <svg className="hub-beads" width={width} height={7} viewBox={`0 -3.5 ${width} 7`} aria-hidden="true">
      {Array.from({ length: count }, (_, j) => (
        <circle key={j} className={j <= lit ? 'on' : undefined} cx={pitch / 2 + j * pitch} cy={0} r={1.8} strokeWidth={0.8} />
      ))}
    </svg>
  );
}

function Countdown({ c }: { c: NowReading['countdowns'][number] }) {
  if (!c.next) {
    return null;
  }
  return (
    <div className="hub-countdown">
      <BeadCounter count={c.siblings} lit={c.local} />
      <span className="caps hub-countdown-label">
        <span className="hub-sym">{c.symbol}</span> {engrave(`${c.next.quarter} in`)}
      </span>
      <Reading className="hub-countdown-span" text={c.next.span} />
      {c.next.earth ? (
        <Earth block className="hub-countdown-earth">
          {c.next.earth.when} · {c.next.earth.in}
        </Earth>
      ) : null}
    </div>
  );
}

export function Present() {
  const { mode } = useMode();
  const reading = useReading(mode);
  if (!reading) {
    return (
      <div className="hub-present" aria-busy="true">
        <p className="caps hub-words">{engrave('the present')}</p>
        <p className="hub-reading" aria-hidden="true">
          —
        </p>
      </div>
    );
  }
  const major = reading.majors[reading.majors.length - 1];
  const big = reading.terms.slice(4, 7).join(' ');
  const fine = reading.terms.slice(7).join(' ');
  return (
    <div className="hub-present" data-row="reading">
      <p className="caps hub-words">{major ? engrave(`${major.name} · ${major.quarter}`) : engrave('the present')}</p>
      <p className="hub-reading" aria-label={`Now: ${reading.terms.slice(4).join(' ')}`}>
        <Reading text={big} /> <Reading className="hub-fine" text={fine} />
      </p>
      {reading.earth ? <Earth block className="hub-earth-line">{reading.earth.line}</Earth> : null}
      <div className="hub-countdowns">
        {reading.countdowns.map((c) => (
          <Countdown key={c.level} c={c} />
        ))}
      </div>
    </div>
  );
}
