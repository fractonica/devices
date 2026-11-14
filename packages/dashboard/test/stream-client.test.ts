// The dashboard's /app/stream client (src/api/stream.ts, DEVICE-SPEC §3.3) against a scripted socket: the hello carries
// the token and `start`; 4400, 4401 and 4409 are final while other closes reconnect with /ws's backoff; the hub's gaps
// and this page's own skips are counted; a frame that comes while one decodes waits, and a newer one replaces it.

import { describe, expect, it } from 'vitest';

import { encodeJpegBlock } from '@fractonica/sdk/camera';

import { NO_RECONNECT, StreamClient, type StreamClientEvent, type StreamSocketLike, streamUrl } from '../src/api/stream.ts';
import { BACKOFF_MS } from '../src/api/ws.ts';
import { ManualTimers } from './fakes.ts';

class FakeStreamSocket implements StreamSocketLike {
  binaryType = 'blob';
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  open(): void {
    this.onopen?.({});
  }
  text(f: object): void {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  binary(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
  drop(code: number): void {
    this.onclose?.({ code, reason: '' });
  }
}

const JPEG = (n: number) => Uint8Array.from([0xff, 0xd8, n & 0xff, 0xff, 0xd9]);
const block = (seq: number, index = seq) => encodeJpegBlock({ seq, index, tUs: seq * 1000, width: 800, height: 600, quality: 12, frameSize: 'svga' }, JPEG(index));
const INFO = { stream_id: 7, kind: 'jpeg', format: 'mjpg1', to: 'hub', interval_ms: 0, seconds: 0 };

/** A client on fake sockets and manual timers; decodes resolve only when the test says. */
function rig(o: { start?: { interval_ms?: number; frame_size?: 'svga'; quality?: number } } = {}) {
  const sockets: FakeStreamSocket[] = [];
  const timers = new ManualTimers();
  const events: StreamClientEvent[] = [];
  const decodes: { jpeg: Uint8Array; resolve: (v: number) => void }[] = [];
  const drawn: number[] = [];
  const client = new StreamClient<number>({
    url: 'ws://127.0.0.1:9/app/stream',
    token: 'tok-123',
    device: 'a0b1c2d3e4f5',
    instance: 'cam',
    ...(o.start ? { start: o.start } : {}),
    connect: (url) => {
      const s = new FakeStreamSocket(url);
      sockets.push(s);
      return s;
    },
    decode: (jpeg) => new Promise<number>((resolve) => decodes.push({ jpeg, resolve })),
    onFrame: (f) => drawn.push(f.block.index),
    onEvent: (e) => events.push(e),
    timers,
  });
  return { client, sockets, timers, events, decodes, drawn };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the /app/stream client', () => {
  it('says hello with the token, the device, the instance and WATCH’s start; answers ping with pong', () => {
    const r = rig({ start: { interval_ms: 0, frame_size: 'svga', quality: 10 } }).client.start();
    const t = rig({ start: { interval_ms: 0 } });
    t.client.start();
    const s = t.sockets[0]!;
    expect(s.url).toBe('ws://127.0.0.1:9/app/stream');
    s.open();
    expect(s.binaryType).toBe('arraybuffer');
    expect(s.sent[0]).toEqual({ t: 'stream.hello', v: 1, token: 'tok-123', device: 'a0b1c2d3e4f5', instance: 'cam', start: { interval_ms: 0 } });
    s.text({ t: 'stream.welcome', v: 1, device: 'a0b1c2d3e4f5', alias: 'cam-esp32', instance: 'cam', stream: INFO });
    expect(t.client.stream).toEqual(INFO);
    s.text({ t: 'ping', id: 4 });
    expect(s.sent[1]).toEqual({ t: 'pong', id: 4 });
    expect(t.events.map((e) => e.type)).toEqual(['connecting', 'welcome']);
    r.stop();
    // joining (no start): the hello has none
    const j = rig();
    j.client.start();
    j.sockets[0]!.open();
    expect(j.sockets[0]!.sent[0]).not.toHaveProperty('start');
    expect(streamUrl({ protocol: 'http:', host: '127.0.0.1:7420' })).toBe('ws://127.0.0.1:7420/app/stream');
    expect(streamUrl({ protocol: 'https:', host: 'h:1' })).toBe('wss://h:1/app/stream');
  });

  it('does not reconnect after 4400, 4401 or 4409; other closes back off as /ws does, and a welcome resets the backoff', () => {
    expect([...NO_RECONNECT].sort()).toEqual([4400, 4401, 4409]);
    for (const code of [4400, 4401, 4409]) {
      const t = rig();
      t.client.start();
      t.sockets[0]!.open();
      t.sockets[0]!.drop(code);
      expect(t.events.at(-1)).toEqual({ type: 'closed', code, reason: '', final: true });
      t.timers.advance(60_000);
      expect(t.sockets).toHaveLength(1);
      expect(t.client.stopped).toBe(true);
    }
    const t = rig({ start: { interval_ms: 0 } });
    t.client.start();
    t.sockets[0]!.drop(1006);
    expect(t.events.at(-1)).toEqual({ type: 'closed', code: 1006, reason: '', final: false });
    expect(t.timers.pending()).toEqual([BACKOFF_MS[0]]);
    t.timers.advance(BACKOFF_MS[0]);
    expect(t.sockets).toHaveLength(2);
    t.sockets[1]!.drop(1001);
    expect(t.timers.pending()).toEqual([BACKOFF_MS[1]]);
    t.timers.advance(BACKOFF_MS[1]);
    t.sockets[2]!.drop(4429);
    expect(t.timers.pending()).toEqual([BACKOFF_MS[2]]);
    t.timers.advance(BACKOFF_MS[2]);
    // the reconnect says the same hello again, start included
    t.sockets[3]!.open();
    expect(t.sockets[3]!.sent[0]).toMatchObject({ t: 'stream.hello', token: 'tok-123', start: { interval_ms: 0 } });
    t.sockets[3]!.text({ t: 'stream.welcome', v: 1, device: 'd', alias: 'a', instance: 'cam', stream: null });
    t.sockets[3]!.drop(1006);
    expect(t.timers.pending()).toEqual([BACKOFF_MS[0]]);
    // stop() ends it for good: the pending retry is dropped, the socket closed 1000
    t.client.stop();
    expect(t.timers.pending()).toEqual([]);
    expect(t.events.at(-1)).toEqual({ type: 'closed', code: 1000, reason: 'left', final: true });
    const u = rig();
    u.client.start();
    u.client.stop();
    expect(u.sockets[0]!.closed).toEqual({ code: 1000, reason: 'left' });
  });

  it('counts the hub’s gaps, tells started and ended, and passes the hub’s errors on', () => {
    const t = rig({ start: {} });
    t.client.start();
    const s = t.sockets[0]!;
    s.open();
    s.text({ t: 'stream.welcome', v: 1, device: 'd', alias: 'a', instance: 'cam', stream: null });
    s.text({ t: 'error', code: 'DEVICE_BUSY', message: 'cam runs stream 3, which is not published live' });
    s.text({ t: 'stream.started', stream: INFO });
    s.text({ t: 'stream.gap', stream_id: 7, blocks: 12 });
    s.text({ t: 'stream.gap', stream_id: 7, blocks: 3 });
    s.text({ t: 'stream.ended', stream_id: 7, reason: 'stopped', records: 40, dropped: 1, bytes: 1000 });
    expect(t.client.counts.hubSkipped).toBe(15);
    expect(t.client.stream).toBeNull();
    expect(t.events.filter((e) => e.type !== 'connecting')).toEqual([
      { type: 'welcome', stream: null, alias: 'a', instance: 'cam' },
      { type: 'error', code: 'DEVICE_BUSY', message: 'cam runs stream 3, which is not published live' },
      { type: 'started', stream: INFO },
      { type: 'skipped', frames: 12, by: 'hub' },
      { type: 'skipped', frames: 3, by: 'hub' },
      { type: 'ended', frame: { t: 'stream.ended', stream_id: 7, reason: 'stopped', records: 40, dropped: 1, bytes: 1000 } },
    ]);
  });

  it('decodes one frame at a time: a frame during a decode waits, a newer one replaces it (counted as skipped here)', async () => {
    const t = rig({ start: {} });
    t.client.start();
    const s = t.sockets[0]!;
    s.open();
    s.text({ t: 'stream.welcome', v: 1, device: 'd', alias: 'a', instance: 'cam', stream: INFO });
    s.binary(block(0));
    expect(t.decodes).toHaveLength(1);
    expect(Array.from(t.decodes[0]!.jpeg)).toEqual(Array.from(JPEG(0)));
    s.binary(block(1)); // waits
    s.binary(block(2)); // replaces 1
    s.binary(block(3)); // replaces 2
    expect(t.decodes).toHaveLength(1);
    expect(t.client.counts.hereSkipped).toBe(2);
    t.decodes[0]!.resolve(0);
    await flush();
    expect(t.drawn).toEqual([0]);
    expect(t.decodes).toHaveLength(2); // the newest waiting one, 3
    expect(t.decodes[1]!.jpeg[2]).toBe(3);
    t.decodes[1]!.resolve(3);
    await flush();
    expect(t.drawn).toEqual([0, 3]);
    expect(t.client.counts.frames).toBe(2);
    expect(t.events.filter((e) => e.type === 'skipped')).toEqual([
      { type: 'skipped', frames: 1, by: 'here' },
      { type: 'skipped', frames: 1, by: 'here' },
    ]);
    // not an mjpg1 block: counted, never drawn
    s.binary(Uint8Array.from([1, 2, 3]));
    expect(t.client.counts.bad).toBe(1);
    expect(t.decodes).toHaveLength(2);
    // a decode that resolves after stop() draws nothing
    s.binary(block(4));
    t.client.stop();
    t.decodes[2]!.resolve(4);
    await flush();
    expect(t.drawn).toEqual([0, 3]);
  });
});
