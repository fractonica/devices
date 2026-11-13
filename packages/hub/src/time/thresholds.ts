// time.threshold events: the hub announces each quarter boundary (peak, node, valley, end) of the Fractonica levels as
// it passes, from the temporal core (@fractonica/time). `fr wait event time.threshold`, /ws, /app and the dashboard's
// Live view get them like any other event.
//
// Which levels, and where they go (config.json `time`, re-read at each pass):
// - α down to `durable_to` (default η, the Helion): published and stored, a row each in `events`. About 20 rows a day
//   (the Helion's four thresholds every Helion, about 5 h; the coarser levels add one every few days).
// - below that, down to `live_to` (default ι, the Preon): live only. Subscribers (/ws, /app, a wait already
//   waiting) get them; no row is written, so they never fill hub.db (θ about 170 a day, ι about 690).
// - finer levels: not announced. `live_to` goes down to ν (the Blink) at most; time_next lists any level's
//   thresholds on demand instead.
// - `thresholds: false` announces none.
//
// Timing: one timer for the earliest pending threshold, never a poll: it fires at that instant (re-armed at most a
// minute ahead, so a change of the wall clock or of the config is seen within a minute). A threshold is announced
// once the wall clock has passed it. When the hub was asleep or the clock jumped, thresholds more than a minute
// old are skipped, not announced late; within that minute each one passed is announced, oldest first, coarse levels
// first at a shared instant.
//
// Fields: level (0 = α), depth (level + 1), symbol (η), unit (Helion; null for a level between units), quarter (the
// core's word in lower case: peak, node, valley, end), cycle (the global index of the cycle whose quarter ends, as a
// decimal string), at (the threshold's instant, Unix µs as a decimal string) and stamp (the stamp at that instant).
// t_hub_us is when the hub published it. Every value is the core's.

import { DateForm, loadCore, parseLevel, TimeError, Unit, type Core } from '@fractonica/time';

import { guarded } from '../crash.ts';
import type { Events } from '../context.ts';
import { nowUs } from '../ring.ts';

export const THRESHOLD_EVENT = 'time.threshold';
/** Thresholds older than this when the hub sees them are skipped (it was asleep, or the clock jumped). */
export const THRESHOLD_GRACE_US = 60_000_000n;
/** The timer is re-armed at least this often, so a clock or config change is seen within it. */
export const THRESHOLD_MAX_WAIT_MS = 60_000;
/** At most this many thresholds of one level are announced in one pass. */
const BURST = 64;

export interface ThresholdConfig {
  thresholds: boolean;
  durable_to: string;
  live_to: string;
}

export interface ThresholdTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ThresholdOptions {
  events: Pick<Events, 'publish'>;
  /** config.json `time`, read at each pass. */
  config: () => ThresholdConfig;
  /** The wall clock, Unix µs (default: the core's frc.now, the machine's clock). Tests pass a fake one. */
  now?: () => bigint;
  /** The hub's clock for t_hub_us (default ring.ts nowUs). */
  hubNowUs?: () => number;
  timers?: ThresholdTimers;
  /** One JSON log line (default: stderr). */
  log?: (line: Record<string, unknown>) => void;
}

interface Pending {
  /** The quarter that ends (frc_quarter_t), when, and the cycle it is a quarter of. */
  name: number;
  time: bigint;
  cycle: bigint;
}

export interface ThresholdLevels {
  /** Levels 0..durable are stored; durable+1..live are live only; -1 when none. */
  durable: number;
  live: number;
}

const DEFAULTS: ThresholdConfig = { thresholds: true, durable_to: 'η', live_to: 'ι' };

export class TimeThresholds {
  #o: ThresholdOptions;
  #core: Core | null = null;
  #pending = new Map<number, Pending>();
  #timer: unknown = null;
  #timers: ThresholdTimers;
  #levelsKey = '';
  #levels: ThresholdLevels = { durable: -1, live: -1 };
  #stopped = true;
  /** Announced since start, by kind. */
  readonly counts = { durable: 0, live: 0, skipped: 0 };

