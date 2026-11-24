// The fake haptics of tools/dash-dev.ts --stepper (tools/fake-haptic.ts on the fake stepper board; design haptic-h1
// D12): LicSim and HapticSim on a manual clock against BatteryService's and HapticService's rules (the cell's charge,
// dip and levels; tap trains and their beat, the accent, the budget, the refusals, done and cut, hub silence), then the
// board against an in-process router, as the dashboard reaches it.

import { afterEach, describe, expect, it } from 'vitest';

import { hapticTrainFits } from '@fractonica/protocol';
import { STATUS } from '@fractonica/protocol/gen';

import { compensate, HAPTIC_HUB_SILENT_MS, HapticSim, type HubLink, LIC, LicSim } from '../../../tools/fake-haptic.ts';
import { startFakeStepper } from '../../../tools/fake-stepper.ts';
import { sendCommandTo } from '../src/router/ops.ts';
import { netRig, type NetRig, waitForEvent } from './fake-node.ts';

interface Sent {
  t: number;
  who: string;
  kind: 'state' | 'event';
  name: string;
  value: unknown;
}

/** The capacitor with a solenoid (kick) and a vibration motor (buzz) on it, on one manual clock. */
function board(o: { mv?: number; hub?: () => HubLink | null } = {}) {
  let t = 1000;
  const sent: Sent[] = [];
  const out = (who: string) => ({
    state: (name: string, value: unknown) => sent.push({ t, who, kind: 'state', name, value }),
    event: (name: string, value: unknown) => sent.push({ t, who, kind: 'event', name, value }),
  });
  const cell = new LicSim({ now: () => t, out: out('cap'), ...(o.mv !== undefined ? { mv: o.mv } : {}) });
  const make = (who: string, kind: 'solenoid' | 'erm', rated: number) =>
    new HapticSim({ config: { kind, rated_mv: rated }, now: () => t, out: out(who), supply: cell, draw: (a) => cell.draw(a), ...(o.hub ? { hub: o.hub } : {}) });
  const kick = make('kick', 'solenoid', 4200);
  const buzz = make('buzz', 'erm', 3000);
  cell.reportAll();
  kick.reportAll();
  buzz.reportAll();
  /** Time on, ticking every `step` ms (1 by default: the duty is looked at every millisecond). */
  const run = (ms: number, step = 1, watch?: () => void) => {
    for (const end = t + ms; t < end; ) {
      t = Math.min(end, t + step);
      kick.tick();
      buzz.tick();
      cell.tick();
      watch?.();
    }
  };
  const events = (who: string, name: string) => sent.filter((x) => x.who === who && x.kind === 'event' && x.name === name).map((x) => ({ t: x.t, ...(x.value as Record<string, unknown>) }) as { t: number } & Record<string, unknown>);
  const states = (who: string, name: string) => sent.filter((x) => x.who === who && x.kind === 'state' && x.name === name).map((x) => x.value);
  /** The times the output went on, while running `ms`. */
  const edges = (sim: HapticSim, ms: number) => {
    const ons: number[] = [];
    let was = sim.duty > 0;
    if (was) {
      ons.push(t);
    }
    run(ms, 1, () => {
      const on = sim.duty > 0;
      if (on && !was) {
        ons.push(t);
      }
      was = on;
    });
    return ons;
  };
  return { cell, kick, buzz, run, events, states, edges, now: () => t, set: (v: number) => (t = v) };
}

describe('LicSim (an LIC-H-0825 on a TP4056)', () => {
  it('starts full; a continuous 0.65 A dips the reading by about 0.4 V and drains I x t / 90 F; the charger brings it back', () => {
    const b = board();
    expect(b.cell.mv).toBe(4200);
    expect(b.states('cap', 'level')).toEqual(['ok']);
    expect(b.states('cap', 'charger')).toEqual(['none']);
    for (let i = 0; i < 10; i++) {
      b.cell.draw(0.65 * 100); // 0.65 A for each 100 ms
      b.run(100, 20);
    }
    expect(b.cell.ocv).toBeGreaterThan(4200 - 80);
    expect(b.cell.mv).toBeLessThan(4200 - 300); // the ESR's dip through the EMA
    expect(b.cell.mv).toBeGreaterThan(4200 - 480);
    b.run(5000, 20); // no load: the dip goes, the TP4056 starts again under 4.05 V only
    expect(b.cell.mv).toBeGreaterThan(4100);
  });

  it('drain() takes it to 3.0 V with the charger held off, levels following with their hysteresis', () => {
    const b = board();
    b.cell.drain();
    expect(b.cell.mv).toBe(3000);
    expect(b.cell.level).toBe('ok'); // 3000 is not under low
    b.run(5000, 20);
    expect(b.cell.mv).toBe(3000);
    expect(b.cell.charging).toBe(false);
    b.cell.drain(2790);
    expect(b.cell.level).toBe('critical');
    expect(b.events('cap', 'level_change').at(-1)).toMatchObject({ level: 'critical' });
    b.run(31_000, 20); // the charger: 1 A into 90 F, 11 mV a second
    expect(b.cell.charging).toBe(true);
    b.run(5_000, 20);
    expect(b.cell.level).toBe('low'); // past 2,850 only
    expect(LIC.criticalMv + LIC.hysteresisMv).toBe(2850);
  });
});

