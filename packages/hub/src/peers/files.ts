// Files of an op that was passed on (design multi-hub-m2 §7.3).
//
// An op names a file by a path of the machine the call was made at: `out` (a recording, a photo, a directory of
// frames) or `in` (a WAV to play). The hub that runs the op is another machine, so the calling hub takes those fields
// out of the input and says only their names (passing.ts); this module is both ends of what follows.
//
// At the hub that runs the op, the spool: `FR_HOME/storage/.peers/<id>/`, one per call, made when the call arrives.
//   o-<field>/<name>   what the op writes for an `out` field (its input gets this path)
//   i-<field>/<name>   an `in` file, fetched from the calling hub before the op runs
// It is under FR_HOME/storage because that is where every op that writes or reads a file may do so (the `out` rules of
// audio, camera, csi, scale and storage, storage_put's rule for a source). A leading dot is no alias, so it never
// meets FR_HOME/storage/<alias>. The calling hub lists the spool (`spool_list`), pulls each file over a data channel
// to the directory of the path it was asked for, and drops the spool (`spool_drop`); one never pulled is removed
// SPOOL_KEEP_MS after it was made, at a hub start or at the next call.
//
// At the calling hub: an offer is a token for one `in` file, good until the call it was made for has answered. What
// the file is (a WAV, its length) is checked by the op at the hub that runs it; where it may come from is checked
// here, by storage_put's rule for a source (nothing of the hub's own, no key directory), since the other hub sees only
// its copy. The destination of a pull must be an absolute path under this hub's FR_HOME, the rule every `out` already
// has; storage_get's stricter one (under FR_HOME/storage, nothing overwritten) is applied here too.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { paths } from '@fractonica/host';
import { FrError, type OpDef } from '@fractonica/protocol';

import { underHome } from '../display/ops.ts';
import { checkGetOut, checkPutFile } from '../storage/ops.ts';
import type { CallMsg } from './wire.ts';

/** A spool nobody pulled is removed this long after it was made. */
export const SPOOL_KEEP_MS = 24 * 3600 * 1000;
/** A spool holds at most this many files for the calling hub (a timelapse of an hour at one frame a second). */
const SPOOL_MAX_FILES = 5000;

const SPOOL_ID = /^[0-9a-f]{16}$/;
const FIELD = /^[a-z][a-z0-9_]{0,31}$/;

export function spoolRoot(): string {
  return join(resolve(paths.home()), 'storage', '.peers');
}

/** The directory of spool `id`; INVALID_ARGS for something that is not a spool id. */
export function spoolDir(id: unknown): string {
  if (typeof id !== 'string' || !SPOOL_ID.test(id)) {
    throw new FrError('INVALID_ARGS', 'not a spool id');
  }
  return join(spoolRoot(), id);
}

/** A file name the calling hub gave: one path segment, nothing that climbs. */
function safeName(name: unknown): string {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || name.length > 255 || /[/\\\0]/.test(name)) {
    throw new FrError('INVALID_ARGS', `${JSON.stringify(name)} is not a file name`);
  }
  return name;
}

function safeField(field: string): string {
  if (!FIELD.test(field)) {
    throw new FrError('INVALID_ARGS', `${JSON.stringify(field)} is not an input field`);
  }
  return field;
}

/** A new spool for one call. */
export function newSpool(): { id: string; dir: string } {
  sweepSpools();
  const id = randomBytes(8).toString('hex');
  const dir = join(spoolRoot(), id);
  mkdirSync(dir, { recursive: true });
  return { id, dir };
}

/** Where the op writes its `out` field in a spool (its directory is made). */
export function spoolOutPath(id: string, field: string, name: string): string {
  const dir = join(spoolDir(id), `o-${safeField(field)}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, safeName(name));
}

/** Where an `in` file of the calling hub is put before the op runs. */
export function spoolInPath(id: string, field: string, name: string): string {
  const dir = join(spoolDir(id), `i-${safeField(field)}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, safeName(name));
}

export interface SpoolFile {
  /** `o-<field>/<name>[/<more>]`, with `/` whatever the machine's separator. */
  path: string;
  size: number;
}

/** The files an op left for its `out` fields, for the calling hub to pull. Temporary files of a writer are left out. */
export function listSpool(id: string): { root: string; files: SpoolFile[] } {
  const root = spoolDir(id);
  const files: SpoolFile[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile() && !/\.(tmp|part)-/.test(e.name)) {
        if (files.length >= SPOOL_MAX_FILES) {
          throw new FrError('INVALID_ARGS', `the op left more than ${SPOOL_MAX_FILES} files: they stay at this hub under ${root}`);
        }
        files.push({ path: relative(root, p).split(sep).join('/'), size: statSync(p).size });
      }
    }
  };
  if (existsSync(root)) {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith('o-')) {
        walk(join(root, e.name));
      }
    }
  }
  return { root, files };
}

/** The file of a spool a data channel may read: an entry of its `o-` trees, never a path that leaves them. */
export function spoolFile(id: unknown, path: unknown): string {
  const root = spoolDir(id);
  if (typeof path !== 'string' || !path.startsWith('o-') || path.split('/').some((s) => !s || s === '.' || s === '..' || /[\\\0]/.test(s))) {
    throw new FrError('INVALID_ARGS', 'not a file of that spool');
  }
  const p = join(root, ...path.split('/'));
  if (!existsSync(p)) {
    throw new FrError('NOT_FOUND', 'that file is not in the spool any more');
  }
  return p;
}

