// A device's instruments as the device pages show them (DEVICE-SPEC §1.3–§1.5): the word for each capability (LIGHT,
// CAMERA, ANALOG INPUT …), the Overview's rows with many instances of one capability folded into one group, the
// caption of an instrument page in words, and the Activity page's filter by instrument. DOM-free, tested in node.

import { enumWords } from './cap-words.ts';
import { fieldWords } from './device-units.ts';

/** Each capability's word, lower case (the pages write it in caps). Test: every capability in schema/ has one. */
const CAP_WORDS: Readonly<Record<string, string>> = {
  'fr.led': 'light',
  'fr.camera': 'camera',
  'fr.button': 'button',
  'fr.analog_in': 'analog input',
  'fr.display': 'display',
  'fr.audio_out': 'speaker',
  'fr.audio_in': 'microphone',
  'fr.touch': 'touch',
  'fr.csi': 'wi-fi sensing',
  'fr.radio_tx': 'radio sender',
  'fr.scale': 'scale',
  'fr.battery': 'battery',
  'fr.haptic': 'haptic',
  'fr.storage': 'card',
  'fr.clock': 'clock',
  'fr.stepper': 'stepper',
  'fr.buzzer': 'buzzer',
  'fr.fixture': 'test fixture',
  'fr.node': 'the board',
  'fr.ota': 'updates',
  'fr.diag': 'diagnostics',
  'fr.face': 'face',
};

/** A capability's word ("camera"); an unknown one is its name without the `fr.` and with spaces. */
export function capWord(cap: string): string {
  return CAP_WORDS[cap] ?? cap.replace(/^fr\./, '').replace(/_/g, ' ');
}

/** True when the table has a word for the capability. */
export function hasCapWord(cap: string): boolean {
  return CAP_WORDS[cap] !== undefined;
}

/** How many instances of one capability fold into one group row. */
export const GROUP_AT = 4;

export type InstrumentItem<T extends { inst: { name: string; cap: string } }> =
  | { kind: 'one'; row: T }
  | { kind: 'group'; cap: string; rows: T[]; label: string };

/**
 * The Overview's rows in order (the rows come in port order): an instrument alone, or, when a capability has at least
 * GROUP_AT instances, one group at the place of its first, labelled "ch0 – ch13".
 */
export function groupInstruments<T extends { inst: { name: string; cap: string } }>(rows: readonly T[]): InstrumentItem<T>[] {
  const count = new Map<string, number>();
  for (const r of rows) {
    count.set(r.inst.cap, (count.get(r.inst.cap) ?? 0) + 1);
  }
  const out: InstrumentItem<T>[] = [];
  const groups = new Map<string, Extract<InstrumentItem<T>, { kind: 'group' }>>();
  for (const r of rows) {
    if ((count.get(r.inst.cap) ?? 0) < GROUP_AT) {
      out.push({ kind: 'one', row: r });
      continue;
    }
    let g = groups.get(r.inst.cap);
    if (!g) {
      g = { kind: 'group', cap: r.inst.cap, rows: [], label: '' };
      groups.set(r.inst.cap, g);
      out.push(g);
    }
    g.rows.push(r);
  }
  for (const g of groups.values()) {
    g.label = `${g.rows[0]!.inst.name} – ${g.rows[g.rows.length - 1]!.inst.name}`;
  }
  return out;
}

/** Traits whose value says it all ("one colour", not "colour mono"); an empty word says nothing (the usual case). */
const TRAIT_WORDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'fr.led.color': { mono: 'one colour', rgb: 'full colour', '0': 'one colour', '1': 'full colour' },
  'fr.led.dimmable': { true: 'dimmable', false: '' },
};

/**
 * An instrument's traits in words for its caption ("ov2640 · up to uxga"): the camera's sensor and largest frame,
 * else each true flag's words and each other value after its words; at most three.
 */
