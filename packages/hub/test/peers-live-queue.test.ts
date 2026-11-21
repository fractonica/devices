// The event relay's queue and its bounds alone (design multi-hub-m2 §8, §17; peers/events.ts), with a link that is a
// list of frames and a backlog the test sets: batches, a connection that takes nothing, STATEs giving way to newer
// ones, an overflow that drops the oldest events and keeps every property's newest value, what the peer is told, what
// is counted, what a message from a peer becomes here, and what a peer must not send. peers-live.test.ts runs the
// relay between hubs over the real link.

import { afterEach, describe, expect, it } from 'vitest';

import type { HubEvent } from '@fractonica/protocol';

import type { HubContext } from '../src/context.ts';
import { createEventRelay, crosses, type EventRelay, type EventRelayLimits } from '../src/peers/events.ts';
import type { PeerView } from '../src/peers/link.ts';
import { FrameDecoder, type EventMsg } from '../src/peers/wire.ts';
import { nowUs } from '../src/ring.ts';
import { type Rig, rig, until } from './fake-node.ts';

const PEER: PeerView = { id: '0000000000b2', name: 'hub-b', reachable: true, since: 1, hello: { t: 'hello', v: 1, wire: 1, hub_id: '0000000000b2', name: 'hub-b', net: 1, registry_hash: 'x', hub_epoch: 1, members_version: 1, events: 1 }, address: null, direction: 'out', rtt_ms: 1, last_error: null, conn: 1 };
const DEV = 'aabbcc1b0001';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

interface Bench {
  r: Rig;
  relay: EventRelay;
  /** What the relay wrote, decoded. */
  sent: EventMsg[];
  /** What the connection says is queued on it. */
  link: { backlog: number | null };
  event(type: string, n?: number): HubEvent;
  state(prop: string, value: number): HubEvent;
}

async function bench(limits: Partial<EventRelayLimits> = {}, held: (id: string) => string | null = () => null): Promise<Bench> {
  const r = await rig();
  cleanups.push(() => r.close());
  const sent: EventMsg[] = [];
  const link = { backlog: 0 as number | null };
  const decoder = new FrameDecoder();
  const relay = createEventRelay({
    hub: () => r.hub as HubContext,
    links: {
      sendFrame: (_id, frame) => {
        if (link.backlog === null) {
          return false;
        }
        for (const d of decoder.push(frame)) {
          if (d.kind === 'message' && d.msg.t === 'event') {
            sent.push(d.msg);
          }
        }
        return true;
      },
      backlog: () => link.backlog,
      views: () => [PEER],
    },
    heldAt: (id) => held(id),
    mode: () => 'on',
    tap: () => null,
    limits: { retryMs: 5, ...limits },
    log: () => undefined,
  });
  relay.start();
  cleanups.push(() => relay.stop());
  relay.onUp(PEER);
  sent.length = 0; // the snapshot of a hub that holds no board
  return {
    r,
    relay,
    sent,
    link,
    event: (type, n = 0) => r.events.publish({ type, device: DEV, t_hub_us: nowUs(), part: 'event', fields: { n } }),
    state: (prop, value) => r.events.publish({ type: `knob.${prop}`, device: DEV, t_hub_us: nowUs(), part: 'state', member: prop, fields: { [prop]: value } }),
  };
}

const eventsOf = (sent: EventMsg[]) => sent.flatMap((m) => (m.events ?? []) as HubEvent[]);

