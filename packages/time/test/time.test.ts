// @fractonica/time against the core's specification (core docs/SPEC.md §12, §15.6, §16.5): the vendored module is
// loaded from disk, and the readings the CLI and the hub show are its answers. Times in the SPEC are Unix seconds
// rounded to the millisecond, so an instant is checked rounded the same way.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  convert,
  type Core,
  formatLadder,
  formatNow,
  inCatalogue,
  loadCore,
  parseLevel,
  parseQuarter,
  readLadder,
  readNext,
  readNow,
  readSpan,
  readSync,
  TimeError,
  toInstant,
} from '@fractonica/time';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');

const A = '2026-10-08T12:00:00Z';
const A_STAMP = 'α#6 β#4 γ#9 δ#3 ε#5 34η 29ι 21λ 3ν';
/** SPEC §12's vectors B, C and the anchor, in Unix seconds (the anchor's one second after the eclipse). */
const B = '946684800';
const C = '2886085800';
const ANCHOR = '125593320.816';

let core: Core;
beforeAll(async () => {
  core = await loadCore();
});

/** An instant (µs, decimal) rounded to the millisecond, as SPEC writes them. */
const ms = (us: string | undefined | null) => (us ? String((BigInt(us) + 500n) / 1000n) : us);
/** The core groups digits with a narrow no-break space (U+202F). */
const n = (s: string) => s.replace(/ /g, '\u202f');

/** Asserts a TimeError of `reason` from `fn`. */
function refuses(fn: () => unknown, reason: string, text?: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(TimeError);
  expect((caught as TimeError).reason).toBe(reason);
  expect((caught as TimeError).code).toBe('INVALID_ARGS');
  if (text) {
    expect((caught as TimeError).message).toMatch(text);
  }
}

describe('the vendored core', () => {
  it('is the module time.lock pins: its sha256 and the versions it reports', () => {
    const lock = JSON.parse(readFileSync(join(PKG, 'time.lock'), 'utf8')) as { core: string; spec: string; files: Record<string, { sha256: string }> };
    for (const [rel, entry] of Object.entries(lock.files)) {
      expect(createHash('sha256').update(readFileSync(join(PKG, rel))).digest('hex'), rel).toBe(entry.sha256);
    }
    expect(core.frc.version).toBe(lock.core);
    expect(core.frc.specVersion).toBe(lock.spec);
  });

  it('loads once: a second call gives the same instance', async () => {
    expect(await loadCore()).toBe(core);
  });

  it('answers SPEC §16.5: the Blink is 310.922 ms and ξ 22.5137 Hz in the reference interval', () => {
    const { frc } = core;
    expect(frc.periodSeconds(12, frc.referenceInterval)).toBeCloseTo(0.310922, 6);
    expect(frc.frequencyHz(13, frc.referenceInterval)).toBeCloseTo(22.5137, 4);
  });
});

