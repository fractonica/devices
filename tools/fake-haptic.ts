// Fake haptics for the scratch hub (tools/dash-dev.ts --stepper, whose fake board is c3s-stepper; design haptic-h1 D12):
// the board's `cap` (fr.battery: an LIC-H-0825 lithium-ion capacitor behind a TP4056), `kick` (fr.haptic: the solenoid)
// and `buzz` (fr.haptic: the vibration motor), so the dashboard's haptic panel can be worked on without a board.
//
// HapticSim answers fr.haptic 1.1 as HapticService does (firmware/components/fr_core/src/services/haptic_service.cpp):
// - pulse, play, tap and stop with the same refusals: INVALID_ARGS for an on-step above max_on_ms, a solenoid pattern
//   with a zero off-step (or an odd one repeated), a tap at or above its period, above max_on_ms, or a train whose worst
//   10 s would spend the budget (hapticTrainFits); BUSY on a start when the supply has no reading, is critical or below,
//   is under critical + 300 mV for a solenoid, or the budget of the last 10 s is spent;
// - a tap while a train runs changes it in place and keeps the beat (no BUSY, no done); the accent counts on;
// - every program ends with one done {program, reason}; a cut (low_supply, floor, max_on) comes first, then done {cut};
//   a replacement says done {replaced} and `active` does not drop; hub silence (10 s, or another hub run): hub_lost;
// - the duty: level x rated_mv / supply_mv (capped), a solenoid's kick at the level for kick_ms, then
//   min(hold_pct, level); on-time is reckoned exactly from the schedule, so the budget is the firmware's.
// LicSim is the cell: 90 F, 0.6 Ohm DC ESR; the loads draw (duty x volts / ohms: 6.4 for the solenoid with the ESR and
// the switches, 30 for the motor) and drain it by I x t / 90 F; the TP4056 charges at 1 A to 4.2 V, stops there and
// starts again under 4.05 V. Its reading is the firmware's: sampled at report_hz with the average load of the sample
// (the ESR's dip: about 0.4 V while the solenoid is on), an EMA of 1/4, the levels with 50 mV of hysteresis upward.
// drain() (dash-dev's SIGUSR2) takes it to 3.0 V and holds the charger off for 30 s, to show BUSY and a cut.
// Never a real board, a serial port or the lab hub: it speaks only to the private hub it is given.

import { HAPTIC_KIND_DEFAULTS, hapticTrainFits } from '@fractonica/protocol';
import { STATUS } from '@fractonica/protocol/gen';

/** c3s-stepper's haptic instances and slots (design haptic-h1 D6): cap 5, kick 6, buzz 7. */
export const HAPTIC_CAPS = [
  { port: 5, cap_id: 0x000d, name: 'cap' },
  { port: 6, cap_id: 0x000e, name: 'kick' },
  { port: 7, cap_id: 0x000e, name: 'buzz' },
] as const;
export const CAP_PORT = 5;
export const KICK_PORT = 6;
export const BUZZ_PORT = 7;

/** The builds' configs (design haptic-h1 D6) as the manifest records them. */
export const LIC_CONFIG = { chemistry: 'lic', full_mv: 4200, report_hz: 10 } as const;
export const LIC_TRAITS = { status_pins: false, test_load: false, charge_gate: false } as const;
export const KICK_CONFIG = { kind: 'solenoid', rated_mv: 4200, supply: 'cap' } as const;
export const BUZZ_CONFIG = { kind: 'erm', rated_mv: 3000, supply: 'cap' } as const;
export const HAPTIC_TRAITS = { pwm: true } as const;

