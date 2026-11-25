// EPAPER-1 on the hub (design epaper-e1 D9, D11): the fake e-paper board's policy (tools/fake-epaper.ts) on a manual
// clock, then display_image, display_refresh, display_html and display_text end to end against it: the first picture
// whole and full, a change as its rectangles and a partial, the same picture nothing, the hub's copy dropped when the
// node's shown_crc says the panel shows something else, a failed refresh, and Chrome refused or used.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { EPAPER_VENDOR_MS } from '@fractonica/protocol';
import { STATUS } from '@fractonica/protocol/gen';

import { EpaperSim, PAPER_CONFIG, PAPER_TRAITS, type PaperConfig, startFakePaper } from '../../../tools/fake-epaper.ts';
import type { HubContext } from '../src/context.ts';
import { findChrome } from '../src/display/chrome.ts';
import { resolvePanel } from '../src/display/render.ts';
import { framebufferToPng } from '../src/display/png.ts';
import { monoToPng } from '../src/display/raster.ts';
import { lastSent } from '../src/display/show.ts';
import { HANDLERS } from '../src/ops.ts';
import { sendCommandTo } from '../src/router/ops.ts';
import { netRig, type NetRig, waitForEvent } from './fake-node.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function env(name: string, value: string | undefined): void {
  const prev = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  cleanups.push(() => {
    if (prev === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = prev;
    }
  });
}

// ---- the fake's policy on a manual clock ----------------------------------------------------------------------------

function sim(config: Partial<PaperConfig> = {}) {
  let t = 1000;
  const events: Record<string, unknown>[] = [];
  const states: [string, number][] = [];
  const s = new EpaperSim({ now: () => t, config, out: { state: (n, v) => states.push([n, v]), event: (_n, f) => events.push(f) } });
  const run = (ms: number) => {
    for (const end = t + ms; t < end; t += 5) {
      s.tick();
    }
    s.tick();
  };
  return { s, events, states, run, now: () => t };
}

describe('EpaperSim (the fake e-paper panel)', () => {
  it('settles, refreshes full while the glass is unknown, then partial, then cleans after full_every', () => {
    const b = sim({ full_every: 5, clean: 'full' }); // the capability's defaults (c6e-paper's own are 60 and fast)
    expect(b.s.command('fill_rect', { x: 10, y: 10, w: 20, h: 5, color: 0 }).status).toBe(STATUS.OK);
    b.run(50);
    expect(b.s.running).toBeNull(); // settle_ms 60
    b.run(20);
    expect(b.s.running?.mode).toBe('full');
    b.run(EPAPER_VENDOR_MS.full);
    expect(b.events.at(-1)).toMatchObject({ mode: 'full', ok: true, partials: 0, w: 400, h: 300 });
    expect(b.s.shownCrc).not.toBe(0);
    for (let i = 1; i <= 5; i++) {
      b.s.command('fill_rect', { x: 40 * i, y: 100, w: 3, h: 3, color: 0 });
      b.run(100 + EPAPER_VENDOR_MS.partial);
      expect(b.events.at(-1)).toMatchObject({ mode: 'partial', ok: true, partials: i });
    }
    b.s.command('fill_rect', { x: 300, y: 200, w: 3, h: 3, color: 0 });
    b.run(100 + EPAPER_VENDOR_MS.full);
    expect(b.events.at(-1)).toMatchObject({ mode: 'full', partials: 0 });
    expect(b.states.filter(([n]) => n === 'partials').map(([, v]) => v)).toEqual([1, 2, 3, 4, 5, 0]);
  });

  it('holds, refreshes once on refresh, does nothing for nothing, and fails a stuck refresh', () => {
    const b = sim();
    b.s.command('text', { x: 0, y: 0, text: 'a', size: 1, color: 0, bg: 0xffffff });
    b.run(100 + EPAPER_VENDOR_MS.full);
    const n = b.events.length;
    b.s.command('hold', { ms: 5000 });
    b.s.command('fill_rect', { x: 0, y: 50, w: 8, h: 8, color: 0 });
    b.run(1000);
    expect(b.events).toHaveLength(n);
    expect(b.s.command('refresh', { mode: 'auto' })).toEqual({ status: STATUS.OK, fields: { mode: 'partial', changed: true } });
    b.run(EPAPER_VENDOR_MS.partial + 20);
    expect(b.events).toHaveLength(n + 1);
    expect(b.s.command('refresh', { mode: 'partial' })).toEqual({ status: STATUS.OK, fields: { mode: 'partial', changed: false } });
    b.run(1000);
    expect(b.events).toHaveLength(n + 1);
    b.s.failNext();
    b.s.command('refresh', { mode: 'fast' });
    b.run(5000);
    expect(b.events.at(-1)).toMatchObject({ mode: 'fast', ok: false, crc: 0 });
    expect(b.s.glassKnown).toBe(false);
  });

  it("draws text with the firmware's 5 x 7 glyphs and refuses what the node refuses", () => {
    const b = sim();
    b.s.command('text', { x: 0, y: 0, text: '!', size: 1, color: 0, bg: 0xffffff });
    // '!' is column 2 = 0x5F: rows 0-4 and 6 inked, row 5 not.
    const ink = (x: number, y: number) => !b.s.frame.get(x, y);
    expect([0, 1, 2, 3, 4, 5, 6].map((y) => ink(2, y))).toEqual([true, true, true, true, true, false, true]);
    expect(ink(0, 0)).toBe(false);
    expect(b.s.command('bitmap', { x: 0, y: 0, w: 9, h: 1, data: new Uint8Array(1) }).status).toBe(STATUS.INVALID_ARGS);
    expect(b.s.command('ui_load', {}).status).toBe(STATUS.UNSUPPORTED);
    expect(PAPER_TRAITS).toMatchObject({ width: 400, height: 300, epaper: true });
  });
});

