// Passing an op on (design multi-hub-m2 §7, step 2.2): "reach a board that is on hub A through hub B". Every client
// reaches a hub through one dispatch point (http.ts, POST /api/v1/op/<name>), and this module is what that point asks
// before a handler runs: where does this op run?
//
//   - Named (`X-Fr-At: <hub name>`, `fr --at <hub>`): on that hub, whatever the op acts on. This hub's own name: here.
//   - `device`: at the hub that holds the board's session. The board is resolved here and passed by its device id.
//     With no holder it runs here: a row edit for a board on no hub is made here and replicates (step 2.3), and one
//     that must reach the board (its alias, its hub list) is made by its holder, which tells the board.
//     Two boards (a binding's ends, a latency probe) must be on one hub.
//   - `selector`: by the op's `across`: `split` (each hub runs its part, the `results` rows are merged, each saying
//     `at`), `one` (passed whole when every selected board that has a session is at one hub, refused when they are
//     spread), `live` (a wait: below), `here` (it needs this hub's sources: refused for a board held elsewhere).
//   - A cursor decides (step 2.4, design multi-hub-m2 §17). A cursor is one hub's own, and its run number says whose
//     (protocol cursor.ts). An op that reads from a cursor (`since`: the four waits, logs_read, events_read) runs at
//     the hub that gave it: here for this hub's own, passed whole to a peer for that peer's, HUB_UNREACHABLE while that
//     hub is away. Every hub's bus carries the events of the whole network (peers/events.ts), so wait_for_event and
//     wait_for_device cover boards wherever they are, and wherever they go meanwhile; wait_for_log and logs_assert
//     read one hub's log store (logs do not cross), and are refused for a board whose lines are at another hub.
//   - `fleet`, `port`, `hub`: here. The job ops follow the job: one that runs at another hub is asked there
//     (job_list stays this hub's own: `fr --at <hub> jobs ls` lists another hub's).
//
// A call that arrived over the link is never passed on again (`serve` runs the handler, or answers DEVICE_OFFLINE with
// `at` when the board it was sent for is no longer here); the calling hub tries once more at the new holder for an op
// that is read-only or idempotent, and never for another. The two hubs' registry hashes must be equal: otherwise the
// caller answers HUB_VERSION_MISMATCH naming the hub, and sends nothing.
//
// What comes back is the other hub's whole Result envelope, with `at` (its name) and its cursor: a cursor is one hub's
// own, and a wait `since` it is asked of the hub that gave it. Jobs, files and firmware: remote-jobs.ts, files.ts,
// firmware.ts.

import { performance } from 'node:perf_hooks';

import { BROADCAST_ALIAS, errorResult, findOp, FrError, type Job, JOB_ORIGINS, type JobOrigin, okResult, opBoardFields, type OpDef, opRepeatable, parseCursor, type Result } from '@fractonica/protocol';
import { z } from 'zod';

import { newestBuildId } from '../artifacts.ts';
import { profileApp } from '../build.ts';
import type { Device, HubContext } from '../context.ts';
import { underHome } from '../display/ops.ts';
import { mintCursor } from '../events/index.ts';
import { requestClient } from '../jobs.ts';
import { HANDLERS } from '../ops.ts';
import { otaOrchestrator } from '../ota/index.ts';
import { requestSignal } from '../prompts.ts';
import { ADDR_ALLOC, allocate } from '../registry/alloc.ts';
import { registryOf } from '../registry/hub.ts';
import { type CommandOutcome, sendCommandTo } from '../router/ops.ts';
import { restStats } from '../router/scale.ts';
import { type CallAnswer, failed } from './calls.ts';
import { destOf, dropSpool, listSpool, localPaths, newSpool, Offers, splitFiles, spoolFile, spoolInPath, spoolOutPath, sweepSpools } from './files.ts';
import { sendMessage } from '../bindings/ops.ts';
import { artifactGet, blobFile, ensureArtifact, hasArtifact } from './firmware.ts';
import { hubName } from './identity.ts';
import { netPresence, type PeerHub } from './index.ts';
import { markPulled, pruneRemoteJobs, rememberJob, remoteJob, type RemoteJob, unpulledJobs } from './remote-jobs.ts';
import { adoptRow } from './rows.ts';
import type { CallMsg } from './wire.ts';

/** Added to an op's own wait for the link: the hub that runs it answers before this hub gives up, and this hub before its client does (the CLI adds 30 s). */
export const LINK_MARGIN_MS = 20_000;
/** A job passed on is followed for its files this long. */
const FOLLOW_MS = 6 * 3600 * 1000;

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const JOB_REF_OPS: ReadonlySet<string> = new Set(['job_get', 'job_wait', 'job_logs', 'job_cancel']);
/** Selector ops over this hub's log and event stores, where the selector `all` is no filter at all. */
const STORE_READERS: ReadonlySet<string> = new Set(['logs_read', 'events_read', 'latency_stats', 'wait_for_log', 'wait_for_event', 'logs_assert']);
/** The ops that read from a cursor (`since`): each runs at the hub whose cursor it is. */
const SINCE_OPS: ReadonlySet<string> = new Set(['logs_read', 'events_read', 'wait_for_log', 'wait_for_event', 'wait_for_device', 'logs_assert']);
/** Of those, the ones that read a hub's log store: lines do not cross the hubs' link. */
const LOG_OPS: ReadonlySet<string> = new Set(['logs_read', 'wait_for_log', 'logs_assert']);
const isUp = (p: string | undefined) => p === 'online' || p === 'suspect';
const isJob = (d: unknown): d is Job => !!d && typeof d === 'object' && typeof (d as Job).job_id === 'string' && typeof (d as Job).status === 'string' && Array.isArray((d as Job).targets);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

/** One op call as the dispatch point hands it over. */
export interface OpContext {
  /** The calling client's origin (design c6 D18). */
  client?: JobOrigin;
  /** `X-Fr-At`: the hub to run it on. */
  at?: string;
  /** Aborted when the client goes away before the answer. */
  signal: AbortSignal;
  /** This hub's cursor, minted before anything ran. */
  cursor: string;
}

