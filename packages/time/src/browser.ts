// @fractonica/time/browser: the temporal core for a browser bundle (the dashboard). The same vendored module and the
// same readers as the CLI and the hub (read.ts, earth.ts, instant.ts), with a loader that takes the module's URL (a
// bundler's asset URL, served by the hub as application/wasm) instead of reading it from disk. Nothing here imports a
// Node builtin; the binding's own Node branch (a dynamic node:fs/promises import for file: URLs) is never taken for an
// http(s) URL, and the dashboard's build stubs it.

import { load } from '../vendor/lib/fractonica.js';
import type { Core } from './core-types.ts';

export { type Core, CoreError } from './core-types.ts';
export { civilText, clockTime, dateLine, duration, EARTH_SIGN, isoLocal, isoUtc, nextCivilSecond, when, zoneName } from './earth.ts';
export { CivilForm, DateForm, LevelKind, Quarter, Unit } from '../vendor/lib/fractonica.js';
export type { Catalogue, Fractonica, FrcDate, Span } from '../vendor/lib/fractonica.js';
export { inCatalogue, outOfCatalogueText } from './instant.ts';
export { type NowReading, readNow, type ThresholdView } from './read.ts';

/**
 * The core from `source`: a URL (string or URL object) to fractonica.wasm, a fetch Response, or the module's bytes.
 * Compiled and instantiated on each call: callers keep the one they get (the dashboard loads it once).
 */
export async function loadCoreFrom(source: string | URL | Response | ArrayBuffer | ArrayBufferView): Promise<Core> {
  const frc = await load(source);
  return { frc, cat: frc.saros141 };
}
