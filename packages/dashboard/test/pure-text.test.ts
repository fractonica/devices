// One rule for the texts the dashboard does not write itself (src/state/pure-text.ts) and one vocabulary for the
// states every page names (src/state/words.ts), as the stage 4 integration settled them.

import { describe, expect, it } from 'vitest';

import { pureSafe, pureText } from '../src/state/pure-text.ts';
import { eventWords, fleetCount, presenceWord } from '../src/state/words.ts';

describe('a hub text in pure mode', () => {
  const spanOf = (us: bigint) => `[${us}]`;

  it('says its durations as spans when the core is loaded, and keeps the sentence', () => {
    expect(pureText('event loop delay p99 7.47 ms over the last 30 s', spanOf)).toBe('event loop delay p99 [7470] over the last [30000000]');
  });

  it('leaves out a clause with another Earth measure, and the durations too without the core', () => {
    expect(pureText('the image is 1.2 MB')).not.toMatch(/MB/);
    expect(pureText('attic-pad is unknown: the OFFER is retried after 5, 15 and 45 s')).toBe('attic-pad is unknown: the OFFER is retried');
    expect(pureText('lab is 5 GHz only', spanOf)).toBe('lab is 5g band only');
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
    expect(eventWords({ type: 'status.color' })).toBe('status.color');
  });

  it('counts the fleet, with a filter', () => {
    expect(fleetCount({ total: 6, online: 5, shown: 2 })).toBe('2 shown · 5 of 6 online');
    expect(fleetCount({ total: 6, online: 6, shown: 6 })).toBe('all 6 online');
  });
});
