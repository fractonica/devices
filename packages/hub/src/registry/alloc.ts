// Addresses stay the registrar's (design multi-hub-m2 §5, §16). A member that is asked to provision, enroll, adopt or
// re-identify a board that has no address of the network asks the registrar for one over the hubs' link, then goes on
// as it always did for a board that has one:
//   - `ensureAddress` (the member): the link service `addr_alloc` at the registrar, and the identity it answers stored
//     in this hub's row (storeSharedIdentity: nothing is allocated here). With the registrar away it refuses, naming it.
//   - `allocate` (the registrar): its own prepareIdentity, the one place an address is handed out. It runs in one
//     SQLite transaction of one process, so two members that ask at once get two addresses, and a member that asks
//     twice for one board gets the address it got. The row it leaves (not provisioned yet, as before a flash) reaches
//     every hub by replication; the member marks it provisioned when its flash or enrollment is done.
// A link service, not an op (as 2.2's artifact_get): it is not gated by the op registry's hash, and no client calls it.

import { DEFAULT_NETWORK, type DeviceRole, FrError } from '@fractonica/protocol';

import type { HubContext } from '../context.ts';
import { fleetNetId, listNetworks, readNetwork, type Registrar, registrarOf } from '../network.ts';
import { listMembers } from '../peers/members.ts';
import { checkAlias } from './names.ts';
import { prepareIdentity, storeSharedIdentity } from './store.ts';

/** The link service's name (peers/passing.ts SYS). */
export const ADDR_ALLOC = 'addr_alloc';
const ALLOC_MS = 8000;

export interface AllocInput {
  device_id: string;
  alias?: string;
  profile?: string | null;
  board?: string | null;
  chip?: string | null;
  role?: DeviceRole;
}

/** What the registrar answers: the identity the board has in the network from now on. */
export interface Allocated {
  device_id: string;
  addr: number;
  net: number;
  alias: string;
  alias_rev: number;
  epoch_floor: number;
}

type AllocHub = Pick<HubContext, 'db'> & Partial<Pick<HubContext, 'peers'>>;

/** The registrar's half: an address for the board (the one it has, or the next), and its alias. */
export function allocate(hub: AllocHub, input: Record<string, unknown>, from: string): Allocated {
  const registrar = registrarOf(hub.db);
  if (registrar) {
    throw new FrError('INVALID_ARGS', `this hub is not the network's registrar (${registrar.hub_host ?? registrar.url} is): it hands out no addresses`);
  }
  const deviceId = typeof input.device_id === 'string' ? input.device_id.toLowerCase() : '';
  if (!/^[0-9a-f]{12}$/.test(deviceId)) {
    throw new FrError('INVALID_ARGS', 'addr_alloc needs a device id (12 hex digits)');
  }
  const net = readNetwork(hub.db, DEFAULT_NETWORK) ?? listNetworks(hub.db)[0] ?? null;
  if (!net) {
    throw new FrError('ENV_MISSING', 'the registrar has no network stored, so no net id to give a board');
  }
  const text = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null);
  const prep = prepareIdentity(hub.db, {
    deviceId,
    ...(typeof input.alias === 'string' ? { alias: checkAlias(input.alias) } : {}),
    profile: text(input.profile),
    board: text(input.board),
    chip: text(input.chip),
    net: net.net_id,
    ...(input.role === 'fixture' || input.role === 'gateway' || input.role === 'node' ? { role: input.role } : {}),
  });
  const d = prep.device;
  console.log(JSON.stringify({ event: 'addr_alloc', device: deviceId, addr: d.addr, for: from }));
  hub.peers?.registry.flush([deviceId]); // the row is at every hub before the member's own write of it arrives
  return { device_id: deviceId, addr: d.addr!, net: d.net!, alias: d.alias, alias_rev: d.alias_rev, epoch_floor: prep.epoch_floor };
}

/** Why a member cannot get an address now: the registrar is not reachable over the link. Retryable. */
function registrarAway(registrar: Registrar, who: string, why: string): FrError {
  const name = registrar.hub_host ? `${registrar.hub_host} (${registrar.url})` : registrar.url;
  return new FrError('HUB_UNREACHABLE', `${who} has no address in this network yet, and this hub joined the network of ${name}: only that hub, the network's registrar, hands out addresses, and it is not reachable over the hubs' link now (${why})`, {
    hint: 'start that hub, or look at the link (fr hub peers), then try again; nothing was changed',
    remediation: [{ tool: 'hub_peers', cli: 'fr hub peers' }],
    details: { registrar: registrar.url, registrar_host: registrar.hub_host, net: registrar.net_id },
  });
}

/**
 * On a member, for a board without an address of the network `net`: asks the registrar for one and stores the
 * identity it answers in this hub's row. Nothing to do on the registrar itself, on a hub that is alone, or for a board
 * that has an address of this network. Returns what the registrar answered, or null when it was not asked.
 */
