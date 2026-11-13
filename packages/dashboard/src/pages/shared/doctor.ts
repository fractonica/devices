// The hub's checks as the Hub page and Settings › Health read them: hub_doctor with max_age_s, so a page shows the
// hub's last result at once (checked_at says when it ran; the checks take a while), "Check again" runs them now, and
// "Run fix" on a check runs that check's fix in the hub (hub_doctor_fix with its id), "Run N fixes" the fixes of every
// check the hub can fix, each named; a fix that writes outside the hub's home (the fr shim) asks first (fixConfirm).

import { useAct, useOp } from '../../hooks.ts';
import { queryClient } from '../../runtime.ts';
import { fixConfirm, hubFixes } from '../../state/checks.ts';

/** How old a result a page takes without running the checks again. */
export const DOCTOR_MAX_AGE_S = 600;

export function useDoctor() {
  const q = useOp('hub_doctor', { max_age_s: DOCTOR_MAX_AGE_S });
  const again = useAct('hub_doctor', {
    done: (d) => {
      queryClient.setQueryData(['hub_doctor', { max_age_s: DOCTOR_MAX_AGE_S }], d);
      return undefined;
    },
  });
  const fix = useAct('hub_doctor_fix', {
    done: (d) => {
      queryClient.setQueryData(['hub_doctor', { max_age_s: DOCTOR_MAX_AGE_S }], d);
      const left = hubFixes(d.checks).length;
      return left ? { tone: 'warn', title: 'Fixes run', body: `${left} still need${left === 1 ? 's' : ''} a look` } : 'Fixed';
    },
    refresh: ['hub_status'],
  });
  const fixable = q.data ? hubFixes(q.data.checks) : [];
  return {
    q,
    checking: q.isFetching || again.isPending,
    checkAgain: () => again.mutate({}),
    fixable,
    fixing: fix.isPending,
    /** The question to ask before running every fix, or null. */
    confirmAll: fixConfirm(fixable.map((c) => c.id)),
    /** Runs the fixes of these checks (every fixable one by default). */
    runFixes: (ids: readonly string[] = fixable.map((c) => c.id)) => fix.mutate({ ids: [...ids] }),
  };
}
