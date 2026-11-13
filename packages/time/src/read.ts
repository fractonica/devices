// The readings: what `fr time …` prints and the hub's time_* ops answer, as plain JSON-ready objects. Each is a
// selection of core answers (cycleAt, nextThreshold, dateAt, syncAt, pentadAt, spanBetween and the frc_format_*
// wordings); nothing here counts, rounds or names anything itself. The order and choice follow the site's NOW and
// LADDER screens (web/public/app/screens/now/now-reading.js, screens/ladder/).
//
// Conventions:
// - Instants are Unix microseconds as DECIMAL STRINGS (`*_us`): the catalogue runs to 2857, past 2^53 µs.
// - `level` is zero-based (0 = α), as the core numbers it; `depth` is level + 1, the user-facing number of
//   fractonica.h, which the ladder shows and a person types.
// - Words are the core's, in its case ("Valley", "Delta Trifracton"); a layout may engrave them in capitals.
// - `earth` blocks exist only when Earth mode was asked for (design ruling 11): a pure reading has no civil time,
//   zone or Earth unit anywhere in it.

import { DateForm, LevelKind, PentadForm, Unit } from '../vendor/lib/fractonica.js';
import type { Core } from './core.ts';
import { CoreError } from './core.ts';
import { dateLine, dayMonthSeconds, duration, isoLocal, isoUtc, nextCivilSecond, signedDuration, when, zoneName } from './earth.ts';
import { TimeError } from './errors.ts';
import { type Clock, clockLevels, inCatalogue, nowOf, type ParsedInstant, parseLevel, parseQuarter, toInstant } from './instant.ts';

const us = (t: bigint | null) => (t === null ? null : String(t));

/** The instant an op is asked about: `at` (any form toInstant reads), else now; refused outside the catalogue. */
export function resolveAt(core: Core, at: string | undefined, clock: Clock = {}, what = 'the instant'): bigint {
  const parsed: ParsedInstant = at === undefined ? { t: nowOf(core, clock), form: 'now' } : toInstant(core, at, clock);
  return inCatalogue(core, parsed, at === undefined ? 'now' : what);
}

/** "Helion" for a unit, the core's "between" for a level between units (design ruling 4), else the level's word. */
function kindWord(core: Core, level: number): string {
  const { frc } = core;
  const unit = frc.unitOfLevel(level);
  if (unit !== null) {
    return frc.formatUnitName(unit);
  }
  const kind = frc.levelKind(level);
  return kind === LevelKind.BETWEEN ? frc.formatLevelKind(kind) : frc.formatLevelWord(level);
}

/** The stamp and its nine terms at `t`. */
function stampOf(core: Core, t: bigint): { stamp: string; terms: string[] } {
  const { frc, cat } = core;
  const date = cat.dateAt(t);
  return {
    stamp: frc.formatDate(date, DateForm.LETTERS, Unit.BLINK),
    terms: Object.values(Unit).map((unit) => frc.formatDateTerm(date, unit)),
  };
}

/** "6ι 43λ": the span from t to `instant`, the core's wording ('' for null). */
function spanTo(core: Core, t: bigint, instant: bigint | null, parts = 0): string {
  return instant === null ? '' : core.frc.formatSpan(core.cat.spanBetween(t, instant), parts);
}

/** When the text of spanTo(t, instant) next changes, as the core computes it; null when it never will. */
function spanChange(core: Core, t: bigint, instant: bigint | null, parts = 0): bigint | null {
  const { cat } = core;
  if (instant === null || !cat.contains(instant)) {
    return null;
  }
  return t < instant ? cat.spanNextChange(t, instant, parts) : cat.spanNextChangeSince(instant, t, parts);
}

/** The earliest of instants (nulls skipped). */
function earliest(list: (bigint | null)[]): bigint | null {
  let best: bigint | null = null;
  for (const x of list) {
    if (x !== null && (best === null || x < best)) {
      best = x;
    }
  }
  return best;
}

