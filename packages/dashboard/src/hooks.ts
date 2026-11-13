// React access to the runtime: ops as TanStack queries keyed [op, input] (live events invalidate them by
// op name), mutations that toast their failures, the live store, and a ticking clock for relative times
// (hub time and the hub's wall clock, state/clock.ts).

import { useMutation, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';

import type { OpName } from '@fractonica/protocol/client';

import { OpError, peopleRemedies } from './api/rest.ts';
import type { OpInput, OpOutput } from './api/types.ts';
import { hubClock, queryClient, rest, store } from './runtime.ts';
import type { Now } from './state/clock.ts';
import type { LiveState, Tone } from './state/live.ts';
import { actFailure } from './state/words.ts';
import { linkDown } from './shell/link.ts';

export function useLive<T>(select: (s: LiveState) => T): T {
  return useStore(store, select);
}

/** Ops that take long by design (the doctor's checks, a picture of a panel): no timeout (api/rest.ts). */
const LONG_OPS: ReadonlySet<string> = new Set(['hub_doctor', 'hub_doctor_fix', 'display_snapshot', 'display_render', 'diag_exec', 'test_run', 'latency_probe', 'ota_deploy', 'build_start', 'wiring_reload']);

export interface OpQueryOptions {
  /** No retry of a failed call (the hub's status, whose failure is the notice). */
  noRetry?: boolean;
  enabled?: boolean;
  /** ms; false for none. */
  refetchInterval?: number | false;
}

export function useOp<N extends OpName>(name: N, input: OpInput<N>, opts: OpQueryOptions = {}): UseQueryResult<OpOutput<N>, OpError> {
  return useQuery<OpOutput<N>, OpError>({
    queryKey: [name, input],
    queryFn: ({ signal }) => rest.op(name, input, { signal, long: LONG_OPS.has(name) }),
    enabled: opts.enabled ?? true,
    ...(opts.noRetry ? { retry: false } : {}),
    refetchInterval: opts.refetchInterval ?? false,
  });
}

export interface ActOptions<N extends OpName> {
  /** A toast for the ok answer (a string is an ok one); none when it returns undefined. */
  done?: (data: OpOutput<N>, input: OpInput<N>) => string | { tone: Tone; title: string; body?: string } | undefined;
  /** Ops to refetch after it. */
  refresh?: readonly OpName[];
  /** Failures the page says itself (on a field): no toast for them. */
  quiet?: (err: OpError) => boolean;
}

/** A mutating op: its failure is toasted with what to do, and `refresh` refetched after it either way. */
export function useAct<N extends OpName>(name: N, opts: ActOptions<N> = {}) {
  return useMutation<OpOutput<N>, OpError, OpInput<N>>({
    mutationFn: (input) => {
      // with the live link down a press is refused now, not sent to a hub that may run it minutes later
      if (linkDown()) {
        return Promise.reject(new OpError({ code: 'HUB_UNREACHABLE', message: 'the hub is not answering, so nothing was sent', retryable: true }));
      }
      return rest.op(name, input, { long: LONG_OPS.has(name) });
    },
    onSuccess: (data, input) => {
      const t = opts.done?.(data, input);
      if (t) {
        store.getState().toast(typeof t === 'string' ? { tone: 'ok', title: t } : t, hubClock.now());
      }
    },
    onError: (err) => {
      const e = err instanceof OpError ? err : new OpError({ code: 'INTERNAL', message: String(err), retryable: false });
      if (opts.quiet?.(e)) {
        return;
      }
      store.getState().toast({ tone: 'bad', code: e.code, ...actFailure(name, e, peopleRemedies(e)) }, hubClock.now());
    },
    onSettled: () => {
      for (const n of opts.refresh ?? []) {
        void queryClient.invalidateQueries({ queryKey: [n] });
      }
    },
  });
}

/** Now on the hub's clocks (hubClock.now()), re-read every `everyMs`. */
export function useNow(everyMs = 1000): Now {
  const [now, setNow] = useState(() => hubClock.now());
  useEffect(() => {
    const t = setInterval(() => setNow(hubClock.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
