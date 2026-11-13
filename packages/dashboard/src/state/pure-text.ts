// Pure mode and the texts the dashboard does not write itself (design README ruling 11 and "Hub"): pure mode shows only
// Fractonica units, so a text of the hub's (a check's detail, a job's message, a warning, a device's error) or of the
// catalog (a capability's summary) that states an Earth measure is changed or held back. One rule for every page, built
// on one list of Earth units (EARTH_UNITS) so the three functions below always agree:
//
// - a text of the hub's in pure mode is said with `pureText`: its civil durations become Fractonica spans ("p99 7.47 ms"
//   → "p99 0.024ν", when the core is loaded), and a clause still stating an Earth measure (volts, bytes, dBm, hertz,
//   per cent, a clock time or a date) is left out ("retried after 5, 15 and 45 s" with no core → "retried"). Whatever
//   it returns passes `pureSafe`.
// - the same text in Earth mode is said with `earthText`: a Fractonica span never gives way to an Earth value, so each
//   duration is its span followed by ⊕ and the civil duration ("p99 0.024ν ⊕ 7.47 ms"), and another Earth measure is
//   led by ⊕ ("supply ⊕ 3.3 V").
// - catalog prose (written for engineers, often naming units without numbers: "volume in %", "for ms") is shown in
//   pure mode only when `pureSafe` says it names no Earth unit at all; Earth mode shows it always.
// - a text someone wires or buys from (a Bench guide's step, a safety line, a part's name or value) in pure mode is
//   said with `heldText`: each Earth measure is replaced by ⊕, the mark that says "a value shown in Earth mode", so a
//   sentence keeps its shape and a safety limit is never silently gone ("below 2.5 V it is damaged" → "below ⊕ it is
//   damaged"). Dropping the clause would change what the sentence tells a person to do.
//
// Identifiers are never read as measures: a run of hex pairs joined by colons (a MAC, a USB serial "02:F2:00:00:00:02")
// is kept as written by all of these, and pureSafe does not count it.
//
// Pages reach these through `useHubText()` (ui/kit.tsx), which binds the core and the mode.

/** Earth unit symbols after a number, case as written (longest first where one is a prefix of another). */
const EARTH_UNITS = [
  'ms', 'µs', 'us', 'ns', 'sec', 'secs', 's', 'mins', 'min', 'hrs', 'hr', 'h', 'd',
  'GHz', 'MHz', 'kHz', 'Hz', 'hz',
  'mAh', 'mA', 'µA', 'uA', 'A', 'mV', 'kV', 'V', 'mW', 'kW', 'W', 'Wh',
  'pF', 'nF', 'µF', 'uF', 'mF', 'F', 'MΩ', 'kΩ', 'Ω', 'ohms?',
  'mg', 'kg', 'nm', 'µm', 'mm', 'cm', 'km', 'm',
  'KiB', 'MiB', 'GiB', 'KB', 'kB', 'MB', 'GB', 'TB', 'B',
  'dBFS', 'dBm', 'dBi', 'dB', '°C', '°F', '°', '%', 'ppm', 'ppb', '″', '"', 'inches', 'inch', 'lux', 'lx', 'rpm', 'bps', 'kbps', 'Mbps', 'baud',
];

/** Earth units as words after a number (any case). */
const EARTH_WORDS = String.raw`(?:milli|micro|nano)?seconds?|minutes?|hours?|days?|weeks?|years?|months?|hertz|volts?|millivolts?|amps?|amperes?|milliamps?|watts?|farads?|ohms?|grams?|kilograms?|milligrams?|metres?|meters?|millimetres?|millimeters?|centimetres?|centimeters?|percent|per cent|celsius|fahrenheit|degrees?|decibels?|kilobytes?|megabytes?|gigabytes?`;
/** Earth unit words that say one even with no number ("in milliseconds", "volume in percent"); not "second" (an ordinal). */
const EARTH_WORDS_BARE = String.raw`(?:milli|micro|nano)seconds?|seconds|minutes|hours|hertz|volts|millivolts|amps|amperes|milliamps|watts|ohms|grams|kilograms|milligrams|metres|meters|millimetres|millimeters|percent|per cent|celsius|fahrenheit|decibels|kilobytes|megabytes|gigabytes`;

