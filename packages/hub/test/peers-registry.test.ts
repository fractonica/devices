// One registry across the hubs of a network (design multi-hub-m2 §5, §16) over the real link, without hub processes:
// each hub here is a router, a SQLite registry and the peers part in this process, joined by TLS on loopback with a
// fast heartbeat. The `registry` message both ways when a link comes up and at each change, three hubs, a hub that was
// away, one alias given twice (and the board that lost it told by the hub that holds it), a delete, a member that asks
// the registrar for an address (the registrar up, away, two members at once), a peer that does not replicate and one
// that says it does and answers nothing, and what every `registry` message carried. registry-sync.test.ts has the merge
// alone; interop-registry.test.ts runs it through hub processes and the C++ node.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { REGISTRY_HASH, slotRun } from '@fractonica/protocol';
import { decodeNodeSetAliasArgs, findCap, PORT } from '@fractonica/protocol/gen';

import type { Device, HelloSeen, HubRunOptions, Presence, Registry } from '../src/context.ts';
import { HUB_SLOT_KEY, kvSet } from '../src/db.ts';
import { joinNetwork, writeNetwork, writeWifiPassword } from '../src/network.ts';
import { hubId, setHubName } from '../src/peers/identity.ts';
import { createPeers, type Peers, peersView } from '../src/peers/index.ts';
import { newNetworkKey, writeNetworkKey } from '../src/peers/key.ts';
import { type HelloInfo, type LinkTarget, PeerLinks, type PeerLinkTiming } from '../src/peers/link.ts';
import { replaceMembers } from '../src/peers/members.ts';
import { installPassing } from '../src/peers/passing.ts';
import type { PeerMessage } from '../src/peers/wire.ts';
import { enrollOp } from '../src/registry/enroll.ts';
import { forgetDevice, SqliteRegistry } from '../src/registry/store.ts';
import { digest } from '../src/registry/sync.ts';
import { type FakeRegistry, type Rig, rig, until } from './fake-node.ts';

