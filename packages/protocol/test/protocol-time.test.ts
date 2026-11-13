// Fractonica time ops (ops/time.ts): time_now, time_convert, time_ladder, time_next on `fr time …`, read-only, their
// input schemas and the REGISTRY_HASH they move.
import { describe, expect, it } from 'vitest';

import { findOp, LOCAL_TIME_OPS, OPS, REGISTRY_HASH, TIME_OPS } from '../src/index.ts';

describe('time ops', () => {
  it('adds four read-only queries at the end, on `fr time …`, and moves REGISTRY_HASH', () => {
    expect(OPS).toHaveLength(122);
    expect(OPS.slice(-4).map((o) => o.name)).toEqual(['time_now', 'time_convert', 'time_ladder', 'time_next']);
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
    expect(REGISTRY_HASH).toBe('d7907c2ee54a');
    expect(REGISTRY_HASH).not.toBe('050452ab10c2'); // before the time ops
  });

  it('takes an instant as text, pure by default, and bounds next', () => {
    expect(findOp('time_now')!.input.parse({})).toEqual({ earth: false });
    expect(findOp('time_now')!.input.parse({ at: '2026-10-08T12:00:00Z', earth: true })).toEqual({ at: '2026-10-08T12:00:00Z', earth: true });
    expect(findOp('time_convert')!.input.safeParse({}).success).toBe(false);
    expect(findOp('time_next')!.input.parse({ level: 'η' })).toEqual({ level: 'η', count: 5, earth: false });
    expect(findOp('time_next')!.input.safeParse({ level: 'η', quarter: 'noon' }).success).toBe(false);
    expect(findOp('time_next')!.input.safeParse({ level: 'η', count: 101 }).success).toBe(false);
  });
});
