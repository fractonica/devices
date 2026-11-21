// A board's hub list (design multi-hub-m1): device_hubs_set pushes the ordered list of hubs a board connects to
// (fr.node.hubs_set, with a rev above the one the board holds) and records it in the registry row; device_hubs_get asks
// the board (fr.node.hubs_get) and brings the row in line with it, since any hub of the network may have set it.
// device_get shows the row's copy and `hub_now`: whether the board's TCP session is with this hub, and its last answer.
// The board decides where it is: it tries the list in order, moves down it when a hub goes away and returns by itself
// (firmware fr/net/hub_plan.hpp). A hub only learns of a move by the board's session ending here or starting.

import { FrError } from '@fractonica/protocol';
import { decodeNodeHubsGetResult, encodeNodeHubsSetArgs, findCap, type NodeHubsGetResult, PORT, STATUS, statusName } from '@fractonica/protocol/gen';

import type { Device, DeviceHubs, HubContext } from '../context.ts';
import type { Db } from '../db.ts';
import { hubHostName } from '../network.ts';
import { routerInfo } from '../router/index.ts';
import { boardAt } from '../peers/index.ts';
import { presenceOf, resolveOne } from './hub.ts';
import { hubIpv4 } from './ident.ts';
import { setDeviceHubs } from './store.ts';

function commandId(name: string): number {
  const id = findCap('fr.node')?.commands.find((c) => c.name === name)?.id;
  if (id === undefined) {
    throw new Error(`fr.node.${name} missing from the generated catalog`);
  }
  return id;
}

const HUBS_SET = commandId('hubs_set');
const HUBS_GET = commandId('hubs_get');
/** fr.node.hubs_get `on` for "none of them". */
const ON_NONE = 255;
const CMD_TIMEOUT_MS = 3000;
/** The board takes a pushed list about 300 ms after its RESULT; it is asked what became of it this long after. */
const SETTLE_MS = 900;

/** A board's last fr.node.hubs_get answer in this hub run. */
interface Report {
  on: number | null;
  rev: number;
  trial: boolean;
  at: string;
}

/** Reports per database (one hub), per device: memory only, a hub run's knowledge. */
const reportsOf = new WeakMap<Db, Map<string, Report>>();

function reports(db: Db): Map<string, Report> {
  let m = reportsOf.get(db);
  if (!m) {
    m = new Map();
    reportsOf.set(db, m);
  }
  return m;
}

/**
 * device_get `hub_now`: whether its TCP session is with this hub, what it last said of its list, and (design
 * multi-hub-m2 §6) `at`: the name of the hub that holds its session, this hub's or a peer's. The time of the board's
 * answer is `asked_at`.
 */
export function hubNow(hub: HubContext, d: Device) {
  const info = routerInfo(hub.router, d.device_id);
  const here = !!info && (info.presence === 'online' || info.presence === 'suspect') && info.links.includes('tcp');
  const r = reports(hub.db).get(d.device_id);
  return { here, on: r?.on ?? null, rev: r?.rev ?? null, trial: r?.trial ?? null, at: boardAt(hub, d.device_id), asked_at: r?.at ?? null };
}

/** `<host>` or `<host>/<ipv4>` (the op's hubEntry) as a list entry. */
function parseEntry(text: string): { host: string; ip: string | null } {
  const slash = text.indexOf('/');
  const host = slash < 0 ? text : text.slice(0, slash);
  const ip = slash < 0 ? null : text.slice(slash + 1);
  if (ip !== null && (ip.split('.').some((p) => Number(p) > 255) || ip === '0.0.0.0')) {
    throw new FrError('INVALID_ARGS', `${JSON.stringify(ip)} is not an IPv4 address`, { hint: 'e.g. home-hub.local/192.168.1.30' });
  }
  return { host, ip };
}

function requireSession(hub: HubContext, d: Device): void {
  const presence = presenceOf(hub)(d.device_id);
  if (presence !== 'online' && presence !== 'suspect') {
    throw new FrError('DEVICE_OFFLINE', `${d.alias} has no session with this hub: its hub list is set and read over the air`, {
      hint: 'a board that moved to another hub of its list is asked there; device_get shows the list this hub recorded',
      remediation: [{ tool: 'device_get', args: { device: d.alias }, cli: `fr devices get ${d.alias}` }],
    });
  }
}

/** What a RESULT status other than OK means for a hub list command. */
function refused(d: Device, cmd: 'hubs_set' | 'hubs_get', status: number): FrError {
  const name = statusName(status) ?? String(status);
  if (status === STATUS.UNSUPPORTED) {
    return new FrError('CAPABILITY_UNSUPPORTED', `${d.alias} has no hub list: its firmware is older than fr.node 1.1, or it has no hub link of its own to choose (a gateway, a radio-off build)`, {
      hint: 'update its firmware (fr ota, or a flash), then set the list',
      details: { device_id: d.device_id, command: cmd, status: name },
    });
  }
  if (status === STATUS.BUSY) {
    return new FrError('DEVICE_BUSY', `${d.alias} is still taking an earlier hub list: try again in a second`, { details: { device_id: d.device_id, status: name } });
  }
  if (status === STATUS.EXPIRED) {
    return new FrError('EXPIRED', `${d.alias} holds a newer hub list than the one sent (another hub of its network set it meanwhile)`, {
      hint: `read it first: fr devices hubs get ${d.alias}`,
      details: { device_id: d.device_id, status: name },
    });
  }
  return new FrError(status === STATUS.INVALID_ARGS ? 'INVALID_ARGS' : 'DELIVERY_FAILED', `${d.alias} refused ${cmd} (${name})`, {
    details: { device_id: d.device_id, command: cmd, status: name },
  });
}

