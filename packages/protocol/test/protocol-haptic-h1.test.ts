// HAPTIC-1 (design haptic-h1 D2, D10): fr.haptic 1.1 in the catalog (the tap command, the done event), the haptic_tap op
// on `fr haptic tap <device>`, its inputs (a period or a rate, the count, the accent), the cooldown-budget rule the
// node, the hub and the dashboard share, and the REGISTRY_HASH it moves.
import { describe, expect, it } from 'vitest';

import { findOp, HAPTIC_KIND_DEFAULTS, hapticLongestTap, hapticTrainFits, OPS, REGISTRY_HASH, REGISTRY_INPUTS_HASH } from '../src/index.ts';
import { CATALOG } from '../src/gen/catalog.ts';

describe('HAPTIC-1 ops and fr.haptic 1.1', () => {
  it('adds haptic_tap after haptic_stop, on `fr haptic tap <device>`, and moves REGISTRY_HASH', () => {
    const names = OPS.map((o) => o.name);
    expect(names.indexOf('haptic_tap')).toBe(names.indexOf('haptic_stop') + 1);
    expect(findOp('haptic_tap')).toMatchObject({ target: 'device', kind: 'command', tier: 'mutate', cli: { path: ['haptic', 'tap'], positional: ['device'] } });
    expect(findOp('haptic_tap')!.summary.length).toBeLessThan(1000);
    expect(OPS).toHaveLength(132);
    expect(REGISTRY_INPUTS_HASH).toBe('0ade067d465c');
    expect(REGISTRY_HASH).toBe('3697879f7c01');
  });

  it('checks the inputs: a period or a rate, the tap, the count, the accent', () => {
    const tap = findOp('haptic_tap')!.input;
    expect(tap.parse({ device: 'stepper-c3' })).toEqual({ device: 'stepper-c3', ms: 20, level: 100, count: 1, accent: 0, accent_level: 100 });
    expect(tap.parse({ device: 'stepper-c3', instance: 'kick', hz: 8, ms: 15, level: 70, count: 0 })).toMatchObject({ hz: 8, ms: 15, level: 70, count: 0 });
    expect(tap.parse({ device: 'stepper-c3', period_ms: 500, accent: 4, accent_level: 100 })).toMatchObject({ period_ms: 500, accent: 4 });
    for (const bad of [{ period_ms: 19 }, { period_ms: 60_001 }, { hz: 0 }, { hz: 51 }, { ms: 0 }, { level: 0 }, { level: 101 }, { count: -1 }, { count: 10_001 }, { accent: 33 }, { accent_level: 0 }]) {
      expect(tap.safeParse({ device: 'stepper-c3', ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('the cooldown-budget rule: the worst 10 s, each tap counted a millisecond longer, strictly under the budget', () => {
    // A solenoid's 30 %: at 20 taps a second (200 in 10 s) 13 ms fits (2,800 ms), 14 does not (3,000).
    expect(hapticTrainFits(50, 13, 30)).toBe(true);
    expect(hapticTrainFits(50, 14, 30)).toBe(false);
    // One every 5 s: two taps in any 10 s, so a solenoid's longest (max_on 1,000) fits.
    expect(hapticTrainFits(5000, 1000, 30)).toBe(true);
    // ceil(10,000 / 3,400) = 3 taps of 1,000 ms: the budget exactly, refused.
    expect(hapticTrainFits(3400, 999, 30)).toBe(false);
    // An ERM's 100 % is no budget.
    expect(hapticTrainFits(20, 19, 100)).toBe(true);
    expect(HAPTIC_KIND_DEFAULTS).toEqual({ erm: { max_on_ms: 10_000, cooldown_pct: 100 }, solenoid: { max_on_ms: 1_000, cooldown_pct: 30 } });
    // The longest tap agrees with the rule at every period.
    for (const period of [20, 33, 40, 50, 80, 100, 125, 250, 333, 500, 1000, 3000, 3400, 5000, 60_000]) {
      for (const [maxOn, pct] of [[1000, 30], [10_000, 100], [500, 50]] as const) {
        const ms = hapticLongestTap(period, maxOn, pct);
        expect(ms, `${period} ${pct}`).toBeLessThan(period);
        expect(ms, `${period} ${pct}`).toBeLessThanOrEqual(maxOn);
        if (ms > 0) {
          expect(hapticTrainFits(period, ms, pct), `${period} ${ms} ${pct}`).toBe(true);
        }
        if (ms + 1 < period && ms + 1 <= maxOn) {
          expect(hapticTrainFits(period, ms + 1, pct), `${period} ${ms + 1} ${pct}`).toBe(false);
        }
      }
    }
  });

  it('fr.haptic 1.1 in the catalog: tap (command 4) and done (event 2)', () => {
    const haptic = CATALOG.capabilities.find((c) => c.name === 'fr.haptic')!;
    expect(haptic.version).toBe('1.1');
    const tap = haptic.commands.find((c) => c.name === 'tap')!;
    expect(tap.id).toBe(4);
    expect(tap.fields.map((f) => f.name)).toEqual(['period_ms', 'ms', 'level', 'count', 'accent', 'accent_level']);
    const done = haptic.events.find((e) => e.name === 'done')!;
    expect(done.id).toBe(2);
    expect(done.fields.map((f) => f.name)).toEqual(['program', 'reason']);
  });
});
