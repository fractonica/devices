// When a time on a page next redraws (src/time/wake.ts), with the real core: a relative time under one Blink is a word
// that waits for the Blink's end (no counter ticking at frame rate), and a wake that fires early by the wall clock is
// armed again for the rest instead of freezing the page.

import { beforeAll, describe, expect, it } from 'vitest';

import { type Core, loadCore } from '@fractonica/time';

import { blinkUsAt, MIN_WAKE_MS, relativeWake, type Timers, wakeAt, withinBlink } from '../src/time/wake.ts';

let core: Core;
beforeAll(async () => {
  core = await loadCore();
});

const T = 1_794_000_000_000_000n; // inside the catalogue

describe('a relative time near its origin', () => {
  it('does not schedule a wake less than about one Blink ahead for an origin 1 ms ago', () => {
    const blink = blinkUsAt(core, T);
    expect(blink).toBeGreaterThan(100_000n);
    const origin = T - 1000n;
    const wake = relativeWake(core, origin, T, 1)!;
    expect(wake - T).toBeGreaterThan(blink - 2000n);
    expect(withinBlink(core, origin, T)).toBe(true);
  });

  it('counts down to a future origin within a Blink by waking at the origin', () => {
    expect(relativeWake(core, T + 5000n, T, 1)).toBe(T + 5000n);
  });

  it('asks the core past the first Blink', () => {
    const origin = T - 10n * blinkUsAt(core, T);
    expect(relativeWake(core, origin, T, 1)).toBe(core.cat.spanNextChangeSince(origin, T, 1));
  });
});

/** Timers run by hand, with a wall clock the test moves. */
function manual() {
  const c = { wall: T, mono: 0, queue: [] as { at: number; fn: () => void; id: number }[], id: 0 };
  const timers: Timers = {
    set: (fn, ms) => {
      const id = ++c.id;
      c.queue.push({ at: c.mono + ms, fn, id });
      return id;
    },
    clear: (h) => {
      c.queue = c.queue.filter((q) => q.id !== h);
    },
  };
  /** Runs the next timer, moving both clocks by its wait (the wall clock by `wallShift` µs more). */
  const step = (wallShift = 0n) => {
    c.queue.sort((a, b) => a.at - b.at);
    const q = c.queue.shift()!;
    c.wall += BigInt(Math.round((q.at - c.mono) * 1000)) + wallShift;
    c.mono = q.at;
    q.fn();
  };
  return { c, timers, step };
}

describe('a wake', () => {
  it('fires once the wall clock reaches it', () => {
    const { c, timers, step } = manual();
    let fired = 0;
    wakeAt(() => c.wall, T + 300_000n, () => fired++, timers);
    step();
    expect(fired).toBe(1);
    expect(c.queue).toHaveLength(0);
  });

  it('is armed again when the wall clock stepped back before it fired', () => {
    const { c, timers, step } = manual();
    let fired = 0;
    wakeAt(() => c.wall, T + 300_000n, () => fired++, timers);
    step(-120_000n); // the wall clock went back 120 ms while waiting
    expect(fired).toBe(0);
    expect(c.queue).toHaveLength(1);
    step();
    expect(fired).toBe(1);
  });

  it('never arms a timer shorter than the backstop, and cancels', () => {
    const { c, timers } = manual();
    let fired = 0;
    const cancel = wakeAt(() => c.wall, T + 1000n, () => fired++, timers);
    expect(c.queue[0]!.at).toBeGreaterThanOrEqual(MIN_WAKE_MS);
    cancel();
    expect(c.queue).toHaveLength(0);
    expect(fired).toBe(0);
  });
});
