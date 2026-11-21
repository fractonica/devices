// One registry across the hubs of a network (design multi-hub-m2 §5, step 2.3; §16), end to end on loopback: real hub
// processes (real-hub.ts: ephemeral ports, their own FR_HOME, the link on 127.0.0.1) and the C++ fr_net_node.
//   - a board made at the registrar is at every hub; device_share has nothing left to do;
//   - an edit at a member is at the registrar and the third hub; a rename on each side;
//   - a member enrolls a new board: the registrar gives the address over the link; two members at once; the registrar away;
//   - a board enrolled at one hub fails over to a hub that never had its row shared by hand, is reached there through
//     a third hub, is renamed there, and the hub that was away catches up when it returns;
//   - a hub restarted keeps what it had and gets what it missed;
//   - a row deleted while a hub was away stays deleted when that hub returns with its old copy;
//   - one alias given to two boards while two hubs could not see each other;
//   - two hub.db files from before the registry was replicated (14 rows at the registrar, 4 of them at the member, one
//     address that differs): what the first merge does, and what it tells a board that is connected meanwhile;
//   - what every `registry` message carried, and what the hubs printed: never the key, a password or the Wi-Fi's name.
// registry-sync.test.ts has the merge alone, peers-registry.test.ts the message over the link without hub processes.
// `node tools/host-test.mjs` builds fr_net_node; without it this file skips.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AT_HEADER, REGISTRY_HASH, type Result } from '@fractonica/protocol';

import { openDb } from '../src/db.ts';
import { forgetDevice, markIdentWritten, prepareIdentity, setDeviceHubs, SqliteRegistry, storeSharedIdentity } from '../src/registry/store.ts';
import { BIN, CppNode } from './cpp-node.ts';
import { type RealHub, startRealHub } from './real-hub.ts';

