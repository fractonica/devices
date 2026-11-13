// The port policy ops (config.json ports): port_lend, port_ignore and port_claim on `fr ports …`, the port states
// and policy reasons port_list carries, and the REGISTRY_HASH they move.
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { findOp, OPS, PORT_STATES, PortInfoSchema, PortPolicyResultSchema, REGISTRY_HASH } from '../src/index.ts';

const hashOf = (ops: readonly { name: string; input: z.ZodType }[]) =>
  createHash('sha256').update(JSON.stringify(ops.map((o) => [o.name, z.toJSONSchema(o.name === 'hub_doctor' && !ops.some((x) => x.name === 'hub_doctor_fix') ? z.object({}) : o.input) /* hub_doctor had no input before the dashboard's health */]))).digest('hex').slice(0, 12);
/** The registry before the time ops (protocol-time.test.ts) came after the port ops. */
const beforeTime = OPS.filter((o) => !o.name.startsWith('time_') && o.name !== 'hub_doctor_fix');

describe('port policy ops', () => {
  it('adds three ops on `fr ports lend|ignore|claim <port>` and moves REGISTRY_HASH', () => {
    expect(beforeTime).toHaveLength(118);
    expect(findOp('port_lend')).toMatchObject({ kind: 'command', tier: 'mutate', cli: { path: ['ports', 'lend'], positional: ['port'] } });
    expect(findOp('port_ignore')).toMatchObject({ kind: 'command', tier: 'mutate', cli: { path: ['ports', 'ignore'], positional: ['port'] } });
    expect(findOp('port_claim')).toMatchObject({ kind: 'command', tier: 'mutate', cli: { path: ['ports', 'claim'], positional: ['port'] } });
    expect(findOp('port_lend')!.input.parse({ port: '/dev/cu.usbmodem1101' })).toEqual({ port: '/dev/cu.usbmodem1101', ttl_s: 600 });
    expect(findOp('port_lend')!.input.safeParse({ port: 'x', ttl_s: 1801 }).success).toBe(false);
    expect(findOp('port_ignore')!.input.parse({ port: '1a86:7523' })).toEqual({ port: '1a86:7523', remove: false });
    for (const name of ['port_lend', 'port_ignore', 'port_claim']) {
      expect(findOp(name)!.summary.length, name).toBeLessThan(1000);
    }
    expect(hashOf(beforeTime)).toBe('050452ab10c2');
    expect(REGISTRY_HASH).not.toBe('c930b40dea94'); // before the port policy
  });

  it('carries the policy states and reasons in port_list rows', () => {
    expect(PORT_STATES).toEqual(['open', 'closed', 'leased', 'busy_external', 'error', 'unwatched', 'ignored']);
    expect(PortInfoSchema.safeParse({ path: '/dev/cu.usbmodem1101', state: 'unwatched', policy: 'not_adopted', lines: 0 }).success).toBe(true);
    expect(PortInfoSchema.safeParse({ path: '/dev/cu.usbmodem1101', state: 'open', policy: 'adopted', alias: 'pad-c6', lines: 3 }).success).toBe(true);
    expect(PortInfoSchema.safeParse({ path: 'p', state: 'open', policy: 'maybe', lines: 0 }).success).toBe(false);
    expect(PortPolicyResultSchema.safeParse({ port: 'x', mode: 'adopted', ignore: [], claim: ['x'], config: '/tmp/config.json' }).success).toBe(true);
  });
});
