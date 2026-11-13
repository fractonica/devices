// The Live page's rules (src/state/live-view.ts): filters by device beads and type chips, the newest-first list while
// live and paused (nothing is lost by pausing), the type families the chips offer, time.threshold's words, and an
// event's fields on one line, with durations said as spans in pure mode.

import { describe, expect, it } from 'vitest';

import type { HubEvent } from '@fractonica/protocol/browser';

import {
  deviceKey,
  familiesOf,
  fieldsText,
  filterIsEmpty,
  HUB_KEY,
  isThreshold,
  liveKeep,
  NO_FILTER,
  pauseSeq,
  shownEvents,
  summary,
  thresholdWords,
  timeKey,
  toggled,
  typeFamily,
  waitingCount,
} from '../src/state/live-view.ts';

let seq = 0;
function e(type: string, device?: string, fields?: Record<string, unknown>): HubEvent {
  seq++;
  return { cursor: `c:1.${seq}`, seq, type, t_hub_us: 1_700_000_000_000_000 + seq, ...(device ? { device, alias: `a-${device}` } : {}), ...(fields ? { fields } : {}) };
}

describe('filters', () => {
  const ring = [e('device.online', 'd1'), e('boot.click', 'd2'), e('hub.warning'), e('boot.down', 'd1'), e('time.threshold', undefined, { symbol: 'ι', quarter: 'PEAK' })];

  it('reads a type family and a device key (the hub for none)', () => {
    expect(typeFamily('device.online')).toBe('device');
    expect(typeFamily('port0.edge.rise')).toBe('port0');
    expect(typeFamily('plain')).toBe('plain');
    expect(deviceKey({ device: 'd1' })).toBe('d1');
    expect(deviceKey({})).toBe(HUB_KEY);
  });

  it('keeps everything with no chip pressed', () => {
    expect(filterIsEmpty(NO_FILTER)).toBe(true);
    expect(ring.filter(liveKeep(NO_FILTER))).toHaveLength(ring.length);
  });

  it('keeps the pressed devices (the hub as one of them) and the pressed families, both at once', () => {
    const byDevice = liveKeep({ devices: new Set(['d1', HUB_KEY]), families: new Set() });
    expect(ring.filter(byDevice).map((x) => x.type)).toEqual(['device.online', 'hub.warning', 'boot.down', 'time.threshold']);
    const both = liveKeep({ devices: new Set(['d1']), families: new Set(['boot']) });
    expect(ring.filter(both).map((x) => x.type)).toEqual(['boot.down']);
  });

  it('toggles a chip in and out of a set without changing the old one', () => {
    const a = new Set(['x']);
    const b = toggled(a, 'y');
    expect([...b]).toEqual(['x', 'y']);
    expect([...toggled(b, 'x')]).toEqual(['y']);
    expect([...a]).toEqual(['x']);
  });

  it('offers the families present, counted, in name order', () => {
    expect(familiesOf(ring)).toEqual([
      { family: 'boot', count: 2 },
      { family: 'device', count: 1 },
      { family: 'hub', count: 1 },
      { family: 'time', count: 1 },
    ]);
  });
});

describe('live and paused', () => {
  it('shows the newest first, and while paused only up to the pause; the rest wait, counted', () => {
    const ring = [e('a.x', 'd1'), e('b.x', 'd1'), e('a.y', 'd2')];
    const keepAll = liveKeep(NO_FILTER);
    expect(shownEvents(ring, null, keepAll).map((x) => x.type)).toEqual(['a.y', 'b.x', 'a.x']);
    const at = pauseSeq(ring);
    const later = [...ring, e('a.z', 'd1'), e('b.z', 'd2')];
    expect(shownEvents(later, at, keepAll).map((x) => x.type)).toEqual(['a.y', 'b.x', 'a.x']);
    expect(waitingCount(later, at, keepAll)).toBe(2);
    const onlyA = liveKeep({ devices: new Set(), families: new Set(['a']) });
    expect(waitingCount(later, at, onlyA)).toBe(1);
    // resuming shows every event that waited
    expect(shownEvents(later, null, keepAll)).toHaveLength(5);
    expect(waitingCount(later, null, keepAll)).toBe(0);
  });

  it('pauses on an empty ring so that every later event waits', () => {
    expect(pauseSeq([])).toBe(-1);
    const later = [e('a.x')];
    expect(shownEvents(later, -1, () => true)).toEqual([]);
    expect(waitingCount(later, -1, () => true)).toBe(1);
  });

  it('caps the list', () => {
    const ring = Array.from({ length: 10 }, () => e('a.x'));
    expect(shownEvents(ring, null, () => true, 3)).toHaveLength(3);
  });
});

