// The checkout a command works on: the one around the current directory, else the one this CLI runs from (the shim
// runs `fr` from anywhere). Commands that need a checkout (fr gen, fr build and every op with source_dir, fr display
// window) use it, and say on stderr when they fall back.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findSourceDir } from '@fractonica/host';

/** The checkout this CLI's own files are in, or null (an installed copy outside one). */
export function cliSourceDir(): string | null {
  return findSourceDir(dirname(fileURLToPath(import.meta.url)));
}

/** The checkout for `cwd`, else the CLI's own (`from: 'cli'`), else null. */
export function sourceDirFor(cwd: string = process.cwd()): { dir: string; from: 'cwd' | 'cli' } | null {
  const here = findSourceDir(cwd);
  if (here) {
    return { dir: here, from: 'cwd' };
  }
  const own = cliSourceDir();
  return own ? { dir: own, from: 'cli' } : null;
}

/** sourceDirFor, with a stderr note when it is not the cwd's. */
export function resolveSourceDir(cwd: string = process.cwd()): string | null {
  const src = sourceDirFor(cwd);
  if (src?.from === 'cli') {
    process.stderr.write(`fr: ${cwd} is not inside a Fractonica checkout; using ${src.dir}, the checkout this fr runs from\n`);
  }
  return src?.dir ?? null;
}
