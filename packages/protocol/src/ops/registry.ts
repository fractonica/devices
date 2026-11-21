// Registry and provisioning ops (design c3 §4, spec 09 §9.4; stream H1): device_list, device_get,
// device_update, device_provision. Spread into OPS (packages/protocol/src/ops.ts); handlers in
// packages/hub/src/registry/ops.ts. flash_start, which also writes fr_ident from the registry, stays
// in ops.ts with the other flash ops. C6 adds INVENTORY_OPS (board_list, profile_list, capability_list;
// design c6 D14, stream S2) at the end.
// A board flashed at one hub for another (06 §6.4 "For another hub"): device_provision takes `for_hub`, the other
// hub's API, and calls that hub's device_enroll, which registers the board there and answers the identity to write.
// One network, several hubs (design multi-hub-m1): network_join makes this hub a member of another hub's network (that
// hub, the registrar, hands out the addresses), device_share gives a member hub the row of a board (device_enroll with
// the identity the board has), device_hubs_set and device_hubs_get set and read a board's ordered hub list.
// Since the registry is one (design multi-hub-m2 §5, step 2.3) every hub of a network holds every row: device_share
// toward a hub that replicates does nothing, and a member's device_enroll and device_provision get a new board's
// address from the registrar over the hubs' link. No input changed for it.

import { z } from 'zod';

import { DeviceHubSchema, DeviceViewSchema, PRESENCES } from '../types.ts';
import { deviceSel, op, portSel, waitS } from './common.ts';
import { networkName, NetworkSchema } from './network.ts';
import { HubIdentitySchema, HubMemberSchema } from './peers.ts';

export { deviceSel } from './common.ts';

/** The 09 §9.2 selector grammar, as agents read it in a field description, with the fixture rule of design m2-c1-hil D6. */
export const SELECTOR_HELP =
  'device selector: alias | id:<12hex> | mac:<mac> | tag:<t> | board:<b> | chip:<esp32|esp32c3|esp32c5|esp32c6|esp32s3> | profile:<p> | role:<node|gateway|fixture> | online | offline | all; "," combines (alternatives within one kind, narrowing across kinds), "!" excludes; the HIL fixture is picked only by its alias, id:, mac: or role:fixture, never by all or a "!"-only selector';

/**
 * A gateway's bridge as this hub run sees it (design m2-c4-gateway D15, D17): hub_status `links.gateways[G]` and the
 * gateway's own device_get `router.gateway`. Down after 1 s without a LINK_PONG; `status` is its last GW_STATUS.
 */
export const GatewayInfoSchema = z.looseObject({
  alias: z.string(),
  up: z.boolean(),
  rtt_us: z.number().nullable(),
  last_pong_ms_ago: z.number().nullable(),
  status: z.record(z.string(), z.unknown()).nullable(),
  /** Node sessions through it. */
  sessions: z.number().int(),
});

/** What this hub run knows of a device's link (device_get `router`; the hub's router DeviceLinkInfo). */
export const DeviceLinkInfoSchema = z.looseObject({
  presence: z.enum(PRESENCES),
  /** Links with a session, best first (gateway: through a gateway's bridge, design m2-c4-gateway D17). */
  links: z.array(z.enum(['serial', 'tcp', 'gateway'])),
  udp_ms_ago: z.number().nullable(),
  udp_blocked: z.boolean(),
  epoch: z.number().int().nullable(),
  addr: z.number().int(),
  fw_id_prefix: z.string().nullable(),
  ota_state: z.string().nullable(),
  /** HELLO caps bits (b1 wifi, b4 inject_enabled, b5 provisioned; 05 §5.7). */
  hello_caps: z.number().int().nullable(),
  hb_interval_ms: z.number(),
  last_rx_ms_ago: z.number().nullable(),
  clock: z.looseObject({ offset_us: z.number(), uncertainty_us: z.number(), skew_ppm: z.number(), rtt_us: z.number(), at_us: z.number(), samples: z.number() }).nullable(),
  heartbeat: z.record(z.string(), z.unknown()).nullable(),
  /** The property mirror: `<instance>.<property>` -> value. */
  properties: z.record(z.string(), z.unknown()),
  instances: z.array(z.looseObject({ name: z.string(), port: z.number().int(), cap: z.string(), cap_id: z.number().int() })).nullable(),
  /** The alias of the gateway its gateway session goes through, null without one (design m2-c4-gateway D17). */
  gw: z.string().nullable().optional(),
  /** For a gateway: its bridge (GatewayInfoSchema); null for any other device. */
  gateway: GatewayInfoSchema.nullable().optional(),
  /** The net id of its HELLO and its image chip id (255: a Linux node); design multi-hub-m1. */
  net: z.number().int().optional(),
  chip_id: z.number().int().nullable().optional(),
});

