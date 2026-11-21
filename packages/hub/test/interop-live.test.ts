// The hubs' link, step 2.4 (design multi-hub-m2 §8, §17 "live data"), end to end on loopback: three real hub processes
// (real-hub.ts: ephemeral ports, their own FR_HOME, the link on 127.0.0.1) and the C++ fr_net_node (cpp-node.ts) as a
// pad and as a board with a fake CSI source (its own fr_stream engine: a real stream over the node HTTP port).
//   - what a board on hub A does is at hub B's `/ws` and `/app`, marked `hub`, and at hub C once, never twice;
//   - a job passed on (a CSI recording asked at hub B, run at hub A) shows its states and progress live at hub B;
//   - the waits: wait_for_event and wait_for_device at hub B for a board at hub A; wait_for_log from hub A's cursor;
//   - a stream relayed: `/app/stream` at hub B for the board at hub A, every block compared with the file hub A wrote;
//   - a client at hub B asks for the stream: it runs at hub A, is busy at every hub and says whose it is, and the
//     client leaving stops it at the board;
//   - hub A stops under the stream: the client is told, the board fails over to hub B, and the stream goes on there
//     by itself; hub A comes back, the board returns to it, and the stream follows it back through the link;
//   - the network key, the Wi-Fi password and the Wi-Fi's name are in no `event` message and in nothing a hub printed.
// peers-live.test.ts has the same without processes (and the slow link, the slow client, three hubs' streams, a hub of
// step 2.3). `node tools/host-test.mjs` builds fr_net_node; without it (or without its CSI source) this file skips.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AT_HEADER, type HubEvent, type Job, type Result } from '@fractonica/protocol';

import { BIN, CppNode } from './cpp-node.ts';
import { type RealHub, startRealHub } from './real-hub.ts';

const HAS_BIN = existsSync(BIN) && readFileSync(BIN).includes('--hub-map') && readFileSync(BIN).includes('--csi');
const PAD = { mac: 'aabbcc1c0e01', alias: 'pad-live' };
const CSI = { mac: 'aabbcc1c0e02', alias: 'csi-live' };
/** The names the CSI board knows its hubs by (its hub list names hubs); the node maps them to loopback ports. */
const HUB_A = 'hub-a.test';
const HUB_B = 'hub-b.test';
const TIMING = { giveUpMs: 1500, welcomeMs: 1200, probeMs: 1500, confirmMs: 500, trialMs: 4000 };
const SSID = 'garret-wifi-name';
const PASSWORD = 'horse-staple-correct';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Row {
  addr: number;
  net: number;
  alias_rev: number;
}
interface DeviceView {
  alias: string;
  presence: string;
  at: string | null;
  tags: string[];
}
interface CsiStatus {
  stream: { stream_id: number; records: number; subscribers: number; via?: string } | null;
}

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

async function waitFor<T>(what: string, fn: () => T | Promise<T>, ms = 20_000): Promise<NonNullable<T>> {
  const t0 = performance.now();
  for (;;) {
    const v = await fn();
    if (v) {
      return v as NonNullable<T>;
    }
    if (performance.now() - t0 > ms) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(50);
  }
}

const linked = (h: RealHub, names: string[]) =>
  waitFor(`${names.join(', ')} reachable`, async () => {
    const r = await h.api.call<{ peers: { name: string; reachable: boolean }[] }>('hub_peers');
    return r.ok && names.every((n) => r.data!.peers.some((p) => p.name === n && p.reachable));
  });

const listedAt = (h: RealHub, alias: string, want: string | null, ms = 30_000) =>
  waitFor(
    `${alias} at ${String(want)}`,
    async () => {
      const r = await h.api.call<{ devices: DeviceView[] }>('device_list', {});
      const row = r.ok ? r.data!.devices.find((d) => d.alias === alias) : undefined;
      return row !== undefined && row.at === want && (want === null || row.presence === 'online');
    },
    ms,
  );

