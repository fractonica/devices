// time_now, time_convert, time_ladder, time_next (packages/protocol/src/ops/time.ts): answered from the hub's copy of the
// temporal core (@fractonica/time), the same function `fr time` and `fr mcp` call without a hub. Spread into HANDLERS
// (packages/hub/src/ops.ts). An argument the core cannot read is INVALID_ARGS, with the reason in details.

import { FrError, type TimeOpName } from '@fractonica/protocol';
import { runTimeOp, TimeError } from '@fractonica/time';

import type { Handler } from '../context.ts';

async function answer(name: TimeOpName, input: Record<string, unknown>): Promise<unknown> {
  try {
    return await runTimeOp(name, input);
  } catch (e) {
    if (e instanceof TimeError) {
      throw new FrError(e.code, e.message, { details: { reason: e.reason, ...e.details } });
    }
    throw e;
  }
}

export const TIME_HANDLERS: Record<TimeOpName, Handler> = {
  time_now: (input) => answer('time_now', input),
  time_convert: (input) => answer('time_convert', input),
  time_ladder: (input) => answer('time_ladder', input),
  time_next: (input) => answer('time_next', input),
};
