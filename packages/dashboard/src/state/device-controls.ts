// Typed controls generated from the catalog (HARDWARE-REVIEW §4 "Screens" 3: capabilities as rows with typed controls,
// no raw JSON). DOM-free and tested in node.
//
// - controlFor: a command field's control from its catalog type: a toggle (bool), a slider (a ranged or small
//   integer), a number (a wide integer), a colour well (rgb), a select (an enum of the capability's `types`), text
//   (string), hex bytes, a list of numbers (array<u16>), or a message (a JSON layout, kept behind a fold).
// - buildArgs: the args a command form sends: required fields always, optional ones only once touched; each value
//   checked against its type (hex for bytes, an integer in range, decimal strings for u64).
// - propertyLink: a property that a command sets (fr.led `set {on, brightness, color}`, fr.audio_out
//   `set_volume {volume}`, fr.display `set_brightness {level}`) becomes the control on its own row; the command's
//   other required fields are filled from the property mirror. A command whose every field is a linked property is
//   then not shown again as a form (coveredCommands).

import type { CatalogCapability, CatalogCommand, CatalogField, CatalogProperty } from '@fractonica/protocol/gen';

import { enumWords, memberWords } from './cap-words.ts';
import { unitInfo } from './device-units.ts';

export type ControlKind = 'toggle' | 'slider' | 'number' | 'colour' | 'select' | 'text' | 'bytes' | 'list' | 'message';

/** An enum's member: its name is the value sent (the wire takes names, DEVICE-SPEC G2), its words the label. */
export interface ControlOption {
  value: string;
  label: string;
  /** The member's number (a property mirror may report it as one). */
  num: number;
}

export interface ControlSpec {
  name: string;
  /** The field's words (an Earth unit dropped from the name). */
  label: string;
  kind: ControlKind;
  /** The catalog type (u8, rgb, Gesture, …). */
  type: string;
  min?: number;
  max?: number;
  options?: ControlOption[];
  unit?: string;
  optional: boolean;
  default?: unknown;
  /** bytes and string: the longest. */
  maxLength?: number;
  /** list: the most numbers it takes (each between min and max, its element type's range). */
  maxItems?: number;
  doc?: string;
}

/** The integer types' ranges; u64 is sent as a decimal string. */
export const INT_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  u8: [0, 255],
  i8: [-128, 127],
  u16: [0, 65_535],
  i16: [-32_768, 32_767],
  u32: [0, 4_294_967_295],
  i32: [-2_147_483_648, 2_147_483_647],
  u64: [0, Number.MAX_SAFE_INTEGER],
};

/** A slider up to this many steps; a wider integer is typed. */
export const SLIDER_MAX_STEPS = 100_000;

export function isNumericType(type: string): boolean {
  return type in INT_RANGES || type === 'f32' || type === 'f64';
}

/** The enum options of a capability type, in member order: the name is the value, the words the label. */
export function enumOptions(cap: Pick<CatalogCapability, 'types'> & { name?: string }, type: string): ControlOption[] | null {
  const t = cap.types[type];
  if (!t) {
    return null;
  }
  return Object.entries(t)
    .map(([name, num]) => ({ value: name, label: enumWords(cap.name ?? '', type, name), num }))
    .sort((a, b) => a.num - b.num);
}

/** An enum value as its member name: a name stays, a number becomes its name; null when it names no member. */
export function enumName(options: readonly ControlOption[], v: unknown): string | null {
  if (typeof v === 'number') {
    return options.find((o) => o.num === v)?.value ?? null;
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^\d+$/.test(t)) {
      return options.find((o) => o.num === Number(t))?.value ?? null;
    }
    return options.find((o) => o.value === t)?.value ?? null;
  }
  return null;
}

export function controlFor(field: CatalogField | (CatalogProperty & { optional?: boolean; default?: unknown }), cap: Pick<CatalogCapability, 'types' | 'messages'> & { name?: string }): ControlSpec {
  const w = memberWords(cap.name ?? '', field);
  const base = {
    name: field.name,
    label: w.words,
    type: field.type,
    optional: 'optional' in field ? field.optional === true : false,
    ...('default' in field && field.default !== undefined ? { default: field.default } : {}),
    ...(w.unit ? { unit: w.unit } : {}),
    ...(field.doc ? { doc: field.doc.trim() } : {}),
  };
  const options = enumOptions(cap, field.type);
  if (options) {
    return { ...base, kind: 'select', options };
  }
  if (field.type === 'bool') {
    return { ...base, kind: 'toggle' };
  }
  if (field.type === 'rgb') {
    return { ...base, kind: 'colour' };
  }
  if (field.type === 'string') {
    return { ...base, kind: 'text', ...(field.max ? { maxLength: field.max } : {}) };
  }
  if (field.type === 'bytes') {
    return { ...base, kind: 'bytes', ...(field.max ? { maxLength: field.max } : {}) };
  }
  if (field.type.startsWith('array<')) {
    const range = INT_RANGES[field.type.slice('array<'.length, -1)];
    return { ...base, kind: 'list', ...(range ? { min: range[0], max: range[1] } : {}), ...(field.max ? { maxItems: field.max } : {}) };
  }
  if (cap.messages?.[field.type]) {
    return { ...base, kind: 'message' };
  }
  const range = field.range ?? INT_RANGES[field.type];
  if (range) {
    const [min, max] = range;
    // a share (%) is always a slider: it is light, never a typed number
    const slider = max - min <= SLIDER_MAX_STEPS && (field.range !== undefined || field.type === 'u8' || field.type === 'i8' || unitInfo(field.unit).cls === 'share');
    return { ...base, kind: slider ? 'slider' : 'number', min, max };
  }
  return { ...base, kind: 'text' };
}