// ---- the ops against the fake board ------------------------------------------------------------------------------

const FW = '5a5a5a5a00000001';

/** The fake board online under a private hub, its build's manifest in the artifact store (the panel's traits). */
async function paperRig(): Promise<{ r: NetRig; hub: HubContext; fake: Awaited<ReturnType<typeof startFakePaper>> }> {
  const home = tmp('fr-home-');
  env('FR_HOME', home);
  const r = await netRig();
  cleanups.push(() => r.close());
  const mac = '02cafe0000e1';
  r.registry.add({ device_id: mac, addr: 0x00e1, alias: 'paper-c6', provisioned: true, net: 0 });
  const manifest = {
    schema: 'fractonica.artifact/1',
    build_id: `node/c6e-paper/debug/${FW.slice(0, 12)}`,
    app: 'node',
    profile: 'c6e-paper',
    build_type: 'debug',
    board: 'esp32c6-supermini',
    target: 'esp32c6',
    chip_id: 13,
    part_profile: 'fr-4mb-v1',
    version: 'v1',
    source_dir: '/src',
    git: { sha: 'abc', dirty: false },
    idf: { version: 'v6.1', commit: 'def' },
    fw_id: `${FW}${'0'.repeat(48)}`,
    elf_sha256: '00',
    size: 1,
    built_at: '2026-11-24T12:00:00Z',
    flash: { mode: 'dio', freq: '80m', size: '4MB', files: [] },
    partitions: [],
    caps: [{ name: 'paper', port: 3, cap: 'fr.display', cap_id: 3, version: '1.3', driver: 'ssd1683_spi', config: PAPER_CONFIG, traits: PAPER_TRAITS }],
  };
  const path = join(r.dir, 'paper-manifest.json');
  writeFileSync(path, JSON.stringify(manifest));
  r.db
    .prepare('INSERT INTO artifacts (build_id, source_dir, profile, build_type, fw_id, built_at, manifest_path, fault) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(manifest.build_id, '/src', 'c6e-paper', 'debug', manifest.fw_id, manifest.built_at, path, null);
  const online = waitForEvent(r.events, (e) => e.type === 'device.online' && e.device === mac);
  const fake = await startFakePaper({ mac, addr: 0x00e1, net: 0, alias: 'paper-c6', aliasRev: 0, epoch: 1, fwPrefix: FW, hub: r.ports });
  cleanups.push(() => fake.stop());
  await online;
  return { r, hub: r.hub, fake };
}

/** A 400 x 300 PNG: white with a black rectangle at (x, y, w, h). */
function picture(x: number, y: number, w: number, h: number): string {
  const grey = new Uint8Array(400 * 300 * 2).fill(0xff); // rgb565 white, little-endian
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      grey[(yy * 400 + xx) * 2] = 0;
      grey[(yy * 400 + xx) * 2 + 1] = 0;
    }
  }
  return Buffer.from(framebufferToPng(grey, 400, 300, 'rgb565')).toString('base64');
}

const show = (hub: HubContext, png: string, extra: Record<string, unknown> = {}) =>
  HANDLERS.display_image(
    { device: 'paper-c6', png_base64: png, fit: 'contain', dither: 'none', threshold: 128, invert: false, mode: 'auto', timeout_s: 20, inline: false, ...extra },
    hub,
  ) as Promise<Record<string, unknown>>;