/**
 * Which hub a board is on, as far as this hub knows (device_get `hub_now`, design multi-hub-m1): `here` when its TCP
 * session is with this hub; `on`, `rev` and `trial` are the board's last fr.node.hubs_get answer in this hub run (null
 * before one: device_hubs_get asks). Since the hubs' link (design multi-hub-m2 §6) `at` is the name of the hub that
 * holds its session, as in device_list, and the time of the board's answer is `asked_at` (it was `at` before).
 */
export const HubNowSchema = z.looseObject({
  here: z.boolean(),
  /** The index in the board's list of the hub it was on when asked; null: none of them, or not asked yet. */
  on: z.number().int().nullable(),
  rev: z.number().int().nullable(),
  trial: z.boolean().nullable(),
  /** The name of the hub that holds its session: this hub's, a peer's, or null when no hub this hub can see holds it. */
  at: z.string().nullable(),
  /** ISO time of the board's hubs_get answer. */
  asked_at: z.string().nullable().optional(),
});

/** One hub of a board's list as the CLI takes it: `<host>` or `<host>/<ipv4>`, e.g. lab-hub.local/192.168.1.20. */
export const hubEntry = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}(\/\d{1,3}(\.\d{1,3}){3})?$/, 'expected <host> or <host>/<ipv4>, e.g. lab-hub.local/192.168.1.20');

/** What device_hubs_set and device_hubs_get answer. */
export const DeviceHubsSchema = z.looseObject({
  device_id: z.string(),
  alias: z.string(),
  /** The list the board holds, in priority order (the first is its default hub); empty: none, it uses the hub it was provisioned with. */
  hubs: z.array(DeviceHubSchema),
  rev: z.number().int(),
  /** The index in `hubs` of the hub its TCP session is with; null: none of them (or it left this hub before it could be asked). */
  on: z.number().int().nullable(),
  /** The list is on trial: no hub of it has WELCOMEd the board yet (it reverts after 60 s without one). */
  trial: z.boolean().nullable(),
  /** device_hubs_set: the board went to another hub of its list (it is no longer connected here). */
  left: z.boolean().optional(),
});


/** A capability instance as capability_list reports it: live from the router, else the build's manifest. */
export const CapInstanceSchema = z.looseObject({
  name: z.string(),
  port: z.number().int(),
  cap: z.string(),
  cap_id: z.number().int(),
  /** Capability version, e.g. 1.0. */
  v: z.string(),
  /** From the running build's manifest (design c6 D13); null for firmware the hub did not build. */
  traits: z.record(z.string(), z.unknown()).nullable(),
  driver: z.string().optional(),
});

/** The chips a registry row names (the hub's CHIP_IDS). */
export const REGISTRY_CHIPS = ['esp32', 'esp32c3', 'esp32c5', 'esp32c6', 'esp32s3'] as const;

/**
 * Another hub's API as device_provision `for_hub` takes it: scheme, host and port, nothing else (no path, query or
 * credentials), e.g. http://127.0.0.1:7520.
 */
export const hubApiUrl = z
  .string()
  .max(200)
  .regex(/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/?$|^https?:\/\/\[[0-9A-Fa-f:]+\](:\d{1,5})?\/?$/, 'expected the base URL of a hub API, e.g. http://127.0.0.1:7520');

/** A profile, board or partition layout name as a manifest spells it. */
const label = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/, 'expected a name of letters, digits, ".", "_" and "-"');

/**
 * What device_enroll answers (06 §6.4): the fr_id fields the flashing hub writes, and where the board finds this hub.
 * Never Wi-Fi credentials: the flashing hub takes those from its own stored network.
 */
