// The hub's config file, `$FR_HOME/config.json` (paths.config()): settings a person edits or the port ops write.
// Every key is optional; a missing file is the defaults. Reading never fails: a file that is not JSON, or a key with a
// value of the wrong type, is reported in `problems` and that part falls back to its default, so a typo never stops
// the hub. The hub reads it through liveConfig, which keeps the last good value of a section the file no longer gives
// (a half-finished edit never drops ports.ignore), and has no value at all for one it never read cleanly. Writing (updateConfig) changes only the keys it is asked to and keeps every other key, known or not; it
// refuses to overwrite a file that is not valid JSON, so a person's half-finished edit is never lost.
//
//   {
//     "ports": {
//       "mode": "adopted",          // "adopted" (default): open only boards the hub knows; "all": every ESP32 and USB-UART port
//       "ignore": ["/dev/cu.usbmodem1101", "1a86:7523", "1cdbd4000134"],  // never opened: path, USB serial or MAC, VID:PID
//       "claim": ["/dev/cu.usbserial-110"]   // opened in adopted mode although no registered board is known on it
//     },
//     "retention": { "jobs_days": 30, "jobs_rows": 5000 },   // finished jobs (and their logs) kept
//     "log": { "max_bytes": 10485760, "keep": 3 },            // hub.log rotation
//     "mcp": { "autostart": false },                          // fr mcp may start a hub when none runs
//     "time": { "thresholds": true, "durable_to": "η", "live_to": "ι" }   // durable_to at most θ, live_to at most ν
//                     // time.threshold events: stored for α..durable_to, live only (subscribers, no row) down to live_to;
//                     // a level is a symbol, word, unit name or depth, which the hub reads with the temporal core
//   }

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { FrError } from '@fractonica/protocol';

import { paths } from './paths.ts';

export const PORT_MODES = ['adopted', 'all'] as const;
export type PortMode = (typeof PORT_MODES)[number];

export interface HubConfig {
  ports: { mode: PortMode; ignore: string[]; claim: string[] };
  retention: { jobs_days: number; jobs_rows: number };
  log: { max_bytes: number; keep: number };
  mcp: { autostart: boolean };
  /** time.threshold events (packages/hub/src/time/thresholds.ts): levels by name or depth, read by the hub. */
  time: { thresholds: boolean; durable_to: string; live_to: string };
}

export const DEFAULT_CONFIG: HubConfig = {
  ports: { mode: 'adopted', ignore: [], claim: [] },
  retention: { jobs_days: 30, jobs_rows: 5000 },
  log: { max_bytes: 10 * 1024 * 1024, keep: 3 },
  mcp: { autostart: false },
  time: { thresholds: true, durable_to: 'η', live_to: 'ι' },
};

/** A part of the file that could not be used: the whole file, or one section. */
export type ConfigPart = 'file' | keyof HubConfig;

