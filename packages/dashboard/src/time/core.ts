// The temporal core in the dashboard: the same vendored fractonica.wasm the CLI and the hub use (packages/time), as a
// hashed asset of this build (the hub serves it as application/wasm under a CSP with 'wasm-unsafe-eval'), loaded once.
// Every Fractonica number and word on a page comes from it; React reads it through the hooks in time/hooks.ts.

import { type Core, loadCoreFrom } from '@fractonica/time/browser';

import wasmUrl from '../../../time/vendor/fractonica.wasm?url';

type CoreState = { core: Core | null; error: Error | null };

let state: CoreState = { core: null, error: null };
let loading: Promise<Core> | null = null;
const listeners = new Set<() => void>();

function set(next: CoreState): void {
  state = next;
  for (const l of listeners) {
    l();
  }
}

/** The core, loading it on the first call; a failed load is tried again on the next call. */
export function loadCore(): Promise<Core> {
  loading ??= loadCoreFrom(wasmUrl).then(
    (core) => {
      set({ core, error: null });
      return core;
    },
    (e: unknown) => {
      loading = null;
      const error = e instanceof Error ? e : new Error(String(e));
      // said on the console too: a CSP without 'wasm-unsafe-eval' or a missing asset must not pass a check silently
      console.error('the temporal core did not load:', error);
      set({ core: null, error });
      throw error;
    },
  );
  return loading;
}

export function coreState(): CoreState {
  return state;
}

export function subscribeCore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The wasm asset's URL in this build (for a check that it loads under the hub's CSP). */
export const WASM_URL: string = wasmUrl;
