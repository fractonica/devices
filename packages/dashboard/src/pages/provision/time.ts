// A span between two instants in Fractonica notation ("2λ 13ν"), live while it is open: it redraws when its text
// next changes (the core's spanNextChangeSince), never on a poll. Pure mode has no Earth form of it at all.

import { useFractonica, useNowFor } from '../../ui/index.ts';
import { instantOf } from '../../ui/index.ts';

/** The span from `start` to `end` (or to now while `end` is unset), in the core's words; undefined while unknown. */
export function useSpan(start: string | undefined, end: string | undefined, parts = 2): string | undefined {
  const core = useFractonica();
  const t0 = instantOf(start);
  const t1 = instantOf(end);
  const now = useNowFor(t1 === null ? core : null, t0, parts);
  const t = t1 ?? now;
  if (!core || t0 === null || t === null || t < t0) {
    return undefined;
  }
  try {
    return core.frc.formatSpan(core.cat.spanBetween(t0, t), parts);
  } catch {
    return undefined;
  }
}
