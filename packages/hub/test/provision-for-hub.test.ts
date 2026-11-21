// A board flashed at one hub for another (spec 06 §6.4 "For another hub"): device_enroll on the hub the board will
// belong to, and device_provision with `for_hub` on the hub that flashes it. Two private hubs in this process: the
// flashing one as provision.test.ts builds it (the real runPytools against a fake sidecar under a temp FR_HOME, a fake
// serial manager), and the target as a real router over the SQLite registry behind the real HTTP server (buildServer,
// the web guard included) on an ephemeral loopback port, which a FakeNode joins over TCP as the flashed board would.
// The Wi-Fi password is a fake secret; the rendered fr_ident is read through the fake sidecar's record of the CSV
// (the secret masked there), and every output of both hubs is searched for it.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ArtifactManifest, CLS, type Enrolled, findOp, FrError, type Job } from '@fractonica/protocol';
import { encodeEnvLine, encodePresenceHello } from '@fractonica/protocol/gen';

import type { HubContext, HubEvent, HubRunOptions } from '../src/context.ts';
import { type Db, HUB_SLOT_KEY, kvSet, nextHubEpoch, openDb } from '../src/db.ts';
import { createEvents, EventStore } from '../src/events/index.ts';
import { runPytools } from '../src/flash.ts';
import { FrameDecoder } from '../src/frames.ts';
import { buildServer } from '../src/http.ts';
import { JobRunner } from '../src/jobs.ts';
import { createLogIngest } from '../src/logs/ingest.ts';
import { LogStore } from '../src/logstore.ts';
import { joinNetwork, writeNetwork } from '../src/network.ts';
import { HANDLERS } from '../src/ops.ts';
import { hubId, setHubName } from '../src/peers/identity.ts';
import { createPeers, type Peers } from '../src/peers/index.ts';
import { newNetworkKey, writeNetworkKey } from '../src/peers/key.ts';
import { replaceMembers } from '../src/peers/members.ts';
import { installPassing } from '../src/peers/passing.ts';
import { createPortPolicy } from '../src/ports/policy.ts';
import { checkDeviceId, enroll } from '../src/registry/enroll.ts';
import { hubIpv4 } from '../src/registry/ident.ts';
import { createRegistry } from '../src/registry/index.ts';
import { type ProvisionDeps, startProvision } from '../src/registry/provision.ts';
import { hubBase, remoteOp } from '../src/registry/remote.ts';
import { provisionOf, setDeviceHubs } from '../src/registry/store.ts';
import { createRouter, type HubRouter } from '../src/router/index.ts';
import { createScaleCounters } from '../src/router/scale.ts';
import { CursorSeq } from '../src/seq.ts';
import { FakeNode, FakeSerial, until } from './fake-node.ts';

const DEV = '1cdbd4000564';
const OTHER = '1cdbd4000777';
const PORT = '/dev/cu.usbmodem1101';
// CSV metacharacters on purpose; TOKEN is what the leak checks look for (it survives any quoting).
const TOKEN = 'fake-secret-5d1c20';
const SECRET = `${TOKEN},"q" #x`;
const LAB_NET = 0x1111;
const HOME_NET = 0x2222;

let home = '';
const savedHome = process.env.FR_HOME;

// The stand-in sidecar of provision.test.ts, cut to what a provisioning asks: probe, nvs_gen (the CSV is recorded with
// the secret masked) and flash.
const FAKE_SIDECAR = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.FR_HOME;
const cfg = JSON.parse(fs.readFileSync(path.join(home, 'fake-sidecar.json'), 'utf8'));
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const req = JSON.parse(input);
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const rec = { cmd: req.cmd };
  const fail = (cfg.fail || {})[req.cmd];
  if (req.cmd === 'probe') {
    if (!fail) emit({ ev: 'result', data: cfg.probe });
  } else if (req.cmd === 'nvs_gen') {
    const csv = fs.readFileSync(req.csv_path, 'utf8');
    rec.has_secret = csv.includes(cfg.secret_csv);
    rec.csv = csv.split(cfg.secret_csv).join('<SECRET>');
    if (!fail) {
      fs.writeFileSync(req.out_path, Buffer.alloc(Number(req.size), 0xff));
      emit({ ev: 'result', data: { out_path: req.out_path, size: Number(req.size) } });
    }
  } else if (req.cmd === 'flash') {
    rec.offsets = req.files.map((f) => f.offset);
    if (!fail) emit({ ev: 'result', data: { chip: 'ESP32-C6', written: req.files } });
  } else if (req.cmd === 'reset') {
    emit({ ev: 'result', data: { mode: 'hard' } });
  }
  if (fail) emit({ ev: 'error', code: fail.code, message: fail.message, stage: req.cmd });
  fs.appendFileSync(path.join(home, 'sidecar-calls.jsonl'), JSON.stringify(rec) + '\\n');
  process.exit(fail ? 1 : 0);
});
`;

interface Call {
  cmd: string;
  has_secret?: boolean;
  csv?: string;
  offsets?: string[];
}

const C6_PROBE = { chip: 'ESP32-C6', description: 'ESP32-C6FH4 (QFN32)', mac: '1c:db:d4:00:05:64', secure_boot: false, flash_encryption: false, flash_size: '4MB' };

function sidecar(cfg: { fail?: Record<string, { code: string; message: string }> } = {}): void {
  writeFileSync(join(home, 'fake-sidecar.json'), JSON.stringify({ probe: C6_PROBE, secret_csv: `"${SECRET.replace(/"/g, '""')}"`, ...cfg }));
  rmSync(join(home, 'sidecar-calls.jsonl'), { force: true });
}