/** A colour (0xRRGGBB) as the colour well's "#rrggbb", and back. */
export function colourHex(n: number): string {
  const v = Number.isFinite(n) ? Math.min(0xffffff, Math.max(0, Math.round(n))) : 0;
  return `#${v.toString(16).padStart(6, '0')}`;
}

export function hexColour(s: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  return m ? parseInt(m[1]!, 16) : null;
}

/**
 * The value a control starts with (DEVICE-SPEC G4): the property mirror's, else the field's default, else empty. An
 * example is never a value. A select's value is always a member name (a number from a mirror becomes its name). A
 * colour well starts white (it has no empty state); a switch whose state is not known is undefined, shown as "not
 * reported yet" and sent as off unless it is switched.
 */
export function initialValue(spec: ControlSpec, mirror?: unknown): unknown {
  const pick = mirror !== undefined && mirror !== null ? mirror : spec.default;
  if (spec.kind === 'select') {
    return pick === undefined ? '' : (enumName(spec.options ?? [], pick) ?? '');
  }
  if (pick !== undefined) {
    return pick;
  }
  switch (spec.kind) {
    case 'toggle':
      return undefined;
    case 'colour':
      return 0xffffff;
    default:
      return '';
  }
}

/** True when a control holds nothing yet (a switch and a colour well are never empty). */
export function isBlank(spec: ControlSpec, v: unknown): boolean {
  if (spec.kind === 'toggle' || spec.kind === 'colour' || spec.kind === 'bytes' || spec.kind === 'list') {
    return false;
  }
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/** The words of the required fields still empty: the form's button waits for them ("Fill in recording first"). */
export function missingFields(specs: readonly ControlSpec[], values: Readonly<Record<string, unknown>>): string[] {
  return specs.filter((s) => !s.optional && isBlank(s, values[s.name])).map((s) => s.label);
}

/** "recording", "x and y", "x, y and text". */
export function wordList(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** The form's values to start with (G4): a field that shadows a property takes the mirror, then its default, then empty. */
export function seedValues(specs: readonly ControlSpec[], properties: readonly Pick<CatalogProperty, 'name' | 'type'>[], mirror: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(specs.map((s) => [s.name, initialValue(s, properties.some((p) => p.name === s.name && p.type === s.type) ? mirror[s.name] : undefined)]));
}

export type ArgCheck = { ok: true; value: unknown } | { ok: false; error: string };

/** A control's value as the hub takes it, or why not. */
export function argValue(spec: ControlSpec, raw: unknown): ArgCheck {
  switch (spec.kind) {
    case 'toggle':
      return { ok: true, value: raw === true };
    case 'colour': {
      const n = typeof raw === 'string' ? hexColour(raw) : typeof raw === 'number' ? raw : null;
      return n === null || n < 0 || n > 0xffffff ? { ok: false, error: 'a colour' } : { ok: true, value: n };
    }
    case 'select': {
      // by name (G2): the member's name is sent; a number is taken as its member
      const name = enumName(spec.options ?? [], raw);
      return name !== null ? { ok: true, value: name } : { ok: false, error: `choose one of ${(spec.options ?? []).map((o) => o.label).join(', ')}` };
    }
    case 'slider':
    case 'number': {
      const text = typeof raw === 'string' ? raw.trim() : raw === undefined || raw === null ? '' : String(raw);
      if (text === '') {
        return { ok: false, error: `fill in ${spec.label}` };
      }
      if (!/^-?\d+$/.test(text)) {
        return { ok: false, error: 'whole numbers only, no fractions' };
      }
      const n = Number(text);
      if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) {
        return { ok: false, error: `between ${spec.min} and ${spec.max}` };
      }
      return { ok: true, value: spec.type === 'u64' ? text : n };
    }
    case 'bytes': {
      const hex = String(raw ?? '').replace(/[\s:]/g, '').toLowerCase();
      if (!/^([0-9a-f]{2})*$/.test(hex)) {
        return { ok: false, error: 'hex bytes, two digits each' };
      }
      if (spec.maxLength && hex.length / 2 > spec.maxLength) {
        return { ok: false, error: `at most ${spec.maxLength} bytes` };
      }
      return { ok: true, value: hex };
    }
    case 'list': {
      const parts = String(raw ?? '')
        .split(/[\s,]+/)
        .filter(Boolean);
      if (parts.some((p) => !/^\d+$/.test(p))) {
        return { ok: false, error: 'whole numbers, separated by commas' };
      }
      if (spec.maxItems !== undefined && parts.length > spec.maxItems) {
        return { ok: false, error: `at most ${spec.maxItems} numbers` };
      }
      const nums = parts.map(Number);
      if (spec.max !== undefined && nums.some((n) => n > spec.max! || (spec.min !== undefined && n < spec.min))) {
        return { ok: false, error: `each between ${spec.min ?? 0} and ${spec.max}` };
      }
      return { ok: true, value: nums };
    }
    case 'message': {
      if (typeof raw === 'object' && raw !== null) {
        return { ok: true, value: raw };
      }
      try {
        const v: unknown = JSON.parse(String(raw));
        return typeof v === 'object' && v !== null && !Array.isArray(v) ? { ok: true, value: v } : { ok: false, error: 'a JSON object' };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
    default: {
      const s = String(raw ?? '');
      return spec.maxLength && s.length > spec.maxLength ? { ok: false, error: `at most ${spec.maxLength} characters` } : { ok: true, value: s };
    }
  }
}

export type BuiltArgs = { ok: true; args: Record<string, unknown> } | { ok: false; errors: Record<string, string> };

/** A command form's args: required fields always, optional fields only once touched. */
export function buildArgs(specs: readonly ControlSpec[], values: Readonly<Record<string, unknown>>, touched: ReadonlySet<string>): BuiltArgs {
  const args: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const s of specs) {
    if (s.optional && !touched.has(s.name)) {
      continue;
    }
    if (isBlank(s, values[s.name])) {
      errors[s.name] = `fill in ${s.label}`;
      continue;
    }
    const r = argValue(s, values[s.name]);
    if (r.ok) {
      args[s.name] = r.value;
    } else {
      errors[s.name] = r.error;
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, args };
}

export interface PropertyLink {
  property: string;
  command: string;
  /** The command field that carries the property's value. */
  field: string;
  /** Other required fields of the command, filled from these properties of the mirror. */
  fill: string[];
}

/** The command that sets a property, if the catalog has one the hub can send with the mirror's help. */
export function propertyLink(cap: Pick<CatalogCapability, 'properties'>, commands: readonly CatalogCommand[], prop: CatalogProperty): PropertyLink | null {
  const props = new Set(cap.properties.map((p) => p.name));
  const candidates: { cmd: CatalogCommand; field: CatalogField }[] = [];
  for (const cmd of commands) {
    if (cmd.visibility !== 'public') {
      continue;
    }
    const same = cmd.fields.find((f) => f.name === prop.name && f.type === prop.type);
    if (same && (cmd.name === 'set' || cmd.name === `set_${prop.name}`)) {
      candidates.push({ cmd, field: same });
    } else if (cmd.name === `set_${prop.name}` && cmd.fields.length === 1 && cmd.fields[0]!.type === prop.type) {
      candidates.push({ cmd, field: cmd.fields[0]! });
    }
  }
  for (const { cmd, field } of candidates) {
    const others = cmd.fields.filter((f) => f !== field && !f.optional);
    if (others.every((f) => props.has(f.name) && cap.properties.find((p) => p.name === f.name)?.type === f.type)) {
      return { property: prop.name, command: cmd.name, field: field.name, fill: others.map((f) => f.name) };
    }
  }
  return null;
}

/** A linked property's command args: its value, and the other required fields from the mirror. */
export function linkArgs(link: PropertyLink, value: unknown, mirror: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const args: Record<string, unknown> = { [link.field]: value };
  for (const f of link.fill) {
    if (mirror[f] !== undefined) {
      args[f] = mirror[f];
    }
  }
  return args;
}

/** Commands every field of which is a linked property's: the property rows are their controls. */
export function coveredCommands(commands: readonly CatalogCommand[], links: readonly PropertyLink[]): Set<string> {
  const out = new Set<string>();
  for (const cmd of commands) {
    const mine = links.filter((l) => l.command === cmd.name);
    if (cmd.fields.length > 0 && mine.length && cmd.fields.every((f) => mine.some((l) => l.field === f.name) || mine.some((l) => l.fill.includes(f.name)))) {
      out.add(cmd.name);
    }
  }
  return out;
}

/** A property value made a number for a sparkline (booleans 0/1); null for anything else. */
export function numericOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  return null;
}
