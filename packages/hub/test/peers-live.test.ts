// Live data across the hubs' link (design multi-hub-m2 §8, §17, step 2.4), without hub processes: each hub here is a
// router with fake boards, a job runner, the peers part, `/ws`, `/app` and the op dispatch point in this process, joined
// by TLS on loopback with a fast heartbeat.
//   - events: every type that crosses is at the other hub's `/ws` and `/app`, marked with its hub, in that hub's own
//     seq order; the types that do not cross stay; with three hubs nothing arrives twice; nothing relayed is stored;
//   - state: a board another hub holds shows its last values to a `/ws` subscription and an `/app` welcome;
//   - a job another hub runs shows its progress on `/ws`; a prompt of a wait there is in this hub's pending list;
//   - the waits: by the cursor's hub, a board on a peer, a board on no hub that appears on one, a board that moves
//     during the wait, boards on two hubs, a hub that goes away mid-wait, a cursor of another hub;
//   - a peer that relays no events (a hub of step 2.3);
//   - a flood through a slow link: the heartbeat lives, the queue is bounded, drops are counted and said;
//   - every `event` message against the network key, the Wi-Fi password and the Wi-Fi's name;
//   - streams: `/app/stream` at one hub for a board another holds, the bytes compared; the client leaving; the link
//     dropping and the board coming to this hub; the board moving to a third hub; a slow link and a slow client (blocks
//     dropped, counted and said, nothing buffered); a hub that relays no streams.
// peers-live-queue.test.ts has the queue alone; interop-live.test.ts runs hub processes and the C++ node (streams).

import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type AddressInfo, createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AT_HEADER, FrError, type HubEvent, type Result, slotRun } from '@fractonica/protocol';
import { encodeMember, findCap } from '@fractonica/protocol/gen';

import { type AppServerPart, createAppServer } from '../src/apps/server.ts';
import type { HubContext, HubRunOptions, StaticSite } from '../src/context.ts';
import { HUB_SLOT_KEY, kvSet } from '../src/db.ts';
import { buildServer } from '../src/http.ts';
import { joinNetwork, writeNetwork, writeWifiPassword } from '../src/network.ts';
import { hubId, setHubName } from '../src/peers/identity.ts';
import { createPeers, type Peers, peersView } from '../src/peers/index.ts';
import { newNetworkKey, writeNetworkKey } from '../src/peers/key.ts';
import type { PeerLinkTiming } from '../src/peers/link.ts';
import { replaceMembers } from '../src/peers/members.ts';
import { installPassing } from '../src/peers/passing.ts';
import { createPrompts } from '../src/prompts.ts';
import { nowUs } from '../src/ring.ts';
import { createWsServer, type WsHub, type WsSocket } from '../src/web/ws.ts';
import { liveStreams, type LiveStream } from '../src/streams/live.ts';
import { type FakeNode, type NetRig, netRig, until } from './fake-node.ts';

const NET = 0x5252;
const SSID = 'cellar-wifi-name';
const PASSWORD = 'staple-battery-horse';
const TOKEN = 'test-token-0123456789abcdef0123456789';
const FAST: Partial<PeerLinkTiming> = { pingMs: 60, awayMs: 400, backoffMinMs: 20, backoffMaxMs: 160, connectMs: 800, helloMs: 600 };
const NOOP: StaticSite = { start() {}, stop() {}, routes() {}, dashboard: () => ({ url: '', built: false, stale: false }) };
const BUTTON = findCap('fr.button')!;
const DOWN = BUTTON.events.find((m) => m.name === 'down')!.id;
const PRESSED = BUTTON.properties.find((m) => m.name === 'pressed')!.id;
const BLINK = findCap('fr.led')!.commands.find((c) => c.name === 'blink')!.id;
const body = (cap: string, part: 'event' | 'state' | 'args', member: string, v: Record<string, unknown>) => (encodeMember(cap, part, member, v) as { value: Uint8Array }).value;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PAD = { mac: 'aabbcc1a0001', addr: 0x21, alias: 'pad-one' };
const LAMP = { mac: 'aabbcc1a0002', addr: 0x22, alias: 'lamp-two' };