  constructor(opts: ThresholdOptions) {
    this.#o = opts;
    this.#timers = opts.timers ?? {
      set: (fn, ms) => {
        const h = setTimeout(fn, ms);
        h.unref?.();
        return h;
      },
      clear: (h) => clearTimeout(h as NodeJS.Timeout),
    };
  }

  async start(): Promise<void> {
    this.#core = await loadCore();
    this.#stopped = false;
    this.tick();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) {
      this.#timers.clear(this.#timer);
      this.#timer = null;
    }
    this.#pending.clear();
  }

  /** The levels announced, as the config names them now. */
  levels(): ThresholdLevels {
    this.#resolve(this.#o.config());
    return { ...this.#levels };
  }

  /** The earliest threshold waited for (Unix µs), or null. */
  nextAt(): bigint | null {
    let best: bigint | null = null;
    for (const p of this.#pending.values()) {
      if (best === null || p.time < best) {
        best = p.time;
      }
    }
    return best;
  }

  #log(line: Record<string, unknown>): void {
    (this.#o.log ?? ((l) => console.error(JSON.stringify(l))))(line);
  }

  /** The config's levels by the core's names; a name it cannot read is logged and its default used. */
  #resolve(cfg: ThresholdConfig): void {
    const core = this.#core!;
    const key = `${cfg.thresholds}|${cfg.durable_to}|${cfg.live_to}`;
    if (key === this.#levelsKey) {
      return;
    }
    this.#levelsKey = key;
    if (!cfg.thresholds) {
      this.#levels = { durable: -1, live: -1 };
      return;
    }
    const blink = core.frc.unitLevel(Unit.BLINK)!;
    const level = (name: string, fallback: string, what: string) => {
      try {
        return parseLevel(core, name);
      } catch (e) {
        if (!(e instanceof TimeError)) {
          throw e;
        }
        this.#log({ event: 'config_problem', message: `config.json time.${what}: ${e.message}; using ${fallback}` });
        return parseLevel(core, fallback);
      }
    };
    const durable = Math.min(level(cfg.durable_to, DEFAULTS.durable_to, 'durable_to'), blink);
    const live = Math.min(level(cfg.live_to, DEFAULTS.live_to, 'live_to'), blink);
    this.#levels = { durable, live: Math.max(durable, live) };
  }

  /** The threshold of `level` strictly after `t`, and the cycle it ends a quarter of; null after the catalogue. */
  #after(level: number, t: bigint): Pending | null {
    const { cat } = this.#core!;
    if (!cat.contains(t)) {
      return null;
    }
    const th = cat.nextThreshold(t, level);
    return th.time === null ? null : { name: th.name, time: th.time, cycle: cat.cycleAt(t, level).cycle };
  }

  #announce(level: number, p: Pending): void {
    const { frc, cat } = this.#core!;
    const durable = level <= this.#levels.durable;
    const unit = frc.unitOfLevel(level);
    this.#o.events.publish(
      {
        type: THRESHOLD_EVENT,
        t_hub_us: (this.#o.hubNowUs ?? nowUs)(),
        fields: {
          level,
          depth: level + 1,
          symbol: frc.formatLevelName(level),
          unit: unit === null ? null : frc.formatUnitName(unit),
          quarter: frc.formatQuarter(p.name, true),
          cycle: String(p.cycle),
          at: String(p.time),
          stamp: frc.formatDate(cat.dateAt(p.time), DateForm.LETTERS, Unit.BLINK),
        },
      },
      { durable },
    );
    this.counts[durable ? 'durable' : 'live']++;
  }

  /** One pass: announce what has passed, then wait for the next. Tests call it after moving their clock. */
  tick(): void {
    if (this.#stopped || !this.#core) {
      return;
    }
    if (this.#timer !== null) {
      this.#timers.clear(this.#timer);
      this.#timer = null;
    }
    this.#resolve(this.#o.config());
    const now = (this.#o.now ?? (() => this.#core!.frc.now()))();
    const deepest = this.#levels.live;
    for (const level of [...this.#pending.keys()]) {
      if (level > deepest) {
        this.#pending.delete(level);
      }
    }
    for (let level = 0; level <= deepest; level++) {
      let p = this.#pending.has(level) ? this.#pending.get(level)! : this.#after(level, now);
      let burst = 0;
      while (p && p.time <= now) {
        if (now - p.time > THRESHOLD_GRACE_US) {
          // asleep or a clock jump: from a minute ago on, nothing older
          this.counts.skipped++;
          p = this.#after(level, now - THRESHOLD_GRACE_US - 1n);
          continue;
        }
        if (burst++ >= BURST) {
          p = this.#after(level, now);
          break;
        }
        this.#announce(level, p);
        p = this.#after(level, p.time);
      }
      if (p) {
        this.#pending.set(level, p);
      } else {
        this.#pending.delete(level);
      }
    }
    const next = this.nextAt();
    const waitMs = next === null ? THRESHOLD_MAX_WAIT_MS : Math.min(THRESHOLD_MAX_WAIT_MS, Math.max(1, Number((next - now + 999n) / 1000n)));
    this.#timer = this.#timers.set(
      guarded('time.thresholds', () => this.tick()),
      waitMs,
    );
  }
}

export function createTimeThresholds(opts: ThresholdOptions): TimeThresholds {
  return new TimeThresholds(opts);
}