export async function ensureAddress(hub: AllocHub, p: AllocInput & { net: number; network: string }): Promise<Allocated | null> {
  const registrar = registrarOf(hub.db);
  if (!registrar) {
    return null;
  }
  const have = hub.db.prepare('SELECT addr, net, alias FROM devices WHERE device_id = ?').get(p.device_id) as { addr: number | null; net: number | null; alias: string } | undefined;
  if (have && have.addr !== null && have.net === p.net) {
    return null;
  }
  const who = have?.alias ?? p.device_id;
  const slot0 = listMembers(hub.db).find((m) => m.slot === 0);
  const peers = hub.peers;
  if (!peers) {
    return null; // no link part at all (a test's context): prepareIdentity refuses as it did before the link
  }
  if (!slot0) {
    throw registrarAway(registrar, who, 'this hub holds no member list: join the network again (fr net join) to get its key');
  }
  const reg = peers.hubs().find((h) => h.id === slot0.id);
  if (!reg || !reg.reachable) {
    throw registrarAway(registrar, who, `hub ${slot0.name}${reg?.last_error ? `: ${reg.last_error}` : ' is away'}`);
  }
  const a = await peers.call(
    reg.id,
    ADDR_ALLOC,
    { device_id: p.device_id, ...(p.alias !== undefined ? { alias: p.alias } : {}), profile: p.profile ?? null, board: p.board ?? null, chip: p.chip ?? null, ...(p.role ? { role: p.role } : {}) },
    { mode: 'sys', timeoutMs: ALLOC_MS, repeatable: true },
  );
  if (!a.result.ok) {
    const err = a.result.error;
    if (err?.code === 'HUB_UNREACHABLE' || err?.code === 'TIMEOUT') {
      throw registrarAway(registrar, who, err.message);
    }
    if (err?.code === 'HUB_VERSION_MISMATCH') {
      throw new FrError('HUB_VERSION_MISMATCH', `${who} has no address in this network yet, and the registrar (hub ${reg.name}) runs a version that hands none out over the hubs' link`, {
        hint: `update hub ${reg.name} and restart it, or provision or enroll the board on that hub`,
        details: { registrar: registrar.url, hub: reg.name },
      });
    }
    throw new FrError(err?.code ?? 'INTERNAL', `the registrar (hub ${reg.name}) refused an address for ${who}: ${err?.message ?? 'no reason given'}`, { ...(err?.hint ? { hint: err.hint } : {}), details: { hub: reg.name, ...(err?.details ?? {}) } });
  }
  const got = a.result.data as Partial<Allocated> | null;
  if (!got || got.device_id !== p.device_id || typeof got.addr !== 'number' || typeof got.net !== 'number' || typeof got.alias !== 'string' || got.net !== fleetNetId(hub.db)) {
    throw new FrError('HUB_VERSION_MISMATCH', `the registrar (hub ${reg.name}) answered an identity this hub cannot use for ${who}`, { hint: 'both hubs must run the same version', details: { hub: reg.name } });
  }
  storeSharedIdentity(hub.db, {
    deviceId: p.device_id,
    addr: got.addr,
    net: got.net,
    alias: got.alias,
    alias_rev: got.alias_rev ?? 1,
    epoch_floor: got.epoch_floor ?? 1,
    profile: p.profile ?? null,
    board: p.board ?? null,
    chip: p.chip ?? null,
    network: p.network,
  });
  return got as Allocated;
}

/** The registrar as a hub of the link, when it is reachable now: its name, else why not. For a check before a job starts. */
export function registrarReachable(hub: AllocHub): { ok: boolean; why: string } {
  const slot0 = listMembers(hub.db).find((m) => m.slot === 0);
  const reg = slot0 && hub.peers?.hubs().find((h) => h.id === slot0.id);
  if (!hub.peers || !slot0) {
    return { ok: false, why: hub.peers ? 'this hub holds no member list: join the network again (fr net join)' : 'this hub has no link' };
  }
  return reg?.reachable ? { ok: true, why: '' } : { ok: false, why: `hub ${slot0.name}${reg?.last_error ? `: ${reg.last_error}` : ' is away'}` };
}

/** A check before a job that will need an address: refused now, not after the probe, when the registrar is away. */
export function checkRegistrarFor(hub: AllocHub, deviceId: string, alias: string | undefined, net: number): void {
  const registrar = registrarOf(hub.db);
  if (!registrar) {
    return;
  }
  const have = hub.db.prepare('SELECT addr, net FROM devices WHERE device_id = ?').get(deviceId) as { addr: number | null; net: number | null } | undefined;
  if (have && have.addr !== null && have.net === net) {
    return;
  }
  const r = registrarReachable(hub);
  if (!r.ok) {
    throw registrarAway(registrar, alias ?? deviceId, r.why);
  }
}
