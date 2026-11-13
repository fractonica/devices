// One rule for the texts the dashboard does not write itself (src/state/pure-text.ts) and one vocabulary for the
// states every page names (src/state/words.ts), as the stage 4 integration settled them.

import { describe, expect, it } from 'vitest';

import { earthText, pureSafe, pureText } from '../src/state/pure-text.ts';
import { eventWords, fleetCount, presenceWord } from '../src/state/words.ts';

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

describe('the words for states', () => {
  it('names presence the same way on every page', () => {
    expect(['online', 'suspect', 'offline', 'unknown', undefined].map(presenceWord)).toEqual(['online', 'suspect', 'offline', 'not heard yet', 'not heard yet']);
  });

  it('says a device’s last event in words where the hub has them', () => {
    expect(eventWords({ type: 'device.link' })).toBe('link changed');
    expect(eventWords({ type: 'node.boot' })).toBe('started');
    expect(eventWords({ type: 'status.color' })).toBe('color changed');
    expect(eventWords({ type: 'button.pressed' })).toBe('button pressed');
    expect(eventWords({ type: 'boot.pressed' })).toBe('boot pressed');
    expect(eventWords({ type: 'scale.weight_mg' })).toBe('scale weight');
  });

  it('counts the fleet, with a filter', () => {
    expect(fleetCount({ total: 6, online: 5, shown: 2 })).toBe('2 shown · 5 of 6 online');
    expect(fleetCount({ total: 6, online: 6, shown: 6 })).toBe('all 6 online');
  });
});
