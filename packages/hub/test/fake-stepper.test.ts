// The fake stepper of tools/dash-dev.ts --stepper (tools/fake-stepper.ts; design stepper-s1 D16): StepperSim on a
// manual clock against D10-D12's rules (states, answers, timing of the trapezoid, done and fault, back-offs, hub
// silence, configure), then the board against an in-process router, as the dashboard reaches it.

import { afterEach, describe, expect, it } from 'vitest';

import { STATUS } from '@fractonica/protocol/gen';

import {
  FAULT_BACKOFF_MS,
  FAULT_LOCKOUT_MS,
  HUB_SILENT_MS,
  type HubLink,
  startFakeStepper,
  StepperSim,
  TICK_MS,
} from '../../../tools/fake-stepper.ts';
import { sendCommandTo } from '../src/router/ops.ts';
import { netRig, type NetRig, waitForEvent } from './fake-node.ts';

interface Sent {
  t: number;
  kind: 'state' | 'event';
  name: string;
  value: unknown;
}

function sim(config: ConstructorParameters<typeof StepperSim>[0]['config'] = {}, hub?: () => HubLink | null) {
  let t = 1000;
  const sent: Sent[] = [];
  const s = new StepperSim({
    config,
    now: () => t,
    ...(hub ? { hub } : {}),
    out: {
      state: (name, value) => sent.push({ t, kind: 'state', name, value }),
      event: (name, value) => sent.push({ t, kind: 'event', name, value }),
    },
  });
  s.reportAll();
  const run = (ms: number) => {
    for (const end = t + ms; t < end; ) {
      t = Math.min(end, t + TICK_MS);
      s.tick();
    }
  };
  const cmd = (name: string, args: Record<string, unknown> = {}) => s.command(name, args);
  const done = () => sent.filter((x) => x.kind === 'event' && x.name === 'done').map((x) => x.value as { reason: string; position: number; target: number });
  const states = (name: string) => sent.filter((x) => x.kind === 'state' && x.name === name);
  /** Runs until a done arrives (or `limitMs`), returning when. */
  const untilDone = (limitMs = 30_000) => {
    const before = done().length;
    const t0 = t;
    while (done().length === before && t - t0 < limitMs) {
      run(TICK_MS);
    }
    return t - t0;
  };
  return { s, sent, run, cmd, done, states, untilDone, now: () => t };
}

