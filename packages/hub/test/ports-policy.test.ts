// The port policy (config.json ports, ports/policy.ts): in mode adopted the hub opens only ports of registered boards
// and lists the others closed (`unwatched`), never opens an ignored port (path, MAC or VID:PID), reopens an adopted
// board after a USB re-enumeration (a new path), opens a bridge port once its board is known, lends an unwatched port
// and leaves it closed when the lend expires, and port_claim / port_ignore write config.json (unknown keys kept) and
// act at once. A config file that is not JSON is reported (hub_status shows the policy's warnings), not fatal: a hand
// edit that breaks it keeps the ports settings read before, and with none read since the start no port is opened.
// A bridge port's board is remembered with its adapter. SerialPort.list and the ports are fakes: no real serial port
// is opened.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HubContext, HubRunOptions, PortHolders } from '../src/context.ts';
import { openDb } from '../src/db.ts';
import { EventStore } from '../src/events/index.ts';
import { JobRunner } from '../src/jobs.ts';
import { LogStore } from '../src/logstore.ts';
import { HANDLERS } from '../src/ops.ts';
import { listPorts } from '../src/ports/holders.ts';
import { createLeases } from '../src/ports/leases.ts';
import { createPortPolicy, portMatches } from '../src/ports/policy.ts';
import { createRegistry } from '../src/registry/index.ts';
import { CursorSeq } from '../src/seq.ts';
import { SerialPortManager } from '../src/serial.ts';

const h = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  class FakePort {
    static listed: { path: string; vendorId?: string; productId?: string; serialNumber?: string }[] = [];
    static list = async () => FakePort.listed;
    static opened: string[] = [];
    static instances: FakePort[] = [];
    path: string;
    isOpen = false;
    #listeners = new Map<string, Listener[]>();
    constructor(opts: { path: string }) {
      this.path = opts.path;
      FakePort.instances.push(this);
    }
    open(cb: (err: Error | null) => void): void {
      this.isOpen = true;
      FakePort.opened.push(this.path);
      queueMicrotask(() => cb(null));
    }
    close(cb: () => void): void {
      this.isOpen = false;
      queueMicrotask(() => {
        cb();
        this.emit('close');
      });
    }
    set(_flags: unknown, cb: (err: Error | null) => void): void {
      cb(null);
    }
    write(_data: string, cb: (err: Error | null) => void): void {
      queueMicrotask(() => cb(null));
    }
    on(event: string, fn: Listener): this {
      this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), fn]);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const fn of this.#listeners.get(event) ?? []) {
        fn(...args);
      }
    }
  }
  return { FakePort };
});

vi.mock('serialport', () => ({ SerialPort: h.FakePort }));

const KNOWN = '1cdbd4000134';
const STRANGER = '1cdbd4000999';
const OWN = (n: number, mac: string) => ({ path: `/dev/tty.usbmodem${n}`, vendorId: '303a', productId: '1001', serialNumber: mac.match(/../g)!.join(':').toUpperCase() });
const CH340 = { path: '/dev/tty.usbserial-110', vendorId: '1a86', productId: '7523' };
const RUN: HubRunOptions = { apiHost: '127.0.0.1', apiPort: 0, nodeHost: '127.0.0.1', nodePort: 0, nodeHttpPort: 0, noAdvert: true, serial: true };

