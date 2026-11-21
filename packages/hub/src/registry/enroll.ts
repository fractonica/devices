// device_enroll (spec 06 §6.4 "For another hub"): the registry half of a provisioning whose flash another hub does.
// A hub without USB ports or builds (the home hub on a UNO Q) gets its ESP32 boards flashed at a hub that has them
// (device_provision `for_hub` there, registry/provision.ts), which calls this op here before it writes anything.
// The row is prepared exactly as a provision here would (prepareIdentity: addr, alias, net, epoch_floor) and marked
// provisioned as a finished fr_ident write is (markIdentWritten), with the tag `new` when the device was not
// provisioned here before: the hub's own screen lists such devices as waiting to be named and accepted
// (device_update --tag -new). The answer is what the flashing hub writes into fr_ident, minus the Wi-Fi: that hub takes
// SSID, password, country and band from its own stored network, so this one needs no password and never reads,
// returns or logs one.
//
// With an explicit identity (addr, net and alias; design multi-hub-m1) it is how one hub of a network gives another
// the row of a board that already exists: device_share, and a `for_hub` provisioning for a hub of the same network.
// The row then holds exactly that identity (enrollShared): nothing is allocated, the net must be this hub's, no other
// device here may hold the addr, and the device is not tagged `new`. A Linux node that is connected here under
// another identity (this hub's own node after the hub joined the network) is given the new one as device_adopt gives
// one (MSG fr.adopt) and restarts with it; an ESP32 keeps what its fr_ident says until it is flashed.

import { DEFAULT_NETWORK, type Enrolled, FrError } from '@fractonica/protocol';

import { ADOPT_TOPIC } from '../app-host/adopt.ts';
import type { HubContext } from '../context.ts';
import { listNetworks, readNetwork, registrarOf } from '../network.ts';
import { nowUs } from '../ring.ts';
import { routerInfo } from '../router/index.ts';
import { ensureAddress } from './alloc.ts';
import { registryOf } from './hub.ts';
import { hubIpv4 } from './ident.ts';
import { checkAlias } from './names.ts';
import { markIdentWritten, prepareIdentity, provisionOf, storeSharedIdentity } from './store.ts';

/** HELLO `chip` of a node that is no ESP32 (fr_posix kChipLinux). */
const CHIP_LINUX = 0xff;

export interface EnrollInput {
  device_id: string;
  /** Required without an explicit identity. */
  chip?: string;
  profile?: string;
  board?: string;
  part_profile?: string;
  build_id?: string;
  fw_id?: string;
  /** Where the firmware's layout keeps fr_ident, for the record (flash_start --plan identity reads it). */
  ident_offset?: number;
  ident_size?: number;
  alias?: string;
  network?: string;
  /** The explicit identity (design multi-hub-m1): addr, net and alias together; alias_rev and epoch_floor default 1. */
  addr?: number;
  net?: number;
  alias_rev?: number;
  epoch_floor?: number;
}

/** A factory MAC as a device id: 12 hex digits, not all zeros or ones, and a unicast address. */
export function checkDeviceId(text: string): string {
  const id = text.toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(id) || /^(0{12}|f{12})$/.test(id) || parseInt(id.slice(0, 2), 16) & 1) {
    throw new FrError('INVALID_ARGS', `${JSON.stringify(text)} is not a device id: a board's factory MAC as 12 hex digits`, { hint: 'e.g. a0b1c2d3e4f5' });
  }
  return id;
}

type EnrollHub = Pick<HubContext, 'db' | 'events'> & Partial<Pick<HubContext, 'registry' | 'router' | 'broadcast' | 'peers'>>;

/**
 * device_enroll: with addr or net the explicit identity (enrollShared), else a new enrollment (enroll). A member of a
 * network first gets the board's address from the registrar over the hubs' link (design multi-hub-m2 §5; alloc.ts),
 * then enrolls it as the registrar itself would; with the registrar away it refuses and says so.
 */
export async function enrollOp(hub: EnrollHub, input: EnrollInput): Promise<Enrolled> {
  if (input.addr !== undefined || input.net !== undefined) {
    return enrollShared(hub, input);
  }
  if (registrarOf(hub.db) && typeof input.device_id === 'string' && /^[0-9a-fA-F]{12}$/.test(input.device_id)) {
    const deviceId = input.device_id.toLowerCase();
    const known = registryOf(hub).get(deviceId);
    const net = readNetwork(hub.db, input.network ?? known?.network ?? DEFAULT_NETWORK);
    // What enroll() refuses anyway (no chip and profile, no network) is refused there, before the registrar is asked.
    const complete = (input.chip !== undefined && input.profile !== undefined) || (input.alias !== undefined && input.chip === undefined);
    if (net && complete && input.alias_rev === undefined && input.epoch_floor === undefined) {
      await ensureAddress(hub, {
        device_id: deviceId,
        ...(input.alias !== undefined ? { alias: checkAlias(input.alias) } : {}),
        profile: input.profile ?? null,
        board: input.board ?? null,
        chip: input.chip ?? null,
        net: net.net_id,
        network: net.name,
      });
    }
  }
  return enroll(hub, input);
}

