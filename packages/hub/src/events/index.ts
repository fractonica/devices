// The event bus and store (design c3 §4, stream H2; spec 08 §8.7). publish() runs in the receive tick:
// it takes the cursor from the Seq that logs share, notifies subscribers synchronously, and queues the
// row; rows are written to the `events` table in one transaction every 50 ms, off the input path. The
// table is a ring trimmed like logs (main.ts runs a RingRetention on it). The store also remembers when
// cursors were handed out (mintCursor), which dates a wait's `since` (09 §9.2). Each write's duration goes into
// a 1 s window (flushMs), which hub_status shows as router.scale.events_flush_ms (design m2-c2 D16).
//
// STATE thinning (design m2-c3-inputs D6): every EVENT and every other row is written, but a STATE (`part:
// 'state'`) the publisher marks `thin` (the router marks a streaming capability's: one with a `report_hz`
// config, fr.analog_in) at most once per (device, instance, member) per STATE_ROW_MS. Other STATEs (an LED's
// `on`, a button's `pressed`) are all written: T-HIL and T-LED read every change back from the store, and they
// change at command rate, not at a sampling rate. The first in a window is queued at
// once and opens the window; a later one in it becomes the window's pending row, replacing an earlier pending
// one, and is queued when the window ends (opening the next), so the last value is always stored. A pending row
// keeps the seq and cursor its subscribers saw, and query() and tail() already return it, so a wait that reads
// the backlog after the STATE was published still finds it. Subscribers and the router's mirror see every STATE.
//
// Live-only events (`durable: false`): per-frame telemetry, such as a camera's frame counter, which changes with every
// frame a stream takes. Subscribers (/ws, /app, a wait already subscribed) get them; no row is written, so they never
// fill hub.db. A wait that reads the backlog does not find them.
//
// Relayed events (design multi-hub-m2 §8, §17): what another hub of the network published and sent over the hubs' link
// (peers/events.ts hands them to relay()). An event is stored once, at the hub that published it; here it is live: it
// takes this hub's own seq and cursor (one order for a client of this hub), carries `hub` (where it came from) and
// `hub_cursor` (its cursor there), and goes only to the subscribers that asked for the fleet (`subscribe(fn, {relayed:
// true})`: /ws, /app, the waits), never to the parts that act on this hub's own sessions (the router, bindings, OTA).
// No row is written. The newest RELAYED_KEPT of them stay in memory for RELAYED_MAX_AGE_MS, so a read that asks for
// them (`relayed: true`: events_read, a wait's backlog, a /ws or /app resume) finds what crossed since its cursor;
// STATEs are thinned there as rows are (one per property per STATE_ROW_MS, and the newest).

import { performance } from 'node:perf_hooks';

import { formatCursor, FrError, parseCursor } from '@fractonica/protocol';

import type { Events, HubContext, HubEvent, Lifecycle, Seq } from '../context.ts';
import type { Db } from '../db.ts';
import { nowUs } from '../ring.ts';
import { WindowStat } from '../router/scale.ts';
import { matchTypes, sqliteGlob } from './match.ts';
import { guarded } from '../crash.ts';

export { matchType, matchTypes, matchWhere, parseTypes } from './match.ts';

export interface EventQuery {
  afterSeq?: number;
  types?: string[];
  /** null (or absent) is every device, hub events included; [] matches nothing. */
  devices?: string[] | null;
  /** Events of these devices are left out; events with no device stay (`all` without the fixture, design m2-c1-hil D6). */
  excludeDevices?: string[];
  limit: number;
  /** Also the events other hubs relayed that are still kept in memory (never stored here). Default: this hub's own. */
  relayed?: boolean;
}

interface Row {
  seq: number;
  run: number;
  ts_us: number;
  t_hub_us: number;
  type: string;
  device: string | null;
  json: string;
}

/** What `json` holds: the event without the columns (seq, run, type, device, t_hub_us) and its cursor. */
type Body = Omit<HubEvent, 'cursor' | 'seq' | 'type' | 'device' | 't_hub_us'>;