let home = '';
let tap = '';
let key: Buffer;
const saved = { home: process.env.FR_HOME, tap: process.env.FR_TEST_PEER_EVENTS_TAP };
const cleanups: (() => unknown)[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'fr-peers-live-'));
  tap = join(home, 'events-tap.jsonl');
  process.env.FR_HOME = home;
  process.env.FR_TEST_PEER_EVENTS_TAP = tap;
  key = newNetworkKey();
  writeNetworkKey(NET, key);
  writeWifiPassword('default', PASSWORD);
});
afterAll(() => {
  for (const [k, v] of [['FR_HOME', saved.home], ['FR_TEST_PEER_EVENTS_TAP', saved.tap]] as const) {
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

/** A `/ws` client as the server sees one: the frames it was sent. */
class WsClient implements WsSocket {
  frames: Record<string, unknown>[] = [];
  bufferedAmount = 0;
  #in: { message(text: string): void; close(): void };

  constructor(ws: WsHub) {
    this.#in = ws.open(this);
  }

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.#in.close();
  }

  sub(id: string, spec: Record<string, unknown>): void {
    this.#in.message(JSON.stringify({ op: 'sub', id, ...spec }));
  }

  /** The events sent, new ones and snapshots apart. */
  events(snapshot = false): HubEvent[] {
    return this.frames.filter((f) => f.t === 'ev' && (f.snapshot === true) === snapshot).map((f) => f.e as HubEvent);
  }

  of(t: string): Record<string, unknown>[] {
    return this.frames.filter((f) => f.t === t);
  }
}

interface LiveHub {
  r: NetRig;
  hub: HubContext;
  peers: Peers;
  ws: WsHub;
  app: AppServerPart;
  id: string;
  name: string;
  url: string;
  /** Stops this hub's link (as a hub that went away) without closing the rest. */
  unlink(): Promise<void>;
  call<T = unknown>(op: string, input?: Record<string, unknown>, at?: string): Promise<Result<T>>;
  ok<T = unknown>(op: string, input?: Record<string, unknown>, at?: string): Promise<Result<T> & { data: T }>;
  /** A board as provisioned on every hub of the test, and its FakeNode connecting to this hub. */
  board(dev: { mac: string; addr: number; alias: string }): FakeNode;
}

const hubs: LiveHub[] = [];

async function liveHub(name: string, slot: number, opts: { live?: 'on' | 'off'; events?: Parameters<typeof createPeers>[2] extends infer O ? (O extends { events?: infer E } ? E : never) : never; linkPort?: () => number } = {}): Promise<LiveHub> {
  const h = { peers: null as unknown as Peers };
  const r = await netRig({
    hubEpoch: slot * 0x4000 + 1,
    run: slotRun(slot, 1),
    heldOverTcp: (id) => h.peers?.heldOverTcp(id) ?? null,
    heldByPeer: (id) => h.peers?.holder(id)?.name ?? null,
  });
  // No USB port in this rig: a port selector names none (the log ops then take the selector for the registry's).
  (r.serial as unknown as { resolve(sel: string): never }).resolve = (sel) => {
    throw new FrError('NOT_FOUND', `no attached port matches ${sel}`);
  };
  setHubName(r.db, name);
  writeNetwork(r.db, { ssid: SSID, bssid: null, country: null });
  r.db.prepare('UPDATE networks SET net_id = ?').run(NET);
  if (slot > 0) {
    joinNetwork(r.db, NET, { url: 'http://127.0.0.1:1', hub_host: 'hub-a.local' }, { name: 'default', ssid: SSID, country: null, band: 'auto' });
  }
  r.router.refreshNet();
  const run = { apiHost: '127.0.0.1', apiPort: 0, nodeHost: '127.0.0.1', nodePort: 0, nodeHttpPort: 0, noAdvert: true, serial: false, peerPort: 0 } as HubRunOptions;
  let hub!: HubContext;
  const ctx = () => hub;
  const app = createAppServer(ctx, run, { token: TOKEN });
  const wsServer = createWsServer(ctx, run);
  h.peers = createPeers(ctx, run, { timing: FAST, registry: { scanMs: 40, digestMs: 250 }, ...(opts.live ? { live: opts.live } : {}), ...(opts.events ? { events: opts.events } : {}) });
  hub = { ...r.hub, startedAt: Date.now(), run, appServer: app, wsServer, staticSite: NOOP, prompts: createPrompts(ctx, run), peers: h.peers } as HubContext;
  await app.start();
  await wsServer.start();
  const stopPassing = installPassing(hub);
  await h.peers.start();
  const server = buildServer(hub, 0);
  await server.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  let linked = true;
  const unlink = async () => {
    if (linked) {
      linked = false;
      stopPassing();
      await h.peers.stop();
    }
  };
  cleanups.push(async () => {
    await app.stop();
    await wsServer.stop();
    await server.close();
    await unlink();
    await r.close();
  });
  const call = async <T,>(op: string, input: Record<string, unknown> = {}, at?: string): Promise<Result<T>> => {
    const res = await fetch(`${url}/api/v1/op/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fr-client': 'cli', ...(at ? { [AT_HEADER]: at } : {}) }, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000) });
    return (await res.json()) as Result<T>;
  };
  const me: LiveHub = {
    r,
    hub,
    peers: h.peers,
    ws: wsServer.ws,
    app,
    id: hubId(r.db),
    name,
    url,
    unlink,
    call,
    async ok<T>(op: string, input: Record<string, unknown> = {}, at?: string) {
      const res = await call<T>(op, input, at);
      if (!res.ok) {
        throw new Error(`${name} ${op}: ${JSON.stringify(res.error)}`);
      }
      return res as Result<T> & { data: T };
    },
    board(dev) {
      for (const x of hubs) {
        x.r.registry.add({ device_id: dev.mac, addr: dev.addr, alias: dev.alias, provisioned: true, net: NET });
      }
      const n = r.pad({ mac: dev.mac, addr: dev.addr, alias: dev.alias, net: NET, hbMs: 100 });
      return n;
    },
  };
  hubs.push(me);
  cleanups.push(() => void hubs.splice(hubs.indexOf(me), 1));
  return me;
}

/** The member list a join would have left in each hub's db; the first is the registrar. `via`: the port to dial a hub at. */
async function joined(list: LiveHub[], via: (h: LiveHub) => number = (h) => h.peers.status().link.port!): Promise<void> {
  const members = list.map((h, slot) => ({ id: h.id, name: h.name, host: '127.0.0.1', addr: '127.0.0.1', link_port: via(h), slot, joined_at: '2026-11-21T10:00:00.000Z' }));
  list.forEach((h, slot) => {
    replaceMembers(h.r.db, members, 1);
    kvSet(h.r.db, HUB_SLOT_KEY, String(slot));
  });
  await Promise.all(list.map((h) => h.peers.refresh()));
  await until(() => list.every((h) => h.peers.status().peers.length === list.length - 1 && h.peers.status().peers.every((p) => p.reachable)), 5000, 'every pair linked');
}

const tapped = (): { dir: 'tx' | 'rx'; peer: string; msg: { t: string; events?: HubEvent[]; jobs?: unknown[]; snapshot?: boolean; dropped?: number } }[] =>
  existsSync(tap)
    ? readFileSync(tap, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

/** Raw `/app` frames at a hub (Node's WebSocket): everything after the hello. */
async function appFrames(h: LiveHub): Promise<Record<string, unknown>[]> {
  const ws = new WebSocket(`${h.url.replace('http', 'ws')}/app`);
  const frames: Record<string, unknown>[] = [];
  ws.addEventListener('message', (e) => frames.push(JSON.parse(String(e.data)) as Record<string, unknown>));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('no /app')));
  });
  ws.send(JSON.stringify({ t: 'hello', v: 1, token: TOKEN, catalog_hash: 0, registry_rev: null }));
  cleanups.push(() => ws.close());
  await until(() => frames.some((f) => f.t === 'welcome'), 5000, 'the /app welcome');
  return frames;
}

describe("events across the hubs' link (design multi-hub-m2 step 2.4)", () => {
  it("what a board on hub A does is at hub B's /ws and /app, marked with its hub, in hub B's own order, and stored only at hub A", async () => {
    const a = await liveHub('hub-a', 0);
    const b = await liveHub('hub-b', 1);
    await joined([a, b]);
    const client = new WsClient(b.ws);
    client.sub('all', { events: {}, jobs: true });
    const pad = a.board(PAD);
    const app = await appFrames(b);
    await pad.connected(a.r.events, 10_000);
    // Presence, then a STATE, then an EVENT, as the board sends them.
    pad.state(1, PRESSED, body('fr.button', 'state', 'pressed', { pressed: true }));
    pad.event(1, DOWN, new Uint8Array(0), { prio: 'realtime' });
    await until(() => client.events().some((e) => e.type === 'boot.down'), 5000, 'boot.down at hub B');
    const got = client.events().filter((e) => e.device === PAD.mac);
    expect(got.map((e) => e.type)).toEqual(expect.arrayContaining(['device.online', 'device.link', 'boot.pressed', 'boot.down']));
    // Marked with the hub they came from; hub B's own seq and cursor, increasing; the cursor at hub A kept beside.
    const mine = b.hub.logs.run;
    for (const e of got) {
      expect(e.hub).toBe('hub-a');
      expect(e.cursor).toBe(`c:${mine}.${e.seq}`);
      expect(e.hub_cursor).toMatch(new RegExp(`^c:${a.hub.logs.run}\\.\\d+$`));
      expect(e.alias).toBe(PAD.alias);
    }
    expect(got.map((e) => e.seq)).toEqual([...got.map((e) => e.seq)].sort((x, y) => x - y));
    // The same events, in the same order, as hub A's own /ws client saw them.
    const atA = a.r.events.query({ devices: [PAD.mac], limit: 100 });
    expect(got.map((e) => e.type)).toEqual(atA.map((e) => e.type));
    expect(got.map((e) => e.hub_cursor)).toEqual(atA.map((e) => e.cursor));
    // Stored once, at the hub that holds the board: hub B's table has none of them, its memory has them for a read.
    b.r.events.flush();
    expect(b.r.db.prepare('SELECT COUNT(*) AS n FROM events WHERE device = ?').get(PAD.mac)).toEqual({ n: 0 });
    expect(b.r.events.query({ devices: [PAD.mac], limit: 100 })).toEqual([]);
    expect(b.r.events.query({ devices: [PAD.mac], limit: 100, relayed: true }).map((e) => e.type)).toEqual(atA.map((e) => e.type));
    // events_read at hub B, in hub B's cursor space: the dashboard's seed, and what a `gap` is re-read from.
    const page = await b.ok<{ events: HubEvent[]; next_cursor: string }>('events_read', { max_events: 50 });
    expect(page.at).toBeUndefined();
    expect(page.data.events.filter((e) => e.device === PAD.mac).map((e) => [e.type, e.hub])).toEqual(atA.map((e) => [e.type, 'hub-a']));
    expect(page.data.next_cursor.startsWith(`c:${mine}.`)).toBe(true);
    // An app connected to hub B: the board is in its welcome's fleet, and its frames say where they came from.
    await until(() => app.some((f) => f.t === 'evt' && f.evt === 'down'), 5000, 'the evt frame');
    expect(app.find((f) => f.t === 'evt')).toMatchObject({ dev: PAD.mac, inst: 'boot', evt: 'down', hub: 'hub-a' });
    expect(app.find((f) => f.t === 'state')).toMatchObject({ dev: PAD.mac, inst: 'boot', prop: 'pressed', value: true, hub: 'hub-a' });
    expect(app.find((f) => f.t === 'presence')).toMatchObject({ dev: PAD.mac, state: 'online', hub: 'hub-a' });
    // The other way round at once: hub A hears nothing of its own events back.
    expect(a.r.events.query({ limit: 500, relayed: true }).filter((e) => e.hub !== undefined)).toEqual([]);
    // fr hub peers on both.
    const viewA = peersView(a.hub).peers.find((p) => p.name === 'hub-b')!;
    const viewB = peersView(b.hub).peers.find((p) => p.name === 'hub-a')!;
    expect(viewA.events).toMatchObject({ speaks: true, sent: atA.length, received: 0, dropped: 0 });
    expect(viewB.events).toMatchObject({ speaks: true, received: atA.length, sent: 0, dropped: 0, mirrored: 1 });
    expect(a.peers.warnings!()).toEqual([]);
    expect(b.peers.warnings!()).toEqual([]);
  }, 60_000);

  it('each type: what crosses and what stays', async () => {
    const a = await liveHub('hub-a', 0);
    const b = await liveHub('hub-b', 1);
    await joined([a, b]);
    const client = new WsClient(b.ws);
    client.sub('all', { events: {} });
    const ports = new WsClient(b.ws);
    ports.sub('p', { ports: true });
    a.board(PAD);
    const publish = (type: string, device: boolean, fields: Record<string, unknown> = {}) => a.r.events.publish({ type, ...(device ? { device: PAD.mac, alias: PAD.alias } : {}), t_hub_us: nowUs(), fields });
    const crossing = ['msg', 'op.called', 'ota.job.state', 'stream.started', 'stream.ended', 'audio.stream_started', 'audio.stream_ended', 'hil.edge', 'hil.frame', 'cell.session', 'wiring.step', 'node.boot', 'device.suspect'];
    for (const t of crossing) {
      publish(t, true, { n: 1 });
    }
    publish('job.state', false, { job_id: 'j_000000000001', kind: 'build', status: 'working', targets: [] });
    publish('hub.prompt', false, { prompt_id: 'p_0000000a', text: 'Press BOOT', types: ['boot.down'], expires_at: new Date(Date.now() + 60_000).toISOString() });
    // These stay: the registry replicates and announces them itself; a port is one machine's; a warning is one hub's own.
    const staying = ['device.provisioned', 'registry.drift', 'port.attached', 'port.state', 'port.leased', 'port.released', 'port.detached'];
    for (const t of staying) {
      publish(t, true, { path: '/dev/cu.fake' });
    }
    publish('hub.warning', false, { code: 'loop_delay' });
    publish('time.threshold', false, { level: 'helion' });
    publish('made.up', false, {});
    publish('last.one', true, {}); // the marker: everything before it has crossed
    await until(() => client.events().some((e) => e.type === 'last.one'), 5000, 'the marker');
    const types = client.events().filter((e) => e.hub === 'hub-a').map((e) => e.type);
    expect(types).toEqual([...crossing, 'job.state', 'hub.prompt', 'last.one']);
    expect(ports.events()).toEqual([]); // a ports sub is this machine's ports
    // The peer's pending prompt is in this hub's list until it ends there.
    expect(b.peers.events.prompts()).toEqual([expect.objectContaining({ prompt_id: 'p_0000000a', text: 'Press BOOT', hub: 'hub-a' })]);
    publish('hub.prompt_done', false, { prompt_id: 'p_0000000a', outcome: 'matched' });
    await until(() => b.peers.events.prompts().length === 0, 5000, 'the prompt to end');
    // A session ending at one hub while another holds the board says where the board is, and an app is not told "offline".
    expect(client.events().find((e) => e.type === 'device.suspect')!.fields).toEqual({ n: 1 });
  }, 60_000);

  it('three hubs: every event arrives once at each of the others, and nothing relayed is sent on', async () => {
    const a = await liveHub('hub-a', 0);
    const b = await liveHub('hub-b', 1);
    const c = await liveHub('hub-c', 2);
    await joined([a, b, c]);
    const atB = new WsClient(b.ws);
    const atC = new WsClient(c.ws);
    atB.sub('all', { events: {} });
    atC.sub('all', { events: {} });
    const pad = a.board(PAD);
    await pad.connected(a.r.events, 10_000);
    for (let i = 0; i < 20; i++) {
      pad.event(1, DOWN, new Uint8Array(0), { prio: 'realtime' });
    }
    await until(() => a.r.events.query({ devices: [PAD.mac], types: ['boot.down'], limit: 100 }).length === 20, 5000, '20 events at hub A');
    await until(() => atB.events().filter((e) => e.type === 'boot.down').length >= 20 && atC.events().filter((e) => e.type === 'boot.down').length >= 20, 5000, '20 events at B and C');
    await sleep(300); // anything relayed a second time would be here by now
    for (const client of [atB, atC]) {
      const downs = client.events().filter((e) => e.type === 'boot.down');
      expect(downs).toHaveLength(20);
      expect(new Set(downs.map((e) => e.hub_cursor)).size).toBe(20);
      expect(downs.every((e) => e.hub === 'hub-a')).toBe(true);
    }
    // Hubs B and C sent nothing: all they had were hub A's events.
    for (const h of [b, c]) {
      expect(h.peers.status().counters.events_sent).toBe(0);
      expect(h.peers.status().counters.events_bad).toBe(0);
    }
    const sent = a.peers.status().counters.events_sent;
    expect(b.peers.status().counters.events_received + c.peers.status().counters.events_received).toBe(sent);
    // Every `event` message a hub wrote carried only its own events (none marked with a hub).
    for (const t of tapped().filter((x) => x.dir === 'tx')) {
      expect((t.msg.events ?? []).filter((e) => e.hub !== undefined)).toEqual([]);
    }
  }, 60_000);

  it("a board another hub holds: its last values on subscribe, `online` in a selector, its place in an app's welcome", async () => {
    const a = await liveHub('hub-a', 0);
    const b = await liveHub('hub-b', 1);
    const pad = a.board(PAD);
    await pad.connected(a.r.events, 10_000);
    pad.state(1, PRESSED, body('fr.button', 'state', 'pressed', { pressed: true }));
    await until(() => a.r.router.info(PAD.mac)?.properties['boot.pressed'] === true, 3000, 'the value at hub A');
    // The link comes up after the value was set: the snapshot brings it.
    await joined([a, b]);
    await until(() => b.peers.events.properties(PAD.mac)?.['boot.pressed'] === true, 5000, 'the mirror at hub B');
    const client = new WsClient(b.ws);
    client.sub('s', { events: { types: 'boot.*', selector: 'online' } });
    expect(client.events(true).map((e) => [e.type, e.device, e.hub, e.fields])).toEqual([['boot.pressed', PAD.mac, 'hub-a', { pressed: true }]]);
    expect(client.of('err')).toEqual([]);
    const frames = await appFrames(b);
    const welcome = frames.find((f) => f.t === 'welcome') as { devices: { id: string; online: boolean; presence: string; hub?: string; props: Record<string, Record<string, unknown>> }[] };
    expect(welcome.devices.find((d) => d.id === PAD.mac)).toMatchObject({ online: true, presence: 'online', hub: 'hub-a', props: { boot: { pressed: true } } });
    // It changes: the mirror follows, live.
    pad.state(1, PRESSED, body('fr.button', 'state', 'pressed', { pressed: false }));
    await until(() => b.peers.events.properties(PAD.mac)?.['boot.pressed'] === false, 5000, 'the new value');
    // Its session there ends: what it last said is forgotten here, and the app hears it went offline.
    pad.close();
    await until(() => b.peers.holder(PAD.mac) === null, 8000, 'the board gone from hub A');
    expect(b.peers.events.properties(PAD.mac)).toBeNull();
    await until(() => frames.some((f) => f.t === 'presence' && f.state === 'offline'), 5000, 'the presence frame');
  }, 60_000);

  it('a job another hub runs shows on /ws, and a board that changes hub is not told offline', async () => {
    const a = await liveHub('hub-a', 0);
    const b = await liveHub('hub-b', 1);
    await joined([a, b]);
    const client = new WsClient(b.ws);
    client.sub('j', { jobs: true, events: { types: 'job.state,device.*' } });
    let release!: () => void;
    const job = a.r.jobs.start('build', ['c6-pad'], [], async (ctx) => {
      ctx.stage('compile');
      ctx.progress(40, 'halfway');
      await new Promise<void>((r) => (release = r));
      return { ok: true };
    });
    await until(() => client.of('job').some((f) => f.job_id === job.job_id && (f.progress as { pct?: number } | undefined)?.pct === 40), 5000, 'the progress frame');
    expect(client.of('job').filter((f) => f.job_id === job.job_id).every((f) => f.hub === 'hub-a')).toBe(true);
    // A client that subscribes while it runs gets it at once, with the hub.
    const late = new WsClient(b.ws);
    late.sub('j', { jobs: true });
    expect(late.of('job')).toEqual([expect.objectContaining({ job_id: job.job_id, status: 'working', stage: 'compile', hub: 'hub-a' })]);
    release();
    await until(() => client.of('job').some((f) => f.job_id === job.job_id && f.status === 'completed'), 5000, 'the end frame');
    expect(client.events().filter((e) => e.type === 'job.state' && e.fields?.job_id === job.job_id).map((e) => [e.fields?.status, e.hub])).toEqual([['queued', 'hub-a'], ['working', 'hub-a'], ['working', 'hub-a'], ['completed', 'hub-a']]);
    expect(b.peers.events.jobs()).toEqual([]);

    // The board moves from hub A to hub B: hub B's own device.online, then hub A's device.offline saying where it is.
    const pad = a.board(PAD);
    const app = await appFrames(b);
    await pad.connected(a.r.events, 10_000);
    await until(() => b.peers.holder(PAD.mac)?.name === 'hub-a', 5000, 'the board at hub A');
    const moved = b.r.pad({ mac: PAD.mac, addr: PAD.addr, alias: PAD.alias, net: NET, hbMs: 100, epoch: 2 });
    await moved.connected(b.r.events, 10_000);
    pad.silent = true;
    await until(() => client.events().some((e) => e.type === 'device.offline' && e.device === PAD.mac), 10_000, "hub A's device.offline");
    const off = client.events().find((e) => e.type === 'device.offline' && e.device === PAD.mac)!;
    expect(off.hub).toBe('hub-a');
    expect(off.fields).toMatchObject({ at: 'hub-b' });
    await sleep(100);
    expect(app.filter((f) => f.t === 'presence' && f.dev === PAD.mac && f.state !== 'online')).toEqual([]);
    // And back: hub B's own device.offline says the board is at hub A.
    const back = a.r.pad({ mac: PAD.mac, addr: PAD.addr, alias: PAD.alias, net: NET, hbMs: 100, epoch: 3 });
    await back.connected(a.r.events, 10_000);
    moved.silent = true;
    await until(() => b.r.events.query({ devices: [PAD.mac], types: ['device.offline'], limit: 10 }).length === 1, 10_000, "hub B's own device.offline");
    expect(b.r.events.query({ devices: [PAD.mac], types: ['device.offline'], limit: 10 })[0].fields).toMatchObject({ at: 'hub-a' });
    expect(app.filter((f) => f.t === 'presence' && f.dev === PAD.mac && f.state === 'offline')).toEqual([]);
    const list = await b.ok<{ devices: { alias: string; presence: string; at: string | null }[] }>('device_list', {});
    expect(list.data.devices.find((d) => d.alias === PAD.alias)).toMatchObject({ presence: 'online', at: 'hub-a' });
  }, 60_000);
});

interface Waited {
  matched: boolean;
  events: HubEvent[];
  cursor: string;
}
interface DeviceWait {
  devices: { alias: string; presence: string; at?: string }[];
}

describe("the waits across the hubs' link (design multi-hub-m2 step 2.4)", () => {
  const down = (n: FakeNode) => n.event(1, DOWN, new Uint8Array(0), { prio: 'realtime' });
  /** A cursor of hub `h`: the envelope's, of an op it ran itself. */
  const cursorOf = async (h: LiveHub) => (await h.ok('device_list', {})).cursor;

  it("wait_for_event runs at the hub whose cursor `since` is: here over what the peers relay, or at the board's hub", async () => {
    const a = await liveHub('hub-a', 0);
    const b = await liveHub('hub-b', 1);
    await joined([a, b]);
    const pad = a.board(PAD);
    pad.handlers.set(`2/${BLINK}`, () => ({}));
    await pad.connected(a.r.events, 10_000);
    await until(() => b.peers.holder(PAD.mac)?.name === 'hub-a', 5000, 'the board at hub A');

    // Hub B's own cursor, the event before the wait starts: found in what hub B kept of the relay.
    const since = await cursorOf(b);
    expect(since.startsWith(`c:${b.hub.logs.run}.`)).toBe(true);
    down(pad);
    await until(() => b.r.events.query({ types: ['boot.down'], limit: 5, relayed: true }).length === 1, 5000, 'the relayed event');
    const backlog = await b.ok<Waited>('wait_for_event', { types: 'boot.down', selector: PAD.alias, since, timeout_s: 10 });
    expect(backlog.at).toBeUndefined(); // it ran here
    expect(backlog.data.events.map((e) => [e.type, e.hub])).toEqual([['boot.down', 'hub-a']]);
    expect(backlog.data.cursor.startsWith(`c:${b.hub.logs.run}.`)).toBe(true);

    // The event after the wait started: live.
    const since2 = backlog.data.cursor;
    const waiting = b.ok<Waited>('wait_for_event', { types: 'boot.down', selector: PAD.alias, since: since2, timeout_s: 10 });
    await sleep(150);
    down(pad);
    expect((await waiting).data.events.map((e) => e.hub)).toEqual(['hub-a']);

    // A cursor of hub A (the answer of an op that hub ran for the board): the wait is passed to hub A whole.
    const sent = await b.ok<{ results: { status: string }[] }>('command_send', { selector: PAD.alias, command: 'status.blink', args: {} });
    expect(sent.at).toBe('hub-a');
    expect(sent.cursor.startsWith(`c:${a.hub.logs.run}.`)).toBe(true);
    down(pad);
    const there = await b.ok<Waited>('wait_for_event', { types: 'boot.down', selector: PAD.alias, since: sent.cursor, timeout_s: 10 });
    expect(there.at).toBe('hub-a');
    expect(there.data.events.map((e) => [e.type, e.hub])).toEqual([['boot.down', undefined]]); // hub A's own stored event
    expect(there.data.cursor.startsWith(`c:${a.hub.logs.run}.`)).toBe(true);
    // The same for a read: events_read since hub A's cursor reads hub A's store, wherever it is asked.
    const page = await b.ok<{ events: HubEvent[]; next_cursor: string }>('events_read', { since: sent.cursor, types: 'boot.down', max_events: 10 });
    expect(page.at).toBe('hub-a');
    expect(page.data.events).toHaveLength(1);
    expect(page.data.events[0].hub).toBeUndefined();

    // A cursor of another hub is never read as a position of this hub's: named and refused when this hub is told to run it.
    const forced = await b.call('wait_for_event', { types: 'boot.down', selector: PAD.alias, since: sent.cursor, timeout_s: 1 }, 'hub-b');
    expect(forced.error).toMatchObject({ code: 'INVALID_ARGS', details: { cursor_hub: 'hub-a' } });
    expect(forced.error!.message).toContain("is hub hub-a's, not this hub's");
    const read = await b.call('events_read', { since: sent.cursor, max_events: 10 }, 'hub-b');
    expect(read.error).toMatchObject({ code: 'INVALID_ARGS', details: { cursor_hub: 'hub-a' } });
    // /ws likewise: a `since` of another hub is an `err` naming it, not a resume from the wrong place.
    const client = new WsClient(b.ws);
    client.sub('x', { events: { since: sent.cursor } });
    expect(client.of('err')).toEqual([expect.objectContaining({ id: 'x', code: 'INVALID_ARGS', message: expect.stringContaining("is hub hub-a's") })]);
    // A cursor of an earlier run of this hub is HUB_RESTARTED, as before.
    const old = await b.call('events_read', { since: `c:${b.hub.logs.run - 1}.5`, max_events: 10 });
    expect(old.error).toMatchObject({ code: 'HUB_RESTARTED' });
  }, 60_000);

  it('the hard cases: a board on no hub that appears on a peer, a board that moves during the wait, boards on two hubs', async () => {
    const a = await liveHub('hub-a', 0);
    const b = await liveHub('hub-b', 1);
    const c = await liveHub('hub-c', 2);
    await joined([a, b, c]);
    const pad = a.board(PAD);
    const lamp = c.board(LAMP);

    // On no hub when the wait starts; it comes up at hub A while hub B waits.
    const appear = b.ok<DeviceWait>('wait_for_device', { selector: PAD.alias, state: 'online', timeout_s: 15 });
    await sleep(200);
    await pad.connected(a.r.events, 10_000);
    expect((await appear).data.devices).toEqual([expect.objectContaining({ alias: PAD.alias, presence: 'online', at: 'hub-a' })]);
    // With `since`: it must have come online after the cursor, wherever that happened.
    const since = await cursorOf(b);
    const again = await b.call<DeviceWait>('wait_for_device', { selector: PAD.alias, state: 'online', since, timeout_s: 1 });
    expect(again.error).toMatchObject({ code: 'TIMEOUT' }); // online, but not since the cursor
    await lamp.connected(c.r.events, 10_000);
    const both = await b.ok<DeviceWait>('wait_for_device', { selector: `${PAD.alias},${LAMP.alias}`, state: 'online', timeout_s: 10 });
    expect(both.data.devices.map((d) => [d.alias, d.presence, d.at])).toEqual([[PAD.alias, 'online', 'hub-a'], [LAMP.alias, 'online', 'hub-c']]);

    // Boards on two hubs (A and C), waited for at a third (B): one event of each.
    const cur = await cursorOf(b);
    const each = b.ok<Waited>('wait_for_event', { types: 'boot.down', selector: `${PAD.alias},${LAMP.alias}`, per_device: true, since: cur, timeout_s: 10 });
    await sleep(100);
    down(pad);
    down(lamp);
    expect((await each).data.events.map((e) => [e.alias, e.hub]).sort()).toEqual([[LAMP.alias, 'hub-c'], [PAD.alias, 'hub-a']]);

    // The board moves from hub A to hub B during the wait: one event from each place, both counted.
    const cur2 = await cursorOf(b);
    const two = b.ok<Waited>('wait_for_event', { types: 'boot.down', selector: PAD.alias, count: 2, since: cur2, timeout_s: 20 });
    await sleep(100);
    down(pad);
    await until(() => b.r.events.query({ afterSeq: Number(cur2.split('.')[1]), types: ['boot.down'], devices: [PAD.mac], limit: 5, relayed: true }).length === 1, 5000, 'the first event');
    const moved = b.r.pad({ mac: PAD.mac, addr: PAD.addr, alias: PAD.alias, net: NET, hbMs: 100, epoch: 2 });
    await moved.connected(b.r.events, 10_000);
    pad.silent = true;
    down(moved);
    const got = await two;
    expect(got.data.events.map((e) => e.hub)).toEqual(['hub-a', undefined]);
    // It went offline nowhere: its session with hub A ended while hub B holds it.
    const cur3 = await cursorOf(b);
    await until(() => a.r.router.presence(PAD.mac) === 'offline', 10_000, 'hub A to drop the session');
    const off = await b.call<DeviceWait>('wait_for_device', { selector: PAD.alias, state: 'offline', since: cur3, timeout_s: 1 });
    expect(off.error).toMatchObject({ code: 'TIMEOUT' });
  }, 90_000);

  it('a hub that goes away mid-wait ends the wait with a retryable error naming it, not at its timeout', async () => {
    const a = await liveHub('hub-a', 0);
    const b = await liveHub('hub-b', 1);
    await joined([a, b]);
    const pad = a.board(PAD);
    pad.handlers.set(`2/${BLINK}`, () => ({}));
    await pad.connected(a.r.events, 10_000);
    await until(() => b.peers.holder(PAD.mac)?.name === 'hub-a', 5000, 'the board at hub A');
    const mine = await cursorOf(b);
    const theirs = (await b.ok('command_send', { selector: PAD.alias, command: 'status.blink', args: {} })).cursor;
    const t0 = Date.now();
    const here = b.call<Waited>('wait_for_event', { types: 'boot.down', selector: PAD.alias, since: mine, timeout_s: 30 });
    const offline = b.call<DeviceWait>('wait_for_device', { selector: PAD.alias, state: 'offline', timeout_s: 30 });
    const there = b.call<Waited>('wait_for_event', { types: 'boot.down', selector: PAD.alias, since: theirs, timeout_s: 30 });
    // A wait for the board to come online goes on: it may come to another hub.
    const online = b.call<DeviceWait>('wait_for_device', { selector: PAD.alias, state: 'online', since: mine, timeout_s: 4 });
    await sleep(300);
    await a.unlink();
    const [r1, r2, r3] = await Promise.all([here, offline, there]);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r1.error).toMatchObject({ code: 'HUB_UNREACHABLE', retryable: true, details: { hub: 'hub-a', devices: [PAD.mac] } });
    expect(r1.error!.message).toContain('hub hub-a went away while wait_for_event waited');
    expect(r2.error).toMatchObject({ code: 'HUB_UNREACHABLE', retryable: true, details: { hub: 'hub-a' } });
    expect(r3.error).toMatchObject({ code: 'HUB_UNREACHABLE', retryable: true });
    expect(r3.error!.message).toContain('hub hub-a is not reachable');
    // The board fails over to hub B meanwhile: the wait for `online` ends well.
    pad.silent = true;
    const moved = b.r.pad({ mac: PAD.mac, addr: PAD.addr, alias: PAD.alias, net: NET, hbMs: 100, epoch: 2 });
    await moved.connected(b.r.events, 10_000);
    expect((await online).data?.devices).toEqual([expect.objectContaining({ alias: PAD.alias, presence: 'online' })]);
    // A cursor of the hub that is away: said, retryable, and not read here.
    const gone = await b.call('events_read', { since: theirs, max_events: 5 });
    expect(gone.error).toMatchObject({ code: 'HUB_UNREACHABLE', retryable: true, details: { hub: 'hub-a' } });
  }, 60_000);

  it('logs do not cross: a log wait runs where the cursor is from, and is refused for a board whose lines are elsewhere', async () => {
    const a = await liveHub('hub-a', 0);
    const b = await liveHub('hub-b', 1);
    await joined([a, b]);
    const pad = a.board(PAD);
    pad.handlers.set(`2/${BLINK}`, () => ({}));
    await pad.connected(a.r.events, 10_000);
    await until(() => b.peers.holder(PAD.mac)?.name === 'hub-a', 5000, 'the board at hub A');
    const mine = await cursorOf(b);
    for (const op of ['wait_for_log', 'logs_assert'] as const) {
      const input = op === 'wait_for_log' ? { selector: PAD.alias, pattern: 'ready', since: mine, timeout_s: 1 } : { selector: PAD.alias, expect: ['ready'], since: mine, timeout_s: 1 };
      const refused = await b.call(op, input);
      expect(refused.error).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', details: { hub: 'hub-a', boards: [{ alias: PAD.alias, at: 'hub-a' }] } });
      expect(refused.error!.message).toContain("log lines do not cross the hubs' link");
      expect(refused.error!.hint).toContain('fr --at hub-a');
    }
    // From a cursor of hub A (an op on the board answered there): the wait is passed to hub A and reads its store.
    const theirs = (await b.ok('command_send', { selector: PAD.alias, command: 'status.blink', args: {} })).cursor;
    a.r.logs.append(PAD.mac, 'serial', 'I (1200) app: ready for input');
    const found = await b.ok<{ matched: boolean; matches: { text: string }[] }>('wait_for_log', { selector: PAD.alias, pattern: 'ready for', since: theirs, timeout_s: 5 });
    expect(found.at).toBe('hub-a');
    expect(found.data.matches.map((m) => m.text)).toEqual(['I (1200) app: ready for input']);
    const asserted = await b.ok<{ matched: { text: string }[] }>('logs_assert', { selector: PAD.alias, expect: ['ready for'], since: theirs, timeout_s: 5 });
    expect(asserted.at).toBe('hub-a');
    // logs_read: without a cursor at the board's hub (as before); from this hub's cursor here, saying where the lines are.
    const tail = await b.ok<{ lines: { text: string }[]; next_cursor: string }>('logs_read', { selector: PAD.alias, max_lines: 10 });
    expect(tail.at).toBe('hub-a');
    expect(tail.data.lines.map((l) => l.text)).toContain('I (1200) app: ready for input');
    const follow = await b.ok<{ lines: unknown[] }>('logs_read', { selector: PAD.alias, since: tail.data.next_cursor, max_lines: 10 });
    expect(follow.at).toBe('hub-a'); // fr logs --follow keeps reading the store its cursor came from
    const here = await b.ok<{ lines: unknown[] }>('logs_read', { selector: PAD.alias, since: mine, max_lines: 10 });
    expect(here.at).toBeUndefined();
    expect(here.data.lines).toEqual([]);
    expect(here.warnings).toEqual([expect.stringContaining(`${PAD.alias} is at hub hub-a: its log lines are in that hub's store`)]);
    // /ws: a logs sub for it is refused with the reason, not left silent.
    const client = new WsClient(b.ws);
    client.sub('l', { logs: { selector: `id:${PAD.mac}` } });
    expect(client.of('err')).toEqual([expect.objectContaining({ id: 'l', code: 'CAPABILITY_UNSUPPORTED', message: expect.stringContaining("log lines do not cross the hubs' link") })]);
  }, 60_000);

  it('a peer that relays no events (a hub of step 2.3): sent none, named, and a wait here for its board is refused', async () => {
    const a = await liveHub('hub-a', 0);
    const old = await liveHub('hub-old', 1, { live: 'off' });
    await joined([a, old]);
    const pad = old.board(PAD);
    await pad.connected(old.r.events, 10_000);
    await until(() => a.peers.holder(PAD.mac)?.name === 'hub-old', 5000, 'the board at the old hub');
    const lamp = a.board(LAMP);
    await lamp.connected(a.r.events, 10_000);
    down(lamp);
    down(pad);
    await sleep(300);
    // Neither sends the other an `event` message, and neither counts one it did not know.
    expect(a.peers.status().counters).toMatchObject({ events_sent: 0, events_received: 0, event_msgs_out: 0, unknown: 0 });
    expect(old.peers.status().counters).toMatchObject({ events_sent: 0, events_received: 0, event_msgs_out: 0, unknown: 0 });
    expect(peersView(a.hub).peers.find((p) => p.name === 'hub-old')).toMatchObject({ events: { speaks: false }, streams: { speaks: false, open: 0 } });
    expect(a.peers.warnings!()).toEqual([expect.stringContaining('hub hub-old does not relay events or live streams')]);
    expect(old.peers.warnings!()).toEqual([]); // as a 2.3 hub, it knows of none
    // Ops still pass both ways (the op registry is the same), and who is where is known.
    expect((await a.ok<{ presence: string }>('device_get', { device: PAD.alias })).at).toBe('hub-old');
    // A wait at hub A for the old hub's board cannot see it: refused, naming the hub and how to wait there.
    const since = (await a.ok('device_list', {})).cursor;
    const refused = await a.call('wait_for_event', { types: 'boot.down', selector: PAD.alias, since, timeout_s: 1 });
    expect(refused.error).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', details: { hub: 'hub-old' } });
    expect(refused.error!.message).toContain('which does not relay its events');
    expect(refused.error!.hint).toContain('fr --at hub-old wait event');
    const dev = await a.call('wait_for_device', { selector: PAD.alias, state: 'offline', timeout_s: 1 });
    expect(dev.error).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    // Named, it runs there on that hub's own bus, as under step 2.2.
    const theirs = (await a.ok('device_list', {}, 'hub-old')).cursor;
    const waiting = a.ok<Waited>('wait_for_event', { types: 'boot.down', selector: PAD.alias, since: theirs, timeout_s: 10 }, 'hub-old');
    await sleep(150);
    down(pad);
    expect((await waiting).at).toBe('hub-old');
    // A wait for this hub's own board is not touched by it.
    const own = (await a.ok('device_list', {})).cursor;
    down(lamp);
    expect((await a.ok<Waited>('wait_for_event', { types: 'boot.down', selector: LAMP.alias, since: own, timeout_s: 5 })).data.matched).toBe(true);
  }, 60_000);
});

/** A TCP relay to `target` that passes at most `rate` bytes a second each way: a slow link between two hubs. */
async function slowLink(target: () => number, rate: number): Promise<{ port: number; close(): Promise<void> }> {
  const socks = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  const pipe = (from: Socket, to: Socket) => {
    const queue: Buffer[] = [];
    let queued = 0;
    from.on('data', (chunk: Buffer) => {
      queue.push(chunk);
      queued += chunk.length;
      if (queued > 32 * 1024) {
        from.pause(); // TCP's own backpressure reaches the sending hub
      }
    });
    const timer = setInterval(() => {
      let budget = Math.ceil(rate / 50);
      while (budget > 0 && queue.length) {
        const head = queue[0];
        const part = head.subarray(0, budget);
        to.write(part);
        budget -= part.length;
        queued -= part.length;
        if (part.length === head.length) {
          queue.shift();
        } else {
          queue[0] = head.subarray(part.length);
        }
      }
      if (queued < 16 * 1024) {
        from.resume();
      }
    }, 20);
    timers.add(timer);
    from.on('close', () => {
      clearInterval(timer);
      timers.delete(timer);
      to.destroy();
    });
    from.on('error', () => undefined);
  };
  const server: Server = createServer((client) => {
    const up = createConnection({ host: '127.0.0.1', port: target() });
    socks.add(client).add(up);
    pipe(client, up);
    pipe(up, client);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const t of timers) {
        clearInterval(t);
      }
      for (const s of socks) {
        s.destroy();
      }
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe('a flood of events over a slow link (design multi-hub-m2 step 2.4)', () => {
  it('the heartbeat and the calls live, the queue stays bounded, the drops are counted and said on both hubs', async () => {
    const a = await liveHub('hub-a', 0, { events: { queueMax: 600 } });
    const b = await liveHub('hub-b', 1);
    // Each hub reaches the other only through a link of 200 KiB a second.
    const toA = await slowLink(() => a.peers.status().link.port!, 200 * 1024);
    const toB = await slowLink(() => b.peers.status().link.port!, 200 * 1024);
    cleanups.push(() => toA.close(), () => toB.close());
    await joined([a, b], (h) => (h === a ? toA.port : toB.port));
    await sleep(300); // both hubs dialled: the pair's one connection is settled before the flood
    const client = new WsClient(b.ws);
    client.sub('all', { events: { types: 'flood.*,knob.*,last.one' } });
    a.board(PAD);
    const text = 'x'.repeat(500);
    let n = 0;
    let states = 0;
    let level = 0;
    const flood = (count: number) => {
      for (let i = 0; i < count; i++) {
        a.r.events.publish({ type: 'flood.tick', device: PAD.mac, t_hub_us: nowUs(), part: 'event', fields: { n: n++, text } }, { durable: false });
        if (i % 20 === 0) {
          states++;
          level = n;
          a.r.events.publish({ type: 'knob.level', device: PAD.mac, t_hub_us: nowUs(), part: 'state', member: 'level', fields: { level } }, { durable: false });
        }
      }
    };
    // About 6 MB in two seconds over a link that carries 0.4 MB of it.
    let down = 0;
    let maxQueued = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 2000) {
      flood(250);
      await sleep(40);
      const st = a.peers.status();
      maxQueued = Math.max(maxQueued, st.events[b.id].queued);
      down += st.peers.find((p) => p.id === b.id)?.reachable && b.peers.status().peers[0].reachable ? 0 : 1;
    }
    // A call through the same link while the flood runs: answered, not starved (its answer waits behind one batch).
    const t1 = Date.now();
    const across = await b.ok<{ devices: unknown[] }>('device_list', {}, 'hub-a');
    expect(across.at).toBe('hub-a');
    expect(Date.now() - t1).toBeLessThan(5000);
    a.r.events.publish({ type: 'last.one', device: PAD.mac, t_hub_us: nowUs(), fields: { level: n } }, { durable: false });
    await until(() => client.events().some((e) => e.type === 'last.one'), 20_000, 'the last event');
    // The link never went away, on either side.
    expect(down).toBe(0);
    expect(a.peers.status().counters.away).toBe(0);
    expect(b.peers.status().counters.away).toBe(0);
    // Bounded: never more waiting than the limit.
    expect(maxQueued).toBeLessThanOrEqual(600);
    expect(maxQueued).toBeGreaterThan(300);
    // Counted and said on both hubs.
    const sa = a.peers.status();
    const sb = b.peers.status();
    expect(sa.counters.events_dropped).toBeGreaterThan(1000);
    expect(sa.events[b.id].dropped).toBe(sa.counters.events_dropped);
    // Every event is accounted for: sent, dropped, or a property's value a newer one replaced.
    expect(sa.counters.events_sent + sa.counters.events_dropped + sa.counters.events_coalesced).toBe(n + states + 1);
    expect(sb.counters.events_received).toBe(sa.counters.events_sent);
    expect(sb.counters.events_missed).toBe(sa.counters.events_dropped);
    expect(peersView(a.hub).peers.find((p) => p.name === 'hub-b')!.events).toMatchObject({ dropped: sa.counters.events_dropped });
    expect(a.peers.warnings!()).toEqual([expect.stringContaining(`${sa.counters.events_dropped} events were not sent to hub hub-b`)]);
    expect(b.peers.warnings!()).toEqual([expect.stringContaining(`hub hub-a did not send ${sa.counters.events_dropped} of its events to this hub`)]);
    // What did arrive is in order, ends with the newest, and the property's newest value is there.
    const got = client.events();
    expect(got.map((e) => e.seq)).toEqual([...got.map((e) => e.seq)].sort((x, y) => x - y));
    expect(got.at(-1)!.type).toBe('last.one');
    expect(got.filter((e) => e.type === 'flood.tick').at(-1)!.fields!.n).toBe(n - 1);
    expect(b.peers.events.properties(PAD.mac)?.['knob.level']).toBe(level);
  }, 90_000);
});

describe('nothing secret in what crosses', () => {
  it('every `event` message of this file: no network key, no Wi-Fi password, no Wi-Fi name', async () => {
    const a = await liveHub('hub-a', 0);
    const b = await liveHub('hub-b', 1);
    await joined([a, b]);
    const pad = a.board(PAD);
    await pad.connected(a.r.events, 10_000);
    // Ops that touch the secrets, at the hub that relays its events.
    await a.ok('network_set', { ssid: SSID, password: PASSWORD });
    await a.ok('network_get', {});
    pad.event(1, DOWN, new Uint8Array(0), { prio: 'realtime' });
    await until(() => b.r.events.query({ types: ['boot.down'], limit: 5, relayed: true }).length === 1, 5000, 'the relayed event');
    const all = readFileSync(tap, 'utf8');
    expect(tapped().filter((t) => t.msg.t === 'event').length).toBeGreaterThan(20);
    expect(tapped().some((t) => (t.msg.events ?? []).length > 0)).toBe(true);
    for (const secret of [key.toString('hex'), key.toString('base64'), PASSWORD, SSID]) {
      expect(all).not.toContain(secret);
    }
    // Nor in what the hubs keep of it.
    for (const h of [a, b]) {
      h.r.events.flush();
      const rows = JSON.stringify(h.r.db.prepare('SELECT type, json FROM events').all()) + JSON.stringify(h.r.events.query({ limit: 5000, relayed: true }));
      for (const secret of [key.toString('hex'), PASSWORD]) {
        expect(rows).not.toContain(secret);
      }
    }
  }, 60_000);
});

// ---- streams ----

const CAM = { mac: 'aabbcc1a0003', addr: 0x23, alias: 'cam-three' };
const CAM_CAPS = [{ port: 3, cap_id: findCap('fr.camera')!.id, name: 'cam' }];

/** A client on `/app/stream` (Node's WebSocket): its text frames, its blocks, its close. */
async function streamClient(h: LiveHub, hello: Record<string, unknown>) {
  const ws = new WebSocket(`${h.url.replace('http', 'ws')}/app/stream`);
  ws.binaryType = 'arraybuffer';
  const frames: Record<string, unknown>[] = [];
  const blocks: Buffer[] = [];
  let closed: { code: number; reason: string } | null = null;
  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string') {
      const f = JSON.parse(e.data) as Record<string, unknown>;
      if (f.t === 'ping') {
        ws.send(JSON.stringify({ t: 'pong', id: f.id }));
      } else {
        frames.push(f);
      }
    } else {
      blocks.push(Buffer.from(e.data as ArrayBuffer));
    }
  });
  ws.addEventListener('close', (e) => (closed = { code: e.code, reason: e.reason }));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('no /app/stream')));
  });
  ws.send(JSON.stringify({ t: 'stream.hello', v: 1, token: TOKEN, ...hello }));
  cleanups.push(() => ws.close());
  return { ws, frames, blocks, closed: () => closed, of: (t: string) => frames.filter((f) => f.t === t) };
}