const HAS_BIN = existsSync(BIN) && readFileSync(BIN).includes('--hub-map');
const SSID = 'attic-wifi-name';
const PASSWORD = 'correct-horse-battery';
const HUB_A = 'hub-a.test';
const HUB_C = 'hub-c.test';
const TIMING = { giveUpMs: 1500, welcomeMs: 1200, probeMs: 1500, confirmMs: 500, trialMs: 4000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mac = (k: number) => `aabbcc0f1${k.toString(16).padStart(3, '0')}`;

interface Row {
  device_id: string;
  alias: string;
  alias_rev: number;
  addr: number | null;
  net: number | null;
  tags: string[];
  provisioned: boolean;
  presence: string;
  at: string | null;
  hubs?: { rev: number; hubs: { host: string }[] } | null;
  router?: { links: string[] } | null;
}
interface Enrolled {
  device_id: string;
  addr: number;
  net: number;
  alias: string;
  alias_rev: number;
}
interface PeersView {
  peers: { name: string; this: boolean; reachable: boolean; registry_hash: string | null; registry?: { speaks: boolean; in_step: boolean | null; rows: number | null; sent: number; received: number; conflicts: number } }[];
  registry?: { rows: number; tombstones: number; hash: string; conflicts: { device: string; hub: string; kind: string; message: string }[] };
  counters: Record<string, number>;
}

/** One op at `h`; `at` as the X-Fr-At header (a hub's own name: its own registry and nothing passed on). */
async function call<T = unknown>(h: RealHub, op: string, input: Record<string, unknown> = {}, at?: string): Promise<Result<T>> {
  const r = await fetch(`${h.url}/api/v1/op/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(at ? { [AT_HEADER]: at } : {}) },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  const body = r ? ((await r.json().catch(() => null)) as Result<T> | null) : null;
  return body ?? { ok: false, cursor: '', error: { code: 'HUB_UNREACHABLE', message: 'no answer', retryable: true } };
}

async function ok<T = unknown>(h: RealHub, op: string, input: Record<string, unknown> = {}, at?: string): Promise<T> {
  const r = await call<T>(h, op, input, at);
  if (!r.ok) {
    throw new Error(`${op}: ${JSON.stringify(r.error)}`);
  }
  return r.data as T;
}

async function eventually<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = await fn();
    if (v) {
      return v;
    }
    if (performance.now() - t0 > ms) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(50);
  }
}

const NAMES = new Map<RealHub, string>();
/** Hub `h`'s own row of a board (asked by the hub's own name), or null. */
const own = async (h: RealHub, device: string): Promise<Row | null> => (await call<Row>(h, 'device_get', { device }, NAMES.get(h))).data ?? null;
/** Waits until `h`'s own row of the board is there and `when` holds. */
const rowAt = (h: RealHub, device: string, when: (r: Row) => boolean = () => true, ms = 20_000) =>
  eventually(`${device} at ${NAMES.get(h)}`, async () => {
    const r = await own(h, device);
    return r && when(r) ? r : null;
  }, ms);
const gone = (h: RealHub, device: string) => eventually(`${device} to be gone at ${NAMES.get(h)}`, async () => (await call(h, 'device_get', { device }, NAMES.get(h))).error?.code === 'NOT_FOUND');
const ownList = async (h: RealHub): Promise<Row[]> => (await ok<{ devices: Row[] }>(h, 'device_list', {}, NAMES.get(h))).devices;
const peersOf = (h: RealHub) => ok<PeersView>(h, 'hub_peers');

/** Waits until `h` sees every hub named reachable and holds the same registry as each. */
const inStep = (h: RealHub, names: string[], ms = 30_000) =>
  eventually(`${NAMES.get(h)} to be in step with ${names.join(', ')}`, async () => {
    const r = await call<PeersView>(h, 'hub_peers');
    return r.ok && names.every((n) => r.data!.peers.some((p) => p.name === n && p.reachable && p.registry?.in_step === true)) ? r.data! : null;
  }, ms);

const printed = (h: RealHub) => JSON.stringify(h.lines) + h.stderr();
const secretsOf = (h: RealHub) => JSON.parse(readFileSync(join(h.home, 'secrets.json'), 'utf8')) as { network_key?: { key: string } };

describe.skipIf(!HAS_BIN)("one registry across three hubs (design multi-hub-m2 step 2.3)", () => {
  let a: RealHub;
  let b: RealHub;
  let c: RealHub;
  let node: CppNode | undefined;
  let scratch = '';
  let pad: Enrolled;
  const PAD = mac(1);
  const hubs = () => [a, b, c];
  const tap = (name: string) => join(scratch, `tap-${name}.jsonl`);

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'fr-registry-'));
    [a, b, c] = await Promise.all(['a', 'b', 'c'].map((n) => startRealHub({ env: { FR_TEST_PEER_REGISTRY_TAP: tap(n) } })));
    for (const [h, name] of [[a, 'hub-a'], [b, 'hub-b'], [c, 'hub-c']] as const) {
      await h.api.ok('hub_name_set', { name });
      NAMES.set(h, name);
    }
    await a.api.ok('network_set', { ssid: SSID, password: PASSWORD });
    // Made before any hub joined: the members get it when their link comes up.
    pad = await a.api.ok<Enrolled>('device_enroll', { device_id: PAD, chip: 'esp32c6', profile: 'c6-pad', alias: 'pad' });
    await a.api.ok('device_update', { device: 'pad', tag: '-new' });
    for (const h of [b, c]) {
      await h.api.ok('network_join', { hub: a.url });
      await h.restart(); // into its epoch slot, so a board that moves between hubs never meets one hub epoch twice
    }
    await inStep(a, ['hub-b', 'hub-c']);
    await inStep(b, ['hub-a', 'hub-c']);
    await inStep(c, ['hub-a', 'hub-b']);
  }, 120_000);

  afterAll(async () => {
    node?.stop();
    await Promise.all(hubs().map((h) => h?.stop()));
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);

  it('a board made at the registrar is at every hub, and device_share has nothing left to do', async () => {
    for (const h of [b, c]) {
      expect(await own(h, 'pad')).toMatchObject({ device_id: PAD, addr: pad.addr, net: pad.net, alias: 'pad', alias_rev: pad.alias_rev, tags: [], provisioned: true, presence: 'unknown', at: null });
    }
    const view = await peersOf(a);
    expect(view.registry).toMatchObject({ rows: 1, tombstones: 0, conflicts: [] });
    expect(view.peers.map((p) => [p.name, p.registry?.speaks, p.registry?.in_step, p.registry?.rows])).toEqual([['hub-a', true, true, 1], ['hub-b', true, true, 1], ['hub-c', true, true, 1]]);
    expect(view.counters.registry_rows_sent).toBeGreaterThanOrEqual(2);
    // What gave a row by hand under MULTI-HUB-1 says the row is there already, and sends nothing.
    const shared = await ok<{ replicated?: boolean; addr: number; hub_host: string; warnings?: string[] }>(a, 'device_share', { device: 'pad', with_hub: b.url });
    expect(shared).toMatchObject({ replicated: true, addr: pad.addr });
    expect(shared.warnings).toEqual([`nothing to share: hub hub-b holds pad's row already, as every hub of this network holds every row of it (the registry is replicated over the hubs' link)`]);
    // Nothing warns on a network that is in step.
    for (const h of hubs()) {
      expect(((await ok<{ warnings?: string[] }>(h, 'hub_status')).warnings ?? []).filter((w) => /registr|replicat|renamed/.test(w))).toEqual([]);
    }
  }, 60_000);

  it('an edit at a member is at the registrar and the third hub; a rename on each side', async () => {
    const lamp = await ok<Enrolled>(a, 'device_enroll', { device_id: mac(2), chip: 'esp32c6', profile: 'c6-pad', alias: 'lamp' });
    await rowAt(b, 'lamp');
    // The board is on no hub: the edit is made where it was asked, and replicates.
    const tagged = await call<Row>(b, 'device_update', { device: 'lamp', tag: 'desk,-new' });
    expect(tagged.at).toBeUndefined();
    expect(tagged.data).toMatchObject({ tags: ['desk'] });
    for (const h of [a, c]) {
      expect((await rowAt(h, 'lamp', (r) => r.tags.join() === 'desk')).addr).toBe(lamp.addr);
    }
    // A rename at the third hub, then one at the registrar: each is at the other two.
    await ok(c, 'device_update', { device: 'lamp', alias: 'lamp-c' });
    for (const h of [a, b]) {
      expect(await rowAt(h, 'lamp-c')).toMatchObject({ device_id: mac(2), alias_rev: 2, tags: ['desk'] });
    }
    expect((await call(a, 'device_get', { device: 'lamp' }, 'hub-a')).error).toMatchObject({ code: 'NOT_FOUND' });
    await ok(a, 'device_update', { device: 'lamp-c', alias: 'lamp' });
    for (const h of [b, c]) {
      expect(await rowAt(h, 'lamp', (r) => r.alias_rev === 3)).toMatchObject({ device_id: mac(2), tags: ['desk'] });
    }
    await inStep(a, ['hub-b', 'hub-c']);
  }, 60_000);

  it('a member enrolls a new board: the registrar gives the address over the link, and two members at once get two', async () => {
    const before = (await ownList(a)).map((d) => d.addr!).sort((x, y) => x - y);
    const next = before.at(-1)! + 1;
    const fan = await ok<Enrolled & { new: boolean; tags: string[] }>(b, 'device_enroll', { device_id: mac(3), chip: 'esp32c6', profile: 'c6-pad', alias: 'fan' });
    expect(fan).toMatchObject({ addr: next, net: pad.net, alias: 'fan', new: true, tags: ['new'] });
    for (const h of [a, c]) {
      expect(await rowAt(h, 'fan', (r) => r.provisioned)).toMatchObject({ device_id: mac(3), addr: next, tags: ['new'] });
    }
    // Two members at once, each with another board.
    const [x, y] = await Promise.all([
      ok<Enrolled>(b, 'device_enroll', { device_id: mac(4), chip: 'esp32c6', profile: 'c6-pad', alias: 'door' }),
      ok<Enrolled>(c, 'device_enroll', { device_id: mac(5), chip: 'esp32c6', profile: 'c6-pad', alias: 'bell' }),
    ]);
    expect(new Set([x.addr, y.addr])).toEqual(new Set([next + 1, next + 2]));
    await rowAt(a, 'door', (r) => r.provisioned);
    await rowAt(a, 'bell', (r) => r.provisioned);
    await rowAt(c, 'door', (r) => r.provisioned);
    // An alias another board of the network holds: the registrar refuses, and the member passes that on.
    const taken = await call(c, 'device_enroll', { device_id: mac(6), chip: 'esp32c6', profile: 'c6-pad', alias: 'fan' });
    expect(taken.error).toMatchObject({ code: 'INVALID_ARGS' });
    expect(taken.error!.message).toContain('the registrar (hub hub-a) refused an address for');
    expect(taken.error!.message).toContain('alias fan is taken');
    // The registrar logged each address it gave, by the board and the hub that asked: never more.
    const given = a.lines.filter((l) => l.event === 'addr_alloc').map((l) => [l.device, l.addr, l.for]);
    expect(given).toContainEqual([mac(3), next, 'hub-b']);
    expect(given.filter(([d]) => d === mac(4) || d === mac(5)).map(([, , who]) => who).sort()).toEqual(['hub-b', 'hub-c']);
    await inStep(a, ['hub-b', 'hub-c']);
  }, 60_000);

  it('a board enrolled at hub A fails over to hub C, which never had its row shared; hub B reaches it there; hub A catches up', async () => {
    node = new CppNode([
      '--hub-tcp', String(a.node.tcp),
      '--hub-udp', String(a.node.udp),
      '--hub-http', String(a.node.http),
      '--hub-name', HUB_A,
      '--hub-map', `${HUB_C}=${c.node.tcp}:${c.node.udp}:${c.node.http}`,
      '--hub-timing', `${TIMING.giveUpMs}:${TIMING.welcomeMs}:${TIMING.probeMs}:${TIMING.confirmMs}:${TIMING.trialMs}`,
      '--mac', PAD,
      '--addr', String(pad.addr),
      '--net', String(pad.net),
      '--alias', 'pad',
      '--alias-rev', String(pad.alias_rev),
      '--epoch', '3',
      '--hb-ms', '500',
    ]);
    await rowAt(a, 'pad', (r) => r.presence === 'online' && (r.router?.links ?? []).includes('tcp'));
    // Its hub list, set at its holder, is at every hub.
    expect(await ok(a, 'device_hubs_set', { device: 'pad', hub: [HUB_A, `${HUB_C}/127.0.0.1`] })).toMatchObject({ rev: 1, on: 0, trial: false });
    for (const h of [b, c]) {
      expect((await rowAt(h, 'pad', (r) => r.hubs?.rev === 1)).hubs).toMatchObject({ rev: 1, hubs: [{ host: HUB_A }, { host: HUB_C }] });
    }
    const epoch = (await node.state()).epoch;
    // Hub A, the registrar and the board's first hub, stops.
    await a.halt();
    const atC = await rowAt(c, 'pad', (r) => r.presence === 'online' && (r.router?.links ?? []).includes('tcp'));
    // Hub C knew the board by replication alone: the same row, not one made up from its HELLO.
    expect(atC).toMatchObject({ device_id: PAD, addr: pad.addr, net: pad.net, alias: 'pad', provisioned: true, at: 'hub-c' });
    expect((await node.state()).epoch).toBe(epoch); // it moved, it did not restart
    // Hub B, which never had the row shared either, names the board and reaches it at hub C.
    const got = await call<Row>(b, 'device_get', { device: 'pad' });
    expect(got.at).toBe('hub-c');
    expect(got.data).toMatchObject({ device_id: PAD, presence: 'online', at: 'hub-c' });
    const sent = await ok<{ results: { alias: string; status: string; at?: string }[] }>(b, 'command_send', { selector: 'pad', command: 'node.identify', args: { ms: 100 } });
    expect(sent.results).toEqual([expect.objectContaining({ alias: 'pad', status: 'ok' })]);
    // A rename asked at hub B is made by the holder, which tells the board; every hub that is up has it.
    const renamed = await call<Row & { alias_pushed?: boolean }>(b, 'device_update', { device: 'pad', alias: 'pad-moved', tag: 'roams' });
    expect(renamed.at).toBe('hub-c');
    expect(renamed.data).toMatchObject({ alias: 'pad-moved', alias_rev: pad.alias_rev + 1, alias_pushed: true });
    await eventually('the board to hear its new name', async () => node!.of('set_alias').some((l) => l.alias === 'pad-moved' && l.rev === pad.alias_rev + 1));
    expect(await rowAt(b, 'pad-moved', (r) => r.tags.includes('roams'))).toMatchObject({ device_id: PAD, at: 'hub-c' });
    // With the registrar away a member cannot enroll a new board, and says what is not reachable.
    const refused = await call(b, 'device_enroll', { device_id: mac(7), chip: 'esp32c6', profile: 'c6-pad', alias: 'late' });
    expect(refused.error).toMatchObject({ code: 'HUB_UNREACHABLE', retryable: true });
    expect(refused.error!.message).toContain("only that hub, the network's registrar, hands out addresses, and it is not reachable over the hubs' link now (hub hub-a");
    expect((await call(b, 'device_get', { device: `id:${mac(7)}` }, 'hub-b')).error).toMatchObject({ code: 'NOT_FOUND' });
    // Hub A comes back: it gets what it missed (the rename, the tag), and the board returns to it by itself.
    await a.start();
    expect(await rowAt(a, 'pad-moved', (r) => r.tags.includes('roams'))).toMatchObject({ device_id: PAD, alias_rev: pad.alias_rev + 1 });
    await rowAt(a, 'pad-moved', (r) => r.presence === 'online' && (r.router?.links ?? []).includes('tcp'), 40_000);
    // The board came back with the name hub C gave it: hub A pushed nothing over it.
    expect(node.of('set_alias').map((l) => l.alias)).toEqual(['pad-moved']);
    expect(await ok<Enrolled>(b, 'device_enroll', { device_id: mac(7), chip: 'esp32c6', profile: 'c6-pad', alias: 'late' })).toMatchObject({ alias: 'late' });
    await inStep(a, ['hub-b', 'hub-c']);
  }, 150_000);

  it('a hub restarted keeps what it had and gets what it missed', async () => {
    const had = (await ownList(b)).map((d) => [d.device_id, d.addr, d.alias, d.alias_rev]).sort();
    await b.halt();
    await ok(a, 'device_update', { device: 'lamp', tag: 'while-b-was-down' });
    await ok(c, 'device_update', { device: 'fan', alias: 'fan-attic' });
    await b.start();
    await inStep(b, ['hub-a', 'hub-c']);
    const has = await ownList(b);
    expect(has.map((d) => [d.device_id, d.addr, d.alias === 'fan-attic' ? 'fan' : d.alias, d.alias === 'fan-attic' ? d.alias_rev - 1 : d.alias_rev]).sort()).toEqual(had);
    expect(has.find((d) => d.alias === 'lamp')!.tags).toContain('while-b-was-down');
    expect(has.find((d) => d.device_id === mac(3))).toMatchObject({ alias: 'fan-attic' });
    // Its counters are this run's: what it took after the restart.
    const view = await peersOf(b);
    expect(view.peers.filter((p) => !p.this).every((p) => p.registry?.in_step === true)).toBe(true);
    expect(view.counters.registry_rows_received).toBeGreaterThanOrEqual(2);
  }, 90_000);

  it('a row deleted while a hub was away stays deleted when that hub returns with its old copy', async () => {
    await c.halt();
    // device_forget is not an op yet (09 §9.4): the row is deleted in hub A's database as that op will delete it.
    const db = openDb(join(a.home, 'hub.db'));
    try {
      expect(forgetDevice(db, mac(5))).toBe(true);
    } finally {
      db.close();
    }
    await gone(a, `id:${mac(5)}`);
    await gone(b, `id:${mac(5)}`); // hub A's scan found the row gone and told hub B
    expect((await peersOf(a)).registry).toMatchObject({ tombstones: 1 });
    await c.start(); // with the row as it was
    await inStep(c, ['hub-a', 'hub-b']);
    expect((await call(c, 'device_get', { device: `id:${mac(5)}` }, 'hub-c')).error).toMatchObject({ code: 'NOT_FOUND' });
    expect((await call(a, 'device_get', { device: `id:${mac(5)}` }, 'hub-a')).error).toMatchObject({ code: 'NOT_FOUND' });
    expect((await peersOf(c)).registry).toMatchObject({ tombstones: 1 });
    expect((await ownList(c)).length).toBe((await ownList(a)).length);
  }, 90_000);

  it('one alias given to two boards while two hubs could not see each other: the later write keeps it, and both hubs say so', async () => {
    node?.stop(); // its hubs go up and down below; the alias push to a board is the test before, and peers-registry.test.ts
    node = undefined;
    // Hub B is away while hub A names the door "hall".
    await b.halt();
    await ok(a, 'device_update', { device: 'door', alias: 'hall' });
    await rowAt(c, 'hall');
    // Then hubs A and C are away while hub B, which has not heard of it, names the lamp "hall".
    await a.halt();
    await c.halt();
    await b.start();
    await ok(b, 'device_update', { device: 'lamp', alias: 'hall' });
    await a.start();
    await c.start();
    const lost = `hall-${mac(4).slice(-3)}`;
    for (const h of hubs()) {
      expect(await rowAt(h, 'hall', (r) => r.device_id === mac(2))).toMatchObject({ device_id: mac(2), tags: expect.not.arrayContaining(['renamed']) });
      const row = await rowAt(h, lost);
      expect(row).toMatchObject({ device_id: mac(4) });
      expect(row.tags).toContain('renamed');
    }
    await inStep(a, ['hub-b', 'hub-c']);
    for (const h of [a, b, c]) {
      const warnings = (await ok<{ warnings?: string[] }>(h, 'hub_status')).warnings ?? [];
      expect(warnings.filter((w) => w.includes('was renamed'))).toEqual([expect.stringContaining(`${lost} (${mac(4)}) was renamed: another board was given its alias while two hubs could not see each other, and the later write kept it`)]);
    }
    // A person settles it with an ordinary edit, and the warning goes everywhere.
    await ok(c, 'device_update', { device: lost, alias: 'door', tag: '-renamed' });
    await rowAt(a, 'door', (r) => !r.tags.includes('renamed'));
    await rowAt(b, 'door', (r) => !r.tags.includes('renamed'));
    for (const h of [a, b]) {
      expect(((await ok<{ warnings?: string[] }>(h, 'hub_status')).warnings ?? []).filter((w) => w.includes('was renamed'))).toEqual([]);
    }
  }, 150_000);

  it('the `registry` messages and everything the hubs printed: never the key, the password or the Wi-Fi\'s name', async () => {
    const key = secretsOf(a).network_key!.key;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    let messages = 0;
    const kinds = new Set<string>();
    for (const n of ['a', 'b', 'c']) {
      const text = readFileSync(tap(n), 'utf8');
      for (const secret of [key, Buffer.from(key, 'hex').toString('base64'), PASSWORD, SSID, 'prov_ts', 'part_profile', 'ssid', 'password']) {
        expect(text, `${secret} in hub ${n}'s registry messages`).not.toContain(secret);
      }
      for (const line of text.split('\n').filter(Boolean)) {
        const { msg } = JSON.parse(line) as { msg: { t: string; k: string } };
        expect(msg.t).toBe('registry');
        kinds.add(msg.k);
        messages++;
      }
    }
    expect(messages).toBeGreaterThan(30);
    expect(kinds).toEqual(new Set(['digest', 'rows', 'state']));
    for (const h of hubs()) {
      const out = printed(h);
      for (const secret of [key, Buffer.from(key, 'hex').toString('base64'), PASSWORD]) {
        expect(out).not.toContain(secret);
      }
      // No row's content is logged either: a rename, a conflict and an address given are logged by device id and alias.
      expect(h.lines.filter((l) => String(l.event).startsWith('registry_')).every((l) => !('rows' in l) && !('core' in l))).toBe(true);
    }
  }, 30_000);
});