export function dropSpool(id: unknown): boolean {
  const dir = spoolDir(id);
  if (!existsSync(dir)) {
    return false;
  }
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Removes the spools older than SPOOL_KEEP_MS; how many. */
export function sweepSpools(now = Date.now()): number {
  let n = 0;
  let names: string[];
  try {
    names = readdirSync(spoolRoot());
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!SPOOL_ID.test(name)) {
      continue;
    }
    const dir = join(spoolRoot(), name);
    try {
      if (now - statSync(dir).mtimeMs > SPOOL_KEEP_MS) {
        rmSync(dir, { recursive: true, force: true });
        n++;
      }
    } catch {
      // gone meanwhile
    }
  }
  return n;
}

// ---- the calling hub ----

/** `in` files this hub lets a peer fetch, by token, while the call that named them runs. */
export class Offers {
  #byToken = new Map<string, string>();

  offer(path: string): { token: string; name: string; size: number } {
    let size: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) {
        throw new Error('not a regular file');
      }
      size = st.size;
    } catch (e) {
      throw new FrError('NOT_FOUND', `cannot read ${path}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (e as Error).message}`);
    }
    const token = randomBytes(12).toString('hex');
    this.#byToken.set(token, path);
    return { token, name: basename(path), size };
  }

  path(token: unknown): string {
    const p = typeof token === 'string' ? this.#byToken.get(token) : undefined;
    if (!p) {
      throw new FrError('NOT_FOUND', 'that file is not on offer (the call it belonged to has ended)');
    }
    return p;
  }

  release(tokens: readonly string[]): void {
    for (const t of tokens) {
      this.#byToken.delete(t);
    }
  }
}

/** The file fields of an input, taken out of it for the link. */
export interface SplitFiles {
  /** The input without its file fields. */
  input: Record<string, unknown>;
  files: CallMsg['files'];
  /** `out` field -> the path of this machine it was asked for. */
  wants: Record<string, string>;
  /** Tokens to release when the call has answered. */
  tokens: string[];
}

/**
 * Takes the `out` and `in` paths out of `input` (they are this machine's): the peer gets each field's file name, and
 * for an `in` file a token to fetch it by. An `out` must be an absolute path under this hub's FR_HOME, as the op asks
 * when it runs here.
 */
export function splitFiles(op: Pick<OpDef, 'files' | 'name'>, input: Record<string, unknown>, offers: Offers): SplitFiles {
  const out: SplitFiles = { input, files: undefined, wants: {}, tokens: [] };
  const outs = (op.files?.out ?? []).filter((f) => typeof input[f] === 'string');
  const ins = (op.files?.in ?? []).filter((f) => typeof input[f] === 'string');
  if (!outs.length && !ins.length) {
    return out;
  }
  out.input = { ...input };
  const files: NonNullable<CallMsg['files']> = {};
  for (const f of outs) {
    const p = input[f] as string;
    if (!isAbsolute(p)) {
      throw new FrError('INVALID_ARGS', `${f} must be an absolute path (got ${p}): the hub writes it, and its working directory is not yours`);
    }
    const o = resolve(p);
    if (!underHome(o)) {
      const home = resolve(paths.home());
      throw new FrError('INVALID_ARGS', `${f} ${p} is outside FR_HOME (${home}): the hub writes files only under FR_HOME`, { hint: `give a path under ${home} and copy the file from there` });
    }
    if (op.name === 'storage_get') {
      // storage_get's own rule, which the other hub cannot check for this machine: under FR_HOME/storage, and nothing
      // is overwritten (it opens with 'wx').
      checkGetOut(o);
      if (existsSync(o)) {
        throw new FrError('INVALID_ARGS', `${f} ${p} exists: storage_get overwrites nothing`, { hint: 'give another name, or remove the file' });
      }
    }
    out.wants[f] = o;
    (files.out ??= {})[f] = basename(o);
    delete out.input[f];
  }
  for (const f of ins) {
    // Nothing of the hub's own (FR_HOME but for FR_HOME/storage) and no key directory leaves this machine: storage_put's
    // rule for a source, applied to every file an op reads, since the hub that runs the op sees only its copy.
    const offer = offers.offer(checkPutFile(resolve(input[f] as string)));
    out.tokens.push(offer.token);
    (files.in ??= {})[f] = offer;
    delete out.input[f];
  }
  out.files = files;
  return out;
}

/** Where a spool entry `o-<field>/<name>/<more>` lands at the calling hub: beside the path `field` was asked for. */
export function destOf(wants: Record<string, string>, entry: string): string | null {
  const [head, name, ...more] = entry.split('/');
  const want = head?.startsWith('o-') ? wants[head.slice(2)] : undefined;
  if (!want || !name) {
    return null;
  }
  // The op was given `<spool>/o-<field>/<basename of the path asked for>`: an entry of that name is the path itself,
  // one beside it (a sidecar the op wrote next to its file) lands beside it.
  return name === basename(want) ? join(want, ...more) : join(dirname(want), name, ...more);
}

/**
 * Every string of `value` that is a path in the spool at `root` (the other hub's), as the path the file has at this
 * hub once pulled: what a result says of its file reads true where the command ran.
 */
export function localPaths<T>(value: T, root: string, wants: Record<string, string>): T {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const map = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (v.startsWith(prefix)) {
        const dest = destOf(wants, v.slice(prefix.length));
        return dest ?? v;
      }
      return v;
    }
    if (Array.isArray(v)) {
      return v.map(map);
    }
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, map(x)]));
    }
    return v;
  };
  return map(value) as T;
}
