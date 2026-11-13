// The Bench page's rules (HARDWARE-REVIEW §4 "Screens" 7; design wiring-w1 D4), moved here from web/bench's format.ts
// when the bench app was folded into the dashboard: the view the page's search names (?v=guide&id=…), a guide's next
// step, the parts still short, the pins as chips with the device's live values, and the diagram sanitiser. Progress is
// counted (5 of 12 steps) and drawn as light; it is never a percentage. Pure, so the tests run in node.

import type { WiringConnection, WiringShow } from '@fractonica/protocol/client';

export type BenchRoute = { view: 'guides' } | { view: 'guide'; id: string } | { view: 'parts' } | { view: 'part'; id: string } | { view: 'shopping' };

export type BenchView = BenchRoute['view'];

/** The view the /bench route's search names (`?v=guide&id=clock-lcd-c6`); the guides by default. */
export function benchRoute(search: Record<string, unknown> | undefined): BenchRoute {
  const v = typeof search?.v === 'string' ? search.v : '';
  const id = typeof search?.id === 'string' ? search.id : typeof search?.id === 'number' ? String(search.id) : '';
  switch (v) {
    case 'guide':
      return id ? { view: 'guide', id } : { view: 'guides' };
    case 'part':
      return id ? { view: 'part', id } : { view: 'parts' };
    case 'parts':
      return { view: 'parts' };
    case 'shopping':
      return { view: 'shopping' };
    default:
      return { view: 'guides' };
  }
}

/** The search of a view (what a Link to /bench carries). */
export function benchSearch(r: BenchRoute): { v: string; id?: string } {
  return r.view === 'guide' || r.view === 'part' ? { v: r.view, id: r.id } : { v: r.view };
}

/** The tab a view belongs to (a guide is under Guides, a part under Parts). */
export function benchTab(r: BenchRoute): 'guides' | 'parts' | 'shopping' {
  return r.view === 'guide' ? 'guides' : r.view === 'part' ? 'parts' : r.view;
}

/**
 * An SVG the page may inline: the hub refuses scripts and external references already (catalog.ts svgProblem); this
 * strips what is left that could run or reach out (script and foreignObject elements, on* handlers such as a chat
 * diagram's onclick, javascript: URLs) and the XML prolog, so innerHTML of the result is inert. It also drops the
 * diagram's own colours (a fill or stroke written as a hex value or a chat colour class's variable), so the page draws
 * it in the hub's engraving: every colour then comes from the tokens (bench.css).
 */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<\?xml[^>]*\?>/gi, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script[^>]*\/>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/\s(fill|stroke)\s*=\s*"#[0-9a-f]{3,8}"/gi, (_m, attr: string) => ` data-ink="${attr.toLowerCase()}"`)
    .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .trim();
}

/** The instances a guide's pins belong to (pin -> instance), from its pin table. */
export function pinInstances(connections: readonly Pick<WiringConnection, 'pin' | 'instance'>[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of connections) {
    if (c.instance && !m.has(c.pin)) {
      m.set(c.pin, c.instance);
    }
  }
  return m;
}

/** One live value as a short text: numbers as they are (mV as volts), booleans on/off, names as they are. */
export function liveText(member: string, v: unknown): string {
  if (typeof v === 'number') {
    return member.endsWith('mv') ? `${(v / 1000).toFixed(2)} V` : String(Math.round(v * 100) / 100);
  }
  if (typeof v === 'boolean') {
    return v ? 'on' : 'off';
  }
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** The live values of one instance from a device's mirror (`<instance>.<member>` -> value), as `member value` texts. */
export function instanceLive(properties: Record<string, unknown> | null | undefined, instance: string, max = 3): string[] {
  if (!properties) {
    return [];
  }
  const out: string[] = [];
  for (const [k, raw] of Object.entries(properties)) {
    if (k.startsWith(`${instance}.`) && out.length < max) {
      const member = k.slice(instance.length + 1);
      // the live store keeps {value, t_hub_us}; device_get's router mirror keeps the value itself
      const v = raw && typeof raw === 'object' && 'value' in (raw as object) && 't_hub_us' in (raw as object) ? (raw as { value: unknown }).value : raw;
      out.push(`${member} ${liveText(member, v)}`);
    }
  }
  return out;
}

/** The guide's first step not done (null when all are). */
export function nextStep(g: Pick<WiringShow, 'sections'>): { section: string; step: string } | null {
  for (const s of g.sections) {
    for (const st of s.steps) {
      if (!st.done) {
        return { section: s.id, step: st.id };
      }
    }
  }
  return null;
}

/** BOM lines still short, as `n × name value`. */
export function missingText(bom: readonly Pick<WiringShow['bom'][number], 'missing' | 'name' | 'value'>[]): string[] {
  return bom.filter((b) => b.missing > 0).map((b) => `${b.missing} × ${b.name}${b.value ? ` ${b.value}` : ''}`);
}

/** Steps done of the steps there are, as words ("5 of 12 steps", "all 12 steps", "no steps"). */
export function stepsText(done: number, total: number): string {
  if (total <= 0) {
    return 'no steps';
  }
  const d = Math.min(Math.max(0, done), total);
  if (d === total) {
    return total === 1 ? 'the one step done' : `all ${total} steps done`;
  }
  return `${d} of ${total} step${total === 1 ? '' : 's'} done`;
}

/** The parts search: id, name or summary contains the words (case-insensitive). */
export function partMatches(p: { id: string; name: string; summary: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || p.id.includes(q) || p.name.toLowerCase().includes(q) || p.summary.toLowerCase().includes(q);
}

/** A stock quantity typed by a person: a whole number, 0 or more, else null. */
export function parseQty(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) {
    return null;
  }
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}
