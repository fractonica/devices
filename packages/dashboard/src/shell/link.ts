// Whether the page's live link to the hub is down: `/ws` has not been open for LINK_GRACE_MS (a reconnect that takes
// longer than a blink of the eye). While it is, what the pages show may be behind: the notices say so, presence is
// said as "not sure" rather than the last word, and actions are refused at once rather than sent minutes later.
// Kept outside React so useAct can ask it when an action is pressed.

import { useSyncExternalStore } from 'react';

import type { ConnState } from '../api/ws.ts';

export const LINK_GRACE_MS = 3000;

let downSince: number | null = null;
let wsDown = false;
let restDown = false;
let down = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function set(ws: boolean): void {
  wsDown = ws;
  const next = wsDown || restDown;
  if (next !== down) {
    down = next;
    for (const l of listeners) {
      l();
    }
  }
}

/** Fed with every connection state (runtime.ts). The first connect does not count: nothing was shown yet. */
export function linkStatus(s: Pick<ConnState, 'status'>, now = Date.now()): void {
  if (s.status === 'open' || s.status === 'idle') {
    downSince = null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    set(false);
    return;
  }
  if (downSince === null) {
    downSince = now;
    timer = setTimeout(() => {
      timer = null;
      if (downSince !== null) {
        set(true);
      }
    }, LINK_GRACE_MS);
  }
}

/**
 * The hub did not answer an op in time (hub_status, polled by the shell): down too, whatever `/ws` says (a hub that
 * hangs keeps its socket open until the ping times out).
 */
export function linkRestDown(isDown: boolean): void {
  restDown = isDown;
  set(wsDown);
}

/** Whether the link is down now (for code outside React). */
export function linkDown(): boolean {
  return down;
}

/** Whether the link is down, redrawn when that changes. */
export function useLinkDown(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => down,
    () => false,
  );
}

/**
 * What a device's presence is while the hub does not answer: not known (words.ts "not known", a hollow bead), never the
 * last word the hub said and never "not heard yet", which says the device was never heard.
 */
export const PRESENCE_NOT_KNOWN = 'not_known';

/** A device's presence as the page may say it: not known while the link is down. */
export function usePresence(): (presence: string | null | undefined) => string | null | undefined {
  const d = useLinkDown();
  return (p) => (d ? PRESENCE_NOT_KNOWN : p);
}
