// Local hub lifecycle: start (detached daemon), stop, restart (spec 08 §8.2).

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { paths, readConfig, rotateLog, run } from '@fractonica/host';
import type { Job, Result } from '@fractonica/protocol';

import { hubCall, hubHealth, hubUrl } from './client.ts';

const HUB_MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hub', 'src', 'main.ts');
const HUB_COMMAND_RE = /packages[\\/]hub[\\/]src[\\/]main\.ts\b/;

export interface StartInfo {
  started: boolean;
  pid?: number;
  log?: string;
  already?: boolean;
  /** The dashboard's URL (hub_status.dashboard.url, design c6 D10), when the hub answers it. */
  dashboard?: string;
  /** Why it was not started (FR_HUB remote, another hub on this FR_HOME, the process exited). */
  error?: string;
  /** Started, but something to know (not answering yet). */
  warning?: string;
}

export interface StopInfo {
  stopped: boolean;
  pid?: number;
}

function readPid(): number | null {
  try {
    return Number(readFileSync(paths.lock(), 'utf8').trim()) || null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** hub.lock outlives a crashed hub and its pid may since belong to anything: only a hub's own main.ts counts. */
async function isHubProcess(pid: number): Promise<boolean> {
  const r = await run('ps', ['-ww', '-o', 'command=', '-p', String(pid)]);
  return r.code === 0 && HUB_COMMAND_RE.test(r.stdout);
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Where the running hub serves its dashboard, from hub_status; absent from a hub that does not say. */
async function dashboardUrl(): Promise<{ dashboard?: string }> {
  const st = await hubCall('hub_status', {}, 3000);
  const url = st.ok ? (st.data as { dashboard?: { url?: unknown } }).dashboard?.url : undefined;
  return typeof url === 'string' ? { dashboard: url } : {};
}

/** Where FR_HUB says the hub is: its port when it is this Mac's loopback, or why this CLI cannot start it there. */
export function hubTarget(env: NodeJS.ProcessEnv = process.env): { port?: number; remote?: string } {
  const raw = env.FR_HUB;
  if (!raw) {
    return {};
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { remote: `FR_HUB=${raw} is not a URL (http://127.0.0.1:<port>)` };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) || url.protocol !== 'http:') {
    return { remote: `FR_HUB=${raw} names a hub on another machine; start it there (fr hub start), or unset FR_HUB` };
  }
  return { port: url.port ? Number(url.port) : 80 };
}

export async function startHub(foreground: boolean, opts: { main?: string } = {}): Promise<StartInfo> {
  const health = await hubHealth();
  if (health) {
    return { started: false, already: true, pid: health.pid, ...(await dashboardUrl()) };
  }
  // FR_HUB (a second hub, a test hub): started on its port, so the health checked below is that hub's. A remote one
  // is refused; so is a second hub on this FR_HOME while another one runs from it (they would share hub.db and fight
  // over the ports).
  const target = hubTarget();
  if (target.remote) {
    return { started: false, error: target.remote };
  }
  if (target.port !== undefined) {
    const other = readPid();
    if (other && (await isHubProcess(other))) {
      return { started: false, error: `hub pid ${other} already runs from ${paths.home()} on another port: set FR_HOME to another directory for a second hub, or unset FR_HUB` };
    }
  }
  const args = ['--conditions=@fractonica/source', opts.main ?? HUB_MAIN, ...(target.port !== undefined ? ['--port', String(target.port)] : [])];
  if (foreground) {
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    await new Promise((r) => child.on('close', r));
    return { started: true };
  }
  mkdirSync(paths.home(), { recursive: true });
  // A hub.log past its size (config.json log) is rotated before the new hub appends to it; the running hub rotates
  // its own log from then on.
  const { max_bytes, keep } = readConfig().config.log;
  rotateLog(paths.log(), { maxBytes: max_bytes, keep, how: 'rename' });
  const log = openSync(paths.log(), 'a');
  // detached => setsid(): the hub outlives the shell, the agent session and `fr mcp`.
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log] });
  let exited: number | null | undefined;
  child.on('exit', (code) => (exited = code));
  child.unref();
  // Up when it answers; a child that exited did not start (already_running exits 0: another hub holds the port).
  const up = await waitFor(async () => exited !== undefined || (await hubHealth()) !== null, 10_000);
  const h = await hubHealth();
  if (up && h) {
    return { started: true, pid: h.pid, log: paths.log(), ...(await dashboardUrl()) };
  }
  if (exited !== undefined) {
    return { started: false, log: paths.log(), error: `the hub exited (code ${exited}) before answering` };
  }
  // Still running but not answering yet (a slow start on a loaded Mac): it was started; say so, not "did not start".
  return { started: true, pid: child.pid, log: paths.log(), warning: `pid ${child.pid} is running but has not answered at ${hubUrl()} yet; see fr hub status` };
}

