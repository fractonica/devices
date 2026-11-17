// The Devices and Device pages' logic (src/state/device-controls.ts, device-units.ts, device-link.ts): typed controls
// generated from the real catalog, the args a form sends, properties that are their own control, how a number in an
// Earth unit is said in pure mode (a span, a per-Blink rate, light, a bare count) and in Earth mode, and the plain
// facts of a device row. The core is the real one (the Node loader of the same vendored module).

import { beforeAll, describe, expect, it } from 'vitest';

import { CATALOG, type CatalogCapability } from '@fractonica/protocol/gen';
import { type Core, loadCore } from '@fractonica/time';

import {
  argValue,
  buildArgs,
  colourHex,
  controlFor,
  coveredCommands,
  hexColour,
  INT_RANGES,
  initialValue,
  isBlank,
  linkArgs,
  missingFields,
  seedValues,
  wordList,
  numericOf,
  type PropertyLink,
  propertyLink,
} from '../src/state/device-controls.ts';
import {
  byPresenceThenAlias,
  clockState,
  fieldPairs,
  filterDevices,
  flattenJson,
  fleetCountOf,
  hardwareLine,
  heartbeatOf,
  lastInstanceEvent,
  linksText,
  liveOf,
  pureJson,
  recentEvents,
  shortId,
} from '../src/state/device-link.ts';
import { blinkMicros, countText, spanToField, spanToUs, usToRung, earthDuration, fieldWords, fractionOf, impliedUnit, rateText, signalOf, spanText, unitInfo, unitOf, valueText } from '../src/state/device-units.ts';
import { Unit } from '@fractonica/time/browser';

import { pureSafe } from '../src/state/pure-text.ts';
import { HUB_ISSUED, isHubIssued } from '../src/state/hub-issued.ts';

const cap = (name: string): CatalogCapability => CATALOG.capabilities.find((c) => c.name === name)!;
const cmd = (c: CatalogCapability, name: string) => c.commands.find((m) => m.name === name)!;
/** Anything Earth in a pure text: a clock time, an Earth unit, a percent sign, the Earth sign. */
const EARTH = /⊕|\d{1,2}:\d{2}|\b\d+\s?(h|min|s|ms|Hz|m|mV|mg|dBm)\b|%/;

let core: Core;
beforeAll(async () => {
  core = await loadCore();
});

