// Fractonica time (the temporal core, packages/time): time_now, time_convert, time_ladder, time_next. Read-only and
// local: the hub answers them from its own copy of the core (packages/hub/src/time/ops.ts), and `fr time …` and
// `fr mcp` compute the same answers without a hub (packages/cli/src/time.ts), so they work while it is down. Every
// number and word in an answer is the core's. Only an instant crosses the wire as input; answers carry the core's
// text. Spread into OPS (packages/protocol/src/ops.ts).
//
// The hub's threshold events (time.threshold) are in events.ts.

import { z } from 'zod';

import { op } from './common.ts';

/** Every form an instant takes (packages/time/src/instant.ts). */
const instant = z
  .string()
  .min(1)
  .describe(
    'an instant: now; Unix seconds (1791460800, 1791460800.25; a bare number is always seconds) or with a unit suffix (1791460800000ms, 1791460800000000us); a Fractonica stamp (α#6 β#4 γ#9 δ#3 ε#5 34η 29ι 21λ 3ν, ASCII a#6 b#4 … too); or a civil date (2026-10-08T12:00:00Z; without an offset, the hub\'s local zone)',
  );
const at = instant.optional().describe('the instant to read (default now); now, Unix seconds (or ms/us suffix), a stamp or an ISO date');
const earth = z.boolean().default(false).describe('add the Earth (Gregorian, local zone) translation of each instant and span, in an `earth` block; pure Fractonica only by default');
const level = z.string().min(1).describe('a level: its symbol (η), ASCII letter (h), word (Eta), unit name (Helion) or depth (7 = η; 1 = α … 22 = χ)');

export const TIME_OPS = [
  op({
    name: 'time_now',
    target: 'hub',
    kind: 'query',
    tier: 'read',
    summary:
      'Fractonica time now (or at `at`), as the core reads it: the stamp (α#6 β#4 γ#9 δ#3 ε#5 34η 29ι 21λ 3ν), the date in words, the Pentad, the four majors with their quarter, the Helion and θ countdowns (place in the parent, next quarter boundary, span to it), the solar sync (number, drift, next quarter) and the next thresholds of the coarser levels. Instants are Unix µs as decimal strings; next_change_us says when the reading next changes. Readings exist only inside the Saros 141 catalogue (1613 to 2857): an instant outside it is INVALID_ARGS. earth adds the civil translation.',
    input: z.object({ at, earth }),
    output: z.looseObject({ unix_us: z.string(), stamp: z.string(), next_change_us: z.string().nullable() }),
    cli: { path: ['time'] },
  }),
  op({
    name: 'time_convert',
    target: 'hub',
    kind: 'query',
    tier: 'read',
    summary:
      'Convert one instant between Fractonica and Earth time: from a stamp (full, partial in the date of `context`, or ASCII) to Unix µs and ISO 8601, or from an ISO date, Unix time or now to the stamp and the date in words. finest names the smallest unit a stamp gave (its first microsecond is the instant). Only instants inside the catalogue (1613 to 2857) convert.',
    input: z.object({
      at: instant,
      context: instant.optional().describe('the instant whose date completes a partial stamp such as ε#5 34η (default now)'),
    }),
    output: z.looseObject({ unix_us: z.string(), iso: z.string(), stamp: z.string() }),
    cli: { path: ['time', 'stamp'], positional: ['at'] },
  }),
  op({
    name: 'time_ladder',
    target: 'hub',
    kind: 'query',
    tier: 'read',
    summary:
      'The Fractonica ladder at an instant (default now): one rung per level from α down to `to` (default ν, the Blink; at most χ), each with depth, symbol, word, kind, the running cycle (its place in the parent and global index), the quarter it is in (the core\'s statement of the phase; the exact phase is a 0.32 fixed-point integer), and the next quarter boundary with the span to it. earth adds civil times and durations.',
    input: z.object({ at, to: level.optional().describe('the deepest level listed (default ν); a symbol, word, unit name or depth'), earth }),
    output: z.looseObject({ unix_us: z.string(), stamp: z.string(), rungs: z.array(z.looseObject({ level: z.number(), symbol: z.string() })) }),
    cli: { path: ['time', 'ladder'] },
  }),
  op({
    name: 'time_next',
    target: 'hub',
    kind: 'query',
    tier: 'read',
    summary:
      'The next thresholds of one level after an instant (default now): each quarter boundary (peak, node, valley, end) with the cycle it ends a quarter of, its instant, its stamp and the span to it; `quarter` keeps only one kind (end: each cycle\'s end). Stops where the catalogue ends (ends: true). Use it to plan for a coming threshold; time.threshold events report them as they pass.',
    input: z.object({
      level,
      // The core's quarter words, checked by the core (packages/time parseQuarter), so every surface accepts any case.
      quarter: z.string().min(1).optional().describe('only boundaries of this kind: the core\'s quarter word (peak, node, valley or end), any case'),
      count: z.number().int().min(1).max(100).default(5),
      at,
      earth,
    }),
    output: z.looseObject({ level: z.number(), thresholds: z.array(z.looseObject({ quarter: z.string(), at_us: z.string(), stamp: z.string() })) }),
    cli: { path: ['time', 'next'], positional: ['level'] },
  }),
] as const;

export type TimeOpName = (typeof TIME_OPS)[number]['name'];

/** The ops `fr time` and `fr mcp` answer without a hub. */
export const LOCAL_TIME_OPS: readonly TimeOpName[] = TIME_OPS.map((o) => o.name);