const FLUSH_MS = 50;
/** One STATE row per (device, instance, member) per this long, at most (D6). */
export const STATE_ROW_MS = 1000;
/** Cursors whose mint time is kept (the newest distinct seqs handed out); older ones are dated by rows. */
const MINTS_KEPT = 1024;
/** Relayed events kept in memory for the reads that ask for them: the newest this many, none older than the age. */
export const RELAYED_KEPT = 8192;
export const RELAYED_MAX_AGE_MS = 10 * 60_000;

export class EventStore implements Events, Lifecycle {
  readonly run: number;
  #db: Db;
  #seq: Seq;
  #pending: Row[] = [];
  #timer: NodeJS.Timeout | null = null;
  /** Subscribers in the order they came; `true`: it also gets the events other hubs relayed. */
  #listeners = new Map<(e: HubEvent) => void, boolean>();
  /** Relayed events kept in memory, by seq, oldest first, with when each came (ms). */
  #relayed = new Map<number, { e: HubEvent; at: number }>();
  /** Relayed STATE windows by `<device>\0<type>`: when the window opened, and the seq of its pending event. */
  #relayedStates = new Map<string, { at: number; pending: number | null }>();
  /** Events other hubs relayed and this hub published live, since start. */
  relayedIn = 0;
  /** seq -> when that cursor was first handed out (µs since the Unix epoch), oldest first. */
  #mints = new Map<number, number>();
  /** How long each batched write took (ms), in 1 s windows (design m2-c2 D16 events_flush_ms). */
  readonly flushMs = new WindowStat('ms');
  /** STATE windows by `<device>\0<type>`: the row to write when it ends (the newest since the window's first), or null. */
  #stateWindows = new Map<string, { pending: Row | null; timer: NodeJS.Timeout }>();
  /** STATE rows left out by thinning (a pending row that a newer one replaced), since start. */
  stateThinned = 0;
  /** Events published live only (`durable: false`: per-frame telemetry), never written, since start. */
  liveOnly = 0;

  constructor(db: Db, seq: Seq, run: number) {
    this.#db = db;
    this.#seq = seq;
    this.run = run;
  }

  start(): void {}

  /** Writes what is queued, the STATE windows' pending rows included; call before the db closes. */
  stop(): void {
    for (const w of this.#stateWindows.values()) {
      clearTimeout(w.timer);
      if (w.pending) {
        this.#pending.push(w.pending);
      }
    }
    this.#stateWindows.clear();
    this.flush();
  }

  publish(e: Omit<HubEvent, 'cursor' | 'seq'>, opts: { thin?: boolean; durable?: boolean } = {}): HubEvent {
    const seq = this.#seq.next();
    const event: HubEvent = { ...e, seq, cursor: formatCursor({ run: this.run, seq }) };
    const { cursor: _c, seq: _s, type, device, t_hub_us, ...body } = event;
    const row: Row = { seq, run: this.run, ts_us: nowUs(), t_hub_us: Math.round(t_hub_us), type, device: device ?? null, json: JSON.stringify(body) };
    if (opts.durable === false) {
      // Live only (per-frame telemetry): subscribers see it, no row is written.
      this.liveOnly++;
    } else if (opts.thin && e.part === 'state') {
      this.#thin(row);
    } else {
      this.#queue(row);
    }
    for (const fn of this.#listeners.keys()) {
      try {
        fn(event);
      } catch (err) {
        // A failing subscriber must not cost the others (or the input path) their event.
        console.error(JSON.stringify({ event: 'event_subscriber_failed', message: (err as Error).message }));
      }
    }
    return event;
  }

  /**
   * An event another hub published, live here (design multi-hub-m2 §8): this hub's own seq and cursor, `hub` naming
   * where it came from, no row. Only the subscribers that asked for relayed events get it.
   */
  relay(e: Omit<HubEvent, 'cursor' | 'seq'> & { hub: string }): HubEvent {
    const seq = this.#seq.next();
    const event: HubEvent = { ...e, seq, cursor: formatCursor({ run: this.run, seq }) };
    this.relayedIn++;
    this.#keep(event);
    for (const [fn, fleet] of this.#listeners) {
      if (!fleet) {
        continue;
      }
      try {
        fn(event);
      } catch (err) {
        console.error(JSON.stringify({ event: 'event_subscriber_failed', message: (err as Error).message }));
      }
    }
    return event;
  }