export interface ConfigRead {
  config: HubConfig;
  /** The parts with a problem (their values in `config` are defaults): `file` when it could not be read or parsed. */
  bad: ConfigPart[];
  /** The file's top-level object as read (unknown keys included); null when absent or not a JSON object. */
  raw: Record<string, unknown> | null;
  file: string;
  exists: boolean;
  /** What is wrong with the file, one line each; empty when it is fine (or absent). */
  problems: string[];
  /** The file's mtime (ms), 0 when absent: a reader caches on it. */
  mtimeMs: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function defaults(): HubConfig {
  return structuredClone(DEFAULT_CONFIG);
}

/** The typed config from a parsed file: each known key checked, a bad one reported and left at its default. */
export function parseConfig(raw: unknown): { config: HubConfig; problems: string[]; bad: ConfigPart[] } {
  const config = defaults();
  const problems: string[] = [];
  const bad = new Set<ConfigPart>();
  if (raw === null || raw === undefined) {
    return { config, problems, bad: [] };
  }
  if (!isObject(raw)) {
    return { config, problems: ['the file is not a JSON object; using the defaults'], bad: ['file'] };
  }
  // Every problem is in a section: `where` starts with its name.
  const problem = (where: string, text: string) => {
    problems.push(text);
    bad.add(where.split('.')[0] as keyof HubConfig);
  };
  const section = (name: keyof HubConfig): Record<string, unknown> | null => {
    const v = raw[name];
    if (v === undefined) {
      return null;
    }
    if (!isObject(v)) {
      problem(name, `${name} is not an object; using its defaults`);
      return null;
    }
    return v;
  };
  const strings = (where: string, v: unknown): string[] | null => {
    if (v === undefined) {
      return null;
    }
    if (!Array.isArray(v) || !v.every((s) => typeof s === 'string' && s.trim() !== '')) {
      problem(where, `${where} is not a list of non-empty strings; ignored`);
      return null;
    }
    return v.map((s: string) => s.trim());
  };
  const positive = (where: string, v: unknown, integer = true): number | null => {
    if (v === undefined) {
      return null;
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || (integer && !Number.isInteger(v))) {
      problem(where, `${where} is not a positive ${integer ? 'integer' : 'number'}; using the default`);
      return null;
    }
    return v;
  };

  const ports = section('ports');
  if (ports) {
    if (ports.mode !== undefined) {
      if ((PORT_MODES as readonly unknown[]).includes(ports.mode)) {
        config.ports.mode = ports.mode as PortMode;
      } else {
        problem('ports', `ports.mode is ${JSON.stringify(ports.mode)}, not one of ${PORT_MODES.join(', ')}; using adopted`);
      }
    }
    config.ports.ignore = strings('ports.ignore', ports.ignore) ?? config.ports.ignore;
    config.ports.claim = strings('ports.claim', ports.claim) ?? config.ports.claim;
  }
  const retention = section('retention');
  if (retention) {
    config.retention.jobs_days = positive('retention.jobs_days', retention.jobs_days, false) ?? config.retention.jobs_days;
    config.retention.jobs_rows = positive('retention.jobs_rows', retention.jobs_rows) ?? config.retention.jobs_rows;
  }
  const log = section('log');
  if (log) {
    config.log.max_bytes = positive('log.max_bytes', log.max_bytes) ?? config.log.max_bytes;
    config.log.keep = positive('log.keep', log.keep) ?? config.log.keep;
  }
  const mcp = section('mcp');
  if (mcp && mcp.autostart !== undefined) {
    if (typeof mcp.autostart === 'boolean') {
      config.mcp.autostart = mcp.autostart;
    } else {
      problem('mcp', 'mcp.autostart is not true or false; using false');
    }
  }
  const time = section('time');
  if (time) {
    if (time.thresholds !== undefined) {
      if (typeof time.thresholds === 'boolean') {
        config.time.thresholds = time.thresholds;
      } else {
        problem('time', 'time.thresholds is not true or false; using true');
      }
    }
    for (const key of ['durable_to', 'live_to'] as const) {
      const v = time[key];
      if (v === undefined) {
        continue;
      }
      if ((typeof v === 'string' && v.trim() !== '') || (typeof v === 'number' && Number.isInteger(v) && v > 0)) {
        config.time[key] = String(v).trim();
      } else {
        problem('time', `time.${key} is not a level (a symbol such as η, a word or a depth); using ${DEFAULT_CONFIG.time[key]}`);
      }
    }
  }
  return { config, problems, bad: [...bad] };
}

/** Reads `file` (default $FR_HOME/config.json). Never throws: problems are reported, defaults fill in. */
export function readConfig(file = paths.config()): ConfigRead {
  if (!existsSync(file)) {
    return { config: defaults(), bad: [], raw: null, file, exists: false, problems: [], mtimeMs: 0 };
  }
  let mtimeMs = 0;
  let text: string;
  try {
    mtimeMs = statSync(file).mtimeMs;
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return { config: defaults(), bad: ['file'], raw: null, file, exists: true, problems: [`cannot read ${file}: ${(e as Error).message}`], mtimeMs };
  }
  let parsed: unknown;
  try {
    parsed = text.trim() === '' ? {} : JSON.parse(text);
  } catch (e) {
    return { config: defaults(), bad: ['file'], raw: null, file, exists: true, problems: [`${file} is not valid JSON (${(e as Error).message})`], mtimeMs };
  }
  const { config, problems, bad } = parseConfig(parsed);
  return { config, bad, raw: isObject(parsed) ? parsed : null, file, exists: true, problems: problems.map((p) => `${file}: ${p}`), mtimeMs };
}

/**
 * Changes the file through `mutate`, which edits the raw object in place (create sections it needs); every other key
 * stays as it was. Written to a temp file and renamed, so a reader never sees half a file. Refuses (INVALID_ARGS) to
 * overwrite a file that is not a JSON object.
 */
export function updateConfig(mutate: (raw: Record<string, unknown>) => void, file = paths.config()): ConfigRead {
  const before = readConfig(file);
  if (before.exists && before.raw === null) {
    throw new FrError('INVALID_ARGS', `${file} is not a valid JSON object, so it is left as it is`, {
      hint: before.problems.join('; '),
      remediation: [{ human: `fix or remove ${file}, then retry` }],
    });
  }
  const raw = structuredClone(before.raw ?? {});
  mutate(raw);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  renameSync(tmp, file);
  return readConfig(file);
}

/** The object at `raw[key]`, created when missing (or not an object). */
export function configSection(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = raw[key];
  if (isObject(v)) {
    return v;
  }
  const fresh: Record<string, unknown> = {};
  raw[key] = fresh;
  return fresh;
}

const SECTIONS = Object.keys(DEFAULT_CONFIG) as (keyof HubConfig)[];

/** What liveConfig reads: the file as read, with each section the file cannot give replaced by its last good value. */
export interface LiveConfigRead extends ConfigRead {
  /** Sections whose value is the last good read's, because the file cannot give them now. */
  held: (keyof HubConfig)[];
  /** Sections the file has not given cleanly since this reader started: their values are only the defaults. */
  unset: (keyof HubConfig)[];
}

export interface LiveConfig {
  /** The config, re-read when the file's mtime changed (checked at most every `everyMs`). */
  read(): LiveConfigRead;
  /** Re-reads now (after a port op wrote the file). */
  refresh(): LiveConfigRead;
}

/**
 * The config for a long-running process (the hub). A section the file cannot give (a syntax error makes that every
 * section; a wrong value, its own) keeps the value of the last read that gave it, so a half-finished hand edit never
 * drops ports.ignore and opens a port the owner protected. A section never read cleanly since the start is in `unset`:
 * its value is only the default, and a careful caller (the port policy, job pruning) does not act on it. `onProblems`
 * hears the problem list whenever it changes, the first read included (an empty list: the file is fine again).
 */
export function liveConfig(file = paths.config(), opts: { everyMs?: number; onProblems?: (problems: string[]) => void } = {}): LiveConfig {
  const everyMs = opts.everyMs ?? 1000;
  const good: Partial<HubConfig> = {};
  let last: LiveConfigRead | null = null;
  let checkedAt = 0;
  let told: string | null = null;
  const load = (): LiveConfigRead => {
    const r = readConfig(file);
    const config = structuredClone(r.config);
    const held: (keyof HubConfig)[] = [];
    const unset: (keyof HubConfig)[] = [];
    for (const s of SECTIONS) {
      const usable = !r.bad.includes('file') && !r.bad.includes(s);
      if (usable) {
        (good as Record<string, unknown>)[s] = structuredClone(r.config[s]);
      } else if (good[s] !== undefined) {
        (config as unknown as Record<string, unknown>)[s] = structuredClone(good[s]);
        held.push(s);
      } else {
        unset.push(s);
      }
    }
    const problems = [...r.problems];
    if (held.length) {
      problems.push(`${file}: keeping the ${held.join(', ')} settings read before, until the file is fixed`);
    }
    if (unset.includes('ports')) {
      problems.push(`${file}: no valid ports settings read since the hub started, so it opens no port until the file is fixed`);
    }
    const key = JSON.stringify(problems);
    if (key !== told) {
      told = key;
      opts.onProblems?.(problems);
    }
    return { ...r, config, problems, held, unset };
  };
  return {
    read() {
      const now = Date.now();
      if (last && now - checkedAt < everyMs) {
        return last;
      }
      checkedAt = now;
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(file).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      if (!last || mtimeMs !== last.mtimeMs || (mtimeMs === 0 && last.exists)) {
        last = load();
      }
      return last;
    },
    refresh() {
      checkedAt = Date.now();
      last = load();
      return last;
    },
  };
}
