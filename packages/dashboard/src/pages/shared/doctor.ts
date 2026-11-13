// The hub's checks as the Hub page and Settings › Health read them: hub_doctor with max_age_s, so a page shows the
// hub's last result at once (checked_at says when it ran; the checks take a while), "Check again" runs them now, and
// "Run fixes" runs `fr doctor --fix`'s fixes in the hub (hub_doctor_fix) when a check says the hub can fix it.

import { useAct, useOp } from '../../hooks.ts';
import { queryClient } from '../../runtime.ts';
import { hubFixes } from '../../state/checks.ts';

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
    runFixes: () => fix.mutate({}),
  };
}
