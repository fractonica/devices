// One network, two hubs, and a board with both in its hub list (design multi-hub-m1), end to end on loopback: two real
// hub processes (real-hub.ts: ephemeral ports, their own FR_HOME) and the C++ fr_net_node (cpp-node.ts), whose TCP link
// follows the firmware's own rules (fr/net/hub_plan.hpp, as hub_link.cpp does on a board). The second hub joins the
// first one's network (network_join), holds the board's row by replication (design multi-hub-m2 step 2.3; device_share,
// which gave it by hand under MULTI-HUB-1, has nothing left to do), and the board's list is set over the air
// (device_hubs_set). Then: the first hub stops and the board is on the second within the bounded time; the first comes
// back and the board returns by itself; a new list changes the default hub; a list none of whose hubs answers is
// dropped after its trial; taking the list away is the provisioned hub again. The node's timing is shortened
// (--hub-timing: give up a hub after 1.5 s, probe every 1.5 s and confirm after 0.5 s, a 4 s trial) so the suite does
// not wait minutes; the rules are the ones of the 10 s, 60 s, 10 s and 60 s defaults.
// `node tools/host-test.mjs` builds fr_net_node; without it (or without its hub list flags) the suite skips.

import { existsSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AT_HEADER, type Result } from '@fractonica/protocol';

import { BIN, CppNode } from './cpp-node.ts';
import { type RealHub, startRealHub } from './real-hub.ts';