export function traitWords(cap: string, traits: Record<string, unknown> | null | undefined): string[] {
  if (!traits) {
    return [];
  }
  if (cap === 'fr.camera') {
    const out: string[] = [];
    const sensor = traits.sensor;
    if (sensor === 1 || sensor === 'ov2640') {
      out.push('ov2640');
    }
    const max = traits.max_frame_size;
    const sizes = ['qvga', 'vga', 'svga', 'xga', 'sxga', 'uxga'];
    const name = typeof max === 'number' ? sizes[max] : typeof max === 'string' ? max : undefined;
    if (name) {
      out.push(`up to ${name}`);
    }
    return out;
  }
  // fr.buzzer (design buzzer-b1 D9): whether it plays pitches and sets its volume; its pitch range is in Hz, never a
  // bare number in a caption
  if (cap === 'fr.buzzer') {
    return [traits.pitched === false ? 'one pitch' : 'plays pitches', ...(traits.volume === true ? ['sets its volume'] : [])];
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(traits)) {
    const said = TRAIT_WORDS[`${cap}.${k}`]?.[String(v)];
    if (said !== undefined) {
      if (said) {
        out.push(said);
      }
    } else if (v === true) {
      out.push(fieldWords(k));
    } else if (typeof v === 'string' && v) {
      out.push(`${fieldWords(k)} ${enumWords(cap, '', v)}`);
    } else if (typeof v === 'number' && Number.isInteger(v)) {
      out.push(`${fieldWords(k)} ${v}`);
    }
  }
  return out.slice(0, 3);
}

/** An instrument page's caption: "camera · port 3 · ov2640 · up to uxga". */
export function captionWords(inst: { cap: string; port: number; traits: Record<string, unknown> | null }): string {
  return [capWord(inst.cap), `port ${inst.port}`, ...traitWords(inst.cap, inst.traits)].join(' · ');
}

/**
 * The instance an event belongs to: for the hub's own words about one (stream.started / stream.ended, op.called) its
 * `instance` field (or the instance of an `<instance>.<command>`), else the part of its type before the first dot
 * ("cam.stream_ended" → "cam").
 */
export function eventInstance(type: string, fields?: Readonly<Record<string, unknown>> | null): string | null {
  if (type.startsWith('stream.') || type === 'op.called') {
    if (typeof fields?.instance === 'string') {
      return fields.instance;
    }
    const cmd = fields?.command;
    return typeof cmd === 'string' && cmd.indexOf('.') > 0 ? cmd.slice(0, cmd.indexOf('.')) : null;
  }
  const dot = type.indexOf('.');
  return dot > 0 ? type.slice(0, dot) : null;
}

type RingEvent = { device?: string; type: string; fields?: Readonly<Record<string, unknown>> | undefined };

/**
 * A device's events in a ring (newest last), newest first, at most `max`, only those of `instrument` when one is
 * chosen (an event of the hub's own about the device, `device.online`, belongs to no instrument). A camera's own word
 * that a stream ended (`cam.stream_ended`) is left out when the hub's stream.ended of that stream is in the ring: that
 * row says the same end, with what the stream was for and its frames.
 */
export function deviceEvents<E extends RingEvent>(ring: readonly E[], deviceId: string, instrument: string | null, max = 50): E[] {
  const told = new Set<string>();
  for (const e of ring) {
    if (e.device === deviceId && e.type === 'stream.ended' && typeof e.fields?.stream_id === 'number') {
      told.add(`${String(e.fields.instance)}:${e.fields.stream_id}`);
    }
  }
  const out: E[] = [];
  for (let i = ring.length - 1; i >= 0 && out.length < max; i--) {
    const e = ring[i]!;
    if (e.device !== deviceId || (instrument !== null && eventInstance(e.type, e.fields) !== instrument)) {
      continue;
    }
    if (e.type.endsWith('.stream_ended') && typeof e.fields?.stream_id === 'number' && told.has(`${e.type.slice(0, -'.stream_ended'.length)}:${e.fields.stream_id}`)) {
      continue; // the device's echo of a stream.ended already shown
    }
    out.push(e);
  }
  return out;
}
