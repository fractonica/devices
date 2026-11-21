// The hubs' link, step 2.1 (design multi-hub-m2 §12 "link and presence"), end to end on loopback: three real hub
// processes (real-hub.ts: ephemeral ports, their own FR_HOME and secrets.json, the link on 127.0.0.1 at a port of its
// own) and the C++ fr_net_node (cpp-node.ts). In order:
//   - a hub that is alone has no key and no link, and says so;
//   - a hub that joined under MULTI-HUB-1 (a net id and a registrar, an epoch counter moved a quarter of the space
//     away, no key and no slot) joins again: it gets the key, its name and slot 1, and its epoch carries on;
//   - the key is in each hub's secrets.json and nowhere else: not in an op's answer, hub.db or what a hub printed;
//   - joining again changes nothing; the link comes back after either hub restarts, each in its own epoch slot;
//   - a third hub joins the registrar and becomes known to the second;
//   - a board on hub A is `at` hub A on every hub; it fails over to B and back, and the hubs follow;
//   - a hub that falls silent (SIGSTOP) is away within the away time, and what it held is no longer known;
//   - a fourth hub gets the last slot, a fifth is refused.
// peers.test.ts has the pieces (the TLS refusals, one connection per pair, the serial rule) without a hub process.
// `node tools/host-test.mjs` builds fr_net_node; without it the board's tests skip.

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REGISTRY_HASH, type SealedKey } from '@fractonica/protocol';

import { kvSet, openDb } from '../src/db.ts';
import { openSealed } from '../src/peers/key.ts';
import { BIN, CppNode } from './cpp-node.ts';
import { type RealHub, startRealHub } from './real-hub.ts';

const HAS_BIN = existsSync(BIN) && readFileSync(BIN).includes('--hub-map');
const MAC = 'aabbcc0e0d01';
const ALIAS = 'pad-roams';
const SOLO_MAC = 'aabbcc0e0d02';
const SOLO = 'pad-stays';
/** The names the board knows its hubs by; the node maps them to loopback ports (as interop-multi-hub.test.ts). */
const HUB_A = 'hub-a.test';
const HUB_B = 'hub-b.test';
const TIMING = { giveUpMs: 1500, welcomeMs: 1200, probeMs: 1500, confirmMs: 500, trialMs: 4000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Member {
  id: string;
  name: string;
  host: string;
  addr: string | null;
  link_port: number;
  slot: number;
}
interface Joined {
  net_id: number;
  previous_net_id: number | null;
  registrar: string;
  hub: { id: string; name: string; slot: number };
  members: Member[];
  warnings?: string[];
}
interface PeerRow {
  id: string;
  name: string;
  this: boolean;
  role: string;
  slot: number;
  reachable: boolean;
  since: string | null;
  registry_hash: string | null;
  hub_epoch: number | null;
  boards: number | null;
  address: string | null;
  last_error?: string;
}
interface Peers {
  net_id: number;
  hub: { id: string; name: string; slot: number | null };
  registrar: string;
  members_version: number;
  link: { listening: boolean; port: number | null; error: string | null };
  peers: PeerRow[];
}
interface Status {
  hub_epoch: number;
  hub: { id: string; name: string; slot: number | null };
  warnings: string[];
  router: { counters: Record<string, number> };
}
interface DeviceView {
  alias: string;
  presence: string;
  presence_reason?: string;
  at: string | null;
  hub_now?: { here: boolean; at: string | null };
}

const secretsOf = (h: RealHub) => JSON.parse(readFileSync(join(h.home, 'secrets.json'), 'utf8')) as { network_key?: { net_id: number; key: string } };

/** Every spelling of `key` a reader would look for, as text and as raw bytes. */
function spellings(keyHex: string): Buffer[] {
  const raw = Buffer.from(keyHex, 'hex');
  return [Buffer.from(keyHex), Buffer.from(keyHex.toUpperCase()), raw, Buffer.from(raw.toString('base64')), Buffer.from(raw.toString('base64url'))];
}

/** The files of a hub's home that are not secrets.json, with the spellings of the key any of them holds. */
function leaksIn(h: RealHub, keyHex: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile() && e.name !== 'secrets.json') {
        const bytes = readFileSync(p);
        if (spellings(keyHex).some((s) => bytes.includes(s))) {
          found.push(p);
        }
      }
    }
  };
  walk(h.home);
  return found;
}

