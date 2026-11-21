// One registry across the hubs of a network (design multi-hub-m2 §5, §16), the part on the link: what registry/sync.ts
// stamps and merges, carried between hubs by the `registry` message (wire.ts).
//
//   - When a link comes up each end sends its digest (every row as `[device id, hash]`), and again every DIGEST_MS.
//     A hub answers a digest with the rows it holds otherwise than the sender (or that the sender lacks); the sender of
//     those merges them and answers with the rows it then still holds otherwise, or with `state`. So a hub that was
//     away, restarted or just joined gets what it missed, both ways, in two messages each way.
//   - A change made here (an op, a job, a HELLO: sync.ts `scan` finds it, within SCAN_MS when nothing said so) is sent
//     to every reachable peer at once. A row a merge changed here is passed on too, so a hub with no link to the one
//     that wrote it still hears of it.
//   - What a merge did is acted on here: a new row is announced as a provisioning is (`device.provisioned`: the
//     DIRECTORY, apps), a new alias goes to the board when this hub holds it (the router's alias push) and is announced
//     as a rename is (`registry.drift`).
//   - A peer whose hello does not say `registry` (a hub of step 2.2) is sent nothing and is named in hub_status; one
//     that says it and answers nothing is counted (`registry_unanswered`) and named after three digests.
// Each peer's state is this hub run's: what it said it holds, what it was told, the rows sent and taken.
// The version is the message's own (`v`, said in the hello as `registry`), never the op registry's hash: two hubs on
// different versions of the ops keep each other's rows current while one is being updated.

import { appendFileSync } from 'node:fs';

import type { HubContext } from '../context.ts';
import { guarded } from '../crash.ts';
import { nowUs } from '../ring.ts';
import { applyRows, type Conflict, digest, type Effect, pruneTombstones, REGISTRY_WIRE, renamedRows, scan, syncCounts, type WireRow, wireHash, wireRows } from '../registry/sync.ts';
import { hubId } from './identity.ts';
import type { PeerView } from './link.ts';
import { type PeerMessage, REGISTRY_DIGEST_MAX, REGISTRY_ROWS_MAX, type RegistryMsg } from './wire.ts';

export interface RegistryTiming {
  /** How often `devices` is compared with what was stamped (a writer that said nothing is found this late). */
  scanMs: number;
  /** How often each peer is sent the digest again. */
  digestMs: number;
}

export const REGISTRY_TIMING: RegistryTiming = { scanMs: 1000, digestMs: 30_000 };
/** A peer that answered this many digests with nothing is named in hub_status, and asked less often. */
const UNANSWERED_WARN = 3;
/** One row goes back and forth between two hubs at most this often a minute; more is a merge that does not settle. */
const STORM_PER_MIN = 20;

/** The registry's state with one peer, in this hub run. */
export interface RegistryPeer {
  /** Its hello says it replicates the registry. */
  speaks: boolean;
  /** It holds the same registry as this hub; null before it said what it holds. */
  in_step: boolean | null;
  /** The rows it said it holds (tombstones included); null before it said. */
  rows: number | null;
  sent: number;
  received: number;
  /** Rows of its that this hub took as sent. */
  taken: number;
  conflicts: number;
  unanswered: number;
  /** ISO time of its last `registry` message. */
  heard_at: string | null;
}

export interface RegistryStatus {
  /** Whether this hub replicates at all (always, but for a test hub told not to). */
  speaks: boolean;
  rows: number;
  tombstones: number;
  hash: string;
  peers: Record<string, RegistryPeer>;
  conflicts: { device: string; hub: string; kind: string; message: string }[];
  counters: Record<string, number>;
}

export interface RegistrySync {
  start(): void;
  stop(): void;
  /** This hub's hello: the version it speaks, or undefined when it does not replicate. */
  hello(): number | undefined;
  onUp(peer: PeerView): void;
  onDown(peer: PeerView): void;
  /** A `registry` message from a peer; false when this hub does not take them (it is then counted as unknown). */
  onMessage(peer: PeerView, msg: RegistryMsg): boolean;
  /** Stamps what changed in `devices` and tells the peers; `ids` when the caller knows which rows. */
  flush(ids?: readonly string[]): void;
  /** Whether the peer replicates the registry with this hub (its hello says so, or it has sent a `registry` message). */
  replicates(hubId: string): boolean;
  status(): RegistryStatus;
  warnings(): string[];
}