/**
 * The row of a board that exists in this hub's network already, as another hub of it holds it. Idempotent: the same
 * identity again changes nothing.
 */
export async function enrollShared(hub: EnrollHub, input: EnrollInput): Promise<Enrolled> {
  const deviceId = checkDeviceId(input.device_id);
  if (input.addr === undefined || input.net === undefined || input.alias === undefined) {
    throw new FrError('INVALID_ARGS', 'an explicit identity is addr, net and alias together', { hint: 'leave all three out to enroll a new board (this hub then gives it an addr)' });
  }
  if ((input.ident_offset === undefined) !== (input.ident_size === undefined)) {
    throw new FrError('INVALID_ARGS', 'give ident_offset and ident_size together, or neither');
  }
  const alias = checkAlias(input.alias);
  const known = registryOf(hub).get(deviceId);
  const name = input.network ?? known?.network ?? DEFAULT_NETWORK;
  const net = readNetwork(hub.db, name);
  if (!net || net.net_id !== input.net) {
    throw new FrError('INVALID_ARGS', net ? `this hub's network ${name} has net id ${net.net_id}, not ${input.net}: the board belongs to another network` : `this hub has no network ${name} stored, so it is in no network a board could be shared into`, {
      hint: 'a board keeps one identity in one network: make this hub a member of the network the board is in (fr net join --hub <that network\'s hub>), then share the board again',
      details: { net: input.net, ...(net ? { this_net: net.net_id } : {}) },
    });
  }
  const wasProvisioned = known?.provisioned === true;
  const before = provisionOf(hub.db, deviceId);
  const prep = storeSharedIdentity(hub.db, {
    deviceId,
    addr: input.addr,
    net: input.net,
    alias,
    alias_rev: input.alias_rev ?? 1,
    epoch_floor: input.epoch_floor ?? 1,
    profile: input.profile ?? null,
    board: input.board ?? null,
    chip: input.chip ?? null,
    network: net.name,
  });
  const d = prep.device;
  // The record of the same identity is kept as it is (its time and what it says of the flash): a repeated share
  // then changes nothing.
  const same = wasProvisioned && before?.addr === d.addr && before?.net === d.net && before?.alias === d.alias && before?.alias_rev === d.alias_rev;
  const done = same
    ? d
    : markIdentWritten(
        hub.db,
        deviceId,
        {
          at: new Date().toISOString(),
          via: 'provision',
          build_id: input.build_id ?? before?.build_id ?? null,
          fw_id: input.fw_id ?? null,
          profile: input.profile ?? d.profile,
          board: input.board ?? d.board,
          part_profile: input.part_profile ?? before?.part_profile ?? null,
          ident: { offset: input.ident_offset ?? before?.ident?.offset ?? 0, size: input.ident_size ?? before?.ident?.size ?? 0 },
          addr: d.addr!,
          alias: d.alias,
          alias_rev: d.alias_rev,
          epoch_floor: prep.epoch_floor,
          net: d.net!,
          hub_host: net.hub_host,
          ssid: net.ssid,
          network: net.name,
          prov_ts: Math.floor(Date.now() / 1000),
          enrolled: true,
        },
        { keepHubs: true },
      );
  if (!same) {
    hub.events.publish({
      type: 'device.provisioned',
      device: deviceId,
      alias: done.alias,
      t_hub_us: nowUs(),
      fields: { addr: done.addr, net: done.net, alias_rev: done.alias_rev, build_id: input.build_id ?? null, fw_id: input.fw_id ?? null, enrolled: true, shared: true },
    });
  }
  // A device connected here right now under another identity: a Linux node takes the new one over its session.
  let adopt: 'pushed' | 'needs_flash' | undefined;
  const live = routerInfo(hub.router, deviceId);
  if (live && (live.presence === 'online' || live.presence === 'suspect') && live.links.length && (live.addr !== d.addr || live.net !== d.net)) {
    if (live.chip_id === CHIP_LINUX && hub.broadcast) {
      const data = new TextEncoder().encode(JSON.stringify({ addr: d.addr, net: d.net, alias: d.alias, alias_rev: d.alias_rev, epoch_floor: prep.epoch_floor }));
      const sent = await hub.broadcast.sendMsg(deviceId, ADOPT_TOPIC, data, { timeoutMs: 3000 });
      if (sent.status !== 0) {
        throw new FrError('DELIVERY_FAILED', `${d.alias} has its row here now, but did not take the identity over its session (status ${sent.status}); share it again while it is connected`);
      }
      adopt = 'pushed';
    } else {
      adopt = 'needs_flash';
    }
  }
  return {
    device_id: deviceId,
    addr: done.addr!,
    net: done.net!,
    alias: done.alias,
    alias_rev: done.alias_rev,
    epoch_floor: prep.epoch_floor,
    hub_host: net.hub_host,
    hub_ip: hubIpv4(),
    network: net.name,
    new: !wasProvisioned,
    tags: done.tags,
    ...(adopt ? { adopt } : {}),
  };
}