async function peersOf(h: RealHub): Promise<Peers> {
  return h.api.ok<Peers>('hub_peers');
}

/** Waits until `h` sees every hub named reachable; the rows. */
async function linked(h: RealHub, names: string[], ms = 15_000): Promise<PeerRow[]> {
  const t0 = performance.now();
  for (;;) {
    const r = await h.api.call<Peers>('hub_peers');
    const rows = r.ok ? r.data!.peers : [];
    if (names.every((n) => rows.some((p) => p.name === n && p.reachable))) {
      return rows;
    }
    if (performance.now() - t0 > ms) {
      throw new Error(`timed out waiting for ${names.join(', ')} to be reachable: ${JSON.stringify(r.ok ? rows : r.error)}`);
    }
    await sleep(50);
  }
}

async function where(h: RealHub, alias = ALIAS): Promise<DeviceView> {
  return h.api.ok<DeviceView>('device_get', { device: alias });
}

/** Waits until `h` answers `at` for the board as `want`; the ms it took. */
async function atBecomes(h: RealHub, want: string | null, ms: number, what: string, alias = ALIAS): Promise<number> {
  const t0 = performance.now();
  for (;;) {
    const v = await h.api.call<DeviceView>('device_get', { device: alias });
    if (v.ok && v.data!.at === want) {
      return performance.now() - t0;
    }
    if (performance.now() - t0 > ms) {
      throw new Error(`timed out waiting for ${what} (at: ${JSON.stringify(v.ok ? v.data!.at : v.error)})`);
    }
    await sleep(40);
  }
}

/**
 * Waits until `h` shows the board as `unknown` because the hub that last held it is away (design multi-hub-m2 §6: `at`
 * still names that hub, and `presence_reason` says why); the ms it took.
 */
async function givenUp(h: RealHub, away: string, ms: number, what: string, alias = ALIAS): Promise<number> {
  const t0 = performance.now();
  for (;;) {
    const v = await h.api.call<DeviceView>('device_get', { device: alias });
    if (v.ok && v.data!.presence === 'unknown' && v.data!.at === away && v.data!.presence_reason === `hub ${away} is not reachable`) {
      return performance.now() - t0;
    }
    if (performance.now() - t0 > ms) {
      throw new Error(`timed out waiting for ${what} (${JSON.stringify(v.ok ? { presence: v.data!.presence, at: v.data!.at } : v.error)})`);
    }
    await sleep(40);
  }
}

