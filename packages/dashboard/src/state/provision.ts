// The Provision page's logic (stage 4, HARDWARE-REVIEW §4 "Screens" 2, 4 and 5), pure so it is tested without a DOM:
// - the six steps a person sees (plug in · network · board · name · flash · done) from the wizard's state;
// - the profiles for the board, the ones for its chip first and built ones before unbuilt ones, and the chip read from
//   the hub's own words when a probe told it;
// - the dial: one ring of arcs for a job's stages (build, provision, or both chained; OTA per device), the running
//   stage lit to its elapsed fraction where the hub reports one (flash bytes, compile steps), never as a number;
// - OTA: the deploy targets from the registry, a preview's plan as rows, each device's state as a ring;
// - the chain of "Build and provision" as the page's URL search, so a reload during the build still provisions.
//
// Nothing here formats a time, size or unit: the page writes instants with FTime (pure: Fractonica notation only).

import type { DeviceView, Job } from '@fractonica/protocol/client';

import type { BeadState } from '../ui/bead.tsx';
import type { ArcState } from '../ui/stage-ring.tsx';
import { type OtaRow, TERMINAL_JOB_STATUSES, type JobStatus } from '../api/types.ts';
import { PROVISION_STAGES, type ProfileOption, type WizardJob, type WizardState } from './wizard.ts';

// ---- the six steps ----

export const PAGE_STEPS = ['plug', 'network', 'board', 'name', 'flash', 'done'] as const;
export type PageStep = (typeof PAGE_STEPS)[number];
export const PAGE_STEP_WORDS: Record<PageStep, string> = { plug: 'plug in', network: 'network', board: 'board', name: 'name', flash: 'flash', done: 'done' };
export type PageStepStatus = 'done' | 'current' | 'todo' | 'failed';

/** Each step's status: steps before the wizard's are done, its own current (board and name share one), later ones to do. */
export function pageSteps(s: Pick<WizardState, 'step' | 'job' | 'build' | 'error' | 'result'>): { step: PageStep; status: PageStepStatus }[] {
  const at: Record<WizardState['step'], number> = { closed: 0, detect: 0, network: 1, profile: 2, flash: 4, done: 5 };
  const i = at[s.step];
  const failed = s.step === 'flash' && s.error !== null;
  return PAGE_STEPS.map((step, k) => {
    let status: PageStepStatus = k < i ? 'done' : k === i ? 'current' : 'todo';
    if (s.step === 'profile' && step === 'name') {
      status = 'current';
    }
    if (failed && step === 'flash') {
      status = 'failed';
    }
    if (s.step === 'done' && step === 'done') {
      status = 'done';
    }
    return { step, status };
  });
}

// ---- board and name ----

const CHIP_RE = /\b(esp32(?:c2|c3|c5|c6|c61|h2|p4|s2|s3)?)\b/gi;

/** The chip a hub error names (a probe ran): "no debug artifact is built for an esp32c6 board", "… is an esp32c6". */
export function chipFromError(err: { code: string; message: string } | null | undefined): string | null {
  if (!err || !['NOT_FOUND', 'INVALID_ARGS', 'TARGET_MISMATCH', 'INCOMPATIBLE_PROFILE'].includes(err.code)) {
    return null;
  }
  const all = [...err.message.matchAll(CHIP_RE)].map((m) => m[1]!.toLowerCase());
  return all.at(-1) ?? null;
}

export interface ProfileChoice extends ProfileOption {
  /** Built for the board's chip (true when the chip is not known). */
  matches: boolean;
}

/** The profiles to offer: for the board's chip first, built before unbuilt, then by name. */
export function profileChoices(profiles: readonly ProfileOption[], chip: string | null): ProfileChoice[] {
  const c = chip?.toLowerCase() ?? null;
  return profiles
    .map((p) => ({ ...p, matches: c === null || !p.chip || p.chip.toLowerCase() === c }))
    .sort((a, b) => Number(b.matches) - Number(a.matches) || Number(b.built) - Number(a.built) || a.profile.localeCompare(b.profile));
}

/** The alias the hub gives when none is typed: the registry's, else <profile>-<last 6 hex of the MAC>; null when unknown. */
export function defaultAlias(s: Pick<WizardState, 'known' | 'port' | 'profile'>): string | null {
  if (s.known?.alias) {
    return s.known.alias;
  }
  const id = s.port?.device_id ?? (s.port?.usb_serial ?? '').replace(/:/g, '').toLowerCase();
  return s.profile && /^[0-9a-f]{12}$/.test(id) ? `${s.profile}-${id.slice(-6)}` : null;
}

