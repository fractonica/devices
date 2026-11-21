// Human rendering of the node <-> node ops (design c5 §4; stream H1): message_send (one send, unicast
// results, the repeat job), binding_set|list|clear and latency_stats print lines and aligned tables
// instead of the YAML dump.

import { describe, expect, it } from 'vitest';

import { renderResult } from '../src/render.ts';

const ok = (data: unknown) => ({ ok: true, cursor: 'c:1.1', data });

const binding = {
  slot: 0,
  on_port: 1,
  on_cls: 3,
  on_kind: 1,
  on_topic: '',
  to_mac: '112233445566',
  to_addr: 0x34,
  to_port: 2,
  to_cls: 4,
  to_kind: 3,
  to_topic: '',
  payload: '08c80110c8011801',
  reliable: true,
};

describe('message_send rendering', () => {
  it('prints one broadcast, unicast results and the repeat job', () => {
    expect(renderResult('message_send', ok({ to: 'broadcast', topic: 'scene', bytes: 2, seq: 7, sessions: 3, seeded: true })).out).toBe(
      'broadcast scene seq 7 to 3 node(s); nodes flood it over ESP-NOW',
    );
    expect(renderResult('message_send', ok({ to: 'broadcast', topic: 'scene', seq: 8, sessions: 3, seeded: false })).out).toMatch(/TCP only \(over the flood rate\)$/);
    const uni = renderResult(
      'message_send',
      ok({
        to: 'tag:poc',
        topic: 'scene',
        results: [
          { device: 'a0', alias: 'pad-c6', status: 'ok', rtt_ms: 3, link: 'tcp' },
          { device: 'b0', alias: 'pad-c3', status: 'offline', error: 'pad-c3 is offline' },
        ],
      }),
    );
    expect(uni.out.split('\n')).toEqual(['msg scene', 'DEVICE  STATUS   RTT   LINK', 'pad-c6  ok       3 ms  tcp', 'pad-c3  offline  -     -', 'pad-c3: pad-c3 is offline']);
    const job = renderResult(
      'message_send',
      ok({
        job_id: 'j_m1',
        kind: 'msg',
        status: 'completed',
        progress: { pct: 100 },
        targets: ['broadcast'],
        created_at: '2026-10-22T00:00:00Z',
        result: { to: 'broadcast', topic: 'flood', count: 1000, sent: 1000, seeded: 998, tcp_only: 2, no_session: 0, first_seq: 5, last_seq: 1004, sessions_max: 3, duration_ms: 100_200 },
      }),
    );
    expect(job.out.split('\n')).toEqual(['j_m1 msg completed 100%', 'broadcast flood: 1000/1000 sent seq 5..1004, 998 flooded, 2 TCP-only (over the flood rate) in 100.2s']);
  });
});

describe('bindings rendering', () => {
  it('prints binding_set as one line', () => {
    const row = { device: 'a0', alias: 'pad-c6', slot: 0, from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { count: 1 }, pushed: true, replaced: false, binding };
    expect(renderResult('binding_set', ok(row)).out).toBe('pad-c6 slot 0: pad-c6.boot.down -> pad-c3.status.blink {"count":1}  pushed');
    expect(renderResult('binding_set', ok({ ...row, pushed: false, pending: 'pad-c6 is offline: pushed at its next handshake' })).out).toMatch(/pending: pad-c6 is offline/);
  });

  it('prints binding_list as a table, --live per node, and binding_clear as one line', () => {
    expect(renderResult('binding_list', ok({ bindings: [], count: 0, truncated: false })).out).toMatch(/^no bindings; try: fr bind/);
    const table = renderResult(
      'binding_list',
      ok({
        bindings: [{ device: 'a0', alias: 'pad-c6', slot: 0, from: 'pad-c6.boot.down', to: 'pad-c3.status.blink', args: { count: 1 }, pushed: true, binding }],
        count: 1,
        truncated: false,
      }),
    );
    expect(table.out.split('\n')).toEqual(['DEVICE  SLOT  FROM              TO                   ARGS         PUSHED', 'pad-c6  0     pad-c6.boot.down  pad-c3.status.blink  {"count":1}  yes']);
    const live = renderResult(
      'binding_list',
      ok({
        devices: [
          { device: 'a0', alias: 'pad-c6', presence: 'online', bindings: [{ slot: 0, binding, registry: 'same' }], missing: [3] },
          { device: 'b0', alias: 'pad-c3', presence: 'offline', error: 'pad-c3 is offline', registry_slots: [] },
        ],
      }),
    );
    const lines = live.out.split('\n');
    expect(lines[0].split(/\s{2,}/)).toEqual(['DEVICE', 'SLOT', 'ON', 'TO', 'PAYLOAD', 'REGISTRY']);
    expect(lines[1].split(/\s{2,}/)).toEqual(['pad-c6', '0', 'event port 1 id 1', '0x0034 (112233445566) cmd port 2 id 3', '08c80110c8011801', 'same']);
    expect(lines.slice(2)).toEqual(['pad-c6: registry slots not on the node: 3 (pushed at its next handshake)', 'pad-c3: pad-c3 is offline']);
    expect(renderResult('binding_clear', ok({ device: 'a0', alias: 'pad-c6', slot: 'all', cleared: [0, 2], pushed: true })).out).toBe('pad-c6 slot all: cleared slots 0, 2; the node cleared it');
    expect(renderResult('binding_clear', ok({ device: 'a0', alias: 'pad-c6', slot: 1, cleared: [], pushed: false, pending: 'pad-c6 is offline: pushed at its next handshake' })).out).toBe(
      'pad-c6 slot 1: no registry rows there; the node: pad-c6 is offline: pushed at its next handshake',
    );
  });
});