/** A threshold ahead of `t`: its quarter word, instant and the span to it; null after the catalogue's last instant. */
export interface ThresholdView {
  quarter: string;
  at_us: string;
  span: string;
  earth?: { when: string; in: string };
}

function thresholdView(core: Core, t: bigint, th: { name: number; time: bigint | null }, earth: boolean): ThresholdView | null {
  if (th.time === null) {
    return null;
  }
  return {
    quarter: core.frc.formatQuarter(th.name),
    at_us: String(th.time),
    span: spanTo(core, t, th.time),
    ...(earth ? { earth: { when: when(core, th.time, t), in: duration(core, t, th.time) } } : {}),
  };
}

/** The Earth translation of an instant (only in Earth mode). */
export interface EarthInstant {
  iso: string;
  local: string;
  line: string;
  zone: string;
  utc_offset_s: number;
}

function earthInstant(core: Core, t: bigint): EarthInstant {
  return { iso: isoUtc(core, t), local: isoLocal(core, t), line: dateLine(core, t), zone: zoneName(core, t), utc_offset_s: core.frc.utcOffsetSeconds(t) || 0 };
}

// ---- NOW ----------------------------------------------------------------------------------------------------------

/** The level whose period the NOW screen counts down, with its child: the Helion (design ruling 9's default focus). */
const FOCUS = Unit.HELION;
/** How many ancestors the list of next thresholds shows (as the site's NOW). */
const UPCOMING_LEVELS = 4;

export interface NowReading {
  unix_us: string;
  stamp: string;
  terms: string[];
  /** The full date in words: "Alpha Hexafracton Valley, …, ε#5 34η 29ι 21λ 3ν". */
  words: string;
  /** The short date: "Delta Trifracton End ε#5 34η 29ι 21λ 3ν". */
  short: string;
  pentad: { name: string; numeral: string; index: number; helion: number; helions: number; detail: string };
  majors: { level: number; depth: number; symbol: string; name: string; quarter: string }[];
  countdowns: {
    level: number;
    depth: number;
    symbol: string;
    kind: string;
    place: string;
    local: number;
    siblings: number;
    /** The two-glyph odometer of the level (2 strokes each), glyph indices as the core gives them. */
    digits: number[];
    next: ThresholdView | null;
  }[];
  sun: {
    sync: number;
    number: string;
    quarter: string;
    drift: string;
    digits: number[];
    next: ThresholdView | null;
    earth?: { start: string; drift: string };
  } | null;
  upcoming: { level: number | null; symbol: string; sun: boolean; quarter: string; at_us: string; span: string; earth?: { when: string } }[];
  /** When anything this reading shows next changes (the core's instants): a watcher redraws then, never polls. */
  next_change_us: string | null;
  earth?: EarthInstant;
}