describe('thresholds', () => {
  it('reads a threshold event defensively', () => {
    expect(isThreshold({ type: 'time.threshold' })).toBe(true);
    expect(isThreshold({ type: 'time.other' })).toBe(false);
    expect(thresholdWords({ symbol: 'η', quarter: 'PEAK', unit: 'Helion', at: '1791460800000000', stamp: 'α#6 …' })).toEqual({
      symbol: 'η',
      quarter: 'peak',
      unit: 'Helion',
      at: 1791460800000000n,
      stamp: 'α#6 …',
    });
    expect(thresholdWords({ symbol: 'θ', quarter: 'end', unit: null, at: 'x' })).toEqual({ symbol: 'θ', quarter: 'end', unit: null, at: null, stamp: null });
    expect(thresholdWords({ quarter: 'end' })).toBeNull();
    expect(thresholdWords(undefined)).toBeNull();
  });
});

describe('the fields line', () => {
  const spanOf = (us: bigint) => `<${us}µs>`;

  it('knows a key in an Earth unit of time, and only those', () => {
    expect(timeKey('rtt_ms')).toEqual({ name: 'rtt', us: 1000 });
    expect(timeKey('uptime_s')).toEqual({ name: 'uptime', us: 1_000_000 });
    expect(timeKey('hold_us')).toEqual({ name: 'hold', us: 1 });
    expect(timeKey('status')).toBeNull();
    expect(timeKey('ms')).toBeNull();
    expect(timeKey('items')).toBeNull();
  });

  it('writes key value pairs; durations become spans under their bare name in pure mode only', () => {
    const f = { link: 'tcp', up: true, p99_ms: 14.95, n: 3, nested: { a: 1 }, none: null };
    expect(summary(f, { pure: true, spanOf })).toBe('link tcp · up yes · p99 <14950µs> · n 3 · nested {"a":1} · none –');
    // Earth mode keeps the span and adds the Earth value after ⊕
    expect(summary(f, { pure: false, spanOf })).toBe('link tcp · up yes · p99 <14950µs> ⊕ 14.95 ms · n 3 · nested {"a":1} · none –');
    // names in words; an instant a field carries never as a date in pure mode; a measure without its unit
    expect(summary({ reset_reason: 1, expires_at: '2026-11-13T20:07:04.171Z', supply_mv: 3712 }, { pure: true, spanOf })).toBe('reset reason 1 · expires – · supply voltage 3712');
    expect(summary({ expires_at: '2026-11-13T20:07:04.171Z' }, { pure: true, instant: () => 'in 3λ' })).toBe('expires in 3λ');
    expect(summary({ supply_mv: 3712 }, { pure: false })).toBe('supply voltage 3712 ⊕ 3712 mV');
    expect(summary({ message: 'timed out after 500 ms' }, { pure: true, say: (t) => t.replace(' after 500 ms', '') })).toBe('message timed out');
    // an identifier is shown as written, in both modes, whatever the text pass would make of it
    const mangle = (t: string) => `${t.replace(/\d/g, '')}!`;
    expect(summary({ usb_serial: '02:F2:00:00:00:02', mac: '02:6F:28:AB:CD:EF', device_id: 'n-12:00:05' }, { pure: true, say: mangle })).toBe(
      'usb serial 02:F2:00:00:00:02 · mac 02:6F:28:AB:CD:EF · device id n-12:00:05',
    );
    expect(summary({ usb_serial: '02:F2:00:00:00:02' }, { pure: false, say: mangle })).toBe('usb serial 02:F2:00:00:00:02');
    // no core yet: the bare name, never the Earth unit, in pure mode
    expect(summary({ rtt_ms: 9 }, { pure: true })).toBe('rtt 9');
    expect(summary(undefined, { pure: true })).toBe('');
  });

  it('cuts a long line', () => {
    const s = summary({ text: 'x'.repeat(400) }, { pure: false, max: 20 });
    expect(s).toHaveLength(20);
    expect(s.endsWith('…')).toBe(true);
  });

  it('writes the open row as JSON, durations as spans in pure mode', () => {
    expect(JSON.parse(fieldsText({ held_ms: 400, code: 'x' }, { pure: true, spanOf }))).toEqual({ held: '<400000µs>', code: 'x' });
    expect(JSON.parse(fieldsText({ held_ms: 400 }, { pure: false, spanOf }))).toEqual({ held: '<400000µs> ⊕ 400 ms' });
    expect(JSON.parse(fieldsText({ expires_at: '2026-11-13T20:07:04.171Z', n: 2 }, { pure: true, spanOf }))).toEqual({ expires: '–', n: 2 });
    expect(fieldsText({}, { pure: true })).toBe('');
  });
});