const esc = (u: string) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const UNIT_ALT = EARTH_UNITS.map((u) => (u.endsWith('s?') ? u : esc(u))).join('|');
/** A number as written in running text (a sign, grouping, decimals, a range or list of them). Not a part of a name. */
const NUM_CORE = String.raw`[-−+]?(?:\d+(?:[.,]\d+)*[¼½¾]?|[¼½¾])`;
const NOT_IN_NAME = String.raw`(?<![\p{L}\p{N}_.\-#:])`;
const NUM = NOT_IN_NAME + NUM_CORE;
const LIST_SEP = String.raw`\s*(?:–|-|to|and|or|×|x|\/)\s*`;
/** "5, 15 and 45": a comma list must end with a joining word, so "channel 6, 2.4 GHz" is two things, not one list. */
const NUM_LIST = String.raw`${NOT_IN_NAME}(?:(?:${NUM_CORE}\s*,\s*)+${NUM_CORE}${LIST_SEP}${NUM_CORE}|${NUM_CORE}(?:${LIST_SEP}${NUM_CORE})*)`;
/**
 * A measure: number(s) then a unit symbol not followed by more of a word ("5g band" is a band's name, not grams). Four
 * digits or more run into one capital letter is a part's name, not a measure ("8205A", "2222A").
 */
const MEASURE = String.raw`(?!\d{4,}[AVWFB](?![\p{L}\p{N}_]))${NUM_LIST}\s?(?:${UNIT_ALT})(?![\p{L}\p{N}_])`;
const WORD_MEASURE = String.raw`${NUM_LIST}\s?(?:${EARTH_WORDS})\b`;
/** Grams, but never a band's name ("5g", "2g"). */
const GRAMS = String.raw`${NOT_IN_NAME}(?![25]g(?![\p{L}\p{N}_]))${NUM_CORE}\s?g(?![\p{L}\p{N}_-])`;
/** A rate per Earth time: "80 conversions/s", "10 samples/min". */
const RATE = String.raw`${NUM_LIST}\s?[\p{L}-]*\/(?:s|sec|min|h|hr|hour|day)(?![\p{L}\p{N}_])`;
/** An Earth duration said without a number: "for a minute", "within a few seconds". */
const VAGUE = String.raw`\b(?:a|an|one)\s+(?:minute|hour|day|week)\b|\ba\s+few\s+(?:seconds|minutes|hours|days)\b`;
const CLOCK = String.raw`\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\b`;
const DATE = String.raw`\b(?:19|20)\d{2}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?`;
const ZONE = String.raw`\b(?:UTC|GMT|CET|CEST|EST|EDT|PST|PDT)\b`;
const BARE = String.raw`[%°]|\b(?:${EARTH_WORDS_BARE})\b|_(?:ms|us|s|hz|mv|ma|mg|mb|c10)\b|\bfreq_hz\b|(?<=\p{L})\/(?:s|sec|min|h)(?![\p{L}\p{N}_])`;

/** Every Earth measure, clock time, date, zone, per cent or unit word in running text. */
const MEASURES = [RATE, MEASURE, GRAMS, WORD_MEASURE, VAGUE, CLOCK, DATE];
const EARTH_ANY = new RegExp([...MEASURES, ZONE, BARE].join('|'), 'u');
const EARTH_ANY_G = new RegExp([...MEASURES, ZONE, BARE].join('|'), 'gu');
/** An Earth measure with its number (what a clause states). */
const EARTH_MEASURE = new RegExp(MEASURES.join('|'), 'u');
const EARTH_MEASURE_G = new RegExp(MEASURES.join('|'), 'gu');

/**
 * An identifier written as hex pairs joined by colons: a MAC ("02:6F:28:AB:CD:EF"), a USB serial. Four pairs or more,
 * or any hex letter, so a clock time ("14:05:33") is still a clock time.
 */
const ID_RUN = /(?<![\p{L}\p{N}_:])[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){2,}(?![\p{L}\p{N}_:])/gu;
const isId = (m: string) => m.split(':').length >= 4 || /[A-Fa-f]/.test(m);
/** Each identifier stands in as one private-use character while a text is changed, and is put back after. */
const ID_MARK = /[\uE000-\uE0FF]/g;

function keepIds(text: string, change: (t: string) => string): string {
  const kept: string[] = [];
  const t = text.replace(ID_RUN, (m) => {
    if (!isId(m) || kept.length > 0xff) {
      return m;
    }
    kept.push(m);
    return String.fromCharCode(0xe000 + kept.length - 1);
  });
  return kept.length ? change(t).replace(ID_MARK, (c) => kept[c.charCodeAt(0) - 0xe000] ?? '') : change(t);
}

