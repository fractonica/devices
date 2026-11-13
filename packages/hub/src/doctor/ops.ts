// Handler of the hub ops (packages/protocol/src/ops/hub.ts; design c6 D14, stream S2): hub_doctor, fr doctor's
// host checks run in the hub process (hub_doctor never fixes; hub_doctor_fix runs `fr doctor --fix`'s fixes), plus what only the hub knows: its
// Local Network self-test and `_fractonica._tcp` advert (lan/), and its event-loop delay (D29). Spread into
// HANDLERS (packages/hub/src/ops.ts); hub_status stays in ops.ts with the C1 ops.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { type Check, hubChecks, runDoctor } from '@fractonica/host';
import type { HubOpName } from '@fractonica/protocol';

import type { Handler, HubContext } from '../context.ts';
import { routerLoopDelay } from '../router/index.ts';
import { LOOP_DELAY_WARN_MS } from '../web/feeds.ts';

/** The last result per hub (the checks take a while: the IDF environment is read), and a run in flight. */
const last = new WeakMap<object, { at: number; out: DoctorResult }>();
const running = new WeakMap<object, Promise<DoctorResult>>();

type DoctorResult = { checks: Check[]; checked_at: string };

export interface DoctorDeps {
  runDoctor?: typeof runDoctor;
  now?: () => number;
  /** Whether the hub runs with its own FR_HOME (a test or scratch hub); default: FR_HOME is set and is not ~/.fractonica. */
  ownHome?: boolean;
}

/** A hub started with its own FR_HOME: a scratch or test hub, or one run from another checkout. */
function hasOwnHome(): boolean {
  const home = process.env.FR_HOME;
  return Boolean(home) && resolve(home!) !== join(homedir(), '.fractonica');
}

/** The shim check's fix on a hub with its own FR_HOME: the fr command is the user's (~/.local/bin), so a person runs it. */
const SHIM_BY_HAND = 'run `fr doctor --fix` in Terminal from the checkout your fr command should run: this hub has its own FR_HOME and leaves the fr command alone';

/**
 * hub_doctor: the checks, or with `max_age_s` the last result when it is at most that old (checked_at says when it
 * ran). Two calls at once share one run. With `fix` (hub_doctor_fix) the fixes of the checks `ids` names run first
 * (every fix without it), except the fr shim's on a hub with its own FR_HOME.
 */
export async function hubDoctor(hub: HubContext, deps: DoctorDeps = {}, input: { max_age_s?: number; fix?: boolean; ids?: readonly string[] } = {}): Promise<DoctorResult> {
  const now = deps.now ?? Date.now;
  const kept = last.get(hub);
  if (!input.fix && input.max_age_s && kept && now() - kept.at <= input.max_age_s * 1000) {
    return kept.out;
  }
  const inFlight = running.get(hub);
  if (inFlight && !input.fix) {
    return inFlight;
  }
  const run = runChecks(hub, deps, input.fix === true, input.ids).then((checks) => {
    const out = { checks, checked_at: new Date(now()).toISOString() };
    last.set(hub, { at: now(), out });
    return out;
  });
  running.set(hub, run);
  try {
    return await run;
  } finally {
    if (running.get(hub) === run) {
      running.delete(hub);
    }
  }
}

async function runChecks(hub: HubContext, deps: DoctorDeps, fix: boolean, ids?: readonly string[]): Promise<Check[]> {
  const ownHome = deps.ownHome ?? hasOwnHome();
  const checks = await (deps.runDoctor ?? runDoctor)({ sourceDir: hub.hubSourceDir, fix, ...(fix && ids ? { only: ids } : {}), ...(fix && ownHome ? { never: ['shim'] } : {}) });
  if (ownHome) {
    for (const c of checks) {
      if (c.id === 'shim' && c.level !== 'ok' && c.fix === 'fr doctor --fix') {
        c.fix = SHIM_BY_HAND;
      }
    }
  }
  const lnp = hub.lnp?.status();
  checks.push(...hubChecks({ lnp: lnp?.lnp, lnp_checked_at: lnp?.checked_at, launched_by: lnp?.launched_by, advert: hub.advert?.status() }));
  const loop = routerLoopDelay(hub.router, 60_000);
  if (loop?.p99_ms != null) {
    const slow = loop.p99_ms > LOOP_DELAY_WARN_MS;
    checks.push({
      id: 'loop_delay',
      level: slow ? 'warn' : 'ok',
      detail: `event loop delay over the last ${loop.seconds} s: p50 ${loop.p50_ms} ms, p99 ${loop.p99_ms} ms${slow ? ` (above ${LOOP_DELAY_WARN_MS} ms)` : ''}`,
      ...(slow ? { fix: 'find what keeps the hub busy (a running build or flash, a large events_read) or what loads the Mac' } : {}),
    });
  }
  return checks;
}

export const HUB_HANDLERS: Record<HubOpName, Handler> = {
  hub_doctor: (input: { max_age_s?: number }, hub) => hubDoctor(hub, {}, { max_age_s: input.max_age_s }),
  // `fr doctor --fix` in the hub process (a person pressed Run fix or Run fixes): those fixes, then the checks again
  hub_doctor_fix: (input: { ids?: string[] }, hub) => hubDoctor(hub, {}, { fix: true, ...(input.ids ? { ids: input.ids } : {}) }),
};
