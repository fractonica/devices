// The hubs' link, step 2.1 (design multi-hub-m2 §3, §4, §6, §9), piece by piece and without a hub process: epoch slots
// (the arithmetic and its wrap), the network key in secrets.json and sealed for a join, the member list's rules, the
// frames, the TLS link itself between PeerLinks instances on loopback (a wrong key, another network, an unknown hub, one
// connection per pair, a silent peer, reconnecting), the router's serial rule, two hubs' routers and peers parts in
// this process (who is where, the cable, the member list over the link), and a join against a hub from before the
// link. interop-peers.test.ts runs it through real hub processes and the C++ node.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FrError } from '@fractonica/protocol';

import { type Db, EPOCH_SLOT_SIZE, epochInSlot, HUB_SLOT_KEY, hubSlot, kvSet, nextHubEpoch, openDb, slotEpoch } from '../src/db.ts';
import type { HubContext, HubRunOptions } from '../src/context.ts';
import { readSecrets, registrarOf, writeNetwork, writeWifiPassword } from '../src/network.ts';
import { advertised, hubId, hubIdentity, hubName, nameFromHost, setHubName } from '../src/peers/identity.ts';
import { boardAt, candidatesOf, createPeers, type Peers, peersView } from '../src/peers/index.ts';
import { admissionKeys, newNetworkKey, openSealed, pskIdentity, readNetworkKey, sealKey, writeNetworkKey } from '../src/peers/key.ts';
import { type HelloInfo, type LinkTarget, PeerLinks, type PeerLinkTiming, type PeerView } from '../src/peers/link.ts';
import { admitMember, bumpMembers, listMembers, membersVersion, noteSeen, publicMember, putRegistrar, replaceMembers } from '../src/peers/members.ts';
import { join as joinNetworkOf } from '../src/registry/share.ts';
import { encodeControl, FRAME_DATA, FrameDecoder, HelloSchema, MAX_FRAME_BYTES, type PeerMessage, WireError } from '../src/peers/wire.ts';
import { type Rig, rig, until } from './fake-node.ts';

