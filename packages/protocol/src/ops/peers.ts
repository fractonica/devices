// The hubs' link, step 2.1 (design multi-hub-m2 §2-§4, §6, §9): a hub's identity in its network (id, name, epoch
// slot), the member list the registrar keeps, admission (network_admit: the registrar's half of network_join, which
// hands the joining hub the network key sealed to a key of its own), and `fr hub peers`. Spread into OPS at its end
// (packages/protocol/src/ops.ts); handlers in packages/hub/src/peers/ops.ts. The network key itself is in no schema
// here: it lives in secrets.json and crosses only inside `sealed`.

import { z } from 'zod';

import { op } from './common.ts';

/** A hub's name in its network (design multi-hub-m2 §2): a lowercase label, unique in the network, at most 31 characters. */
export const HUB_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,29}[a-z0-9])?$/;
export const hubName = z.string().regex(HUB_NAME_RE, 'expected a lowercase label of letters, digits and "-", at most 31 characters, e.g. lab').describe('hub name, e.g. lab');

/** A hub id: 6 random bytes as 12 lowercase hex, made once per FR_HOME. */
export const hubId = z.string().regex(/^[0-9a-f]{12}$/, 'expected 12 lowercase hex digits');

/** The port the hubs' link listens on (design multi-hub-m2 §3.1), beside the node ports 7421 and 7422. */
export const PEER_LINK_PORT = 7423;

/** The registrar is slot 0; it gives members 1 to 3, so a network has at most four hubs (design multi-hub-m2 §9). */
export const EPOCH_SLOTS = 4;

/** This hub in its network (hub_status `hub`, network_join `hub`): `slot` null until it holds one. */
export const HubIdentitySchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  slot: z.number().int().min(0).max(EPOCH_SLOTS - 1).nullable(),
});
export type HubIdentity = z.infer<typeof HubIdentitySchema>;

/** One hub of the member list as the registrar keeps it and every member holds it. Never a secret. */
export const HubMemberSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  /** Its host name (what a peer resolves first), and the address and link port it gave when it joined. */
  host: z.string(),
  addr: z.string().nullable(),
  link_port: z.number().int().min(1).max(65535),
  /** Its epoch slot: 0 is the registrar. */
  slot: z.number().int().min(0).max(EPOCH_SLOTS - 1),
  joined_at: z.string(),
});
export type HubMember = z.infer<typeof HubMemberSchema>;

/**
 * The network key as network_admit answers it: sealed to the X25519 public key the joining hub sent (an ephemeral
 * X25519 key of the registrar's, HKDF-SHA256, AES-256-GCM). Only the hub that holds the matching private key opens it.
 */
export const SealedKeySchema = z.looseObject({
  alg: z.literal('x25519-hkdf-sha256-aes256gcm'),
  /** Base64: the registrar's ephemeral public key (32 bytes), the HKDF salt, the GCM nonce, the ciphertext and its tag. */
  epk: z.string(),
  salt: z.string(),
  nonce: z.string(),
  ct: z.string(),
  tag: z.string(),
});
export type SealedKey = z.infer<typeof SealedKeySchema>;

/** What network_admit answers the joining hub: public data and the sealed key, nothing else. */
export const AdmittedSchema = z.looseObject({
  net_id: z.number().int().min(1).max(0xffff),
  /** The joining hub as admitted: its id, the name the network knows it by, its epoch slot. */
  hub: HubIdentitySchema.extend({ slot: z.number().int().min(0).max(EPOCH_SLOTS - 1) }),
  registrar: z.looseObject({ id: z.string(), name: z.string() }),
  members: z.array(HubMemberSchema),
  members_version: z.number().int().min(1),
  sealed: SealedKeySchema,
});
export type Admitted = z.infer<typeof AdmittedSchema>;

/** One row of hub_peers: a hub of the network as this hub sees it now. */
export const HubPeerSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  /** True for the hub that answers. */
  this: z.boolean(),
  role: z.enum(['registrar', 'member']),
  slot: z.number().int(),
  host: z.string(),
  /** The peer link to it is up (always true for this hub). */
  reachable: z.boolean(),
  /** ISO time it became reachable or went away in this hub run; null: never connected since this hub started. */
  since: z.string().nullable(),
  /** From its hello: what it runs. null for a peer never connected in this hub run. */
  registry_hash: z.string().nullable(),
  hub_epoch: z.number().int().nullable(),
  /** Boards whose session it holds (for a peer: as it last reported; null while it is not reachable). */
  boards: z.number().int().nullable(),
  /** `<address>:<port>` of the connection in use (this hub: where its link listens); null without one. */
  address: z.string().nullable(),
  /** Why the last attempt to reach it failed, while it is not reachable. */
  last_error: z.string().optional(),
  /**
   * The one registry with this hub, in this hub run (design multi-hub-m2 §5): `speaks` false for a hub that does not
   * replicate (a version from before step 2.3); `in_step` whether it holds the same registry as this hub (null while it
   * is away or has not said); `rows` what it said it holds, tombstones included; `sent`, `received` and `taken` count
   * rows; `conflicts` the copies of its that this hub did not take; `unanswered` this hub's digests it has not answered.
   */
  registry: z
    .looseObject({
      speaks: z.boolean(),
      in_step: z.boolean().nullable(),
      rows: z.number().int().nullable(),
      sent: z.number().int().optional(),
      received: z.number().int().optional(),
      taken: z.number().int().optional(),
      conflicts: z.number().int().optional(),
      unanswered: z.number().int().optional(),
      heard_at: z.string().nullable().optional(),
    })
    .optional(),
  /**
   * Events with this hub, in this hub run (design multi-hub-m2 §8): `speaks` false for a hub that relays none (a version
   * from before step 2.4); `sent` and `received` count events; `dropped` those this hub did not send it because its
   * queue to it was full (a slow link) or its connection went, `coalesced` the values of properties a newer one replaced in that queue,
   * `missed` those it said it did not send this hub; `queued` wait now; `mirrored` its boards whose state this hub holds.
   */
  events: z
    .looseObject({
      speaks: z.boolean(),
      sent: z.number().int().optional(),
      received: z.number().int().optional(),
      dropped: z.number().int().optional(),
      coalesced: z.number().int().optional(),
      missed: z.number().int().optional(),
      queued: z.number().int().optional(),
      mirrored: z.number().int().optional(),
    })
    .optional(),
  /** Live streams relayed with this hub: whether it relays them, and how many are open now, either way. */
  streams: z.looseObject({ speaks: z.boolean(), open: z.number().int() }).optional(),
});
export type HubPeer = z.infer<typeof HubPeerSchema>;