function calls(): Call[] {
  const file = join(home, 'sidecar-calls.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Call) : [];
}

/** The fr_ident CSV the last nvs_gen was given, as `key -> value` (the password masked by the sidecar). */
function identOf(): { fields: Record<string, string>; has_secret: boolean } {
  const gen = calls().findLast((c) => c.cmd === 'nvs_gen')!;
  const fields: Record<string, string> = {};
  for (const line of gen.csv!.trim().split('\n')) {
    const [key, type, , ...value] = line.split(',');
    if (type === 'data') {
      fields[key] = value.join(',');
    }
  }
  return { fields, has_secret: gen.has_secret === true };
}

const cleanups: (() => Promise<void> | void)[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'fr-for-hub-test-'));
  process.env.FR_HOME = home;
  const py = join(home, 'pytools', 'bin', 'python');
  mkdirSync(dirname(py), { recursive: true });
  writeFileSync(py, FAKE_SIDECAR);
  chmodSync(py, 0o755);
});
afterAll(() => {
  if (savedHome === undefined) {
    delete process.env.FR_HOME;
  } else {
    process.env.FR_HOME = savedHome;
  }
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => sidecar());
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

/** A full-plan artifact on the fr-4mb-v1 layout, registered like ingestBuild does. */
function artifact(db: Db, profile = 'c6-pad'): string {
  const fw = 'aa11';
  const buildId = `node/${profile}/debug/${fw}`;
  const blob = (c: string) => `sha256:${c.repeat(64)}`;
  const manifest: ArtifactManifest = {
    schema: 'fractonica.artifact/1',
    build_id: buildId,
    app: 'node',
    profile,
    build_type: 'debug',
    board: 'esp32c6-supermini',
    target: 'esp32c6',
    chip_id: 13,
    part_profile: 'fr-4mb-v1',
    version: '0.1.0',
    source_dir: '/src',
    git: { sha: 'abc', dirty: false },
    idf: { version: 'v6.1', commit: 'def' },
    fw_id: fw.padEnd(64, '0'),
    elf_sha256: '00',
    size: 1,
    built_at: '2026-10-21T10:00:00.000Z',
    flash: {
      mode: 'dio',
      freq: '80m',
      size: '4MB',
      files: [
        { offset: '0x0', role: 'bootloader', blob: blob('a'), size: 1 },
        { offset: '0x8000', role: 'partition_table', blob: blob('b'), size: 1 },
        { offset: '0xe000', role: 'ota_data_initial', blob: blob('c'), size: 1 },
        { offset: '0x10000', role: 'app', blob: blob('d'), size: 1 },
      ],
    },
    partitions: [
      { label: 'nvs', type: 1, subtype: 2, offset: 0x9000, size: 0x5000, readonly: false },
      { label: 'fr_ident', type: 1, subtype: 2, offset: 0x3fc000, size: 0x4000, readonly: true },
    ],
  };
  const file = join(home, `${buildId.replaceAll('/', '_')}-${++dbs}.json`);
  writeFileSync(file, JSON.stringify(manifest));
  db.prepare('INSERT INTO artifacts (build_id, source_dir, profile, build_type, fw_id, built_at, manifest_path) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    buildId, '/src', profile, 'debug', manifest.fw_id, manifest.built_at, file,
  );
  return buildId;
}

let dbs = 0;

// ---- the target hub: the one the board will belong to ----

interface Target {
  hub: HubContext;
  db: Db;
  router: HubRouter;
  url: string;
  published: HubEvent[];
  /** The flashed board as that hub meets it: a node that joins over TCP with the identity the hub enrolled. */
  boardJoins(epoch?: number): Promise<FakeNode>;
  op<T = unknown>(name: string, input: Record<string, unknown>): Promise<T>;
}

/** A hub with a network record (no Wi-Fi password of its own), a real router and the real HTTP API on loopback. */
async function target(opts: { network?: boolean } = {}): Promise<Target> {
  const db = openDb(join(home, `target-${++dbs}.db`));
  // Every hub of this file runs on one host, so each is given a name of its own, as `fr hub name` does: a network
  // refuses a second hub under a name it has (design multi-hub-m2 §2).
  setHubName(db, `home-${dbs}`);
  const seq = new CursorSeq(db);
  const logs = new LogStore(db, 1, { retention: false, seq });
  const events = new EventStore(db, seq, 1);
  const published: HubEvent[] = [];
  events.subscribe((e) => published.push(e));
  const registry = createRegistry(db);
  const serial = new FakeSerial();
  const scale = createScaleCounters();
  if (opts.network !== false) {
    writeNetwork(db, { ssid: 'HomeNet', bssid: null, country: null });
    db.prepare("UPDATE networks SET net_id = ?, hub_host = 'home-hub.local'").run(HOME_NET);
  }
  const router = createRouter({
    db,
    logs,
    serial,
    seq,
    registry,
    events,
    hubEpoch: 3,
    links: { host: '127.0.0.1', tcpPort: 0, udpPort: 0 },
    config: { timeSampleTimeoutMs: 200 },
    logIngest: createLogIngest(logs, scale),
    scale,
  });
  serial.deliver = (device, line) => router.serialLine(device, line);
  await router.start();
  const hub = { db, logs, serial, seq, registry, router, events, hubEpoch: 3, jobs: new JobRunner(db), startedAt: Date.now() } as unknown as HubContext;
  const app = buildServer(hub, 0);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const nodes: FakeNode[] = [];
  cleanups.push(async () => {
    nodes.forEach((n) => n.close());
    await app.close();
    await router.stop();
    events.stop();
    logs.close();
    db.close();
  });
  return {
    hub,
    db,
    router,
    url,
    published,
    async boardJoins(epoch = 1) {
      const row = registry.get(DEV)!;
      const node = new FakeNode({ mac: DEV, addr: row.addr!, net: row.net!, epoch, alias: row.alias, aliasRev: row.alias_rev, hub: router.ports()!, autoHeartbeat: false });
      nodes.push(node);
      await node.connected(events);
      return node;
    },
    op: (name, input) => remoteOp(url, name, input),
  };
}

// ---- the flashing hub: USB ports, the sidecar, the Wi-Fi password ----

interface Lab {
  hub: HubContext;
  db: Db;
  logs: LogStore;
  published: HubEvent[];
  /** What the board does after each hub reset. */
  onReset: (() => void) | null;
  /** The job's temporary reads of the port (SerialPortManager.watchFor): [key, 'watch' | 'release']. */
  watches: [string, string][];
}

function lab(): Lab {
  const db = openDb(join(home, `lab-${++dbs}.db`));
  setHubName(db, `lab-${dbs}`);
  const seq = new CursorSeq(db);
  const logs = new LogStore(db, 1, { retention: false, seq, frames: new FrameDecoder(db) });
  const events = createEvents(db, seq, 1);
  const published: HubEvent[] = [];
  events.subscribe((e) => published.push(e));
  const r: Lab = { hub: null as unknown as HubContext, db, logs, published, onReset: null, watches: [] };
  const entry = { key: DEV, path: PORT };
  const serial = {
    resolveWait: async (sel: string) => {
      if (sel.replace(/[:]/g, '').toLowerCase() === DEV || sel === PORT) {
        return entry;
      }
      throw new FrError('NOT_FOUND', `no attached Espressif port matches ${sel}`);
    },
    lease: async () => ({ ...entry, release: () => undefined }),
    hardReset: async () => {
      r.onReset?.();
      return entry;
    },
    watchFor: (key: string) => {
      r.watches.push([key, 'watch']);
      return () => r.watches.push([key, 'release']);
    },
    list: () => [{ path: PORT, device_id: DEV, state: 'open', lines: 0 }],
  };
  r.hub = {
    db,
    logs,
    serial,
    jobs: new JobRunner(db),
    startedAt: Date.now(),
    hubSourceDir: home,
    idf: () => null,
    pytools: () => null,
    seq,
    registry: createRegistry(db),
    router: { presence: () => 'unknown', online: () => [], sendCommand: vi.fn(), pushAlias: vi.fn() },
    events,
    hubEpoch: 1,
  } as unknown as HubContext;
  HANDLERS.network_set({ ssid: 'LabNet', password: SECRET, country: 'LV' }, r.hub);
  db.prepare("UPDATE networks SET net_id = ?, hub_host = 'lab-mac.local'").run(LAB_NET);
  artifact(db);
  cleanups.push(() => {
    r.hub.jobs.cancelAll();
    events.stop();
    logs.close();
    db.close();
  });
  return r;
}

/**
 * The board after the flashing hub's reset: its HELLO on serial as that hub's log store keeps it (the board now says
 * the other hub's net), and, with `joins`, its TCP session with the hub it belongs to.
 */
function boardBoots(l: Lab, t: Target | null, opts: { joins?: boolean; epoch?: number } = {}): void {
  l.onReset = () => {
    setTimeout(() => {
      const body = encodePresenceHello({ mac: Buffer.from(DEV, 'hex'), chip: 13, alias: 'x', alias_rev: 1, caps: 0x22 });
      l.logs.append(DEV, PORT, encodeEnvLine({ header: { flags: 0, cls: CLS.PRESENCE, kind: 1, seq: 1, net: HOME_NET, src: 1, dst: 0, epoch: 1, ttl: 0x22, port: 0 }, body }));
    }, 20);
    if (t && opts.joins !== false) {
      setTimeout(() => void t.boardJoins(opts.epoch).catch(() => undefined), 60);
    }
  };
}

const FAST: ProvisionDeps = { pytools: runPytools, helloMs: 1500, joinMs: 3000, joinPollMs: 50 };

async function provision(l: Lab, input: Record<string, unknown>, deps: ProvisionDeps = FAST): Promise<Job> {
  return (await startProvision({ port: DEV, wait_s: 30, ...input } as never, l.hub, deps)) as Job;
}

function jobLogs(db: Db, jobId: string): string[] {
  return (db.prepare('SELECT text FROM job_logs WHERE job_id = ? ORDER BY line').all(jobId) as { text: string }[]).map((x) => x.text);
}

/** Every place a hub keeps or returns something: none may hold the Wi-Fi password. */
function expectNoSecret(h: { db: Db; published: HubEvent[]; logs?: LogStore }, ...outputs: unknown[]): void {
  h.logs?.flush();
  for (const table of ['devices', 'networks', 'kv', 'jobs', 'job_logs', 'logs', 'events', 'artifacts']) {
    expect(JSON.stringify(h.db.prepare(`SELECT * FROM ${table}`).all()), table).not.toContain(TOKEN);
  }
  expect(JSON.stringify(h.published)).not.toContain(TOKEN);
  for (const o of outputs) {
    expect(JSON.stringify(o)).not.toContain(TOKEN);
    expect(String(o instanceof Error ? o.message : '')).not.toContain(TOKEN);
  }
}

const frError = async (p: Promise<unknown>): Promise<FrError> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(FrError);
  return e as FrError;
};

const messageOf = (job: Job): string => (job.error as { message: string }).message;

const ENROLL = { device_id: DEV, chip: 'esp32c6', profile: 'c6-pad' };

// ---- device_enroll ----

