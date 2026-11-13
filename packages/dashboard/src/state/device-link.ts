// What the Devices and Device pages read from the hub's device rows (device_list, device_get), as plain facts for the
// views: the order of the fleet, this hub run's link (`live`, `router`), the heartbeat, and the clock sync stated
// plainly. DOM-free and tested in node.

import type { DeviceView } from '@fractonica/protocol/client';

import { fieldWords } from './device-units.ts';
import { fleetCount } from './words.ts';

/** device_list's `live` (hub registry/ops.ts, design m2-c2 D16): this hub run's view of the device's link. */
export interface LiveLink {
  links: string[];
  udp_blocked: boolean;
  /** The last HEARTBEAT's RSSI to the AP (0: not on Wi-Fi) and uptime; null before one. */
  rssi_ap: number | null;
  uptime_s: number | null;
  fw_id_prefix: string | null;
}

/** A device_list row's `live`; null before the device's first HELLO this hub run (or from a hub without it). */
export function liveOf(device: DeviceView): LiveLink | null {
  const live = (device as { live?: unknown }).live;
  return live && typeof live === 'object' && Array.isArray((live as LiveLink).links) ? (live as LiveLink) : null;
}

const PRESENCE_ORDER: Record<string, number> = { online: 0, suspect: 1, offline: 2, unknown: 3 };

/** The fleet's order: online first, then suspect, offline, unknown; by alias within each. */
export function byPresenceThenAlias(a: Pick<DeviceView, 'presence' | 'alias'>, b: Pick<DeviceView, 'presence' | 'alias'>): number {
  return (PRESENCE_ORDER[a.presence] ?? 9) - (PRESENCE_ORDER[b.presence] ?? 9) || a.alias.localeCompare(b.alias);
}

/** Devices whose alias, profile, board, chip or a tag contains every word of `query` (case-insensitive). */
export function filterDevices<T extends DeviceView>(devices: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return [...devices];
  }
  return devices.filter((d) => {
    const hay = [d.alias, d.profile, d.board, d.chip, d.presence, ...d.tags].filter(Boolean).join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The Devices page's count line ("2 shown · 5 of 6 online"): words.ts fleetCount over the registry rows. */
export function fleetCountOf(all: readonly Pick<DeviceView, 'presence'>[], shown?: number): string {
  return fleetCount({ total: all.length, online: all.filter((d) => d.presence === 'online').length, ...(shown !== undefined ? { shown } : {}) });
}

/** The first `n` characters of a fw_id. */
export function shortId(id: string | null | undefined, n = 8): string {
  return id ? id.slice(0, n) : '';
}

/** The board, profile and chip a row names, without repeats or blanks. */
export function hardwareLine(d: Pick<DeviceView, 'board' | 'profile' | 'chip'>): string {
  return [...new Set([d.profile, d.board, d.chip].filter((x): x is string => !!x))].join(' · ');
}

/** A HEARTBEAT as the router keeps it (05 §5.7); every field may be missing. */
export interface Heartbeat {
  uptime_s?: number;
  rssi_ap?: number;
  free_heap_kb?: number;
  vbat_mv?: number;
  tx_fail?: number;
  rx_drop?: number;
  queue_hwm?: number;
}

export function heartbeatOf(hb: Record<string, unknown> | null | undefined): Heartbeat | null {
  if (!hb) {
    return null;
  }
  const num = (k: string) => (typeof hb[k] === 'number' && Number.isFinite(hb[k]) ? (hb[k] as number) : undefined);
  const out: Heartbeat = {};
  for (const k of ['uptime_s', 'rssi_ap', 'free_heap_kb', 'vbat_mv', 'tx_fail', 'rx_drop', 'queue_hwm'] as const) {
    const v = num(k);
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export interface ClockInfo {
  offset_us: number;
  uncertainty_us: number;
  rtt_us: number;
  samples: number;
}

/**
 * The device clock's sync with the hub, plainly: `none` (no TIME exchange yet: its events carry the hub's receive
 * time), `settling` (fewer than three samples: the bound is still wide), or `in-step` (the device's times are the
 * hub's to within ± uncertainty).
 */
export type ClockState = 'none' | 'settling' | 'in-step';

export function clockState(clock: ClockInfo | null | undefined): ClockState {
  if (!clock || !Number.isFinite(clock.uncertainty_us)) {
    return 'none';
  }
  return clock.samples < 3 ? 'settling' : 'in-step';
}

export const CLOCK_WORDS: Record<ClockState, string> = {
  none: 'not synced',
  settling: 'settling',
  'in-step': 'in step',
};

/** The links, best first, said for people: "tcp", "gateway via hall-gw", "serial". */
export function linksText(links: readonly string[], gw?: string | null): string {
  return links.map((l) => (l === 'gateway' && gw ? `gateway via ${gw}` : l)).join(' · ');
}

/** The last event of a device's instance in a ring of events (newest last), capability events only. */
export function lastInstanceEvent<E extends { device?: string; type: string; part?: string }>(ring: readonly E[], deviceId: string, instance: string): E | undefined {
  for (let i = ring.length - 1; i >= 0; i--) {
    const e = ring[i]!;
    if (e.device === deviceId && e.part === 'event' && e.type.startsWith(`${instance}.`)) {
      return e;
    }
  }
  return undefined;
}

/** A device's events in a ring, newest first, at most `max`. */
export function recentEvents<E extends { device?: string }>(ring: readonly E[], deviceId: string, max = 30): E[] {
  const out: E[] = [];
  for (let i = ring.length - 1; i >= 0 && out.length < max; i--) {
    if (ring[i]!.device === deviceId) {
      out.push(ring[i]!);
    }
  }
  return out;
}

/** An event's fields in words for a row: "count 2 · held 3.2ν" is the page's; here only the plain pairs. */
export function fieldPairs(fields: Record<string, unknown> | undefined, max = 4): [string, unknown][] {
  if (!fields) {
    return [];
  }
  return Object.entries(fields)
    .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
    .slice(0, max);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Raw JSON for pure mode: every ISO time in it (created_at, last_seen, …) replaced by `stamp(iso)`, the Fractonica
 * notation, so no Gregorian date reaches the page; Earth mode shows the JSON as the hub sent it.
 */
export function pureJson(value: unknown, stamp: (iso: string) => string): unknown {
  if (typeof value === 'string') {
    return ISO.test(value) ? stamp(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => pureJson(v, stamp));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, pureJson(v, stamp)]));
  }
  return value;
}

/**
 * A JSON answer as rows: [label, text, the leaf's key, the leaf's number]. Nested objects are flattened to
 * "links · tcp · up", arrays stay on one line, and a key's Earth unit leaves its words (uptime_ms is "uptime"; the
 * caller says the number in its unit, impliedUnit(key)).
 */
export function flattenJson(value: unknown, prefix = '', out: [string, string, string, number | null][] = [], depth = 0, key = ''): [string, string, string, number | null][] {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && depth < 4) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const words = fieldWords(k);
      flattenJson(v, prefix ? `${prefix} · ${words}` : words, out, depth + 1, k);
    }
    return out;
  }
  out.push([prefix || 'value', typeof value === 'string' ? value : JSON.stringify(value), key, typeof value === 'number' ? value : null]);
  return out;
}
