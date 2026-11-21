// The fake buzzer of tools/dash-dev.ts --stepper (tools/fake-buzzer.ts on the fake stepper board; design buzzer-b1
// D10): BuzzerSim on a manual clock against BuzzerService's rules (answers, timing, replacement, stop, volume, hub
// silence), then the board against an in-process router, as the dashboard reaches it.

import { afterEach, describe, expect, it } from 'vitest';

import { STATUS } from '@fractonica/protocol/gen';

import { BUZZER_HUB_SILENT_MS, type BuzzerHubLink, BuzzerSim, dutyForVolume } from '../../../tools/fake-buzzer.ts';
import { startFakeStepper, TICK_MS } from '../../../tools/fake-stepper.ts';
import { sendCommandTo } from '../src/router/ops.ts';
import { netRig, type NetRig, waitForEvent } from './fake-node.ts';

interface Sent {
  t: number;
  kind: 'state' | 'event';
  name: string;
  value: unknown;
}

function sim(config: { volume?: number; beep_hz?: number } = {}, hub?: () => BuzzerHubLink | null) {
  let t = 1000;
  const sent: Sent[] = [];
  const s = new BuzzerSim({
    config,
    now: () => t,
    ...(hub ? { hub } : {}),
    out: {
      state: (name, value) => sent.push({ t, kind: 'state', name, value }),
      event: (name, value) => sent.push({ t, kind: 'event', name, value }),
    },
  });
  s.reportAll();
  const run = (ms: number, step = 1) => {
    for (const end = t + ms; t < end; ) {
      t = Math.min(end, t + step);
      s.tick();
    }
  };
  const cmd = (name: string, args: Record<string, unknown> = {}) => s.command(name, args);
  const dones = () => sent.filter((x) => x.kind === 'event').map((x) => ({ t: x.t, ...(x.value as { sound: string; reason: string }) }));
  const states = (name: string) => sent.filter((x) => x.kind === 'state' && x.name === name).map((x) => x.value);
  return { s, run, cmd, dones, states, now: () => t };
}

describe('BuzzerSim', () => {
  it('boots quiet at the config volume and reports both properties', () => {
    const k = sim();
    expect(k.s.playing).toBe(false);
    expect(k.states('playing')).toEqual([false]);
    expect(k.states('volume')).toEqual([50]);
    expect(k.s.sounding).toEqual({ hz: 0, duty: 0 });
  });

  it('the volume curve is BuzzerService\'s', () => {
    expect([0, 1, 10, 50, 100].map(dutyForVolume)).toEqual([0, 3, 32, 167, 500]);
  });

  it('plays a tone for its length and ends with done', () => {
    const k = sim();
    expect(k.cmd('tone', { freq_hz: 2000, ms: 250 })).toBe(STATUS.OK);
    expect(k.s.sounding).toEqual({ hz: 2000, duty: 167 });
    expect(k.states('playing')).toEqual([false, true]);
    k.run(249);
    expect(k.s.playing).toBe(true);
    k.run(1);
    expect(k.dones()).toEqual([{ t: 1250, sound: 'tone', reason: 'done' }]);
    expect(k.states('playing')).toEqual([false, true, false]);
  });

  it('beeps count times with the last pause trimmed, at beep_hz unless told', () => {
    const k = sim({ beep_hz: 2700 });
    expect(k.cmd('beep', { count: 3, on_ms: 80, off_ms: 40 })).toBe(STATUS.OK);
    const pitches: number[] = [];
    for (let i = 0; i < 400; i++) {
      pitches.push(k.s.sounding.hz);
      k.run(1);
    }
    expect(k.dones()).toEqual([{ t: 1320, sound: 'beep', reason: 'done' }]);
    expect(pitches.slice(0, 80).every((h) => h === 2700)).toBe(true);
    expect(pitches.slice(80, 120).every((h) => h === 0)).toBe(true);
    expect(pitches.slice(120, 200).every((h) => h === 2700)).toBe(true);
  });

  it('plays a melody with gaps inside its notes and repeats; 0 runs until stop', () => {
    const k = sim();
    expect(k.cmd('melody', { freq_hz: [523, 0, 784], ms: [100, 50, 200], gap_ms: 20, repeat: 2 })).toBe(STATUS.OK);
    k.run(79);
    expect(k.s.sounding.hz).toBe(523);
    k.run(1);
    expect(k.s.sounding.hz).toBe(0); // the gap
    k.run(70);
    expect(k.s.sounding.hz).toBe(784);
    k.run(1000);
    expect(k.dones()).toEqual([{ t: 1700, sound: 'melody', reason: 'done' }]);

    expect(k.cmd('melody', { freq_hz: [1000], ms: [50], repeat: 0 })).toBe(STATUS.OK);
    k.run(60_000, 10);
    expect(k.s.playing).toBe(true);
    expect(k.cmd('stop')).toBe(STATUS.OK);
    expect(k.dones().at(-1)).toMatchObject({ sound: 'melody', reason: 'stopped' });
  });

  it('a new sound replaces the playing one; playing stays true', () => {
    const k = sim();
    k.cmd('melody', { freq_hz: [523, 659], ms: [500, 500] });
    k.run(100);
    expect(k.cmd('tone', { freq_hz: 3000, ms: 50 })).toBe(STATUS.OK);
    expect(k.dones()).toEqual([{ t: 1100, sound: 'melody', reason: 'replaced' }]);
    k.run(50);
    expect(k.dones().at(-1)).toEqual({ t: 1150, sound: 'tone', reason: 'done' });
    expect(k.states('playing')).toEqual([false, true, false]);
  });

  it('set_volume changes what plays and what follows; a command\'s volume is its own', () => {
    const k = sim();
    k.cmd('tone', { freq_hz: 1500, ms: 1000, volume: 10 });
    expect(k.s.sounding.duty).toBe(32);
    expect(k.s.volume).toBe(50);
    expect(k.cmd('set_volume', { volume: 100 })).toBe(STATUS.OK);
    expect(k.s.sounding.duty).toBe(500);
    expect(k.states('volume')).toEqual([50, 100]);
    expect(k.cmd('set_volume', { volume: 101 })).toBe(STATUS.INVALID_ARGS);
  });

  it('refuses what the service refuses and leaves the playing sound alone', () => {
    const k = sim();
    expect(k.cmd('tone', { freq_hz: 99, ms: 100 })).toBe(STATUS.INVALID_ARGS);
    expect(k.cmd('tone', { freq_hz: 20001, ms: 100 })).toBe(STATUS.INVALID_ARGS);
    expect(k.cmd('beep', { freq_hz: 50 })).toBe(STATUS.INVALID_ARGS);
    expect(k.cmd('melody', { freq_hz: [], ms: [] })).toBe(STATUS.INVALID_ARGS);
    expect(k.cmd('melody', { freq_hz: [1000, 2000], ms: [100] })).toBe(STATUS.INVALID_ARGS);
    expect(k.cmd('melody', { freq_hz: [1000], ms: [0] })).toBe(STATUS.INVALID_ARGS);
    expect(k.cmd('tone', { freq_hz: 1000, ms: 500 })).toBe(STATUS.OK);
    expect(k.cmd('tone', { freq_hz: 30000, ms: 10 })).toBe(STATUS.INVALID_ARGS);
    expect(k.s.playing).toBe(true);
    expect(k.dones()).toEqual([]);
    expect(k.cmd('stop')).toBe(STATUS.OK);
    expect(k.cmd('stop')).toBe(STATUS.OK);
    expect(k.dones()).toHaveLength(1);
  });

  it('ends with hub_lost 10 s after the hub\'s newest frame, or at another hub run', () => {
    let link: BuzzerHubLink | null = { epoch: 7, heardAt: 1000 };
    const k = sim({}, () => link);
    k.cmd('beep', { count: 0 });
    k.run(BUZZER_HUB_SILENT_MS - 1, TICK_MS / 20);
    expect(k.s.playing).toBe(true);
    k.run(1);
    expect(k.dones()).toEqual([{ t: 1000 + BUZZER_HUB_SILENT_MS, sound: 'beep', reason: 'hub_lost' }]);

    link = { epoch: 7, heardAt: k.now() };
    k.cmd('tone', { freq_hz: 2000, ms: 60_000 });
    link = { epoch: 8, heardAt: k.now() };
    k.run(TICK_MS);
    expect(k.dones().at(-1)).toMatchObject({ sound: 'tone', reason: 'hub_lost' });

    link = null;
    k.cmd('tone', { freq_hz: 2000, ms: 100 });
    k.run(100);
    expect(k.dones().at(-1)).toMatchObject({ sound: 'tone', reason: 'done' }); // no hub session at the start
  });
});