export const PEER_OPS = [
  op({
    name: 'network_admit',
    target: 'hub',
    kind: 'command',
    tier: 'mutate',
    mcp: { idempotent: true },
    summary:
      'Admit a hub into this hub\'s network (that hub\'s network_join calls it; people do not need it). Only the registrar answers: it makes the network key the first time (32 random bytes, kept in secrets.json), gives the hub its name as the network knows it (refused when another hub has it), an epoch slot (the registrar is 0, members 1 to 3; a fifth hub is refused) and the member list, and tells the other members. The key is answered only sealed to the X25519 public key the caller sent, never in the clear. Admitting a hub again keeps its slot and answers the same.',
    input: z.object({
      hub_id: hubId.describe('the joining hub\'s id: 12 lowercase hex, e.g. 5d1c20a0b1c2'),
      name: hubName.describe('the name it asks for in the network, e.g. lab'),
      host: z.string().regex(/^[A-Za-z0-9._-]{1,253}$/, 'expected a host name or an IPv4 address').describe('its host name, which a peer resolves first, e.g. lab-hub.local'),
      addr: z
        .string()
        .regex(/^\d{1,3}(\.\d{1,3}){3}$/, 'expected an IPv4 address')
        .optional()
        .describe('its LAN IPv4, a peer\'s fallback when the name does not resolve'),
      link_port: z.number().int().min(1).max(65535).describe('the port its peer link listens on (7423 unless it runs elsewhere)'),
      public_key: z
        .string()
        .regex(/^[A-Za-z0-9+/]{43}=$/, 'expected a raw X25519 public key, 32 bytes as base64')
        .describe('an X25519 public key made for this call (32 bytes, base64): the network key is answered sealed to it'),
    }),
    output: AdmittedSchema,
    cli: { path: ['net', 'admit'] },
  }),
  op({
    name: 'hub_name_set',
    target: 'hub',
    kind: 'command',
    tier: 'mutate',
    mcp: { idempotent: true },
    summary:
      'Give this hub its name in its network: the short name shown wherever a board\'s place is shown (device_list `at`, hub_peers). The default is the host name without its domain. A lowercase label, unique in the network: on the registrar the member list changes and the other hubs are told; on a member the registrar is asked through its API (the URL network_join was given, so the tunnel to it must be open) and refuses a name another hub has; on a hub that is alone it is stored for the next join. Example: lab.',
    input: z.object({ name: hubName }),
    output: z.looseObject({ hub: HubIdentitySchema, previous: z.string() }),
    cli: { path: ['hub', 'name'], positional: ['name'] },
  }),
  op({
    name: 'hub_peers',
    target: 'hub',
    kind: 'query',
    tier: 'read',
    summary:
      'The hubs of this hub\'s network and the link to each (design multi-hub-m2): name, id, whether it is this hub, whether it is reachable and since when, the registry hash and hub epoch it runs, how many boards it holds a session with, the address in use, how the device registry stands with it (`registry`: whether it replicates, whether the two hold the same rows, rows sent and taken, copies not taken), and the live data with it (`events`: events sent, received and dropped; `streams`: relayed streams open). ENV_MISSING while this hub is alone in its network (no hub joined it and it joined none: fr net join).',
    input: z.object({}),
    output: z.looseObject({
      net_id: z.number().int(),
      hub: HubIdentitySchema,
      /** The registrar's name. */
      registrar: z.string(),
      members_version: z.number().int(),
      /** This hub's link listener. */
      link: z.looseObject({ listening: z.boolean(), port: z.number().int().nullable(), error: z.string().nullable() }),
      peers: z.array(HubPeerSchema),
      /** Since this hub started: handshakes refused, peers gone silent, ops passed on and taken, data channels and their bytes, registry rows, events sent, received and dropped, relayed streams and their bytes. */
      counters: z.record(z.string(), z.number()).optional(),
      /** The device registry this hub holds for the network: its rows, its tombstones, the hash two hubs compare, and the copies it did not take. */
      registry: z
        .looseObject({
          rows: z.number().int(),
          tombstones: z.number().int(),
          hash: z.string(),
          conflicts: z.array(z.looseObject({ device: z.string(), hub: z.string(), kind: z.string().optional(), message: z.string() })),
        })
        .optional(),
    }),
    cli: { path: ['hub', 'peers'] },
  }),
] as const;

export type PeerOpName = (typeof PEER_OPS)[number]['name'];
