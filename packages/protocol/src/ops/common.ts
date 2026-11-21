// Shared pieces of the operation registry (packages/protocol/src/ops.ts and its C3 groups in this
// directory): the op definition shape and the input fields several ops use.

import { z } from 'zod';

export type OpKind = 'query' | 'command' | 'job' | 'wait';

/**
 * Safety tier (09 §9.2, design c6 D17): `read` changes nothing (MCP readOnlyHint), `mutate` acts on the
 * hub or devices. Every command and job is `mutate`, and so are diag_exec, job_cancel and network_set.
 * A mutation that cannot be undone by another op carries `destructive: true` on its OpDef as well.
 */
export type OpTier = 'read' | 'mutate';

/**
 * What an op acts on, which decides where it runs in a network of several hubs (design multi-hub-m2 §7.1):
 * - `device`: one board. It runs at the hub that holds the board's session (the holder); with no holder, here.
 * - `selector`: the boards a selector names; `across` says what happens when some are held by another hub.
 * - `fleet`: the whole registry (device_list, job_list). Here, with what the peers report.
 * - `port`: a USB port, which belongs to one machine. Here.
 * - `hub`: this hub itself (its status, its builds, its network). Here.
 * `fr --at <hub>` runs any op on a named hub, whatever its target.
 */
export const OP_TARGETS = ['device', 'selector', 'fleet', 'port', 'hub'] as const;
export type OpTarget = (typeof OP_TARGETS)[number];

/**
 * A `selector` op whose boards are held by more than this hub:
 * - `split`: each hub runs its part and the answers' `results` rows are merged, each row saying `at`.
 * - `one`: passed whole when every selected board that has a session is at one hub; refused, naming where each is,
 *   when they are spread (its answer is one job, one page of a cursor or one set of files).
 * - `live`: a wait. It runs at the hub whose cursor its `since` is (a cursor is one hub's own), on that hub's bus,
 *   which carries the events every hub of the network relays (design multi-hub-m2 §8, §17). wait_for_event and
 *   wait_for_device then cover boards wherever they are; wait_for_log and logs_assert read that hub's log store
 *   (logs do not cross the link) and are refused for a board whose lines are at another hub.
 * - `here`: it needs this hub (a build from this machine's sources): refused for a board held elsewhere.
 */
export const OP_ACROSS = ['split', 'one', 'live', 'here'] as const;
export type OpAcross = (typeof OP_ACROSS)[number];

/** An input field that names a board: a selector, or `<alias>.<rest>` when `dotted` (a binding's ends). */
export type OpBoardField = string | { field: string; dotted: true };

export interface OpDef<I extends z.ZodObject = z.ZodObject, O extends z.ZodType = z.ZodType> {
  name: string;
  kind: OpKind;
  tier: OpTier;
  /** Where it runs among the hubs of a network (design multi-hub-m2 §7.1). Part of REGISTRY_HASH. */
  target: OpTarget;
  /**
   * The input fields that name the board or boards (`device` and `selector` targets): default `['device']` for a
   * device op, `['selector']` for a selector op. A device op with two fields (a binding's `from` and `to`) is refused
   * when the two boards are held by two hubs.
   */
  boards?: readonly OpBoardField[];
  /** A `selector` op's rule for boards held by several hubs (required for that target). */
  across?: OpAcross;
  /**
   * Input fields that are a path on the machine the call was made at (design multi-hub-m2 §7.3). `out`: a file or
   * directory the op writes; when the op is passed on, it is written at the hub that runs it and the calling hub pulls
   * it to the path given. `in`: a file the op reads; the hub that runs it fetches it from the calling hub first.
   */
  files?: { out?: readonly string[]; in?: readonly string[] };
  /**
   * Deletes, overwrites, flashes, erases, provisions, updates over the air or reboots: what it changes cannot be put
   * back by another op. MCP destructiveHint; a client asks a person before calling it.
   */
  destructive?: boolean;
  /**
   * MCP tool metadata: `alwaysLoad` sets `_meta["anthropic/alwaysLoad"]` (09 §9.6; hub_status, device_list);
   * `idempotent`: calling it again with the same input changes nothing more (idempotentHint; every read op is);
   * `openWorld`: it may reach outside the hub and its devices, such as the internet (openWorldHint);
   * `hide`: input fields MCP never takes (a secret: the tool's schema leaves them out, and a call that sends one is
   * refused with the CLI command that does take it).
   */
  mcp?: { alwaysLoad?: boolean; idempotent?: boolean; openWorld?: boolean; hide?: readonly string[] };
  /** First sentence: what and when. Kept under 1,000 characters (MCP description limits). */
  summary: string;
  input: I;
  /**
   * The `data` of an ok Result, for OpenAPI and typed clients (design c6 D17). Objects are loose, so a
   * field a handler adds does not break a client. Neither tier, destructive, mcp nor output is in REGISTRY_HASH
   * (target, boards, across and files are: two hubs that pass ops to each other must agree on them).
   */
  output?: O;
  /** `variadic`: the last positional takes the remaining words, joined with single spaces. */
  cli: { path: string[]; positional?: string[]; variadic?: boolean };
}