describe('StepperSim: motion', () => {
  it('boots released at 0, position unknown, and reports every property', () => {
    const k = sim();
    expect(k.s.motion).toBe('released');
    expect(k.states('position')[0]!.value).toBe(0);
    expect(k.states('position_known')[0]!.value).toBe(false);
    expect(k.states('steps_per_rev')[0]!.value).toBe(20);
    expect(k.states('run_duty_pct')[0]!.value).toBe(20); // 100 mA × 10 Ω / 5,000 mV
    expect(k.states('step_mode')[0]!.value).toBe('micro8');
  });

  it('moves on the trapezoid and lands exactly, then holds and lets go after release_ms', () => {
    const k = sim();
    expect(k.cmd('move_to', { position: 1000 })).toBe(STATUS.OK);
    expect(k.s.motion).toBe('moving');
    expect(k.states('target').at(-1)!.value).toBe(1000);
    const took = k.untilDone();
    // d / vmax + vmax / a = 0.625 + 0.2 s.
    expect(took).toBeGreaterThan(800);
    expect(took).toBeLessThan(860);
    expect(k.done()).toEqual([{ reason: 'reached', position: 1000, target: 1000, slips: 0 }]);
    expect(k.states('position').at(-1)!.value).toBe(1000);
    expect(k.states('speed_hz').at(-1)!.value).toBe(0);
    const speeds = k.states('speed_hz').map((x) => x.value as number);
    expect(Math.max(...speeds)).toBeLessThanOrEqual(1600);
    expect(Math.max(...speeds)).toBeGreaterThan(1500);
    expect(k.s.motion).toBe('holding');
    k.run(980);
    expect(k.s.motion).toBe('holding');
    k.run(40);
    expect(k.s.motion).toBe('released');
  });

  it('lands exactly with no overshoot from rest, for any target, speed and accel', () => {
    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n) + 1;
    for (let i = 0; i < 200; i++) {
      const k = sim();
      const target = (rnd(2) === 1 ? -1 : 1) * rnd(5000);
      k.cmd('move_to', { position: target, speed_hz: 49 + rnd(1551), accel: 9 + rnd(7991) });
      k.untilDone(200_000);
      expect(k.done(), `move ${i}`).toEqual([{ reason: 'reached', position: target, target, slips: 0 }]);
      const positions = k.states('position').map((x) => (x.value as number) * Math.sign(target));
      expect(Math.max(...positions)).toBe(Math.abs(target));
    }
  });

  it('is a triangle when the move is short, and reports at most report_hz while moving', () => {
    const k = sim();
    k.cmd('move_by', { steps: 160 });
    const t0 = k.now();
    const took = k.untilDone();
    expect(took).toBeGreaterThan(270); // 2·√(d/a) = 283 ms, peaking at √(a·d) = 1,131
    expect(took).toBeLessThan(310);
    const moving = k.states('position').filter((x) => x.t > t0 && x.t < t0 + took);
    expect(moving.length).toBeLessThanOrEqual(Math.ceil(took / 100) + 1);
    expect(Math.max(...k.states('speed_hz').map((x) => x.value as number))).toBeLessThan(1200);
  });

  it('retargets without a done for the replaced move; move_by adds to the running target', () => {
    const k = sim();
    k.cmd('move_to', { position: 1000 });
    k.run(200);
    k.cmd('move_to', { position: 2000 });
    k.untilDone();
    expect(k.done()).toEqual([{ reason: 'reached', position: 2000, target: 2000, slips: 0 }]);
    k.cmd('move_by', { steps: 10 });
    k.cmd('move_by', { steps: 10 });
    k.untilDone();
    expect(k.done().at(-1)).toMatchObject({ reason: 'reached', position: 2020 });
  });

  it('passes a target inside the stopping distance and comes back to it', () => {
    const k = sim();
    k.cmd('move_to', { position: 5000 });
    k.run(400); // cruising at 1,600: stopping distance 160
    const at = k.s.position;
    k.cmd('move_to', { position: at + 10 });
    k.untilDone();
    const max = Math.max(...k.states('position').map((x) => x.value as number));
    expect(max).toBeGreaterThan(at + 100);
    expect(k.done()).toEqual([{ reason: 'reached', position: at + 10, target: at + 10, slips: 0 }]);
  });

  it('refuses beyond the limits, above max_speed_hz or accel, and with limits on and the position unknown', () => {
    const k = sim({ limits: true, limit_min: -100, limit_max: 100 });
    expect(k.cmd('move_to', { position: 50 })).toBe(STATUS.BUSY);
    expect(k.cmd('zero', {})).toBe(STATUS.OK);
    expect(k.s.positionKnown).toBe(true);
    expect(k.cmd('move_to', { position: 101 })).toBe(STATUS.INVALID_ARGS);
    expect(k.cmd('move_to', { position: 50, speed_hz: 1601 })).toBe(STATUS.INVALID_ARGS);
    expect(k.cmd('move_to', { position: 50, accel: 8001 })).toBe(STATUS.INVALID_ARGS);
    expect(k.cmd('jog', { speed_hz: -1601, seconds: 0 })).toBe(STATUS.INVALID_ARGS);
    expect(k.cmd('move_to', { position: 0 })).toBe(STATUS.OK); // where it rests: done at once
    expect(k.done()).toEqual([{ reason: 'reached', position: 0, target: 0, slips: 0 }]);
    expect(k.s.motion).toBe('released');
  });

  it('stops at a, halts at once, lets go while moving, and loses the position only above start_hz', () => {
    const k = sim();
    k.cmd('zero', {});
    k.cmd('move_to', { position: 10_000 });
    k.run(400);
    expect(k.cmd('hold')).toBe(STATUS.BUSY); // as the service: hold is for a motor at rest
    expect(k.s.motion).toBe('moving');
    const from = k.s.position;
    expect(k.cmd('stop')).toBe(STATUS.OK);
    expect(k.s.motion).toBe('stopping');
    k.untilDone();
    expect(k.done().at(-1)).toMatchObject({ reason: 'stopped', target: 10_000 });
    expect(Math.abs(k.s.position - from - 160)).toBeLessThanOrEqual(3); // v² / 2a
    expect(k.s.positionKnown).toBe(true);

    k.cmd('move_by', { steps: 10_000 });
    k.run(300);
    expect(k.cmd('halt')).toBe(STATUS.OK);
    expect(k.done().at(-1)).toMatchObject({ reason: 'halted' });
    expect(k.s.motion).toBe('holding');
    expect(k.s.positionKnown).toBe(false);
    const still = k.s.position;
    k.run(200);
    expect(k.s.position).toBe(still);

    k.cmd('zero', {});
    k.cmd('move_by', { steps: 1000, speed_hz: 50 });
    k.run(500);
    k.cmd('release');
    expect(k.done().at(-1)).toMatchObject({ reason: 'released' });
    expect(k.s.motion).toBe('released');
    expect(k.s.positionKnown).toBe(true);
    const n = k.done().length;
    for (const c of ['stop', 'halt', 'release']) {
      expect(k.cmd(c)).toBe(STATUS.OK);
    }
    expect(k.done().length).toBe(n);
  });

  it('jogs, reverses through zero, ends after seconds and rests on a limit', () => {
    const k = sim();
    k.cmd('jog', { speed_hz: 400, seconds: 0 });
    k.run(300);
    expect(k.s.speed).toBe(400);
    k.cmd('jog', { speed_hz: -400, seconds: 1 });
    const signs = new Set<number>();
    const t0 = k.now();
    k.untilDone();
    for (const x of k.states('speed_hz').filter((x) => x.t > t0)) {
      signs.add(Math.sign(x.value as number));
    }
    expect([...signs].sort()).toEqual([-1, 0]);
    expect(k.now() - t0).toBeGreaterThan(1000);
    expect(k.done()).toHaveLength(1);
    expect(k.done()[0]).toMatchObject({ reason: 'elapsed' });

    expect(k.cmd('jog', { speed_hz: 0, seconds: 0 })).toBe(STATUS.OK); // at rest: nothing
    k.cmd('configure', { limits: true, limit_min: -50, limit_max: 300 });
    k.cmd('zero', {});
    k.cmd('jog', { speed_hz: 1600, seconds: 0 });
    k.untilDone();
    expect(k.done().at(-1)).toMatchObject({ reason: 'limit', position: 300 });
  });
});

