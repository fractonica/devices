// The present as a small instrument (HARDWARE-REVIEW §4 "Screens" 1): the site's NOW instrument drawn in SVG from
// the core's arcs and readings (state/hub-instrument.ts), at the phone reference size and scaled by its viewBox.
// Layers back to front, as DESIGN.md §5: the ancestors' counter rings with their planets, the carrier, the nested
// arcs, the beads, the inner bezel with its graduations and the four threshold words (Earth mode adds their clock
// times), the alidade, the point of now, and the Helion's odometer in the middle with the cycle's name above it.
//
// It redraws at the instant the core says something next changes, or when its fastest ink has moved half a unit
// (nextDraw: seconds apart), never on a poll. The arcs that change only when one is completed are memoised by the
// running arcs' indices. Outside the catalogue (or while the core loads) it stays engraved.

import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type { Core } from '@fractonica/time/browser';

import { theme } from '../../design/hub-tokens.ts';
import {
  carrierInk,
  counterRingInk,
  graduationInk,
  type HubGeometry,
  hubGeometry,
  nestInk,
  nestPath,
  nextDraw,
  nowPoint,
  odometerInk,
  pointAt,
  readHubInstrument,
  REFERENCE,
  ringCarrier,
  settledKey,
  tickAt,
} from '../../state/hub-instrument.ts';
import { engrave } from '../../ui/index.ts';

/** The core's present, redrawn at `wake` (a timer to that instant on the core's clock). */
function usePresent(core: Core | null, wake: bigint | null, at?: bigint): [bigint | null, () => void] {
  const [t, setT] = useState<bigint | null>(() => at ?? (core ? core.frc.now() : null));
  const read = () => {
    if (core && at === undefined) {
      setT(core.frc.now());
    }
  };
  const ref = useRef(read);
  ref.current = read;
  useEffect(() => {
    ref.current();
  }, [core]);
  useEffect(() => {
    if (!core || wake === null) {
      return;
    }
    const ms = Number(wake - core.frc.now()) / 1000;
    const timer = setTimeout(() => ref.current(), Math.max(0, Math.min(ms + 1, 2 ** 31 - 1)));
    return () => clearTimeout(timer);
  }, [core, wake]);
  // a hidden tab's timers are throttled: catch up when it is shown again
  useEffect(() => {
    const show = () => document.visibilityState === 'visible' && ref.current();
    document.addEventListener('visibilitychange', show);
    return () => document.removeEventListener('visibilitychange', show);
  }, []);
  return [t, read];
}

/** The engraved plate shown while the core loads: carrier, bezel and the outermost ring, nothing lit. */
export function InstrumentPlaceholder({ label = 'The present: the temporal core is loading' }: { label?: string }) {
  const E = 190;
  return (
    <figure className="hub-inst" role="img" aria-label={label} data-state="loading">
      <svg viewBox={`${-E} ${-E} ${2 * E} ${2 * E}`} aria-hidden="true">
        <circle className="i-etch2" r={REFERENCE.R} strokeWidth={0.75} />
        <circle className="i-etch2" r={REFERENCE.R * 0.71} strokeWidth={0.75} />
        <circle className="i-etch2" r={REFERENCE.R * 1.37} strokeWidth={1} />
        <circle className="i-etch2" r={175} strokeWidth={0.8} />
      </svg>
    </figure>
  );
}

