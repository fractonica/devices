// Cursors are "c:<hub_run>.<seq>" (spec 08 §8.7). hub_run increments at every hub start;
// seq is monotonic across runs, so cursors from one run compare by seq alone.
// A cursor is one hub's own. In a network of several hubs (design multi-hub-m2 §9, §17) a hub's run number carries
// its slot, `slot * RUN_SLOT_SIZE + <its own run counter>`, so two hubs never give one run and any hub can tell whose
// cursor it was handed (cursorSlot). The registrar is slot 0, and so is a hub that is alone: their runs read as before.

export interface Cursor {
  run: number;
  seq: number;
}

const CURSOR_RE = /^c:(\d+)\.(\d+)$/;

export function formatCursor(c: Cursor): string {
  return `c:${c.run}.${c.seq}`;
}

export function parseCursor(s: string): Cursor | null {
  const m = CURSOR_RE.exec(s.trim());
  if (!m) {
    return null;
  }
  return { run: Number(m[1]), seq: Number(m[2]) };
}

/** The runs of one hub slot: a hub in slot s counts `s * RUN_SLOT_SIZE + 1` upward (a restart a minute for 1900 years). */
export const RUN_SLOT_SIZE = 1_000_000_000;

/** The slot of the hub that gave a run number (0: the registrar, or a hub that is alone). */
export function runSlot(run: number): number {
  return Math.floor(run / RUN_SLOT_SIZE);
}

/** The run number of a hub in `slot` whose own counter stands at `counter`. */
export function slotRun(slot: number, counter: number): number {
  return slot * RUN_SLOT_SIZE + (counter % RUN_SLOT_SIZE);
}
