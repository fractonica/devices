// The hub's small instrument (HARDWARE-REVIEW §4 "Screens" 1; DESIGN.md §5): the site's NOW instrument at the phone
// reference size, focused on the Helion, without the Sun's ring (sol is the clock's, design README "Hub" 5) and
// without the limb. Every arc is the core's (frc.arcChild, frc.arcPoint, frc.arcSvgPath) and every count, phase and
// glyph state is read from it (cat.cycleAt, cat.odometerAt, cat.nextThreshold): this module only decides which arcs
// exist and which of them are lit, as the site's app/drawing/arcs.js, app/instrument/geometry.js and
// app/instrument/reading.js do, and writes SVG path data. No React here, so it is tested in node.
//
// Coordinates: SVG user units with the centre at (0, 0), y down, 0 rad at 3 o'clock, clockwise. The component draws
// it in a viewBox, so the whole instrument scales with its box (marks and type with it, as the site's markScale).

import type { Core } from '@fractonica/time/browser';
import { isoLocal, LevelKind, Quarter, Unit } from '@fractonica/time/browser';

type Frc = Core['frc'];
type Cycle = ReturnType<Core['cat']['cycleAt']>;

/** An arc as the core gives it (frc_arc_t). */
export interface Arc {
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  readonly start: number;
  readonly sweep: number;
}

/** The first counter ring sits at this multiple of the hero radius; the inner bezel at BEZEL (DESIGN.md §5). */
export const FIRST_RING = 1.37;
export const BEZEL = 0.71;
/** The nested arcs may reach this multiple of the hero radius (clear of the first counter ring). */
const NEST_REACH = 1.335;
/** Stop nesting when an arc's radius would fall under this (design ruling 9). */
export const MIN_ARC_RADIUS = 3;
/** α β γ δ are majors: their rings are closer together (gapMajor). */
const LAST_MAJOR = 3;

/** The phone reference (DESIGN.md §7): hero R 102, rings +9.5 (majors +6.5), two nested levels, bezel ticks. */
export const REFERENCE = Object.freeze({ R: 102, gap: 9.5, gapMajor: 6.5, depth: 2, longTick: 4.6, shortTick: 2.4, thresholdTick: 6, wordInset: 12.5 });

/** The four thresholds in their places on the bezel: end at 12, peak at 3, node at 6, valley at 9 o'clock. */
export const BEZEL_QUARTERS = Object.freeze([Quarter.END, Quarter.PEAK, Quarter.NODE, Quarter.VALLEY]);
export const BEZEL_FRACTIONS: Readonly<Record<number, number>> = Object.freeze({ [Quarter.END]: 0, [Quarter.PEAK]: 0.25, [Quarter.NODE]: 0.5, [Quarter.VALLEY]: 0.75 });

/** Stems of the centre odometer are this many design units apart (DESIGN.md §6). */
export const PAIR_PITCH = 5.6;
/** The odometer's box centre sits this many design units below the centre (the cycle's name stands above it). */
const ODOMETER_DROP = 0.4;

/** The level the hub's instrument shows: the Helion, as the site's NOW opens. */
export function hubFocus(frc: Frc): number {
  return frc.unitLevel(Unit.HELION) ?? 6;
}

/** A whole cycle drawn as a closed ring: a circle from 12 o'clock, clockwise; a fraction along it is a phase. */
export function ringCarrier(frc: Frc, radius: number, cx = 0, cy = 0): Arc {
  const pi = frc.constants.PI;
  return { cx, cy, radius, start: -pi / 2, sweep: 2 * pi };
}

// ------------------------------------------------------------------------------------------------- the nest

export interface NestLayer {
  level: number;
  /** Arcs per parent arc. */
  m: number;
  /** Flat and in time order: arc i is child i mod m of arc floor(i / m) of the layer above. */
  arcs: Arc[];
  odd: Uint8Array;
}

export interface Nest {
  carrier: Arc;
  level: number;
  layers: NestLayer[];
  /** Parity of the first arc's global half index (0 for a ring). */
  lead: number;
}