/** The op's own wait in ms (wait_s, else total_timeout_s, else timeout_s; 0 without one), as the CLI counts it. */
export function opWaitMs(input: Record<string, unknown>): number {
  const s = Number(input.wait_s ?? input.total_timeout_s ?? input.timeout_s);
  return Number.isFinite(s) ? Math.max(0, s) * 1000 : 0;
}

/** Runs the op's handler here, inside the request's abort signal and the calling client's origin. */
export function runLocal(hub: HubContext, op: OpDef, input: unknown, ctx: Pick<OpContext, 'client' | 'signal'>): Promise<unknown> {
  const handler = HANDLERS[op.name as keyof typeof HANDLERS];
  const call = async () => requestSignal.run(ctx.signal, () => handler(input, hub));
  return ctx.client ? requestClient.run(ctx.client, call) : call();
}

// ---- where a board is ----

type Place = { at: 'here' } | { at: 'peer'; hub: PeerHub } | { at: 'none' };

/**
 * FR_TEST_PEER_HOLDER (`<device id>=<hub name>[,…]`, a test hub only): this hub takes the named hub for the board's
 * holder whatever the peers report. It is how a test makes "the board moved between the resolve and the call".
 */
function forcedHolder(hub: HubContext, deviceId: string): PeerHub | null {
  const spec = process.env.FR_TEST_PEER_HOLDER;
  if (!spec || !hub.run || hub.run.nodePort === 7421) {
    return null;
  }
  const name = spec.split(',').map((x) => x.split('=')).find(([id]) => id === deviceId)?.[1];
  return (name && hub.peers!.hubs().find((h) => h.name === name && !h.self)) || null;
}

function placeOf(hub: HubContext, deviceId: string): Place {
  const forced = forcedHolder(hub, deviceId);
  if (forced) {
    return { at: 'peer', hub: forced };
  }
  if (isUp(hub.router?.presence(deviceId))) {
    return { at: 'here' };
  }
  const h = hub.peers!.holder(deviceId);
  return h ? { at: 'peer', hub: h } : { at: 'none' };
}

interface Board {
  field: string;
  dotted: boolean;
  text: string;
  device: Device;
  place: Place;
}

/** The devices an input field names, as this hub's registry resolves it; null when it names none it knows. */
function resolveField(hub: HubContext, text: string, dotted: boolean): Device[] | null {
  const dot = dotted ? text.indexOf('.') : -1;
  const sel = dotted ? (dot > 0 ? text.slice(0, dot) : '') : text;
  if (!sel || sel === BROADCAST_ALIAS) {
    return null;
  }
  try {
    return registryOf(hub).resolve(sel, netPresence(hub));
  } catch (e) {
    if (e instanceof FrError) {
      return null; // the handler says what is wrong with it
    }
    throw e;
  }
}

const idField = (b: Pick<Board, 'dotted' | 'text'>, id: string) => (b.dotted ? `id:${id}${b.text.slice(b.text.indexOf('.'))}` : `id:${id}`);
const whereText = (hub: HubContext, b: { device: Device; place: Place }) => `${b.device.alias} is ${b.place.at === 'peer' ? `at hub ${b.place.hub.name}` : b.place.at === 'here' ? `at hub ${hubName(hub.db)}` : 'on no hub'}`;
const cliOf = (op: OpDef) => `fr ${op.cli.path.join(' ')}`;

// ---- the calling hub ----

interface Passing {
  hub: HubContext;
  offers: Offers;
  /** Jobs whose files are being pulled, so two answers of one job pull once. */
  pulling: Map<string, Promise<string>>;
  following: Set<string>;
  stopped: boolean;
}

const states = new WeakMap<object, Passing>();

function stateOf(hub: HubContext): Passing {
  let s = states.get(hub.db);
  if (!s) {
    s = { hub, offers: new Offers(), pulling: new Map(), following: new Set(), stopped: false };
    states.set(hub.db, s);
  }
  return s;
}

function mismatch(hub: HubContext, to: PeerHub, what: string): Result {
  const mine = hub.peers!.registryHash();
  return failed('HUB_VERSION_MISMATCH', `hub ${to.name} runs another version (its op registry is ${to.registry_hash ?? 'not known'}, this hub's ${mine}): ${what} was not passed to it`, {
    hint: 'update both hubs to one version and restart each (fr hub restart); who is where shows meanwhile',
    remediation: [{ tool: 'hub_peers', cli: 'fr hub peers' }],
    details: { hub: to.name, registry_hash: to.registry_hash, this_hub: mine },
  });
}

function away(to: Pick<PeerHub, 'name' | 'last_error'>, what: string): Result {
  return failed('HUB_UNREACHABLE', `hub ${to.name} is not reachable${to.last_error ? ` (${to.last_error})` : ''}: ${what} was not sent`, {
    retryable: true,
    hint: 'fr hub peers shows the link to each hub of the network',
    remediation: [{ tool: 'hub_peers', cli: 'fr hub peers' }],
    details: { hub: to.name },
  });
}

/** A link service at a peer (`mode: sys`); throws its failure as an FrError naming the hub. */
async function sys<T>(hub: HubContext, hubId: string, name: string, input: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  const a = await hub.peers!.call(hubId, name, input, { mode: 'sys', timeoutMs, repeatable: true });
  if (!a.result.ok) {
    throw new FrError(a.result.error?.code ?? 'INTERNAL', a.result.error?.message ?? `${name} failed`);
  }
  return a.result.data as T;
}

