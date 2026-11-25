// ssd1683_spi and the e-paper backend in the generated glue (design epaper-e1 D5-D7): the driver manifest, c6e-paper
// against its committed slots.lock (the pins, the traits, EpaperBackend with static frames sized for the panel after
// rotation, a third only under test hooks, the input slot and SPI host budgets), a rotated panel, and refusals.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { type FirmwareResult, generateFirmware, loadDriver } from '../src/board.ts';
import { formatIssue, loadModel, SchemaError } from '../src/model.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MODEL = loadModel(ROOT);

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

/** A scratch checkout with the inputs `fr gen firmware` reads and one profile on a C6 Super Mini. */
function checkout(paper: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fr-epaper-'));
  temps.push(dir);
  cpSync(join(ROOT, 'hardware'), join(dir, 'hardware'), { recursive: true });
  cpSync(join(ROOT, 'firmware', 'partitions'), join(dir, 'firmware', 'partitions'), { recursive: true });
  for (const app of ['node', 'gateway']) {
    cpSync(join(ROOT, 'firmware', 'apps', app, 'CMakeLists.txt'), join(dir, 'firmware', 'apps', app, 'CMakeLists.txt'));
  }
  mkdirSync(join(dir, 'firmware', 'profiles'), { recursive: true });
  writeFileSync(
    join(dir, 'firmware', 'profiles', 'paper-test.profile.yaml'),
    ['profile: paper-test', 'board: esp32c6-supermini', 'app: node', 'net: { link_profile: default }', 'caps:', `  paper:  ${paper}`, ''].join('\n'),
  );
  return dir;
}

function gen(dir: string, profile = 'paper-test'): FirmwareResult {
  try {
    return generateFirmware({ sourceDir: dir, profile, outDir: join(dir, 'build', 'fr_gen'), write: false, model: MODEL });
  } catch (e) {
    if (e instanceof SchemaError) {
      throw new Error(e.issues.map(formatIssue).join('\n'));
    }
    throw e;
  }
}

function file(r: FirmwareResult, path: string): string {
  const f = r.files.find((x) => x.path === path);
  if (!f) {
    throw new Error(`no ${path} in ${r.files.map((x) => x.path).join(', ')}`);
  }
  return f.content;
}

const BIND = '{ cap: fr.display, driver: ssd1683_spi, bind: { sclk: gpio.19, mosi: gpio.18, cs: gpio.14, dc: gpio.3, rst: gpio.2, busy: gpio.1 }';

describe('ssd1683_spi (design epaper-e1 D5)', () => {
  it('is an hal.Epaper on bare pins, 400 x 300 by default, with the epaper trait and an input slot for BUSY', () => {
    const d = loadDriver(ROOT, 'ssd1683_spi');
    expect(d).toMatchObject({ implements: 'hal.Epaper', class: 'fr::drv::Ssd1683Spi', binds: 'gpio', traits: { color: 'mono1', ui: false, epaper: true } });
    expect(d.resources).toEqual({ gpio: 6, spi_host: 1, input_slot: 1 });
    expect(Object.keys(d.config ?? {})).toEqual(['sclk', 'mosi', 'cs', 'dc', 'rst', 'busy', 'width', 'height', 'spi_mhz', 'fast_ms']);
    expect(d.config?.spi_mhz).toMatchObject({ default: 10, range: [1, 20] });
  });
});

describe('c6e-paper (design epaper-e1 D7)', () => {
  it('generates against its committed slots.lock: the pins, the traits, EpaperBackend with static frames', () => {
    const r = gen(ROOT, 'c6e-paper');
    const paper = r.manifest.caps.find((c) => c.name === 'paper')!;
    expect(paper).toMatchObject({ port: 3, cap: 'fr.display', driver: 'ssd1683_spi', config: { full_every: 60, clean: 'fast', burst_ms: 1000, boot_clear: false } });
    expect(paper.traits).toEqual({ width: 400, height: 300, color: 'mono1', ui: false, touch: false, round: false, epaper: true });
    expect(r.instances.paper).toMatchObject({ pins: [19, 18, 14, 3, 2, 1], driverConfig: { sclk: 19, mosi: 18, cs: 14, dc: 3, rst: 2, busy: 1, width: 400, height: 300, spi_mhz: 10, fast_ms: 1500 } });
    const cpp = file(r, 'fr_board/fr_board.cpp');
    expect(cpp).toContain('#include "fr/display/epaper_backend.hpp"');
    expect(cpp).toContain(
      [
        'fr::drv::Ssd1683Spi driver{kDriverConfig};',
        'alignas(4) uint8_t frame_buf[15000];',
        'alignas(4) uint8_t shown_buf[15000];',
        '#if FR_TEST_HOOKS',
        'alignas(4) uint8_t frozen_buf[15000];',
        'fr::display::EpaperBackend backend{driver, {frame_buf, shown_buf, frozen_buf}};',
        '#else',
        'fr::display::EpaperBackend backend{driver, {frame_buf, shown_buf, {}}};',
        '#endif',
        'fr::DisplayService service{driver, backend, kConfig};',
      ].join('\n'),
    );
    expect(cpp).not.toContain('MonoBackend');
    expect(file(r, 'fr_board/include/fr/board.hpp')).toContain('    {3, "paper", 400, 300, 0, false, false, 0, true},');
    expect(file(r, 'fr_board/CMakeLists.txt')).toMatch(/PRIV_REQUIRES .*ssd1683_spi/);
    expect(file(r, 'fr_board/CMakeLists.txt')).not.toMatch(/fr_ui/);
    expect(readFileSync(join(ROOT, 'firmware', 'profiles', 'c6e-paper.slots.lock'), 'utf8')).toMatch(/^paper: 3$/m);
  });

  it('a panel turned a quarter: frames for 300 x 400 (38-byte rows)', () => {
    const r = gen(checkout(`${BIND}, config: { rotation: r90 } }`));
    expect(r.manifest.caps.find((c) => c.name === 'paper')!.traits).toMatchObject({ width: 300, height: 400, epaper: true });
    expect(file(r, 'fr_board/fr_board.cpp')).toContain('alignas(4) uint8_t frame_buf[15200];');
  });

  it('refuses a strapping pin, a pin used twice and a board without an SPI host to spare', () => {
    expect(() => gen(checkout('{ cap: fr.display, driver: ssd1683_spi, bind: { sclk: gpio.19, mosi: gpio.18, cs: gpio.14, dc: gpio.3, rst: gpio.2, busy: gpio.9 } }'))).toThrow(/9/);
    expect(() => gen(checkout('{ cap: fr.display, driver: ssd1683_spi, bind: { sclk: gpio.19, mosi: gpio.18, cs: gpio.14, dc: gpio.3, rst: gpio.3, busy: gpio.1 } }'))).toThrow(/3/);
  });
});