describe('device_enroll input (the op registry)', () => {
  const input = findOp('device_enroll')!.input;
  it('takes a device id, a chip and a profile, and what the record wants', () => {
    expect(input.parse(ENROLL)).toEqual(ENROLL);
    expect(input.safeParse({ ...ENROLL, device_id: DEV.toUpperCase(), board: 'esp32c6-supermini', part_profile: 'fr-4mb-v1', build_id: 'node/c6-pad/debug/aa11', fw_id: 'ab'.repeat(32), ident_offset: 0x3fc000, ident_size: 0x4000, alias: 'kitchen-cam', network: 'default' }).success).toBe(true);
  });

  it.each([
    ['no device id', { chip: 'esp32c6', profile: 'c6-pad' }],
    ['a MAC with colons', { ...ENROLL, device_id: '1c:db:d4:00:05:64' }],
    ['11 hex digits', { ...ENROLL, device_id: DEV.slice(1) }],
    ['a device id that is not hex', { ...ENROLL, device_id: 'zzzzzzzzzzzz' }],
    ['a chip the registry does not name', { ...ENROLL, chip: 'esp8266' }],
    ['a profile with a space', { ...ENROLL, profile: 'c6 pad' }],
    ['a profile that is a path', { ...ENROLL, profile: '../c6-pad' }],
    ['an fw_id that is not hex', { ...ENROLL, fw_id: 'not-hex!' }],
    ['an empty alias', { ...ENROLL, alias: '' }],
    ['a network name in capitals', { ...ENROLL, network: 'Home' }],
    ['an fr_ident size of 0', { ...ENROLL, ident_offset: 0, ident_size: 0 }],
  ])('refuses %s', (_what, bad) => {
    expect(input.safeParse(bad).success).toBe(false);
  });

  it('has no field for a Wi-Fi credential, in or out', () => {
    const op = findOp('device_enroll')!;
    const out = (op.output as unknown as { shape: Record<string, unknown> }).shape;
    for (const key of [...Object.keys(op.input.shape), ...Object.keys(out)]) {
      expect(key).not.toMatch(/pass|psk|secret|ssid|wifi/i);
    }
    expect(op).toMatchObject({ kind: 'command', tier: 'mutate', cli: { path: ['devices', 'enroll'], positional: ['device_id'] } });
  });

  it('device_provision takes for_hub as the base URL of a hub API only', () => {
    const p = findOp('device_provision')!.input;
    expect(p.safeParse({ port: DEV, for_hub: 'http://127.0.0.1:7520' }).success).toBe(true);
    expect(p.safeParse({ port: DEV, for_hub: 'http://home-hub.local:7520/' }).success).toBe(true);
    for (const bad of ['127.0.0.1:7520', 'ftp://127.0.0.1:7520', 'http://user:pw@127.0.0.1:7520', 'http://127.0.0.1:7520/api/v1', 'http://127.0.0.1:7520?x=1', '']) {
      expect(p.safeParse({ port: DEV, for_hub: bad }).success, bad).toBe(false);
    }
    expect(hubBase('http://127.0.0.1:7520/')).toBe('http://127.0.0.1:7520');
    expect(() => hubBase('http://127.0.0.1:7520/x')).toThrow(/base URL/);
  });
});

describe('device_enroll (the hub the board will belong to)', () => {
  it('registers a new board as a provision would, provisioned and tagged new, and answers its identity without Wi-Fi', async () => {
    const t = await target();
    const out = await t.op<Enrolled>('device_enroll', { ...ENROLL, board: 'esp32c6-supermini', part_profile: 'fr-4mb-v1', build_id: 'node/c6-pad/debug/aa11', fw_id: 'aa11'.padEnd(64, '0'), ident_offset: 0x3fc000, ident_size: 0x4000 });
    expect(out).toEqual({
      device_id: DEV,
      addr: 1,
      net: HOME_NET,
      alias: 'c6-pad-000564',
      alias_rev: 1,
      epoch_floor: 1,
      hub_host: 'home-hub.local',
      hub_ip: hubIpv4(),
      network: 'default',
      new: true,
      tags: ['new'],
    });
    const row = t.hub.registry.get(DEV)!;
    expect(row).toMatchObject({ provisioned: true, addr: 1, net: HOME_NET, alias: 'c6-pad-000564', profile: 'c6-pad', board: 'esp32c6-supermini', chip: 'esp32c6', tags: ['new'], fw_id: 'aa11'.padEnd(64, '0') });
    expect(provisionOf(t.db, DEV)).toMatchObject({ via: 'provision', enrolled: true, addr: 1, net: HOME_NET, hub_host: 'home-hub.local', ident: { offset: 0x3fc000, size: 0x4000 }, build_id: 'node/c6-pad/debug/aa11' });
    expect(t.published.filter((e) => e.type === 'device.provisioned').map((e) => [e.device, e.fields?.enrolled])).toEqual([[DEV, true]]);
    // The hub's screen lists what waits to be accepted, and accepting is device_update --tag -new.
    expect((HANDLERS.device_list({ selector: 'tag:new' }, t.hub) as { devices: { device_id: string }[] }).devices.map((d) => d.device_id)).toEqual([DEV]);
    HANDLERS.device_update({ device: `id:${DEV}`, alias: 'kitchen-cam', tag: '-new' }, t.hub);
    expect(t.hub.registry.get(DEV)).toMatchObject({ alias: 'kitchen-cam', tags: [], provisioned: true });
    expectNoSecret(t, out);
  });

  it('is idempotent for a known board: the same addr and alias, no second `new`, the epoch floor past the last epoch seen', async () => {
    const t = await target();
    const first = await t.op<Enrolled>('device_enroll', { ...ENROLL, alias: 'kitchen-cam' });
    const again = await t.op<Enrolled>('device_enroll', ENROLL);
    expect(again).toEqual({ ...first, new: false });
    expect(first).toMatchObject({ addr: 1, alias: 'kitchen-cam', alias_rev: 1, epoch_floor: 1, tags: ['new'] });
    // Accepted, then seen at epoch 41: enrolling it again keeps it accepted and moves the floor as a provision does.
    HANDLERS.device_update({ device: 'kitchen-cam', tag: '-new' }, t.hub);
    t.db.prepare('UPDATE devices SET last_epoch = 41 WHERE device_id = ?').run(DEV);
    const later = await t.op<Enrolled>('device_enroll', ENROLL);
    expect(later).toMatchObject({ addr: 1, alias: 'kitchen-cam', alias_rev: 1, epoch_floor: 42, new: false, tags: [] });
    // Another board gets the next addr; the first one's is never handed out again.
    expect(await t.op<Enrolled>('device_enroll', { ...ENROLL, device_id: OTHER })).toMatchObject({ addr: 2, alias: 'c6-pad-000777', new: true });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM devices').get()).toEqual({ n: 2 });
  });

  it('replaces the made-up alias of a board the hub only saw, and tags it new', async () => {
    const t = await target();
    t.hub.registry.touchHello(DEV, { device_id: DEV, addr: 0xfffe, net: 0, epoch: 7, chip: 13, chip_rev: 1, fw_id_prefix: '', descriptor_hash: 0, board_hash: 0, role: 'node', caps: 0, alias: '', alias_rev: 0, ota_state: 0, link: 'tcp' } as never);
    expect(t.hub.registry.get(DEV)).toMatchObject({ provisioned: false, addr: null, alias: 'esp32c6-000564' });
    expect(await t.op<Enrolled>('device_enroll', ENROLL)).toMatchObject({ addr: 1, alias: 'c6-pad-000564', epoch_floor: 8, new: true, tags: ['new'] });
  });

  it('refuses what a provision refuses, before any row changes', async () => {
    const t = await target();
    await t.op('device_enroll', { ...ENROLL, device_id: OTHER, alias: 'kitchen-cam' });
    const taken = await frError(t.op('device_enroll', { ...ENROLL, alias: 'Kitchen-Cam' }));
    expect(taken.code).toBe('INVALID_ARGS');
    expect(taken.message).toContain(`${t.url} refused device_enroll: alias kitchen-cam is taken by device ${OTHER}`);
    expect((await frError(t.op('device_enroll', { ...ENROLL, alias: '-bad-' }))).code).toBe('INVALID_ARGS');
    expect((await frError(t.op('device_enroll', { ...ENROLL, network: 'attic' }))).message).toContain('no network attic is stored (stored: default)');
    expect((await frError(t.op('device_enroll', { ...ENROLL, ident_offset: 0x3fc000 }))).message).toContain('ident_offset and ident_size together');
    for (const id of ['000000000000', 'ffffffffffff', '01005e000001']) {
      expect((await frError(t.op('device_enroll', { ...ENROLL, device_id: id }))).message).toContain('is not a device id');
    }
    expect(checkDeviceId('1CDBD4000564')).toBe(DEV);
    expect(t.hub.registry.get(DEV)).toBeNull();
  });

  it('needs a stored network, but no Wi-Fi password', async () => {
    const t = await target({ network: false });
    const e = await frError(t.op('device_enroll', ENROLL));
    expect(e.code).toBe('ENV_MISSING');
    expect(e.hint).toContain('the password is not needed on this hub');
    expect(t.hub.registry.get(DEV)).toBeNull();
    // In process too (no HTTP between): the handler, not the route, refuses.
    expect(() => enroll(t.hub, ENROLL)).toThrow(/no network is stored/);
  });

  it('needs the chip and the profile of a new board (only a board with an explicit identity may come without)', async () => {
    const t = await target();
    for (const bad of [{ device_id: DEV, profile: 'c6-pad' }, { device_id: DEV, chip: 'esp32c6' }, { device_id: DEV, chip: 'esp32c6', alias: 'kitchen-cam' }, { device_id: DEV }]) {
      const e = await frError(t.op('device_enroll', bad));
      expect(e.code).toBe('INVALID_ARGS');
      expect(e.message).toContain('chip and profile are required to enroll a new board');
    }
    expect((await frError(t.op('device_enroll', { ...ENROLL, alias_rev: 3 }))).message).toContain('go with an explicit identity');
    expect(t.hub.registry.get(DEV)).toBeNull();
  });
});

// ---- device_provision --for-hub ----