export const EnrolledSchema = z.looseObject({
  device_id: z.string(),
  addr: z.number().int().min(1).max(0xefff),
  /** This hub's net_id. */
  net: z.number().int().min(1).max(0xffff),
  alias: z.string(),
  alias_rev: z.number().int().min(1),
  epoch_floor: z.number().int().min(1).max(0xffff),
  /** This hub's mDNS name, which the board resolves at every connect. */
  hub_host: z.string().regex(/^[A-Za-z0-9._-]{1,253}$/, 'expected a host name'),
  /** This hub's LAN IPv4, the board's fallback when mDNS fails; null when the hub knows none. */
  hub_ip: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,3}){3}$/, 'expected an IPv4 address')
    .nullable(),
  /** This hub's stored network the row names. */
  network: z.string(),
  /** Whether the device was not provisioned on this hub before (it then carries the tag `new`). */
  new: z.boolean(),
  tags: z.array(z.string()),
  /**
   * With an explicit identity (design multi-hub-m1), for a device connected to this hub under another identity:
   * `pushed` (a Linux node: the identity went to it as MSG fr.adopt and it restarts with it), `needs_flash` (an ESP32:
   * its fr_ident keeps the other identity until it is flashed). Absent otherwise.
   */
  adopt: z.enum(['pushed', 'needs_flash']).optional(),
});
export type Enrolled = z.infer<typeof EnrolledSchema>;