/**
 * Keeps the literal op name (design c6 §3.2), so OpName is the union of names: HANDLERS must cover each
 * one, and a typed client finds an op's input and output schemas by name.
 */
export function op<const N extends string, I extends z.ZodObject, O extends z.ZodType = z.ZodType>(def: OpDef<I, O> & { name: N }): OpDef<I, O> & { name: N } {
  return def;
}

/** Calling it twice does what calling it once does: every read op, and the ops marked `mcp.idempotent`. */
export function opRepeatable(op: Pick<OpDef, 'tier' | 'mcp'>): boolean {
  return op.tier === 'read' || op.mcp?.idempotent === true;
}

/** The input fields of `op` that name its boards, with the form of each. */
export function opBoardFields(op: Pick<OpDef, 'target' | 'boards'>): { field: string; dotted: boolean }[] {
  const fields: readonly OpBoardField[] = op.boards ?? (op.target === 'device' ? ['device'] : op.target === 'selector' ? ['selector'] : []);
  return fields.map((f) => (typeof f === 'string' ? { field: f, dotted: false } : { field: f.field, dotted: true }));
}

/**
 * CLI option name for an input field (spec 09 §9.5): wait_s is --wait, window_s is --window, ttl_s is
 * --ttl, timeout_s is --timeout and any `<x>_timeout_s` --<x>-timeout (seconds are the CLI's unit for
 * every timeout, window and lease), else kebab-case.
 */
export function cliFlag(key: string): string {
  if (key === 'wait_s') {
    return 'wait';
  }
  if (key === 'window_s') {
    return 'window'; // latency_stats: `fr latency <sel> --window 60` (09 §9.5)
  }
  if (key === 'ttl_s') {
    return 'ttl'; // serial_lease: `fr serial lease <dev> --ttl 120` (09 §9.5)
  }
  return (key.endsWith('timeout_s') ? key.slice(0, -2) : key).replace(/_/g, '-');
}

/** Max server-side wait. Claude Code backgrounds tool calls after 2 minutes. */
export const MAX_WAIT_S = 110;

export const waitS = z.number().int().min(0).max(MAX_WAIT_S).optional().describe('seconds to wait for the job to finish (cap 110)');
export const sourceDir = z
  .string()
  .describe('absolute path of the checkout containing firmware/idf-version.lock (the CLI fills it from its cwd)');
export const portSel = z.string().describe('USB serial (MAC), 12-hex device id, /dev path, or path:<basename> (a USB-UART bridge port, design camera-c1 D3)');
export const cursor = z.string().regex(/^c:\d+\.\d+$/, 'expected a cursor c:<run>.<seq>');
/** The device selector of most ops (09 §9.2), as agents read it in a field description. */
export const selector = z.string().min(1).describe('device selector (alias, id:<12hex>, tag:<t>, chip:<c>, online, all; comma-separated, ! negates)');
/** A selector that must name exactly one device. */
export const deviceSel = z.string().min(1).describe('the device: an alias, id:<12hex> or any selector that matches exactly one device');