describe('controls from catalog fields', () => {
  it('gives each field type its control', () => {
    const led = cap('fr.led');
    const set = cmd(led, 'set');
    expect(set.fields.map((f) => controlFor(f, led).kind)).toEqual(['toggle', 'slider', 'colour']);
    const blink = cmd(led, 'blink').fields.map((f) => controlFor(f, led));
    expect(blink[0]).toMatchObject({ name: 'on_ms', label: 'lit for', kind: 'slider', min: 10, max: 10_000, unit: 'ms', default: 200, optional: false });
    expect(blink[3]).toMatchObject({ name: 'color', kind: 'colour', optional: true });
    const button = cap('fr.button');
    const gesture = controlFor(cmd(button, 'inject').fields[0]!, button);
    expect(gesture.kind).toBe('select');
    expect(gesture.options?.map((o) => o.label)).toContain('double click');
    const display = cap('fr.display');
    expect(controlFor(cmd(display, 'text').fields.find((f) => f.name === 'text')!, display).kind).toBe('text');
    expect(controlFor(cmd(display, 'text').fields.find((f) => f.name === 'x')!, display).kind).toBe('number');
    expect(controlFor(cmd(display, 'ui_load').fields[0]!, display).kind).toBe('message');
    expect(controlFor(cmd(cap('fr.storage'), 'write').fields.find((f) => f.name === 'data')!, cap('fr.storage')).kind).toBe('bytes');
    expect(controlFor(cmd(cap('fr.haptic'), 'play').fields.find((f) => f.name === 'steps')!, cap('fr.haptic')).kind).toBe('list');
    // a share is a slider even without a range of its own: light, never a typed number
    expect(controlFor(cmd(cap('fr.audio_out'), 'set_volume').fields[0]!, cap('fr.audio_out')).kind).toBe('slider');
    // a wide integer is typed
    expect(controlFor(cmd(cap('fr.scale'), 'calibrate').fields[0]!, cap('fr.scale')).kind).toBe('number');
  });

  it('starts a control at the mirror, then the default, then its rest value', () => {
    const led = cap('fr.led');
    const bright = controlFor(cmd(led, 'set').fields[1]!, led);
    expect(initialValue(bright, 64)).toBe(64);
    expect(initialValue(bright)).toBe('');
    expect(initialValue(controlFor(cmd(led, 'blink').fields[0]!, led))).toBe(200);
    expect(initialValue(controlFor(cmd(led, 'set').fields[2]!, led))).toBe(0xffffff);
  });

  it('checks each value against its type', () => {
    const led = cap('fr.led');
    const onMs = controlFor(cmd(led, 'blink').fields[0]!, led);
    expect(argValue(onMs, '250')).toEqual({ ok: true, value: 250 });
    expect(argValue(onMs, '5')).toEqual({ ok: false, error: 'between 10 and 10000' });
    expect(argValue(onMs, '2.5').ok).toBe(false);
    const bytes = controlFor(cmd(cap('fr.storage'), 'write').fields.find((f) => f.name === 'data')!, cap('fr.storage'));
    expect(argValue(bytes, 'DE AD:be ef')).toEqual({ ok: true, value: 'deadbeef' });
    expect(argValue(bytes, 'abc').ok).toBe(false);
    const steps = controlFor(cmd(cap('fr.haptic'), 'play').fields[0]!, cap('fr.haptic'));
    expect(argValue(steps, '40, 20 40')).toEqual({ ok: true, value: [40, 20, 40] });
    expect(argValue(controlFor(cmd(cap('fr.display'), 'ui_load').fields[0]!, cap('fr.display')), '{"bg":1}')).toEqual({ ok: true, value: { bg: 1 } });
    expect(argValue(controlFor(cmd(led, 'set').fields[2]!, led), '#00ff00')).toEqual({ ok: true, value: 0x00ff00 });
  });

  it('sends required fields always and optional ones only once touched', () => {
    const led = cap('fr.led');
    const specs = cmd(led, 'set').fields.map((f) => controlFor(f, led));
    expect(buildArgs(specs, { on: true, brightness: 10 }, new Set())).toEqual({ ok: true, args: { on: true } });
    expect(buildArgs(specs, { on: true, brightness: 10 }, new Set(['brightness']))).toEqual({ ok: true, args: { on: true, brightness: 10 } });
    const bad = buildArgs(cmd(led, 'blink').fields.map((f) => controlFor(f, led)), { on_ms: 1 }, new Set());
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors.on_ms).toBe('between 10 and 10000');
  });

  it('makes a property its own control when a command sets it, and hides the command it covers', () => {
    const led = cap('fr.led');
    const links = led.properties.map((p) => propertyLink(led, led.commands, p));
    expect(links).toEqual([
      { property: 'on', command: 'set', field: 'on', fill: [] },
      { property: 'brightness', command: 'set', field: 'brightness', fill: ['on'] },
      { property: 'color', command: 'set', field: 'color', fill: ['on'] },
    ]);
    expect([...coveredCommands(led.commands, links as PropertyLink[])]).toEqual(['set']);
    expect(linkArgs(links[1]!, 90, { on: true, brightness: 64 })).toEqual({ brightness: 90, on: true });
    const display = cap('fr.display');
    expect(propertyLink(display, display.commands, display.properties[0]!)).toEqual({ property: 'brightness', command: 'set_brightness', field: 'level', fill: [] });
    const audio = cap('fr.audio_out');
    expect(propertyLink(audio, audio.commands, audio.properties.find((p) => p.name === 'volume')!)?.command).toBe('set_volume');
    // a read-only property has no control
    expect(propertyLink(cap('fr.button'), cap('fr.button').commands, cap('fr.button').properties[0]!)).toBeNull();
  });

  it('writes colours for the well and reads them back', () => {
    expect(colourHex(0xff0000)).toBe(`#${'ff0000'}`);
    expect(colourHex(-5)).toBe(`#${'000000'}`);
    expect(hexColour('#0A0B0C')).toBe(0x0a0b0c);
    expect(hexColour('nope')).toBeNull();
    expect(numericOf(3)).toBe(3);
    expect(numericOf(true)).toBeNull();
  });
});