/** The LIC-H-0825 and its TP4056 (design haptic-h1 §0), and the LIC chemistry's levels (fr.battery). */
export const LIC = {
  farads: 90,
  esrOhm: 0.6,
  chargeA: 1,
  fullMv: 4200,
  rechargeMv: 4050,
  lowMv: 3000,
  criticalMv: 2800,
  floorMv: 2700,
  hysteresisMv: 50,
  deadbandMv: 5,
  reportHz: 10,
} as const;
/** The loads' ohms seen from the cell's open-circuit voltage (the ESR and the switches included). */
export const LOAD_OHM = { solenoid: 6.4, erm: 30 } as const;
/** HapticService's constants. */
export const HAPTIC_WINDOW_MS = 10_000;
export const HAPTIC_HUB_SILENT_MS = 10_000;
export const SOLENOID_MARGIN_MV = 300;
const SUPPLY_BAND_MV = 20;
const SUPPLY_REPORT_MS = 100;
const MAX_STEPS = 32;

export type HapticKind = 'erm' | 'solenoid';
export type HapticProgram = 'pulse' | 'play' | 'tap';
export type HapticDoneReason = 'done' | 'stopped' | 'replaced' | 'hub_lost' | 'cut';
export type HapticCutReason = 'low_supply' | 'floor' | 'max_on';
export type CellLevel = 'ok' | 'low' | 'critical' | 'empty';
const LEVELS: readonly CellLevel[] = ['ok', 'low', 'critical', 'empty'];

/** The hub session as the node sees it: its run's epoch and when its newest frame arrived (the sim's clock, ms). */
export interface HubLink {
  epoch: number;
  heardAt: number;
}

/** HapticService::compensate: the duty (permille) for a level on a supply (0 = unknown: none), capped at 1000. */
export function compensate(levelPct: number, ratedMv: number, supplyMv: number): number {
  const base = Math.min(levelPct, 100) * 10;
  if (supplyMv <= 0) {
    return base;
  }
  return Math.min(1000, Math.floor((base * ratedMv + Math.floor(supplyMv / 2)) / supplyMv));
}

const num = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

// ---- the cell ----

export interface LicOut {
  state(name: 'mv' | 'percent' | 'charger' | 'level' | 'load_on' | 'gate_open', value: unknown): void;
  event(name: 'level_change', fields: { level: CellLevel; mv: number }): void;
}

export interface LicSimOptions {
  now: () => number;
  out: LicOut;
  /** The open-circuit voltage at the start (default full). */
  mv?: number;
}

/** The LIC on the TP4056: drawn by the haptics, charged at 1 A, read as fr.battery reads it. */
export class LicSim {
  readonly criticalMv = LIC.criticalMv;
  #now: () => number;
  #out: LicOut;
  /** Open-circuit voltage, mV. */
  #v: number;
  #charging = false;
  #chargerOffUntil = -Infinity;
  #t: number;
  /** Charge drawn since the last sample (A x ms). */
  #drawn = 0;
  #sampleAt: number;
  #ema: number;
  #level: CellLevel = 'ok';
  #sent = new Map<string, unknown>();

  constructor(o: LicSimOptions) {
    this.#now = o.now;
    this.#out = o.out;
    this.#v = o.mv ?? LIC.fullMv;
    this.#t = o.now();
    this.#sampleAt = this.#t;
    this.#ema = this.#v;
    this.#level = this.#levelFor(this.#ema, 'ok');
  }