/** The nested half-cycle arcs of a whole cycle of `level` on `carrier` (the site's buildNest, ring form). */
export function buildNest(frc: Frc, carrier: Arc, level: number, depth: number, minRadius = MIN_ARC_RADIUS): Nest {
  const layers: NestLayer[] = [];
  let parents: Arc[] = [carrier];
  let parentOdd = Uint8Array.of(0);
  for (let d = 0; d < depth; d++) {
    const m = (d === 0 ? 2 : 1) * frc.factor(level + d);
    const arcs: Arc[] = new Array(parents.length * m);
    const odd = new Uint8Array(arcs.length);
    let total = 0;
    for (let p = 0; p < parents.length; p++) {
      for (let j = 0; j < m; j++) {
        const isOdd = (parentOdd[p]! * m + j) & 1;
        const arc = frc.arcChild(parents[p]!, m, j, isOdd) as Arc;
        arcs[p * m + j] = arc;
        odd[p * m + j] = isOdd;
        total += arc.radius;
      }
    }
    // judged by the layer's mean, as the site does (an inward bulge is smaller than an outward one)
    if (d > 0 && total / arcs.length < minRadius) {
      break;
    }
    layers.push({ level: level + 1 + d, m, arcs, odd });
    parents = arcs;
    parentOdd = odd;
  }
  return { carrier, level, layers, lead: layers.length > 0 ? layers[0]!.odd[0]! : 0 };
}

/** Where now is in a nest: per layer the flat index of the arc being drawn and how far along it is. */
export type NestPath = { index: number; progress: number }[];

export function nestPath(nest: Nest, steps: readonly { local: number; progress: number }[]): NestPath {
  const path: NestPath = [];
  let flat = 0;
  for (let d = 0; d < nest.layers.length && d < steps.length; d++) {
    flat = flat * nest.layers[d]!.m + steps[d]!.local;
    path.push({ index: flat, progress: steps[d]!.progress });
  }
  return path;
}

/** The point of now: on the deepest arc drawn, at its own fraction. */
export function nowPoint(frc: Frc, nest: Nest, path: NestPath | null): { x: number; y: number } | null {
  if (!path || path.length === 0) {
    return null;
  }
  const last = path[path.length - 1]!;
  return frc.arcPoint(nest.layers[path.length - 1]!.arcs[last.index]!, last.progress);
}

// --------------------------------------------------------------------------------------------- geometry

export interface PlacedRing {
  level: number;
  radius: number;
  major: boolean;
}

export interface HubGeometry {
  focus: number;
  /** The hero radius. */
  R: number;
  /** The carrier's radius (R for the Helion) and the inner bezel's. */
  carrier: number;
  bezel: number;
  nest: Nest;
  /** Counter rings of the ancestors, outward: the parent of the focus first, α last. */
  rings: PlacedRing[];
  /** The outermost ring's radius. */
  outer: number;
  /** Half the side of the box that holds everything (rings, planets, their letters). */
  extent: number;
}

/** Reach of the nested arcs of `focus` on a carrier of radius 1, per layer (the site's unitReach). */
function unitReach(frc: Frc, focus: number, depth: number): { outer: number; inner: number; meanRadius: number }[] {
  const nest = buildNest(frc, ringCarrier(frc, 1), focus, depth, 0);
  const found: { outer: number; inner: number; meanRadius: number }[] = [];
  let outer = 1;
  let inner = 1;
  for (const layer of nest.layers) {
    let sum = 0;
    for (const arc of layer.arcs) {
      const distance = Math.hypot(arc.cx, arc.cy);
      outer = Math.max(outer, distance + arc.radius);
      inner = Math.min(inner, distance - arc.radius);
      sum += arc.radius;
    }
    found.push({ outer, inner, meanRadius: sum / layer.arcs.length });
  }
  return found;
}

/**
 * Where the instrument's circles are, at the phone reference (R 102) or the R given: the carrier and the bezel that
 * let the focus's arcs fit between them (the Helion's are the design's: carrier R, bezel 0.71 R), the nest built on
 * the carrier, and the ancestors' counter rings laid outward from 1.37 R (no Sun's ring in the hub).
 */