/** Another registered device already has this alias (the hub refuses it before the job starts). */
export function aliasTaken(alias: string, devices: readonly Pick<DeviceView, 'alias' | 'device_id'>[], selfId: string | undefined): string | null {
  const a = alias.trim().toLowerCase();
  if (!a) {
    return null;
  }
  const other = devices.find((d) => d.alias.toLowerCase() === a && d.device_id !== selfId);
  return other ? `${a} is taken by another device` : null;
}

// ---- the dial ----

/** build_start's job stages (hub build.ts), in order. */
export const BUILD_STAGES = ['generate', 'idf_env', 'compile', 'ingest'] as const;
/** An OTA child's states before its end (hub ota/orchestrator.ts OTA_JOB_STATES), lower-cased. */
export const OTA_STAGES = ['queued', 'offered', 'downloading', 'staged', 'rebooting', 'verifying'] as const;

const STAGE_WORDS: Record<string, string> = { idf_env: 'toolchain' };

/** A stage's word on the bezel. */
export function stageWord(stage: string): string {
  return STAGE_WORDS[stage] ?? stage.replace(/_/g, ' ').toLowerCase();
}

/** Stages whose job progress is the elapsed fraction of their arc (the hub's pct: esptool bytes, ninja steps). */
const MEASURED = new Set(['flash', 'compile', 'downloading']);

export interface DialView {
  stages: readonly string[];
  /** The running stage; stages.length when all are done. */
  current: number;
  /** 0..1 of the running stage, when the hub measures it; undefined otherwise (the arc stays engraved). */
  fraction?: number;
  failed: boolean;
  /** The centre word instead of the stage's ("cancelled", "rolled back"). */
  word?: string;
  /**
   * Arcs that each go their own way (an update's devices side by side): each arc's own status and fraction, in place
   * of the one running stage. `current` is then the count of arcs done.
   */
  arcs?: readonly ArcState[];
}

export type { ArcState };

type JobLike = Pick<WizardJob, 'status' | 'stage' | 'progress'> & { stages?: readonly string[] };

/**
 * The sidecar's own steps inside a hub stage (its `stage` events become the job's stage): esptool's connect is part of
 * the probe, its write, erase and verify part of the flash.
 */
const SUBSTAGES: Record<string, string> = { connect: 'probe', write: 'flash', erase: 'flash', verify: 'flash' };

/** The index of the job's stage in `stages`: its newest stage the ring knows (a sub-stage counts as its stage); -1 for none. */
export function stageIndex(stages: readonly string[], job: Pick<JobLike, 'stage' | 'stages'>): number {
  const seen = [...(job.stages ?? []), ...(job.stage ? [job.stage] : [])];
  for (let i = seen.length - 1; i >= 0; i--) {
    const k = stages.indexOf(SUBSTAGES[seen[i]!] ?? seen[i]!);
    if (k >= 0) {
      return k;
    }
  }
  return -1;
}

/** Where a job is on its stages: the running one, its measured fraction, failed or not. */
export function jobPosition(stages: readonly string[], job: JobLike | null): Omit<DialView, 'stages'> {
  if (!job) {
    return { current: 0, failed: false };
  }
  if (job.status === 'completed') {
    return { current: stages.length, failed: false };
  }
  const current = Math.max(0, stageIndex(stages, job));
  const pct = job.progress?.pct;
  const fraction = job.status === 'working' && MEASURED.has(stages[current] ?? '') && typeof pct === 'number' ? Math.max(0, Math.min(1, pct / 100)) : undefined;
  const failed = job.status === 'failed' || job.status === 'cancelled';
  return { current, failed, ...(fraction !== undefined ? { fraction } : {}), ...(job.status === 'cancelled' ? { word: 'cancelled' } : {}) };
}

/** The provisioning dial: nine arcs, or thirteen with the build of "Build and provision" in front. */
export function provisionDial(s: Pick<WizardState, 'job' | 'build' | 'error'>): DialView {
  if (!s.build) {
    const p = jobPosition(PROVISION_STAGES, s.job);
    // refused before the job had a frame (device_provision answered an error): the first arc in fault
    const refused = s.error !== null && s.job === null;
    return { stages: PROVISION_STAGES, ...p, failed: p.failed || refused, ...(refused ? { word: 'refused' } : {}) };
  }
  const stages = [...BUILD_STAGES, ...PROVISION_STAGES];
  if (s.build.status !== 'completed') {
    return { stages, ...jobPosition(BUILD_STAGES, s.build) };
  }
  const p = jobPosition(PROVISION_STAGES, s.job);
  return { stages, ...p, current: BUILD_STAGES.length + p.current, failed: p.failed || (s.error !== null && s.job === null) };
}

