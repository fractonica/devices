// Terminal layouts of the readings (read.ts): the site's NOW and LADDER said in aligned columns of plain text. Labels
// are engraved in capitals as the site engraves them (Latin letters only: η stays η); the values are the core's text,
// untouched. No colour, no percentage. PURE by default; an EARTH reading (one asked with `earth`) adds its
// translations, each led by ⊕, and a pure reading has none to add.

import { EARTH_SIGN } from './earth.ts';
import type { Conversion, LadderReading, NextReading, NowReading, SpanReading, SyncReading, ThresholdView } from './read.ts';

/** The site's engraving: Latin letters in capitals, everything else (Greek, numerals, signs) as it is. */
export function engrave(words: string): string {
  return words.replace(/[a-z]+/g, (run) => run.toUpperCase());
}

const width = (s: string) => [...s].length;

/** Rows of cells as aligned columns, two spaces apart; `right` columns are right-aligned. Trailing empty cells are dropped. */
export function table(rows: string[][], right: ReadonlySet<number> = new Set()): string[] {
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(0, ...rows.map((r) => width(r[i] ?? ''))));
  return rows.map((r) => {
    let last = r.length - 1;
    while (last >= 0 && (r[last] ?? '') === '') {
      last--;
    }
    return r
      .slice(0, last + 1)
      .map((cell, i) => {
        const pad = ' '.repeat(widths[i] - width(cell));
        return right.has(i) ? pad + cell : i === last ? cell : cell + pad;
      })
      .join('  ');
  });
}

const earthCell = (text: string | undefined) => (text ? `${EARTH_SIGN} ${text}` : '');

/** "END IN" */
const inLabel = (next: ThresholdView | null) => (next ? `${engrave(next.quarter)} IN` : '');

/** `fr time`: the NOW screen in text. */
export function formatNow(r: NowReading): string {
  const out: string[] = [r.stamp];
  if (r.earth) {
    out.push(earthCell(r.earth.line));
  }
  out.push('', engrave(`${r.pentad.name}  ·  ${r.pentad.detail}`), '');
  out.push(...table(r.majors.map((m) => [m.symbol, engrave(m.name), engrave(m.quarter)])));
  out.push('');
  out.push(
    ...table(
      r.countdowns.map((c) => [
        c.symbol,
        engrave(c.kind),
        engrave(c.place),
        inLabel(c.next),
        c.next?.span ?? '',
        earthCell(c.next?.earth ? `${c.next.earth.when} · ${c.next.earth.in}` : ''),
      ]),
    ),
  );
  if (r.sun) {
    out.push('');
    const sun = r.sun;
    out.push(
      ...table([
        ['SOLAR SYNC', sun.number, earthCell(sun.earth?.start)],
        ['DRIFT', sun.drift, earthCell(sun.earth?.drift)],
        ...(sun.next ? [[inLabel(sun.next), sun.next.span, earthCell(sun.next.earth?.when)]] : []),
      ]),
    );
  }
  if (r.upcoming.length) {
    out.push('', 'NEXT THRESHOLDS');
    out.push(...table(r.upcoming.map((u) => [u.sun ? 'SUN' : u.symbol, engrave(u.quarter), u.span, earthCell(u.earth?.when)])));
  }
  return out.join('\n');
}

/** `fr time ladder`: one row per level, α first, like the site's LADDER. */
export function formatLadder(r: LadderReading): string {
  const out: string[] = [`LADDER  ·  ${r.stamp}`];
  if (r.earth) {
    out.push(earthCell(r.earth.line));
  }
  out.push('');
  const earth = Boolean(r.earth);
  const head = ['DEPTH', 'RUNG', 'KIND', 'CYCLE', 'QUARTER', 'ENDS IN', ...(earth ? [`${EARTH_SIGN} AT`, `${EARTH_SIGN} IN`] : [])];
  const rows = r.rungs.map((g) => [
    String(g.depth),
    g.symbol,
    engrave(g.kind),
    engrave(g.place),
    engrave(g.quarter),
    g.next?.span ?? '',
    ...(earth ? [g.next?.earth?.when ?? '', g.next?.earth?.in ?? ''] : []),
  ]);
  out.push(...table([head, ...rows], new Set([0])));
  return out.join('\n');
}

/** `fr time next`: the coming thresholds of one level, each with its stamp. */
export function formatNext(r: NextReading): string {
  const what = `${r.symbol} ${engrave(r.kind)}${r.quarter ? ` ${engrave(r.quarter)}` : ''}`;
  const out: string[] = [`NEXT THRESHOLDS OF ${what}  ·  FROM ${r.stamp}`, ''];
  const earth = r.thresholds.some((x) => x.earth);
  const head = ['QUARTER', 'CYCLE', 'AT', 'IN', ...(earth ? [`${EARTH_SIGN} AT`] : [])];
  const rows = r.thresholds.map((x) => [engrave(x.quarter), engrave(x.place), x.stamp, x.span, ...(earth ? [x.earth?.when ?? ''] : [])]);
  out.push(...table([head, ...rows]));
  if (r.ends) {
    out.push('', 'The catalogue ends here: no threshold comes later.');
  }
  return out.join('\n');
}

/** `fr time span`: the signed span and its two ends. */
export function formatSpanReading(r: SpanReading): string {
  const rows = [
    ['SPAN', r.signed, earthCell(r.earth?.duration)],
    ['FROM', r.from_stamp, earthCell(r.earth?.from)],
    ['TO', r.to_stamp, earthCell(r.earth?.to)],
  ];
  return table(rows).join('\n');
}

/** `fr time sync`: the solar sync, its Pentad and drift. */
export function formatSync(r: SyncReading): string {
  const e = r.earth;
  const rows = [
    ['SOLAR SYNC', r.number, earthCell(e?.start)],
    ['PENTAD', engrave(`${r.pentad.name}  ·  ${r.pentad.detail}`)],
    ['QUARTER', engrave(r.quarter)],
    ['DRIFT', r.drift, earthCell(e?.drift)],
    ...(r.next ? [[inLabel(r.next), r.next.span, earthCell(r.next.earth?.when)]] : []),
  ];
  const out = [r.stamp];
  if (e) {
    out.push(earthCell(e.now.line));
  }
  out.push('', ...table(rows));
  return out.join('\n');
}

/** `fr time stamp`: the stamp, and the date in words. */
export function formatStamp(r: Conversion): string {
  return [r.stamp, r.words].join('\n');
}

/** `fr time parse`: the instant a stamp names, in Unix µs and ISO (Earth forms, marked as such). */
export function formatParse(r: Conversion): string {
  const rows = [
    ['STAMP', r.stamp],
    ...(r.finest ? [['FINEST', `${r.finest.symbol} ${engrave(r.finest.name)}`]] : []),
    [`${EARTH_SIGN} UNIX µs`, r.unix_us],
    [`${EARTH_SIGN} UTC`, r.iso],
    [`${EARTH_SIGN} LOCAL`, r.local],
  ];
  return table(rows).join('\n');
}