  /** Keeps a relayed event for the reads that ask for them; a STATE as the store thins rows (first of a window, and the newest). */
  #keep(event: HubEvent): void {
    const now = Date.now();
    if (event.part === 'state') {
      const key = `${event.device ?? ''}\0${event.type}`;
      const w = this.#relayedStates.get(key);
      if (w && now - w.at < STATE_ROW_MS) {
        if (w.pending !== null) {
          this.#relayed.delete(w.pending);
        }
        w.pending = event.seq;
      } else {
        this.#relayedStates.set(key, { at: now, pending: null });
        if (this.#relayedStates.size > 4 * RELAYED_KEPT) {
          this.#relayedStates.clear(); // only the thinning's memory: the next STATE of each opens a window again
        }
      }
    }
    this.#relayed.set(event.seq, { e: event, at: now });
    for (const [seq, kept] of this.#relayed) {
      if (this.#relayed.size <= RELAYED_KEPT && now - kept.at <= RELAYED_MAX_AGE_MS) {
        break;
      }
      this.#relayed.delete(seq);
    }
  }

  /** The kept relayed events that match `q`, oldest first. */
  #relayedMatching(q: EventQuery): HubEvent[] {
    const out: HubEvent[] = [];
    const oldest = Date.now() - RELAYED_MAX_AGE_MS;
    for (const { e, at } of this.#relayed.values()) {
      if (
        at >= oldest &&
        (q.afterSeq === undefined || e.seq > q.afterSeq) &&
        (!q.devices || (e.device !== undefined && q.devices.includes(e.device))) &&
        (!q.excludeDevices?.length || e.device === undefined || !q.excludeDevices.includes(e.device)) &&
        (!q.types?.length || matchTypes(q.types, e.type))
      ) {
        out.push(e);
      }
    }
    return out;
  }

  #queue(row: Row): void {
    this.#pending.push(row);
    this.#timer ??= setTimeout(guarded('events.flush', () => this.flush()), FLUSH_MS);
  }

  /** A STATE row (D6): queued now when its key has no window open, else the window's pending row. */
  #thin(row: Row): void {
    const key = `${row.device ?? ''}\0${row.type}`;
    const w = this.#stateWindows.get(key);
    if (w) {
      if (w.pending) {
        this.stateThinned++;
      }
      w.pending = row;
      return;
    }
    this.#queue(row);
    this.#openWindow(key);
  }

  /** A window from now: at its end the pending row (if any) is queued and opens the next, else the key closes. */
  #openWindow(key: string): void {
    const w = {
      pending: null as Row | null,
      timer: setTimeout(() => {
        this.#stateWindows.delete(key);
        if (w.pending) {
          this.#queue(w.pending);
          this.#openWindow(key);
        }
      }, STATE_ROW_MS),
    };
    w.timer.unref?.();
    this.#stateWindows.set(key, w);
  }

  /**
   * `fn` gets every event this hub publishes, in the publish tick; with `relayed` also the events other hubs of the
   * network relayed (each marked `hub`): what a client of this hub sees as one fleet.
   */
  subscribe(fn: (e: HubEvent) => void, opts: { relayed?: boolean } = {}): () => void {
    this.#listeners.set(fn, opts.relayed === true);
    return () => this.#listeners.delete(fn);
  }

  /**
   * The cursor at `seq` was handed out now. The first time counts: on a quiet hub one cursor is handed out
   * again and again, and a wait since it must not drop what followed its first mint.
   */
  noteMint(seq: number, atUs = nowUs()): void {
    if (this.#mints.has(seq)) {
      return;
    }
    this.#mints.set(seq, atUs);
    if (this.#mints.size > MINTS_KEPT) {
      this.#mints.delete(this.#mints.keys().next().value!);
    }
  }

  /** When the cursor at `seq` was first handed out (µs since the Unix epoch); null when not recorded. */
  mintedAtUs(seq: number): number | null {
    return this.#mints.get(seq) ?? null;
  }

  flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (!this.#pending.length || !this.#db.open) {
      return;
    }
    const rows = this.#pending;
    this.#pending = [];
    const t0 = performance.now();
    const insert = this.#db.prepare('INSERT INTO events (seq, run, ts_us, t_hub_us, type, device, json) VALUES (@seq, @run, @ts_us, @t_hub_us, @type, @device, @json)');
    this.#db.transaction((all: Row[]) => {
      for (const r of all) {
        insert.run(r);
      }
    })(rows);
    this.flushMs.add(performance.now() - t0);
  }

  /** Oldest first, after `afterSeq`. */
  query(q: EventQuery): HubEvent[] {
    return this.#select(q, 'ASC');
  }

  /** The newest `limit` events (after `afterSeq` if given), oldest first. */
  tail(q: EventQuery): HubEvent[] {
    return this.#select(q, 'DESC').reverse();
  }

  /**
   * The STATE windows' pending rows that match `q` (not in the table yet), so a read sees the newest value of a
   * property the moment it was published; the window still writes it later, with the same seq.
   */
  #pendingStates(q: EventQuery): Row[] {
    const out: Row[] = [];
    for (const w of this.#stateWindows.values()) {
      const r = w.pending;
      if (
        r &&
        (!q.devices || (r.device !== null && q.devices.includes(r.device))) &&
        (!q.excludeDevices?.length || r.device === null || !q.excludeDevices.includes(r.device)) &&
        (q.afterSeq === undefined || r.seq > q.afterSeq) &&
        (!q.types?.length || matchTypes(q.types, r.type))
      ) {
        out.push(r);
      }
    }
    return out;
  }

  #select(q: EventQuery, order: 'ASC' | 'DESC'): HubEvent[] {
    const rows = this.#selectRows(q, order);
    const extra = this.#pendingStates(q);
    const relayed = q.relayed ? this.#relayedMatching(q) : [];
    if (!extra.length && !relayed.length) {
      return rows.map(toEvent);
    }
    const all = [...rows.map(toEvent), ...extra.map(toEvent), ...relayed].sort((a, b) => (order === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
    return all.slice(0, q.limit);
  }

  #selectRows(q: EventQuery, order: 'ASC' | 'DESC'): Row[] {
    this.flush();
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.devices) {
      if (!q.devices.length) {
        return [];
      }
      where.push(`device IN (${q.devices.map(() => '?').join(',')})`);
      args.push(...q.devices);
    }
    if (q.excludeDevices?.length) {
      where.push(`(device IS NULL OR device NOT IN (${q.excludeDevices.map(() => '?').join(',')}))`);
      args.push(...q.excludeDevices);
    }
    if (q.afterSeq !== undefined) {
      where.push('seq > ?');
      args.push(q.afterSeq);
    }
    if (q.types?.length) {
      where.push(`(${q.types.map(() => 'type GLOB ?').join(' OR ')})`);
      args.push(...q.types.map(sqliteGlob));
    }
    const sql = `SELECT seq, run, t_hub_us, type, device, json FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq ${order} LIMIT ?`;
    return this.#db.prepare(sql).all(...args, q.limit) as Row[];
  }
}