const token = (h: RealHub) => (JSON.parse(readFileSync(join(h.home, 'secrets.json'), 'utf8')) as { app_token: string }).app_token;
const printed = (h: RealHub) => JSON.stringify(h.lines) + h.stderr();

/** A `/ws` client: every frame it was sent. */
async function wsClient(h: RealHub, sub: Record<string, unknown>) {
  const ws = new WebSocket(`${h.url.replace('http', 'ws')}/ws`);
  const frames: Record<string, unknown>[] = [];
  ws.addEventListener('message', (e) => frames.push(JSON.parse(String(e.data)) as Record<string, unknown>));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('no /ws')));
  });
  await waitFor('the /ws hello', () => frames.some((f) => f.t === 'hello'));
  ws.send(JSON.stringify({ op: 'sub', id: 's', ...sub }));
  return {
    ws,
    frames,
    events: () => frames.filter((f) => f.t === 'ev' && f.snapshot !== true).map((f) => f.e as HubEvent),
    of: (t: string) => frames.filter((f) => f.t === t),
  };
}

/** An `/app` client: its frames after the hello. */
async function appClient(h: RealHub) {
  const ws = new WebSocket(`${h.url.replace('http', 'ws')}/app`);
  const frames: Record<string, unknown>[] = [];
  ws.addEventListener('message', (e) => {
    const f = JSON.parse(String(e.data)) as Record<string, unknown>;
    if (f.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong', id: f.id }));
    } else {
      frames.push(f);
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('no /app')));
  });
  ws.send(JSON.stringify({ t: 'hello', v: 1, token: token(h), catalog_hash: 0, registry_rev: null }));
  await waitFor('the /app welcome', () => frames.some((f) => f.t === 'welcome'));
  return { ws, frames, of: (t: string) => frames.filter((f) => f.t === t) };
}

/** An `/app/stream` client: its text frames and its blocks. */
async function streamClient(h: RealHub, hello: Record<string, unknown>) {
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
  ws.send(JSON.stringify({ t: 'stream.hello', v: 1, token: token(h), ...hello }));
  return { ws, frames, blocks, closed: () => closed, of: (t: string) => frames.filter((f) => f.t === t) };
}

/** The blocks of a .csi file, each its exact bytes (a 12-byte head, then a u32 LE length before each). */
function fileBlocks(path: string): Buffer[] {
  const bytes = readFileSync(path);
  const out: Buffer[] = [];
  for (let at = 12; at + 4 <= bytes.length; ) {
    const len = bytes.readUInt32LE(at);
    out.push(bytes.subarray(at + 4, at + 4 + len));
    at += 4 + len;
  }
  return out;
}

