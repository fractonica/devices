// One registry across the hubs of a network (design multi-hub-m2 §5, §16), without a link or a hub process: the stamps
// `scan` gives (registry/sync.ts), the merge of a copy another hub sent, and the rules above the revs. Each "hub" here is
// a hub.db; rows cross as the wire rows the `registry` message carries. peers-registry.test.ts runs the message over a
// real link, interop-registry.test.ts through hub processes and the C++ node.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { HelloSeen } from '../src/context.ts';
import { type Db, kvGet, kvSet, openDb } from '../src/db.ts';
import { joinNetwork, writeNetwork, writeWifiPassword } from '../src/network.ts';
import { newNetworkKey, writeNetworkKey } from '../src/peers/key.ts';
import { replaceMembers } from '../src/peers/members.ts';
import { forgetDevice, markIdentWritten, markMovedAway, prepareIdentity, type ProvisionRecord, provisionOf, setDeviceHubs, SqliteRegistry, storeSharedIdentity } from '../src/registry/store.ts';
import { applyRows, type ApplyReport, digest, LEGACY_REV_MEMBER, LEGACY_REV_REGISTRAR, nextRev, pruneTombstones, renamedAlias, renamedRows, rowStamps, scan, TOMBSTONE_MS, type WireRow, wireHash, wireRows } from '../src/registry/sync.ts';

const NET = 0x4242;
const SSID = 'attic-wifi-name';
const PASSWORD = 'correct-horse-battery';
let home = '';
const savedHome = process.env.FR_HOME;
let n = 0;
const open: Db[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'fr-registry-sync-'));
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
afterEach(() => {
  for (const db of open.splice(0)) {
    db.close();
  }
});

/** One hub of the network: its hub.db, its id, and whether it is the registrar. */
interface H {
  db: Db;
  self: { hubId: string };
  reg: SqliteRegistry;
  name: string;
}

function hub(name: string, hubId: string, role: 'registrar' | 'member'): H {
  const db = openDb(join(home, `sync-${++n}.db`));
  open.push(db);
  writeNetwork(db, { ssid: SSID, bssid: null, country: null });
  db.prepare('UPDATE networks SET net_id = ?').run(NET);
  if (role === 'member') {
    joinNetwork(db, NET, { url: 'http://127.0.0.1:1', hub_host: 'hub-a.local' }, { name: 'default', ssid: SSID, country: null, band: 'auto' });
  }
  return { db, self: { hubId }, reg: new SqliteRegistry(db), name };
}

const A = () => hub('hub-a', '0000000000aa', 'registrar');
const B = () => hub('hub-b', '0000000000bb', 'member');
const C = () => hub('hub-c', '0000000000cc', 'member');

const id = (k: number) => `aabbcc0d${k.toString(16).padStart(4, '0')}`;

const record = (d: { addr: number | null; alias: string; alias_rev: number; net: number | null }, extra: Partial<ProvisionRecord> = {}): ProvisionRecord => ({
  at: '2026-11-01T10:00:00.000Z',
  via: 'provision',
  build_id: null,
  fw_id: null,
  profile: 'c6-pad',
  board: 'esp32c6-supermini',
  part_profile: 'fr-4mb-v1',
  ident: { offset: 0x9000, size: 0x1000 },
  addr: d.addr!,
  alias: d.alias,
  alias_rev: d.alias_rev,
  epoch_floor: 1,
  net: d.net!,
  hub_host: 'hub-a.local',
  ssid: SSID,
  prov_ts: 1,
  ...extra,
});

/** A board as a provisioning leaves it (on the registrar: an address of its own; on a member: the one given). */
function board(h: H, k: number, alias: string, addr?: number) {
  const prep = addr === undefined ? prepareIdentity(h.db, { deviceId: id(k), alias, profile: 'c6-pad', board: 'esp32c6-supermini', chip: 'esp32c6', net: NET }) : storeSharedIdentity(h.db, { deviceId: id(k), addr, net: NET, alias, alias_rev: 1, epoch_floor: 1, profile: 'c6-pad', board: 'esp32c6-supermini', chip: 'esp32c6', network: 'default' });
  return markIdentWritten(h.db, id(k), record(prep.device), { keepHubs: true });
}

const all = (h: H) => wireRows(h.db, digest(h.db).rows.map(([i]) => i));
const send = (from: H, to: H, rows: WireRow[] = all(from)): ApplyReport => applyRows(to.db, to.self, rows, from.name);

/** Both ways until both hold the same, as a digest and its answers do; the reports of each direction. */
function settle(a: H, b: H): { atA: ApplyReport[]; atB: ApplyReport[] } {
  const out = { atA: [] as ApplyReport[], atB: [] as ApplyReport[] };
  for (let round = 0; round < 6; round++) {
    scan(a.db, a.self);
    scan(b.db, b.self);
    if (digest(a.db).hash === digest(b.db).hash) {
      return out;
    }
    out.atB.push(send(a, b));
    out.atA.push(send(b, a));
  }
  return out;
}

const hello = (k: number, o: Partial<HelloSeen> = {}): HelloSeen => ({ device_id: id(k), addr: 0xfffe, net: NET, epoch: 5, chip: 13, chip_rev: 1, fw_id_prefix: '', descriptor_hash: 0, board_hash: 0, role: 'node', caps: 0, alias: 'x', alias_rev: 0, ota_state: 0, link: 'tcp', ...o });