/** Pulls what the op left in `spool` at hub `hubId` to the paths asked for, and drops the spool. Returns its root there. */
async function pullSpool(hub: HubContext, hubId: string, spool: string, wants: Record<string, string>): Promise<string> {
  const listed = await sys<{ root: string; files: { path: string; size: number }[] }>(hub, hubId, 'spool_list', { spool });
  const t0 = performance.now();
  let bytes = 0;
  for (const f of listed.files) {
    const dest = destOf(wants, f.path);
    if (!dest || !underHome(dest)) {
      continue;
    }
    bytes += (await hub.peers!.pull(hubId, 'spool', { spool, path: f.path }, dest)).bytes;
  }
  // The names and the sizes, never the contents.
  console.log(JSON.stringify({ event: 'peer_files_pulled', files: listed.files.length, bytes, ms: Math.round(performance.now() - t0) }));
  await sys(hub, hubId, 'spool_drop', { spool }).catch(() => undefined);
  return listed.root;
}

/** The name the hub that runs a job has now (it may have been renamed since). */
const nameOf = (hub: HubContext, row: Pick<RemoteJob, 'hub_id' | 'hub_name'>) => hub.peers!.hubs().find((h) => h.id === row.hub_id)?.name ?? row.hub_name;

/**
 * A job that runs at another hub, as this hub answers it: `at`, and once it has completed its files pulled here (once)
 * and its result's paths those of this machine. A pull that fails is a warning, and is tried again at the next answer.
 */
async function settleJob(hub: HubContext, row: RemoteJob, job: Job, warnings: string[]): Promise<Job> {
  const st = stateOf(hub);
  const at = nameOf(hub, row);
  let out: Job = { ...job, at };
  if (!row.wants || !row.spool) {
    return out;
  }
  if (job.status !== 'completed') {
    if (TERMINAL.has(job.status)) {
      void sys(hub, row.hub_id, 'spool_drop', { spool: row.spool }).catch(() => undefined);
    }
    return out;
  }
  let root = row.pulled_at ? row.spool_root : null;
  if (!root) {
    let p = st.pulling.get(row.job_id);
    if (!p) {
      p = pullSpool(hub, row.hub_id, row.spool, row.wants)
        .then((r) => {
          markPulled(hub.db, row.job_id, r);
          return r;
        })
        .finally(() => st.pulling.delete(row.job_id));
      st.pulling.set(row.job_id, p);
    }
    try {
      root = await p;
    } catch (e) {
      warnings.push(`the file of job ${row.job_id} is still at hub ${at} (${(e as Error).message}): ask for the job again to fetch it`);
      return out;
    }
  }
  out = { ...out, result: localPaths(out.result, root, row.wants) };
  return out;
}

/** Follows a job that leaves files until it ends, so they are pulled even when nobody asks for the job again. */
function follow(hub: HubContext, row: RemoteJob): void {
  const st = stateOf(hub);
  if (st.following.has(row.job_id) || st.stopped) {
    return;
  }
  st.following.add(row.job_id);
  void (async () => {
    const until = Date.now() + FOLLOW_MS;
    while (!st.stopped && Date.now() < until) {
      const to = hub.peers!.hubs().find((h) => h.id === row.hub_id);
      if (!to?.reachable) {
        await sleep(5000);
        continue;
      }
      const a = await hub.peers!.call(row.hub_id, 'job_wait', { job_id: row.job_id, timeout_s: 60 }, { mode: 'at', timeoutMs: 60_000 + LINK_MARGIN_MS, repeatable: true });
      if (a.result.ok && isJob(a.result.data) && TERMINAL.has(a.result.data.status)) {
        const warnings: string[] = [];
        await settleJob(hub, remoteJob(hub.db, row.job_id) ?? row, a.result.data, warnings);
        if (!warnings.length) {
          return;
        }
        await sleep(5000); // the pull failed: tried again
      } else if (!a.result.ok) {
        if (a.result.error?.code === 'NOT_FOUND') {
          return; // that hub pruned the job
        }
        await sleep(5000);
      }
      // still working: waited for again at once
    }
  })()
    .catch((e: unknown) => console.error(JSON.stringify({ event: 'peer_follow_failed', job_id: row.job_id, message: (e as Error).message })))
    .finally(() => st.following.delete(row.job_id));
}

/**
 * What a peer answered, as this hub's answer: `at`, its job remembered, its files pulled. The row it changed reaches
 * this hub by replication (step 2.3); only for a peer that does not replicate (a hub of step 2.2, while one is being
 * updated) is what it answered still written into this hub's row by hand (rows.ts).
 */
async function received(hub: HubContext, to: PeerHub, op: OpDef, answer: CallAnswer, wants: Record<string, string>): Promise<Result> {
  const r: Result = { ...answer.result, at: to.name };
  const warnings = [...(r.warnings ?? [])];
  const wanted = Object.keys(wants).length > 0;
  if (r.ok) {
    if (!hub.peers!.registry.replicates(to.id)) {
      const w = adoptRow(hub, op.name, r.data, to.name);
      if (w) {
        warnings.push(w);
      }
    }
    if (isJob(r.data)) {
      const row = rememberJob(hub.db, { job_id: r.data.job_id, hub_id: to.id, hub_name: to.name, op: op.name, ...(wanted && answer.spool ? { wants, spool: answer.spool } : {}) });
      r.data = await settleJob(hub, row, r.data, warnings);
      if (row.wants && !TERMINAL.has((r.data as Job).status)) {
        follow(hub, row);
      }
    } else if (wanted && answer.spool) {
      try {
        r.data = localPaths(r.data, await pullSpool(hub, to.id, answer.spool, wants), wants);
      } catch (e) {
        warnings.push(`the file is still at hub ${to.name} (${(e as Error).message})`);
      }
    }
  }
  if (warnings.length) {
    r.warnings = warnings;
  }
  return r;
}