/** The NOW reading at `at` (default now). */
export function readNow(core: Core, input: { at?: string; earth?: boolean } = {}, clock: Clock = {}): NowReading {
  const { frc, cat } = core;
  const earth = Boolean(input.earth);
  const t = resolveAt(core, input.at, clock);
  const date = cat.dateAt(t);
  const { stamp, terms } = stampOf(core, t);
  const changes: (bigint | null)[] = [cat.cycleAt(t, frc.unitLevel(Unit.BLINK)!).end];
  if (earth) {
    changes.push(nextCivilSecond(core, t));
  }

  const majors = [0, 1, 2, 3].map((level) => {
    const cycle = cat.cycleAt(t, level);
    return { level, depth: level + 1, symbol: frc.formatLevelName(level), name: frc.formatCycleName(level, cycle.cycle), quarter: frc.formatQuarter(cycle.quarter) };
  });

  const focus = frc.unitLevel(FOCUS)!;
  const countdowns = [focus, focus + 1].map((level) => {
    const cycle = cat.cycleAt(t, level);
    const th = cat.nextThreshold(t, level);
    changes.push(th.time, spanChange(core, t, th.time));
    return {
      level,
      depth: level + 1,
      symbol: frc.formatLevelName(level),
      kind: kindWord(core, level),
      place: frc.formatCyclePlace(cycle),
      local: cycle.local,
      siblings: cycle.siblings,
      digits: [...cat.odometerAt(t, level, 2, 2).digits],
      next: thresholdView(core, t, th, earth),
    };
  });

  const p = cat.pentadAt(t);
  const pentad = {
    name: frc.formatPentad(p, PentadForm.FULL),
    numeral: frc.formatPentad(p, PentadForm.NUMERAL),
    index: p.index,
    helion: p.helion,
    helions: p.helions,
    detail: `${frc.formatUnitName(Unit.HELION)} ${p.helion} of ${p.helions}`,
  };

  // The Sun: the solar sync, absent in the catalogue's first and last partial sync (the core answers FRC_ERR_RANGE).
  let sun: NowReading['sun'] = null;
  const sync = syncOrNull(core, t);
  if (sync) {
    const odo = cat.syncOdometer(t, 2, 3);
    changes.push(sync.next.time, odo.nextChange, spanChange(core, t, sync.next.time));
    sun = {
      sync: sync.sync,
      number: frc.formatCountSigned(sync.sync),
      quarter: frc.formatQuarter(sync.quarter),
      drift: driftFlavons(core, sync),
      digits: [...odo.digits],
      next: thresholdView(core, t, sync.next, earth),
      ...(earth ? { earth: { start: dayMonthSeconds(core, sync.start!), drift: signedDuration(core, sync.driftUs) } } : {}),
    };
  }

  const upcoming: NowReading['upcoming'] = [];
  for (let level = focus - 1; level >= Math.max(0, focus - UPCOMING_LEVELS); level--) {
    const th = cat.nextThreshold(t, level);
    if (th.time === null) {
      continue; // the catalogue's closing instant: nothing comes later
    }
    changes.push(spanChange(core, t, th.time));
    upcoming.push({
      level,
      symbol: frc.formatLevelName(level),
      sun: false,
      quarter: frc.formatQuarter(th.name),
      at_us: String(th.time),
      span: spanTo(core, t, th.time),
      ...(earth ? { earth: { when: when(core, th.time, t) } } : {}),
    });
  }
  if (sun?.next) {
    upcoming.push({ level: null, symbol: '', sun: true, quarter: sun.next.quarter, at_us: sun.next.at_us, span: sun.next.span, ...(earth ? { earth: { when: when(core, BigInt(sun.next.at_us), t) } } : {}) });
  }
  upcoming.sort((a, b) => (BigInt(a.at_us) < BigInt(b.at_us) ? -1 : BigInt(a.at_us) > BigInt(b.at_us) ? 1 : 0));

  return {
    unix_us: String(t),
    stamp,
    terms,
    words: frc.formatDate(date, DateForm.FULL, Unit.BLINK),
    short: frc.formatDate(date, DateForm.SHORT, Unit.BLINK),
    pentad,
    majors,
    countdowns,
    sun,
    upcoming,
    next_change_us: us(earliest(changes.filter((c) => c === null || c > t))),
    ...(earth ? { earth: earthInstant(core, t) } : {}),
  };
}

function syncOrNull(core: Core, t: bigint) {
  try {
    return core.cat.syncAt(t);
  } catch (e) {
    if (e instanceof CoreError && (e as { status?: string }).status === 'FRC_ERR_RANGE') {
      return null;
    }
    throw e;
  }
}

/** "−6 235λ": a sync's drift (nominal start to start) in Flavons, cut as the core cuts it; '' when the nominal start is outside the catalogue. */
function driftFlavons(core: Core, sync: { nominal: bigint | null; start: bigint | null }): string {
  const { frc, cat } = core;
  if (sync.nominal === null || sync.start === null || !cat.contains(sync.nominal) || !cat.contains(sync.start)) {
    return '';
  }
  return frc.formatSpanInUnit(cat.spanBetween(sync.nominal, sync.start), Unit.FLAVON);
}

