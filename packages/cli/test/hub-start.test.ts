// `fr hub start` with FR_HUB (review finding 6): the hub is started on FR_HUB's port, so the health it then checks is
// that hub's, and a started hub is never reported as "did not start"; a remote FR_HUB, or a second hub on an FR_HOME
// whose hub runs, is refused. The hub here is a stand-in script (an HTTP health endpoint on --port): nothing opens a
// serial port, and the real hub's ports are never used.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hubTarget, startHub } from '../src/hub.ts';

const dir = mkdtempSync(join(tmpdir(), 'fr-hub-start-'));
const FAKE = join(dir, 'fake-hub.mjs');
writeFileSync(
  FAKE,
  `import { createServer } from 'node:http';
const i = process.argv.indexOf('--port');
const port = i >= 0 ? Number(process.argv[i + 1]) : 7420;
if (process.env.FAKE_HUB_EXIT) process.exit(Number(process.env.FAKE_HUB_EXIT));
const delay = Number(process.env.FAKE_HUB_DELAY_MS || 0);
setTimeout(() => {
  createServer((req, res) => res.end(JSON.stringify(req.url === '/api/v1/health' ? { ok: true, version: 'fake', registry_hash: 'x', pid: process.pid, port } : { ok: false, cursor: '' }))).listen(port, '127.0.0.1');
}, delay);
setTimeout(() => process.exit(0), 60_000);
`,
);

const saved = { hub: process.env.FR_HUB, home: process.env.FR_HOME, exit: process.env.FAKE_HUB_EXIT, delay: process.env.FAKE_HUB_DELAY_MS };
const pids: number[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

beforeEach(() => {
  process.env.FR_HOME = mkdtempSync(join(dir, 'home-'));
});
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // gone already
    }
  }
  for (const [k, v] of [['FR_HUB', saved.hub], ['FR_HOME', saved.home], ['FAKE_HUB_EXIT', saved.exit], ['FAKE_HUB_DELAY_MS', saved.delay]] as const) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('hubTarget', () => {
  it("is FR_HUB's port on loopback, and a refusal for another host", () => {
    expect(hubTarget({})).toEqual({});
    expect(hubTarget({ FR_HUB: 'http://127.0.0.1:7500' })).toEqual({ port: 7500 });
    expect(hubTarget({ FR_HUB: 'http://localhost:7501/' })).toEqual({ port: 7501 });
    expect(hubTarget({ FR_HUB: 'http://[::1]:7502' })).toEqual({ port: 7502 });
    expect(hubTarget({ FR_HUB: 'http://lab-mac.local:7420' }).remote).toMatch(/another machine/);
    expect(hubTarget({ FR_HUB: 'not a url' }).remote).toMatch(/not a URL/);
  });
});

describe('startHub with FR_HUB', { timeout: 30_000 }, () => {
  it("starts the hub on FR_HUB's port and reports it started", async () => {
    const port = await freePort();
    process.env.FR_HUB = `http://127.0.0.1:${port}`;
    const r = await startHub(false, { main: FAKE });
    if (r.pid) {
      pids.push(r.pid);
    }
    expect(r).toMatchObject({ started: true });
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/v1/health`)).json()) as { port: number; pid: number };
    expect(health.port).toBe(port);
    expect(health.pid).toBe(r.pid);
  });

  it('says it started a hub that runs but does not answer yet, not "did not start"', async () => {
    const port = await freePort();
    process.env.FR_HUB = `http://127.0.0.1:${port}`;
    process.env.FAKE_HUB_DELAY_MS = '20000';
    const r = await startHub(false, { main: FAKE });
    if (r.pid) {
      pids.push(r.pid);
    }
    expect(r).toMatchObject({ started: true, warning: expect.stringContaining('has not answered') });
  });

  it('reports a hub that exits at once as not started, with its exit code', async () => {
    process.env.FR_HUB = `http://127.0.0.1:${await freePort()}`;
    process.env.FAKE_HUB_EXIT = '1';
    const r = await startHub(false, { main: FAKE });
    expect(r).toMatchObject({ started: false, error: expect.stringContaining('exited (code 1)') });
  });

  it('refuses a second hub on an FR_HOME whose hub runs (they would share hub.db and the ports)', async () => {
    // A stand-in for the running hub: a sleeping node whose command line names packages/hub/src/main.ts.
    const decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', join(dir, 'packages', 'hub', 'src', 'main.ts')], { stdio: 'ignore' });
    pids.push(decoy.pid!);
    writeFileSync(join(process.env.FR_HOME!, 'hub.lock'), String(decoy.pid));
    process.env.FR_HUB = `http://127.0.0.1:${await freePort()}`;
    const r = await startHub(false, { main: FAKE });
    expect(r).toMatchObject({ started: false, error: expect.stringContaining(`hub pid ${decoy.pid} already runs`) });
  });

  it('refuses a remote FR_HUB without starting anything', async () => {
    process.env.FR_HUB = 'http://192.0.2.10:7420';
    const r = await startHub(false, { main: FAKE });
    expect(r).toMatchObject({ started: false, error: expect.stringContaining('another machine') });
  });
});
