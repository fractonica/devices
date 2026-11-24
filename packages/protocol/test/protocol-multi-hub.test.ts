// One network, several hubs (design multi-hub-m1): the four ops at the end of the registry (a board's hub list, a
// board's row for another hub, joining a network), device_enroll's explicit identity, fr.node 1.1's hub list commands,
// and the REGISTRY_HASH they move.
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DeviceHubsSchema, findOp, hubEntry, MULTI_HUB_OPS, OPS, REGISTRY_HASH, REGISTRY_INPUTS_HASH } from '../src/index.ts';
import { decodeNodeHubsGetResult, decodeNodeHubsSetArgs, encodeNodeHubsGetResult, encodeNodeHubsSetArgs, findCap } from '../src/gen/index.ts';

/** The ops as they were here, before the hubs' link added its three (design multi-hub-m2; protocol-peers.test.ts). */
const m1 = OPS.filter((o) => !/^network_admit$|^hub_(name_set|peers)$|^haptic_tap$/.test(o.name));
const hashOf = (ops: readonly { name: string; input: z.ZodType }[]) =>
  createHash('sha256')
    .update(JSON.stringify(ops.map((o) => [o.name, z.toJSONSchema(o.input)])))
    .digest('hex')
    .slice(0, 12);

describe('multi-hub ops', () => {
  it('adds four ops at the end, on `fr devices hubs set|get`, `fr devices share` and `fr net join`, and moves REGISTRY_HASH', () => {
    expect(m1).toHaveLength(128);
    expect(m1.slice(-4).map((o) => o.name)).toEqual(['device_hubs_set', 'device_hubs_get', 'device_share', 'network_join']);
    expect(MULTI_HUB_OPS.map((o) => o.name)).toEqual(m1.slice(-4).map((o) => o.name));
    expect(findOp('device_hubs_set')).toMatchObject({ kind: 'command', tier: 'mutate', cli: { path: ['devices', 'hubs', 'set'], positional: ['device'] } });
    expect(findOp('device_hubs_get')).toMatchObject({ kind: 'query', tier: 'read', cli: { path: ['devices', 'hubs', 'get'], positional: ['device'] } });
    expect(findOp('device_share')).toMatchObject({ kind: 'command', tier: 'mutate', cli: { path: ['devices', 'share'], positional: ['device'] } });
    expect(findOp('network_join')).toMatchObject({ kind: 'command', tier: 'mutate', destructive: true, cli: { path: ['net', 'join'] } });
    for (const o of MULTI_HUB_OPS) {
      expect(o.summary.length, o.name).toBeLessThan(1000);
    }
    expect(findOp('device_enroll')!.summary.length).toBeLessThan(1000);
    expect(findOp('device_provision')!.summary.length).toBeLessThan(1000);
    // network_join's input did not change with the hubs' link (its answer did), so these ops still hash as they did.
    expect(hashOf(m1)).toBe('b6d669a67036');
    expect(hashOf(m1)).not.toBe('fc936a53d2f2'); // a board for another hub (protocol-for-hub.test.ts)
    expect(REGISTRY_INPUTS_HASH).not.toBe(hashOf(m1)); // the hubs' link moved it (protocol-peers.test.ts)
  });

  it('device_hubs_set takes up to four hubs in priority order, each a host or host/ipv4, or none', () => {
    const input = findOp('device_hubs_set')!.input;
    expect(input.parse({ device: 'pad-c6', hub: ['lab-hub.local', 'home-hub.local/192.168.1.30'] })).toEqual({ device: 'pad-c6', hub: ['lab-hub.local', 'home-hub.local/192.168.1.30'], none: false });
    expect(input.parse({ device: 'pad-c6', none: true })).toEqual({ device: 'pad-c6', hub: [], none: true });
    for (const ok of ['lab-hub.local', '192.168.1.20', 'hub.example.org', 'lab-hub.local/10.0.0.7', 'a']) {
      expect(hubEntry.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['', '.local', '-hub', 'lab hub.local', 'lab-hub.local:7421', 'lab-hub.local/', 'lab-hub.local/10.0.0', 'http://lab-hub.local', 'lab-hub.local/home-hub.local', 'a'.repeat(64)]) {
      expect(hubEntry.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(input.safeParse({ device: 'pad-c6', hub: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(false);
    expect(input.safeParse({ hub: ['lab-hub.local'] }).success).toBe(false);
    const out = { device_id: 'a0b1c2d3e4f5', alias: 'pad-c6', hubs: [{ host: 'lab-hub.local', ip: null }, { host: 'home-hub.local', ip: '192.168.1.30' }], rev: 3, on: 0, trial: false };
    expect(DeviceHubsSchema.parse(out)).toEqual(out);
    expect(DeviceHubsSchema.parse({ ...out, on: null, trial: null, left: true })).toMatchObject({ on: null, left: true });
    expect(findOp('device_hubs_set')!.output).toBe(DeviceHubsSchema);
    expect(findOp('device_hubs_get')!.output).toBe(DeviceHubsSchema);
  });

  it('device_share and network_join name the other hub by the base URL of its API', () => {
    const share = findOp('device_share')!.input;
    expect(share.parse({ device: 'pad-c6', with_hub: 'http://127.0.0.1:7520' })).toEqual({ device: 'pad-c6', with_hub: 'http://127.0.0.1:7520' });
    const join = findOp('network_join')!.input;
    expect(join.parse({ hub: 'http://127.0.0.1:7420' })).toEqual({ hub: 'http://127.0.0.1:7420', force: false });
    for (const bad of ['home-hub.local', 'http://127.0.0.1:7520/api/v1', 'http://user:secret@127.0.0.1:7520']) {
      expect(share.safeParse({ device: 'pad-c6', with_hub: bad }).success, bad).toBe(false);
      expect(join.safeParse({ hub: bad }).success, bad).toBe(false);
    }
    expect(share.safeParse({ with_hub: 'http://127.0.0.1:7520' }).success).toBe(false);
    expect(join.safeParse({}).success).toBe(false);
  });

  it('device_enroll takes an explicit identity, and then needs neither chip nor profile', () => {
    const input = findOp('device_enroll')!.input;
    const shared = { device_id: 'a0b1c2d3e4f5', alias: 'pad-c6', addr: 7, net: 41235, alias_rev: 2, epoch_floor: 9 };
    expect(input.parse(shared)).toEqual(shared);
    expect(input.parse({ ...shared, chip: 'esp32c6', profile: 'c6-pad' })).toEqual({ ...shared, chip: 'esp32c6', profile: 'c6-pad' });
    for (const bad of [{ ...shared, addr: 0 }, { ...shared, addr: 0xf000 }, { ...shared, net: 0 }, { ...shared, net: 0x10000 }, { ...shared, alias_rev: 0 }, { ...shared, epoch_floor: 0 }, { ...shared, epoch_floor: 0x10000 }]) {
      expect(input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    // No field of it is a Wi-Fi credential, as before.
    expect(Object.keys(input.shape).some((k) => /pass|ssid|secret|key/.test(k))).toBe(false);
  });
});

describe('fr.node 1.1 (design multi-hub-m1)', () => {
  const node = findCap('fr.node')!;

  it('adds hubs_set and hubs_get after the bindings, both reliable and idempotent', () => {
    expect(node.version).toEqual({ major: 1, minor: 1 });
    expect(node.commands.map((c) => [c.name, c.id])).toEqual([
      ['identify', 1],
      ['describe', 2],
      ['reboot', 3],
      ['set_alias', 4],
      ['set_groups', 5],
      ['net_set', 6],
      ['get_state', 7],
      ['bind_set', 8],
      ['bind_clear', 9],
      ['bind_list', 10],
      ['hubs_set', 11],
      ['hubs_get', 12],
    ]);
    for (const name of ['hubs_set', 'hubs_get']) {
      expect(node.commands.find((c) => c.name === name), name).toMatchObject({ delivery: 'reliable', idempotent: true });
    }
  });

  it('a hub list round-trips: up to four hubs of host and ip, a rev, the hub it is on and the trial', () => {
    const args = { hubs: [{ host: 'lab-hub.local', ip: '192.168.1.20' }, { host: 'home-hub.local', ip: '' }], rev: 3 };
    const sent = decodeNodeHubsSetArgs(encodeNodeHubsSetArgs(args));
    expect(sent.ok && sent.value).toEqual(args);
    const none = decodeNodeHubsSetArgs(encodeNodeHubsSetArgs({ hubs: [], rev: 4 }));
    expect(none.ok && none.value).toEqual({ hubs: [], rev: 4 });
    expect(() => encodeNodeHubsSetArgs({ hubs: Array.from({ length: 5 }, (_, i) => ({ host: `h${i}.local`, ip: '' })), rev: 1 })).toThrow(RangeError);
    expect(() => encodeNodeHubsSetArgs({ hubs: [{ host: 'a'.repeat(64), ip: '' }], rev: 1 })).toThrow(RangeError);
    const result = { hubs: args.hubs, rev: 3, on: 1, trial: true };
    const got = decodeNodeHubsGetResult(encodeNodeHubsGetResult(result));
    expect(got.ok && got.value).toEqual(result);
    const off = decodeNodeHubsGetResult(encodeNodeHubsGetResult({ hubs: [], rev: 0, on: 255, trial: false }));
    expect(off.ok && off.value).toEqual({ hubs: [], rev: 0, on: 255, trial: false });
  });
});