describe('SPEC vector A: 2026-10-08T12:00:00Z', () => {
  it('reads the stamp, the date in words and the short date (§15.6)', () => {
    const r = readNow(core, { at: A });
    expect(r.unix_us).toBe('1791460800000000');
    expect(r.stamp).toBe(A_STAMP);
    expect(r.terms).toEqual(A_STAMP.split(' '));
    expect(r.words).toBe('Alpha Hexafracton Valley, Beta Tetrafracton Valley, Gamma Nonafracton Valley, Delta Trifracton End, ε#5 34η 29ι 21λ 3ν');
    expect(r.short).toBe('Delta Trifracton End ε#5 34η 29ι 21λ 3ν');
    expect(r.majors.map((m) => `${m.symbol} ${m.name} ${m.quarter}`)).toEqual(['α Alpha Hexafracton Valley', 'β Beta Tetrafracton Valley', 'γ Gamma Nonafracton Valley', 'δ Delta Trifracton End']);
    expect(r.pentad.name).toBe('Pentad II');
  });

  it('counts the Helion and the θ down as §12 gives them, and the depth-7 end is 6ι 43λ away', () => {
    const [helion, theta] = readNow(core, { at: A }).countdowns;
    expect(helion).toMatchObject({ level: 6, depth: 7, symbol: 'η', kind: 'Helion', place: '1 of 11', local: 0, siblings: 11, digits: [13, 0] });
    expect(helion.next).toMatchObject({ quarter: 'End', span: '6ι 43λ' });
    expect(ms(helion.next?.at_us)).toBe('1791464172428');
    expect(theta).toMatchObject({ level: 7, symbol: 'θ', kind: 'between', place: '8 of 9', local: 7, siblings: 9, digits: [5, 4] });
    expect(theta.next?.quarter).toBe('Node');
    expect(ms(theta.next?.at_us)).toBe('1791461140937');
  });

  it('reads the solar sync of §12: 4 820, its digits, drift and next node', () => {
    const r = readSync(core, { at: A });
    expect(r).toMatchObject({ sync: 4820, number: n('4 820'), digits: [5, 11, 13], drift: n('−6 235λ'), quarter: 'Node' });
    expect(ms(r.start_us)).toBe('1791336849826');
    expect(r.next?.quarter).toBe('Node');
    expect(ms(r.next?.at_us)).toBe('1791509644786');
    expect(readNow(core, { at: A }).sun).toMatchObject({ sync: 4820, digits: [5, 11, 13], drift: n('−6 235λ') });
  });

  it('gives the global cycle indices of §12 in the ladder', () => {
    const r = readLadder(core, { at: A, to: 'θ' });
    expect(r.rungs.map((g) => g.symbol)).toEqual(['α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ']);
    expect(r.rungs[6]).toMatchObject({ cycle: '717211', place: '1 of 11', quarter: 'End', kind_word: 'unit', name: null });
    expect(r.rungs[7]).toMatchObject({ cycle: '6454906', place: '8 of 9', quarter: 'Node', kind_word: 'between' });
    expect(r.rungs[0]).toMatchObject({ name: 'Alpha Hexafracton', kind_word: 'major' });
  });
});

describe('SPEC vectors B, C and the anchor (§12, §15.6)', () => {
  it('B: 2000-01-01T00:00:00Z', () => {
    const r = readNow(core, { at: B });
    expect(r.words).toBe('Alpha Hexafracton Node, Beta Difracton End, Gamma Didecafracton Node, Delta Trifracton Node, ε#2 21η 12ι 6λ 5ν');
    expect(r.countdowns[0]).toMatchObject({ digits: [5, 6], local: 9, siblings: 11 });
    expect(r.countdowns[0].next?.quarter).toBe('Node');
    expect(ms(r.countdowns[0].next?.at_us)).toBe('946687783046');
    expect(r.countdowns[1]).toMatchObject({ digits: [0, 6], local: 3, siblings: 9 });
    expect(ms(r.countdowns[1].next?.at_us)).toBe('946685256803');
    const s = readSync(core, { at: B });
    expect(s).toMatchObject({ sync: 2375, digits: [14, 9, 9] });
    expect(ms(s.next?.at_us)).toBe('946715066462');
    expect(s.next?.quarter).toBe('End');
  });

  it('C: 2061-06-15T18:30:00Z', () => {
    const r = readNow(core, { at: C });
    expect(r.words).toBe('Alpha Heptafracton Peak, Beta Difracton Peak, Gamma Monofracton End, Delta Pentafracton Peak, ε#2 1η 23ι 1λ 21ν');
    expect(r.countdowns[0]).toMatchObject({ digits: [10, 3], local: 0 });
    expect(r.countdowns[0].next?.quarter).toBe('Valley');
    expect(ms(r.countdowns[0].next?.at_us)).toBe('2886087806395');
    expect(r.countdowns[1]).toMatchObject({ digits: [12, 1], local: 5 });
    expect(ms(r.countdowns[1].next?.at_us)).toBe('2886086290651');
    const s = readSync(core, { at: C });
    expect(s).toMatchObject({ sync: 7987, digits: [12, 5, 4] });
    expect(ms(s.next?.at_us)).toBe('2886165109343');
  });

  it('the anchor + 1 s: sync 0, no drift, digits [0, 0, 0]', () => {
    const r = readNow(core, { at: ANCHOR });
    expect(r.words).toBe('Alpha Hexafracton Peak, Beta Monofracton Peak, Gamma Monofracton Peak, Delta Monofracton Peak, ε#1 1η 0ι 0λ 3ν');
    expect(r.countdowns[0].digits).toEqual([0, 0]);
    const s = readSync(core, { at: ANCHOR });
    expect(s).toMatchObject({ sync: 0, number: '0', digits: [0, 0, 0] });
    expect(s.drift).toBe('0λ');
  });
});

