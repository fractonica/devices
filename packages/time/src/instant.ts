// Reading what a person or an agent types: an instant, a level, a quarter. Parsing only: every instant comes from the
// core (fromUnixSeconds, fromUnixMs, parseDate + dateToTime, parseCivil + timeFromCivil), every level and quarter name
// is matched against the core's own words.
//
// An instant is one of:
//   now                         the clock of the machine (the core's frc.now, or the caller's clock)
//   1791460800  1791460800.25   Unix SECONDS: a bare number is always seconds, never guessed from its length
//   1791460800000ms             Unix milliseconds: the suffix ms
//   1791460800000000us          Unix microseconds: the suffix us (or µs)
//   @1791460800                 seconds, as date(1) writes them
//   α#6 β#4 γ#9 δ#3 ε#5 34η 29ι 21λ 3ν
//                               a Fractonica stamp (ASCII letters too: a#6 b#4 …); a partial one (ε#5 34η) is read
//                               in the date of a context instant, `now` unless given; it names the first microsecond
//                               of its finest unit
//   2026-10-08T12:00:00Z        a civil date and time (everything the core's frc_parse_civil reads); without an
//   2026-10-08 12:00            offset it is read in the local time zone of the machine

import type { Core } from './core.ts';
import { CoreError } from './core.ts';
import { TimeError } from './errors.ts';

/** How an instant was written. */
export type InstantForm = 'now' | 'unix' | 'stamp' | 'civil';

export interface ParsedInstant {
  /** Unix microseconds. */
  t: bigint;
  form: InstantForm;
  /** For a stamp: the finest unit it names (the core's frc_unit_t), and the unit's level. */
  finest?: number;
  /** For bare Unix seconds: true when the number had no unit suffix. */
  bareSeconds?: boolean;
}

/** Options of every reader: the instant `now` means (tests pass a fixed one). */
export interface Clock {
  now?: () => bigint;
}

/** The accepted forms, for an error message. */
export const INSTANT_FORMS = 'now, Unix seconds (1791460800; 1791460800000ms, 1791460800000000us), a stamp (α#6 β#4 γ#9 δ#3 ε#5 34η 29ι 21λ 3ν) or an ISO date (2026-10-08T12:00:00Z)';

const UNIX = /^@?([+-]?)(\d+)(?:\.(\d+))?\s*(s|ms|us|µs)?$/i;

export function nowOf(core: Core, clock: Clock = {}): bigint {
  return clock.now ? clock.now() : core.frc.now();
}

function isCoreError(e: unknown, status?: string): e is InstanceType<typeof CoreError> {
  return e instanceof CoreError && (status === undefined || (e as { status?: string }).status === status);
}

/** Unix seconds, milliseconds or microseconds (UNIX matched). */
function unixInstant(core: Core, m: RegExpMatchArray, text: string): ParsedInstant {
  const [, sign, whole, fraction = '', suffix = 's'] = m;
  const unit = suffix.toLowerCase() === 'µs' ? 'us' : suffix.toLowerCase();
  // The fraction that fits the microsecond: 6 digits of a second, 3 of a millisecond, none of a microsecond.
  const room = unit === 's' ? 6 : unit === 'ms' ? 3 : 0;
  if (fraction.length > room) {
    throw new TimeError('parse', `${text}: finer than a microsecond`);
  }
  const negative = sign === '-';
  const n = BigInt(whole);
  let t: bigint | null;
  if (unit === 's') {
    t = core.frc.fromUnixSeconds(negative ? -n : n);
  } else if (unit === 'ms') {
    t = core.frc.fromUnixMs(negative ? -n : n);
  } else {
    t = negative ? -n : n;
  }
  if (t === null) {
    throw new TimeError('range', `${text}: too large for an instant`);
  }
  if (fraction) {
    const micro = BigInt(fraction.padEnd(room, '0'));
    t += negative ? -micro : micro;
  }
  return { t, form: 'unix', ...(m[4] === undefined ? { bareSeconds: true } : {}) };
}

/**
 * The instant `text` names (see the head of this file). `context` is the instant a partial stamp is read in (default
 * now). Throws TimeError('parse') for text that is none of the forms.
 */