describe('StepperSim: faults', () => {
  it('cuts a move, backs off 1 s, then 60 s after three in a minute', () => {
    const k = sim();
    k.cmd('zero', {});
    k.cmd('move_to', { position: 5000 });
    k.run(300);
    k.s.fault('driver');
    expect(k.s.motion).toBe('fault');
    expect(k.s.positionKnown).toBe(false);
    const events = k.sent.filter((x) => x.kind === 'event').map((x) => [x.name, x.value]);
    expect(events).toEqual([
      ['fault', { cause: 'driver', position: k.s.position, recent: 1 }],
      ['done', { reason: 'fault', position: k.s.position, target: 5000, slips: 0 }],
    ]);
    expect(k.cmd('hold')).toBe(STATUS.BUSY);
    expect(k.cmd('move_by', { steps: 5 })).toBe(STATUS.BUSY);
    k.run(FAULT_BACKOFF_MS);
    expect(k.cmd('hold')).toBe(STATUS.OK);
    expect(k.s.motion).toBe('holding');

    expect(k.cmd('inject_fault')).toBe(STATUS.OK);
    expect(k.sent.at(-1)!.value).toMatchObject({ cause: 'injected', recent: 2 });
    k.run(FAULT_BACKOFF_MS);
    k.s.fault('driver');
    expect(k.sent.at(-1)!.value).toMatchObject({ recent: 3 });
    k.run(FAULT_BACKOFF_MS);
    expect(k.cmd('hold')).toBe(STATUS.BUSY);
    k.run(FAULT_LOCKOUT_MS - FAULT_BACKOFF_MS);
    expect(k.cmd('move_by', { steps: 5 })).toBe(STATUS.OK);
    expect(k.s.motion).toBe('moving');
    k.untilDone();
    expect(k.cmd('release')).toBe(STATUS.OK);
    expect(k.s.motion).toBe('released');
  });
});

