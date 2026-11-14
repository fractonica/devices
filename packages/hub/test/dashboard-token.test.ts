// The dashboard's /app token and its captures route (DEVICE-SPEC §3.1, §3.2): the hub injects the /app token into the
// dashboard's index.html as it does into an app page (so the device page's camera panel can open /app/stream from
// the hub's own origin), and serves the .jpg files camera_snap and camera_stream wrote under FR_HOME/captures,
// read-only, never anything outside it.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAppServer } from '../src/apps/server.ts';
import type { HubContext, HubRunOptions, WsServer } from '../src/context.ts';
import { buildServer } from '../src/http.ts';
import { captureFile, createStaticSite } from '../src/web/static.ts';
import { otaRig, until } from './fake-node.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

const TOKEN = 'dashboard-token-0123456789abcdef0123';
const RUN: HubRunOptions = { apiHost: '127.0.0.1', apiPort: 0, nodeHost: '127.0.0.1', nodePort: 0, nodeHttpPort: 0, noAdvert: true, serial: false };
const NOOP_WS: WsServer = { start() {}, stop() {}, routes() {} };
const DEV = 'a0b1c2d3e4f6';

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function put(file: string, data: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
}

function freshHome(): string {
  const home = tmp('fr-home-');
  const prev = process.env.FR_HOME;
  process.env.FR_HOME = home;
  cleanups.push(() => (prev === undefined ? delete process.env.FR_HOME : (process.env.FR_HOME = prev)));
  return home;
}

/** A checkout with a built dashboard. */
function checkout(): string {
  const src = tmp('fr-dash-src-');
  put(join(src, 'packages/dashboard/package.json'), JSON.stringify({ name: '@fractonica/dashboard' }));
  put(join(src, 'packages/dashboard/dist/index.html'), '<!doctype html><html><head><script type="module" src="/assets/index-a1.js"></script></head><body></body></html>');
  put(join(src, 'packages/dashboard/dist/assets/index-a1.js'), 'console.log(1);\n');
  return src;
}

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);

/** A real hub server: the router rig, an AppServer with TOKEN, the real static site; a fake node with fr.camera. */
async function hubWithCamera() {
  const r = await otaRig();
  cleanups.push(() => r.close());
  r.registry.add({ device_id: DEV, addr: 0x43, alias: 'cam-esp32', provisioned: true, net: 0, chip: 'esp32' });
  let hub!: HubContext;
  const part = createAppServer(() => hub, RUN, { token: TOKEN });
  const staticSite = createStaticSite(() => hub, RUN);
  hub = { ...r.hub, hubSourceDir: checkout(), appServer: part, wsServer: NOOP_WS, staticSite } as HubContext;
  part.start();
  cleanups.push(() => part.stop());
  const app = buildServer(hub, 0);
  cleanups.push(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  const node = r.node({ mac: DEV, addr: 0x43, alias: 'cam-esp32' });
  node.describeAs([
    { port: 1, cap_id: 0x0002, name: 'status' },
    { port: 2, cap_id: 0x0002, name: 'flash' },
    { port: 3, cap_id: 0x000b, name: 'cam' },
  ]);
  await node.connected(r.events);
  return { app, port };
}

/** A /app/stream socket from the hub's own origin (as the dashboard page opens it), and the frames and close it got. */
function streamSocket(port: number, token: string) {
  const got = { frames: [] as { t: string }[], close: null as number | null };
  // Node's WebSocket (undici) takes headers: the browser sends the page's Origin, the guard checks it against the hub's.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/app/stream`, { headers: { origin: `http://127.0.0.1:${port}` } } as unknown as string[]);
  ws.onmessage = (e) => typeof e.data === 'string' && got.frames.push(JSON.parse(e.data) as { t: string });
  ws.onclose = (e) => (got.close = e.code);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'stream.hello', v: 1, token, device: 'cam-esp32', instance: 'cam' }));
  cleanups.push(() => ws.close());
  return got;
}