/** Sends `op` to hub `to` and answers what it answers. Nothing is sent to a hub that is away or on another registry. */
async function pass(hub: HubContext, to: PeerHub, op: OpDef, input: Record<string, unknown>, ctx: OpContext, mode: 'holder' | 'at'): Promise<Result> {
  if (!to.reachable) {
    return away(to, op.name);
  }
  if (to.registry_hash !== hub.peers!.registryHash()) {
    return mismatch(hub, to, op.name);
  }
  const st = stateOf(hub);
  const split = splitFiles(op, input, st.offers);
  try {
    const answer = await hub.peers!.call(to.id, op.name, split.input, {
      mode,
      ...(ctx.client ? { client: ctx.client } : {}),
      timeoutMs: opWaitMs(input) + LINK_MARGIN_MS,
      repeatable: opRepeatable(op),
      ...(split.files ? { files: split.files } : {}),
      signal: ctx.signal,
    });
    return await received(hub, to, op, answer, split.wants);
  } finally {
    st.offers.release(split.tokens);
  }
}

// ---- the rule ----

/**
 * One op, wherever it runs: the dispatch point's whole answer. `input` is the op's parsed input. Never throws.
 */
export async function runOp(hub: HubContext, op: OpDef, input: Record<string, unknown>, ctx: OpContext): Promise<Result> {
  const local = async (inp: Record<string, unknown> = input): Promise<Result> => {
    try {
      return okResult(await runLocal(hub, op, inp, ctx), ctx.cursor);
    } catch (e) {
      return errorResult(e, ctx.cursor);
    } finally {
      wrote(hub, op);
    }
  };
  if (!hub.peers) {
    return local();
  }
  try {
    if (ctx.at !== undefined) {
      return await runAt(hub, op, input, ctx, local);
    }
    if (JOB_REF_OPS.has(op.name)) {
      return (await jobOp(hub, op, input)) ?? (await local());
    }
    if (SINCE_OPS.has(op.name) && (op.across === 'live' || typeof input.since === 'string')) {
      return await runBySince(hub, op, input, ctx, local);
    }
    if (op.target === 'device') {
      return await runDevice(hub, op, input, ctx, local);
    }
    if (op.target === 'selector') {
      return await runSelector(hub, op, input, ctx, local);
    }
    return await local();
  } catch (e) {
    return errorResult(e, ctx.cursor);
  }
}

type Local = (input?: Record<string, unknown>) => Promise<Result>;

/** After an op that may have written the registry: its rows are stamped and told to the peers now (step 2.3), not at the next scan. */
function wrote(hub: HubContext, op: OpDef): void {
  if (op.tier !== 'read') {
    try {
      hub.peers?.registry.flush();
    } catch (e) {
      console.error(JSON.stringify({ event: 'registry_flush_failed', op: op.name, message: (e as Error).message }));
    }
  }
}

async function runAt(hub: HubContext, op: OpDef, input: Record<string, unknown>, ctx: OpContext, local: Local): Promise<Result> {
  const me = hubName(hub.db);
  if (ctx.at === me) {
    return local();
  }
  const hubs = hub.peers!.hubs();
  const to = hubs.find((h) => h.name === ctx.at);
  if (!to) {
    return {
      ...failed('NOT_FOUND', hubs.length ? `no hub named ${ctx.at} in this network (its hubs: ${hubs.map((h) => h.name).join(', ')})` : `no hub named ${ctx.at}: this hub (${me}) is alone in its network`, {
        remediation: [hubs.length ? { tool: 'hub_peers', cli: 'fr hub peers' } : { tool: 'network_join', cli: "fr net join --hub <the other hub's API>" }],
        details: { at: ctx.at, hubs: hubs.map((h) => h.name) },
      }),
      cursor: ctx.cursor,
    };
  }
  if (to.self) {
    return local();
  }
  const r = await pass(hub, to, op, input, ctx, 'at');
  return r.cursor ? r : { ...r, cursor: ctx.cursor };
}

/** The boards a live op's selector names that another hub holds, with that hub; [] for no selector or `all`. */
function heldElsewhere(hub: HubContext, op: OpDef, input: Record<string, unknown>): { device: Device; hub: PeerHub }[] {
  const text = input[opBoardFields(op)[0]?.field ?? 'selector'];
  if (typeof text !== 'string' || text.trim().toLowerCase() === 'all') {
    return [];
  }
  const out: { device: Device; hub: PeerHub }[] = [];
  for (const device of resolveField(hub, text, false) ?? []) {
    const place = placeOf(hub, device.device_id);
    if (place.at === 'peer') {
      out.push({ device, hub: place.hub });
    }
  }
  return out;
}

/** Whether this hub has the board's own lines: one of its ports is attached here (a USB cable to this machine). */
function linesHere(hub: HubContext, deviceId: string): boolean {
  try {
    hub.serial.resolve(deviceId);
    return true;
  } catch {
    return false;
  }
}

/**
 * A wait that is to run on this hub (its `since` is this hub's cursor, or it has none), checked before it starts: it
 * must be able to see what it waits for. Throws CAPABILITY_UNSUPPORTED naming the boards and where to wait instead.
 */
function liveHere(hub: HubContext, op: OpDef, input: Record<string, unknown>): void {
  const elsewhere = heldElsewhere(hub, op, input);
  if (!elsewhere.length) {
    return;
  }
  const me = hubName(hub.db);
  const details = { boards: elsewhere.map((b) => ({ device_id: b.device.device_id, alias: b.device.alias, at: b.hub.name })) };
  const where = (list: typeof elsewhere) => list.map((b) => `${b.device.alias} is at hub ${b.hub.name}`).join(', ');
  if (LOG_OPS.has(op.name)) {
    const blind = elsewhere.filter((b) => !linesHere(hub, b.device.device_id));
    if (blind.length) {
      const to = blind[0].hub.name;
      throw new FrError('CAPABILITY_UNSUPPORTED', `${op.name} reads the log store of one hub, and log lines do not cross the hubs' link: ${where(blind)}, so ${blind.length === 1 ? 'its lines are' : 'their lines are'} not in hub ${me}'s store${typeof input.since === 'string' ? `, whose cursor ${input.since} is` : ''}`, {
        hint: `wait where the board is, from a cursor of that hub: the cursor of an op on the board answered by hub ${to} (its \`at\` says so), or fr --at ${to} hub status; then fr --at ${to} ${op.cli.path.join(' ')} …`,
        details: { ...details, hub: to },
      });
    }
    return;
  }
  const deaf = elsewhere.filter((b) => !hub.peers!.events.relays(b.hub.id));
  if (deaf.length) {
    const to = deaf[0].hub.name;
    throw new FrError('CAPABILITY_UNSUPPORTED', `${op.name} waits here for what the boards' hubs relay, and ${where(deaf)}, which does not relay its events (it runs a version from before step 2.4 of the hubs' link)`, {
      hint: `run it on that hub, from a cursor of that hub: fr --at ${to} ${op.cli.path.join(' ')} …; or update hub ${to} and restart it`,
      details: { ...details, hub: to },
    });
  }
}

