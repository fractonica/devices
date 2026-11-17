// The fr.stepper panel (design stepper-s1 D15): its arithmetic in node (src/state/stepper.ts: the dial's angle, the
// nudges per step mode, the spin speed, a typed position, the fault line's words), its words (cap-words.ts), and the
// panel rendered to strings with the live store seeded: the headline at rest and away, STOP on the Overview only while
// a motion runs, the Motor block (dial, nudges, GO TO, SPIN, STOP · HALT · HOLD · LET GO) with the commands it covers
// left out of the generic Actions, the fault line, and "set position here" while the position is not known. Nothing
// Earth in pure mode, ⊕ in Earth mode, and no button says Send.

import { QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { CATALOG } from '@fractonica/protocol/gen';
import { loadCore } from '@fractonica/time';

import { allCommandSentences, commandWords, enumWords, hasMemberEntry, memberValueText, memberWords } from '../src/state/cap-words.ts';
import { pureSafe } from '../src/state/pure-text.ts';
import { dialFraction, faultMessage, isRunning, lastFault, microsteps, motionOf, nudges, parsePosition, spinSpeed, stepsPerTurn } from '../src/state/stepper.ts';

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
vi.mock('../src/pages/device/panels/stepper.css', () => ({}));

type Runtime = typeof import('../src/runtime.ts');
let runtime: Runtime;
let stepper: typeof import('../src/pages/device/panels/stepper.tsx');
let panels: typeof import('../src/pages/device/panels.ts');

beforeAll(async () => {
  (globalThis as { location?: unknown }).location ??= { protocol: 'http:', host: '127.0.0.1:7420', search: '' };
  (globalThis as { __FRACTONICA__?: unknown }).__FRACTONICA__ = { token: 'tok-for-tests' };
  h.core = await loadCore();
  runtime = await import('../src/runtime.ts');
  stepper = await import('../src/pages/device/panels/stepper.tsx');
  panels = await import('../src/pages/device/panels.ts');
});

const EARTH = /⊕|\d{1,2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T|\b\d+\s?(h|min|s|ms|Hz|mV|mA|Ω|ohm)\b|%/;
/** The page's text without its inline styles and attribute values a person never reads. */
const visible = (html: string) => html.replace(/ (style|data-[a-z-]+)="[^"]*"/g, '');

const CAP = CATALOG.capabilities.find((c) => c.name === 'fr.stepper')!;
const DEV = 'c3c3c3c3c3c3';
const INSTANCES = [
  { name: 'status', port: 1, cap: 'fr.led', cap_id: 2, v: '1.0', traits: null },
  { name: 'motor', port: 2, cap: 'fr.stepper', cap_id: 0x12, v: '1.0', traits: { microstep: true } },
];
const DETAIL = {
  device_id: DEV,
  addr: 0x44,
  alias: 'stepper-c3',
  alias_rev: 1,
  net: 1,
  board: 'esp32c3-supermini',
  profile: 'c3s-stepper',
  chip: 'esp32c3',
  tags: [],
  role: 'node',
  fw_id: '3f2a9c01b2d40012',
  provisioned: true,
  last_seen: '2026-11-17T10:00:00.000Z',
  last_epoch: 1,
  created_at: '2026-11-17T09:00:00.000Z',
  presence: 'online',
  provision: null,
  router: { presence: 'online', hello_caps: 0, properties: {}, instances: INSTANCES.map(({ name, port, cap, cap_id }) => ({ name, port, cap, cap_id })) },
};

const REST = {
  position: 160,
  target: 160,
  speed_hz: 0,
  motion: 'holding',
  position_known: true,
  step_mode: 'micro8',
  max_speed_hz: 1600,
  accel: 8000,
  start_hz: 80,
  coil_ohm: 10,
  run_ma: 100,
  hold_pct: 30,
  release_ms: 1000,
  supply_mv: 5000,
  invert: false,
  limits: false,
  limit_min: -1_000_000_000,
  limit_max: 1_000_000_000,
  run_duty_pct: 20,
  steps_per_rev: 20,
};

function props(mirror: Record<string, unknown> = REST, presence = 'online') {
  return {
    detail: { ...DETAIL, presence } as never,
    inst: INSTANCES[1]!,
    cap: CAP,
    members: { properties: [...CAP.properties], commands: CAP.commands.filter((c) => c.visibility !== 'test'), events: [...CAP.events] },
    mirror,
    instances: INSTANCES,
  };
}

function render(el: ReturnType<typeof createElement>) {
  return renderToString(createElement(QueryClientProvider, { client: runtime.queryClient }, el));
}

describe('the stepper arithmetic', () => {
  it('counts the steps of a full step and of a turn from the step mode, by name or number', () => {
    expect(microsteps('full')).toBe(1);
    expect(microsteps('micro8')).toBe(8);
    expect(microsteps(5)).toBe(32);
    expect(microsteps('nonsense')).toBeNull();
    expect(stepsPerTurn(20, 'micro8')).toBe(160);
    expect(stepsPerTurn(20, 3)).toBe(160);
    expect(stepsPerTurn(200, 'half')).toBe(400);
    expect(stepsPerTurn(undefined, 'micro8')).toBeNull();
    expect(stepsPerTurn(20, undefined)).toBeNull();
  });

  it('puts the dial’s mark at position mod a turn, clockwise from the top, negative positions wrapping', () => {
    expect(dialFraction(0, 160)).toBe(0);
    expect(dialFraction(160, 160)).toBe(0);
    expect(dialFraction(40, 160)).toBe(0.25);
    expect(dialFraction(400, 160)).toBe(0.5);
    expect(dialFraction(-1, 160)).toBe(159 / 160);
    expect(dialFraction(-40, 160)).toBe(0.75);
    expect(dialFraction(-1_000_000_000, 160)).toBe(0);
    expect(dialFraction(5, 0)).toBe(0);
  });

  it('sizes the nudges by the step mode: a full step is 2^mode steps, a turn steps_per_rev of them', () => {
    const sizes = (spr: unknown, mode: unknown) => nudges(spr, mode).map((n) => n.steps);
    expect(sizes(20, 'full')).toEqual([-20, -1, 1, 20]);
    expect(sizes(20, 'half')).toEqual([-40, -2, 2, 40]);
    expect(sizes(20, 'micro4')).toEqual([-80, -4, 4, 80]);
    expect(sizes(20, 'micro8')).toEqual([-160, -8, 8, 160]);
    expect(sizes(20, 'micro16')).toEqual([-320, -16, 16, 320]);
    expect(sizes(200, 'micro32')).toEqual([-6400, -32, 32, 6400]);
    expect(nudges(20, 'micro8').map((n) => n.label)).toEqual(['−1 turn', '−1 full step', '+1 full step', '+1 turn']);
    // the turns wait for steps_per_rev; nothing is offered before the step mode is known
    expect(sizes(undefined, 'micro8')).toEqual([-8, 8]);
    expect(sizes(20, undefined)).toEqual([]);
  });

  it('spins at half the top speed, at least one step a second', () => {
    expect(spinSpeed(1600)).toBe(800);
    expect(spinSpeed(1601)).toBe(800);
    expect(spinSpeed(1)).toBe(1);
    expect(spinSpeed(undefined)).toBeNull();
  });

  it('takes a typed position as a whole number within the capability’s range', () => {
    expect(parsePosition('160')).toEqual({ ok: true, value: 160 });
    expect(parsePosition(' −800 ')).toEqual({ ok: true, value: -800 });
    expect(parsePosition('1 000')).toEqual({ ok: true, value: 1000 });
    expect(parsePosition('1.5').ok).toBe(false);
    expect(parsePosition('2000000000').ok).toBe(false);
    expect(parsePosition('').ok).toBe(false);
  });

  it('reads the motion by name or number, and says when it runs', () => {
    expect(motionOf(2)).toBe('moving');
    expect(motionOf('stopping')).toBe('stopping');
    expect(motionOf(undefined)).toBeNull();
    expect(isRunning('moving')).toBe(true);
    expect(isRunning('stopping')).toBe(true);
    expect(isRunning('holding')).toBe(false);
    expect(isRunning(null)).toBe(false);
  });

  it('says the fault’s cause, that the coils are off and that HOLD clears it, pure-safe', () => {
    expect(faultMessage('driver', 1)).toBe('The driver reported a fault; the coils are off. Hold clears it.');
    expect(faultMessage(1, 1)).toBe('A fault was injected; the coils are off. Hold clears it.');
    expect(faultMessage(undefined, undefined)).toBe('The motor is in fault; the coils are off. Hold clears it.');
    expect(faultMessage('driver', 3)).toContain('3 faults lately');
    for (const s of [faultMessage('driver', 3), faultMessage('injected', 1), faultMessage(null, null)]) {
      expect(pureSafe(s), s).toBe(true);
    }
  });

  it('finds the instance’s last fault event in the live ring, not another device’s or instance’s', () => {
    const ev = (seq: number, type: string, device = 'd1', part = 'event') => ({ seq, type, device, part, fields: { cause: seq } });
    const ring = [ev(1, 'motor.fault'), ev(2, 'motor.done'), ev(3, 'motor.fault', 'd2'), ev(4, 'arm.fault'), ev(5, 'motor.fault', 'd1', 'state')];
    expect(lastFault(ring, 'd1', 'motor')?.seq).toBe(1);
    expect(lastFault([...ring, ev(6, 'motor.fault')], 'd1', 'motor')?.seq).toBe(6);
    expect(lastFault(ring, 'd1', 'lift')).toBeUndefined();
  });
});

describe('the stepper words', () => {
  it('names every member whose catalog name is a code, and every enum member, in words', () => {
    const missing: string[] = [];
    const members = [...CAP.properties, ...CAP.commands.flatMap((c) => c.fields), ...CAP.events.flatMap((e) => e.fields)];
    for (const m of members) {
      if (/_(hz|ms|mv|ma|ohm|pct|rev|known)$|^(accel|recent|slips|seconds|target)$/.test(m.name) && !hasMemberEntry('fr.stepper', m.name)) {
        missing.push(m.name);
      }
    }
    expect(missing).toEqual([]);
    expect(enumWords('fr.stepper', 'StepMode', 'micro32')).toBe('thirty-second steps');
    expect(enumWords('fr.stepper', 'Motion', 'released')).toBe('let go');
    expect(enumWords('fr.stepper', 'DoneReason', 'hub_lost')).toBe('hub went quiet');
    expect(enumWords('fr.stepper', 'DoneReason', 'limit')).toBe('at a limit');
    for (const c of CAP.commands.filter((c) => c.visibility !== 'test')) {
      expect(commandWords('fr.stepper', c.name).does, c.name).toBeTruthy();
    }
    for (const s of allCommandSentences()) {
      expect(pureSafe(s), s).toBe(true);
    }
  });

  it('says speeds per Blink in pure mode and steps a second after ⊕; the coil’s Earth values only in Earth mode', () => {
    const speed = memberValueText(h.core as never, 'fr.stepper', { name: 'max_speed_hz', unit: 'Hz' }, 1600);
    expect(speed.text).not.toMatch(EARTH);
    expect(speed.earth).toBe('1 600 steps a second');
    const accel = memberValueText(h.core as never, 'fr.stepper', { name: 'accel', unit: 'Hz/s' }, 8000);
    expect(accel.text).not.toMatch(EARTH);
    expect(accel.earth).toBe('8 000 steps a second, each second');
    expect(memberValueText(h.core as never, 'fr.stepper', { name: 'coil_ohm', unit: 'ohm' }, 20)).toEqual({ text: '—', earth: '20 Ω' });
    expect(memberValueText(h.core as never, 'fr.stepper', { name: 'run_ma', unit: 'mA' }, 90)).toEqual({ text: '—', earth: '90 mA' });
    expect(memberValueText(h.core as never, 'fr.stepper', { name: 'supply_mv', unit: 'mV' }, 5000).text).toBe('—');
    expect(memberWords('fr.stepper', { name: 'seconds' })).toMatchObject({ words: 'for', unit: 's' });
    expect(memberWords('fr.stepper', { name: 'hold_pct' })).toMatchObject({ words: 'hold power', unit: '%' });
  });
});

describe('the stepper panel', () => {
  it('is registered for fr.stepper and covers the Motor block’s commands', () => {
    expect(panels.panelFor('fr.stepper')).toBe(stepper.STEPPER_PANEL);
    expect(stepper.STEPPER_PANEL.covers).toEqual(['move_to', 'move_by', 'jog', 'stop', 'halt', 'hold', 'release']);
  });

  it('heads the Overview row with the position and the motion word; away, it says as last seen', () => {
    h.mode = 'pure';
    const rest = render(createElement(stepper.STEPPER_PANEL.Headline, props()));
    expect(rest).toContain('160');
    expect(rest).toContain('holding');
    expect(rest).not.toContain('as last seen');
    const away = render(createElement(stepper.STEPPER_PANEL.Headline, props(REST, 'offline')));
    expect(away).toContain('data-stale="true"');
    expect(away).toContain('as last seen');
    expect(render(createElement(stepper.STEPPER_PANEL.Headline, props({})))).toContain('not reported yet');
  });

  it('offers STOP on the Overview only while a motion runs', () => {
    const Quick = stepper.STEPPER_PANEL.Quick!;
    expect(render(createElement(Quick, props()))).toBe('');
    const moving = render(createElement(Quick, props({ ...REST, motion: 'moving' })));
    expect(moving).toContain('>STOP<');
    expect(moving).toContain('aria-label="Stop motor"');
    expect(render(createElement(Quick, props({ ...REST, motion: 'stopping' })))).toContain('>STOP<');
  });

  it('draws the Motor block at rest: the dial at the position, the nudges, GO TO, SPIN, STOP · HALT · HOLD · LET GO; pure has nothing Earth', () => {
    h.mode = 'pure';
    const html = render(createElement(stepper.STEPPER_PANEL.Lens, props({ ...REST, position: 200, target: 200 })));
    // the Motor block leads the page, over the generic readings
    expect(html.indexOf('aria-label="Motor"')).toBeLessThan(html.indexOf('aria-label="Readings"'));
    // 200 of a 160-step turn: a quarter turn
    expect(html).toContain('data-turn="0.2500"');
    expect(html).toContain('data-mark="position"');
    expect(html).not.toContain('data-mark="target"');
    expect(html.match(/class="stepper-dial-tick/g)).toHaveLength(20);
    for (const n of [-160, -8, 8, 160]) {
      expect(html).toContain(`data-nudge="${n}"`);
    }
    expect(html).toContain('data-spin="-800"');
    expect(html).toContain('data-spin="800"');
    for (const w of ['GO TO', 'BACK', 'FORWARD', 'STOP', 'HALT', 'HOLD', 'LET GO']) {
      expect(html).toContain(`>${w}<`);
    }
    // the generic Actions keep zero, configure and reset_settings, not what the block runs
    for (const c of ['move_to', 'move_by', 'jog', 'stop', 'halt', 'hold', 'release']) {
      expect(html).not.toContain(`data-action-of="motor.${c}"`);
    }
    for (const c of ['zero', 'configure', 'reset_settings']) {
      expect(html).toContain(`data-action-of="motor.${c}"`);
    }
    expect(html).not.toContain('data-variant="primary"');
    expect(html).not.toMatch(/>Send</i);
    expect(html).not.toContain('ErrorLine');
    expect(html).not.toContain('data-error="fault"');
    expect(html).not.toContain('SET POSITION HERE');
    expect(visible(html)).not.toMatch(EARTH);
  });

  it('marks the target while a move runs elsewhere, and Earth mode adds ⊕ translations', () => {
    h.mode = 'earth';
    const html = render(createElement(stepper.STEPPER_PANEL.Lens, props({ ...REST, position: 40, target: 120, motion: 'moving', speed_hz: 800 })));
    h.mode = 'pure';
    expect(html).toContain('data-turn="0.2500"');
    expect(html).toContain('data-mark="target"');
    expect(html).toContain('going to 120');
    expect(html).toContain('⊕');
    expect(html).toContain('steps a second');
  });

  it('says the fault and HOLD as the fix while motion is fault', () => {
    // a server render reads the live store's first state, so no fault event: the cause is said in general
    const html = render(createElement(stepper.STEPPER_PANEL.Lens, props({ ...REST, motion: 'fault', position_known: false })));
    expect(html).toContain('data-error="fault"');
    expect(html).toContain('The motor is in fault; the coils are off. Hold clears it.');
    expect(html).toMatch(/data-error="fault"[\s\S]*>HOLD</);
    expect(html).toContain('data-motion="fault"');
    expect(visible(html)).not.toMatch(EARTH);
  });

  it('offers to set the position here while it is not known, and draws the mark hollow', () => {
    const html = render(createElement(stepper.STEPPER_PANEL.Lens, props({ ...REST, position_known: false })));
    expect(html).toContain('SET POSITION HERE');
    expect(html).toContain('data-known="false"');
    expect(html).toContain('NOT KNOWN');
    const moving = render(createElement(stepper.STEPPER_PANEL.Lens, props({ ...REST, position_known: false, motion: 'moving' })));
    expect(moving).toMatch(/data-stepper="zero"[^>]*disabled=""|disabled=""[^>]*data-stepper="zero"/);
  });

  it('waits for the step mode before it offers nudges, and disables everything while the board is away', () => {
    const bare = render(createElement(stepper.STEPPER_PANEL.Lens, props({ position: 0 })));
    expect(bare).toContain('the step mode is not reported yet');
    expect(bare).not.toContain('data-mark="position"');
    const away = render(createElement(stepper.STEPPER_PANEL.Lens, props(REST, 'offline')));
    for (const k of ['stop', 'halt', 'hold', 'release', 'goto']) {
      expect(away).toMatch(new RegExp(`data-stepper="${k}"[^>]*disabled=""|disabled=""[^>]*data-stepper="${k}"`));
    }
  });
});
