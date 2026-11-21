// A board flashed at one hub for another (spec 06 §6.4 "For another hub"): device_provision takes `for_hub`, and
// device_enroll is the op it calls on the other hub. Their place in the registry, their CLI paths, the schemas, and
// the REGISTRY_HASH they move.
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { EnrolledSchema, findOp, hubApiUrl, OP_NAMES, OPS, ProvisionResultSchema, REGISTRY_CHIPS, REGISTRY_HASH } from '../src/index.ts';

/**
 * The ops as they were here, before one network had several hubs (design multi-hub-m1; protocol-multi-hub.test.ts):
 * without its four ops, device_enroll with chip and profile required and no explicit identity, and device_provision's
 * for_hub as it read.
 */
const label = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/, 'expected a name of letters, digits, ".", "_" and "-"');
const forHub = OPS.filter((o) => !/^device_(hubs_set|hubs_get|share)$|^network_join$|^network_admit$|^hub_(name_set|peers)$/.test(o.name)).map((o) => [
  o.name,
  z.toJSONSchema(
    o.name === 'device_enroll'
      ? (o.input as z.ZodObject)
          .omit({ addr: true, net: true, alias_rev: true, epoch_floor: true })
          .extend({ chip: z.enum(REGISTRY_CHIPS).describe('the probed chip'), profile: label.describe('the profile of the firmware being written, e.g. c6-pad') })
      : o.name === 'device_provision'
        ? (o.input as z.ZodObject).extend({
            for_hub: hubApiUrl
              .optional()
              .describe(
                "provision the board for another hub: the base URL of that hub's API, e.g. http://127.0.0.1:7520 (an SSH tunnel to it). That hub registers the board (device_enroll) and the board connects to it; the Wi-Fi is still this hub's stored network",
              ),
          })
        : o.input,
  ),
]);

describe('provisioning for another hub', () => {
  it('adds device_enroll after device_provision, on `fr devices enroll <device_id>`, and moves REGISTRY_HASH', () => {
    expect(forHub).toHaveLength(124);
    expect(OP_NAMES[OP_NAMES.indexOf('device_provision') + 1]).toBe('device_enroll');
    expect(findOp('device_enroll')).toMatchObject({ kind: 'command', tier: 'mutate', destructive: true, cli: { path: ['devices', 'enroll'], positional: ['device_id'] } });
    expect(findOp('device_enroll')!.summary.length).toBeLessThan(1000);
    expect(findOp('device_provision')!.summary.length).toBeLessThan(1000);
    expect(findOp('device_provision')!.summary).toContain('for_hub');
    expect(createHash('sha256').update(JSON.stringify(forHub)).digest('hex').slice(0, 12)).toBe('fc936a53d2f2');
    expect(REGISTRY_HASH).not.toBe('fc936a53d2f2'); // protocol-multi-hub.test.ts pins the current one
    expect(REGISTRY_HASH).not.toBe('4c2515061881'); // the dashboard's health (protocol-hub-health.test.ts)
  });

  it('device_provision takes for_hub: scheme, host and port of a hub API, nothing else', () => {
    const input = findOp('device_provision')!.input;
    expect(input.parse({ port: 'a0b1c2d3e4f5' })).toEqual({ port: 'a0b1c2d3e4f5' });
    for (const ok of ['http://127.0.0.1:7520', 'http://127.0.0.1:7520/', 'http://home-hub.local:7520', 'https://hub.example', 'http://[::1]:7520']) {
      expect(hubApiUrl.safeParse(ok).success, ok).toBe(true);
      expect(input.safeParse({ port: 'a0b1c2d3e4f5', for_hub: ok }).success, ok).toBe(true);
    }
    for (const bad of ['', '127.0.0.1:7520', 'home-hub.local', 'ws://127.0.0.1:7520', 'http://127.0.0.1:7520/api/v1', 'http://127.0.0.1:7520/?a=1', 'http://127.0.0.1:7520#x', 'http://user:secret@127.0.0.1:7520', 'http://127.0.0.1:7520 ', 'http://']) {
      expect(hubApiUrl.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('device_enroll names the board, its chip and its profile; no input or output is a Wi-Fi credential', () => {
    const op = findOp('device_enroll')!;
    const base = { device_id: 'a0b1c2d3e4f5', chip: 'esp32c6', profile: 'c6-pad' };
    expect(op.input.parse(base)).toEqual(base);
    for (const chip of REGISTRY_CHIPS) {
      expect(op.input.safeParse({ ...base, chip }).success, chip).toBe(true);
    }
    for (const bad of [{ ...base, device_id: 'a0:b1:c2:d3:e4:f5' }, { ...base, device_id: 'a0b1c2d3e4' }, { ...base, chip: 'esp8266' }, { ...base, profile: '' }, { ...base, profile: 'a/b' }, { ...base, fw_id: 'xyz' }, { ...base, ident_size: 0 }, { ...base, network: 'Home Net' }]) {
      expect(op.input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    // addr, net, alias_rev and epoch_floor came with design multi-hub-m1 (the identity a board already has).
    expect(Object.keys(op.input.shape)).toEqual(['device_id', 'chip', 'profile', 'board', 'part_profile', 'build_id', 'fw_id', 'ident_offset', 'ident_size', 'alias', 'network', 'addr', 'net', 'alias_rev', 'epoch_floor']);
    expect(op.output).toBe(EnrolledSchema);
    expect(Object.keys(EnrolledSchema.shape)).toEqual(['device_id', 'addr', 'net', 'alias', 'alias_rev', 'epoch_floor', 'hub_host', 'hub_ip', 'network', 'new', 'tags', 'adopt']);
  });

  it('checks what the other hub answers before it goes into fr_ident', () => {
    const ok = { device_id: 'a0b1c2d3e4f5', addr: 7, net: 41235, alias: 'kitchen-cam', alias_rev: 1, epoch_floor: 1, hub_host: 'home-hub.local', hub_ip: '192.0.2.7', network: 'default', new: true, tags: ['new'] };
    expect(EnrolledSchema.parse(ok)).toEqual(ok);
    expect(EnrolledSchema.safeParse({ ...ok, hub_ip: null }).success).toBe(true);
    for (const bad of [{ ...ok, addr: 0 }, { ...ok, addr: 0xf000 }, { ...ok, net: 0 }, { ...ok, net: 0x10000 }, { ...ok, epoch_floor: 0 }, { ...ok, alias_rev: 0 }, { ...ok, hub_host: 'home hub\nssid,data,string,x' }, { ...ok, hub_host: '' }, { ...ok, hub_ip: 'not-an-ip' }]) {
      expect(EnrolledSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("the job result says which hub the board was provisioned for", () => {
    const r = { device_id: 'a0b1c2d3e4f5', alias: 'kitchen-cam', profile: 'c6-pad', build_id: 'node/c6-pad/debug/aa11', fw_id: 'aa11', wifi: 'joined' as const, via: 'tcp' as const, for_hub: 'http://127.0.0.1:7520' };
    expect(ProvisionResultSchema.parse(r)).toEqual(r);
  });
});
