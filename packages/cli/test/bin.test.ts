// The bin wrapper (bin/fr.mjs): plain `node bin/fr.mjs` runs the CLI from source from any directory, passes the exit
// code through, and a command that needs a checkout falls back to the CLI's own when the working directory is not in
// one (saying so on stderr). `pnpm fr` runs it in the directory pnpm was called from (INIT_CWD). The doctor's shim
// execs the wrapper. No hub is involved (FR_HUB points at a closed port).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { shimText } from '@fractonica/host';

import { sourceDirFor } from '../src/source.ts';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'fr.mjs');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'fr-bin-')));
afterAll(() => rmSync(outside, { recursive: true, force: true }));

const fr = (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd: opts.cwd ?? outside,
    env: { ...process.env, FR_HUB: 'http://127.0.0.1:9', FR_HOME: join(outside, 'home'), ...opts.env },
    encoding: 'utf8',
    timeout: 120_000,
  });

describe('bin/fr.mjs', { timeout: 180_000 }, () => {
  it('runs the CLI from source outside a checkout, and passes the exit code through', () => {
    const help = fr(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: fr');
    const usage = fr(['nope', '--json']);
    expect(usage.status).toBe(64);
    const down = fr(['devices', 'ls', '--json']);
    expect(down.status).toBe(10);
    expect(JSON.parse(down.stdout)).toMatchObject({ ok: false, error: { code: 'HUB_UNREACHABLE' } });
  });

  it("falls back to the CLI's own checkout for fr gen --check outside one, and says so", () => {
    const r = fr(['gen', '--check', '--json']);
    expect(r.stderr).toContain(`is not inside a Fractonica checkout; using ${ROOT}`);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true });
  });

  it('runs in INIT_CWD under `pnpm fr` (npm_lifecycle_event fr), so relative paths are the caller’s', () => {
    const r = fr(['gen', '--check', '--json'], { cwd: ROOT, env: { npm_lifecycle_event: 'fr', INIT_CWD: outside } });
    expect(r.stderr).toContain(`${outside} is not inside a Fractonica checkout`);
  });
});

describe('sourceDirFor and the shim', () => {
  it('prefers the working directory, then the CLI checkout', () => {
    expect(sourceDirFor(join(ROOT, 'packages', 'hub'))).toEqual({ dir: ROOT, from: 'cwd' });
    expect(sourceDirFor(outside)).toEqual({ dir: ROOT, from: 'cli' });
  });

  it('execs the wrapper with a pinned Node', () => {
    expect(shimText('/repo', '/usr/local/bin/node')).toContain('exec "/usr/local/bin/node" "/repo/packages/cli/bin/fr.mjs" "$@"');
  });
});
