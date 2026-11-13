// The wizard's state outlives the page: `/provision` and `/provision/<job>` are two routes, and a person may go to
// another page while the hub flashes. The reducer (state/wizard.ts) runs in this module-level store, so moving between
// the routes (or away and back) keeps the job in view; a reload starts empty and the job page resumes from the hub.
//
// Following a job: `/ws` job frames as they come, and job_get every 1.5 s as the fallback (a frame missed while the
// socket reconnected), until it ends; then once more if no frame carried the result or error.

import { useEffect, useRef, useSyncExternalStore } from 'react';

import type { Job } from '@fractonica/protocol/client';

import { TERMINAL_JOB_STATUSES } from '../../api/types.ts';
import { live, rest } from '../../runtime.ts';
import { WIZARD_CLOSED, wizardReducer, type WizardAction, type WizardState } from '../../state/wizard.ts';

let state: WizardState = WIZARD_CLOSED;
const listeners = new Set<() => void>();

export function dispatch(a: WizardAction): void {
  const next = wizardReducer(state, a);
  if (next !== state) {
    state = next;
    for (const l of listeners) {
      l();
    }
  }
}

/** Replaces the whole state (a chain read back from the URL). */
export function replace(s: WizardState): void {
  state = s;
  for (const l of listeners) {
    l();
  }
}

export function getWizard(): WizardState {
  return state;
}

export function useWizard(): WizardState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

const POLL_MS = 1500;

/**
 * Calls `onJob` with each frame of the job (`full` for a job_get answer) while `active`; job_get every 1.5 s too, and
 * once at the start. Stops polling when it ended.
 */
export function useFollowJob(jobId: string | undefined, active: boolean, onJob: (job: Pick<Job, 'job_id' | 'status' | 'stage' | 'progress' | 'result' | 'error'>, full: boolean) => void): void {
  const cb = useRef(onJob);
  cb.current = onJob;
  useEffect(() => {
    if (!jobId || !active) {
      return;
    }
    let ended = false;
    const off = live.listen({ job: (f) => f.job_id === jobId && cb.current(f, false) });
    const read = () =>
      rest.op('job_get', { job_id: jobId }).then(
        (j) => {
          ended = TERMINAL_JOB_STATUSES.has(j.status);
          cb.current(j, true);
        },
        () => {},
      );
    void read();
    const t = setInterval(() => {
      if (!ended) {
        void read();
      }
    }, POLL_MS);
    return () => {
      off();
      clearInterval(t);
    };
  }, [jobId, active]);
}
