// Op handlers of the registry and provisioning (packages/protocol/src/ops/registry.ts; stream H1),
// spread into HANDLERS (packages/hub/src/ops.ts). flash_start's handler is flashing.ts (startFlash);
// device_enroll's is enroll.ts.
// M2-C2 (design m2-c2 D16): device_list rows carry `live`, what a dashboard tile shows of the device's link, so
// 30 tiles render from one device_list instead of a device_get each (each O(N) to resolve).

import { FrError, type MultiHubOpName, type PortInfo, type RegistryOpName } from '@fractonica/protocol';

import type { Device, Handler, HubContext } from '../context.ts';
import { netPresence, presenceView } from '../peers/index.ts';
import { nowUs } from '../ring.ts';
import { routerInfo, routerSummary } from '../router/index.ts';
import { presenceOf, registryOf, resolveOne } from './hub.ts';
import { enrollOp, type EnrollInput } from './enroll.ts';
import { hubNow, hubsGet, hubsSet } from './hubs.ts';
import { join, share } from './share.ts';
import { editTags } from './names.ts';
import { startProvision } from './provision.ts';
import { provisionOf } from './store.ts';
import { rowStamps } from './sync.ts';

/** List budget (spec 09 §9.2): 100 rows. */
const LIST_MAX = 100;

/**
 * A registry row as ops return it: plus presence, `at` and, when attached, the USB port (`ports`: one port listing for
 * many rows). `presence` covers the network (design multi-hub-m2 §6; peers presenceView): `online` when this hub or a
 * reachable peer holds the board's session, `unknown` with `presence_reason` when the hub that last held it is away.
 * `at` names the hub that holds the session (or last did), null when no hub this hub can see does.
 */
function view(hub: HubContext, d: Device, ports: PortInfo[] = hub.serial.list()) {
  const port = ports.find((p) => p.device_id === d.device_id);
  return { ...d, ...presenceView(hub, d.device_id), ...(port ? { port: port.path, port_state: port.state } : {}) };
}

export const REGISTRY_HANDLERS: Record<RegistryOpName | MultiHubOpName, Handler> = {
  device_list: (input: { selector?: string }, hub: HubContext) => {
    // `online` and `offline` in the selector mean what the rows show: the network's presence.
    const found = registryOf(hub).resolve(input.selector ?? 'all', netPresence(hub));
    const ports = hub.serial.list();
    return {
      // `live`: links (best first), udp_blocked, the last heartbeat's RSSI and uptime, the firmware prefix; null
      // before the device's first HELLO in this hub run.
      devices: found.slice(0, LIST_MAX).map((d) => ({ ...view(hub, d, ports), live: routerSummary(hub.router, d.device_id) })),
      count: found.length,
      truncated: found.length > LIST_MAX,
    };
  },

  device_get: (input: { device: string }, hub: HubContext) => {
    const d = resolveOne(hub, input.device);
    // `router`: what this hub run knows of it (links, clock offset, heartbeat, property mirror); null
    // before its first HELLO.
    // `hubs`: its hub list as this hub recorded it; `hub_now`: whether it is on this hub (design multi-hub-m1).
    // `replication`: the row's rev and the hub that wrote it (design multi-hub-m2 §5), null for a row that is this hub's
    // own (a board seen only, one of another net id), which no other hub holds.
    const stamps = rowStamps(hub.db, d.device_id);
    return {
      ...view(hub, d),
      provision: provisionOf(hub.db, d.device_id),
      router: routerInfo(hub.router, d.device_id),
      hub_now: hubNow(hub, d),
      replication: stamps && !stamps.gone ? { row_rev: stamps.row_rev, row_hub: stamps.row_hub } : null,
    };
  },

  device_update: (input: { device: string; alias?: string; tag?: string }, hub: HubContext) => {
    if (input.alias === undefined && input.tag === undefined) {
      throw new FrError('INVALID_ARGS', 'nothing to change: give --alias and/or --tag');
    }
    const before = resolveOne(hub, input.device);
    const tags = input.tag === undefined ? undefined : editTags(before.tags, input.tag);
    const after = registryOf(hub).update(before.device_id, { ...(input.alias !== undefined ? { alias: input.alias } : {}), ...(tags ? { tags } : {}) });
    const renamed = after.alias_rev !== before.alias_rev;
    if (renamed) {
      // 06 §6.3 renames: the registry wins. An online node gets fr.node.set_alias now; the router
      // compares alias and rev on every HELLO and re-sends to one that missed it.
      hub.router.pushAlias(after.device_id);
      hub.events.publish({
        type: 'registry.drift',
        device: after.device_id,
        alias: after.alias,
        t_hub_us: nowUs(),
        fields: { alias: after.alias, alias_rev: after.alias_rev, previous_alias: before.alias },
      });
    }
    const v = view(hub, after);
    return { ...v, ...(renamed ? { previous_alias: before.alias, alias_pushed: v.presence === 'online' || v.presence === 'suspect' } : {}) };
  },

  // Design csi-c1 D5: onto the named network (default: the registry row's, else default); a 5g one only for a 5 GHz chip.
  // `for_hub` (06 §6.4 "For another hub"): the board is registered on that hub (its device_enroll) and connects there.
  device_provision: (input: { port: string; profile?: string; build?: string; alias?: string; network?: string; for_hub?: string; wait_s?: number }, hub: HubContext) =>
    startProvision(input, hub),

  // The other half of a `for_hub` provisioning, on the hub the board will belong to: never a Wi-Fi credential.
  // With addr, net and alias: the row of a board another hub of this network has (design multi-hub-m1).
  device_enroll: (input: EnrollInput, hub: HubContext) => enrollOp(hub, input),

  // Design multi-hub-m1: a board's ordered hub list, a row for another hub of the network, joining a network.
  device_hubs_set: (input: { device: string; hub?: string[]; none?: boolean }, hub: HubContext) => hubsSet(hub, input),
  device_hubs_get: (input: { device: string }, hub: HubContext) => hubsGet(hub, input),
  device_share: (input: { device: string; with_hub: string }, hub: HubContext) => share(hub, input),
  network_join: (input: { hub: string; force?: boolean }, hub: HubContext) => join(hub, input),
};
