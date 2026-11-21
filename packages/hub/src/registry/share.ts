// One network, several hubs (design multi-hub-m1), the registry side.
//   - network_join: this hub becomes a member of another hub's network. It takes that hub's net id (and, with no
//     network stored here, its SSID, country and band; never a password) and records that hub as the registrar: the
//     one hub of the network that hands out addresses (network.ts registrarOf; store.ts prepareIdentity refuses to
//     allocate from then on). Boards provisioned here under the hub's own net id become foreign: their HELLO is no
//     longer taken (router `foreign_net`), and each needs a new identity.
//   - device_share: this hub gives another hub of the SAME network the row of one of its boards, through that hub's
//     device_enroll with the identity the board has (enroll.ts enrollShared there). Nothing is flashed or allocated.
//     Since the hubs' link (design multi-hub-m2 §3.1, §4, §9) the registrar also admits the hub (its network_admit,
//     peers/admission.ts): this hub gets the network key (sealed in transit, into secrets.json), its name in the
//     network, an epoch slot and the member list, and its link to the other hubs starts. Joining the same hub again
//     changes nothing, and gives a hub that joined under MULTI-HUB-1 its key and slot.
// The other hub is called as `for_hub` calls it (remote.ts).
// Since the registry is one (design multi-hub-m2 §5, step 2.3) every hub of a network holds every row of it by
// replication (peers/registry.ts), and device_share toward a hub this hub replicates with does nothing and says so. It
// still gives the row by hand to a hub of the network that does not replicate: one from before step 2.3, or one that
// joined before the hubs' link and holds no key.

import { DEFAULT_NETWORK, EnrolledSchema, FrError, type NetworkBand, NETWORK_BANDS } from '@fractonica/protocol';

import type { HubContext } from '../context.ts';
import { fleetNetId, joinNetwork, listNetworks, networkDevices, passwordNames, registrarOf } from '../network.ts';
import { requestAdmission, slotWarning, storeAdmission } from '../peers/admission.ts';
import { listMembers, publicMember } from '../peers/members.ts';
import { hubIdentity } from '../peers/identity.ts';
import { HubRouter } from '../router/index.ts';
import { registryOf, resolveOne } from './hub.ts';
import { type Fetch, hubBase, remoteHealth, remoteOp } from './remote.ts';
import { noteSharedWith, provisionOf } from './store.ts';

/** The other hub's stored networks as its network_list answers them. */
interface RemoteNetwork {
  name?: unknown;
  net_id?: unknown;
  ssid?: unknown;
  country?: unknown;
  band?: unknown;
  hub_host?: unknown;
}

export interface ShareDeps {
  /** How the other hub is called; default the global fetch. */
  fetch?: Fetch;
}

/** INVALID_ARGS when `base` is this hub's own API on loopback. */
export function notSelf(hub: HubContext, base: string, hint: string): void {
  const own = hub.run?.apiPort;
  const u = new URL(base);
  if (own !== undefined && Number(u.port || (u.protocol === 'https:' ? 443 : 80)) === own && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    throw new FrError('INVALID_ARGS', `${base} is this hub itself`, { hint });
  }
}

async function remoteNetworks(base: string, deps: ShareDeps): Promise<RemoteNetwork[]> {
  await remoteHealth(base, { fetch: deps.fetch });
  return (await remoteOp<{ networks?: RemoteNetwork[] }>(base, 'network_list', {}, { fetch: deps.fetch })).networks ?? [];
}

/**
 * The hub at `base` when this hub replicates the registry with it (design multi-hub-m2 step 2.3): it is in the member
 * list by the id its hub_peers says, its link is up, and its hello said `registry`. Its name, and the host name and
 * address a board finds it by. Null for any other hub (another network's, one that says nothing of itself, an older one).
 */
export async function linkedReplica(hub: Pick<HubContext, 'db'> & Partial<Pick<HubContext, 'peers'>>, base: string, deps: ShareDeps = {}): Promise<{ id: string; name: string; host: string; addr: string | null } | null> {
  if (!hub.peers) {
    return null;
  }
  let id: unknown;
  try {
    // hub_peers answers who that hub is in its network (and ENV_MISSING on a hub that is in none).
    id = (await remoteOp<{ hub?: { id?: unknown } }>(base, 'hub_peers', {}, { fetch: deps.fetch })).hub?.id;
  } catch {
    return null; // a hub that says nothing of itself is treated as before
  }
  const member = typeof id === 'string' ? listMembers(hub.db).find((m) => m.id === id) : undefined;
  const peer = member && hub.peers.hubs().find((h) => h.id === member.id);
  return member && peer?.reachable && hub.peers.registry.replicates(member.id) ? { id: member.id, name: member.name, host: member.host, addr: member.addr } : null;
}