interface PeerState extends Omit<RegistryPeer, 'in_step'> {
  name: string;
  /** Its hash over its whole registry, as it last said. */
  hash: string | null;
  /** The hash of each row as it last said it holds it, and as this hub last sent it. */
  heard: Map<string, string>;
  told: Map<string, string>;
  /** Digests sent since it was last asked (a silent peer is asked every fifth time). */
  skipped: number;
  storm: Map<string, { n: number; t0: number }>;
  differsSince: number | null;
}

export interface RegistrySyncDeps {
  hub(): HubContext;
  send(hubId: string, msg: PeerMessage): boolean;
  views(): PeerView[];
  /** A test hub only: `off` behaves as a hub of step 2.2, `mute` says it replicates and never does. */
  mode(): 'on' | 'off' | 'mute';
  /** A test hub only: a file every `registry` message sent and received is appended to, one JSON line each. */
  tap(): string | null;
  timing?: Partial<RegistryTiming>;
  log(line: Record<string, unknown>): void;
}

export function createRegistrySync(deps: RegistrySyncDeps): RegistrySync {
  const t = { ...REGISTRY_TIMING, ...deps.timing };
  const db = () => deps.hub().db;
  const self = () => ({ hubId: hubId(db()) });
  const peers = new Map<string, PeerState>();
  const conflicts = new Map<string, { device: string; hub: string; kind: string; message: string }>();
  const counters = {
    registry_rows_sent: 0,
    registry_rows_received: 0,
    registry_rows_taken: 0,
    registry_rows_bad: 0,
    registry_conflicts: 0,
    registry_renames: 0,
    registry_digests_sent: 0,
    registry_digests_received: 0,
    registry_unanswered: 0,
    registry_storms: 0,
  };
  let scanner: NodeJS.Timeout | null = null;
  let digester: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;
  let started = false;
  /** This hub's own digest, kept until a row's stamps change. */
  let mine: ReturnType<typeof digest> | null = null;
  let mineById: Map<string, string> | null = null;

  const own = () => {
    if (!mine) {
      mine = digest(db());
      mineById = new Map(mine.rows);
    }
    return mine;
  };
  const ownHash = (id: string) => {
    own();
    return mineById!.get(id) ?? null;
  };
  const dirty = () => {
    mine = null;
    mineById = null;
  };

  const tapped = (dir: 'tx' | 'rx', peer: string, msg: PeerMessage) => {
    const file = deps.tap();
    if (file) {
      try {
        appendFileSync(file, `${JSON.stringify({ dir, peer, msg })}\n`);
      } catch {
        // a test's tap only
      }
    }
  };

  const send = (p: PeerState, id: string, msg: RegistryMsg): boolean => {
    tapped('tx', p.name, msg);
    return deps.send(id, msg);
  };

  const stateOf = (peer: PeerView): PeerState => {
    let p = peers.get(peer.id);
    if (!p) {
      p = { name: peer.name, speaks: false, rows: null, sent: 0, received: 0, taken: 0, conflicts: 0, unanswered: 0, heard_at: null, hash: null, heard: new Map(), told: new Map(), skipped: 0, storm: new Map(), differsSince: null };
      peers.set(peer.id, p);
    }
    p.name = peer.name;
    return p;
  };

  const speaking = () =>
    deps
      .views()
      .filter((v) => v.reachable && peers.get(v.id)?.speaks)
      .map((v) => [v.id, peers.get(v.id)!] as const);

  const head = (k: RegistryMsg['k']) => ({ t: 'registry' as const, v: REGISTRY_WIRE, k, hash: own().hash, n: own().rows.length });

  /** Rows `ids` to one peer, in messages of at most REGISTRY_ROWS_MAX; each row is then what the peer was told. */
  const sendRows = (id: string, p: PeerState, ids: readonly string[]): number => {
    let n = 0;
    for (let i = 0; i < ids.length; i += REGISTRY_ROWS_MAX) {
      const rows = wireRows(db(), ids.slice(i, i + REGISTRY_ROWS_MAX));
      if (!rows.length || !send(p, id, { ...head('rows'), rows } as RegistryMsg)) {
        break;
      }
      for (const r of rows) {
        p.told.set(r.id, ownHash(r.id) ?? '');
      }
      n += rows.length;
    }
    p.sent += n;
    counters.registry_rows_sent += n;
    return n;
  };

  const sendDigest = (id: string, p: PeerState) => {
    const d = own();
    if (d.rows.length > REGISTRY_DIGEST_MAX) {
      deps.log({ event: 'registry_digest_cut', rows: d.rows.length, sent: REGISTRY_DIGEST_MAX });
    }
    if (send(p, id, { ...head('digest'), digest: d.rows.slice(0, REGISTRY_DIGEST_MAX) } as RegistryMsg)) {
      counters.registry_digests_sent++;
      p.unanswered++;
      if (p.unanswered > 1) {
        counters.registry_unanswered++;
      }
    }
  };

  /** The rows this hub holds otherwise than `p` said it does, and has not sent it as they are now. */
  const owed = (p: PeerState, ids: Iterable<string>): string[] => {
    const out: string[] = [];
    for (const id of ids) {
      const h = ownHash(id);
      if (h !== null && p.heard.get(id) !== h && p.told.get(id) !== h) {
        out.push(id);
      }
    }
    return out;
  };

  /** Whether one row has gone back and forth with `p` too often to be a merge that settles. */
  const storming = (p: PeerState, id: string): boolean => {
    const now = Date.now();
    const s = p.storm.get(id);
    if (!s || now - s.t0 > 60_000) {
      p.storm.set(id, { n: 1, t0: now });
      return false;
    }
    s.n++;
    if (s.n === STORM_PER_MIN + 1) {
      counters.registry_storms++;
      deps.log({ event: 'registry_storm', peer: p.name, device: id });
    }
    return s.n > STORM_PER_MIN;
  };

  /** Rows whose stamps changed here go to every peer that does not hold them so, but `except` (which sent them). */
  const spread = (ids: readonly string[], except?: string) => {
    if (!ids.length) {
      return;
    }
    for (const [id, p] of speaking()) {
      if (id !== except) {
        const due = owed(p, ids);
        if (due.length) {
          sendRows(id, p, due);
        }
      }
    }
  };

  const act = (effects: readonly Effect[], from: string) => {
    const hub = deps.hub();
    let directory = false;
    for (const e of effects) {
      try {
        if (e.kind === 'new') {
          if (e.provisioned && e.addr !== null) {
            // As a provisioning here announces a board: the router's DIRECTORY and the apps follow the event.
            hub.events.publish({ type: 'device.provisioned', device: e.device, alias: e.alias, t_hub_us: nowUs(), fields: { addr: e.addr, replicated: true, from } });
          }
        } else if (e.kind === 'alias') {
          if (e.renamed) {
            counters.registry_renames++;
            deps.log({ event: 'registry_renamed', device: e.device, alias: e.alias, previous: e.previous });
          }
          // The board is told by the hub that holds it: here when its session is here (the router's alias push, with
          // the higher alias_rev), else by its holder when this row reaches it.
          hub.router?.pushAlias(e.device);
          hub.events.publish({
            type: 'registry.drift',
            device: e.device,
            alias: e.alias,
            t_hub_us: nowUs(),
            fields: { alias: e.alias, alias_rev: e.alias_rev, previous_alias: e.previous, replicated: true, from, ...(e.renamed ? { renamed: true } : {}) },
          });
        } else if (e.kind === 'row') {
          if (e.provisioned !== undefined) {
            // A row this hub held without an identity (an address the registrar just gave, a board another hub then flashed).
            hub.events.publish({ type: 'device.provisioned', device: e.device, alias: e.alias, t_hub_us: nowUs(), fields: { addr: e.provisioned, replicated: true, from } });
          } else {
            directory ||= e.addr_changed;
          }
        } else {
          directory = true;
          hub.events.publish({ type: 'registry.drift', device: e.device, alias: e.alias, t_hub_us: nowUs(), fields: { removed: true, replicated: true, from } });
        }
      } catch (err) {
        console.error(JSON.stringify({ event: 'registry_effect_failed', device: e.device, message: (err as Error).message }));
      }
    }
    if (directory) {
      (hub.router as { syncDirectory?(): void } | undefined)?.syncDirectory?.();
    }
  };

  const note = (peer: PeerView, p: PeerState, found: readonly Conflict[], rows: readonly WireRow[]) => {
    for (const r of rows) {
      if (typeof r?.id === 'string') {
        conflicts.delete(`${peer.id}/${r.id}`);
      }
    }
    for (const c of found) {
      if (c.kind === 'bad') {
        counters.registry_rows_bad++;
      }
      counters.registry_conflicts++;
      p.conflicts++;
      const key = `${peer.id}/${c.device}`;
      if (!conflicts.has(key)) {
        deps.log({ event: 'registry_conflict', peer: peer.name, device: c.device, kind: c.kind, message: c.message });
      }
      conflicts.set(key, { device: c.device, hub: peer.name, kind: c.kind, message: c.message });
    }
  };

  /** A copy that was not taken is settled once the two hubs hold that row alike (a person changed one of them). */
  const settled = (peer: PeerView, p: PeerState) => {
    const all = p.hash !== null && p.hash === own().hash;
    for (const [key, c] of conflicts) {
      if (key.startsWith(`${peer.id}/`) && (all || (p.heard.has(c.device) && p.heard.get(c.device) === ownHash(c.device)))) {
        conflicts.delete(key);
      }
    }
  };

  const flush = (ids?: readonly string[]) => {
    if (deps.mode() !== 'on') {
      return;
    }
    let changed: string[];
    try {
      changed = scan(db(), self(), ids);
    } catch (e) {
      console.error(JSON.stringify({ event: 'registry_scan_failed', message: (e as Error).message }));
      return;
    }
    if (changed.length) {
      dirty();
      spread(changed);
    }
  };

  const onEvent = (e: { type: string; device?: string | null; fields?: Record<string, unknown> | null }) => {
    // What an op or a job just wrote, told at once; anything else is found by the scan.
    if ((e.type === 'device.provisioned' || e.type === 'registry.drift') && e.device && e.fields?.replicated !== true) {
      flush();
    }
  };

  return {
    start() {
      started = true;
      try {
        const pruned = pruneTombstones(db());
        if (pruned) {
          deps.log({ event: 'registry_tombstones_pruned', n: pruned });
        }
      } catch {
        // tried again at the next start
      }
      flush();
      unsubscribe = deps.hub().events.subscribe(onEvent);
      scanner = setInterval(guarded('peers.registry.scan', () => flush()), t.scanMs);
      scanner.unref();
      digester = setInterval(
        guarded('peers.registry.digest', () => {
          if (deps.mode() !== 'on') {
            return;
          }
          for (const [id, p] of speaking()) {
            // A peer that answers nothing is asked every fifth time: it costs it one dropped message each.
            if (p.unanswered >= UNANSWERED_WARN && ++p.skipped % 5 !== 0) {
              continue;
            }
            sendDigest(id, p);
          }
        }),
        t.digestMs,
      );
      digester.unref();
    },
    stop() {
      started = false;
      unsubscribe?.();
      unsubscribe = null;
      if (scanner) {
        clearInterval(scanner);
        scanner = null;
      }
      if (digester) {
        clearInterval(digester);
        digester = null;
      }
      peers.clear();
    },
    hello() {
      return deps.mode() === 'off' ? undefined : REGISTRY_WIRE;
    },
    onUp(peer) {
      // A new connection: what was told on the old one may not have arrived, so nothing counts as told.
      const p = stateOf(peer);
      p.speaks = typeof peer.hello?.registry === 'number';
      p.heard = new Map();
      p.told = new Map();
      p.hash = null;
      p.rows = null;
      p.unanswered = 0;
      p.skipped = 0;
      p.differsSince = null;
      if (!p.speaks || deps.mode() !== 'on' || !started) {
        return;
      }
      flush();
      sendDigest(peer.id, p);
    },
    onDown(peer) {
      const p = peers.get(peer.id);
      if (p) {
        p.hash = null;
        p.rows = null;
        p.heard = new Map();
        p.told = new Map();
      }
    },
    onMessage(peer, msg) {
      if (deps.mode() === 'off') {
        return false;
      }
      tapped('rx', peer.name, msg);
      if (deps.mode() === 'mute' || !started) {
        return true;
      }
      const p = stateOf(peer);
      p.speaks = true;
      p.unanswered = 0;
      p.skipped = 0;
      p.heard_at = new Date().toISOString();
      p.hash = msg.hash;
      p.rows = msg.n;
      if (msg.k === 'state') {
        settled(peer, p);
        return true;
      }
      flush(); // this hub's own writes get their revs before another hub's copy is compared with them
      if (msg.k === 'digest') {
        counters.registry_digests_received++;
        p.heard = new Map(msg.digest ?? []);
        settled(peer, p);
        const due = owed(p, own().rows.map(([id]) => id));
        if (!due.length || !sendRows(peer.id, p, due)) {
          send(p, peer.id, head('state') as RegistryMsg);
        }
        return true;
      }
      const rows = (msg.rows ?? []) as unknown as WireRow[];
      p.received += rows.length;
      counters.registry_rows_received += rows.length;
      for (const r of rows) {
        try {
          p.heard.set(r.id, wireHash(r));
        } catch {
          // a row that is not one: the merge counts it
        }
      }
      const report = applyRows(db(), self(), rows, peer.name);
      p.taken += report.taken;
      counters.registry_rows_taken += report.taken;
      note(peer, p, report.conflicts, rows);
      if (report.changed.length) {
        dirty();
      }
      act(report.effects, peer.name);
      settled(peer, p);
      // Passed on to the hubs that do not hold these rows so; back to the sender what this hub holds otherwise.
      spread(report.changed, peer.id);
      const back = owed(p, report.differ).filter((id) => !storming(p, id));
      if (!back.length || !sendRows(peer.id, p, back)) {
        send(p, peer.id, head('state') as RegistryMsg);
      }
      return true;
    },
    flush,
    replicates(id) {
      return deps.mode() === 'on' && peers.get(id)?.speaks === true;
    },
    status() {
      const d = own();
      const counts = syncCounts(db());
      const out: Record<string, RegistryPeer> = {};
      const now = Date.now();
      for (const v of deps.views()) {
        const p = peers.get(v.id);
        if (!p) {
          continue;
        }
        const inStep = v.reachable && p.speaks && p.hash !== null ? p.hash === d.hash : null;
        p.differsSince = inStep === false ? (p.differsSince ?? now) : null;
        out[v.id] = { speaks: p.speaks, in_step: inStep, rows: p.rows, sent: p.sent, received: p.received, taken: p.taken, conflicts: p.conflicts, unanswered: p.unanswered, heard_at: p.heard_at };
      }
      return { speaks: deps.mode() === 'on', rows: counts.rows, tombstones: counts.tombstones, hash: d.hash, peers: out, conflicts: [...conflicts.values()], counters: { ...counters } };
    },
    warnings() {
      const out: string[] = [];
      if (deps.mode() !== 'on') {
        return out;
      }
      const st = this.status();
      for (const v of deps.views()) {
        const p = peers.get(v.id);
        if (!v.reachable || !p) {
          continue;
        }
        if (!p.speaks) {
          out.push(`hub ${v.name} does not replicate the registry (it runs a version from before the one registry, design multi-hub-m2 step 2.3): a board made or changed here is not known there, and the other way round; update that hub and restart it (fr hub restart)`);
        } else if (p.unanswered >= UNANSWERED_WARN) {
          out.push(`hub ${v.name} has not answered this hub's last ${p.unanswered} registry digests: the two registries may differ (fr hub peers shows the link)`);
        } else if (st.peers[v.id]?.in_step === false && p.differsSince !== null && Date.now() - p.differsSince > 2 * t.digestMs && !st.conflicts.some((c) => c.hub === v.name)) {
          out.push(`the registry of hub ${v.name} still differs from this hub's (${p.rows ?? '?'} rows there, ${st.rows + st.tombstones} here): fr hub peers shows the counters`);
        }
      }
      for (const c of st.conflicts) {
        out.push(
          c.kind === 'addr' || c.kind === 'addr_held'
            ? `registry: ${c.message}. An address is the registrar's to give: its row is the network's, and the board must carry that address (fr devices get id:${c.device} on each hub shows the two)`
            : `registry: ${c.message}`,
        );
      }
      try {
        for (const r of renamedRows(db())) {
          out.push(`${r.alias} (${r.device_id}) was renamed: another board was given its alias while two hubs could not see each other, and the later write kept it. Give it the name you want (fr devices set ${r.alias} --alias <name>), then take the tag off (fr devices set <name> --tag -renamed)`);
        }
      } catch {
        // a registry that cannot be read now
      }
      return out;
    },
  };
}
