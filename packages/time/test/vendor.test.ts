// The drift check `fr gen --check` runs (src/vendor.ts), on scratch copies of the package: the vendored files against
// time.lock, and against a web checkout beside the repository when there is one.

import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { checkVendor, readLock } from '@fractonica/time/vendor';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');

let work = '';
afterEach(() => {
  if (work) {
    rmSync(work, { recursive: true, force: true });
    work = '';
  }
});

/** A scratch `devices/` with the package's lock and vendored files; with `web`, a `web/` beside it holding the same files. */
function scratch(web: boolean): { repo: string; web: string } {
  work = mkdtempSync(join(tmpdir(), 'fr-time-vendor-'));
  const repo = join(work, 'devices');
  mkdirSync(join(repo, 'packages', 'time'), { recursive: true });
  cpSync(join(PKG, 'time.lock'), join(repo, 'packages', 'time', 'time.lock'));
  cpSync(join(PKG, 'vendor'), join(repo, 'packages', 'time', 'vendor'), { recursive: true });
  const webDir = join(work, 'web');
  if (web) {
    mkdirSync(join(webDir, 'public', 'lib'), { recursive: true });
    cpSync(join(PKG, 'vendor', 'fractonica.wasm'), join(webDir, 'public', 'fractonica.wasm'));
    cpSync(join(PKG, 'vendor', 'lib', 'fractonica.js'), join(webDir, 'public', 'lib', 'fractonica.js'));
    cpSync(join(PKG, 'vendor', 'lib', 'fractonica.d.ts'), join(webDir, 'public', 'lib', 'fractonica.d.ts'));
    execFileSync('git', ['init', '-q', webDir]);
    execFileSync('git', ['-C', webDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  }
  return { repo, web: webDir };
}

describe('the vendored core against time.lock and ../web', () => {
  it('is in step in this checkout (with ../web when it is checked out beside it)', async () => {
    const r = await checkVendor(join(PKG, '..', '..'));
    expect(r.stale).toEqual([]);
    expect(r.core).toBe('0.2.0');
  });

  it('without ../web: checks the lock only, quietly', async () => {
    const { repo } = scratch(false);
    expect(await checkVendor(repo)).toMatchObject({ web: null, stale: [], written: [] });
  });

  it('a hand edit of a vendored file is stale, with or without ../web', async () => {
    const { repo } = scratch(false);
    appendFileSync(join(repo, 'packages', 'time', 'vendor', 'lib', 'fractonica.d.ts'), '\n');
    const r = await checkVendor(repo);
    expect(r.stale).toEqual(['packages/time/vendor/lib/fractonica.d.ts (sha256 differs from time.lock)']);
    // without ../web, a write has nothing to restore it from: it stays stale
    expect((await checkVendor(repo, { write: true })).stale).toHaveLength(1);
  });

  it('reports drift from ../web, and a write copies the web files in and rewrites the lock', async () => {
    const { repo, web } = scratch(true);
    expect((await checkVendor(repo)).stale).toEqual([]);
    appendFileSync(join(web, 'public', 'lib', 'fractonica.js'), '\n// a newer binding\n');
    const check = await checkVendor(repo);
    expect(check.web).toBe('../web');
    expect(check.stale).toEqual(['packages/time/vendor/lib/fractonica.js (differs from ../web/public/lib/fractonica.js)']);
    const write = await checkVendor(repo, { write: true });
    expect(write.stale).toEqual([]);
    expect(write.written).toEqual(['packages/time/vendor/lib/fractonica.js', 'packages/time/time.lock']);
    expect(readFileSync(join(repo, 'packages', 'time', 'vendor', 'lib', 'fractonica.js'), 'utf8')).toContain('a newer binding');
    const lock = readLock(repo);
    expect(lock.web.commit).toBe(execFileSync('git', ['-C', web, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
    expect(lock.files['vendor/lib/fractonica.js'].sha256).not.toBe(readLock(join(PKG, '..', '..')).files['vendor/lib/fractonica.js'].sha256);
    expect(await checkVendor(repo)).toMatchObject({ stale: [], written: [] });
  });
});
