// Design face-f1 D11: fr.clock became fr.rtc, and its five ops clock_* became rtc_* (their `instance` field's text with
// them). The registry checkpoints from before the rename hash the ops as they were then.
import { z } from 'zod';

const OLD_INSTANCE = z.string().min(1).optional().describe("the fr.clock instance, e.g. clock (default: the device's only one)");

export function beforeRtc<T extends { name: string; input: z.ZodType }>(ops: readonly T[]): T[] {
  return ops.map((o) =>
    /^rtc_(read|sync|set|aging|drift)$/.test(o.name) ? { ...o, name: o.name.replace(/^rtc_/, 'clock_'), input: (o.input as z.ZodObject).extend({ instance: OLD_INSTANCE }) } : o,
  );
}
