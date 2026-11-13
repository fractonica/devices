// One rule for the texts the dashboard does not write itself (src/state/pure-text.ts) and one vocabulary for the
// states every page names (src/state/words.ts), as the stage 4 integration settled them.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { sayInSvg } from '../src/state/bench-view.ts';
import { earthText, heldText, pureSafe, pureText } from '../src/state/pure-text.ts';
import { actFailure, eventWords, fleetCount, presenceWord } from '../src/state/words.ts';

describe('a hub text in pure mode', () => {
  const spanOf = (us: bigint) => `[${us}]`;

  it('says its durations as spans when the core is loaded, and keeps the sentence', () => {
    expect(pureText('event loop delay p99 7.47 ms over the last 30 s', spanOf)).toBe('event loop delay p99 [7470] over the last [30000000]');
  });

  it('leaves out a clause with another Earth measure, and the durations too without the core', () => {
    expect(pureText('the image is 1.2 MB')).not.toMatch(/MB/);
    expect(pureText('attic-pad is unknown: the OFFER is retried after 5, 15 and 45 s')).toBe('attic-pad is unknown: the OFFER is retried');
    expect(pureText('lab is 5 GHz only', spanOf)).toBe('lab is 5g only');
  });

  it('leaves out every Earth measure the hub, a device or a part may write, and keeps band and network names', () => {
    const cases: [string, string][] = [
      ['disk 85 % full', 'disk full'],
      ['supply 3.3 V', 'supply'],
      ['reading 3712 mV', 'reading'],
      ['next check at 14:05', 'next check'],
      ['lent until 2026-11-13T21:00:00Z', 'lent'],
      ['temperature 41 °C', 'temperature'],
      ['build is 1.2 GB', 'build is'],
      ['rssi -70 dBm', 'rssi'],
      ['100 V, 17 A N-MOSFET', 'N-MOSFET'],
      ['Bar load cell, 1 kg (80 × 12.7 × 12.7 mm)', 'Bar load cell'],
      ['90 F lithium-ion capacitor', 'lithium-ion capacitor'],
      ['the second device on lab-5g', 'the second device on lab-5g'],
      ['a 5g network', 'a 5g network'],
      ['esptool null, expected 5.6.0', 'esptool null, expected 5.6.0'],
    ];
    for (const [x, want] of cases) {
      expect(pureText(x, spanOf)).toBe(want);
    }
    expect(pureText('retried after 5 minutes', spanOf)).toBe('retried after [300000000]');
    expect(pureText('5-10 s', spanOf)).toBe('[5000000]-[10000000]');
    expect(pureText('network lab-5g is 5 GHz only (band 5g), but porch-light is an esp32c6, which has no 5 GHz radio', spanOf)).toBe(
      'network lab-5g is 5g only, but porch-light is an esp32c6, which has no 5g radio',
    );
  });

  it('always returns a text pure mode may show, whatever it is given', () => {
    const words = ['the', 'board', '5', '3.3', '-70', '12', '¼', 'ms', 's', 'V', 'mV', 'A', 'mAh', 'F', 'Ω', 'kg', 'g', 'mm', 'm', '%', '°C', 'dBm', 'GHz', 'MB', 'B', 'minutes', 'hours', 'days', 'seconds', '14:05', '2026-11-13', 'UTC', '(', ')', ',', ':', 'after', 'below', 'lab-5g', '5g', 'and', 'per cent', 'ν'];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 2000; i++) {
      const n = 1 + Math.floor(rnd() * 9);
      const x = Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(rnd() < 0.5 ? ' ' : '');
      expect(pureSafe(pureText(x)), x).toBe(true);
      expect(pureSafe(pureText(x, spanOf)), x).toBe(true);
    }
  });

  it('in Earth mode keeps the span and marks every Earth value with ⊕', () => {
    expect(earthText('p99 10.06 ms (above 5 ms)', spanOf)).toBe('p99 [10060] ⊕ 10.06 ms (above [5000] ⊕ 5 ms)');
    expect(earthText('supply 3.3 V', spanOf)).toBe('supply ⊕ 3.3 V');
  });

  it('keeps a text with no Earth unit as it is', () => {
    expect(pureText('sidecar venv missing', spanOf)).toBe('sidecar venv missing');
  });

  it('holds back catalog prose that names a unit, even without a number', () => {
    expect(pureSafe('Momentary push button with debounced edges.')).toBe(true);
    expect(pureSafe('volume in %')).toBe(false);
    expect(pureSafe('checked at 14:05')).toBe(false);
    expect(pureSafe('a sine of freq_hz for ms')).toBe(false);
  });
});