const dir = mkdtempSync(join(tmpdir(), 'fr-policy-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});
beforeEach(() => {
  h.FakePort.listed = [];
  h.FakePort.opened = [];
  h.FakePort.instances = [];
});

class NoHolders implements PortHolders {
  async holders(): Promise<Map<string, never[]>> {
    return new Map();
  }
}

interface Rig {
  hub: HubContext;
  serial: SerialPortManager;
  config: string;
  clock: { now: number };
  state(path: string): string | undefined;
  register(deviceId: string, alias: string): void;
}

async function rig(config?: unknown): Promise<Rig> {
  const home = mkdtempSync(join(dir, 'home-'));
  const file = join(home, 'config.json');
  if (config !== undefined) {
    writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config));
  }
  const db = openDb(join(home, 'hub.db'));
  const seq = new CursorSeq(db);
  const logs = new LogStore(db, 1, { retention: false, seq });
  const events = new EventStore(db, seq, 1);
  const portPolicy = createPortPolicy(db, file);
  const serial = new SerialPortManager(logs, db, { policy: portPolicy, holders: new NoHolders() });
  const registry = createRegistry(db);
  const clock = { now: Date.now() };
  const router = { presence: () => 'online', endSerialSession: async () => true };
  const hub = { idf: () => null, pytools: () => null, hubSourceDir: dir, db, logs, seq, serial, portPolicy, jobs: new JobRunner(db), registry, router, events, portHolders: new NoHolders() } as unknown as HubContext;
  hub.leases = createLeases(() => hub, RUN, { alive: () => true, now: () => clock.now, sweepMs: 10, portGoneMs: 600_000 });
  hub.leases.start();
  const register = (deviceId: string, alias: string) =>
    db.prepare('INSERT INTO devices (device_id, alias, created_at) VALUES (?, ?, ?)').run(deviceId, alias, new Date().toISOString());
  cleanups.push(async () => {
    hub.leases.stop();
    await serial.stop();
    events.stop();
    logs.close();
    db.close();
  });
  return { hub, serial, config: file, clock, state: (path) => serial.list().find((p) => p.path === path)?.state, register };
}

describe('portMatches', () => {
  const own = { key: KNOWN, path: '/dev/cu.usbmodem1101', usbSerial: '1C:DB:D4:00:01:34', vid: '303a', pid: '1001' };
  const bridge = { key: 'path:usbserial-110', path: '/dev/cu.usbserial-110', vid: '1a86', pid: '7523', bridge: 'ch340' };
  it('matches a path (cu or tty), a MAC or USB serial, a VID:PID, path:<basename> and a bare basename', () => {
    expect(portMatches('/dev/tty.usbmodem1101', own)).toBe(true);
    expect(portMatches('/dev/cu.usbmodem1101', own)).toBe(true);
    expect(portMatches('1C:DB:D4:00:01:34', own)).toBe(true);
    expect(portMatches(KNOWN, own)).toBe(true);
    expect(portMatches('303A:1001', own)).toBe(true);
    expect(portMatches('1a86:7523', own)).toBe(false);
    expect(portMatches('1a86:7523', bridge)).toBe(true);
    expect(portMatches('path:usbserial-110', bridge)).toBe(true);
    expect(portMatches('usbserial-110', bridge)).toBe(true);
    expect(portMatches('usbmodem1101', own)).toBe(true);
    expect(portMatches('/dev/cu.usbmodem1201', own)).toBe(false);
  });
});

