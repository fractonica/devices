// The port policy (config.json `ports`; review decision "adopted only"): which USB serial ports the hub opens.
//   - ports.ignore: never opened, whatever the mode. An entry is a /dev path (cu. or tty.), a USB serial or MAC (it
//     follows the board to any path, and covers the bridge port the board was last seen on), `path:<basename>` or a
//     bare basename (a USB-UART bridge's location), or a VID:PID such as 1a86:7523 (every port of that adapter).
//   - mode `adopted` (the default): a port is opened when its board is registered: its key is the MAC of a registry
//     device (a chip's own USB names its MAC in the USB serial number, which survives re-enumeration), or the device
//     last seen on it (ports_seen.device_id: a bridge port's HELLO, a provision's probe) is one. ports.claim lists
//     ports opened anyway (fr ports claim), so an unknown board can say HELLO. Every other candidate port is listed
//     as `unwatched`, closed, for idf.py, esptool or a browser to use.
//   - mode `all`: every Espressif and USB-UART bridge port, as before the policy.
// A bridge port is known only by its USB socket (its path) until its board speaks, so the board last seen on it is
// remembered with the adapter it was behind (ports_seen.device_port: VID:PID and the adapter's own serial number):
// another kind of adapter, or one with another serial number, in that socket is not taken for the board. Two adapters
// of one model without serial numbers (most CH340s) cannot be told apart that way: the second is opened as the first
// board's until it speaks, so ignore that socket (`fr ports ignore <path>`) when another board is plugged into it.
// config.json is read through liveConfig: a section the file stops giving (a syntax error mid-edit) keeps its last good
// value; with no valid ports settings read since the start the hub opens no port (`config_invalid`).
// A port the hub opens is opened with serialport's default lock (flock LOCK_EX|LOCK_NB on macOS): esptool and
// idf.py, which also open exclusively, then fail with "Could not exclusively lock port" until the port is lent
// (serial_lease, port_lend) or ignored. Provisioning and flashing lease the port they are given, watched or not.

import { configSection, type LiveConfig, liveConfig, type LiveConfigRead, paths, readConfig, updateConfig } from '@fractonica/host';
import { FrError } from '@fractonica/protocol';

import type { HubContext, OpInput } from '../context.ts';
import type { Db } from '../db.ts';
import { adapterId, isPathKey, normalizeMac, pathKey, type PolicyPort, type PortDecision, type PortPolicy } from '../serial.ts';
import { portLeased } from './holders.ts';

const DEVICE_ID = /^[0-9a-f]{12}$/;
const VID_PID = /^([0-9a-f]{4}):([0-9a-f]{4})$/i;

function cu(path: string): string {
  return path.replace('/dev/tty.', '/dev/cu.');
}

/** Whether a config entry names this port. */
export function portMatches(pattern: string, p: PolicyPort): boolean {
  const pat = pattern.trim();
  const vp = VID_PID.exec(pat);
  if (vp) {
    return p.vid?.toLowerCase() === vp[1].toLowerCase() && p.pid?.toLowerCase() === vp[2].toLowerCase();
  }
  if (pat.startsWith('/dev/')) {
    return cu(pat) === p.path;
  }
  if (isPathKey(pat)) {
    return pat === p.key;
  }
  const mac = normalizeMac(pat);
  if (mac === p.key || (p.usbSerial !== undefined && (p.usbSerial === pat || normalizeMac(p.usbSerial) === mac))) {
    return true;
  }
  if (p.bridgeSerial !== undefined && p.bridgeSerial === pat) {
    return true;
  }
  // A bare basename (`usbserial-110`, `usbmodem1101`).
  return !pat.includes('/') && (pathKey(`/dev/cu.${pat}`) === p.key || `/dev/cu.${pat}` === p.path);
}

export interface PortPolicyHandle extends PortPolicy {
  /** The config in force (a section the file cannot give now keeps its last good value). */
  config(): LiveConfigRead;
  /** Re-reads config.json now (after a port op wrote it). */
  refresh(): void;
  /** hub_status warnings: problems in config.json. */
  warnings(): string[];
}

/**
 * The hub's policy over config.json (re-read when its mtime changes, checked at most once a second) and the registry.
 * `config` is the hub's live reader (main.ts shares it with job pruning and log rotation), or a file to read.
 */