describe('device_provision for another hub', () => {
  it('flashes a new board with the other hub\'s identity and this hub\'s Wi-Fi, and keeps no row of its own', async () => {
    const l = lab();
    const t = await target();
    boardBoots(l, t);
    const job = await provision(l, { profile: 'c6-pad', alias: 'kitchen-cam', for_hub: `${t.url}/` });
    expect(job.error).toBeUndefined();
    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({
      device_id: DEV,
      alias: 'kitchen-cam',
      alias_rev: 1,
      addr: 1,
      net: HOME_NET,
      hub_host: 'home-hub.local',
      for_hub: t.url,
      new: true,
      network: 'default',
      hello: 'serial',
      wifi: 'joined',
      via: 'tcp',
      profile: 'c6-pad',
      chip: 'esp32c6',
    });
    expect((job.result as { warnings?: string[] }).warnings).toBeUndefined();
    expect(job.stage).toBe('join'); // the same stages as a provision for this hub, to the last one

    // The other hub has the board: provisioned, waiting to be accepted, online over TCP.
    expect(t.hub.registry.get(DEV)).toMatchObject({ provisioned: true, alias: 'kitchen-cam', addr: 1, net: HOME_NET, tags: ['new'], profile: 'c6-pad', chip: 'esp32c6' });
    expect(t.router.presence(DEV)).toBe('online');
    expect(provisionOf(t.db, DEV)).toMatchObject({ enrolled: true, ident: { offset: 0x3fc000, size: 0x4000 }, hub_host: 'home-hub.local' });

    // fr_ident: who the board is and where it connects come from the other hub; how it gets onto Wi-Fi from this one.
    const ident = identOf();
    expect(ident.fields).toMatchObject({
      mac: DEV,
      addr: '1',
      net: String(HOME_NET),
      alias: 'kitchen-cam',
      alias_rev: '1',
      epoch_floor: '1',
      profile: 'c6-pad',
      ssid: 'LabNet',
      pass: '<SECRET>',
      country: 'LV',
      hub_host: 'home-hub.local',
    });
    expect(ident.has_secret).toBe(true);
    expect(calls().map((c) => c.cmd)).toEqual(['probe', 'nvs_gen', 'flash']);
    expect(calls()[2].offsets).toContain('0x3fc000');

    // This hub: no row at all for a board it never had, no device.provisioned, and the port was read only for the job.
    expect(l.hub.registry.get(DEV)).toBeNull();
    expect(l.db.prepare('SELECT COUNT(*) AS n FROM devices').get()).toEqual({ n: 0 });
    expect(l.published.filter((e) => e.type === 'device.provisioned')).toEqual([]);
    expect(l.watches).toEqual([[DEV, 'watch'], [DEV, 'release']]);
    const text = jobLogs(l.db, job.job_id).join('\n');
    expect(text).toContain(`registry: enrolled at ${t.url} (new there): kitchen-cam addr 1 net ${HOME_NET} hub home-hub.local`);
    expect(text).toContain(`kitchen-cam: online at ${t.url} over TCP (joined Wi-Fi)`);
    expectNoSecret(l, job, text);
    expectNoSecret(t);
  });

  it('writes the hub_ip the other hub answered, and none when it knows none', async () => {
    const l = lab();
    const t = await target();
    boardBoots(l, t);
    // The other hub's answer on its way back, with a documentation address as its LAN IPv4 (this machine's is not the test's to know).
    const withIp = (ip: string | null): typeof fetch => async (url, init) => {
      const r = await fetch(url, init);
      const body = (await r.json()) as { data?: Record<string, unknown> };
      if (String(url).endsWith('/device_enroll') && body.data) {
        body.data.hub_ip = ip;
      }
      return new Response(JSON.stringify(body), { status: r.status, headers: { 'content-type': 'application/json' } });
    };
    expect((await provision(l, { profile: 'c6-pad', for_hub: t.url }, { ...FAST, fetch: withIp('192.0.2.7') })).status).toBe('completed');
    expect(identOf().fields).toMatchObject({ hub_host: 'home-hub.local', hub_ip: '192.0.2.7' });
    sidecar();
    expect((await provision(l, { profile: 'c6-pad', for_hub: t.url }, { ...FAST, fetch: withIp(null) })).status).toBe('completed');
    expect(identOf().fields.hub_ip).toBeUndefined();
    // Never this hub's own host: the board would connect to the hub that only flashed it.
    expect(identOf().fields.hub_host).not.toBe('lab-mac.local');
  });

  it('provisioning the same board for that hub again keeps its addr and alias there', async () => {
    const l = lab();
    const t = await target();
    boardBoots(l, t, { epoch: 5 });
    const first = await provision(l, { profile: 'c6-pad', alias: 'kitchen-cam', for_hub: t.url });
    expect(first.result).toMatchObject({ addr: 1, alias: 'kitchen-cam', epoch_floor: 1, new: true, wifi: 'joined' });
    HANDLERS.device_update({ device: 'kitchen-cam', tag: '-new' }, t.hub); // named and accepted on that hub's screen
    sidecar();
    boardBoots(l, t, { epoch: 6 });
    const again = await provision(l, { for_hub: t.url, profile: 'c6-pad' });
    expect(again.status).toBe('completed');
    // The floor is past the epoch that hub saw (5), as a provision there would set it.
    expect(again.result).toMatchObject({ addr: 1, alias: 'kitchen-cam', alias_rev: 1, epoch_floor: 6, new: false, for_hub: t.url });
    expect(identOf().fields).toMatchObject({ addr: '1', alias: 'kitchen-cam', epoch_floor: '6' });
    expect(t.hub.registry.get(DEV)).toMatchObject({ provisioned: true, addr: 1, tags: [] });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM devices').get()).toEqual({ n: 1 });
    expect(l.hub.registry.get(DEV)).toBeNull();
  });

  it('fails before the board is touched when the other hub does not answer', async () => {
    const l = lab();
    // A loopback port nobody listens on.
    const port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const url = `http://127.0.0.1:${port}`;
    const e = await frError(provision(l, { profile: 'c6-pad', for_hub: url }));
    expect(e.code).toBe('HUB_UNREACHABLE');
    expect(e.message).toContain(`the hub at ${url} is not reachable`);
    expect(e.hint).toContain('tunnel');
    expect(e.hint).toContain(`curl ${url}/api/v1/health`);
    expect(calls()).toEqual([]); // not even a probe
    expect(l.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 0 });
    expect(l.hub.registry.get(DEV)).toBeNull();
  });

  it('fails before anything is written when the other hub goes away, refuses the alias, or is an older version', async () => {
    const l = lab();
    const t = await target();
    await t.op('device_enroll', { ...ENROLL, device_id: OTHER, alias: 'kitchen-cam' });

    // The alias is taken there: its refusal, with that hub named, before the render and the flash.
    const taken = await provision(l, { profile: 'c6-pad', alias: 'kitchen-cam', for_hub: t.url });
    expect(taken.status).toBe('failed');
    expect(taken.error).toMatchObject({ code: 'INVALID_ARGS' });
    expect(messageOf(taken)).toContain(`the hub at ${t.url} refused device_enroll: alias kitchen-cam is taken by device ${OTHER}`);
    expect(taken.stage).toBe('registry');
    expect(calls().map((c) => c.cmd)).toEqual(['probe']);
    expect(t.hub.registry.get(DEV)).toBeNull();

    // Gone between the pre-check and the enrollment (a tunnel that dropped).
    sidecar();
    const dropped: typeof fetch = (url, init) => (String(url).endsWith('/device_enroll') ? Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })) : fetch(url, init));
    const gone = await provision(l, { profile: 'c6-pad', for_hub: t.url }, { ...FAST, fetch: dropped });
    expect(gone.error).toMatchObject({ code: 'HUB_UNREACHABLE' });
    expect(messageOf(gone)).toBe(`the hub at ${t.url} is not reachable (ECONNREFUSED)`);
    expect(calls().map((c) => c.cmd)).toEqual(['probe']);

    // A hub from before device_enroll.
    sidecar();
    const old: typeof fetch = (url, init) =>
      String(url).endsWith('/device_enroll')
        ? Promise.resolve(new Response(JSON.stringify({ ok: false, cursor: 'c:1.0', error: { code: 'NOT_FOUND', message: 'unknown op device_enroll', retryable: false } }), { status: 404 }))
        : fetch(url, init);
    const older = await provision(l, { profile: 'c6-pad', for_hub: t.url }, { ...FAST, fetch: old });
    expect(older.error).toMatchObject({ code: 'HUB_VERSION_MISMATCH' });
    expect(messageOf(older)).toContain(`the hub at ${t.url} does not know device_enroll`);
    expect(calls().map((c) => c.cmd)).toEqual(['probe']);

    expect(l.hub.registry.get(DEV)).toBeNull();
    expect(l.watches.filter(([, w]) => w === 'watch')).toHaveLength(l.watches.filter(([, w]) => w === 'release').length);
    expectNoSecret(l, taken, gone, older);
  });

  it('refuses, before a job starts, a hub without a stored network, and this hub itself', async () => {
    const l = lab();
    const bare = await target({ network: false });
    const none = await frError(provision(l, { profile: 'c6-pad', for_hub: bare.url }));
    expect(none.code).toBe('ENV_MISSING');
    expect(none.message).toContain(`the hub at ${bare.url} has no network stored`);
    expect(none.hint).toContain('on that hub: fr net set --ssid');
    expect(calls()).toEqual([]);

    // This hub itself is not another hub.
    (l.hub as { run?: unknown }).run = { apiPort: 7420 };
    expect((await frError(provision(l, { profile: 'c6-pad', for_hub: 'http://localhost:7420' }))).message).toContain('is this hub itself');
  });

  it('still needs this hub\'s own stored network: the Wi-Fi is not the other hub\'s to give', async () => {
    const l = lab();
    const t = await target();
    l.db.prepare('DELETE FROM networks').run();
    const e = await frError(provision(l, { profile: 'c6-pad', for_hub: t.url }));
    expect(e.code).toBe('ENV_MISSING');
    expect(e.hint).toBe('fr net set');
    expect(t.hub.registry.get(DEV)).toBeNull();
  });

  it('reports not_joined, with the other hub named, when the board does not reach it', async () => {
    const l = lab();
    const t = await target();
    boardBoots(l, t, { joins: false });
    const job = await provision(l, { profile: 'c6-pad', for_hub: t.url }, { ...FAST, joinMs: 400 });
    expect(job.status).toBe('completed');
    const res = job.result as { wifi: string; via?: string; warnings: string[] };
    expect(res.wifi).toBe('not_joined');
    expect(res.via).toBeUndefined();
    expect(res.warnings).toEqual([expect.stringContaining(`c6-pad-000564 did not reach the hub at ${t.url} over Wi-Fi within 0.4 s`)]);
    // Flashed and enrolled all the same: the registry row there is the board's.
    expect(t.hub.registry.get(DEV)).toMatchObject({ provisioned: true, tags: ['new'] });
    expect(t.router.presence(DEV)).not.toBe('online');
  });

  it('says so in the job log when the flash fails after the other hub registered the board', async () => {
    const l = lab();
    const t = await target();
    sidecar({ fail: { flash: { code: 'FLASH_FAILED', message: 'A fatal error occurred: Failed to connect' } } });
    const job = await provision(l, { profile: 'c6-pad', for_hub: t.url });
    expect(job.error).toMatchObject({ code: 'FLASH_FAILED' });
    expect(jobLogs(l.db, job.job_id).join('\n')).toContain(`c6-pad-000564 is registered at ${t.url} but was not flashed; provision it again with --for-hub`);
    expect(l.hub.registry.get(DEV)).toBeNull();
    // The next run finds the row there and keeps its addr.
    sidecar();
    boardBoots(l, t);
    expect((await provision(l, { profile: 'c6-pad', for_hub: t.url })).result).toMatchObject({ addr: 1, new: false, wifi: 'joined' });
  });
});

