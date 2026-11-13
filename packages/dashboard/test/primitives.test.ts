// The stage 4 foundation's primitives and time helpers (src/ui, src/time): what they say in pure and in Earth mode
// (design ruling 11: nothing Earth in pure mode), the stage ring's light (no percentage), the instants the hub gives,
// and the CSP-relevant facts of the core in a browser bundle. Rendered to strings; the core is the Node loader's
// (the same vendored module the dashboard fetches).

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { type Core, loadCore } from '@fractonica/time';

/** The core and the mode the mocked hooks give the components. */
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
  return { Link: ({ children, to }: { children?: unknown; to: string }) => react.createElement('a', { href: `#${to}` }, children as never) };
});

/** SPEC vector A: 2026-10-08T12:00:00Z, ε#5 34η 29ι 21λ 3ν. */
const A_US = 1_791_460_800_000_000n;

let core: Core;
let ui: typeof import('../src/ui/index.ts');
let instant: typeof import('../src/time/instant.ts');

beforeAll(async () => {
  core = await loadCore();
  h.core = core;
  ui = await import('../src/ui/index.ts');
  instant = await import('../src/time/instant.ts');
});

const html = (el: Parameters<typeof renderToString>[0]) => renderToString(el);
/** Anything Earth: a clock time, a civil date word, a zone, an Earth unit, the Earth sign. */
const EARTH = /⊕|\d{1,2}:\d{2}|\b(UTC|GMT|MON|TUE|WED|THU|FRI|SAT|SUN|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b|\b\d+\s?(h|min|s|ms|Hz|m)\b|%/;

describe('instantOf', () => {
  it('reads the hub’s instants as BigInt Unix µs', () => {
    expect(instant.instantOf(1_791_460_800_000_000)).toBe(A_US);
    expect(instant.instantOf('2026-10-08T12:00:00.000Z')).toBe(A_US);
    expect(instant.instantOf(new Date(1_791_460_800_000))).toBe(A_US);
    expect(instant.instantOf(A_US)).toBe(A_US);
    expect(instant.instantOf('not a time')).toBeNull();
    expect(instant.instantOf(Number.NaN)).toBeNull();
    expect(instant.instantOf(undefined)).toBeNull();
  });
});

describe('fTimeText: the core’s notation, Earth only in Earth mode', () => {
  it('writes the terms, the short letters and the stamp as the core does', () => {
    expect(ui.fTimeText(core, A_US, null, { earthMode: false })).toEqual({ text: '29ι 21λ 3ν', civil: null });
    expect(ui.fTimeText(core, A_US, null, { form: 'stamp', earthMode: false }).text).toBe('α#6 β#4 γ#9 δ#3 ε#5 34η 29ι 21λ 3ν');
    expect(ui.fTimeText(core, A_US, null, { form: 'short', earthMode: false }).text).toMatch(/ε#5 34η 29ι 21λ 3ν$/);
  });

  it('says a relative time as a span, ago or ahead', () => {
    const later = A_US + 60_000_000n;
    expect(ui.fTimeText(core, A_US, later, { form: 'relative', earthMode: false }).text).toMatch(/^[\d.]+[α-ω]( \d+[α-ω])? ago$/);
    expect(ui.fTimeText(core, later, A_US, { form: 'relative', earthMode: false }).text).toMatch(/^in [\d.]+[α-ω]/);
    const earth = ui.fTimeText(core, A_US, later, { form: 'relative', earthMode: true });
    expect(earth.civil).toBe('1 min ago');
  });

  it('adds the civil clock time, date line or duration only in Earth mode', () => {
    expect(ui.fTimeText(core, A_US, null, { earthMode: true }).civil).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(ui.fTimeText(core, A_US, null, { form: 'stamp', earthMode: true }).civil).toMatch(/2026/);
    for (const form of ['terms', 'short', 'stamp', 'relative'] as const) {
      expect(ui.fTimeText(core, A_US, A_US + 1n, { form, earthMode: false }).civil, form).toBeNull();
    }
  });
});

describe('FTime, Earth and Page in the two modes', () => {
  it('render nothing Earth in pure mode', () => {
    h.mode = 'pure';
    const out = html(
      createElement(ui.Page, { title: 'Live', earth: 'THU 8 OCT 2026' }, createElement(ui.FTime, { at: A_US, form: 'stamp' }), createElement(ui.Earth, null, '12:00:00'), createElement(ui.Row, { label: 'At', value: 'x', earth: '12:00' })),
    );
    expect(out.replace(/<[^>]+>/g, '')).toContain('29ι 21λ 3ν');
    expect(out.replace(/<[^>]+>/g, ' ')).not.toMatch(EARTH);
  });

  it('lead every translation with ⊕ in Earth mode', () => {
    h.mode = 'earth';
    const out = html(createElement(ui.FTime, { at: A_US }));
    expect(out).toMatch(/class="earth"><span class="sign">⊕<\/span>\d{2}:\d{2}:\d{2}\.\d{3}/);
    h.mode = 'pure';
  });
});

describe('StageRing: progress as light', () => {
  const ring = (props: Partial<Parameters<typeof ui.StageRing>[0]>) => html(createElement(ui.StageRing, { stages: ui.PROVISION_STAGES, current: 0, ...props }));
  const count = (out: string, cls: string) => (out.match(new RegExp(`class="ui-ring-arc ${cls}"`, 'g')) ?? []).length;

  it('lights the stages done, engraves the running one lit to its fraction, and the rest to come', () => {
    const out = ring({ current: 5, fraction: 0.4 });
    expect(PROVISION_STAGES_LEN()).toBe(9);
    expect(count(out, 'done')).toBe(5);
    expect(count(out, 'base')).toBe(1);
    expect(count(out, 'lit')).toBe(1);
    expect(count(out, 'todo')).toBe(3);
    expect(out).toContain('data-stage="flash"');
    expect(out).toContain('>FLASH<');
    expect(out).toContain('aria-label="Progress: flash, stage 6 of 9"');
    // the point of now at the lit arc's edge, and a bead per stage on the carrier, five of them done
    expect(out).toContain('class="ui-ring-now"');
    expect((out.match(/class="ui-ring-bead lit"/g) ?? []).length).toBe(5);
    // what a person reads (the text, not the drawing's attributes) has no percentage
    expect(out.replace(/<[^>]*>/g, ' ')).not.toMatch(/%|\d+\s*percent/i);
  });

  it('leaves an unknown fraction engraved, turns a failure fault and says done at the end', () => {
    expect(count(ring({ current: 2 }), 'lit')).toBe(0);
    const failed = ring({ current: 7, failed: true });
    expect(failed).toContain('data-state="failed"');
    expect(count(failed, 'failed')).toBe(1);
    const done = ring({ current: 9 });
    expect(count(done, 'done')).toBe(9);
    expect(done).toContain('data-state="done"');
  });

  it('draws arcs that go their own way (a guide’s steps), and a bare mark for a row', () => {
    const steps = ring({ stages: ['a', 'b', 'c', 'd'], current: 2, bezel: false, arcs: [{ status: 'done' }, { status: 'todo' }, { status: 'done' }, { status: 'todo' }], label: 'Guide' });
    expect(count(steps, 'done')).toBe(2);
    expect(count(steps, 'todo')).toBe(2);
    expect(steps).toContain('aria-label="Guide: 2 of 4 done"');
    expect(steps).not.toContain('ui-ring-word');
    const bare = ring({ current: 3, bare: true, size: 22 });
    expect(bare).not.toContain('ui-ring-centre');
    expect(count(bare, 'done')).toBe(3);
  });

  function PROVISION_STAGES_LEN() {
    return ui.PROVISION_STAGES.length;
  }
});

describe('Bead, Button, ErrorLine', () => {
  it('draws a bead per state with its word for assistive technology', () => {
    for (const state of ['online', 'waiting', 'offline', 'fault', 'idle'] as const) {
      expect(html(createElement(ui.Bead, { state }))).toContain(`data-state="${state}"`);
    }
    expect(ui.presenceBead('online')).toBe('online');
    expect(ui.presenceBead('suspect')).toBe('waiting');
    expect(ui.presenceBead('offline')).toBe('offline');
    expect(ui.presenceBead(undefined)).toBe('idle');
  });

  it('engraves a button’s words and marks its variant', () => {
    const out = html(createElement(ui.Button, { variant: 'primary', children: 'Provision' }));
    expect(out).toContain('data-variant="primary"');
    expect(out).toContain('PROVISION');
  });

  it('shows an op error’s code and remedies, and a missing op as a notice', async () => {
    const { OpError } = await import('../src/api/rest.ts');
    const out = html(createElement(ui.ErrorLine, { error: new OpError({ code: 'PORT_BUSY_EXTERNAL', message: 'held by idf.py', retryable: false, hint: 'lend it' }) }));
    expect(out).toContain('data-error="PORT_BUSY_EXTERNAL"');
    expect(out).toContain('PORT HELD ELSEWHERE');
    expect(out).toContain('lend it');
    const missing = html(createElement(ui.ErrorLine, { error: new OpError({ code: 'NOT_FOUND', message: 'unknown op hub_doctor', retryable: false }), what: 'Doctor' }));
    expect(missing).toContain('data-tone="notice"');
    expect(missing).toContain('Doctor is not available on this hub yet.');
  });
});
