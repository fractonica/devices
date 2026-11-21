// The hubs' link as a part of the hub (design multi-hub-m2, step 2.1 "link and presence"): what link.ts carries, and
// what it means here.
//   - Membership (§4). The member list in hub.db (members.ts) says who the peers are; a newer list from a peer is
//     taken and passed on, so a third hub that joined at the registrar becomes known to the second.
//   - Presence (§6). This hub tells its peers which boards it holds a session with: all of them when a link comes up,
//     then each change (a session started or ended, its links changed), read off the hub's own event bus
//     (device.online, device.offline, device.link). What a peer said is kept while that peer is reachable and
//     forgotten when it goes away. From it: `at`, the name of the hub that holds a board's session, for device_list,
//     device_get and hub_now; and the serial rule below.
//   - No USB blip (§6; MULTI-HUB-1 §c left it open). While a reachable peer reports a board's TCP session, this hub
//     does not WELCOME that board on a USB cable (the router asks `heldOverTcp`), and a serial session it still has
//     with the board is ended: the board gave it up when it took the other hub's WELCOME. The port stays open (logs,
//     flash, serial diag).
//   - Ops (§7, step 2.2). `call` and `result` (calls.ts) and the data channels (channels.ts) ride the same link; what
//     an op passed on means is passing.ts's, which this part hands every call that arrives (`serve`). This part
//     answers who holds a board (`holder`), who held it when its hub went away (`lastHolder`) and which hub a name is.
//   - One registry (§5, step 2.3). Every hub holds every row of the network: registry.ts carries the rows and their revs
//     in the `registry` message, registry/sync.ts stamps and merges them. `registry` is that part.
//   - Live data (§8, step 2.4). Events cross: events.ts sends what this hub publishes and publishes what the peers send
//     (`events`); a live stream of a board a peer holds is relayed over a data channel (streams.ts, `streams`).
// A hub that holds no network key has no link: createPeers still answers `at` for its own boards and its identity.

import { hostname } from 'node:os';

import { FrError, HUB_VERSION, type HubMember, type HubPeer, REGISTRY_HASH, runSlot } from '@fractonica/protocol';

import type { HubContext, HubEvent, HubPart, HubRunOptions, Presence } from '../context.ts';
import { guarded } from '../crash.ts';
import { epochInSlot, EPOCH_SLOT_SIZE, runInSlot } from '../db.ts';
import { fleetNetId, registrarOf } from '../network.ts';
import { routerInfo } from '../router/index.ts';
import { advertised, hubIdentity, hubName, peerPortOf } from './identity.ts';
import { readNetworkKey } from './key.ts';
import { type CallAnswer, type CallOptions, failed, PeerCalls } from './calls.ts';
import { PeerChannels, type Provider, type Pulled, type PullOptions } from './channels.ts';
import { createEventRelay, type EventRelay, type EventRelayLimits, type EventsPeer } from './events.ts';
import { type LinkTarget, PeerLinks, type PeerLinkTiming, type PeerView } from './link.ts';
import { bumpMembers, listMembers, type MemberRow, membersVersion, noteSeen, publicMember, putRegistrar, replaceMembers } from './members.ts';
import { createRegistrySync, type RegistryStatus, type RegistrySync, type RegistryTiming } from './registry.ts';
import { PeerStreams, type RelayHandle, type RelaySink, type StreamServer } from './streams.ts';
import { type CallMsg, type Held, type MembersMsg, type PeerMessage, type PresenceMsg, STREAMS_WIRE } from './wire.ts';

/** The node link port of a real hub (links/index.ts NODE_LINK_PORT, not imported: that module loads the listeners). */
const NODE_PORT = 7421;

/** A board a peer holds, as it last said. */
interface Remote extends Held {
  /** Unix ms this hub heard of it. */
  since: number;
}

export interface PeersStatus {
  /** Whether this hub holds its network's key (so has a link at all). */
  keyed: boolean;
  link: { listening: boolean; port: number | null; error: string | null };
  members: MemberRow[];
  members_version: number;
  peers: PeerView[];
  /** Boards each reachable peer holds, by hub id. */
  held: Record<string, number>;
  counters: Record<string, number>;
  /** The one registry (design multi-hub-m2 §5): what this hub holds and how it stands with each peer. */
  registry: RegistryStatus;
  /** Live data (design multi-hub-m2 §8): events with each peer, and the relayed streams open with it. */
  events: Record<string, EventsPeer>;
  streams: Record<string, { speaks: boolean; open: number }>;
}

/** A hub of this hub's network as an op's passing sees it. */
export interface PeerHub {
  id: string;
  name: string;
  /** This hub itself. */
  self: boolean;
  reachable: boolean;
  /** The registry hash it said in its hello (this hub's own for `self`); null before its first hello of this hub run. */
  registry_hash: string | null;
  last_error: string | null;
  /** Its epoch slot in the network (0: the registrar): the slot its cursors' runs carry. */
  slot: number;
}