export function hubGeometry(frc: Frc, focus = hubFocus(frc), R: number = REFERENCE.R): HubGeometry {
  const k = R / REFERENCE.R;
  const reach = unitReach(frc, focus, REFERENCE.depth);
  let layers = reach.length;
  let carrier = R;
  for (;;) {
    carrier = Math.min(R, (NEST_REACH * R) / reach[layers - 1]!.outer);
    if (layers > 1 && reach[layers - 1]!.meanRadius * carrier < MIN_ARC_RADIUS) {
      layers--;
    } else {
      break;
    }
  }
  const bezel = Math.min(BEZEL * R, carrier * reach[layers - 1]!.inner - REFERENCE.longTick * k);
  const nest = buildNest(frc, ringCarrier(frc, carrier), focus, layers, 0);
  const rings: PlacedRing[] = [];
  let radius = FIRST_RING * R;
  for (let level = focus - 1; level >= 0; level--) {
    if (rings.length > 0) {
      radius += (level + 1 <= LAST_MAJOR + 1 ? REFERENCE.gapMajor : REFERENCE.gap) * k;
    }
    rings.push({ level, radius, major: level <= LAST_MAJOR });
  }
  const outer = rings.length > 0 ? rings[rings.length - 1]!.radius : FIRST_RING * R;
  return { focus, R, carrier, bezel, nest, rings, outer, extent: outer + 13 * k };
}

// ---------------------------------------------------------------------------------------------- reading

export interface AncestorRing {
  level: number;
  letter: string;
  major: boolean;
  /** How many children the level has (its slots). */
  slots: number;
  /** The running child's place in this level's cycle; -1 when nothing is lit. */
  current: number;
  /** How far that child has run, 0..1. */
  slotFraction: number;
  /** The level's own phase: where its planet is; null for none. */
  fraction: number | null;
}

export interface BezelWord {
  quarter: number;
  word: string;
  /** Place on the ring from 12 o'clock, 0..1. */
  at: number;
  /** Earth mode only: the local clock time of the threshold, "12:56"; '' in pure mode. */
  time: string;
}

export interface HubInstrumentReading {
  /** False outside the catalogue: the instrument stays engraved (design ruling 7). */
  lit: boolean;
  focus: number;
  t: bigint;
  /** Phase of the focused cycle, 0..1: the carrier's lit part and the alidade's angle. */
  fraction: number;
  /** The path to now (per nested layer: the running half-cycle's index inside its parent arc and its progress). */
  steps: { local: number; progress: number }[] | null;
  beads: { count: number; lit: number };
  graduations: { count: number; every: number; lit: number };
  thresholds: BezelWord[];
  /** The next threshold's quarter, or -1. */
  next: number;
  /** The focus's two-glyph odometer (glyph state indices), or null. */
  digits: number[] | null;
  /** The focused cycle's own name in the reading style, "34η". */
  name: string;
  ancestors: AncestorRing[];
  /** Instants at which something above next changes state. */
  changes: bigint[];
  /** The instrument in words for assistive technology: core notation only, nothing Earth (design ruling 11). */
  label: string;
}

/** The local clock time "HH:MM" of an instant (Earth mode only: the bezel words). */
export function clockMinute(core: Core, t: bigint): string {
  const m = /T(\d{2}:\d{2})/.exec(isoLocal(core, t));
  return m ? m[1]! : '';
}

/**
 * Everything the instrument shows at `t`, asked of the core (the site's readInstrument, without the Sun): plain data,
 * so one object describes one frame and a test can check it without drawing.
 */