describe('latency_stats rendering', () => {
  it('prints the event loop and one row per device and metric with samples', () => {
    const none = { n: 0, p50_ms: null, p99_ms: null, max_ms: null };
    const out = renderResult(
      'latency_stats',
      ok({
        window_s: 60,
        event_loop: { seconds: 60, p50_ms: 0.01, p99_ms: 0.52, max_ms: 1.3 },
        devices: [
          {
            device: 'a0',
            alias: 'pad-c6',
            presence: 'online',
            ping: { tcp: { n: 8, p50_ms: 0.41, p99_ms: 0.9, max_ms: 1.1 } },
            input: { n: 3, p50_ms: 3.1, p99_ms: 9.8, max_ms: 9.8 },
            bindings: { espnow: { n: 5, p50_ms: 4.2, p99_ms: 8, max_ms: 8, fast: 2, failed: 0 }, hub: { ...none, fast: 0, failed: 0 }, flood: { ...none, fast: 0, failed: 0 } },
          },
          { device: 'b0', alias: 'pad-c3', presence: 'offline', ping: {}, input: none, bindings: {} },
        ],
        count: 2,
        truncated: false,
      }),
    ).out;
    expect(out.split('\n')).toEqual([
      'hub event-loop delay over 60 s: p50 0.01 ms, p99 0.52 ms, max 1.3 ms',
      'DEVICE  METRIC          N  P50      P99     MAX',
      'pad-c6  ping tcp        8  0.41 ms  0.9 ms  1.1 ms',
      'pad-c6  input -> hub    3  3.1 ms   9.8 ms  9.8 ms',
      'pad-c6  binding espnow  5  4.2 ms   8 ms    8 ms    fast 2',
      'no samples in the last 60 s: pad-c3',
    ]);
  });
});