describe('the revs of a row (scan)', () => {
  it('a rev is the clock in ms, never going back, and above any rev seen', () => {
    const a = A();
    const t0 = nextRev(a.db, 1_800_000_000_000);
    expect(t0).toBe(1_800_000_000_000);
    expect(nextRev(a.db, 1_800_000_000_000)).toBe(t0 + 1);
    expect(nextRev(a.db, 1_700_000_000_000)).toBe(t0 + 2); // the wall clock went back: the rev does not
    expect(nextRev(a.db, 1_800_000_000_500)).toBe(1_800_000_000_500);
  });

  it('stamps a board of the network, and only the part of it that changed afterwards', () => {
    const a = A();
    scan(a.db, a.self); // a fresh hub: nothing from before
    board(a, 1, 'pad');
    a.reg.touchHello(id(9), hello(9, { alias: 'new-0d0009' })); // seen only: this hub's own
    expect(scan(a.db, a.self)).toEqual([id(1)]);
    expect(rowStamps(a.db, id(9))).toBeNull();
    const [w] = all(a);
    expect(w).toMatchObject({ id: id(1), row: [expect.any(Number), a.self.hubId], core: { addr: 1, net: NET, provisioned: true, tags: [], profile: 'c6-pad', chip: 'esp32c6', role: 'node' }, alias: { alias: 'pad', alias_rev: 1 }, hubs: { list: null }, fw: { fw_id: null } });
    expect(w.row[0]).toBeGreaterThan(Date.now() - 5000);
    expect(scan(a.db, a.self)).toEqual([]); // nothing changed: nothing to tell
    // A tag: the row's rev moves, the alias's does not.
    a.reg.update(id(1), { tags: ['kitchen'] });
    expect(scan(a.db, a.self)).toEqual([id(1)]);
    const [tagged] = all(a);
    expect(tagged.row[0]).toBeGreaterThan(w.row[0]);
    expect(tagged.alias!.at).toEqual(w.alias!.at);
    // A rename: the alias's rev moves, the row's does not.
    a.reg.update(id(1), { alias: 'pad-kitchen' });
    scan(a.db, a.self);
    const [named] = all(a);
    expect(named.alias).toMatchObject({ alias: 'pad-kitchen', alias_rev: 2 });
    expect(named.alias!.at[0]).toBeGreaterThan(tagged.alias!.at[0]);
    expect(named.row).toEqual(tagged.row);
    // The hub list and the firmware have their own.
    setDeviceHubs(a.db, id(1), { rev: 1, hubs: [{ host: 'hub-a.local', ip: null }], set_at: '2026-11-21T10:00:00.000Z' });
    a.db.prepare('UPDATE devices SET fw_id = ? WHERE device_id = ?').run('f00dfeedf00dfeed', id(1));
    scan(a.db, a.self);
    const [listed] = all(a);
    expect(listed.hubs).toMatchObject({ list: { rev: 1, hubs: [{ host: 'hub-a.local', ip: null }] } });
    expect(listed.fw).toMatchObject({ fw_id: 'f00dfeedf00dfeed' });
    expect(listed.row).toEqual(tagged.row);
    expect(listed.alias).toEqual(named.alias);
    // What a HELLO moves and no other hub needs (last seen, the epoch) is no change.
    a.reg.touchHello(id(1), hello(1, { addr: 1, alias: 'pad-kitchen', alias_rev: 2, fw_id_prefix: 'f00dfeedf00dfeed', epoch: 77 }));
    expect(scan(a.db, a.self)).toEqual([]);
    expect(wireHash(listed)).toBe(rowStamps(a.db, id(1))!.hash);
  });

  it('nothing on a hub without a network record, and a hub that joins another network starts again', () => {
    const db = openDb(join(home, `sync-${++n}.db`));
    open.push(db);
    const alone = { db, self: { hubId: '0000000000dd' }, reg: new SqliteRegistry(db), name: 'alone' };
    markIdentWritten(db, prepareIdentity(db, { deviceId: id(1), alias: 'pad', profile: null, board: null, chip: null, net: 42 }).device.device_id, record({ addr: 1, alias: 'pad', alias_rev: 1, net: 42 }));
    expect(scan(db, alone.self)).toEqual([]);
    expect(digest(db).rows).toEqual([]);
    // It gets a network: its boards under that net id are the network's.
    writeNetwork(db, { ssid: SSID, bssid: null, country: null });
    db.prepare('UPDATE networks SET net_id = 42').run();
    expect(scan(db, alone.self)).toEqual([id(1)]);
    // It joins another hub's network: what it held of its own is not that network's.
    joinNetwork(db, NET, { url: 'http://127.0.0.1:1', hub_host: 'hub-a.local' }, { name: 'default', ssid: SSID, country: null, band: 'auto' });
    scan(db, alone.self);
    expect(digest(db).rows).toEqual([]);
    expect(kvGet(db, 'registry.sync_net')).toBe(String(NET));
  });
});

