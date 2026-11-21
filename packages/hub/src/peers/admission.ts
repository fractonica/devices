// Admission (design multi-hub-m2 §3.1, §4, §9): how a hub comes to hold its network's key, a name in the network and
// an epoch slot.
//   - `admit` is the registrar's half (op network_admit). The registrar makes the key the first time a hub asks
//     (32 random bytes into secrets.json) and takes slot 0 itself; the joining hub gets its name as asked (refused when
//     another hub has it), the lowest free slot of 1 to 3 (a fifth hub is refused) and the member list, and the other
//     members are told over the link. The key leaves only sealed to the public key the caller sent (key.ts).
//   - `requestAdmission` is the joining hub's half, inside network_join and hub_name_set: a key pair for the one call,
//     the registrar's network_admit over its API (remote.ts, the same way network_join already calls it), the sealed
//     key opened. `storeAdmission` then writes the key to secrets.json and the rest to hub.db.
// Nothing here logs, returns or throws the key or anything made from it: errors name hubs, names and slots.
// The call goes over the registrar's API, so the first contact between two hubs still needs loopback access to both
// (one SSH tunnel, once); everything after it goes over the link.

import { type Admitted, AdmittedSchema, FrError } from '@fractonica/protocol';

import type { HubContext } from '../context.ts';
import { epochInSlot, runInSlot, EPOCH_SLOT_SIZE, HUB_SLOT_KEY, hubSlot, kvSet } from '../db.ts';
import { fleetNetId, registrarOf } from '../network.ts';
import { type Fetch, remoteOp } from '../registry/remote.ts';
import { hubIdentity, setHubName } from './identity.ts';
import { ownClaim } from './index.ts';
import { admissionKeys, newNetworkKey, openSealed, readNetworkKey, sealKey, writeNetworkKey } from './key.ts';
import { admitMember, bumpMembers, listMembers, membersVersion, publicMember, putRegistrar, replaceMembers } from './members.ts';

export interface AdmitInput {
  hub_id: string;
  name: string;
  host: string;
  addr?: string;
  link_port: number;
  public_key: string;
}

/** network_admit, on the registrar. */
export async function admit(hub: HubContext, input: AdmitInput): Promise<Admitted> {
  const registrar = registrarOf(hub.db);
  if (registrar) {
    const who = registrar.hub_host ? `${registrar.hub_host} (${registrar.url})` : registrar.url;
    throw new FrError('INVALID_ARGS', `this hub is a member of the network of ${who}: only that hub, the network's registrar, admits a hub`, {
      hint: `join the registrar instead: fr net join --hub <the API of ${registrar.hub_host ?? 'that hub'}>`,
      details: { registrar: registrar.url, registrar_host: registrar.hub_host, net: registrar.net_id },
    });
  }
  const net = fleetNetId(hub.db);
  if (net === null) {
    throw new FrError('ENV_MISSING', 'this hub has no network stored: there is nothing to join', { hint: 'fr net set --ssid <ssid> --password-stdin' });
  }
  const me = hubIdentity(hub.db);
  if (input.hub_id === me.id) {
    throw new FrError('INVALID_ARGS', `hub ${me.id} is this hub itself`, { hint: 'name the hub whose network this hub joins' });
  }
  // The key first: a hub that could not store it must admit nobody.
  let key = readNetworkKey(net);
  if (!key) {
    key = newNetworkKey();
    writeNetworkKey(net, key);
  }
  const self = await ownClaim(hub);
  let changed = false;
  let member: ReturnType<typeof admitMember>['member'];
  const tx = hub.db.transaction(() => {
    changed = putRegistrar(hub.db, self);
    const r = admitMember(hub.db, { id: input.hub_id, name: input.name, host: input.host, addr: input.addr ?? null, link_port: input.link_port });
    member = r.member;
    changed ||= r.changed;
    if (changed || !membersVersion(hub.db)) {
      bumpMembers(hub.db);
    }
    if (hubSlot(hub.db) !== 0) {
      kvSet(hub.db, HUB_SLOT_KEY, '0'); // the registrar's own slot, from its next start on (db.ts nextHubEpoch)
    }
  });
  tx();
  const sealed = sealKey(key, input.public_key, net, input.hub_id);
  // The link starts (the first admission) or follows the list, and the other members hear of the new one.
  await hub.peers?.refresh();
  return {
    net_id: net,
    hub: { id: member!.id, name: member!.name, slot: member!.slot },
    registrar: { id: me.id, name: self.name },
    members: listMembers(hub.db).map(publicMember),
    members_version: membersVersion(hub.db),
    sealed,
  };
}

/** What a joining hub holds after the registrar admitted it; `key` goes to secrets.json and nowhere else. */
export interface Admission {
  key: Buffer;
  admitted: Admitted;
}