/** A job of any kind on its own stages (the job page): build, provision, else the stages it has shown. */
export function jobDial(job: Pick<Job, 'kind' | 'status' | 'stage' | 'progress'> & { stages?: readonly string[] }, seen: readonly string[] = []): DialView {
  const stages: readonly string[] =
    job.kind === 'build' ? BUILD_STAGES : job.kind === 'provision' ? PROVISION_STAGES : seen.length ? seen : job.stage ? [job.stage] : [job.kind];
  return { stages, ...jobPosition(stages, job) };
}

const OTA_END_WORDS: Record<string, string> = { SUCCEEDED: 'updated', FAILED: 'failed', ROLLED_BACK: 'rolled back', TIMED_OUT: 'timed out', CANCELLED: 'cancelled' };

/** One device's OTA as a ring of its six states; an end is done (SUCCEEDED) or failed where it stopped. */
export function otaDial(row: Pick<OtaRow, 'state' | 'bytes' | 'size'>): DialView {
  const state = row.state.toUpperCase();
  const i = OTA_STAGES.indexOf(row.state.toLowerCase() as (typeof OTA_STAGES)[number]);
  if (i >= 0) {
    const fraction = state === 'DOWNLOADING' && row.size > 0 ? Math.max(0, Math.min(1, row.bytes / row.size)) : undefined;
    return { stages: OTA_STAGES, current: i, failed: false, ...(fraction !== undefined ? { fraction } : {}) };
  }
  if (state === 'SUCCEEDED') {
    return { stages: OTA_STAGES, current: OTA_STAGES.length, failed: false, word: OTA_END_WORDS.SUCCEEDED };
  }
  // Where it stopped: no bytes yet (offered), a part (downloading), all of them (the reboot and health check).
  const bytes = Number.isFinite(row.bytes) ? row.bytes : 0;
  const size = Number.isFinite(row.size) ? row.size : 0;
  const at = bytes <= 0 ? 1 : size > 0 && bytes < size ? 2 : 5;
  return { stages: OTA_STAGES, current: at, failed: true, word: OTA_END_WORDS[state] ?? stageWord(row.state) };
}

/**
 * An update's devices as one ring, one arc per device: an arc lit to how far its device is through its six states
 * (the bytes lighting the download's share), lumen once updated, fault where it failed; the arcs' words are the
 * aliases. The centre counts the devices updated.
 */
export function otaFleetDial(rows: readonly Pick<OtaRow, 'alias' | 'state' | 'bytes' | 'size'>[]): DialView {
  const arcs = rows.map((r): ArcState => {
    const v = otaDial(r);
    if (v.failed) {
      return { status: 'failed' };
    }
    if (v.current >= OTA_STAGES.length) {
      return { status: 'done' };
    }
    if (v.current === 0) {
      return { status: 'todo' };
    }
    return { status: 'current', fraction: Math.min(1, (v.current + (v.fraction ?? 0)) / OTA_STAGES.length) };
  });
  const done = arcs.filter((a) => a.status === 'done').length;
  const failed = arcs.some((a) => a.status === 'failed');
  const ended = rows.length > 0 && rows.every((r) => otaEnded(r.state));
  return { stages: rows.map((r) => r.alias), current: done, failed: ended && failed, arcs, word: ended ? (failed ? 'ended' : 'updated') : 'updating' };
}

export type ErrorFixKind = 'port' | 'network' | 'profile' | 'retry';

/** What the page offers to fix a provisioning error in place: back to the port, the network, the profile, or a retry. */
export function errorFixKind(err: { code: string; message: string; candidates?: readonly string[] }): ErrorFixKind | null {
  if (err.candidates?.length) {
    return null; // the candidate profiles are the fix
  }
  if (['PORT_BUSY_EXTERNAL', 'PORT_LEASED', 'PORT_NOT_FOUND', 'LOCKED'].includes(err.code)) {
    return 'port';
  }
  if (err.code === 'INCOMPATIBLE_PROFILE' && /\bnetwork\b/.test(err.message)) {
    return 'network';
  }
  if (['NOT_FOUND', 'TARGET_MISMATCH', 'INCOMPATIBLE_PROFILE', 'BUILD_FAILED'].includes(err.code)) {
    return 'profile';
  }
  return 'retry';
}

/** Whether an OTA row has ended. */
export function otaEnded(state: string): boolean {
  return state.toUpperCase() in OTA_END_WORDS;
}

/** A job's status as a bead: done lumen, running hollow bone, failed fault, cancelled etch, queued idle. */
export function jobBead(status: JobStatus): BeadState {
  return status === 'completed' ? 'online' : status === 'working' ? 'waiting' : status === 'failed' ? 'fault' : status === 'cancelled' ? 'offline' : 'idle';
}

const KIND_WORDS: Record<string, string> = { ota: 'update', provision: 'provision', build: 'build', deploy: 'deploy', flash: 'flash', reset: 'reset' };

/** A job's kind for people. */
export function kindWord(kind: string): string {
  return KIND_WORDS[kind] ?? kind;
}

