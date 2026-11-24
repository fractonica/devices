// The hubs' link, step 2.1 (design multi-hub-m2 §2-§4, §6, §9): the three ops at the end of the registry (the
// registrar's half of a join, a hub's name, the peers), what joins the answers of older ops (a hub's identity, the
// member list, where a board is), and the REGISTRY_HASH they move. No schema here has a field for the network key.
import { describe, expect, it } from 'vitest';

import {
  AdmittedSchema,
  DeviceViewSchema,
  EPOCH_SLOTS,
  findOp,
  HUB_NAME_RE,
  HubIdentitySchema,
  HubMemberSchema,
  HubNowSchema,
  HubPeerSchema,
  HubStatusSchema,
  OPS,
  PEER_LINK_PORT,
  PEER_OPS,
  type OpDef,
  REGISTRY_HASH,
  REGISTRY_INPUTS_HASH,
  registryHashOf,
  registryInputsHashOf,
  SealedKeySchema,
} from '../src/index.ts';

const PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64');
const member = { id: '5d1c20a0b1c2', name: 'lab', host: 'lab-hub.local', addr: '192.168.1.20', link_port: 7423, slot: 0, joined_at: '2026-11-21T10:00:00.000Z' };
const sealed = { alg: 'x25519-hkdf-sha256-aes256gcm', epk: 'AA==', salt: 'AA==', nonce: 'AA==', ct: 'AA==', tag: 'AA==' };