export const REGISTRY_OPS = [
  op({
    name: 'device_list',
    target: 'fleet',
    kind: 'query',
    tier: 'read',
    mcp: { alwaysLoad: true },
    summary:
      'Registered devices (provisioned, and seen-only ones with provisioned=false and addr=null) with alias, addr, profile, chip, tags, presence and USB port, at most 100. Example: selector "tag:poc,online".',
    input: z.object({
      selector: z.string().min(1).optional().describe(`${SELECTOR_HELP} (default all)`),
    }),
    output: z.looseObject({ devices: z.array(DeviceViewSchema), count: z.number().int(), truncated: z.boolean() }),
    cli: { path: ['devices', 'ls'], positional: ['selector'] },
  }),
  op({
    name: 'device_get',
    target: 'device',
    kind: 'query',
    tier: 'read',
    summary:
      'One device: its registry row, presence, USB port, what this hub run knows of its link (router: links, clock offset, last heartbeat, property mirror; null before its first HELLO) and the record of its last fr_ident write (never the Wi-Fi password).',
    input: z.object({ device: deviceSel }),
    output: DeviceViewSchema.extend({ provision: z.record(z.string(), z.unknown()).nullable(), router: DeviceLinkInfoSchema.nullable() }),
    cli: { path: ['devices', 'get'], positional: ['device'] },
  }),
  op({
    name: 'device_update',
    target: 'device',
    kind: 'command',
    tier: 'mutate',
    mcp: { idempotent: true },
    summary:
      'Rename a device and/or edit its tags. A new alias (RFC 1123 label, at most 31 characters, unique) bumps alias_rev and is pushed to the device if it is online (otherwise on its next HELLO). Example: --alias pad-red-1 --tag +poc,-old.',
    input: z.object({
      device: deviceSel,
      alias: z.string().min(1).max(63).optional().describe('new alias, e.g. pad-red-1'),
      tag: z.string().min(1).optional().describe('comma-separated tag edits: +t (or t) adds, -t removes'),
    }),
    cli: { path: ['devices', 'set'], positional: ['device'] },
  }),
  op({
    name: 'device_provision',
    target: 'port',
    kind: 'job',
    tier: 'mutate',
    destructive: true,
    summary:
      'Provision a USB-attached board (first flash): probe it, register it (addr, alias, net), write the newest debug artifact of its profile plus fr_ident (Wi-Fi from network_set, hub host) in one write_flash, reset it, wait for its HELLO on serial, then report whether it joined over Wi-Fi (wifi: joined | not_joined, via: tcp, or gateway_status for a role: gateway profile, which opens no TCP and shows the AP in its GW_STATUS; off for a radio-off profile such as the HIL fixture\'s). With for_hub (another hub\'s API, e.g. http://127.0.0.1:7520 through an SSH tunnel) the board is flashed here for that hub: that hub registers it (device_enroll) and the board connects there, with the Wi-Fi of this hub\'s stored network; this hub keeps no provisioned row for it. When that hub is in this hub\'s network (the same net id: network_join) the board is both hubs\': this hub keeps its row, that hub gets the same row, and the board connects there first. Example: --port 1cdbd4000134 --profile c6-pad.',
    input: z.object({
      port: portSel,
      profile: z.string().optional().describe('profile to flash; default: the registry profile, else the only one built for the probed chip'),
      build: z.string().optional().describe('build_id; default: newest debug artifact of the profile'),
      alias: z.string().min(1).max(63).optional().describe('alias; default: the registry alias, else <profile>-<last 6 hex of the MAC>'),
      network: networkName.optional().describe('the stored network it joins (network_list); default: the registry row\'s, else default'),
      for_hub: hubApiUrl
        .optional()
        .describe(
          'provision the board for another hub: the base URL of that hub\'s API, e.g. http://127.0.0.1:7520 (an SSH tunnel to it). That hub registers the board (device_enroll) and the board connects to it; the Wi-Fi is still this hub\'s stored network. A hub of this hub\'s own network gets the row this hub keeps',
        ),
      wait_s: waitS,
    }),
    cli: { path: ['devices', 'provision'] },
  }),
  op({
    name: 'device_enroll',
    target: 'hub',
    kind: 'command',
    tier: 'mutate',
    destructive: true,
    summary:
      'Register a board that another hub is flashing for this one (that hub\'s device_provision with for_hub calls it; people do not need it): give it an addr and an alias on a stored network exactly as a provision here would, mark it provisioned, and tag it `new` when it was not provisioned here before (device_update --tag -new accepts it). Answers what the flashing hub writes into fr_ident: addr, net, alias, alias_rev, epoch_floor, hub_host and hub_ip, never Wi-Fi credentials. Enrolling a known board again keeps its addr and alias. On a member of a network the address comes from the registrar over the hubs\' link (HUB_UNREACHABLE while the registrar is away), and the row is then at every hub. With addr, net and alias it stores exactly that identity instead, without the tag: refused when net is not this hub\'s or another device holds the addr. ENV_MISSING when no network is stored (fr net set --ssid; the password is not needed here).',
    input: z.object({
      device_id: z.string().regex(/^[0-9a-fA-F]{12}$/, 'expected 12 hex digits').describe('the board\'s device id: its factory MAC as 12 hex digits, e.g. a0b1c2d3e4f5'),
      chip: z.enum(REGISTRY_CHIPS).optional().describe('the probed chip; required for a board that is flashed (a Linux node has none and is enrolled by its alias)'),
      profile: label.optional().describe('the profile of the firmware being written, e.g. c6-pad; required with chip'),
      board: label.optional().describe('the board of that firmware, e.g. esp32c6-supermini'),
      part_profile: label.optional().describe('its partition layout, e.g. fr-4mb-v1'),
      build_id: z.string().min(1).max(200).optional().describe('the build being written, for the record'),
      fw_id: z.string().regex(/^[0-9a-f]{8,64}$/, 'expected 8 to 64 hex digits').optional().describe('its fw_id, for the registry row'),
      ident_offset: z.number().int().min(0).max(0xffffffff).optional().describe('where that layout keeps fr_ident in flash, for the record (with ident_size)'),
      ident_size: z.number().int().min(1).max(0x100000).optional().describe('the size of that fr_ident partition'),
      alias: z.string().min(1).max(63).optional().describe('alias; default: the registry alias, else <profile>-<last 6 hex of the MAC>'),
      network: networkName.optional().describe('this hub\'s stored network the row names (network_list); default: the registry row\'s, else default'),
      addr: z.number().int().min(1).max(0xefff).optional().describe('with net and alias: the address the board already has in this network (nothing is allocated)'),
      net: z.number().int().min(1).max(0xffff).optional().describe('with addr and alias: the net id the board has, which must be this hub\'s'),
      alias_rev: z.number().int().min(1).max(0xffffffff).optional().describe('with addr: the rev of that alias (default 1)'),
      epoch_floor: z.number().int().min(1).max(0xffff).optional().describe('with addr: above the last boot epoch the other hub saw (default 1)'),
    }),
    output: EnrolledSchema,
    cli: { path: ['devices', 'enroll'], positional: ['device_id'] },
  }),
] as const;

export type RegistryOpName = (typeof REGISTRY_OPS)[number]['name'];

/**
 * One network, several hubs (design multi-hub-m1): a board's ordered hub list, a board's row for another hub of the
 * network, and joining another hub's network. At the end of OPS; handlers in packages/hub/src/registry (hubs.ts, share.ts).
 */