  /** The reading (mV): what the firmware's fr.battery says, the EMA of its samples. */
  get mv(): number {
    return Math.round(this.#ema);
  }
  get level(): CellLevel {
    return this.#level;
  }
  /** The open-circuit voltage (mV), no wire carries it. */
  get ocv(): number {
    return Math.round(this.#v);
  }
  get charging(): boolean {
    return this.#charging;
  }
  /** fr.battery has a fresh reading (always, here). */
  readingOk(): boolean {
    return true;
  }

  /** The loads drew `ampMs` (A x ms) since the last call. */
  draw(ampMs: number): void {
    this.#drawn += ampMs;
  }

  /** dash-dev's SIGUSR2: the cell at `mv`, the charger held off for `holdMs`. */
  drain(mv = 3000, holdMs = 30_000): void {
    this.#v = mv;
    this.#ema = mv;
    this.#charging = false;
    this.#chargerOffUntil = this.#now() + holdMs;
    this.#setLevel(this.#levelFor(this.#ema, this.#level));
    this.#put('mv', this.mv, true);
    this.#put('percent', this.#percent(), true);
  }

  reportAll(): void {
    this.#sent.clear();
    this.#put('mv', this.mv, true);
    this.#put('percent', this.#percent(), true);
    this.#put('charger', 'none', true);
    this.#put('level', this.#level, true);
    this.#put('load_on', false, true);
    this.#put('gate_open', false, true);
  }

  /** fr.battery's commands: read reports now; calibrate and reset_calibration are taken; no load, gate or inject here. */
  command(name: string): number {
    switch (name) {
      case 'read':
        this.#put('mv', this.mv, true);
        return STATUS.OK;
      case 'calibrate':
      case 'reset_calibration':
        return STATUS.OK;
      default:
        return STATUS.UNSUPPORTED;
    }
  }

  /** Moves time on: the charge in and out, a sample every 1/report_hz. */
  tick(): void {
    const now = this.#now();
    const dt = now - this.#t;
    if (dt <= 0) {
      return;
    }
    this.#t = now;
    // The TP4056: 1 A until 4.2 V, then off until the cell falls under 4.05 V (held off after a drain()).
    if (now < this.#chargerOffUntil) {
      this.#charging = false;
    } else if (!this.#charging && this.#v < LIC.rechargeMv) {
      this.#charging = true;
    }
    if (this.#charging) {
      this.#v += (LIC.chargeA * dt) / LIC.farads; // mV: A x ms / F
      if (this.#v >= LIC.fullMv) {
        this.#v = LIC.fullMv;
        this.#charging = false;
      }
    }
    if (now - this.#sampleAt >= 1000 / LIC.reportHz) {
      const span = now - this.#sampleAt;
      this.#sampleAt = now;
      const amps = this.#drawn / span;
      this.#v = Math.max(0, this.#v - this.#drawn / LIC.farads);
      this.#drawn = 0;
      const terminal = Math.min(LIC.fullMv, this.#v - amps * LIC.esrOhm * 1000);
      this.#ema += (terminal - this.#ema) / 4;
      this.#setLevel(this.#levelFor(this.#ema, this.#level));
      this.#put('mv', this.mv, false);
      this.#put('percent', this.#percent(), false);
    }
  }

  #percent(): number {
    return Math.max(0, Math.min(100, Math.round(((this.#ema - LIC.floorMv) * 100) / (LIC.fullMv - LIC.floorMv))));
  }

  /** The level for a reading: down at once, up only 50 mV past the threshold. */
  #levelFor(mv: number, was: CellLevel): CellLevel {
    const raw: CellLevel = mv < LIC.floorMv ? 'empty' : mv < LIC.criticalMv ? 'critical' : mv < LIC.lowMv ? 'low' : 'ok';
    if (LEVELS.indexOf(raw) >= LEVELS.indexOf(was)) {
      return raw;
    }
    const up = (lv: CellLevel) => mv >= ({ ok: LIC.lowMv, low: LIC.criticalMv, critical: LIC.floorMv, empty: 0 } as const)[lv] + LIC.hysteresisMv;
    let to = was;
    while (to !== raw && up(LEVELS[LEVELS.indexOf(to) - 1]!)) {
      to = LEVELS[LEVELS.indexOf(to) - 1]!;
    }
    return to;
  }

  #setLevel(l: CellLevel): void {
    if (l !== this.#level) {
      this.#level = l;
      this.#put('level', l, true);
      this.#out.event('level_change', { level: l, mv: this.mv });
    }
  }

  /** A STATE when the value changed since it was last sent (mV past the deadband). */
  #put(name: 'mv' | 'percent' | 'charger' | 'level' | 'load_on' | 'gate_open', value: unknown, force: boolean): void {
    const had = this.#sent.get(name);
    if (!force && had !== undefined && (name === 'mv' ? Math.abs((had as number) - (value as number)) < LIC.deadbandMv : had === value)) {
      return;
    }
    this.#sent.set(name, value);
    this.#out.state(name, value);
  }
}

// ---- a haptic ----

export interface HapticOut {
  state(name: 'active' | 'supply_mv', value: unknown): void;
  event(name: 'cut' | 'done', fields: Record<string, unknown>): void;
}

/** What a haptic draws from: the cell's reading and level. */
export interface HapticSupply {
  readonly mv: number;
  readonly level: CellLevel;
  readonly criticalMv: number;
  readingOk(): boolean;
}

export interface HapticConfig {
  kind: HapticKind;
  rated_mv: number;
  max_on_ms: number;
  kick_ms: number;
  hold_pct: number;
  cooldown_pct: number;
}

export interface HapticSimOptions {
  config: Partial<HapticConfig> & { kind: HapticKind };
  now: () => number;
  out: HapticOut;
  supply?: HapticSupply | null;
  /** Where the load's charge goes (A x ms), e.g. the cell. */
  draw?: (ampMs: number) => void;
  hub?: () => HubLink | null;
}

interface Steps {
  type: 'steps';
  steps: number[];
  repeatsLeft: number;
  step: number;
  stepStart: number;
}

interface Train {
  type: 'tap';
  period: number;
  ms: number;
  accent: number;
  accentLevel: number;
  forever: boolean;
  tapsLeft: number;
  tapNo: number;
  tapStart: number;
}

/** fr.haptic 1.1's service on a simulated clock: commands answer at once, tick() moves time on. */
export class HapticSim {
  readonly config: HapticConfig;
  #now: () => number;
  #out: HapticOut;
  #supply: HapticSupply | null;
  #draw: (ampMs: number) => void;
  #hub: () => HubLink | null;
  #prog: Steps | Train | null = null;
  #program: HapticProgram = 'pulse';
  #level = 100;
  #active = false;
  #on = false;
  #onSince = 0;
  #onStepStart = 0;
  /** The time the schedule was last walked to: nothing is placed before it. */
  #t: number;
  /** On-intervals of the last window, [start, end) (end Infinity while on). */
  #intervals: [number, number][] = [];
  #hubEpoch: number | null = null;
  #lastDrawAt: number;
  #lastSupply = 0;
  #lastSupplyAt = -Infinity;
  #sent = new Map<string, unknown>();

  constructor(o: HapticSimOptions) {
    const d = HAPTIC_KIND_DEFAULTS[o.config.kind];
    this.config = {
      kind: o.config.kind,
      rated_mv: o.config.rated_mv ?? 3000,
      max_on_ms: o.config.max_on_ms || d.max_on_ms,
      kick_ms: o.config.kick_ms ?? 30,
      hold_pct: o.config.hold_pct ?? 40,
      cooldown_pct: o.config.cooldown_pct || d.cooldown_pct,
    };
    this.#now = o.now;
    this.#out = o.out;
    this.#supply = o.supply ?? null;
    this.#draw = o.draw ?? (() => {});
    this.#hub = o.hub ?? (() => null);
    this.#t = o.now();
    this.#lastDrawAt = this.#t;
  }

  get active(): boolean {
    return this.#active;
  }
  get program(): HapticProgram | null {
    return this.#active ? this.#program : null;
  }
  /** The duty the output has now (permille), which no wire carries. */
  get duty(): number {
    return this.#on ? this.#dutyAt(this.#now()) : 0;
  }
  /** The taps a train has started since it began. */
  get tapsPlayed(): number {
    return this.#prog?.type === 'tap' ? this.#prog.tapNo + 1 : 0;
  }

  /** On-time within the last 10 s (ms). */
  spentMs(now = this.#now()): number {
    const from = now - HAPTIC_WINDOW_MS;
    let sum = 0;
    for (const [a, b] of this.#intervals) {
      sum += Math.max(0, Math.min(b, now) - Math.max(a, from));
    }
    return sum;
  }

  reportAll(): void {
    this.#sent.clear();
    this.#put('active', this.#active);
    if (this.#supply) {
      this.#put('supply_mv', this.#supply.mv);
    }
  }

  /** A command by name with its decoded args: the status HapticService would answer. */
  command(name: string, args: Record<string, unknown>): number {
    switch (name) {
      case 'pulse': {
        const ms = num(args.ms, 0);
        if (ms < 1 || ms > this.config.max_on_ms) {
          return STATUS.INVALID_ARGS;
        }
        return this.#startSteps('pulse', [ms], num(args.level, 100), 1);
      }
      case 'play':
        return this.#play(args);
      case 'tap':
        return this.#tap(args);
      case 'stop':
        if (this.#active) {
          this.#finish('stopped', this.#now());
        }
        return STATUS.OK;
      default:
        return STATUS.UNSUPPORTED;
    }
  }

  /** Moves time on: the schedule, the supply, the hub, the budget and the on-time limit, as on_tick. */
  tick(): void {
    const now = this.#now();
    if (this.#active) {
      this.#walk(now);
    }
    this.#account(now);
    if (!this.#active) {
      return;
    }
    if (this.#supply) {
      if (this.#supply.readingOk() && this.#supply.level === 'empty') {
        this.#cut('floor', now);
        return;
      }
      if (!this.#supply.readingOk() || this.#supply.level === 'critical' || this.#supply.level === 'empty') {
        this.#cut('low_supply', now);
        return;
      }
    }
    if (this.#hubEpoch !== null) {
      const hub = this.#hub();
      if (!hub || hub.epoch !== this.#hubEpoch || now - hub.heardAt >= HAPTIC_HUB_SILENT_MS) {
        this.#finish('hub_lost', now);
        return;
      }
    }
    if (this.#on && this.config.cooldown_pct < 100 && this.spentMs(now) >= (this.config.cooldown_pct * HAPTIC_WINDOW_MS) / 100) {
      this.#cut('max_on', now);
      return;
    }
    if (this.#on && now - this.#onSince >= this.config.max_on_ms) {
      this.#cut('max_on', now);
      return;
    }
    this.#reportSupply(now, false);
  }

  // ---- commands ----

  #play(args: Record<string, unknown>): number {
    const steps = Array.isArray(args.steps) ? (args.steps as unknown[]).map((v) => num(v, -1)) : [];
    if (steps.length === 0 || steps.length > MAX_STEPS || steps.some((s) => s < 0)) {
      return STATUS.INVALID_ARGS;
    }
    if (steps.some((s, i) => i % 2 === 0 && s > this.config.max_on_ms) || !steps.some((s, i) => i % 2 === 0 && s > 0)) {
      return STATUS.INVALID_ARGS;
    }
    const repeat = num(args.repeat, 1);
    if (this.config.kind === 'solenoid' && (steps.some((s, i) => i % 2 === 1 && s === 0) || (steps.length % 2 === 1 && repeat > 1))) {
      return STATUS.INVALID_ARGS;
    }
    return this.#startSteps('play', steps, num(args.level, 100), repeat);
  }

  #tap(args: Record<string, unknown>): number {
    const period = int(args.period_ms) ?? 0;
    const ms = int(args.ms) ?? 0;
    const level = num(args.level, 100);
    const count = num(args.count, 1);
    const accent = num(args.accent, 0);
    const accentLevel = num(args.accent_level, 100);
    // The generated valid() (ranges), then the service's own rules.
    if (period < 20 || period > 60_000 || level < 1 || level > 100 || count < 0 || count > 10_000 || accent < 0 || accent > 32 || accentLevel < 1 || accentLevel > 100) {
      return STATUS.INVALID_ARGS;
    }
    if (ms < 1 || ms >= period || ms > this.config.max_on_ms || !hapticTrainFits(period, ms, this.config.cooldown_pct)) {
      return STATUS.INVALID_ARGS;
    }
    const now = this.#now();
    this.#walk(now);
    const prog = this.#prog;
    const change = this.#active && prog?.type === 'tap';
    if (!change && this.#refuses(now)) {
      return STATUS.BUSY;
    }
    this.#level = Math.max(1, Math.min(100, level));
    if (change) {
      const wasOn = now < prog.tapStart + prog.ms;
      prog.period = period;
      prog.ms = ms;
      prog.accent = accent;
      prog.accentLevel = accentLevel;
      prog.forever = count === 0;
      const hub = this.#hub();
      this.#hubEpoch = hub ? hub.epoch : null;
      if (wasOn) {
        prog.tapsLeft = count;
      } else if (prog.tapStart + period <= now) {
        prog.tapStart = now;
        prog.tapNo += 1;
        prog.tapsLeft = count;
        this.#setOn(true, now);
      } else {
        prog.tapsLeft = count + 1;
      }
    } else {
      this.#begin('tap', now);
      this.#prog = { type: 'tap', period, ms, accent, accentLevel, forever: count === 0, tapsLeft: count, tapNo: 0, tapStart: now };
      this.#setOn(true, now);
    }
    this.#walk(now);
    return STATUS.OK;
  }

  #startSteps(program: HapticProgram, steps: number[], level: number, repeat: number): number {
    const now = this.#now();
    this.#walk(now);
    if (this.#refuses(now)) {
      return STATUS.BUSY;
    }
    this.#begin(program, now);
    this.#level = Math.max(1, Math.min(100, level));
    this.#prog = { type: 'steps', steps, repeatsLeft: Math.max(1, repeat), step: 0, stepStart: now };
    this.#setOn(steps[0]! > 0, now);
    this.#walk(now);
    return STATUS.OK;
  }

  /** The BUSY rules of a start (HapticService::admit). */
  #refuses(now: number): boolean {
    const s = this.#supply;
    if (s) {
      if (!s.readingOk() || s.level === 'critical' || s.level === 'empty') {
        return true;
      }
      if (this.config.kind === 'solenoid' && s.mv < s.criticalMv + SOLENOID_MARGIN_MV) {
        return true;
      }
    }
    return this.config.cooldown_pct < 100 && this.spentMs(now) >= (this.config.cooldown_pct * HAPTIC_WINDOW_MS) / 100;
  }