const NET = 0x5151;
const SSID = 'attic-wifi-name';
const PASSWORD = 'correct-horse-battery';
const FAST: Partial<PeerLinkTiming> = { pingMs: 60, awayMs: 300, backoffMinMs: 20, backoffMaxMs: 160, connectMs: 800, helloMs: 600 };
const SET_ALIAS = findCap('fr.node')!.commands.find((c) => c.name === 'set_alias')!.id;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let home = '';
let tap = '';
let key: Buffer;
const saved = { home: process.env.FR_HOME, tap: process.env.FR_TEST_PEER_REGISTRY_TAP };
const cleanups: (() => unknown)[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'fr-peers-registry-'));
  tap = join(home, 'registry-tap.jsonl');
  process.env.FR_HOME = home;
  process.env.FR_TEST_PEER_REGISTRY_TAP = tap;
  key = newNetworkKey();
  writeNetworkKey(NET, key);
  writeWifiPassword('default', PASSWORD);
});
afterAll(() => {
  for (const [k, v] of [['FR_HOME', saved.home], ['FR_TEST_PEER_REGISTRY_TAP', saved.tap]] as const) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  rmSync(home, { recursive: true, force: true });
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

/** The SQLite registry of a rig's db, which exists only once the rig does. */
class LateRegistry implements Registry {
  inner: SqliteRegistry | null = null;
  get = (id: string) => this.inner?.get(id) ?? null;
  byAddr = (addr: number) => this.inner?.byAddr(addr) ?? null;
  byAlias = (alias: string) => this.inner?.byAlias(alias) ?? null;
  list = () => this.inner?.list() ?? [];
  resolve = (selector: string, presence: (id: string) => Presence) => this.inner!.resolve(selector, presence);
  touchHello = (id: string, hello: HelloSeen) => this.inner!.touchHello(id, hello);
  update = (id: string, patch: Partial<Pick<Device, 'alias' | 'tags'>>) => this.inner!.update(id, patch);
}

interface TestHub {
  r: Rig;
  reg: SqliteRegistry;
  peers: Peers;
  id: string;
  name: string;
  /** Everything this hub printed as JSON lines is not captured here; its warnings are what hub_status would add. */
  warnings(): string[];
}

async function testHub(name: string, role: 'registrar' | 'member', hubEpoch: number): Promise<TestHub> {
  const late = new LateRegistry();
  const h = { peers: null as unknown as Peers };
  const r = await rig({ hubEpoch, registry: late as unknown as FakeRegistry, heldOverTcp: (id) => h.peers?.heldOverTcp(id) ?? null });
  late.inner = new SqliteRegistry(r.db);
  setHubName(r.db, name);
  writeNetwork(r.db, { ssid: SSID, bssid: null, country: null });
  r.db.prepare('UPDATE networks SET net_id = ?').run(NET);
  if (role === 'member') {
    joinNetwork(r.db, NET, { url: 'http://127.0.0.1:1', hub_host: 'hub-a.local' }, { name: 'default', ssid: SSID, country: null, band: 'auto' });
  }
  r.router.refreshNet();
  const run = { nodeHost: '127.0.0.1', peerPort: 0 } as HubRunOptions;
  Object.assign(r.hub, { startedAt: Date.now(), run });
  h.peers = createPeers(() => r.hub, run, { timing: FAST, registry: { scanMs: 40, digestMs: 250 } });
  (r.hub as { peers?: Peers }).peers = h.peers;
  const stopPassing = installPassing(r.hub);
  await h.peers.start();
  cleanups.push(async () => {
    stopPassing();
    await h.peers.stop();
    await r.close();
  });
  return { r, reg: late.inner, peers: h.peers, id: hubId(r.db), name, warnings: () => h.peers.warnings?.() ?? [] };
}

/** The member list a join would have left in each hub's db, at the ports the hubs listen on; the first is the registrar. */
async function joined(...hubs: TestHub[]): Promise<void> {
  const members = hubs.map((h, slot) => ({ id: h.id, name: h.name, host: '127.0.0.1', addr: '127.0.0.1', link_port: h.peers.status().link.port!, slot, joined_at: '2026-11-21T10:00:00.000Z' }));
  hubs.forEach((h, slot) => {
    replaceMembers(h.r.db, members, 1);
    kvSet(h.r.db, HUB_SLOT_KEY, String(slot));
    // As a member's next start would count (db.ts nextHubRun, design multi-hub-m2 §17): its cursors carry its slot.
    for (const store of [h.r.logs, h.r.events] as unknown as { run: number }[]) {
      store.run = slotRun(slot, 1);
    }
  });
  await Promise.all(hubs.map((h) => h.peers.refresh()));
  await until(() => hubs.every((h) => h.peers.status().peers.length === hubs.length - 1 && h.peers.status().peers.every((p) => p.reachable)), 4000, 'every pair linked');
}

const id = (k: number) => `aabbcc0e${k.toString(16).padStart(4, '0')}`;
const hashOf = (h: TestHub) => digest(h.r.db).hash;
const inStep = (...hubs: TestHub[]) => until(() => new Set(hubs.map(hashOf)).size === 1 && hubs.every((h) => h.peers.status().peers.every((v) => !v.reachable || h.peers.status().registry.peers[v.id]?.in_step === true)), 4000, `${hubs.map((h) => h.name).join(', ')} to hold one registry`);

/** A board enrolled at `h` as device_enroll does it (on a member: the address from the registrar over the link). */
const enroll = (h: TestHub, k: number, alias: string) => enrollOp(h.r.hub, { device_id: id(k), chip: 'esp32c6', profile: 'c6-pad', alias });

const tapped = (): { dir: 'tx' | 'rx'; peer: string; msg: PeerMessage & { k?: string; rows?: { id: string }[] } }[] =>
  existsSync(tap)
    ? readFileSync(tap, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

describe('the registry over the link (design multi-hub-m2 step 2.3)', () => {
  it('two hubs: what each held when the link came up is at both, and a change crosses at once', async () => {
    const a = await testHub('hub-a', 'registrar', 7);
    const b = await testHub('hub-b', 'member', 0x4001);
    await enroll(a, 1, 'pad');
    await enroll(a, 2, 'lamp');
    expect(b.reg.list()).toEqual([]);
    await joined(a, b);
    await inStep(a, b);
    expect(b.reg.list().map((d) => [d.alias, d.addr, d.net, d.provisioned, d.tags.join()])).toEqual([['lamp', 2, NET, true, 'new'], ['pad', 1, NET, true, 'new']]);
    // The member was told of two boards as a provisioning tells of one (the router's DIRECTORY and the apps follow it).
    const told = b.r.events.query({ limit: 100 }).filter((e) => e.type === 'device.provisioned');
    expect(told.map((e) => [e.alias, e.fields?.addr, e.fields?.replicated, e.fields?.from]).sort()).toEqual([['lamp', 2, true, 'hub-a'], ['pad', 1, true, 'hub-a']]);
    // fr hub peers: each hub's view of the other.
    const viewA = peersView(a.r.hub);
    expect(viewA.registry).toMatchObject({ rows: 2, tombstones: 0, conflicts: [] });
    expect(viewA.peers.map((p) => [p.name, p.registry?.speaks, p.registry?.in_step])).toEqual([['hub-a', true, true], ['hub-b', true, true]]);
    expect(viewA.peers[1].registry).toMatchObject({ rows: 2, sent: 2, received: 0, conflicts: 0 });
    expect(peersView(b.r.hub).peers[0].registry).toMatchObject({ speaks: true, in_step: true, received: 2, taken: 2 });
    expect(viewA.counters).toMatchObject({ registry_rows_sent: 2, registry_conflicts: 0 });
    // A tag at the member (the board is on no hub, so the edit is made there): at the registrar within a moment.
    b.reg.update(id(1), { tags: ['kitchen'] });
    b.peers.registry.flush();
    await until(() => a.reg.get(id(1))!.tags.join() === 'kitchen', 2000, 'the tag at the registrar');
    // A writer that tells nobody (a job, an older code path) is found by the scan.
    a.r.db.prepare("UPDATE devices SET tags = '[\"found\"]' WHERE device_id = ?").run(id(2));
    await until(() => b.reg.get(id(2))!.tags.join() === 'found', 2000, 'the scan to find the change and tell the member');
    await inStep(a, b);
    expect(a.warnings()).toEqual([]);
    expect(b.warnings()).toEqual([]);
  });

  it('three hubs: an edit at a member is at the registrar and the third hub; a hub that was away gets what it missed, both ways', async () => {
    const a = await testHub('hub-a', 'registrar', 7);
    const b = await testHub('hub-b', 'member', 0x4001);
    const c = await testHub('hub-c', 'member', 0x8001);
    await enroll(a, 1, 'pad');
    await joined(a, b, c);
    await inStep(a, b, c);
    b.reg.update(id(1), { alias: 'pad-kitchen', tags: [] });
    b.peers.registry.flush();
    await until(() => a.reg.get(id(1))?.alias === 'pad-kitchen' && c.reg.get(id(1))?.alias === 'pad-kitchen', 2000, 'the rename at both other hubs');
    expect(c.r.events.query({ limit: 100 }).filter((e) => e.type === 'registry.drift').map((e) => e.fields)).toEqual([expect.objectContaining({ alias: 'pad-kitchen', alias_rev: 2, previous_alias: 'pad', replicated: true })]);
    // Hub C goes away. Meanwhile: a new board at the registrar, a tag at B, a delete at A; and C itself tags a board.
    await c.peers.stop();
    await until(() => !a.peers.status().peers.find((p) => p.id === c.id)?.reachable, 2000, 'hub C to be away');
    await enroll(a, 2, 'lamp');
    await enroll(a, 3, 'fan');
    await until(() => b.reg.get(id(2)) && b.reg.get(id(3)), 2000, 'the new boards at hub B');
    b.reg.update(id(2), { tags: ['desk'] });
    b.peers.registry.flush();
    forgetDevice(a.r.db, id(3));
    a.peers.registry.flush();
    await until(() => b.reg.get(id(3)) === null && a.reg.get(id(2))?.tags.join() === 'desk', 2000, 'A and B to agree while C is away');
    c.reg.update(id(1), { tags: ['c-was-here'] });
    await c.peers.start();
    await inStep(a, b, c);
    for (const h of [a, b, c]) {
      expect(h.reg.list().map((d) => [d.alias, d.tags.join()])).toEqual([['lamp', 'desk'], ['pad-kitchen', 'c-was-here']]);
    }
    expect(peersView(c.r.hub).registry).toMatchObject({ rows: 2, tombstones: 1 });
  });

  it('one alias given to two boards while two hubs were apart: the later write keeps it, and the holder tells the board that lost it', async () => {
    const a = await testHub('hub-a', 'registrar', 7);
    const b = await testHub('hub-b', 'member', 0x4001);
    const one = await enroll(a, 1, 'pad-one');
    await enroll(a, 2, 'pad-two');
    await joined(a, b);
    await inStep(a, b);
    // Board 1 is on hub A. It hears what hub A calls it.
    const node = a.r.node({ mac: id(1), addr: one.addr, net: NET, epoch: 4, alias: 'pad-one', aliasRev: 1 });
    const aliases: [string, number][] = [];
    node.handlers.set(`${PORT.NODE}/${SET_ALIAS}`, (args) => {
      const d = decodeNodeSetAliasArgs(args);
      if (d.ok) {
        aliases.push([d.value.alias, d.value.rev]);
      }
    });
    await node.connected(a.r.events);
    // The hubs lose each other. A names board 1 kitchen; later B names board 2 kitchen.
    await b.peers.stop();
    await until(() => !a.peers.status().peers[0].reachable, 2000, 'the link to be down');
    a.reg.update(id(1), { alias: 'kitchen' });
    a.r.router.pushAlias(id(1));
    await until(() => aliases.length === 1, 2000, 'the board to hear its new name');
    kvSet(b.r.db, 'registry.clock', String(Date.now() + 60_000));
    b.reg.update(id(2), { alias: 'kitchen' });
    await b.peers.start();
    await inStep(a, b);
    const lost = `kitchen-${id(1).slice(-3)}`;
    for (const h of [a, b]) {
      expect(h.reg.get(id(2))).toMatchObject({ alias: 'kitchen' });
      expect(h.reg.get(id(1))).toMatchObject({ alias: lost, alias_rev: 3 });
      expect(h.reg.get(id(1))!.tags).toContain('renamed');
      // Both hubs say so, and how to settle it.
      expect(h.warnings().join('\n')).toContain(`${lost} (${id(1)}) was renamed: another board was given its alias while two hubs could not see each other`);
    }
    // The board is told by its holder, through the alias push it always had, with the higher alias_rev.
    await until(() => aliases.length === 2, 2000, 'the board to be told the name it was left with');
    expect(aliases).toEqual([['kitchen', 2], [lost, 3]]);
    expect(a.r.events.query({ limit: 200 }).filter((e) => e.type === 'registry.drift' && e.device === id(1)).at(-1)?.fields).toMatchObject({ alias: lost, alias_rev: 3, replicated: true });
    expect(a.peers.status().counters.registry_renames + b.peers.status().counters.registry_renames).toBeGreaterThanOrEqual(1);
  });

  it('a member asks the registrar for a new board\'s address: the registrar up, two members at once, the registrar away', async () => {
    const a = await testHub('hub-a', 'registrar', 7);
    const b = await testHub('hub-b', 'member', 0x4001);
    const c = await testHub('hub-c', 'member', 0x8001);
    await enroll(a, 1, 'pad');
    await joined(a, b, c);
    await inStep(a, b, c);
    // Enrolled at a member: the address is the registrar's next one, and the row is at every hub.
    const atB = await enroll(b, 2, 'lamp');
    expect(atB).toMatchObject({ device_id: id(2), addr: 2, net: NET, alias: 'lamp', new: true, tags: ['new'] });
    await inStep(a, b, c);
    for (const h of [a, b, c]) {
      expect(h.reg.get(id(2))).toMatchObject({ addr: 2, net: NET, alias: 'lamp', provisioned: true, tags: ['new'] });
    }
    // Two members at once, each for another board: two addresses.
    const [x, y] = await Promise.all([enroll(b, 3, 'fan'), enroll(c, 4, 'door')]);
    expect(new Set([x.addr, y.addr])).toEqual(new Set([3, 4]));
    // The same board asked for twice, at two members: one address.
    const [p, q] = await Promise.all([enroll(b, 5, 'bell'), enroll(c, 5, 'bell')]);
    expect(p.addr).toBe(5);
    expect(q.addr).toBe(5);
    await inStep(a, b, c);
    expect(a.reg.list().map((d) => d.addr).sort()).toEqual([1, 2, 3, 4, 5]);
    // An alias another board of the network holds is refused by the registrar, which holds every row.
    await expect(enroll(c, 6, 'lamp')).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('alias lamp is taken') });
    expect(c.reg.get(id(6))).toBeNull();
    // The registrar away: refused as before 2.3, and the answer says what is not reachable.
    await a.peers.stop();
    await until(() => !b.peers.status().peers.find((v) => v.id === a.id)?.reachable, 2000, 'the registrar to be away');
    const refused = await enroll(b, 7, 'late').catch((e: unknown) => e as { code: string; message: string; retryable?: boolean });
    expect(refused).toMatchObject({ code: 'HUB_UNREACHABLE' });
    expect(refused.message).toContain("only that hub, the network's registrar, hands out addresses, and it is not reachable over the hubs' link now (hub hub-a");
    expect(b.reg.get(id(7))).toBeNull();
    // A board that has its address is enrolled again without the registrar.
    expect(await enroll(b, 2, 'lamp')).toMatchObject({ addr: 2, new: false });
  });
});

// ---- a peer that is not a hub of step 2.3 ----

interface RawPeer {
  id: string;
  links: PeerLinks;
  got: PeerMessage[];
  known: Map<string, LinkTarget>;
}

/** A hub's link alone, as a hub of step 2.2 runs it: `registry` in its hello only when told to say so. */
function rawPeer(peerId: string, name: string, speaks: boolean): RawPeer {
  const p: RawPeer = { id: peerId, links: null as unknown as PeerLinks, got: [], known: new Map() };
  const hello = (): HelloInfo => ({ hub_id: peerId, name, net: NET, registry_hash: REGISTRY_HASH, hub_epoch: 0x4001, members_version: 1, ...(p.links.port() ? { link_port: p.links.port()! } : {}), ...(speaks ? { registry: 1 } : {}) });
  p.links = new PeerLinks({ listen: { host: '127.0.0.1', port: 0 }, key: () => ({ key, net: NET }), hello, targets: () => [...p.known.values()], onUp: () => undefined, onDown: () => undefined, onMessage: (_peer, msg) => p.got.push(msg), timing: FAST });
  cleanups.push(() => p.links.stop());
  return p;
}

async function linkRaw(a: TestHub, raw: RawPeer, name: string): Promise<void> {
  await raw.links.listen();
  replaceMembers(a.r.db, [
    { id: a.id, name: a.name, host: '127.0.0.1', addr: '127.0.0.1', link_port: a.peers.status().link.port ?? 1, slot: 0, joined_at: 't' },
    { id: raw.id, name, host: '127.0.0.1', addr: '127.0.0.1', link_port: raw.links.port()!, slot: 1, joined_at: 't' },
  ], 1);
  kvSet(a.r.db, HUB_SLOT_KEY, '0');
  await a.peers.refresh();
  raw.known.set(a.id, { id: a.id, name: a.name, candidates: [{ host: '127.0.0.1', port: a.peers.status().link.port! }] });
  await raw.links.sync();
  await until(() => a.peers.status().peers[0]?.reachable === true, 4000, 'the link to the raw peer');
}

describe('a peer that does not replicate the registry', () => {
  it('a hub of step 2.2 (the same op registry, no `registry` in its hello) is sent no `registry` message and is named in hub_status', async () => {
    const a = await testHub('hub-a', 'registrar', 7);
    await enroll(a, 1, 'pad');
    const old = rawPeer('0000000000b2', 'hub-old', false);
    await linkRaw(a, old, 'hub-old');
    a.reg.update(id(1), { tags: ['x'] });
    a.peers.registry.flush();
    await sleep(700); // more than two digest periods
    expect(old.got.filter((m) => m.t === 'registry')).toEqual([]);
    expect(old.got.some((m) => m.t === 'presence')).toBe(true); // who is where still crosses
    expect(old.links.counters.unknown).toBe(0);
    const view = peersView(a.r.hub);
    expect(view.peers[1].registry).toMatchObject({ speaks: false, in_step: null, sent: 0, received: 0 });
    expect(a.peers.registry.replicates(old.id)).toBe(false);
    // Such a hub relays no events either (step 2.4): it is sent none, and that is said too.
    expect(old.got.filter((m) => m.t === 'event')).toEqual([]);
    expect(a.warnings()).toEqual([expect.stringContaining('hub hub-old does not replicate the registry'), expect.stringContaining('hub hub-old does not relay events or live streams')]);
    expect(a.peers.status().counters).toMatchObject({ registry_rows_sent: 0, registry_digests_sent: 0, registry_unanswered: 0 });
  });

  it('a hub of step 2.2 drops a `registry` message it is sent as a type it does not know, and nothing else happens', async () => {
    // The link of step 2.2 is this same link (wire.ts) without the peers part's registry: what it does with the message
    // is the decoder's and the link's, and those hand an unknown type nowhere. Shown with the frame decoder a 2.2 hub
    // has: a type it has no schema for.
    const { FrameDecoder, encodeControl } = await import('../src/peers/wire.ts');
    const frame = encodeControl({ t: 'registry-of-a-later-step', v: 9, k: 'digest' } as unknown as PeerMessage);
    expect(new FrameDecoder().push(frame)).toEqual([{ kind: 'unknown', t: 'registry-of-a-later-step' }]);
    // And a `registry` whose fields this version cannot read is no error either.
    expect(new FrameDecoder().push(encodeControl({ t: 'registry', v: 1, k: 'something-newer' } as unknown as PeerMessage))).toEqual([{ kind: 'unknown', t: 'registry' }]);
  });

  it('a peer that says it replicates and answers nothing: no storm, a counter, a line in hub_peers, a warning after three digests', async () => {
    const a = await testHub('hub-a', 'registrar', 7);
    await enroll(a, 1, 'pad');
    const mute = rawPeer('0000000000b3', 'hub-mute', true);
    await linkRaw(a, mute, 'hub-mute');
    await until(() => (a.peers.status().counters.registry_unanswered ?? 0) >= 2, 4000, 'three digests without an answer');
    const sentBy = (ms: number) => sleep(ms).then(() => mute.got.filter((m) => m.t === 'registry').length);
    const n0 = await sentBy(0);
    expect(n0).toBeGreaterThanOrEqual(3);
    expect(mute.got.filter((m) => m.t === 'registry').every((m) => (m as { k?: string }).k === 'digest')).toBe(true);
    // From then on it is asked every fifth period: at 250 ms a period, at most two more in 1.5 s.
    expect((await sentBy(1500)) - n0).toBeLessThanOrEqual(2);
    expect(peersView(a.r.hub).peers[1].registry).toMatchObject({ speaks: true, in_step: null, rows: null, received: 0 });
    expect(peersView(a.r.hub).peers[1].registry!.unanswered).toBeGreaterThanOrEqual(3);
    expect(a.warnings().join('\n')).toMatch(/hub hub-mute has not answered this hub's last \d+ registry digests/);
    // A change is still sent to it once (it said it replicates); nothing is repeated.
    const rows0 = mute.got.filter((m) => (m as { k?: string }).k === 'rows').length;
    a.reg.update(id(1), { tags: ['y'] });
    a.peers.registry.flush();
    await sleep(300);
    expect(mute.got.filter((m) => (m as { k?: string }).k === 'rows').length).toBe(rows0 + 1);
  });
});

describe('what the `registry` messages of this file carried', () => {
  it('rows, digests and states only: no password, no key, no Wi-Fi name, nothing of a provision record', () => {
    const lines = tapped();
    expect(lines.length).toBeGreaterThan(20);
    expect(new Set(lines.map((l) => l.msg.t))).toEqual(new Set(['registry']));
    expect(new Set(lines.map((l) => l.msg.k))).toEqual(new Set(['digest', 'rows', 'state']));
    expect(lines.some((l) => (l.msg.rows ?? []).length > 0)).toBe(true);
    const text = readFileSync(tap, 'utf8');
    for (const secret of [PASSWORD, key.toString('hex'), key.toString('base64'), SSID, 'prov_ts', 'part_profile', 'hub_host', 'wifi', 'password']) {
      expect(text, secret).not.toContain(secret);
    }
  });
});