describe('HapticSim (fr.haptic 1.1 as HapticService)', () => {
  it('a tap train: taps timed from its start, done when the last one ends', () => {
    const b = board();
    expect(b.kick.command('tap', { period_ms: 100, ms: 20, level: 100, count: 3 })).toBe(STATUS.OK);
    const ons = b.edges(b.kick, 400);
    expect(ons).toEqual([1000, 1100, 1200]);
    expect(b.events('kick', 'done')).toEqual([{ t: 1220, program: 'tap', reason: 'done' }]);
    expect(b.states('kick', 'active')).toEqual([false, true, false]);
  });

  it('a change keeps the beat: the next tap a new period after the last one, or now when that has passed', () => {
    const b = board();
    expect(b.kick.command('tap', { period_ms: 200, ms: 20, count: 0 })).toBe(STATUS.OK);
    b.run(50);
    expect(b.kick.command('tap', { period_ms: 100, ms: 20, count: 0 })).toBe(STATUS.OK); // at 1050
    const ons = b.edges(b.kick, 80); // to 1130
    expect(ons).toEqual([1100]);
    expect(b.kick.command('tap', { period_ms: 300, ms: 20, count: 0 })).toBe(STATUS.OK); // next at 1400
    expect(b.edges(b.kick, 320)).toEqual([1400]); // to 1450
    expect(b.kick.command('tap', { period_ms: 30, ms: 10, count: 0 })).toBe(STATUS.INVALID_ARGS); // 334 x 11 ms: over 30 %
    expect(b.kick.command('tap', { period_ms: 30, ms: 7, count: 0 })).toBe(STATUS.OK); // overdue: now
    expect(b.kick.duty).toBeGreaterThan(0);
    expect(b.edges(b.kick, 40)).toEqual([1450, 1480]);
    expect(b.events('kick', 'done')).toEqual([]);
  });

  it('the accent: the first tap and every Nth after it at accent_level; a change counts on', () => {
    const b = board();
    expect(b.buzz.command('tap', { period_ms: 100, ms: 20, level: 50, count: 0, accent: 4, accent_level: 100 })).toBe(STATUS.OK);
    const duties: number[] = [];
    for (let i = 0; i < 6; i++) {
      duties.push(b.buzz.duty);
      b.run(100);
    }
    const hi = compensate(100, 3000, b.cell.mv);
    const lo = compensate(50, 3000, b.cell.mv);
    expect(duties.map((d) => (Math.abs(d - hi) <= 2 ? 'A' : Math.abs(d - lo) <= 2 ? 'a' : d))).toEqual(['A', 'a', 'a', 'a', 'A', 'a']);
    expect(b.buzz.command('tap', { period_ms: 100, ms: 20, level: 50, count: 0, accent: 3, accent_level: 100 })).toBe(STATUS.OK);
    expect(b.buzz.tapsPlayed).toBe(7);
    expect(Math.abs(b.buzz.duty - hi)).toBeLessThanOrEqual(2); // tap 7 (index 6): 6 % 3 == 0
  });

  it('a solenoid kicks at its level, then holds at min(hold_pct, level)', () => {
    const b = board();
    expect(b.kick.command('pulse', { ms: 200, level: 50 })).toBe(STATUS.OK);
    expect(b.kick.duty).toBe(compensate(50, 4200, 4200));
    b.run(31);
    expect(b.kick.duty).toBe(compensate(40, 4200, b.cell.mv));
    expect(b.kick.command('pulse', { ms: 200, level: 30 })).toBe(STATUS.OK);
    b.run(31);
    expect(b.kick.duty).toBe(compensate(30, 4200, b.cell.mv));
  });

  it('refuses as the firmware does: a tap at or over its period, over max_on, over the budget; a solenoid pattern without breaks', () => {
    const b = board();
    expect(b.kick.command('tap', { period_ms: 100, ms: 100 })).toBe(STATUS.INVALID_ARGS);
    expect(b.kick.command('tap', { period_ms: 100, ms: 0 })).toBe(STATUS.INVALID_ARGS);
    expect(b.kick.command('tap', { period_ms: 19, ms: 5 })).toBe(STATUS.INVALID_ARGS);
    expect(b.kick.command('tap', { period_ms: 5000, ms: 1001 })).toBe(STATUS.INVALID_ARGS);
    expect(hapticTrainFits(50, 14, 30)).toBe(false);
    expect(b.kick.command('tap', { period_ms: 50, ms: 14, count: 0 })).toBe(STATUS.INVALID_ARGS);
    expect(b.kick.command('tap', { period_ms: 50, ms: 13, count: 0 })).toBe(STATUS.OK);
    expect(b.buzz.command('tap', { period_ms: 20, ms: 19, count: 0 })).toBe(STATUS.OK); // an ERM has no budget
    expect(b.kick.command('play', { steps: [40, 0, 40], level: 100, repeat: 1 })).toBe(STATUS.INVALID_ARGS);
    expect(b.kick.command('play', { steps: [40, 60, 40], level: 100, repeat: 2 })).toBe(STATUS.INVALID_ARGS);
    expect(b.kick.command('play', { steps: [40, 60, 40, 60], level: 100, repeat: 2 })).toBe(STATUS.OK);
    expect(b.kick.command('pulse', { ms: 1001 })).toBe(STATUS.INVALID_ARGS);
    expect(b.buzz.command('play', { steps: [] })).toBe(STATUS.INVALID_ARGS);
  });

  it('a train inside the budget runs on; pulses that spend it make the next start BUSY and a running one cut', () => {
    const b = board();
    expect(b.kick.command('tap', { period_ms: 50, ms: 13, count: 0 })).toBe(STATUS.OK);
    b.run(30_000, 2);
    expect(b.kick.active).toBe(true);
    expect(b.events('kick', 'cut')).toEqual([]);
    expect(b.kick.spentMs()).toBeLessThan(3000);
    expect(b.kick.command('stop', {})).toBe(STATUS.OK);
    b.run(10_100, 20);
    for (let i = 0; i < 3; i++) {
      expect(b.kick.command('pulse', { ms: 1000 })).toBe(STATUS.OK);
      b.run(1100, 5);
    }
    expect(b.kick.command('pulse', { ms: 500 })).toBe(STATUS.BUSY);
    expect(b.kick.spentMs()).toBeGreaterThanOrEqual(2990);
  });

  it('cuts continuous on-time at max_on (a zero off-step), then says done {cut}', () => {
    const b = board();
    expect(b.buzz.command('play', { steps: [6000, 0, 6000], level: 100, repeat: 1 })).toBe(STATUS.OK);
    b.run(10_100, 10);
    expect(b.events('buzz', 'cut')).toMatchObject([{ reason: 'max_on' }]);
    expect(b.events('buzz', 'done')).toMatchObject([{ program: 'play', reason: 'cut' }]);
  });

  it('BUSY on a low capacitor for the solenoid (under 3.1 V), not for the motor; cut when it falls to critical', () => {
    const b = board();
    b.cell.drain(3050);
    expect(b.kick.command('tap', { period_ms: 500, ms: 20 })).toBe(STATUS.BUSY);
    expect(b.buzz.command('pulse', { ms: 5000, level: 100 })).toBe(STATUS.OK);
    b.cell.drain(2750);
    b.run(30, 10);
    expect(b.events('buzz', 'cut')).toMatchObject([{ reason: 'low_supply', supply_mv: 2750 }]);
    expect(b.events('buzz', 'done')).toMatchObject([{ program: 'pulse', reason: 'cut' }]);
    expect(b.buzz.command('pulse', { ms: 100 })).toBe(STATUS.BUSY);
  });

  it('a replacement says done {replaced} and active does not drop; stop says stopped; the hub\'s silence hub_lost', () => {
    let link: HubLink | null = { epoch: 7, heardAt: 1000 };
    const b = board({ hub: () => link });
    expect(b.buzz.command('pulse', { ms: 1000 })).toBe(STATUS.OK);
    expect(b.buzz.command('tap', { period_ms: 200, ms: 50, count: 0 })).toBe(STATUS.OK);
    expect(b.buzz.command('stop', {})).toBe(STATUS.OK);
    expect(b.buzz.command('stop', {})).toBe(STATUS.OK);
    expect(b.events('buzz', 'done').map((d) => [d.program, d.reason])).toEqual([
      ['pulse', 'replaced'],
      ['tap', 'stopped'],
    ]);
    expect(b.states('buzz', 'active')).toEqual([false, true, false]);
    expect(b.buzz.command('tap', { period_ms: 200, ms: 50, count: 0 })).toBe(STATUS.OK);
    b.run(HAPTIC_HUB_SILENT_MS + 20, 20);
    expect(b.events('buzz', 'done').at(-1)).toMatchObject({ program: 'tap', reason: 'hub_lost' });
    link = null;
    expect(b.buzz.command('tap', { period_ms: 200, ms: 50, count: 2 })).toBe(STATUS.OK);
    b.run(300, 10);
    expect(b.events('buzz', 'done').at(-1)).toMatchObject({ program: 'tap', reason: 'done' }); // no hub at the start
  });

  it('the solenoid\'s taps dip the capacitor\'s reading and draw it down; the charger starts again under 4.05 V', () => {
    const b = board();
    expect(b.kick.command('tap', { period_ms: 50, ms: 13, count: 0 })).toBe(STATUS.OK);
    let low = 4200;
    b.run(5000, 2, () => (low = Math.min(low, b.cell.mv)));
    expect(low).toBeLessThan(4150); // about 0.17 A on average through 0.6 Ohm
    b.run(25_000, 5);
    expect(b.cell.ocv).toBeLessThan(4200);
    expect(b.cell.charging || b.cell.ocv > LIC.rechargeMv).toBe(true);
  });
});