// ---- LADDER -------------------------------------------------------------------------------------------------------

export interface Rung {
  level: number;
  depth: number;
  symbol: string;
  /** The level's word ("Eta"). */
  word: string;
  /** The unit's name ("Helion"), the core's "between", or the level's word. */
  kind: string;
  /** The core's kind word: major, unit, between, sub-Blink. */
  kind_word: string;
  /** The running cycle's place in its parent ("1 of 11"); for a major also its name ("Alpha Hexafracton"). */
  place: string;
  name: string | null;
  local: number;
  siblings: number;
  /** Global index of the running cycle (decimal: it passes 2^53 below the Blink). */
  cycle: string;
  /** The quarter the instant is in: the core's statement of the phase. */
  quarter: string;
  /** The exact phase, 0.32 fixed point (frc_frac_t), for a program; never shown as a percentage. */
  phase: number;
  start_us: string | null;
  end_us: string | null;
  next: ThresholdView | null;
}

export interface LadderReading {
  unix_us: string;
  stamp: string;
  rungs: Rung[];
  next_change_us: string | null;
  earth?: EarthInstant;
}

/** The ladder at `at` (default now), from α down to `to` (default ν, the Blink; at most the core's CLOCK_MAX_LEVEL). */
export function readLadder(core: Core, input: { at?: string; to?: string | number; earth?: boolean } = {}, clock: Clock = {}): LadderReading {
  const { frc, cat } = core;
  const earth = Boolean(input.earth);
  const t = resolveAt(core, input.at, clock);
  const to = input.to === undefined ? frc.unitLevel(Unit.BLINK)! : parseLevel(core, input.to);
  const changes: (bigint | null)[] = [];
  const rungs: Rung[] = [];
  for (let level = 0; level <= Math.min(to, clockLevels(core)); level++) {
    const cycle = cat.cycleAt(t, level);
    const th = cat.nextThreshold(t, level);
    changes.push(spanChange(core, t, th.time));
    rungs.push({
      level,
      depth: level + 1,
      symbol: frc.formatLevelName(level),
      word: frc.formatLevelWord(level),
      kind: kindWord(core, level),
      kind_word: frc.formatLevelKind(frc.levelKind(level)),
      place: frc.formatCyclePlace(cycle),
      name: frc.levelKind(level) === LevelKind.MAJOR ? frc.formatCycleName(level, cycle.cycle) : null,
      local: cycle.local,
      siblings: cycle.siblings,
      cycle: String(cycle.cycle),
      quarter: frc.formatQuarter(cycle.quarter),
      phase: cycle.phase,
      start_us: us(cycle.start),
      end_us: us(cycle.end),
      next: thresholdView(core, t, th, earth),
    });
  }
  return {
    unix_us: String(t),
    stamp: stampOf(core, t).stamp,
    rungs,
    next_change_us: us(earliest(changes)),
    ...(earth ? { earth: earthInstant(core, t) } : {}),
  };
}

// ---- NEXT ---------------------------------------------------------------------------------------------------------

/** At most this many thresholds per call. */
export const NEXT_MAX = 100;

export interface NextReading {
  unix_us: string;
  stamp: string;
  level: number;
  depth: number;
  symbol: string;
  kind: string;
  /** The quarter asked for (the core's word), or null for every one. */
  quarter: string | null;
  thresholds: { quarter: string; cycle: string; place: string; name: string | null; at_us: string; stamp: string; span: string; earth?: { when: string; in: string; iso: string } }[];
  /** true when the catalogue ends before `count` thresholds. */
  ends: boolean;
}