export async function share(hub: HubContext, input: { device: string; with_hub: string }, deps: ShareDeps = {}) {
  const d = resolveOne(hub, input.device);
  const base = hubBase(input.with_hub);
  notSelf(hub, base, 'name the other hub of the network');
  if (!d.provisioned || d.addr === null || d.net === null) {
    throw new FrError('INVALID_ARGS', `${d.alias} is not provisioned on this hub: it has no identity to share`, {
      hint: 'provision it first (fr devices provision), or share it from the hub that has its row',
      remediation: [{ tool: 'device_get', args: { device: d.alias }, cli: `fr devices get ${d.alias}` }],
    });
  }
  const nets = await remoteNetworks(base, deps);
  const theirs = nets.filter((n) => n.net_id === d.net);
  if (!theirs.length) {
    const other = nets.find((n) => typeof n.net_id === 'number')?.net_id;
    throw new FrError('INVALID_ARGS', `the hub at ${base} is not in ${d.alias}'s network (${other === undefined ? 'it has no network stored' : `its net id is ${String(other)}`}; ${d.alias}'s is ${d.net})`, {
      hint: `a board keeps one identity in one network. Make that hub a member of this one first, on it: fr net join --hub <this hub's API>`,
      details: { with_hub: base, net: d.net, ...(other === undefined ? {} : { their_net: other }) },
    });
  }
  // Design multi-hub-m2 step 2.3: a hub this hub replicates with holds the row already. Nothing is sent.
  const replica = await linkedReplica(hub, base, deps);
  if (replica) {
    hub.peers?.registry.flush([d.device_id]);
    return {
      device_id: d.device_id,
      alias: d.alias,
      addr: d.addr,
      net: d.net,
      with_hub: base,
      hub_host: replica.host,
      hub_ip: replica.addr,
      replicated: true,
      warnings: [`nothing to share: hub ${replica.name} holds ${d.alias}'s row already, as every hub of this network holds every row of it (the registry is replicated over the hubs' link)`],
    };
  }
  // The same network name there when it has one, else its default, else whichever carries the net id.
  const named = theirs.find((n) => n.name === (d.network ?? DEFAULT_NETWORK)) ?? theirs.find((n) => n.name === DEFAULT_NETWORK) ?? theirs[0];
  const rec = provisionOf(hub.db, d.device_id);
  const answer = EnrolledSchema.safeParse(
    await remoteOp(
      base,
      'device_enroll',
      {
        device_id: d.device_id,
        ...(d.chip ? { chip: d.chip } : {}),
        ...(d.profile ? { profile: d.profile } : {}),
        ...(d.board ? { board: d.board } : {}),
        ...(rec?.part_profile ? { part_profile: rec.part_profile } : {}),
        ...(rec?.build_id ? { build_id: rec.build_id } : {}),
        ...(d.fw_id && /^[0-9a-f]{8,64}$/.test(d.fw_id) ? { fw_id: d.fw_id } : {}),
        ...(rec?.ident?.size ? { ident_offset: rec.ident.offset, ident_size: rec.ident.size } : {}),
        ...(typeof named.name === 'string' ? { network: named.name } : {}),
        alias: d.alias,
        addr: d.addr,
        net: d.net,
        alias_rev: Math.max(d.alias_rev, 1),
        epoch_floor: ((d.last_epoch ?? 0) + 1) & 0xffff || 1,
      },
      { fetch: deps.fetch },
    ),
  );
  if (!answer.success || answer.data.device_id !== d.device_id || answer.data.addr !== d.addr || answer.data.net !== d.net) {
    throw new FrError('HUB_VERSION_MISMATCH', `the hub at ${base} answered device_enroll with another identity than the one ${d.alias} has`, {
      hint: 'both hubs must run the same version',
      details: { with_hub: base, ...(answer.success ? { answered: { addr: answer.data.addr, net: answer.data.net } } : { issues: answer.error.issues }) },
    });
  }
  noteSharedWith(hub.db, d.device_id, base);
  const warnings: string[] = [];
  if (answer.data.adopt === 'needs_flash') {
    warnings.push(`${d.alias} is connected to the hub at ${base} under another identity, and it is an ESP32: its fr_ident keeps that identity until it is flashed with this one`);
  }
  return {
    device_id: d.device_id,
    alias: d.alias,
    addr: d.addr,
    net: d.net,
    with_hub: base,
    hub_host: answer.data.hub_host,
    hub_ip: answer.data.hub_ip,
    ...(answer.data.adopt ? { adopt: answer.data.adopt } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

function band(v: unknown): NetworkBand {
  return (NETWORK_BANDS as readonly unknown[]).includes(v) ? (v as NetworkBand) : 'auto';
}

export async function join(hub: HubContext, input: { hub: string; force?: boolean }, deps: ShareDeps = {}) {
  const base = hubBase(input.hub);
  notSelf(hub, base, 'name the hub whose network this hub joins');
  const nets = (await remoteNetworks(base, deps)).filter((n): n is RemoteNetwork & { net_id: number; ssid: string } => typeof n.net_id === 'number' && typeof n.ssid === 'string');
  if (!nets.length) {
    throw new FrError('ENV_MISSING', `the hub at ${base} has no network stored: there is nothing to join`, {
      hint: 'on that hub: fr net set --ssid <ssid> --password-stdin',
      details: { hub: base },
    });
  }
  const theirs = nets.find((n) => n.name === DEFAULT_NETWORK) ?? nets[0];
  const netId = theirs.net_id;
  const previous = fleetNetId(hub.db);
  // Boards whose fr_ident (or identity file) carries this hub's own net id: after the join their HELLO is another
  // network's. An ESP32 keeps its identity in flash; a Linux node takes a new one over the air while it is connected.
  const foreign = registryOf(hub)
    .list()
    .filter((d) => d.provisioned && d.net !== null && d.net !== netId)
    .map((d) => ({
      device_id: d.device_id,
      alias: d.alias,
      chip: d.chip,
      fix: d.chip
        ? `an ESP32: flash it at a hub that has its USB port, for this network (fr devices provision --port <port> --for-hub <this hub's API>)`
        : `no ESP32 chip on record (a Linux node): give it a new identity while it is still connected here, after the join: fr devices adopt ${d.alias} (this hub asks the registrar for its address over the hubs' link)`,
    }));
  if (foreign.length && !input.force) {
    throw new FrError('INVALID_ARGS', `${foreign.length} board${foreign.length === 1 ? ' is' : 's are'} provisioned here under this hub's own net id (${String(previous)}): ${foreign.map((f) => f.alias).join(', ')}. In the joined network (net id ${netId}) their identity is foreign and this hub no longer takes their HELLO`, {
      hint: 'join with --force when that is meant; each board then needs a new identity (the answer says how). To keep the boards as they are, let the other hub join this one instead',
      details: { hub: base, net: netId, previous_net: previous, foreign },
    });
  }
  // The registrar admits this hub before anything changes here: a registrar from before the hubs' link (no
  // network_admit), a name another hub has or a network that is full leaves this hub as it was.
  const admission = await requestAdmission(hub, base, { fetch: deps.fetch });
  if (admission.admitted.net_id !== netId) {
    throw new FrError('HUB_VERSION_MISMATCH', `the hub at ${base} admitted this hub to net id ${admission.admitted.net_id}, but its stored network says ${netId}`, { hint: 'both hubs must run the same version', details: { hub: base } });
  }
  hub.db.transaction(() => {
    joinNetwork(
      hub.db,
      netId,
      { url: base, hub_host: typeof theirs.hub_host === 'string' ? theirs.hub_host : null },
      { name: typeof theirs.name === 'string' ? theirs.name : DEFAULT_NETWORK, ssid: theirs.ssid, country: typeof theirs.country === 'string' ? theirs.country : null, band: band(theirs.band) },
    );
    // The key into secrets.json, the name, slot and member list into hub.db.
    storeAdmission(hub, admission);
  })();
  if (hub.router instanceof HubRouter) {
    hub.router.refreshNet(); // the next HELLO is judged by the joined net id
  }
  await hub.peers?.refresh(); // the link to the other hubs, with the key just stored
  // Two hubs count their runs apart, and a board that moves between them must not meet one epoch at both: each hub
  // counts inside its own slot (db.ts slotEpoch), from its next start on. Said when this run is not in its slot yet.
  const warnings: string[] = [];
  const outside = slotWarning(hub, admission.admitted.hub.slot);
  if (outside) {
    warnings.push(outside);
  }
  const pw = passwordNames();
  const registrar = registrarOf(hub.db);
  return {
    net_id: netId,
    previous_net_id: previous,
    registrar: base,
    networks: listNetworks(hub.db).map((n) => ({
      name: n.name,
      ssid: n.ssid,
      bssid: n.bssid,
      country: n.country,
      band: n.band,
      net_id: n.net_id,
      hub_host: n.hub_host,
      password_set: pw.has(n.name),
      devices: networkDevices(hub.db, n.name),
      registrar: registrar?.url ?? null,
    })),
    foreign,
    // Never the key: only what the network knows this hub as, and the hubs of the network.
    hub: hubIdentity(hub.db),
    members: admission.admitted.members.map(publicMember),
    ...(warnings.length ? { warnings } : {}),
  };
}