describe('display_image and display_refresh against the fake paper-c6', () => {
  it('sends the whole first picture (a full refresh), then only what changed (a partial), then nothing', async () => {
    const { hub, fake } = await paperRig();
    const first = await show(hub, picture(100, 100, 50, 40));
    expect(first).toMatchObject({ alias: 'paper-c6', instance: 'paper', width: 400, height: 300, sent: 'full', mode: 'full', ok: true });
    expect(first.bytes).toBe(15_000);
    expect(fake.sim.shown.bytes).toEqual(fake.sim.frame.bytes);
    expect(fake.sim.frame.get(120, 120)).toBe(false); // ink
    expect(fake.sim.frame.get(10, 10)).toBe(true);
    expect(lastSent(hub, '02cafe0000e1', 'paper')?.crc).toBe(first.crc);

    const second = await show(hub, picture(100, 100, 50, 41));
    expect(second).toMatchObject({ sent: 'diff', mode: 'partial', ok: true, partials: 1 });
    expect(second.bytes as number).toBeLessThan(40);
    expect(fake.sim.frame.get(120, 140)).toBe(false);

    const third = await show(hub, picture(100, 100, 50, 41));
    expect(third).toMatchObject({ sent: 'none', mode: 'none', ok: true, regions: 0 });
  });

  it('sends everything again once the panel shows something else, and reports a failed refresh', async () => {
    const { r, hub, fake } = await paperRig();
    await show(hub, picture(10, 10, 20, 20));
    const dev = r.registry.get('02cafe0000e1')!;
    // Someone draws on the node and refreshes: its shown_crc moves.
    const crcMoved = waitForEvent(r.events, (e) => e.type === 'paper.shown_crc', 3000);
    expect(await sendCommandTo(hub, dev, 'paper', 'fill_rect', { x: 0, y: 0, w: 40, h: 40, color: 0 }, { ack: 'result', timeoutMs: 2000 })).toMatchObject({ status: 'ok' });
    await HANDLERS.display_refresh({ device: 'paper-c6', mode: 'auto', timeout_s: 10 }, hub);
    await crcMoved;
    const again = await show(hub, picture(10, 10, 20, 20));
    // The hub sends the whole frame again; the node still moves only what differs from its glass.
    expect(again).toMatchObject({ sent: 'full', ok: true, mode: 'partial', bytes: 15_000 });

    fake.sim.failNext();
    const failed = (await HANDLERS.display_refresh({ device: 'paper-c6', mode: 'full', timeout_s: 15 }, hub)) as Record<string, unknown>;
    expect(failed).toMatchObject({ mode: 'full', ok: false, crc: 0 });
  }, 30_000);

  it('display_html and display_text refuse without Chrome; images other than PNG too', async () => {
    const { hub } = await paperRig();
    env('CHROME', 'none');
    await expect(HANDLERS.display_html({ device: 'paper-c6', html: '<p>hi</p>', fit: 'contain', dither: 'none', threshold: 128, invert: false, mode: 'auto', timeout_s: 10, inline: false, wait_ms: 0 }, hub)).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
    });
    await expect(
      HANDLERS.display_text({ device: 'paper-c6', text: 'hi', size_px: 48, font: 'serif', align: 'center', fit: 'contain', dither: 'none', threshold: 128, invert: false, mode: 'auto', timeout_s: 10, inline: false, wait_ms: 0 }, hub),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    await expect(show(hub, Buffer.from('GIF89a....').toString('base64'))).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    await expect(show(hub, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64'))).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });

  it.skipIf(!findChrome())('display_text draws with Chrome at the panel size', async () => {
    const { hub, fake } = await paperRig();
    const out = (await HANDLERS.display_text(
      { device: 'paper-c6', text: 'Fractonica', size_px: 64, font: 'Georgia, serif', align: 'center', fit: 'contain', dither: 'none', threshold: 128, invert: false, mode: 'auto', timeout_s: 30, inline: true, wait_ms: 0 },
      hub,
    )) as Record<string, unknown>;
    expect(out).toMatchObject({ sent: 'full', ok: true, width: 400, height: 300 });
    // Ink near the middle, paper at the corners.
    let ink = 0;
    for (let y = 120; y < 180; y++) {
      for (let x = 50; x < 350; x++) {
        ink += fake.sim.frame.get(x, y) ? 0 : 1;
      }
    }
    expect(ink).toBeGreaterThan(500);
    expect(fake.sim.frame.get(2, 2)).toBe(true);
    expect(Buffer.from(String(out.png_base64), 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(monoToPng).toBeTypeOf('function');
  }, 60_000);
});

describe('display_render for c6e-paper (design epaper-e1 D12)', () => {
  it('resolves the profile\'s panel as a 400 x 300 e-paper, so the renderer draws it through EpaperBackend', async () => {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const panel = await resolvePanel(repo, 'c6e-paper', undefined);
    expect(panel).toMatchObject({ name: 'paper', width: 400, height: 300, format: 'mono1', ui: false, epaper: true, rotation: 0 });
  });
});
