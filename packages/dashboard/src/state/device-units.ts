// How the device pages say a capability's numbers (design README rulings 2, 3, 11 and "Hub" 10). DOM-free, so it is
// tested in node with the real core.
//
// The catalog gives a field or property a unit (`ms`, `s`, `Hz`, `%`, `mV`, `dBm`, …). Pure mode shows only
// Fractonica units, so:
// - a time (ms, s) is a span, as the core writes it ("3.2ν", "7λ 17ν"); Earth mode adds "⊕ 200 ms";
// - a rate (Hz) is cycles per Blink, the core's "pB"; Earth mode adds "⊕ 100 Hz";
// - a share (%) is never a number: it is light on a hairline (a slider's lit line, a meter); Earth mode adds "⊕ 60 %";
// - a physical quantity the core has no unit for (mV, mg, MB, dBm, °C/10, dBFS/10) is the bare count in pure mode, and
//   Earth mode adds the value in its unit ("⊕ 3 712 mV");
// - pixels and bytes are counts, the same in both modes.
// The words of a field drop an Earth unit from its name too ("on_ms" is "on", "seconds" is "duration").

import { type Core, Unit } from '@fractonica/time/browser';

export type UnitClass = 'none' | 'time' | 'rate' | 'share' | 'earth' | 'count';

export interface UnitInfo {
  cls: UnitClass;
  /** Microseconds per unit, for a time. */
  us?: number;
  /** The value's scale to its Earth unit (degC/10: 0.1 °C). */
  scale?: number;
  /** The Earth unit's symbol ("mV", "°C"). */
  symbol?: string;
}

const UNITS: Record<string, UnitInfo> = {
  us: { cls: 'time', us: 1, symbol: 'µs' },
  ms: { cls: 'time', us: 1000, symbol: 'ms' },
  s: { cls: 'time', us: 1_000_000, symbol: 's' },
  Hz: { cls: 'rate', symbol: 'Hz' },
  '%': { cls: 'share', symbol: '%' },
  mV: { cls: 'earth', symbol: 'mV' },
  mg: { cls: 'earth', symbol: 'mg' },
  MB: { cls: 'earth', symbol: 'MB' },
  dBm: { cls: 'earth', symbol: 'dBm' },
  'degC/10': { cls: 'earth', scale: 0.1, symbol: '°C' },
  'dBFS/10': { cls: 'earth', scale: 0.1, symbol: 'dBFS' },
  px: { cls: 'count', symbol: 'px' },
  B: { cls: 'count', symbol: 'B' },
};

export function unitInfo(unit: string | undefined | null): UnitInfo {
  if (!unit) {
    return { cls: 'none' };
  }
  return UNITS[unit] ?? { cls: 'earth', symbol: unit };
}

/**
 * The unit of a field or property: the catalog's, else one its name implies (fr.battery's `percent` has none in the
 * catalog but is a share, so it is light, never a number).
 */
export function unitOf(field: { name: string; unit?: string }): string | undefined {
  if (field.unit) {
    return field.unit;
  }
  return field.name === 'percent' || field.name.endsWith('_percent') ? '%' : undefined;
}

/**
 * The unit an event field implies when the catalog gives it none: by its type (`duration_ms`) or its name's suffix
 * (`held_ms`, `rtt_us`, `mv`, `weight_mg`, `rate_hz`).
 */
export function impliedUnit(name: string, type?: string): string | undefined {
  if (type === 'duration_ms') {
    return 'ms';
  }
  const n = name.toLowerCase();
  if (n === 'mv' || n.endsWith('_mv')) {
    return 'mV';
  }
  const m = /_(ms|us|mg|hz|s)$/.exec(n);
  return m ? ({ ms: 'ms', us: 'us', mg: 'mg', hz: 'Hz', s: 's' } as Record<string, string>)[m[1]!] : undefined;
}

/** Name suffixes that are an Earth unit (stripped from the words), longest first. */
const UNIT_SUFFIXES = ['_mv', '_mg', '_mb', '_ms', '_us', '_hz', '_c10', '_s'];
/** Whole names that are an Earth word. */
const NAME_WORDS: Record<string, string> = { on: 'state', ms: 'duration', seconds: 'duration', percent: 'charge', freq_hz: 'pitch', unix: 'time', mv: 'voltage', meter_mv: 'meter voltage', supply_mv: 'supply voltage' };

/** A field or property name as words, with an Earth unit dropped: on_ms → "on", double_click → "double click". */
export function fieldWords(name: string): string {
  if (NAME_WORDS[name]) {
    return NAME_WORDS[name]!;
  }
  let n = name;
  for (const s of UNIT_SUFFIXES) {
    if (n.length > s.length && n.toLowerCase().endsWith(s)) {
      n = n.slice(0, -s.length);
      break;
    }
  }
  return n.replace(/_/g, ' ');
}

