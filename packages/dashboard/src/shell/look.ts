// The dashboard's look while design proposals are compared (2026-11-14): `now` is the current Astrolabe hub; `a`, `b`
// and `c` are proposals for more pronounced controls and larger text, each one stylesheet in styles/looks/ scoped to
// <html data-look="…">. Remembered in localStorage (fractonica.hub.look) like the mode; `?look=a` in the page's
// query wins (screenshots, links). Once one is chosen it is folded into the base styles and this goes away.

import { useSyncExternalStore } from 'react';

export type Look = 'now' | 'a' | 'b' | 'c';
export const LOOKS: readonly Look[] = ['now', 'a', 'b', 'c'];
export const LOOK_KEY = 'fractonica.hub.look';

const isLook = (v: unknown): v is Look => typeof v === 'string' && (LOOKS as readonly string[]).includes(v);

function stored(): Look | null {
  try {
    const v = localStorage.getItem(LOOK_KEY);
    return isLook(v) ? v : null;
  } catch {
    return null;
  }
}

function fromQuery(): Look | null {
  try {
    const v = new URLSearchParams(location.search).get('look');
    return isLook(v) ? v : null;
  } catch {
    return null;
  }
}

let look: Look = (typeof location !== 'undefined' && fromQuery()) || (typeof localStorage !== 'undefined' && stored()) || 'now';
const listeners = new Set<() => void>();

function reflect(): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.look = look;
  }
}
reflect();

export function getLook(): Look {
  return look;
}

export function setLook(next: Look): void {
  if (next === look) {
    return;
  }
  look = next;
  try {
    localStorage.setItem(LOOK_KEY, next);
  } catch {
    // remembering is a convenience
  }
  reflect();
  for (const l of listeners) {
    l();
  }
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key === LOOK_KEY && isLook(e.newValue)) {
      setLook(e.newValue);
    }
  };
  addEventListener('storage', onStorage);
  return () => {
    listeners.delete(l);
    removeEventListener('storage', onStorage);
  };
}

export function useLook(): { look: Look; setLook: (l: Look) => void } {
  return { look: useSyncExternalStore(subscribe, getLook, getLook), setLook };
}
