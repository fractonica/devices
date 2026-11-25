// fr.face in the generated glue (design face-f1 D5, D8, D9, D16, D18, D19): c6e-paper's face with its peers (the
// three keys and the buzzer among them), power save's pins and LP keep buffer, the clock's components on the build
// path; the face's refusals (one key named twice among them) and the warning when its pins cannot wake the chip;
// button_pin on a bare pin.

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const PAPER = '{ cap: fr.display, driver: ssd1683_spi, bind: { sclk: gpio.19, mosi: gpio.18, cs: gpio.14, dc: gpio.3, rst: gpio.2, busy: gpio.1 } }';

/** A scratch checkout with one profile on a C6 Super Mini: the panel plus the given instances. */
function checkout(caps: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'fr-face-'));
  temps.push(dir);
  cpSync(join(ROOT, 'hardware'), join(dir, 'hardware'), { recursive: true });
  cpSync(join(ROOT, 'firmware', 'partitions'), join(dir, 'firmware', 'partitions'), { recursive: true });
  for (const app of ['node', 'gateway']) {
    cpSync(join(ROOT, 'firmware', 'apps', app, 'CMakeLists.txt'), join(dir, 'firmware', 'apps', app, 'CMakeLists.txt'));
  }
  mkdirSync(join(dir, 'firmware', 'profiles'), { recursive: true });
  writeFileSync(
    join(dir, 'firmware', 'profiles', 'face-test.profile.yaml'),
    ['profile: face-test', 'board: esp32c6-supermini', 'app: node', 'net: { link_profile: default }', 'caps:', `  paper: ${PAPER}`, ...Object.entries(caps).map(([k, v]) => `  ${k}: ${v}`), ''].join('\n'),
  );
  return dir;
}

function gen(dir: string, profile = 'face-test'): FirmwareResult {
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
    throw new Error(`no ${path}`);
  }
  return f.content;
}

describe('fractonica_face and button_pin (design face-f1 D5, D16)', () => {
  it('fractonica_face binds nothing and brings the clock components; button_pin is button_gpio on a bare pin', () => {
    expect(loadDriver(ROOT, 'fractonica_face')).toMatchObject({ implements: 'hal.Face', binds: 'none', component_dirs: ['clock/components/fractonica', 'clock/components/fractonica_ui'] });
    expect(loadDriver(ROOT, 'button_pin')).toMatchObject({ implements: 'hal.ButtonSource', class: 'fr::drv::ButtonGpio', binds: 'gpio', uses: ['button_gpio'] });
  });
});

describe('c6e-paper with a face (design face-f1 D9)', () => {
  it('binds the panel, the key and the RTC, with power save pins and LP memory for the glass', () => {
    const r = gen(ROOT, 'c6e-paper');
    const face = r.manifest.caps.find((c) => c.name === 'face')!;
    expect(face).toMatchObject({
      port: 6,
      cap: 'fr.face',
      driver: 'fractonica_face',
      config: { display: 'paper', button: 'key', rtc: 'rtc', left: 'left', right: 'right', buzzer: 'buzzer', step: 'preon', chime: 'preon', clicks: true },
    });
    // As the owner wired them (D18): the centre key on GPIO21, left on GPIO22, right on GPIO4, the one key that wakes
    // the chip.
    expect([r.instances.key, r.instances.left, r.instances.right].map((i) => i?.driverConfig.gpio)).toEqual([21, 22, 4]);
    expect(r.manifest.caps.filter((c) => c.port > 6).map((c) => [c.name, c.port, c.driver])).toEqual([
      ['left', 7, 'button_pin'],
      ['right', 8, 'button_pin'],
      ['buzzer', 9, 'ledc_buzzer'],
    ]);
    expect(face.traits).toEqual({ width: 400, height: 300, can_sleep: true });
    const cpp = file(r, 'fr_board/fr_board.cpp');
    expect(cpp).toContain('#include "esp_attr.h"');
    expect(cpp).toContain('fr::FaceService service{driver, settings, kConfig};');
    expect(cpp).toContain('alignas(8) RTC_NOINIT_ATTR uint8_t keep_buf[sizeof(fr::FaceService::KeepHeader) + 15000];');
    expect(cpp).toContain(
      [
        '    inst_face::service.bind_display(inst_paper::service);',
        '    inst_face::service.bind_button(inst_key::service);',
        '    inst_face::service.bind_rtc(inst_rtc::service);',
        '    inst_face::service.bind_left(inst_left::service);',
        '    inst_face::service.bind_right(inst_right::service);',
        '    inst_face::service.bind_buzzer(inst_buzzer::service);',
        '    inst_face::service.bind_sleep(fr::core::sleep(), {.wake_low = 0x30ull, .hold = 0x400cull, .keys = 0x10ull});',
        '    inst_face::service.bind_keep(inst_face::keep_buf);',
      ].join('\n'),
    );
    // The face is initialised after its panel, key and RTC (port order).
    expect(cpp.indexOf('s_init[5] = inst_face::service.init(core);')).toBeGreaterThan(cpp.indexOf('s_init[3] = inst_rtc::service.init(core);'));
    expect(r.instances.rtc).toMatchObject({ driverConfig: { sda: 6, scl: 7, khz: 100, sqw: 5 } });
    const cmake = file(r, 'components.cmake');
    expect(cmake).toContain('/clock/components/fractonica"');
    expect(cmake).toContain('/clock/components/fractonica_ui"');
    expect(cmake).toContain('/hardware/drivers/button_gpio"');  // button_pin's code
    expect(file(r, 'fr_board/CMakeLists.txt')).toMatch(/PRIV_REQUIRES .*fractonica_face/);
  });
});

