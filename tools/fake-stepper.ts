// A fake stepper board for the scratch hub (tools/dash-dev.ts --stepper; design stepper-s1 D16): a FakeNode with
// c3s-stepper's instances (boot fr.button, status fr.led, motor fr.stepper, buzzer fr.buzzer, and since design
// haptic-h1 cap fr.battery, kick and buzz fr.haptic) whose motor answers as StepperService does (D10-D12), whose buzzer
// as BuzzerService (tools/fake-buzzer.ts, design buzzer-b1 D10), and whose capacitor, solenoid and vibration motor as
// BatteryService and HapticService (tools/fake-haptic.ts, design haptic-h1 D12), so the dashboard's stepper, buzzer
// and haptic panels can be worked on without a board:
// - the motion states (released, holding, moving, stopping, fault) and the service's answers: INVALID_ARGS above
//   max_speed_hz or accel, beyond the limits or ±10⁹, or for limit_min ≥ limit_max; BUSY in a fault's back-off, with
//   limits on and the position unknown, for hold, zero and configure while moving, and for a new step_mode or
//   reset_settings unless released; stop, halt, hold and release OK with nothing to do at rest;
// - motion that takes time: StepperSim, a trapezoid at the move's accel up to its speed, integrated in 1 ms slices
//   at each 20 ms tick (the C++ engine's looks, not its step arithmetic, D16). A move lands exactly on its target; a
//   newer move or jog replaces the running one without a done; a target inside the stopping distance is passed and
//   come back to; a jog reverses through zero speed and rests exactly on a limit (done limit);
// - position and speed_hz at most report_hz times a second while moving and exact at every rest; motion, target,
//   position_known and the settings at once, on change. A jog or a stop plans no end, so target follows the position
//   until it rests;
// - done once per motion; fault {driver} from fault() (dash-dev's SIGUSR1) and fault {injected} from inject_fault,
//   then done {fault} if it was moving, the position unknown above start_hz; the 1 s back-off, 60 s once three fall
//   within a minute; the release after release_ms at rest; a jog's seconds (done elapsed); the hub-silence stop
//   (done hub_lost) 10 s after the hub's newest frame, or at another hub run, for a motion started under a session.
// configure keeps its settings in memory (the fake never reboots). A new step_mode rescales the position, the limits
// and the speeds not given, as D11 says; reset_settings rescales the position to the build's step_mode too.
// Never a real board, a serial port or the lab hub: it speaks only to the private hub it is given.

import {
  decodeMember,
  encodeMember,
  findCap,
  STEPPER_CONFIG_DEFAULTS,
  type StepperConfig,
  type StepperDoneReason,
  type StepperFaultCause,
  type StepperMotion,
  StepperStepMode,
} from '@fractonica/protocol/gen';

import { FakeNode, STATUS } from '../packages/hub/test/fake-node.ts';
import { BuzzerSim } from './fake-buzzer.ts';
import { BUZZ_CONFIG, BUZZ_PORT, CAP_PORT, HAPTIC_CAPS, HapticSim, KICK_CONFIG, KICK_PORT, LicSim } from './fake-haptic.ts';

/**
 * c3s-stepper's instances and slots (design stepper-s1 D13, buzzer-b1 D8, haptic-h1 D6): boot 1, status 2, motor 3,
 * buzzer 4, cap 5, kick 6, buzz 7.
 */
export const STEPPER_CAPS = [
  { port: 1, cap_id: 0x0001, name: 'boot' },
  { port: 2, cap_id: 0x0002, name: 'status' },
  { port: 3, cap_id: 0x0012, name: 'motor' },
  { port: 4, cap_id: 0x0013, name: 'buzzer' },
  ...HAPTIC_CAPS,
];
export const MOTOR_PORT = 3;
export const BUZZER_PORT = 4;
/** HELLO's chip for c3s-stepper's board, the ESP32-C3 (esp_chip_model_t; the hub's CHIP_IDS). */
const ESP32C3 = 5;
/** c3s-stepper's motor config (D13); the rest are the capability's defaults. */
export const C3S_STEPPER_CONFIG: Partial<StepperConfig> = { steps_per_rev: 20, step_mode: 'micro8', coil_ohm: 10, run_ma: 100, supply_mv: 5000 };