describe('mode adopted (the default)', () => {
  it('opens a registered board, leaves an unknown one closed, never opens an ignored path or VID:PID', async () => {
    const r = await rig({ ports: { ignore: ['/dev/cu.usbmodem1301', '1a86:7523'] } });
    r.register(KNOWN, 'pad-c6');
    h.FakePort.listed = [OWN(1101, KNOWN), OWN(1201, STRANGER), OWN(1301, '1cdbd4000777'), CH340];
    await r.serial.poll();
    expect(h.FakePort.opened).toEqual(['/dev/cu.usbmodem1101']);
    const ports = (await listPorts(r.hub)).ports;
    expect(ports.map((p) => [p.path, p.state, p.policy, p.alias])).toEqual([
      ['/dev/cu.usbmodem1101', 'open', 'adopted', 'pad-c6'],
      ['/dev/cu.usbmodem1201', 'unwatched', 'not_adopted', undefined],
      ['/dev/cu.usbmodem1301', 'ignored', 'ignored', undefined],
      ['/dev/cu.usbserial-110', 'ignored', 'ignored', undefined],
    ]);
    // Polls go on: nothing else is opened.
    await r.serial.poll();
    expect(h.FakePort.opened).toEqual(['/dev/cu.usbmodem1101']);
    expect(r.hub.portPolicy!.config().config.ports.mode).toBe('adopted');
  });

  it('reopens an adopted board after a USB re-enumeration at another path', async () => {
    const r = await rig();
    r.register(KNOWN, 'pad-c6');
    h.FakePort.listed = [OWN(1101, KNOWN)];
    await r.serial.poll();
    expect(r.state('/dev/cu.usbmodem1101')).toBe('open');
    // A chip reset: its USB goes (the hub's handle reports a disconnect) and comes back under another location.
    const old = h.FakePort.instances.at(-1)!;
    old.isOpen = false;
    old.emit('close', { disconnected: true });
    h.FakePort.listed = [OWN(1201, KNOWN)];
    await r.serial.recheck();
    // Reopened once the close's 250 ms back-off is over (the hub polls every 500 ms).
    await vi.waitFor(
      async () => {
        await r.serial.poll();
        expect(r.state('/dev/cu.usbmodem1201')).toBe('open');
      },
      { timeout: 5000, interval: 100 },
    );
    expect(h.FakePort.opened).toContain('/dev/cu.usbmodem1201');
  });

  it("watches a bridge port once the board seen on it is registered (ports_seen.device_id), also after a re-plug", async () => {
    const r = await rig();
    h.FakePort.listed = [CH340];
    await r.serial.poll();
    expect(r.state('/dev/cu.usbserial-110')).toBe('unwatched');
    // A provision's probe (or a HELLO on a claimed port) names the board; then it is registered.
    r.serial.notePortDevice('path:usbserial-110', 'A0:B1:C2:D3:E4:F5');
    await r.serial.poll();
    expect(r.state('/dev/cu.usbserial-110')).toBe('unwatched');
    r.register('a0b1c2d3e4f5', 'cam-esp32');
    await r.serial.poll();
    expect(r.state('/dev/cu.usbserial-110')).toBe('open');
    h.FakePort.listed = [];
    await r.serial.poll();
    await new Promise((res) => setTimeout(res, 1600)); // past the gone debounce
    await r.serial.poll();
    expect(r.serial.list()).toEqual([]);
    h.FakePort.listed = [CH340];
    h.FakePort.opened = [];
    await r.serial.poll();
    expect(h.FakePort.opened).toEqual(['/dev/cu.usbserial-110']);
  });

  it('lends an unwatched port and leaves it closed when the lend expires', async () => {
    const r = await rig();
    h.FakePort.listed = [OWN(1201, STRANGER)];
    await r.serial.poll();
    const lend = (await HANDLERS.port_lend({ port: '/dev/cu.usbmodem1201', ttl_s: 60 }, r.hub)) as { lease_id: string; path: string; ttl_s: number };
    expect(lend).toMatchObject({ path: '/dev/cu.usbmodem1201', ttl_s: 60 });
    expect(r.state('/dev/cu.usbmodem1201')).toBe('leased');
    r.clock.now += 61_000;
    await vi.waitFor(() => expect(r.hub.leases.list()).toEqual([]));
    await r.serial.poll();
    expect(r.state('/dev/cu.usbmodem1201')).toBe('unwatched');
    expect(h.FakePort.opened).toEqual([]);
  });

  it('lets a provision lease an unwatched port, and watches it once the board is registered', async () => {
    const r = await rig();
    h.FakePort.listed = [OWN(1201, STRANGER)];
    await r.serial.poll();
    const lease = await r.serial.lease(STRANGER, 'job j_1');
    expect(r.state('/dev/cu.usbmodem1201')).toBe('leased');
    r.register(STRANGER, 'pad-new'); // the provision's registry stage
    lease.release();
    await vi.waitFor(() => expect(r.state('/dev/cu.usbmodem1201')).toBe('open'));
  });
});

