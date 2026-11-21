// A fake buzzer for the scratch hub (tools/dash-dev.ts --stepper, whose fake board is c3s-stepper with its `buzzer`;
// design buzzer-b1 D10): BuzzerSim answers fr.buzzer's commands as BuzzerService does (D2, D5, D6), on a simulated clock,
// so the dashboard's buzzer panel can be worked on without a board:
// - the answers: INVALID_ARGS for a pitch outside min_hz..max_hz (a melody's rest excepted), a melody with no notes,
//   lists of different lengths or a note of 0 ms, and a volume above 100; stop and set_volume always OK;
// - one sound at a time: tone, beep and melody replace what plays (done replaced, `playing` stays true); stop ends it
//   (done stopped); a beep's last pause is not played, a melody's gap is inside its notes (min(gap_ms, half a note));
//   count or repeat 0 runs until stop;
// - time: the sound's steps are reckoned from its start and checked at each tick (the fake's resolution, 20 ms on the
//   board), so done comes at the sound's length rounded up to a tick;
// - hub silence: a sound started under a hub session ends with done hub_lost 10 s after the hub's newest frame, or at
//   another hub run;
// - the reports: playing and volume on change.
// It also says what sounds now (pitch and duty), which no wire carries: the fake board's log line for a person.
// Never a real board, a serial port or the lab hub: it speaks only to the private hub it is given.

import { STATUS } from '@fractonica/protocol/gen';

/** c3s-stepper's buzzer config (design buzzer-b1 D8): the capability's defaults. */
export const BUZZER_CONFIG = { volume: 50, beep_hz: 2000 } as const;
/** ledc_buzzer's traits (driver.yaml). */
export const BUZZER_TRAITS = { pitched: true, volume: true, min_hz: 100, max_hz: 20000 } as const;
/** BuzzerService's kHubSilentUs. */
export const BUZZER_HUB_SILENT_MS = 10_000;
const MAX_NOTES = 32;

export type BuzzerSound = 'tone' | 'beep' | 'melody';
export type BuzzerDoneReason = 'done' | 'stopped' | 'replaced' | 'hub_lost' | 'error';

/** Where the buzzer's STATE and EVENT bodies go (the JSON form of the generated codecs). */
export interface BuzzerOut {
  state(name: 'playing' | 'volume', value: unknown): void;
  event(name: 'done', fields: { sound: BuzzerSound; reason: BuzzerDoneReason }): void;
}

/** The hub session as the node sees it: its run's epoch and when its newest frame arrived (the sim's clock, ms). */
export interface BuzzerHubLink {
  epoch: number;
  heardAt: number;
}

export interface BuzzerSimOptions {
  config?: Partial<{ volume: number; beep_hz: number }>;
  /** Milliseconds, never going back. */
  now: () => number;
  out: BuzzerOut;
  /** The hub session now, or null without one. */
  hub?: () => BuzzerHubLink | null;
}

/** One step of a sound: a pitch (0: silent) for some milliseconds. */
interface Step {
  hz: number;
  ms: number;
}

/** BuzzerService's volume curve (design buzzer-b1 D3): the duty in permille for a volume, linear in amplitude. */
export function dutyForVolume(volume: number): number {
  if (volume <= 0) {
    return 0;
  }
  if (volume >= 100) {
    return 500;
  }
  return Math.round((Math.asin(volume / 100) / Math.PI) * 1000);
}

const num = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);

/** fr.buzzer's service on a simulated clock: commands answer at once, tick() moves time on. */
export class BuzzerSim {
  readonly traits = BUZZER_TRAITS;
  readonly beepHz: number;
  #now: () => number;
  #out: BuzzerOut;
  #hub: () => BuzzerHubLink | null;
  #volume: number;
  #level: number;
  #steps: Step[] = [];
  #step = 0;
  #stepEnd = 0;
  #repeatsLeft = 0;
  #forever = false;
  #trimTail = false;
  #sound: BuzzerSound = 'tone';
  #playing = false;
  #hubEpoch: number | null = null;
  #sent = new Map<string, unknown>();

  constructor(o: BuzzerSimOptions) {
    this.#now = o.now;
    this.#out = o.out;
    this.#hub = o.hub ?? (() => null);
    this.#volume = Math.min(100, num(o.config?.volume, BUZZER_CONFIG.volume));
    this.#level = this.#volume;
    this.beepHz = num(o.config?.beep_hz, BUZZER_CONFIG.beep_hz);
  }

