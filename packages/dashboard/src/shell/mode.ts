// PURE / EARTH (design README rulings 11 and Hub 10), as the site keeps it: remembered in localStorage under the same
// key (fractonica.mode), PURE by default, `?mode=earth|pure` in the page's query wins (screenshots, links). Pure mode
// shows only Fractonica units; Earth mode adds translations led by ⊕. The mode is also written to
// <html data-mode>, so CSS can follow it, and a change cross-fades the Earth annotations (200 ms, not under reduced
// motion) through the html.mode-fade class, as the site does.

import { useSyncExternalStore } from 'react';

export type Mode = 'pure' | 'earth';
export const MODES: readonly Mode[] = ['pure', 'earth'];
export const MODE_KEY = 'fractonica.mode';
/** The cross-fade of the Earth annotations when the mode changes (the site's FADE.mode). */
export const MODE_FADE_MS = 200;

const isMode = (v: unknown): v is Mode => v === 'pure' || v === 'earth';

function stored(): Mode | null {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return isMode(v) ? v : null;
  } catch {
    return null; // a private window or blocked storage: the default
  }
}

function fromQuery(): Mode | null {
  try {
    const v = new URLSearchParams(location.search).get('mode');
    return isMode(v) ? v : null;
  } catch {
    return null;
  }
}

let mode: Mode = (typeof location !== 'undefined' && fromQuery()) || (typeof localStorage !== 'undefined' && stored()) || 'pure';
const listeners = new Set<() => void>();

function reflect(fade: boolean): void {
  if (typeof document === 'undefined') {
    return;
  }
  const html = document.documentElement;
  html.dataset.mode = mode;
  if (fade && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    html.classList.add('mode-fade');
    setTimeout(() => html.classList.remove('mode-fade'), MODE_FADE_MS + 50);
  }
}
reflect(false);

export function getMode(): Mode {
  return mode;
}

export function setMode(next: Mode): void {
  if (next === mode) {
    return;
  }
  mode = next;
  try {
    localStorage.setItem(MODE_KEY, next);
  } catch {
    // remembering is a convenience
  }
  reflect(true);
  for (const l of listeners) {
    l();
  }
}

export function toggleMode(): void {
  setMode(mode === 'pure' ? 'earth' : 'pure');
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  // another tab changed it
  const onStorage = (e: StorageEvent) => {
    if (e.key === MODE_KEY && isMode(e.newValue)) {
      setMode(e.newValue);
    }
  };
  addEventListener('storage', onStorage);
  return () => {
    listeners.delete(l);
    removeEventListener('storage', onStorage);
  };
}

/** The mode in force, and its setters. Every Earth line on a page renders only when this says 'earth'. */
export function useMode(): { mode: Mode; earth: boolean; setMode: (m: Mode) => void; toggle: () => void } {
  const m = useSyncExternalStore(subscribe, getMode, getMode);
  return { mode: m, earth: m === 'earth', setMode, toggle: toggleMode };
}