describe('identifiers and lists', () => {
  const spanOf = (us: bigint) => `[${us}]`;

  it('keeps a MAC or a USB serial as written in both modes', () => {
    for (const x of ['mac 02:6F:28:AB:CD:EF', 'usb serial 02:F2:00:00:00:02', 'port /dev/cu.usbmodem-fr-02f200000002']) {
      expect(pureText(x, spanOf)).toBe(x);
      expect(earthText(x, spanOf)).toBe(x);
      expect(heldText(x, spanOf)).toBe(x);
      expect(pureSafe(x)).toBe(true);
    }
    // a MAC beside a measure: the measure goes, the MAC stays
    expect(pureText('mac 02:6F:28:AB:CD:EF, rssi -70 dBm', spanOf)).toBe('mac 02:6F:28:AB:CD:EF');
    expect(earthText('mac 02:6F:28:AB:CD:EF, rssi -70 dBm', spanOf)).toBe('mac 02:6F:28:AB:CD:EF, rssi ⊕ -70 dBm');
    // three decimal pairs read as a clock time still (pure mode never shows one)
    expect(pureSafe('at 12:00:05')).toBe(false);
  });

  it('reads a comma list only when it ends with a joining word', () => {
    expect(earthText('channel 6, 2.4 GHz', spanOf)).toBe('channel 6, ⊕ 2.4 GHz');
    expect(earthText('retried after 5, 15 and 45 s', spanOf)).toBe('retried after [5000000], [15000000] and [45000000] ⊕ 5, 15 and 45 s');
    expect(heldText('LiPo OUT+ (TP4056 #1, 3.0–4.2 V)', spanOf)).toBe('LiPo OUT+ (TP4056 #1, ⊕)');
  });

  it('says a rate per Earth time and a duration in words as Earth measures', () => {
    expect(pureSafe('10 or 80 conversions/s')).toBe(false);
    expect(pureSafe('samples/s')).toBe(false);
    expect(pureText('switches it on for a minute', spanOf)).toBe('switches it on for [60000000]');
    expect(earthText('switches it on for a minute', spanOf)).toBe('switches it on for [60000000] ⊕ a minute');
    expect(pureText('rises within a few seconds', spanOf)).toBe('rises within a few moments');
    expect(pureText('rises within a few minutes', spanOf)).toBe('rises within a short while');
    expect(pureSafe(pureText('switches it on for a minute'))).toBe(true);
  });

  it('cleans up after a removal: no doubled commas, no dangling "about", no ":."', () => {
    expect(pureText('pouch, about 250–300 mAh, usually lithium')).toBe('pouch, usually lithium');
    expect(pureText('Multimeter on the cell holder: 3.7 V.')).not.toMatch(/:\.|:$/);
    expect(pureText('Leave it at 3.8 V: then stop.')).not.toMatch(/:\./);
  });
});