  #begin(program: HapticProgram, now: number): void {
    if (this.#active) {
      this.#out.event('done', { program: this.#program, reason: 'replaced' });
    }
    this.#program = program;
    const hub = this.#hub();
    this.#hubEpoch = hub ? hub.epoch : null;
    this.#active = true;
    this.#put('active', true);
    this.#reportSupply(now, true);
  }

  // ---- the schedule ----

  /** Walks the program's boundaries up to `now`, placing each at its own time (never before the last walk). */
  #walk(now: number): void {
    const at = (b: number) => Math.max(b, this.#t);
    while (this.#active && this.#prog) {
      const p = this.#prog;
      if (p.type === 'steps') {
        const end = p.stepStart + p.steps[p.step]!;
        if (now < end) {
          break;
        }
        const b = at(end);
        p.stepStart = end;
        p.step += 1;
        if (p.step === p.steps.length) {
          p.repeatsLeft -= 1;
          if (p.repeatsLeft === 0) {
            this.#finish('done', b);
            return;
          }
          p.step = 0;
        }
        const on = p.step % 2 === 0 && p.steps[p.step]! > 0;
        this.#setOn(on, b);
        if (on) {
          this.#onStepStart = b;
        }
      } else {
        const onEnd = p.tapStart + p.ms;
        if (now < onEnd) {
          break;
        }
        this.#setOn(false, at(onEnd));
        if (!p.forever && p.tapsLeft <= 1) {
          this.#finish('done', at(onEnd));
          return;
        }
        const next = p.tapStart + p.period;
        if (now < next) {
          break;
        }
        p.tapStart = next;
        p.tapNo += 1;
        if (!p.forever) {
          p.tapsLeft -= 1;
        }
        this.#setOn(true, at(next));
      }
    }
    this.#t = Math.max(this.#t, now);
  }

  #setOn(on: boolean, t: number): void {
    if (on) {
      this.#onStepStart = t;
    }
    if (on === this.#on) {
      return;
    }
    this.#account(t);
    this.#on = on;
    if (on) {
      const last = this.#intervals[this.#intervals.length - 1];
      if (last && last[1] === t) {
        last[1] = Infinity; // off for no time (a zero off-step): the firmware never wrote 0, the on-time runs on
        return;
      }
      this.#onSince = t;
      this.#intervals.push([t, Infinity]);
    } else {
      const last = this.#intervals[this.#intervals.length - 1];
      if (last) {
        last[1] = Math.max(last[0], t);
      }
    }
  }

  /** The level of what is on now: a train's accented tap at accent_level. */
  #levelNow(): number {
    const p = this.#prog;
    if (p?.type === 'tap' && p.accent > 0 && p.tapNo % p.accent === 0) {
      return p.accentLevel;
    }
    return this.#level;
  }

  #dutyAt(now: number): number {
    const supply = this.#supply ? this.#supply.mv : 0;
    const level = this.#levelNow();
    const c = this.config;
    if (c.kind === 'solenoid' && now - this.#onStepStart >= c.kick_ms) {
      return compensate(Math.min(c.hold_pct, level), c.rated_mv, supply);
    }
    return compensate(level, c.rated_mv, supply);
  }

  /** The charge drawn since the last account, at the duty of the on-step that runs (or ran last). */
  #account(now: number): void {
    const from = this.#lastDrawAt;
    if (now <= from) {
      return;
    }
    let onMs = 0;
    for (const [a, b] of this.#intervals) {
      onMs += Math.max(0, Math.min(b, now) - Math.max(a, from));
    }
    this.#lastDrawAt = now;
    // Old intervals out of the window.
    this.#intervals = this.#intervals.filter(([, b]) => b > now - HAPTIC_WINDOW_MS);
    if (onMs > 0) {
      const volts = (this.#supply?.mv ?? 4000) / 1000;
      const duty = compensate(this.#levelNow(), this.config.rated_mv, this.#supply?.mv ?? 0) / 1000;
      this.#draw((onMs * duty * volts) / LOAD_OHM[this.config.kind]);
    }
  }

  #finish(reason: HapticDoneReason, t: number): void {
    this.#setOn(false, Math.max(t, this.#t));
    this.#account(this.#now());
    this.#active = false;
    this.#prog = null;
    this.#out.event('done', { program: this.#program, reason });
    this.#put('active', false);
    this.#reportSupply(this.#now(), true);
  }

  #cut(reason: HapticCutReason, now: number): void {
    this.#setOn(false, now);
    this.#out.event('cut', { reason, supply_mv: this.#supply ? this.#supply.mv : 0 });
    this.#finish('cut', now);
  }

  #reportSupply(now: number, force: boolean): void {
    if (!this.#supply) {
      return;
    }
    const mv = this.#supply.mv;
    if (force || (Math.abs(mv - this.#lastSupply) >= SUPPLY_BAND_MV && now - this.#lastSupplyAt >= SUPPLY_REPORT_MS)) {
      this.#lastSupply = mv;
      this.#lastSupplyAt = now;
      this.#out.state('supply_mv', mv);
      this.#sent.set('supply_mv', mv);
    }
  }

  /** A STATE when the value changed since it was last sent. */
  #put(name: 'active' | 'supply_mv', value: unknown): void {
    if (this.#sent.get(name) !== value) {
      this.#sent.set(name, value);
      this.#out.state(name, value);
    }
  }
}