/** The next `count` thresholds of `level` after `at` (default now), only those that end `quarter` when given. */
export function readNext(core: Core, input: { level: string | number; quarter?: string; count?: number; at?: string; earth?: boolean }, clock: Clock = {}): NextReading {
  const { frc, cat } = core;
  const earth = Boolean(input.earth);
  const t0 = resolveAt(core, input.at, clock);
  const level = parseLevel(core, input.level);
  const quarter = input.quarter === undefined ? null : parseQuarter(core, input.quarter);
  const count = input.count ?? 5;
  if (!Number.isInteger(count) || count < 1 || count > NEXT_MAX) {
    throw new TimeError('range', `count ${count}: give 1 to ${NEXT_MAX}`);
  }
  const thresholds: NextReading['thresholds'] = [];
  let t = t0;
  let ends = false;
  // Each threshold is the end of a quarter of the cycle running just before it; a quarter filter skips three in four.
  for (let step = 0; thresholds.length < count; step++) {
    if (step > 4 * count + 4) {
      throw new TimeError('range', 'no such threshold'); // cannot happen: every cycle has the four quarters
    }
    const th = cat.nextThreshold(t, level);
    if (th.time === null) {
      ends = true;
      break;
    }
    const cycle = cat.cycleAt(t, level);
    if (quarter === null || th.name === quarter) {
      thresholds.push({
        quarter: frc.formatQuarter(th.name),
        cycle: String(cycle.cycle),
        place: frc.formatCyclePlace(cycle),
        name: frc.levelKind(level) === LevelKind.MAJOR ? frc.formatCycleName(level, cycle.cycle) : null,
        at_us: String(th.time),
        stamp: stampOf(core, th.time).stamp,
        span: spanTo(core, t0, th.time),
        ...(earth ? { earth: { when: when(core, th.time, t0), in: duration(core, t0, th.time), iso: isoLocal(core, th.time) } } : {}),
      });
    }
    t = th.time;
  }
  return {
    unix_us: String(t0),
    stamp: stampOf(core, t0).stamp,
    level,
    depth: level + 1,
    symbol: frc.formatLevelName(level),
    kind: kindWord(core, level),
    quarter: quarter === null ? null : frc.formatQuarter(quarter),
    thresholds,
    ends,
  };
}

// ---- SPAN ---------------------------------------------------------------------------------------------------------

export interface SpanReading {
  from_us: string;
  to_us: string;
  from_stamp: string;
  to_stamp: string;
  /** "6ι 43λ" (unsigned), at most `parts` parts (the core's default precision when 0). */
  span: string;
  /** "+6ι 43λ", "−6ι 43λ": the direction said, as the core signs it. */
  signed: string;
  negative: boolean;
  /** Every non-zero part, coarsest first: the unit's symbol and count (decimal). */
  parts: { symbol: string; count: string }[];
  earth?: { duration: string; from: string; to: string };
}

/** The span from `from` to `to`, both in the catalogue. */
export function readSpan(core: Core, input: { from: string; to: string; parts?: number; earth?: boolean }, clock: Clock = {}): SpanReading {
  const { frc, cat } = core;
  const a = inCatalogue(core, toInstant(core, input.from, clock), input.from);
  const b = inCatalogue(core, toInstant(core, input.to, clock), input.to);
  const parts = input.parts ?? 0;
  if (!Number.isInteger(parts) || parts < 0 || parts > 9) {
    throw new TimeError('range', `parts ${parts}: give 0 (the core's default) to 9`);
  }
  const span = cat.spanBetween(a, b);
  return {
    from_us: String(a),
    to_us: String(b),
    from_stamp: stampOf(core, a).stamp,
    to_stamp: stampOf(core, b).stamp,
    span: frc.formatSpan(span, parts),
    signed: frc.formatSpanSigned(span, parts),
    negative: span.negative,
    parts: frc.spanParts(span, 9).map((p) => ({ symbol: frc.formatUnitSymbol(p.unit), count: String(p.count) })),
    ...(input.earth ? { earth: { duration: signedDuration(core, b - a), from: isoLocal(core, a), to: isoLocal(core, b) } } : {}),
  };
}

// ---- SYNC ---------------------------------------------------------------------------------------------------------