describe('a text someone wires or buys from, in pure mode (heldText)', () => {
  const spanOf = (us: bigint) => `[${us}]`;

  it('puts ⊕ where it holds a value back, so the sentence keeps its shape and a safety limit is never silently gone', () => {
    expect(heldText('Never short the capacitor or run it flat: below 2.5 V it is damaged. Leave it at about 3.8 V when you stop.', spanOf)).toBe(
      'Never short the capacitor or run it flat: below ⊕ it is damaged. Leave it at about ⊕ when you stop.',
    );
    expect(heldText('GC9A01 1.28" round display, 240 × 240', spanOf)).toBe('GC9A01 ⊕ round display, 240 × 240');
    expect(heldText('Resistor (¼ W through-hole) 1 MΩ', spanOf)).toBe('Resistor (⊕ through-hole) ⊕');
    expect(heldText('holes at 15/40/15 mm from the ends; ±2 ppm', spanOf)).toBe('holes at ⊕ from the ends; ±⊕');
    // a part's number is not a measure
    expect(heldText('TP4056 charger module with protection (DW01 + 8205A)', spanOf)).toBe('TP4056 charger module with protection (DW01 + 8205A)');
    expect(heldText('a 5V pin and a 3.3V rail', spanOf)).toBe('a ⊕ pin and a ⊕ rail');
    expect(heldText('TP4056 #1 OUT+ through the divider via 1 MΩ / 1 MΩ, 100 nF', spanOf)).toBe('TP4056 #1 OUT+ through the divider via ⊕ / ⊕, ⊕');
    expect(heldText('Momentary push button with debounced edges.', spanOf)).toBe('Momentary push button with debounced edges.');
  });

  it('draws a diagram\'s labels the same way, changing no markup', () => {
    const svg = '<svg><text x="1">10 kΩ in series</text><g><text>GPIO0 &amp; GND</text></g></svg>';
    expect(sayInSvg(svg, (t) => heldText(t, spanOf), null)).toBe('<svg><text x="1">⊕ in series</text><g><text>GPIO0 &amp; GND</text></g></svg>');
  });

  it('leaves no Earth measure and no broken sentence in any guide, part or drawing the repository ships', () => {
    const root = join(import.meta.dirname, '..', '..', '..', 'hardware');
    const texts: string[] = [];
    const strings = (v: unknown): void => {
      if (typeof v === 'string') {
        texts.push(v);
      } else if (Array.isArray(v)) {
        v.forEach(strings);
      } else if (v && typeof v === 'object') {
        Object.values(v).forEach(strings);
      }
    };
    for (const g of readdirSync(join(root, 'wiring'))) {
      for (const f of readdirSync(join(root, 'wiring', g))) {
        if (f.endsWith('.yaml')) {
          strings(parse(readFileSync(join(root, 'wiring', g, f), 'utf8')));
        } else if (f.endsWith('.svg')) {
          for (const m of readFileSync(join(root, 'wiring', g, f), 'utf8').matchAll(/>([^<>]+)</g)) {
            texts.push(m[1]!);
          }
        }
      }
    }
    for (const f of readdirSync(join(root, 'parts'))) {
      if (f.endsWith('.yaml')) {
        strings(parse(readFileSync(join(root, 'parts', f), 'utf8')));
      }
    }
    expect(texts.length).toBeGreaterThan(200);
    for (const x of texts) {
      const held = heldText(x, spanOf);
      expect(pureSafe(held), `${x} → ${held}`).toBe(true);
      expect(held, x).not.toMatch(/\bat when\b|:\.|,\s*,|\(\s*\)/);
      if (!pureSafe(x)) {
        // a value held back leaves its mark, or was a duration said as a span
        expect(held.includes('⊕') || held.includes('[') || /a few moments|a (?:short|long) while/.test(held), `${x} → ${held}`).toBe(true);
      }
    }
  });
});

describe('the words for states', () => {
  it('names presence the same way on every page', () => {
    expect(['online', 'suspect', 'offline', 'unknown', undefined, 'not_known'].map(presenceWord)).toEqual(['online', 'suspect', 'offline', 'not heard yet', 'not heard yet', 'not known']);
  });

  it('says a device’s last event in words where the hub has them', () => {
    expect(eventWords({ type: 'device.link' })).toBe('link changed');
    expect(eventWords({ type: 'node.boot' })).toBe('started');
    expect(eventWords({ type: 'status.color' })).toBe('color changed');
    expect(eventWords({ type: 'button.pressed' })).toBe('button pressed');
    expect(eventWords({ type: 'boot.pressed' })).toBe('boot pressed');
    expect(eventWords({ type: 'scale.weight_mg' })).toBe('scale weight');
  });

  it('says a refused action once, without repeating that the hub does not answer', () => {
    expect(actFailure('device_set', { code: 'HUB_UNREACHABLE', message: 'the hub is not answering; nothing was sent' }, []).body).toBe('the hub is not answering; nothing was sent');
    expect(actFailure('device_set', { code: 'HUB_UNREACHABLE', message: 'the hub did not answer in time' }, []).body).toBe(
      'the hub did not answer in time — the hub does not answer; the page tries again by itself',
    );
  });

  it('counts the fleet, with a filter', () => {
    expect(fleetCount({ total: 6, online: 5, shown: 2 })).toBe('2 shown · 5 of 6 online');
    expect(fleetCount({ total: 6, online: 6, shown: 6 })).toBe('all 6 online');
  });
});
