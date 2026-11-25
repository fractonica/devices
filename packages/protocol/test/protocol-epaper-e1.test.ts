// EPAPER-1 (design epaper-e1 D2, D9): fr.display 1.3 (the epaper trait, bitmap, refresh, hold, refreshed, the e-paper
// config and properties), the shared numbers in epaper.ts against the catalogue, and the four ops at the end of the
// registry with the REGISTRY_HASH they move.

import { describe, expect, it } from 'vitest';

import { CATALOG, DISPLAY_CAP, DisplayRefreshMode, encodeMember } from '@fractonica/protocol/gen';

import {
  DISPLAY_DITHERS,
  DISPLAY_FITS,
  EPAPER_BITMAP_MAX_BYTES,
  EPAPER_CONFIG_DEFAULTS,
  EPAPER_HOLD_MAX_MS,
  EPAPER_REFRESH_MODES,
  findOp,
  monoFrameBytes,
  OPS,
  PAPER_OPS,
  type OpDef,
  REGISTRY_HASH,
  registryHashOf,
  registryInputsHashOf,
} from '../src/index.ts';

import { beforeRtc } from './before-rtc.ts';

const NAMES = ['display_image', 'display_html', 'display_text', 'display_refresh'];

describe('fr.display 1.3 (design epaper-e1 D2)', () => {
  const cat = () => CATALOG.capabilities.find((c) => c.name === 'fr.display')!;

  it('adds the e-paper members, additively', () => {
    expect(DISPLAY_CAP.version).toEqual({ major: 1, minor: 3 });
    expect(DISPLAY_CAP.commands.map((c) => [c.name, c.id])).toEqual([
      ['clear', 1],
      ['text', 2],
      ['fill_rect', 3],
      ['set_brightness', 4],
      ['ui_load', 5],
      ['ui_set', 6],
      ['snapshot', 7],
      ['snapshot_read', 8],
      ['bitmap', 9],
      ['refresh', 10],
      ['hold', 11],
    ]);
    expect(cat().events.map((e) => [e.name, e.id])).toEqual([
      ['ui', 1],
      ['refreshed', 2],
    ]);
    expect(cat().properties.map((p) => [p.name, p.id])).toEqual([
      ['brightness', 1],
      ['partials', 2],
      ['shown_crc', 3],
      ['refresh_ms', 4],
    ]);
    expect(cat().traits.map((t) => t.name)).toEqual(['width', 'height', 'color', 'ui', 'touch', 'round', 'epaper']);
  });

  it('agrees with the numbers every side shares (epaper.ts)', () => {
    const bitmap = cat().commands.find((c) => c.name === 'bitmap')!;
    expect(bitmap.bulk).toBe(true);
    expect(bitmap.fields.find((f) => f.name === 'data')).toMatchObject({ type: 'bytes', max: EPAPER_BITMAP_MAX_BYTES });
    const hold = cat().commands.find((c) => c.name === 'hold')!;
    expect(hold.fields[0]).toMatchObject({ name: 'ms', range: [0, EPAPER_HOLD_MAX_MS] });
    expect(Object.keys(DisplayRefreshMode)).toEqual([...EPAPER_REFRESH_MODES]);
    const defaults = Object.fromEntries(cat().config.filter((c) => c.name in EPAPER_CONFIG_DEFAULTS).map((c) => [c.name, c.default]));
    expect(defaults).toEqual(EPAPER_CONFIG_DEFAULTS);
    // A full bitmap of 1,200 B (400 x 24) fits one BULK frame.
    const args = { x: 0, y: 0, w: 400, h: 24, data: 'ff'.repeat(EPAPER_BITMAP_MAX_BYTES), color: 0xffffff, bg: 0 };
    const enc = encodeMember('fr.display', 'args', 'bitmap', { ...args, data: Buffer.from(args.data, 'hex') });
    expect(enc.ok).toBe(true);
    expect(enc.ok ? enc.value.length : Infinity).toBeLessThan(1440);
    expect(monoFrameBytes(400, 300)).toBe(15_000);
    expect(monoFrameBytes(300, 400)).toBe(15_200);
  });
});

