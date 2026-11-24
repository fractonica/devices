// Fractonica time ops (ops/time.ts): time_now, time_convert, time_ladder, time_next on `fr time …`, read-only, their
// input schemas and the REGISTRY_HASH they move; and the time.threshold event's fields.
import { describe, expect, it } from 'vitest';

import { findOp, HUB_EVENT_FIELDS, HUB_EVENT_TYPES, LOCAL_TIME_OPS, OPS, REGISTRY_HASH, TIME_OPS } from '../src/index.ts';

describe('time ops', () => {
  it('adds four read-only queries at the end, on `fr time …`, and moves REGISTRY_HASH', () => {
    expect(OPS.filter((o) => o.name !== 'hub_doctor_fix' && o.name !== 'device_enroll' && !/^device_(hubs_set|hubs_get|share)$|^network_join$|^network_admit$|^hub_(name_set|peers)$|^haptic_tap$/.test(o.name))).toHaveLength(122); // the dashboard's health adds one (protocol-hub-health.test.ts), a board for another hub one (protocol-for-hub.test.ts)
    expect(OPS.filter((o) => !/^device_(hubs_set|hubs_get|share)$|^network_join$|^network_admit$|^hub_(name_set|peers)$|^haptic_tap$/.test(o.name)).slice(-4).map((o) => o.name)).toEqual(['time_now', 'time_convert', 'time_ladder', 'time_next']); // the multi-hub ops follow (protocol-multi-hub.test.ts)
    expect(LOCAL_TIME_OPS).toEqual(TIME_OPS.map((o) => o.name));
    for (const o of TIME_OPS) {
      expect(o, o.name).toMatchObject({ kind: 'query', tier: 'read' });
      expect(o.destructive, o.name).toBeUndefined();
      expect(o.summary.length, o.name).toBeLessThan(1000);
    }
    expect(findOp('time_now')!.cli.path).toEqual(['time']);
    expect(findOp('time_convert')!.cli).toEqual({ path: ['time', 'stamp'], positional: ['at'] });
    expect(findOp('time_ladder')!.cli.path).toEqual(['time', 'ladder']);
    expect(findOp('time_next')!.cli).toEqual({ path: ['time', 'next'], positional: ['level'] });
    expect(REGISTRY_HASH).not.toBe('b72ee2ac252c'); // the dashboard's health moved it (protocol-hub-health.test.ts)
    expect(REGISTRY_HASH).not.toBe('050452ab10c2'); // before the time ops
    expect(REGISTRY_HASH).not.toBe('d7907c2ee54a'); // time_next's quarter as an enum
  });

  it('takes an instant as text, pure by default, and bounds next', () => {
    expect(findOp('time_now')!.input.parse({})).toEqual({ earth: false });
    expect(findOp('time_now')!.input.parse({ at: '2026-10-08T12:00:00Z', earth: true })).toEqual({ at: '2026-10-08T12:00:00Z', earth: true });
    expect(findOp('time_convert')!.input.safeParse({}).success).toBe(false);
    expect(findOp('time_next')!.input.parse({ level: 'η' })).toEqual({ level: 'η', count: 5, earth: false });
    // the quarter is the core's word, read by the core (any case): the schema only asks for text
    expect(findOp('time_next')!.input.parse({ level: 'η', quarter: 'End' })).toMatchObject({ quarter: 'End' });
    expect(findOp('time_next')!.input.safeParse({ level: 'η', quarter: '' }).success).toBe(false);
    expect(findOp('time_next')!.input.safeParse({ level: 'η', count: 101 }).success).toBe(false);
  });

  it('names time.threshold among the hub events, with its fields', () => {
    expect(HUB_EVENT_TYPES.at(-1)).toBe('time.threshold');
    const ok = { level: 6, depth: 7, symbol: 'η', unit: 'Helion', quarter: 'end', cycle: '717211', at: '1791464172427759', stamp: 'α#6 β#4 γ#9 δ#3 ε#5 35η 0ι 0λ 0ν' };
    expect(HUB_EVENT_FIELDS['time.threshold'].safeParse(ok).success).toBe(true);
    expect(HUB_EVENT_FIELDS['time.threshold'].safeParse({ ...ok, unit: null }).success).toBe(true);
    expect(HUB_EVENT_FIELDS['time.threshold'].safeParse({ ...ok, at: 1791464172427759 }).success).toBe(false);
  });
});