/** A board's session at a peer started, changed or ended, as that peer said (or that peer went away: `up` false). */
export interface RemotePresence {
  device: string;
  hub: { id: string; name: string };
  up: boolean;
  fw: string | null;
  links: string[];
  /** `up` false because that hub went away, not because the board's session there ended: where the board is, is not known. */
  away?: boolean;
}

/** Runs a call that arrived over the link (passing.ts): the op by its name, never passed on again. */
export type CallServer = (from: PeerHub, msg: CallMsg, input: Record<string, unknown>) => Promise<CallAnswer>;

/** The hubs' link (HubContext.peers). */
export interface Peers extends HubPart {
  /** This hub's registry hash as its peers hear it (REGISTRY_HASH; a test hub may be told another). */
  registryHash(): string;
  /** The reachable peer that reports the board's session (one with its TCP session first), or null. */
  holder(deviceId: string): PeerHub | null;
  /** The firmware id prefix the reachable peer that holds the board said of it (its HELLO's), or null. */
  heldFw(deviceId: string): string | null;
  /** The hub that last reported the board's session and is away now (design multi-hub-m2 §6), or null. */
  lastHolder(deviceId: string): { id: string; name: string } | null;
  /** The hubs of the network, this one included; empty on a hub that is alone. */
  hubs(): PeerHub[];
  /** One op (or link service) at a peer, by hub id: never rejects (calls.ts). */
  call(hubId: string, op: string, input: Record<string, unknown>, opts: CallOptions): Promise<CallAnswer>;
  /** What answers the calls that arrive: set once, by passing.ts. */
  serve(fn: CallServer): void;
  /** Fetches bytes a peer serves into a file of this hub (channels.ts). */
  pull(hubId: string, kind: string, ref: Record<string, unknown>, dest: string, opts?: PullOptions): Promise<Pulled>;
  /** Registers what serves a kind of data channel to the peers. */
  provide(kind: string, fn: Provider): void;
  /** Calls `fn` at each change of what a peer holds; returns the unsubscribe. */
  onRemote(fn: (e: RemotePresence) => void): () => void;
  /** The name of the hub that holds the board's session: this hub's, a reachable peer's, or null. */
  at(deviceId: string): string | null;
  /** The reachable peer that reports the board's TCP session, by name; null when none does (the serial rule). */
  heldOverTcp(deviceId: string): string | null;
  /**
   * The key or the member list changed (network_join, network_admit, hub_name_set): the link follows, and the peers
   * hear of a newer list.
   */
  refresh(): Promise<void>;
  /** Binds the link's listener if it is not bound and answers its port: what a hub tells the registrar at a join. */
  listen(): Promise<number | null>;
  status(): PeersStatus;
  /** The one registry across the hubs (design multi-hub-m2 §5, registry.ts): `flush` after a write to `devices`. */
  registry: Pick<RegistrySync, 'flush' | 'replicates' | 'status'>;
  /** Events across the hubs (design multi-hub-m2 §8, events.ts): what the peers' boards last said, their jobs and prompts. */
  events: Pick<EventRelay, 'relays' | 'states' | 'properties' | 'jobs' | 'onJob' | 'prompts'>;
  /** Live streams across the hubs (design multi-hub-m2 §8, streams.ts). */
  streams: {
    /** Whether that hub relays streams with this one (both hellos say `streams`). */
    speaks(hubId: string): boolean;
    /** Asks the hub to run a stream for `hello` and send its frames to `sink`. */
    relay(hubId: string, hello: Record<string, unknown>, sink: RelaySink): RelayHandle;
    /** What serves the relays that arrive: set by the /app server while it runs. */
    serve(fn: StreamServer | null): void;
  };
  /**
   * The hub whose cursor a run number belongs to (a run carries its hub's slot, db.ts nextHubRun): this hub (`self`)
   * for its own current run, a member of the network for another slot's, null for an earlier run of this hub's own
   * slot or a slot no member has.
   */
  hubOfRun(run: number): PeerHub | null;
  /**
   * The name of the hub that holds the board's session as this hub sees the network, leaving out the hub `except`
   * (by id; this hub's own id leaves this hub out): this hub's, a reachable peer's, or null.
   */
  heldAt(deviceId: string, except?: string): string | null;
}

export interface PeersOptions {
  timing?: Partial<PeerLinkTiming>;
  registry?: Partial<RegistryTiming>;
  events?: Partial<EventRelayLimits>;
  /** A test: `off` makes this hub one of step 2.3 (no `events` and no `streams` in its hello, none sent, none taken). */
  live?: 'on' | 'off';
}

const isUp = (p: string | undefined) => p === 'online' || p === 'suspect';
/** The order a board's links are told in, whatever the router ranks first at the moment. */
const LINK_ORDER = ['tcp', 'gateway', 'serial'];
/** How often what was told is checked against the router while a peer is reachable. */
const RECONCILE_MS = 2000;

/**
 * Where to look for a peer, in order (design multi-hub-m2 §3.2, as a board resolves its hub, 05 §5.12.5): its host
 * name, the address its link last came from, the address in the member list.
 */
