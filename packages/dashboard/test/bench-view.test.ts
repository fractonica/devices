// The Bench page's rules (src/state/bench-view.ts), ported from web/bench's tests (test/format.test.ts) when the bench
// app was folded into the dashboard: the views in the route's search, the next step, the short parts, the live chips,
// and the SVG sanitiser, which now also drops a drawing's own colours. Progress is counted in words, never a percent.

import { describe, expect, it } from 'vitest';

import { benchRoute, benchSearch, benchTab, instanceLive, liveText, missingText, nextStep, parseQty, partMatches, pinInstances, sanitizeSvg, stepsText } from '../src/state/bench-view.ts';
import { pureSafe } from '../src/state/pure-text.ts';

describe('routes', () => {
  it('reads the view from the search; guides by default', () => {
    expect(benchRoute(undefined)).toEqual({ view: 'guides' });
    expect(benchRoute({})).toEqual({ view: 'guides' });
    expect(benchRoute({ v: 'guide', id: 'power-bench-c6' })).toEqual({ view: 'guide', id: 'power-bench-c6' });
    expect(benchRoute({ v: 'guide' })).toEqual({ view: 'guides' });
    expect(benchRoute({ v: 'parts' })).toEqual({ view: 'parts' });
    expect(benchRoute({ v: 'part', id: 'tp4056-protected' })).toEqual({ view: 'part', id: 'tp4056-protected' });
    expect(benchRoute({ v: 'part', id: 42 })).toEqual({ view: 'part', id: '42' });
    expect(benchRoute({ v: 'shopping' })).toEqual({ view: 'shopping' });
    expect(benchRoute({ v: 'nonsense' })).toEqual({ view: 'guides' });
  });

  it('writes a view back as a search, and knows its tab', () => {
    expect(benchSearch({ view: 'part', id: 'a b' })).toEqual({ v: 'part', id: 'a b' });
    expect(benchSearch({ view: 'shopping' })).toEqual({ v: 'shopping' });
    expect(benchRoute(benchSearch({ view: 'guide', id: 'x-1' }))).toEqual({ view: 'guide', id: 'x-1' });
    expect(benchTab({ view: 'guide', id: 'x' })).toBe('guides');
    expect(benchTab({ view: 'part', id: 'x' })).toBe('parts');
    expect(benchTab({ view: 'shopping' })).toBe('shopping');
  });
});

describe('progress and the next step', () => {
  it('counts steps in words, never as a percentage', () => {
    expect(stepsText(0, 0)).toBe('no steps');
    expect(stepsText(1, 3)).toBe('1 of 3 steps done');
    expect(stepsText(5, 4)).toBe('all 4 steps done');
    expect(stepsText(1, 1)).toBe('the one step done');
    expect(stepsText(0, 1)).toBe('0 of 1 step done');
    for (const s of [stepsText(1, 3), stepsText(3, 3)]) {
      expect(s).not.toMatch(/%|per ?cent/);
    }
  });

  it('the first step not done, or null', () => {
    const g = { sections: [{ id: 'a', steps: [{ id: 'a1', done: true }] }, { id: 'b', steps: [{ id: 'b1', done: true }, { id: 'b2', done: false }] }] };
    expect(nextStep(g as never)).toEqual({ section: 'b', step: 'b2' });
    expect(nextStep({ sections: [{ id: 'a', steps: [{ id: 'a1', done: true }] }] } as never)).toBeNull();
  });

  it('lists the short BOM lines', () => {
    expect(missingText([{ name: 'Resistor', value: '1 MΩ', missing: 2 }, { name: 'TP4056', value: null, missing: 0 }])).toEqual(['2 × Resistor 1 MΩ']);
  });
});