/**
 * An op that reads from a cursor: at the hub whose cursor `since` is. This hub's own, or none (wait_for_device without
 * `since`): here, once `liveHere` says a wait can see what it waits for. A peer's: passed whole, whatever it acts on.
 */
async function runBySince(hub: HubContext, op: OpDef, input: Record<string, unknown>, ctx: OpContext, local: Local): Promise<Result> {
  const cur = typeof input.since === 'string' ? parseCursor(input.since) : null;
  const owner = cur ? hub.peers!.hubOfRun(cur.run) : null;
  if (owner && !owner.self) {
    if (!owner.reachable) {
      return { ...away(owner, `${op.name} since ${String(input.since)}, a cursor of that hub,`), cursor: ctx.cursor };
    }
    const r = await pass(hub, owner, op, input, ctx, 'at');
    return r.cursor ? r : { ...r, cursor: ctx.cursor };
  }
  // Its own cursor, none, or one of an earlier run (the handler says HUB_RESTARTED).
  if (op.across === 'live') {
    liveHere(hub, op, input);
  }
  const r = await local();
  if (LOG_OPS.has(op.name)) {
    // A page or a wait that found nothing for a board whose lines are elsewhere says where they are.
    const blind = heldElsewhere(hub, op, input).filter((b) => !linesHere(hub, b.device.device_id));
    if (blind.length) {
      const note = `${blind.map((b) => `${b.device.alias} is at hub ${b.hub.name}`).join(', ')}: ${blind.length === 1 ? 'its' : 'their'} log lines are in that hub's store, not this one's (fr --at ${blind[0].hub.name} ${op.cli.path.join(' ')} …)`;
      if (r.ok) {
        r.warnings = [...(r.warnings ?? []), note];
      } else if (r.error && (r.error.code === 'TIMEOUT' || r.error.code === 'ASSERTION_FAILED')) {
        r.error = { ...r.error, hint: r.error.hint ? `${r.error.hint}; ${note}` : note };
      }
    }
  }
  return r;
}

async function runDevice(hub: HubContext, op: OpDef, input: Record<string, unknown>, ctx: OpContext, local: Local): Promise<Result> {
  const boards: Board[] = [];
  for (const f of opBoardFields(op)) {
    const text = input[f.field];
    const found = typeof text === 'string' ? resolveField(hub, text, f.dotted) : null;
    if (found?.length === 1) {
      boards.push({ ...f, text: text as string, device: found[0], place: placeOf(hub, found[0].device_id) });
    }
  }
  const remote = boards.filter((b): b is Board & { place: { at: 'peer'; hub: PeerHub } } => b.place.at === 'peer');
  if (!remote.length) {
    return local();
  }
  const hubs = new Map(remote.map((b) => [b.place.hub.id, b.place.hub]));
  if (hubs.size > 1 || boards.some((b) => b.place.at === 'here')) {
    throw new FrError('CAPABILITY_UNSUPPORTED', `${op.name}: both boards must be on one hub (${boards.map((b) => whereText(hub, b)).join(', ')})`, {
      hint: 'an op over two boards runs at the hub that holds both; wait for them to be on one hub, or give each the same first hub (fr devices hubs set)',
      details: { boards: boards.map((b) => ({ device_id: b.device.device_id, alias: b.device.alias, at: b.place.at === 'peer' ? b.place.hub.name : b.place.at === 'here' ? hubName(hub.db) : null })) },
    });
  }
  const to = [...hubs.values()][0];
  const passed = { ...input };
  for (const b of boards) {
    passed[b.field] = idField(b, b.device.device_id);
  }
  const r = await pass(hub, to, op, passed, ctx, 'holder');
  const d = r.ok ? undefined : (r.error?.details as { moved?: unknown; at?: unknown } | undefined);
  if (!d || r.error?.code !== 'DEVICE_OFFLINE' || d.moved !== true) {
    return r.cursor ? r : { ...r, cursor: ctx.cursor };
  }
  // The board left that hub between the resolve and the call. That hub did not pass the op on (nothing is passed on
  // twice): this hub tries once more where the board is now, for an op that is safe to run again, and for no other.
  const now = typeof d.at === 'string' ? d.at : null;
  if (!opRepeatable(op)) {
    return {
      ...r,
      cursor: r.cursor || ctx.cursor,
      error: { ...r.error!, message: `${r.error!.message}; ${op.name} is not tried again by itself (it is not idempotent)`, hint: `run it again: ${cliOf(op)} …` },
    };
  }
  if (now === null || now === hubName(hub.db)) {
    return local();
  }
  const next = hub.peers!.hubs().find((h) => h.name === now && !h.self);
  if (!next || next.id === to.id) {
    return r.cursor ? r : { ...r, cursor: ctx.cursor };
  }
  const again = await pass(hub, next, op, passed, ctx, 'holder');
  return again.cursor ? again : { ...again, cursor: ctx.cursor };
}

