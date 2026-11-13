// When a time on a page next needs redrawing, and a timer that keeps that promise (DOM-free, tested in node with the
// real core). Two rules the hooks in time/hooks.ts follow:
//
// - A relative time under one Blink is not counted ("just now", "now"): the core would write it with decimals of the
//   Blink ("0.25ν ago", "0.38ν ago" …) that change every few ms, a counter ticking at frame rate on a page where
//   nothing should move. Its next change is the end of that first Blink.
// - A wake is checked when it fires: the timer runs on the monotonic clock, the core reads the wall clock, so a timer
//   that fires before the core's `at` (the wall clock stepped back, or slews under NTP) is armed again for the rest
//   rather than recomputing the same instant and never waking again.

import { type Core, Unit } from '@fractonica/time/browser';

/** The length of the Blink that holds `t`, in µs (it follows the Saros interval): from the core's own cycle. */
export function blinkUsAt(core: Core, t: bigint): bigint {
  const c = core.cat.cycleAt(t, core.frc.unitLevel(Unit.BLINK)!);
  // a partial Blink at the catalogue's edge has no start or end: its nominal length, from the core's period
  if (c.start === null || c.end === null) {
    return BigInt(Math.round(core.frc.periodSeconds(core.frc.unitLevel(Unit.BLINK)!, core.cat.intervalAt(t)) * 1e6));
  }
  return c.end - c.start;
}

/** Whether `t` is within one Blink of `now` (either side). */
export function withinBlink(core: Core, t: bigint, now: bigint): boolean {
  const d = t > now ? t - now : now - t;
  return d < blinkUsAt(core, now);
}

/**
 * When the relative text of `origin` seen at `t` next changes, with `maxParts` parts: the core's spanNextChange (a
 * countdown) or spanNextChangeSince (an age), except within a Blink of the origin, where the text is a word and the
 * next change is the Blink's end (an age) or the origin itself (a countdown). Null when it never changes (outside the
 * catalogue).
 */
export function relativeWake(core: Core, origin: bigint, t: bigint, maxParts: number): bigint | null {
  try {
    if (withinBlink(core, origin, t)) {
      return origin > t ? origin : origin + blinkUsAt(core, origin);
    }
    return origin > t ? core.cat.spanNextChange(t, origin, maxParts) : core.cat.spanNextChangeSince(origin, t, maxParts);
  } catch {
    return null;
  }
}

/** The shortest wait a wake is armed for: a backstop against a run of timers, never the thing that paces a page. */
export const MIN_WAKE_MS = 16;
/** The longest single setTimeout (its delay is a signed 32-bit ms count). */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/**
 * Calls `fire` once the core's clock (`now`, Unix µs) has reached `at`. The timer is armed for the time left (one
 * more ms, as a timer fires a little early on some engines); when it fires before `at` by `now`, it is armed again for
 * the rest. Returns the cancel.
 */
export function wakeAt(now: () => bigint, at: bigint, fire: () => void, timers: Timers): () => void {
  let handle: unknown = null;
  let done = false;
  const arm = () => {
    const left = Number(at - now()) / 1000;
    if (left <= 0) {
      done = true;
      fire();
      return;
    }
    handle = timers.set(
      () => {
        handle = null;
        if (!done) {
          arm();
        }
      },
      Math.max(MIN_WAKE_MS, Math.min(left + 1, MAX_TIMEOUT_MS)),
    );
  };
  arm();
  return () => {
    done = true;
    if (handle !== null) {
      timers.clear(handle);
    }
  };
}

export const browserTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