// ---- a board that was this hub's own (the moved-board question) ----

describe('moving a registered board to another hub', () => {
  it('leaves a row seen only, tagged moved, that the port policy no longer adopts; provisioning it here again takes it back', async () => {
    const l = lab();
    const t = await target();
    // The board is this hub's: provisioned here, tagged by its owner.
    l.onReset = () => {
      setTimeout(() => {
        const body = encodePresenceHello({ mac: Buffer.from(DEV, 'hex'), chip: 13, alias: 'mic-1', alias_rev: 1, caps: 0x22 });
        l.logs.append(DEV, PORT, encodeEnvLine({ header: { flags: 0, cls: CLS.PRESENCE, kind: 1, seq: 1, net: LAB_NET, src: 1, dst: 0, epoch: 1, ttl: 0x22, port: 0 }, body }));
      }, 20);
    };
    const own = await provision(l, { profile: 'c6-pad', alias: 'mic-1' }, { ...FAST, joinMs: 100 });
    expect(own.status).toBe('completed');
    HANDLERS.device_update({ device: 'mic-1', tag: 'desk' }, l.hub);
    expect(l.hub.registry.get(DEV)).toMatchObject({ provisioned: true, addr: 1, net: LAB_NET, tags: ['desk'] });
    const policy = createPortPolicy(l.db, join(home, 'no-config.json'));
    const port = { key: DEV, path: PORT, usbSerial: '1C:DB:D4:00:05:64', vid: '303a', pid: '1001' };
    expect(policy.decide(port)).toEqual({ watch: true, why: 'adopted' });

    // Moved: flashed here for the other hub.
    sidecar();
    boardBoots(l, t);
    const moved = await provision(l, { for_hub: t.url });
    expect(moved.status).toBe('completed');
    expect(moved.result).toMatchObject({ alias: 'c6-pad-000564', addr: 1, net: HOME_NET, for_hub: t.url, new: true, wifi: 'joined' });
    expect(identOf().fields).toMatchObject({ net: String(HOME_NET), hub_host: 'home-hub.local', ssid: 'LabNet' });
    expect(t.hub.registry.get(DEV)).toMatchObject({ provisioned: true, tags: ['new'] });

    // Here it is no longer a device of this hub: not provisioned (apps, bindings and the node directory leave it
    // out), no addr or net, its own alias and tags kept, the record saying where it went.
    const row = l.hub.registry.get(DEV)!;
    expect(row).toMatchObject({ provisioned: false, addr: null, net: null, alias: 'mic-1', tags: ['desk', 'moved'], profile: 'c6-pad' });
    expect(provisionOf(l.db, DEV)).toMatchObject({ for_hub: t.url, hub_host: 'home-hub.local', net: HOME_NET, alias: 'c6-pad-000564' });
    expect((HANDLERS.device_list({ selector: 'tag:moved' }, l.hub) as { devices: { provisioned: boolean }[] }).devices).toMatchObject([{ provisioned: false }]);
    expect(l.published.filter((e) => e.type === 'device.provisioned')).toHaveLength(1); // the first, local one only
    expect(jobLogs(l.db, moved.job_id).join('\n')).toContain("mic-1 was this hub's: its row here is now seen only, tagged moved, and its port is no longer adopted");
    // Its port: left closed once the job is over, for a row and for a bridge port that last carried the board.
    expect(policy.decide(port)).toEqual({ watch: false, why: 'not_adopted' });
    l.db.prepare("INSERT INTO ports_seen (usb_serial, last_path, vid, pid, last_seen, device_id, device_port) VALUES ('path:usbserial-110', '/dev/cu.usbserial-110', '1a86', '7523', '', ?, '1a86:7523:')").run(DEV);
    expect(policy.decide({ key: 'path:usbserial-110', path: '/dev/cu.usbserial-110', vid: '1a86', pid: '7523', bridge: 'ch340' })).toEqual({ watch: false, why: 'not_adopted' });
    // The addr it had here is not handed to the next board.
    expect(l.db.prepare("SELECT v FROM kv WHERE k = 'registry.addr_hwm'").get()).toEqual({ v: '1' });

    // Back: provisioned here again, it is this hub's device again, on a new addr, and its port is adopted again.
    sidecar();
    l.onReset = null;
    const back = await provision(l, {}, { ...FAST, helloMs: 100 }).catch((e: unknown) => e);
    expect(back).toBeDefined();
    expect(l.hub.registry.get(DEV)).toMatchObject({ provisioned: true, addr: 2, net: LAB_NET, alias: 'mic-1', tags: ['desk'] });
    expect(provisionOf(l.db, DEV)!.for_hub).toBeUndefined();
    expect(identOf().fields).toMatchObject({ net: String(LAB_NET), hub_host: 'lab-mac.local', addr: '2' });
    expect(policy.decide(port)).toEqual({ watch: true, why: 'adopted' });
    expectNoSecret(l, own, moved);
  });

  it('this hub\'s router drops the moved board\'s serial HELLO: no session, nothing written to its port, no row', async () => {
    // What the board on a USB port of the flashing hub does after the move: HELLO once a second with the other hub's
    // net (firmware fr_net, hello_retry_ms). A real router with this hub's net record takes none of them.
    const db = openDb(join(home, `lab-router-${++dbs}.db`));
    const seq = new CursorSeq(db);
    const logs = new LogStore(db, 1, { retention: false, seq });
    const events = new EventStore(db, seq, 1);
    const registry = createRegistry(db);
    const serial = new FakeSerial();
    writeNetwork(db, { ssid: 'LabNet', bssid: null, country: null });
    db.prepare('UPDATE networks SET net_id = ?').run(LAB_NET);
    const router = createRouter({ db, logs, serial, seq, registry, events, hubEpoch: 9, links: false, config: { timeSampleTimeoutMs: 200 } });
    serial.deliver = (device, line) => router.serialLine(device, line);
    await router.start();
    const board = new FakeNode({ mac: DEV, addr: 1, net: HOME_NET, epoch: 2, alias: 'kitchen-cam', aliasRev: 1, serial, autoHeartbeat: false });
    cleanups.push(async () => {
      board.close();
      await router.stop();
      events.stop();
      logs.close();
      db.close();
    });
    await expect(board.connect(400)).rejects.toThrow(/no WELCOME/);
    board.hello();
    await new Promise((r) => setTimeout(r, 50));
    expect(router.status().counters.foreign_net).toBeGreaterThanOrEqual(2);
    expect(router.presence(DEV)).not.toBe('online');
    expect(serial.written).toEqual([]); // the hub answers nothing, so it can command nothing
    expect(registry.get(DEV)).toBeNull();
    expect(events.query({ limit: 10 }).filter((e) => e.device === DEV)).toEqual([]);
  });
});