/** The service's poll (D10). */
export const TICK_MS = 20;
const SLICE_MS = 1;
/** FixtureService's and HapticService's kHubSilentUs (D12). */
export const HUB_SILENT_MS = 10_000;
/** D11's fault back-offs. */
export const FAULT_BACKOFF_MS = 1000;
export const FAULT_LOCKOUT_MS = 60_000;
const FAULT_WINDOW_MS = 60_000;
const FAULTS_TO_LOCK = 3;
/** D6: positions, targets and a jog's implicit bounds. */
const BOUND = 1_000_000_000;

const MODES = Object.keys(StepperStepMode) as (keyof typeof StepperStepMode)[];
type Mode = (typeof MODES)[number];
const SPEED_RANGE: [number, number] = [1, 10_000];
const ACCEL_RANGE: [number, number] = [10, 200_000];

/** What configure keeps (the config minus what only the build decides). */
type Settings = Omit<StepperConfig, 'step_mode' | 'steps_per_rev' | 'report_hz'> & { step_mode: Mode };
const SETTINGS = ['step_mode', 'max_speed_hz', 'accel', 'start_hz', 'coil_ohm', 'run_ma', 'hold_pct', 'release_ms', 'supply_mv', 'invert', 'limits', 'limit_min', 'limit_max'] as const;

/** A move to a target, or a spin at a signed speed (a jog; a stop is speed 0) that never passes lo..hi. */
type Plan = { kind: 'to'; target: number; vmax: number; accel: number } | { kind: 'spin'; speed: number; accel: number; lo: number; hi: number };

/** Where the motor's STATE and EVENT bodies go (the JSON form of the generated codecs). */
export interface StepperOut {
  state(name: string, value: unknown): void;
  event(name: 'done' | 'fault', fields: Record<string, unknown>): void;
}

/** The hub session as the node sees it: its run's epoch and when its newest frame arrived (the sim's clock, ms). */
export interface HubLink {
  epoch: number;
  heardAt: number;
}

export interface StepperSimOptions {
  /** The build's configuration (absent fields: the capability's defaults). */
  config?: Partial<StepperConfig>;
  /** Milliseconds, never going back. */
  now: () => number;
  out: StepperOut;
  /** The hub session now, or null without one. */
  hub?: () => HubLink | null;
}

const clamp = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, v));
/** Half away from zero, as the C++ rescale rounds. */
const roundAway = (v: number) => Math.sign(v) * Math.round(Math.abs(v));
const modeName = (m: StepperConfig['step_mode']): Mode => (typeof m === 'number' ? MODES[m]! : m);

/** fr.stepper's service and motion on a simulated clock: commands answer at once, tick() moves time on. */
export class StepperSim {
  readonly build: Readonly<StepperConfig>;
  #cfg: Settings;
  #now: () => number;
  #out: StepperOut;
  #hub: () => HubLink | null;
  #t: number;
  #pos = 0;
  #v = 0;
  #motion: StepperMotion = 'released';
  #known = false;
  #target = 0;
  #plan: Plan | null = null;
  /** What done says when a spin of speed 0 rests. */
  #stopReason: StepperDoneReason = 'stopped';
  /** The target the running motion had, for its done (null: a jog's, the position it rests at). */
  #doneTarget: number | null = null;
  #jogUntil: number | null = null;
  #releaseAt: number | null = null;
  /** The hub run a motion started under (D12), or null. */
  #hubEpoch: number | null = null;
  #faults: number[] = [];
  #backoffUntil = -Infinity;
  #lastReport = -Infinity;
  #sent = new Map<string, unknown>();

  constructor(o: StepperSimOptions) {
    this.build = { ...STEPPER_CONFIG_DEFAULTS, ...o.config };
    this.#cfg = this.#fromBuild();
    this.#now = o.now;
    this.#out = o.out;
    this.#hub = o.hub ?? (() => null);
    this.#t = o.now();
  }