describe('port_claim and port_ignore', () => {
  it('claim opens an unknown board now and writes ports.claim, keeping unknown keys; remove takes it back', async () => {
    const r = await rig({ ports: { ignore: ['/dev/cu.usbmodem1201'] }, mine: { keep: 1 } });
    h.FakePort.listed = [OWN(1201, STRANGER)];
    await r.serial.poll();
    expect(r.state('/dev/cu.usbmodem1201')).toBe('ignored');
    const res = await HANDLERS.port_claim({ port: '/dev/tty.usbmodem1201', remove: false }, r.hub);
    expect(res).toMatchObject({ port: STRANGER, path: '/dev/cu.usbmodem1201', state: 'open', ignore: [], claim: [STRANGER] });
    expect(JSON.parse(readFileSync(r.config, 'utf8'))).toEqual({ ports: { ignore: [], claim: [STRANGER] }, mine: { keep: 1 } });
    expect(r.serial.list()[0]).toMatchObject({ state: 'open', policy: 'claimed' });
    await HANDLERS.port_claim({ port: STRANGER, remove: true }, r.hub);
    expect(r.state('/dev/cu.usbmodem1201')).toBe('unwatched');
  });

  it('ignore closes a watched port now (also in mode all) and remove opens it again', async () => {
    const r = await rig({ ports: { mode: 'all' } });
    h.FakePort.listed = [OWN(1101, KNOWN), CH340];
    await r.serial.poll();
    expect(r.serial.list().map((p) => p.state)).toEqual(['open', 'open']);
    const res = await HANDLERS.port_ignore({ port: '1C:DB:D4:00:01:34', remove: false }, r.hub);
    expect(res).toMatchObject({ port: KNOWN, mode: 'all', ignore: [KNOWN] });
    expect(r.state('/dev/cu.usbmodem1101')).toBe('ignored');
    await HANDLERS.port_ignore({ port: '1a86:7523', remove: false }, r.hub);
    expect(r.state('/dev/cu.usbserial-110')).toBe('ignored');
    await HANDLERS.port_ignore({ port: '/dev/cu.usbmodem1101', remove: true }, r.hub);
    await vi.waitFor(() => expect(r.state('/dev/cu.usbmodem1101')).toBe('open'));
    expect(JSON.parse(readFileSync(r.config, 'utf8')).ports).toEqual({ mode: 'all', ignore: ['1a86:7523'] });
  });

  it('refuses to claim a lent port, and an unknown one', async () => {
    const r = await rig();
    h.FakePort.listed = [OWN(1201, STRANGER)];
    await r.serial.poll();
    await HANDLERS.port_lend({ port: STRANGER, ttl_s: 60 }, r.hub);
    await expect(HANDLERS.port_claim({ port: STRANGER, remove: false }, r.hub)).rejects.toMatchObject({ code: 'PORT_LEASED' });
    await expect(HANDLERS.port_claim({ port: '/dev/cu.nothing', remove: false }, r.hub)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('a config file that is not right', () => {
  it('is reported in hub_status and not fatal; with no valid ports settings read yet, no port is opened', async () => {
    const r = await rig('{ "ports": { "mode": "al');
    r.register(KNOWN, 'pad-c6');
    h.FakePort.listed = [OWN(1201, STRANGER), OWN(1101, KNOWN)];
    await r.serial.poll();
    expect(r.state('/dev/cu.usbmodem1201')).toBe('unwatched');
    // Not even a registered board: the file may have meant to ignore it.
    expect(r.serial.list().find((p) => p.path === '/dev/cu.usbmodem1101')).toMatchObject({ state: 'unwatched', policy: 'config_invalid' });
    expect(h.FakePort.opened).toEqual([]);
    expect(r.hub.portPolicy!.warnings().some((w) => w.includes('opens no port until the file is fixed'))).toBe(true);
    // hub_status lists the policy's warnings with the other parts'.
    expect(r.hub.portPolicy!.warnings().some((w) => w.includes('is not valid JSON'))).toBe(true);
    // A port op does not overwrite it.
    await expect(HANDLERS.port_claim({ port: STRANGER, remove: false }, r.hub)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(readFileSync(r.config, 'utf8')).toBe('{ "ports": { "mode": "al');
  });

  it('a wrong value falls back to its default and is named', async () => {
    const r = await rig({ ports: { mode: 'everything', ignore: 'x' } });
    const warnings = r.hub.portPolicy!.warnings().join('\n');
    expect(warnings).toMatch(/ports\.mode is "everything"/);
    expect(warnings).toMatch(/ports\.ignore is not a list/);
    expect(r.hub.portPolicy!.config().config.ports.mode).toBe('adopted');
  });

  it('a hand edit that breaks the file keeps the ports settings read before: an ignored board stays closed', async () => {
    const r = await rig();
    r.register(KNOWN, 'clock');
    h.FakePort.listed = [OWN(1101, KNOWN)];
    await r.serial.poll();
    expect(r.state('/dev/cu.usbmodem1101')).toBe('open');
    await HANDLERS.port_ignore({ port: 'clock', remove: false }, r.hub);
    expect(r.state('/dev/cu.usbmodem1101')).toBe('ignored');
    // A trailing comma.
    writeFileSync(r.config, `{"ports":{"ignore":["${KNOWN}"],}}`);
    r.hub.portPolicy!.refresh();
    for (let i = 0; i < 3; i++) {
      await r.serial.poll();
    }
    expect(r.state('/dev/cu.usbmodem1101')).toBe('ignored');
    expect(h.FakePort.opened).toEqual(['/dev/cu.usbmodem1101']); // only the first open, before the ignore
    const warnings = r.hub.portPolicy!.warnings().join('\n');
    expect(warnings).toMatch(/is not valid JSON/);
    expect(warnings).toMatch(/keeping the ports, retention, log, mcp, time settings read before/);
    // A wrong value in the ports section alone holds that section too.
    writeFileSync(r.config, JSON.stringify({ ports: { ignore: KNOWN } }));
    r.hub.portPolicy!.refresh();
    await r.serial.poll();
    expect(r.state('/dev/cu.usbmodem1101')).toBe('ignored');
    expect(r.hub.portPolicy!.warnings().join('\n')).toMatch(/keeping the ports settings read before/);
    // A port op does not rewrite the broken section (that would drop the settings held).
    await expect(HANDLERS.port_claim({ port: KNOWN, remove: false }, r.hub)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(JSON.parse(readFileSync(r.config, 'utf8'))).toEqual({ ports: { ignore: KNOWN } });
    // Fixed (and the ignore taken out): the new settings apply.
    writeFileSync(r.config, JSON.stringify({ ports: { ignore: [] } }));
    r.hub.portPolicy!.refresh();
    await vi.waitFor(async () => {
      await r.serial.poll();
      expect(r.state('/dev/cu.usbmodem1101')).toBe('open');
    });
    expect(r.hub.portPolicy!.warnings()).toEqual([]);
  });
});

describe('port_ignore by name', () => {
  it('ignores a registered board that is not plugged in by its MAC, so it stays closed when it is', async () => {
    const r = await rig();
    r.register('aabbcc000009', 'gamma');
    const res = await HANDLERS.port_ignore({ port: 'gamma', remove: false }, r.hub);
    expect(res).toMatchObject({ port: 'aabbcc000009', ignore: ['aabbcc000009'] });
    h.FakePort.listed = [OWN(1501, 'aabbcc000009')];
    await r.serial.poll();
    expect(r.state('/dev/cu.usbmodem1501')).toBe('ignored');
    expect(h.FakePort.opened).toEqual([]);
    // And `--remove` by the same name.
    await HANDLERS.port_ignore({ port: 'gamma', remove: true }, r.hub);
    await vi.waitFor(() => expect(r.state('/dev/cu.usbmodem1501')).toBe('open'));
  });

  it('refuses text that is no port, pattern or registered board (it would match nothing)', async () => {
    const r = await rig();
    await expect(HANDLERS.port_ignore({ port: 'gamma', remove: false }, r.hub)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(() => readFileSync(r.config, 'utf8')).toThrow();
    // Patterns are taken as they are.
    for (const p of ['/dev/tty.usbmodem1701', 'usbserial-120', 'path:usbserial-130', '10c4:ea60', 'AA:BB:CC:00:00:0A']) {
      await HANDLERS.port_ignore({ port: p, remove: false }, r.hub);
    }
    expect(JSON.parse(readFileSync(r.config, 'utf8')).ports.ignore).toEqual([
      '/dev/cu.usbmodem1701',
      'usbserial-120',
      'path:usbserial-130',
      '10c4:ea60',
      'aabbcc00000a',
    ]);
  });

  it("a board's MAC also covers the bridge port it was last seen on", async () => {
    const r = await rig({ ports: { mode: 'all' } });
    r.register('a0b1c2d3e4f5', 'cam-esp32');
    h.FakePort.listed = [CH340];
    await r.serial.poll();
    r.serial.learnDevice('path:usbserial-110', 'a0b1c2d3e4f5'); // its HELLO
    const res = await HANDLERS.port_ignore({ port: 'cam-esp32', remove: false }, r.hub);
    expect(res).toMatchObject({ port: 'a0b1c2d3e4f5', path: '/dev/cu.usbserial-110', state: 'ignored' });
  });
});

describe('a bridge port and its adapter', () => {
  const CP2102 = (serial?: string) => ({ path: '/dev/tty.usbserial-110', vendorId: '10c4', productId: 'ea60', ...(serial ? { serialNumber: serial } : {}) });

  async function adopted(first: { path: string; vendorId: string; productId: string; serialNumber?: string }) {
    const r = await rig();
    r.register('a0b1c2d3e4f5', 'cam-esp32');
    h.FakePort.listed = [first];
    await r.serial.poll();
    r.serial.notePortDevice('path:usbserial-110', 'a0b1c2d3e4f5');
    await r.serial.poll();
    expect(r.state('/dev/cu.usbserial-110')).toBe('open');
    return r;
  }

  async function replug(r: Rig, next: { path: string; vendorId: string; productId: string; serialNumber?: string }) {
    h.FakePort.listed = [];
    await r.serial.poll();
    await new Promise((res) => setTimeout(res, 1600)); // past the gone debounce
    await r.serial.poll();
    h.FakePort.listed = [next];
    h.FakePort.opened = [];
    await r.serial.poll();
  }

  it('another kind of adapter in the same socket is not the adopted board', async () => {
    const r = await adopted(CH340);
    await replug(r, CP2102());
    expect(r.serial.list()[0]).toMatchObject({ state: 'unwatched', policy: 'not_adopted' });
    expect(h.FakePort.opened).toEqual([]);
  });

  it('an adapter of the same kind with another serial number is not either; the same adapter is', async () => {
    const r = await adopted(CP2102('0001A'));
    await replug(r, CP2102('0002B'));
    expect(r.state('/dev/cu.usbserial-110')).toBe('unwatched');
    await replug(r, CP2102('0001A'));
    expect(r.state('/dev/cu.usbserial-110')).toBe('open');
  });

  it('a different adapter re-plugged inside the gone debounce is a new port too', async () => {
    const r = await adopted(CH340);
    h.FakePort.listed = [CP2102('77')];
    h.FakePort.opened = [];
    await r.serial.poll();
    expect(r.state('/dev/cu.usbserial-110')).toBe('unwatched');
    expect(h.FakePort.opened).toEqual([]);
  });
});

describe('a reset through the hub on a port it leaves closed', () => {
  it('fails at once, so a job falls back to esptool without waiting', async () => {
    const r = await rig();
    h.FakePort.listed = [OWN(1201, STRANGER)];
    await r.serial.poll();
    const t0 = Date.now();
    await expect(r.serial.hardReset(STRANGER)).rejects.toMatchObject({ code: 'DEVICE_OFFLINE', details: { state: 'unwatched' } });
    // Also right after a lease ends, while the port is `closed` until the next poll applies the policy.
    const lease = await r.serial.lease(STRANGER, 'job j_1');
    lease.release();
    await expect(r.serial.hardReset(STRANGER)).rejects.toMatchObject({ code: 'DEVICE_OFFLINE' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

// A board flashed here for another hub (device_provision `for_hub`, 06 §6.4 "For another hub").
describe("a board that is another hub's", () => {
  const movedTo = (r: Rig, deviceId: string) =>
    r.hub.db.prepare('UPDATE devices SET provisioned = 0, addr = NULL, provision = ? WHERE device_id = ?').run(JSON.stringify({ via: 'provision', for_hub: 'http://127.0.0.1:7520' }), deviceId);

  it('is not adopted once its row says it was flashed for another hub, though the row stays', async () => {
    const r = await rig();
    r.register(KNOWN, 'mic-1');
    h.FakePort.listed = [OWN(1101, KNOWN)];
    await r.serial.poll();
    expect(r.state('/dev/cu.usbmodem1101')).toBe('open');
    movedTo(r, KNOWN);
    await r.serial.poll();
    expect(r.state('/dev/cu.usbmodem1101')).toBe('unwatched');
    expect((await listPorts(r.hub)).ports.map((p) => [p.path, p.state, p.policy, p.alias])).toEqual([['/dev/cu.usbmodem1101', 'unwatched', 'not_adopted', 'mic-1']]);
    // A record that only mentions the words, or cannot be read, is an ordinary row: adopted.
    r.hub.db.prepare('UPDATE devices SET provision = ? WHERE device_id = ?').run(JSON.stringify({ via: 'provision', hub_host: '"for_hub"' }), KNOWN);
    await r.serial.poll();
    expect(r.state('/dev/cu.usbmodem1101')).toBe('open');
    r.hub.db.prepare('UPDATE devices SET provision = ? WHERE device_id = ?').run('{"for_hub": ', KNOWN);
    await r.serial.poll();
    expect(r.state('/dev/cu.usbmodem1101')).toBe('open');
    // Claimed by hand, a moved board's port is read like any claimed port.
    movedTo(r, KNOWN);
    await r.serial.poll();
    expect(r.state('/dev/cu.usbmodem1101')).toBe('unwatched');
    await HANDLERS.port_claim({ port: KNOWN, remove: false }, r.hub);
    expect(r.state('/dev/cu.usbmodem1101')).toBe('open');
  });

  it('is read while a job watches its port (watchFor): the reset works, and the port closes when the job lets go', async () => {
    const r = await rig({ ports: { ignore: ['/dev/cu.usbmodem1301'] } });
    r.register(KNOWN, 'mic-1');
    movedTo(r, KNOWN);
    h.FakePort.listed = [OWN(1101, KNOWN), OWN(1201, STRANGER), OWN(1301, '1cdbd4000777')];
    await r.serial.poll();
    expect([r.state('/dev/cu.usbmodem1101'), r.state('/dev/cu.usbmodem1201'), r.state('/dev/cu.usbmodem1301')]).toEqual(['unwatched', 'unwatched', 'ignored']);
    // The provisioning job: watch, lease for the flash, release, reset through the hub's own handle.
    const unwatch = [r.serial.watchFor(KNOWN), r.serial.watchFor(STRANGER), r.serial.watchFor('1cdbd4000777')];
    const lease = await r.serial.lease(STRANGER, 'job j_1');
    lease.release();
    await expect(r.serial.hardReset(STRANGER)).resolves.toMatchObject({ key: STRANGER });
    await r.serial.poll();
    // What port_list shows is still the policy's own answer; an ignored port is never opened.
    expect((await listPorts(r.hub)).ports.map((p) => [p.path, p.state, p.policy])).toEqual([
      ['/dev/cu.usbmodem1101', 'open', 'not_adopted'],
      ['/dev/cu.usbmodem1201', 'open', 'not_adopted'],
      ['/dev/cu.usbmodem1301', 'ignored', 'ignored'],
    ]);
    unwatch.forEach((u) => u());
    unwatch[0](); // a second call changes nothing
    await r.serial.recheck();
    expect([r.state('/dev/cu.usbmodem1101'), r.state('/dev/cu.usbmodem1201'), r.state('/dev/cu.usbmodem1301')]).toEqual(['unwatched', 'unwatched', 'ignored']);
  });
});