describe('StepperSim: configure', () => {
  it('is BUSY while moving, and for a new step_mode unless released', () => {
    const k = sim();
    k.cmd('move_by', { steps: 1000 });
    expect(k.cmd('configure', { coil_ohm: 20 })).toBe(STATUS.BUSY);
    expect(k.cmd('zero', {})).toBe(STATUS.BUSY);
    k.untilDone();
    expect(k.cmd('configure', { step_mode: 'micro16' })).toBe(STATUS.BUSY);
    expect(k.cmd('configure', { step_mode: 'micro8', coil_ohm: 20, run_ma: 90 })).toBe(STATUS.OK); // the form's own step_mode
    expect(k.states('run_duty_pct').at(-1)!.value).toBe(36);
    expect(k.cmd('reset_settings')).toBe(STATUS.BUSY);
    expect(k.cmd('configure', { limit_min: 10, limit_max: 10 })).toBe(STATUS.INVALID_ARGS);
  });

  it('rescales the position, the limits and the speeds not given; reset_settings brings the build back', () => {
    const k = sim();
    k.cmd('move_to', { position: 101 });
    k.untilDone();
    k.cmd('release');
    k.cmd('configure', { limit_min: -500, limit_max: 700 });
    expect(k.cmd('configure', { step_mode: 'micro16', accel: 9000 })).toBe(STATUS.OK);
    expect(k.s.position).toBe(202);
    expect(k.s.settings).toMatchObject({ step_mode: 'micro16', limit_min: -1000, limit_max: 1400, max_speed_hz: 3200, start_hz: 160, accel: 9000 });
    expect(k.states('max_speed_hz').at(-1)!.value).toBe(3200);
    expect(k.cmd('configure', { step_mode: 'full' })).toBe(STATUS.OK);
    expect(k.s.position).toBe(13); // 202 / 16 = 12.6
    expect(k.s.settings.start_hz).toBe(10);
    expect(k.cmd('reset_settings')).toBe(STATUS.OK);
    expect(k.s.settings).toMatchObject({ step_mode: 'micro8', max_speed_hz: 1600, accel: 8000, limit_min: -1_000_000_000 });
    expect(k.s.position).toBe(104);
  });
});

describe('StepperSim: hub silence (D12)', () => {
  it('stops a motion 10 s after its hub fell silent, or at another hub run; without a session it runs on', () => {
    let link: HubLink | null = { epoch: 7, heardAt: 1000 };
    const k = sim({}, () => link);
    k.cmd('jog', { speed_hz: 1600, seconds: 0 });
    k.run(HUB_SILENT_MS - 100);
    expect(k.s.motion).toBe('moving');
    k.run(120);
    expect(k.s.motion).toBe('stopping');
    k.untilDone();
    expect(k.done()).toEqual([expect.objectContaining({ reason: 'hub_lost' })]);

    link = { epoch: 7, heardAt: k.now() };
    k.cmd('jog', { speed_hz: 200, seconds: 0 });
    k.run(500);
    link = { epoch: 8, heardAt: k.now() };
    k.run(TICK_MS);
    k.untilDone();
    expect(k.done().at(-1)).toMatchObject({ reason: 'hub_lost' });

    link = null;
    k.cmd('jog', { speed_hz: 200, seconds: 0 });
    k.run(HUB_SILENT_MS * 2);
    expect(k.s.motion).toBe('moving');
  });
});

describe('the fake stepper board', () => {
  let r: NetRig | null = null;
  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const s of stops.splice(0)) {
      await s();
    }
    await r?.close();
    r = null;
  });

  it('answers the generated codecs through the router: a move, its reports, done and a fault', async () => {
    r = await netRig();
    const mac = '02cafe000002';
    r.registry.add({ device_id: mac, addr: 0x0031, alias: 'stepper-c3', provisioned: true, net: 0 });
    const online = waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === mac);
    const fake = await startFakeStepper({ mac, addr: 0x0031, net: 0, alias: 'stepper-c3', aliasRev: 0, epoch: 1, hub: r.ports });
    stops.push(() => fake.stop());
    await online;
    const dev = r.registry.get(mac)!;
    expect(r.registry.hellos.at(-1)?.chip).toBe(5); // the ESP32-C3 (the hub's CHIP_IDS), not the FakeNode's C6
    const send = (command: string, args: Record<string, unknown> = {}) => sendCommandTo(r!.hub, dev, 'motor', command, args, { ack: 'result', timeoutMs: 2000 });

    const done = waitForEvent(r.events, (e) => e.type === 'motor.done', 5000);
    expect(await send('move_by', { steps: 160 })).toMatchObject({ status: 'ok' });
    expect((await done).fields).toEqual({ reason: 'reached', position: 160, target: 160, slips: 0 });
    expect(fake.sim.position).toBe(160);
    expect(await send('move_to', { position: 0, speed_hz: 5000 })).toMatchObject({ status: 'invalid_args' });

    const fault = waitForEvent(r.events, (e) => e.type === 'motor.fault', 2000);
    fake.fault();
    expect((await fault).fields).toEqual({ cause: 'driver', position: 160, recent: 1 });
    expect(await send('hold')).toMatchObject({ status: 'busy' });
  });
});
