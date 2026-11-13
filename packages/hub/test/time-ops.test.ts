// The time_* handlers in the hub: the temporal core's answers (the same function `fr time` and `fr mcp` call), and
// INVALID_ARGS outside the catalogue.

import { describe, expect, it } from 'vitest';

import { FrError } from '@fractonica/protocol';

import type { HubContext } from '../src/context.ts';
import { HANDLERS } from '../src/ops.ts';

describe('time_* handlers', () => {
  it('answer from the core: vector A, its stamp and the Helion countdown', async () => {
    const now = (await HANDLERS.time_now({ at: '2026-10-08T12:00:00Z', earth: false }, {} as HubContext)) as { stamp: string; countdowns: { next: { span: string } }[] };
    expect(now.stamp).toBe('α#6 β#4 γ#9 δ#3 ε#5 34η 29ι 21λ 3ν');
    expect(now.countdowns[0].next.span).toBe('6ι 43λ');
    const conv = (await HANDLERS.time_convert({ at: 'α#6 β#4 γ#9 δ#3 ε#5 34η 29ι 21λ 3ν' }, {} as HubContext)) as { iso: string };
    expect(conv.iso).toBe('2026-10-08T11:59:59.855Z');
    const next = (await HANDLERS.time_next({ level: 'η', quarter: 'end', count: 2, at: '1791460800', earth: false }, {} as HubContext)) as { thresholds: unknown[] };
    expect(next.thresholds).toHaveLength(2);
    const ladder = (await HANDLERS.time_ladder({ to: 'δ', earth: false }, {} as HubContext)) as { rungs: unknown[] };
    expect(ladder.rungs).toHaveLength(4);
  });

  it('refuse an instant outside the catalogue with INVALID_ARGS and the reason', async () => {
    const e = await (async () => HANDLERS.time_now({ at: '1500-01-01T00:00:00Z', earth: false }, {} as HubContext))().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FrError);
    expect(e).toMatchObject({ code: 'INVALID_ARGS', details: { reason: 'out_of_catalogue' } });
    expect((e as FrError).message).toMatch(/OUT OF CATALOGUE · α#1 – α#18/);
  });
});