/** The jobs the Provision page owns (builds, provisions, flashes, OTA), newest first as job_list gives them. */
export function firmwareJobs<J extends Pick<Job, 'kind'>>(jobs: readonly J[]): J[] {
  return jobs.filter((j) => j.kind in KIND_WORDS);
}

// ---- OTA: preview, then deploy ----

export interface DeployTarget {
  value: string;
  label: string;
  /** Devices the selector names. */
  count: number;
}

/** What the deploy can name, from the registry: every device, each profile, each tag, each device. */
export function deployTargets(devices: readonly Pick<DeviceView, 'alias' | 'profile' | 'tags' | 'role'>[]): DeployTarget[] {
  const nodes = devices.filter((d) => d.role !== 'fixture');
  const out: DeployTarget[] = [];
  if (nodes.length) {
    out.push({ value: 'all', label: `Every device (${nodes.length})`, count: nodes.length });
  }
  const count = (key: (d: (typeof nodes)[number]) => readonly string[]) => {
    const m = new Map<string, number>();
    for (const d of nodes) {
      for (const k of key(d)) {
        m.set(k, (m.get(k) ?? 0) + 1);
      }
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  };
  for (const [p, n] of count((d) => (d.profile ? [d.profile] : []))) {
    out.push({ value: `profile:${p}`, label: `Profile ${p} (${n})`, count: n });
  }
  for (const [t, n] of count((d) => d.tags ?? [])) {
    out.push({ value: `tag:${t}`, label: `Tag ${t} (${n})`, count: n });
  }
  for (const d of [...nodes].sort((a, b) => a.alias.localeCompare(b.alias))) {
    out.push({ value: d.alias, label: d.alias, count: 1 });
  }
  return out;
}

/** One device of an ota_deploy dry run (hub ota/orchestrator.ts OtaPlanDevice). */
export interface PlanDevice {
  device_id: string;
  alias: string;
  presence?: string;
  action: 'ota' | 'already_current' | 'skip';
  via?: string;
  build_id?: string;
  fw_id?: string;
  current_fw?: string | null;
  code?: string;
  message?: string;
  warnings?: string[];
}

/** The devices of a dry run's answer, read defensively. */
export function planDevices(plan: unknown): PlanDevice[] {
  const list = (plan as { devices?: unknown } | null)?.devices;
  return Array.isArray(list) ? list.filter((d): d is PlanDevice => typeof (d as PlanDevice)?.alias === 'string' && typeof (d as PlanDevice)?.action === 'string') : [];
}

/** A plan device in words and a bead: what the deploy will do to it. */
export function planLine(d: PlanDevice): { bead: BeadState; text: string } {
  if (d.action === 'ota') {
    return { bead: d.warnings?.length ? 'waiting' : 'online', text: d.via === 'serial' ? 'update over USB' : 'update over Wi-Fi' };
  }
  if (d.action === 'already_current') {
    return { bead: 'idle', text: 'already current' };
  }
  // a device the deploy leaves alone is not an error (fault is for errors only): engraved, as offline
  return { bead: 'offline', text: `skipped: ${(d.code ?? 'cannot update').replace(/_/g, ' ')}` };
}

/** How many devices the deploy updates. */
export function planUpdates(plan: readonly PlanDevice[]): number {
  return plan.filter((d) => d.action === 'ota').length;
}

// ---- "Build and provision" across a reload ----

/** What the build job's page needs to provision once the build is done (kept in the URL's search). */
export interface Chain {
  port: string;
  profile: string;
  alias?: string;
  network?: string;
}

/** The chain as search params (`then=provision`), or null for none. */
export function chainSearch(c: Chain): Record<string, string> {
  return { then: 'provision', port: c.port, profile: c.profile, ...(c.alias ? { alias: c.alias } : {}), ...(c.network ? { network: c.network } : {}) };
}

/** The chain read back from the search params, or null. */
export function readChain(search: Record<string, unknown> | null | undefined): Chain | null {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined);
  if (!search || search.then !== 'provision') {
    return null;
  }
  const port = str(search.port);
  const profile = str(search.profile);
  if (!port || !profile) {
    return null;
  }
  const alias = str(search.alias);
  const network = str(search.network);
  return { port, profile, ...(alias ? { alias } : {}), ...(network ? { network } : {}) };
}

/** The wizard's state for a build job's page reloaded mid-chain: the flash step, the choices from the URL. */
export function chainState(c: Chain, base: WizardState): WizardState {
  return {
    ...base,
    step: 'flash',
    port: { path: c.port, state: 'open' },
    profile: c.profile,
    alias: c.alias ?? '',
    networkName: c.network ?? '',
    network: { state: 'set', ssid: c.network ?? '' },
    job: null,
    build: null,
    result: null,
    error: null,
  };
}
