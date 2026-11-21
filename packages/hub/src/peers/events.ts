// Events across the hubs' link (design multi-hub-m2 §8, §17, step 2.4): what one hub publishes, live at every other.
//
//   - Out. This part is a subscriber of this hub's own bus and of its job runner. Every event that crosses (below) is
//     queued for each reachable peer whose hello says `events` and written in batches (`event` messages, wire.ts), at
//     the end of the tick it was published in. Only this hub's own events are ever sent: an event a peer relayed never
//     reaches a plain subscriber of the bus (events/index.ts), so nothing is relayed twice, with any number of hubs.
//   - In. An event a peer sent is published live into this hub's bus (EventStore.relay): this hub's own seq and
//     cursor, `hub` (the sender's name), `hub_cursor` (its cursor there, where it is stored), and `t_hub_us` moved into
//     this hub's clock by the message's `now_us`. It is not written to this hub's events table.
//   - Bounded. A peer's queue holds at most QUEUE_MAX events and QUEUE_MAX_BYTES; nothing is written while more than
//     HIGH_WATER bytes wait on the connection, so the heartbeat, a call and a file never wait behind more than that
//     and one batch. A slow peer first loses old values of properties (a queued STATE gives way to a newer one of the
//     same property once the queue is behind), then its oldest events; the newest state of every property is the last
//     thing dropped. Both are counted, the peer is told how many events it missed (`dropped`), and hub_status warns.
//   - State. Each hub keeps the newest STATE of every property of the boards its peers hold (the mirror: what a `/ws`
//     subscription and an `/app` welcome show of a board at first), filled by a snapshot when a link comes up and by
//     the events after it, and forgotten when the board's session there ends or that hub goes away.
//   - Jobs and prompts. Changes of the jobs a peer runs (status, stage, progress) arrive as `jobs` and go to `/ws` job
//     subscriptions; a peer's pending prompts are kept for hub_status.
//
// What crosses, by type (`crosses`):
//   yes  every event about a board (it has `device`): capability EVENTs and STATEs, device.online, device.suspect,
//        device.offline, device.link, msg, op.called, ota.job.state, stream.* and audio.stream_*, hil.*, cell.*,
//        wiring.*; and of the hub's own: job.state, hub.prompt, hub.prompt_done.
//   no   device.provisioned and registry.drift (the registry replicates and publishes them at each hub, step 2.3);
//        port.* (a USB port belongs to one machine); hub.warning (one hub's own condition: fr --at <hub> hub status);
//        time.threshold (each hub computes Fractonica time itself); any other event without a device.
// The message has its own version (`v`, said in the hello as `events`), never the op registry's hash.

import { appendFileSync } from 'node:fs';

import { type HubEvent, HubEventSchema, type Job, type Prompt } from '@fractonica/protocol';

import type { HubContext } from '../context.ts';
import { mintCursor, tailEvents } from '../events/index.ts';
import type { JobChange } from '../jobs.ts';
import { nowUs } from '../ring.ts';
import { routerInfo } from '../router/index.ts';
import type { PeerLinks, PeerView } from './link.ts';
import { encodeControlJson, EVENT_BATCH_BYTES, EVENT_BATCH_MAX, type EventMsg, EVENTS_WIRE, type JobChangeMsg } from './wire.ts';

export interface EventRelayLimits {
  /** Events queued for one peer at most, and their bytes. */
  queueMax: number;
  queueMaxBytes: number;
  /** A queued STATE gives way to a newer one of its property once this many events wait. */
  coalesceAbove: number;
  /** Nothing is written to a connection with more than this queued on it. */
  highWater: number;
  /** A queue that could not be written is tried again this often. */
  retryMs: number;
  /** A drop is warned about in hub_status for this long. */
  warnMs: number;
}

export const EVENT_RELAY_LIMITS: EventRelayLimits = { queueMax: 4096, queueMaxBytes: 4 << 20, coalesceAbove: 64, highWater: 128 * 1024, retryMs: 25, warnMs: 10 * 60_000 };

/** STATEs kept per board in the mirror at most (a board has a few dozen properties). */
const MIRROR_MAX_PER_DEVICE = 512;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
/** Events of the hub itself (no device) that cross. */
const HUB_TYPES_THAT_CROSS: ReadonlySet<string> = new Set(['job.state', 'hub.prompt', 'hub.prompt_done']);
/** Events about a board that do not cross: the registry replicates and publishes these at each hub (step 2.3). */
const DEVICE_TYPES_THAT_STAY: ReadonlySet<string> = new Set(['device.provisioned', 'registry.drift']);