describe('the fake stepper board\'s buzzer', () => {
  let r: NetRig | null = null;
  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const s of stops.splice(0)) {
      await s();
    }
    await r?.close();
    r = null;
  });

  it('answers the generated codecs through the router: a beep, its done, a refused pitch and the volume', async () => {
    r = await netRig();
    const mac = '02cafe000003';
    r.registry.add({ device_id: mac, addr: 0x0032, alias: 'stepper-c3', provisioned: true, net: 0 });
    const online = waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === mac);
    const fake = await startFakeStepper({ mac, addr: 0x0032, net: 0, alias: 'stepper-c3', aliasRev: 0, epoch: 1, hub: r.ports });
    stops.push(() => fake.stop());
    await online;
    const dev = r.registry.get(mac)!;
    const send = (command: string, args: Record<string, unknown> = {}) => sendCommandTo(r!.hub, dev, 'buzzer', command, args, { ack: 'result', timeoutMs: 2000 });

    const done = waitForEvent(r.events, (e) => e.type === 'buzzer.done', 3000);
    expect(await send('beep', { count: 2, on_ms: 50, off_ms: 50 })).toMatchObject({ status: 'ok' });
    expect(fake.buzzer.playing).toBe(true);
    expect((await done).fields).toEqual({ sound: 'beep', reason: 'done' });
    expect(await send('tone', { freq_hz: 50, ms: 100 })).toMatchObject({ status: 'invalid_args' });
    expect(await send('melody', { freq_hz: [523, 659, 784], ms: [100, 100, 200] })).toMatchObject({ status: 'ok' });
    expect(await send('set_volume', { volume: 20 })).toMatchObject({ status: 'ok' });
    expect(fake.buzzer.volume).toBe(20);
    const stopped = waitForEvent(r.events, (e) => e.type === 'buzzer.done' && (e.fields as { reason?: string }).reason === 'stopped', 2000);
    expect(await send('stop')).toMatchObject({ status: 'ok' });
    expect((await stopped).fields).toEqual({ sound: 'melody', reason: 'stopped' });
  });
});