/** The microseconds of one Blink at `t` (they follow the Saros interval): the core's period of the Blink's level. */
export function blinkMicros(core: Core, t: bigint = core.frc.now()): number {
  const level = core.frc.unitLevel(Unit.BLINK);
  return level === null ? NaN : core.frc.periodSeconds(level, core.cat.intervalAt(t)) * 1e6;
}

/** A span of `us` microseconds ending now, as the core writes it ("3.2ν", "7λ 17ν", "0.0036ν"); "0ν" for none. */
export function spanText(core: Core, us: number, parts = 2, now: bigint = core.frc.now()): string {
  if (!Number.isFinite(us)) {
    return '—';
  }
  const neg = us < 0;
  const d = BigInt(Math.round(Math.abs(us)));
  const text = core.frc.formatSpan(core.cat.spanBetween(now - d, now), parts);
  return neg ? `−${text}` : text;
}

/** A short Earth duration: under a second in ms (the core's words drop sub-second spans to "0 s"), else the core's. */
export function earthDuration(core: Core, us: number): string {
  const a = Math.abs(us);
  if (a < 1_000_000) {
    const ms = Math.round((us / 1000) * 10) / 10;
    return `${ms < 0 ? '−' : ''}${Math.abs(ms)} ms`;
  }
  return core.frc.formatDuration(BigInt(Math.round(us)), 2);
}

/** A rate in Hz as cycles per Blink, the core's words ("7 pB", "1 per 3 Blinks"). */
export function rateText(core: Core, hz: number, now: bigint = core.frc.now()): string {
  const blinkUs = blinkMicros(core, now);
  if (!Number.isFinite(hz) || !Number.isFinite(blinkUs)) {
    return '—';
  }
  // cycles per Blink = hz × blinkUs / 10⁶, given to the core as an exact ratio
  const num = BigInt(Math.round(hz * blinkUs * 1000));
  return core.frc.formatPerBlink(num, 1_000_000_000n);
}

/** An integer grouped as the core groups counts ("58 500", "−3"); other numbers as they are. */
export function countText(core: Core | null, n: number): string {
  if (core && Number.isInteger(n) && Math.abs(n) < Number.MAX_SAFE_INTEGER) {
    return core.frc.formatCountSigned(BigInt(n));
  }
  return String(n);
}

export interface ValueText {
  /** What pure mode shows (and Earth mode first); '' for a share, which is drawn as light instead. */
  text: string;
  /** Earth mode's translation (no ⊕: the caller's Earth line adds it); null when there is none. */
  earth: string | null;
}

/** A numeric value of a field or property in `unit`, for both modes. */
export function valueText(core: Core | null, value: number, unit: string | undefined | null): ValueText {
  const u = unitInfo(unit);
  const earthNum = (v: number) => `${countTextEarth(v * (u.scale ?? 1))} ${u.symbol ?? ''}`.trim();
  switch (u.cls) {
    case 'time':
      return { text: core ? spanText(core, value * u.us!) : '—', earth: earthNum(value) };
    case 'rate':
      return { text: core ? rateText(core, value) : '—', earth: earthNum(value) };
    case 'share':
      return { text: '', earth: earthNum(value) };
    case 'earth': {
      const scaled = Math.round(value * (u.scale ?? 1) * 1000) / 1000;
      return { text: countText(core, scaled), earth: earthNum(value) };
    }
    case 'count':
      return { text: `${countText(core, value)} ${u.symbol}`, earth: null };
    default:
      return { text: countText(core, value), earth: null };
  }
}

/** An Earth number: grouped like the core's counts (narrow no-break spaces), decimals kept. */
function countTextEarth(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  const [int, frac] = String(Math.abs(r)).split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f'); // the core's narrow no-break space
  return `${r < 0 ? '−' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

/** Signal strength from an RSSI (dBm) as a level 0..4 and its word; null when there is none (0: not on Wi-Fi). */
export function signalOf(rssiDbm: number | null | undefined): { level: number; word: string } | null {
  if (rssiDbm === null || rssiDbm === undefined || !Number.isFinite(rssiDbm) || rssiDbm === 0) {
    return null;
  }
  const level = rssiDbm >= -55 ? 4 : rssiDbm >= -65 ? 3 : rssiDbm >= -75 ? 2 : rssiDbm >= -85 ? 1 : 0;
  return { level, word: ['faint', 'weak', 'fair', 'good', 'strong'][level]! };
}

/** A value's place in [min, max] as 0..1 (a meter's light; never written as a number). */
export function fractionOf(value: number, min: number, max: number): number {
  if (!(max > min) || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