describe('a copy from another hub (merge)', () => {
  it('a row made at one hub is at the other, without what is that hub\'s own', () => {
    const a = A();
    const b = B();
    scan(a.db, a.self);
    scan(b.db, b.self);
    board(a, 1, 'pad');
    a.reg.update(id(1), { tags: ['kitchen'] });
    a.reg.touchHello(id(1), hello(1, { addr: 1, alias: 'pad', alias_rev: 1, epoch: 9 }));
    scan(a.db, a.self);
    const report = send(a, b);
    expect(report).toMatchObject({ taken: 1, changed: [id(1)], differ: [], conflicts: [], effects: [{ kind: 'new', device: id(1), alias: 'pad', addr: 1, provisioned: true }] });
    expect(b.reg.get(id(1))).toMatchObject({ addr: 1, net: NET, alias: 'pad', alias_rev: 1, tags: ['kitchen'], provisioned: true, profile: 'c6-pad', board: 'esp32c6-supermini', chip: 'esp32c6', last_seen: null, last_epoch: null });
    expect(provisionOf(b.db, id(1))).toBeNull(); // what hub A wrote into its fr_ident is hub A's record
    expect(digest(b.db).hash).toBe(digest(a.db).hash);
    // The address is retired here too: this hub never hands it out, should it allocate one day.
    expect(kvGet(b.db, 'registry.addr_hwm')).toBe('1');
    // The same copy again changes nothing.
    expect(send(a, b)).toMatchObject({ taken: 1, changed: [], effects: [] });
  });

  it('an edit at a member is at the registrar and at a third hub; a rename here and a tag there both stay', () => {
    const a = A();
    const b = B();
    const c = C();
    board(a, 1, 'pad');
    settle(a, b);
    settle(a, c);
    // While B and A do not see each other: B tags it, A renames it.
    b.reg.update(id(1), { tags: ['desk'] });
    a.reg.update(id(1), { alias: 'pad-lab' });
    const { atA, atB } = settle(a, b);
    expect(a.reg.get(id(1))).toMatchObject({ alias: 'pad-lab', alias_rev: 2, tags: ['desk'] });
    expect(b.reg.get(id(1))).toMatchObject({ alias: 'pad-lab', alias_rev: 2, tags: ['desk'] });
    expect(atB.flatMap((r) => r.effects)).toEqual([{ kind: 'alias', device: id(1), alias: 'pad-lab', alias_rev: 2, previous: 'pad', renamed: false }]);
    expect(atA.flatMap((r) => r.effects)).toEqual([{ kind: 'row', device: id(1), alias: 'pad-lab', addr_changed: false }]);
    // The third hub hears of both from either.
    settle(b, c);
    expect(c.reg.get(id(1))).toMatchObject({ alias: 'pad-lab', alias_rev: 2, tags: ['desk'] });
    expect(new Set([a, b, c].map((h) => digest(h.db).hash)).size).toBe(1);
  });

  it('both rename one board: the higher alias_rev wins, then the later write, then the higher hub id', () => {
    const a = A();
    const b = B();
    board(a, 1, 'pad');
    settle(a, b);
    // B renames twice, A once: alias_rev 3 against 2.
    b.reg.update(id(1), { alias: 'pad-b1' });
    b.reg.update(id(1), { alias: 'pad-b2' });
    a.reg.update(id(1), { alias: 'pad-a1' });
    settle(a, b);
    expect([a, b].map((h) => [h.reg.get(id(1))!.alias, h.reg.get(id(1))!.alias_rev])).toEqual([['pad-b2', 3], ['pad-b2', 3]]);
    // Once each (alias_rev 4 on both): the later write.
    a.reg.update(id(1), { alias: 'pad-first' });
    scan(a.db, a.self);
    kvSet(b.db, 'registry.clock', String(Date.now() + 60_000)); // hub B writes a minute later
    b.reg.update(id(1), { alias: 'pad-later' });
    settle(a, b);
    expect([a, b].map((h) => h.reg.get(id(1))!.alias)).toEqual(['pad-later', 'pad-later']);
    expect(a.reg.get(id(1))!.alias_rev).toBe(4);
    // In the same ms: the higher hub id (B's).
    const at = Number(kvGet(a.db, 'registry.clock')) + 1000;
    for (const [h, alias] of [[a, 'pad-x'], [b, 'pad-y']] as const) {
      kvSet(h.db, 'registry.clock', String(at - 1));
      h.reg.update(id(1), { alias });
      expect(scan(h.db, h.self, [id(1)])).toEqual([id(1)]);
    }
    expect(all(a)[0].alias!.at[0]).toBe(all(b)[0].alias!.at[0]);
    settle(a, b);
    expect([a, b].map((h) => h.reg.get(id(1))!.alias)).toEqual(['pad-y', 'pad-y']);
  });

  it('one alias given to two boards on two hubs that could not see each other: the later write keeps it', () => {
    const a = A();
    const b = B();
    const c = C();
    board(a, 1, 'pad-one');
    board(a, 2, 'pad-two');
    settle(a, b);
    settle(a, c);
    a.reg.update(id(1), { alias: 'kitchen' });
    scan(a.db, a.self);
    kvSet(b.db, 'registry.clock', String(Date.now() + 60_000)); // hub B names the other board so a minute later
    b.reg.update(id(2), { alias: 'kitchen' });
    const { atA, atB } = settle(a, b);
    const short = id(1).slice(-3);
    for (const h of [a, b]) {
      expect(h.reg.get(id(2))).toMatchObject({ alias: 'kitchen', alias_rev: 2, tags: [] });
      expect(h.reg.get(id(1))).toMatchObject({ alias: `kitchen-${short}`, alias_rev: 3, tags: ['renamed'] });
      expect(renamedRows(h.db)).toEqual([{ device_id: id(1), alias: `kitchen-${short}` }]);
    }
    // Each hub says what it did: the board that lost the name is told by the hub that holds it, at the new alias_rev.
    // Hub B, which heard first, renamed the copy that arrived; hub A then took that rename as any other.
    expect(atB.flatMap((r) => r.effects).filter((e) => e.kind === 'alias')).toContainEqual({ kind: 'alias', device: id(1), alias: `kitchen-${short}`, alias_rev: 3, previous: 'pad-one', renamed: true });
    expect(atA.flatMap((r) => r.effects).filter((e) => e.kind === 'alias')).toContainEqual({ kind: 'alias', device: id(1), alias: `kitchen-${short}`, alias_rev: 3, previous: 'kitchen', renamed: false });
    expect(digest(a.db).hash).toBe(digest(b.db).hash);
    // The third hub, which saw neither write, ends where they did.
    settle(a, c);
    expect(c.reg.get(id(1))).toMatchObject({ alias: `kitchen-${short}`, tags: ['renamed'] });
    expect(c.reg.get(id(2))).toMatchObject({ alias: 'kitchen' });
    expect(digest(c.db).hash).toBe(digest(a.db).hash);
    // A person names it and takes the tag off: that is an ordinary edit.
    a.reg.update(id(1), { alias: 'pantry', tags: [] });
    settle(a, b);
    expect(b.reg.get(id(1))).toMatchObject({ alias: 'pantry', tags: [] });
    expect(renamedRows(b.db)).toEqual([]);
  });

  it('the hub that holds the losing board hears first: it renames its own row, and the other hub ends the same', () => {
    const a = A();
    const b = B();
    board(a, 1, 'pad-one');
    board(a, 2, 'pad-two');
    settle(a, b);
    a.reg.update(id(1), { alias: 'kitchen' });
    scan(a.db, a.self);
    kvSet(b.db, 'registry.clock', String(Date.now() + 60_000));
    b.reg.update(id(2), { alias: 'kitchen' });
    scan(b.db, b.self);
    const atA = send(b, a); // hub A, where board 1 was named kitchen, is told of board 2's later claim
    const short = id(1).slice(-3);
    expect(atA.effects).toEqual([
      { kind: 'alias', device: id(1), alias: `kitchen-${short}`, alias_rev: 3, previous: 'kitchen', renamed: true },
      { kind: 'alias', device: id(2), alias: 'kitchen', alias_rev: 2, previous: 'pad-two', renamed: false },
    ]);
    expect(atA.changed.sort()).toEqual([id(1), id(2)]);
    expect(a.reg.get(id(1))).toMatchObject({ alias: `kitchen-${short}`, alias_rev: 3, tags: ['renamed'] });
    settle(a, b);
    expect(b.reg.get(id(1))).toMatchObject({ alias: `kitchen-${short}`, alias_rev: 3, tags: ['renamed'] });
    expect(b.reg.get(id(2))).toMatchObject({ alias: 'kitchen' });
    expect(digest(a.db).hash).toBe(digest(b.db).hash);
  });

  it('a board seen only by this hub gives way to a board of the network with its alias, and stays this hub\'s own', () => {
    const a = A();
    const b = B();
    scan(b.db, b.self);
    b.reg.touchHello(id(7), hello(7, { alias: 'pad' })); // seen only at B, calling itself pad
    board(a, 1, 'pad');
    settle(a, b);
    expect(b.reg.get(id(1))).toMatchObject({ alias: 'pad', provisioned: true });
    expect(b.reg.get(id(7))).toMatchObject({ alias: `pad-${id(7).slice(-3)}`, provisioned: false, tags: ['renamed'] });
    expect(rowStamps(b.db, id(7))).toBeNull();
    expect(a.reg.get(id(7))).toBeNull();
    expect(renamedAlias(a.db, 'a-name-as-long-as-an-alias-gets', id(1))).toBe(`a-name-as-long-as-an-alias-${id(1).slice(-3)}`);
  });

  it('the hub list follows its last write, also back to an older list (a trial the board dropped)', () => {
    const a = A();
    const b = B();
    board(a, 1, 'pad');
    setDeviceHubs(a.db, id(1), { rev: 2, hubs: [{ host: 'hub-a.local', ip: null }, { host: 'hub-b.local', ip: '192.168.1.30' }], set_at: 't2' });
    settle(a, b);
    expect(b.reg.get(id(1))!.hubs).toMatchObject({ rev: 2 });
    // B, which holds the board, set a list on trial (rev 3), then read the board: it went back to rev 2.
    setDeviceHubs(b.db, id(1), { rev: 3, hubs: [{ host: 'nowhere.local', ip: null }], set_at: 't3' });
    settle(a, b);
    expect(a.reg.get(id(1))!.hubs).toMatchObject({ rev: 3 });
    setDeviceHubs(b.db, id(1), { rev: 2, hubs: [{ host: 'hub-a.local', ip: null }, { host: 'hub-b.local', ip: '192.168.1.30' }], set_at: 't4' });
    settle(a, b);
    expect(a.reg.get(id(1))!.hubs).toMatchObject({ rev: 2, hubs: [{ host: 'hub-a.local' }, { host: 'hub-b.local' }] });
    // A flash took the list away (06 §6.3): gone at the other hub too.
    setDeviceHubs(a.db, id(1), null);
    settle(a, b);
    expect(b.reg.get(id(1))!.hubs).toBeNull();
  });

  it('a deleted row leaves a tombstone that an older copy does not undo, and a later write does', () => {
    const a = A();
    const b = B();
    const c = C();
    board(a, 1, 'pad');
    board(a, 2, 'lamp');
    settle(a, b);
    settle(a, c);
    const old = all(c).find((w) => w.id === id(1))!;
    // Deleted at A while C is away.
    expect(forgetDevice(a.db, id(1))).toBe(true);
    expect(scan(a.db, a.self)).toEqual([id(1)]);
    expect(rowStamps(a.db, id(1))).toMatchObject({ gone: true, row_hub: a.self.hubId });
    expect(all(a).find((w) => w.id === id(1))).toEqual({ id: id(1), row: [expect.any(Number), a.self.hubId], gone: true });
    const atB = send(a, b);
    expect(atB.effects).toEqual([{ kind: 'gone', device: id(1), alias: 'pad' }]);
    expect(b.reg.get(id(1))).toBeNull();
    // C comes back with its old copy: it does not bring the row back at A or B, and loses its own.
    expect(send(c, a, [old])).toMatchObject({ taken: 0, changed: [], differ: [id(1)], effects: [] });
    expect(a.reg.get(id(1))).toBeNull();
    settle(a, c);
    expect(c.reg.get(id(1))).toBeNull();
    expect(c.reg.get(id(2))).toMatchObject({ alias: 'lamp' });
    expect(new Set([a, b, c].map((h) => digest(h.db).hash)).size).toBe(1);
    expect(digest(a.db).tombstones).toBe(1);
    // The board says HELLO at B: a row seen only, this hub's own, not the network's row again.
    b.reg.touchHello(id(1), hello(1, { addr: 1, alias: 'pad', alias_rev: 1 }));
    expect(scan(b.db, b.self)).toEqual([]);
    expect(rowStamps(b.db, id(1))).toMatchObject({ gone: true });
    // Provisioned again at the registrar: a write after the delete, so the row is back everywhere, at a new address.
    const again = board(a, 1, 'pad');
    expect(again.addr).toBe(3);
    settle(a, b);
    settle(a, c);
    expect(b.reg.get(id(1))).toMatchObject({ addr: 3, alias: 'pad', provisioned: true });
    expect(c.reg.get(id(1))).toMatchObject({ addr: 3 });
    expect(digest(c.db).tombstones).toBe(0);
    // A row edited after a delete it had not heard of stays: the later write.
    forgetDevice(a.db, id(2));
    scan(a.db, a.self);
    kvSet(b.db, 'registry.clock', String(Date.now() + 60_000));
    b.reg.update(id(2), { tags: ['kept'] });
    settle(a, b);
    expect(a.reg.get(id(2))).toMatchObject({ alias: 'lamp', tags: ['kept'] });
    // Tombstones are dropped after a year.
    forgetDevice(a.db, id(2));
    scan(a.db, a.self);
    expect(pruneTombstones(a.db, Date.now() + TOMBSTONE_MS - 60_000)).toBe(0);
    expect(pruneTombstones(a.db, Date.now() + TOMBSTONE_MS + 60_000)).toBe(1);
  });

  it('an address is never replaced by another one: neither copy changes, and both hubs say so', () => {
    const a = A();
    const b = B();
    board(a, 1, 'pad');
    board(a, 2, 'lamp');
    board(b, 1, 'pad', 9); // hub B holds the same board at another address
    const { atA, atB } = settle(a, b);
    expect(a.reg.get(id(1))).toMatchObject({ addr: 1 });
    expect(b.reg.get(id(1))).toMatchObject({ addr: 9 });
    expect(atB[0].conflicts).toEqual([{ kind: 'addr', device: id(1), message: `pad (${id(1)}) is addr 9 here and addr 1 at hub hub-a: neither copy was changed` }]);
    expect(atA[0].conflicts).toEqual([{ kind: 'addr', device: id(1), message: `pad (${id(1)}) is addr 1 here and addr 9 at hub hub-b: neither copy was changed` }]);
    // The rest of the registry still crosses.
    expect(b.reg.get(id(2))).toMatchObject({ addr: 2, alias: 'lamp' });
    // An address another board holds here: the row is not taken.
    const c = C();
    board(c, 5, 'other', 2);
    const atC = send(a, c);
    expect(atC.conflicts.map((x) => [x.kind, x.device])).toEqual([['addr_held', id(2)]]);
    expect(c.reg.get(id(2))).toBeNull();
    expect(c.reg.get(id(1))).toMatchObject({ addr: 1 });
    // A copy under another net id, and one that is no row, are left out.
    const [good] = all(a);
    expect(send(a, c, [{ ...good, id: id(8), core: { ...good.core!, net: 7, addr: 77 } }]).conflicts.map((x) => x.kind)).toEqual(['net']);
    expect(send(a, c, [{ id: 'zz', row: [1, 'x'] } as WireRow, { ...good, id: id(8), alias: { ...good.alias!, alias: 'Not A Label!' } }]).conflicts.map((x) => x.kind)).toEqual(['bad', 'bad']);
    expect(c.reg.get(id(8))).toBeNull();
  });
});