/** Whether an event of this hub's bus is sent to the peers. */
export function crosses(e: Pick<HubEvent, 'type' | 'device' | 'hub'>): boolean {
  if (e.hub !== undefined || e.type.startsWith('port.') || DEVICE_TYPES_THAT_STAY.has(e.type)) {
    return false;
  }
  return e.device !== undefined || HUB_TYPES_THAT_CROSS.has(e.type);
}

/** A job change a peer sent, as a `/ws` job frame shows it. */
export interface RemoteJob extends JobChangeMsg {
  /** The name of the hub that runs it. */
  hub: string;
}

/** How events stand with one peer, in this hub run (hub_peers). */
export interface EventsPeer {
  /** Its hello says it relays events. */
  speaks: boolean;
  sent: number;
  received: number;
  /** Events this hub did not send it (its queue was full), and values of properties replaced in the queue. */
  dropped: number;
  coalesced: number;
  /** Events it said it did not send this hub. */
  missed: number;
  /** Waiting now. */
  queued: number;
  /** Boards of its whose state this hub mirrors. */
  mirrored: number;
}

export interface EventRelay {
  start(): void;
  stop(): void;
  /** This hub's hello: the version it speaks, or undefined when it relays none. */
  hello(): number | undefined;
  onUp(peer: PeerView): void;
  onDown(peer: PeerView): void;
  /** An `event` message from a peer; false when this hub takes none (it is then counted as unknown). */
  onMessage(peer: PeerView, msg: EventMsg): boolean;
  /** The board's session at that peer ended: its mirrored state is forgotten. */
  forget(hubId: string, deviceId: string): void;
  /** Whether events of that peer's boards reach this hub (its hello says `events`, and this hub takes them). */
  relays(hubId: string): boolean;
  /** The newest STATE of each property of a board a peer holds, as events (`hub` set); [] for a board none holds. */
  states(deviceId: string): HubEvent[];
  /** The same as `<instance>.<property>` -> value; null for a board no reachable peer mirrors. */
  properties(deviceId: string): Record<string, unknown> | null;
  /** Jobs the peers run that have not ended, as each last said. */
  jobs(): RemoteJob[];
  /** Calls `fn` at each job change a peer sends; returns the unsubscribe. */
  onJob(fn: (job: RemoteJob) => void): () => void;
  /** The peers' pending prompts (hub_status `prompts`), each with `hub`. */
  prompts(): (Prompt & { hub: string })[];
  status(): { speaks: boolean; peers: Record<string, EventsPeer>; counters: Record<string, number> };
  warnings(): string[];
}

export interface EventRelayDeps {
  hub(): HubContext;
  links: Pick<PeerLinks, 'sendFrame' | 'backlog' | 'views'>;
  /**
   * The hub that holds a board's session as this hub sees the network, leaving out the hub `except` (by id): this
   * hub's own name, a reachable peer's, or null.
   */
  heldAt(deviceId: string, except: string): string | null;
  /** A test hub only: `off` behaves as a hub of step 2.3 (no `events` in its hello, none sent, none taken). */
  mode(): 'on' | 'off';
  /** A test hub only: a file every `event` message sent and received is appended to, one JSON line each. */
  tap(): string | null;
  limits?: Partial<EventRelayLimits>;
  log(line: Record<string, unknown>): void;
}

interface Item {
  seq: number;
  json: string;
  bytes: number;
  /** A STATE's property (`<device>\0<type>`): a newer one may take its place. */
  key?: string;
  dead?: boolean;
}

/** A FIFO with a moving head (shift on a large array is O(n)). */
class Fifo {
  items: Item[] = [];
  head = 0;
  /** Items not dead. */
  alive = 0;

  push(i: Item): void {
    this.items.push(i);
    this.alive++;
  }

  /** The oldest live item, without taking it. */
  peek(): Item | undefined {
    while (this.head < this.items.length && this.items[this.head].dead) {
      this.head++;
    }
    return this.items[this.head];
  }

  take(): Item | undefined {
    const i = this.peek();
    if (i) {
      this.head++;
      this.alive--;
      if (this.head > 1024 && this.head * 2 > this.items.length) {
        this.items = this.items.slice(this.head);
        this.head = 0;
      }
    }
    return i;
  }

