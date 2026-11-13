// The Live page's view of the live store's ring (HARDWARE-REVIEW §4 "Screens" 6; design README "Hub" 10): which events
// a filter keeps (device beads and type chips), the newest-first list while live or paused, the type families the
// chips offer, the quiet line a time.threshold becomes, and an event's fields as one short line. Pure, so the tests run
// in node; the page (pages/live.tsx) renders what these return.
//
// Pause keeps every event: the ring goes on filling while the page shows the events up to the seq it paused at, and
// counts the ones that wait. Resume shows them all at once. Nothing is dropped by pausing (the ring's own RING_MAX is
// the only limit, as before).

import type { HubEvent } from '@fractonica/protocol/client';

import { fieldWords, impliedUnit } from './device-units.ts';
import { pureSafe, pureText } from './pure-text.ts';

/** The device key of the hub's own events (no device): its chip in the device filter. */
export const HUB_KEY = 'hub';

/** The type every threshold event has (packages/hub/src/time/thresholds.ts). */
export const THRESHOLD_TYPE = 'time.threshold';

/** An event's type family: what comes before the first dot (`device.online` → `device`). */
export function typeFamily(type: string): string {
  const i = type.indexOf('.');
  return i < 0 ? type : type.slice(0, i);
}

/** The device an event is about, or HUB_KEY for the hub's own. */
export function deviceKey(e: Pick<HubEvent, 'device'>): string {
  return e.device ?? HUB_KEY;
}

export interface LiveFilter {
  /** Device ids (and HUB_KEY) to keep; empty keeps every device. */
  devices: ReadonlySet<string>;
  /** Type families to keep; empty keeps every type. */
  families: ReadonlySet<string>;
}

export const NO_FILTER: LiveFilter = { devices: new Set(), families: new Set() };

/** Whether a filter keeps everything. */
export function filterIsEmpty(f: LiveFilter): boolean {
  return f.devices.size === 0 && f.families.size === 0;
}

/** The predicate of a filter. */
export function liveKeep(f: LiveFilter): (e: HubEvent) => boolean {
  const { devices, families } = f;
  return (e) => (devices.size === 0 || devices.has(deviceKey(e))) && (families.size === 0 || families.has(typeFamily(e.type)));
}

/** A set with `item` added, or taken out when it is in (a chip's toggle). */
export function toggled<T>(set: ReadonlySet<T>, item: T): Set<T> {
  const next = new Set(set);
  if (next.has(item)) {
    next.delete(item);
  } else {
    next.add(item);
  }
  return next;
}

/** The type families in `events` with their counts, in name order (so chips do not move as counts change). */
export function familiesOf(events: readonly HubEvent[]): { family: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    const f = typeFamily(e.type);
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return [...counts].map(([family, count]) => ({ family, count })).sort((a, b) => a.family.localeCompare(b.family));
}

/**
 * The events to show, newest first: those the filter keeps, and while paused (`pausedAt` a seq) only those up to it.
 * `max` caps the list (the ring holds RING_MAX at most anyway).
 */
export function shownEvents(ring: readonly HubEvent[], pausedAt: number | null, keep: (e: HubEvent) => boolean, max = Infinity): HubEvent[] {
  const out: HubEvent[] = [];
  for (let i = ring.length - 1; i >= 0 && out.length < max; i--) {
    const e = ring[i]!;
    if ((pausedAt === null || e.seq <= pausedAt) && keep(e)) {
      out.push(e);
    }
  }
  return out;
}

/** Events that came after the pause and pass the filter: what Resume will show. */
export function waitingCount(ring: readonly HubEvent[], pausedAt: number | null, keep: (e: HubEvent) => boolean): number {
  if (pausedAt === null) {
    return 0;
  }
  let n = 0;
  for (let i = ring.length - 1; i >= 0; i--) {
    const e = ring[i]!;
    if (e.seq <= pausedAt) {
      break; // the ring is in seq order
    }
    if (keep(e)) {
      n++;
    }
  }
  return n;
}

/** The seq a pause starts at: the newest event in the ring (-1 when it is empty, so every event after waits). */
export function pauseSeq(ring: readonly HubEvent[]): number {
  return ring.at(-1)?.seq ?? -1;
}

export function isThreshold(e: Pick<HubEvent, 'type'>): boolean {
  return e.type === THRESHOLD_TYPE;
}

export interface ThresholdWords {
  /** The level's symbol (η). */
  symbol: string;
  /** The quarter, the core's word in lower case (peak, node, valley, end). */
  quarter: string;
  /** The unit's name (Helion), or null for a level between units. */
  unit: string | null;
  /** The threshold's Unix µs (the `at` field, a decimal string), or null. */
  at: bigint | null;
  /** The core's stamp of the instant, as the hub wrote it. */
  stamp: string | null;
}

/** What a time.threshold event says, read defensively (null when its fields are not a threshold's). */
export function thresholdWords(fields: Record<string, unknown> | undefined): ThresholdWords | null {
  if (!fields || typeof fields.symbol !== 'string' || typeof fields.quarter !== 'string') {
    return null;
  }
  let at: bigint | null = null;
  if (typeof fields.at === 'string' && /^-?\d+$/.test(fields.at)) {
    at = BigInt(fields.at);
  }
  return {
    symbol: fields.symbol,
    quarter: fields.quarter.toLowerCase(),
    unit: typeof fields.unit === 'string' ? fields.unit : null,
    at,
    stamp: typeof fields.stamp === 'string' ? fields.stamp : null,
  };
}