export function readHubInstrument(core: Core, t: bigint, focus: number, depth: number, opts: { earth?: boolean } = {}): HubInstrumentReading {
  const { frc, cat } = core;
  const lit = cat.contains(t);
  const cache = new Map<number, Cycle>();
  const cycle = (level: number): Cycle => {
    let c = cache.get(level);
    if (!c) {
      c = cat.cycleAt(t, level);
      cache.set(level, c);
    }
    return c;
  };
  const unit = frc.unitOfLevel(focus);
  const word = unit === null ? frc.formatLevelWord(focus) : frc.formatUnitName(unit);
  const reading: HubInstrumentReading = {
    lit,
    focus,
    t,
    fraction: 0,
    steps: null,
    beads: { count: frc.factor(focus), lit: -1 },
    graduations: { count: frc.factor(focus) * frc.factor(focus + 1), every: frc.factor(focus + 1), lit: -1 },
    thresholds: BEZEL_QUARTERS.map((quarter) => ({ quarter, word: frc.formatQuarter(quarter), at: BEZEL_FRACTIONS[quarter]!, time: '' })),
    next: -1,
    digits: null,
    name: '',
    ancestors: [],
    changes: [],
    label: `The present, ${word}: nothing lit, outside the catalogue.`,
  };
  for (let level = focus - 1; level >= 0; level--) {
    const child = lit ? cycle(level + 1) : null;
    reading.ancestors.push({
      level,
      letter: frc.formatLevelName(level),
      major: frc.levelKind(level) === LevelKind.MAJOR,
      slots: frc.factor(level),
      current: child ? child.local : -1,
      slotFraction: child ? child.fraction : 0,
      fraction: lit ? cycle(level).fraction : null,
    });
  }
  if (!lit) {
    return reading;
  }
  const own = cycle(focus);
  reading.fraction = own.fraction;
  reading.steps = ringSteps(core, t, focus, depth, cycle);
  reading.beads.lit = cycle(focus + 1).local;
  reading.graduations.lit = Number(cycle(focus + 2).cycle - own.cycle * BigInt(frc.factor(focus) * frc.factor(focus + 1)));
  const threshold = cat.nextThreshold(t, focus);
  reading.next = threshold.name;
  const odometer = cat.odometerAt(t, focus, 2, 2);
  reading.digits = [...odometer.digits];
  reading.name = frc.formatCycleName(focus, own.cycle, true);
  for (const at of [odometer.nextChange, threshold.time, cycle(focus + 1).end, cycle(focus + 2).end]) {
    if (at !== null && at > t) {
      reading.changes.push(at);
    }
  }
  if (opts.earth) {
    const points = cat.cyclePoints(focus, own.cycle); // start, peak, node, valley, end
    const at: Record<number, bigint | null | undefined> = { [Quarter.PEAK]: points[1], [Quarter.NODE]: points[2], [Quarter.VALLEY]: points[3], [Quarter.END]: points[4] };
    for (const item of reading.thresholds) {
      const when = at[item.quarter];
      if (when !== null && when !== undefined) {
        item.time = clockMinute(core, when);
      }
    }
  }
  const parts = [`The present, ${word} ${frc.formatCycleName(focus, own.cycle)}`];
  if (threshold.time !== null) {
    parts.push(`${frc.formatQuarter(threshold.name)} in ${frc.formatSpan(cat.spanBetween(t, threshold.time), 2)}`);
  }
  parts.push(`${reading.beads.lit + 1} of ${reading.beads.count} ${frc.formatLevelName(focus + 1)} cycles begun`);
  reading.label = `${parts.join('. ')}.`;
  return reading;
}

/**
 * The path from the focused cycle down to now (the site's model/halves.js ringSteps): the core returns cycles, the
 * arcs are half-cycles; half index = 2 x cycle + (phase >= FRAC_HALF), progress = phase << 1; child half index =
 * parent half index x m + j. Index bookkeeping on the core's exact answers, no clock arithmetic.
 */
export function ringSteps(core: Core, t: bigint, focus: number, depth: number, cycle: (level: number) => Cycle = (l) => core.cat.cycleAt(t, l)): { local: number; progress: number }[] {
  const { frc } = core;
  const steps: { local: number; progress: number }[] = [];
  const first = 2n * cycle(focus).cycle * BigInt(frc.factor(focus));
  let parent: bigint | null = null;
  for (let d = 0; d < depth; d++) {
    const level = focus + 1 + d;
    if (level > frc.constants.CLOCK_MAX_LEVEL) {
      break;
    }
    const c = cycle(level);
    const second = c.phase >= frc.constants.FRAC_HALF;
    const index = 2n * c.cycle + (second ? 1n : 0n);
    const progress = frc.fracToDouble((c.phase << 1) >>> 0);
    const base = parent === null ? first : parent * BigInt(frc.factor(level - 1));
    steps.push({ local: Number(index - base), progress });
    parent = index;
  }
  return steps;
}

// -------------------------------------------------------------------------------------------------- ink

