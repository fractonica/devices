// The fr.haptic panel (design haptic-h1 D11): its logic in node (src/state/haptic.ts: the build's kind and limits, the tap
// train's checks against the node's budget rule, the named patterns and the metronome against the catalog, the sender
// that keeps live changes to five a second, the supply, the words for an end and a refusal), its words (cap-words.ts),
// and the panel rendered to strings: the headline, TAP, BUZZ or STOP on the Overview, the Solenoid block (taps, patterns,
// metronome) and the Vibration motor block over the generic readings and actions. Nothing Earth in pure mode, and no
// button says Send.

import { QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { hapticTrainFits } from '@fractonica/protocol/client';
import { CATALOG } from '@fractonica/protocol/gen';
import { loadCore } from '@fractonica/time';

import { allCommandSentences, commandWords, enumWords, hasMemberEntry } from '../src/state/cap-words.ts';
import {
  activeOf,
  busyWords,
  type Clock,
  fastestTempo,
  hapticDoneWords,
  hapticLimits,
  lastEvent,
  LiveSender,
  metronomeArgs,
  motorPatterns,
  rollPeriod,
  solenoidPatterns,
  supplyRefuses,
  supplyView,
  tapArgs,
  tapCheck,
  tapCheckWords,
} from '../src/state/haptic.ts';
import { capWord } from '../src/state/instruments.ts';
import { pureSafe } from '../src/state/pure-text.ts';

const h = vi.hoisted(() => ({ core: null as unknown, mode: 'pure' as 'pure' | 'earth' }));

vi.mock('../src/time/hooks.ts', () => ({
  useFractonica: () => h.core,
  useCoreError: () => null,
  useNowFor: (core: { frc: { now(): bigint } } | null) => (core ? core.frc.now() : null),
  useReading: () => null,
}));
vi.mock('../src/shell/mode.ts', () => ({
  useMode: () => ({ mode: h.mode, earth: h.mode === 'earth', setMode: () => {}, toggle: () => {} }),
}));
vi.mock('@tanstack/react-router', async () => {
  const react = await import('react');
  return {
    Link: ({ children, params, to, className }: { children?: ReactNode; params?: Record<string, string>; to: string; className?: string }) =>
      react.createElement('a', { href: `#${to.replace('$id', params?.id ?? '').replace('$instance', params?.instance ?? '')}`, className }, children),
    useParams: () => ({ id: 'stepper-c3' }),
    useNavigate: () => () => {},
    useSearch: () => ({}),
  };
});
vi.mock('../src/pages/device/panels/haptic.css', () => ({}));
vi.mock('../src/pages/device/panels/buzzer.css', () => ({}));
vi.mock('../src/pages/device/panels/stepper.css', () => ({}));

type Runtime = typeof import('../src/runtime.ts');
let runtime: Runtime;
let haptic: typeof import('../src/pages/device/panels/haptic.tsx');
let panels: typeof import('../src/pages/device/panels.ts');

beforeAll(async () => {
  (globalThis as { location?: unknown }).location ??= { protocol: 'http:', host: '127.0.0.1:7420', search: '' };
  (globalThis as { __FRACTONICA__?: unknown }).__FRACTONICA__ = { token: 'tok-for-tests' };
  h.core = await loadCore();
  runtime = await import('../src/runtime.ts');
  haptic = await import('../src/pages/device/panels/haptic.tsx');
  panels = await import('../src/pages/device/panels.ts');
});

const EARTH = /⊕|\d{1,2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T|\b\d+\s?(h|min|s|ms|Hz|mV|V|mA|A|Ω|ohm)\b|%|\bminute\b|\bsecond\b/;
/** The page's text without its inline styles and attribute values a person never reads. */
const visible = (html: string) => html.replace(/ (style|data-[a-z-]+|title|aria-valuetext)="[^"]*"/g, '');

const CAP = CATALOG.capabilities.find((c) => c.name === 'fr.haptic')!;
const DEV = 'c3c3c3c3c3c5';
/** c3s-stepper's capacitor, solenoid and motor (design haptic-h1 D6), as capability_list gives them with their config. */
const KICK = { name: 'kick', port: 6, cap: 'fr.haptic', cap_id: 0x0e, v: '1.1', traits: { pwm: true }, config: { kind: 'solenoid', rated_mv: 4200, supply: 'cap' } };
const BUZZ = { name: 'buzz', port: 7, cap: 'fr.haptic', cap_id: 0x0e, v: '1.1', traits: { pwm: true }, config: { kind: 'erm', rated_mv: 3000, supply: 'cap' } };
const CAPACITOR = { name: 'cap', port: 5, cap: 'fr.battery', cap_id: 0x0d, v: '1.0', traits: { status_pins: false, test_load: false, charge_gate: false }, config: { chemistry: 'lic', full_mv: 4200, report_hz: 10 } };
const INSTANCES = [CAPACITOR, KICK, BUZZ];
const DETAIL = {
  device_id: DEV,
  addr: 0x45,
  alias: 'stepper-c3',
  alias_rev: 1,
  net: 1,
  board: 'esp32c3-supermini',
  profile: 'c3s-stepper',
  chip: 'esp32c3',
  tags: [],
  role: 'node',
  fw_id: '3f2a9c01b2d40013',
  provisioned: true,
  last_seen: '2026-11-21T10:00:00.000Z',
  last_epoch: 1,
  created_at: '2026-11-21T09:00:00.000Z',
  presence: 'online',
  at: null,
  live: null,
};
const STILL = { active: false, supply_mv: 4180 };

function props(o: { inst?: typeof KICK; mirror?: Record<string, unknown>; presence?: string; capMv?: number; capLevel?: string } = {}) {
  const inst = o.inst ?? KICK;
  return {
    detail: { ...DETAIL, presence: o.presence ?? 'online', router: { properties: { 'cap.mv': o.capMv ?? 4180, 'cap.level': o.capLevel ?? 'ok' } } } as never,
    inst,
    cap: CAP,
    members: { properties: [...CAP.properties], commands: CAP.commands.filter((c) => c.visibility !== 'test'), events: [...CAP.events] },
    mirror: o.mirror ?? STILL,
    instances: INSTANCES,
  };
}

function render(el: ReturnType<typeof createElement>) {
  return renderToString(createElement(QueryClientProvider, { client: runtime.queryClient }, el));
}

/** A command's field range from the catalog. */
const range = (cmd: string, field: string) => CAP.commands.find((c) => c.name === cmd)!.fields.find((f) => f.name === field)!.range;
const SOLENOID = hapticLimits(KICK.config);
const ERM = hapticLimits(BUZZ.config);

describe('the haptic state', () => {
  it('reads the kind and limits from the build\'s config, the kind\'s defaults for what it leaves 0, the safe side without one', () => {
    expect(SOLENOID).toEqual({ kind: 'solenoid', max_on_ms: 1000, cooldown_pct: 30, kick_ms: 30, hold_pct: 40, rated_mv: 4200, supply: 'cap' });
    expect(ERM).toMatchObject({ kind: 'erm', max_on_ms: 10_000, cooldown_pct: 100, supply: 'cap' });
    expect(hapticLimits({ kind: 1, max_on_ms: 500, cooldown_pct: 20 })).toMatchObject({ kind: 'solenoid', max_on_ms: 500, cooldown_pct: 20, supply: null });
    expect(hapticLimits({ rated_mv: 3000 })).toMatchObject({ kind: 'erm' }); // the schema's default kind
    expect(hapticLimits(undefined)).toMatchObject({ kind: null, max_on_ms: 1000, cooldown_pct: 30 });
  });

  it('checks a train with the node\'s rule and says the longest tap that fits, pure-safe', () => {
    expect(tapCheck(50, 13, SOLENOID)).toEqual({ ok: true });
    expect(tapCheck(50, 14, SOLENOID)).toEqual({ ok: false, why: 'budget', longest: 13 });
    expect(tapCheck(50, 50, SOLENOID)).toMatchObject({ ok: false, why: 'period' });
    expect(tapCheck(5000, 1001, SOLENOID)).toMatchObject({ ok: false, why: 'max_on', longest: 1000 });
    expect(tapCheck(20, 19, ERM)).toEqual({ ok: true });
    for (const period of [20, 40, 50, 125, 250, 1000, 2000]) {
      for (const ms of [1, 5, 13, 14, 30, 100, 299, 300, 900]) {
        expect(tapCheck(period, ms, SOLENOID).ok, `${period} ${ms}`).toBe(ms < period && ms <= 1000 && hapticTrainFits(period, ms, 30));
      }
    }
    for (const why of ['period', 'max_on', 'budget'] as const) {
      expect(pureSafe(tapCheckWords({ ok: false, why, longest: 1 }))).toBe(true);
    }
    expect(tapArgs({ hz: 8, ms: 15, level: 70, count: 0 })).toEqual({ period_ms: 125, ms: 15, level: 70, count: 0, accent: 0, accent_level: 100 });
    expect(tapArgs({ hz: 25, ms: 13, level: 100, count: 1 }).period_ms).toBe(40);
    expect(tapArgs({ hz: 0.5, ms: 13, level: 100, count: 1 }).period_ms).toBe(2000);
  });

  it('builds the owner\'s patterns as the catalog and the node take them; one the node would refuse is greyed with why', () => {
    for (const [list, l] of [[solenoidPatterns(15, 70, SOLENOID), SOLENOID], [motorPatterns(80, ERM), ERM]] as const) {
      for (const p of list) {
        expect(p.send, p.key).not.toBeNull();
        const s = p.send!;
        if (s.command === 'play') {
          const steps = s.args.steps as number[];
          expect(steps.length).toBeLessThanOrEqual(32);
          expect(steps.filter((_, i) => i % 2 === 0).every((x) => x >= 1 && x <= l.max_on_ms)).toBe(true);
          if (l.kind === 'solenoid') {
            expect(steps.filter((_, i) => i % 2 === 1).every((x) => x > 0), p.key).toBe(true); // a real break after each tap
            expect(steps.length % 2 === 0 || !s.args.repeat, p.key).toBe(true);
          }
        }
        if (s.command === 'tap') {
          const [lo, hi] = range('tap', 'period_ms')!;
          expect(s.args.period_ms as number).toBeGreaterThanOrEqual(lo);
          expect(s.args.period_ms as number).toBeLessThanOrEqual(hi);
          expect(tapCheck(s.args.period_ms as number, s.args.ms as number, l).ok, p.key).toBe(true);
        }
      }
    }
    expect(solenoidPatterns(15, 70, SOLENOID).map((p) => p.key)).toEqual(['double', 'triple', 'heartbeat', 'knock', 'roll']);
    expect(motorPatterns(80, ERM).map((p) => p.key)).toEqual(['short', 'double', 'long', 'heartbeat']);
    expect(rollPeriod(13, SOLENOID)).toBe(50); // twenty a second
    expect(rollPeriod(20, SOLENOID)).toBe(75); // 134 x 21 ms of 3,000 (at 70: 143 x 21, over)
    // a long tap: the heartbeat's four beats spend more than the budget, the roll does not fit
    const long = solenoidPatterns(600, 70, SOLENOID);
    expect(long.find((p) => p.key === 'heartbeat')).toMatchObject({ send: null, why: expect.stringContaining('budget') });
    expect(long.find((p) => p.key === 'roll')).toMatchObject({ send: null, why: expect.stringContaining('roll') });
    expect(long.find((p) => p.key === 'double')?.send).not.toBeNull();
    for (const p of long) {
      expect(pureSafe(p.why ?? ''), p.key).toBe(true);
    }
  });

  it('sets the metronome: a beat every 60,000 / bpm ms, the bar\'s first beat accented, the fastest tempo a tap allows', () => {
    expect(metronomeArgs({ bpm: 120, beats: 4, ms: 15, level: 60, accentLevel: 100 })).toEqual({ period_ms: 500, ms: 15, level: 60, count: 0, accent: 4, accent_level: 100 });
    expect(metronomeArgs({ bpm: 120, beats: 1, ms: 15, level: 60, accentLevel: 100 }).accent).toBe(0);
    expect(fastestTempo(13, SOLENOID)).toBe(600); // a beat every 100 ms: 100 x 14 ms of 3,000
    expect(fastestTempo(60, SOLENOID)).toBe(293); // a beat every 205 ms: 49 x 61 = 2,989 of 3,000
    expect(tapCheck(Math.round(60_000 / fastestTempo(60, SOLENOID)!), 60, SOLENOID).ok).toBe(true);
    expect(tapCheck(Math.round(60_000 / (fastestTempo(60, SOLENOID)! + 1)), 60, SOLENOID).ok).toBe(false);
    expect(fastestTempo(1000, SOLENOID)).toBeNull(); // even at 20 a minute, four second-long taps in 10 s
  });

  it('sends live changes at most five a second: the first at once, then the latest at the end of each gap, never one twice', () => {
    let t = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const clock: Clock = {
      now: () => t,
      later: (fn, ms) => {
        const x = { at: t + ms, fn };
        timers.push(x);
        return x;
      },
      cancel: (x) => timers.splice(timers.indexOf(x as (typeof timers)[number]), 1),
    };
    const run = (to: number) => {
      while (t < to) {
        t += 1;
        for (const x of timers.filter((y) => y.at <= t)) {
          timers.splice(timers.indexOf(x), 1);
          x.fn();
        }
      }
    };
    const sent: { t: number; v: number }[] = [];
    const s = new LiveSender<{ v: number }>((a) => sent.push({ t, v: a.v }), 200, clock);
    for (let i = 1; i <= 50; i++) {
      s.push({ v: i });
      run(i * 20);
    }
    run(1500);
    expect(sent[0]).toEqual({ t: 0, v: 1 });
    expect(sent.at(-1)!.v).toBe(50); // the last change always lands
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i]!.t - sent[i - 1]!.t).toBeGreaterThanOrEqual(200);
    }
    expect(sent.length).toBeLessThanOrEqual(7); // a second of dragging: at most six, and the last
    const before = sent.length;
    s.push({ v: 50 }); // what was sent last: not again
    run(2000);
    expect(sent.length).toBe(before);
    s.push({ v: 51 });
    s.push({ v: 52 });
    s.cancel(); // STOP: the change not sent yet is dropped
    run(3000);
    expect(sent.map((x) => x.v).slice(before)).toEqual([51]);
  });

  it('reads the supply and says why the board refuses, pure-safe', () => {
    const s = supplyView('cap', { 'cap.mv': 3050, 'cap.level': 'ok' }, CAPACITOR.config)!;
    expect(s).toEqual({ name: 'cap', mv: 3050, level: 'ok', criticalMv: 2800 });
    expect(supplyRefuses('solenoid', s)).toBe('margin'); // under 2,800 + 300
    expect(supplyRefuses('erm', s)).toBeNull();
    expect(supplyRefuses('erm', { ...s, level: 'critical' })).toBe('low');
    expect(supplyRefuses(null, s)).toBe('margin'); // unknown: the solenoid's rule
    expect(supplyView('cap', { 'cap.mv': 3900, 'cap.level': 2 }, { chemistry: 2, critical_mv: 3000 })).toMatchObject({ level: 'critical', criticalMv: 3000 });
    expect(supplyView(null, {}, undefined)).toBeNull();
    for (const w of [busyWords('solenoid', s), busyWords('erm', { ...s, level: 'critical' }), busyWords('erm', s), busyWords('erm', null)]) {
      expect(pureSafe(w), w).toBe(true);
    }
    expect(busyWords('solenoid', s)).toContain('too low for the solenoid');
  });

  it('says how the last program ended, with the cut\'s reason, by name or number, pure-safe', () => {
    expect(hapticDoneWords({ program: 'tap', reason: 'done' })).toBe('the taps ran to their end');
    expect(hapticDoneWords({ program: 0, reason: 1 })).toBe('the pulse was stopped');
    expect(hapticDoneWords({ program: 'play', reason: 'replaced' })).toBe('the pattern gave way to the next');
    expect(hapticDoneWords({ program: 'tap', reason: 'cut' }, { reason: 'max_on', supply_mv: 4100 })).toBe('the taps were cut: it was on for as long as it may');
    expect(hapticDoneWords({ program: 'pulse', reason: 'cut' }, { reason: 0 })).toBe('the pulse was cut: its supply ran low');
    expect(hapticDoneWords({ program: 'tap', reason: 'hub_lost' })).toBe('the taps ended when the hub went quiet');
    expect(hapticDoneWords({ program: 'buzz', reason: 'done' })).toBeNull();
    for (const program of ['pulse', 'play', 'tap']) {
      for (const reason of ['done', 'stopped', 'replaced', 'hub_lost', 'cut']) {
        for (const cut of ['low_supply', 'floor', 'max_on']) {
          expect(pureSafe(hapticDoneWords({ program, reason }, { reason: cut })!)).toBe(true);
        }
      }
    }
    const ev = (seq: number, type: string, device = 'd1') => ({ seq, type, device, part: 'event', fields: {} });
    expect(lastEvent([ev(1, 'kick.done'), ev(2, 'buzz.done'), ev(3, 'kick.done', 'd2')], 'd1', 'kick', 'done')?.seq).toBe(1);
    expect(activeOf(true)).toBe(true);
    expect(activeOf(undefined)).toBeNull();
  });
});