describe('units in pure and Earth mode', () => {
  it('drops Earth units from field words', () => {
    expect(fieldWords('on_ms')).toBe('on');
    expect(fieldWords('weight_mg')).toBe('weight');
    expect(fieldWords('seconds')).toBe('duration');
    expect(fieldWords('percent')).toBe('charge');
    expect(fieldWords('mv')).toBe('voltage');
    expect(fieldWords('double_click')).toBe('double click');
    expect(fieldWords('ms')).toBe('duration');
    expect(unitOf({ name: 'percent' })).toBe('%');
    expect(unitOf({ name: 'mv', unit: 'mV' })).toBe('mV');
  });

  it('says a time as a span, a rate per Blink, a share only as light, a physical value as a bare count', () => {
    const now = core.frc.now();
    expect(spanText(core, 1_000_000, 2, now)).toBe(core.frc.formatSpan(core.cat.spanBetween(now - 1_000_000n, now), 2));
    expect(spanText(core, 0)).toBe('0ν');
    const ms = valueText(core, 200, 'ms');
    expect(ms.text).toMatch(/ν$/);
    expect(ms.earth).toBe('200 ms');
    const hz = valueText(core, 100, 'Hz');
    expect(hz.text).toMatch(/pB|per/);
    expect(hz.earth).toBe('100 Hz');
    expect(valueText(core, 60, '%')).toEqual({ text: '', earth: '60 %' });
    expect(valueText(core, 3712, 'mV')).toEqual({ text: '3\u202f712', earth: '3\u202f712 mV' });
    expect(valueText(core, 231, 'degC/10')).toEqual({ text: '23.1', earth: '23.1 °C' });
    expect(valueText(core, 64, undefined)).toEqual({ text: '64', earth: null });
    expect(valueText(core, 72, 'px')).toEqual({ text: '72 px', earth: null });
    for (const [v, u] of [[200, 'ms'], [3, 's'], [100, 'Hz'], [60, '%'], [3712, 'mV'], [-72, 'dBm'], [152340, 'mg']] as const) {
      expect(valueText(core, v, u).text).not.toMatch(EARTH);
    }
    expect(unitInfo('furlongs')).toEqual({ cls: 'earth', symbol: 'furlongs' });
  });

  it('reads a Blink and rates from the core', () => {
    const us = blinkMicros(core);
    expect(us).toBeGreaterThan(100_000);
    expect(us).toBeLessThan(1_000_000);
    // one cycle a Blink
    expect(rateText(core, 1e6 / us)).toMatch(/^1(\.0+)? pB$|^1 per/);
  });

  it('writes a negative rate (a stepper spinning back) as the same words after a minus sign', () => {
    // the core's formatPerBlink takes magnitudes only: a raw negative threw FRC_ERR_ARG on the stepper panel
    for (const hz of [-1600, -800, -1]) {
      expect(rateText(core, hz)).toBe(`−${rateText(core, -hz)}`);
    }
    expect(rateText(core, 0)).toBe(rateText(core, -0));
    const back = valueText(core, -1600, 'Hz');
    expect(back.text.startsWith('−')).toBe(true);
    expect(pureSafe(back.text)).toBe(true);
  });

  it('writes Earth durations under a second in ms', () => {
    expect(earthDuration(core, 1521.5)).toBe('1.5 ms');
    expect(earthDuration(core, -3000)).toBe('−3 ms');
    expect(earthDuration(core, 61_000_000)).toBe(core.frc.formatDuration(61_000_000n, 2));
    expect(countText(core, 58500)).toBe('58\u202f500');
    expect(countText(null, 1.5)).toBe('1.5');
  });

  it('says signal as a level and a word, never dBm', () => {
    expect(signalOf(-50)).toEqual({ level: 4, word: 'strong' });
    expect(signalOf(-72)).toEqual({ level: 2, word: 'fair' });
    expect(signalOf(-90)).toEqual({ level: 0, word: 'faint' });
    expect(signalOf(0)).toBeNull();
    expect(signalOf(null)).toBeNull();
    expect(fractionOf(50, 0, 100)).toBe(0.5);
    expect(fractionOf(500, 0, 100)).toBe(1);
    expect(fractionOf(5, 3, 3)).toBe(0);
  });
});

