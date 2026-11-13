// Serial lease ops (design c6 D4, spec 09 §9.2 locks and leases; stream S5): serial_lease,
// serial_lease_renew and serial_release; and the port policy ops port_lend, port_ignore and port_claim (config.json
// ports, packages/hub/src/ports/policy.ts). Spread into OPS (packages/protocol/src/ops.ts); handlers in
// packages/hub/src/ports/. `fr serial lease <dev> -- <cmd…>` and `fr serial monitor` are hand-written
// over these in packages/cli/src/serial.ts.

import { z } from 'zod';

import { op } from './common.ts';

const leaseId = z.string().regex(/^l_[0-9a-f]{12}$/, 'expected a lease id l_<12hex>').describe('the lease id serial_lease returned, l_<12hex>');
/** Leases are capped at 30 min (09 §9.2). */
const ttlS = z.number().int().min(1).max(1800);

/** A granted lease: `port` is the USB serial (the `port:<serial>` lock key), `expires_at` ISO time. */
export const LeaseSchema = z.looseObject({
  lease_id: z.string(),
  device_id: z.string().optional(),
  alias: z.string().optional(),
  port: z.string(),
  path: z.string(),
  holder_pid: z.number().int().optional(),
  ttl_s: z.number().int(),
  expires_at: z.string(),
});
export type Lease = z.infer<typeof LeaseSchema>;

const LEASE_OPS = [
  op({
    name: 'serial_lease',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Lend a USB serial port the hub holds to another program (idf.py monitor, a Web Serial page): the hub ends the device's serial session (a BYE line), closes its handle and returns the path. The lease ends with serial_release, after ttl_s unless renewed (serial_lease_renew), when holder_pid exits (checked every 1 s), when the port goes away or when the hub stops; then the hub reopens the port. Refused with PORT_LEASED, PORT_BUSY_EXTERNAL or LOCKED (a flash job). Prefer `fr serial lease <dev> -- <cmd…>`, which runs the command with FR_PORT and releases on exit.",
    input: z.object({
      device: z.string().min(1).describe('the device or port: alias, id:<12hex>, MAC, USB serial or /dev path, matching exactly one'),
      ttl_s: ttlS.default(120).describe('seconds until the lease ends unless renewed (cap 1800)'),
      holder_pid: z.number().int().min(1).optional().describe('pid of the program using the port; the lease ends when it exits'),
    }),
    output: LeaseSchema,
    cli: { path: ['serial', 'lease'], positional: ['device'] },
  }),
  op({
    name: 'serial_lease_renew',
    kind: 'command',
    tier: 'mutate',
    summary: 'Extend a serial lease: it now ends ttl_s from now (default: its own ttl_s). An unknown or ended lease is NOT_FOUND.',
    input: z.object({
      lease_id: leaseId,
      ttl_s: ttlS.optional().describe("seconds from now (cap 1800; default: the lease's own)"),
    }),
    output: z.looseObject({ lease_id: z.string(), expires_at: z.string() }),
    cli: { path: ['serial', 'renew'], positional: ['lease_id'] },
  }),
  op({
    name: 'serial_release',
    kind: 'command',
    tier: 'mutate',
    summary: 'End a serial lease: the hub reopens the port (DTR and RTS deasserted, so the board does not reset) and the node greets it again over serial. An unknown or ended lease is NOT_FOUND.',
    input: z.object({ lease_id: leaseId }),
    output: z.looseObject({ lease_id: z.string(), port: z.string(), released: z.literal(true) }),
    cli: { path: ['serial', 'release'], positional: ['lease_id'] },
  }),
] as const;

/** What port_ignore and port_claim answer: the port (when attached), the config lists after the change. */
export const PortPolicyResultSchema = z.looseObject({
  port: z.string().describe('the entry written to or removed from config.json'),
  path: z.string().optional(),
  state: z.string().optional(),
  mode: z.enum(['adopted', 'all']),
  ignore: z.array(z.string()),
  claim: z.array(z.string()),
  config: z.string().describe('the config file'),
});

/** The port policy ops (config.json ports; port_list shows each port's state and policy). */
export const PORT_POLICY_OPS = [
  op({
    name: 'port_lend',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Lend a port to another program for ttl_s (default 600): a serial lease with no holder process, for idf.py, esptool or a Web Serial page started by hand. The hub ends the device's serial session, closes its handle (it works on a port the hub does not watch too) and takes it back when the lease expires or serial_release ends it. Prefer `fr serial lease <dev> -- idf.py -p '$FR_PORT' flash monitor`, which releases as soon as the command exits.",
    input: z.object({
      port: z.string().min(1).describe('the port or device: /dev path, USB serial (MAC), path:<basename>, alias or id:<12hex>'),
      ttl_s: ttlS.default(600).describe('seconds until the hub takes the port back (cap 1800; renew with serial_lease_renew)'),
    }),
    output: LeaseSchema,
    cli: { path: ['ports', 'lend'], positional: ['port'] },
  }),
  op({
    name: 'port_ignore',
    kind: 'command',
    tier: 'mutate',
    mcp: { idempotent: true },
    summary:
      'Never open a port (config.json ports.ignore): the hub closes it now if it has it open and leaves it to other programs, also after a re-plug. `port` is a /dev path, a USB serial or MAC (follows the board to any path), or a VID:PID such as 1a86:7523 (every port of that adapter). remove: true takes the entry off the list again. A leased port stays leased until its lease ends.',
    input: z.object({
      port: z.string().min(1).describe('/dev path, USB serial or MAC, path:<basename>, or VID:PID (4 hex : 4 hex)'),
      remove: z.boolean().default(false).describe('take the matching entries off ports.ignore instead'),
    }),
    output: PortPolicyResultSchema,
    cli: { path: ['ports', 'ignore'], positional: ['port'] },
  }),
  op({
    name: 'port_claim',
    kind: 'command',
    tier: 'mutate',
    mcp: { idempotent: true },
    summary:
      'Let the hub watch a port it leaves alone (config.json ports.claim): takes the port off ports.ignore, records it as claimed, and opens it now, so its board says HELLO and is registered. For a board the registry does not know yet in mode adopted (the default); a provisioned board is watched without a claim. remove: true takes the claim back (the port is then watched only if its board is registered). PORT_LEASED while it is lent; PORT_BUSY_EXTERNAL when another program has it open.',
    input: z.object({
      port: z.string().min(1).describe('/dev path, USB serial (MAC), path:<basename>, alias or id:<12hex> of an attached port'),
      remove: z.boolean().default(false).describe('take the claim back instead'),
    }),
    output: PortPolicyResultSchema,
    cli: { path: ['ports', 'claim'], positional: ['port'] },
  }),
] as const;

export type PortPolicyOpName = (typeof PORT_POLICY_OPS)[number]['name'];

export const PORTS_OPS = [...LEASE_OPS, ...PORT_POLICY_OPS] as const;

export type PortsOpName = (typeof PORTS_OPS)[number]['name'];
