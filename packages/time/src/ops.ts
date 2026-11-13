// The time_* ops of the registry (packages/protocol/src/ops/time.ts), answered from this package's readings: the hub's
// handlers, `fr time` and `fr mcp` all call runTimeOp, so a hub and a CLI without one give the same answer. Inputs
// arrive validated by the op's schema (defaults filled); this file only routes them.

import { type Clock } from './instant.ts';
import { loadCore } from './core.ts';
import { convert, readLadder, readNext, readNow } from './read.ts';

export const TIME_OP_NAMES = ['time_now', 'time_convert', 'time_ladder', 'time_next'] as const;
export type TimeOp = (typeof TIME_OP_NAMES)[number];

export function isTimeOp(name: string): name is TimeOp {
  return (TIME_OP_NAMES as readonly string[]).includes(name);
}

type Input = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** The data of a time op's ok Result. Throws TimeError for an argument the core cannot read (INVALID_ARGS). */
export async function runTimeOp(name: TimeOp, input: Input, clock: Clock = {}): Promise<unknown> {
  const core = await loadCore();
  const earth = input.earth === true;
  switch (name) {
    case 'time_now':
      return readNow(core, { at: str(input.at), earth }, clock);
    case 'time_convert':
      return convert(core, { at: String(input.at), context: str(input.context) }, clock);
    case 'time_ladder':
      return readLadder(core, { at: str(input.at), to: str(input.to), earth }, clock);
    case 'time_next':
      return readNext(
        core,
        { level: String(input.level), quarter: str(input.quarter), count: typeof input.count === 'number' ? input.count : undefined, at: str(input.at), earth },
        clock,
      );
  }
}