/** fr.node.hubs_get, decoded; the row and this run's report follow what the board holds. */
async function ask(hub: HubContext, d: Device): Promise<NodeHubsGetResult> {
  const r = await hub.router.sendCommand(d.device_id, PORT.NODE, HUBS_GET, new Uint8Array(), { ack: 'result', timeoutMs: CMD_TIMEOUT_MS, bulk: true });
  if (r.status !== STATUS.OK) {
    throw refused(d, 'hubs_get', r.status);
  }
  const got = decodeNodeHubsGetResult(r.fields);
  if (!got.ok) {
    throw new FrError('DELIVERY_FAILED', `${d.alias} answered hubs_get with something that does not decode`, { details: { device_id: d.device_id } });
  }
  const v = got.value;
  const at = new Date().toISOString();
  reports(hub.db).set(d.device_id, { on: v.on === ON_NONE ? null : v.on, rev: v.rev, trial: v.trial, at });
  // The board is the truth of its own list. A list still on trial is not recorded: it may yet be reverted.
  if (!v.trial && (d.hubs?.rev ?? 0) !== v.rev) {
    setDeviceHubs(hub.db, d.device_id, v.rev === 0 && !v.hubs.length ? null : { rev: v.rev, hubs: v.hubs.map((h) => ({ host: h.host, ip: h.ip || null })), set_at: at });
  }
  return v;
}

function view(d: Device, v: NodeHubsGetResult, extra: Record<string, unknown> = {}) {
  return {
    device_id: d.device_id,
    alias: d.alias,
    hubs: v.hubs.map((h) => ({ host: h.host, ip: h.ip || null })),
    rev: v.rev,
    on: v.on === ON_NONE ? null : v.on,
    trial: v.trial,
    ...extra,
  };
}

export async function hubsGet(hub: HubContext, input: { device: string }) {
  const d = resolveOne(hub, input.device);
  requireSession(hub, d);
  return view(d, await ask(hub, d));
}

/** The names a board may know this hub under: its mDNS name and its LAN address. */
function ownNames(): string[] {
  const names = [hubHostName().toLowerCase()];
  const ip = hubIpv4();
  if (ip) {
    names.push(ip);
  }
  return names;
}

export async function hubsSet(hub: HubContext, input: { device: string; hub?: string[]; none?: boolean }) {
  const d = resolveOne(hub, input.device);
  const entries = (input.hub ?? []).map(parseEntry);
  if (!entries.length && !input.none) {
    throw new FrError('INVALID_ARGS', 'give the hubs in priority order (--hub <host>, repeated), or --none to take the list away');
  }
  if (entries.length && input.none) {
    throw new FrError('INVALID_ARGS', '--none takes the list away: give it without --hub');
  }
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.host.toLowerCase())) {
      throw new FrError('INVALID_ARGS', `${e.host} is in the list twice`);
    }
    seen.add(e.host.toLowerCase());
  }
  requireSession(hub, d);
  // The next rev is above the board's own (another hub of the network may have pushed since) and the row's.
  const held = await ask(hub, d);
  const rev = Math.max(held.rev, d.hubs?.rev ?? 0) + 1;
  const args = encodeNodeHubsSetArgs({ hubs: entries.map((e) => ({ host: e.host, ip: e.ip ?? '' })), rev });
  const r = await hub.router.sendCommand(d.device_id, PORT.NODE, HUBS_SET, args, { ack: 'result', timeoutMs: CMD_TIMEOUT_MS, bulk: true });
  if (r.status !== STATUS.OK) {
    throw refused(d, 'hubs_set', r.status);
  }
  const at = new Date().toISOString();
  const stored: DeviceHubs | null = entries.length ? { rev, hubs: entries, set_at: at } : { rev, hubs: [], set_at: at };
  setDeviceHubs(hub.db, d.device_id, stored);
  const warnings: string[] = [];
  const own = ownNames();
  // Said only when the board does not find this hub in the list itself (it knows the hub by the name it was given).
  const notListed = entries.length && !entries.some((e) => own.includes(e.host.toLowerCase())) ? `this hub (${own.join(', ')}) is not in the list: ${d.alias} leaves it for ${entries[0].host}` : null;
  // What became of it: a list that names this hub is kept at once; with another the board goes there (and its
  // session here ends), and a list none of whose hubs takes it is dropped by the board after 60 s.
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const pushed = { hubs: entries.map((e) => ({ host: e.host, ip: e.ip ?? '' })), rev, on: ON_NONE, trial: false };
  const presence = presenceOf(hub)(d.device_id);
  if (presence === 'online' || presence === 'suspect') {
    try {
      const now = await ask(hub, { ...d, hubs: stored });
      if (notListed && now.on === ON_NONE) {
        warnings.push(notListed);
      }
      return { ...view(d, now, { left: false }), ...(warnings.length ? { warnings } : {}) };
    } catch {
      // it left between the two commands: the answer below says so
    }
  }
  reports(hub.db).delete(d.device_id);
  if (notListed) {
    warnings.push(notListed);
  }
  warnings.push(`${d.alias} is no longer connected here: it went to ${entries[0]?.host ?? 'the hub it was provisioned with'}; if no hub of the list takes it within 60 s it returns to the list it had (fr devices hubs get ${d.alias} then shows the older rev)`);
  return { ...view(d, { ...pushed, trial: true }, { on: null, trial: null, left: true }), warnings };
}