/** Stop guard (spec 08 §8.2): a failed Result while the hub has queued or working jobs, else null. */
async function stopGuard(verb: 'stop' | 'restart'): Promise<Result<never> | null> {
  const force = { cli: `fr hub ${verb} --force`, human: 'only if aborting those jobs is acceptable' };
  const st = await hubCall('hub_status', {}, 5000);
  if (!st.ok) {
    return {
      ok: false,
      cursor: st.cursor ?? '',
      error: { code: st.error?.code ?? 'INTERNAL', message: `cannot read the hub's jobs before stopping it: ${st.error?.message ?? 'no answer'}`, retryable: true, remediation: [force] },
    };
  }
  const counts = (st.data as { jobs?: Record<string, number> }).jobs ?? {};
  const working = counts.working ?? 0;
  const queued = counts.queued ?? 0;
  if (working + queued === 0) {
    return null;
  }
  // Name them when this hub's job_list answers (best effort: the hub may run an older registry).
  const list = await hubCall('job_list', { limit: 100 }, 5000);
  const active = list.ok ? ((list.data as { jobs?: Job[] }).jobs ?? []).filter((j) => j.status === 'working' || j.status === 'queued') : [];
  const named = active.length ? ` (${active.map((j) => `${j.kind} ${j.job_id}`).join(', ')})` : '';
  return {
    ok: false,
    cursor: st.cursor,
    error: {
      code: 'LOCKED',
      message: `the hub has ${working} working and ${queued} queued job(s)${named}; ${verb === 'stop' ? 'stopping' : 'restarting'} it now would abort them, and a flash cut short can leave a half-written bootloader`,
      retryable: true,
      remediation: [...(active[0] ? [{ cli: `fr jobs wait ${active[0].job_id}` }] : []), { cli: 'fr hub status', human: 'wait until no job is queued or working' }, force],
      details: { jobs: counts, ...(active[0] ? { holder_job: active[0].job_id } : {}), active: active.map((j) => ({ job_id: j.job_id, kind: j.kind, status: j.status })) },
    },
  };
}

async function stop(verb: 'stop' | 'restart', force: boolean): Promise<Result<StopInfo>> {
  const health = await hubHealth();
  if (health && !force) {
    const refused = await stopGuard(verb);
    if (refused) {
      return refused;
    }
  }
  // Signal only a pid that runs the hub: hub.lock outlives a crashed hub, and FR_HUB may name another host.
  const candidate = health?.pid ?? readPid();
  const pid = candidate && (await isHubProcess(candidate)) ? candidate : null;
  if (!health && pid && !force) {
    return {
      ok: false,
      cursor: '',
      error: {
        code: 'HUB_UNREACHABLE',
        message: `hub pid ${pid} is running but not answering, so its jobs cannot be checked`,
        retryable: true,
        remediation: [{ cli: `fr hub ${verb} --force`, human: 'only if aborting its jobs is acceptable' }],
      },
    };
  }
  if (!pid) {
    return { ok: true, data: { stopped: false }, cursor: '' };
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return { ok: true, data: { stopped: false, pid }, cursor: '' };
  }
  // Wait for the process to exit, not just for /health to stop answering: until then it still holds
  // the serial ports, and a hub started meanwhile would find them busy. Its own backstop is 5 s.
  const down = await waitFor(async () => !alive(pid), 10_000);
  return { ok: true, data: { stopped: down, pid }, cursor: '' };
}

/** `fr hub stop [--force]`: refuses while jobs are queued or working unless `force`. */
export function stopHub(force = false): Promise<Result<StopInfo>> {
  return stop('stop', force);
}

/** `fr hub restart [--force]`: the same guard, then a detached start. */
export async function restartHub(force = false): Promise<Result<StartInfo | StopInfo>> {
  const s = await stop('restart', force);
  if (!s.ok) {
    return s;
  }
  if (s.data?.pid && !s.data.stopped) {
    return { ok: false, cursor: '', error: { code: 'TIMEOUT', message: `hub pid ${s.data.pid} is still running; it did not stop`, retryable: true } };
  }
  const r = await startHub(false);
  return r.started ? { ok: true, data: r, cursor: '' } : { ok: false, cursor: '', error: { code: 'HUB_UNREACHABLE', message: r.error ?? `hub did not start; see ${r.log}`, retryable: true } };
}

/**
 * `fr hub compact`: rewrites hub.db (VACUUM) and turns on incremental auto_vacuum, so the space pruning freed goes
 * back to the disk now and after each prune from then on. Only with no hub running (it would block the hub for as
 * long as the VACUUM takes): refuses with LOCKED while one answers or holds hub.lock.
 */
export async function compactHub(): Promise<Result<Record<string, unknown>>> {
  const health = await hubHealth();
  if (health) {
    return {
      ok: false,
      cursor: '',
      error: { code: 'LOCKED', message: `the hub (pid ${health.pid}) is running; compacting would stop it for as long as it takes`, retryable: true, remediation: [{ cli: 'fr hub stop' }, { cli: 'fr hub compact' }, { cli: 'fr hub start' }] },
    };
  }
  const r = spawnSync(process.execPath, ['--conditions=@fractonica/source', HUB_MAIN, '--compact'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const last = r.stdout.trim().split('\n').at(-1) ?? '';
  try {
    const out = JSON.parse(last) as { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };
    if (out.ok) {
      return { ok: true, data: out.data ?? {}, cursor: '' };
    }
    return { ok: false, cursor: '', error: { code: out.error?.code === 'LOCKED' ? 'LOCKED' : 'INTERNAL', message: out.error?.message ?? 'compact failed', retryable: true } };
  } catch {
    return { ok: false, cursor: '', error: { code: 'INTERNAL', message: `compact failed (exit ${r.status}): ${last || 'no output'}`, retryable: false } };
  }
}
