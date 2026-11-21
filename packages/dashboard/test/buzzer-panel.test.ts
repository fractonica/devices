// The fr.buzzer panel (design buzzer-b1 D9): its logic in node (src/state/buzzer.ts: the beeps and tunes against the
// catalog and the driver's pitches, the last done and its words), its words (cap-words.ts), and the panel rendered to
// strings: the headline playing, quiet and away, BEEP or STOP on the Overview, the Buzzer block (beeps, tunes, STOP)
// over the generic readings and actions, which keep tone, beep, melody and the volume. Nothing Earth in pure mode, and
// no button says Send.

import { QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { CATALOG } from '@fractonica/protocol/gen';
import { loadCore } from '@fractonica/time';

import { BEEPS, doneWords, lastDone, playingOf, TUNES } from '../src/state/buzzer.ts';
import { allCommandSentences, commandWords, enumWords, hasMemberEntry } from '../src/state/cap-words.ts';
import { capWord, captionWords } from '../src/state/instruments.ts';
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
vi.mock('../src/pages/device/panels/buzzer.css', () => ({}));
vi.mock('../src/pages/device/panels/stepper.css', () => ({}));

type Runtime = typeof import('../src/runtime.ts');
let runtime: Runtime;
let buzzer: typeof import('../src/pages/device/panels/buzzer.tsx');
let panels: typeof import('../src/pages/device/panels.ts');

beforeAll(async () => {
  (globalThis as { location?: unknown }).location ??= { protocol: 'http:', host: '127.0.0.1:7420', search: '' };
  (globalThis as { __FRACTONICA__?: unknown }).__FRACTONICA__ = { token: 'tok-for-tests' };
  h.core = await loadCore();
  runtime = await import('../src/runtime.ts');
  buzzer = await import('../src/pages/device/panels/buzzer.tsx');
  panels = await import('../src/pages/device/panels.ts');
});

const EARTH = /⊕|\d{1,2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T|\b\d+\s?(h|min|s|ms|Hz|mV|mA|Ω|ohm)\b|%/;
/** The page's text without its inline styles and attribute values a person never reads. */
const visible = (html: string) => html.replace(/ (style|data-[a-z-]+|title)="[^"]*"/g, '');

const CAP = CATALOG.capabilities.find((c) => c.name === 'fr.buzzer')!;
/** ledc_buzzer's pitches (driver.yaml traits). */
const MIN_HZ = 100;
const MAX_HZ = 20000;
const DEV = 'c3c3c3c3c3c4';
const INSTANCES = [
  { name: 'status', port: 2, cap: 'fr.led', cap_id: 2, v: '1.0', traits: null },
  { name: 'buzzer', port: 4, cap: 'fr.buzzer', cap_id: 0x13, v: '1.0', traits: { pitched: true, volume: true, min_hz: MIN_HZ, max_hz: MAX_HZ } },
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
  last_seen: '2026-11-21T10:00:00.000Z',
  last_epoch: 1,
  created_at: '2026-11-21T09:00:00.000Z',
  presence: 'online',
  at: null,
  live: null,
};
const QUIET = { playing: false, volume: 50 };

function props(mirror: Record<string, unknown> = QUIET, presence = 'online') {
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

/** A command's field range from the catalog. */
const range = (cmd: string, field: string) => CAP.commands.find((c) => c.name === cmd)!.fields.find((f) => f.name === field)!.range;

describe('the buzzer presets', () => {
  it('beeps the catalog takes', () => {
    for (const b of BEEPS) {
      const [lo, hi] = range('beep', 'count')!;
      expect(b.args.count, b.key).toBeGreaterThanOrEqual(lo);
      expect(b.args.count, b.key).toBeLessThanOrEqual(hi);
      for (const f of ['on_ms', 'off_ms'] as const) {
        const v = b.args[f];
        if (v !== undefined) {
          const [l, u] = range('beep', f)!;
          expect(v, `${b.key}.${f}`).toBeGreaterThanOrEqual(l);
          expect(v, `${b.key}.${f}`).toBeLessThanOrEqual(u);
        }
      }
    }
    expect(BEEPS.map((b) => b.args.count)).toEqual([1, 3, 0]);
  });

  it('tunes BuzzerService plays: lists of one length, at most 32 notes, pitches the driver plays or rests, no empty note', () => {
    for (const t of TUNES) {
      const { freq_hz, ms } = t.args;
      expect(freq_hz.length, t.key).toBe(ms.length);
      expect(freq_hz.length, t.key).toBeGreaterThan(0);
      expect(freq_hz.length, t.key).toBeLessThanOrEqual(32);
      for (const f of freq_hz) {
        expect(f === 0 || (f >= MIN_HZ && f <= MAX_HZ), `${t.key}: ${f}`).toBe(true);
      }
      for (const m of ms) {
        expect(m, t.key).toBeGreaterThanOrEqual(1);
        expect(m, t.key).toBeLessThanOrEqual(65535);
      }
    }
    expect(new Set(TUNES.map((t) => t.key)).size).toBe(TUNES.length);
  });
});

describe('the buzzer state', () => {
  it('finds the instance’s last done in the live ring, not another device’s or instance’s', () => {
    const ev = (seq: number, type: string, device = 'd1', part = 'event') => ({ seq, type, device, part, fields: { sound: 'beep', reason: 'done' } });
    const ring = [ev(1, 'buzzer.done'), ev(2, 'motor.done'), ev(3, 'buzzer.done', 'd2'), ev(4, 'beeper.done'), ev(5, 'buzzer.done', 'd1', 'state')];
    expect(lastDone(ring, 'd1', 'buzzer')?.seq).toBe(1);
    expect(lastDone([...ring, ev(6, 'buzzer.done')], 'd1', 'buzzer')?.seq).toBe(6);
    expect(lastDone(ring, 'd1', 'horn')).toBeUndefined();
  });

  it('says how the last sound ended, by name or number, pure-safe', () => {
    expect(doneWords({ sound: 'melody', reason: 'done' })).toBe('the melody played out');
    expect(doneWords({ sound: 1, reason: 1 })).toBe('the beep was stopped');
    expect(doneWords({ sound: 'tone', reason: 'replaced' })).toBe('the tone gave way to the next sound');
    expect(doneWords({ sound: 'beep', reason: 'hub_lost' })).toBe('the beep ended when the hub went quiet');
    expect(doneWords({ sound: 'tone', reason: 'error' })).toBe('the tone failed: the buzzer refused');
    expect(doneWords({ sound: 'siren', reason: 'done' })).toBeNull();
    expect(doneWords(undefined)).toBeNull();
    for (const sound of ['tone', 'beep', 'melody']) {
      for (const reason of ['done', 'stopped', 'replaced', 'hub_lost', 'error']) {
        expect(pureSafe(doneWords({ sound, reason })!)).toBe(true);
      }
    }
    expect(playingOf(true)).toBe(true);
    expect(playingOf(undefined)).toBeNull();
  });
});

describe('the buzzer words', () => {
  it('names every member whose catalog name is a code, every enum member and every command, pure-safe', () => {
    const missing: string[] = [];
    const members = [...CAP.properties, ...CAP.traits, ...CAP.commands.flatMap((c) => c.fields), ...CAP.events.flatMap((e) => e.fields)];
    for (const m of members) {
      if (/_(hz|ms)$|^(count|repeat|playing|pitched|sound|reason)$/.test(m.name) && !hasMemberEntry('fr.buzzer', m.name)) {
        missing.push(m.name);
      }
    }
    expect(missing).toEqual([]);
    expect(enumWords('fr.buzzer', 'DoneReason', 'hub_lost')).toBe('hub went quiet');
    expect(enumWords('fr.buzzer', 'Sound', 'melody')).toBe('melody');
    for (const c of CAP.commands) {
      expect(commandWords('fr.buzzer', c.name).does, c.name).toBeTruthy();
    }
    for (const s of allCommandSentences()) {
      expect(pureSafe(s), s).toBe(true);
    }
    expect(capWord('fr.buzzer')).toBe('buzzer');
    // the caption says what it can do, never its pitch range as a bare number
    expect(captionWords(INSTANCES[1]!)).toBe('buzzer · port 4 · plays pitches · sets its volume');
    expect(captionWords({ ...INSTANCES[1]!, traits: { pitched: false, volume: false, min_hz: 0, max_hz: 0 } })).toBe('buzzer · port 4 · one pitch');
  });
});

describe('the buzzer panel', () => {
  it('is registered for fr.buzzer and covers its commands', () => {
    expect(panels.panelFor('fr.buzzer')).toBe(buzzer.BUZZER_PANEL);
    expect(buzzer.BUZZER_PANEL.covers).toEqual(['tone', 'beep', 'melody', 'stop', 'set_volume']);
  });

  it('heads the Overview row with playing or quiet; away, it says as last seen', () => {
    h.mode = 'pure';
    expect(render(createElement(buzzer.BUZZER_PANEL.Headline, props()))).toContain('quiet');
    const playing = render(createElement(buzzer.BUZZER_PANEL.Headline, props({ ...QUIET, playing: true })));
    expect(playing).toContain('playing');
    expect(playing).toContain('data-playing="true"');
    const away = render(createElement(buzzer.BUZZER_PANEL.Headline, props(QUIET, 'offline')));
    expect(away).toContain('data-stale="true"');
    expect(away).toContain('as last seen');
    expect(render(createElement(buzzer.BUZZER_PANEL.Headline, props({})))).toContain('not reported yet');
  });

  it('offers BEEP on the Overview while quiet and STOP while it plays', () => {
    const Quick = buzzer.BUZZER_PANEL.Quick!;
    const quiet = render(createElement(Quick, props()));
    expect(quiet).toContain('>BEEP<');
    expect(quiet).toContain('aria-label="Beep buzzer"');
    const playing = render(createElement(Quick, props({ ...QUIET, playing: true })));
    expect(playing).toContain('>STOP<');
    expect(playing).toContain('aria-label="Stop buzzer"');
    expect(render(createElement(Quick, props(QUIET, 'offline')))).toContain('disabled=""');
  });

  it('draws the Buzzer block over the generic body: beeps, tunes and STOP; the generic Actions keep the forms; pure has nothing Earth', () => {
    h.mode = 'pure';
    const html = render(createElement(buzzer.BUZZER_PANEL.Lens, props()));
    expect(html.indexOf('aria-label="Buzzer"')).toBeLessThan(html.indexOf('aria-label="Readings"'));
    for (const b of BEEPS) {
      expect(html).toContain(`data-beep="${b.key}"`);
    }
    for (const t of TUNES) {
      expect(html).toContain(`data-tune="${t.key}"`);
    }
    for (const w of ['BEEP', 'THREE BEEPS', 'KEEP BEEPING', 'RISING CHIME', 'FALLING CHIME', 'ALERT', 'SCALE', 'STOP']) {
      expect(html).toContain(`>${w}<`);
    }
    // the generic Actions keep a tone, a beep and a melody of one's own; STOP is the block's
    for (const c of ['tone', 'beep', 'melody']) {
      expect(html).toContain(`data-action-of="buzzer.${c}"`);
    }
    expect(html).not.toContain('data-action-of="buzzer.stop"');
    expect(html).not.toContain('data-variant="primary"');
    expect(html).not.toMatch(/>Send</i);
    expect(visible(html)).not.toMatch(EARTH);
  });

  it('disables every button while the board is away', () => {
    const away = render(createElement(buzzer.BUZZER_PANEL.Lens, props(QUIET, 'offline')));
    for (const k of ['once', 'three', 'keep']) {
      expect(away).toMatch(new RegExp(`data-beep="${k}"[^>]*disabled=""|disabled=""[^>]*data-beep="${k}"`));
    }
    expect(away).toMatch(/data-buzzer="stop"[^>]*disabled=""|disabled=""[^>]*data-buzzer="stop"/);
  });
});