/** Per nested layer: arcs to come, elapsed, the near ones (the child cycle that holds now), and the lit part of the running arc. */
export interface LayerInk {
  depth: number;
  toCome: string;
  elapsed: string;
  near: string;
  current: string;
}

/**
 * The nest as SVG path data in two parts, as the site's paintNest splits it: `settled` changes only when an arc is
 * completed (the running arc engraved whole), `current` is only the lit part of the running arcs, laid over it.
 * `path` null paints everything as to come (engraved, out of the catalogue).
 */
export function nestInk(frc: Frc, nest: Nest, path: NestPath | null, part: 'settled' | 'current'): LayerInk[] {
  const out: LayerInk[] = [];
  const lead = nest.lead;
  const nearCycle = path && path.length > 0 ? (path[0]!.index + lead) >> 1 : -1;
  const firstCount = nest.layers[0]?.arcs.length ?? 1;
  nest.layers.forEach((layer, d) => {
    const step = path && d < path.length ? path[d]! : null;
    const perFirst = layer.arcs.length / firstCount;
    const ink: LayerInk = { depth: d, toCome: '', elapsed: '', near: '', current: '' };
    if (part === 'current') {
      if (step && step.progress > 0) {
        ink.current = frc.arcSvgPath(layer.arcs[step.index]!, 0, step.progress);
      }
      out.push(ink);
      return;
    }
    for (let i = 0; i < layer.arcs.length; i++) {
      const arc = layer.arcs[i]!;
      if (step === null || i >= step.index) {
        ink.toCome += frc.arcSvgPath(arc); // the running arc is engraved whole; `current` lights its elapsed part
      } else if (d > 0 && (Math.floor(i / perFirst) + lead) >> 1 === nearCycle) {
        ink.near += frc.arcSvgPath(arc);
      } else {
        ink.elapsed += frc.arcSvgPath(arc);
      }
    }
    out.push(ink);
  });
  return out;
}

/** The key under which nestInk(…, 'settled') stays the same: the running arc's index per layer. */
export function settledKey(path: NestPath | null): string {
  return path ? path.map((s) => s.index).join('.') : '-';
}

const f2 = (n: number) => (Math.round(n * 100) / 100).toString();

/** The carrier's elapsed and to-come parts. */
export function carrierInk(frc: Frc, carrier: Arc, fraction: number): { elapsed: string; toCome: string } {
  const f = Math.max(0, Math.min(1, fraction));
  return { elapsed: f > 0 ? frc.arcSvgPath(carrier, 0, f) : '', toCome: f < 1 ? frc.arcSvgPath(carrier, f, 1) : '' };
}

export interface RingInk {
  level: number;
  major: boolean;
  rest: string;
  done: string;
  lit: string;
  planet: { x: number; y: number; r: number } | null;
  letter: { x: number; y: number; text: string } | null;
}

/** A counter ring: its slots (3.2 units of gap between them, from 12 o'clock), the planet at the level's phase, its letter further along. */
export function counterRingInk(frc: Frc, ring: AncestorRing, radius: number, k = 1): RingInk {
  const carrier = ringCarrier(frc, radius);
  const turn = 2 * frc.constants.PI * radius;
  const gap = (3.2 * k) / turn;
  const ink: RingInk = { level: ring.level, major: ring.major, rest: '', done: '', lit: '', planet: null, letter: null };
  for (let j = 0; j < ring.slots; j++) {
    const from = j / ring.slots + gap / 2;
    const to = (j + 1) / ring.slots - gap / 2;
    if (to <= from) {
      continue;
    }
    if (j < ring.current) {
      ink.done += frc.arcSvgPath(carrier, from, to);
    } else if (j > ring.current || ring.current < 0) {
      ink.rest += frc.arcSvgPath(carrier, from, to);
    } else {
      const split = from + (to - from) * Math.min(1, Math.max(0, ring.slotFraction));
      if (split > from) {
        ink.lit += frc.arcSvgPath(carrier, from, split);
      }
      if (split < to) {
        ink.rest += frc.arcSvgPath(carrier, split, to);
      }
    }
  }
  if (ring.fraction !== null && ring.current >= 0) {
    const at = frc.arcPoint(carrier, ring.fraction);
    ink.planet = { x: at.x, y: at.y, r: (ring.major ? 1.6 : 1.9) * k };
    const further = frc.arcPoint(carrier, ring.fraction + (9.5 * k) / turn);
    ink.letter = { x: further.x, y: further.y, text: ring.letter };
  }
  return ink;
}