function toEvent(r: Pick<Row, 'seq' | 'run' | 't_hub_us' | 'type' | 'device' | 'json'>): HubEvent {
  let body: Body = {};
  try {
    body = JSON.parse(r.json) as Body;
  } catch {
    // A row this code did not write: keep the columns.
  }
  return {
    cursor: formatCursor({ run: r.run, seq: r.seq }),
    seq: r.seq,
    type: r.type,
    ...(r.device !== null ? { device: r.device } : {}),
    t_hub_us: r.t_hub_us,
    ...body,
  };
}

export function createEvents(db: Db, seq: Seq, run: number): EventStore {
  return new EventStore(db, seq, run);
}

/**
 * Subscribes `fn` to the fleet: this hub's events and those other hubs relayed (an Events that knows none of that,
 * a test's, gives its own).
 */
export function subscribeFleet(events: Events, fn: (e: HubEvent) => void): () => void {
  return (events.subscribe as (fn: (e: HubEvent) => void, opts?: { relayed?: boolean }) => () => void).call(events, fn, { relayed: true });
}

/** The newest events through any Events (tail reads need the store; another implementation pages forward). */
export function tailEvents(events: Events, q: EventQuery): HubEvent[] {
  if (events instanceof EventStore) {
    return events.tail(q);
  }
  return events.query(q).slice(-q.limit);
}

