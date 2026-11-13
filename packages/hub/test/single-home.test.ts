// One hub per FR_HOME (spec 08 §8.2), whatever its port: a hub started on another port than the running one, with the
// same FR_HOME, would share hub.db and fight over the USB ports. Its hub.lock names a live hub process, so the new one
// exits 0 with already_running before it opens hub.db. The "running hub" here is a sleeping node whose command line
// names packages/hub/src/main.ts (what lock.ts checks); the real hub, its port and its FR_HOME are never touched.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts');
const dir = mkdtempSync(join(tmpdir(), 'fr-single-home-'));
const pids: number[] = [];
afterAll(() => {
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch {
      // gone
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('a second hub on one FR_HOME', { timeout: 60_000 }, () => {
  it('exits 0 with already_running before opening hub.db, on any port', async () => {
    const home = mkdtempSync(join(dir, 'home-'));
    const decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', join(dir, 'packages', 'hub', 'src', 'main.ts')], { stdio: 'ignore' });
    pids.push(decoy.pid!);
    writeFileSync(join(home, 'hub.lock'), String(decoy.pid));
    const args = ['--conditions=@fractonica/source', MAIN, '--port', '0', '--node-host', '127.0.0.1', '--node-port', '0', '--node-http-port', '0', '--no-advert', '--no-serial'];
    const proc = spawn(process.execPath, args, { env: { ...process.env, FR_HOME: home, FR_HUB: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
    proc.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => proc.kill('SIGKILL'), 45_000);
    const code = await new Promise<number | null>((r) => proc.on('exit', (c) => r(c)));
    clearTimeout(timer);
    expect(code, out).toBe(0);
    expect(out).toContain(`"event":"already_running","pid":${decoy.pid}`);
    expect(existsSync(join(home, 'hub.db'))).toBe(false);
  });
});
