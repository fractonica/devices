// The hub's config file, `$FR_HOME/config.json` (paths.config()): settings a person edits or the port ops write.
// Every key is optional; a missing file is the defaults. Reading never fails: a file that is not JSON, or a key with a
// value of the wrong type, is reported in `problems` and that part falls back to its default, so a typo never stops
// the hub. Writing (updateConfig) changes only the keys it is asked to and keeps every other key, known or not; it
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
//     "mcp": { "autostart": false }                           // fr mcp may start a hub when none runs
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
}

export const DEFAULT_CONFIG: HubConfig = {
  ports: { mode: 'adopted', ignore: [], claim: [] },
  retention: { jobs_days: 30, jobs_rows: 5000 },
  log: { max_bytes: 10 * 1024 * 1024, keep: 3 },
  mcp: { autostart: false },
};

export interface ConfigRead {
  config: HubConfig;
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
export function parseConfig(raw: unknown): { config: HubConfig; problems: string[] } {
  const config = defaults();
  const problems: string[] = [];
  if (raw === null || raw === undefined) {
    return { config, problems };
  }
  if (!isObject(raw)) {
    return { config, problems: ['the file is not a JSON object; using the defaults'] };
  }
  const section = (name: keyof HubConfig): Record<string, unknown> | null => {
    const v = raw[name];
    if (v === undefined) {
      return null;
    }
    if (!isObject(v)) {
      problems.push(`${name} is not an object; using its defaults`);
      return null;
    }
    return v;
  };
  const strings = (where: string, v: unknown): string[] | null => {
    if (v === undefined) {
      return null;
    }
    if (!Array.isArray(v) || !v.every((s) => typeof s === 'string' && s.trim() !== '')) {
      problems.push(`${where} is not a list of non-empty strings; ignored`);
      return null;
    }
    return v.map((s: string) => s.trim());
  };
  const positive = (where: string, v: unknown, integer = true): number | null => {
    if (v === undefined) {
      return null;
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || (integer && !Number.isInteger(v))) {
      problems.push(`${where} is not a positive ${integer ? 'integer' : 'number'}; using the default`);
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
        problems.push(`ports.mode is ${JSON.stringify(ports.mode)}, not one of ${PORT_MODES.join(', ')}; using adopted`);
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
      problems.push('mcp.autostart is not true or false; using false');
    }
  }
  return { config, problems };
}

/** Reads `file` (default $FR_HOME/config.json). Never throws: problems are reported, defaults fill in. */
export function readConfig(file = paths.config()): ConfigRead {
  if (!existsSync(file)) {
    return { config: defaults(), raw: null, file, exists: false, problems: [], mtimeMs: 0 };
  }
  let mtimeMs = 0;
  let text: string;
  try {
    mtimeMs = statSync(file).mtimeMs;
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return { config: defaults(), raw: null, file, exists: true, problems: [`cannot read ${file}: ${(e as Error).message}`], mtimeMs };
  }
  let parsed: unknown;
  try {
    parsed = text.trim() === '' ? {} : JSON.parse(text);
  } catch (e) {
    return { config: defaults(), raw: null, file, exists: true, problems: [`${file} is not valid JSON (${(e as Error).message}); using the defaults`], mtimeMs };
  }
  const { config, problems } = parseConfig(parsed);
  return { config, raw: isObject(parsed) ? parsed : null, file, exists: true, problems: problems.map((p) => `${file}: ${p}`), mtimeMs };
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

/** A reader that re-reads the file only when its mtime changed, at most every `everyMs`. */
export function cachedConfig(file = paths.config(), everyMs = 1000): () => ConfigRead {
  let last: ConfigRead | null = null;
  let checkedAt = 0;
  return () => {
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
      last = readConfig(file);
    }
    return last;
  };
}
