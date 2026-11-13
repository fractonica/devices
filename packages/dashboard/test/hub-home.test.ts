// The Hub page's logic (src/state/hub-instrument.ts, src/state/hub-home.ts): the small instrument read from the core
// at SPEC vector A (the numbers the design states for that instant: 29ι lit on the bezel, 8 of 9 θ beads, the next
// threshold an END, the glyphs of the period pair), its geometry and ink, when it asks to be drawn again (never a
// fixed poll), and nothing Earth in pure mode; then the fleet's order and words, the health line, the banner and the
// threshold line.

import { beforeAll, describe, expect, it } from 'vitest';

import { type Core, loadCore } from '@fractonica/time';
import type { HubEvent, Prompt } from '@fractonica/protocol/client';

import {
  BEZEL,
  counterRingInk,
  FIRST_RING,
  graduationInk,
  hubFocus,
  hubGeometry,
  nestInk,
  nestPath,
  nextDraw,
  nowPoint,
  odometerInk,
  readHubInstrument,
  REFERENCE,
  settledKey,
} from '../src/state/hub-instrument.ts';
import { checkName, healthLine } from '../src/state/checks.ts';
import { bannerItems, fleetSummary, latestThresholds, portName } from '../src/state/hub-home.ts';
import { pureSafe } from '../src/state/pure-text.ts';
import { eventWords, fleetCount } from '../src/state/words.ts';

