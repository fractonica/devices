// Pure mode and the texts the dashboard does not write itself (design README ruling 11 and "Hub"): pure mode shows only
// Fractonica units, so a text of the hub's (a check's detail, a job's message, a warning) or of the catalog (a
// capability's summary) that states an Earth measure is changed or held back. One rule for every page:
//
// - a text of the hub's is said with `pureText`: its civil durations become Fractonica spans ("p99 7.47 ms" →
//   "p99 0.024ν", when the core is loaded), and a clause still stating an Earth measure (bytes, dBm, hertz, per cent)
//   is left out ("retried after 5, 15 and 45 s" with no core → "retried"). Earth mode shows the text whole.
// - catalog prose (written for engineers, often naming units without numbers: "volume in %", "for ms") is shown in
//   pure mode only when `pureSafe` says it names no Earth unit at all; Earth mode shows it always.
//
// Pages reach these through `useHubText()` (ui/span.tsx), which binds the core and the mode.

/** An Earth unit, word, clock time, date or zone anywhere in running text. */
const EARTH_TEXT = new RegExp(
  [
    String.raw`\b\d+(\.\d+)?\s?(ms|µs|us|s|sec|min|h|hr|d|Hz|kHz|MHz|GHz|mV|V|mA|mg|g|kg|m|cm|mm|km|KB|kB|MB|GB|dB|dBm|dBFS|°C|px)\b`,
    String.raw`\b(milli\w*|seconds?|minutes?|hours?|days?|hertz|volts?|grams?|celsius|percent|per cent|dBm|dBFS|Hz|UTC|GMT)\b`,
    String.raw`_(ms|us|s|hz|mv|mg|mb)\b`,
    String.raw`\b\d{1,2}:\d{2}\b`,
    String.raw`\b(19|20)\d{2}-\d{2}-\d{2}`,
    '%',
    '°',
  ].join('|'),
  'i',
);

/** Whether a text names no Earth unit, clock time, date, zone or per cent, so pure mode may show it as it is. */
export function pureSafe(text: string): boolean {
  return !EARTH_TEXT.test(text);
}

const CIVIL_DURATION = /(\d+(?:\.\d+)?)\s?(µs|us|ms|s|sec|min|h)\b/g;
const CIVIL_US: Record<string, number> = { 'µs': 1, us: 1, ms: 1000, s: 1_000_000, sec: 1_000_000, min: 60_000_000, h: 3_600_000_000 };

/**
 * A text the hub wrote with its civil durations said as Fractonica spans: "p99 7.47 ms over the last 30 s" →
 * "p99 0.024ν over the last 3λ 27ν". Other words are left as they are.
 */
export function pureDurations(text: string, spanOf: (us: bigint) => string): string {
  return text.replace(CIVIL_DURATION, (_m, n: string, unit: string) => spanOf(BigInt(Math.round(Number(n) * CIVIL_US[unit]!))));
}

const EARTH_UNIT = /\d\s?(?:ms|s|min|h|d|KB|MB|kB|B|dBm|Hz|kHz|MHz|GHz|%|m|cm|mm)\b|\d%/;

/**
 * A text of the hub's with its clauses that state an Earth measure (seconds, bytes, dBm, per cent) left out: "attic-pad
 * is unknown: the OFFER is retried after 5, 15 and 45 s" becomes "attic-pad is unknown: the OFFER is retried". A band
 * said in hertz becomes the hub's band name ("5 GHz only" → "5g band only").
 */
export function earthless(text: string): string {
  if (!EARTH_UNIT.test(text)) {
    return text;
  }
  const t = text
    .replace(/(\d+(?:\.\d+)?)\s?GHz(?: only)?/g, (_m, n: string) => `${n.startsWith('5') ? '5g' : '2g'} band${_m.endsWith('only') ? ' only' : ''}`)
    .replace(/\s*\([^)]*\)/g, (m) => (EARTH_UNIT.test(m) ? '' : m))
    .replace(/\s*\b(?:within|after|in|for|every|of|at|by)\s+(?:[\d.]+(?:,\s*|\s+and\s+|\s*-\s*))*[\d.]+\s?(?:ms|s|min|h|KB|MB|kB|B|dBm|%)(?=\W|$)/g, '');
  if (!EARTH_UNIT.test(t)) {
    return t.trim();
  }
  const parts = t.split(/(?<=[:;,.(])\s+|\s+(?=\()/);
  const kept: string[] = [];
  for (const p of parts) {
    if (EARTH_UNIT.test(p)) {
      break;
    }
    kept.push(p);
  }
  const out = kept.join(' ').replace(/[\s:;,(]+$/, '').trim();
  // nothing before the first measure: the text with its measures taken out
  return out || t.replace(/\s*\d[\d.,]*\s?(?:ms|s|min|h|d|KB|MB|kB|B|dBm|Hz|kHz|MHz|GHz|%|m|cm|mm)\b/g, '').trim();
}

/** A text of the hub's for pure mode: durations as spans (with the core), then any other Earth measure left out. */
export function pureText(text: string, spanOf?: (us: bigint) => string): string {
  return earthless(spanOf ? pureDurations(text, spanOf) : text);
}