describe('device rows', () => {
  const dev = (alias: string, presence: string, extra: object = {}) =>
    ({ device_id: `id-${alias}`, alias, presence, profile: 'c6-pad', board: null, chip: 'esp32c6', tags: [], ...extra }) as never;

  it('orders the fleet online first, then by alias, and filters it by words', () => {
    const list = [dev('b', 'offline'), dev('c', 'online'), dev('a', 'online'), dev('d', 'suspect'), dev('e', 'unknown')];
    expect([...list].sort(byPresenceThenAlias).map((d: { alias: string }) => d.alias)).toEqual(['a', 'c', 'd', 'b', 'e']);
    expect(filterDevices(list, 'ON').map((d: { alias: string }) => d.alias)).toEqual(['c', 'a']);
    expect(filterDevices([dev('lab-1', 'online', { tags: ['poc'] }), dev('x', 'online')], 'poc c6').length).toBe(1);
    expect(fleetCountOf(list)).toBe('2 of 5 online');
    expect(fleetCountOf(list, 1)).toBe('1 shown · 2 of 5 online');
  });

  it('reads the row’s link, hardware and heartbeat defensively', () => {
    expect(liveOf(dev('a', 'online', { live: { links: ['tcp'], udp_blocked: false, rssi_ap: -60, uptime_s: 3, fw_id_prefix: null } }))?.rssi_ap).toBe(-60);
    expect(liveOf(dev('a', 'online', { live: null }))).toBeNull();
    expect(hardwareLine({ profile: 'c6-pad', board: 'c6-pad', chip: 'esp32c6' })).toBe('c6-pad · esp32c6');
    expect(hardwareLine({ profile: null, board: null, chip: null })).toBe('');
    expect(shortId('3f2a9c01b2d40011')).toBe('3f2a9c01');
    expect(shortId(null)).toBe('');
    expect(heartbeatOf({ uptime_s: 3, rssi_ap: 'x', tx_fail: 0 })).toEqual({ uptime_s: 3, tx_fail: 0 });
    expect(heartbeatOf(null)).toBeNull();
    expect(linksText(['gateway', 'serial'], 'hall-gw')).toBe('gateway via hall-gw · serial');
  });

  it('states the clock plainly', () => {
    expect(clockState(null)).toBe('none');
    expect(clockState({ offset_us: 0, uncertainty_us: 900, rtt_us: 1800, samples: 2 })).toBe('settling');
    expect(clockState({ offset_us: 0, uncertainty_us: 900, rtt_us: 1800, samples: 8 })).toBe('in-step');
  });

  it('finds an instance’s last event and a device’s recent ones', () => {
    const ring = [
      { device: 'd1', type: 'boot.click', part: 'event' },
      { device: 'd1', type: 'status.on', part: 'state' },
      { device: 'd2', type: 'boot.down', part: 'event' },
      { device: 'd1', type: 'boot.down', part: 'event' },
    ];
    expect(lastInstanceEvent(ring, 'd1', 'boot')?.type).toBe('boot.down');
    expect(lastInstanceEvent(ring, 'd1', 'status')).toBeUndefined();
    expect(recentEvents(ring, 'd1', 2).map((e) => e.type)).toEqual(['boot.down', 'status.on']);
    expect(fieldPairs({ a: 1, b: { c: 2 }, d: 'x', e: null })).toEqual([['a', 1], ['d', 'x'], ['e', null]]);
  });

  it('keeps Gregorian dates out of raw JSON in pure mode, and flattens answers into rows', () => {
    const out = pureJson({ created_at: '2026-10-08T12:00:00.000Z', n: 1, list: ['2026-10-08T12:00:00Z', 'x'], nested: { at: '2026-10-08T14:00:00+02:00' } }, () => 'STAMP');
    expect(out).toEqual({ created_at: 'STAMP', n: 1, list: ['STAMP', 'x'], nested: { at: 'STAMP' } });
    expect(flattenJson({ ok: true, links: { tcp: { up: true } }, list: [1, 2], id: 'x', uptime_ms: 5 })).toEqual([
      ['ok', 'true', 'ok', null],
      ['links · tcp · up', 'true', 'up', null],
      ['list', '[1,2]', 'list', null],
      ['id', 'x', 'id', null],
      ['uptime', '5', 'uptime_ms', 5],
    ]);
  });
});

