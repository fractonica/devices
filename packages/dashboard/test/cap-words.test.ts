// The words a person reads for a capability's members (src/state/cap-words.ts, DEVICE-SPEC G1, G5): codes become
// words, a scaled or suffixed number is said in its unit (pure mode: Fractonica units only), and every sentence that
// says what a command does is pure-safe.

import { beforeAll, describe, expect, it } from 'vitest';

import { CATALOG } from '@fractonica/protocol/gen';
import { type Core, loadCore } from '@fractonica/time';

import { allCommandSentences, commandDoes, commandWords, enumWords, firstSentence, hasMemberEntry, isDestructive, memberValueText, memberWords, suffixRule } from '../src/state/cap-words.ts';
import { pureSafe } from '../src/state/pure-text.ts';

const EARTH = /⊕|\d{1,2}:\d{2}|\b\d+\s?(h|min|s|ms|Hz|m|mV|mg|MB|dBm)\b|%/;

let core: Core;
beforeAll(async () => {
  core = await loadCore();
});

describe('member words', () => {
  it('says fps_x10 as a rate per Blink in pure mode and frames a second in Earth mode', () => {
    const fps = { name: 'fps_x10' };
    expect(memberWords('fr.camera', fps)).toMatchObject({ words: 'frame rate', unit: 'Hz', scale: 0.1 });
    const v = memberValueText(core, 'fr.camera', fps, 97);
    expect(v.text).toMatch(/pB|per/);
    expect(v.text).not.toMatch(EARTH);
    expect(v.earth).toBe('9.7 frames a second');
  });

  it('names the camera’s codes in words, the card space only in Earth mode', () => {
    expect(memberWords('fr.camera', { name: 'last_bytes' })).toMatchObject({ words: 'last frame', unit: 'B' });
    expect(memberValueText(core, 'fr.camera', { name: 'last_bytes' }, 38400).text).toBe('38 400 B');
    expect(memberWords('fr.camera', { name: 'frames' }).words).toBe('frames taken');
    const free = memberValueText(core, 'fr.camera', { name: 'sd_free_mb', unit: 'MB' }, 1204);
    expect(free).toEqual({ text: '—', earth: '1 204 MB' });
    expect(enumWords('fr.camera', 'Target', 'both')).toBe('hub and card');
    expect(enumWords('fr.camera', 'CardState', 'mounted')).toBe('in');
    expect(enumWords('fr.camera', 'FrameSize', 'qvga')).toBe('qvga · 320 × 240');
    expect(enumWords('fr.button', 'Gesture', 'double_click')).toBe('double click');
  });

  it('applies a suffix rule the table does not override: _x10 scales and leaves the words', () => {
    expect(suffixRule('temp_x10')).toMatchObject({ scale: 0.1 });
    expect(memberWords('fr.any', { name: 'temp_x10' })).toMatchObject({ words: 'temp', scale: 0.1 });
    expect(memberWords('fr.any', { name: 'level_x100' })).toMatchObject({ words: 'level', scale: 0.01 });
    expect(memberWords('fr.analog_in', { name: 'hold_ms' })).toMatchObject({ words: 'hold', unit: 'ms' });
  });

  it('covers every catalog member named with a unit or scale suffix, by a rule or the table', () => {
    const missing: string[] = [];
    for (const c of CATALOG.capabilities) {
      const members = [...c.properties, ...c.commands.flatMap((m) => m.fields)];
      for (const m of members) {
        if (/_(x10|mb|ms|hz|s)$/i.test(m.name) && !suffixRule(m.name) && !hasMemberEntry(c.name, m.name)) {
          missing.push(`${c.name}.${m.name}`);
        }
        if (/_(x10|mb|ms|hz|s)$/i.test(m.name) && !memberWords(c.name, m).unit && !memberWords(c.name, m).scale) {
          missing.push(`${c.name}.${m.name} (no unit)`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('command words', () => {
  it('gives each command a verb and says what it does, safely in pure mode', () => {
    expect(commandWords('fr.camera', 'sd_delete').verb).toBe('delete a recording');
    expect(commandWords('fr.camera', 'stream_start').verb).toBe('start a stream');
    expect(commandWords('fr.x', 'do_thing').verb).toBe('do thing');
    expect(commandDoes('fr.led', 'blink', 'status')).toBe('Blinks status the number of times chosen, then returns it to its state.');
    for (const s of allCommandSentences()) {
      expect(pureSafe(s), s).toBe(true);
      expect(s).not.toMatch(EARTH);
    }
  });

  it('marks a command that cannot be undone, and takes the first sentence of a doc', () => {
    expect(isDestructive('sd_delete')).toBe(true);
    expect(isDestructive('reset_calibration')).toBe(true);
    expect(isDestructive('stream_stop')).toBe(false);
    expect(firstSentence('Ends stream `stream_id` (reason stopped). NOT_FOUND otherwise.')).toBe('Ends stream stream_id (reason stopped).');
  });
});