describe('the first merge of two databases from before the registry was replicated', () => {
  /** The registrar's 14 boards, 4 of them also at the member (shared by hand: the same ids and addresses), nothing stamped. */
  function before23() {
    const a = A();
    const b = B();
    for (let k = 1; k <= 14; k++) {
      const d = board(a, k, `board-${k}`);
      if (k <= 4) {
        a.reg.update(id(k), { tags: ['home'] });
        setDeviceHubs(a.db, id(k), { rev: 2, hubs: [{ host: 'hub-b.local', ip: null }, { host: 'hub-a.local', ip: null }], set_at: 't' });
        board(b, k, `board-${k}`, d.addr!);
        b.reg.update(id(k), { tags: ['home'] });
        setDeviceHubs(b.db, id(k), { rev: 2, hubs: [{ host: 'hub-b.local', ip: null }, { host: 'hub-a.local', ip: null }], set_at: 't' });
      }
    }
    a.reg.touchHello(id(99), hello(99, { alias: 'new-0d0063' })); // a board on the registrar's cable, seen only
    return { a, b };
  }
  const identity = (h: H) => h.reg.list().map((d) => [d.device_id, d.addr, d.net, d.alias, d.alias_rev, d.hubs?.rev ?? null, d.tags.join(',')]);

  it('both hold 14 rows afterwards; no address, alias or hub list changed; nothing is told to a board', () => {
    const { a, b } = before23();
    const beforeA = identity(a);
    const beforeB = identity(b);
    expect(kvGet(a.db, 'registry.sync_net')).toBeUndefined();
    scan(a.db, a.self);
    scan(b.db, b.self);
    // The revs of rows from before: the registrar's copy outranks the member's; the hub list's are equal.
    expect(all(a)[0]).toMatchObject({ row: [LEGACY_REV_REGISTRAR, a.self.hubId], alias: { at: [LEGACY_REV_REGISTRAR, a.self.hubId] }, hubs: { at: [0, a.self.hubId] } });
    expect(all(b)[0]).toMatchObject({ row: [LEGACY_REV_MEMBER, b.self.hubId], alias: { at: [LEGACY_REV_MEMBER, b.self.hubId] }, hubs: { at: [0, b.self.hubId] } });
    expect(digest(a.db).rows).toHaveLength(14); // the board seen only is not the network's
    expect(digest(b.db).rows).toHaveLength(4);
    const { atA, atB } = settle(a, b);
    expect(identity(a)).toEqual(beforeA);
    expect(identity(b).filter(([d]) => beforeB.some(([x]) => x === d))).toEqual(beforeB);
    expect(b.reg.list()).toHaveLength(14);
    expect(a.reg.list()).toHaveLength(15);
    expect(identity(b)).toEqual(identity(a).filter(([d]) => d !== id(99)));
    expect(digest(a.db).hash).toBe(digest(b.db).hash);
    // At the member: ten new rows, and nothing else. No alias changed anywhere, so no board is told a name.
    const effectsB = atB.flatMap((r) => r.effects);
    expect(effectsB.map((e) => e.kind)).toEqual(Array(10).fill('new'));
    expect(atA.flatMap((r) => r.effects)).toEqual([]);
    expect([...atA, ...atB].flatMap((r) => r.conflicts)).toEqual([]);
    // The four shared rows now carry one rev at both hubs: the registrar's.
    expect(all(b).find((w) => w.id === id(1))).toMatchObject({ row: [LEGACY_REV_REGISTRAR, a.self.hubId] });
    // Each hub keeps its own record of what it wrote.
    expect(provisionOf(b.db, id(1))).toMatchObject({ addr: 1 });
    expect(provisionOf(b.db, id(9))).toBeNull();
  });

  it('where the two old copies differ: the registrar\'s row, the higher alias_rev, the hub list with the higher rev, and never another address', () => {
    const { a, b } = before23();
    // Tags that only one hub got: the registrar's copy is kept.
    a.reg.update(id(1), { tags: ['home', 'lab-only'] });
    b.reg.update(id(2), { tags: ['home', 'member-only'] });
    // A rename only the member got (alias_rev 2 against 1): kept, on both.
    b.reg.update(id(3), { alias: 'renamed-at-b' });
    // A hub list the member read from the board later (rev 3 against 2): kept, on both.
    setDeviceHubs(b.db, id(4), { rev: 3, hubs: [{ host: 'hub-b.local', ip: null }], set_at: 't3' });
    // An address that differs: never overwritten.
    b.db.prepare('UPDATE devices SET addr = 40 WHERE device_id = ?').run(id(2));
    // The firmware each hub last saw the board run: the hub that saw it later is right (board 1 was at the member last).
    a.db.prepare("UPDATE devices SET fw_id = 'aaaaaaaaaaaaaaaa', last_seen = '2026-11-01T10:00:00.000Z' WHERE device_id = ?").run(id(1));
    b.db.prepare("UPDATE devices SET fw_id = 'bbbbbbbbbbbbbbbb', last_seen = '2026-11-20T10:00:00.000Z' WHERE device_id = ?").run(id(1));
    const { atA, atB } = settle(a, b);
    for (const h of [a, b]) {
      expect(h.reg.get(id(1))!.tags).toEqual(['home', 'lab-only']);
      expect(h.reg.get(id(1))!.fw_id).toBe('bbbbbbbbbbbbbbbb');
      expect(h.reg.get(id(3))).toMatchObject({ alias: 'renamed-at-b', alias_rev: 2 });
      expect(h.reg.get(id(4))!.hubs).toMatchObject({ rev: 3, hubs: [{ host: 'hub-b.local' }] });
    }
    expect(a.reg.get(id(2))).toMatchObject({ addr: 2, tags: ['home'] });
    expect(b.reg.get(id(2))).toMatchObject({ addr: 40, tags: ['home', 'member-only'] });
    const conflicts = [...atA, ...atB].flatMap((r) => r.conflicts);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(new Set(conflicts.map((c) => `${c.kind} ${c.device}`))).toEqual(new Set([`addr ${id(2)}`]));
    // Each hub says it of its own copy.
    expect(new Set(conflicts.map((c) => c.message))).toEqual(new Set([`board-2 (${id(2)}) is addr 40 here and addr 2 at hub hub-a: neither copy was changed`, `board-2 (${id(2)}) is addr 2 here and addr 40 at hub hub-b: neither copy was changed`]));
    // The registrar was told one alias and one hub list; the member one row. Nothing else moved.
    expect(atA.flatMap((r) => r.effects).map((e) => `${e.kind} ${e.device}`).sort()).toEqual([`alias ${id(3)}`]);
    expect(atB.flatMap((r) => r.effects).filter((e) => e.kind !== 'new').map((e) => `${e.kind} ${e.device}`)).toEqual([`row ${id(1)}`]);
    // The two hubs differ in that one row only, and say so in what they compare.
    const da = new Map(digest(a.db).rows);
    const differing = digest(b.db).rows.filter(([d, h]) => da.get(d) !== h).map(([d]) => d);
    expect(differing).toEqual([id(2)]);
  });

  it('the tag `moved`: off a provisioned row of the network, and off a row another hub of the network turns out to hold', () => {
    const a = A();
    const b = B();
    // Before 2.3 the registrar flashed board 1 for the hub that is now a member (`--for-hub`, when that hub was another
    // network's): its row here is seen only and tagged moved. Board 2 kept a stale tag on a provisioned row.
    board(a, 1, 'pad');
    markMovedAway(a.db, id(1), { ...record({ addr: 1, alias: 'pad', alias_rev: 1, net: NET }), for_hub: 'http://127.0.0.1:7520' });
    board(a, 2, 'lamp');
    a.reg.update(id(2), { tags: ['moved', 'desk'] });
    expect(a.reg.get(id(1))).toMatchObject({ addr: null, provisioned: false, tags: ['moved'] });
    board(b, 1, 'pad', 30); // the member holds it, at the address the network gave it since
    scan(a.db, a.self);
    scan(b.db, b.self);
    expect(a.reg.get(id(2))!.tags).toEqual(['desk']); // the first scan took the stale tag off
    expect(rowStamps(a.db, id(1))).toBeNull(); // a row seen only is this hub's own until the network's arrives
    const { atA } = settle(a, b);
    expect(a.reg.get(id(1))).toMatchObject({ addr: 30, net: NET, alias: 'pad', provisioned: true, tags: [] });
    expect(atA.flatMap((r) => r.effects)).toContainEqual({ kind: 'new', device: id(1), alias: 'pad', addr: 30, provisioned: true });
    // Its record no longer says "another hub's": the port policy adopts its port again.
    const rec = provisionOf(a.db, id(1)) as ProvisionRecord;
    expect(rec.for_hub).toBeUndefined();
    expect(rec.shared_with).toEqual(['http://127.0.0.1:7520']);
    expect(b.reg.get(id(2))).toMatchObject({ tags: ['desk'] });
    expect(digest(a.db).hash).toBe(digest(b.db).hash);
  });
});