describe('units an event field implies', () => {
  it('reads them from the type or the name', () => {
    expect(impliedUnit('held_ms', 'duration_ms')).toBe('ms');
    expect(impliedUnit('held')).toBeUndefined();
    expect(impliedUnit('rtt_us')).toBe('us');
    expect(impliedUnit('mv')).toBe('mV');
    expect(impliedUnit('delta_mg')).toBe('mg');
    expect(impliedUnit('count')).toBeUndefined();
    expect(fieldWords('rtt_us')).toBe('rtt');
    expect(valueText(core, 1500, 'us').earth).toBe('1 500 µs');
  });
});

describe('catalog texts in pure mode', () => {
  it('keeps a text that names an Earth unit for Earth mode', () => {
    expect(pureSafe('Momentary push button with debounced edges and gesture recognition.')).toBe(true);
    expect(pureSafe('A sine of freq_hz for ms, made on the node at config sample_hz')).toBe(false);
    expect(pureSafe('tared and calibrated on the node, reported in milligrams.')).toBe(false);
    expect(pureSafe('hold the value for 1 s')).toBe(false);
    expect(pureSafe('volume in %')).toBe(false);
    // every summary the page shows in pure mode is checked the same way
    const shown = CATALOG.capabilities.map((c) => c.summary).filter(pureSafe);
    for (const t of shown) {
      expect(t).not.toMatch(EARTH);
    }
  });
});