/** The bezel's graduations, one per grandchild cycle (a long one at each child cycle), lit through `lit`. */
export function graduationInk(frc: Frc, bezel: number, g: { count: number; every: number; lit: number }, k = 1): { on: string; off: string } {
  const ring = ringCarrier(frc, bezel);
  const long = ringCarrier(frc, bezel + REFERENCE.longTick * k);
  const short = ringCarrier(frc, bezel + REFERENCE.shortTick * k);
  let on = '';
  let off = '';
  for (let i = 0; i < g.count; i++) {
    const a = frc.arcPoint(ring, i / g.count);
    const b = frc.arcPoint(i % g.every === 0 ? long : short, i / g.count);
    const d = `M${f2(a.x)} ${f2(a.y)}L${f2(b.x)} ${f2(b.y)}`;
    if (i <= g.lit) {
      on += d;
    } else {
      off += d;
    }
  }
  return { on, off };
}

/** A radial tick at a fraction of the ring, from radius r0 to r1. */
export function tickAt(frc: Frc, fraction: number, r0: number, r1: number): string {
  const a = frc.arcPoint(ringCarrier(frc, r0), fraction);
  const b = frc.arcPoint(ringCarrier(frc, r1), fraction);
  return `M${f2(a.x)} ${f2(a.y)}L${f2(b.x)} ${f2(b.y)}`;
}

/** The point on the ring of radius r at a fraction from 12 o'clock. */
export function pointAt(frc: Frc, radius: number, fraction: number): { x: number; y: number } {
  return frc.arcPoint(ringCarrier(frc, radius), fraction);
}

/** The centre odometer: one stroke path and one dot path per glyph, centred on (0, u x drop), as DESIGN.md §6 places it. */
export function odometerInk(frc: Frc, digits: readonly number[], u: number, strokes = 2): { stroke: string; fill: string; lineWidth: number }[] {
  const first = -(PAIR_PITCH * u * (digits.length - 1)) / 2;
  const top = u * ODOMETER_DROP - ((3 * strokes - 2.05) / 2) * u;
  return digits.map((index, i) => frc.glyphSvgPath(frc.glyphFromIndex(index, strokes), { scale: u, x: first + i * PAIR_PITCH * u, y: top }));
}

/**
 * When the instrument should be drawn again after `t`: the next state change of the reading, or sooner when its
 * fastest ink (the point of now on the deepest arc, the alidade at the outer ring) has moved about half a unit.
 * Never a fixed poll: on a slow focus this is seconds apart.
 */
export function nextDraw(core: Core, geometry: HubGeometry, reading: HubInstrumentReading): bigint | null {
  if (!reading.lit) {
    return null;
  }
  const { cat } = core;
  const t = reading.t;
  let wake: bigint | null = null;
  for (const c of reading.changes) {
    if (c > t && (wake === null || c < wake)) {
      wake = c;
    }
  }
  const deepest = geometry.nest.layers[geometry.nest.layers.length - 1];
  const focusCycle = cat.cycleAt(t, geometry.focus);
  const steps: number[] = [];
  if (focusCycle.start !== null && focusCycle.end !== null) {
    const us = Number(focusCycle.end - focusCycle.start);
    steps.push((us * 0.5) / (2 * Math.PI * geometry.outer));
  }
  if (deepest) {
    const c = cat.cycleAt(t, deepest.level);
    if (c.start !== null && c.end !== null) {
      const half = Number(c.end - c.start) / 2;
      const mean = deepest.arcs.reduce((s, a) => s + a.radius, 0) / deepest.arcs.length;
      steps.push((half * 0.5) / Math.max(1, mean * Math.PI));
    }
  }
  if (steps.length) {
    const step = BigInt(Math.round(Math.max(250_000, Math.min(60_000_000, Math.min(...steps)))));
    if (wake === null || t + step < wake) {
      wake = t + step;
    }
  }
  return wake;
}