describe('reading instants', () => {
  const t = (text: string, opts = {}) => String(toInstant(core, text, opts).t);

  it('reads every form of vector A to the same microsecond', () => {
    for (const text of [A, '2026-10-08T14:00:00+02:00', '1791460800', '@1791460800', '1791460800s', '1791460800000ms', '1791460800000000us', '1791460800000000µs', '1791460800.000000']) {
      expect(t(text), text).toBe('1791460800000000');
    }
  });

  it('keeps the fraction of seconds and milliseconds exactly, and refuses one finer than a microsecond', () => {
    expect(t('1791460800.25')).toBe('1791460800250000');
    expect(t('1791460800.000001')).toBe('1791460800000001');
    expect(t('1791460800000.5ms')).toBe('1791460800000500');
    expect(t('-1.5')).toBe('-1500000');
    refuses(() => toInstant(core, '1791460800.0000001'), 'parse', /finer than a microsecond/);
    refuses(() => toInstant(core, '1.5us'), 'parse', /finer than a microsecond/);
  });

  it('reads a bare number as seconds, never by its length, and says how to write milliseconds when that leaves the catalogue', () => {
    expect(t('2026')).toBe('2026000000');
    refuses(() => inCatalogue(core, toInstant(core, '1791460800000')), 'out_of_catalogue', /1791460800000ms/);
  });

  it('reads a civil time without an offset in the local zone', () => {
    const before = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Kolkata'; // UTC+5:30 all year
      expect(t('2026-10-08 17:30')).toBe('1791460800000000');
      process.env.TZ = 'UTC';
      expect(t('2026-10-08 12:00')).toBe('1791460800000000');
    } finally {
      if (before === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = before;
      }
    }
  });

  it('round-trips the stamp: an instant to its stamp and the stamp back to the first microsecond of its Blink', () => {
    for (const at of [A, B, C, ANCHOR, '1613-06-01T00:00:00Z', '2857-01-01T00:00:00Z']) {
      const there = convert(core, { at });
      const back = convert(core, { at: there.stamp });
      expect(back.stamp, at).toBe(there.stamp);
      expect(back.form).toBe('stamp');
      expect(back.finest?.symbol).toBe('ν');
      // the stamp names the Blink the instant is in: back is its first microsecond, at most one Blink earlier
      expect(BigInt(back.unix_us) <= BigInt(there.unix_us)).toBe(true);
      expect(convert(core, { at: back.unix_us + 'us' }).stamp).toBe(there.stamp);
      const blink = core.cat.cycleAt(BigInt(there.unix_us), 12);
      expect(back.unix_us).toBe(String(blink.start));
    }
  });

  it('reads an ASCII stamp, and a partial one in the date of its context', () => {
    expect(convert(core, { at: 'a#6 b#4 g#9 d#3 e#5 34h 29i 21l 3n' }).stamp).toBe(A_STAMP);
    const partial = convert(core, { at: 'ε#5 34η', context: A });
    expect(partial.stamp).toBe('α#6 β#4 γ#9 δ#3 ε#5 34η 0ι 0λ 0ν');
    expect(partial.finest).toEqual({ symbol: 'η', name: 'Helion' });
    expect(convert(core, { at: 'ε#5 34η' }, { now: () => 1791460800000000n }).stamp).toBe(partial.stamp);
  });

  it('gives a conversion in every form', () => {
    const r = convert(core, { at: A });
    expect(r).toMatchObject({ form: 'civil', unix_us: '1791460800000000', iso: '2026-10-08T12:00:00.000Z', stamp: A_STAMP });
    expect(convert(core, { at: 'now' }, { now: () => 1791460800000000n }).stamp).toBe(A_STAMP);
  });

  it('refuses text that is no instant, with the forms it reads', () => {
    refuses(() => toInstant(core, 'banana'), 'parse', /Unix seconds/);
    refuses(() => toInstant(core, ''), 'parse');
    refuses(() => toInstant(core, '2026-02-31'), 'range');
  });
});