  get motion(): StepperMotion {
    return this.#motion;
  }
  get position(): number {
    return Math.round(this.#pos);
  }
  get speed(): number {
    return Math.round(this.#v);
  }
  get positionKnown(): boolean {
    return this.#known;
  }
  get settings(): Readonly<Settings> {
    return this.#cfg;
  }

  /** Every property again (boot, and fr.node get_state through the FakeNode's props). */
  reportAll(): void {
    this.#sent.clear();
    this.#reportPosition();
    this.#put('motion', this.#motion);
    this.#put('position_known', this.#known);
    this.#put('steps_per_rev', this.build.steps_per_rev);
    this.#reportSettings();
  }

  /** Runs the motion and the timers up to now(). */
  tick(): void {
    const now = this.#now();
    while (this.#t < now) {
      const h = Math.min(SLICE_MS, now - this.#t);
      this.#t += h;
      this.#timers();
      if (this.#plan) {
        this.#slice(h / 1000);
      }
    }
    if (this.#running() && this.#t - this.#lastReport >= 1000 / this.build.report_hz) {
      this.#reportPosition();
    }
  }

  /** A command by name with its decoded arguments: the RESULT status. */
  command(name: string, a: Record<string, unknown>): number {
    this.tick();
    switch (name) {
      case 'move_to':
        return this.#moveTo(a.position as number, a.speed_hz as number | undefined, a.accel as number | undefined);
      case 'move_by': {
        const from = this.#plan?.kind === 'to' && this.#motion === 'moving' ? this.#plan.target : this.position;
        return this.#moveTo(from + (a.steps as number), a.speed_hz as number | undefined, a.accel as number | undefined);
      }
      case 'jog':
        return this.#jog(a.speed_hz as number, a.accel as number | undefined, (a.seconds as number | undefined) ?? 0);
      case 'stop':
        if (this.#motion === 'moving') {
          this.#stop('stopped');
        }
        return STATUS.OK;
      case 'halt':
        return this.#halt();
      case 'hold':
        return this.#hold();
      case 'release':
        this.#release();
        return STATUS.OK;
      case 'zero':
        return this.#zero((a.position as number | undefined) ?? 0);
      case 'configure':
        return this.#configure(a);
      case 'reset_settings':
        return this.#resetSettings();
      case 'inject_fault':
        this.fault('injected');
        return STATUS.OK;
      default:
        return STATUS.UNSUPPORTED;
    }
  }

  /** The driver's fault path (nFAULT fell, or injected): coils off at once, then the events (D11). */
  fault(cause: StepperFaultCause): void {
    this.tick();
    const running = this.#running();
    if (running) {
      this.#loseIfFast();
    }
    const doneTarget = this.#doneTarget;
    this.#halted('fault');
    this.#faults = this.#faults.filter((at) => this.#t - at < FAULT_WINDOW_MS);
    this.#faults.push(this.#t);
    this.#backoffUntil = this.#t + (this.#faults.length >= FAULTS_TO_LOCK ? FAULT_LOCKOUT_MS : FAULT_BACKOFF_MS);
    this.#out.event('fault', { cause, position: this.position, recent: this.#faults.length });
    if (running) {
      this.#out.event('done', { reason: 'fault', position: this.position, target: doneTarget ?? this.position, slips: 0 });
    }
  }

  // ---- commands ----

  #moveTo(target: number, speed?: number, accel?: number): number {
    const c = this.#cfg;
    if (Math.abs(target) > BOUND || (c.limits && (target < c.limit_min || target > c.limit_max))) {
      return STATUS.INVALID_ARGS;
    }
    const bad = this.#refuse(speed, accel);
    if (bad !== null) {
      return bad;
    }
    this.#clearFault();
    if (!this.#running() && target === this.position) {
      this.#out.event('done', { reason: 'reached', position: target, target, slips: 0 });
      return STATUS.OK;
    }
    this.#begin({ kind: 'to', target, vmax: speed ?? c.max_speed_hz, accel: accel ?? c.accel }, target);
    this.#put('target', target);
    return STATUS.OK;
  }

  #jog(speed: number, accel: number | undefined, seconds: number): number {
    if (speed === 0) {
      if (this.#motion === 'moving') {
        this.#stop('stopped');
      }
      return STATUS.OK;
    }
    const bad = this.#refuse(Math.abs(speed), accel);
    if (bad !== null) {
      return bad;
    }
    this.#clearFault();
    const c = this.#cfg;
    const [lo, hi] = c.limits ? [c.limit_min, c.limit_max] : [-BOUND, BOUND];
    this.#begin({ kind: 'spin', speed, accel: accel ?? c.accel, lo, hi }, null);
    this.#jogUntil = seconds > 0 ? this.#t + seconds * 1000 : null;
    return STATUS.OK;
  }

  /** The checks a move and a jog share (D10): INVALID_ARGS, then the BUSYs; null when it may run. */
  #refuse(speed: number | undefined, accel: number | undefined): number | null {
    const c = this.#cfg;
    if ((speed !== undefined && speed > c.max_speed_hz) || (accel !== undefined && accel > c.accel)) {
      return STATUS.INVALID_ARGS;
    }
    if (this.#t < this.#backoffUntil || (c.limits && !this.#known)) {
      return STATUS.BUSY;
    }
    return null;
  }

