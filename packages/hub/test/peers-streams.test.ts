// The relayed stream's channel alone (design multi-hub-m2 §8, §17; peers/streams.ts): two PeerLinks on loopback, each
// with its files' channels and its streams, as peers/index.ts wires them. What is on the wire for an `open`, a text
// frame and a block (the kind byte, the pieces, the acks), what the pipe says is buffered when the other hub takes
// nothing, the close from either end, a hub that serves no streams, a block too large, and the link going away.
// peers-live.test.ts runs it under real stream sockets; interop-live.test.ts with a board.

import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { PeerChannels } from '../src/peers/channels.ts';
import { type LinkTarget, PeerLinks, type PeerLinkTiming } from '../src/peers/link.ts';
import { PeerStreams, type RelaySink, STREAM_BLOCK_MAX, STREAM_CHANNEL, type StreamPipe } from '../src/peers/streams.ts';
import { type PeerMessage, STREAM_BLOCK_END, STREAM_BLOCK_MORE, STREAM_TEXT } from '../src/peers/wire.ts';
import { until } from './fake-node.ts';

const FAST: Partial<PeerLinkTiming> = { pingMs: 80, awayMs: 400, backoffMinMs: 20, backoffMaxMs: 160, connectMs: 800, helloMs: 600 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

interface End {
  id: string;
  name: string;
  links: PeerLinks;
  channels: PeerChannels;
  streams: PeerStreams;
  known: Map<string, LinkTarget>;
  /** Every control message and data frame this end received, in order. */
  got: ({ msg: PeerMessage } | { ch: number; kind: number; bytes: number })[];
  /** Acks are held back while false: a hub that takes nothing. */
  acking: boolean;
}

function end(id: string, name: string, key: Buffer): End {
  const e = { id, name, known: new Map<string, LinkTarget>(), got: [], acking: true } as unknown as End;
  e.links = new PeerLinks({
    listen: { host: '127.0.0.1', port: 0 },
    key: () => ({ key, net: 0x2222 }),
    hello: () => ({ hub_id: id, name, net: 0x2222, registry_hash: 'r', hub_epoch: 1, members_version: 1, streams: 1, ...(e.links.port() ? { link_port: e.links.port()! } : {}) }),
    targets: () => [...e.known.values()],
    onUp: (p) => e.streams.onLink(p, 'replaced'),
    onDown: (p, why) => {
      e.channels.onLink(p, why);
      e.streams.onLink(p, why);
    },
    onMessage: (p, msg) => {
      e.got.push({ msg });
      if (!e.streams.onMessage(p, msg)) {
        e.channels.onMessage(p, msg);
      }
    },
    onData: (p, ch, bytes) => {
      e.got.push({ ch, kind: bytes[0], bytes: bytes.length - 1 });
      if (!e.streams.onData(p, ch, bytes)) {
        e.channels.onData(p, ch, bytes);
      }
    },
    timing: FAST,
  });
  e.channels = new PeerChannels({ links: e.links });
  // The opener's acks pass through here, so a test can hold them back.
  e.streams = new PeerStreams({
    links: {
      send: (hub, msg) => (msg.t === 'ack' && !e.acking ? true : e.links.send(hub, msg)),
      sendData: (hub, ch, bytes, conn) => e.links.sendData(hub, ch, bytes, conn),
      backlog: (hub, conn) => e.links.backlog(hub, conn),
    },
  });
  cleanups.push(() => e.links.stop());
  return e;
}

async function pair(): Promise<[End, End]> {
  const key = randomBytes(32);
  const a = end('0000000000aa', 'hub-a', key);
  const b = end('0000000000bb', 'hub-b', key);
  for (const n of [a, b]) {
    await n.links.listen();
  }
  a.known.set(b.id, { id: b.id, name: b.name, candidates: [{ host: '127.0.0.1', port: b.links.port()! }] });
  b.known.set(a.id, { id: a.id, name: a.name, candidates: [{ host: '127.0.0.1', port: a.links.port()! }] });
  await Promise.all([a.links.sync(), b.links.sync()]);
  await until(() => a.links.view(b.id)?.reachable === true && b.links.view(a.id)?.reachable === true && a.links.connections() === 1 && b.links.connections() === 1, 4000, 'the link up at both ends');
  await sleep(50);
  a.got.length = 0;
  b.got.length = 0;
  return [a, b];
}

/** What the opening hub was handed. */
function sink(): RelaySink & { texts: string[]; blocks: Buffer[]; ended: { code: string; message: string }[] } {
  const s = { texts: [] as string[], blocks: [] as Buffer[], ended: [] as { code: string; message: string }[] };
  return { ...s, text: (json) => void s.texts.push(json), block: (bytes) => void s.blocks.push(Buffer.from(bytes)), end: (why) => void s.ended.push(why), texts: s.texts, blocks: s.blocks, ended: s.ended };
}

/** The holder's side: the pipe each relay was given, the hello it came with, and whether it was closed. */
function holder(a: End): { pipes: StreamPipe[]; hellos: Record<string, unknown>[]; closed: number; gaps: number } {
  const h = { pipes: [] as StreamPipe[], hellos: [] as Record<string, unknown>[], closed: 0, gaps: 0 };
  a.streams.serve((_peer, hello, pipe) => {
    h.pipes.push(pipe);
    h.hellos.push(hello);
    return {
      closed: () => void h.closed++,
      get gaps() {
        return h.gaps;
      },
    };
  });
  return h;
}

describe("a relayed stream's channel (design multi-hub-m2 step 2.4)", () => {
  it('open, text frames and blocks: what is on the wire, and the same bytes at the other end', async () => {
    const [a, b] = await pair();
    const h = holder(a);
    const s = sink();
    const ref = { v: 1, device: 'aabbcc000001', instance: 'cam', start: { interval_ms: 250 } };
    const relay = b.streams.relay(b.links.view(a.id)!, ref, s);
    await until(() => h.pipes.length === 1, 2000, 'the relay served');
    // The `open` names the board, the instance and what to start: that is all the holder is told.
    const open = a.got.find((g) => 'msg' in g && g.msg.t === 'open') as { msg: { kind: string; ref: unknown; ch: number } };
    expect(open.msg.kind).toBe(STREAM_CHANNEL);
    expect(open.msg.ref).toEqual(ref);
    expect(h.hellos).toEqual([ref]);
    expect(open.msg.ch).toBeGreaterThan(0x40000000); // never a number the files' channels use
    await until(() => b.got.some((g) => 'msg' in g && g.msg.t === 'accept'), 2000, 'the accept');
    const pipe = h.pipes[0];
    expect(pipe.readyState).toBe(1);
    expect(pipe.bufferedAmount).toBe(0);
    // A text frame, a small block, a block of exactly one piece, one of two pieces, an empty one.
    const blocks = [randomBytes(1000), randomBytes(65_535), randomBytes(65_536), Buffer.alloc(0)];
    pipe.send(JSON.stringify({ t: 'stream.welcome', v: 1 }), { binary: false });
    for (const blk of blocks) {
      pipe.send(blk, { binary: true });
    }
    await until(() => s.blocks.length === blocks.length, 3000, 'every block');
    expect(s.texts).toEqual(['{"t":"stream.welcome","v":1}']);
    expect(s.blocks.map((x) => x.length)).toEqual(blocks.map((x) => x.length));
    expect(Buffer.concat(s.blocks).equals(Buffer.concat(blocks))).toBe(true);
    const data = b.got.filter((g): g is { ch: number; kind: number; bytes: number } => 'ch' in g);
    expect(data.every((d) => d.ch === open.msg.ch)).toBe(true);
    expect(data.map((d) => [d.kind, d.bytes])).toEqual([
      [STREAM_TEXT, 28],
      [STREAM_BLOCK_END, 1000],
      [STREAM_BLOCK_END, 65_535],
      [STREAM_BLOCK_MORE, 65_535],
      [STREAM_BLOCK_END, 1],
      [STREAM_BLOCK_END, 0],
    ]);
    // The opener acked what it took: nothing is under way.
    await until(() => pipe.bufferedAmount === 0, 2000, 'the acks');
    expect(a.got.filter((g) => 'msg' in g && g.msg.t === 'ack').length).toBeGreaterThanOrEqual(5);
    expect(a.streams.counters).toMatchObject({ streams_served: 1, stream_blocks_out: 4 });
    expect(b.streams.counters).toMatchObject({ streams_opened: 1, stream_blocks_in: 4 });
    expect(b.streams.counters.stream_bytes_in).toBe(a.streams.counters.stream_bytes_out);
    expect(a.streams.open()).toEqual({ opened: 0, served: 1 });
    expect(b.streams.openWith(a.id)).toBe(1);
    // The opener closes (its client left): the holder hears it once, and nothing more is sent.
    h.gaps = 3;
    relay.close('the client left');
    await until(() => h.closed === 1, 2000, 'the close at the holder');
    expect(pipe.readyState).not.toBe(1);
    pipe.send(randomBytes(10), { binary: true });
    await sleep(60);
    expect(s.blocks).toHaveLength(blocks.length);
    expect(s.ended).toEqual([]); // it closed it itself
    expect(a.streams.open()).toEqual({ opened: 0, served: 0 });
    expect(b.streams.open()).toEqual({ opened: 0, served: 0 });
    expect(a.streams.counters.stream_blocks_dropped).toBe(3); // what the holder's socket had dropped is counted when it ends
  });

  it('a hub that takes nothing: the pipe says how much is under way, and it falls back when the acks come', async () => {
    const [a, b] = await pair();
    const h = holder(a);
    const s = sink();
    b.streams.relay(b.links.view(a.id)!, { device: 'aabbcc000001' }, s);
    await until(() => h.pipes.length === 1, 2000, 'the relay served');
    const pipe = h.pipes[0];
    b.acking = false;
    for (let i = 0; i < 5; i++) {
      pipe.send(randomBytes(100_000), { binary: true });
    }
    await until(() => s.blocks.length === 5, 3000, 'the blocks');
    // 5 x 100 kB and their kind bytes are sent and not acked: a stream socket would have dropped after the third.
    expect(pipe.bufferedAmount).toBe(500_000 + 10);
    b.acking = true;
    pipe.send(randomBytes(10), { binary: true });
    await until(() => pipe.bufferedAmount === 0, 2000, 'the ack');
  });

  it('the holder closes: a refusal with its close code, and a hub that serves no streams', async () => {
    const [a, b] = await pair();
    const h = holder(a);
    const s = sink();
    b.streams.relay(b.links.view(a.id)!, { device: 'aabbcc000001' }, s);
    await until(() => h.pipes.length === 1, 2000, 'the relay served');
    h.pipes[0].send('{"t":"error","code":"NOT_FOUND","message":"no such board"}', { binary: false });
    h.pipes[0].close(4400, 'no such board');
    await until(() => s.ended.length === 1, 2000, 'the end');
    expect(s.texts).toHaveLength(1);
    expect(s.ended).toEqual([{ code: '4400', message: 'no such board' }]);
    await until(() => h.closed === 1, 2000, 'the holder told');
    expect(a.streams.open().served + b.streams.open().opened).toBe(0);
    // No server (the /app part is not running, or a hub of step 2.3): the files' channels answer that it serves none.
    a.streams.serve(null);
    const none = sink();
    b.streams.relay(b.links.view(a.id)!, { device: 'aabbcc000001' }, none);
    await until(() => none.ended.length === 1, 2000, 'the refusal');
    expect(none.ended[0]).toMatchObject({ code: 'HUB_VERSION_MISMATCH', message: expect.stringContaining('serves no stream channel') });
    // A server that throws is a refusal too, not a hub that falls over.
    a.streams.serve(() => {
      throw new Error('cannot');
    });
    const failed = sink();
    b.streams.relay(b.links.view(a.id)!, { device: 'aabbcc000001' }, failed);
    await until(() => failed.ended.length === 1, 2000, 'the failure');
    expect(failed.ended[0]).toEqual({ code: 'INTERNAL', message: 'cannot' });
    expect(a.streams.counters.streams_refused).toBe(1);
  });

  it('the link goes away: both ends give the relay up at once; a block past the limit ends it', async () => {
    const [a, b] = await pair();
    const h = holder(a);
    const s = sink();
    b.streams.relay(b.links.view(a.id)!, { device: 'aabbcc000001' }, s);
    await until(() => h.pipes.length === 1, 2000, 'the relay served');
    h.pipes[0].send(randomBytes(STREAM_BLOCK_MAX + 1), { binary: true });
    await until(() => s.ended.length === 1, 5000, 'the end');
    expect(s.ended[0]).toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringContaining('a block of more than') });
    expect(s.blocks).toEqual([]);
    await until(() => h.closed === 1, 2000, 'the holder told');

    const s2 = sink();
    b.streams.relay(b.links.view(a.id)!, { device: 'aabbcc000001' }, s2);
    await until(() => h.pipes.length === 2, 2000, 'the second relay');
    h.pipes[1].send(randomBytes(500), { binary: true });
    await until(() => s2.blocks.length === 1, 2000, 'a block');
    await a.links.stop();
    await until(() => s2.ended.length === 1 && h.closed === 2, 3000, 'both ends');
    expect(s2.ended[0]).toMatchObject({ code: 'HUB_UNREACHABLE', message: expect.stringContaining('the link to hub hub-a was lost') });
    expect(h.pipes[1].readyState).not.toBe(1);
    // A relay asked of a hub that is away ends at once, with why.
    const s3 = sink();
    b.streams.relay(b.links.view(a.id)!, { device: 'aabbcc000001' }, s3);
    await until(() => s3.ended.length === 1, 2000, 'the refusal');
    expect(s3.ended[0].code).toBe('HUB_UNREACHABLE');
  });
});