describe('the dashboard gets the /app token (DEVICE-SPEC §3.1)', { timeout: 15_000 }, () => {
  it("injects the AppServer's token before the first module script, no-store, the CSP admitting only that script; /assets unchanged", async () => {
    freshHome();
    const { app } = await hubWithCamera();
    const host = { host: `127.0.0.1:${(app.server.address() as AddressInfo).port}` };
    const r = await app.inject({ url: '/', headers: host });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    const script = `window.__FRACTONICA__={token:"${TOKEN}"}`;
    expect(r.body.indexOf(`<script>${script}</script>`)).toBeGreaterThan(0);
    expect(r.body.indexOf(script)).toBeLessThan(r.body.indexOf('<script type="module"'));
    expect(String(r.headers['content-security-policy'])).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+' 'wasm-unsafe-eval';/);
    const asset = await app.inject({ url: '/assets/index-a1.js', headers: host });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(asset.body).not.toContain(TOKEN);
  });

  it('a /app/stream socket from the hub’s origin with that token gets stream.welcome; a wrong token is closed 4401', async () => {
    freshHome();
    const { port } = await hubWithCamera();
    const good = streamSocket(port, TOKEN);
    await until(() => good.frames.length, 5000, 'the welcome');
    expect(good.frames[0]).toMatchObject({ t: 'stream.welcome', alias: 'cam-esp32', instance: 'cam', stream: null });
    const bad = streamSocket(port, 'not-the-token');
    await until(() => bad.close !== null, 5000, 'the close');
    expect(bad.close).toBe(4401);
    expect(bad.frames).toEqual([]);
  });
});

describe('GET /captures/* (DEVICE-SPEC §3.2)', { timeout: 15_000 }, () => {
  it('serves a .jpg under FR_HOME/captures with CORP same-origin; 404 for .., a symlink out, a non-jpg, a directory, a missing file', async () => {
    const home = freshHome();
    const outside = tmp('fr-outside-');
    put(join(home, 'captures/cam-esp32/20261114-020304.jpg'), JPEG);
    put(join(home, 'captures/cam-esp32/20261114-020500/000003.jpg'), JPEG);
    put(join(home, 'captures/cam-esp32/notes.txt'), 'hello');
    put(join(home, 'secrets.json'), '{"app_token":"x"}');
    put(join(outside, 'leak.jpg'), JPEG);
    mkdirSync(join(home, 'captures/cam-esp32/dir.jpg'), { recursive: true });
    symlinkSync(join(outside, 'leak.jpg'), join(home, 'captures/cam-esp32/link.jpg'));
    symlinkSync(join(home, 'captures/cam-esp32/20261114-020304.jpg'), join(home, 'captures/cam-esp32/inside.jpg'));
    const { app } = await hubWithCamera();
    const host = { host: `127.0.0.1:${(app.server.address() as AddressInfo).port}` };
    for (const url of ['/captures/cam-esp32/20261114-020304.jpg', '/captures/cam-esp32/20261114-020500/000003.jpg', '/captures/cam-esp32/inside.jpg']) {
      const r = await app.inject({ url, headers: host });
      expect(r.statusCode, url).toBe(200);
      expect(r.headers['content-type'], url).toBe('image/jpeg');
      expect(r.headers['cross-origin-resource-policy'], url).toBe('same-origin');
      expect(r.headers['x-content-type-options'], url).toBe('nosniff');
      expect(r.headers['cache-control'], url).toBe('no-cache');
      expect(String(r.headers['content-security-policy']), url).toContain("default-src 'none'");
      expect(r.rawPayload.equals(Buffer.from(JPEG)), url).toBe(true);
    }
    for (const url of [
      '/captures/cam-esp32/link.jpg',
      '/captures/cam-esp32/notes.txt',
      '/captures/cam-esp32/dir.jpg',
      '/captures/cam-esp32/missing.jpg',
      '/captures/cam-esp32/../../secrets.json',
      '/captures/%2e%2e/secrets.json',
      '/captures/cam-esp32/%2e%2e/%2e%2e/secrets.json',
      '/captures/',
      '/captures/cam-esp32/',
    ]) {
      const r = await app.inject({ url, headers: host });
      expect(r.statusCode, url).toBe(404);
      expect(r.body, url).not.toContain('app_token');
    }
  });

  it('captureFile: only a .jpg whose real path is inside the root', async () => {
    const root = tmp('fr-cap-');
    const outside = tmp('fr-cap-out-');
    put(join(root, 'a/b.jpg'), JPEG);
    put(join(root, 'c/D.JPG'), JPEG);
    put(join(outside, 'x.jpg'), JPEG);
    symlinkSync(outside, join(root, 'out'));
    expect(await captureFile('a/b.jpg', root)).toMatch(/[/\\]a[/\\]b\.jpg$/);
    expect(await captureFile('c/D.JPG', root)).toMatch(/D\.JPG$/i);
    expect(await captureFile('out/x.jpg', root)).toBeNull();
    expect(await captureFile('a/../a/b.jpg', root)).toBeNull();
    expect(await captureFile('/a/b.jpg', root)).toBeNull();
    expect(await captureFile('a', root)).toBeNull();
    expect(await captureFile('', root)).toBeNull();
    expect(await captureFile('a/b.jpg', join(root, 'nope'))).toBeNull();
  });
});
