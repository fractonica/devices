// React's view of the temporal core. Nothing here polls: a component redraws at the instant the core says its text
// next changes (a reading's next_change_us, a span's spanNextChange), as the site does (DESIGN.md §10).

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { type Core, nextCivilSecond, type NowReading, readNow, Unit } from '@fractonica/time/browser';

import type { Mode } from '../shell/mode.ts';
import { coreState, loadCore, subscribeCore } from './core.ts';

/** The loaded core, or null while it loads (or when it failed: useCoreError says why). Starts the load. */
export function useFractonica(): Core | null {
  const s = useSyncExternalStore(subscribeCore, coreState, coreState);
  useEffect(() => {
    if (!s.core && !s.error) {
      void loadCore().catch(() => {});
    }
  }, [s.core, s.error]);
  return s.core;
}

/** Why the core did not load (a CSP or a missing asset), or null. */
export function useCoreError(): Error | null {
  return useSyncExternalStore(subscribeCore, coreState, coreState).error;
}

/** Calls `fire` at the Unix µs `at` (a setTimeout to that instant on the core's clock); again whenever `at` changes. */
function useWakeAt(core: Core | null, at: bigint | null, fire: () => void): void {
  const ref = useRef(fire);
  ref.current = fire;
  useEffect(() => {
    if (!core || at === null) {
      return;
    }
    const ms = Number(at - core.frc.now()) / 1000;
    // a timer fires a little early on some engines: one more ms so the core's text has changed when it does
    const t = setTimeout(() => ref.current(), Math.max(0, Math.min(ms + 1, 2 ** 31 - 1)));
    return () => clearTimeout(t);
  }, [core, at]);
}

export interface ReadingOptions {
  /**
   * The finest unit the caller shows (default the Blink): it redraws when that unit's cycle ends rather than at
   * every Blink. In Earth mode it also redraws at each civil second.
   */
  grain?: number;
}

/**
 * The core's NOW reading (the stamp, its terms, the date words, the Pentad, the majors, the countdowns, the Sun),
 * as `fr time now` and the time_now op give it; with `earth` blocks only in Earth mode. It is recomputed at the
 * instant it next changes, never on a fixed poll. Null while the core loads.
 */
export function useReading(mode: Mode, opts: ReadingOptions = {}): NowReading | null {
  const core = useFractonica();
  const grain = opts.grain ?? Unit.BLINK;
  const [tick, setTick] = useState(0);
  const [reading, setReading] = useState<{ r: NowReading; wake: bigint | null } | null>(null);
  useEffect(() => {
    if (!core) {
      return;
    }
    const earth = mode === 'earth';
    const r = readNow(core, { earth });
    const t = BigInt(r.unix_us);
    const level = core.frc.unitLevel(grain);
    let wake: bigint | null = grain === Unit.BLINK ? (r.next_change_us === null ? null : BigInt(r.next_change_us)) : level === null ? null : core.cat.cycleAt(t, level).end;
    if (earth && grain !== Unit.BLINK) {
      const civil = nextCivilSecond(core, t);
      wake = wake === null || civil < wake ? civil : wake;
    }
    setReading({ r, wake });
  }, [core, mode, grain, tick]);
  useWakeAt(core, reading?.wake ?? null, () => setTick((n) => n + 1));
  return reading?.r ?? null;
}

/**
 * The present on the core's clock, redrawn when the span of `maxParts` parts between `origin` and now next changes
 * (the core's spanNextChangeSince / spanNextChange): what a relative time ("3λ 2ν ago", "in 6ι 43λ") needs, and
 * nothing more often.
 */
export function useNowFor(core: Core | null, origin: bigint | null, maxParts = 2): bigint | null {
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState<{ t: bigint; wake: bigint | null } | null>(null);
  useEffect(() => {
    if (!core || origin === null) {
      return;
    }
    const t = core.frc.now();
    let wake: bigint | null = null;
    try {
      // a past origin counts up from it; a future one counts down to it
      wake = origin > t ? core.cat.spanNextChange(t, origin, maxParts) : core.cat.spanNextChangeSince(origin, t, maxParts);
    } catch {
      wake = null; // outside the catalogue: a fixed text
    }
    setNow({ t, wake });
  }, [core, origin, maxParts, tick]);
  useWakeAt(core, now?.wake ?? null, () => setTick((n) => n + 1));
  return now?.t ?? null;
}