describe.skipIf(!HAS_BIN)("the hubs' link: live data across hubs (design multi-hub-m2 step 2.4)", () => {
  let a: RealHub;
  let b: RealHub;
  let c: RealHub;
  let pad: CppNode;
  let csi: CppNode;
  let scratch = '';
  const taps: string[] = [];
  const rows = new Map<string, Row>();
  const sockets: { close(): void }[] = [];

  const nodeArgs = (h: RealHub, dev: { mac: string; alias: string }) => {
    const row = rows.get(dev.mac)!;
    return ['--hub-tcp', String(h.node.tcp), '--hub-udp', String(h.node.udp), '--hub-http', String(h.node.http), '--mac', dev.mac, '--addr', String(row.addr), '--net', String(row.net), '--alias', dev.alias, '--alias-rev', String(row.alias_rev), '--epoch', '3', '--hb-ms', '500'];
  };

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'fr-live-'));
    const tap = (name: string) => {
      const file = join(scratch, `${name}.events.jsonl`);
      taps.push(file);
      return { FR_TEST_PEER_EVENTS_TAP: file };
    };
    [a, b, c] = await Promise.all([startRealHub({ env: tap('a') }), startRealHub({ env: tap('b') }), startRealHub({ env: tap('c') })]);
    for (const [h, name] of [[a, 'hub-a'], [b, 'hub-b'], [c, 'hub-c']] as const) {
      await h.api.ok('hub_name_set', { name });
    }
    await a.api.ok('network_set', { ssid: SSID, password: PASSWORD });
    for (const h of [b, c]) {
      await h.api.ok('network_join', { hub: a.url });
    }
    // A member counts its runs (and so its cursors) in its slot from its next start: the join says so, and the hub is
    // restarted as on a real machine.
    const status = await b.api.ok<{ warnings: string[] }>('hub_status');
    expect(status.warnings.some((w) => w.includes('restart this hub'))).toBe(true);
    await Promise.all([b.restart(), c.restart()]);
    await linked(a, ['hub-b', 'hub-c']);
    await linked(b, ['hub-a', 'hub-c']);
    await linked(c, ['hub-a', 'hub-b']);
    for (const dev of [PAD, CSI]) {
      rows.set(dev.mac, await a.api.ok<Row>('device_enroll', { device_id: dev.mac, chip: 'esp32c6', profile: 'c6-pad', alias: dev.alias }));
      await a.api.ok('device_update', { device: dev.alias, tag: '-new' });
    }
    for (const [h, name] of [[b, 'hub-b'], [c, 'hub-c']] as const) {
      for (const dev of [PAD, CSI]) {
        await waitFor(`${dev.alias} at ${name}`, async () => {
          const r = await call<DeviceView>(h, 'device_get', { device: dev.alias }, name);
          return r.ok && r.data!.tags.length === 0;
        });
      }
    }
    pad = new CppNode([...nodeArgs(a, PAD), '--net-log', '1']);
    csi = new CppNode([
      ...nodeArgs(a, CSI),
      '--csi', 'sine',
      '--hub-name', HUB_A,
      '--hub-map', `${HUB_B}=${b.node.tcp}:${b.node.udp}:${b.node.http}`,
      '--hub-timing', `${TIMING.giveUpMs}:${TIMING.welcomeMs}:${TIMING.probeMs}:${TIMING.confirmMs}:${TIMING.trialMs}`,
    ]);
    await listedAt(b, PAD.alias, 'hub-a');
    await listedAt(b, CSI.alias, 'hub-a');
    await listedAt(c, CSI.alias, 'hub-a');
  }, 180_000);

  afterAll(async () => {
    for (const s of sockets) {
      s.close();
    }
    pad?.stop();
    csi?.stop();
    await Promise.all([a?.stop(), b?.stop(), c?.stop()]);
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);

  it('the runs of two hubs never meet: a cursor says whose it is', async () => {
    const heads = await Promise.all([a, b, c].map(async (h) => (await h.api.ok<{ head: string; run: number; hub: { slot: number } }>('hub_status')) as unknown as { head: string; run: number; hub: { slot: number } }));
    expect(heads.map((s) => s.hub.slot)).toEqual([0, 1, 2]);
    expect(heads.map((s) => Math.floor(s.run / 1_000_000_000))).toEqual([0, 1, 2]);
    expect(new Set(heads.map((s) => s.head.split('.')[0])).size).toBe(3);
    for (const h of [a, b, c]) {
      const st = await h.api.ok<{ warnings: string[] }>('hub_status');
      expect(st.warnings.filter((w) => /cursor|slot|relay|events/.test(w))).toEqual([]);
    }
  }, 30_000);

  it("what a board on hub A does is live at hub B's /ws and /app, marked with its hub, and at hub C once", async () => {
    const atB = await wsClient(b, { events: { selector: PAD.alias } });
    const atC = await wsClient(c, { events: { types: 'boot.*,op.called' } });
    const app = await appClient(b);
    sockets.push(atB.ws, atC.ws, app.ws);
    // The welcome lists the board as online at hub A.
    const welcome = app.of('welcome')[0] as { devices: { alias: string; online: boolean; hub?: string }[] };
    expect(welcome.devices.find((d) => d.alias === PAD.alias)).toMatchObject({ online: true, hub: 'hub-a' });
    // The board's button, and a command sent to it through hub B.
    pad.send('inject click');
    const sent = await ok<{ results: { status: string; at?: string }[] }>(b, 'command_send', { selector: PAD.alias, command: 'node.identify', args: { ms: 100 } });
    expect(sent.at).toBe('hub-a');
    await waitFor('the click and the call at hub B', () => atB.events().some((e) => e.type === 'boot.click') && atB.events().some((e) => e.type === 'op.called'));
    const got = atB.events().filter((e) => ['boot.down', 'boot.up', 'boot.click', 'op.called'].includes(e.type));
    expect(got.map((e) => e.type).sort()).toEqual(['boot.click', 'boot.down', 'boot.up', 'op.called']);
    const runB = (await b.api.ok<{ run: number }>('hub_status') as unknown as { run: number }).run;
    for (const e of got) {
      expect(e.hub).toBe('hub-a');
      expect(e.device).toBe(PAD.mac);
      expect(e.cursor).toBe(`c:${runB}.${e.seq}`);
      expect(e.hub_cursor).toMatch(/^c:\d+\.\d+$/);
      expect(e.hub_cursor!.split('.')[0]).not.toBe(e.cursor.split('.')[0]);
    }
    // The app: its frames say the hub too.
    await waitFor('the evt frames', () => app.of('evt').filter((f) => f.inst === 'boot').length >= 3);
    expect(app.of('evt').every((f) => f.hub === 'hub-a' && f.dev === PAD.mac)).toBe(true);
    // Hub C got each once, from hub A alone.
    await waitFor('the click at hub C', () => atC.events().some((e) => e.type === 'boot.click'));
    await sleep(500);
    const atCGot = atC.events().filter((e) => e.device === PAD.mac && e.part !== 'state');
    expect(atCGot.map((e) => e.type).sort()).toEqual(['boot.click', 'boot.down', 'boot.up', 'op.called']);
    expect(new Set(atCGot.map((e) => e.hub_cursor)).size).toBe(4);
    expect(atCGot.every((e) => e.hub === 'hub-a')).toBe(true);
    // Stored once: hub B's own store has none of them (asked by its own name, a tail of its table and memory).
    const stored = await ok<{ events: HubEvent[] }>(a, 'events_read', { selector: PAD.alias, types: 'boot.*', max_events: 50 }, 'hub-a');
    expect(stored.data.events.filter((e) => e.type === 'boot.click')).toHaveLength(1);
    expect(stored.data.events.every((e) => e.hub === undefined)).toBe(true);
    const peers = await b.api.ok<{ peers: { name: string; events?: { speaks: boolean; received: number; dropped: number } }[]; counters: Record<string, number> }>('hub_peers');
    expect(peers.peers.find((p) => p.name === 'hub-a')!.events).toMatchObject({ speaks: true, dropped: 0 });
    expect(peers.peers.find((p) => p.name === 'hub-a')!.events!.received).toBeGreaterThanOrEqual(4);
    expect(peers.counters.events_bad).toBe(0);
  }, 60_000);

  it("a job passed on shows its states and its progress live at the hub that was asked, and the board's stream events too", async () => {
    const atB = await wsClient(b, { jobs: true, events: { types: 'job.state,stream.*' } });
    sockets.push(atB.ws);
    const out = join(b.home, 'csi', 'job.csi');
    mkdirSync(join(b.home, 'csi'), { recursive: true });
    const started = await ok<Job>(b, 'csi_stream', { device: CSI.alias, seconds: 3, out, live: true });
    expect(started.at).toBe('hub-a');
    const id = started.data.job_id;
    await waitFor('the job to end at hub B', () => atB.of('job').some((f) => f.job_id === id && f.status === 'completed'), 30_000);
    const frames = atB.of('job').filter((f) => f.job_id === id);
    expect(frames.every((f) => f.hub === 'hub-a')).toBe(true);
    expect(frames.some((f) => f.status === 'working' && typeof (f.progress as { message?: string } | undefined)?.message === 'string')).toBe(true);
    expect(frames.some((f) => f.stage === 'streaming')).toBe(true);
    const states = atB.events().filter((e) => e.type === 'job.state' && e.fields?.job_id === id);
    expect(states.map((e) => e.fields?.status)).toEqual(expect.arrayContaining(['working', 'completed']));
    expect(states.every((e) => e.hub === 'hub-a')).toBe(true);
    await waitFor('stream.ended at hub B', () => atB.events().some((e) => e.type === 'stream.ended' && e.device === CSI.mac));
    expect(atB.events().filter((e) => e.type.startsWith('stream.')).map((e) => [e.type, e.hub])).toEqual([['stream.started', 'hub-a'], ['stream.ended', 'hub-a']]);
    // The file is where the command ran (step 2.2), and the job is asked of hub B as before.
    const done = await ok<Job>(b, 'job_wait', { job_id: id, timeout_s: 20 });
    expect(done.data.status).toBe('completed');
    await waitFor('the file at hub B', () => existsSync(out));
  }, 90_000);

  it('the waits: for an event and a state of a board at hub A, asked at hub B; for a log line, from a cursor of hub A', async () => {
    // This hub's own cursor: the wait runs here, over what hub A relays.
    const mine = (await b.api.ok<{ head: string }>('hub_status') as unknown as { head: string }).head;
    pad.send('inject click');
    const backlog = await ok<{ events: HubEvent[] }>(b, 'wait_for_event', { types: 'boot.click', selector: PAD.alias, since: mine, timeout_s: 20 });
    expect(backlog.at).toBeUndefined();
    expect(backlog.data.events.map((e) => [e.type, e.hub])).toEqual([['boot.click', 'hub-a']]);
    const online = await ok<{ devices: { alias: string; presence: string; at?: string }[] }>(b, 'wait_for_device', { selector: `${PAD.alias},${CSI.alias}`, state: 'online', timeout_s: 10 });
    expect(online.data.devices.map((d) => [d.alias, d.presence, d.at]).sort()).toEqual([[CSI.alias, 'online', 'hub-a'], [PAD.alias, 'online', 'hub-a']]);
    // A log wait from this hub's cursor would read this hub's store, which has none of the board's lines: refused.
    const refused = await call(b, 'wait_for_log', { selector: PAD.alias, pattern: 'marker', since: mine, timeout_s: 1 });
    expect(refused.error).toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', details: { hub: 'hub-a' } });
    // From a cursor of hub A (an op on the board, answered there): passed to hub A, which has the lines.
    const there = await ok(b, 'command_send', { selector: PAD.alias, command: 'node.identify', args: { ms: 50 } });
    expect(there.at).toBe('hub-a');
    const waiting = ok<{ matches: { text: string }[] }>(b, 'wait_for_log', { selector: PAD.alias, pattern: 'marker-17', since: there.cursor, timeout_s: 20 });
    await sleep(200);
    pad.send('log I app marker-17 seen');
    const found = await waiting;
    expect(found.at).toBe('hub-a');
    expect(found.data.matches).toHaveLength(1);
    expect(found.data.matches[0].text).toContain('marker-17');
    const asserted = await ok<{ matched: unknown[] }>(b, 'logs_assert', { selector: PAD.alias, expect: ['marker-17'], since: there.cursor, timeout_s: 10 });
    expect(asserted.at).toBe('hub-a');
    // A cursor of hub A at hub C: the read goes to hub A; told to run at hub C, it is refused by name.
    const read = await ok<{ events: HubEvent[] }>(c, 'events_read', { since: there.cursor, selector: PAD.alias, max_events: 20 });
    expect(read.at).toBe('hub-a');
    const wrong = await call(c, 'events_read', { since: there.cursor, max_events: 20 }, 'hub-c');
    expect(wrong.error).toMatchObject({ code: 'INVALID_ARGS', details: { cursor_hub: 'hub-a' } });
  }, 90_000);

  it("a stream relayed: /app/stream at hub B gets every block of the board's stream at hub A, byte for byte", async () => {
    const client = await streamClient(b, { device: CSI.alias });
    sockets.push(client.ws);
    await waitFor('the welcome', () => client.of('stream.welcome').length === 1);
    expect(client.of('stream.welcome')[0]).toMatchObject({ device: CSI.mac, alias: CSI.alias, stream: null });
    const out = join(b.home, 'csi', 'relay.csi');
    const job = await ok<Job>(b, 'csi_stream', { device: CSI.alias, seconds: 3, out, live: true, wait_s: 30 });
    expect(job.at).toBe('hub-a');
    expect(job.data.status).toBe('completed');
    await waitFor('stream.ended at the client', () => client.of('stream.ended').length === 1);
    await waitFor('the file at hub B', () => existsSync(out));
    const file = fileBlocks(out);
    expect(file.length).toBeGreaterThan(5);
    await waitFor('every block', () => client.blocks.length >= file.length, 10_000);
    expect(client.blocks.length).toBe(file.length);
    expect(Buffer.concat(client.blocks).equals(Buffer.concat(file))).toBe(true);
    expect(client.of('stream.gap')).toEqual([]);
    expect(client.of('stream.started')).toHaveLength(1);
    const peers = await b.api.ok<{ peers: { name: string; streams?: { speaks: boolean; open: number } }[]; counters: Record<string, number> }>('hub_peers');
    expect(peers.peers.find((p) => p.name === 'hub-a')!.streams).toEqual({ speaks: true, open: 1 });
    expect(peers.counters.stream_blocks_in).toBeGreaterThanOrEqual(file.length);
    client.ws.close();
    await waitFor('the relay to close', async () => (await a.api.ok<{ counters: Record<string, number> }>('hub_peers')).counters.streams_open === 0);
  }, 90_000);

  it('a client at hub B asks for the stream: it runs at hub A, is busy at every hub and says whose, and leaving stops it at the board', async () => {
    const stops = csi.of('dispatch').length;
    const client = await streamClient(b, { device: CSI.alias, start: {} });
    await waitFor('blocks through the link', () => client.blocks.length >= 3, 20_000);
    expect(client.of('error')).toEqual([]);
    // The stream is hub A's (where the board is), and its status says for whom, whichever hub is asked.
    for (const h of [a, b, c]) {
      const st = await ok<CsiStatus>(h, 'csi_status', { device: CSI.alias });
      expect(st.data.stream).toMatchObject({ subscribers: 1, via: 'hub-b' });
    }
    // One stream at a time: busy at every hub, naming the hub whose client holds it.
    for (const h of [a, c]) {
      const busy = await call(h, 'csi_stream', { device: CSI.alias, seconds: 1 });
      expect(busy.error).toMatchObject({ code: 'DEVICE_BUSY' });
      expect(busy.error!.message).toContain('for a client of hub hub-b');
    }
    // A second client, at hub C, joins the same stream.
    const other = await streamClient(c, { device: CSI.alias });
    sockets.push(other.ws);
    await waitFor('blocks at hub C', () => other.blocks.length >= 2, 20_000);
    other.ws.close();
    // The client that asked leaves: hub A tells the board to stop.
    client.ws.close();
    await waitFor('the stream to end at hub A', async () => (await ok<CsiStatus>(a, 'csi_status', { device: CSI.alias })).data.stream === null, 20_000);
    expect(csi.of('dispatch').length).toBeGreaterThan(stops + 1); // stream_start and stream_stop reached the board
    await waitFor('no relay left', async () => (await a.api.ok<{ counters: Record<string, number> }>('hub_peers')).counters.streams_open === 0);
    // And the board takes a new stream at once.
    const again = await ok<Job>(c, 'csi_stream', { device: CSI.alias, seconds: 1, wait_s: 20 });
    expect(again.data.status).toBe('completed');
  }, 120_000);

  it('hub A stops under the stream: the client is told, the board fails over, and the stream goes on at hub B; then back', async () => {
    // The board knows both hubs: hub A first (its default), hub B second.
    await ok(b, 'device_hubs_set', { device: CSI.alias, hub: [HUB_A, `${HUB_B}/127.0.0.1`] });
    const client = await streamClient(b, { device: CSI.alias, start: {} });
    sockets.push(client.ws);
    await waitFor('blocks through the link', () => client.blocks.length >= 3, 20_000);
    const first = (client.of('stream.welcome')[0].stream ?? client.of('stream.started')[0]?.stream) as { stream_id: number };
    // Hub A stops (as `fr hub stop`: its jobs are cancelled, its link closes).
    await a.halt();
    await waitFor('the client to be told', () => client.of('error').length >= 1 || client.of('stream.ended').length >= 1, 15_000);
    await waitFor('the end of the first stream', () => client.of('stream.ended').some((f) => f.stream_id === first.stream_id), 15_000);
    expect(client.closed()).toBeNull();
    // The board fails over to hub B; the socket attaches there and, since the client had asked for the stream and it was
    // cut a moment ago, asks hub B's own board session for it again.
    await listedAt(b, CSI.alias, 'hub-b', 40_000);
    const before = client.blocks.length;
    await waitFor('a new stream at hub B', () => client.of('stream.started').some((f) => (f.stream as { stream_id: number }).stream_id !== first.stream_id), 30_000);
    await waitFor('blocks from hub B', () => client.blocks.length >= before + 3, 20_000);
    const local = await ok<CsiStatus>(b, 'csi_status', { device: CSI.alias });
    expect(local.at).toBeUndefined();
    expect(local.data.stream).toMatchObject({ subscribers: 1 });
    expect(local.data.stream!.via).toBeUndefined();
    const second = local.data.stream!.stream_id;

    // Hub A comes back; the board returns to its default hub by itself, under the running stream (today's firmware does
    // not hold it back). The socket leaves hub B's stream (hub B stops it: through hub A, where the board now is) and
    // follows the board through the link.
    await a.start();
    await linked(b, ['hub-a']);
    await listedAt(b, CSI.alias, 'hub-a', 60_000);
    await waitFor('the second stream to end for the client', () => client.of('stream.ended').some((f) => f.stream_id === second), 30_000);
    await waitFor('a third stream, at hub A', () => client.of('stream.started').some((f) => ![first.stream_id, second].includes((f.stream as { stream_id: number }).stream_id)), 40_000);
    const mark = client.blocks.length;
    await waitFor('blocks through the link again', () => client.blocks.length >= mark + 3, 20_000);
    const back = await ok<CsiStatus>(b, 'csi_status', { device: CSI.alias });
    expect(back.at).toBe('hub-a');
    expect(back.data.stream).toMatchObject({ via: 'hub-b' });
    // Nothing is left streaming at hub B with nobody watching (its job ends a few seconds after the board was told).
    await waitFor("hub B's stream to be over", async () => (await ok<CsiStatus>(b, 'csi_status', { device: CSI.alias }, 'hub-b')).data.stream === null, 20_000);
    expect(client.closed()).toBeNull();
    client.ws.close();
    await waitFor('the stream to stop at hub A', async () => (await ok<CsiStatus>(a, 'csi_status', { device: CSI.alias }, 'hub-a')).data.stream === null, 20_000);
  }, 240_000);

  it('nothing secret crossed or was printed', async () => {
    const key = (JSON.parse(readFileSync(join(a.home, 'secrets.json'), 'utf8')) as { network_key: { key: string } }).network_key.key;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    let messages = 0;
    let events = 0;
    for (const file of taps) {
      const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
      for (const line of text.split('\n').filter(Boolean)) {
        const t = JSON.parse(line) as { msg: { t: string; events?: unknown[] } };
        expect(t.msg.t).toBe('event');
        messages++;
        events += t.msg.events?.length ?? 0;
      }
      for (const secret of [key, Buffer.from(key, 'hex').toString('base64'), PASSWORD, SSID, token(a), token(b), token(c)]) {
        expect(text).not.toContain(secret);
      }
    }
    expect(messages).toBeGreaterThan(20);
    expect(events).toBeGreaterThan(20);
    for (const h of [a, b, c]) {
      const text = printed(h);
      for (const secret of [key, PASSWORD, token(a), token(b), token(c)]) {
        expect(text).not.toContain(secret);
      }
    }
  }, 30_000);
});