// ---- two hub.db files from before the registry was replicated ----

describe.skipIf(!HAS_BIN)('the first merge of two databases from before step 2.3', () => {
  let d: RealHub;
  let e: RealHub;
  let node: CppNode | undefined;
  let net = 0;
  const id = (k: number) => mac(0x100 + k);

  beforeAll(async () => {
    [d, e] = await Promise.all([startRealHub(), startRealHub()]);
    await d.api.ok('hub_name_set', { name: 'hub-d' });
    await e.api.ok('hub_name_set', { name: 'hub-e' });
    NAMES.set(d, 'hub-d');
    NAMES.set(e, 'hub-e');
    await d.api.ok('network_set', { ssid: SSID });
    net = (await d.api.ok<{ net_id: number }>('network_get', {})).net_id;
    await e.api.ok('network_join', { hub: d.url });
    await e.restart();
    await inStep(d, ['hub-e']);
    await d.halt();
    await e.halt();
    // The two databases as steps 2.1 and 2.2 left them on two linked hubs: 14 boards at the registrar, 4 of them also
    // at the member with the same ids and addresses (shared by hand, kept in step by 2.2), and nothing that step 2.3
    // adds (no revs, no clock). Board 4's address differs between the two, which must never be settled silently.
    const dbD = openDb(join(d.home, 'hub.db'));
    const dbE = openDb(join(e.home, 'hub.db'));
    try {
      const rec = (dev: { addr: number | null; alias: string; alias_rev: number }) => ({ at: '2026-11-01T10:00:00.000Z', via: 'provision' as const, build_id: null, fw_id: null, profile: 'c6-pad', board: 'esp32c6-supermini', part_profile: 'fr-4mb-v1', ident: { offset: 0x9000, size: 0x1000 }, addr: dev.addr!, alias: dev.alias, alias_rev: dev.alias_rev, epoch_floor: 1, net, hub_host: 'hub-d.local', ssid: SSID, prov_ts: 1 });
      const list = { rev: 2, hubs: [{ host: 'hub-e.local', ip: null }, { host: 'hub-d.local', ip: null }], set_at: '2026-11-10T10:00:00.000Z' };
      for (let k = 1; k <= 14; k++) {
        const dev = prepareIdentity(dbD, { deviceId: id(k), alias: `board-${k}`, profile: 'c6-pad', board: 'esp32c6-supermini', chip: 'esp32c6', net }).device;
        markIdentWritten(dbD, id(k), rec(dev));
        if (k <= 4) {
          new SqliteRegistry(dbD).update(id(k), { tags: ['home'] });
          setDeviceHubs(dbD, id(k), list);
          const there = storeSharedIdentity(dbE, { deviceId: id(k), addr: k === 4 ? 40 : dev.addr!, net, alias: `board-${k}`, alias_rev: 1, epoch_floor: 1, profile: 'c6-pad', board: 'esp32c6-supermini', chip: 'esp32c6', network: 'default' }).device;
          markIdentWritten(dbE, id(k), { ...rec(there), enrolled: true }, { keepHubs: true });
          new SqliteRegistry(dbE).update(id(k), { tags: ['home'] });
          setDeviceHubs(dbE, id(k), list);
        }
      }
      for (const db of [dbD, dbE]) {
        db.prepare('DELETE FROM registry_sync').run();
        db.prepare("DELETE FROM kv WHERE k IN ('registry.sync_net', 'registry.clock')").run();
      }
    } finally {
      dbD.close();
      dbE.close();
    }
  }, 120_000);

  afterAll(async () => {
    node?.stop();
    await Promise.all([d?.stop(), e?.stop()]);
  }, 60_000);

  const identity = (rows: Row[]) => rows.map((r) => [r.device_id, r.addr, r.net, r.alias, r.alias_rev, r.hubs?.rev ?? null, r.tags.join()]).sort();

  it('both hold 14 rows afterwards; no address, alias or hub list changed; a board connected meanwhile is told no name and no list', async () => {
    // The member starts first, alone, with a board of the four connected to it.
    await e.start();
    const before = identity(await ownList(e));
    expect(before).toHaveLength(4);
    node = new CppNode(['--hub-tcp', String(e.node.tcp), '--hub-udp', String(e.node.udp), '--hub-http', String(e.node.http), '--mac', id(1), '--addr', '1', '--net', String(net), '--alias', 'board-1', '--alias-rev', '1', '--epoch', '3', '--hb-ms', '500']);
    await rowAt(e, 'board-1', (r) => r.presence === 'online');
    expect((await node.state()).directory).toBe(4);
    const dispatched = node.of('dispatch').length;
    // The registrar starts: the link comes up and the two registries meet for the first time.
    await d.start();
    await eventually('the member to hold 14 rows', async () => (await ownList(e)).length === 14, 30_000);
    const atD = await ownList(d);
    const atE = await ownList(e);
    expect(atD).toHaveLength(14);
    // The four rows the member had are as they were, the one whose address differs included.
    expect(identity(atE).filter(([dev]) => before.some(([x]) => x === dev))).toEqual(before);
    expect(atE.find((r) => r.device_id === id(4))).toMatchObject({ addr: 40 });
    expect(atD.find((r) => r.device_id === id(4))).toMatchObject({ addr: 4 });
    // Everything else is one registry: the registrar's addresses, aliases, tags and hub lists.
    expect(identity(atE).filter(([dev]) => dev !== id(4))).toEqual(identity(atD).filter(([dev]) => dev !== id(4)));
    // The board was told no alias and no hub list, and no command at all; its DIRECTORY now lists the network's boards.
    expect(node.of('set_alias')).toEqual([]);
    expect(node.of('hubs')).toEqual([]);
    expect(node.of('dispatch').length).toBe(dispatched);
    await eventually('the DIRECTORY of the network at the board', async () => (await node!.state()).directory === 14);
    expect(await own(e, 'board-1')).toMatchObject({ presence: 'online', at: 'hub-e' });
    // The address that differs is said, on both hubs, and nothing was overwritten.
    const viewE = await eventually('the member to report the address', async () => {
      const v = await peersOf(e);
      return v.registry?.conflicts.length ? v : null;
    });
    expect(viewE.registry!.conflicts).toEqual([{ device: id(4), hub: 'hub-d', kind: 'addr', message: `board-4 (${id(4)}) is addr 40 here and addr 4 at hub hub-d: neither copy was changed` }]);
    expect(viewE.peers.find((p) => p.name === 'hub-d')!.registry).toMatchObject({ speaks: true, in_step: false });
    const warnE = (await ok<{ warnings?: string[] }>(e, 'hub_status')).warnings ?? [];
    expect(warnE.join('\n')).toContain(`registry: board-4 (${id(4)}) is addr 40 here and addr 4 at hub hub-d: neither copy was changed. An address is the registrar's to give`);
    const viewD = await peersOf(d);
    expect(viewD.peers.find((p) => p.name === 'hub-e')!.registry).toMatchObject({ speaks: true, in_step: false });
    expect(viewD.registry!.conflicts).toEqual([{ device: id(4), hub: 'hub-e', kind: 'addr', message: `board-4 (${id(4)}) is addr 4 here and addr 40 at hub hub-e: neither copy was changed` }]);
    expect(((await ok<{ warnings?: string[] }>(d, 'hub_status')).warnings ?? []).join('\n')).toContain(`registry: board-4 (${id(4)}) is addr 4 here and addr 40 at hub hub-e`);
    // The two hubs do not send that row back and forth: a few messages, then quiet.
    const sent = (await peersOf(e)).counters.registry_rows_sent;
    await sleep(2500);
    expect((await peersOf(e)).counters.registry_rows_sent).toBe(sent);
    expect((await peersOf(e)).counters.registry_storms).toBe(0);
  }, 120_000);

  it('a person settles the address on the hub that is wrong, and the two hubs are in step', async () => {
    // The registrar's is the network's: the member takes it as an explicit identity (nothing is allocated).
    expect(await ok<Enrolled>(e, 'device_enroll', { device_id: id(4), addr: 4, net, alias: 'board-4' })).toMatchObject({ addr: 4, net });
    await inStep(e, ['hub-d']);
    await inStep(d, ['hub-e']);
    expect(await own(d, 'board-4')).toMatchObject({ addr: 4, tags: ['home'] });
    expect(await own(e, 'board-4')).toMatchObject({ addr: 4, tags: ['home'] });
    for (const h of [d, e]) {
      expect(((await ok<{ warnings?: string[] }>(h, 'hub_status')).warnings ?? []).filter((w) => w.startsWith('registry:'))).toEqual([]);
      expect((await peersOf(h)).registry!.conflicts).toEqual([]);
    }
    expect((await peersOf(e)).peers.every((p) => p.registry_hash === REGISTRY_HASH)).toBe(true);
  }, 60_000);
});