export const MULTI_HUB_OPS = [
  op({
    name: 'device_hubs_set',
    target: 'device',
    kind: 'command',
    tier: 'mutate',
    mcp: { idempotent: true },
    summary:
      'Set the ordered list of hubs a board connects to (one network, several hubs): the first is its default hub; when the hub it is on goes away it moves down the list within about 10 to 15 s, and it returns by itself once a hub above answers again (it looks about once a minute). The list goes to the board over the air (fr.node.hubs_set with the next rev) and into the registry. A list that names the hub the board is on is kept at once; any other is on trial, and the board returns to the list it had unless one of its hubs takes it within 60 s. Every hub of the list needs the board\'s row: the hubs of one network hold it by themselves. --none takes the list away: the board uses the hub it was provisioned with. DEVICE_OFFLINE without a session; CAPABILITY_UNSUPPORTED for firmware without fr.node 1.1. Example: --hub lab-hub.local --hub home-hub.local/192.168.1.30.',
    input: z.object({
      device: deviceSel,
      hub: z
        .array(hubEntry)
        .max(4)
        .default([])
        .describe('a hub of the list, in priority order: <host> or <host>/<ipv4 to fall back to>, e.g. home-hub.local/192.168.1.30; at most 4'),
      none: z.boolean().default(false).describe('take the list away: the board uses the hub it was provisioned with'),
    }),
    output: DeviceHubsSchema,
    cli: { path: ['devices', 'hubs', 'set'], positional: ['device'] },
  }),
  op({
    name: 'device_hubs_get',
    target: 'device',
    kind: 'query',
    tier: 'read',
    summary:
      'Ask a board for its hub list (fr.node.hubs_get): the hubs in priority order, the list\'s rev, the index of the hub its session is with and whether the list is still on trial. The registry row is brought in line with what the board holds (another hub of its network may have set it). device_get shows the registry\'s copy without asking the board. DEVICE_OFFLINE without a session; CAPABILITY_UNSUPPORTED for firmware without fr.node 1.1.',
    input: z.object({ device: deviceSel }),
    output: DeviceHubsSchema,
    cli: { path: ['devices', 'hubs', 'get'], positional: ['device'] },
  }),
  op({
    name: 'device_share',
    target: 'hub',
    kind: 'command',
    tier: 'mutate',
    mcp: { idempotent: true, openWorld: true },
    summary:
      'Retired inside one network: the hubs of a network hold every row of it by themselves (the registry is replicated over the hubs\' link), so toward a hub this hub replicates with it changes nothing and says so (`replicated: true`, a warning), answering that hub\'s host name for the board\'s hub list (device_hubs_set). It still gives the row by hand to a hub of the same network that does not replicate (one that was not updated, or that joined before the hubs\' link): that hub\'s device_enroll with the board\'s addr, net and alias; nothing is flashed and no address is allocated. Refused when that hub is in another network (on it: network_join). Example: device pad-c6, --with-hub http://127.0.0.1:7520.',
    input: z.object({
      device: deviceSel,
      with_hub: hubApiUrl.describe('the base URL of the other hub\'s API, e.g. http://127.0.0.1:7520 (an SSH tunnel to it)'),
    }),
    output: z.looseObject({
      device_id: z.string(),
      alias: z.string(),
      addr: z.number().int(),
      net: z.number().int(),
      with_hub: z.string(),
      /** The other hub's host name and LAN address, for device_hubs_set. */
      hub_host: z.string(),
      hub_ip: z.string().nullable(),
      adopt: z.enum(['pushed', 'needs_flash']).optional(),
      /** That hub holds the row by replication (design multi-hub-m2 step 2.3): nothing was sent. */
      replicated: z.boolean().optional(),
      warnings: z.array(z.string()).optional(),
    }),
    cli: { path: ['devices', 'share'], positional: ['device'] },
  }),
  op({
    name: 'network_join',
    target: 'hub',
    kind: 'command',
    tier: 'mutate',
    destructive: true,
    mcp: { openWorld: true },
    summary:
      'Make this hub a member of another hub\'s network: it takes that hub\'s net id (and, when it has no network stored, its SSID, country and band; never a password) and records that hub as the network\'s registrar, the one hub that hands out addresses. The registrar admits it (network_admit): this hub gets its name in the network, an epoch slot, the member list and the network key (sealed in transit, kept in secrets.json, never answered), and the hubs\' link to its peers starts. From then on device_provision, device_adopt and device_enroll here ask the registrar for a new board\'s address over the hubs\' link, and refuse while it is away; every row of the network is at every hub of it. Boards this hub provisioned under its own net id become foreign: refused while there are any unless force is set. Joining the same hub again changes nothing (and gives a hub that joined before the hubs\' link its key and slot). Example: --hub http://127.0.0.1:7420.',
    input: z.object({
      hub: hubApiUrl.describe('the base URL of the API of the hub whose network this hub joins, e.g. http://127.0.0.1:7420 (an SSH tunnel to it)'),
      force: z.boolean().default(false).describe('join although boards are provisioned here under this hub\'s own net id (they then need a new identity)'),
    }),
    output: z.looseObject({
      net_id: z.number().int(),
      /** This hub's net id before; null when it had none. */
      previous_net_id: z.number().int().nullable(),
      registrar: z.string(),
      networks: z.array(NetworkSchema),
      /** Boards provisioned here under the previous net id. */
      foreign: z.array(z.looseObject({ device_id: z.string(), alias: z.string(), chip: z.string().nullable(), fix: z.string() })),
      /** This hub as the registrar admitted it (design multi-hub-m2 §4): its name in the network and its epoch slot. */
      hub: HubIdentitySchema.optional(),
      /** The network's hubs, this one included. Never the network key: that goes to secrets.json and nowhere else. */
      members: z.array(HubMemberSchema).optional(),
      warnings: z.array(z.string()).optional(),
    }),
    cli: { path: ['net', 'join'] },
  }),
] as const;