/** SPEC vector A: 2026-10-08T12:00:00Z, ε#5 34η 29ι 21λ 3ν. */
const A = 1_791_460_800_000_000n;
/** Anything Earth: a clock time, a civil date word, a zone, an Earth unit, the Earth sign. */
const EARTH = /⊕|\d{1,2}:\d{2}|\b(UTC|GMT|MON|TUE|WED|THU|FRI|SAT|SUN|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b|\b\d+\s?(h|min|s|ms|Hz|m)\b|%/;

let core: Core;
beforeAll(async () => {
  core = await loadCore();
});

describe('the small instrument at SPEC vector A', () => {
  it('is focused on the Helion and laid out as the phone reference, without the Sun’s ring', () => {
    const g = hubGeometry(core.frc);
    expect(g.focus).toBe(hubFocus(core.frc));
    expect(core.frc.formatLevelName(g.focus)).toBe('η');
    expect(g.R).toBe(REFERENCE.R);
    expect(g.carrier).toBeCloseTo(REFERENCE.R, 6); // the Helion's arcs fit at the full radius
    expect(g.bezel).toBeCloseTo(BEZEL * REFERENCE.R, 6);
    // two nested layers: 18 θ half-cycles, then 4 ι half-cycles on each
    expect(g.nest.layers.map((l) => l.arcs.length)).toEqual([18, 72]);
    // one ring per ancestor, ζ first at 1.37 R, α outermost; majors closer together
    expect(g.rings.map((r) => core.frc.formatLevelName(r.level))).toEqual(['ζ', 'ε', 'δ', 'γ', 'β', 'α']);
    expect(g.rings[0]!.radius).toBeCloseTo(FIRST_RING * REFERENCE.R, 6);
    expect(g.rings[1]!.radius - g.rings[0]!.radius).toBeCloseTo(REFERENCE.gap, 6);
    expect(g.rings[2]!.radius - g.rings[1]!.radius).toBeCloseTo(REFERENCE.gapMajor, 6);
    expect(g.extent).toBeGreaterThan(g.outer);
  });

  it('lights what the design states for A', () => {
    const g = hubGeometry(core.frc);
    const r = readHubInstrument(core, A, g.focus, g.nest.layers.length);
    expect(r.lit).toBe(true);
    expect(r.name).toBe('34η');
    expect(r.beads).toEqual({ count: 9, lit: 7 }); // θ: 8 of 9 lit
    expect(r.graduations.count).toBe(36); // 36 Preons in a Helion
    expect(r.graduations.lit).toBe(29); // the bezel's lit ticks minus one: 29ι
    expect(r.next).toBe(3); // Quarter.END: η END IN 6ι 43λ
    expect(r.digits).toEqual([...core.cat.odometerAt(A, g.focus, 2, 2).digits]);
    expect(r.fraction).toBeCloseTo(core.cat.cycleAt(A, g.focus).fraction, 12);
    expect(r.ancestors.map((a) => a.letter)).toEqual(['ζ', 'ε', 'δ', 'γ', 'β', 'α']);
    expect(r.ancestors[0]).toMatchObject({ slots: 11, current: 0 }); // ζ: 1 of 11 lit
    expect(r.thresholds.map((t) => t.word.toLowerCase())).toEqual(['end', 'peak', 'node', 'valley']);
    expect(r.thresholds.every((t) => t.time === '')).toBe(true);
    // the path to now: the 15th θ half (the 8th θ cycle, its first half: θ's phase is 0.33 at A) and its ι half
    expect(r.steps![0]!.local).toBe(14);
    expect(r.steps).toHaveLength(2);
    for (const s of r.steps!) {
      expect(s.progress).toBeGreaterThanOrEqual(0);
      expect(s.progress).toBeLessThan(1);
    }
  });

  it('says itself in core notation only in pure mode, and puts clock times on the bezel only in Earth mode', () => {
    const g = hubGeometry(core.frc);
    const pure = readHubInstrument(core, A, g.focus, 2);
    expect(pure.label).toContain('34η');
    expect(pure.label).toMatch(/End in 6ι 43λ/i);
    expect(pure.label).not.toMatch(EARTH);
    const earth = readHubInstrument(core, A, g.focus, 2, { earth: true });
    for (const t of earth.thresholds) {
      expect(t.time).toMatch(/^\d{2}:\d{2}$/);
    }
    expect(earth.label).toBe(pure.label);
  });

  it('draws from the core’s arcs: settled ink keyed by the running arcs, the lit part apart, now on the deepest arc', () => {
    const g = hubGeometry(core.frc);
    const r = readHubInstrument(core, A, g.focus, 2);
    const path = nestPath(g.nest, r.steps!);
    expect(path.map((p) => p.index)).toEqual([14, 14 * 4 + r.steps![1]!.local]);
    expect(settledKey(path)).toBe(path.map((p) => p.index).join('.'));
    expect(settledKey(null)).toBe('-');
    const settled = nestInk(core.frc, g.nest, path, 'settled');
    expect(settled).toHaveLength(2);
    // first layer: 14 elapsed arcs, the running one and the three after it to come
    expect((settled[0]!.elapsed.match(/M/g) ?? []).length).toBe(14);
    expect((settled[0]!.toCome.match(/M/g) ?? []).length).toBe(4);
    expect(settled[1]!.near).not.toBe(''); // the θ cycle that holds now is brighter
    const current = nestInk(core.frc, g.nest, path, 'current');
    expect(current[0]!.current).toMatch(/^M/);
    expect(current[0]!.toCome).toBe('');
    const engraved = nestInk(core.frc, g.nest, null, 'settled');
    expect(engraved.every((l) => l.elapsed === '' && l.near === '')).toBe(true);
    const now = nowPoint(core.frc, g.nest, path)!;
    expect(Math.hypot(now.x, now.y)).toBeGreaterThan(g.bezel);
    expect(Math.hypot(now.x, now.y)).toBeLessThan(g.rings[0]!.radius);
  });

  it('inks the counter rings, the bezel and the odometer', () => {
    const g = hubGeometry(core.frc);
    const r = readHubInstrument(core, A, g.focus, 2);
    const zeta = counterRingInk(core.frc, r.ancestors[0]!, g.rings[0]!.radius);
    expect(zeta.done).toBe(''); // the first Helion of eleven
    expect(zeta.lit).toMatch(/^M/);
    expect((zeta.rest.match(/M/g) ?? []).length).toBe(11); // the rest of the running slot and ten to come
    expect(zeta.planet && Math.hypot(zeta.planet.x, zeta.planet.y)).toBeCloseTo(g.rings[0]!.radius, 3);
    expect(zeta.letter?.text).toBe('ζ');
    const grads = graduationInk(core.frc, g.bezel, r.graduations);
    expect((grads.on.match(/M/g) ?? []).length).toBe(30);
    expect((grads.off.match(/M/g) ?? []).length).toBe(6);
    const glyphs = odometerInk(core.frc, r.digits!, 8.8);
    expect(glyphs).toHaveLength(2);
    expect(glyphs[0]!.stroke).toMatch(/^M/);
    expect(glyphs[0]!.lineWidth).toBeGreaterThan(0);
  });

  it('asks to be drawn again at its next change or when its ink has moved, never on a fixed poll', () => {
    const g = hubGeometry(core.frc);
    const r = readHubInstrument(core, A, g.focus, 2);
    const wake = nextDraw(core, g, r)!;
    expect(wake).toBeGreaterThan(A);
    // within a minute, and not sooner than a quarter of a second
    expect(wake - A).toBeGreaterThanOrEqual(250_000n);
    expect(wake - A).toBeLessThanOrEqual(60_000_000n);
    for (const c of r.changes) {
      expect(wake).toBeLessThanOrEqual(c);
    }
  });

  it('stays engraved outside the catalogue', () => {
    const g = hubGeometry(core.frc);
    const before = core.cat.instant(0)! - 1_000_000_000n;
    const r = readHubInstrument(core, before, g.focus, 2);
    expect(r.lit).toBe(false);
    expect(r.steps).toBeNull();
    expect(r.digits).toBeNull();
    expect(r.ancestors.every((a) => a.current === -1 && a.fraction === null)).toBe(true);
    expect(nextDraw(core, g, r)).toBeNull();
    expect(r.label).not.toMatch(EARTH);
  });
});

describe('the fleet', () => {
  const devices = [
    { device_id: 'a1', alias: 'porch-analog', presence: 'online', profile: 'c3o-analog', last_seen: '2026-10-08T11:59:00Z' },
    { device_id: 'a2', alias: 'attic-pad', presence: 'unknown', profile: 'c6-pad', last_seen: null },
    { device_id: 'a3', alias: 'desk-pad', presence: 'online', profile: null, board: 'esp32-c6-devkit' },
    { device_id: 'a4', alias: 'hall-pad', presence: 'suspect', chip: 'esp32c6' },
    { device_id: 'a5', alias: 'bench-analog', presence: 'offline', profile: 'c3o-analog', last_seen: '2026-10-08T10:00:00Z' },
    { device_id: 'f1', alias: 'fixture', presence: 'online', role: 'fixture' },
  ];

  it('orders by presence (lit first, as a bead counter reads), then by name, and leaves the HIL fixture out', () => {
    const s = fleetSummary(devices);
    expect(s.rows.map((r) => r.alias)).toEqual(['desk-pad', 'porch-analog', 'hall-pad', 'bench-analog', 'attic-pad']);
    expect(s.rows.map((r) => r.bead)).toEqual(['online', 'online', 'waiting', 'offline', 'idle']);
    expect(s).toMatchObject({ total: 5, online: 2, waiting: 1, offline: 2 });
    expect(s.rows.map((r) => r.kind)).toEqual(['esp32-c6-devkit', 'c3o-analog', 'esp32c6', 'c3o-analog', 'c6-pad']);
    expect(s.rows.find((r) => r.alias === 'attic-pad')!.presence).toBe('not heard yet');
  });

  it('gives each device its last word: the newest live event, else when the registry last heard it', () => {
    const s = fleetSummary(devices, { a1: { type: 'button.down', t_hub_us: 1_791_460_799_000_000 }, a4: { type: 'device.suspect', t_hub_us: 5 } });
    const by = Object.fromEntries(s.rows.map((r) => [r.alias, r.last]));
    expect(by['porch-analog']).toEqual({ what: 'button.down', at: 1_791_460_799_000_000 });
    expect(by['hall-pad']).toEqual({ what: 'went quiet', at: 5 });
    expect(by['bench-analog']).toEqual({ what: 'last heard', at: '2026-10-08T10:00:00Z' });
    expect(by['attic-pad']).toBeNull();
    expect(eventWords({ type: 'device.online' })).toBe('came online');
    expect(eventWords({ type: 'status.color' })).toBe('status.color');
  });

  it('counts in words, never a percentage', () => {
    expect(fleetCount({ total: 6, online: 5 })).toBe('5 of 6 online');
    expect(fleetCount({ total: 6, online: 6 })).toBe('all 6 online');
    expect(fleetCount({ total: 1, online: 1 })).toBe('online');
    expect(fleetCount({ total: 3, online: 0 })).toBe('none of 3 online');
    expect(fleetCount({ total: 0, online: 0 })).toBe('no devices');
  });
});

describe('hub health', () => {
  const checks = [
    { id: 'node', level: 'ok' as const, detail: 'v24' },
    { id: 'shim', level: 'warn' as const, detail: 'the fr shim points elsewhere', fix: 'fr doctor --fix' },
    { id: 'pytools', level: 'error' as const, detail: 'sidecar venv missing', fix: 'fr doctor --fix' },
    { id: 'idf_env', level: 'ok' as const, detail: 'ok' },
  ];

  it('makes each check a bead and lists what needs doing, errors first, each with its fix', () => {
    const h = healthLine(checks);
    expect(h.checks.map((c) => c.bead)).toEqual(['online', 'waiting', 'fault', 'online']);
    expect(h.checks[3]!.label).toBe('IDF environment: ok');
    expect(h.issues.map((c) => c.id)).toEqual(['pytools', 'shim']);
    expect(h.issues[0]!.fix).toBe('fr doctor --fix');
    expect(h).toMatchObject({ ok: 2, warn: 1, error: 1, word: '1 error · 1 warning', bead: 'fault' });
    expect(healthLine(checks.filter((c) => c.level === 'ok'))).toMatchObject({ word: 'all well', bead: 'online', issues: [] });
    expect(healthLine([])).toMatchObject({ word: 'no checks', bead: 'idle' });
    expect(healthLine([checks[1]!, { ...checks[1]!, id: 'x' }]).word).toBe('2 warnings');
    expect(checkName('web_bench')).toBe('app bench');
  });

  it('tells a text with Earth units from one pure mode may show', () => {
    expect(pureSafe('sidecar venv missing')).toBe(true);
    expect(pureSafe('fr doctor --fix')).toBe(true);
    expect(pureSafe('v6.1 at the pinned commit')).toBe(true);
    expect(pureSafe('event loop delay over the last 59 s: p50 0.74 ms, p99 8.11 ms')).toBe(false);
    expect(pureSafe('a 5 GHz network')).toBe(false);
    expect(pureSafe('92% full')).toBe(false);
    expect(pureSafe('checked at 14:05')).toBe(false);
    expect(pureSafe('every 2 minutes')).toBe(false);
  });
});

describe('the banner', () => {
  const prompts: Prompt[] = [
    { prompt_id: 'p_00000002', text: 'Press BOOT on desk-pad', selector: 'desk-pad', types: ['boot.down'], expires_at: '2026-10-08T12:05:00Z' },
    { prompt_id: 'p_00000001', text: 'Unplug hall-pad', types: ['device.offline'], expires_at: '2026-10-08T12:01:00Z' },
  ];
  const ports = [
    { path: '/dev/cu.usbmodem-test-1', alias: 'hall-pad', lease: { lease_id: 'l_1', holder_pid: 4242, expires_at: '2026-10-08T12:10:00Z' } },
    { path: '/dev/cu.usbmodem-test-2', lease: { lease_id: 'l_2', expires_at: '2026-10-08T12:10:00Z', by: 'job' as const } },
    { path: '/dev/cu.usbmodem-test-3' },
  ];
  const jobs = [
    { job_id: 'j_1', kind: 'provision', status: 'working', stage: 'flash', targets: ['desk-pad'] },
    { job_id: 'j_2', kind: 'build', status: 'completed' },
    { job_id: 'j_3', kind: 'ota', status: 'queued' },
  ];

  it('lists prompts (soonest to end first), lent ports, then running jobs', () => {
    const items = bannerItems(prompts, ports, jobs);
    expect(items.map((i) => i.kind)).toEqual(['prompt', 'prompt', 'lease', 'lease', 'job', 'job']);
    expect(items[0]).toMatchObject({ kind: 'prompt', text: 'Unplug hall-pad', who: '' });
    expect(items[1]).toMatchObject({ who: 'desk-pad' });
    expect(items[2]).toMatchObject({ kind: 'lease', port: 'hall-pad', who: 'pid 4242', byJob: false });
    expect(items[3]).toMatchObject({ kind: 'lease', port: 'cu.usbmodem-test-2', who: 'a job', byJob: true });
    expect(items[4]).toMatchObject({ kind: 'job', title: 'provision desk-pad', stage: 'flash', provision: true });
    expect(items[5]).toMatchObject({ kind: 'job', title: 'ota', stage: 'queued', provision: false });
    expect(bannerItems([], [{ path: '/dev/x' }], [{ job_id: 'j', kind: 'build', status: 'failed' }])).toEqual([]);
    expect(portName('/dev/cu.usbmodem-test-1')).toBe('cu.usbmodem-test-1');
  });
});

describe('the threshold line', () => {
  const ev = (seq: number, symbol: string, quarter: string, at: string | undefined, t = 0): HubEvent => ({
    cursor: `c:1.${seq}`,
    seq,
    type: 'time.threshold',
    t_hub_us: t,
    fields: { symbol, quarter, ...(at ? { at } : {}) },
  });

  it('merges the stored and the live ones, each once, newest first, at most three', () => {
    const stored = [ev(1, 'η', 'peak', '1791460000000000'), ev(5, 'η', 'node', '1791460500000000')];
    const live = [ev(5, 'η', 'node', '1791460500000000'), ev(7, 'ι', 'end', '1791460700000000'), ev(8, 'θ', 'valley', undefined, 1_791_460_750_000_000), { ...ev(9, '', '', undefined), type: 'button.down' }];
    const lines = latestThresholds(stored, live);
    expect(lines.map((l) => l.words)).toEqual(['θ valley', 'ι end', 'η node']);
    expect(lines[0]!.at).toBe(1_791_460_750_000_000n);
    expect(lines[1]!.at).toBe(1_791_460_700_000_000n);
    expect(latestThresholds([], [])).toEqual([]);
  });
});