describe('the fake stepper board\'s haptics', () => {
  let r: NetRig | null = null;
  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const s of stops.splice(0)) {
      await s();
    }
    await r?.close();
    r = null;
  });

  it('answers the generated codecs through the router: a tap train, its done, a refusal over the budget, the capacitor', async () => {
    r = await netRig();
    const mac = '02cafe000004';
    r.registry.add({ device_id: mac, addr: 0x0033, alias: 'stepper-c3', provisioned: true, net: 0 });
    const online = waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === mac);
    const fake = await startFakeStepper({ mac, addr: 0x0033, net: 0, alias: 'stepper-c3', aliasRev: 0, epoch: 1, hub: r.ports });
    stops.push(() => fake.stop());
    await online;
    const dev = r.registry.get(mac)!;
    const send = (inst: string, command: string, args: Record<string, unknown> = {}) => sendCommandTo(r!.hub, dev, inst, command, args, { ack: 'result', timeoutMs: 2000 });

    const done = waitForEvent(r.events, (e) => e.type === 'kick.done', 3000);
    expect(await send('kick', 'tap', { period_ms: 100, ms: 20, level: 70, count: 3 })).toMatchObject({ status: 'ok' });
    expect(fake.kick.active).toBe(true);
    expect((await done).fields).toEqual({ program: 'tap', reason: 'done' });
    expect(await send('kick', 'tap', { period_ms: 50, ms: 14, count: 0 })).toMatchObject({ status: 'invalid_args' });
    const stopped = waitForEvent(r.events, (e) => e.type === 'buzz.done' && (e.fields as { reason?: string }).reason === 'stopped', 2000);
    expect(await send('buzz', 'tap', { period_ms: 500, ms: 120, level: 60, count: 0, accent: 4, accent_level: 100 })).toMatchObject({ status: 'ok' });
    expect(await send('buzz', 'stop')).toMatchObject({ status: 'ok' });
    expect((await stopped).fields).toEqual({ program: 'tap', reason: 'stopped' });
    expect(await send('cap', 'read')).toMatchObject({ status: 'ok' });
    expect(await send('cap', 'load', { on: true })).toMatchObject({ status: 'unsupported' });
    fake.drain();
    expect(fake.cell.mv).toBe(3000);
    expect(await send('kick', 'pulse', { ms: 20 })).toMatchObject({ status: 'busy' });
  });
});