describe('the event relay queue (design multi-hub-m2 step 2.4)', () => {
  it('writes what one tick published as batches, in order, each with the hub clock', async () => {
    const b = await bench();
    const made = Array.from({ length: 600 }, (_, i) => b.event('boot.down', i));
    expect(b.sent).toEqual([]); // nothing is written inside the publish tick
    await until(() => eventsOf(b.sent).length === 600, 2000, 'the batches');
    expect(b.sent.map((m) => m.events!.length)).toEqual([256, 256, 88]);
    expect(eventsOf(b.sent).map((e) => e.seq)).toEqual(made.map((e) => e.seq));
    for (const m of b.sent) {
      expect(m.v).toBe(1);
      expect(Math.abs(m.now_us - nowUs())).toBeLessThan(5_000_000);
      expect(m.dropped).toBeUndefined();
    }
    expect(b.relay.status()).toMatchObject({ speaks: true, counters: { events_sent: 600, events_dropped: 0, event_msgs_out: 4 }, peers: { [PEER.id]: { speaks: true, sent: 600, dropped: 0, queued: 0 } } });
  });

  it('only what crosses is queued, and never an event another hub relayed', async () => {
    const b = await bench();
    b.r.events.publish({ type: 'device.provisioned', device: DEV, t_hub_us: nowUs() });
    b.r.events.publish({ type: 'registry.drift', device: DEV, t_hub_us: nowUs() });
    b.r.events.publish({ type: 'port.attached', device: DEV, t_hub_us: nowUs() });
    b.r.events.publish({ type: 'hub.warning', t_hub_us: nowUs() });
    b.r.events.relay({ type: 'boot.down', device: DEV, t_hub_us: nowUs(), hub: 'hub-c' });
    b.event('boot.up');
    await until(() => eventsOf(b.sent).length > 0, 2000, 'the one event');
    await sleep(30);
    expect(eventsOf(b.sent).map((e) => e.type)).toEqual(['boot.up']);
    expect(crosses({ type: 'boot.down', device: DEV, hub: 'hub-c' })).toBe(false);
    expect(crosses({ type: 'job.state' })).toBe(true);
    expect(crosses({ type: 'made.up' })).toBe(false);
  });

  it('writes nothing while the connection is behind, then all of it; a link that is gone drops what waited', async () => {
    const b = await bench();
    b.link.backlog = 10 << 20;
    for (let i = 0; i < 50; i++) {
      b.event('boot.down', i);
    }
    await sleep(60);
    expect(b.sent).toEqual([]);
    expect(b.relay.status().peers[PEER.id]).toMatchObject({ queued: 50, sent: 0 });
    b.link.backlog = 0;
    await until(() => eventsOf(b.sent).length === 50, 2000, 'the queue');
    expect(eventsOf(b.sent).map((e) => e.fields?.n)).toEqual([...Array(50).keys()]);
    // The link goes: what waited is not kept for the next one.
    b.link.backlog = 10 << 20;
    b.event('boot.down', 99);
    await sleep(20);
    b.link.backlog = null;
    await sleep(40);
    expect(b.relay.status().peers[PEER.id].queued).toBe(0);
  });

  it('behind: a STATE gives way to a newer one of its property, and the newest of each is always sent', async () => {
    const b = await bench({ coalesceAbove: 8 });
    b.link.backlog = 10 << 20;
    for (let i = 0; i < 300; i++) {
      b.state('level', i);
      b.state('gain', 1000 + i);
    }
    b.event('boot.down', 1);
    await sleep(30);
    // Bounded by the properties, not by how often they changed.
    expect(b.relay.status().peers[PEER.id].queued).toBeLessThan(20);
    b.link.backlog = 0;
    await until(() => eventsOf(b.sent).some((e) => e.type === 'boot.down'), 2000, 'the queue');
    const got = eventsOf(b.sent);
    expect(got.filter((e) => e.type === 'knob.level').at(-1)!.fields).toEqual({ level: 299 });
    expect(got.filter((e) => e.type === 'knob.gain').at(-1)!.fields).toEqual({ gain: 1299 });
    expect(got.map((e) => e.seq)).toEqual([...got.map((e) => e.seq)].sort((x, y) => x - y)); // still in order
    const st = b.relay.status();
    expect(st.counters.events_coalesced).toBeGreaterThan(550);
    expect(st.counters.events_dropped).toBe(0);
    expect(st.peers[PEER.id].coalesced).toBe(st.counters.events_coalesced);
    expect(b.relay.warnings()).toEqual([]); // a value a newer one replaced is not a lost event
  });

  it('full: the oldest events go first, the peer is told how many, and hub_status warns', async () => {
    const b = await bench({ queueMax: 100, coalesceAbove: 8 });
    b.link.backlog = 10 << 20;
    for (let i = 0; i < 500; i++) {
      b.event('boot.down', i);
      if (i % 50 === 0) {
        b.state('level', i);
      }
    }
    await sleep(30);
    const waiting = b.relay.status().peers[PEER.id];
    expect(waiting.queued).toBe(100);
    expect(waiting.dropped).toBe(500 + 10 - 100 - waiting.coalesced);
    b.link.backlog = 0;
    await until(() => eventsOf(b.sent).length === 100, 2000, 'the queue');
    const got = eventsOf(b.sent);
    // The newest events, and the property's newest value.
    expect(got.filter((e) => e.type === 'boot.down').at(-1)!.fields).toEqual({ n: 499 });
    expect(got.filter((e) => e.type === 'boot.down')[0].fields!.n).toBeGreaterThan(390);
    expect(got.filter((e) => e.type === 'knob.level').at(-1)!.fields).toEqual({ level: 450 });
    // Said once, in the first message after the drop.
    expect(b.sent.map((m) => m.dropped ?? 0)).toEqual([waiting.dropped]);
    expect(b.relay.status().counters).toMatchObject({ events_dropped: waiting.dropped, events_sent: 100 });
    expect(b.relay.warnings()).toEqual([expect.stringContaining(`${waiting.dropped} events were not sent to hub hub-b`)]);
    // Bytes bound it too.
    const big = await bench({ queueMaxBytes: 20_000 });
    big.link.backlog = 10 << 20;
    for (let i = 0; i < 100; i++) {
      big.r.events.publish({ type: 'msg', device: DEV, t_hub_us: nowUs(), fields: { data: 'x'.repeat(1000) } });
    }
    await sleep(20);
    expect(big.relay.status().peers[PEER.id].queued).toBeLessThan(20);
    expect(big.relay.status().counters.events_dropped).toBeGreaterThan(80);
  });

  it('a job change replaces the one waiting for the same job, and keeps the stronger kind', async () => {
    const b = await bench();
    const jobs: Parameters<NonNullable<HubContext['jobs']>['onChange']>[0][] = [];
    // The relay subscribed to the rig's job runner if it had one; here the changes are handed over as the runner would.
    const r2 = await rig();
    cleanups.push(() => r2.close());
    const sent: EventMsg[] = [];
    const decoder = new FrameDecoder();
    const relay = createEventRelay({
      hub: () => ({ ...r2.hub, jobs: { onChange: (fn: (typeof jobs)[number]) => (jobs.push(fn), () => undefined), list: () => [] } }) as unknown as HubContext,
      links: { sendFrame: (_id, f) => (decoder.push(f).forEach((d) => d.kind === 'message' && d.msg.t === 'event' && sent.push(d.msg)), true), backlog: () => 0, views: () => [PEER] },
      heldAt: () => null,
      mode: () => 'on',
      tap: () => null,
      log: () => undefined,
    });
    relay.start();
    cleanups.push(() => relay.stop());
    relay.onUp(PEER);
    sent.length = 0;
    const job = { job_id: 'j_1', kind: 'build', status: 'working', targets: [], created_at: 't' } as never;
    jobs[0]({ ...(job as object), stage: 'compile' } as never, 'stage');
    for (let i = 0; i < 20; i++) {
      jobs[0]({ ...(job as object), stage: 'compile', progress: { pct: i } } as never, 'progress');
    }
    await until(() => sent.length > 0, 2000, 'the job message');
    expect(sent).toHaveLength(1);
    expect(sent[0].jobs).toEqual([{ job_id: 'j_1', kind: 'build', status: 'working', stage: 'compile', progress: { pct: 19 }, change: 'stage' }]);
    void b;
  });

  it("what a peer sends is published live: this hub's seq, the sender's name, its clock moved, where the board is", async () => {
    const b = await bench({}, (id) => (id === DEV ? 'hub-c' : null));
    const fleet: HubEvent[] = [];
    const own: HubEvent[] = [];
    b.r.events.subscribe((e) => own.push(e));
    (b.r.events.subscribe as (fn: (e: HubEvent) => void, o: { relayed: boolean }) => () => void)((e) => fleet.push(e), { relayed: true });
    const theirClock = nowUs() - 7_000_000; // the other hub's clock is 7 s behind this one's
    const ev = (type: string, extra: Record<string, unknown> = {}) => ({ cursor: 'c:1000000003.41', seq: 41, type, device: DEV, t_hub_us: theirClock - 20_000, ...extra });
    const took = b.relay.onMessage(PEER, {
      t: 'event',
      v: 1,
      now_us: theirClock,
      dropped: 3,
      events: [
        ev('boot.down', { part: 'event', fields: { n: 1 } }),
        ev('device.offline', { fields: { reason: 'silent' } }),
        ev('knob.level', { part: 'state', member: 'level', fields: { level: 7 } }),
        { not: 'an event' },
        ev('boot.down', { hub: 'hub-c' }), // one it was itself sent: nothing is relayed twice
        ev('device.provisioned'), // the registry announces that itself
        ev('port.attached'),
      ],
    });
    expect(took).toBe(true);
    expect(own).toEqual([]); // the parts that act on this hub's own sessions hear none of it
    expect(fleet.map((e) => e.type)).toEqual(['boot.down', 'device.offline', 'knob.level']);
    for (const e of fleet) {
      expect(e.hub).toBe('hub-b');
      expect(e.hub_cursor).toBe('c:1000000003.41');
      expect(e.cursor).toBe(`c:1.${e.seq}`);
      // 20 ms before the message was written, in this hub's clock (give or take the test's own delay).
      expect(Math.abs(nowUs() - 20_000 - e.t_hub_us)).toBeLessThan(500_000);
    }
    expect(fleet[1].fields).toEqual({ reason: 'silent', at: 'hub-c' });
    expect(b.relay.properties(DEV)).toEqual({ 'knob.level': 7 });
    expect(b.relay.states(DEV).map((e) => [e.type, e.hub])).toEqual([['knob.level', 'hub-b']]);
    expect(b.relay.status().counters).toMatchObject({ events_received: 3, events_bad: 4, events_missed: 3 });
    expect(b.relay.warnings()).toEqual([expect.stringContaining('hub hub-b did not send 3 of its events to this hub')]);
    // Nothing of it is a row.
    b.r.events.flush();
    expect(b.r.db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
    // A snapshot replaces what was mirrored and publishes nothing.
    b.relay.onMessage(PEER, { t: 'event', v: 1, now_us: theirClock, snapshot: true, first: true, events: [ev('knob.gain', { part: 'state', member: 'gain', fields: { gain: 2 } })] } as EventMsg);
    expect(fleet).toHaveLength(3);
    expect(b.relay.properties(DEV)).toEqual({ 'knob.gain': 2 });
    // The board's session there ended, or that hub went away: forgotten.
    b.relay.forget(PEER.id, DEV);
    expect(b.relay.properties(DEV)).toBeNull();
  });

  it('a hub that relays none (mode off) says no `events`, sends none and takes none', async () => {
    const r = await rig();
    cleanups.push(() => r.close());
    const frames: Buffer[] = [];
    const relay = createEventRelay({ hub: () => r.hub as HubContext, links: { sendFrame: (_i, f) => (frames.push(f), true), backlog: () => 0, views: () => [PEER] }, heldAt: () => null, mode: () => 'off', tap: () => null, log: () => undefined });
    relay.start();
    cleanups.push(() => relay.stop());
    expect(relay.hello()).toBeUndefined();
    relay.onUp(PEER);
    r.events.publish({ type: 'boot.down', device: DEV, t_hub_us: nowUs() });
    await sleep(30);
    expect(frames).toEqual([]);
    expect(relay.onMessage(PEER, { t: 'event', v: 1, now_us: 1, events: [] })).toBe(false);
    expect(relay.relays(PEER.id)).toBe(false);
    expect(relay.warnings()).toEqual([]);
  });
});