describe('enums by name and forms without examples (DEVICE-SPEC G2, G4)', () => {
  const seeded = (c: CatalogCapability, name: string, mirror: Record<string, unknown> = {}) => {
    const command = cmd(c, name);
    const specs = command.fields.map((f) => controlFor(f, c));
    return { specs, values: seedValues(specs, c.properties, mirror) };
  };

  it('a list of numbers takes what the hub takes: each in its element type’s range, at most the field’s count (every array<int> field)', () => {
    let seen = 0;
    for (const c of CATALOG.capabilities) {
      for (const m of c.commands) {
        for (const f of m.fields) {
          const inner = /^array<(\w+)>$/.exec(f.type)?.[1];
          if (!inner || !INT_RANGES[inner]) {
            continue;
          }
          seen++;
          const spec = controlFor(f, c);
          const [, top] = INT_RANGES[inner]!;
          expect(spec, `${c.name}.${m.name}.${f.name}`).toMatchObject({ kind: 'list', max: top, ...(f.max ? { maxItems: f.max } : {}) });
          expect(argValue(spec, String(top + 1))).toEqual({ ok: false, error: `each between 0 and ${top}` });
          if (f.max) {
            expect(argValue(spec, Array.from({ length: f.max }, () => String(top)).join(','))).toEqual({ ok: true, value: Array.from({ length: f.max }, () => top) });
            expect(argValue(spec, Array.from({ length: f.max + 1 }, () => '1').join(','))).toEqual({ ok: false, error: `at most ${f.max} numbers` });
          }
        }
      }
    }
    expect(seen).toBeGreaterThanOrEqual(2); // fr.haptic play steps, fr.node set_groups
  });

  it('never says "a whole number": every command of the catalog, seeded, builds or waits only for an empty field', () => {
    const problems: string[] = [];
    for (const c of CATALOG.capabilities) {
      for (const m of c.commands) {
        const { specs, values } = seeded(c, m.name);
        const r = buildArgs(specs, values, new Set());
        if (r.ok) {
          continue;
        }
        for (const [field, error] of Object.entries(r.errors)) {
          const spec = specs.find((s) => s.name === field)!;
          const blank = isBlank(spec, values[field]);
          const hub = isHubIssued(c.name, m) && (HUB_ISSUED[c.name]?.[m.name] ?? []).includes(field);
          if (error.includes('a whole number') || !(blank || hub)) {
            problems.push(`${c.name}.${m.name}.${field}: ${error}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('offers an enum by its member names, with words for labels, and sends the name', () => {
    const cam = cap('fr.camera');
    const { specs, values } = seeded(cam, 'stream_start');
    const to = specs.find((s) => s.name === 'to')!;
    expect(to.options).toEqual([
      { value: 'hub', label: 'hub', num: 0 },
      { value: 'sd', label: 'card', num: 1 },
      { value: 'both', label: 'hub and card', num: 2 },
    ]);
    // the default of `to` is the name hub, not a number to type
    expect(values.to).toBe('hub');
    expect(argValue(to, 'hub')).toEqual({ ok: true, value: 'hub' });
    expect(argValue(to, 1)).toEqual({ ok: true, value: 'sd' });
    expect(argValue(to, 'disk')).toEqual({ ok: false, error: 'choose one of hub, card, hub and card' });
    // set {frame_size: xga} is xga on the wire
    const set = cmd(cam, 'set').fields.map((f) => controlFor(f, cam));
    expect(buildArgs(set, { frame_size: 'xga' }, new Set(['frame_size']))).toEqual({ ok: true, args: { frame_size: 'xga' } });
    expect(set.find((s) => s.name === 'frame_size')!.options![3]!.label).toBe('xga · 1024 × 768');
  });

  it('shows a number the mirror reports for an enum as its name', () => {
    const cam = cap('fr.camera');
    const sd = controlFor({ ...cam.properties.find((p) => p.name === 'sd')!, optional: false }, cam);
    expect(initialValue(sd, 1)).toBe('mounted');
    expect(initialValue(sd, 'error')).toBe('error');
    expect(initialValue(sd, 9)).toBe('');
    const button = cap('fr.button');
    expect(seeded(button, 'inject').values.gesture).toBe('click');
  });

  it('starts a field empty instead of from an example, and says what is missing', () => {
    const cam = cap('fr.camera');
    const { specs, values } = seeded(cam, 'sd_delete');
    // the example is { recording: 3 }: never a value
    expect(values).toEqual({ recording: '' });
    expect(missingFields(specs, values)).toEqual(['recording']);
    expect(`Fill in ${wordList(missingFields(specs, values))} first`).toBe('Fill in recording first');
    expect(buildArgs(specs, values, new Set()).ok).toBe(false);
    expect(buildArgs(specs, { recording: '7' }, new Set())).toEqual({ ok: true, args: { recording: 7 } });
    // a field that shadows a property starts from the mirror
    const led = cap('fr.led');
    expect(seeded(led, 'set', { on: true, brightness: 40 }).values).toMatchObject({ on: true, brightness: 40 });
    expect(wordList(['x', 'y', 'text'])).toBe('x, y and text');
  });
});

describe('spans typed by a person (DEVICE-SPEC G7) and scaled rates', () => {
  it('turns a count of a rung into the field’s unit, rounded and clamped, never back to 0 by rounding', () => {
    const blink = spanToUs(core, 1, Unit.BLINK);
    expect(blink).toBeCloseTo(blinkMicros(core), 0);
    expect(spanToUs(core, 1, Unit.FLAVON)).toBeCloseTo(blink * 25, -1);
    const ms = spanToField(spanToUs(core, 2, Unit.BLINK), 'ms', 10, 10_000)!;
    expect(ms.clamped).toBeNull();
    expect(ms.value).toBe(Math.round((2 * blink) / 1000));
    expect(spanToField(spanToUs(core, 9, Unit.PREON), 's', 0, 3600)).toEqual({ value: 3600, clamped: 'max' });
    expect(spanToField(1000, 'ms', 10, 100)).toEqual({ value: 10, clamped: 'min' });
    expect(spanToField(1000, 'Hz')).toBeNull();
    const r = usToRung(core, 30 * blink);
    expect(r.rung).toBe(Unit.FLAVON);
    expect(r.count).toBeCloseTo(1.2, 1);
    expect(usToRung(core, blink / 2).rung).toBe(Unit.BLINK);
  });

  it('applies a scale in the rate branch (fps_x10 is tenths of a hertz)', () => {
    const scaled = valueText(core, 97, 'Hz', { scale: 0.1 });
    expect(scaled.text).toBe(valueText(core, 9.7, 'Hz').text);
    expect(scaled.earth).toBe('9.7 Hz');
    expect(valueText(core, 97, 'Hz', { scale: 0.1, symbol: 'frames a second' }).earth).toBe('9.7 frames a second');
  });
});