let home = '';
const savedHome = process.env.FR_HOME;
let dbs = 0;
const cleanups: (() => unknown)[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'fr-peers-test-'));
  process.env.FR_HOME = home;
});
afterAll(() => {
  if (savedHome === undefined) {
    delete process.env.FR_HOME;
  } else {
    process.env.FR_HOME = savedHome;
  }
  rmSync(home, { recursive: true, force: true });
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

function freshDb(): Db {
  const db = openDb(join(home, `peers-${++dbs}.db`));
  cleanups.push(() => db.close());
  return db;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- epoch slots (§9) ----

describe('epoch slots (design multi-hub-m2 §9)', () => {
  it('a slot is a quarter of the u16 space: slot * 0x4000 + run, the run from 1 to 0x3FFF and wrapping inside it', () => {
    expect(EPOCH_SLOT_SIZE).toBe(0x4000);
    expect(slotEpoch(0, 0)).toBe(1);
    expect(slotEpoch(0, 1)).toBe(2);
    expect(slotEpoch(0, 0x3ffe)).toBe(0x3fff);
    expect(slotEpoch(0, 0x3fff)).toBe(1); // the wrap, never 0
    expect(slotEpoch(1, 0x4001)).toBe(0x4002);
    expect(slotEpoch(1, 0x7ffe)).toBe(0x7fff);
    expect(slotEpoch(1, 0x7fff)).toBe(0x4001); // the wrap stays in the slot: 0x8000 is no run of any slot
    expect(slotEpoch(2, 0xbfff)).toBe(0x8001);
    expect(slotEpoch(3, 0xfffe)).toBe(0xffff);
    expect(slotEpoch(3, 0xffff)).toBe(0xc001);
    // A counter outside the slot (a hub that just got it) starts the slot's runs at 1.
    for (const [slot, prev] of [[1, 0], [1, 7], [1, 0x4000], [1, 0x8000], [1, 0xffff], [2, 0x4005], [3, 0xc000], [0, 0x4000], [0, 0x9000], [1, NaN], [2, -4], [3, 1.5]] as const) {
      expect(slotEpoch(slot, prev), `slot ${slot} after ${prev}`).toBe(slot * 0x4000 + 1);
    }
  });

  it('whatever the counter was, the next epoch is one of the hub\'s own slot: never 0, never another slot\'s', () => {
    for (let slot = 0; slot < 4; slot++) {
      for (let prev = 0; prev <= 0xffff; prev++) {
        const e = slotEpoch(slot, prev);
        if (e <= slot * 0x4000 || e > slot * 0x4000 + 0x3fff) {
          throw new Error(`slot ${slot} after ${prev} gave ${e}`);
        }
      }
      expect(epochInSlot(slot * 0x4000, slot)).toBe(false);
      expect(epochInSlot(slot * 0x4000 + 1, slot)).toBe(true);
      expect(epochInSlot(slot * 0x4000 + 0x3fff, slot)).toBe(true);
      expect(epochInSlot((slot + 1) * 0x4000, slot)).toBe(false);
    }
  });

  it('two hubs that restart any number of times never give one epoch (equal run numbers included)', () => {
    const a = freshDb();
    const b = freshDb();
    kvSet(a, HUB_SLOT_KEY, '0');
    kvSet(b, HUB_SLOT_KEY, '1');
    const seenA = new Set<number>();
    const seenB = new Set<number>();
    // More starts than a slot has runs, so both wrap.
    kvSet(a, 'hub_epoch', String(0x3fff - 40));
    kvSet(b, 'hub_epoch', String(0x7fff - 40));
    for (let i = 0; i < 120; i++) {
      seenA.add(nextHubEpoch(a));
      seenB.add(nextHubEpoch(b));
    }
    expect(seenA.has(0) || seenB.has(0)).toBe(false);
    expect([...seenA].every((e) => epochInSlot(e, 0))).toBe(true);
    expect([...seenB].every((e) => epochInSlot(e, 1))).toBe(true);
    expect([...seenA].some((e) => seenB.has(e))).toBe(false);
    expect(seenA.has(0x3fff) && seenA.has(1)).toBe(true); // it wrapped
    expect(seenB.has(0x7fff) && seenB.has(0x4001)).toBe(true);
  });

  it('a hub with no slot counts the whole space as before; with one, from its next start on', () => {
    const db = freshDb();
    expect(hubSlot(db)).toBeNull();
    expect(nextHubEpoch(db)).toBe(1);
    expect(nextHubEpoch(db)).toBe(2);
    kvSet(db, 'hub_epoch', String(0xfffe));
    expect(nextHubEpoch(db)).toBe(0xffff);
    expect(nextHubEpoch(db)).toBe(1); // 0 is skipped
    // The registrar gives it slot 2: the next start is the first run of the slot, then it counts there.
    kvSet(db, HUB_SLOT_KEY, '2');
    expect(hubSlot(db)).toBe(2);
    expect(nextHubEpoch(db)).toBe(0x8001);
    expect(nextHubEpoch(db)).toBe(0x8002);
    for (const bad of ['4', '-1', 'x', '1.5']) {
      kvSet(db, HUB_SLOT_KEY, bad);
      expect(hubSlot(db), bad).toBeNull();
    }
  });

  it('a member whose counter MULTI-HUB-1 moved a quarter of the space away lands in its slot and stays there', () => {
    // MULTI-HUB-1's network_join set the counter to (registrar's epoch + 0x4000); the member has started five times since.
    const member = freshDb();
    kvSet(member, 'hub_epoch', String(3 + 0x4000 + 5));
    kvSet(member, HUB_SLOT_KEY, '1'); // what the re-join gives the second hub of a network
    expect(nextHubEpoch(member)).toBe(3 + 0x4000 + 6); // already in slot 1: it carries on, no jump back
    // Given another slot (a network's third hub), it starts that slot's runs.
    const third = freshDb();
    kvSet(third, 'hub_epoch', String(3 + 0x4000 + 5));
    kvSet(third, HUB_SLOT_KEY, '2');
    expect(nextHubEpoch(third)).toBe(0x8001);
    // The counter MULTI-HUB-1 left at 0x4000 exactly (a registrar at epoch 0xFFFF: (0xFFFF + 0x4000) % 0xFFFF).
    const edge = freshDb();
    kvSet(edge, 'hub_epoch', String(0x4000));
    kvSet(edge, HUB_SLOT_KEY, '1');
    expect(nextHubEpoch(edge)).toBe(0x4001);
  });
});

// ---- identity ----

describe('a hub\'s identity', () => {
  it('the id is made once per hub.db: 12 lowercase hex', () => {
    const db = freshDb();
    const id = hubId(db);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(hubId(db)).toBe(id);
    expect(hubId(freshDb())).not.toBe(id);
  });

  it('the name is the host name without its domain, lower-cased, until it is given one', () => {
    expect(nameFromHost('Lab-Hub.local')).toBe('lab-hub');
    expect(nameFromHost('attic.lan.example.org')).toBe('attic');
    expect(nameFromHost("Someone's Mac")).toBe('someone-s-mac');
    expect(nameFromHost('-x_')).toBe('x');
    expect(nameFromHost('a'.repeat(40))).toBe('a'.repeat(31));
    expect(nameFromHost('')).toBe('hub');
    expect(nameFromHost('...')).toBe('hub');
    const db = freshDb();
    expect(hubName(db)).toMatch(/^[a-z0-9]([a-z0-9-]{0,29}[a-z0-9])?$/);
    setHubName(db, 'lab');
    expect(hubIdentity(db)).toEqual({ id: hubId(db), name: 'lab', slot: null });
  });

  it('a hub whose node listeners bind one address is reached there and nowhere else', () => {
    expect(advertised({ nodeHost: '127.0.0.1' })).toEqual({ host: '127.0.0.1', addr: '127.0.0.1' });
    const lan = advertised({ nodeHost: '0.0.0.0' });
    expect(lan.host).toMatch(/\.local$/);
    expect(lan.host).not.toBe('0.0.0.0');
  });
});

// ---- the key ----

describe('the network key', () => {
  it('lives in secrets.json with its net id, beside what is there, and reads back only for that network', () => {
    writeWifiPassword('default', 'fake-wifi-password');
    expect(readNetworkKey(0x1111)).toBeNull();
    const key = newNetworkKey();
    expect(key).toHaveLength(32);
    writeNetworkKey(0x1111, key);
    expect(readNetworkKey(0x1111)!.equals(key)).toBe(true);
    expect(readNetworkKey(0x2222)).toBeNull();
    expect(readNetworkKey(null)).toBeNull();
    const file = JSON.parse(readFileSync(join(home, 'secrets.json'), 'utf8')) as Record<string, unknown>;
    expect(file.network_key).toEqual({ net_id: 0x1111, key: key.toString('hex') });
    expect(file.wifi_passwords).toEqual({ default: 'fake-wifi-password' });
    // What is not a key reads as none, and a secrets.json that does not parse says so without quoting itself.
    writeFileSync(join(home, 'secrets.json'), JSON.stringify({ ...readSecrets(), network_key: { net_id: 0x1111, key: 'zz' } }));
    expect(readNetworkKey(0x1111)).toBeNull();
    writeFileSync(join(home, 'secrets.json'), `{"network_key": {"key": "${key.toString('hex')}"`);
    let said = '';
    try {
      readNetworkKey(0x1111);
    } catch (e) {
      said = `${(e as Error).message} ${JSON.stringify((e as FrError).details ?? {})}`;
    }
    expect(said).toContain('is not valid JSON');
    expect(said).not.toContain(key.toString('hex'));
    rmSync(join(home, 'secrets.json'));
  });

  it('crosses sealed to the joining hub\'s key: only that hub opens it, for that network and that hub id', () => {
    const key = newNetworkKey();
    const keys = admissionKeys();
    expect(Buffer.from(keys.publicKey, 'base64')).toHaveLength(32);
    const sealed = sealKey(key, keys.publicKey, 0x1111, 'aabbccddeeff');
    expect(sealed.alg).toBe('x25519-hkdf-sha256-aes256gcm');
    expect(openSealed(sealed, keys, 0x1111, 'aabbccddeeff').equals(key)).toBe(true);
    // Nothing in the blob is the key, in any of the spellings a reader would look for.
    const blob = JSON.stringify(sealed);
    for (const spelled of [key.toString('hex'), key.toString('base64'), key.toString('base64url')]) {
      expect(blob).not.toContain(spelled);
    }
    // Two seals of one key differ (an ephemeral key, a salt and a nonce each time).
    expect(sealKey(key, keys.publicKey, 0x1111, 'aabbccddeeff').ct).not.toBe(sealed.ct);
    // Another hub's keys, another network, another hub id, a changed byte: none opens, and the error quotes nothing.
    const refused = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(FrError);
        expect((e as FrError).code).toBe('HUB_VERSION_MISMATCH');
        const text = JSON.stringify({ m: (e as FrError).message, h: (e as FrError).hint, d: (e as FrError).details });
        expect(text).not.toContain(sealed.ct);
        expect(text).not.toContain(key.toString('hex'));
        return true;
      }
      return false;
    };
    expect(refused(() => openSealed(sealed, admissionKeys(), 0x1111, 'aabbccddeeff'))).toBe(true);
    expect(refused(() => openSealed(sealed, keys, 0x2222, 'aabbccddeeff'))).toBe(true);
    expect(refused(() => openSealed(sealed, keys, 0x1111, 'aabbccddee00'))).toBe(true);
    const ct = Buffer.from(sealed.ct, 'base64');
    ct[0] ^= 1;
    expect(refused(() => openSealed({ ...sealed, ct: ct.toString('base64') }, keys, 0x1111, 'aabbccddeeff'))).toBe(true);
    expect(refused(() => openSealed({ ...sealed, alg: 'none' as never }, keys, 0x1111, 'aabbccddeeff'))).toBe(true);
    // What is not a public key is refused before anything is sealed.
    expect(() => sealKey(key, Buffer.alloc(31).toString('base64'), 0x1111, 'aabbccddeeff')).toThrow(/not a raw X25519 public key/);
    expect(() => sealKey(key, Buffer.alloc(32).toString('base64'), 0x1111, 'aabbccddeeff')).toThrow(/X25519/);
  });
});

// ---- the member list (§4) ----

describe('the member list', () => {
  const claim = (id: string, name: string, port = 7423) => ({ id, name, host: `${name}.test`, addr: '127.0.0.1', link_port: port });

  it('the registrar is slot 0 and gives members 1 to 3; a fifth hub is refused', () => {
    const db = freshDb();
    expect(listMembers(db)).toEqual([]);
    expect(membersVersion(db)).toBe(0);
    expect(putRegistrar(db, claim('000000000001', 'hub-a'))).toBe(true);
    expect(putRegistrar(db, claim('000000000001', 'hub-a'))).toBe(false);
    expect(admitMember(db, claim('000000000002', 'hub-b'))).toMatchObject({ changed: true, member: { slot: 1, name: 'hub-b' } });
    expect(admitMember(db, claim('000000000003', 'hub-c')).member.slot).toBe(2);
    expect(admitMember(db, claim('000000000004', 'hub-d')).member.slot).toBe(3);
    expect(bumpMembers(db)).toBe(1);
    expect(listMembers(db).map((m) => [m.name, m.slot])).toEqual([['hub-a', 0], ['hub-b', 1], ['hub-c', 2], ['hub-d', 3]]);
    let fifth: FrError | null = null;
    try {
      admitMember(db, claim('000000000005', 'hub-e'));
    } catch (e) {
      fifth = e as FrError;
    }
    expect(fifth).toMatchObject({ code: 'INVALID_ARGS' });
    expect(fifth!.message).toContain('the network already has 4 hubs (hub-a, hub-b, hub-c, hub-d)');
    expect(listMembers(db)).toHaveLength(4);
  });

  it('a hub admitted again keeps its slot; a name another hub has is refused; the registrar cannot join itself', () => {
    const db = freshDb();
    putRegistrar(db, claim('000000000001', 'hub-a'));
    admitMember(db, claim('000000000002', 'hub-b'));
    admitMember(db, claim('000000000003', 'hub-c'));
    // Again, unchanged: no change. With another port or name: the same slot, the row brought up to date.
    expect(admitMember(db, claim('000000000002', 'hub-b'))).toMatchObject({ changed: false, member: { slot: 1 } });
    expect(admitMember(db, claim('000000000002', 'hub-b2', 7500))).toMatchObject({ changed: true, member: { slot: 1, name: 'hub-b2', link_port: 7500 } });
    for (const [id, name, text] of [
      ['000000000004', 'hub-c', 'the network already has a hub named hub-c (000000000003)'],
      ['000000000004', 'hub-a', 'the network already has a hub named hub-a (000000000001, the registrar)'],
      ['000000000002', 'hub-c', 'the network already has a hub named hub-c'],
    ]) {
      expect(() => admitMember(db, claim(id, name)), `${id} as ${name}`).toThrow(text);
    }
    expect(() => admitMember(db, claim('000000000001', 'hub-z'))).toThrow(/this network's registrar: it cannot join itself/);
    // A member that left its slot free is not a case yet (no leave): the lowest free slot goes to the next hub.
    expect(admitMember(db, claim('000000000004', 'hub-d')).member.slot).toBe(3);
  });

  it('a list taken from another hub replaces this hub\'s, and keeps where each peer was last seen', () => {
    const db = freshDb();
    putRegistrar(db, claim('000000000001', 'hub-a'));
    admitMember(db, claim('000000000002', 'hub-b'));
    noteSeen(db, '000000000002', '10.1.2.3', 7999);
    const list = [...listMembers(db).map(publicMember), { id: '000000000003', name: 'hub-c', host: 'hub-c.test', addr: null, link_port: 7423, slot: 2, joined_at: '2026-11-21T10:00:00.000Z' }];
    expect(Object.keys(list[0]).sort()).toEqual(['addr', 'host', 'id', 'joined_at', 'link_port', 'name', 'slot']);
    replaceMembers(db, list, 7);
    expect(membersVersion(db)).toBe(7);
    const now = listMembers(db);
    expect(now.map((m) => m.name)).toEqual(['hub-a', 'hub-b', 'hub-c']);
    expect(now[1]).toMatchObject({ seen_addr: '10.1.2.3', seen_port: 7999 });
    expect(now[2]).toMatchObject({ seen_addr: null, addr: null });
    // Where to look for a peer (§3.2): its host name, the address its link last came from, the address in the list.
    expect(candidatesOf(now[1])).toEqual([{ host: 'hub-b.test', port: 7423 }, { host: '10.1.2.3', port: 7999 }, { host: '127.0.0.1', port: 7423 }]);
    expect(candidatesOf(now[2])).toEqual([{ host: 'hub-c.test', port: 7423 }]);
    expect(candidatesOf({ ...now[1], host: '127.0.0.1', seen_addr: '127.0.0.1', seen_port: 7423 })).toEqual([{ host: '127.0.0.1', port: 7423 }]);
    // The table holds no key and no column for one.
    expect((db.prepare('PRAGMA table_info(hub_members)').all() as { name: string }[]).map((c) => c.name)).toEqual(['hub_id', 'name', 'host', 'addr', 'link_port', 'slot', 'joined_at', 'seen_addr', 'seen_port', 'seen_at']);
  });
});

// ---- frames (§3.3) ----

describe('the link\'s frames', () => {
  const hello: PeerMessage = { t: 'hello', v: 1, wire: 1, hub_id: '0000000000aa', name: 'hub-a', net: 0x1111, registry_hash: 'abc', hub_epoch: 3, members_version: 2, link_port: 7423 };

  it('a control message is u32 length, kind 1, JSON; a stream cut anywhere gives the same messages', () => {
    const presence: PeerMessage = { t: 'presence', v: 1, full: false, up: [{ device: 'aabbcc0e0a01', links: ['tcp'], fw: 'f00dfeedf00dfeed', epoch: 3 }], gone: ['aabbcc0e0a02'] };
    const bytes = Buffer.concat([encodeControl(hello), encodeControl(presence), encodeControl({ t: 'ping', v: 1, n: 9 })]);
    expect(bytes.readUInt32BE(0)).toBe(encodeControl(hello).length - 4);
    expect(bytes[4]).toBe(1);
    for (const cut of [1, 3, 4, 5, 17, bytes.length - 1]) {
      const d = new FrameDecoder();
      const out = [...d.push(bytes.subarray(0, cut)), ...d.push(bytes.subarray(cut))];
      expect(out.map((f) => (f.kind === 'message' ? f.msg.t : f.kind)), `cut at ${cut}`).toEqual(['hello', 'presence', 'ping']);
      expect(out[0]).toEqual({ kind: 'message', msg: hello });
    }
    const d = new FrameDecoder();
    expect(bytes.reduce<string[]>((acc, _b, i) => [...acc, ...d.push(bytes.subarray(i, i + 1)).map((f) => f.kind)], [])).toEqual(['message', 'message', 'message']);
  });

  it('takes what it does not know without breaking: a later step\'s type, a later field, a data frame', () => {
    const d = new FrameDecoder();
    const later = (o: unknown) => encodeControl(o as PeerMessage);
    // Step 2.2: a data frame is `u32 channel | bytes`; one too short to name a channel is skipped like an unknown kind.
    const data = Buffer.concat([Buffer.from([0, 0, 0, 8, FRAME_DATA, 0, 0, 0, 7]), Buffer.from('abc')]);
    const short = Buffer.concat([Buffer.from([0, 0, 0, 4, FRAME_DATA]), Buffer.from('abc')]);
    const odd = Buffer.from([0, 0, 0, 2, 9, 0]);
    const out = d.push(Buffer.concat([later({ t: 'registry', v: 1, rows: [] }), later({ ...hello, new_field: { x: 1 } }), later({ t: 'presence', v: 1 }), later({ no: 'type' }), data, short, odd, later({ t: 'pong', v: 2, n: 1 }), later({ t: 'call', v: 1, op: 'device_list' })]));
    expect(out.map((f) => f.kind)).toEqual(['unknown', 'message', 'unknown', 'unknown', 'data', 'unknown', 'unknown', 'message', 'unknown']);
    expect(out[0]).toEqual({ kind: 'unknown', t: 'registry' });
    expect((out[1] as { msg: Record<string, unknown> }).msg.new_field).toEqual({ x: 1 });
    expect(out[4]).toMatchObject({ kind: 'data', ch: 7 });
    expect((out[4] as { bytes: Buffer }).bytes.toString()).toBe('abc');
    // A `call` without its fields (an older or newer shape) is dropped, not fatal.
    expect(out[8]).toEqual({ kind: 'unknown', t: 'call' });
    expect(HelloSchema.safeParse({ ...hello, hub_id: 'not-an-id' }).success).toBe(false);
  });

  it('refuses what breaks the framing', () => {
    const tooBig = Buffer.alloc(5);
    tooBig.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(() => new FrameDecoder().push(tooBig)).toThrow(WireError);
    expect(() => new FrameDecoder().push(Buffer.from([0, 0, 0, 0]))).toThrow(WireError);
    expect(() => new FrameDecoder().push(Buffer.concat([Buffer.from([0, 0, 0, 4, 1]), Buffer.from('{{{')]))).toThrow(/not JSON/);
  });
});

// ---- the TLS link (§3.1, §3.2) ----

interface Node {
  id: string;
  name: string;
  links: PeerLinks;
  /** The members it knows, by id, with the port to dial each at (set once the others listen). */
  known: Map<string, LinkTarget>;
  ups: PeerView[];
  downs: [PeerView, string][];
  got: [string, PeerMessage][];
  log: Record<string, unknown>[];
  hello: HelloInfo;
}

const FAST: Partial<PeerLinkTiming> = { pingMs: 60, awayMs: 300, backoffMinMs: 20, backoffMaxMs: 160, connectMs: 800, helloMs: 600 };

function linkNode(id: string, name: string, key: Buffer | null, net = 0x1111, timing: Partial<PeerLinkTiming> = FAST): Node {
  const n: Node = {
    id,
    name,
    known: new Map(),
    ups: [],
    downs: [],
    got: [],
    log: [],
    hello: { hub_id: id, name, net, registry_hash: 'r-hash', hub_epoch: 5, members_version: 1 },
    links: null as unknown as PeerLinks,
  };
  n.links = new PeerLinks({
    listen: { host: '127.0.0.1', port: 0 },
    key: () => (key ? { key, net } : null),
    hello: () => ({ ...n.hello, ...(n.links.port() ? { link_port: n.links.port()! } : {}) }),
    targets: () => [...n.known.values()],
    onUp: (p) => n.ups.push(p),
    onDown: (p, why) => n.downs.push([p, why]),
    onMessage: (p, msg) => n.got.push([p.id, msg]),
    timing,
    log: (line) => n.log.push(line),
  });
  cleanups.push(() => n.links.stop());
  return n;
}

/** Each node learns the others at the ports they listen on. */
async function introduce(...nodes: Node[]): Promise<void> {
  for (const n of nodes) {
    await n.links.listen();
  }
  for (const n of nodes) {
    for (const o of nodes) {
      if (o !== n) {
        n.known.set(o.id, { id: o.id, name: o.name, candidates: [{ host: '127.0.0.1', port: o.links.port()! }] });
      }
    }
  }
}

const reachable = (n: Node, other: Node) => n.links.view(other.id)?.reachable === true;

describe('the peer link (TLS with the network key as its pre-shared key)', () => {
  it('two hubs with one key connect, say hello and carry messages both ways', async () => {
    const key = randomBytes(32);
    const a = linkNode('0000000000aa', 'hub-a', key);
    const b = linkNode('0000000000bb', 'hub-b', key);
    await introduce(a, b);
    await Promise.all([a.links.sync(), b.links.sync()]);
    await until(() => reachable(a, b) && reachable(b, a), 3000, 'the link up at both ends');
    expect(a.ups[0]).toMatchObject({ id: b.id, name: 'hub-b', reachable: true });
    expect(a.links.view(b.id)!.hello).toMatchObject({ hub_id: b.id, net: 0x1111, registry_hash: 'r-hash', hub_epoch: 5, members_version: 1, link_port: b.links.port() });
    expect(a.links.view(b.id)!.since).toBeGreaterThan(Date.now() - 5000);
    expect(a.links.send(b.id, { t: 'presence', v: 1, full: true, up: [{ device: 'aabbcc0e0a01', links: ['tcp'], fw: null, epoch: 2 }], gone: [] })).toBe(true);
    expect(b.links.broadcast({ t: 'members', v: 1, version: 4, members: [{ id: a.id, name: 'hub-a', host: '127.0.0.1', addr: null, link_port: 1, slot: 0, joined_at: 'x' }] })).toBe(1);
    await until(() => b.got.length === 1 && a.got.length === 1, 2000, 'both messages');
    expect(b.got[0]).toMatchObject([a.id, { t: 'presence', full: true }]);
    expect(a.got[0]).toMatchObject([b.id, { t: 'members', version: 4 }]);
    // Pings answer: a round trip is measured, and nothing goes away.
    await until(() => a.links.view(b.id)!.rtt_ms !== null, 2000, 'a pong');
    await sleep(500); // longer than awayMs
    expect(reachable(a, b) && reachable(b, a)).toBe(true);
    expect(a.downs).toEqual([]);
    expect(a.links.send('0000000000cc', { t: 'ping', v: 1, n: 1 })).toBe(false);
  });

  it('both ends dial at once: one connection per pair survives, the one the lower hub id dialled', async () => {
    const key = randomBytes(32);
    for (let round = 0; round < 6; round++) {
      const a = linkNode('0000000000aa', 'hub-a', key);
      const b = linkNode('0000000000bb', 'hub-b', key);
      await introduce(a, b);
      await Promise.all([a.links.sync(), b.links.sync()]);
      await until(() => reachable(a, b) && reachable(b, a), 3000, 'the link up at both ends');
      // Both dials have ended one way or the other once each end holds exactly one connection.
      await until(() => a.links.connections() === 1 && b.links.connections() === 1, 3000, 'one connection at each end');
      await sleep(80);
      expect([a.links.connections(), b.links.connections()]).toEqual([1, 1]);
      expect(a.links.view(b.id)).toMatchObject({ reachable: true, direction: 'out' }); // a has the lower id: its dial is the one kept
      expect(b.links.view(a.id)).toMatchObject({ reachable: true, direction: 'in' });
      // It stays one: no end dials again while the pair has its connection, and neither ever saw the peer go away.
      await sleep(200);
      expect([a.links.connections(), b.links.connections()]).toEqual([1, 1]);
      expect(a.downs).toEqual([]);
      expect(b.downs).toEqual([]);
      // The surviving connection carries both ways.
      a.links.send(b.id, { t: 'presence', v: 1, full: true, up: [], gone: [] });
      b.links.send(a.id, { t: 'presence', v: 1, full: true, up: [], gone: [] });
      await until(() => a.got.length >= 1 && b.got.length >= 1, 2000, 'a message each way');
      await Promise.all([a.links.stop(), b.links.stop()]);
    }
  });

  it('only the higher hub id can dial (the other end has nowhere to look): that connection is the pair\'s', async () => {
    const key = randomBytes(32);
    const a = linkNode('0000000000aa', 'hub-a', key);
    const b = linkNode('0000000000bb', 'hub-b', key);
    await introduce(a, b);
    a.known.set(b.id, { id: b.id, name: 'hub-b', candidates: [] }); // a firewall, a hub with no address to give
    await Promise.all([a.links.sync(), b.links.sync()]);
    await until(() => reachable(a, b) && reachable(b, a), 3000, 'the link up at both ends');
    expect(a.links.view(b.id)).toMatchObject({ direction: 'in' });
    expect(b.links.view(a.id)).toMatchObject({ direction: 'out' });
  });

  it('a wrong key is refused at the TLS handshake, and so is a hub of another network', async () => {
    const key = randomBytes(32);
    const a = linkNode('0000000000aa', 'hub-a', key);
    const wrong = linkNode('0000000000bb', 'hub-b', randomBytes(32)); // the same net id, another key
    const foreign = linkNode('0000000000cc', 'hub-c', randomBytes(32), 0x2222); // another network, with its own key
    const stolen = linkNode('0000000000dd', 'hub-d', key, 0x2222); // another net id although the key is this network's
    await introduce(a, wrong, foreign, stolen);
    a.known.clear(); // a dials nobody: what reaches it is what it must refuse
    for (const n of [wrong, foreign, stolen]) {
      for (const id of [...n.known.keys()]) {
        if (id !== a.id) {
          n.known.delete(id);
        }
      }
    }
    await a.links.sync();
    await Promise.all([wrong.links.sync(), foreign.links.sync(), stolen.links.sync()]);
    await until(() => [wrong, foreign, stolen].every((n) => n.links.view(a.id)?.last_error), 3000, 'each dial to fail');
    await sleep(150); // a few more attempts
    expect(a.ups).toEqual([]);
    expect(a.downs).toEqual([]);
    expect(a.links.connections()).toBe(0);
    expect(a.links.counters.handshake_refused).toBeGreaterThanOrEqual(3);
    expect(a.links.counters.hello_refused).toBe(0); // none got as far as a hello
    expect(wrong.links.view(a.id)).toMatchObject({ reachable: false });
    expect(wrong.links.view(a.id)!.last_error).toContain('the two hubs hold different network keys');
    expect(foreign.links.view(a.id)!.last_error).toContain('that hub is in another network');
    expect(stolen.links.view(a.id)!.last_error).toContain('that hub is in another network');
    for (const n of [wrong, foreign, stolen]) {
      expect(n.ups).toEqual([]);
    }
    // What was logged names addresses and reasons, never a key.
    const logged = JSON.stringify([a.log, wrong.log, foreign.log, stolen.log]);
    expect(logged).toContain('peer_handshake_refused');
    expect(logged).not.toContain(key.toString('hex'));
    expect(logged).not.toContain(key.toString('base64'));
  });

  it('a hub that holds no key has no link: nothing is dialled, and its listener refuses every handshake', async () => {
    const key = randomBytes(32);
    const keyless = linkNode('0000000000aa', 'hub-a', null);
    const b = linkNode('0000000000bb', 'hub-b', key);
    // The listener of a hub about to join is bound before it holds the key (it tells the registrar its port).
    expect(await keyless.links.listen()).toBeGreaterThan(0);
    await b.links.listen();
    b.known.set(keyless.id, { id: keyless.id, name: 'hub-a', candidates: [{ host: '127.0.0.1', port: keyless.links.port()! }] });
    await b.links.sync();
    await until(() => b.links.view(keyless.id)?.last_error, 3000, 'the dial to fail');
    expect(b.links.view(keyless.id)!.last_error).toContain('holds no network key');
    expect(keyless.links.counters.handshake_refused).toBeGreaterThanOrEqual(1);
    // sync() without a key closes the listener again.
    keyless.known.set(b.id, { id: b.id, name: 'hub-b', candidates: [{ host: '127.0.0.1', port: b.links.port()! }] });
    await keyless.links.sync();
    expect(keyless.links.port()).toBeNull();
    expect(keyless.links.views()).toEqual([]);
  });

  it('a hub with the key that is not in the member list is refused after its hello, and told why', async () => {
    const key = randomBytes(32);
    const a = linkNode('0000000000aa', 'hub-a', key);
    const stranger = linkNode('0000000000ee', 'hub-e', key);
    await introduce(a, stranger);
    a.known.clear();
    await Promise.all([a.links.sync(), stranger.links.sync()]);
    await until(() => stranger.links.view(a.id)?.last_error?.includes('refused'), 3000, 'the refusal');
    expect(stranger.links.view(a.id)!.last_error).toContain('refused: hub hub-e (0000000000ee) is not in the member list of hub hub-a (version 1)');
    expect(a.links.counters.hello_refused).toBeGreaterThanOrEqual(1);
    expect(a.ups).toEqual([]);
    // The refused hub never took the other for reachable either: a connection is in use only once both ends said so.
    expect(stranger.ups).toEqual([]);
    expect(stranger.downs).toEqual([]);
    expect(a.log.find((l) => l.event === 'peer_refused')).toMatchObject({ code: 'unknown_hub', hub: 'hub-e', id: '0000000000ee' });
    // Once the list names it (the registrar told this hub), the next attempt is taken.
    a.known.set(stranger.id, { id: stranger.id, name: 'hub-e', candidates: [{ host: '127.0.0.1', port: stranger.links.port()! }] });
    await a.links.sync();
    await until(() => reachable(a, stranger) && reachable(stranger, a), 3000, 'the link up once the hub is a member');
  });

  it('a peer that falls silent is away after awayMs and its connection is closed; a peer that stops is away at once', async () => {
    const key = randomBytes(32);
    const a = linkNode('0000000000aa', 'hub-a', key);
    await a.links.listen();
    a.known.set('0000000000bb', { id: '0000000000bb', name: 'hub-b', candidates: [] });
    await a.links.sync();
    // A peer that completes the handshake and its hello, then never reads or writes again (a hub frozen, a cable out).
    const silent = tls.connect({ host: '127.0.0.1', port: a.links.port()!, ciphers: 'ECDHE-PSK-CHACHA20-POLY1305', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', pskCallback: () => ({ psk: key, identity: pskIdentity(0x1111) }), checkServerIdentity: () => undefined });
    cleanups.push(() => silent.destroy());
    let closed = false;
    silent.on('close', () => (closed = true));
    silent.on('error', () => undefined);
    silent.on('data', () => undefined); // it takes what arrives (so it sees the connection end) and answers nothing
    await new Promise<void>((r) => silent.once('secureConnect', () => r()));
    silent.write(Buffer.concat([encodeControl({ t: 'hello', v: 1, wire: 1, hub_id: '0000000000bb', name: 'hub-b', net: 0x1111, registry_hash: 'x', hub_epoch: 1, members_version: 1 }), encodeControl({ t: 'ready', v: 1 })]));
    const t0 = Date.now();
    await until(() => a.links.view('0000000000bb')?.reachable, 2000, 'the silent peer up');
    await until(() => a.downs.length === 1, 3000, 'the silent peer away');
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(250); // awayMs 300, less the ms before it was seen up
    expect(took).toBeLessThan(1200);
    expect(a.downs[0][1]).toMatch(/^silent for 0\.\d s$/);
    expect(a.links.view('0000000000bb')).toMatchObject({ reachable: false, address: null });
    expect(a.links.view('0000000000bb')!.last_error).toMatch(/silent/);
    expect(a.links.counters.away).toBe(1);
    await until(() => closed, 2000, 'its connection closed');
    // And one that stops: its peer hears the connection close.
    const c = linkNode('0000000000cc', 'hub-c', key);
    await c.links.listen();
    a.known.set(c.id, { id: c.id, name: 'hub-c', candidates: [{ host: '127.0.0.1', port: c.links.port()! }] });
    c.known.set(a.id, { id: a.id, name: 'hub-a', candidates: [{ host: '127.0.0.1', port: a.links.port()! }] });
    await Promise.all([a.links.sync(), c.links.sync()]);
    await until(() => reachable(a, c), 3000, 'hub-c up');
    const before = Date.now();
    await c.links.stop();
    await until(() => !reachable(a, c), 1000, 'hub-c away');
    expect(Date.now() - before).toBeLessThan(250); // well inside awayMs
  });

  it('dials again with a backoff, finds the peer at the next place it looks, and takes it back when it returns', async () => {
    const key = randomBytes(32);
    const a = linkNode('0000000000aa', 'hub-a', key);
    const b = linkNode('0000000000bb', 'hub-b', key);
    await introduce(a, b);
    b.known.set(a.id, { id: a.id, name: 'hub-a', candidates: [] }); // b knows a and has nowhere to look for it: only a dials
    const port = b.links.port()!;
    // Where a looks (§3.2): a name that does not resolve here, an address nothing listens on, then where b is.
    a.known.set(b.id, { id: b.id, name: 'hub-b', candidates: [{ host: 'hub-b.invalid', port }, { host: '127.0.0.1', port: 9 }, { host: '127.0.0.1', port }] });
    await Promise.all([a.links.sync(), b.links.sync()]);
    await until(() => reachable(a, b), 5000, 'the third candidate to answer');
    expect(a.links.view(b.id)).toMatchObject({ address: `127.0.0.1:${port}`, direction: 'out', last_error: null });
    // b does not dial (it has nowhere to look for a): a must find it again by itself.
    await b.links.stop();
    await until(() => !reachable(a, b), 1000, 'b away');
    await until(() => a.links.view(b.id)!.last_error?.includes(`127.0.0.1:${port}`), 3000, 'a failed attempt');
    expect(a.links.view(b.id)!.last_error).toMatch(/ECONNREFUSED/);
    // While b is gone a keeps trying, no more often than the backoff allows (20, 40, 80, 160, 160 ... ms).
    // The same hub started again, on the port it had.
    const again = new PeerLinks({
      listen: { host: '127.0.0.1', port },
      key: () => ({ key, net: 0x1111 }),
      hello: () => ({ ...b.hello, link_port: port }),
      targets: () => [{ id: a.id, name: 'hub-a', candidates: [] }],
      onUp: () => undefined,
      onDown: () => undefined,
      onMessage: () => undefined,
      timing: FAST,
    });
    cleanups.push(() => again.stop());
    await sleep(300);
    await again.sync();
    expect(again.port()).toBe(port);
    await until(() => reachable(a, b), 3000, 'a to reach b again');
    expect(a.ups.filter((p) => p.id === b.id)).toHaveLength(2);
    expect(a.downs).toHaveLength(1);
  });
});

// ---- the serial rule (§6) ----

describe('no WELCOME on a USB cable for a board another hub holds over Wi-Fi (design multi-hub-m2 §6)', () => {
  const MAC = 'aabbcc0e0b01';

  it('the HELLO is not answered while a peer reports the board\'s TCP session, and is as before once it does not', async () => {
    let heldBy: string | null = 'hub-b';
    const r = await rig({ serialOnly: true, heldOverTcp: (id) => (id === MAC ? heldBy : null) });
    cleanups.push(() => r.close());
    r.registry.add({ device_id: MAC, addr: 5, alias: 'pad-usb', provisioned: true });
    const board = r.node({ mac: MAC, addr: 5, net: 0, epoch: 2, alias: 'pad-usb', aliasRev: 1, serial: r.serial, autoHeartbeat: false });
    await expect(board.connect(350)).rejects.toThrow(/no WELCOME/);
    board.hello();
    await sleep(30);
    expect(r.router.status().counters.serial_hello_held).toBeGreaterThanOrEqual(2);
    expect(r.router.status().counters.serial_yielded).toBe(0);
    expect(r.serial.written).toEqual([]); // nothing was written to the port: no WELCOME, no BYE
    expect(r.router.presence(MAC)).not.toBe('online');
    expect(r.router.status().sessions.serial).toBe(0);
    expect(r.events.query({ limit: 20 }).filter((e) => e.device === MAC)).toEqual([]);
    // Another board on a cable is answered as ever.
    const other = r.node({ mac: 'aabbcc0e0b02', addr: 6, net: 0, epoch: 1, alias: 'pad-other', aliasRev: 1, serial: r.serial });
    await other.connected(r.events);
    expect(r.router.presence('aabbcc0e0b02')).toBe('online');
    // The peer's report ends (the board left that hub, or that hub went away): the next HELLO is taken.
    heldBy = null;
    await board.connected(r.events);
    expect(r.router.presence(MAC)).toBe('online');
    expect(r.router.info(MAC)!.links).toEqual(['serial']);
  });

  it('a serial session the board gave up for another hub\'s Wi-Fi is ended at once, without a BYE, the port left open', async () => {
    let heldBy: string | null = null;
    const r = await rig({ serialOnly: true, heldOverTcp: () => heldBy });
    cleanups.push(() => r.close());
    r.registry.add({ device_id: MAC, addr: 5, alias: 'pad-usb', provisioned: true });
    const board = r.node({ mac: MAC, addr: 5, net: 0, epoch: 2, alias: 'pad-usb', aliasRev: 1, serial: r.serial });
    await board.connected(r.events); // booted on the cable before its Wi-Fi was up: this hub has it
    expect(r.router.yieldSerial(MAC, 'held by hub hub-b over Wi-Fi')).toBe(false); // nobody else holds it
    expect(r.router.presence(MAC)).toBe('online');
    // The other hub reports its TCP session: the board ended this one when it took that hub's WELCOME.
    heldBy = 'hub-b';
    const written = r.serial.written.length;
    expect(r.router.yieldSerial(MAC, 'held by hub hub-b over Wi-Fi')).toBe(true);
    expect(r.router.presence(MAC)).toBe('offline');
    expect(r.router.status().counters.serial_yielded).toBe(1);
    await sleep(20);
    expect(r.serial.written.length).toBe(written); // no BYE: the board holds no session to end
    const events = r.events.query({ limit: 50 }).filter((e) => e.device === MAC).map((e) => [e.type, e.fields?.reason ?? null]);
    expect(events.slice(-2)).toEqual([
      ['device.link', 'held by hub hub-b over Wi-Fi'],
      ['device.offline', 'held by hub hub-b over Wi-Fi'],
    ]);
    // Its HELLOs on the cable are then not answered, and a second yield finds nothing.
    await expect(board.connect(300)).rejects.toThrow(/no WELCOME/);
    expect(r.router.yieldSerial(MAC, 'again')).toBe(false);
    expect(r.router.status().counters.serial_hello_held).toBeGreaterThanOrEqual(1);
  });

  it('a HELLO on the cable while this hub still shows the old serial session ends that session', async () => {
    let heldBy: string | null = null;
    const r = await rig({ serialOnly: true, heldOverTcp: () => heldBy });
    cleanups.push(() => r.close());
    r.registry.add({ device_id: MAC, addr: 5, alias: 'pad-usb', provisioned: true });
    const board = r.node({ mac: MAC, addr: 5, net: 0, epoch: 2, alias: 'pad-usb', aliasRev: 1, serial: r.serial });
    await board.connected(r.events);
    heldBy = 'hub-b'; // known to the link, the report's own yield not run (this test calls the router alone)
    board.hello();
    await until(() => r.router.presence(MAC) === 'offline', 1000, 'the old session to end');
    expect(r.router.status().counters).toMatchObject({ serial_hello_held: 1, serial_yielded: 1 });
  });

  it('a stale report loses to this hub\'s own TCP session with the board', async () => {
    const r = await rig({ heldOverTcp: () => 'hub-b' }); // the peer has not noticed the board left yet
    cleanups.push(() => r.close());
    r.registry.add({ device_id: MAC, addr: 5, alias: 'pad-usb', provisioned: true });
    const wifi = r.node({ mac: MAC, addr: 5, net: 0, epoch: 2, alias: 'pad-usb', aliasRev: 1 });
    await wifi.connected(r.events); // TCP is never held back
    const usb = r.node({ mac: MAC, addr: 5, net: 0, epoch: 2, alias: 'pad-usb', aliasRev: 1, serial: r.serial, autoHeartbeat: false });
    await usb.connect(1500); // and with the TCP session here, the cable is answered too
    expect(r.router.status().counters.serial_hello_held).toBe(0);
    expect(r.router.yieldSerial(MAC, 'held by hub hub-b over Wi-Fi')).toBe(false);
    expect(r.router.info(MAC)!.links.sort()).toEqual(['serial', 'tcp']);
  });
});

// ---- who is where, and the serial rule through the link (§6) ----

interface PeerHub {
  r: Rig;
  peers: Peers;
  id: string;
  name: string;
}

/** A hub's router and its peers part in this process: its own hub.db, the network's key in the (shared) secrets.json. */
async function peerHub(name: string, net: number, hubEpoch: number): Promise<PeerHub> {
  const h = { peers: null as unknown as Peers };
  const r = await rig({ hubEpoch, heldOverTcp: (id) => h.peers?.heldOverTcp(id) ?? null });
  setHubName(r.db, name);
  writeNetwork(r.db, { ssid: 'lab-wifi', bssid: null, country: null });
  r.db.prepare('UPDATE networks SET net_id = ?').run(net);
  r.router.refreshNet();
  const run = { nodeHost: '127.0.0.1', peerPort: 0 } as HubRunOptions;
  Object.assign(r.hub, { startedAt: Date.now(), run });
  h.peers = createPeers(() => r.hub, run, { timing: FAST });
  (r.hub as { peers?: Peers }).peers = h.peers;
  await h.peers.start();
  cleanups.push(async () => {
    await h.peers.stop();
    await r.close();
  });
  return { r, peers: h.peers, id: hubId(r.db), name };
}

/** The member list a join would have left in each hub's db, at the ports the hubs really listen on. */
async function joined(...hubs: PeerHub[]): Promise<void> {
  const members = hubs.map((h, slot) => ({ id: h.id, name: h.name, host: '127.0.0.1', addr: '127.0.0.1', link_port: h.peers.status().link.port!, slot, joined_at: '2026-11-21T10:00:00.000Z' }));
  hubs.forEach((h, slot) => {
    replaceMembers(h.r.db, members, 1);
    kvSet(h.r.db, HUB_SLOT_KEY, String(slot));
  });
  await Promise.all(hubs.map((h) => h.peers.refresh()));
  await until(() => hubs.every((h) => h.peers.status().peers.every((p) => p.reachable)), 3000, 'every pair linked');
}

describe('who is where, and the cable, between two hubs (design multi-hub-m2 §6)', () => {
  const NET = 0x3131;
  const MAC = 'aabbcc0e0c01';
  const node = (h: PeerHub, over: 'tcp' | 'serial') => {
    h.r.registry.add({ device_id: MAC, addr: 9, alias: 'pad-roams', provisioned: true });
    return h.r.node({ mac: MAC, addr: 9, net: NET, epoch: 4, alias: 'pad-roams', aliasRev: 1, fwPrefix: 'f00dfeedf00dfeed', ...(over === 'serial' ? { serial: h.r.serial } : {}) });
  };

  it('each hub tells the other which boards it holds; `at` names the holder; a peer that goes away is forgotten', async () => {
    writeNetworkKey(NET, newNetworkKey());
    const a = await peerHub('hub-a', NET, 7);
    const b = await peerHub('hub-b', NET, 0x4001);
    // Alone (no member list yet): a hub answers for its own boards, and hub_peers says it is alone.
    expect(a.peers.at(MAC)).toBeNull();
    expect(() => peersView(a.r.hub)).toThrow(/alone in its network/);
    await joined(a, b);
    expect(peersView(a.r.hub).peers.map((p) => [p.name, p.this, p.role, p.reachable, p.boards, p.hub_epoch])).toEqual([
      ['hub-a', true, 'registrar', true, 0, 7],
      ['hub-b', false, 'member', true, 0, 0x4001],
    ]);
    // The board connects to B: A hears of it.
    const wifi = node(b, 'tcp');
    await wifi.connected(b.r.events);
    expect(b.peers.at(MAC)).toBe('hub-b');
    await until(() => a.peers.at(MAC) === 'hub-b', 2000, 'hub A to hear the board is at hub B');
    expect(boardAt(a.r.hub, MAC)).toBe('hub-b');
    expect(a.r.router.presence(MAC)).toBe('unknown'); // presence stays this hub's own
    expect(a.peers.heldOverTcp(MAC)).toBe('hub-b');
    expect(b.peers.heldOverTcp(MAC)).toBeNull();
    expect(a.peers.status().held).toEqual({ [b.id]: 1 });
    expect(peersView(a.r.hub).peers[1]).toMatchObject({ name: 'hub-b', boards: 1 });
    expect(peersView(b.r.hub).peers[1]).toMatchObject({ name: 'hub-b', this: true, boards: 1 });
    // A link that comes up later gets everything at once: a third hub of the network.
    const c = await peerHub('hub-c', NET, 0x8001);
    await joined(a, b, c);
    await until(() => c.peers.at(MAC) === 'hub-b', 2000, 'hub C to get hub B\'s snapshot');
    expect(c.peers.status().held).toEqual({ [a.id]: 0, [b.id]: 1 });
    // The board leaves B: both forget.
    wifi.close();
    await until(() => a.peers.at(MAC) === null && c.peers.at(MAC) === null, 3000, 'the others to hear it left');
    expect(a.peers.heldOverTcp(MAC)).toBeNull();
    // Back on B, then B goes away without a word about the board: what it held is not known any more.
    const again = node(b, 'tcp');
    await again.connected(b.r.events);
    await until(() => a.peers.at(MAC) === 'hub-b', 2000, 'hub A to hear of it again');
    await b.peers.stop();
    await until(() => a.peers.at(MAC) === null, 1000, 'hub A to forget what hub B held');
    expect(peersView(a.r.hub).peers[1]).toMatchObject({ name: 'hub-b', reachable: false, boards: null });
    expect(a.peers.heldOverTcp(MAC)).toBeNull();
  });

  it('the registrar\'s own row follows where it is at each start, and a newer list reaches the members over the link', async () => {
    writeNetworkKey(NET, newNetworkKey());
    const a = await peerHub('hub-a', NET, 7);
    const b = await peerHub('hub-b', NET, 0x4001);
    await joined(a, b);
    expect(membersVersion(b.r.db)).toBe(1);
    // The registrar comes back at another address than its row says (a new DHCP lease while it was off).
    await a.peers.stop();
    a.r.db.prepare("UPDATE hub_members SET addr = '10.9.9.9', host = 'old-name.test' WHERE slot = 0").run();
    await a.peers.start();
    expect(listMembers(a.r.db)[0]).toMatchObject({ slot: 0, host: '127.0.0.1', addr: '127.0.0.1' });
    expect(membersVersion(a.r.db)).toBe(2);
    await until(() => membersVersion(b.r.db) === 2, 3000, 'the member to take the newer list');
    expect(listMembers(b.r.db).map((m) => [m.name, m.slot, m.addr])).toEqual([['hub-a', 0, '127.0.0.1'], ['hub-b', 1, '127.0.0.1']]);
    // A member takes no list that leaves it out, moves its slot, or is older; what it has stays.
    const mine = listMembers(b.r.db).map(publicMember);
    const send = (version: number, members: typeof mine) => {
      replaceMembers(a.r.db, members, version);
      return a.peers.refresh();
    };
    await send(9, [mine[0], { ...mine[1], slot: 2 }]);
    await sleep(150);
    expect(membersVersion(b.r.db)).toBe(2);
    await send(10, [mine[0]]);
    await sleep(150);
    expect(membersVersion(b.r.db)).toBe(2);
    expect(listMembers(b.r.db)).toHaveLength(2);
    // A good one with a higher version is taken: a third hub the registrar admitted.
    await send(11, [...mine, { id: '0000000000cc', name: 'hub-c', host: '127.0.0.1', addr: null, link_port: 9, slot: 2, joined_at: 'x' }]);
    await until(() => membersVersion(b.r.db) === 11, 3000, 'the member to hear of the third hub');
    expect(listMembers(b.r.db).map((m) => m.name)).toEqual(['hub-a', 'hub-b', 'hub-c']);
    expect(peersView(b.r.hub).peers.map((p) => [p.name, p.reachable])).toEqual([['hub-a', true], ['hub-b', true], ['hub-c', false]]);
  });

  it('a board on hub A\'s cable and hub B\'s Wi-Fi: A sends no WELCOME, ends the session it had, and takes the board back when B lets go', async () => {
    writeNetworkKey(NET, newNetworkKey());
    const a = await peerHub('hub-a', NET, 7);
    const b = await peerHub('hub-b', NET, 0x4001);
    await joined(a, b);
    // The board boots on A's cable before its Wi-Fi is up: A has it, and says so.
    const usb = node(a, 'serial');
    await usb.connected(a.r.events);
    expect(a.peers.at(MAC)).toBe('hub-a');
    await until(() => b.peers.at(MAC) === 'hub-a', 2000, 'hub B to hear the board is at hub A');
    expect(b.peers.heldOverTcp(MAC)).toBeNull(); // a USB session elsewhere holds no hub back
    // Its Wi-Fi comes up and it joins B. A hears, and ends the serial session the board gave up.
    const wifi = node(b, 'tcp');
    await wifi.connected(b.r.events);
    await until(() => a.r.router.presence(MAC) === 'offline', 2000, 'hub A to end its serial session');
    expect(a.r.router.status().counters.serial_yielded).toBe(1);
    expect(a.r.events.query({ limit: 50 }).filter((e) => e.device === MAC && e.type === 'device.offline').map((e) => e.fields?.reason)).toEqual(['held by hub hub-b over Wi-Fi']);
    expect(a.peers.at(MAC)).toBe('hub-b');
    await until(() => b.peers.at(MAC) === 'hub-b', 1000, 'hub B to say it has the board');
    // The board's HELLOs on the cable (one a second while it has no session there) get no WELCOME: no blip.
    const online = a.r.events.query({ limit: 100 }).filter((e) => e.device === MAC && e.type === 'device.online').length;
    await expect(usb.connect(400)).rejects.toThrow(/no WELCOME/);
    expect(a.r.router.status().counters.serial_hello_held).toBeGreaterThanOrEqual(1);
    expect(a.r.router.presence(MAC)).toBe('offline');
    expect(a.r.events.query({ limit: 100 }).filter((e) => e.device === MAC && e.type === 'device.online')).toHaveLength(online);
    // B lets go (the board's Wi-Fi drops): the next HELLO on the cable is answered as before.
    wifi.close();
    await until(() => a.peers.heldOverTcp(MAC) === null, 3000, 'hub A to hear hub B let go');
    await usb.connected(a.r.events);
    expect(a.peers.at(MAC)).toBe('hub-a');
    await until(() => b.peers.at(MAC) === 'hub-a', 2000, 'hub B to hear it is at hub A again');
  });
});

// ---- a registrar from before the hubs' link ----

describe('joining a hub that does not know network_admit', () => {
  it('is HUB_VERSION_MISMATCH naming that hub, and leaves this hub as it was', async () => {
    const r = await rig({ serialOnly: true });
    cleanups.push(() => r.close());
    setHubName(r.db, 'hub-b');
    const asked: string[] = [];
    // The other hub as a version from before the hubs' link answers: health and network_list, no network_admit.
    const old = (async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      asked.push(path);
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (path === '/api/v1/health') {
        return json(200, { ok: true, version: '0.1.0' });
      }
      if (path === '/api/v1/op/network_list') {
        return json(200, { ok: true, cursor: 'c:1.1', data: { networks: [{ name: 'default', ssid: 'lab-wifi', country: null, band: 'auto', net_id: 0x5151, hub_host: 'hub-a.test' }] } });
      }
      return json(404, { ok: false, cursor: 'c:1.1', error: { code: 'NOT_FOUND', message: `unknown op ${path.split('/').at(-1)}`, retryable: false } });
    }) as typeof fetch;
    let e: FrError | null = null;
    try {
      await joinNetworkOf(r.hub, { hub: 'http://127.0.0.1:7999' }, { fetch: old });
    } catch (x) {
      e = x as FrError;
    }
    expect(e).toBeInstanceOf(FrError);
    expect(e!.code).toBe('HUB_VERSION_MISMATCH');
    expect(e!.message).toContain("the hub at http://127.0.0.1:7999 does not know network_admit: it runs a version from before the hubs' link");
    expect(e!.hint).toContain('update that hub to this checkout and restart it');
    expect(e!.hint).toContain('nothing was changed here');
    expect(asked).toEqual(['/api/v1/health', '/api/v1/op/network_list', '/api/v1/op/network_admit']);
    // Not joined: no registrar, no network taken, no slot, no members, the name it had.
    expect(registrarOf(r.db)).toBeNull();
    expect(r.db.prepare('SELECT COUNT(*) AS n FROM networks').get()).toEqual({ n: 0 });
    expect(hubIdentity(r.db)).toMatchObject({ name: 'hub-b', slot: null });
    expect(listMembers(r.db)).toEqual([]);
    expect(readNetworkKey(0x5151)).toBeNull();
  });
});
