// The Hub page's drawn parts rendered to strings at SPEC vector A (pages/hub/instrument.tsx, pages/hub/present.tsx):
// the instrument is lit from the core's numbers, says itself in core notation, and in pure mode neither it nor the
// reading carries any Earth unit, date, clock time or the Earth sign, in text or attributes (design ruling 11);
// Earth mode adds the ⊕ line and the bezel's clock times.

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { type Core, loadCore, readNow } from '@fractonica/time';

const h = vi.hoisted(() => ({ core: null as unknown, mode: 'pure' as 'pure' | 'earth' }));
/** SPEC vector A: 2026-10-08T12:00:00Z, ε#5 34η 29ι 21λ 3ν. */
const A = 1_791_460_800_000_000n;

vi.mock('../src/time/hooks.ts', () => ({
  useFractonica: () => h.core,
  useCoreError: () => null,
  useNowFor: (core: { frc: { now(): bigint } } | null) => (core ? core.frc.now() : null),
  useReading: (mode: 'pure' | 'earth') => readNow(h.core as Core, { earth: mode === 'earth' }, { now: () => A }),
}));
vi.mock('../src/shell/mode.ts', () => ({
  useMode: () => ({ mode: h.mode, earth: h.mode === 'earth', setMode: () => {}, toggle: () => {} }),
}));

const EARTH = /⊕|\d{1,2}:\d{2}|\b(UTC|GMT|MON|TUE|WED|THU|FRI|SAT|SUN|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b|\b\d+\s?(h|min|s|ms|Hz|m)\b|%/;

let core: Core;
let Instrument: typeof import('../src/pages/hub/instrument.tsx').Instrument;
let Present: typeof import('../src/pages/hub/present.tsx').Present;

beforeAll(async () => {
  core = await loadCore();
  h.core = core;
  ({ Instrument } = await import('../src/pages/hub/instrument.tsx'));
  ({ Present } = await import('../src/pages/hub/present.tsx'));
});

/** The text a page shows and says: its text nodes and every attribute but path data and geometry. */
function words(html: string): string {
  const attrs = [...html.matchAll(/\s(aria-[a-z]+|title|alt)="([^"]*)"/g)].map((m) => m[2]);
  const text = html.replace(/<[^>]*>/g, ' ');
  return `${text} ${attrs.join(' ')}`;
}

describe('the Hub page’s instrument and reading', () => {
  it('draws the instrument lit from the core at A, its odometer and name, labelled in core notation', () => {
    h.mode = 'pure';
    const html = renderToString(createElement(Instrument, { core, earth: false, at: A }));
    expect(html).toContain('data-state="lit"');
    expect(html).toContain(`data-digits="${core.cat.odometerAt(A, 6, 2, 2).digits.join(' ')}"`);
    expect(html).toMatch(/aria-label="The present, Helion[^"]*34η/);
    expect(words(html)).toContain('END');
    expect(words(html)).not.toMatch(EARTH);
    // one glow filter, colours by class: no colour literal in the markup
    expect(html).not.toMatch(/#[0-9a-f]{6}\b|rgb\(/i);
  });

  it('puts the clock times on the bezel only in Earth mode', () => {
    const html = renderToString(createElement(Instrument, { core, earth: true, at: A }));
    expect(words(html)).toMatch(/END \d{2}:\d{2}/);
  });

  it('sets the reading as the site does; ⊕ only in Earth mode', () => {
    h.mode = 'pure';
    const pure = renderToString(createElement(Present));
    expect(pure).toContain('ε#5 34η 29ι');
    expect(words(pure)).toMatch(/END IN/);
    expect(words(pure)).not.toMatch(EARTH);
    h.mode = 'earth';
    const earth = renderToString(createElement(Present));
    expect(earth).toContain('⊕');
    h.mode = 'pure';
  });
});
