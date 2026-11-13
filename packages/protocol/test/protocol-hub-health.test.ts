// The dashboard's hub health (stage 4): hub_doctor answers its last result when asked for one no older than
// max_age_s (checked_at says when it ran), and hub_doctor_fix runs `fr doctor --fix`'s fixes in the hub process.
import { describe, expect, it } from 'vitest';

import { findOp, OPS, REGISTRY_HASH } from '../src/index.ts';

describe('hub health ops', () => {
  it('gives hub_doctor a max_age_s and adds hub_doctor_fix as a mutating command on `fr hub doctor-fix`', () => {
    expect(OPS).toHaveLength(123);
    expect(findOp('hub_doctor')).toMatchObject({ kind: 'query', tier: 'read' });
    expect(findOp('hub_doctor')!.input.parse({})).toEqual({});
    expect(findOp('hub_doctor')!.input.parse({ max_age_s: 600 })).toEqual({ max_age_s: 600 });
    expect(findOp('hub_doctor')!.input.safeParse({ max_age_s: -1 }).success).toBe(false);
    expect(findOp('hub_doctor')!.output!.safeParse({ checks: [], checked_at: '2026-11-13T20:00:00.000Z' }).success).toBe(true);
    expect(findOp('hub_doctor_fix')).toMatchObject({ kind: 'command', tier: 'mutate', cli: { path: ['hub', 'doctor-fix'] } });
    expect(findOp('hub_doctor_fix')!.summary.length).toBeLessThan(1000);
    // `ids` runs only the fixes a person chose (one check's Run fix); absent, every fix
    expect(findOp('hub_doctor_fix')!.input.parse({})).toEqual({});
    expect(findOp('hub_doctor_fix')!.input.parse({ ids: ['pytools'] })).toEqual({ ids: ['pytools'] });
    expect(findOp('hub_doctor_fix')!.input.safeParse({ ids: [] }).success).toBe(false);
    expect(REGISTRY_HASH).toBe('4c2515061881'); // '88f3b29c39ea' before hub_doctor_fix took `ids`
  });
});