describe('what crosses and what does not', () => {
  it('no password, no key, no Wi-Fi name and no provision record is in a row or a digest', () => {
    const a = A();
    writeWifiPassword('default', PASSWORD);
    const key = newNetworkKey();
    writeNetworkKey(NET, key);
    board(a, 1, 'pad');
    a.reg.update(id(1), { tags: ['kitchen'] });
    forgetDevice(a.db, board(a, 2, 'lamp').device_id);
    board(a, 3, 'lamp');
    scan(a.db, a.self);
    const sent = JSON.stringify([all(a), digest(a.db)]);
    for (const secret of [PASSWORD, key.toString('hex'), key.toString('base64'), SSID, 'part_profile', 'prov_ts', 'hub_host', 'last_seen']) {
      expect(sent, secret).not.toContain(secret);
    }
    expect(Object.keys(all(a)[0]).sort()).toEqual(['alias', 'core', 'fw', 'hubs', 'id', 'row']);
    expect(Object.keys(all(a)[0].core!).sort()).toEqual(['addr', 'board', 'chip', 'net', 'network', 'profile', 'provisioned', 'role', 'tags']);
    // Nothing of it reached the sync table either.
    const table = JSON.stringify(a.db.prepare('SELECT * FROM registry_sync').all());
    expect(table).not.toContain(PASSWORD);
    expect(table).not.toContain(SSID);
  });

  it.each([20261121, 1, 2, 3, 7, 42, 99, 12345, 777, 31337, 5, 8])('three hubs that edit, rename, delete and meet in any order end with one registry (seed %i)', (start) => {
    let seed = start;
    const rnd = (m: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % m;
    };
    const hubs = [A(), B(), C()];
    for (let k = 1; k <= 6; k++) {
      board(hubs[0], k, `board-${k}`);
    }
    settle(hubs[0], hubs[1]);
    settle(hubs[0], hubs[2]);
    for (let step = 0; step < 300; step++) {
      const h = hubs[rnd(3)];
      const k = 1 + rnd(6);
      const d = h.reg.get(id(k));
      const what = rnd(10);
      try {
        if (what < 3 && d) {
          h.reg.update(id(k), { tags: [`t${rnd(4)}`] });
        } else if (what < 6 && d) {
          h.reg.update(id(k), { alias: `name-${rnd(5)}` }); // few names: clashes on purpose
        } else if (what === 6 && d) {
          setDeviceHubs(h.db, id(k), rnd(3) ? { rev: rnd(5), hubs: [{ host: `hub-${rnd(3)}.local`, ip: null }], set_at: 't' } : null);
        } else if (what === 7 && d && rnd(4) === 0) {
          forgetDevice(h.db, id(k));
        } else if (what === 8) {
          // one link, one way, some of the rows: a message that crossed while others did not
          const to = hubs[rnd(3)];
          if (to !== h) {
            scan(h.db, h.self);
            send(h, to, all(h).filter(() => rnd(2) === 0));
          }
        } else if (what === 9 && rnd(3) === 0) {
          kvSet(h.db, 'registry.clock', String(Number(kvGet(h.db, 'registry.clock') ?? Date.now()) + rnd(5000))); // clocks that disagree
        }
      } catch {
        // an alias another board holds here: refused, as device_update refuses it
      }
      if (rnd(4) === 0) {
        scan(h.db, h.self);
      }
    }
    // Every pair meets, a few times round: each merge may write (a board renamed), and that has to cross too.
    for (let round = 0; round < 6; round++) {
      for (const [x, y] of [[0, 1], [1, 2], [0, 2]] as const) {
        settle(hubs[x], hubs[y]);
      }
    }
    const hashes = hubs.map((h) => digest(h.db).hash);
    expect(new Set(hashes).size, JSON.stringify(hubs.map((h) => digest(h.db).rows))).toBe(1);
    const rows = hubs.map((h) => h.reg.list().map((d) => [d.device_id, d.addr, d.alias, d.alias_rev, d.tags.join(','), d.hubs?.rev ?? null, d.provisioned]));
    expect(rows[1]).toEqual(rows[0]);
    expect(rows[2]).toEqual(rows[0]);
    // And aliases stayed unique on every hub (the table's own rule would have thrown otherwise).
    expect(new Set(rows[0].map((r) => r[2])).size).toBe(rows[0].length);
  });
});