// ---- one network, several hubs (design multi-hub-m1) ----

describe('one network, two hubs (design multi-hub-m1)', () => {
  const LINUX = '1cdbd4000999';
  /** A hub whose net id is its own, not the default target's. */
  async function member(netId: number): Promise<Target> {
    const t = await target();
    t.db.prepare("UPDATE networks SET net_id = ?, hub_host = 'attic-hub.local'").run(netId);
    t.router.refreshNet(); // the router read the net id when it started
    return t;
  }

  it('device_enroll with an explicit identity stores exactly that row: nothing allocated, not tagged new, the same again', async () => {
    const t = await target();
    const shared = { device_id: DEV, chip: 'esp32c6', profile: 'c6-pad', alias: 'kitchen-cam', addr: 7, net: HOME_NET, alias_rev: 3, epoch_floor: 12 };
    const out = await t.op<Enrolled>('device_enroll', shared);
    expect(out).toEqual({ device_id: DEV, addr: 7, net: HOME_NET, alias: 'kitchen-cam', alias_rev: 3, epoch_floor: 12, hub_host: 'home-hub.local', hub_ip: hubIpv4(), network: 'default', new: true, tags: [] });
    expect(t.hub.registry.get(DEV)).toMatchObject({ provisioned: true, addr: 7, net: HOME_NET, alias: 'kitchen-cam', alias_rev: 3, tags: [], last_epoch: 11, profile: 'c6-pad', chip: 'esp32c6' });
    const first = provisionOf(t.db, DEV);
    expect(first).toMatchObject({ enrolled: true, addr: 7, net: HOME_NET, alias: 'kitchen-cam', alias_rev: 3 });
    // Again: the same answer (it was provisioned here by then), the same record, no second event.
    expect(await t.op<Enrolled>('device_enroll', shared)).toEqual({ ...out, new: false });
    expect(provisionOf(t.db, DEV)).toEqual(first);
    expect(t.published.filter((e) => e.type === 'device.provisioned').map((e) => [e.device, e.fields?.shared])).toEqual([[DEV, true]]);
    // The address is retired here too: a board this hub enrolls itself gets the next one.
    expect(await t.op<Enrolled>('device_enroll', { ...ENROLL, device_id: OTHER })).toMatchObject({ addr: 8, new: true, tags: ['new'] });
    // A node without an ESP32 chip comes without chip and profile.
    expect(await t.op<Enrolled>('device_enroll', { device_id: LINUX, alias: 'home-node', addr: 30, net: HOME_NET })).toMatchObject({ addr: 30, alias: 'home-node', alias_rev: 1, epoch_floor: 1, tags: [] });
    expect(t.hub.registry.get(LINUX)).toMatchObject({ provisioned: true, chip: null, profile: null });
  });

  it('the registry keeps a board\'s hub list until a flash writes its identity again', async () => {
    const t = await target();
    await t.op('device_enroll', { ...ENROLL, alias: 'kitchen-cam' });
    const list = { rev: 2, hubs: [{ host: 'lab-hub.local', ip: null }, { host: 'home-hub.local', ip: '192.168.1.30' }], set_at: '2026-11-20T10:00:00.000Z' };
    setDeviceHubs(t.db, DEV, list);
    expect(t.hub.registry.get(DEV)!.hubs).toEqual(list);
    expect((HANDLERS.device_get({ device: 'kitchen-cam' }, t.hub) as { hubs: unknown; hub_now: unknown }).hubs).toEqual(list);
    expect((HANDLERS.device_get({ device: 'kitchen-cam' }, t.hub) as { hub_now: unknown }).hub_now).toEqual({ here: false, on: null, rev: null, trial: null, at: null, asked_at: null });
    // A row shared again by another hub of the network is no flash: the list stands.
    await t.op('device_enroll', { device_id: DEV, alias: 'kitchen-cam', addr: 1, net: HOME_NET, alias_rev: 2 });
    expect(t.hub.registry.get(DEV)!.hubs).toEqual(list);
    // A flash (here: the board enrolled again for a provisioning elsewhere) writes a new prov_ts, and the board drops
    // the list it held: so does the row.
    await t.op('device_enroll', ENROLL);
    expect(t.hub.registry.get(DEV)!.hubs).toBeNull();
    // What is not a list reads as none.
    t.db.prepare("UPDATE devices SET hubs = 'not json' WHERE device_id = ?").run(DEV);
    expect(t.hub.registry.get(DEV)!.hubs).toBeNull();
  });

  it('refuses an identity of another network, an addr or alias another device holds, and half an identity', async () => {
    const t = await target();
    await t.op('device_enroll', { ...ENROLL, device_id: OTHER, alias: 'hall-pad' }); // addr 1
    const shared = { device_id: DEV, alias: 'kitchen-cam', addr: 7, net: HOME_NET };
    const foreign = await frError(t.op('device_enroll', { ...shared, net: LAB_NET }));
    expect(foreign.code).toBe('INVALID_ARGS');
    expect(foreign.message).toContain(`this hub's network default has net id ${HOME_NET}, not ${LAB_NET}`);
    expect(foreign.hint).toContain('fr net join --hub');
    const held = await frError(t.op('device_enroll', { ...shared, addr: 1 }));
    expect(held.code).toBe('INVALID_ARGS');
    expect(held.message).toContain(`addr 1 is held by hall-pad (${OTHER})`);
    expect((await frError(t.op('device_enroll', { ...shared, alias: 'Hall-Pad' }))).message).toContain(`alias hall-pad is taken by device ${OTHER}`);
    for (const half of [{ device_id: DEV, addr: 7 }, { device_id: DEV, net: HOME_NET, alias: 'kitchen-cam' }, { device_id: DEV, addr: 7, net: HOME_NET }]) {
      expect((await frError(t.op('device_enroll', half))).message).toContain('addr, net and alias together');
    }
    expect(t.hub.registry.get(DEV)).toBeNull();
  });

  it('a row shared for a board that is connected under another identity: a Linux node takes it over the air, an ESP32 needs a flash', async () => {
    const t = await target();
    (t.hub as { broadcast?: unknown }).broadcast = t.router; // the real hub's context has it (main.ts)
    // An ESP32 this hub provisioned itself (addr 1), connected; the network's registrar says it is addr 9.
    await t.op('device_enroll', { ...ENROLL, alias: 'kitchen-cam' });
    await t.boardJoins();
    const esp = await t.op<Enrolled>('device_enroll', { device_id: DEV, alias: 'kitchen-cam', addr: 9, net: HOME_NET });
    expect(esp.adopt).toBe('needs_flash');
    expect(t.hub.registry.get(DEV)).toMatchObject({ addr: 9, provisioned: true });
    // A Linux node (HELLO chip 255) connected without an identity of this network.
    const node = new FakeNode({ mac: LINUX, chip: 255, alias: 'home-node', hub: t.router.ports()!, autoHeartbeat: false });
    cleanups.push(() => node.close());
    await node.connected(t.hub.events as EventStore);
    const linux = await t.op<Enrolled>('device_enroll', { device_id: LINUX, alias: 'home-node', addr: 30, net: HOME_NET, alias_rev: 2, epoch_floor: 5 });
    expect(linux.adopt).toBe('pushed');
    const adopt = node.msgs.filter((m) => m.topic === 'fr.adopt');
    expect(adopt).toHaveLength(1);
    expect(JSON.parse(adopt[0].data)).toEqual({ addr: 30, net: HOME_NET, alias: 'home-node', alias_rev: 2, epoch_floor: 5 });
    // A board that is not connected, or connected as itself, gets no such note.
    expect((await t.op<Enrolled>('device_enroll', { device_id: OTHER, alias: 'hall-pad', addr: 31, net: HOME_NET })).adopt).toBeUndefined();
  });

  it('network_join takes the other hub\'s net id and names it the registrar; from then on only that hub hands out addresses', async () => {
    const reg = await target(); // the registrar: HOME_NET
    const b = await member(0x3333);
    const joined = await b.op<{ net_id: number; previous_net_id: number; registrar: string; networks: { net_id: number; registrar: string; ssid: string }[]; foreign: unknown[] }>('network_join', { hub: `${reg.url}/` });
    expect(joined).toMatchObject({ net_id: HOME_NET, previous_net_id: 0x3333, registrar: reg.url, foreign: [] });
    expect(joined.networks).toHaveLength(1);
    expect(joined.networks[0]).toMatchObject({ net_id: HOME_NET, registrar: reg.url, ssid: 'HomeNet' });
    expect(await b.op('network_get', {})).toMatchObject({ net_id: HOME_NET, registrar: reg.url });
    expect(await reg.op('network_get', {})).toMatchObject({ net_id: HOME_NET, registrar: null });
    // The registrar admitted it (design multi-hub-m2 §4, §9): its name in the network, epoch slot 1 and the member
    // list. The registrar itself is slot 0.
    const admitted = joined as unknown as { hub: { id: string; name: string; slot: number }; members: { id: string; name: string; slot: number }[]; warnings?: string[] };
    expect(admitted.hub).toMatchObject({ slot: 1 });
    expect(admitted.hub.name).toMatch(/^home-\d+$/);
    expect(admitted.members.map((m) => m.slot)).toEqual([0, 1]);
    expect(admitted.members[1]).toMatchObject({ id: admitted.hub.id, name: admitted.hub.name });
    // This file's cut-down hub context runs under epoch 3, which is not one of slot 1: the answer says to restart.
    expect(admitted.warnings?.join(' ')).toContain('outside the epoch slot the registrar gave it (slot 1: 16385..32767)');
    // From its next start on the member counts inside its slot, and the registrar inside slot 0: they never meet.
    expect(nextHubEpoch(b.db)).toBe(0x4000 + 1);
    expect(nextHubEpoch(b.db)).toBe(0x4000 + 2);
    expect(nextHubEpoch(reg.db)).toBe(1);
    // Joining again changes nothing.
    expect(await b.op('network_join', { hub: reg.url })).toMatchObject({ net_id: HOME_NET, previous_net_id: HOME_NET, hub: admitted.hub, members: admitted.members });

    // The member allocates nothing: a new board is the registrar's to enroll.
    const refused = await frError(b.op('device_enroll', ENROLL));
    expect(refused.code).toBe('INVALID_ARGS');
    expect(refused.message).toContain(`this hub joined the network of home-hub.local (${reg.url}): only that hub, the network's registrar, hands out addresses`);
    // This file's hub context has no link part, so the registrar cannot be asked over it (peers-registry.test.ts and
    // interop-registry.test.ts have a member that asks): refused as before the link, and the hint says where a row comes from now.
    expect(refused.hint).toContain("asks home-hub.local");
    expect(refused.hint).toContain('its row then reaches this hub by itself');
    expect(b.hub.registry.get(DEV)).toBeNull();
    // The registrar enrolls it and shares the row; the member then holds the same identity.
    const row = await reg.op<Enrolled>('device_enroll', { ...ENROLL, alias: 'kitchen-cam' });
    const shared = await reg.op<{ hub_host: string; with_hub: string; addr: number; net: number; adopt?: string }>('device_share', { device: 'kitchen-cam', with_hub: b.url });
    expect(shared).toMatchObject({ device_id: DEV, alias: 'kitchen-cam', addr: row.addr, net: HOME_NET, with_hub: b.url, hub_host: 'attic-hub.local' });
    expect(shared.adopt).toBeUndefined();
    expect(b.hub.registry.get(DEV)).toMatchObject({ provisioned: true, addr: row.addr, net: HOME_NET, alias: 'kitchen-cam', alias_rev: row.alias_rev, tags: [], chip: 'esp32c6', profile: 'c6-pad' });
    expect(provisionOf(reg.db, DEV)).toMatchObject({ shared_with: [b.url] });
    // Sharing again is no change, and a row with its address may be enrolled again on the member (no allocation).
    await reg.op('device_share', { device: 'kitchen-cam', with_hub: b.url });
    expect(provisionOf(reg.db, DEV)!.shared_with).toEqual([b.url]);
    expect(await b.op<Enrolled>('device_enroll', ENROLL)).toMatchObject({ addr: row.addr, alias: 'kitchen-cam', new: false });
    // The board connects to the member with the identity the registrar gave it: the member's router takes its net now.
    const node = new FakeNode({ mac: DEV, addr: row.addr, net: HOME_NET, epoch: 4, alias: 'kitchen-cam', aliasRev: row.alias_rev, hub: b.router.ports()!, autoHeartbeat: false });
    cleanups.push(() => node.close());
    await node.connected(b.hub.events as EventStore);
    expect(b.router.presence(DEV)).toBe('online');
  });

  it('network_join refuses to strand boards provisioned under this hub\'s own net id unless forced, and names them', async () => {
    const reg = await target();
    const b = await member(0x3333);
    await b.op('device_enroll', { ...ENROLL, device_id: OTHER, alias: 'attic-pad' });
    const refused = await frError(b.op('network_join', { hub: reg.url }));
    expect(refused.code).toBe('INVALID_ARGS');
    expect(refused.message).toContain("1 board is provisioned here under this hub's own net id (13107): attic-pad");
    expect(refused.hint).toContain('--force');
    expect(await b.op('network_get', {})).toMatchObject({ net_id: 0x3333, registrar: null });
    const forced = await b.op<{ foreign: { device_id: string; alias: string; chip: string; fix: string }[] }>('network_join', { hub: reg.url, force: true });
    expect(forced.foreign).toHaveLength(1);
    expect(forced.foreign[0]).toMatchObject({ device_id: OTHER, alias: 'attic-pad', chip: 'esp32c6' });
    expect(forced.foreign[0].fix).toContain('flash it');
    // That board's HELLO is another network's now: the member answers nothing.
    const old = new FakeNode({ mac: OTHER, addr: 1, net: 0x3333, epoch: 2, alias: 'attic-pad', aliasRev: 1, hub: b.router.ports()!, autoHeartbeat: false });
    cleanups.push(() => old.close());
    await expect(old.connect(400)).rejects.toThrow(/no WELCOME/);
    expect(b.router.status().counters.foreign_net).toBeGreaterThanOrEqual(1);
    // A hub without a stored network has nothing to join; this hub is not another hub.
    const bare = await target({ network: false });
    expect((await frError(b.op('network_join', { hub: bare.url }))).code).toBe('ENV_MISSING');
    (b.hub as { run?: unknown }).run = { apiPort: Number(new URL(b.url).port) };
    expect((await frError(b.op('network_join', { hub: b.url }))).message).toContain('is this hub itself');
  });

  it('a hub with no network of its own takes the registrar\'s SSID, country and band with the net id, never a password', async () => {
    const reg = await target();
    reg.db.prepare("UPDATE networks SET country = 'LV', band = '2g'").run();
    const bare = await target({ network: false });
    const joined = await bare.op<{ networks: Record<string, unknown>[] }>('network_join', { hub: reg.url });
    expect(joined.networks).toHaveLength(1);
    // (password_set is not asked here: every hub of this file shares one FR_HOME, and so one secrets.json.)
    expect(joined.networks[0]).toMatchObject({ name: 'default', ssid: 'HomeNet', country: 'LV', band: '2g', net_id: HOME_NET, registrar: reg.url });
    expect(JSON.stringify(bare.db.prepare('SELECT * FROM networks').all())).not.toMatch(/pass/i);
    expectNoSecret(bare, joined);
  });

  it('device_share refuses a hub of another network, a board that is not provisioned here, and this hub itself', async () => {
    const reg = await target();
    const other = await member(0x3333);
    await reg.op('device_enroll', { ...ENROLL, alias: 'kitchen-cam' });
    const e = await frError(reg.op('device_share', { device: 'kitchen-cam', with_hub: other.url }));
    expect(e.code).toBe('INVALID_ARGS');
    expect(e.message).toContain(`the hub at ${other.url} is not in kitchen-cam's network (its net id is 13107; kitchen-cam's is ${HOME_NET})`);
    expect(e.hint).toContain('fr net join --hub');
    expect(other.hub.registry.get(DEV)).toBeNull();
    reg.hub.registry.touchHello(OTHER, { device_id: OTHER, addr: 0xfffe, net: 0, epoch: 7, chip: 13, chip_rev: 1, fw_id_prefix: '', descriptor_hash: 0, board_hash: 0, role: 'node', caps: 0, alias: '', alias_rev: 0, ota_state: 0, link: 'tcp' });
    expect((await frError(reg.op('device_share', { device: `id:${OTHER}`, with_hub: other.url }))).message).toContain('is not provisioned on this hub');
    (reg.hub as { run?: unknown }).run = { apiPort: Number(new URL(reg.url).port) };
    expect((await frError(reg.op('device_share', { device: 'kitchen-cam', with_hub: reg.url }))).message).toContain('is this hub itself');
  });

  it('device_provision --for-hub a hub of this network: both hubs hold the row, the board\'s hub is the other one', async () => {
    const l = lab();
    const twin = await target();
    twin.db.prepare('UPDATE networks SET net_id = ?').run(LAB_NET);
    twin.router.refreshNet();
    boardBoots(l, twin);
    const job = await provision(l, { profile: 'c6-pad', alias: 'kitchen-cam', for_hub: twin.url });
    expect(job.error).toBeUndefined();
    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({ device_id: DEV, alias: 'kitchen-cam', addr: 1, net: LAB_NET, hub_host: 'home-hub.local', for_hub: twin.url, shared: true, wifi: 'joined', via: 'tcp' });
    // This hub keeps its row: provisioned, not moved, its port still adopted; the record says who else has it.
    expect(l.hub.registry.get(DEV)).toMatchObject({ provisioned: true, addr: 1, net: LAB_NET, alias: 'kitchen-cam', tags: [] });
    const rec = provisionOf(l.db, DEV)!;
    expect(rec).toMatchObject({ hub_host: 'home-hub.local', shared_with: [twin.url], addr: 1, net: LAB_NET });
    expect(rec.for_hub).toBeUndefined();
    expect(createPortPolicy(l.db, join(home, 'no-config.json')).decide({ key: DEV, path: PORT, usbSerial: '1C:DB:D4:00:05:64', vid: '303a', pid: '1001' })).toEqual({ watch: true, why: 'adopted' });
    // The other hub holds the same identity, not as a new board waiting to be accepted.
    expect(twin.hub.registry.get(DEV)).toMatchObject({ provisioned: true, addr: 1, net: LAB_NET, alias: 'kitchen-cam', alias_rev: 1, tags: [], profile: 'c6-pad', chip: 'esp32c6' });
    expect(twin.router.presence(DEV)).toBe('online');
    // fr_ident: one identity, the other hub as the board's hub, this hub's Wi-Fi.
    const ident = identOf();
    expect(ident.fields).toMatchObject({ mac: DEV, addr: '1', net: String(LAB_NET), alias: 'kitchen-cam', ssid: 'LabNet', pass: '<SECRET>', hub_host: 'home-hub.local' });
    expect(l.published.filter((e) => e.type === 'device.provisioned').map((e) => e.device)).toEqual([DEV]);
    expect(jobLogs(l.db, job.job_id).join('\n')).toContain(`here and at ${twin.url} (one network); its hub is home-hub.local`);
    expectNoSecret(l, job);
    expectNoSecret(twin);
  });

  it('a member hub that flashes a board for the registrar lets the registrar give the address', async () => {
    const l = lab();
    const reg = await target();
    reg.db.prepare('UPDATE networks SET net_id = ?').run(LAB_NET);
    reg.router.refreshNet();
    await (HANDLERS.network_join({ hub: reg.url, force: false }, l.hub) as Promise<unknown>);
    // On its own it may not allocate ...
    const alone = await frError(provision(l, { profile: 'c6-pad' }));
    expect(alone.code).toBe('INVALID_ARGS');
    expect(alone.message).toContain("only that hub, the network's registrar, hands out addresses");
    expect(calls()).toEqual([]);
    // ... but for the registrar it asks the registrar, and keeps the row it answers.
    await reg.op('device_enroll', { ...ENROLL, device_id: OTHER }); // the registrar's addr 1 is taken
    boardBoots(l, reg);
    const job = await provision(l, { profile: 'c6-pad', alias: 'kitchen-cam', for_hub: reg.url });
    expect(job.error).toBeUndefined();
    expect(job.result).toMatchObject({ alias: 'kitchen-cam', addr: 2, net: LAB_NET, shared: true, for_hub: reg.url });
    expect(reg.hub.registry.get(DEV)).toMatchObject({ provisioned: true, addr: 2, alias: 'kitchen-cam', tags: ['new'] });
    expect(l.hub.registry.get(DEV)).toMatchObject({ provisioned: true, addr: 2, net: LAB_NET, alias: 'kitchen-cam', tags: [] });
    expect(identOf().fields).toMatchObject({ addr: '2', net: String(LAB_NET), hub_host: 'home-hub.local' });
  });
  it('with the hubs\' link (step 2.3): a member flashes a new board with an address from the registrar, and --for-hub a hub that replicates enrolls nothing there', async () => {
    const l = lab(); // the member: it has the USB port, the sidecar and the Wi-Fi password
    const reg = await target(); // the registrar
    reg.db.prepare('UPDATE networks SET net_id = ?').run(LAB_NET);
    reg.router.refreshNet();
    joinNetwork(l.db, LAB_NET, { url: reg.url, hub_host: 'home-hub.local' }, { name: 'default', ssid: 'LabNet', country: 'LV', band: 'auto' });
    writeNetworkKey(LAB_NET, newNetworkKey());
    // Each hub's link part, joined as a join leaves them (the registrar is slot 0), on loopback with a fast heartbeat.
    const parts: { hub: HubContext; peers: Peers }[] = [];
    for (const hub of [reg.hub, l.hub]) {
      const run = { nodeHost: '127.0.0.1', peerPort: 0 } as HubRunOptions;
      Object.assign(hub, { run });
      const peers = createPeers(() => hub, run, { timing: { pingMs: 60, awayMs: 300, backoffMinMs: 20, backoffMaxMs: 160, connectMs: 800, helloMs: 600 }, registry: { scanMs: 40, digestMs: 300 } });
      (hub as { peers?: Peers }).peers = peers;
      const stop = installPassing(hub);
      await peers.start();
      cleanups.push(async () => {
        stop();
        await peers.stop();
      });
      parts.push({ hub, peers });
    }
    const members = parts.map((p, slot) => ({ id: hubId(p.hub.db), name: slot === 0 ? 'home' : 'lab', host: '127.0.0.1', addr: '127.0.0.1', link_port: p.peers.status().link.port!, slot, joined_at: '2026-11-21T10:00:00.000Z' }));
    parts.forEach((p, slot) => {
      setHubName(p.hub.db, members[slot].name);
      replaceMembers(p.hub.db, members, 1);
      kvSet(p.hub.db, HUB_SLOT_KEY, String(slot));
    });
    await Promise.all(parts.map((p) => p.peers.refresh()));
    await until(() => parts.every((p) => p.peers.status().peers.every((v) => v.reachable) && p.peers.registry.replicates(p.peers.status().peers[0].id)), 4000, 'the two hubs linked');

    // A new board on the member's USB port: before this step it refused ("only that hub ... hands out addresses").
    boardBoots(l, null);
    const first = await provision(l, { profile: 'c6-pad', alias: 'kitchen-cam' }, { ...FAST, joinMs: 300 });
    expect(first.error).toBeUndefined();
    expect(first.status).toBe('completed');
    expect(first.result).toMatchObject({ device_id: DEV, alias: 'kitchen-cam', addr: 1, net: LAB_NET, hub_host: 'lab-mac.local' });
    expect(identOf().fields).toMatchObject({ addr: '1', net: String(LAB_NET), hub_host: 'lab-mac.local' });
    // The registrar gave the address and holds the row: provisioned once the member's flash was done.
    await until(() => reg.hub.registry.get(DEV)?.provisioned === true, 3000, 'the row at the registrar');
    expect(reg.hub.registry.get(DEV)).toMatchObject({ addr: 1, net: LAB_NET, alias: 'kitchen-cam', profile: 'c6-pad' });
    expect(l.hub.registry.get(DEV)).toMatchObject({ addr: 1, net: LAB_NET, alias: 'kitchen-cam', provisioned: true });
    // The registrar never enrolled it (no record of its own, no enrollment event): the row came by replication.
    expect(provisionOf(reg.db, DEV)).toBeNull();
    expect(reg.published.filter((e) => e.type === 'device.provisioned').map((e) => [e.fields?.replicated, e.fields?.enrolled])).toEqual([[true, undefined]]);

    // The same board for the registrar as its first hub: nothing is enrolled there, and fr_ident names that hub from
    // the member list (here its loopback address).
    boardBoots(l, reg);
    const again = await provision(l, { profile: 'c6-pad', for_hub: reg.url });
    expect(again.error).toBeUndefined();
    expect(again.result).toMatchObject({ device_id: DEV, alias: 'kitchen-cam', addr: 1, net: LAB_NET, hub_host: '127.0.0.1', for_hub: reg.url, shared: true, wifi: 'joined' });
    expect(identOf().fields).toMatchObject({ addr: '1', net: String(LAB_NET), hub_host: '127.0.0.1' });
    expect(jobLogs(l.db, again.job_id).join('\n')).toContain('replicated to hub home (one network): no second enrollment there');
    expect(provisionOf(reg.db, DEV)).toBeNull();
    expect(reg.published.filter((e) => e.fields?.enrolled === true)).toEqual([]);
    expect(provisionOf(l.db, DEV)).toMatchObject({ shared_with: [reg.url], hub_host: '127.0.0.1' });
    // device_share toward it has nothing to do.
    expect(await HANDLERS.device_share({ device: 'kitchen-cam', with_hub: reg.url }, l.hub)).toMatchObject({ replicated: true, hub_host: '127.0.0.1' });
    // The registrar away: a board with no address is refused before the job starts, and the answer says what is not reachable.
    l.db.prepare('DELETE FROM devices').run();
    await parts[0].peers.stop();
    await until(() => !parts[1].peers.status().peers[0].reachable, 2000, 'the registrar to be away');
    const refused = await frError(provision(l, { profile: 'c6-pad' }));
    expect(refused.code).toBe('HUB_UNREACHABLE');
    expect(refused.message).toContain("only that hub, the network's registrar, hands out addresses, and it is not reachable over the hubs' link now");
    expectNoSecret(l, first, again);
  });
});