/** A live jpeg stream on a board's instance at hub `h`, as a camera job registers one; `push` hands it a block. */
function fakeStream(h: LiveHub, dev: { mac: string; alias: string }, id: number, appOwned = false): { stream: LiveStream; push(bytes: Uint8Array): void; end(reason?: 'done' | 'net_lost' | 'stopped'): void; stopped(): boolean } {
  const live = liveStreams(h.hub);
  let stopped = false;
  const stream: LiveStream = {
    device: dev.mac,
    alias: dev.alias,
    instance: 'cam',
    info: { stream_id: id, kind: 'jpeg', format: 'mjpg1', to: 'hub', interval_ms: 0, seconds: 0 },
    counts: { records: 0, dropped: 0, blocks: 0, bytes: 0, firstAt: null, lastAt: null },
    appOwned,
    use: 'view',
    live: true,
    stop: () => {
      stopped = true;
    },
    pastGaps: 0,
  };
  live.register(stream);
  return {
    stream,
    push: (bytes) => live.block(dev.mac, 'cam', bytes),
    end: (reason = 'done') => live.end(dev.mac, 'cam', { t: 'stream.ended', stream_id: id, reason, records: 0, dropped: 0, bytes: 0 }),
    stopped: () => stopped,
  };
}

/** A block of `size` bytes that says which one it is: its number in the first four bytes, a pattern after. */
function block(n: number, size: number): Buffer {
  const b = Buffer.alloc(Math.max(4, size), n % 251);
  b.writeUInt32LE(n, 0);
  return b;
}