describe('a board that carries a newer alias than this hub\'s row', () => {
  it('with several hubs the row follows the board; a hub that is alone keeps its own name, as before', () => {
    const a = A();
    board(a, 1, 'pad');
    const members = (h: H, count: number) =>
      replaceMembers(h.db, [{ id: '0000000000aa', name: 'hub-a', host: 'a', addr: null, link_port: 1, slot: 0, joined_at: 't' }, { id: '0000000000bb', name: 'hub-b', host: 'b', addr: null, link_port: 2, slot: 1, joined_at: 't' }].slice(0, count), 1);
    // Alone: the registry wins, with a rev above the board's (06 §6.3).
    expect(a.reg.touchHello(id(1), hello(1, { addr: 1, alias: 'kitchen', alias_rev: 4 }))).toMatchObject({ alias: 'pad', alias_rev: 5 });
    // In a network of two hubs: another hub renamed it while this one was away.
    members(a, 2);
    expect(a.reg.touchHello(id(1), hello(1, { addr: 1, alias: 'kitchen', alias_rev: 9 }))).toMatchObject({ alias: 'kitchen', alias_rev: 9 });
    // Not when another board holds that name here, and not for an alias_rev that is no higher.
    board(a, 2, 'lamp');
    expect(a.reg.touchHello(id(1), hello(1, { addr: 1, alias: 'lamp', alias_rev: 12 }))).toMatchObject({ alias: 'kitchen', alias_rev: 13 });
    expect(a.reg.touchHello(id(1), hello(1, { addr: 1, alias: 'older', alias_rev: 13 }))).toMatchObject({ alias: 'kitchen', alias_rev: 14 });
  });
});
