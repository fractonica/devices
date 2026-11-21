// The hubs' link, step 2.2 (design multi-hub-m2 §7 "passing an op on"), end to end on loopback: four real hub
// processes (real-hub.ts: ephemeral ports, their own FR_HOME, the link on 127.0.0.1) and the C++ fr_net_node
// (cpp-node.ts). "Reach a board that is on hub A through hub B":
//   - an op for a board on the other hub runs there and answers as if it were local, with `at`;
//   - device_list shows a board a peer holds as online with `at`;
//   - a selector that spans two hubs: command_send is split and merged, logs_read is refused naming where each board
//     is, a wait covers the network (step 2.4), deploy is refused as this hub's own;
//   - a rename's tag and a hub list changed at the holder are in every hub's row (the registry is replicated, step 2.3);
//   - `X-Fr-At` (fr --at): another hub, this hub, an unknown name, a hub on another registry hash;
//   - two hubs on different registry hashes keep presence and refuse `call`;
//   - the board moved between the resolve and the call: DEVICE_OFFLINE with `at`, one more try for a read op, none for
//     another; with three hubs nothing is passed on twice;
//   - a job passed on: get, wait, logs, cancel, the other hub's list, a job id asked of a hub that never saw it, and the
//     calling hub restarting while the job runs;
//   - a recording pulled to the path the caller named; a WAV of the caller's machine played at the other hub;
//   - an update of a board on hub B from a build only hub A has;
//   - two boards on two hubs in one op are refused;
//   - the peer goes away mid-op: an error naming the hub, retryable only for a read op;
//   - the network key and a recording's bytes are in nothing a hub printed.
// peers.test.ts has the pieces without a hub process (calls, data channels, a 50 MB file under the heartbeat, a
// transfer cut mid-way). `node tools/host-test.mjs` builds fr_net_node; without it this file skips.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AT_HEADER, type Job, REGISTRY_HASH, type Result } from '@fractonica/protocol';

import { readWav } from '../src/audio/wav.ts';
import { sine } from './audio-util.ts';
import { BIN, CppBoard, CppNode, makeImage } from './cpp-node.ts';
import { type RealHub, startRealHub } from './real-hub.ts';

const HAS_BIN = existsSync(BIN) && readFileSync(BIN).includes('--hub-map') && readFileSync(BIN).includes('--audio-in');
const MIC = { mac: 'aabbcc0f0e01', alias: 'mic-b' };
const PAD = { mac: 'aabbcc0f0e02', alias: 'pad-a' };
const SOLO = { mac: 'aabbcc0f0e03', alias: 'pad-d' };
const UPD = { mac: 'aabbcc0f0e04', alias: 'upd-b' };
const OTHER_HASH = '0123456789ab';
/** The name the microphone board knows hub B by (the node resolves no other name, and dials nothing for one). */
const HUB_B = 'hub-b.test';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PeerRow {
  name: string;
  reachable: boolean;
  registry_hash: string | null;
  boards: number | null;
}
interface DeviceView {
  device_id: string;
  alias: string;
  presence: string;
  presence_reason?: string;
  at: string | null;
  tags: string[];
  hubs?: { rev: number; hubs: { host: string }[] } | null;
  hub_now?: { here: boolean; at: string | null };
}
interface Row {
  addr: number;
  net: number;
  alias_rev: number;
}
interface Outcome {
  device: string;
  alias: string;
  status: string;
  at?: string;
  error?: string;
}

