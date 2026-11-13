// The Bench page's rules (HARDWARE-REVIEW §4 "Screens" 7; design wiring-w1 D4), moved here from web/bench's format.ts
// when the bench app was folded into the dashboard: the view the page's search names (?v=guide&id=…), a guide's next
// step, the parts still short, the pins as chips with the device's live values, and the diagram sanitiser. Progress is
// counted (5 of 12 steps) and drawn as light; it is never a percentage. Pure, so the tests run in node.

import type { WiringConnection, WiringShow } from '@fractonica/protocol/client';
import type { Core } from '@fractonica/time/browser';

import { fieldWords, impliedUnit, valueText } from './device-units.ts';

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

/** SVG elements a wiring diagram may hold (drawing and text only: no script, foreignObject, animation or link). */
const SVG_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textpath', 'marker', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern',
]);
/** Attributes it may keep; anything else (every on*, style, a link out) goes. */
const SVG_ATTRS = new Set([
  'id', 'class', 'viewbox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points',
  'transform', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'opacity', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'clip-rule', 'font-size', 'font-family', 'font-weight', 'text-anchor',
  'dominant-baseline', 'dx', 'dy', 'rotate', 'textlength', 'lengthadjust', 'marker-start', 'marker-mid', 'marker-end',
  'markerwidth', 'markerheight', 'refx', 'refy', 'orient', 'markerunits', 'preserveaspectratio', 'offset', 'stop-color',
  'stop-opacity', 'gradientunits', 'gradienttransform', 'patternunits', 'clip-path', 'mask', 'href', 'xlink:href',
  'startoffset', 'xmlns', 'xmlns:xlink', 'version', 'role', 'aria-label', 'aria-hidden', 'vector-effect', 'data-ink',
]);

/** A diagram's own colour (a hex fill or stroke) becomes a mark the page inks from the tokens (bench.css). */
function inkOf(name: string, value: string): string | null {
  return (name === 'fill' || name === 'stroke') && /^#[0-9a-f]{3,8}$/i.test(value.trim()) ? name : null;
}

/** A reference inside the file only: "#id", "url(#id)". */
function insideRef(value: string): boolean {
  const v = value.trim();
  return v.startsWith('#') || (/^url\(/i.test(v) && /^url\(\s*['"]?#/i.test(v));
}

/**
 * An SVG the page may inline: parsed (DOMParser) and rebuilt from an allowlist of drawing elements and attributes, so
 * no script, handler, animation, foreignObject, style or reference outside the file survives, whatever its spelling;
 * the hub refuses the worst already (catalog.ts svgProblem). The diagram's own colours (a hex fill or stroke) are
 * dropped, so the page draws it in the hub's engraving: every colour then comes from the tokens (bench.css). Without a
 * DOM (the tests in node) a stricter text pass does the same.
 */
export function sanitizeSvg(svg: string, parser: { parseFromString(s: string, type: 'image/svg+xml'): Document } | null = typeof DOMParser === 'undefined' ? null : new DOMParser()): string {
  if (!parser) {
    return sanitizeSvgText(svg);
  }
  const doc = parser.parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.localName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length) {
    return '';
  }
  const walk = (el: Element): void => {
    for (const child of [...el.children]) {
      if (!SVG_ELEMENTS.has(child.localName.toLowerCase())) {
        child.remove();
        continue;
      }
      walk(child);
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const ink = inkOf(name, attr.value);
      if (ink) {
        el.removeAttribute(attr.name);
        el.setAttribute('data-ink', ink);
        continue;
      }
      const ref = name === 'href' || name === 'xlink:href' || attr.value.includes('url(');
      if (!SVG_ATTRS.has(name) || name.startsWith('on') || (ref && !insideRef(attr.value))) {
        el.removeAttribute(attr.name);
      }
    }
  };
  walk(root);
  return new XMLSerializer().serializeToString(root);
}

/** The text pass: what must go, removed until nothing more changes (a nested "javajavascript:script:" included). */
export function sanitizeSvgText(svg: string): string {
  let t = svg
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_m, d: string) => String.fromCodePoint(Number(d)));
  for (let i = 0; i < 8; i++) {
    const before = t;
    t = t
      .replace(/<\?xml[^>]*\?>/gi, '')
      .replace(/<!DOCTYPE[^>]*>/gi, '')
      .replace(/<(script|foreignObject|style|animate\w*|set|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<(script|foreignObject|style|animate\w*|set|iframe|object|embed)\b[^>]*>/gi, '')
      .replace(/(^|[\s/"'])on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '$1')
      .replace(/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/gi, '')
      .replace(/\s(?:xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*'|(?!["'#])[^\s>]+)/gi, '')
      .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    if (t === before) {
      break;
    }
  }
  return t
    .replace(/\s(fill|stroke)\s*=\s*"#[0-9a-f]{3,8}"/gi, (_m, attr: string) => ` data-ink="${attr.toLowerCase()}"`)
    .replace(/(<[^<>]*?)\s+(\/?>)/g, '$1$2')
    .replace(/(<[^<>]*?\S)\s{2,}/g, '$1 ')
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

/**
 * One live value as a short text, in the mode's units (state/device-units.ts): a member's words without an Earth unit
 * ("mv" → "voltage"), a number as the core says it (a time as a span, a physical quantity as the bare count), and in
 * Earth mode its value in its unit after ⊕ ("voltage 3 912 ⊕ 3 912 mV"); booleans on or off, names as they are.
 */
export function liveText(core: Core | null, member: string, v: unknown, earth = false): string {
  const words = fieldWords(member);
  if (typeof v === 'number') {
    const t = valueText(core, Math.round(v * 100) / 100, impliedUnit(member));
    return `${words} ${t.text || '·'}${earth && t.earth ? ` ⊕ ${t.earth}` : ''}`;
  }
  if (typeof v === 'boolean') {
    return `${words} ${v ? 'on' : 'off'}`;
  }
  return `${words} ${typeof v === 'string' ? v : JSON.stringify(v)}`;
}

/** The live values of one instance from a device's mirror (`<instance>.<member>` -> value), as texts (liveText). */
export function instanceLive(properties: Record<string, unknown> | null | undefined, instance: string, max = 3, say: (member: string, v: unknown) => string = (m, v) => liveText(null, m, v)): string[] {
  if (!properties) {
    return [];
  }
  const out: string[] = [];
  for (const [k, raw] of Object.entries(properties)) {
    if (k.startsWith(`${instance}.`) && out.length < max) {
      const member = k.slice(instance.length + 1);
      // the live store keeps {value, t_hub_us}; device_get's router mirror keeps the value itself
      const v = raw && typeof raw === 'object' && 'value' in (raw as object) && 't_hub_us' in (raw as object) ? (raw as { value: unknown }).value : raw;
      out.push(say(member, v));
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
