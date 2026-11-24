// The fr.haptic panel's logic (design haptic-h1 D11), DOM-free and tested in node: what the panel knows of an instance's
// build (its kind and limits, from capability_list's config, else the kind's defaults), the tap train's checks (the
// node's cooldown-budget rule, shared with the hub and the fake), the owner's named patterns and the metronome as the
// commands they send, the sender that keeps live changes to at most five a second, the supply's reading, and the words
// for how a program ended or why the board refused. Every sentence here is pure-safe: the numbers a person reads (a
// rate, a length, a voltage) are put on the page by the panel, as Fractonica spans with their Earth line.

import { HAPTIC_KIND_DEFAULTS, type HapticKind, hapticLongestTap, hapticTrainFits } from '@fractonica/protocol/client';

/** The firmware's defaults for a solenoid's kick and hold (haptic.cap.yaml config). */
const KICK_MS = 30;
const HOLD_PCT = 40;
/** A solenoid starts only this far above its supply's critical level (HapticService::kSolenoidMarginMv). */
export const SOLENOID_MARGIN_MV = 300;

/** What the panel knows of an instance's build. */
export interface HapticLimits {
  /** null: the build's config is not known (firmware the hub did not build): the solenoid's limits, the safe side. */
  kind: HapticKind | null;
  max_on_ms: number;
  cooldown_pct: number;
  kick_ms: number;
  hold_pct: number;
  rated_mv: number;
  /** The fr.battery instance it draws from, or null. */
  supply: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** An instance's kind and limits from its build's config (capability_list), each 0 or missing as the firmware reads it. */
export function hapticLimits(config: Readonly<Record<string, unknown>> | undefined | null): HapticLimits {
  const k = config?.kind;
  const kind: HapticKind | null = k === 'solenoid' || k === 1 ? 'solenoid' : k === 'erm' || k === 0 ? 'erm' : config ? 'erm' : null;
  const d = HAPTIC_KIND_DEFAULTS[kind ?? 'solenoid'];
  const maxOn = num(config?.max_on_ms);
  const cool = num(config?.cooldown_pct);
  const supply = typeof config?.supply === 'string' && config.supply ? config.supply : null;
  return {
    kind,
    max_on_ms: maxOn && maxOn > 0 ? maxOn : d.max_on_ms,
    cooldown_pct: cool && cool > 0 ? cool : d.cooldown_pct,
    kick_ms: num(config?.kick_ms) ?? KICK_MS,
    hold_pct: num(config?.hold_pct) ?? HOLD_PCT,
    rated_mv: num(config?.rated_mv) ?? 3000,
    supply,
  };
}

/** The budget in ms of any 10 s (Infinity without one). */
export function budgetMs(l: HapticLimits): number {
  return l.cooldown_pct >= 100 ? Infinity : l.cooldown_pct * 100;
}

// ---- the tap train ----

/** The rate slider: taps a second, in halves, half a tap a second to twenty-five. */
export const RATE_MIN_HZ = 0.5;
export const RATE_MAX_HZ = 25;
export const RATE_STEP_HZ = 0.5;
/** The count choices: once, a few, until stopped (0). */
export const COUNTS: readonly { value: number; words: string }[] = [
  { value: 1, words: 'once' },
  { value: 2, words: 'twice' },
  { value: 5, words: 'five times' },
  { value: 10, words: 'ten times' },
  { value: 0, words: 'until stopped' },
];
/** The panel's first settings: four taps a second, strength 70, 15 ms taps, until stopped (the bench's first train). */
export const TAP_DEFAULTS = { hz: 4, level: 70, ms: 15, count: 0 } as const;

/** A rate (taps a second) as the node's period in whole ms. */
export function periodOf(hz: number): number {
  return Math.max(20, Math.round(1000 / hz));
}

/** The longest a tap-length slider goes: below the period at the slowest rate, at most max_on_ms, never past a second. */
export function lengthMax(l: HapticLimits): number {
  return Math.min(l.max_on_ms, 1000);
}

export type TapCheck = { ok: true } | { ok: false; why: 'period' | 'max_on' | 'budget'; longest: number };

/** Whether the node takes a train of `ms` every `periodMs` (HapticService::tap's INVALID_ARGS rules), and the longest that fits. */
export function tapCheck(periodMs: number, ms: number, l: HapticLimits): TapCheck {
  const longest = hapticLongestTap(periodMs, l.max_on_ms, l.cooldown_pct);
  if (ms >= periodMs) {
    return { ok: false, why: 'period', longest };
  }
  if (ms > l.max_on_ms) {
    return { ok: false, why: 'max_on', longest };
  }
  if (!hapticTrainFits(periodMs, ms, l.cooldown_pct)) {
    return { ok: false, why: 'budget', longest };
  }
  return { ok: true };
}

/** What a refused train is, in words (the panel adds the longest tap that fits, as a span). */
export function tapCheckWords(c: Exclude<TapCheck, { ok: true }>): string {
  switch (c.why) {
    case 'period':
      return 'each tap needs a break before the next: at this rate a tap can be';
    case 'max_on':
      return 'longer than it may stay on: a tap can be';
    case 'budget':
      return 'more on-time than its budget allows: at this rate a tap can be';
  }
}

export interface TapArgs {
  period_ms: number;
  ms: number;
  level: number;
  count: number;
  accent: number;
  accent_level: number;
}

/** fr.haptic tap's args for the panel's settings. */
export function tapArgs(o: { hz: number; ms: number; level: number; count: number; accent?: number; accentLevel?: number }): TapArgs {
  return { period_ms: periodOf(o.hz), ms: Math.round(o.ms), level: Math.round(o.level), count: o.count, accent: o.accent ?? 0, accent_level: Math.round(o.accentLevel ?? 100) };
}

// ---- named patterns (the owner's, 2026-11-21) ----

export interface HapticSend {
  command: 'pulse' | 'play' | 'tap' | 'stop';
  args: Record<string, unknown>;
}

export interface PatternButton {
  key: string;
  words: string;
  /** What it sends, or null when the board would refuse it at these settings (`why` says why). */
  send: HapticSend | null;
  why?: string;
}

/** A pattern's refusal at the solenoid's limits: an on-step past max_on, or more on-time than the budget. */
function patternWhy(steps: readonly number[], repeat: number, l: HapticLimits): string | undefined {
  const ons = steps.filter((_, i) => i % 2 === 0);
  if (ons.some((s) => s > l.max_on_ms)) {
    return 'a tap is longer than it may stay on: shorten the taps';
  }
  if (ons.reduce((a, b) => a + b, 0) * repeat >= budgetMs(l)) {
    return 'more on-time than its budget allows: shorten the taps';
  }
  return undefined;
}

function play(key: string, words: string, steps: number[], level: number, repeat: number, l: HapticLimits): PatternButton {
  const why = patternWhy(steps, repeat, l);
  return why ? { key, words, send: null, why } : { key, words, send: { command: 'play', args: { steps, level, ...(repeat > 1 ? { repeat } : {}) } } };
}

/** The shortest roll period (from 50 ms, 20 taps a second) at which ten taps of `ms` fit; null past 200 ms. */
export function rollPeriod(ms: number, l: HapticLimits): number | null {
  for (let p = 50; p <= 200; p += 5) {
    if (ms < p && ms <= l.max_on_ms && hapticTrainFits(p, ms, l.cooldown_pct)) {
      return p;
    }
  }
  return null;
}

/** The solenoid's patterns at the block's tap length and strength: double, triple, heartbeat, knock-knock, a roll of ten. */
export function solenoidPatterns(ms: number, level: number, l: HapticLimits): PatternButton[] {
  const m = Math.max(1, Math.round(ms));
  const soft = Math.max(1, Math.round(m * 0.6));
  const roll = rollPeriod(m, l);
  return [
    play('double', 'double tap', [m, 90, m], level, 1, l),
    play('triple', 'triple tap', [m, 90, m, 90, m], level, 1, l),
    play('heartbeat', 'heartbeat', [m, 130, soft, 700], level, 4, l),
    play('knock', 'knock-knock', [m, 160, m, 480, m, 160, m], level, 1, l),
    roll === null
      ? { key: 'roll', words: 'roll', send: null, why: 'too long a tap for a roll: shorten the taps' }
      : { key: 'roll', words: 'roll', send: { command: 'tap', args: { period_ms: roll, ms: m, level, count: 10, accent: 0, accent_level: 100 } } },
  ];
}

/** The motor's patterns at the block's strength: short, double, long, heartbeat. */
export function motorPatterns(level: number, l: HapticLimits): PatternButton[] {
  return [
    { key: 'short', words: 'short', send: { command: 'pulse', args: { ms: 80, level } } },
    play('double', 'double', [120, 100, 120], level, 1, l),
    { key: 'long', words: 'long', send: { command: 'pulse', args: { ms: Math.min(600, l.max_on_ms), level } } },
    play('heartbeat', 'heartbeat', [150, 120, 100, 600], level, 4, l),
  ];
}

// ---- the metronome (the owner's, 2026-11-21) ----

export const TEMPO_MIN_BPM = 20;
export const TEMPO_MAX_BPM = 600;
export const BEATS_MAX = 12;
export const METRONOME_DEFAULTS = { bpm: 100, beats: 4, accentLevel: 100 } as const;

/** The tap args of a metronome: a beat every 60,000 / bpm ms, the bar's first beat at accent_level (one beat: no accent). */
export function metronomeArgs(o: { bpm: number; beats: number; ms: number; level: number; accentLevel: number }): TapArgs {
  return { period_ms: Math.round(60_000 / o.bpm), ms: Math.round(o.ms), level: Math.round(o.level), count: 0, accent: o.beats > 1 ? o.beats : 0, accent_level: Math.round(o.accentLevel) };
}

/** The fastest tempo (bpm) at which taps of `ms` fit, or null when none in range does. */
export function fastestTempo(ms: number, l: HapticLimits): number | null {
  for (let bpm = TEMPO_MAX_BPM; bpm >= TEMPO_MIN_BPM; bpm -= 1) {
    if (tapCheck(Math.round(60_000 / bpm), ms, l).ok) {
      return bpm;
    }
  }
  return null;
}

// ---- live changes ----

export interface Clock {
  now(): number;
  later(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

const WALL: Clock = {
  now: () => Date.now(),
  later: (fn, ms) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Sends a running train's new settings at most once every `gapMs` (200: five a second, D11): the first change at once,
 * then the latest one at the end of each gap; one that equals the last sent is not sent again.
 */
export class LiveSender<T> {
  #send: (v: T) => void;
  #gap: number;
  #clock: Clock;
  #last = -Infinity;
  #sent: string | null = null;
  #pending: T | null = null;
  #timer: unknown = null;

  constructor(send: (v: T) => void, gapMs = 200, clock: Clock = WALL) {
    this.#send = send;
    this.#gap = gapMs;
    this.#clock = clock;
  }

  push(v: T): void {
    const now = this.#clock.now();
    if (now - this.#last >= this.#gap && this.#timer === null) {
      this.#fire(v, now);
      return;
    }
    this.#pending = v;
    if (this.#timer === null) {
      this.#timer = this.#clock.later(() => {
        this.#timer = null;
        const p = this.#pending;
        this.#pending = null;
        if (p !== null) {
          this.#fire(p, this.#clock.now());
        }
      }, Math.max(0, this.#last + this.#gap - now));
    }
  }

  /** Forgets a change not sent yet (STOP, or the train ended). */
  cancel(): void {
    if (this.#timer !== null) {
      this.#clock.cancel(this.#timer);
      this.#timer = null;
    }
    this.#pending = null;
    this.#sent = null;
  }

  #fire(v: T, now: number): void {
    const key = JSON.stringify(v);
    if (key === this.#sent) {
      return;
    }
    this.#sent = key;
    this.#last = now;
    this.#send(v);
  }
}

// ---- the supply ----

/** fr.battery's critical level for each chemistry (the hub's learn.ts thresholds), when the build leaves it 0. */
const CRITICAL_MV: Readonly<Record<string, number>> = { liion: 3300, lifepo4: 2800, lic: 2800 };

export interface SupplyView {
  name: string;
  mv: number | null;
  level: string | null;
  criticalMv: number | null;
}

/**
 * The supply's reading from the device's properties (`<instance>.<member>`) and its build's config: its voltage, level
 * and critical voltage; null without a supply.
 */
export function supplyView(name: string | null, props: Readonly<Record<string, unknown>>, config: Readonly<Record<string, unknown>> | undefined): SupplyView | null {
  if (!name) {
    return null;
  }
  const mv = num(props[`${name}.mv`]);
  const lv = props[`${name}.level`];
  const levels = ['ok', 'low', 'critical', 'empty'];
  const level = typeof lv === 'string' ? lv : typeof lv === 'number' ? (levels[lv] ?? null) : null;
  const chem = typeof config?.chemistry === 'string' ? config.chemistry : typeof config?.chemistry === 'number' ? (['liion', 'lifepo4', 'lic'][config.chemistry] ?? null) : null;
  const set = num(config?.critical_mv);
  const criticalMv = set && set > 0 ? set : chem ? (CRITICAL_MV[chem] ?? null) : null;
  return { name, mv, level, criticalMv };
}

/** Whether the board would refuse a start now for its supply (HapticService::supply_refuses), as far as the panel sees. */
export function supplyRefuses(kind: HapticKind | null, s: SupplyView | null): 'low' | 'margin' | null {
  if (!s) {
    return null;
  }
  if (s.level === 'critical' || s.level === 'empty') {
    return 'low';
  }
  if (kind !== 'erm' && s.mv !== null && s.criticalMv !== null && s.mv < s.criticalMv + SOLENOID_MARGIN_MV) {
    return 'margin';
  }
  return null;
}

/** Why a start was refused (BUSY), in words. */
export function busyWords(kind: HapticKind | null, s: SupplyView | null): string {
  const why = supplyRefuses(kind, s);
  if (why === 'low') {
    return `Its supply, ${s!.name}, is too low to start anything: let it charge.`;
  }
  if (why === 'margin') {
    return `Its supply, ${s!.name}, is too low for the solenoid to start: it starts again once it has charged a little.`;
  }
  return 'It has been on for as long as it may for now, or its supply has no reading: wait a few moments and try again.';
}

// ---- how a program ended ----

const PROGRAMS = ['pulse', 'play', 'tap'] as const;
const REASONS = ['done', 'stopped', 'replaced', 'hub_lost', 'cut'] as const;
const CUTS = ['low_supply', 'floor', 'max_on'] as const;

function nameOf(list: readonly string[], v: unknown): string | null {
  if (typeof v === 'number') {
    return list[v] ?? null;
  }
  return typeof v === 'string' && list.includes(v) ? v : null;
}

const PROGRAM_WORDS: Readonly<Record<(typeof PROGRAMS)[number], string>> = { pulse: 'pulse', play: 'pattern', tap: 'taps' };
const ENDED: Readonly<Record<(typeof REASONS)[number], string>> = {
  done: 'ran to their end',
  stopped: 'were stopped',
  replaced: 'gave way to the next',
  hub_lost: 'ended when the hub went quiet',
  cut: 'were cut',
};
const CUT_WORDS: Readonly<Record<(typeof CUTS)[number], string>> = {
  low_supply: 'its supply ran low',
  floor: 'its supply reached its floor',
  max_on: 'it was on for as long as it may',
};

/** What the last done says ("the taps were cut: its supply ran low"), pure-safe; null for fields it cannot read. */
export function hapticDoneWords(fields: Readonly<Record<string, unknown>> | undefined, cut?: Readonly<Record<string, unknown>>): string | null {
  const program = nameOf(PROGRAMS, fields?.program) as (typeof PROGRAMS)[number] | null;
  const reason = nameOf(REASONS, fields?.reason) as (typeof REASONS)[number] | null;
  if (program === null || reason === null) {
    return null;
  }
  const plural = program === 'tap';
  const ended = plural ? ENDED[reason] : ENDED[reason].replace(/^ran to their end$/, 'ran to its end').replace(/^were /, 'was ');
  const cutWhy = reason === 'cut' ? nameOf(CUTS, cut?.reason) : null;
  return `the ${PROGRAM_WORDS[program]} ${ended}${cutWhy ? `: ${CUT_WORDS[cutWhy as (typeof CUTS)[number]]}` : ''}`;
}

/** The last event `<instance>.<member>` of a device in a ring (newest last). */
export function lastEvent<E extends { device?: string; type: string; part?: string }>(ring: readonly E[], deviceId: string, instance: string, member: string): E | undefined {
  for (let i = ring.length - 1; i >= 0; i--) {
    const e = ring[i]!;
    if (e.device === deviceId && e.part === 'event' && e.type === `${instance}.${member}`) {
      return e;
    }
  }
  return undefined;
}

/** The mirror's `active`, or null before the board reported it. */
export function activeOf(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** The word for a haptic that runs, by its kind. */
export function runningWord(kind: HapticKind | null): string {
  return kind === 'erm' ? 'buzzing' : kind === 'solenoid' ? 'tapping' : 'on';
}