export function toInstant(core: Core, text: string, opts: Clock & { context?: bigint } = {}): ParsedInstant {
  const s = text.trim();
  if (s === '') {
    throw new TimeError('parse', `an empty instant; give ${INSTANT_FORMS}`);
  }
  if (s.toLowerCase() === 'now') {
    return { t: nowOf(core, opts), form: 'now' };
  }
  const unix = s.match(UNIX);
  if (unix) {
    return unixInstant(core, unix, s);
  }
  const { frc, cat } = core;
  // A stamp: the core's parser, with the date of the context instant for a partial one.
  try {
    let parsed: ReturnType<typeof frc.parseDate>;
    try {
      parsed = frc.parseDate(s);
    } catch (e) {
      if (!isCoreError(e, 'FRC_ERR_PARSE')) {
        throw e;
      }
      const context = opts.context ?? nowOf(core, opts);
      if (!cat.contains(context)) {
        throw e;
      }
      parsed = frc.parseDate(s, cat.dateAt(context));
    }
    const t = cat.dateToTime(parsed.date);
    if (t === null) {
      throw new TimeError('range', `${s} names no Blink of the catalogue`);
    }
    return { t, form: 'stamp', finest: parsed.finest };
  } catch (e) {
    if (e instanceof TimeError) {
      throw e;
    }
    if (isCoreError(e, 'FRC_ERR_RANGE')) {
      throw new TimeError('range', `${s} names no date of the catalogue (${outOfCatalogueText(core)})`);
    }
    if (!isCoreError(e)) {
      throw e;
    }
    // not a stamp: a civil date, perhaps
  }
  // A civil date and time: the core reads it; with no offset in the text, the local zone's (as the site reads one).
  try {
    const parsed = frc.parseCivil(s);
    if (parsed.offset !== null) {
      const t = frc.timeFromCivil(parsed.civil, parsed.offset);
      if (t === null) {
        throw new TimeError('range', `${s}: too large for an instant`);
      }
      return { t, form: 'civil' };
    }
    const guess = frc.timeFromCivil(parsed.civil, 0);
    if (guess === null) {
      throw new TimeError('range', `${s}: too large for an instant`);
    }
    // The zone's offset at that moment, asked twice: the offset on that day may differ from the one at the guess.
    const offset = frc.utcOffsetSeconds(guess);
    const first = frc.timeFromCivil(parsed.civil, offset);
    const again = first === null ? offset : frc.utcOffsetSeconds(first);
    const t = again === offset ? first : frc.timeFromCivil(parsed.civil, again);
    if (t === null) {
      throw new TimeError('range', `${s}: too large for an instant`);
    }
    return { t, form: 'civil' };
  } catch (e) {
    if (e instanceof TimeError) {
      throw e;
    }
    if (!isCoreError(e)) {
      throw e;
    }
    if (isCoreError(e, 'FRC_ERR_RANGE')) {
      throw new TimeError('range', `${s}: no such day or time in the calendar`);
    }
  }
  throw new TimeError('parse', `cannot read ${JSON.stringify(s)} as an instant; give ${INSTANT_FORMS}`);
}

/** "OUT OF CATALOGUE · α#1 – α#18": the words shown instead of a reading (design ruling 7), the names the core's. */
export function outOfCatalogueText(core: Core): string {
  const { frc, cat } = core;
  return `OUT OF CATALOGUE · ${frc.formatCycleName(0, 0, true)} – ${frc.formatCycleName(0, cat.cycleCount(0) - 1n, true)}`;
}

/**
 * `t`, when the catalogue holds it; else TimeError('out_of_catalogue'), never a reading extrapolated past the
 * eclipses. `what` names the argument in the message.
 */
export function inCatalogue(core: Core, parsed: ParsedInstant, what = 'the instant'): bigint {
  const { frc, cat } = core;
  if (cat.contains(parsed.t)) {
    return parsed.t;
  }
  const iso = (t: bigint) => frc.formatCivil(frc.civilFromTime(t, 0), 0);
  let shown: string;
  try {
    shown = iso(parsed.t);
  } catch {
    shown = `${parsed.t} µs`;
  }
  const hint = parsed.bareSeconds ? '; a bare number is Unix seconds: write 1791460800000ms for milliseconds or 1791460800000000us for microseconds' : '';
  throw new TimeError('out_of_catalogue', `${what} (${shown}) is outside the catalogue: ${outOfCatalogueText(core)}, ${iso(cat.first)} to ${iso(cat.last)}${hint}`, {
    first_us: String(cat.first),
    last_us: String(cat.last),
  });
}

/** The levels the clock reads at an instant: 0 (α) to the core's CLOCK_MAX_LEVEL (21, χ). */
export function clockLevels(core: Core): number {
  return core.frc.constants.CLOCK_MAX_LEVEL;
}

/**
 * A level as a person names it: its symbol (η), its ASCII letter (h), its word (Eta), its unit's name (Helion,
 * Helions), or its depth, the user-facing number of fractonica.h (7 = η, level 6). Case does not matter. Returns the
 * zero-based level, 0..CLOCK_MAX_LEVEL.
 */
export function parseLevel(core: Core, text: string | number): number {
  const { frc } = core;
  const max = clockLevels(core);
  const s = String(text).trim();
  if (/^\d+$/.test(s)) {
    const depth = Number(s);
    if (depth < 1 || depth > max + 1) {
      throw new TimeError('range', `depth ${s}: the clock reads depths 1 (${frc.formatLevelName(0)}) to ${max + 1} (${frc.formatLevelName(max)})`);
    }
    return depth - 1;
  }
  const want = s.toLowerCase();
  for (let level = 0; level <= max; level++) {
    const names = [frc.formatLevelName(level), frc.toAscii(frc.formatLevelName(level)), frc.formatLevelWord(level)];
    const unit = frc.unitOfLevel(level);
    if (unit !== null) {
      names.push(frc.formatUnitName(unit), frc.formatUnitName(unit, true));
    }
    if (names.some((n) => n.toLowerCase() === want)) {
      return level;
    }
  }
  throw new TimeError('parse', `no level ${JSON.stringify(s)}: give a symbol (η), a word (Eta, Helion) or a depth (7)`);
}

/** A quarter by the core's word (peak, node, valley, end), any case: the core's frc_quarter_t. */
export function parseQuarter(core: Core, text: string): number {
  const want = text.trim().toLowerCase();
  for (let q = 0; q < 4; q++) {
    if (core.frc.formatQuarter(q, true) === want) {
      return q;
    }
  }
  throw new TimeError('parse', `no quarter ${JSON.stringify(text)}: give ${[0, 1, 2, 3].map((q) => core.frc.formatQuarter(q, true)).join(', ')}`);
}