  /** A new motion, replacing the running one without stopping and without its done. */
  #begin(plan: Plan, doneTarget: number | null): void {
    this.#plan = plan;
    this.#doneTarget = doneTarget;
    this.#jogUntil = null;
    this.#releaseAt = null;
    this.#hubEpoch = this.#hub()?.epoch ?? null;
    this.#setMotion('moving');
  }

  #stop(reason: StepperDoneReason): void {
    this.#plan = { kind: 'spin', speed: 0, accel: this.#plan!.accel, lo: -BOUND, hi: BOUND };
    this.#stopReason = reason;
    this.#jogUntil = null;
    this.#setMotion('stopping');
  }

  #halt(): number {
    if (this.#running()) {
      this.#loseIfFast();
      const target = this.#doneTarget;
      this.#halted('holding');
      this.#releaseAfterMotion();
      this.#out.event('done', { reason: 'halted', position: this.position, target: target ?? this.position, slips: 0 });
    }
    return STATUS.OK;
  }

  /** Holds at hold power until release or the next motion's end; clears a fault after its back-off. BUSY while a
   *  motion runs, as the service. */
  #hold(): number {
    if (this.#running()) {
      return STATUS.BUSY;
    }
    if (this.#t < this.#backoffUntil) {
      return STATUS.BUSY;
    }
    this.#releaseAt = null;
    this.#setMotion('holding');
    return STATUS.OK;
  }

  #release(): void {
    if (this.#running()) {
      this.#loseIfFast();
      const target = this.#doneTarget;
      this.#halted('released');
      this.#out.event('done', { reason: 'released', position: this.position, target: target ?? this.position, slips: 0 });
      return;
    }
    this.#releaseAt = null;
    this.#setMotion('released');
  }

  #zero(position: number): number {
    if (this.#running()) {
      return STATUS.BUSY;
    }
    this.#pos = position;
    this.#known = true;
    this.#reportPosition();
    this.#put('position_known', true);
    return STATUS.OK;
  }

  #configure(a: Record<string, unknown>): number {
    if (this.#running()) {
      return STATUS.BUSY;
    }
    const given = Object.fromEntries(SETTINGS.filter((k) => a[k] !== undefined).map((k) => [k, k === 'step_mode' ? modeName(a[k] as Mode) : a[k]])) as Partial<Settings>;
    // The dashboard's form sends the current step_mode back with every change: only a new one needs the coils off.
    const mode = given.step_mode ?? this.#cfg.step_mode;
    if (mode !== this.#cfg.step_mode && this.#motion !== 'released') {
      return STATUS.BUSY;
    }
    const next = { ...this.#cfg };
    let position = this.#pos;
    if (mode !== this.#cfg.step_mode) {
      const f = 2 ** (MODES.indexOf(mode) - MODES.indexOf(this.#cfg.step_mode));
      const scale = (v: number) => clamp(roundAway(v * f), [-BOUND, BOUND]);
      position = scale(position);
      next.limit_min = scale(next.limit_min);
      next.limit_max = scale(next.limit_max);
      next.max_speed_hz = clamp(roundAway(next.max_speed_hz * f), SPEED_RANGE);
      next.accel = clamp(roundAway(next.accel * f), ACCEL_RANGE);
      next.start_hz = clamp(roundAway(next.start_hz * f), SPEED_RANGE);
    }
    Object.assign(next, given);
    if (next.limit_min >= next.limit_max) {
      return STATUS.INVALID_ARGS;
    }
    this.#cfg = next;
    this.#pos = position;
    this.#reportPosition();
    this.#reportSettings();
    return STATUS.OK;
  }

  #resetSettings(): number {
    if (this.#motion !== 'released') {
      return STATUS.BUSY;
    }
    const build = this.#fromBuild();
    this.#pos = clamp(roundAway(this.#pos * 2 ** (MODES.indexOf(build.step_mode) - MODES.indexOf(this.#cfg.step_mode))), [-BOUND, BOUND]);
    this.#cfg = build;
    this.#reportPosition();
    this.#reportSettings();
    return STATUS.OK;
  }

  // ---- motion ----

  /** One slice of `h` seconds of the running plan. */
  #slice(h: number): void {
    const p = this.#plan!;
    const dv = p.accel * h;
    let v = this.#v;
    if (p.kind === 'to') {
      const d = p.target - this.#pos;
      const toward = Math.sign(d);
      if (toward === 0 && v === 0) {
        this.#rest('reached');
        return;
      }
      if (v * toward < 0 || toward === 0) {
        v = v > 0 ? Math.max(0, v - dv) : Math.min(0, v + dv); // moving away (an overshoot, a target behind): brake
      } else {
        // Up to the move's speed, and never above the speed it can still stop from: the v² = 2·a·d braking curve.
        const cap = Math.min(p.vmax, Math.sqrt(2 * p.accel * Math.abs(d)));
        const s = Math.abs(v);
        v = toward * (s < cap ? Math.min(s + dv, cap) : Math.max(s - dv, cap));
      }
      const next = this.#pos + v * h;
      // Reaching it within this slice at a speed it could stop from by then (within a step, as the engine's last
      // step) ends the move on it; faster, it passes and comes back.
      if (toward !== 0 && (p.target - next) * toward <= 0 && v * v <= 2 * p.accel * (Math.abs(d) + 1)) {
        this.#pos = p.target;
        this.#v = 0;
        this.#rest('reached');
        return;
      }
      this.#pos = next;
      this.#v = v;
      return;
    }
    if (v !== 0 && Math.sign(p.speed) !== Math.sign(v)) {
      v = v > 0 ? Math.max(0, v - dv) : Math.min(0, v + dv); // a stop, or a reversal through zero speed
    } else {
      v = v < p.speed ? Math.min(v + dv, p.speed) : Math.max(v - dv, p.speed);
    }
    if (v === 0 && p.speed === 0) {
      this.#v = 0;
      this.#pos = Math.round(this.#pos);
      this.#rest(this.#stopReason);
      return;
    }
    const dir = v !== 0 ? Math.sign(v) : Math.sign(p.speed);
    const bound = dir > 0 ? p.hi : p.lo;
    const room = (bound - this.#pos) * dir;
    v = dir * Math.min(Math.abs(v), Math.sqrt(2 * p.accel * Math.max(0, room)));
    const next = this.#pos + v * h;
    if (room <= 0 || (bound - next) * dir <= 0) {
      this.#pos = bound;
      this.#v = 0;
      this.#rest('limit');
      return;
    }
    this.#pos = next;
    this.#v = v;
  }

  /** The engine came to rest: done once, hold, and the idle release after it. */
  #rest(reason: StepperDoneReason): void {
    const target = this.#doneTarget ?? this.position;
    this.#halted('holding');
    this.#releaseAfterMotion();
    this.#out.event('done', { reason, position: this.position, target, slips: 0 });
  }

  /** Motion ends at once in `motion`: position on a whole step, speed 0, the exact values reported. */
  #halted(motion: StepperMotion): void {
    this.#plan = null;
    this.#v = 0;
    this.#pos = Math.round(this.#pos);
    this.#doneTarget = null;
    this.#jogUntil = null;
    this.#hubEpoch = null;
    this.#releaseAt = null;
    this.#setMotion(motion);
    this.#reportPosition();
  }

  /** A halt, a release or a fault above start_hz loses the position (D10). */
  #loseIfFast(): void {
    if (Math.abs(this.#v) > this.#cfg.start_hz && this.#known) {
      this.#known = false;
      this.#put('position_known', false);
    }
  }

  #releaseAfterMotion(): void {
    this.#releaseAt = this.#cfg.release_ms > 0 ? this.#t + this.#cfg.release_ms : null;
  }

  /** After its back-off a fault clears on the next motion (released, then as from released). */
  #clearFault(): void {
    if (this.#motion === 'fault') {
      this.#setMotion('released');
    }
  }

  /** The deadlines of D10: a jog's seconds, the hub's silence, the idle release. */
  #timers(): void {
    if (this.#motion === 'moving' && this.#jogUntil !== null && this.#t >= this.#jogUntil) {
      this.#stop('elapsed');
    }
    if (this.#motion === 'moving' && this.#hubEpoch !== null) {
      const link = this.#hub();
      if (!link || link.epoch !== this.#hubEpoch || this.#t - link.heardAt >= HUB_SILENT_MS) {
        this.#stop('hub_lost');
      }
    }
    if (this.#motion === 'holding' && this.#releaseAt !== null && this.#t >= this.#releaseAt) {
      this.#releaseAt = null;
      this.#setMotion('released');
    }
  }

  #running(): boolean {
    return this.#motion === 'moving' || this.#motion === 'stopping';
  }

  // ---- reports ----

  #fromBuild(): Settings {
    const b = this.build;
    return { ...Object.fromEntries(SETTINGS.map((k) => [k, b[k]])), step_mode: modeName(b.step_mode) } as Settings;
  }

  #setMotion(m: StepperMotion): void {
    this.#motion = m;
    this.#put('motion', m);
  }

  /** position and speed_hz now; target with them while nothing plans an end (a spin, or at rest). */
  #reportPosition(): void {
    this.#lastReport = this.#t;
    this.#put('position', this.position);
    this.#put('speed_hz', this.speed);
    if (this.#plan?.kind !== 'to') {
      this.#put('target', this.position);
    }
  }

  #reportSettings(): void {
    for (const k of SETTINGS) {
      this.#put(k, this.#cfg[k]);
    }
    const c = this.#cfg;
    const runPermille = Math.min(1000, Math.floor((c.run_ma * c.coil_ohm * 1000) / c.supply_mv));
    this.#put('run_duty_pct', Math.ceil(runPermille / 10));
  }

  /** A STATE when the value changed since it was last sent. */
  #put(name: string, value: unknown): void {
    if (this.#sent.get(name) !== value) {
      this.#sent.set(name, value);
      this.#out.state(name, value);
    }
  }
}