export type MultiHubOpName = (typeof MULTI_HUB_OPS)[number]['name'];

/**
 * What the hub's checkout and catalog offer (design c6 D14; stream S2): board_list, profile_list and
 * capability_list. A group of their own, so their handlers live apart from the registry's.
 */
export const INVENTORY_OPS = [
  op({
    name: 'board_list',
    target: 'hub',
    kind: 'query',
    tier: 'read',
    summary: "Boards the hub's checkout describes (hardware/boards): id, chip, flash size, button and LED names, and the T-LAT test_pin (null without one).",
    input: z.object({}),
    output: z.looseObject({
      boards: z.array(
        z.looseObject({
          board: z.string(),
          chip: z.string(),
          flash: z.string(),
          buttons: z.array(z.string()),
          leds: z.array(z.string()),
          test_pin: z.number().int().nullable(),
        }),
      ),
    }),
    cli: { path: ['boards', 'ls'] },
  }),
  op({
    name: 'profile_list',
    target: 'hub',
    kind: 'query',
    tier: 'read',
    summary:
      "Firmware profiles in the hub's checkout (firmware/profiles): board, chip, app, capability instances with their drivers, and the newest debug build of each (build_id, fw_id, built_at), for build_start and device_provision.",
    input: z.object({}),
    output: z.looseObject({
      profiles: z.array(
        z.looseObject({
          profile: z.string(),
          board: z.string(),
          chip: z.string(),
          app: z.string(),
          instances: z.record(z.string(), z.looseObject({ cap: z.string(), driver: z.string() })),
          newest_debug: z.looseObject({ build_id: z.string(), fw_id: z.string(), built_at: z.string() }).optional(),
        }),
      ),
    }),
    cli: { path: ['profiles', 'ls'] },
  }),
  op({
    name: 'capability_list',
    target: 'device',
    kind: 'query',
    tier: 'read',
    summary:
      "The capability catalog the hub runs (catalog_hash, each capability's commands, events and properties); with device, also that device's instances (port, capability, version, traits, driver), as the router knows them this run, else from its build's manifest. Example: device pad-c6.",
    input: z.object({ device: deviceSel.optional() }),
    output: z.looseObject({
      catalog_hash: z.number().int(),
      caps: z.array(z.record(z.string(), z.unknown())),
      device: z.looseObject({ instances: z.array(CapInstanceSchema) }).optional(),
    }),
    cli: { path: ['caps', 'ls'] },
  }),
] as const;

export type InventoryOpName = (typeof INVENTORY_OPS)[number]['name'];
