// The temporal core in Node: the vendored WebAssembly build of the C core (vendor/fractonica.wasm) and its JavaScript
// binding (vendor/lib/fractonica.js), both byte for byte the files of the web repository, pinned by time.lock.
//
// The module is read from disk (never fetched), compiled and instantiated once per process, on first use: a command
// that never asks for Fractonica time never pays for it. Every Fractonica number, name, symbol, phase, boundary, span,
// date and formatted quantity in this package is an answer of this module; the TypeScript around it parses arguments
// and lays text out.

import { readFileSync } from 'node:fs';

import { load } from '../vendor/lib/fractonica.js';
import type { Core } from './core-types.ts';

export { type Core, CoreError } from './core-types.ts';

/** Where the module is: vendor/fractonica.wasm, beside vendor/lib/ as in the web repository's public/. */
export const WASM_URL = new URL('../vendor/fractonica.wasm', import.meta.url);

let loading: Promise<Core> | null = null;

/** The core, loaded on the first call and shared after it. */
export function loadCore(): Promise<Core> {
  loading ??= (async () => {
    const frc = await load(readFileSync(WASM_URL));
    return { frc, cat: frc.saros141 };
  })();
  // A failed load is not cached: the next call tries again.
  loading.catch(() => (loading = null));
  return loading;
}