describe("the hubs' link: key, members, slots and who is where (design multi-hub-m2 step 2.1)", () => {
  let a: RealHub;
  let b: RealHub;
  let c: RealHub;
  let netId = 0;
  let key = '';
  let node: CppNode | null = null;
  let solo: CppNode | null = null;
  let row: { addr: number; net: number; alias_rev: number };

  beforeAll(async () => {
    [a, b, c] = await Promise.all([startRealHub(), startRealHub(), startRealHub()]);
    // Three hubs on one Mac have one host name, and a hub's name is unique in its network: each is given its own.
    await a.api.ok('hub_name_set', { name: 'hub-a' });
    await b.api.ok('hub_name_set', { name: 'hub-b' });
    await c.api.ok('hub_name_set', { name: 'hub-c' });
    netId = (await a.api.ok<{ net_id: number }>('network_set', { ssid: 'lab-wifi' })).net_id;
  }, 120_000);

  afterAll(async () => {
    node?.stop();
    solo?.stop();
    for (const h of [a, b, c]) {
      // A hub this file stopped with SIGSTOP must run again to take its SIGTERM.
      const pid = h?.pid();
      if (pid) {
        try {
          process.kill(pid, 'SIGCONT');
        } catch {
          // gone already
        }
      }
    }
    await Promise.all([a?.stop(), b?.stop(), c?.stop()]);
  }, 60_000);

  it('a hub that is alone has an id and a name, no slot, no key and no link', async () => {
    const st = await a.api.ok<Status>('hub_status');
    expect(st.hub).toEqual({ id: expect.stringMatching(/^[0-9a-f]{12}$/), name: 'hub-a', slot: null });
    expect((await b.api.ok<Status>('hub_status')).hub.id).not.toBe(st.hub.id);
    const alone = await a.api.call('hub_peers');
    expect(alone.error).toMatchObject({ code: 'ENV_MISSING' });
    expect(alone.error!.message).toContain('this hub is alone in its network');
    expect(alone.error!.hint).toContain('fr net join --hub');
    expect(secretsOf(a).network_key).toBeUndefined();
    expect(a.peerPort()).toBeNull(); // nothing listens for hubs
    // The name is a lowercase label, and the same again is no change.
    expect((await a.api.call('hub_name_set', { name: 'Hub A' })).error).toMatchObject({ code: 'INVALID_ARGS' });
    expect(await a.api.ok('hub_name_set', { name: 'hub-a' })).toMatchObject({ hub: { name: 'hub-a' }, previous: 'hub-a' });
  });

  it('a hub that joined under MULTI-HUB-1 joins again: it gets the key, its name and a slot, and its epoch carries on', async () => {
    // What MULTI-HUB-1's network_join left in hub B: the registrar's net id and network, the registrar's URL, and
    // its own epoch counter moved a quarter of the u16 space away from the registrar's (1); two starts since.
    await b.halt();
    const db = openDb(join(b.home, 'hub.db'));
    try {
      db.prepare("INSERT INTO networks (id, name, ssid, band, updated_at, net_id, hub_host) VALUES (1, 'default', 'lab-wifi', 'auto', ?, ?, 'hub-b.test')").run(new Date().toISOString(), netId);
      kvSet(db, 'net.registrar', JSON.stringify({ url: a.url, hub_host: 'hub-a.test', net_id: netId, joined_at: '2026-11-20T10:00:00.000Z' }));
      kvSet(db, 'hub_epoch', String(1 + 0x4000 + 2));
    } finally {
      db.close();
    }
    await b.start();
    const before = await b.api.ok<Status>('hub_status');
    expect(before.hub).toMatchObject({ name: 'hub-b', slot: null });
    expect(before.hub_epoch).toBe(1 + 0x4000 + 3);
    // It says what it lacks, and how to get it.
    expect(before.warnings.join('\n')).toContain(`holds no network key: join it again (fr net join --hub ${a.url})`);
    const noLink = await b.api.call('hub_peers');
    expect(noLink.error).toMatchObject({ code: 'ENV_MISSING' });
    expect(noLink.error!.message).toContain("before the hubs' link and holds no network key");
    expect(noLink.error!.hint).toContain(`fr net join --hub ${a.url}`);

    const joined = await b.api.ok<Joined>('network_join', { hub: a.url });
    expect(joined).toMatchObject({ net_id: netId, previous_net_id: netId, registrar: a.url, hub: { name: 'hub-b', slot: 1 } });
    expect(joined.hub.id).toBe(before.hub.id);
    // Its running epoch is already one of slot 1 (MULTI-HUB-1 put it there): no restart is asked for the epoch. Its
    // cursors carry its slot only from its next start (step 2.4: a run number says whose a cursor is), and that is said.
    expect(joined.warnings ?? []).toEqual([expect.stringContaining('cursors (run')]);
    expect((joined.warnings ?? []).join('\n')).not.toContain('epoch');
    // The member list: both hubs, at the address and the port each really listens on.
    expect(joined.members.map((m) => [m.name, m.slot, m.host, m.addr, m.link_port])).toEqual([
      ['hub-a', 0, '127.0.0.1', '127.0.0.1', a.peerPort()],
      ['hub-b', 1, '127.0.0.1', '127.0.0.1', b.peerPort()],
    ]);
    expect(a.peerPort()).toBeGreaterThan(0);
    expect(b.peerPort()).not.toBe(a.peerPort());
    for (const port of [a.peerPort(), b.peerPort()]) {
      expect([7420, 7421, 7422, 7423, 7520]).not.toContain(port);
    }
    const after = await b.api.ok<Status>('hub_status');
    expect(after.hub).toEqual({ ...before.hub, slot: 1 });
    expect(after.warnings.join('\n')).not.toContain('network key');
    expect(after.warnings.join('\n')).not.toContain('epoch slot');
    expect((await a.api.ok<Status>('hub_status')).hub).toMatchObject({ name: 'hub-a', slot: 0 });
    // The link is up at both ends, and each says what the other runs.
    const atB = await linked(b, ['hub-a']);
    const atA = await linked(a, ['hub-b']);
    expect(atB.map((p) => [p.name, p.this, p.role, p.slot, p.reachable, p.registry_hash, p.boards])).toEqual([
      ['hub-a', false, 'registrar', 0, true, REGISTRY_HASH, 0],
      ['hub-b', true, 'member', 1, true, REGISTRY_HASH, 0],
    ]);
    expect(atB[0].hub_epoch).toBe(1);
    expect(atA[1]).toMatchObject({ name: 'hub-b', this: false, role: 'member', hub_epoch: 1 + 0x4000 + 3 });
    expect(atB[0].address).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(atB[0].since).toMatch(/^\d{4}-/);
    const view = await peersOf(b);
    expect(view).toMatchObject({ net_id: netId, hub: { name: 'hub-b', slot: 1 }, registrar: 'hub-a', members_version: 1, link: { listening: true, port: b.peerPort(), error: null } });
  }, 60_000);

  it('the key is in each hub\'s secrets.json and nowhere else: no answer, no hub.db, no log line holds it', async () => {
    const atA = secretsOf(a).network_key!;
    const atB = secretsOf(b).network_key!;
    expect(atA).toEqual({ net_id: netId, key: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(atB).toEqual(atA);
    key = atA.key;
    // Every answer a client can ask for.
    const answers: unknown[] = [];
    for (const h of [a, b]) {
      for (const [op, input] of [['hub_status', {}], ['hub_peers', {}], ['network_get', {}], ['network_list', {}], ['device_list', {}], ['events_read', { max_events: 100 }]] as const) {
        answers.push(await h.api.call(op, input));
      }
    }
    answers.push(await b.api.call('network_join', { hub: a.url }));
    // The registrar's own answer, asked as hub B's join asks it, with a key pair made here: only a sealed blob.
    const me = (await peersOf(b)).peers.find((p) => p.this)!;
    const own = (await b.api.ok<Joined>('network_join', { hub: a.url })).members.find((m) => m.id === me.id)!;
    const pair = generateKeyPairSync('x25519');
    const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
    const admitted = await a.api.ok<{ hub: { slot: number }; members_version: number; sealed: SealedKey }>('network_admit', { hub_id: own.id, name: own.name, host: own.host, addr: own.addr!, link_port: own.link_port, public_key: publicKey });
    answers.push(admitted);
    expect(admitted).toMatchObject({ hub: { slot: 1 }, members_version: 1, sealed: { alg: 'x25519-hkdf-sha256-aes256gcm' } });
    expect(Object.keys(admitted).sort()).toEqual(['hub', 'members', 'members_version', 'net_id', 'registrar', 'sealed']);
    const text = Buffer.from(JSON.stringify(answers));
    for (const s of spellings(key)) {
      expect(text.includes(s)).toBe(false);
    }
    // The blob opens only with the private key of the pair it was sealed to, and then it is the key.
    expect(openSealed(admitted.sealed, { publicKey, privateKey: pair.privateKey }, netId, own.id).toString('hex')).toBe(key);
    const other = generateKeyPairSync('x25519');
    expect(() => openSealed(admitted.sealed, { publicKey, privateKey: other.privateKey }, netId, own.id)).toThrow(/does not open/);
    // hub.db (and its WAL), config and every other file of both homes; and all both hubs printed.
    expect(leaksIn(a, key)).toEqual([]);
    expect(leaksIn(b, key)).toEqual([]);
    for (const h of [a, b]) {
      const printed = Buffer.from(JSON.stringify(h.lines) + h.stderr());
      for (const s of spellings(key)) {
        expect(printed.includes(s)).toBe(false);
      }
    }
    // What the hubs did print about the link names hubs and addresses.
    expect(a.lines.some((l) => l.event === 'peer_link_listening' && l.port === a.peerPort())).toBe(true);
    expect([...a.lines, ...b.lines].some((l) => l.event === 'peer_up')).toBe(true);
  }, 60_000);

  it('joining the same hub again changes nothing: the same slot, name, list and key, and the link stays up', async () => {
    const before = await peersOf(b);
    const again = await b.api.ok<Joined>('network_join', { hub: a.url });
    expect(again).toMatchObject({ net_id: netId, previous_net_id: netId, hub: { name: 'hub-b', slot: 1 } });
    expect(again.members.map((m) => [m.name, m.slot])).toEqual([['hub-a', 0], ['hub-b', 1]]);
    expect(secretsOf(b).network_key!.key).toBe(key);
    expect(secretsOf(a).network_key!.key).toBe(key);
    const after = await peersOf(b);
    expect(after.members_version).toBe(before.members_version);
    expect(after.peers.map((p) => [p.name, p.reachable, p.since])).toEqual(before.peers.map((p) => [p.name, p.reachable, p.since]));
    // A member admits nobody, and a hub cannot take a name the network has.
    const pair = generateKeyPairSync('x25519');
    const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
    const byMember = await b.api.call('network_admit', { hub_id: 'aaaaaaaaaaaa', name: 'hub-x', host: '127.0.0.1', link_port: 9, public_key: publicKey });
    expect(byMember.error).toMatchObject({ code: 'INVALID_ARGS' });
    expect(byMember.error!.message).toContain("only that hub, the network's registrar, admits a hub");
    const taken = await a.api.call('network_admit', { hub_id: 'aaaaaaaaaaaa', name: 'hub-b', host: '127.0.0.1', link_port: 9, public_key: publicKey });
    expect(taken.error).toMatchObject({ code: 'INVALID_ARGS' });
    expect(taken.error!.message).toContain('the network already has a hub named hub-b');
    expect(taken.error!.hint).toContain('fr hub name');
    const rename = await b.api.call('hub_name_set', { name: 'hub-a' });
    expect(rename.error).toMatchObject({ code: 'INVALID_ARGS' });
    expect(rename.error!.message).toContain(`the network of the hub at ${a.url} already has a hub named hub-a`);
    expect((await b.api.ok<Status>('hub_status')).hub.name).toBe('hub-b');
    expect((await a.api.call('hub_name_set', { name: 'hub-b' })).error!.message).toContain('the network already has a hub named hub-b');
    expect((await peersOf(a)).peers.map((p) => p.name)).toEqual(['hub-a', 'hub-b']);
  }, 30_000);

  it('each hub counts its epochs in its own slot across restarts, and the link comes back after either restarts', async () => {
    await b.restart();
    expect((await b.api.ok<Status>('hub_status')).hub_epoch).toBe(1 + 0x4000 + 4); // slot 1: it carries on
    await linked(a, ['hub-b']);
    await linked(b, ['hub-a']);
    expect((await peersOf(a)).peers[1]).toMatchObject({ name: 'hub-b', hub_epoch: 1 + 0x4000 + 4 });
    await a.restart();
    expect((await a.api.ok<Status>('hub_status')).hub_epoch).toBe(2); // slot 0
    await linked(a, ['hub-b']);
    await linked(b, ['hub-a']);
    expect((await peersOf(b)).peers[0]).toMatchObject({ name: 'hub-a', hub_epoch: 2 });
    // The link listens where the member list says after a restart.
    expect((await peersOf(a)).link.port).toBe(a.peerPort());
    for (const h of [a, b]) {
      const st = await h.api.ok<Status>('hub_status');
      expect(st.hub.slot === 0 ? st.hub_epoch < 0x4000 : st.hub_epoch > 0x4000 && st.hub_epoch < 0x8000).toBe(true);
      expect(st.warnings.join('\n')).not.toContain('epoch slot');
    }
  }, 90_000);

  it('a third hub joins the registrar and becomes known to the second; a renamed hub is renamed on every hub', async () => {
    expect((await peersOf(b)).peers.map((p) => p.name)).toEqual(['hub-a', 'hub-b']);
    // Under a name the network has, the join is refused before anything changes on the joining hub.
    await c.api.ok('hub_name_set', { name: 'hub-b' });
    const clash = await c.api.call('network_join', { hub: a.url });
    expect(clash.error).toMatchObject({ code: 'INVALID_ARGS' });
    expect(clash.error!.message).toContain(`the network of the hub at ${a.url} already has a hub named hub-b`);
    expect(clash.error!.hint).toBe('give this hub another name, then join again: fr hub name <name>');
    expect((await c.api.ok<Status>('hub_status')).hub).toMatchObject({ name: 'hub-b', slot: null });
    expect((await c.api.call('network_get', {})).error).toMatchObject({ code: 'NOT_FOUND' }); // no network taken, no registrar
    expect(secretsOf(c).network_key).toBeUndefined();
    expect(c.peerPort()).toBeNull(); // the listener it bound to tell the registrar a port was closed again
    expect((await peersOf(a)).peers.map((p) => p.name)).toEqual(['hub-a', 'hub-b']);
    await c.api.ok('hub_name_set', { name: 'hub-c' });
    const joined = await c.api.ok<Joined>('network_join', { hub: a.url });
    expect(joined).toMatchObject({ net_id: netId, hub: { name: 'hub-c', slot: 2 } });
    expect(joined.members.map((m) => [m.name, m.slot])).toEqual([['hub-a', 0], ['hub-b', 1], ['hub-c', 2]]);
    // A fresh hub's first run is epoch 1, which is not one of slot 2: it is told to restart, and then it is.
    expect(joined.warnings!.join(' ')).toContain("this hub run's epoch (1) is outside the epoch slot the registrar gave it (slot 2: 32769..49151)");
    expect((await c.api.ok<Status>('hub_status')).warnings.join('\n')).toContain('outside its epoch slot 2');
    expect(secretsOf(c).network_key).toEqual({ net_id: netId, key });
    expect(leaksIn(c, key)).toEqual([]);
    // Hub B was told by the registrar over the link, and the two members reach each other directly.
    const atB = await linked(b, ['hub-a', 'hub-c']);
    expect(atB.map((p) => [p.name, p.role, p.slot])).toEqual([['hub-a', 'registrar', 0], ['hub-b', 'member', 1], ['hub-c', 'member', 2]]);
    await linked(c, ['hub-a', 'hub-b']);
    await linked(a, ['hub-b', 'hub-c']);
    expect((await peersOf(b)).members_version).toBe((await peersOf(a)).members_version);
    await c.restart();
    expect((await c.api.ok<Status>('hub_status')).hub_epoch).toBe(0x8000 + 1);
    await linked(c, ['hub-a', 'hub-b']);
    await linked(b, ['hub-a', 'hub-c']);
    // A member renames itself at the registrar (its API); every hub then knows it by the new name.
    expect(await c.api.ok('hub_name_set', { name: 'attic' })).toMatchObject({ hub: { name: 'attic', slot: 2 }, previous: 'hub-c' });
    for (const h of [a, b, c]) {
      await linked(h, h === c ? ['hub-a', 'hub-b'] : ['attic']);
      expect((await peersOf(h)).peers.map((p) => p.name)).toEqual(['hub-a', 'hub-b', 'attic']);
    }
    // And the registrar renames itself.
    expect(await a.api.ok('hub_name_set', { name: 'lab' })).toMatchObject({ hub: { name: 'lab', slot: 0 }, previous: 'hub-a' });
    for (const h of [b, c]) {
      await linked(h, ['lab']);
      expect((await peersOf(h)).registrar).toBe('lab');
    }
    await a.api.ok('hub_name_set', { name: 'hub-a' });
    await c.api.ok('hub_name_set', { name: 'hub-c' });
    for (const h of [a, b, c]) {
      await linked(h, ['hub-a', 'hub-b', 'hub-c'].filter((n) => n !== (h === a ? 'hub-a' : h === b ? 'hub-b' : 'hub-c')));
    }
  }, 120_000);

  describe.skipIf(!HAS_BIN)('who is where, with a board (the C++ node)', () => {
    beforeAll(async () => {
      row = await a.api.ok('device_enroll', { device_id: MAC, chip: 'esp32c6', profile: 'c6-pad', alias: ALIAS });
      await a.api.ok('device_update', { device: ALIAS, tag: '-new' });
      const other = await a.api.ok<{ addr: number; alias_rev: number }>('device_enroll', { device_id: SOLO_MAC, chip: 'esp32c6', profile: 'c6-pad', alias: SOLO });
      // The registry is one (step 2.3): the rows reach the other hubs by themselves.
      for (const h of [b, c]) {
        for (const alias of [ALIAS, SOLO]) {
          for (let i = 0; !(await h.api.call<{ devices: unknown[] }>('device_list', { selector: alias })).data?.devices.length; i++) {
            if (i > 200) {
              throw new Error(`${alias} did not reach a member by replication`);
            }
            await sleep(50);
          }
        }
      }
      node = new CppNode([
        '--hub-tcp', String(a.node.tcp),
        '--hub-udp', String(a.node.udp),
        '--hub-http', String(a.node.http),
        '--hub-name', HUB_A,
        '--hub-map', `${HUB_B}=${b.node.tcp}:${b.node.udp}:${b.node.http}`,
        '--hub-timing', `${TIMING.giveUpMs}:${TIMING.welcomeMs}:${TIMING.probeMs}:${TIMING.confirmMs}:${TIMING.trialMs}`,
        '--mac', MAC,
        '--addr', String(row.addr),
        '--net', String(row.net),
        '--alias', ALIAS,
        '--alias-rev', String(row.alias_rev),
        '--epoch', '3',
        '--hb-ms', '500',
      ]);
      // A board with one hub and no list: it stays with hub A whatever happens to it.
      solo = new CppNode([
        '--hub-tcp', String(a.node.tcp),
        '--hub-udp', String(a.node.udp),
        '--hub-http', String(a.node.http),
        '--mac', SOLO_MAC,
        '--addr', String(other.addr),
        '--net', String(row.net),
        '--alias', SOLO,
        '--alias-rev', String(other.alias_rev),
        '--epoch', '2',
        '--hb-ms', '500',
      ]);
      await atBecomes(a, 'hub-a', 15_000, 'the board on hub A');
      await atBecomes(a, 'hub-a', 15_000, 'the second board on hub A', SOLO);
      await a.api.ok('device_hubs_set', { device: ALIAS, hub: [HUB_A, `${HUB_B}/127.0.0.1`] });
    }, 60_000);

    it('a board on hub A is `at` hub A on every hub, and online there for every hub (step 2.2: the op is passed to hub A)', async () => {
      await atBecomes(b, 'hub-a', 5000, 'hub B to hear the board is at hub A');
      await atBecomes(c, 'hub-a', 5000, 'hub C to hear the board is at hub A');
      expect(await where(a)).toMatchObject({ presence: 'online', at: 'hub-a', hub_now: { here: true, at: 'hub-a' } });
      for (const h of [b, c]) {
        // Step 2.2: device_get for a board at hub A is answered by hub A, so it reads as it does there.
        const v = await where(h);
        expect(v).toMatchObject({ presence: 'online', at: 'hub-a', hub_now: { here: true, at: 'hub-a' } });
        // device_list is this hub's own list: the peer's report is the board's presence, with `at`.
        const list = await h.api.ok<{ devices: DeviceView[] }>('device_list', {});
        expect(list.devices.map((d) => [d.alias, d.presence, d.at]).sort()).toEqual([[ALIAS, 'online', 'hub-a'], [SOLO, 'online', 'hub-a']]);
      }
      expect((await peersOf(b)).peers.map((p) => [p.name, p.boards])).toEqual([['hub-a', 2], ['hub-b', 0], ['hub-c', 0]]);
      expect((await peersOf(a)).peers.map((p) => [p.name, p.boards])).toEqual([['hub-a', 2], ['hub-b', 0], ['hub-c', 0]]);
    }, 30_000);

    it('the board fails over to hub B and both hubs follow; hub A stopped makes it `unknown` until the board arrives', async () => {
      await atBecomes(b, 'hub-a', 10_000, 'hub B to know the board at hub A before the failover');
      const stopped = performance.now();
      await a.halt();
      // Hub A's link closed: at once, well inside the away time, hub B no longer knows where the board is; it says
      // the board was at hub A and that hub A is not reachable (§6) ...
      const forgot = await givenUp(b, 'hub-a', 6000, 'hub B to give up what hub A held');
      expect(performance.now() - stopped).toBeLessThan(6000 + 2000);
      expect(forgot).toBeLessThan(6000);
      // ... and then the board, having given hub A up, is with hub B.
      await atBecomes(b, 'hub-b', 20_000, 'the board on hub B');
      expect(await where(b)).toMatchObject({ presence: 'online', at: 'hub-b', hub_now: { here: true, at: 'hub-b' } });
      await atBecomes(c, 'hub-b', 5000, 'hub C to hear the board is at hub B');
      expect((await where(c)).presence).toBe('online'); // answered by hub B
      expect((await peersOf(c)).peers.map((p) => [p.name, p.reachable, p.boards])).toEqual([['hub-a', false, null], ['hub-b', true, 1], ['hub-c', true, 0]]);
      // Its only hub is stopped: nobody holds it, and hub C says which hub it was last seen at.
      expect(await where(c, SOLO)).toMatchObject({ presence: 'unknown', at: 'hub-a', presence_reason: 'hub hub-a is not reachable', hub_now: { here: false, at: null } });
    }, 60_000);

    it('hub A comes back: the board returns by itself and every hub follows', async () => {
      await a.start();
      await linked(a, ['hub-b', 'hub-c'], 30_000);
      await atBecomes(a, 'hub-a', 40_000, 'the board back on hub A');
      await atBecomes(b, 'hub-a', 10_000, 'hub B to hear the board went back to hub A');
      await atBecomes(c, 'hub-a', 10_000, 'hub C to hear the board went back to hub A');
      expect(await where(b)).toMatchObject({ presence: 'online', at: 'hub-a', hub_now: { here: true, at: 'hub-a' } });
      await atBecomes(c, 'hub-a', 20_000, 'the second board back on hub A', SOLO);
      expect((await where(c, SOLO)).presence_reason).toBeUndefined();
      expect((await peersOf(b)).peers.map((p) => [p.name, p.reachable, p.boards])).toEqual([['hub-a', true, 2], ['hub-b', true, 0], ['hub-c', true, 0]]);
      // No hub held a board back on a cable in all this (there is none): the counters say so.
      for (const h of [a, b, c]) {
        expect((await h.api.ok<Status>('hub_status')).router.counters).toMatchObject({ serial_hello_held: 0, serial_yielded: 0 });
      }
    }, 120_000);

    it('a hub that falls silent is away within the away time: what it held is no longer known, and it is back when it runs again', async () => {
      const pid = a.pid()!;
      process.kill(pid, 'SIGSTOP'); // its sockets stay open and say nothing: no FIN tells its peers
      const t0 = performance.now();
      try {
        // The second board has no other hub to go to. Hub B knows it at hub A until hub A has been silent for 6 s.
        const ms = await givenUp(b, 'hub-a', 12_000, 'hub B to give hub A up', SOLO);
        expect(ms).toBeGreaterThan(3500); // not before the pings went unanswered (6 s, less the last one's age)
        expect(ms).toBeLessThan(9000);
        const rowA = (await peersOf(b)).peers[0];
        expect(rowA).toMatchObject({ name: 'hub-a', reachable: false, boards: null, address: null });
        expect(rowA.last_error).toMatch(/silent for \d\.\d s|ECONNREFUSED|no TLS session|its hello was not answered/);
        expect(await where(b, SOLO)).toMatchObject({ presence: 'unknown', at: 'hub-a', hub_now: { here: false, at: null } });
      } finally {
        process.kill(pid, 'SIGCONT');
      }
      expect(performance.now() - t0).toBeLessThan(15_000);
      // Running again, hub A is found (it gave its own silent peers up, and both ends dial).
      await linked(b, ['hub-a'], 30_000);
      await linked(a, ['hub-b', 'hub-c'], 30_000);
      await atBecomes(b, 'hub-a', 30_000, 'hub B to hear the second board is at hub A again', SOLO);
    }, 90_000);
  });

  it('a fourth hub gets the last slot and a fifth is refused; no answer of any of it holds the key', async () => {
    const pair = generateKeyPairSync('x25519');
    const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
    // Hubs that exist only as a name here: nothing listens where they say (port 9 on loopback).
    const fourth = await a.api.ok<{ hub: { slot: number }; members: Member[] }>('network_admit', { hub_id: 'dddddddddddd', name: 'hub-d', host: '127.0.0.1', addr: '127.0.0.1', link_port: 9, public_key: publicKey });
    expect(fourth.hub.slot).toBe(3);
    expect(fourth.members.map((m) => m.slot)).toEqual([0, 1, 2, 3]);
    const fifth = await a.api.call('network_admit', { hub_id: 'eeeeeeeeeeee', name: 'hub-e', host: '127.0.0.1', addr: '127.0.0.1', link_port: 9, public_key: publicKey });
    expect(fifth.error).toMatchObject({ code: 'INVALID_ARGS' });
    expect(fifth.error!.message).toContain('the network already has 4 hubs (hub-a, hub-b, hub-c, hub-d)');
    // The members hear of the fourth, and say they cannot reach it and why.
    const t0 = performance.now();
    let rows: PeerRow[] = [];
    while (performance.now() - t0 < 15_000) {
      rows = (await peersOf(b)).peers;
      if (rows.some((p) => p.name === 'hub-d' && p.last_error)) {
        break;
      }
      await sleep(100);
    }
    expect(rows.find((p) => p.name === 'hub-d')).toMatchObject({ slot: 3, reachable: false, boards: null, registry_hash: null });
    expect(rows.find((p) => p.name === 'hub-d')!.last_error).toMatch(/127\.0\.0\.1:9: ECONNREFUSED/);
    const text = Buffer.from(JSON.stringify([fourth, fifth, rows]));
    for (const s of spellings(key)) {
      expect(text.includes(s)).toBe(false);
    }
    for (const h of [a, b, c]) {
      expect(leaksIn(h, key)).toEqual([]);
    }
  }, 60_000);
});