describe('the haptic words', () => {
  it('names the 1.1 members, enums and commands, pure-safe; the instrument word is haptic', () => {
    const missing: string[] = [];
    const members = [...CAP.properties, ...CAP.commands.flatMap((c) => c.fields), ...CAP.events.flatMap((e) => e.fields)];
    for (const m of members) {
      if (/_(ms|mv)$|^(level|count|accent|accent_level|active|program|reason)$/.test(m.name) && !hasMemberEntry('fr.haptic', m.name)) {
        missing.push(m.name);
      }
    }
    expect(missing).toEqual([]);
    expect(enumWords('fr.haptic', 'Program', 'play')).toBe('pattern');
    expect(enumWords('fr.haptic', 'DoneReason', 'hub_lost')).toBe('hub went quiet');
    expect(enumWords('fr.haptic', 'Kind', 'erm')).toBe('vibration motor');
    for (const c of CAP.commands) {
      expect(commandWords('fr.haptic', c.name).does, c.name).toBeTruthy();
    }
    for (const s of allCommandSentences()) {
      expect(pureSafe(s), s).toBe(true);
    }
    expect(capWord('fr.haptic')).toBe('haptic');
  });
});

describe('the haptic panel', () => {
  it('is registered for fr.haptic and covers its commands', () => {
    expect(panels.panelFor('fr.haptic')).toBe(haptic.HAPTIC_PANEL);
    expect(haptic.HAPTIC_PANEL.covers).toEqual(['pulse', 'play', 'tap', 'stop']);
  });

  it('heads the Overview row with tapping, buzzing or still; away, it says as last seen', () => {
    h.mode = 'pure';
    const H = haptic.HAPTIC_PANEL.Headline;
    expect(render(createElement(H, props()))).toContain('still');
    expect(render(createElement(H, props({ mirror: { ...STILL, active: true } })))).toContain('tapping');
    expect(render(createElement(H, props({ inst: BUZZ, mirror: { ...STILL, active: true } })))).toContain('buzzing');
    const away = render(createElement(H, props({ presence: 'offline' })));
    expect(away).toContain('data-stale="true"');
    expect(away).toContain('as last seen');
    expect(render(createElement(H, props({ mirror: {} })))).toContain('not reported yet');
  });

  it('offers TAP (a solenoid) or BUZZ (a motor) on the Overview while still, STOP while it runs', () => {
    const Quick = haptic.HAPTIC_PANEL.Quick!;
    expect(render(createElement(Quick, props()))).toContain('>TAP<');
    expect(render(createElement(Quick, props({ inst: BUZZ })))).toContain('>BUZZ<');
    const running = render(createElement(Quick, props({ mirror: { ...STILL, active: true } })));
    expect(running).toContain('>STOP<');
    expect(running).toContain('aria-label="Stop kick"');
    expect(render(createElement(Quick, props({ presence: 'offline' })))).toContain('disabled=""');
  });

  it('draws the Solenoid block over the generic body: taps, the patterns, the metronome, the supply; pure has nothing Earth', () => {
    h.mode = 'pure';
    const html = render(createElement(haptic.HAPTIC_PANEL.Lens, props()));
    expect(html).toContain('data-kind="solenoid"');
    expect(html.indexOf('aria-label="Solenoid"')).toBeLessThan(html.indexOf('aria-label="Readings"'));
    for (const g of ['taps', 'patterns', 'metronome']) {
      expect(html).toContain(`data-haptic-group="${g}"`);
    }
    for (const k of ['double', 'triple', 'heartbeat', 'knock', 'roll']) {
      expect(html).toContain(`data-pattern="${k}"`);
    }
    for (const w of ['TAP', 'START', 'STOP', 'DOUBLE TAP', 'TRIPLE TAP', 'HEARTBEAT', 'KNOCK-KNOCK', 'ROLL']) {
      expect(html).toContain(`>${w}<`);
    }
    expect(html).toContain('data-haptic="supply"');
    expect(html).not.toContain('data-haptic="tap-hint"'); // the first settings fit
    expect(html).not.toContain('data-haptic="refuses"');
    // the generic Actions keep a pulse, a pattern and a tap of one's own; STOP is the block's
    for (const c of ['pulse', 'play', 'tap']) {
      expect(html).toContain(`data-action-of="kick.${c}"`);
    }
    expect(html).not.toContain('data-action-of="kick.stop"');
    expect(html).not.toContain('data-variant="primary"');
    expect(html).not.toMatch(/>Send</i);
    expect(visible(html)).not.toMatch(EARTH);
    h.mode = 'earth';
    const earth = render(createElement(haptic.HAPTIC_PANEL.Lens, props()));
    expect(earth).toContain('4 taps a second');
    expect(earth).toContain('100 beats a minute');
    h.mode = 'pure';
  });

  it('holds back what the board would refuse: the hint with the longest tap, START off, a greyed pattern with why; a low supply said', () => {
    h.mode = 'pure';
    const tight = { ...KICK, config: { ...KICK.config, cooldown_pct: 1 } }; // 100 ms of any 10 s
    const html = render(createElement(haptic.HAPTIC_PANEL.Lens, props({ inst: tight })));
    expect(html).toContain('data-haptic="tap-hint"');
    expect(html).toMatch(/data-haptic="start"[^>]*disabled=""|disabled=""[^>]*data-haptic="start"/);
    expect(html).toMatch(/data-pattern="roll"[^>]*disabled=""|disabled=""[^>]*data-pattern="roll"/);
    expect(html).toContain('data-haptic="pattern-why"');
    expect(html).toContain('data-haptic="tempo-hint"');
    const low = render(createElement(haptic.HAPTIC_PANEL.Lens, props({ capMv: 3050 })));
    expect(low).toContain('data-haptic="refuses"');
    expect(low).toContain('too low for the solenoid to start');
    expect(visible(html + low)).not.toMatch(EARTH);
  });

  it('draws the Vibration motor block: strength, length, BUZZ, its patterns and STOP', () => {
    h.mode = 'pure';
    const html = render(createElement(haptic.HAPTIC_PANEL.Lens, props({ inst: BUZZ })));
    expect(html).toContain('data-kind="erm"');
    expect(html).toContain('aria-label="Vibration motor"');
    expect(html).toContain('data-haptic-group="buzz"');
    expect(html).not.toContain('data-haptic-group="metronome"');
    for (const k of ['short', 'double', 'long', 'heartbeat']) {
      expect(html).toContain(`data-pattern="${k}"`);
    }
    expect(visible(html)).not.toMatch(EARTH);
  });

  it('disables every button while the board is away', () => {
    const away = render(createElement(haptic.HAPTIC_PANEL.Lens, props({ presence: 'offline' })));
    for (const k of ['tap', 'start', 'stop', 'metronome']) {
      expect(away).toMatch(new RegExp(`data-haptic="${k}"[^>]*disabled=""|disabled=""[^>]*data-haptic="${k}"`));
    }
    expect(away).toMatch(/data-pattern="double"[^>]*disabled=""|disabled=""[^>]*data-pattern="double"/);
  });
});