/** A field key that carries an Earth unit of time (`rtt_ms`, `uptime_s`, `hold_us`): its unit and its bare name. */
export function timeKey(key: string): { name: string; us: number } | null {
  const m = /^(.*?)_?(us|ms|s)$/.exec(key);
  if (!m || !m[1] || !/_(us|ms|s)$/.test(key)) {
    return null;
  }
  return { name: m[1], us: m[2] === 'us' ? 1 : m[2] === 'ms' ? 1000 : 1_000_000 };
}

export interface SummaryOptions {
  /** Pure mode: only Fractonica units (a duration as a span, an instant in Fractonica notation, no Earth unit). */
  pure: boolean;
  /** A duration in µs as a Fractonica span ("0.048ν", "1ι 12λ"); without it the raw value stays. */
  spanOf?: (us: bigint) => string;
  /** An ISO instant as the page says it (Fractonica notation, ⊕ civil time in Earth mode); without it pure mode leaves it out. */
  instant?: (iso: string) => string;
  /** A number in an Earth unit (mV, mg, Hz) in the mode's words (device-units valueText bound to the core). */
  unitValue?: (v: number, unit: string) => { text: string; earth: string | null };
  /** A text of the hub's or a device's in the mode's units (ui/kit.tsx useHubText). */
  say?: (text: string) => string;
  /** Characters at most (default 160). */
  max?: number;
}

const ISO = /^(?:19|20)\d{2}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?$/;
/** Fields that name something (a serial, a MAC, a path, an id): shown as written, never read for Earth units. */
const ID_FIELD = /^(?:usb_serial|serial|mac|bssid|device_id|id|path|port|alias|name|ssid|host|hash|sha|fw|firmware|fw_id(?:_prefix)?|profile|board|chip)$|_(?:id|mac|serial|path|hash|sha|prefix)$/;

/** One field as people read it: its name in words (no Earth unit in it) and its value in the mode's units. */
export function fieldEntry(key: string, v: unknown, opts: Omit<SummaryOptions, 'max'>): [string, string] {
  const t = timeKey(key);
  if (t && typeof v === 'number' && Number.isFinite(v)) {
    const civil = `${v} ${key.endsWith('_us') ? 'µs' : key.endsWith('_ms') ? 'ms' : 's'}`;
    const name = t.name.replace(/_/g, ' ');
    if (opts.spanOf) {
      const span = `${v < 0 ? '−' : ''}${opts.spanOf(BigInt(Math.round(Math.abs(v) * t.us)))}`;
      return [name, opts.pure ? span : `${span} ⊕ ${civil}`];
    }
    return opts.pure ? [name, String(v)] : [name, `⊕ ${civil}`];
  }
  const unit = typeof v === 'number' ? impliedUnit(key) : undefined;
  if (unit && typeof v === 'number' && Number.isFinite(v)) {
    const u = opts.unitValue?.(v, unit) ?? { text: String(v), earth: `${v} ${unit}` };
    return [fieldWords(key), opts.pure || !u.earth ? u.text || '·' : `${u.text} ⊕ ${u.earth}`];
  }
  if (typeof v === 'string' && ISO.test(v)) {
    const name = key.replace(/_at$/, '').replace(/_/g, ' ');
    return [name, opts.instant ? opts.instant(v) : opts.pure ? '–' : `⊕ ${v}`];
  }
  const text = valueText(v);
  if (typeof v === 'string' && ID_FIELD.test(key)) {
    return [fieldWords(key), text];
  }
  return [fieldWords(key), typeof v === 'string' && opts.say ? opts.say(text) : opts.pure && !pureSafe(text) ? pureText(text, opts.spanOf) : text];
}


function valueText(v: unknown): string {
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'boolean') {
    return v ? 'yes' : 'no';
  }
  if (typeof v === 'number' || typeof v === 'bigint') {
    return String(v);
  }
  if (v === null || v === undefined) {
    return '–';
  }
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * An event's fields on one line, `key value · key value`, cut at `max`. In pure mode a duration field (`p99_ms`) is
 * said as a Fractonica span under its bare name (`p99 0.048ν`), so no second reaches the page.
 */
export function summary(fields: Record<string, unknown> | undefined, opts: SummaryOptions): string {
  if (!fields) {
    return '';
  }
  const max = opts.max ?? 160;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    const [name, text] = fieldEntry(k, v, opts);
    parts.push(`${name} ${text}`);
  }
  const s = parts.join(' · ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The fields as indented JSON for the open row; in pure mode durations become spans as in summary(). */
export function fieldsText(fields: Record<string, unknown> | undefined, opts: Omit<SummaryOptions, 'max'>): string {
  if (!fields || !Object.keys(fields).length) {
    return '';
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    // a value with no unit and no text of an Earth measure stays as JSON has it (a number, a list, an object)
    const plain = typeof v !== 'string' && !timeKey(k) && !(typeof v === 'number' && impliedUnit(k)) && (!opts.pure || pureSafe(JSON.stringify(v) ?? ''));
    if (plain) {
      out[k] = v;
      continue;
    }
    const [name, text] = fieldEntry(k, v, opts);
    out[name] = text;
  }
  return JSON.stringify(out, null, 2);
}