/** ota_deploy for boards at another hub: the build this hub would use, named, so that hub fetches it when it lacks it. */
function otaBuild(hub: HubContext, input: Record<string, unknown>, devices: Device[]): Record<string, unknown> {
  if (typeof input.build === 'string') {
    return input;
  }
  const profiles = new Set(devices.map((d) => (typeof input.profile === 'string' ? input.profile : d.profile)));
  const profile = profiles.size === 1 ? [...profiles][0] : null;
  if (!profile) {
    return input;
  }
  const build = newestBuildId(hub.db, { app: profileApp(hub.hubSourceDir, profile), profile, buildType: 'debug' });
  return build && hasArtifact(hub, build) ? { ...input, build } : input;
}

async function runSelector(hub: HubContext, op: OpDef, input: Record<string, unknown>, ctx: OpContext, local: Local): Promise<Result> {
  const field = opBoardFields(op)[0]?.field ?? 'selector';
  const text = input[field];
  // `all` to an op that reads this hub's own log or event store names no board: it is "no device filter" there, as
  // leaving the selector out is. It reads this hub's store, as before.
  if (typeof text === 'string' && text.trim().toLowerCase() === 'all' && STORE_READERS.has(op.name)) {
    return local();
  }
  const devices = typeof text === 'string' ? resolveField(hub, text, false) : null;
  if (!devices?.length) {
    return local();
  }
  const placed = devices.map((device) => ({ device, place: placeOf(hub, device.device_id) }));
  const remote = placed.filter((b): b is { device: Device; place: { at: 'peer'; hub: PeerHub } } => b.place.at === 'peer');
  if (!remote.length) {
    return local();
  }
  const hubs = new Map(remote.map((b) => [b.place.hub.id, b.place.hub]));
  const elsewhere = [...new Set(remote.map((b) => b.place.hub.name))];
  const details = { boards: placed.map((b) => ({ device_id: b.device.device_id, alias: b.device.alias, at: b.place.at === 'peer' ? b.place.hub.name : b.place.at === 'here' ? hubName(hub.db) : null })) };
  const across = op.across ?? 'one';
  if (across === 'live') {
    // A wait is routed by its cursor before it gets here (runBySince): this is one without a place of its own.
    liveHere(hub, op, input);
    return local();
  }
  if (across === 'here') {
    throw new FrError('CAPABILITY_UNSUPPORTED', `${op.name} builds on this hub and updates over this hub's own links, and ${remote.map((b) => whereText(hub, b)).join(', ')}`, {
      hint: `build here, then update through the hubs' link: fr build --profile <profile>, then fr ota ${typeof text === 'string' ? text : '<device>'}`,
      details,
    });
  }
  const idsOf = (list: { device: Device }[]) => list.map((b) => `id:${b.device.device_id}`).join(',');
  if (across === 'one') {
    const here = placed.filter((b) => b.place.at === 'here');
    if (hubs.size > 1 || here.length) {
      throw new FrError('CAPABILITY_UNSUPPORTED', `${op.name} runs on one hub, and the boards ${JSON.stringify(text)} names are on ${hubs.size + (here.length ? 1 : 0)}: ${placed.filter((b) => b.place.at !== 'none').map((b) => whereText(hub, b)).join(', ')}`, {
        hint: `name the boards of one hub, or run it on each: ${elsewhere.map((n) => `fr --at ${n} ${op.cli.path.join(' ')} …`).join('; ')}`,
        details,
      });
    }
    const to = [...hubs.values()][0];
    let passed: Record<string, unknown> = { ...input, [field]: idsOf(remote) };
    if (op.name === 'ota_deploy') {
      passed = otaBuild(hub, passed, remote.map((b) => b.device));
    }
    const r = await pass(hub, to, op, passed, ctx, 'holder');
    const left = placed.filter((b) => b.place.at === 'none');
    if (left.length) {
      r.warnings = [...(r.warnings ?? []), `${left.map((b) => b.device.alias).join(', ')}: on no hub now, left out (the op ran at hub ${to.name} for the boards it holds)`];
    }
    return r.cursor ? r : { ...r, cursor: ctx.cursor };
  }
  // split: each hub its part; the boards on no hub stay with this hub's part, which answers `offline` for them.
  const mine = placed.filter((b) => b.place.at !== 'peer');
  const parts: Promise<{ at: string; devices: Device[]; r: Result }>[] = [];
  if (mine.length) {
    parts.push(local({ ...input, [field]: idsOf(mine) }).then((r) => ({ at: hubName(hub.db), devices: mine.map((b) => b.device), r })));
  }
  for (const to of hubs.values()) {
    const part = remote.filter((b) => b.place.hub.id === to.id);
    parts.push(pass(hub, to, op, { ...input, [field]: idsOf(part) }, ctx, 'holder').then((r) => ({ at: to.name, devices: part.map((b) => b.device), r })));
  }
  const done = await Promise.all(parts);
  if (done.length === 1) {
    return done[0].r.cursor ? done[0].r : { ...done[0].r, cursor: ctx.cursor };
  }
  const rows = new Map<string, Record<string, unknown>>();
  const warnings: string[] = [];
  for (const p of done) {
    warnings.push(...(p.r.warnings ?? []));
    const got = (p.r.ok ? (p.r.data as { results?: unknown })?.results : (p.r.error?.details as { results?: unknown } | undefined)?.results) as Record<string, unknown>[] | undefined;
    for (const row of Array.isArray(got) ? got : []) {
      if (typeof row?.device === 'string') {
        rows.set(row.device, { ...row, at: p.at });
      }
    }
    for (const d of p.devices) {
      if (!rows.has(d.device_id)) {
        // That hub answered no row for it: its part failed as a whole, and the row says how.
        rows.set(d.device_id, { device: d.device_id, alias: d.alias, status: p.r.error?.code === 'DEVICE_OFFLINE' ? 'offline' : 'failed', error: p.r.error?.message ?? 'no answer', at: p.at });
      }
    }
  }
  const results = devices.map((d) => rows.get(d.device_id)!).filter(Boolean);
  if (done.every((p) => !p.r.ok)) {
    const first = done[0].r.error!;
    return { ok: false, cursor: ctx.cursor, error: { ...first, message: done.map((p) => `hub ${p.at}: ${p.r.error?.message}`).join('; '), details: { ...(first.details ?? {}), results } }, ...(warnings.length ? { warnings } : {}) };
  }
  return okResult({ results }, ctx.cursor, warnings);
}