const HAS_BIN = existsSync(BIN) && readFileSync(BIN).includes('--hub-map');
const MAC = 'aabbcc0e0a01';
const ALIAS = 'pad-two-hubs';
/** The names the board knows its hubs by (a board's hub_host and list entries); the node maps them to loopback ports. */
const HUB_A = 'hub-a.test';
const HUB_B = 'hub-b.test';
const TIMING = { giveUpMs: 1500, welcomeMs: 1200, probeMs: 1500, confirmMs: 500, trialMs: 4000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DeviceGet {
  presence: string;
  addr: number;
  net: number;
  alias: string;
  hubs: { rev: number; hubs: { host: string; ip: string | null }[] } | null;
  hub_now: { here: boolean; on: number | null; rev: number | null; trial: boolean | null };
  router: { links: string[] } | null;
}
interface Hubs {
  hubs: { host: string; ip: string | null }[];
  rev: number;
  on: number | null;
  trial: boolean | null;
  left?: boolean;
  warnings?: string[];
}

/**
 * Each hub is asked by its own name here (X-Fr-At, `fr --at <this hub>`): this file is about what each hub holds and
 * does itself. Since the hubs' link passes ops on (design multi-hub-m2 step 2.2), an op for a board that is asked
 * without a name runs at the hub that has the board, whichever hub is asked (interop-pass.test.ts).
 */
const NAMES = new Map<RealHub, string>();

async function callOwn<T = unknown>(h: RealHub, op: string, input: Record<string, unknown> = {}): Promise<Result<T>> {
  const r = await fetch(`${h.url}/api/v1/op/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(NAMES.has(h) ? { [AT_HEADER]: NAMES.get(h)! } : {}) },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  const body = r ? ((await r.json().catch(() => null)) as Result<T> | null) : null;
  return body ?? { ok: false, cursor: '', error: { code: 'HUB_UNREACHABLE', message: 'no answer', retryable: true } };
}

async function okOwn<T = unknown>(h: RealHub, op: string, input: Record<string, unknown> = {}): Promise<T> {
  const r = await callOwn<T>(h, op, input);
  if (!r.ok) {
    throw new Error(`${op}: ${r.error?.code} ${r.error?.message}`);
  }
  return r.data as T;
}

/** Whether the board's TCP session is with `h` now. */
async function on(h: RealHub): Promise<boolean> {
  const r = await callOwn<DeviceGet>(h, 'device_get', { device: ALIAS });
  return r.ok && r.data!.presence === 'online' && (r.data!.router?.links ?? []).includes('tcp');
}

/** Waits until the board is on `h`; the ms it took. */
async function arrives(h: RealHub, ms: number, what: string): Promise<number> {
  const t0 = performance.now();
  while (!(await on(h))) {
    if (performance.now() - t0 > ms) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(50);
  }
  return performance.now() - t0;
}

async function gone(h: RealHub, ms: number, what: string): Promise<void> {
  const t0 = performance.now();
  while (await on(h)) {
    if (performance.now() - t0 > ms) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(50);
  }
}

describe.skipIf(!HAS_BIN)('one network, two hubs, a C++ node with a hub list (design multi-hub-m1)', () => {
  let a: RealHub;
  let b: RealHub;
  let node: CppNode;
  let row: { addr: number; net: number; alias_rev: number };

  beforeAll(async () => {
    [a, b] = await Promise.all([startRealHub(), startRealHub()]);
    // Hub A has the network and is its registrar; B joins it and holds no address space of its own.
    await a.api.ok('network_set', { ssid: 'lab-wifi' });
    row = await a.api.ok('device_enroll', { device_id: MAC, chip: 'esp32c6', profile: 'c6-pad', alias: ALIAS });
    await a.api.ok('device_update', { device: ALIAS, tag: '-new' });
    // Two hubs on one Mac have one host name, and a network refuses a second hub under a name it has (design
    // multi-hub-m2 §2): each is given its own, as `fr hub name` does.
    await a.api.ok('hub_name_set', { name: 'hub-a' });
    await b.api.ok('hub_name_set', { name: 'hub-b' });
    NAMES.set(a, 'hub-a');
    NAMES.set(b, 'hub-b');
    const joined = await b.api.ok<{ net_id: number; registrar: string; hub: { name: string; slot: number }; warnings?: string[] }>('network_join', { hub: a.url });
    expect(joined).toMatchObject({ net_id: row.net, registrar: a.url, hub: { name: 'hub-b', slot: 1 } });
    // Each hub counts its epochs inside its own slot (design multi-hub-m2 §9; it replaced MULTI-HUB-1's counter moved
    // a quarter of the space away): the registrar is slot 0, B slot 1. A fresh hub's first run is epoch 1 on both,
    // which is not one of slot 1: the answer says to restart, and the restart gives B the first epoch of its slot.
    const epochA = (await a.api.ok<{ hub_epoch: number }>('hub_status')).hub_epoch;
    expect(epochA).toBe(1);
    expect(joined.warnings?.join(' ')).toContain("this hub run's epoch (1) is outside the epoch slot the registrar gave it (slot 1: 16385..32767)");
    await b.restart();
    expect((await b.api.ok<{ hub_epoch: number }>('hub_status')).hub_epoch).toBe(0x4000 + 1);
    // The member holds the row by itself (step 2.3). device_share, which gave it by hand, says so and sends nothing.
    for (let i = 0; !(await callOwn<DeviceGet>(b, 'device_get', { device: ALIAS })).ok; i++) {
      if (i > 200) {
        throw new Error('the row did not reach hub B by replication');
      }
      await sleep(50);
    }
    const shared = await a.api.ok<{ replicated?: boolean; hub_host: string; warnings?: string[] }>('device_share', { device: ALIAS, with_hub: b.url });
    expect(shared.replicated).toBe(true);
    expect(shared.warnings?.join(' ')).toContain(`nothing to share: hub hub-b holds ${ALIAS}'s row already`);
    // The board as provisioned for hub A: one identity, A as its hub; B is a name it can look up.
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
    await arrives(a, 15_000, 'the node on hub A');
  }, 90_000);

  afterAll(async () => {
    node?.stop();
    await Promise.all([a?.stop(), b?.stop()]);
  }, 60_000);

  it('both hubs hold one row for the board; only the registrar hands out addresses, and a member asks it for one', async () => {
    const atA = await okOwn<DeviceGet>(a, 'device_get', { device: ALIAS });
    const atB = await okOwn<DeviceGet>(b, 'device_get', { device: ALIAS });
    expect(atB).toMatchObject({ addr: atA.addr, net: atA.net, alias: ALIAS, provisioned: true });
    expect(atA.hub_now).toMatchObject({ here: true });
    expect(atB.hub_now).toMatchObject({ here: false });
    expect(await b.api.ok('network_get', {})).toMatchObject({ net_id: row.net, registrar: a.url });
    // A new board enrolled at the member: the registrar gives the address over the hubs' link (step 2.3; before it
    // the member refused with "only that hub, the network's registrar, hands out addresses"), and holds the row too.
    const enrolled = await b.api.ok<{ addr: number; net: number; alias: string }>('device_enroll', { device_id: 'aabbcc0e0a02', chip: 'esp32c6', profile: 'c6-pad' });
    expect(enrolled).toMatchObject({ addr: row.addr + 1, net: row.net, alias: 'c6-pad-0e0a02' });
    for (let i = 0; (await callOwn<DeviceGet & { provisioned: boolean }>(a, 'device_get', { device: 'id:aabbcc0e0a02' })).data?.provisioned !== true; i++) {
      expect(i).toBeLessThan(200);
      await sleep(50);
    }
    expect((await okOwn<DeviceGet>(a, 'device_get', { device: 'id:aabbcc0e0a02' }))).toMatchObject({ addr: row.addr + 1, alias: 'c6-pad-0e0a02', tags: ['new'] });
  });

  it('the hub list goes to the board over the air and into the registry', async () => {
    expect(await okOwn<Hubs>(a, 'device_hubs_get', { device: ALIAS })).toMatchObject({ hubs: [], rev: 0, on: null, trial: false });
    // What is not a list is refused before anything is sent.
    for (const [input, text] of [
      [{ device: ALIAS }, 'give the hubs in priority order'],
      [{ device: ALIAS, hub: [HUB_A, HUB_A.toUpperCase()] }, 'is in the list twice'],
      [{ device: ALIAS, hub: [HUB_A], none: true }, '--none takes the list away'],
    ] as const) {
      const r = await callOwn(a, 'device_hubs_set', input);
      expect(r.error, JSON.stringify(input)).toMatchObject({ code: 'INVALID_ARGS' });
      expect(r.error!.message).toContain(text);
    }
    expect((await callOwn(b, 'device_hubs_set', { device: ALIAS, hub: [HUB_A] })).error).toMatchObject({ code: 'DEVICE_OFFLINE' });
    expect((await callOwn(b, 'device_hubs_get', { device: ALIAS })).error).toMatchObject({ code: 'DEVICE_OFFLINE' });

    const set = await okOwn<Hubs>(a, 'device_hubs_set', { device: ALIAS, hub: [HUB_A, `${HUB_B}/127.0.0.1`] });
    // It names the hub the board is on: kept at once, the session stays.
    expect(set).toMatchObject({ hubs: [{ host: HUB_A, ip: null }, { host: HUB_B, ip: '127.0.0.1' }], rev: 1, on: 0, trial: false, left: false });
    expect(node.of('hubs').at(-1)).toMatchObject({ rev: 1, count: 2, state: 'kept' });
    const got = await okOwn<DeviceGet>(a, 'device_get', { device: ALIAS });
    expect(got.hubs).toMatchObject({ rev: 1, hubs: [{ host: HUB_A, ip: null }, { host: HUB_B, ip: '127.0.0.1' }] });
    expect(got.hub_now).toMatchObject({ here: true, on: 0, rev: 1, trial: false });
    expect(await on(a)).toBe(true);
  });

  it('its first hub stops: the board is on the second within the bounded time, under the same identity', async () => {
    const state = await node.state();
    await a.halt();
    const ms = await arrives(b, 20_000, 'the node on hub B after hub A stopped');
    // Give up after 1.5 s without a session (and at least three attempts), then one connect and a handshake.
    expect(ms).toBeGreaterThan(TIMING.giveUpMs - 200);
    expect(ms).toBeLessThan(TIMING.giveUpMs + 6000);
    expect(node.of('hub_next').at(-1)).toMatchObject({ from: HUB_A, to: HUB_B });
    expect(node.of('hub').at(-1)).toMatchObject({ on: 1, name: HUB_B });
    const atB = await okOwn<DeviceGet>(b, 'device_get', { device: ALIAS });
    expect(atB).toMatchObject({ addr: row.addr, net: row.net, alias: ALIAS, presence: 'online' });
    // The same boot, the same epoch: it moved, it did not restart.
    expect((await node.state()).epoch).toBe(state.epoch);
    // Hub B never set the list: it holds it by replication (step 2.3), and asking the board agrees.
    expect(atB.hubs).toMatchObject({ rev: 1, hubs: [{ host: HUB_A }, { host: HUB_B }] });
    expect(await okOwn<Hubs>(b, 'device_hubs_get', { device: ALIAS })).toMatchObject({ rev: 1, on: 1, trial: false });
    expect((await okOwn<DeviceGet>(b, 'device_get', { device: ALIAS })).hubs).toMatchObject({ rev: 1, hubs: [{ host: HUB_A }, { host: HUB_B }] });
  }, 60_000);

  it('its first hub comes back: the board returns by itself', async () => {
    const returns = node.of('hub_return').length;
    await a.start();
    const ms = await arrives(a, 30_000, 'the node back on hub A');
    // A probe period at most until it looks, then the second answer, then the connect.
    expect(ms).toBeLessThan(TIMING.probeMs + TIMING.confirmMs + 8000);
    expect(node.of('hub_return').length).toBe(returns + 1);
    expect(node.of('hub_return').at(-1)).toMatchObject({ to: HUB_A });
    expect(node.of('hub').at(-1)).toMatchObject({ on: 0, name: HUB_A });
    await gone(b, 10_000, 'hub B to see the node leave');
    expect((await okOwn<DeviceGet>(b, 'device_get', { device: ALIAS })).hub_now.here).toBe(false);
    // Hub A restarted: its row is the one it had, and the board says where it is.
    expect(await okOwn<Hubs>(a, 'device_hubs_get', { device: ALIAS })).toMatchObject({ rev: 1, on: 0, trial: false });
  }, 90_000);

  it('a new list changes the default hub: the board moves to the hub now first', async () => {
    const set = await okOwn<Hubs>(a, 'device_hubs_set', { device: ALIAS, hub: [HUB_B, HUB_A] });
    expect(set).toMatchObject({ hubs: [{ host: HUB_B }, { host: HUB_A }], rev: 2 });
    // The list names hub A (now second), so it was kept without a trial; hub B above it is probed at once.
    expect(node.of('hubs').at(-1)).toMatchObject({ rev: 2, count: 2, state: 'kept' });
    expect(set.left === true || set.on === 1).toBe(true);
    const ms = await arrives(b, 20_000, 'the node on hub B, its new default');
    expect(ms).toBeLessThan(TIMING.confirmMs + 8000);
    await gone(a, 10_000, 'hub A to see the node leave');
    expect(await okOwn<Hubs>(b, 'device_hubs_get', { device: ALIAS })).toMatchObject({ hubs: [{ host: HUB_B }, { host: HUB_A }], rev: 2, on: 0, trial: false });
    expect((await okOwn<DeviceGet>(a, 'device_get', { device: ALIAS })).hubs).toMatchObject({ rev: 2 });
  }, 60_000);

  it('a list none of whose hubs answers is dropped after its trial, for the list the board had', async () => {
    const set = await okOwn<Hubs>(b, 'device_hubs_set', { device: ALIAS, hub: ['nowhere.test'] });
    expect(set).toMatchObject({ rev: 3, left: true });
    expect(set.warnings!.join(' ')).toContain('this hub');
    expect(node.of('hubs').at(-1)).toMatchObject({ rev: 3, count: 1, state: 'trial' });
    await gone(b, 5000, 'the node to leave hub B for the list on trial');
    const ms = await arrives(b, 20_000, 'the node back on hub B after the trial');
    expect(ms).toBeLessThan(TIMING.trialMs + 8000);
    expect(node.of('hubs').at(-1)).toMatchObject({ rev: 2, count: 2, state: 'reverted' });
    // The registry here said rev 3; the board says what it holds, and the row follows it.
    expect((await okOwn<DeviceGet>(b, 'device_get', { device: ALIAS })).hubs).toMatchObject({ rev: 3 });
    expect(await okOwn<Hubs>(b, 'device_hubs_get', { device: ALIAS })).toMatchObject({ hubs: [{ host: HUB_B }, { host: HUB_A }], rev: 2, on: 0, trial: false });
    expect((await okOwn<DeviceGet>(b, 'device_get', { device: ALIAS })).hubs).toMatchObject({ rev: 2, hubs: [{ host: HUB_B }, { host: HUB_A }] });
  }, 60_000);

  it('taking the list away is the provisioned hub again, with a rev no older list can undo', async () => {
    const none = await okOwn<Hubs>(b, 'device_hubs_set', { device: ALIAS, none: true });
    // The next rev above the one the board holds (2: the list of rev 3 was dropped, and the row followed the board).
    expect(none).toMatchObject({ hubs: [], rev: 3, left: true });
    await arrives(a, 20_000, 'the node on hub A, the hub it was provisioned with');
    expect(node.of('hubs').at(-1)).toMatchObject({ rev: 3, count: 0, state: 'confirmed' });
    expect(await okOwn<Hubs>(a, 'device_hubs_get', { device: ALIAS })).toMatchObject({ hubs: [], rev: 3, on: null, trial: false });
    expect((await okOwn<DeviceGet>(a, 'device_get', { device: ALIAS })).hubs).toMatchObject({ rev: 3, hubs: [] });
    // The node refuses an older rev itself (a push from a hub that missed the newer ones): fr.node.hubs_set EXPIRED.
    const stale = await callOwn(a, 'command_send', { selector: ALIAS, command: 'node.hubs_set', args: { hubs: [{ host: HUB_B, ip: '' }], rev: 2 } });
    expect(JSON.stringify(stale)).toMatch(/EXPIRED|expired/);
    expect(await okOwn<Hubs>(a, 'device_hubs_get', { device: ALIAS })).toMatchObject({ hubs: [], rev: 3 });
  }, 60_000);
});