  get playing(): boolean {
    return this.#playing;
  }
  get volume(): number {
    return this.#volume;
  }
  get sound(): BuzzerSound | null {
    return this.#playing ? this.#sound : null;
  }
  /** What the pad plays now: a pitch and a duty in permille (0: silent). */
  get sounding(): { hz: number; duty: number } {
    const s = this.#playing ? this.#steps[this.#step] : undefined;
    if (!s || s.hz === 0 || this.#level === 0) {
      return { hz: 0, duty: 0 };
    }
    return { hz: s.hz, duty: dutyForVolume(this.#level) };
  }

  reportAll(): void {
    this.#sent.clear();
    this.#put('playing', this.#playing);
    this.#put('volume', this.#volume);
  }

  /** A command by name with its decoded args: the status BuzzerService would answer. */
  command(name: string, args: Record<string, unknown>): number {
    switch (name) {
      case 'tone':
        return this.#tone(args);
      case 'beep':
        return this.#beep(args);
      case 'melody':
        return this.#melody(args);
      case 'stop':
        if (this.#playing) {
          this.#finish('stopped');
        }
        return STATUS.OK;
      case 'set_volume': {
        const v = num(args.volume, -1);
        if (v < 0 || v > 100) {
          return STATUS.INVALID_ARGS;
        }
        this.#volume = v;
        if (this.#playing) {
          this.#level = v;
        }
        this.#put('volume', v);
        return STATUS.OK;
      }
      default:
        return STATUS.UNSUPPORTED;
    }
  }

  /** Moves time on: steps that ended, the sound's end, hub silence. */
  tick(): void {
    if (!this.#playing) {
      return;
    }
    const now = this.#now();
    if (this.#hubGone(now)) {
      this.#finish('hub_lost');
      return;
    }
    while (now >= this.#stepEnd) {
      this.#step += 1;
      const lastPass = !this.#forever && this.#repeatsLeft === 0;
      if (lastPass && this.#trimTail && this.#step === this.#steps.length - 1) {
        this.#finish('done');
        return;
      }
      if (this.#step === this.#steps.length) {
        if (lastPass) {
          this.#finish('done');
          return;
        }
        if (!this.#forever) {
          this.#repeatsLeft -= 1;
        }
        this.#step = 0;
      }
      this.#stepEnd += this.#steps[this.#step]!.ms;
    }
  }

  #pitchOk(hz: number, restOk: boolean): boolean {
    if (hz === 0) {
      return restOk;
    }
    return !this.traits.pitched || (hz >= this.traits.min_hz && hz <= this.traits.max_hz);
  }

  #volumeOf(args: Record<string, unknown>): number | null | undefined {
    if (args.volume === undefined) {
      return undefined;
    }
    const v = num(args.volume, -1);
    return v < 0 || v > 100 ? null : v;
  }

  #tone(args: Record<string, unknown>): number {
    const hz = num(args.freq_hz, 0);
    const ms = num(args.ms, 500);
    const vol = this.#volumeOf(args);
    if (ms < 1 || !this.#pitchOk(hz, false) || vol === null) {
      return STATUS.INVALID_ARGS;
    }
    return this.#start('tone', [{ hz, ms }], 1, vol);
  }

  #beep(args: Record<string, unknown>): number {
    const hz = num(args.freq_hz, this.beepHz);
    const on = num(args.on_ms, 100);
    const off = num(args.off_ms, 100);
    const vol = this.#volumeOf(args);
    if (on < 1 || off < 1 || !this.#pitchOk(hz, false) || vol === null) {
      return STATUS.INVALID_ARGS;
    }
    return this.#start('beep', [{ hz, ms: on }, { hz: 0, ms: off }], num(args.count, 1), vol);
  }

  #melody(args: Record<string, unknown>): number {
    const hz = Array.isArray(args.freq_hz) ? (args.freq_hz as unknown[]).map((v) => num(v, -1)) : [];
    const ms = Array.isArray(args.ms) ? (args.ms as unknown[]).map((v) => num(v, 0)) : [];
    const gap = num(args.gap_ms, 10);
    const vol = this.#volumeOf(args);
    if (hz.length === 0 || hz.length > MAX_NOTES || ms.length !== hz.length || vol === null) {
      return STATUS.INVALID_ARGS;
    }
    if (hz.some((h, i) => ms[i]! < 1 || !this.#pitchOk(h, true))) {
      return STATUS.INVALID_ARGS;
    }
    const steps: Step[] = [];
    hz.forEach((h, i) => {
      const note = ms[i]!;
      if (h === 0) {
        steps.push({ hz: 0, ms: note });
        return;
      }
      const g = Math.min(gap, note / 2);
      steps.push({ hz: h, ms: note - g });
      if (g > 0) {
        steps.push({ hz: 0, ms: g });
      }
    });
    return this.#start('melody', steps, num(args.repeat, 1), vol);
  }

  #start(sound: BuzzerSound, steps: Step[], repeat: number, volume: number | undefined): number {
    const now = this.#now();
    if (this.#playing) {
      this.#out.event('done', { sound: this.#sound, reason: 'replaced' });
    }
    this.#steps = steps;
    this.#step = 0;
    this.#stepEnd = now + steps[0]!.ms;
    this.#forever = repeat === 0;
    this.#repeatsLeft = this.#forever ? 0 : repeat - 1;
    this.#trimTail = sound === 'beep';
    this.#sound = sound;
    this.#level = volume ?? this.#volume;
    const hub = this.#hub();
    this.#hubEpoch = hub ? hub.epoch : null;
    this.#playing = true;
    this.#put('playing', true);
    return STATUS.OK;
  }

  #hubGone(now: number): boolean {
    if (this.#hubEpoch === null) {
      return false;
    }
    const hub = this.#hub();
    return !hub || hub.epoch !== this.#hubEpoch || now - hub.heardAt >= BUZZER_HUB_SILENT_MS;
  }

  #finish(reason: BuzzerDoneReason): void {
    this.#playing = false;
    this.#out.event('done', { sound: this.#sound, reason });
    this.#put('playing', false);
  }

  /** A STATE when the value changed since it was last sent. */
  #put(name: 'playing' | 'volume', value: unknown): void {
    if (this.#sent.get(name) !== value) {
      this.#sent.set(name, value);
      this.#out.state(name, value);
    }
  }
}