/**
 * One command to one board for the `/app` socket (apps/socket.ts), which sends commands without an op: over this
 * hub's own link when it holds the board (sendCommandTo, as before), else as a command_send through the same rule as
 * every op, so an app's command reaches a board another hub holds. What such a board says comes back as the events
 * its hub relays (peers/events.ts), and its live stream through a relay (peers/streams.ts).
 */
export async function commandAnywhere(
  hub: HubContext,
  dev: Device,
  instance: string,
  command: string,
  args: Record<string, unknown>,
  opts: { ack: 'none' | 'result'; timeoutMs: number },
): Promise<CommandOutcome> {
  if (isUp(hub.router?.presence(dev.device_id)) || !hub.peers?.holder(dev.device_id)) {
    return sendCommandTo(hub, dev, instance, command, args, opts);
  }
  const op = findOp('command_send')!;
  const input = op.input.parse({ selector: `id:${dev.device_id}`, instance, command, args, ack: opts.ack, timeout_s: Math.min(30, Math.max(1, Math.ceil(opts.timeoutMs / 1000))) }) as Record<string, unknown>;
  const r = await runOp(hub, op, input, { client: 'app', signal: new AbortController().signal, cursor: '' });
  const rows = (r.ok ? (r.data as { results?: CommandOutcome[] }).results : (r.error?.details as { results?: CommandOutcome[] } | undefined)?.results) ?? [];
  return rows[0] ?? { device: dev.device_id, alias: dev.alias, status: r.error?.code === 'DEVICE_OFFLINE' ? 'offline' : 'failed', error: r.error?.message ?? 'no answer' };
}

/**
 * One MSG to one board for the `/app` socket (apps/socket.ts `msg`): over this hub's own link when it holds the board,
 * else as a message_send through the same rule as every op, so an app's MSG reaches a board another hub holds. A
 * broadcast stays this hub's own (each hub broadcasts to its own sessions, design multi-hub-m2 §10).
 */
export async function messageAnywhere(hub: HubContext, dev: Device, topic: string, data: unknown): Promise<Awaited<ReturnType<typeof sendMessage>>> {
  const to = `id:${dev.device_id}`;
  if (isUp(hub.router?.presence(dev.device_id)) || !hub.peers?.holder(dev.device_id)) {
    return sendMessage(hub, { to, topic, ...(data !== undefined ? { data } : {}) });
  }
  const op = findOp('message_send')!;
  const input = op.input.parse({ to, topic, ...(data !== undefined ? { data } : {}) }) as Record<string, unknown>;
  const r = await runOp(hub, op, input, { client: 'app', signal: new AbortController().signal, cursor: '' });
  if (!r.ok) {
    throw new FrError(r.error?.code ?? 'INTERNAL', r.error?.message ?? 'message_send failed');
  }
  return r.data as Awaited<ReturnType<typeof sendMessage>>;
}

// ---- jobs ----

function localJob(hub: HubContext, jobId: string): boolean {
  try {
    hub.jobs.get(jobId);
    return true;
  } catch {
    return false;
  }
}

/** job_get, job_wait, job_logs, job_cancel for a job that runs at another hub; null for one of this hub (or of none). */
async function jobOp(hub: HubContext, op: OpDef, input: Record<string, unknown>): Promise<Result | null> {
  const id = typeof input.job_id === 'string' ? input.job_id : '';
  if (!id || localJob(hub, id)) {
    return null;
  }
  const peers = hub.peers!;
  const mine = peers.registryHash();
  let row = remoteJob(hub.db, id);
  if (!row) {
    // A job id this hub never saw (the op was started through another hub): the reachable peers are asked.
    for (const p of peers.hubs()) {
      if (p.self || !p.reachable || p.registry_hash !== mine) {
        continue;
      }
      const a = await peers.call(p.id, 'job_get', { job_id: id }, { mode: 'at', timeoutMs: 8000, repeatable: true });
      if (a.result.ok && isJob(a.result.data)) {
        row = rememberJob(hub.db, { job_id: id, hub_id: p.id, hub_name: p.name, op: 'job_get' });
        break;
      }
    }
    if (!row) {
      return null;
    }
  }
  const name = nameOf(hub, row);
  const to = peers.hubs().find((h) => h.id === row!.hub_id);
  if (!to || !to.reachable) {
    return away(to ?? { name, last_error: 'it is no longer in the member list' }, `${op.name} for job ${id}, which runs there,`);
  }
  if (to.registry_hash !== mine) {
    return mismatch(hub, to, `${op.name} for job ${id}`);
  }
  const a = await peers.call(to.id, op.name, input, { mode: 'at', timeoutMs: opWaitMs(input) + LINK_MARGIN_MS, repeatable: opRepeatable(op) });
  const r: Result = { ...a.result, at: to.name };
  const warnings = [...(r.warnings ?? [])];
  if (r.ok && isJob(r.data)) {
    r.data = await settleJob(hub, row, r.data, warnings);
  }
  if (warnings.length) {
    r.warnings = warnings;
  }
  return r;
}

// ---- the hub that runs it ----

/** A device op sent here because the caller took this hub for the board's holder: DEVICE_OFFLINE with `at` when it is not. */
function heldHere(hub: HubContext, op: OpDef, input: Record<string, unknown>): void {
  for (const f of opBoardFields(op)) {
    const text = input[f.field];
    const found = typeof text === 'string' ? resolveField(hub, text, f.dotted) : null;
    if (found?.length !== 1 || isUp(hub.router?.presence(found[0].device_id))) {
      continue;
    }
    const at = hub.peers!.at(found[0].device_id);
    throw new FrError('DEVICE_OFFLINE', `${found[0].alias} has no session with hub ${hubName(hub.db)}${at ? `: it is at hub ${at} now` : ' (nor with a hub it can see)'}`, {
      details: { device_id: found[0].device_id, moved: true, at },
    });
  }
}