describe("the hubs' link rendering (design multi-hub-m2)", () => {
  const peers = {
    net_id: 41235,
    hub: { id: 'a0b1c2d3e4f5', name: 'attic', slot: 1 },
    registrar: 'lab',
    members_version: 2,
    link: { listening: true, port: 7423, error: null },
    peers: [
      { id: '5d1c20a0b1c2', name: 'lab', this: false, role: 'registrar', slot: 0, host: 'lab-hub.local', reachable: false, since: null, registry_hash: null, hub_epoch: null, boards: null, address: null, last_error: '192.168.1.20:7423: ECONNREFUSED' },
      { id: 'a0b1c2d3e4f5', name: 'attic', this: true, role: 'member', slot: 1, host: 'attic.local', reachable: true, since: '2026-11-21T10:00:00.000Z', registry_hash: '7113df84c91b', hub_epoch: 16390, boards: 3, address: '192.168.1.30:7423' },
    ],
  };

  it('prints hub_peers as a table, this hub marked, and why an unreachable hub is not', () => {
    const lines = renderResult('hub_peers', ok(peers)).out.split('\n');
    expect(lines[0]).toBe('network 41235: this hub is attic (a0b1c2d3e4f5, slot 1); registrar lab; link listening on 7423');
    expect(lines[1].split(/\s{2,}/)).toEqual(['HUB', 'ID', 'ROLE', 'SLOT', 'REACHABLE', 'SINCE', 'EPOCH', 'REGISTRY', 'BOARDS', 'ADDRESS']);
    expect(lines[2].split(/\s{2,}/)).toEqual(['lab', '5d1c20a0b1c2', 'registrar', '0', 'no', '-', '-', '-', '-', '-']);
    expect(lines[3].split(/\s{2,}/).slice(0, 5)).toEqual(['attic (this hub)', 'a0b1c2d3e4f5', 'member', '1', '-']);
    expect(lines[3]).toMatch(/16390\s+7113df84c91b\s+3\s+192\.168\.1\.30:7423$/);
    // SINCE is the local date and time of day, both from one clock.
    const at = new Date('2026-11-21T10:00:00.000Z');
    const local = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${at.toLocaleTimeString('en-GB', { hour12: false })}`;
    expect(lines[3].split(/\s{2,}/)[5]).toBe(local);
    expect(lines[4]).toBe('lab: not reachable (192.168.1.20:7423: ECONNREFUSED)');
    expect(lines).toHaveLength(5);
    expect(renderResult('hub_peers', ok({ ...peers, link: { listening: false, port: null, error: '0.0.0.0:7423: EADDRINUSE' } })).out).toContain('link not listening (0.0.0.0:7423: EADDRINUSE)');
  });

  it('prints how the device registry stands with each reachable hub (design multi-hub-m2 step 2.3)', () => {
    const lab = { ...peers.peers[0], reachable: true, last_error: undefined };
    const withRegistry = (registry: Record<string, unknown>, top: Record<string, unknown> = {}) =>
      renderResult('hub_peers', ok({ ...peers, peers: [{ ...lab, registry }, peers.peers[1]], registry: { rows: 14, tombstones: 0, hash: 'a1', conflicts: [], ...top } })).out.split('\n');
    expect(withRegistry({ speaks: true, in_step: true, rows: 14, sent: 10, received: 0 }).at(-1)).toBe('registry: 14 rows; lab in step, 10 sent, 0 received');
    expect(withRegistry({ speaks: true, in_step: false, rows: 4, sent: 0, received: 0, conflicts: 1 }, { tombstones: 2 }).at(-1)).toBe('registry: 14 rows, 2 deleted; lab differs (4 rows there), 0 sent, 0 received, 1 not taken');
    expect(withRegistry({ speaks: false, in_step: null, rows: null }).at(-1)).toBe('registry: 14 rows; lab does not replicate');
    const conflict = withRegistry({ speaks: true, in_step: false, rows: 14, sent: 1, received: 1, conflicts: 1 }, { conflicts: [{ device: 'aabbcc000001', hub: 'lab', message: 'pad is addr 7 here and addr 9 at hub lab: neither copy was changed' }] });
    expect(conflict.at(-1)).toBe('registry: pad is addr 7 here and addr 9 at hub lab: neither copy was changed');
    // A hub from before the registry was replicated answers no `registry`: the table alone, as before.
    expect(renderResult('hub_peers', ok(peers)).out).not.toContain('registry:');
  });

  it('prints the live data with each reachable hub (design multi-hub-m2 step 2.4)', () => {
    const lab = { ...peers.peers[0], reachable: true, last_error: undefined };
    const withEvents = (events: Record<string, unknown>, streams?: Record<string, unknown>) => renderResult('hub_peers', ok({ ...peers, peers: [{ ...lab, events, ...(streams ? { streams } : {}) }, peers.peers[1]] })).out.split('\n');
    expect(withEvents({ speaks: true, sent: 1240, received: 318, dropped: 0, missed: 0, queued: 0 }).at(-1)).toBe('events: lab 1240 sent, 318 received');
    expect(withEvents({ speaks: true, sent: 9, received: 2, dropped: 40, missed: 3, queued: 12 }, { speaks: true, open: 1 }).at(-1)).toBe('events: lab 9 sent, 2 received, 40 dropped, 3 missed, 12 waiting, 1 stream relayed');
    expect(withEvents({ speaks: true, sent: 0, received: 0 }, { speaks: true, open: 2 }).at(-1)).toBe('events: lab 0 sent, 0 received, 2 streams relayed');
    // A hub from before step 2.4 relays none; a hub that is not reachable has no line; an older answer has no `events`.
    expect(withEvents({ speaks: false }).at(-1)).toBe('events: lab relays none');
    expect(renderResult('hub_peers', ok({ ...peers, peers: [{ ...peers.peers[0], events: { speaks: true, sent: 1, received: 1 } }, peers.peers[1]] })).out).not.toContain('events:');
    expect(renderResult('hub_peers', ok(peers)).out).not.toContain('events:');
  });

  it('prints where a board is in fr devices ls and fr devices get: the `at` of each row', () => {
    const row = { device_id: 'a0b1c2d3e4f5', alias: 'pad-c6', presence: 'offline', at: 'lab' };
    expect(renderResult('device_list', ok({ devices: [row], count: 1, truncated: false })).out).toContain('at: lab');
    expect(renderResult('device_get', ok({ ...row, hub_now: { here: false, at: 'lab' } })).out).toMatch(/at: lab[\s\S]*hub_now:[\s\S]*at: lab/);
    expect(renderResult('device_list', ok({ devices: [{ ...row, at: null }], count: 1, truncated: false })).out).toContain('at: null');
  });
});