describe('catalogue edges: a reading exists only inside the catalogue', () => {
  it('reads the first and the last instant of the catalogue', () => {
    const { cat } = core;
    expect(readNow(core, { at: `${cat.first}us` }).stamp).toMatch(/^α#1 /);
    const last = readNow(core, { at: `${cat.last}us` });
    expect(last.stamp).toMatch(/^α#18 /);
    // nothing comes after the closing instant
    expect(last.countdowns.every((c) => c.next === null)).toBe(true);
  });

  it('refuses an instant one microsecond outside, never extrapolating', () => {
    const { cat } = core;
    for (const at of [`${cat.first - 1n}us`, `${cat.last + 1n}us`, '1500-01-01T00:00:00Z', '3000-01-01T00:00:00Z']) {
      refuses(() => readNow(core, { at }), 'out_of_catalogue', /OUT OF CATALOGUE · α#1 – α#18/);
      refuses(() => readLadder(core, { at }), 'out_of_catalogue');
      refuses(() => readNext(core, { at, level: 'η' }), 'out_of_catalogue');
      refuses(() => convert(core, { at }), 'out_of_catalogue');
      refuses(() => readSpan(core, { from: A, to: at }), 'out_of_catalogue');
    }
  });

  it('stops listing thresholds where the catalogue ends', () => {
    const { cat } = core;
    const r = readNext(core, { at: `${cat.last - 1n}us`, level: 'α', count: 3 });
    expect(r.thresholds.length).toBe(1);
    expect(r.thresholds[0].at_us).toBe(String(cat.last));
    expect(r.ends).toBe(true);
  });

  it('refuses a stamp of an Alpha the catalogue does not have', () => {
    refuses(() => toInstant(core, 'α#19 β#1 γ#1 δ#1 ε#1 1η 0ι 0λ 0ν'), 'range');
  });
});

describe('levels, quarters, next thresholds and spans', () => {
  it('names a level by symbol, ASCII letter, word, unit name or depth', () => {
    for (const name of ['η', 'h', 'Eta', 'eta', 'Helion', 'helions', '7']) {
      expect(parseLevel(core, name), name).toBe(6);
    }
    expect(parseLevel(core, 'θ')).toBe(7);
    expect(parseLevel(core, '22')).toBe(21);
    refuses(() => parseLevel(core, '23'), 'range');
    refuses(() => parseLevel(core, '0'), 'range');
    refuses(() => parseLevel(core, 'ω'), 'parse');
    expect([0, 1, 2, 3].map((q) => parseQuarter(core, core.frc.formatQuarter(q)))).toEqual([0, 1, 2, 3]);
    refuses(() => parseQuarter(core, 'noon'), 'parse');
  });

  it('lists the next thresholds of a level, each the end of a quarter of the cycle before it', () => {
    const r = readNext(core, { at: A, level: 'η', count: 5 });
    expect(r.thresholds.map((x) => x.quarter)).toEqual(['End', 'Peak', 'Node', 'Valley', 'End']);
    expect(r.thresholds[0]).toMatchObject({ place: '1 of 11', span: '6ι 43λ', stamp: 'α#6 β#4 γ#9 δ#3 ε#5 35η 0ι 0λ 0ν' });
    expect(r.thresholds[1].place).toBe('2 of 11');
    const ends = readNext(core, { at: A, level: 'η', quarter: 'end', count: 3 });
    expect(ends.thresholds.map((x) => x.stamp)).toEqual(['35η', '36η', '37η'].map((h) => `α#6 β#4 γ#9 δ#3 ε#5 ${h} 0ι 0λ 0ν`));
    refuses(() => readNext(core, { at: A, level: 'η', count: 0 }), 'range');
    refuses(() => readNext(core, { at: A, level: 'η', count: 101 }), 'range');
  });

  it('says a span the core\'s way, both directions', () => {
    const later = '1791464172428000us';
    const r = readSpan(core, { from: A, to: later });
    expect(r).toMatchObject({ span: '6ι 43λ', signed: '+6ι 43λ', negative: false });
    expect(r.parts.map((p) => `${p.count}${p.symbol}`)).toEqual(['6ι', '43λ', '21ν']);
    expect(readSpan(core, { from: later, to: A })).toMatchObject({ signed: '−6ι 43λ', negative: true });
    expect(readSpan(core, { from: A, to: later, parts: 1 }).span).toBe('6ι');
  });
});

describe('pure and Earth', () => {
  const EARTH = /⊕|UTC|GMT|\d{1,2}:\d{2}|\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b|\b(min|h|s|d)\b|Hz|%/;

  it('a pure reading carries no Earth text in its data or its layout', () => {
    for (const r of [readNow(core, { at: A }), readLadder(core, { at: A }), readNext(core, { at: A, level: 'θ' }), readSync(core, { at: A })]) {
      expect(JSON.stringify(r)).not.toMatch(/"earth"|⊕/);
    }
    const text = formatNow(readNow(core, { at: A })) + formatLadder(readLadder(core, { at: A }));
    expect(text).not.toMatch(EARTH);
  });

  it('an Earth reading adds the civil translations, marked ⊕', () => {
    const before = process.env.TZ;
    process.env.TZ = 'UTC';
    try {
      const r = readNow(core, { at: A, earth: true });
      expect(r.earth).toMatchObject({ iso: '2026-10-08T12:00:00.000Z', line: 'THU 8 OCT 2026 · 12:00:00 UTC', utc_offset_s: 0 });
      expect(r.countdowns[0].next?.earth).toEqual({ when: '12:56:12', in: '56 min 12 s' });
      const text = formatNow(r);
      expect(text).toContain('⊕ THU 8 OCT 2026 · 12:00:00 UTC');
      expect(text).toContain('⊕ 12:56:12 · 56 min 12 s');
      // every Earth figure on a line follows the sign
      for (const line of text.split('\n')) {
        const sign = line.indexOf('⊕');
        expect(line.slice(0, sign < 0 ? undefined : sign), line).not.toMatch(EARTH);
      }
    } finally {
      if (before === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = before;
      }
    }
  });

  it('lays out NOW like the site: the reading, the Pentad, the majors, two countdowns, the Sun, next thresholds', () => {
    expect(formatNow(readNow(core, { at: A })).split('\n')).toEqual([
      A_STAMP,
      '',
      'PENTAD II  ·  HELION 2 OF 5',
      '',
      'α  ALPHA HEXAFRACTON  VALLEY',
      'β  BETA TETRAFRACTON  VALLEY',
      'γ  GAMMA NONAFRACTON  VALLEY',
      'δ  DELTA TRIFRACTON   END',
      '',
      'η  HELION   1 OF 11  END IN   6ι 43λ',
      'θ  BETWEEN  8 OF 9   NODE IN  43λ 21ν',
      '',
      'SOLAR SYNC  ' + n('4 820'),
      'DRIFT       ' + n('−6 235λ'),
      'NODE IN     2η 24ι',
      '',
      'NEXT THRESHOLDS',
      'ζ    PEAK    1η 33ι',
      'SUN  NODE    2η 24ι',
      'ε    NODE    4η 24ι',
      'δ    END     43η 6ι',
      'γ    VALLEY  4ε 23η',
    ]);
  });

  it('says when the reading next changes: the end of the running Blink, or sooner', () => {
    const r = readNow(core, { at: A });
    expect(r.next_change_us).toBe(String(core.cat.cycleAt(1791460800000000n, 12).end));
    const after = readNow(core, { at: `${r.next_change_us}us` });
    expect(after.stamp).not.toBe(r.stamp);
  });
});