/** `at` freezes the instrument at an instant (a test, a specimen); without it, it shows the present. */
export function Instrument({ core, earth, at }: { core: Core; earth: boolean; at?: bigint }) {
  const glowId = useId().replace(/:/g, '');
  const geometry: HubGeometry = useMemo(() => hubGeometry(core.frc), [core]);
  const [wake, setWake] = useState<bigint | null>(null);
  const [t] = usePresent(core, wake, at);
  const reading = useMemo(() => (t === null ? null : readHubInstrument(core, t, geometry.focus, geometry.nest.layers.length, { earth })), [core, t, geometry, earth]);
  useEffect(() => {
    setWake(reading ? nextDraw(core, geometry, reading) : null);
  }, [core, geometry, reading]);

  const path = reading?.lit && reading.steps ? nestPath(geometry.nest, reading.steps) : null;
  const key = settledKey(path);
  const settled = useMemo(() => nestInk(core.frc, geometry.nest, path, 'settled'), [core, geometry, key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!reading) {
    return <InstrumentPlaceholder />;
  }
  const { frc } = core;
  const { line, glow, alpha } = theme();
  const current = nestInk(frc, geometry.nest, path, 'current');
  const carrier = carrierInk(frc, ringCarrier(frc, geometry.carrier), reading.lit ? reading.fraction : 0);
  const rings = geometry.rings.map((placed) => {
    const a = reading.ancestors.find((x) => x.level === placed.level)!;
    return counterRingInk(frc, a, placed.radius);
  });
  const grads = graduationInk(frc, geometry.bezel, reading.graduations);
  const now = reading.lit ? nowPoint(frc, geometry.nest, path) : null;
  const E = geometry.extent;
  const rIn = geometry.bezel;
  const wordSize = 6.2;
  const wordRing = rIn - REFERENCE.wordInset;
  const u = geometry.R * 0.086;
  const glyphs = reading.digits ? odometerInk(frc, reading.digits, u) : [];
  const nameSize = 12.5 * Math.min(1, Math.max(0.62, rIn / 72));
  // layer styles (DESIGN.md §5): [width, elapsed class, elapsed opacity, to-come class, to-come width]
  const layerStyle = [
    { w: line.heroPhone, lit: 'i-lumen', a: 1, rest: 'i-etch3', rw: line.tick },
    { w: line.engrave, lit: 'i-lumen-mid', a: alpha.grand, rest: 'i-etch2', rw: line.engrave },
    { w: line.deep, lit: 'i-lumen-mid', a: alpha.great, rest: 'i-etch2', rw: line.deep },
  ];
  const sigma = glow.sigmaPhone;
  const filter = `url(#${glowId})`;
  const alidade = reading.lit ? { a: pointAt(frc, rIn, reading.fraction), b: pointAt(frc, geometry.outer + 5, reading.fraction) } : null;

  return (
    <figure className="hub-inst" role="img" aria-label={reading.label} data-state={reading.lit ? 'lit' : 'engraved'} data-digits={reading.digits?.join(' ')}>
      <svg viewBox={`${-E} ${-E} ${2 * E} ${2 * E}`} aria-hidden="true">
        <defs>
          <filter id={glowId} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur in="SourceGraphic" stdDeviation={sigma} result="blur" />
            <feComponentTransfer in="blur" result="soft">
              <feFuncA type="linear" slope={glow.arc} />
            </feComponentTransfer>
            <feMerge>
              <feMergeNode in="soft" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* the orrery: one counter ring per ancestor, its planet, its letter */}
        <g className="i-rings">
          {rings.map((r) => {
            const w = r.major ? line.ringMajor : line.ringMinor;
            return (
              <g key={r.level}>
                <path className="i-etch2" d={r.rest} strokeWidth={w} />
                <path className={r.major ? 'i-lumen-etch' : 'i-lumen-dim'} d={r.done} strokeWidth={w} />
                <path className={r.major ? 'i-lumen-ring' : 'i-lumen-mid'} d={r.lit} strokeWidth={w * line.currentSlot} />
                {r.planet ? (
                  <>
                    <circle className="i-knock" cx={r.planet.x} cy={r.planet.y} r={r.planet.r + 1.4} strokeWidth={1.4} />
                    <circle className={r.major ? 'i-fill-lumen-mid' : 'i-fill-lumen'} cx={r.planet.x} cy={r.planet.y} r={r.planet.r} />
                  </>
                ) : null}
                {r.letter ? (
                  <text className={`i-letter${r.major ? ' major' : ''}`} x={r.letter.x} y={r.letter.y + 8 * 0.34} fontSize={8}>
                    {r.letter.text}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>

        {/* the carrier: the Helion itself, its elapsed part in resting lumen */}
        <path className="i-etch2" d={carrier.toCome} strokeWidth={line.engrave} />
        <path className="i-lumen-dim" d={carrier.elapsed} strokeWidth={line.carrierLit} />

        {/* the nested arcs, deepest first */}
        {settled
          .map((ink, d) => {
            const s = layerStyle[Math.min(d, layerStyle.length - 1)]!;
            return (
              <g key={d}>
                <path className={s.rest} d={ink.toCome} strokeWidth={s.rw} />
                <path className={s.lit} d={ink.elapsed} strokeWidth={s.w} opacity={s.a} filter={d === 0 && reading.lit ? filter : undefined} />
                <path className={d === 1 ? 'i-lumen' : s.lit} d={ink.near} strokeWidth={s.w} opacity={Math.min(1, s.a + 0.25)} />
                <path className="i-lumen" d={current[d]?.current ?? ''} strokeWidth={d === 0 ? s.w : s.w * 1.2} filter={reading.lit ? filter : undefined} />
              </g>
            );
          })
          .reverse()}

        {/* beads: one per child cycle, bone through the running one */}
        {Array.from({ length: reading.beads.count }, (_, j) => {
          const at = pointAt(frc, geometry.carrier, j / reading.beads.count);
          const on = reading.lit && j <= reading.beads.lit;
          return <circle key={j} className={on ? 'i-bead on' : 'i-bead'} cx={at.x} cy={at.y} r={1.8} strokeWidth={0.8} />;
        })}

        {/* the inner bezel: graduations, the four thresholds and their words */}
        <circle className="i-etch2" r={rIn} strokeWidth={line.engrave} />
        <path className="i-etch3" d={grads.off} strokeWidth={0.8} />
        <path className="i-lumen-mid" d={grads.on} strokeWidth={line.tick} />
        {reading.thresholds.map((th) => {
          const next = th.quarter === reading.next;
          const anchor = pointAt(frc, wordRing, th.at);
          const upright = th.at === 0.5;
          const label = `${engrave(th.word)}${th.time ? ` ${th.time}` : ''}`;
          return (
            <g key={th.quarter} className={next ? 'i-next' : undefined}>
              <path className={next ? 'i-now' : 'i-etch3'} d={tickAt(frc, th.at, rIn - REFERENCE.thresholdTick, rIn)} strokeWidth={next ? 1.3 : line.tick} />
              <text
                className={next ? 'i-word next' : 'i-word'}
                x={anchor.x}
                y={anchor.y + (upright ? wordSize * 0.75 : 0)}
                fontSize={wordSize}
                transform={upright ? undefined : `rotate(${th.at * 360} ${anchor.x} ${anchor.y})`}
              >
                {label}
              </text>
            </g>
          );
        })}

        {/* the alidade and the point of now */}
        {alidade ? <line className="i-bone" x1={alidade.a.x} y1={alidade.a.y} x2={alidade.b.x} y2={alidade.b.y} strokeWidth={line.hair} opacity={alpha.alidade} /> : null}
        {now ? (
          <g className="i-nowpoint">
            <circle className="i-now" cx={now.x} cy={now.y} r={2.6 * 2.6} strokeWidth={0.6} opacity={alpha.nowHalo} fill="none" />
            <circle className="i-fill-now" cx={now.x} cy={now.y} r={2.6} filter={filter} />
            <circle className="i-fill-core" cx={now.x} cy={now.y} r={2.6 * 0.45} />
          </g>
        ) : null}

        {/* the centre: the Helion's odometer, the cycle's name above it */}
        {reading.lit && glyphs.length ? (
          <g className="i-glyphs" filter={filter}>
            {glyphs.map((g, i) => (
              <g key={i}>
                <path d={g.stroke} strokeWidth={g.lineWidth} />
                {g.fill ? <path className="dot" d={g.fill} /> : null}
              </g>
            ))}
          </g>
        ) : null}
        {reading.lit && reading.name ? <ReadingText text={reading.name} y={-u * 5.05} size={nameSize} /> : null}
      </svg>
    </figure>
  );
}

/** A reading centred in the SVG: numerals bone, unit letters and # ash. */
function ReadingText({ text, y, size }: { text: string; y: number; size: number }) {
  const runs = text.match(/[α-ω#]+|[^α-ω#]+/g) ?? [];
  return (
    <text className="i-name" x={0} y={y} fontSize={size}>
      {runs.map((run, i) => (
        <tspan key={i} className={/[α-ω#]/.test(run) ? 'u' : undefined}>
          {run}
        </tspan>
      ))}
    </text>
  );
}