/**
 * Asks the registrar at `base` to admit this hub under `name` (default: the name it has). HUB_VERSION_MISMATCH when
 * that hub does not know network_admit (it runs a version from before the hubs' link) or answers something else than
 * an admission; its own refusal (a name taken, four hubs already) otherwise.
 */
export async function requestAdmission(hub: HubContext, base: string, opts: { name?: string; fetch?: Fetch } = {}): Promise<Admission> {
  const claim = await ownClaim(hub);
  const keys = admissionKeys();
  let answer: unknown;
  try {
    answer = await remoteOp(
      base,
      'network_admit',
      { hub_id: claim.id, name: opts.name ?? claim.name, host: claim.host, ...(claim.addr ? { addr: claim.addr } : {}), link_port: claim.link_port, public_key: keys.publicKey },
      { fetch: opts.fetch },
    );
  } catch (e) {
    // The listener was bound to tell the registrar a port; a hub that still holds no key has no use for it.
    await hub.peers?.refresh().catch(() => undefined);
    if (e instanceof FrError && e.code === 'HUB_VERSION_MISMATCH') {
      throw new FrError('HUB_VERSION_MISMATCH', `the hub at ${base} does not know network_admit: it runs a version from before the hubs' link, so it cannot give this hub the network key, a name or an epoch slot`, {
        hint: 'update that hub to this checkout and restart it (fr hub restart there), then join again; nothing was changed here',
        details: e.details,
      });
    }
    // The registrar's refusal of the name, said as this hub's to fix (remoteOp words a hint as the other hub's).
    const theirs = (e instanceof FrError ? (e.details?.error as { details?: { name?: unknown; held_by?: unknown } } | undefined)?.details : undefined) ?? {};
    if (e instanceof FrError && e.code === 'INVALID_ARGS' && typeof theirs.name === 'string' && typeof theirs.held_by === 'string') {
      throw new FrError('INVALID_ARGS', `the network of the hub at ${base} already has a hub named ${theirs.name} (${theirs.held_by}): a hub's name is unique in its network`, {
        hint: 'give this hub another name, then join again: fr hub name <name>',
        remediation: [{ tool: 'hub_name_set', cli: 'fr hub name <name>' }],
        details: { hub: base, name: theirs.name, held_by: theirs.held_by },
      });
    }
    throw e;
  }
  const parsed = AdmittedSchema.safeParse(answer);
  if (!parsed.success || parsed.data.hub.id !== claim.id) {
    throw new FrError('HUB_VERSION_MISMATCH', `the hub at ${base} answered network_admit with something that is not an admission of this hub`, {
      hint: 'both hubs must run the same version',
      details: { hub: base, ...(parsed.success ? {} : { issues: parsed.error.issues.map((i) => ({ path: i.path, code: i.code })) }) },
    });
  }
  const admitted = parsed.data;
  return { key: openSealed(admitted.sealed, keys, admitted.net_id, claim.id), admitted };
}

/**
 * Stores an admission: the key in secrets.json; this hub's name and slot and the member list in hub.db. The caller
 * runs it inside its own transaction when it changes more (network_join's net id and registrar).
 */
export function storeAdmission(hub: HubContext, a: Admission): void {
  writeNetworkKey(a.admitted.net_id, a.key);
  hub.db.transaction(() => {
    setHubName(hub.db, a.admitted.hub.name);
    kvSet(hub.db, HUB_SLOT_KEY, String(a.admitted.hub.slot));
    replaceMembers(hub.db, a.admitted.members.map(publicMember), a.admitted.members_version);
  })();
}

/** What a hub is told when the epoch it runs under is not one of its slot: it moves there at its next start. */
export function slotWarning(hub: Pick<HubContext, 'hubEpoch'> & Partial<Pick<HubContext, 'logs'>>, slot: number): string | null {
  if (epochInSlot(hub.hubEpoch, slot)) {
    // Its cursors carry its slot from its next start too (db.ts nextHubRun, design multi-hub-m2 §17).
    return hub.logs && !runInSlot(hub.logs.run, slot)
      ? `this hub run's cursors (run ${hub.logs.run}) do not carry the slot the registrar gave it (slot ${slot}) yet, so another hub may take one for the registrar's: restart this hub (fr hub restart)`
      : null;
  }
  return `this hub run's epoch (${hub.hubEpoch}) is outside the epoch slot the registrar gave it (slot ${slot}: ${slot * EPOCH_SLOT_SIZE + 1}..${(slot + 1) * EPOCH_SLOT_SIZE - 1}): restart this hub (fr hub restart) before boards use both hubs, so a board never takes the two for one hub run`;
}
