// The fr.buzzer panel's logic (design buzzer-b1 D9), DOM-free and tested in node: the beeps and tunes its buttons send,
// the instance's last `done` in the live ring and the words for it. The tunes are pitches and lengths on the wire, never
// shown as numbers: a person reads only their names.

import { enumWords } from './cap-words.ts';

const CAP = 'fr.buzzer';

/** A button that beeps: fr.buzzer `beep` args (the rest are the capability's defaults). */
export interface BeepPreset {
  key: string;
  words: string;
  args: { count: number; on_ms?: number; off_ms?: number };
}

/** A button that plays a tune: fr.buzzer `melody` args. */
export interface TunePreset {
  key: string;
  words: string;
  args: { freq_hz: number[]; ms: number[]; gap_ms?: number };
}

export const BEEPS: readonly BeepPreset[] = [
  { key: 'once', words: 'beep', args: { count: 1 } },
  { key: 'three', words: 'three beeps', args: { count: 3, on_ms: 80, off_ms: 80 } },
  // count 0: until STOP (or until the hub falls quiet for 10 s, BuzzerService's rule): a way to find the board
  { key: 'keep', words: 'keep beeping', args: { count: 0, on_ms: 200, off_ms: 300 } },
];

export const TUNES: readonly TunePreset[] = [
  // C6 E6 G6 C7 and back: the notes of a major chord, quick, the last held
  { key: 'chime-up', words: 'rising chime', args: { freq_hz: [1047, 1319, 1568, 2093], ms: [110, 110, 110, 330] } },
  { key: 'chime-down', words: 'falling chime', args: { freq_hz: [2093, 1568, 1319, 1047], ms: [110, 110, 110, 330] } },
  { key: 'alert', words: 'alert', args: { freq_hz: [2794, 0, 2794, 0, 2794], ms: [90, 60, 90, 60, 240], gap_ms: 0 } },
  { key: 'scale', words: 'scale', args: { freq_hz: [1047, 1175, 1319, 1397, 1568, 1760, 1976, 2093], ms: [150, 150, 150, 150, 150, 150, 150, 300] } },
];

/** The last `done` event of a device's instance in a ring of events (newest last). */
export function lastDone<E extends { device?: string; type: string; part?: string }>(ring: readonly E[], deviceId: string, instance: string): E | undefined {
  for (let i = ring.length - 1; i >= 0; i--) {
    const e = ring[i]!;
    if (e.device === deviceId && e.part === 'event' && e.type === `${instance}.done`) {
      return e;
    }
  }
  return undefined;
}

const SOUNDS = ['tone', 'beep', 'melody'] as const;
const REASONS = ['done', 'stopped', 'replaced', 'hub_lost', 'error'] as const;

/** An enum value by name or number. */
function nameOf(list: readonly string[], v: unknown): string | null {
  if (typeof v === 'number') {
    return list[v] ?? null;
  }
  return typeof v === 'string' && list.includes(v) ? v : null;
}

/** How each reason reads after "the <sound>". */
const ENDED: Readonly<Record<(typeof REASONS)[number], string>> = {
  done: 'played out',
  stopped: 'was stopped',
  replaced: 'gave way to the next sound',
  hub_lost: 'ended when the hub went quiet',
  error: 'failed: the buzzer refused',
};

/** What the last `done` says, in words ("the melody played out"), pure-safe; null for fields it cannot read. */
export function doneWords(fields: Readonly<Record<string, unknown>> | undefined): string | null {
  const sound = nameOf(SOUNDS, fields?.sound);
  const reason = nameOf(REASONS, fields?.reason) as (typeof REASONS)[number] | null;
  if (sound === null || reason === null) {
    return null;
  }
  return `the ${enumWords(CAP, 'Sound', sound)} ${ENDED[reason]}`;
}

/** The mirror's `playing`, or null before the board reported it. */
export function playingOf(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}