describe('a face that cannot be (design face-f1 D8)', () => {
  it('refuses a face without a display, or on something that is not a 400 x 300 e-paper panel', () => {
    expect(() => gen(checkout({ face: '{ cap: fr.face, driver: fractonica_face }' }))).toThrow(/display must name an fr.display instance/);
    expect(() => gen(checkout({ key: '{ cap: fr.button, driver: button_pin, bind: gpio.0 }', face: '{ cap: fr.face, driver: fractonica_face, config: { display: key } }' }))).toThrow(/'key' is an fr.button instance/);
    expect(() => gen(checkout({ face: '{ cap: fr.face, driver: fractonica_face, config: { display: paper } }' })).manifest).not.toThrow();
  });

  it('refuses one button as two of its keys, and a buzzer that is not an fr.buzzer (D18, D19)', () => {
    const key = '{ cap: fr.button, driver: button_pin, bind: gpio.4 }';
    expect(() => gen(checkout({ key, face: '{ cap: fr.face, driver: fractonica_face, config: { display: paper, button: key, right: key } }' }))).toThrow(/'key' is already the face's button/);
    expect(() => gen(checkout({ key, face: '{ cap: fr.face, driver: fractonica_face, config: { display: paper, buzzer: key } }' }))).toThrow(/'key' is an fr.button instance; buzzer names an fr.buzzer instance/);
  });

  it('wakes on any of its keys that is a wake pin, and needs a centre key to leave (D18)', () => {
    const rtc = '{ cap: fr.rtc, driver: ds3231_i2c, bind: { sda: gpio.6, scl: gpio.7, sqw: gpio.5 } }';
    const side = gen(
      checkout({
        rtc,
        key: '{ cap: fr.button, driver: button_pin, bind: gpio.22 }',
        right: '{ cap: fr.button, driver: button_pin, bind: gpio.0 }',
        face: '{ cap: fr.face, driver: fractonica_face, config: { display: paper, button: key, right: right, rtc: rtc } }',
      }),
    );
    expect(side.manifest.caps.find((c) => c.name === 'face')!.traits).toMatchObject({ can_sleep: true });
    expect(file(side, 'fr_board/fr_board.cpp')).toContain('{.wake_low = 0x21ull, .hold = 0x400cull, .keys = 0x1ull}');
    const noCentre = gen(
      checkout({
        rtc,
        right: '{ cap: fr.button, driver: button_pin, bind: gpio.0 }',
        face: '{ cap: fr.face, driver: fractonica_face, config: { display: paper, right: right, rtc: rtc } }',
      }),
    );
    expect(noCentre.manifest.caps.find((c) => c.name === 'face')!.traits).toMatchObject({ can_sleep: false });
  });

  it('has no power save when none of its keys or its RTC alarm is a wake pin, and says so', () => {
    const r = gen(
      checkout({
        rtc: '{ cap: fr.rtc, driver: ds3231_i2c, bind: { sda: gpio.6, scl: gpio.7, sqw: gpio.5 } }',
        key: '{ cap: fr.button, driver: button_pin, bind: gpio.21 }',
        face: '{ cap: fr.face, driver: fractonica_face, config: { display: paper, button: key, rtc: rtc } }',
      }),
    );
    expect(r.manifest.caps.find((c) => c.name === 'face')!.traits).toMatchObject({ can_sleep: false });
    expect(r.warnings.join('\n')).toMatch(/face: no power save: one of its keys \(GPIO 21\)/);
    expect(file(r, 'fr_board/fr_board.cpp')).not.toContain('bind_sleep');
    expect(file(r, 'fr_board/fr_board.cpp')).not.toContain('keep_buf');
  });
});
