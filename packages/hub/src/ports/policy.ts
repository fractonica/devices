// The port policy (config.json `ports`; review decision "adopted only"): which USB serial ports the hub opens.
//   - ports.ignore: never opened, whatever the mode. An entry is a /dev path (cu. or tty.), a USB serial or MAC (it
//     follows the board to any path), `path:<basename>` or a bare basename (a USB-UART bridge's location), or a
//     VID:PID such as 1a86:7523 (every port of that adapter).
//   - mode `adopted` (the default): a port is opened when its board is registered: its key is the MAC of a registry
//     device (a chip's own USB names its MAC in the USB serial number, which survives re-enumeration), or the device
//     last seen on it (ports_seen.device_id: a bridge port's HELLO, a provision's probe) is one. ports.claim lists
//     ports opened anyway (fr ports claim), so an unknown board can say HELLO. Every other candidate port is listed
//     as `unwatched`, closed, for idf.py, esptool or a browser to use.
//   - mode `all`: every Espressif and USB-UART bridge port, as before the policy.
// A port the hub opens is opened with serialport's default lock (flock LOCK_EX|LOCK_NB on macOS): esptool and
// idf.py, which also open exclusively, then fail with "Could not exclusively lock port" until the port is lent
// (serial_lease, port_lend) or ignored. Provisioning and flashing lease the port they are given, watched or not.

import { cachedConfig, type ConfigRead, configSection, paths, readConfig, updateConfig } from '@fractonica/host';
import { FrError } from '@fractonica/protocol';

import type { HubContext, OpInput } from '../context.ts';
import type { Db } from '../db.ts';
import { isPathKey, normalizeMac, pathKey, type PolicyPort, type PortDecision, type PortPolicy } from '../serial.ts';
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
  // A bare basename (`usbserial-110`, `usbmodem1101`).
  return !pat.includes('/') && (pathKey(`/dev/cu.${pat}`) === p.key || `/dev/cu.${pat}` === p.path);
}

export interface PortPolicyHandle extends PortPolicy {
  /** The config as last read (problems included). */
  config(): ConfigRead;
  /** Re-reads config.json now (after a port op wrote it). */
  refresh(): void;
  /** hub_status warnings: problems in config.json. */
  warnings(): string[];
}

/** The hub's policy over config.json (re-read when its mtime changes, checked at most once a second) and the registry. */
export function createPortPolicy(db: Db, file = paths.config()): PortPolicyHandle {
  let reader = cachedConfig(file);
  const deviceKnown = db.prepare('SELECT 1 FROM devices WHERE device_id = ?');
  const seenDevice = db.prepare('SELECT device_id FROM ports_seen WHERE usb_serial = ? AND device_id IS NOT NULL');
  const adopted = (p: PolicyPort): boolean => {
    if (DEVICE_ID.test(p.key) && deviceKnown.get(p.key)) {
      return true;
    }
    const seen = seenDevice.get(p.key) as { device_id: string } | undefined;
    return !!seen && !!deviceKnown.get(seen.device_id);
  };
  return {
    decide(p: PolicyPort): PortDecision {
      const { config } = reader();
      if (config.ports.ignore.some((x) => portMatches(x, p))) {
        return { watch: false, why: 'ignored' };
      }
      if (config.ports.mode === 'all') {
        return { watch: true, why: 'all' };
      }
      if (adopted(p)) {
        return { watch: true, why: 'adopted' };
      }
      if (config.ports.claim.some((x) => portMatches(x, p))) {
        return { watch: true, why: 'claimed' };
      }
      return { watch: false, why: 'not_adopted' };
    },
    config: () => reader(),
    refresh() {
      reader = cachedConfig(file);
    },
    warnings: () => reader().problems,
  };
}

/** The entry a port op writes for an attached port: the MAC of a chip's own USB, else the /dev path. */
function stableId(port: { key: string; path: string }): string {
  return DEVICE_ID.test(port.key) ? port.key : port.path;
}

/** The entry a port op writes for a port that is not attached: as given, a path in its cu. form, a MAC normalized. */
function literalId(text: string): string {
  const t = text.trim().replace(/^port:/, '');
  if (VID_PID.test(t)) {
    return t.toLowerCase();
  }
  if (t.startsWith('/dev/')) {
    return cu(t);
  }
  return normalizeMac(t);
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
function attached(hub: HubContext, selector: string): { key: string; path: string; usbSerial?: string; vid?: string; pid?: string; bridge?: string } | null {
  try {
    const e = hub.serial.resolve(selector);
    return { key: e.key, path: e.path, usbSerial: e.usbSerial, vid: e.vid, pid: e.pid, bridge: e.bridge };
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
  const entry = port ? stableId(port) : literalId(input.port);
  updateConfig((raw) => {
    const ignore = listOf(raw, 'ignore');
    const keep = ignore.filter((x) => !(x === entry || x === input.port.trim() || (port && portMatches(x, port))));
    if (input.remove) {
      configSection(raw, 'ports').ignore = keep;
    } else if (!ignore.includes(entry)) {
      ignore.push(entry);
    }
  }, hub.portPolicy?.config().file ?? paths.config());
  hub.portPolicy?.refresh();
  await hub.serial.recheck();
  return result(hub, entry, port);
}

export async function portClaim(hub: HubContext, input: OpInput<'port_claim'>): Promise<Record<string, unknown>> {
  const port = attached(hub, input.port);
  if (!port && !input.remove) {
    throw new FrError('NOT_FOUND', `no attached port matches ${JSON.stringify(input.port)}`, { remediation: [{ tool: 'port_list', cli: 'fr ports ls' }] });
  }
  const entry = port ? stableId(port) : literalId(input.port);
  if (port && !input.remove) {
    const info = hub.serial.list().find((p) => p.path === port.path);
    if (info?.state === 'leased') {
      throw portLeased(port, info);
    }
  }
  updateConfig((raw) => {
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
  }, hub.portPolicy?.config().file ?? paths.config());
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