export interface SyncReading {
  unix_us: string;
  stamp: string;
  /** The sync's number: 0 at the anchor, negative before it. */
  sync: number;
  number: string;
  quarter: string;
  /** The running Helion's place in the sync, 0..18, as the core counts it. */
  helion: number;
  pentad: { name: string; short: string; index: number; helion: number; helions: number; detail: string };
  drift: string;
  digits: number[];
  start_us: string | null;
  end_us: string | null;
  next: ThresholdView | null;
  earth?: { start: string; end: string; nominal: string; drift: string; now: EarthInstant };
}

/** The solar sync and Pentad at `at` (default now). The catalogue's first and last syncs are partial: no reading. */
export function readSync(core: Core, input: { at?: string; earth?: boolean } = {}, clock: Clock = {}): SyncReading {
  const { frc, cat } = core;
  const earth = Boolean(input.earth);
  const t = resolveAt(core, input.at, clock);
  const sync = syncOrNull(core, t);
  if (!sync) {
    throw new TimeError('out_of_catalogue', 'no solar sync here: the catalogue\'s first and last syncs are partial');
  }
  const p = cat.pentadAt(t);
  return {
    unix_us: String(t),
    stamp: stampOf(core, t).stamp,
    sync: sync.sync,
    number: frc.formatCountSigned(sync.sync),
    quarter: frc.formatQuarter(sync.quarter),
    helion: sync.helion,
    pentad: {
      name: frc.formatPentad(p, PentadForm.FULL),
      short: frc.formatPentad(p, PentadForm.SHORT, true),
      index: p.index,
      helion: p.helion,
      helions: p.helions,
      detail: `${frc.formatUnitName(Unit.HELION)} ${p.helion} of ${p.helions}`,
    },
    drift: driftFlavons(core, sync),
    digits: [...cat.syncOdometer(t, 2, 3).digits],
    start_us: us(sync.start),
    end_us: us(sync.end),
    next: thresholdView(core, t, sync.next, earth),
    ...(earth
      ? {
          earth: {
            start: dayMonthSeconds(core, sync.start!),
            end: dayMonthSeconds(core, sync.end!),
            nominal: dayMonthSeconds(core, sync.nominal!),
            drift: signedDuration(core, sync.driftUs),
            now: earthInstant(core, t),
          },
        }
      : {}),
  };
}

// ---- CONVERT ------------------------------------------------------------------------------------------------------

export interface Conversion {
  /** How the input was written: now, unix, stamp or civil. */
  form: string;
  unix_us: string;
  /** The instant in UTC, ISO 8601 (the core's form). A conversion is between the two times, so both are always given. */
  iso: string;
  local: string;
  stamp: string;
  terms: string[];
  words: string;
  /** For a stamp: the finest unit it named (its first microsecond is the instant). */
  finest: { symbol: string; name: string } | null;
}

/** An instant in every form: from a stamp to Unix µs and ISO, or from ISO, Unix or now to the stamp. */
export function convert(core: Core, input: { at: string; context?: string }, clock: Clock = {}): Conversion {
  const { frc, cat } = core;
  const context = input.context === undefined ? undefined : inCatalogue(core, toInstant(core, input.context, clock), input.context);
  const parsed = toInstant(core, input.at, { ...clock, ...(context === undefined ? {} : { context }) });
  const t = inCatalogue(core, parsed, input.at);
  const { stamp, terms } = stampOf(core, t);
  return {
    form: parsed.form,
    unix_us: String(t),
    iso: isoUtc(core, t),
    local: isoLocal(core, t),
    stamp,
    terms,
    words: frc.formatDate(cat.dateAt(t), DateForm.FULL, Unit.BLINK),
    finest: parsed.finest === undefined ? null : { symbol: frc.formatUnitSymbol(parsed.finest), name: frc.formatUnitName(parsed.finest) },
  };
}

/** Whether `e` is a refusal of the core (a FractonicaError of the binding). */
export function isCoreError(e: unknown): boolean {
  return e instanceof CoreError;
}