describe('EPAPER-1 ops (design epaper-e1 D9)', () => {
  it('adds four device ops at the end, on `fr display image|html|text|refresh`, and moves REGISTRY_HASH', () => {
    expect(OPS).toHaveLength(136);
    expect(OPS.slice(-4).map((o) => o.name)).toEqual(NAMES);
    expect(PAPER_OPS.map((o) => o.name)).toEqual(NAMES);
    expect(findOp('display_image')).toMatchObject({ target: 'device', kind: 'command', tier: 'mutate', files: { in: ['file'] }, cli: { path: ['display', 'image'], positional: ['device', 'file'] } });
    expect(findOp('display_html')).toMatchObject({ target: 'device', kind: 'command', tier: 'mutate', cli: { path: ['display', 'html'], positional: ['device'] } });
    expect(findOp('display_text')).toMatchObject({ target: 'device', kind: 'command', tier: 'mutate', cli: { path: ['display', 'text'], positional: ['device', 'text'] } });
    expect(findOp('display_refresh')).toMatchObject({ target: 'device', kind: 'command', tier: 'mutate', cli: { path: ['display', 'refresh'], positional: ['device'] } });
    for (const n of NAMES) {
      expect(findOp(n)!.summary.length, n).toBeLessThan(1000);
    }
    // EPAPER-1's own pins, before FACE-1 renamed the clock ops (protocol-face-f1.test.ts pins the current ones).
    expect(registryInputsHashOf(beforeRtc(OPS) as readonly OpDef[])).toBe('daf7db1a4752');
    expect(registryHashOf(beforeRtc(OPS) as readonly OpDef[])).toBe('5f28136596ac');
    expect(REGISTRY_HASH).not.toBe('5f28136596ac');
  });

  it('checks the inputs', () => {
    const image = findOp('display_image')!.input;
    expect(image.parse({ device: 'paper-c6', file: '/tmp/a.png' })).toEqual({
      device: 'paper-c6',
      file: '/tmp/a.png',
      fit: 'contain',
      dither: 'none',
      threshold: 128,
      invert: false,
      mode: 'auto',
      timeout_s: 30,
      inline: false,
    });
    expect(image.parse({ device: 'paper-c6', png_base64: 'iVBO', fit: 'none', x: -10, y: 20, dither: 'diffusion', mode: 'full' })).toMatchObject({ fit: 'none', x: -10, dither: 'diffusion', mode: 'full' });
    for (const bad of [{ fit: 'tile' }, { dither: 'random' }, { threshold: 0 }, { threshold: 256 }, { mode: 'slow' }, { timeout_s: 0 }]) {
      expect(image.safeParse({ device: 'paper-c6', file: '/a.png', ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(DISPLAY_FITS).toEqual(['contain', 'cover', 'stretch', 'none']);
    expect(DISPLAY_DITHERS).toEqual(['none', 'ordered', 'diffusion']);
    const html = findOp('display_html')!.input;
    expect(html.parse({ device: 'paper-c6', html: '<p>hi</p>' })).toMatchObject({ wait_ms: 300, fit: 'contain' });
    expect(html.safeParse({ device: 'paper-c6', url: 'not a url' }).success).toBe(false);
    const text = findOp('display_text')!.input;
    expect(text.parse({ device: 'paper-c6', text: 'Fractonica' })).toMatchObject({ size_px: 48, font: 'Georgia, serif', align: 'center' });
    expect(text.safeParse({ device: 'paper-c6', text: '' }).success).toBe(false);
    expect(text.safeParse({ device: 'paper-c6', text: 'x', size_px: 301 }).success).toBe(false);
    const refresh = findOp('display_refresh')!.input;
    expect(refresh.parse({ device: 'paper-c6' })).toEqual({ device: 'paper-c6', mode: 'auto', timeout_s: 15 });
    expect(refresh.parse({ device: 'paper-c6', instance: 'paper', mode: 'fast' })).toMatchObject({ mode: 'fast' });
  });
});