async function camAt(h: LiveHub, epoch = 1): Promise<FakeNode> {
  for (const x of hubs) {
    x.r.registry.add({ device_id: CAM.mac, addr: CAM.addr, alias: CAM.alias, provisioned: true, net: NET });
  }
  const n = h.r.pad({ mac: CAM.mac, addr: CAM.addr, alias: CAM.alias, net: NET, hbMs: 100, epoch, caps: CAM_CAPS });
  await n.connected(h.r.events, 10_000);
  return n;
}

describe("live streams across the hubs' link (design multi-hub-m2 step 2.4)", () => {
  it('/app/stream at hub B for a board hub A holds: every frame, the same bytes, and the end; the client leaving ends it at hub A', async () => {
    const a = await liveHub('hub-a', 0);
    const b = await liveHub('hub-b', 1);
    await joined([a, b]);
    await camAt(a);
    await until(() => b.peers.holder(CAM.mac)?.name === 'hub-a', 5000, 'the board at hub A');
    const s = fakeStream(a, CAM, 7001);
    // Everything hub B puts on the link for the relay, and everything that comes back, as text: no token may be in it.
    const crossed: string[] = [];
    const relay = b.hub.peers!.streams.relay;
    b.hub.peers!.streams.relay = (hubId, hello, sink) => {
      crossed.push(JSON.stringify(hello));
      return relay(hubId, hello, { ...sink, text: (json) => (crossed.push(json), sink.text(json)) });
    };
    const client = await streamClient(b, { device: CAM.alias });
    await until(() => client.of('stream.welcome').length === 1, 5000, 'the welcome');
    expect(JSON.parse(crossed[0])).toEqual({ v: 1, device: CAM.mac }); // the board and nothing else: hub B checked the token itself
    expect(crossed.join('\n')).not.toContain(TOKEN);
    expect(client.of('stream.welcome')[0]).toEqual({ t: 'stream.welcome', v: 1, device: CAM.mac, alias: CAM.alias, instance: 'cam', stream: s.stream.info });
    expect(a.app.relayedStreamSockets()).toBe(1);
    expect(liveStreams(a.hub).subscribers(CAM.mac, 'cam')).toBe(1);
    // Blocks of every size a relay cuts differently: empty, small, one data frame less a byte, exactly one, several, a megabyte.
    const sizes = [0, 1, 4, 1000, 65_534, 65_535, 65_536, 65_537, 200_000, 131_070, 1 << 20, 17];
    const sent = sizes.map((size, i) => (size < 4 ? Buffer.alloc(size, 0x5a) : block(i, size)));
    for (const bytes of sent) {
      s.push(bytes);
      await until(() => client.blocks.length === sent.indexOf(bytes) + 1, 5000, `block ${sent.indexOf(bytes)}`);
    }
    expect(client.blocks.map((x) => x.length)).toEqual(sizes);
    expect(Buffer.concat(client.blocks).equals(Buffer.concat(sent))).toBe(true);
    expect(client.of('stream.gap')).toEqual([]);
    // hub_peers on both: one relay open, and its bytes.
    const total = sent.reduce((n, x) => n + x.length, 0);
    expect(peersView(b.hub).peers.find((p) => p.name === 'hub-a')!.streams).toEqual({ speaks: true, open: 1 });
    expect(peersView(a.hub).peers.find((p) => p.name === 'hub-b')!.streams).toEqual({ speaks: true, open: 1 });
    expect(a.peers.status().counters).toMatchObject({ streams_served: 1, stream_blocks_out: sizes.length, streams_open: 1 });
    expect(b.peers.status().counters).toMatchObject({ streams_opened: 1, stream_blocks_in: sizes.length, streams_open: 1 });
    expect(a.peers.status().counters.stream_bytes_out).toBeGreaterThan(total);
    expect(b.peers.status().counters.stream_bytes_in).toBe(a.peers.status().counters.stream_bytes_out);
    // The stream ends at the board: the client hears it, and stays for the next one.
    s.end('done');
    await until(() => client.of('stream.ended').length === 1, 5000, 'stream.ended');
    expect(client.of('stream.ended')[0]).toMatchObject({ stream_id: 7001, reason: 'done' });
    const next = fakeStream(a, CAM, 7002, true);
    await until(() => client.of('stream.started').length === 1, 5000, 'the next stream');
    next.push(block(99, 500));
    await until(() => client.blocks.length === sizes.length + 1, 5000, 'its block');
    // The client goes: hub A's end closes with it.
    client.ws.close();
    await until(() => a.app.relayedStreamSockets() === 0, 5000, 'the relayed socket to close');
    expect(liveStreams(a.hub).subscribers(CAM.mac, 'cam')).toBe(0);
    await until(() => a.peers.status().counters.streams_open === 0 && b.peers.status().counters.streams_open === 0, 5000, 'the channel to close');
    expect(next.stopped()).toBe(false); // it did not ask for the stream, so its leaving stops none
    expect(b.app.streamSockets()).toBe(0);
    // Nothing that crossed for the relay, either way, named the token, the key, the password or the Wi-Fi.
    expect(crossed.length).toBeGreaterThan(3);
    for (const secret of [TOKEN, key.toString('hex'), PASSWORD, SSID]) {
      expect(crossed.join('\n')).not.toContain(secret);
    }
  }, 60_000);

  it('a client that asked for the stream holds it open through the link, and its leaving stops it at the board', async () => {
    const a = await liveHub('hub-a', 0);
    const b = await liveHub('hub-b', 1);
    await joined([a, b]);
    await camAt(a);
    await until(() => b.peers.holder(CAM.mac)?.name === 'hub-a', 5000, 'the board at hub A');
    // A stream that is running, begun by an app: a client at hub B that asks `start` joins it and holds it open.
    const s = fakeStream(a, CAM, 7101, true);
    const starter = await streamClient(b, { device: CAM.alias, instance: 'cam', start: { interval_ms: 250 } });
    const watcher = await streamClient(b, { device: CAM.alias });
    await until(() => starter.of('stream.welcome').length === 1 && watcher.of('stream.welcome').length === 1, 5000, 'both welcomes');
    s.push(block(1, 3000));
    await until(() => starter.blocks.length === 1 && watcher.blocks.length === 1, 5000, 'the block at both');
    watcher.ws.close();
    await until(() => a.app.relayedStreamSockets() === 1, 5000, 'the watcher gone');
    expect(s.stopped()).toBe(false);
    starter.ws.close();
    await until(() => s.stopped(), 5000, 'the stream stopped at hub A'); // the hub that holds the board tells it to stop
    expect(a.app.relayedStreamSockets()).toBe(0);
    // A start with fields of the wrong capability is refused by the hub that knows the instance, and said here.
    const bad = await streamClient(b, { device: CAM.alias, start: { source: 'router' } });
    await until(() => bad.closed() !== null, 5000, 'the refusal');
    expect(bad.closed()!.code).toBe(4400);
    expect(bad.of('error')).toEqual([expect.objectContaining({ code: 'INVALID_ARGS', message: expect.stringContaining('cam is fr.camera') })]);
    // A board that is not there at all is refused by this hub itself.
    const none = await streamClient(b, { device: 'no-such-board' });
    await until(() => none.closed() !== null, 5000, 'the refusal');
    expect(none.of('error')).toEqual([expect.objectContaining({ code: 'NOT_FOUND' })]);
    expect(a.peers.status().counters.streams_open).toBe(0);
  }, 60_000);

  it('the link drops mid-stream: the client is told, and when the board comes to this hub the socket follows it there', async () => {
    const a = await liveHub('hub-a', 0);
    const b = await liveHub('hub-b', 1);
    await joined([a, b]);
    const cam = await camAt(a);
    await until(() => b.peers.holder(CAM.mac)?.name === 'hub-a', 5000, 'the board at hub A');
    const s = fakeStream(a, CAM, 7201, true);
    const client = await streamClient(b, { device: CAM.alias, start: {} });
    await until(() => client.of('stream.welcome').length === 1, 5000, 'the welcome');
    s.push(block(1, 2000));
    await until(() => client.blocks.length === 1, 5000, 'a block');
    // Hub A goes away (its link closes: a stop, a crash, a cable).
    await a.unlink();
    await until(() => client.of('error').length === 1, 5000, 'the error frame');
    expect(client.of('stream.ended')).toEqual([{ t: 'stream.ended', stream_id: 7201, reason: 'net_lost', records: 0, dropped: 0 }]);
    expect(client.of('error')[0]).toMatchObject({ code: 'HUB_UNREACHABLE', message: expect.stringContaining(`the stream of ${CAM.alias} through hub hub-a ended`) });
    expect(client.closed()).toBeNull(); // the socket stays
    // Hub A's side ended at once too: the stream there lost its last starter and was stopped.
    expect(s.stopped()).toBe(true);
    expect(a.app.relayedStreamSockets()).toBe(0);
    // The board fails over to hub B: the socket attaches there by itself; no second welcome.
    cam.silent = true;
    await camAt(b, 2);
    await sleep(600);
    expect(client.of('stream.welcome')).toHaveLength(1);
    const local = fakeStream(b, CAM, 7202, true);
    await until(() => client.of('stream.started').length === 1, 5000, 'stream.started at hub B');
    expect(client.of('stream.started')[0]).toMatchObject({ stream: { stream_id: 7202 } });
    local.push(block(2, 2000));
    await until(() => client.blocks.length === 2, 5000, 'a block from hub B');
    expect(client.blocks[1].readUInt32LE(0)).toBe(2);
    // The client leaves: it had asked for the stream, so hub B stops the one that runs now.
    client.ws.close();
    await until(() => local.stopped(), 5000, 'the stream stopped at hub B');
  }, 60_000);

  it('the board moves to a third hub under the stream, every link up: the socket leaves the old hub and attaches at the new one', async () => {
    const a = await liveHub('hub-a', 0);
    const b = await liveHub('hub-b', 1);
    const c = await liveHub('hub-c', 2);
    await joined([a, b, c]);
    const cam = await camAt(a);
    await until(() => b.peers.holder(CAM.mac)?.name === 'hub-a', 5000, 'the board at hub A');
    const s = fakeStream(a, CAM, 7301, true);
    const client = await streamClient(b, { device: CAM.alias, start: {} });
    await until(() => client.of('stream.welcome').length === 1, 5000, 'the welcome');
    s.push(block(1, 1000));
    await until(() => client.blocks.length === 1, 5000, 'a block');
    // The board walks to hub C (its session with hub A ends a moment later; its stream to hub A may go on meanwhile).
    await camAt(c, 2);
    cam.silent = true;
    await until(() => b.peers.holder(CAM.mac)?.name === 'hub-c', 10_000, 'the board at hub C');
    await until(() => c.app.relayedStreamSockets() === 1, 10_000, 'the relay at hub C');
    // What it was watching is over for it, and hub A was left: the stream there is stopped (through the board's new hub).
    expect(client.of('stream.ended')).toEqual([expect.objectContaining({ stream_id: 7301, reason: 'net_lost' })]);
    await until(() => s.stopped() && a.app.relayedStreamSockets() === 0, 5000, 'hub A left');
    expect(client.of('stream.welcome')).toHaveLength(1);
    // The client had asked for the stream: hub C was asked to start one (here it cannot: this rig has no node HTTP
    // listener), and the client is told what hub C answered instead of being left waiting in silence.
    await until(() => client.of('error').length === 1, 5000, "hub C's answer");
    const moved = fakeStream(c, CAM, 7302, true);
    await until(() => client.of('stream.started').length === 1, 5000, 'stream.started from hub C');
    moved.push(block(3, 70_000));
    await until(() => client.blocks.length === 2, 5000, 'a block from hub C');
    expect(client.blocks[1].equals(block(3, 70_000))).toBe(true);
    expect(client.closed()).toBeNull();
    client.ws.close();
    await until(() => moved.stopped(), 5000, 'the stream stopped at hub C');
  }, 60_000);

  it('a slow link: blocks are dropped at the hub that holds the board, counted and said; nothing queues, the heartbeat lives', async () => {
    const a = await liveHub('hub-a', 0);
    const b = await liveHub('hub-b', 1);
    const toA = await slowLink(() => a.peers.status().link.port!, 300 * 1024);
    const toB = await slowLink(() => b.peers.status().link.port!, 300 * 1024);
    cleanups.push(() => toA.close(), () => toB.close());
    await joined([a, b], (h) => (h === a ? toA.port : toB.port));
    await sleep(300);
    await camAt(a);
    await until(() => b.peers.holder(CAM.mac)?.name === 'hub-a', 5000, 'the board at hub A');
    const s = fakeStream(a, CAM, 7401);
    const client = await streamClient(b, { device: CAM.alias });
    await until(() => client.of('stream.welcome').length === 1, 5000, 'the welcome');
    // 100 kB frames at 25 a second (2.5 MB/s) into a link of 0.3 MB/s, for three seconds.
    let n = 0;
    let down = 0;
    let maxBacklog = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      s.push(block(n++, 100_000));
      await sleep(40);
      down += a.peers.status().peers[0].reachable && b.peers.status().peers[0].reachable ? 0 : 1;
      maxBacklog = Math.max(maxBacklog, a.peers.status().counters.stream_bytes_out - b.peers.status().counters.stream_bytes_in);
    }
    s.push(block(n++, 100_000));
    await sleep(1500); // what was under way arrives
    s.end('done');
    await until(() => client.of('stream.ended').length === 1, 10_000, 'the end');
    expect(down).toBe(0);
    expect(a.peers.status().counters.away + b.peers.status().counters.away).toBe(0);
    // Far fewer arrived than were made, in order, each whole, the last ones recent.
    const got = client.blocks.map((x) => x.readUInt32LE(0));
    expect(got.length).toBeGreaterThan(3);
    expect(got.length).toBeLessThan(n / 2);
    expect(got).toEqual([...got].sort((x, y) => x - y));
    expect(client.blocks.every((x) => x.length === 100_000 && x.equals(block(x.readUInt32LE(0), 100_000)))).toBe(true);
    expect(got.at(-1)!).toBeGreaterThan(n - 15);
    // Every block is one that arrived or one the client was told was dropped.
    const gaps = client.of('stream.gap').reduce((sum, f) => sum + (f.blocks as number), 0);
    expect(got.length + gaps).toBe(n);
    // Never more under way than the stream's high water, a frame and what the slow link itself held.
    expect(maxBacklog).toBeLessThan(1_000_000);
    client.ws.close();
    await until(() => a.peers.status().counters.streams_open === 0, 5000, 'the channel to close');
    expect(a.peers.status().counters.stream_blocks_dropped).toBe(gaps);
  }, 60_000);

  it('a slow client: the hub it is connected to drops blocks for it and says how many; the other hub and the board are not slowed', async () => {
    const a = await liveHub('hub-a', 0);
    const b = await liveHub('hub-b', 1);
    await joined([a, b]);
    await camAt(a);
    await until(() => b.peers.holder(CAM.mac)?.name === 'hub-a', 5000, 'the board at hub A');
    const s = fakeStream(a, CAM, 7501);
    // A WebSocket by hand, so its TCP socket can stop reading: a browser tab that fell behind.
    const port = Number(new URL(b.url).port);
    const sock = createConnection({ host: '127.0.0.1', port });
    cleanups.push(() => sock.destroy());
    let inbox = Buffer.alloc(0);
    sock.on('data', (chunk: Buffer) => (inbox = Buffer.concat([inbox, chunk])));
    await new Promise<void>((r) => sock.once('connect', () => r()));
    sock.write(`GET /app/stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    await until(() => inbox.includes('\r\n\r\n'), 5000, 'the upgrade');
    inbox = inbox.subarray(inbox.indexOf('\r\n\r\n') + 4);
    const text = Buffer.from(JSON.stringify({ t: 'stream.hello', v: 1, token: TOKEN, device: CAM.alias }));
    const mask = randomBytes(4);
    const head = Buffer.from([0x81, 0x80 | text.length, ...mask]);
    sock.write(Buffer.concat([head, Buffer.from(text.map((x, i) => x ^ mask[i % 4]))]));
    /** The frames received so far: text ones parsed, binary ones as their bytes. */
    const frames = (): { texts: Record<string, unknown>[]; blocks: Buffer[] } => {
      const texts: Record<string, unknown>[] = [];
      const blocks: Buffer[] = [];
      let at = 0;
      while (at + 2 <= inbox.length) {
        const op = inbox[at] & 0x0f;
        let len = inbox[at + 1] & 0x7f;
        let off = at + 2;
        if (len === 126) {
          len = inbox.readUInt16BE(off);
          off += 2;
        } else if (len === 127) {
          len = Number(inbox.readBigUInt64BE(off));
          off += 8;
        }
        if (off + len > inbox.length) {
          break;
        }
        const payload = inbox.subarray(off, off + len);
        if (op === 1) {
          texts.push(JSON.parse(payload.toString('utf8')) as Record<string, unknown>);
        } else if (op === 2) {
          blocks.push(payload);
        }
        at = off + len;
      }
      return { texts, blocks };
    };
    await until(() => frames().texts.some((f) => f.t === 'stream.welcome'), 5000, 'the welcome');
    sock.pause();
    let n = 0;
    for (let i = 0; i < 80; i++) {
      s.push(block(n++, 100_000)); // 8 MB while the client reads nothing
      await sleep(15);
    }
    // Hub A sent every block: the link and the other hub were never behind, whatever the client did.
    expect(a.peers.status().counters.stream_blocks_out).toBe(80);
    expect(b.peers.status().counters.stream_blocks_in).toBe(80);
    expect(a.peers.status().counters.stream_blocks_dropped).toBe(0);
    sock.resume();
    s.push(block(n++, 100_000));
    s.end('done');
    await until(() => frames().texts.some((f) => f.t === 'stream.ended'), 10_000, 'the end');
    const got = frames();
    const gaps = got.texts.filter((f) => f.t === 'stream.gap').reduce((sum, f) => sum + (f.blocks as number), 0);
    expect(gaps).toBeGreaterThan(10);
    expect(got.blocks.length + gaps).toBe(n);
    expect(got.blocks.every((x) => x.equals(block(x.readUInt32LE(0), 100_000)))).toBe(true);
    expect(a.peers.status().peers[0].reachable && b.peers.status().peers[0].reachable).toBe(true);
  }, 60_000);

  it('a hub that relays no streams (step 2.3) is named, at once', async () => {
    const a = await liveHub('hub-a', 0);
    const old = await liveHub('hub-old', 1, { live: 'off' });
    await joined([a, old]);
    await camAt(old);
    await until(() => a.peers.holder(CAM.mac)?.name === 'hub-old', 5000, 'the board at the old hub');
    const client = await streamClient(a, { device: CAM.alias, start: {} });
    await until(() => client.closed() !== null, 5000, 'the refusal');
    expect(client.closed()!.code).toBe(4400);
    expect(client.of('error')).toEqual([expect.objectContaining({ code: 'CAPABILITY_UNSUPPORTED', message: expect.stringContaining(`${CAM.alias} is at hub hub-old, which does not relay live streams`) })]);
    expect(a.peers.status().counters.streams_opened).toBe(0);
    // And the other way: the old hub's client is told the board is not there, as under step 2.2.
    const cam2 = { mac: 'aabbcc1a0004', addr: 0x24, alias: 'cam-four' };
    for (const x of hubs) {
      x.r.registry.add({ device_id: cam2.mac, addr: cam2.addr, alias: cam2.alias, provisioned: true, net: NET });
    }
    const n = a.r.pad({ mac: cam2.mac, addr: cam2.addr, alias: cam2.alias, net: NET, hbMs: 100, caps: CAM_CAPS });
    await n.connected(a.r.events, 10_000);
    await until(() => old.peers.holder(cam2.mac)?.name === 'hub-a', 5000, 'the board at hub A');
    const theirs = await streamClient(old, { device: cam2.alias, start: {} });
    await until(() => theirs.closed() !== null, 5000, 'the refusal');
    expect(theirs.of('error')).toEqual([expect.objectContaining({ code: 'CAPABILITY_UNSUPPORTED' })]);
    expect(a.app.relayedStreamSockets()).toBe(0);
  }, 60_000);
});
