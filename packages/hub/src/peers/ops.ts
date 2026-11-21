// Op handlers of the hubs' link (packages/protocol/src/ops/peers.ts; design multi-hub-m2 step 2.1), spread into
// HANDLERS (packages/hub/src/ops.ts): network_admit (the registrar's half of a join), hub_name_set and hub_peers.

import { FrError, type PeerOpName } from '@fractonica/protocol';

import type { Handler, HubContext } from '../context.ts';
import { fleetNetId, registrarOf } from '../network.ts';
import { type AdmitInput, admit, requestAdmission, storeAdmission } from './admission.ts';
import { hubIdentity, setHubName } from './identity.ts';
import { ownClaim, peersView } from './index.ts';
import { readNetworkKey } from './key.ts';
import { bumpMembers, listMembers, putRegistrar } from './members.ts';

/**
 * hub_name_set: a hub that is alone stores the name for its next join; the registrar changes its own row and tells
 * the members; a member asks the registrar (its API, as at the join), which refuses a name another hub has.
 */
async function nameSet(hub: HubContext, input: { name: string }) {
  const before = hubIdentity(hub.db);
  if (input.name === before.name) {
    return { hub: before, previous: before.name };
  }
  const registrar = registrarOf(hub.db);
  const keyed = readNetworkKey(fleetNetId(hub.db)) !== null && listMembers(hub.db).length > 0;
  if (!keyed) {
    setHubName(hub.db, input.name);
  } else if (!registrar) {
    const taken = listMembers(hub.db).find((m) => m.name === input.name && m.id !== before.id);
    if (taken) {
      throw new FrError('INVALID_ARGS', `the network already has a hub named ${input.name} (${taken.id}): a hub's name is unique in its network`, { hint: 'choose another name' });
    }
    const claim = await ownClaim(hub);
    hub.db.transaction(() => {
      setHubName(hub.db, input.name);
      if (putRegistrar(hub.db, { ...claim, name: input.name })) {
        bumpMembers(hub.db);
      }
    })();
    await hub.peers?.refresh();
  } else {
    // The registrar keeps the list: it is asked as at the join, and what it answers is stored (the same key again).
    let admission;
    try {
      admission = await requestAdmission(hub, registrar.url, { name: input.name });
    } catch (e) {
      if (e instanceof FrError && (e.code === 'HUB_UNREACHABLE' || e.code === 'TIMEOUT')) {
        throw new FrError(e.code, `${e.message}: a member's name is changed at its network's registrar, which was not reached, so this hub is still ${before.name}`, { hint: e.hint, details: e.details });
      }
      throw e;
    }
    storeAdmission(hub, admission);
    await hub.peers?.refresh();
  }
  return { hub: hubIdentity(hub.db), previous: before.name };
}

export const PEER_HANDLERS: Record<PeerOpName, Handler> = {
  network_admit: (input: AdmitInput, hub: HubContext) => admit(hub, input),
  hub_name_set: (input: { name: string }, hub: HubContext) => nameSet(hub, input),
  hub_peers: (_input: unknown, hub: HubContext) => peersView(hub),
};