describe('the SVG sanitiser', () => {
  it('drops scripts, foreignObject, handlers, javascript: and the prolog; keeps the drawing', () => {
    const svg = `<?xml version="1.0"?><!DOCTYPE svg><svg viewBox="0 0 1 1"><script>alert(1)</script><script src="x"/><foreignObject><div/></foreignObject><g class="node c-teal" onclick="sendPrompt('x')" onmouseover='y()'><rect x="1"/></g><a href="javascript:alert(1)"/></svg>`;
    const out = sanitizeSvg(svg);
    expect(out).toBe(`<svg viewBox="0 0 1 1"><g class="node c-teal"><rect x="1"/></g><a/></svg>`);
    expect(out).not.toMatch(/script|onclick|onmouseover|foreignObject|javascript/i);
  });

  it('drops a handler after a slash, an unquoted link out, a nested or encoded scheme, and animation', () => {
    for (const bad of [
      '<svg><image href=x /onerror=document.documentElement.dataset.xss=1 /></svg>',
      '<svg><a href="javajavascript:script:alert(1)"/></svg>',
      '<svg><a href="&#106;avascript:alert(1)"/></svg>',
      '<svg><set attributeName="href" to="javascript:alert(1)"/><animate onbegin="x()"/></svg>',
    ]) {
      const out = sanitizeSvg(bad);
      expect(out, bad).not.toMatch(/onerror|onbegin|javascript|<set|<animate|href=x/i);
    }
    expect(sanitizeSvg('<svg><use href="#a"/></svg>')).toBe('<svg><use href="#a"/></svg>');
  });

  it("drops the drawing's own colours and inline styles, so the tokens draw it", () => {
    const out = sanitizeSvg(`<svg><path stroke="#D85A30" d="M0 0"/><circle fill="#7f77dd" r="1"/><rect fill="var(--s)" style="fill:red"/><path stroke="context-stroke"/></svg>`);
    expect(out).toBe(`<svg><path data-ink="stroke" d="M0 0"/><circle data-ink="fill" r="1"/><rect fill="var(--s)"/><path stroke="context-stroke"/></svg>`);
    expect(out).not.toMatch(/#[0-9a-f]{3,8}/i);
  });
});

describe('live chips', () => {
  it("maps pins to instances and shows an instance's live values", () => {
    const m = pinInstances([
      { pin: 'gpio.0', instance: 'battery' },
      { pin: 'gpio.5', instance: null },
      { pin: 'gpio.5', instance: 'kick' },
    ]);
    expect([...m]).toEqual([
      ['gpio.0', 'battery'],
      ['gpio.5', 'kick'],
    ]);
    const props = { 'battery.mv': 3912, 'battery.charger': 'charging', 'battery.load_on': false, 'battery.level': 'ok', 'cap.mv': 4100 };
    // pure mode: no volt anywhere, the member's words and the bare count; Earth mode adds the value in its unit after ⊕
    expect(instanceLive(props, 'battery')).toEqual(['voltage 3912', 'charger charging', 'load on off']);
    expect(instanceLive(props, 'cap', 5)).toEqual(['voltage 4100']);
    expect(instanceLive(props, 'cap', 5, (m, v) => liveText(null, m, v, true))).toEqual(['voltage 4100 ⊕ 4\u202f100 mV']);
    expect(instanceLive(undefined, 'battery')).toEqual([]);
    expect(liveText(null, 'ratio', 57.123)).toBe('ratio 57.12');
    expect(liveText(null, 'x', { a: 1 })).toBe('x {"a":1}');
    for (const t of instanceLive(props, 'battery')) {
      expect(pureSafe(t), t).toBe(true);
    }
  });

  it("reads the live store's mirror ({value, t_hub_us}) as well as plain values", () => {
    const mirror = { 'battery.mv': { value: 3700, t_hub_us: 1 }, 'battery.charger': { value: 'full', t_hub_us: 2 } };
    expect(instanceLive(mirror, 'battery')).toEqual(['voltage 3700', 'charger full']);
  });
});

describe('parts', () => {
  it('searches id, name and summary', () => {
    const p = { id: 'tp4056-protected', name: 'TP4056 charger', summary: 'Li-ion charging module' };
    expect(partMatches(p, '')).toBe(true);
    expect(partMatches(p, 'tp4056')).toBe(true);
    expect(partMatches(p, 'CHARGING')).toBe(true);
    expect(partMatches(p, 'resistor')).toBe(false);
  });

  it('takes a stock count as a whole number, 0 or more', () => {
    expect(parseQty(' 12 ')).toBe(12);
    expect(parseQty('0')).toBe(0);
    expect(parseQty('-1')).toBeNull();
    expect(parseQty('1.5')).toBeNull();
    expect(parseQty('')).toBeNull();
    expect(parseQty('9'.repeat(30))).toBeNull();
  });
});