export function candidatesOf(m: MemberRow): { host: string; port: number }[] {
  const out: { host: string; port: number }[] = [];
  const add = (host: string | null, port: number | null) => {
    if (host && port && !out.some((c) => c.host === host && c.port === port)) {
      out.push({ host, port });
    }
  };
  add(m.host, m.link_port);
  add(m.seen_addr, m.seen_port);
  add(m.addr, m.link_port);
  return out;
}

export function createPeers(hub: () => HubContext, run: HubRunOptions | undefined, opts: PeersOptions = {}): Peers {
  const db = () => hub().db;
  /** The key in memory, read from secrets.json at the start and at each refresh: a handshake never reads the file. */
  let key: { key: Buffer; net: number } | null = null;
  /** What each reachable peer holds: hub id -> device id -> the board. */
  const remote = new Map<string, Map<string, Remote>>();
  /** What this hub last told its peers of each board it holds, so only a change is sent. */
  const told = new Map<string, { json: string; held: Held }>();
  /** What a peer held when it went away, until it is back or the board is seen elsewhere: hub id -> device ids. */
  const lost = new Map<string, { name: string; devices: Set<string> }>();
  const remoteListeners = new Set<(e: RemotePresence) => void>();
  let server: CallServer | null = null;
  /** The member list version each peer is known to hold. */
  const peerVersion = new Map<string, number>();
  let unsubscribe: (() => void) | null = null;
  let reconciler: NodeJS.Timeout | null = null;
  let started = false;

  const loadKey = () => {
    const net = fleetNetId(db());
    let k: Buffer | null = null;
    try {
      k = readNetworkKey(net);
    } catch (e) {
      // secrets.json that does not parse: the hub runs without its link, and says so (never the file's content).
      console.error(JSON.stringify({ event: 'peer_key_unreadable', message: (e as Error).message }));
    }
    key = k && net !== null ? { key: k, net } : null;
  };

  /**
   * This hub's registry hash as it tells its peers. FR_TEST_PEER_REGISTRY_HASH says another one on a test hub only
   * (one whose node port is not 7421): how a test makes two hubs that differ.
   */
  const registryHash = (): string => {
    const forced = process.env.FR_TEST_PEER_REGISTRY_HASH;
    return forced && run !== undefined && run.nodePort !== NODE_PORT ? forced : REGISTRY_HASH;
  };

  /** FR_TEST_PEER_EVENTS=off: a test hub behaves as one of step 2.3 (no `events` and no `streams` in its hello). */
  const liveMode = (): 'on' | 'off' => opts.live ?? (run !== undefined && run.nodePort !== NODE_PORT && process.env.FR_TEST_PEER_EVENTS === 'off' ? 'off' : 'on');

  const tellRemote = (e: RemotePresence) => {
    for (const fn of remoteListeners) {
      try {
        fn(e);
      } catch (err) {
        console.error(JSON.stringify({ event: 'peer_listener_failed', message: (err as Error).message }));
      }
    }
  };

  const log = (line: Record<string, unknown>) => console.log(JSON.stringify(line));

  /** FR_TEST_PEER_REGISTRY and FR_TEST_PEER_REGISTRY_TAP are honoured by a test hub only (one not on node port 7421). */
  const testHub = () => run !== undefined && run.nodePort !== NODE_PORT;
  const registry: RegistrySync = createRegistrySync({
    hub,
    send: (id, msg) => links.send(id, msg),
    views: () => links.views(),
    mode: () => {
      const m = testHub() ? process.env.FR_TEST_PEER_REGISTRY : undefined;
      return m === 'off' || m === 'mute' ? m : 'on';
    },
    tap: () => (testHub() ? (process.env.FR_TEST_PEER_REGISTRY_TAP ?? null) : null),
    timing: opts.registry,
    log,
  });

  const links: PeerLinks = new PeerLinks({
    listen: { host: run?.nodeHost ?? '0.0.0.0', port: peerPortOf(run) },
    key: () => key,
    hello: () => {
      const me = hubIdentity(db());
      return {
        hub_id: me.id,
        name: me.name,
        net: key?.net ?? fleetNetId(db()) ?? 0,
        registry_hash: registryHash(),
        hub_epoch: hub().hubEpoch,
        members_version: membersVersion(db()),
        ...(links.port() ? { link_port: links.port()! } : {}),
        hub_version: HUB_VERSION,
        ...(registry.hello() !== undefined ? { registry: registry.hello() } : {}),
        ...(events.hello() !== undefined ? { events: events.hello(), streams: STREAMS_WIRE } : {}),
      };
    },
    targets: (): LinkTarget[] => {
      const me = hubIdentity(db()).id;
      return listMembers(db())
        .filter((m) => m.id !== me)
        .map((m) => ({ id: m.id, name: m.name, candidates: candidatesOf(m) }));
    },
    onUp: (peer) => {
      // The pair's other connection may have taken the first one's place: channels on the old one end.
      channels.onLink(peer, "the pair's other connection took its place");
      streams.onLink(peer, "the pair's other connection took its place");
      up(peer);
    },
    onDown: (peer, why) => {
      // What it held is not known any more (§6): `at` falls back to nobody, and its boards' serial HELLOs are taken.
      // Which boards those were is kept, so device_list can say why each is `unknown`.
      const boards = remote.get(peer.id);
      remote.delete(peer.id);
      peerVersion.delete(peer.id);
      if (boards?.size) {
        lost.set(peer.id, { name: peer.name, devices: new Set(boards.keys()) });
      }
      calls.onDown(peer, why);
      channels.onLink(peer, why);
      streams.onLink(peer, why);
      registry.onDown(peer);
      events.onDown(peer);
      for (const h of boards?.values() ?? []) {
        tellRemote({ device: h.device, hub: { id: peer.id, name: peer.name }, up: false, fw: h.fw, links: [], away: true });
      }
    },
    onMessage: (peer, msg) => {
      if (!calls.onMessage(peer, msg) && !(liveMode() === 'on' && streams.onMessage(peer, msg)) && !channels.onMessage(peer, msg)) {
        message(peer, msg);
      }
    },
    onData: (peer, ch, bytes) => {
      if (!calls.onData(peer, ch, bytes) && !streams.onData(peer, ch, bytes)) {
        channels.onData(peer, ch, bytes);
      }
    },
    onSeen: (id, addr, port) => {
      try {
        noteSeen(db(), id, addr, port);
      } catch {
        // a note for the next dial only
      }
    },
    timing: opts.timing,
    log,
  });

  const slotOf = (hubId: string): number => listMembers(db()).find((m) => m.id === hubId)?.slot ?? 0;
  const asHub = (p: PeerView): PeerHub => ({ id: p.id, name: p.name, self: false, reachable: p.reachable, registry_hash: p.hello?.registry_hash ?? null, last_error: p.last_error, slot: slotOf(p.id) });

  const calls = new PeerCalls({
    links,
    serve: (peer, msg, input) =>
      server ? server(asHub(peer), msg, input) : Promise.resolve({ result: failed('HUB_VERSION_MISMATCH', `hub ${hubName(db())} does not take ops over the link`) }),
    log,
  });
  const channels = new PeerChannels({ links, log });
  const streams = new PeerStreams({ links, log });
  const events: EventRelay = createEventRelay({
    hub,
    links,
    heldAt: (deviceId, except) => heldAt(deviceId, except),
    mode: liveMode,
    tap: () => (testHub() ? (process.env.FR_TEST_PEER_EVENTS_TAP ?? null) : null),
    limits: opts.events,
    log,
  });

  // ---- presence out ----

  /** What this hub would say of a board now: null when it holds no session with it. The links in one fixed order. */
  const held = (deviceId: string): Held | null => {
    const info = routerInfo(hub().router, deviceId);
    if (!info || !isUp(info.presence) || !info.links.length) {
      return null;
    }
    return { device: deviceId, links: LINK_ORDER.filter((l) => (info.links as string[]).includes(l)), fw: info.fw_id_prefix, epoch: info.epoch };
  };

  /** A board's session here started, ended or changed its links: the peers hear of it when what they know differs. */
  const changed = (deviceId: string) => {
    const h = held(deviceId);
    const json = h ? JSON.stringify(h) : null;
    if ((told.get(deviceId)?.json ?? null) === json) {
      return;
    }
    if (h) {
      told.set(deviceId, { json: json!, held: h });
    } else {
      told.delete(deviceId);
    }
    links.broadcast({ t: 'presence', v: 1, full: false, up: h ? [h] : [], gone: h ? [] : [deviceId] });
  };

  /**
   * Every board this hub holds or said it holds, against what the router says now. The bus tells of a session that
   * became ready or ended; a link whose handshake never finished, or one that was added to a board already online,
   * changes what `held` answers without an event, so this also runs every RECONCILE_MS while a peer listens.
   */
  const reconcile = () => {
    for (const id of new Set([...(hub().router?.online() ?? []), ...told.keys()])) {
      changed(id);
    }
  };

  /** Everything this hub holds, for a link that just came up: the peers are brought to it first, then it is sent whole. */
  const snapshot = (): PresenceMsg => {
    reconcile();
    return { t: 'presence', v: 1, full: true, up: [...told.values()].map((x) => x.held), gone: [] };
  };

  const onEvent = (e: HubEvent) => {
    if (e.device && (e.type === 'device.online' || e.type === 'device.offline' || e.type === 'device.link')) {
      changed(e.device);
    }
  };

  // ---- the link's events ----

  const membersMsg = (): MembersMsg => ({ t: 'members', v: 1, version: membersVersion(db()), members: listMembers(db()).map(publicMember) });

  const up = (peer: PeerView) => {
    // Its snapshot follows on this connection and replaces what it said before (a pair's second connection taking
    // the first one's place keeps the peer reachable, and what it held known, in between).
    const theirs = peer.hello?.members_version ?? 0;
    peerVersion.set(peer.id, theirs);
    if (membersVersion(db()) > theirs) {
      links.send(peer.id, membersMsg());
      peerVersion.set(peer.id, membersVersion(db()));
    }
    links.send(peer.id, snapshot());
    // The registry after the member list and who is where: each end says what it holds, and gets what it lacks.
    registry.onUp(peer);
    // Then what this hub's boards last said, its running jobs and its prompts; its events follow as they happen.
    events.onUp(peer);
  };

  /** A serial session with a board that a peer now holds over Wi-Fi is one the board gave up: ended here at once. */
  const yieldSerial = (deviceId: string, peerName: string) => {
    hub().router.yieldSerial?.(deviceId, `held by hub ${peerName} over Wi-Fi`);
  };

  const message = (peer: PeerView, msg: PeerMessage) => {
    if (msg.t === 'presence') {
      let boards = remote.get(peer.id);
      const before = boards;
      if (!boards || msg.full) {
        boards = new Map();
        remote.set(peer.id, boards);
        // It is back and says what it holds now: what it held when it went away is history.
        lost.delete(peer.id);
      }
      const now = Date.now();
      const who = { id: peer.id, name: peer.name };
      for (const h of msg.up) {
        boards.set(h.device, { ...h, since: (msg.full ? before : boards)?.get(h.device)?.since ?? now });
        // Seen at a hub: no longer "last seen at one that is away".
        for (const l of lost.values()) {
          l.devices.delete(h.device);
        }
        if (h.links.includes('tcp')) {
          yieldSerial(h.device, peer.name);
        }
        tellRemote({ device: h.device, hub: who, up: true, fw: h.fw, links: h.links });
      }
      for (const id of msg.gone) {
        const was = boards.get(id);
        if (boards.delete(id)) {
          events.forget(peer.id, id);
          tellRemote({ device: id, hub: who, up: false, fw: was?.fw ?? null, links: [] });
        }
      }
      if (msg.full && before) {
        for (const [id, was] of before) {
          if (!boards.has(id)) {
            events.forget(peer.id, id);
            tellRemote({ device: id, hub: who, up: false, fw: was.fw, links: [] });
          }
        }
      }
      return;
    }
    if (msg.t === 'members') {
      peerVersion.set(peer.id, msg.version);
      takeMembers(peer, msg);
      return;
    }
    if (msg.t === 'registry') {
      if (!registry.onMessage(peer, msg)) {
        links.counters.unknown++; // a hub that does not replicate drops it as a type it does not know
      }
      return;
    }
    if (msg.t === 'event' && !events.onMessage(peer, msg)) {
      links.counters.unknown++; // a hub that relays no events drops it likewise
    }
  };

  /** A newer member list from a peer: stored, the link brought in line, and passed on to peers that hold an older one. */
  const takeMembers = (peer: PeerView, msg: MembersMsg) => {
    if (msg.version <= membersVersion(db())) {
      return;
    }
    const me = hubIdentity(db());
    const mine = msg.members.find((m) => m.id === me.id);
    const slots = new Set(msg.members.map((m) => m.slot));
    const names = new Set(msg.members.map((m) => m.name));
    if (!mine || mine.slot !== me.slot || slots.size !== msg.members.length || names.size !== msg.members.length || !msg.members.some((m) => m.slot === 0)) {
      // A list that leaves this hub out, moves its slot, or is not one list: not taken (a slot never changes).
      console.error(JSON.stringify({ event: 'peer_members_refused', from: peer.name, version: msg.version, why: !mine ? 'this hub is not in it' : mine.slot !== me.slot ? 'it gives this hub another slot' : 'it is not a consistent list' }));
      return;
    }
    replaceMembers(db(), msg.members.map(publicMember), msg.version);
    console.log(JSON.stringify({ event: 'peer_members', from: peer.name, version: msg.version, members: msg.members.map((m) => m.name) }));
    void refresh().catch((e: unknown) => console.error(JSON.stringify({ event: 'peer_refresh_failed', message: (e as Error).message })));
  };

  /** Every reachable peer that holds an older list gets this hub's. */
  const spreadMembers = () => {
    const version = membersVersion(db());
    if (!version) {
      return;
    }
    for (const p of links.views()) {
      if (p.reachable && (peerVersion.get(p.id) ?? 0) < version && links.send(p.id, membersMsg())) {
        peerVersion.set(p.id, version);
      }
    }
  };

  const refresh = async () => {
    loadKey();
    if (!started) {
      return;
    }
    await links.sync();
    spreadMembers();
  };

  const ownName = () => hubName(db());

  /** The reachable peer that holds `deviceId`; one with its TCP session first (a stale USB session elsewhere loses). */
  const holderView = (deviceId: string, tcpOnly: boolean): PeerView | null => {
    let found: PeerView | null = null;
    for (const p of links.views()) {
      if (!p.reachable) {
        continue;
      }
      const h = remote.get(p.id)?.get(deviceId);
      if (!h) {
        continue;
      }
      if (h.links.includes('tcp')) {
        return p;
      }
      if (!tcpOnly) {
        found ??= p;
      }
    }
    return found;
  };
  const holder = (deviceId: string, tcpOnly: boolean): string | null => holderView(deviceId, tcpOnly)?.name ?? null;

  /** The hub that holds `deviceId` in this hub's view of the network, leaving out `except` (a hub id). */
  const heldAt = (deviceId: string, except?: string): string | null => {
    const me = hubIdentity(db());
    if (except !== me.id && isUp(hub().router?.presence(deviceId))) {
      return me.name;
    }
    let found: string | null = null;
    for (const p of links.views()) {
      if (!p.reachable || p.id === except) {
        continue;
      }
      const h = remote.get(p.id)?.get(deviceId);
      if (h?.links.includes('tcp')) {
        return p.name;
      }
      if (h) {
        found ??= p.name;
      }
    }
    return found;
  };

  const gone = (hubId: string, what: string): PeerView => ({ id: hubId, name: listMembers(db()).find((m) => m.id === hubId)?.name ?? hubId, reachable: false, since: null, hello: null, address: null, direction: null, rtt_ms: null, last_error: what, conn: null });

  return {
    async start() {
      started = true;
      loadKey();
      unsubscribe = hub().events.subscribe(onEvent);
      reconciler = setInterval(
        guarded('peers.presence', () => {
          if (links.views().some((p) => p.reachable)) {
            reconcile();
          }
        }),
        RECONCILE_MS,
      );
      reconciler.unref();
      registry.start();
      events.start();
      await links.sync();
      // The registrar's own row follows where it is now (a LAN address or a link port that changed since it was
      // written): the members then hear of it. A member's row is the registrar's to change, at its next join.
      if (key && !registrarOf(db()) && listMembers(db()).length) {
        try {
          if (putRegistrar(db(), await ownClaim(hub()))) {
            bumpMembers(db());
            await refresh();
          }
        } catch (e) {
          console.error(JSON.stringify({ event: 'peer_own_row_failed', message: (e as Error).message }));
        }
      }
    },
    async stop() {
      started = false;
      unsubscribe?.();
      unsubscribe = null;
      if (reconciler) {
        clearInterval(reconciler);
        reconciler = null;
      }
      calls.stop();
      channels.stop();
      streams.stop();
      events.stop();
      registry.stop();
      await links.stop();
      remote.clear();
      lost.clear();
      told.clear();
    },
    registryHash,
    holder(deviceId) {
      const p = holderView(deviceId, false);
      return p ? asHub(p) : null;
    },
    heldFw(deviceId) {
      const p = holderView(deviceId, false);
      return p ? (remote.get(p.id)?.get(deviceId)?.fw ?? null) : null;
    },
    lastHolder(deviceId) {
      if (isUp(hub().router?.presence(deviceId)) || holderView(deviceId, false)) {
        return null;
      }
      for (const [id, l] of lost) {
        if (l.devices.has(deviceId)) {
          return { id, name: listMembers(db()).find((m) => m.id === id)?.name ?? l.name };
        }
      }
      return null;
    },
    hubs() {
      const me = hubIdentity(db());
      const views = new Map(links.views().map((p) => [p.id, p]));
      return listMembers(db()).map((m) => {
        if (m.id === me.id) {
          return { id: m.id, name: m.name, self: true, reachable: true, registry_hash: registryHash(), last_error: null, slot: m.slot };
        }
        const v = views.get(m.id);
        return v ? asHub(v) : { id: m.id, name: m.name, self: false, reachable: false, registry_hash: null, last_error: key ? 'not connected yet' : 'this hub holds no network key', slot: m.slot };
      });
    },
    hubOfRun(runNo) {
      const me = hubIdentity(db());
      if (runNo === hub().logs.run) {
        return { id: me.id, name: me.name, self: true, reachable: true, registry_hash: registryHash(), last_error: null, slot: me.slot ?? 0 };
      }
      // The slot this hub's own runs carry now (a hub that got its slot and has not restarted still counts in the old one).
      const slot = runSlot(runNo);
      if (slot === runSlot(hub().logs.run)) {
        return null; // an earlier run of this hub
      }
      return this.hubs().find((h) => !h.self && h.slot === slot) ?? null;
    },
    heldAt,
    events,
    streams: {
      speaks: (hubId) => liveMode() === 'on' && typeof links.view(hubId)?.hello?.streams === 'number',
      relay: (hubId, hello, sink) => streams.relay(links.view(hubId) ?? gone(hubId, 'it is not a member of this network'), hello, sink),
      serve: (fn) => streams.serve(fn),
    },
    call(hubId, op, input, o) {
      return calls.call(links.view(hubId) ?? gone(hubId, 'it is not a member of this network'), op, input, o);
    },
    serve(fn) {
      server = fn;
    },
    pull(hubId, kind, ref, dest, o) {
      return channels.pull(links.view(hubId) ?? gone(hubId, 'it is not a member of this network'), kind, ref, dest, o);
    },
    provide(kind, fn) {
      channels.provide(kind, fn);
    },
    onRemote(fn) {
      remoteListeners.add(fn);
      return () => remoteListeners.delete(fn);
    },
    at(deviceId) {
      return isUp(hub().router?.presence(deviceId)) ? ownName() : holder(deviceId, false);
    },
    heldOverTcp(deviceId) {
      return holder(deviceId, true);
    },
    refresh,
    async listen() {
      return started ? links.listen() : null;
    },
    status() {
      const heldBy: Record<string, number> = {};
      for (const p of links.views()) {
        if (p.reachable) {
          heldBy[p.id] = remote.get(p.id)?.size ?? 0;
        }
      }
      return {
        keyed: key !== null,
        link: { listening: links.port() !== null, port: links.port(), error: links.listenError() },
        members: listMembers(db()),
        members_version: membersVersion(db()),
        peers: links.views(),
        held: heldBy,
        counters: {
          ...links.counters,
          ...calls.counters,
          ...channels.counters,
          calls_pending: calls.pending(),
          channels_open: channels.open(),
          ...registry.status().counters,
          ...events.status().counters,
          ...streams.counters,
          streams_open: streams.open().opened + streams.open().served,
        },
        registry: registry.status(),
        events: events.status().peers,
        streams: Object.fromEntries(links.views().map((p) => [p.id, { speaks: liveMode() === 'on' && typeof p.hello?.streams === 'number', open: streams.openWith(p.id) }])),
      };
    },
    registry,
    warnings() {
      const out: string[] = [];
      const me = hubIdentity(db());
      if (me.slot !== null && !epochInSlot(hub().hubEpoch, me.slot)) {
        out.push(
          `this hub run's epoch (${hub().hubEpoch}) is outside its epoch slot ${me.slot} (${me.slot * EPOCH_SLOT_SIZE + 1}..${(me.slot + 1) * EPOCH_SLOT_SIZE - 1}): restart this hub (fr hub restart) before boards use more than one hub, so a board never takes two hubs for one hub run`,
        );
      }
      // A hub that got its slot while it ran: its cursors still read as the registrar's until it restarts (said once:
      // the epoch's line above asks for the same restart).
      if (me.slot !== null && epochInSlot(hub().hubEpoch, me.slot) && !runInSlot(hub().logs.run, me.slot)) {
        out.push(`this hub run's cursors (run ${hub().logs.run}) do not carry its slot ${me.slot} yet, so another hub may take one for the registrar's: restart this hub (fr hub restart)`);
      }
      // A peer on another op registry: who is where still crosses, an op does not (design multi-hub-m2 §3.3).
      const mine = registryHash();
      for (const p of links.views()) {
        if (p.reachable && p.hello && p.hello.registry_hash !== mine) {
          out.push(`hub ${p.name} runs another version (its op registry is ${p.hello.registry_hash}, this hub's ${mine}): the two hubs say who is where but pass no op to each other; update both to one version and restart each (fr hub restart)`);
        }
      }
      if (key && links.listenError()) {
        out.push(`the hubs' link is not listening (${links.listenError()}): other hubs cannot dial this one (it still dials them)`);
      }
      if (registrarOf(db()) && !key && started) {
        const reg = registrarOf(db())!;
        out.push(`this hub joined the network of ${reg.hub_host ?? reg.url} before the hubs' link and holds no network key: join it again (fr net join --hub ${reg.url}) to get its key, name and epoch slot`);
      }
      // The one registry: a peer that does not replicate, a row two hubs disagree on, a board that lost its alias.
      out.push(...registry.warnings());
      // Live data: a peer that relays no events, events that were dropped because a link was slow.
      out.push(...events.warnings());
      return out;
    },
  };
}

