// The hub event type glob (09 §9.2), with no dependency, so a browser bundle takes it without the event schemas
// (@fractonica/protocol/client). events.ts re-exports it.

/**
 * Whether `type` matches one glob of the 09 §9.2 type grammar, in which `*` matches any run of characters
 * (dots included: `boot.*`, `*.effect_done`) and nothing else is special. Two pointers that step back only
 * to the last `*` seen: at most len(glob) x len(type) steps, where a `.*` RegExp backtracks once per star
 * (`****…x` took a minute per event). The hub runs it on globs from /ws and /app clients, the dashboard on
 * its Live filters (design c6 §7.10).
 */
export function matchType(glob: string, type: string): boolean {
  let g = 0;
  let t = 0;
  /** The last `*` in the glob and the type position it was last made to stop at; -1 before one. */
  let star = -1;
  let mark = 0;
  while (t < type.length) {
    if (g < glob.length && glob[g] === '*') {
      star = g++;
      mark = t;
    } else if (g < glob.length && glob[g] === type[t]) {
      g++;
      t++;
    } else if (star >= 0) {
      // The last `*` takes one more character; the rest of the glob tries again from there.
      g = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (g < glob.length && glob[g] === '*') {
    g++;
  }
  return g === glob.length;
}