export function createPortPolicy(db: Db, config: string | LiveConfig = paths.config()): PortPolicyHandle {
  const reader = typeof config === 'string' ? liveConfig(config) : config;
  const deviceKnown = db.prepare('SELECT 1 FROM devices WHERE device_id = ?');
  const seenRow = db.prepare('SELECT device_id, device_port, vid, pid FROM ports_seen WHERE usb_serial = ? AND device_id IS NOT NULL');
  /** The board last seen on a bridge port, when the adapter in the socket is still the one it was seen behind. */
  const seenDevice = (p: PolicyPort): string | null => {
    const row = seenRow.get(p.key) as { device_id: string; device_port: string | null; vid: string | null; pid: string | null } | undefined;
    if (!row) {
      return null;
    }
    if (row.device_port !== null) {
      return row.device_port === adapterId(p) ? row.device_id : null;
    }
    // A row from before device_port: the same kind of adapter at least.
    const same = (a: string | null, b: string | undefined) => a === null || b === undefined || a.toLowerCase() === b.toLowerCase();
    return same(row.vid, p.vid) && same(row.pid, p.pid) ? row.device_id : null;
  };
  return {
    decide(p: PolicyPort): PortDecision {
      const read = reader.read();
      if (read.unset.includes('ports')) {
        // The file has not given valid ports settings since the start: no ignore list to trust, so nothing is opened.
        return { watch: false, why: 'config_invalid' };
      }
      const { ports } = read.config;
      const ownId = DEVICE_ID.test(p.key) ? p.key : null;
      const seen = ownId ? null : seenDevice(p);
      // An entry naming a board's MAC also covers the bridge port that board was last seen on.
      if (ports.ignore.some((x) => portMatches(x, p) || (seen !== null && normalizeMac(x.trim()) === seen))) {
        return { watch: false, why: 'ignored' };
      }
      if (ports.mode === 'all') {
        return { watch: true, why: 'all' };
      }
      const board = ownId ?? seen;
      if (board !== null && deviceKnown.get(board)) {
        return { watch: true, why: 'adopted' };
      }
      if (ports.claim.some((x) => portMatches(x, p))) {
        return { watch: true, why: 'claimed' };
      }
      return { watch: false, why: 'not_adopted' };
    },
    config: () => reader.read(),
    refresh() {
      reader.refresh();
    },
    warnings: () => reader.read().problems,
  };
}

/**
 * The entry a port op writes for an attached port: the MAC of a chip's own USB, or of the board a bridge port has
 * learned from its HELLO (it follows the board, decide()), else the /dev path.
 */
function stableId(port: { key: string; path: string; deviceId?: string }): string {
  return DEVICE_ID.test(port.key) ? port.key : (port.deviceId ?? port.path);
}

/** A port's basename as macOS and Linux name the candidates (`usbmodem1101`, `usbserial-110`, `ttyUSB0`, ...). */
const PORT_BASENAME = /^(cu\.|tty\.)?(usbmodem|usbserial|wchusbserial|SLAB_USBtoUART|ttyUSB|ttyACM)/i;

/**
 * The entry a port op writes for a port that is not attached: a registered board's MAC (by alias or id), a path in its
 * cu. form, a MAC normalized, a VID:PID, `path:<basename>` or a port basename. Anything else would be written as it is
 * and match nothing, so it is refused.
 */
function literalId(hub: HubContext, text: string): string {
  const t = text.trim().replace(/^port:/, '');
  if (VID_PID.test(t)) {
    return t.toLowerCase();
  }
  if (t.startsWith('/dev/')) {
    return cu(t);
  }
  if (DEVICE_ID.test(normalizeMac(t)) || isPathKey(t) || PORT_BASENAME.test(t)) {
    return normalizeMac(t);
  }
  const board = registeredBoard(hub, text);
  if (board) {
    return board;
  }
  throw new FrError('INVALID_ARGS', `${JSON.stringify(text)} is not an attached port, a registered board or a port pattern`, {
    hint: 'accepted: a registered board (alias or id:<12hex>), a MAC, a /dev path, path:<basename>, a port basename such as usbserial-110, or a VID:PID such as 1a86:7523',
    remediation: [{ tool: 'port_list', cli: 'fr ports' }, { tool: 'device_list', cli: 'fr devices' }],
  });
}

/** The MAC of the one registered board `selector` names (alias, id:, MAC), or null. */
function registeredBoard(hub: HubContext, selector: string): string | null {
  try {
    const d = hub.registry.resolve(selector, () => 'unknown');
    return d.length === 1 ? d[0].device_id : null;
  } catch {
    return null;
  }
}

/** literalId, or the text as given (normalized as a MAC) when it is no pattern: for removing an entry. */
function literalOrAsIs(hub: HubContext, text: string): string {
  try {
    return literalId(hub, text);
  } catch {
    return normalizeMac(text.trim());
  }
}

/**
 * Writes config.json's ports section through `mutate`. Refused (INVALID_ARGS) while that section has a problem (a value
 * of the wrong type): the hub runs on the last good settings then, and rewriting the section from the broken one would
 * drop them. updateConfig itself refuses a file that is not valid JSON.
 */