/** One op call, with `at` as the X-Fr-At header: the whole envelope. */
async function call<T = unknown>(h: RealHub, op: string, input: Record<string, unknown> = {}, at?: string, timeoutMs = 60_000): Promise<Result<T>> {
  const r = await fetch(`${h.url}/api/v1/op/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fr-client': 'cli', ...(at ? { [AT_HEADER]: at } : {}) },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await r.json()) as Result<T>;
}

async function ok<T = unknown>(h: RealHub, op: string, input: Record<string, unknown> = {}, at?: string): Promise<Result<T> & { data: T }> {
  const r = await call<T>(h, op, input, at);
  if (!r.ok) {
    throw new Error(`${op}: ${JSON.stringify(r.error)}`);
  }
  return r as Result<T> & { data: T };
}

/** Waits until `h` sees every hub named reachable. */
async function linked(h: RealHub, names: string[], ms = 20_000): Promise<PeerRow[]> {
  const t0 = performance.now();
  for (;;) {
    const r = await h.api.call<{ peers: PeerRow[] }>('hub_peers');
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

/** Waits until `h`'s own list shows the board at `want`. */
async function listedAt(h: RealHub, alias: string, want: string | null, ms = 20_000): Promise<void> {
  const t0 = performance.now();
  for (;;) {
    const r = await h.api.call<{ devices: DeviceView[] }>('device_list', {});
    const row = r.ok ? r.data!.devices.find((d) => d.alias === alias) : undefined;
    if (row && row.at === want && (want === null || row.presence === 'online')) {
      return;
    }
    if (performance.now() - t0 > ms) {
      throw new Error(`timed out waiting for ${alias} at ${String(want)}: ${JSON.stringify(row ?? r.error)}`);
    }
    await sleep(50);
  }
}

/** Hub `h`'s own row of the board (asked by its own name), once it is there and `when` holds: rows arrive by replication. */
async function rowAt(h: RealHub, name: string, alias: string, when: (row: DeviceView) => boolean = () => true, ms = 15_000): Promise<DeviceView> {
  const t0 = performance.now();
  for (;;) {
    const r = await call<DeviceView>(h, 'device_get', { device: alias }, name);
    if (r.ok && when(r.data!)) {
      return r.data!;
    }
    if (performance.now() - t0 > ms) {
      throw new Error(`timed out waiting for ${alias} at ${name}: ${JSON.stringify(r.ok ? r.data : r.error)}`);
    }
    await sleep(50);
  }
}

async function jobEnds(h: RealHub, jobId: string, ms = 60_000): Promise<Result<Job> & { data: Job }> {
  const t0 = performance.now();
  for (;;) {
    const r = await ok<Job>(h, 'job_wait', { job_id: jobId, timeout_s: 5 });
    if (['completed', 'failed', 'cancelled'].includes(r.data.status)) {
      return r;
    }
    if (performance.now() - t0 > ms) {
      throw new Error(`job ${jobId} still ${r.data.status}`);
    }
  }
}

const printed = (h: RealHub) => JSON.stringify(h.lines) + h.stderr();
const peerCalls = (h: RealHub) => h.lines.filter((l) => l.event === 'peer_call') as { op: string; from: string; mode: string; ok: boolean; code?: string }[];

/** The files of a tree, by path. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of existsSync(d) ? readdirSync(d, { withFileTypes: true }) : []) {
      if (e.isDirectory()) {
        walk(join(d, e.name));
      } else {
        out.push(join(d, e.name));
      }
    }
  };
  walk(dir);
  return out;
}

function wav(file: string, seconds: number, hz: number): void {
  const rate = 16000;
  const s = sine(rate * seconds, hz, rate);
  const data = Buffer.alloc(s.length * 2);
  s.forEach((v, i) => data.writeInt16LE(v, i * 2));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([head, data]));
}

describe.skipIf(!HAS_BIN)("the hubs' link: an op runs where the board is (design multi-hub-m2 step 2.2)", () => {
  let a: RealHub;
  let b: RealHub;
  let c: RealHub;
  let d: RealHub;
  let mic: CppNode;
  let pad: CppNode;
  let solo: CppNode;
  let upd: CppBoard;
  let scratch = '';
  let speaker = '';
  let image: { fw_id: string; image: Buffer };
  const rows = new Map<string, Row>();

  const nodeArgs = (h: RealHub, dev: { mac: string; alias: string }) => {
    const row = rows.get(dev.mac)!;
    return ['--hub-tcp', String(h.node.tcp), '--hub-udp', String(h.node.udp), '--hub-http', String(h.node.http), '--mac', dev.mac, '--addr', String(row.addr), '--net', String(row.net), '--alias', dev.alias, '--alias-rev', String(row.alias_rev), '--epoch', '3', '--hb-ms', '500'];
  };

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'fr-pass-'));
    speaker = join(scratch, 'spk.raw');
    image = makeImage(join(scratch, 'new.bin'), { version: '0.2.0', size: 300_000, seed: 22 });
    [a, b, c, d] = await Promise.all([
      // Only hub A has the build.
      startRealHub({ images: [{ image: image.image, profile: 'c6-pad', buildType: 'debug' }] }),
      startRealHub(),
      // Hub C takes hub B for the pad's holder whatever the peers say: the board "moved between the resolve and the call".
      startRealHub({ env: { FR_TEST_PEER_HOLDER: `${PAD.mac}=hub-b` } }),
      // Hub D says another registry hash, as a hub that was not updated with the others.
      startRealHub({ env: { FR_TEST_PEER_REGISTRY_HASH: OTHER_HASH } }),
    ]);
    for (const [h, name] of [[a, 'hub-a'], [b, 'hub-b'], [c, 'hub-c'], [d, 'hub-d']] as const) {
      await h.api.ok('hub_name_set', { name });
    }
    await a.api.ok('network_set', { ssid: 'lab-wifi' });
    for (const h of [b, c, d]) {
      await h.api.ok('network_join', { hub: a.url });
    }
    await linked(a, ['hub-b', 'hub-c', 'hub-d']);
    await linked(b, ['hub-a', 'hub-c', 'hub-d']);
    await linked(c, ['hub-a', 'hub-b']);
    for (const dev of [MIC, PAD, SOLO, UPD]) {
      rows.set(dev.mac, await a.api.ok<Row>('device_enroll', { device_id: dev.mac, chip: 'esp32c6', profile: 'c6-pad', alias: dev.alias }));
      await a.api.ok('device_update', { device: dev.alias, tag: '-new' });
    }
    // The registry is one (step 2.3): the rows reach the other hubs by themselves, hub D on another op registry
    // hash included (the registry's version is its own).
    for (const [h, name] of [[b, 'hub-b'], [c, 'hub-c'], [d, 'hub-d']] as const) {
      for (const dev of [MIC, PAD, SOLO, UPD]) {
        await rowAt(h, name, dev.alias, (row) => row.tags.length === 0);
      }
    }
    // The board knows hub B by a name (its hub list names hubs); the node maps it to hub B's loopback ports.
    mic = new CppNode([...nodeArgs(b, MIC), '--hub-name', HUB_B, '--audio-in', 'sine:1000', '--audio-out', speaker]);
    pad = new CppNode(nodeArgs(a, PAD));
    solo = new CppNode(nodeArgs(d, SOLO));
    upd = new CppBoard([...nodeArgs(b, UPD), '--ota-dir', mkdtempSync(join(scratch, 'ota-')), '--version', '0.1.0', '--health-ms', '1500']);
    await listedAt(a, MIC.alias, 'hub-b');
    await listedAt(a, UPD.alias, 'hub-b');
    await listedAt(b, PAD.alias, 'hub-a');
    await listedAt(a, SOLO.alias, 'hub-d');
    await listedAt(c, MIC.alias, 'hub-b');
  }, 180_000);

  afterAll(async () => {
    try {
      // A hub this file froze must run again to take its SIGTERM.
      process.kill(b.pid()!, 'SIGCONT');
    } catch {
      // gone already, or never started
    }
    mic?.stop();
    pad?.stop();
    solo?.stop();
    upd?.stop();
    await Promise.all([a?.stop(), b?.stop(), c?.stop(), d?.stop()]);
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);

  it('an op for a board on the other hub runs there, and the answer says where', async () => {
    // Asked at hub A, answered by hub B, which holds the board: its presence, its session, its cursor.
    const got = await ok<DeviceView>(a, 'device_get', { device: MIC.alias });
    expect(got.at).toBe('hub-b');
    expect(got.data).toMatchObject({ device_id: MIC.mac, presence: 'online', at: 'hub-b', hub_now: { here: true, at: 'hub-b' } });
    expect(got.cursor).toMatch(/^c:\d+\.\d+$/);
    const own = await ok<{ head: string }>(b, 'hub_status');
    expect(got.cursor.split('.')[0]).toBe(own.data.head.split('.')[0]); // hub B's run, not hub A's
    // A capability of the board, through the link: the microphone's level.
    const level = await ok<{ dbfs: number; device: string }>(a, 'audio_level', { device: MIC.alias, timeout_s: 5 });
    expect(level.at).toBe('hub-b');
    expect(level.data.device).toBe(MIC.mac);
    expect(level.data.dbfs).toBeLessThanOrEqual(0);
    expect(level.data.dbfs).toBeGreaterThanOrEqual(-120);
    // The other way round: a board on hub A through hub B.
    const padAtB = await ok<DeviceView>(b, 'device_get', { device: PAD.alias });
    expect(padAtB.at).toBe('hub-a');
    expect(padAtB.data).toMatchObject({ presence: 'online', at: 'hub-a' });
    // A board this hub holds itself is answered here: no `at` on the envelope.
    const here = await ok<DeviceView>(a, 'device_get', { device: PAD.alias });
    expect(here.at).toBeUndefined();
    expect(here.data).toMatchObject({ presence: 'online', at: 'hub-a', hub_now: { here: true } });
    // The hub that ran it logged the call by its op and its caller, never its input.
    const seen = peerCalls(b).filter((l) => l.op === 'audio_level');
    expect(seen).toEqual([expect.objectContaining({ from: 'hub-a', mode: 'holder', ok: true })]);
    expect(JSON.stringify(seen)).not.toContain(MIC.mac);
  }, 60_000);

  it('device_list shows a board a peer holds as online, with `at`, and `online` selects it', async () => {
    const list = await ok<{ devices: DeviceView[] }>(a, 'device_list', {});
    expect(list.at).toBeUndefined(); // the list is this hub's own
    expect(list.data.devices.map((x) => [x.alias, x.presence, x.at]).sort()).toEqual([
      [MIC.alias, 'online', 'hub-b'],
      [PAD.alias, 'online', 'hub-a'],
      [SOLO.alias, 'online', 'hub-d'],
      [UPD.alias, 'online', 'hub-b'],
    ]);
    const online = await ok<{ devices: DeviceView[] }>(c, 'device_list', { selector: 'online' });
    expect(online.data.devices.map((x) => x.alias).sort()).toEqual([MIC.alias, PAD.alias, SOLO.alias, UPD.alias]);
  }, 30_000);

  it('a selector that spans two hubs: command_send is split and merged; what needs one hub says where each board is', async () => {
    const micRan = mic.of('dispatch').length;
    const padRan = pad.of('dispatch').length;
    const sent = await ok<{ results: Outcome[] }>(a, 'command_send', { selector: `${MIC.alias},${PAD.alias}`, command: 'node.identify', args: { ms: 200 } });
    expect(sent.data.results.map((r) => [r.alias, r.status, r.at])).toEqual([
      [MIC.alias, 'ok', 'hub-b'],
      [PAD.alias, 'ok', 'hub-a'],
    ]);
    expect(mic.of('dispatch').length).toBe(micRan + 1);
    expect(pad.of('dispatch').length).toBe(padRan + 1);
    // All of one hub: passed whole, and the answer is that hub's.
    const one = await ok<{ results: Outcome[] }>(a, 'command_send', { selector: `${MIC.alias},${UPD.alias}`, command: 'node.identify', args: { ms: 200 } });
    expect(one.at).toBe('hub-b');
    expect(one.data.results.map((r) => [r.alias, r.status])).toEqual([[MIC.alias, 'ok'], [UPD.alias, 'ok']]);
    // logs_read answers one page of one hub's cursor: spread over two hubs it is refused, naming where each board is.
    const logs = await call(a, 'logs_read', { selector: `${MIC.alias},${PAD.alias}` });
    expect(logs.error).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(logs.error!.message).toContain(`${MIC.alias} is at hub hub-b`);
    expect(logs.error!.message).toContain(`${PAD.alias} is at hub hub-a`);
    expect(logs.error!.hint).toContain('fr --at hub-b logs');
    // ... and for the boards of one hub it is that hub's page.
    const page = await ok<{ lines: unknown[]; next_cursor: string }>(a, 'logs_read', { selector: MIC.alias, max_lines: 5 });
    expect(page.at).toBe('hub-b');
    const events = await ok<{ events: { device: string }[] }>(a, 'events_read', { selector: MIC.alias, max_events: 50 });
    expect(events.at).toBe('hub-b');
    expect(events.data.events.some((e) => e.device === MIC.mac)).toBe(true);
    // `all` (and no selector) to a reader of this hub's own stores is no filter: this hub's log and events, as before.
    expect((await ok(a, 'logs_read', { selector: 'all', max_lines: 5 })).at).toBeUndefined();
    expect((await ok(a, 'events_read', { selector: 'all', max_events: 5 })).at).toBeUndefined();
    expect((await ok(a, 'events_read', { max_events: 5 })).at).toBeUndefined();
    // A wait for a board at another hub runs here since step 2.4, on the network's presence and what that hub relays
    // (interop-live.test.ts and peers-live.test.ts have the waits); named, it still runs on that hub.
    const wait = await ok<{ devices: { alias: string; presence: string; at?: string }[] }>(a, 'wait_for_device', { selector: MIC.alias, state: 'online', timeout_s: 5 });
    expect(wait.at).toBeUndefined();
    expect(wait.data.devices).toEqual([expect.objectContaining({ alias: MIC.alias, presence: 'online', at: 'hub-b' })]);
    expect((await ok(a, 'wait_for_device', { selector: MIC.alias, state: 'online', timeout_s: 2 }, 'hub-b')).at).toBe('hub-b');
    // deploy builds here and updates over this hub's own links.
    const dep = await call(a, 'deploy', { selector: MIC.alias, source_dir: scratch, dry_run: true });
    expect(dep.error).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(dep.error!.hint).toContain('fr ota');
  }, 60_000);

  it('a row changed at the holder is changed in the calling hub\'s copy too (a tag, the hub list)', async () => {
    const tagged = await ok<DeviceView>(a, 'device_update', { device: MIC.alias, tag: 'studio' });
    expect(tagged.at).toBe('hub-b');
    expect(tagged.data.tags).toContain('studio');
    // Each hub's own row, asked of that hub by name.
    expect((await ok<DeviceView>(a, 'device_get', { device: MIC.alias }, 'hub-a')).data.tags).toContain('studio');
    expect((await ok<DeviceView>(a, 'device_get', { device: MIC.alias }, 'hub-b')).data.tags).toContain('studio');
    // A hub that took no part in the call has it too (step 2.3: the registry is replicated), and so has hub D, which
    // runs another op registry hash and is passed no op: the registry's version is its own.
    expect((await rowAt(c, 'hub-c', MIC.alias, (row) => row.tags.includes('studio'))).tags).toContain('studio');
    expect((await rowAt(d, 'hub-d', MIC.alias, (row) => row.tags.includes('studio'))).tags).toContain('studio');
    // The hub list is set and read over the air, at the holder.
    const set = await ok<{ rev: number; hubs: { host: string }[]; left: boolean }>(a, 'device_hubs_set', { device: MIC.alias, hub: [HUB_B] });
    expect(set.at).toBe('hub-b');
    expect(set.data).toMatchObject({ rev: 1, hubs: [{ host: HUB_B }], left: false });
    const read = await ok<{ rev: number }>(a, 'device_hubs_get', { device: MIC.alias });
    expect(read.at).toBe('hub-b');
    expect(read.data.rev).toBe(1);
    expect((await rowAt(a, 'hub-a', MIC.alias, (row) => row.hubs?.rev === 1)).hubs).toMatchObject({ rev: 1, hubs: [{ host: HUB_B }] });
    expect((await rowAt(c, 'hub-c', MIC.alias, (row) => row.hubs?.rev === 1)).hubs).toMatchObject({ rev: 1, hubs: [{ host: HUB_B }] });
    expect((await ok<DeviceView>(a, 'device_get', { device: MIC.alias })).data).toMatchObject({ presence: 'online', at: 'hub-b' });
  }, 60_000);

  it('naming a hub (X-Fr-At): another hub, this hub, an unknown name', async () => {
    const st = await ok<{ hub: { name: string }; pid: number }>(a, 'hub_status', {}, 'hub-b');
    expect(st.at).toBe('hub-b');
    expect(st.data.hub.name).toBe('hub-b');
    expect(st.data.pid).toBe(b.pid());
    const ports = await ok<{ ports: unknown[] }>(a, 'port_list', {}, 'hub-b');
    expect(ports.at).toBe('hub-b');
    expect(ports.data.ports).toEqual([]);
    // This hub's own name: here, with nothing passed on. A device op named onto a hub that does not hold the board
    // runs there all the same: that hub's own view.
    const self = await ok<{ hub: { name: string } }>(a, 'hub_status', {}, 'hub-a');
    expect(self.at).toBeUndefined();
    expect(self.data.hub.name).toBe('hub-a');
    const ownView = await ok<DeviceView>(a, 'device_get', { device: MIC.alias }, 'hub-a');
    expect(ownView.data).toMatchObject({ presence: 'online', at: 'hub-b', hub_now: { here: false, at: 'hub-b' } });
    const unknown = await call(a, 'hub_status', {}, 'hub-x');
    expect(unknown.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(unknown.error!.message).toContain('no hub named hub-x in this network (its hubs: hub-a, hub-b, hub-c, hub-d)');
    // An op's own `at` input is another thing: time_now takes an instant there, and the header names the hub.
    const time = await ok<Record<string, unknown>>(a, 'time_now', { at: '2026-11-21T00:00:00Z' }, 'hub-b');
    expect(time.at).toBe('hub-b');
  }, 30_000);

  it('two hubs on different registry hashes keep presence and refuse `call`', async () => {
    // Who is where crosses the link whatever each hub runs ...
    const peers = (await ok<{ peers: PeerRow[] }>(a, 'hub_peers')).data.peers;
    expect(peers.find((p) => p.name === 'hub-d')).toMatchObject({ reachable: true, registry_hash: OTHER_HASH, boards: 1 });
    expect(peers.find((p) => p.name === 'hub-b')).toMatchObject({ reachable: true, registry_hash: REGISTRY_HASH });
    const row = (await ok<{ devices: DeviceView[] }>(a, 'device_list', { selector: SOLO.alias })).data.devices[0];
    expect(row).toMatchObject({ presence: 'online', at: 'hub-d' });
    // ... but an op is not passed to a hub that may read it differently: refused here, naming the hub, nothing sent.
    const before = peerCalls(d).length;
    const get = await call(a, 'device_get', { device: SOLO.alias });
    expect(get.error).toMatchObject({ code: 'HUB_VERSION_MISMATCH', retryable: false, details: { hub: 'hub-d', registry_hash: OTHER_HASH, this_hub: REGISTRY_HASH } });
    expect(get.error!.message).toContain('hub hub-d runs another version');
    const named = await call(a, 'hub_status', {}, 'hub-d');
    expect(named.error).toMatchObject({ code: 'HUB_VERSION_MISMATCH' });
    // The other way: hub D does not pass to hub A either.
    const back = await call(d, 'device_get', { device: PAD.alias });
    expect(back.error).toMatchObject({ code: 'HUB_VERSION_MISMATCH', details: { hub: 'hub-a' } });
    // In a split, that hub's rows say why, and the others' are answered.
    const sent = await ok<{ results: Outcome[] }>(a, 'command_send', { selector: `${PAD.alias},${SOLO.alias}`, command: 'node.identify', args: { ms: 100 } });
    expect(sent.data.results.map((r) => [r.alias, r.status, r.at])).toEqual([[PAD.alias, 'ok', 'hub-a'], [SOLO.alias, 'failed', 'hub-d']]);
    expect(sent.data.results[1].error).toContain('another version');
    expect(peerCalls(d).length).toBe(before);
    expect(peerCalls(a).filter((l) => l.from === 'hub-d')).toEqual([]);
  }, 30_000);

  it('the board moved between the resolve and the call: DEVICE_OFFLINE with `at`, one more try for a read op, none for another; nothing is passed on twice', async () => {
    // Hub C takes hub B for the pad's holder (FR_TEST_PEER_HOLDER); the pad is at hub A.
    const beforeA = peerCalls(a).length;
    const beforeB = peerCalls(b).length;
    const padRan = pad.of('dispatch').length;
    const get = await ok<DeviceView>(c, 'device_get', { device: PAD.alias });
    // Hub B answered DEVICE_OFFLINE with `at` and passed nothing on; hub C tried once more, at hub A.
    expect(get.at).toBe('hub-a');
    expect(get.data).toMatchObject({ presence: 'online', at: 'hub-a', hub_now: { here: true } });
    expect(peerCalls(b).slice(beforeB)).toEqual([expect.objectContaining({ op: 'device_get', from: 'hub-c', mode: 'holder', ok: false, code: 'DEVICE_OFFLINE' })]);
    expect(peerCalls(a).slice(beforeA)).toEqual([expect.objectContaining({ op: 'device_get', from: 'hub-c', mode: 'holder', ok: true })]);
    // An op that is not idempotent is not tried again: the caller hears where the board is.
    const sync = await call(c, 'clock_sync', { device: PAD.alias });
    expect(sync.error).toMatchObject({ code: 'DEVICE_OFFLINE', details: { device_id: PAD.mac, moved: true, at: 'hub-a' } });
    expect(sync.error!.message).toContain(`${PAD.alias} has no session with hub hub-b: it is at hub hub-a now`);
    expect(sync.error!.message).toContain('not tried again');
    expect(sync.at).toBe('hub-b');
    // Hub B took two calls from hub C and made none; hub A took one, from hub C; the board ran nothing.
    expect(peerCalls(b).slice(beforeB).map((l) => [l.op, l.from, l.ok])).toEqual([['device_get', 'hub-c', false], ['clock_sync', 'hub-c', false]]);
    expect(peerCalls(a).slice(beforeA).map((l) => [l.op, l.from])).toEqual([['device_get', 'hub-c']]);
    expect(peerCalls(a).slice(beforeA).some((l) => l.from === 'hub-b')).toBe(false);
    expect(peerCalls(a).some((l) => l.op === 'clock_sync')).toBe(false);
    expect(pad.of('dispatch').length).toBe(padRan);
  }, 30_000);

  it('a job passed on: the recording is pulled to the path the caller named; get, logs, wait, cancel and the other hub\'s list', async () => {
    const out = join(a.home, 'audio', 'take.wav');
    const started = await ok<Job>(a, 'audio_record', { device: MIC.alias, seconds: 3, out, sample_hz: 16000, wait_s: 0 });
    expect(started.at).toBe('hub-b');
    expect(started.data).toMatchObject({ kind: 'audio', at: 'hub-b', origin: 'cli' });
    expect(['queued', 'working']).toContain(started.data.status);
    const id = started.data.job_id;
    // The job is hub B's; hub A answers for it.
    expect((await call(b, 'job_get', { job_id: id }, 'hub-b')).ok).toBe(true);
    const got = await ok<Job>(a, 'job_get', { job_id: id });
    expect(got.at).toBe('hub-b');
    expect(got.data).toMatchObject({ job_id: id, at: 'hub-b' });
    expect(existsSync(out)).toBe(false);
    const done = await jobEnds(a, id);
    expect(done.data).toMatchObject({ status: 'completed', at: 'hub-b' });
    expect(done.warnings).toBeUndefined();
    // The result reads as if the op had run here: the path is this machine's, and the file is there, whole.
    const res = done.data.result as { path: string; samples: number; sample_hz: number; reason: string };
    expect(res).toMatchObject({ path: out, sample_hz: 16000, reason: 'done' });
    expect(Math.abs(res.samples - 48_000)).toBeLessThanOrEqual(1);
    const w = readWav(out);
    expect(w).toMatchObject({ sampleHz: 16000, channels: 1, bits: 16 });
    expect(Math.abs(w.frames - 48_000)).toBeLessThanOrEqual(1);
    // Nothing else was left beside it, and hub B's spool is gone.
    expect(readdirSync(join(a.home, 'audio'))).toEqual(['take.wav']);
    expect(tree(join(b.home, 'storage', '.peers'))).toEqual([]);
    // Asked again, the job says the same (the file is not pulled twice).
    const again = await ok<Job>(a, 'job_get', { job_id: id });
    expect((again.data.result as { path: string }).path).toBe(out);
    const logs = await ok<{ lines: { text: string }[] }>(a, 'job_logs', { job_id: id });
    expect(logs.at).toBe('hub-b');
    expect(logs.data.lines.length).toBeGreaterThan(0);
    // A hub that never saw the job asks the others.
    const viaC = await ok<Job>(c, 'job_get', { job_id: id });
    expect(viaC.at).toBe('hub-b');
    expect(viaC.data.status).toBe('completed');
    expect((await call(c, 'job_get', { job_id: 'j_000000000000' })).error).toMatchObject({ code: 'NOT_FOUND' });
    // Cancel through the link.
    const long = await ok<Job>(a, 'audio_record', { device: MIC.alias, seconds: 60, out: join(a.home, 'audio', 'long.wav'), sample_hz: 16000, wait_s: 0 });
    await sleep(500);
    const cancelled = await ok<Job>(a, 'job_cancel', { job_id: long.data.job_id });
    expect(cancelled.at).toBe('hub-b');
    expect((await jobEnds(a, long.data.job_id)).data.status).toBe('cancelled');
    expect(existsSync(join(a.home, 'audio', 'long.wav'))).toBe(false);
    // job_list is this hub's own; another hub's is asked of it by name.
    const mine = await ok<{ jobs: Job[] }>(a, 'job_list', {});
    expect(mine.data.jobs.some((j) => j.job_id === id)).toBe(false);
    const theirs = await ok<{ jobs: Job[] }>(a, 'job_list', { limit: 50 }, 'hub-b');
    expect(theirs.at).toBe('hub-b');
    expect(theirs.data.jobs.find((j) => j.job_id === id)).toMatchObject({ status: 'completed', kind: 'audio' });
    // An `out` outside this hub's FR_HOME is refused here, as when the op runs here.
    const outside = await call(a, 'audio_record', { device: MIC.alias, seconds: 1, out: join(scratch, 'x.wav'), wait_s: 0 });
    expect(outside.error).toMatchObject({ code: 'INVALID_ARGS' });
    expect(outside.error!.message).toContain('outside FR_HOME');
  }, 120_000);

  it('a file of the calling machine is fetched by the hub that runs the op (audio_play)', async () => {
    const file = join(scratch, 'a440.wav');
    wav(file, 1, 440);
    const before = existsSync(speaker) ? readFileSync(speaker).length : 0;
    const played = await ok<Job>(a, 'audio_play', { device: MIC.alias, file, wait_s: 30 });
    expect(played.at).toBe('hub-b');
    expect(played.data).toMatchObject({ status: 'completed', at: 'hub-b' });
    // One second of 16 kHz PCM reached the board's speaker.
    expect(readFileSync(speaker).length - before).toBeGreaterThanOrEqual(16_000 * 2 * 0.8);
    const missing = await call(a, 'audio_play', { device: MIC.alias, file: join(scratch, 'none.wav'), wait_s: 5 });
    expect(missing.error).toMatchObject({ code: 'NOT_FOUND' });
  }, 60_000);

  it('the calling hub restarts while the job runs: it still answers for the job, and the file arrives', async () => {
    const out = join(a.home, 'audio', 'across.wav');
    const started = await ok<Job>(a, 'audio_record', { device: MIC.alias, seconds: 4, out, sample_hz: 16000, wait_s: 0 });
    const id = started.data.job_id;
    await a.restart();
    await linked(a, ['hub-b']);
    const got = await ok<Job>(a, 'job_get', { job_id: id });
    expect(got.at).toBe('hub-b');
    const done = await jobEnds(a, id);
    expect(done.data.status).toBe('completed');
    expect((done.data.result as { path: string }).path).toBe(out);
    expect(Math.abs(readWav(out).frames - 64_000)).toBeLessThanOrEqual(1);
    await listedAt(a, PAD.alias, 'hub-a', 30_000); // its board is back with it
  }, 120_000);

  it('an update of a board on hub B from a build only hub A has', async () => {
    const buildId = a.images[0].buildId;
    expect((await ok<{ artifacts: { build_id: string }[] }>(a, 'artifact_list', {}, 'hub-b')).data.artifacts).toEqual([]);
    const plan = await ok<{ devices: { alias: string; action: string }[] }>(a, 'ota_deploy', { selector: UPD.alias, dry_run: true });
    expect(plan.at).toBe('hub-b');
    // The dry run already made the build hub B's own: the manifest and the image, the image under the hash it is named by.
    const atB = (await ok<{ artifacts: { build_id: string; fw_id: string }[] }>(a, 'artifact_list', {}, 'hub-b')).data.artifacts;
    expect(atB).toEqual([expect.objectContaining({ build_id: buildId, fw_id: image.fw_id })]);
    expect(b.lines.some((l) => l.event === 'peer_artifact_fetched' && l.build_id === buildId && l.from === 'hub-a' && l.bytes === image.image.length)).toBe(true);
    const job = await ok<Job>(a, 'ota_deploy', { selector: UPD.alias, wait_s: 90 });
    expect(job.at).toBe('hub-b');
    const done = ['completed', 'failed', 'cancelled'].includes(job.data.status) ? job : await jobEnds(a, job.data.job_id, 120_000);
    expect(done.data.error).toBeUndefined();
    expect(done.data).toMatchObject({ status: 'completed', at: 'hub-b' });
    // The board pulled the image from hub B's own node HTTP port and runs it.
    expect(upd.boots.length).toBeGreaterThanOrEqual(2);
    expect(upd.node.of('started')[0]).toMatchObject({ fw: image.fw_id, version: '0.2.0' });
    expect((await ok<DeviceView & { fw_id: string }>(a, 'device_get', { device: UPD.alias })).data.fw_id.slice(0, 16)).toBe(image.fw_id.slice(0, 16));
    expect(peerCalls(b).filter((l) => l.op === 'ota_deploy').length).toBe(2);
    // An unknown build is unknown at both: hub B asked hub A, which has none either.
    const none = await call(a, 'ota_deploy', { selector: UPD.alias, build: 'node/c6-pad/debug/000000000000', dry_run: true });
    expect(none.error).toMatchObject({ code: 'NOT_FOUND' });
  }, 180_000);

  it('an op over two boards on two hubs is refused: both must be on one hub', async () => {
    const r = await call(a, 'binding_set', { from: `${MIC.alias}.boot.click`, to: `${PAD.alias}.status.toggle` });
    expect(r.error).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(r.error!.message).toContain(`both boards must be on one hub (${MIC.alias} is at hub hub-b, ${PAD.alias} is at hub hub-a)`);
    const probe = await call(b, 'latency_probe', { from: MIC.alias, to: PAD.alias, count: 1, wait_s: 0 });
    expect(probe.error).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(probe.error!.message).toContain('both boards must be on one hub');
  }, 30_000);

  it('the peer goes away mid-op: the caller hears which hub, and only a read op is marked retryable', async () => {
    // Two ops in flight at hub B, asked through hub A: a wait (read-only) and a recording (it changes things).
    const waiting = call(a, 'wait_for_event', { types: 'never.happens', since: (await ok(b, 'hub_status')).cursor, timeout_s: 30 }, 'hub-b');
    const recording = call(a, 'audio_record', { device: MIC.alias, seconds: 20, out: join(a.home, 'audio', 'cut.wav'), wait_s: 30 });
    await sleep(1500);
    // Frozen, not stopped: a hub that is told to stop cancels its jobs and answers first; one that falls silent answers nothing.
    const pid = b.pid()!;
    process.kill(pid, 'SIGSTOP');
    try {
      const [w, r] = await Promise.all([waiting, recording]);
      expect(w.error).toMatchObject({ code: 'HUB_UNREACHABLE', retryable: true, details: { hub: 'hub-b', op: 'wait_for_event' } });
      expect(w.error!.message).toMatch(/hub hub-b is not reachable: it went away while the op ran \(silent for \d\.\d s\)/);
      expect(r.error).toMatchObject({ code: 'HUB_UNREACHABLE', retryable: false, details: { hub: 'hub-b', op: 'audio_record' } });
      expect(r.error!.message).toContain('audio_record may have run there');
      expect(existsSync(join(a.home, 'audio', 'cut.wav'))).toBe(false);
      // With the hub away: its boards are `unknown` in the list, an op for one runs here and says so, and naming the hub fails at once.
      const row = (await ok<{ devices: DeviceView[] }>(a, 'device_list', { selector: MIC.alias })).data.devices[0];
      expect(row).toMatchObject({ presence: 'unknown', at: 'hub-b', presence_reason: 'hub hub-b is not reachable' });
      const level = await call(a, 'audio_level', { device: MIC.alias, timeout_s: 2 });
      expect(level.error).toMatchObject({ code: 'DEVICE_OFFLINE' });
      expect(level.at).toBeUndefined();
      const named = await call(a, 'hub_status', {}, 'hub-b');
      expect(named.error).toMatchObject({ code: 'HUB_UNREACHABLE', retryable: true, details: { hub: 'hub-b' } });
    } finally {
      process.kill(pid, 'SIGCONT');
    }
    await linked(a, ['hub-b'], 30_000);
    await listedAt(a, MIC.alias, 'hub-b', 40_000);
    expect((await ok<DeviceView>(a, 'device_get', { device: MIC.alias })).at).toBe('hub-b');
  }, 150_000);

  it('the network key and a recording\'s bytes are in nothing a hub printed', async () => {
    const key = (JSON.parse(readFileSync(join(a.home, 'secrets.json'), 'utf8')) as { network_key: { key: string } }).network_key.key;
    const rawKey = Buffer.from(key, 'hex');
    const take = readFileSync(join(a.home, 'audio', 'take.wav'));
    // A stretch of the recording's samples, as bytes, base64 and hex.
    const part = take.subarray(4096, 4096 + 48);
    for (const h of [a, b, c, d]) {
      const text = printed(h);
      for (const needle of [key, key.toUpperCase(), rawKey.toString('base64'), rawKey.toString('base64url'), part.toString('base64'), part.toString('hex'), part.toString('latin1')]) {
        expect(text.includes(needle)).toBe(false);
      }
      // What a hub printed of a file is its count and size.
      expect(text).not.toContain('RIFF');
    }
    expect(a.lines.some((l) => l.event === 'peer_files_pulled' && l.files === 1 && typeof l.bytes === 'number')).toBe(true);
    // Every op the hubs passed to each other was logged by its name and its caller only.
    for (const l of [...peerCalls(a), ...peerCalls(b), ...peerCalls(c)]) {
      expect(Object.keys(l).sort().filter((k) => !['code'].includes(k))).toEqual(['event', 'from', 'mode', 'ms', 'ok', 'op']);
    }
  }, 30_000);
});