  kill(i: Item): void {
    if (!i.dead) {
      i.dead = true;
      this.alive--;
    }
  }

  clear(): void {
    this.items = [];
    this.head = 0;
    this.alive = 0;
  }
}

interface Out {
  name: string;
  speaks: boolean;
  /** Events and STATEs wait apart, each in seq order, and are written merged: an overflow drops events first. */
  events: Fifo;
  states: Fifo;
  byKey: Map<string, Item>;
  bytes: number;
  jobs: Map<string, JobChangeMsg>;
  /** Dropped since the last message that said so. */
  untold: number;
  timer: NodeJS.Timeout | null;
  scheduled: boolean;
  sent: number;
  received: number;
  dropped: number;
  coalesced: number;
  missed: number;
  droppedAt: number;
  missedAt: number;
  dropLoggedAt: number;
}

const CHANGE_RANK: Record<string, number> = { progress: 0, stage: 1, status: 2 };

export function createEventRelay(deps: EventRelayDeps): EventRelay {
  const lim = { ...EVENT_RELAY_LIMITS, ...deps.limits };
  const outs = new Map<string, Out>();
  /** hub id -> device id -> event type -> the newest STATE. */
  const mirror = new Map<string, Map<string, Map<string, HubEvent>>>();
  /** hub id -> job id -> its last change, while it has not ended. */
  const remoteJobs = new Map<string, Map<string, RemoteJob>>();
  /** hub id -> prompt id -> the prompt. */
  const remotePrompts = new Map<string, Map<string, Prompt>>();
  const jobListeners = new Set<(job: RemoteJob) => void>();
  const counters = {
    events_sent: 0,
    events_received: 0,
    events_dropped: 0,
    events_coalesced: 0,
    events_missed: 0,
    events_bad: 0,
    event_msgs_out: 0,
    event_msgs_in: 0,
    jobs_sent: 0,
    jobs_received: 0,
  };
  let offEvents: (() => void) | null = null;
  let offJobs: (() => void) | null = null;
  let started = false;

  const on = () => deps.mode() === 'on';

  const tapped = (dir: 'tx' | 'rx', peer: string, json: string) => {
    const file = deps.tap();
    if (file) {
      try {
        appendFileSync(file, `{"dir":"${dir}","peer":${JSON.stringify(peer)},"msg":${json}}\n`);
      } catch {
        // a test's tap only
      }
    }
  };

  const outOf = (peer: PeerView): Out => {
    let o = outs.get(peer.id);
    if (!o) {
      o = { name: peer.name, speaks: false, events: new Fifo(), states: new Fifo(), byKey: new Map(), bytes: 0, jobs: new Map(), untold: 0, timer: null, scheduled: false, sent: 0, received: 0, dropped: 0, coalesced: 0, missed: 0, droppedAt: 0, missedAt: 0, dropLoggedAt: 0 };
      outs.set(peer.id, o);
    }
    o.name = peer.name;
    return o;
  };

  const clearQueue = (o: Out) => {
    o.events.clear();
    o.states.clear();
    o.byKey.clear();
    o.jobs.clear();
    o.bytes = 0;
    o.untold = 0;
    if (o.timer) {
      clearTimeout(o.timer);
      o.timer = null;
    }
  };

  const queued = (o: Out) => o.events.alive + o.states.alive;

  /**
   * What waits for a peer is given up because its connection is gone or was replaced (never because it was slow: that
   * is `dropped`'s warning). Counted with the dropped, so every event is one of sent, dropped or replaced by a newer
   * value; `tell`: the peer is still there (the pair's other connection took over) and hears how many it missed.
   */
  const discard = (o: Out, tell: boolean) => {
    const n = queued(o);
    clearQueue(o);
    if (n) {
      o.dropped += n;
      counters.events_dropped += n;
      if (tell) {
        o.untold = n;
      }
    }
  };

  const dropped = (id: string, o: Out, n: number) => {
    o.dropped += n;
    o.untold += n;
    o.droppedAt = Date.now();
    counters.events_dropped += n;
    if (o.droppedAt - o.dropLoggedAt > 60_000) {
      o.dropLoggedAt = o.droppedAt;
      deps.log({ event: 'peer_events_dropped', to: o.name, id, dropped: o.dropped, queued: queued(o) });
    }
  };

  const enqueue = (id: string, o: Out, item: Item) => {
    if (item.key !== undefined) {
      // Behind: the value a newer one replaces is not worth the link (the newest of each property always stays).
      const old = o.byKey.get(item.key);
      if (old && !old.dead && queued(o) > lim.coalesceAbove) {
        o.states.kill(old);
        o.bytes -= old.bytes;
        o.coalesced++;
        counters.events_coalesced++;
      }
      o.byKey.set(item.key, item);
      o.states.push(item);
    } else {
      o.events.push(item);
    }
    o.bytes += item.bytes;
    let n = 0;
    while (queued(o) > lim.queueMax || o.bytes > lim.queueMaxBytes) {
      // Full: the oldest event goes first, a property's value only when no event is left.
      const victim = o.events.take() ?? o.states.take();
      if (!victim) {
        break;
      }
      if (victim.key !== undefined && o.byKey.get(victim.key) === victim) {
        o.byKey.delete(victim.key);
      }
      o.bytes -= victim.bytes;
      n++;
    }
    if (n) {
      dropped(id, o, n);
    }
    schedule(id, o);
  };

  const schedule = (id: string, o: Out) => {
    if (o.scheduled || o.timer) {
      return;
    }
    o.scheduled = true;
    setImmediate(() => {
      o.scheduled = false;
      flush(id, o);
    });
  };

  /** The oldest waiting item of the two queues, by seq. */
  const next = (o: Out): Item | undefined => {
    const a = o.events.peek();
    const b = o.states.peek();
    const from = !a ? o.states : !b ? o.events : a.seq <= b.seq ? o.events : o.states;
    const item = from.take();
    if (item) {
      o.bytes -= item.bytes;
      if (item.key !== undefined && o.byKey.get(item.key) === item) {
        o.byKey.delete(item.key);
      }
    }
    return item;
  };

  const write = (id: string, o: Out, json: string): boolean => {
    tapped('tx', o.name, json);
    const ok = deps.links.sendFrame(id, encodeControlJson(json));
    if (ok) {
      counters.event_msgs_out++;
    }
    return ok;
  };

  /** Writes what waits for a peer, a batch at a time, while its connection takes it. */
  const flush = (id: string, o: Out) => {
    if (o.timer) {
      clearTimeout(o.timer);
      o.timer = null;
    }
    while (queued(o) > 0 || o.jobs.size > 0 || o.untold > 0) {
      const backlog = deps.links.backlog(id);
      if (backlog === null) {
        discard(o, false); // the link is gone: what waited is not kept for the next one (its snapshot says where things stand)
        return;
      }
      if (backlog > lim.highWater) {
        o.timer = setTimeout(() => {
          o.timer = null;
          flush(id, o);
        }, lim.retryMs);
        o.timer.unref();
        return;
      }
      const parts: string[] = [];
      let bytes = 0;
      while (parts.length < EVENT_BATCH_MAX && bytes < EVENT_BATCH_BYTES) {
        const item = next(o);
        if (!item) {
          break;
        }
        parts.push(item.json);
        bytes += item.bytes;
      }
      const jobs = [...o.jobs.values()].slice(0, EVENT_BATCH_MAX);
      for (const j of jobs) {
        o.jobs.delete(j.job_id);
      }
      const untold = o.untold;
      o.untold = 0;
      const json = `{"t":"event","v":${EVENTS_WIRE},"now_us":${Math.round(nowUs())}${parts.length ? `,"events":[${parts.join(',')}]` : ''}${jobs.length ? `,"jobs":${JSON.stringify(jobs)}` : ''}${untold ? `,"dropped":${untold}` : ''}}`;
      if (!write(id, o, json)) {
        o.dropped += parts.length;
        counters.events_dropped += parts.length;
        discard(o, false);
        return;
      }
      o.sent += parts.length;
      counters.events_sent += parts.length;
      counters.jobs_sent += jobs.length;
    }
  };

  const speaking = (): [string, Out][] => {
    const out: [string, Out][] = [];
    for (const v of deps.links.views()) {
      const o = outs.get(v.id);
      if (v.reachable && o?.speaks) {
        out.push([v.id, o]);
      }
    }
    return out;
  };

  const onLocal = (e: HubEvent) => {
    if (!on() || !crosses(e)) {
      return;
    }
    const to = speaking();
    if (!to.length) {
      return;
    }
    const json = JSON.stringify(e); // once for every peer
    const bytes = Buffer.byteLength(json);
    for (const [id, o] of to) {
      enqueue(id, o, { seq: e.seq, json, bytes, ...(e.part === 'state' && e.device ? { key: `${e.device}\0${e.type}` } : {}) });
    }
  };

  const jobMsg = (job: Job, change: JobChange): JobChangeMsg => ({
    job_id: job.job_id,
    kind: job.kind,
    status: job.status,
    ...(job.stage ? { stage: job.stage } : {}),
    ...(job.progress ? { progress: job.progress } : {}),
    change,
  });

  const onJobChange = (job: Job, change: JobChange) => {
    if (!on()) {
      return;
    }
    const msg = jobMsg(job, change);
    for (const [id, o] of speaking()) {
      // One change per job per message: the newest, said as the strongest kind of change it replaces.
      const waiting = o.jobs.get(job.job_id);
      o.jobs.set(job.job_id, waiting && CHANGE_RANK[waiting.change] > CHANGE_RANK[change] ? { ...msg, change: waiting.change } : msg);
      schedule(id, o);
    }
  };

  /** Where this hub stands, for a link that just came up: its boards' properties, its running jobs, its pending prompts. */
  const snapshot = (id: string, o: Out) => {
    const hub = deps.hub();
    const head = hub.logs.headSeq();
    const events: string[] = [];
    for (const dev of hub.router?.online() ?? []) {
      const info = routerInfo(hub.router, dev);
      if (!info) {
        continue;
      }
      for (const [type, value] of Object.entries(info.properties)) {
        const member = type.slice(type.indexOf('.') + 1);
        let e: HubEvent | undefined;
        try {
          e = tailEvents(hub.events, { types: [type], devices: [dev], limit: 1 })[0];
        } catch {
          e = undefined;
        }
        // A value whose event the ring dropped is rebuilt from the router's mirror (as /ws does for its snapshot).
        e ??= { cursor: mintCursor(hub), seq: head, type, device: dev, alias: hub.registry.get(dev)?.alias, t_hub_us: nowUs(), fields: { [member]: value }, part: 'state', member };
        events.push(JSON.stringify(e));
      }
    }
    for (const p of hub.prompts?.pending() ?? []) {
      events.push(JSON.stringify({ cursor: mintCursor(hub), seq: head, type: 'hub.prompt', t_hub_us: nowUs(), fields: p }));
    }
    for (let i = 0; i < events.length || i === 0; i += EVENT_BATCH_MAX) {
      // Sent even when empty: it says "this is all I hold", so what a peer mirrored before a reconnect is replaced.
      if (!write(id, o, `{"t":"event","v":${EVENTS_WIRE},"now_us":${Math.round(nowUs())},"snapshot":true,"first":${i === 0},"events":[${events.slice(i, i + EVENT_BATCH_MAX).join(',')}]}`)) {
        return;
      }
    }
    let jobs: Job[] = [];
    try {
      jobs = typeof hub.jobs?.list === 'function' ? hub.jobs.list(100).filter((j) => !TERMINAL.has(j.status)) : [];
    } catch {
      jobs = [];
    }
    if (jobs.length) {
      write(id, o, `{"t":"event","v":${EVENTS_WIRE},"now_us":${Math.round(nowUs())},"jobs":${JSON.stringify(jobs.map((j) => jobMsg(j, 'status')))}}`);
    }
  };

  // ---- in ----

  const mirrorOf = (hubId: string, deviceId: string): Map<string, HubEvent> => {
    let byDevice = mirror.get(hubId);
    if (!byDevice) {
      byDevice = new Map();
      mirror.set(hubId, byDevice);
    }
    let props = byDevice.get(deviceId);
    if (!props) {
      props = new Map();
      byDevice.set(deviceId, props);
    }
    return props;
  };

  const remember = (hubId: string, e: HubEvent) => {
    if (e.part !== 'state' || !e.device) {
      return;
    }
    const props = mirrorOf(hubId, e.device);
    if (props.size < MIRROR_MAX_PER_DEVICE || props.has(e.type)) {
      props.set(e.type, e);
    }
  };

  const promptOf = (v: unknown): Prompt | null => {
    const p = v as Partial<Prompt> | undefined;
    return typeof p?.prompt_id === 'string' && typeof p.text === 'string' && typeof p.expires_at === 'string' && Array.isArray(p.types) ? (p as Prompt) : null;
  };

  const notePrompt = (hubId: string, e: HubEvent) => {
    if (e.type === 'hub.prompt') {
      const p = promptOf(e.fields);
      if (p) {
        let of = remotePrompts.get(hubId);
        if (!of) {
          of = new Map();
          remotePrompts.set(hubId, of);
        }
        if (of.size < 256) {
          of.set(p.prompt_id, p);
        }
      }
    } else if (e.type === 'hub.prompt_done' && typeof e.fields?.prompt_id === 'string') {
      remotePrompts.get(hubId)?.delete(e.fields.prompt_id);
    }
  };

  const takeJobs = (peer: PeerView, jobs: readonly JobChangeMsg[]) => {
    let of = remoteJobs.get(peer.id);
    if (!of) {
      of = new Map();
      remoteJobs.set(peer.id, of);
    }
    for (const j of jobs) {
      counters.jobs_received++;
      const job: RemoteJob = { ...j, hub: peer.name };
      if (TERMINAL.has(j.status)) {
        of.delete(j.job_id);
      } else if (of.size < 1024 || of.has(j.job_id)) {
        of.set(j.job_id, job);
      }
      for (const fn of jobListeners) {
        try {
          fn(job);
        } catch (err) {
          console.error(JSON.stringify({ event: 'peer_job_listener_failed', message: (err as Error).message }));
        }
      }
    }
  };

  return {
    start() {
      started = true;
      const hub = deps.hub();
      // A plain subscriber: this hub's own events only, never one a peer relayed.
      offEvents = hub.events.subscribe(onLocal);
      if (typeof hub.jobs?.onChange === 'function') {
        offJobs = hub.jobs.onChange(onJobChange);
      }
    },
    stop() {
      started = false;
      offEvents?.();
      offEvents = null;
      offJobs?.();
      offJobs = null;
      for (const o of outs.values()) {
        clearQueue(o);
      }
      outs.clear();
      mirror.clear();
      remoteJobs.clear();
      remotePrompts.clear();
    },
    hello() {
      return on() ? EVENTS_WIRE : undefined;
    },
    onUp(peer) {
      const o = outOf(peer);
      // A new connection: what waited for the old one is not sent on this one (the snapshot says where things stand),
      // and the peer is told how many events that were.
      discard(o, true);
      o.speaks = typeof peer.hello?.events === 'number';
      if (o.speaks && on() && started) {
        snapshot(peer.id, o);
        if (o.untold) {
          schedule(peer.id, o);
        }
      }
    },
    onDown(peer) {
      const o = outs.get(peer.id);
      if (o) {
        discard(o, false);
      }
      // What it held is not known any more: its boards' state, its jobs and its prompts go with it (a job of its that
      // was running is no longer listed as running here; job_get asks that hub once it is back).
      mirror.delete(peer.id);
      remotePrompts.delete(peer.id);
      remoteJobs.delete(peer.id);
    },
    onMessage(peer, msg) {
      if (!on()) {
        return false;
      }
      const file = deps.tap();
      if (file) {
        tapped('rx', peer.name, JSON.stringify(msg));
      }
      if (!started) {
        return true;
      }
      const hub = deps.hub();
      const o = outOf(peer);
      counters.event_msgs_in++;
      if (typeof msg.dropped === 'number' && msg.dropped > 0) {
        o.missed += msg.dropped;
        o.missedAt = Date.now();
        counters.events_missed += msg.dropped;
      }
      // The sender's clock at the write against this hub's at the read: the two hubs' offset plus the link's delay.
      const offset = Number.isFinite(msg.now_us) ? nowUs() - msg.now_us : 0;
      if (msg.snapshot === true && (msg as { first?: unknown }).first === true) {
        mirror.delete(peer.id);
        remotePrompts.delete(peer.id);
      }
      for (const raw of msg.events ?? []) {
        const parsed = HubEventSchema.safeParse(raw);
        if (!parsed.success || !crosses(parsed.data)) {
          // Not an event, one a peer must not send (a relayed one: nothing is relayed twice), or one that stays local.
          counters.events_bad++;
          continue;
        }
        const { seq: _seq, cursor, ...rest } = parsed.data;
        const e: Omit<HubEvent, 'cursor' | 'seq'> & { hub: string } = { ...rest, hub: peer.name, hub_cursor: cursor, t_hub_us: Math.round(rest.t_hub_us + offset) };
        if ((e.type === 'device.offline' || e.type === 'device.suspect') && e.device) {
          // Its session with that hub ended (or went quiet); where the board is now, when another hub holds it.
          const at = deps.heldAt(e.device, peer.id);
          if (at) {
            e.fields = { ...(e.fields ?? {}), at };
          }
        }
        if (msg.snapshot === true) {
          // A current value, not a new event: kept, not published.
          const head = hub.logs.headSeq();
          const kept: HubEvent = { ...e, seq: head, cursor: mintCursor(hub) };
          remember(peer.id, kept);
          notePrompt(peer.id, kept);
          continue;
        }
        o.received++;
        counters.events_received++;
        const published = hub.events.relay ? hub.events.relay(e) : null;
        if (published) {
          remember(peer.id, published);
          notePrompt(peer.id, published);
        }
      }
      if (msg.jobs?.length) {
        takeJobs(peer, msg.jobs);
      }
      return true;
    },
    forget(hubId, deviceId) {
      mirror.get(hubId)?.delete(deviceId);
    },
    relays(hubId) {
      return on() && outs.get(hubId)?.speaks === true;
    },
    states(deviceId) {
      for (const v of deps.links.views()) {
        const props = v.reachable ? mirror.get(v.id)?.get(deviceId) : undefined;
        if (props?.size) {
          return [...props.values()];
        }
      }
      return [];
    },
    properties(deviceId) {
      for (const v of deps.links.views()) {
        const props = v.reachable ? mirror.get(v.id)?.get(deviceId) : undefined;
        if (props) {
          const out: Record<string, unknown> = {};
          for (const [type, e] of props) {
            const member = e.member ?? type.slice(type.indexOf('.') + 1);
            out[type] = e.fields && member in e.fields ? e.fields[member] : e.fields;
          }
          return out;
        }
      }
      return null;
    },
    jobs() {
      const out: RemoteJob[] = [];
      for (const v of deps.links.views()) {
        if (v.reachable) {
          out.push(...(remoteJobs.get(v.id)?.values() ?? []));
        }
      }
      return out;
    },
    onJob(fn) {
      jobListeners.add(fn);
      return () => jobListeners.delete(fn);
    },
    prompts() {
      const now = Date.now();
      const out: (Prompt & { hub: string })[] = [];
      for (const v of deps.links.views()) {
        const of = v.reachable ? remotePrompts.get(v.id) : undefined;
        for (const [id, p] of of ?? []) {
          if (Date.parse(p.expires_at) + 5000 < now) {
            of!.delete(id); // its hub.prompt_done never came (dropped): it ended by its own time
          } else {
            out.push({ ...p, types: [...p.types], hub: v.name });
          }
        }
      }
      return out;
    },
    status() {
      const peers: Record<string, EventsPeer> = {};
      for (const v of deps.links.views()) {
        const o = outs.get(v.id);
        if (o) {
          peers[v.id] = { speaks: o.speaks, sent: o.sent, received: o.received, dropped: o.dropped, coalesced: o.coalesced, missed: o.missed, queued: queued(o), mirrored: mirror.get(v.id)?.size ?? 0 };
        }
      }
      return { speaks: on(), peers, counters: { ...counters } };
    },
    warnings() {
      const out: string[] = [];
      if (!on()) {
        return out;
      }
      const now = Date.now();
      for (const v of deps.links.views()) {
        const o = outs.get(v.id);
        if (!v.reachable || !o) {
          continue;
        }
        if (!o.speaks) {
          out.push(`hub ${v.name} does not relay events or live streams (it runs a version from before step 2.4 of the hubs' link): what its boards do is not seen live on this hub, a wait here for one of them is refused, and its camera cannot be watched from here; update that hub and restart it (fr hub restart)`);
          continue;
        }
        if (o.dropped && now - o.droppedAt < lim.warnMs) {
          out.push(`${o.dropped} events were not sent to hub ${v.name} since this hub started (the last ${Math.round((now - o.droppedAt) / 1000)} s ago): the link to it is slower than this hub's boards talk, so that hub's live view missed them (they are stored here: fr events); fr hub peers shows the counters`);
        }
        if (o.missed && now - o.missedAt < lim.warnMs) {
          out.push(`hub ${v.name} did not send ${o.missed} of its events to this hub since this hub started (the last ${Math.round((now - o.missedAt) / 1000)} s ago): the link was slow, and a live view or a wait here missed them (they are stored there: fr --at ${v.name} events)`);
        }
      }
      return out;
    },
  };
}
