// REGISTRY_HASH: the CLI, `fr mcp` and the hub compare it (GET /api/v1/health), so a client never
// calls a hub whose ops differ, and two hubs of one network compare it before one passes an op to the other (design
// multi-hub-m2 §3.3). It covers op names, input schemas (field descriptions included) and where each op runs among
// several hubs (target, boards, across, files), not summaries, tier, mcp or output. Kept out of ops.ts so node:crypto never reaches the browser entry
// (design c6 §3.2).

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { OPS } from './ops.ts';
import type { OpDef } from './ops/common.ts';

const short = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

/** Op names and input schemas alone (REGISTRY_INPUTS_HASH's formula). */
export function registryInputsHashOf(ops: readonly Pick<OpDef, 'name' | 'input'>[]): string {
  return short(JSON.stringify(ops.map((o) => [o.name, z.toJSONSchema(o.input)])));
}

/** REGISTRY_HASH's formula: the inputs hash, and where each op runs among several hubs (target, boards, across, files). */
export function registryHashOf(ops: readonly Pick<OpDef, 'name' | 'input' | 'target' | 'boards' | 'across' | 'files'>[]): string {
  return short(JSON.stringify([registryInputsHashOf(ops), ops.map((o) => [o.name, o.target, o.boards ?? null, o.across ?? null, o.files ?? null])]));
}

/**
 * The op names and their input schemas alone: what REGISTRY_HASH was before the ops said where they run (design
 * multi-hub-m2 step 2.2). It moves only when an op is added or an input changes.
 */
export const REGISTRY_INPUTS_HASH = registryInputsHashOf(OPS as readonly OpDef[]);

/**
 * Changes whenever an op name, an input schema or where an op runs among several hubs changes; CLI and hub compare
 * it, and so do two hubs before one passes an op to the other.
 */
export const REGISTRY_HASH = registryHashOf(OPS as readonly OpDef[]);