function writePorts(hub: HubContext, mutate: (raw: Record<string, unknown>) => void): void {
  const file = hub.portPolicy?.config().file ?? paths.config();
  const now = readConfig(file);
  if (now.bad.includes('ports')) {
    throw new FrError('INVALID_ARGS', `the ports section of ${file} has a problem, so it is left as it is`, {
      hint: now.problems.join('; '),
      remediation: [{ human: `fix the ports section of ${file}, then retry` }],
    });
  }
  updateConfig(mutate, file);
}

function listOf(raw: Record<string, unknown>, key: 'ignore' | 'claim'): string[] {
  const ports = configSection(raw, 'ports');
  const v = ports[key];
  const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  ports[key] = list;
  return list;
}

function result(hub: HubContext, entry: string, port: { path: string } | null): Record<string, unknown> {
  hub.portPolicy?.refresh();
  const read = hub.portPolicy?.config() ?? readConfig();
  const info = port ? hub.serial.list().find((p) => p.path === port.path) : undefined;
  return {
    port: entry,
    ...(port ? { path: port.path } : {}),
    ...(info ? { state: info.state } : {}),
    mode: read.config.ports.mode,
    ignore: read.config.ports.ignore,
    claim: read.config.ports.claim,
    config: read.file,
  };
}

/** The attached port a selector names (a port, or a registered device's port), or null when none is attached. */
function attached(
  hub: HubContext,
  selector: string,
): { key: string; path: string; usbSerial?: string; vid?: string; pid?: string; bridge?: string; bridgeSerial?: string; deviceId?: string } | null {
  try {
    const e = hub.serial.resolve(selector);
    return { key: e.key, path: e.path, usbSerial: e.usbSerial, vid: e.vid, pid: e.pid, bridge: e.bridge, bridgeSerial: e.bridgeSerial, deviceId: e.deviceId };
  } catch (err) {
    if (err instanceof FrError && err.code === 'NOT_FOUND') {
      // An alias: the port of that registered device, when attached.
      try {
        const d = hub.registry.resolve(selector, () => 'unknown');
        if (d.length === 1) {
          return attached(hub, d[0].device_id);
        }
      } catch {
        // not a device either
      }
      return null;
    }
    throw err;
  }
}

/** Waits up to `ms` for the hub to settle on a port after a policy change (open, busy, or closed). */
async function settle(hub: HubContext, path: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const st = hub.serial.list().find((p) => p.path === path)?.state;
    if (st !== 'closed') {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
    await hub.serial.recheck();
  }
}

export async function portIgnore(hub: HubContext, input: OpInput<'port_ignore'>): Promise<Record<string, unknown>> {
  const port = VID_PID.test(input.port.trim()) ? null : attached(hub, input.port);
  // Removing takes any text (an entry written by hand); adding needs an entry that can match a port.
  const entry = port ? stableId(port) : input.remove ? literalOrAsIs(hub, input.port) : literalId(hub, input.port);
  writePorts(hub, (raw) => {
    const ignore = listOf(raw, 'ignore');
    const keep = ignore.filter((x) => !(x === entry || x === input.port.trim() || (port && portMatches(x, port))));
    if (input.remove) {
      configSection(raw, 'ports').ignore = keep;
    } else if (!ignore.includes(entry)) {
      ignore.push(entry);
    }
  });
  hub.portPolicy?.refresh();
  await hub.serial.recheck();
  return result(hub, entry, port);
}

export async function portClaim(hub: HubContext, input: OpInput<'port_claim'>): Promise<Record<string, unknown>> {
  const port = attached(hub, input.port);
  if (!port && !input.remove) {
    throw new FrError('NOT_FOUND', `no attached port matches ${JSON.stringify(input.port)}`, { remediation: [{ tool: 'port_list', cli: 'fr ports ls' }] });
  }
  const entry = port ? stableId(port) : literalOrAsIs(hub, input.port);
  if (port && !input.remove) {
    const info = hub.serial.list().find((p) => p.path === port.path);
    if (info?.state === 'leased') {
      throw portLeased(port, info);
    }
  }
  writePorts(hub, (raw) => {
    const ports = configSection(raw, 'ports');
    const claim = listOf(raw, 'claim');
    const named = (x: string) => x === entry || x === input.port.trim() || (port !== null && portMatches(x, port));
    if (input.remove) {
      ports.claim = claim.filter((x) => !named(x));
      return;
    }
    ports.ignore = listOf(raw, 'ignore').filter((x) => !named(x));
    if (!claim.includes(entry)) {
      claim.push(entry);
    }
  });
  hub.portPolicy?.refresh();
  await hub.serial.recheck();
  if (port && !input.remove) {
    await settle(hub, port.path);
  }
  return result(hub, entry, port);
}

export async function portLend(hub: HubContext, input: OpInput<'port_lend'>) {
  return hub.leases.lease({ device: input.port, ttl_s: input.ttl_s });
}