export function enroll(hub: EnrollHub, input: EnrollInput): Enrolled {
  const deviceId = checkDeviceId(input.device_id);
  const alias = input.alias === undefined ? undefined : checkAlias(input.alias);
  // A board being flashed has a chip and a profile. A node without an ESP32 chip (a Linux node that is to get its
  // address from this hub, the registrar, while it is connected to another hub of the network) is named by a person.
  if ((input.chip === undefined || input.profile === undefined) && (alias === undefined || input.chip !== undefined)) {
    throw new FrError('INVALID_ARGS', 'chip and profile are required to enroll a new board', {
      hint: 'a node without an ESP32 chip (a Linux node) is enrolled with --alias and no chip; with an explicit identity (addr, net and alias) neither is needed',
    });
  }
  if (input.alias_rev !== undefined || input.epoch_floor !== undefined) {
    throw new FrError('INVALID_ARGS', 'alias_rev and epoch_floor go with an explicit identity (addr, net and alias)');
  }
  if ((input.ident_offset === undefined) !== (input.ident_size === undefined)) {
    throw new FrError('INVALID_ARGS', 'give ident_offset and ident_size together, or neither');
  }
  const known = registryOf(hub).get(deviceId);
  const name = input.network ?? known?.network ?? DEFAULT_NETWORK;
  const net = readNetwork(hub.db, name);
  if (!net) {
    const stored = listNetworks(hub.db).map((n) => n.name);
    throw new FrError(
      stored.length ? 'NOT_FOUND' : 'ENV_MISSING',
      stored.length ? `no network ${name} is stored (stored: ${stored.join(', ')})` : 'no network is stored: its id is the net the board joins, and its hub host is where the board connects',
      {
        hint: 'fr net set --ssid <your Wi-Fi> (the password is not needed on this hub: the hub that flashes the board has it)',
        remediation: [{ tool: 'network_set', args: { name }, cli: `fr net set${name === DEFAULT_NETWORK ? '' : ` --name ${name}`} --ssid <ssid>` }],
      },
    );
  }
  const wasProvisioned = known?.provisioned === true;
  // The same upsert a provision here does (06 §6.4 step 4): a known board keeps its addr and alias, a new one gets the
  // next addr and `<profile>-<short id>` (or the alias asked for, refused when another device holds it).
  const prep = prepareIdentity(hub.db, {
    deviceId,
    alias,
    profile: input.profile ?? null,
    board: input.board ?? null,
    chip: input.chip ?? null,
    net: net.net_id,
    network: net.name,
  });
  const d = prep.device;
  const done = markIdentWritten(
    hub.db,
    deviceId,
    {
      at: new Date().toISOString(),
      via: 'provision',
      build_id: input.build_id ?? null,
      fw_id: input.fw_id ?? null,
      profile: input.profile ?? null,
      board: input.board ?? d.board,
      part_profile: input.part_profile ?? null,
      // Size 0 when the flashing hub did not say: no region is known here (flashing.ts takes it for none).
      ident: { offset: input.ident_offset ?? 0, size: input.ident_size ?? 0 },
      addr: d.addr!,
      alias: d.alias,
      alias_rev: d.alias_rev,
      epoch_floor: prep.epoch_floor,
      net: d.net!,
      hub_host: net.hub_host,
      // This hub's record of the network; the Wi-Fi the board is given is the flashing hub's.
      ssid: net.ssid,
      network: net.name,
      prov_ts: Math.floor(Date.now() / 1000),
      enrolled: true,
    },
    { tagNew: true },
  );
  hub.events.publish({
    type: 'device.provisioned',
    device: deviceId,
    alias: done.alias,
    t_hub_us: nowUs(),
    fields: { addr: done.addr, net: done.net, alias_rev: done.alias_rev, build_id: input.build_id ?? null, fw_id: input.fw_id ?? null, enrolled: true },
  });
  return {
    device_id: deviceId,
    addr: done.addr!,
    net: done.net!,
    alias: done.alias,
    alias_rev: done.alias_rev,
    epoch_floor: prep.epoch_floor,
    hub_host: net.hub_host,
    hub_ip: hubIpv4(),
    network: net.name,
    new: !wasProvisioned,
    tags: done.tags,
  };
}