/** Whether a text names no Earth unit, clock time, date, zone or per cent, so pure mode may show it as it is. */
export function pureSafe(text: string): boolean {
  return !EARTH_ANY.test(text.replace(ID_RUN, (m) => (isId(m) ? ' ' : m)));
}

const DURATION_US: Record<string, number> = {
  ns: 0.001, 'µs': 1, us: 1, ms: 1000, s: 1e6, sec: 1e6, secs: 1e6, min: 6e7, mins: 6e7, h: 3.6e9, hr: 3.6e9, hrs: 3.6e9, d: 8.64e10,
  nanosecond: 0.001, microsecond: 1, millisecond: 1000, second: 1e6, minute: 6e7, hour: 3.6e9, day: 8.64e10, week: 6.048e11,
};
/** "for a minute", "one hour": a duration of one unit said in words. */
const ONE_UNIT = /\b(?:a|an|one)\s+(minute|hour|day|week)\b/gu;
/** "within a few seconds": no number to say as a span, so pure mode says it without the unit. */
const A_FEW = /\ba\s+few\s+(seconds|minutes|hours|days)\b/gu;
const DURATION = new RegExp(
  String.raw`(${NUM_LIST})\s?(ns|µs|us|ms|secs|sec|s|mins|min|hrs|hr|h|d|(?:nano|micro|milli)?seconds?|minutes?|hours?|days?)(?![\p{L}\p{N}_])`,
  'gu',
);
const ONE_NUM = /\d+(?:[.,]\d+)*[¼½¾]?|[¼½¾]/gu;

function durationUs(n: string, unit: string): number {
  const key = unit.toLowerCase().replace(/s$/, '');
  const per = DURATION_US[unit] ?? DURATION_US[key] ?? DURATION_US[`${key}s`] ?? 1e6;
  const frac: Record<string, number> = { '¼': 0.25, '½': 0.5, '¾': 0.75 };
  const tail = frac[n.slice(-1)] ?? 0;
  const head = tail ? n.slice(0, -1) : n;
  return ((head ? Number(head.replace(/,/g, '')) : 0) + tail) * per;
}

/**
 * A text the hub wrote with its civil durations said as Fractonica spans: "p99 7.47 ms over the last 30 s" →
 * "p99 0.024ν over the last 3λ 27ν"; a list ("after 5, 15 and 45 s") has each of its numbers said. With `earth`, each
 * span is followed by ⊕ and the duration as written. Other words are left as they are.
 */
export function pureDurations(text: string, spanOf: (us: bigint) => string, earth = false): string {
  return text
    .replace(DURATION, (whole: string, list: string, unit: string) => {
      const spans = list.replace(ONE_NUM, (n) => {
        const us = durationUs(n, unit);
        const sign = us < 0 ? '−' : '';
        return `${sign}${spanOf(BigInt(Math.round(Math.abs(us))))}`;
      });
      return earth ? `${spans} ⊕ ${whole}` : spans;
    })
    .replace(ONE_UNIT, (whole: string, unit: string) => {
      const span = spanOf(BigInt(DURATION_US[unit]!));
      return earth ? `${span} ⊕ ${whole}` : span;
    });
}

/** "a few seconds" → "a few moments", "a few minutes" → "a short while": a vague Earth duration said without its unit. */
function vague(text: string): string {
  return text.replace(A_FEW, (_m, unit: string) => (unit === 'seconds' ? 'a few moments' : unit === 'minutes' ? 'a short while' : 'a long while'));
}

/** The band a frequency names, in the hub's words ("5 GHz only" → "5g only", "a 2.4 GHz radio" → "a 2g radio"). */
function bands(text: string): string {
  return text.replace(/(\d+(?:\.\d+)?)\s?GHz/g, (_m, n: string) => (n.startsWith('5') ? '5g' : '2g')).replace(/\s*\(band [25]g\)/g, '');
}

const PREPOSITION = new RegExp(
  String.raw`\s*\b(?:within|after|in|for|every|of|at|by|to|from|over|under|below|above|than|until|till|since|about|around|near|ca\.?)\s+(?:about\s+|around\s+)?(?:${MEASURES.join('|')})`,
  'gu',
);

