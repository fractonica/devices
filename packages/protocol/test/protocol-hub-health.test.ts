// The dashboard's hub health (stage 4): hub_doctor answers its last result when asked for one no older than
// max_age_s (checked_at says when it ran), and hub_doctor_fix runs `fr doctor --fix`'s fixes in the hub process.
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { findOp, OPS, REGISTRY_HASH } from '../src/index.ts';

/** The ops as they were here: before a board for another hub (device_enroll, device_provision for_hub; protocol-for-hub.test.ts). */
const health = OPS.filter((o) => o.name !== 'device_enroll' && !/^device_(hubs_set|hubs_get|share)$|^network_join$|^network_admit$|^hub_(name_set|peers)$/.test(o.name)).map((o) => [o.name, z.toJSONSchema(o.name === 'device_provision' ? (o.input as z.ZodObject).omit({ for_hub: true }) : o.input)]);

describe('hub health ops', () => {
  it('gives hub_doctor a max_age_s and adds hub_doctor_fix as a mutating command on `fr hub doctor-fix`', () => {
    expect(health).toHaveLength(123);
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
    expect(createHash('sha256').update(JSON.stringify(health)).digest('hex').slice(0, 12)).toBe('4c2515061881'); // '88f3b29c39ea' before hub_doctor_fix took `ids`
    expect(REGISTRY_HASH).not.toBe('4c2515061881'); // protocol-for-hub.test.ts pins the current one
  });
});
