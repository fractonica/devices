// The vendored core and its lock (packages/time/time.lock): `fr gen --check` runs checkVendor, `fr gen` runs it with
// `write`. The lock records the core and SPEC versions the module reports, the web commit the files came from and
// the sha256 of each file.
//
// - Always: each vendored file must hash to what the lock says (a hand edit of a vendored file is stale).
// - When the web repository is checked out beside this one (`../web`, with public/lib/fractonica.js): each vendored
//   file must equal its source there byte for byte. A difference is drift: --check reports it as stale, and a write
//   copies the web's files in and rewrites the lock. Without `../web` there is nothing to compare, and nothing is said.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The package, relative to the checkout. */
export const TIME_DIR = 'packages/time';
export const LOCK_FILE = `${TIME_DIR}/time.lock`;

export interface TimeLock {
  schema: 'fractonica.time-lock/1';
  core: string;
  spec: string;
  web: { repository: string; commit: string };
  /** Vendored path (relative to the package) -> its source in the web repository and its sha256. */
  files: Record<string, { from: string; sha256: string }>;
}

export interface VendorResult {
  /** The lock's file and the web checkout compared with, or null when there is none beside this checkout. */
  lock: string;
  web: string | null;
  /** Repo-relative paths that are stale, each with why (check mode; in write mode, what could not be fixed). */
  stale: string[];
  /** Repo-relative paths written (write mode). */
  written: string[];
  core: string;
  spec: string;
}

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

export function readLock(sourceDir: string): TimeLock {
  return JSON.parse(readFileSync(join(sourceDir, LOCK_FILE), 'utf8')) as TimeLock;
}

/** The web checkout beside `sourceDir`, when there is one. */
export function webCheckout(sourceDir: string): string | null {
  const web = join(sourceDir, '..', 'web');
  return existsSync(join(web, 'public', 'lib', 'fractonica.js')) && existsSync(join(web, 'public', 'fractonica.wasm')) ? web : null;
}

function webCommit(web: string): string {
  try {
    return execFileSync('git', ['-C', web, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

/** The versions the vendored module reports (its binding, loaded fresh so a file just copied in is the one read). */
async function moduleVersions(pkg: string): Promise<{ core: string; spec: string }> {
  const js = pathToFileURL(join(pkg, 'vendor', 'lib', 'fractonica.js'));
  js.search = `?sha=${sha256(join(pkg, 'vendor', 'lib', 'fractonica.js'))}`;
  const binding = (await import(js.href)) as typeof import('../vendor/lib/fractonica.js');
  const frc = await binding.load(readFileSync(join(pkg, 'vendor', 'fractonica.wasm')));
  return { core: frc.version, spec: frc.specVersion };
}

/** A lock's `files` against the vendored copies under `pkg` and their sources in `web`, as checkVendor describes. */
function syncFiles(
  pkg: string,
  pkgRel: string,
  files: Record<string, { from: string; sha256: string }>,
  web: string | null,
  write: boolean,
  lockName: string,
): { stale: string[]; written: string[]; lockChanged: boolean } {
  const stale: string[] = [];
  const written: string[] = [];
  let lockChanged = false;
  for (const [rel, entry] of Object.entries(files)) {
    const vendored = join(pkg, rel);
    const path = `${pkgRel}/${rel}`;
    if (web) {
      const source = join(web, entry.from);
      if (!existsSync(source)) {
        stale.push(`${path} (its source ${entry.from} is missing from ../web)`);
        continue;
      }
      const same = existsSync(vendored) && sha256(source) === sha256(vendored);
      if (!same) {
        if (write) {
          copyFileSync(source, vendored);
          written.push(path);
        } else {
          stale.push(`${path} (differs from ../web/${entry.from})`);
          continue;
        }
      }
    }
    if (!existsSync(vendored)) {
      stale.push(`${path} (missing)`);
      continue;
    }
    const hash = sha256(vendored);
    if (hash !== entry.sha256) {
      if (write && web) {
        entry.sha256 = hash;
        lockChanged = true;
      } else {
        stale.push(`${path} (sha256 differs from ${lockName})`);
      }
    }
  }
  return { stale, written, lockChanged };
}

/** Compares the vendored files with the lock and with `../web`; with `write`, brings them in step. */
export async function checkVendor(sourceDir: string, opts: { write?: boolean } = {}): Promise<VendorResult> {
  const pkg = join(sourceDir, TIME_DIR);
  const lock = readLock(sourceDir);
  const web = webCheckout(sourceDir);
  const synced = syncFiles(pkg, TIME_DIR, lock.files, web, Boolean(opts.write), 'time.lock');
  const { stale, written } = synced;
  let lockChanged = synced.lockChanged;
  const versions = stale.length ? { core: lock.core, spec: lock.spec } : await moduleVersions(pkg);
  if (!stale.length && (versions.core !== lock.core || versions.spec !== lock.spec)) {
    if (opts.write && web) {
      lock.core = versions.core;
      lock.spec = versions.spec;
      lockChanged = true;
    } else {
      stale.push(`${LOCK_FILE} (says core ${lock.core}, SPEC ${lock.spec}; the module is core ${versions.core}, SPEC ${versions.spec})`);
    }
  }
  if (opts.write && web && (lockChanged || written.length)) {
    lock.web.commit = webCommit(web);
    writeFileSync(join(sourceDir, LOCK_FILE), JSON.stringify(lock, null, 2) + '\n');
    written.push(LOCK_FILE);
  }
  return { lock: LOCK_FILE, web: web ? '../web' : null, stale, written, core: versions.core, spec: versions.spec };
}

// ------------------------------------------------------------------------------------------------------------------
// The dashboard's design tokens (packages/dashboard/src/design/tokens.js): the web repository's
// public/app/design/tokens.js byte for byte, pinned by tokens.lock beside it, checked and refreshed the same way.

export const TOKENS_DIR = 'packages/dashboard/src/design';
export const TOKENS_LOCK_FILE = `${TOKENS_DIR}/tokens.lock`;

export interface TokensLock {
  schema: 'fractonica.tokens-lock/1';
  web: { repository: string; commit: string };
  files: Record<string, { from: string; sha256: string }>;
}

export interface TokensResult {
  lock: string;
  web: string | null;
  stale: string[];
  written: string[];
}

/** The token table against tokens.lock and `../web`; with `write`, copies the web's file in and rewrites the lock. */
export function checkTokens(sourceDir: string, opts: { write?: boolean } = {}): TokensResult {
  const lockPath = join(sourceDir, TOKENS_LOCK_FILE);
  const web = webCheckout(sourceDir);
  if (!existsSync(lockPath)) {
    return { lock: TOKENS_LOCK_FILE, web: web ? '../web' : null, stale: [`${TOKENS_LOCK_FILE} (missing)`], written: [] };
  }
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as TokensLock;
  const { stale, written, lockChanged } = syncFiles(join(sourceDir, TOKENS_DIR), TOKENS_DIR, lock.files, web, Boolean(opts.write), 'tokens.lock');
  if (opts.write && web && (lockChanged || written.length)) {
    lock.web.commit = webCommit(web);
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
    written.push(TOKENS_LOCK_FILE);
  }
  return { lock: TOKENS_LOCK_FILE, web: web ? '../web' : null, stale, written };
}
