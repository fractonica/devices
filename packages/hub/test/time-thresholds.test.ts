// time.threshold events (src/time/thresholds.ts) on a fake clock: when they fire, which are stored and which live
// only, what a sleep or a clock jump skips, the config, and `fr wait event time.threshold` (wait_for_event) receiving
// one.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type Core, loadCore } from '@fractonica/time';

import type { HubContext, HubEvent } from '../src/context.ts';
import { openDb } from '../src/db.ts';
import { createEvents } from '../src/events/index.ts';
import { LogStore } from '../src/logstore.ts';
import { HANDLERS } from '../src/ops.ts';
import { nowUs } from '../src/ring.ts';
import { CursorSeq } from '../src/seq.ts';
import { type ThresholdConfig, THRESHOLD_GRACE_US, THRESHOLD_MAX_WAIT_MS, TimeThresholds } from '../src/time/thresholds.ts';

/** SPEC vector A, 2026-10-08T12:00:00Z, in Unix µs. */
const A = 1_791_460_800_000_000n;
const DEFAULT: ThresholdConfig = { thresholds: true, durable_to: 'η', live_to: 'ι' };

let core: Core;
let dir: string;
const cleanups: (() => void)[] = [];
beforeAll(async () => {
  core = await loadCore();
  dir = mkdtempSync(join(tmpdir(), 'fr-time-hub-'));
});
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) {
    c();
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A fake clock and timer: `advance` moves the clock and fires the timer when its time has come. */
function rig(config: () => ThresholdConfig = () => DEFAULT, start = A) {
  let now = start;
  let timer: { fn: () => void; at: bigint } | null = null;
  const published: { e: Omit<HubEvent, 'cursor' | 'seq'>; durable: boolean }[] = [];
  const delays: number[] = [];
  const logs: Record<string, unknown>[] = [];
  const t = new TimeThresholds({
    events: {
      publish: (e, opts) => {
        published.push({ e, durable: opts?.durable !== false });
        return { ...e, cursor: 'c:1.1', seq: 1 } as HubEvent;
      },
    },
    config,
    now: () => now,
    hubNowUs: () => 1,
    timers: {
      set: (fn, ms) => {
        delays.push(ms);
        timer = { fn, at: now + BigInt(ms) * 1000n };
        return timer;
      },
      clear: (h) => {
        if (timer === h) {
          timer = null;
        }
      },
    },
    log: (line) => logs.push(line),
  });
  cleanups.push(() => t.stop());
  return {
    t,
    published,
    delays,
    logs,
    /** Moves the clock to `to`, firing the timer each time it is due on the way. */
    advanceTo(to: bigint) {
      while (timer && timer.at <= to) {
        now = timer.at;
        const fire = timer.fn;
        timer = null;
        fire();
      }
      now = to;
    },
    /** Jumps the clock without firing (the Mac slept), then fires once. */
    jumpTo(to: bigint) {
      now = to;
      const fire = timer?.fn;
      timer = null;
      fire?.();
    },
  };
}

const fields = (p: { e: Omit<HubEvent, 'cursor' | 'seq'> }) => p.e.fields as Record<string, unknown>;

describe('time.threshold', () => {
  it('fires at the Helion end of vector A: η stored, θ and ι live only, coarse first', async () => {
    const r = rig();
    await r.t.start();
    expect(r.published).toEqual([]);
    const end = core.cat.nextThreshold(A, 6).time!;
    // one timer for the earliest pending threshold (θ's node, 5 min ahead), never a fixed poll
    expect(r.t.nextAt()).toBe(core.cat.nextThreshold(A, 8).time);
    // the timer is armed in whole milliseconds, rounded up: it fires within one after the instant, never before
    r.advanceTo(end + 1000n);
    const atEnd = r.published.filter((p) => fields(p).at === String(end));
    expect(atEnd.map((p) => [fields(p).symbol, fields(p).quarter, p.durable])).toEqual([
      ['η', 'end', true],
      ['θ', 'end', false],
      ['ι', 'end', false],
    ]);
    expect(fields(atEnd[0])).toMatchObject({ level: 6, depth: 7, unit: 'Helion', cycle: '717211', stamp: 'α#6 β#4 γ#9 δ#3 ε#5 35η 0ι 0λ 0ν' });
    expect(atEnd[0].e.type).toBe('time.threshold');
    expect(fields(atEnd[1]).unit).toBeNull();
    // everything before the end was announced too, in time order, and nothing deeper than ι
    expect(r.published.every((p) => (fields(p).level as number) <= 8)).toBe(true);
    const ats = r.published.map((p) => BigInt(fields(p).at as string));
    expect([...ats].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(ats);
    // the next θ and ι thresholds after the end are pending, not announced
    expect(r.published.some((p) => BigInt(fields(p).at as string) > end)).toBe(false);
  });

  it('arms its timer for the instant itself, at most a minute ahead', async () => {
    const r = rig(() => ({ thresholds: true, durable_to: 'α', live_to: 'α' }));
    await r.t.start();
    // α's next threshold is more than a year away: the timer is re-armed every minute
    expect(r.delays.at(-1)).toBe(THRESHOLD_MAX_WAIT_MS);
    const r2 = rig(() => ({ thresholds: true, durable_to: 'η', live_to: 'η' }), core.cat.nextThreshold(A, 6).time! - 1500n);
    await r2.t.start();
    expect(r2.delays.at(-1)).toBe(2); // 1.5 ms, rounded up
  });

  it('skips what passed more than a minute ago (asleep), and announces what passed within it', async () => {
    const r = rig();
    await r.t.start();
    const end = core.cat.nextThreshold(A, 6).time!;
    r.jumpTo(end + 3n * 3_600_000_000n); // three hours later
    expect(r.published).toEqual([]);
    const r2 = rig();
    await r2.t.start();
    r2.jumpTo(end + THRESHOLD_GRACE_US / 2n);
    // within the minute: the Helion end (and θ, ι) are announced late, once
    expect(r2.published.filter((p) => fields(p).at === String(end)).map((p) => fields(p).symbol)).toEqual(['η', 'θ', 'ι']);
  });

  it('follows the config: no events when off, levels by name or depth, a bad name falls back', async () => {
    let cfg: ThresholdConfig = { thresholds: false, durable_to: 'η', live_to: 'ι' };
    const r = rig(() => cfg);
    await r.t.start();
    r.advanceTo(A + 3_600_000_000n);
    expect(r.published).toEqual([]);
    cfg = { thresholds: true, durable_to: '5', live_to: 'theta' };
    expect(r.t.levels()).toEqual({ durable: 4, live: 7 });
    cfg = { thresholds: true, durable_to: 'nope', live_to: 'χ' };
    // a bad name: its default; live_to stops at ν
    expect(r.t.levels()).toEqual({ durable: 6, live: 12 });
  });

  it('stores θ at the deepest: a deeper durable_to is a config_problem, and θ is used', async () => {
    let cfg: ThresholdConfig = { thresholds: true, durable_to: 'θ', live_to: 'ι' };
    const r = rig(() => cfg);
    await r.t.start();
    expect(r.t.levels()).toEqual({ durable: 7, live: 8 });
    expect(r.logs).toEqual([]);
    for (const deep of ['ι', 'ν', 'Blink', '13']) {
      cfg = { thresholds: true, durable_to: deep, live_to: 'ι' };
      r.logs.length = 0;
      expect(r.t.levels(), deep).toEqual({ durable: 7, live: 8 });
      expect(r.logs, deep).toEqual([expect.objectContaining({ event: 'config_problem', message: expect.stringContaining('using θ') })]);
    }
    // live only below it still goes deeper
    cfg = { thresholds: true, durable_to: 'ν', live_to: 'λ' };
    expect(r.t.levels()).toEqual({ durable: 7, live: 10 });
    // past θ's next threshold: θ is stored, κ and λ are live only
    r.advanceTo(core.cat.nextThreshold(A, 7).time! + 2_000_000n);
    expect(r.published.some((p) => fields(p).symbol === 'θ' && p.durable)).toBe(true);
    expect(r.published.some((p) => fields(p).symbol === 'λ' && !p.durable)).toBe(true);
    expect(r.published.every((p) => p.durable === (fields(p).level as number) <= 7)).toBe(true);
  });

  it('announces a catch-up of several levels in time order, never going back', async () => {
    const r = rig(() => ({ thresholds: true, durable_to: 'η', live_to: 'λ' }));
    await r.t.start();
    // 50 s pass in one tick (within the minute's grace): κ and λ thresholds interleave
    r.jumpTo(A + 50_000_000n);
    const order = r.published.map((p) => [BigInt(fields(p).at as string), fields(p).level as number] as const);
    expect(new Set(order.map(([, level]) => level)).size).toBeGreaterThan(1);
    for (let i = 1; i < order.length; i++) {
      const [at, level] = order[i];
      const [atBefore, levelBefore] = order[i - 1];
      expect(at > atBefore || (at === atBefore && level > levelBefore), `event ${i}`).toBe(true);
    }
    // the same thresholds as one tick per instant would give
    const r2 = rig(() => ({ thresholds: true, durable_to: 'η', live_to: 'λ' }));
    await r2.t.start();
    r2.advanceTo(A + 50_000_000n);
    expect(r2.published.map((p) => [fields(p).at, fields(p).level])).toEqual(order.map(([at, level]) => [String(at), level]));
  });

  it('reaches a waiting `fr wait event time.threshold`, durable or live only', async () => {
    const db = openDb(join(dir, 'hub.db'));
    const seq = new CursorSeq(db);
    const logs = new LogStore(db, 1, { retention: false, seq });
    const events = createEvents(db, seq, 1);
    cleanups.push(() => {
      events.stop();
      logs.close();
      db.close();
    });
    const hub = { db, logs, events, seq, registry: { all: () => [], get: () => undefined }, router: { presence: () => 'unknown', online: () => [] } } as unknown as HubContext;
    let now = core.cat.nextThreshold(A, 7).time! - 1000n; // just before θ's node: live only by default
    let fire: (() => void) | null = null;
    const t = new TimeThresholds({
      events,
      config: () => DEFAULT,
      now: () => now,
      hubNowUs: () => nowUs(),
      timers: { set: (fn) => (fire = fn), clear: () => (fire = null) },
      log: () => undefined,
    });
    cleanups.push(() => t.stop());
    await t.start();
    const since = logs.head();
    const wait = HANDLERS.wait_for_event({ types: 'time.threshold', since, count: 1, per_device: false, timeout_s: 5, include_replayed: false, where: { symbol: 'θ' } }, hub) as Promise<{
      events: HubEvent[];
    }>;
    await new Promise((res) => setTimeout(res, 20));
    now += 1000n;
    (fire as unknown as () => void)();
    const got = await wait;
    expect(got.events[0]).toMatchObject({ type: 'time.threshold', fields: { symbol: 'θ', quarter: 'node' } });
    // live only: not in the store
    events.flush();
    expect(events.query({ types: ['time.threshold'], limit: 10 })).toEqual([]);
  });
});