/** The name of the hub that holds a board's session, for a context with or without the peers part (a test's). */
export function boardAt(hub: Pick<HubContext, 'db'> & Partial<Pick<HubContext, 'router' | 'peers'>>, deviceId: string): string | null {
  if (hub.peers) {
    return hub.peers.at(deviceId);
  }
  return isUp(hub.router?.presence(deviceId)) ? hubName(hub.db) : null;
}

/**
 * A board's presence as an op's answer shows it for the whole network (design multi-hub-m2 §6). This hub's own when it
 * holds the board's session (`online`: it can command it now); `online` with `at` when a reachable peer reports the
 * session (an op for it is passed there); `unknown` with why when the hub that last reported it is away. The router's
 * own presence, which every internal rule reads, is not changed by this.
 */
export function presenceView(hub: Pick<HubContext, 'db'> & Partial<Pick<HubContext, 'router' | 'peers'>>, deviceId: string): { presence: Presence; at: string | null; presence_reason?: string } {
  const own: Presence = hub.router?.presence(deviceId) ?? 'unknown';
  if (isUp(own) || !hub.peers) {
    return { presence: own, at: isUp(own) ? hubName(hub.db) : null };
  }
  const held = hub.peers.holder(deviceId);
  if (held) {
    return { presence: 'online', at: held.name };
  }
  const last = hub.peers.lastHolder(deviceId);
  if (last) {
    return { presence: 'unknown', at: last.name, presence_reason: `hub ${last.name} is not reachable` };
  }
  return { presence: own, at: null };
}