describe("the hubs' link ops", () => {
  it('adds three ops at the end, on `fr net admit`, `fr hub name` and `fr hub peers`, and moves REGISTRY_HASH', () => {
    expect(OPS.filter((o) => o.name !== 'haptic_tap')).toHaveLength(131); // HAPTIC-1 adds haptic_tap (protocol-haptic-h1.test.ts)
    expect(OPS.slice(-3).map((o) => o.name)).toEqual(['network_admit', 'hub_name_set', 'hub_peers']);
    expect(PEER_OPS.map((o) => o.name)).toEqual(OPS.slice(-3).map((o) => o.name));
    expect(findOp('network_admit')).toMatchObject({ kind: 'command', tier: 'mutate', cli: { path: ['net', 'admit'] } });
    expect(findOp('hub_name_set')).toMatchObject({ kind: 'command', tier: 'mutate', cli: { path: ['hub', 'name'], positional: ['name'] } });
    expect(findOp('hub_peers')).toMatchObject({ kind: 'query', tier: 'read', cli: { path: ['hub', 'peers'] } });
    for (const o of [...PEER_OPS, findOp('network_join')!]) {
      expect(o.summary.length, o.name).toBeLessThan(1000);
    }
    // Step 2.1's hash is the hash of the names and inputs to this day: step 2.2 changed no input and added no op. It
    // moved REGISTRY_HASH by what joined it, where each op runs (protocol-targets.test.ts).
    const beforeHaptic = OPS.filter((o) => o.name !== 'haptic_tap') as readonly OpDef[];
    expect(registryInputsHashOf(beforeHaptic)).toBe('7113df84c91b');
    expect(registryHashOf(beforeHaptic)).toBe('8910d0ce4075');
    expect(REGISTRY_HASH).not.toBe('8910d0ce4075'); // HAPTIC-1's haptic_tap moved it (protocol-haptic-h1.test.ts)
    expect(REGISTRY_INPUTS_HASH).not.toBe('b6d669a67036'); // one network, several hubs (protocol-multi-hub.test.ts)
    expect(PEER_LINK_PORT).toBe(7423);
    expect(EPOCH_SLOTS).toBe(4);
  });

  it('a hub name is a lowercase label of at most 31 characters', () => {
    const input = findOp('hub_name_set')!.input;
    for (const ok of ['lab', 'attic', 'hub-2', 'a', '7', 'a'.repeat(31)]) {
      expect(input.safeParse({ name: ok }).success, ok).toBe(true);
      expect(HUB_NAME_RE.test(ok)).toBe(true);
    }
    for (const bad of ['', 'Lab', 'lab hub', 'lab.local', '-lab', 'lab-', 'lab_1', 'a'.repeat(32)]) {
      expect(input.safeParse({ name: bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(input.safeParse({}).success).toBe(false);
  });

  it('network_admit takes a hub id, a name, where the hub is reached and a public key; it answers the key only sealed', () => {
    const input = findOp('network_admit')!.input;
    const ask = { hub_id: 'a0b1c2d3e4f5', name: 'attic', host: 'attic.local', addr: '192.168.1.30', link_port: 7423, public_key: PUBLIC_KEY };
    expect(input.parse(ask)).toEqual(ask);
    const { addr: _addr, ...noAddr } = ask;
    expect(input.safeParse(noAddr).success).toBe(true); // a hub that knows no LAN address of its own
    for (const bad of [
      { ...ask, hub_id: 'A0B1C2D3E4F5' },
      { ...ask, hub_id: 'a0b1c2' },
      { ...ask, name: 'Uriel' },
      { ...ask, host: 'attic local' },
      { ...ask, addr: 'attic.local' },
      { ...ask, link_port: 0 },
      { ...ask, link_port: 65536 },
      { ...ask, public_key: 'short' },
      { ...ask, public_key: Buffer.alloc(31).toString('base64') },
      { ...ask, public_key: Buffer.alloc(33).toString('base64') },
    ]) {
      expect(input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    // Nothing the caller sends or the registrar answers is the key in the clear: the answer has a sealed blob only.
    expect(Object.keys(input.shape).sort()).toEqual(['addr', 'host', 'hub_id', 'link_port', 'name', 'public_key']);
    expect(findOp('network_admit')!.output).toBe(AdmittedSchema);
    expect(Object.keys(AdmittedSchema.shape).sort()).toEqual(['hub', 'members', 'members_version', 'net_id', 'registrar', 'sealed']);
    expect(Object.keys(SealedKeySchema.shape).sort()).toEqual(['alg', 'ct', 'epk', 'nonce', 'salt', 'tag']);
    const out = { net_id: 41235, hub: { id: 'a0b1c2d3e4f5', name: 'attic', slot: 1 }, registrar: { id: member.id, name: 'lab' }, members: [member], members_version: 2, sealed };
    expect(AdmittedSchema.parse(out)).toEqual(out);
    expect(AdmittedSchema.safeParse({ ...out, hub: { ...out.hub, slot: 4 } }).success).toBe(false);
    expect(AdmittedSchema.safeParse({ ...out, sealed: { ...sealed, alg: 'none' } }).success).toBe(false);
    for (const schema of [HubMemberSchema, HubPeerSchema, HubIdentitySchema, AdmittedSchema]) {
      expect(Object.keys(schema.shape).some((k) => /key|secret|psk|pass/.test(k))).toBe(false);
    }
  });

  it('hub_peers answers one row per hub of the network', () => {
    const out = findOp('hub_peers')!.output!;
    const row = { id: member.id, name: 'lab', this: false, role: 'registrar', slot: 0, host: 'lab-hub.local', reachable: true, since: '2026-11-21T10:00:00.000Z', registry_hash: 'b6d669a67036', hub_epoch: 12, boards: 3, address: '192.168.1.20:7423' };
    const view = { net_id: 41235, hub: { id: 'a0b1c2d3e4f5', name: 'attic', slot: 1 }, registrar: 'lab', members_version: 2, link: { listening: true, port: 7423, error: null }, peers: [row] };
    expect(out.parse(view)).toEqual(view);
    // A peer never reached in this hub run, with why.
    const away = { ...row, reachable: false, since: null, registry_hash: null, hub_epoch: null, boards: null, address: null, last_error: '192.168.1.20:7423: ECONNREFUSED' };
    expect(HubPeerSchema.parse(away)).toEqual(away);
    expect(findOp('hub_peers')!.input.parse({})).toEqual({});
  });
});

describe("what the hubs' link adds to older answers", () => {
  it('hub_status says who this hub is; network_join what it was admitted as and the members', () => {
    expect(HubStatusSchema.shape.hub.parse({ id: member.id, name: 'lab', slot: null })).toEqual({ id: member.id, name: 'lab', slot: null });
    expect(HubStatusSchema.shape.hub.safeParse(undefined).success).toBe(true); // an older hub
    const join = findOp('network_join')!;
    const answer = { net_id: 41235, previous_net_id: null, registrar: 'http://127.0.0.1:7420', networks: [], foreign: [], hub: { id: 'a0b1c2d3e4f5', name: 'attic', slot: 1 }, members: [member] };
    expect(join.output!.parse(answer)).toEqual(answer);
    // Its input is as MULTI-HUB-1 left it: the join of an upgraded hub is the same call.
    expect(Object.keys(join.input.shape).sort()).toEqual(['force', 'hub']);
  });

  it('a device row says at which hub the board is; hub_now too, with the time of the board\'s answer as asked_at', () => {
    const row = { device_id: 'a0b1c2d3e4f5', addr: 7, alias: 'pad-c6', alias_rev: 1, net: 41235, board: null, profile: null, chip: null, tags: [], role: 'node', fw_id: null, provisioned: true, last_seen: null, last_epoch: null, created_at: 'x', presence: 'offline' };
    expect(DeviceViewSchema.parse({ ...row, at: 'attic' }).at).toBe('attic');
    expect(DeviceViewSchema.parse({ ...row, at: null }).at).toBeNull();
    expect(DeviceViewSchema.parse(row).at).toBeUndefined(); // an older hub
    const now = { here: false, on: 1, rev: 3, trial: false, at: 'attic', asked_at: '2026-11-21T10:00:00.000Z' };
    expect(HubNowSchema.parse(now)).toEqual(now);
    expect(HubNowSchema.parse({ here: false, on: null, rev: null, trial: null, at: null })).toMatchObject({ at: null });
  });
});