/**
 * The head cursor, recorded as handed out now: ops return their cursors through this, so a wait since one
 * is dated by when it was handed out (mintTimeUs).
 */
export function mintCursor(hub: Pick<HubContext, 'logs' | 'events'>): string {
  const seq = hub.logs.headSeq();
  if (hub.events instanceof EventStore) {
    hub.events.noteMint(seq);
  }
  return formatCursor({ run: hub.logs.run, seq });
}

/**
 * When the cursor `seq` was minted (µs since the Unix epoch), for the waits' "no stale matches" (09 §9.2):
 * the time it was first handed out when the store recorded that (mintCursor), never earlier than the
 * newest row at or before it. The rows alone can be far older on a quiet hub (heartbeats store nothing).
 */
export function mintTimeUs(hub: Pick<HubContext, 'db' | 'events'>, seq: number): number {
  const minted = hub.events instanceof EventStore ? hub.events.mintedAtUs(seq) : null;
  return Math.max(cursorTimeUs(hub.db, seq), minted ?? 0);
}

/**
 * When the cursor `seq` was minted, as well as the tables can tell: the hub receive time of the newest
 * log line or event at or before it (0 when there is none); a lower bound of the mint time (mintTimeUs).
 */
export function cursorTimeUs(db: Db, seq: number): number {
  const row = db
    .prepare(
      `SELECT MAX(ts) AS ts FROM (
         SELECT ts_us AS ts FROM (SELECT ts_us FROM logs WHERE seq <= ? ORDER BY seq DESC LIMIT 1)
         UNION ALL
         SELECT ts_us AS ts FROM (SELECT ts_us FROM events WHERE seq <= ? ORDER BY seq DESC LIMIT 1))`,
    )
    .get(seq, seq) as { ts: number | null };
  return row.ts ?? 0;
}

/**
 * The seq of a `since` cursor, for a read of this hub's stores (spec 08 §8.7; design multi-hub-m2 §17). A cursor is one
 * hub's own: one of an earlier run of this hub is HUB_RESTARTED with a cursor to resume from; one that another hub of
 * the network gave (its run carries that hub's slot) is refused naming that hub, and never read as a position here.
 */
export function sinceSeqOf(hub: Pick<HubContext, 'logs' | 'events'> & Partial<Pick<HubContext, 'peers'>>, since: string | undefined): number | undefined {
  if (!since) {
    return undefined;
  }
  const c = parseCursor(since);
  if (!c) {
    throw new FrError('INVALID_ARGS', `bad cursor ${since}; expected c:<run>.<seq>`);
  }
  if (c.run !== hub.logs.run) {
    const other = hub.peers?.hubOfRun(c.run);
    if (other && !other.self) {
      throw new FrError('INVALID_ARGS', `cursor ${since} is hub ${other.name}'s, not this hub's: a cursor is one hub's own, and this one says nothing about what this hub stored`, {
        hint: `read it where it came from (fr --at ${other.name} …), or take a cursor of this hub (the cursor of any answer of its own, or fr hub status)`,
        details: { cursor: since, cursor_hub: other.name, resume_cursor: mintCursor(hub) },
      });
    }
    throw new FrError('HUB_RESTARTED', `cursor ${since} is from an earlier hub run`, { details: { resume_cursor: mintCursor(hub) } });
  }
  return c.seq;
}