// ---- the board ----

export interface FakeStepperOptions {
  mac: string;
  addr: number;
  net: number;
  alias: string;
  aliasRev: number;
  epoch: number;
  fwPrefix?: string;
  hub: { tcp: number; udp: number };
  /** The build's motor config (default c3s-stepper's). */
  config?: Partial<StepperConfig>;
}

export interface FakeStepper {
  node: FakeNode;
  sim: StepperSim;
  buzzer: BuzzerSim;
  /** The LIC (fr.battery `cap`), the solenoid (`kick`) and the vibration motor (`buzz`). */
  cell: LicSim;
  kick: HapticSim;
  buzz: HapticSim;
  /** nFAULT fell: fault {driver}. */
  fault(): void;
  /** The capacitor drawn down to 3.0 V, its charger held off for 30 s (BUSY, then a cut). */
  drain(): void;
  stop(): Promise<void>;
}

const enc = (cap: string, part: 'event' | 'state', member: string, v: unknown) => {
  const e = encodeMember(cap, part, member, v);
  if (!e.ok) {
    throw new Error(`${cap}.${member}: ${e.detail}`);
  }
  return e.value;
};

export async function startFakeStepper(o: FakeStepperOptions): Promise<FakeStepper> {
  const node = new FakeNode({ mac: o.mac, addr: o.addr, net: o.net, alias: o.alias, aliasRev: o.aliasRev, epoch: o.epoch, hub: o.hub, chip: ESP32C3, ...(o.fwPrefix ? { fwPrefix: o.fwPrefix } : {}) });
  node.describeAs(STEPPER_CAPS);
  const cap = findCap('fr.stepper')!;
  let closed = false;
  // The hub's newest frame, as fr_net's link_info().hub_heard_at: the FakeNode keeps every frame it took.
  let framesSeen = 0;
  let heardAt = performance.now();
  const sim = new StepperSim({
    config: o.config ?? C3S_STEPPER_CONFIG,
    now: () => performance.now(),
    hub: () => (node.welcome && !node.tcpClosed ? { epoch: node.welcome.hub_epoch, heardAt } : null),
    out: {
      state(name, value) {
        if (!closed) {
          node.state(MOTOR_PORT, cap.properties.find((p) => p.name === name)!.id, enc('fr.stepper', 'state', name, { [name]: value }));
        }
      },
      event(name, fields) {
        if (!closed) {
          node.event(MOTOR_PORT, cap.events.find((e) => e.name === name)!.id, enc('fr.stepper', 'event', name, fields));
        }
      },
    },
  });
  for (const c of cap.commands) {
    node.handlers.set(`${MOTOR_PORT}/${c.id}`, (args) => {
      const d = decodeMember('fr.stepper', 'args', c.name, args);
      return { status: d.ok ? sim.command(c.name, d.value) : STATUS.INVALID_ARGS };
    });
  }
  const bcap = findCap('fr.buzzer')!;
  const buzzer = new BuzzerSim({
    now: () => performance.now(),
    hub: () => (node.welcome && !node.tcpClosed ? { epoch: node.welcome.hub_epoch, heardAt } : null),
    out: {
      state(name, value) {
        if (!closed) {
          node.state(BUZZER_PORT, bcap.properties.find((p) => p.name === name)!.id, enc('fr.buzzer', 'state', name, { [name]: value }));
        }
      },
      event(name, fields) {
        if (!closed) {
          node.event(BUZZER_PORT, bcap.events.find((e) => e.name === name)!.id, enc('fr.buzzer', 'event', name, fields));
        }
      },
    },
  });
  for (const c of bcap.commands) {
    node.handlers.set(`${BUZZER_PORT}/${c.id}`, (args) => {
      const d = decodeMember('fr.buzzer', 'args', c.name, args);
      return { status: d.ok ? buzzer.command(c.name, d.value) : STATUS.INVALID_ARGS };
    });
  }
  // The capacitor, the solenoid and the vibration motor (design haptic-h1 D12).
  const batCap = findCap('fr.battery')!;
  const hapCap = findCap('fr.haptic')!;
  const hub = () => (node.welcome && !node.tcpClosed ? { epoch: node.welcome.hub_epoch, heardAt } : null);
  const cell = new LicSim({
    now: () => performance.now(),
    out: {
      state(name, value) {
        if (!closed) {
          node.state(CAP_PORT, batCap.properties.find((p) => p.name === name)!.id, enc('fr.battery', 'state', name, { [name]: value }));
        }
      },
      event(name, fields) {
        if (!closed) {
          node.event(CAP_PORT, batCap.events.find((e) => e.name === name)!.id, enc('fr.battery', 'event', name, fields));
        }
      },
    },
  });
  const haptic = (port: number, config: typeof KICK_CONFIG | typeof BUZZ_CONFIG) =>
    new HapticSim({
      config: { kind: config.kind, rated_mv: config.rated_mv },
      now: () => performance.now(),
      supply: cell,
      draw: (ampMs) => cell.draw(ampMs),
      hub,
      out: {
        state(name, value) {
          if (!closed) {
            node.state(port, hapCap.properties.find((p) => p.name === name)!.id, enc('fr.haptic', 'state', name, { [name]: value }));
          }
        },
        event(name, fields) {
          if (!closed) {
            node.event(port, hapCap.events.find((e) => e.name === name)!.id, enc('fr.haptic', 'event', name, fields));
          }
        },
      },
    });
  const kick = haptic(KICK_PORT, KICK_CONFIG);
  const buzz = haptic(BUZZ_PORT, BUZZ_CONFIG);
  for (const c of batCap.commands) {
    node.handlers.set(`${CAP_PORT}/${c.id}`, () => ({ status: cell.command(c.name) }));
  }
  for (const [port, sim] of [[KICK_PORT, kick], [BUZZ_PORT, buzz]] as const) {
    for (const c of hapCap.commands) {
      node.handlers.set(`${port}/${c.id}`, (args) => {
        const d = decodeMember('fr.haptic', 'args', c.name, args);
        return { status: d.ok ? sim.command(c.name, d.value) : STATUS.INVALID_ARGS };
      });
    }
  }
  // The status LED's set, as the camera's fake keeps it.
  node.handlers.set('2/1', (args) => {
    const d = decodeMember('fr.led', 'args', 'set', args);
    if (d.ok && d.value.on !== undefined) {
      node.state(2, 1, enc('fr.led', 'state', 'on', { on: d.value.on }));
    }
    return undefined;
  });

  await node.connect(10_000);
  sim.reportAll();
  buzzer.reportAll();
  cell.reportAll();
  kick.reportAll();
  buzz.reportAll();
  const timer = setInterval(() => {
    if (node.frames.length !== framesSeen) {
      framesSeen = node.frames.length;
      heardAt = performance.now();
    }
    sim.tick();
    buzzer.tick();
    kick.tick();
    buzz.tick();
    cell.tick();
  }, TICK_MS);
  return {
    node,
    sim,
    buzzer,
    cell,
    kick,
    buzz,
    fault: () => sim.fault('driver'),
    drain: () => cell.drain(),
    async stop() {
      closed = true;
      clearInterval(timer);
      node.close();
    },
  };
}