// ---- a hub that does not replicate (one of step 2.2, while the hubs are updated one by one) ----

describe('a member that does not replicate the registry (as a hub of step 2.2)', () => {
  let g: RealHub;
  let f: RealHub;

  beforeAll(async () => {
    // FR_TEST_PEER_REGISTRY=off (a test hub only): hub F says no `registry` in its hello and takes none, as a hub of
    // step 2.2. Its op registry is the same, so ops still pass between the two.
    [g, f] = await Promise.all([startRealHub(), startRealHub({ env: { FR_TEST_PEER_REGISTRY: 'off' } })]);
    await g.api.ok('hub_name_set', { name: 'hub-g' });
    await f.api.ok('hub_name_set', { name: 'hub-f' });
    NAMES.set(g, 'hub-g');
    NAMES.set(f, 'hub-f');
    await g.api.ok('network_set', { ssid: SSID });
    await f.api.ok('network_join', { hub: g.url });
    await eventually('the link', async () => (await call<PeersView>(g, 'hub_peers')).data?.peers.some((p) => p.name === 'hub-f' && p.reachable));
  }, 90_000);

  afterAll(async () => {
    await Promise.all([g?.stop(), f?.stop()]);
  }, 60_000);

  it('is sent no row, is named in hub_status and hub_peers, is still passed ops, and still gets a row by device_share', async () => {
    const pad = await g.api.ok<Enrolled>('device_enroll', { device_id: mac(0x201), chip: 'esp32c6', profile: 'c6-pad', alias: 'pad-g' });
    await sleep(2500); // two scans and more
    expect((await call(f, 'device_get', { device: 'pad-g' }, 'hub-f')).error).toMatchObject({ code: 'NOT_FOUND' });
    const view = await peersOf(g);
    expect(view.peers.find((p) => p.name === 'hub-f')).toMatchObject({ reachable: true, registry_hash: REGISTRY_HASH, registry: { speaks: false, in_step: null, sent: 0, received: 0 } });
    expect(view.counters).toMatchObject({ registry_rows_sent: 0, registry_digests_sent: 0 });
    // The older hub was sent nothing it would have had to drop.
    expect((await peersOf(f)).counters.unknown).toBe(0);
    const warnings = (await ok<{ warnings?: string[] }>(g, 'hub_status')).warnings ?? [];
    expect(warnings.filter((w) => w.includes('replicate'))).toEqual([expect.stringContaining('hub hub-f does not replicate the registry')]);
    expect(((await ok<{ warnings?: string[] }>(f, 'hub_status')).warnings ?? []).filter((w) => /registr|replicat/.test(w))).toEqual([]);
    // Ops still pass between them: their op registries are the same.
    expect((await call<{ hub: { name: string } }>(g, 'hub_status', {}, 'hub-f')).data?.hub.name).toBe('hub-f');
    // device_share still gives such a hub the row by hand, as under MULTI-HUB-1.
    const shared = await ok<{ replicated?: boolean; addr: number }>(g, 'device_share', { device: 'pad-g', with_hub: f.url });
    expect(shared.replicated).toBeUndefined();
    expect(shared.addr).toBe(pad.addr);
    expect(await own(f, 'pad-g')).toMatchObject({ device_id: mac(0x201), addr: pad.addr, net: pad.net, provisioned: true });
  }, 60_000);
});