/**
 * A text of the hub's with its clauses that state an Earth measure (seconds, volts, bytes, dBm, per cent, a clock time
 * or a date) left out: "attic-pad is unknown: the OFFER is retried after 5, 15 and 45 s" becomes "attic-pad is
 * unknown: the OFFER is retried". A band said in hertz becomes the hub's band name ("5 GHz only" → "5g only").
 * What it returns passes pureSafe.
 */
export function earthless(text: string): string {
  let t = bands(text);
  if (pureSafe(t)) {
    return t;
  }
  // a parenthesis that states a measure, then "after 5 s", "below 20 %", "until 2026-…"
  t = t.replace(/\s*\([^)]*\)/g, (m) => (EARTH_ANY.test(m) ? '' : m)).replace(PREPOSITION, '');
  if (!pureSafe(t)) {
    // the clauses that still state one are left out; the others stay
    const parts = t.split(/(?<=[:;,])\s+|\s+(?=—|–\s)/);
    const kept = parts.filter((p) => !EARTH_MEASURE.test(p));
    t = kept.length ? kept.join(' ') : t;
  }
  // what is left: the measures and bare unit words themselves, until none remain
  for (let i = 0; i < 8 && !pureSafe(t); i++) {
    t = t.replace(EARTH_MEASURE_G, '').replace(EARTH_ANY_G, '').replace(/\s{2,}/g, ' ');
  }
  // a measure that only appears once its neighbours are gone: its numbers go too (never an Earth text in pure mode)
  if (!pureSafe(t)) {
    t = t.replace(EARTH_ANY_G, '').replace(/[-−+]?\d[\d.,]*/g, '');
  }
  const out = t
    .replace(/\b(?:about|around|roughly|approximately|ca\.)(?=\s*(?:[,.;:)]|$))/g, '')
    .replace(/\s+([,.;:)])/g, '$1')
    .replace(/([,;])(?:\s*[,;])+/g, '$1')
    .replace(/[:;,]+\./g, '.')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s:;,(—–-]+$/, '')
    .replace(/^[\s,;:·—–-]+/, '')
    .trim();
  return pureSafe(out) ? out : out.replace(EARTH_ANY_G, '').replace(/[-−+]?\d[\d.,]*/g, '').replace(/\s{2,}/g, ' ').trim();
}

/** A text of the hub's for pure mode: durations as spans (with the core), then any other Earth measure left out. */
export function pureText(text: string, spanOf?: (us: bigint) => string): string {
  return keepIds(text, (t) => earthless(spanOf ? pureDurations(vague(t), spanOf) : vague(t)));
}

/** The mark a held-back Earth value leaves in a text someone wires or buys from (heldText). */
export const HELD = '⊕';

/**
 * A text someone wires or buys from (a guide's step, a safety line, a part's name or value), for pure mode: durations as
 * spans (with the core), and every other Earth measure replaced by ⊕ in place, so the sentence keeps its shape and
 * says that a value is there in Earth mode: "below 2.5 V it is damaged. Leave it at about 3.8 V" → "below ⊕ it is
 * damaged. Leave it at about ⊕"; 'GC9A01 1.28" round display' → "GC9A01 ⊕ round display". Passes pureSafe.
 */
export function heldText(text: string, spanOf?: (us: bigint) => string): string {
  return keepIds(text, (t) => {
    let out = bands(spanOf ? pureDurations(vague(t), spanOf) : vague(t));
    if (pureSafe(out)) {
      return out;
    }
    out = out
      .replace(EARTH_MEASURE_G, HELD)
      .replace(EARTH_ANY_G, HELD)
      .replace(/⊕(?:\s*⊕)+/g, HELD);
    return pureSafe(out) ? out : earthless(out);
  });
}

/**
 * A text of the hub's for Earth mode: each duration as its span ⊕ the duration (with the core), each other Earth
 * measure led by ⊕, so a Fractonica value is never replaced and every Earth value is marked.
 */
export function earthText(text: string, spanOf?: (us: bigint) => string): string {
  return keepIds(text, (t) => {
    const marked = new Set<number>();
    const withSpans = spanOf ? pureDurations(t, spanOf, true) : t;
    // the durations already carry their ⊕; mark the other measures
    return withSpans.replace(EARTH_MEASURE_G, (m: string, ...rest: unknown[]) => {
      const at = rest.find((x) => typeof x === 'number') as number;
      const before = withSpans.slice(Math.max(0, at - 2), at);
      if (before.endsWith('⊕ ') || marked.has(at)) {
        return m;
      }
      marked.add(at);
      return `⊕ ${m}`;
    });
  });
}