/** Link services: what one hub asks another that is no op (files.ts, firmware.ts). */
const SYS: Record<string, (hub: HubContext, from: PeerHub, input: Record<string, unknown>) => unknown> = {
  spool_list: (_hub, _from, input) => listSpool(String(input.spool)),
  spool_drop: (_hub, _from, input) => ({ dropped: dropSpool(input.spool) }),
  artifact_get: (hub, _from, input) => artifactGet(hub, input),
  // Step 2.3: a member asks the registrar for a new board's address (registry/alloc.ts).
  [ADDR_ALLOC]: (hub, from, input) => allocate(hub, input, from.name),
};

/** One call that arrived over the link: the op's handler here, never passed on again. */
async function serve(hub: HubContext, from: PeerHub, msg: CallMsg, input: Record<string, unknown>): Promise<CallAnswer> {
  if (msg.mode === 'sys') {
    const fn = SYS[msg.op];
    if (!fn) {
      return { result: failed('HUB_VERSION_MISMATCH', `hub ${hubName(hub.db)} has no link service ${msg.op}`) };
    }
    try {
      return { result: okResult(await fn(hub, from, input), '') };
    } catch (e) {
      return { result: errorResult(e, '') };
    }
  }
  const mine = hub.peers!.registryHash();
  if (from.registry_hash !== mine) {
    return { result: failed('HUB_VERSION_MISMATCH', `hub ${hubName(hub.db)} runs another version than hub ${from.name} (op registry ${mine}, not ${from.registry_hash ?? 'unknown'}): ${msg.op} was not run`) };
  }
  const op = findOp(msg.op);
  if (!op || !HANDLERS[op.name as keyof typeof HANDLERS]) {
    return { result: failed('NOT_FOUND', `unknown op ${msg.op}`) };
  }
  const cursor = mintCursor(hub);
  const t0 = performance.now();
  let spool: string | undefined;
  let hasOut = false;
  try {
    const inp = { ...input };
    const outs = Object.entries(msg.files?.out ?? {});
    const ins = Object.entries(msg.files?.in ?? {});
    if (outs.length || ins.length) {
      spool = newSpool().id;
      for (const [field, name] of outs) {
        if (!(op.files?.out ?? []).includes(field)) {
          throw new FrError('INVALID_ARGS', `${op.name} writes no file for ${field}`);
        }
        inp[field] = spoolOutPath(spool, field, name);
        hasOut = true;
      }
      for (const [field, o] of ins) {
        if (!(op.files?.in ?? []).includes(field)) {
          throw new FrError('INVALID_ARGS', `${op.name} reads no file for ${field}`);
        }
        const dest = spoolInPath(spool, field, o.name);
        await hub.peers!.pull(from.id, 'offer', { token: o.token }, dest);
        inp[field] = dest;
      }
    }
    if (typeof inp.build === 'string') {
      // A build only the calling hub has (the Mac builds, this hub cannot): made this hub's own first (§7.3).
      await ensureArtifact(hub, from, inp.build);
    }
    const parsed = op.input.safeParse(inp);
    if (!parsed.success) {
      throw new FrError('INVALID_ARGS', z.prettifyError(parsed.error), { details: { issues: parsed.error.issues } });
    }
    if (msg.mode === 'holder' && op.target === 'device') {
      heldHere(hub, op, parsed.data as Record<string, unknown>);
    }
    if (op.across === 'live') {
      // A wait sent here because its cursor is this hub's: it must be able to see what it waits for from here.
      liveHere(hub, op, parsed.data as Record<string, unknown>);
    }
    const client = (JOB_ORIGINS as readonly string[]).includes(msg.client ?? '') ? (msg.client as JobOrigin) : undefined;
    const data = await runLocal(hub, op, parsed.data, { ...(client ? { client } : {}), signal: new AbortController().signal });
    wrote(hub, op); // the row it changed is at the calling hub with, or just after, the answer
    return { result: okResult(data, cursor), ...(hasOut ? { spool } : {}) };
  } catch (e) {
    if (spool) {
      try {
        dropSpool(spool);
      } catch {
        // swept later
      }
    }
    return { result: errorResult(e, cursor) };
  } finally {
    // Counted with the ops this hub's own clients call (hub_status `rest`).
    restStats(hub).add(op.name, performance.now() - t0);
  }
}

/**
 * Makes `hub` a hub that passes ops on and takes them: the calls that arrive are served, the link services and the
 * data channels registered, an OTA job hears of its board coming back at a peer, and the jobs whose files were not
 * pulled before a restart are followed again. Returns the stop.
 */
export function installPassing(hub: HubContext): () => void {
  const peers = hub.peers;
  if (!peers) {
    return () => undefined;
  }
  const st = stateOf(hub);
  peers.serve((from, msg, input) => serve(hub, from, msg, input));
  peers.provide('spool', (_peer, ref) => ({ path: spoolFile(ref.spool, ref.path) }));
  peers.provide('offer', (_peer, ref) => ({ path: st.offers.path(ref.token) }));
  peers.provide('blob', (_peer, ref) => blobFile(ref));
  // §6: an update whose board comes back with the new firmware at another hub ended well.
  const off = peers.onRemote((e) => {
    if (e.up && e.fw) {
      try {
        otaOrchestrator(hub).seenAtPeer(e.device, e.fw, e.hub.name);
      } catch {
        // a hub without an orchestrator (a test context)
      }
    }
  });
  try {
    pruneRemoteJobs(hub.db);
    sweepSpools();
    for (const row of unpulledJobs(hub.db, FOLLOW_MS)) {
      follow(hub, row);
    }
  } catch (e) {
    console.error(JSON.stringify({ event: 'peer_jobs_resume_failed', message: (e as Error).message }));
  }
  return () => {
    st.stopped = true;
    off();
  };
}