/** `presenceView`'s presence alone: what a selector's `online` and `offline` mean in an op that covers the network. */
export function netPresence(hub: Pick<HubContext, 'db'> & Partial<Pick<HubContext, 'router' | 'peers'>>): (deviceId: string) => Presence {
  return (id) => presenceView(hub, id).presence;
}

/** This hub's own member claim: what it tells a registrar (or, as the registrar, its own row). */
export async function ownClaim(hub: HubContext): Promise<{ id: string; name: string; host: string; addr: string | null; link_port: number }> {
  const me = hubIdentity(hub.db);
  const where = advertised(hub.run);
  const port = (await hub.peers?.listen()) ?? null;
  return { id: me.id, name: me.name, host: where.host || hostname(), addr: where.addr, link_port: port ?? peerPortOf(hub.run) };
}

/** hub_peers: every member as this hub sees it now. ENV_MISSING while the hub is alone. */
export function peersView(hub: HubContext): {
  net_id: number;
  hub: ReturnType<typeof hubIdentity>;
  registrar: string;
  members_version: number;
  link: PeersStatus['link'];
  peers: HubPeer[];
  counters: Record<string, number>;
  registry?: { rows: number; tombstones: number; hash: string; conflicts: RegistryStatus['conflicts'] };
} {
  const me = hubIdentity(hub.db);
  const members: (HubMember & Partial<MemberRow>)[] = listMembers(hub.db);
  const net = fleetNetId(hub.db);
  const st = hub.peers?.status();
  if (!members.length || net === null || (st && !st.keyed)) {
    const reg = registrarOf(hub.db);
    throw reg
      ? new FrError('ENV_MISSING', `this hub joined the network of ${reg.hub_host ?? reg.url} before the hubs' link and holds no network key, so it has no link to that hub`, {
          hint: `join it again to get the key, a name and an epoch slot: fr net join --hub ${reg.url}`,
          remediation: [{ tool: 'network_join', args: { hub: reg.url }, cli: `fr net join --hub ${reg.url}` }],
        })
      : new FrError('ENV_MISSING', 'this hub is alone in its network: no hub has joined it and it has joined none, so there is no network key and no link', {
          hint: "to join another hub's network: fr net join --hub <that hub's API>; to let another hub in, run that on the other hub with this hub's API",
          remediation: [{ tool: 'network_join', cli: "fr net join --hub <the other hub's API, e.g. http://127.0.0.1:7520>" }],
        });
  }
  const views = new Map((st?.peers ?? []).map((p) => [p.id, p]));
  const where = advertised(hub.run);
  const peers: HubPeer[] = members.map((m) => {
    if (m.id === me.id) {
      return {
        id: m.id,
        name: m.name,
        this: true,
        role: m.slot === 0 ? ('registrar' as const) : ('member' as const),
        slot: m.slot,
        host: m.host,
        reachable: true,
        since: new Date(hub.startedAt).toISOString(),
        registry_hash: hub.peers?.registryHash() ?? REGISTRY_HASH,
        hub_epoch: hub.hubEpoch,
        boards: hub.router?.online().length ?? 0,
        address: st?.link.port ? `${where.addr ?? where.host}:${st.link.port}` : null,
        ...(st ? { registry: { speaks: st.registry.speaks, in_step: true, rows: st.registry.rows + st.registry.tombstones } } : {}),
      };
    }
    const reg = st?.registry.peers[m.id];
    const v = views.get(m.id);
    return {
      id: m.id,
      name: m.name,
      this: false,
      role: m.slot === 0 ? ('registrar' as const) : ('member' as const),
      slot: m.slot,
      host: m.host,
      reachable: v?.reachable ?? false,
      since: v?.since != null ? new Date(v.since).toISOString() : null,
      registry_hash: v?.hello?.registry_hash ?? null,
      hub_epoch: v?.hello?.hub_epoch ?? null,
      boards: v?.reachable ? (st?.held[m.id] ?? 0) : null,
      address: v?.address ?? null,
      ...(v?.direction ? { direction: v.direction } : {}),
      ...(v?.rtt_ms != null ? { rtt_ms: v.rtt_ms } : {}),
      ...(v && !v.reachable && v.last_error ? { last_error: v.last_error } : {}),
      // The one registry with this peer, in this hub run: null `in_step` while it is away or has not said what it holds.
      ...(reg ? { registry: { ...reg } } : {}),
      // Live data with this peer, in this hub run (design multi-hub-m2 §8): events sent, taken and dropped; relayed streams open.
      ...(st?.events[m.id] ? { events: { ...st.events[m.id] } } : {}),
      ...(st?.streams[m.id] ? { streams: { ...st.streams[m.id] } } : {}),
    };
  });
  return {
    net_id: net,
    hub: me,
    registrar: members.find((m) => m.slot === 0)?.name ?? me.name,
    members_version: membersVersion(hub.db),
    link: st?.link ?? { listening: false, port: null, error: null },
    peers,
    // The link's counters since this hub started: handshakes refused, peers gone silent, calls in and out, data channels.
    counters: st?.counters ?? {},
    ...(st ? { registry: { rows: st.registry.rows, tombstones: st.registry.tombstones, hash: st.registry.hash, conflicts: st.registry.conflicts } } : {}),
  };
}
