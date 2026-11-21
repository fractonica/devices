// The hubs' link, step 2.2 (design multi-hub-m2 §7), in pieces and without a hub process: `call` and `result` between
// two PeerLinks on loopback (an answer too large for one control frame, a timeout, a peer that goes away mid-call),
// the data channels (a file checked and renamed, a 50 MB file with the heartbeat alive, the provider never further
// ahead than its window, a transfer cut mid-way, a damaged one, a refusal), the spool and the paths of a pulled file,
// the row a holder changed, an OTA job whose board comes back at a peer, and `--at` in the CLI's words.
// interop-pass.test.ts runs the whole of it between real hub processes.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { errorResult, findOp, FrError, okResult, type OpDef, opRepeatable } from '@fractonica/protocol';

import type { Device } from '../src/context.ts';
import { openDb } from '../src/db.ts';
import { type CallAnswer, type CallOptions, PeerCalls } from '../src/peers/calls.ts';
import { PeerChannels, WINDOW } from '../src/peers/channels.ts';
import { destOf, dropSpool, listSpool, localPaths, newSpool, Offers, splitFiles, spoolFile, spoolInPath, spoolOutPath, spoolRoot } from '../src/peers/files.ts';
import { type LinkTarget, PeerLinks, type PeerLinkTiming, type PeerView } from '../src/peers/link.ts';
import { opWaitMs } from '../src/peers/passing.ts';
import { markPulled, rememberJob, remoteJob, unpulledJobs } from '../src/peers/remote-jobs.ts';
import { adoptRow } from '../src/peers/rows.ts';
import type { CallMsg, PeerMessage } from '../src/peers/wire.ts';
import { SqliteRegistry } from '../src/registry/store.ts';
import { takeAtHub } from '../../cli/src/client.ts';
import { until } from './fake-node.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A hub's link with its calls and channels, as peers/index.ts wires them. */
interface End {
  id: string;
  name: string;
  links: PeerLinks;
  calls: PeerCalls;
  channels: PeerChannels;
  known: Map<string, LinkTarget>;
  downs: string[];
  /** What answers the calls that arrive. */
  serve: (peer: PeerView, msg: CallMsg, input: Record<string, unknown>) => Promise<CallAnswer>;
  log: Record<string, unknown>[];
  /** Data frames seen, for the heartbeat test. */
  frames: number;
}

const FAST: Partial<PeerLinkTiming> = { pingMs: 80, awayMs: 400, backoffMinMs: 20, backoffMaxMs: 160, connectMs: 800, helloMs: 600 };

function end(id: string, name: string, key: Buffer, timing: Partial<PeerLinkTiming> = FAST): End {
  const e = { id, name, known: new Map<string, LinkTarget>(), downs: [] as string[], log: [] as Record<string, unknown>[], frames: 0 } as End;
  e.serve = async (_peer, msg, input) => ({ result: okResult({ op: msg.op, input }, 'c:1.1') });
  e.links = new PeerLinks({
    listen: { host: '127.0.0.1', port: 0 },
    key: () => ({ key, net: 0x1111 }),
    hello: () => ({ hub_id: id, name, net: 0x1111, registry_hash: 'r', hub_epoch: 1, members_version: 1, ...(e.links.port() ? { link_port: e.links.port()! } : {}) }),
    targets: () => [...e.known.values()],
    onUp: (p) => e.channels.onLink(p, 'replaced'),
    onDown: (p, why) => {
      e.downs.push(why);
      e.calls.onDown(p, why);
      e.channels.onLink(p, why);
    },
    onMessage: (p, msg: PeerMessage) => {
      if (!e.calls.onMessage(p, msg)) {
        e.channels.onMessage(p, msg);
      }
    },
    onData: (p, ch, bytes) => {
      e.frames++;
      if (!e.calls.onData(p, ch, bytes)) {
        e.channels.onData(p, ch, bytes);
      }
    },
    timing,
    log: (line) => e.log.push(line),
  });
  e.calls = new PeerCalls({ links: e.links, serve: (p, m, i) => e.serve(p, m, i), log: (line) => e.log.push(line) });
  e.channels = new PeerChannels({ links: e.links, log: (line) => e.log.push(line) });
  cleanups.push(() => e.links.stop());
  return e;
}

async function pair(timing: Partial<PeerLinkTiming> = FAST): Promise<[End, End]> {
  const key = randomBytes(32);
  const a = end('0000000000aa', 'hub-a', key, timing);
  const b = end('0000000000bb', 'hub-b', key, timing);
  for (const n of [a, b]) {
    await n.links.listen();
  }
  a.known.set(b.id, { id: b.id, name: b.name, candidates: [{ host: '127.0.0.1', port: b.links.port()! }] });
  b.known.set(a.id, { id: a.id, name: a.name, candidates: [{ host: '127.0.0.1', port: a.links.port()! }] });
  await Promise.all([a.links.sync(), b.links.sync()]);
  await until(() => a.links.view(b.id)?.reachable === true && b.links.view(a.id)?.reachable === true && a.links.connections() === 1 && b.links.connections() === 1, 4000, 'the link up at both ends');
  return [a, b];
}

const to = (from: End, other: End) => from.links.view(other.id)!;
const opts = (o: Partial<CallOptions> = {}): CallOptions => ({ mode: 'at', timeoutMs: 3000, repeatable: true, ...o });

describe('call and result over the link', () => {
  it('one op by name with its input and the calling client; the answer is the whole Result envelope', async () => {
    const [a, b] = await pair();
    let seen: CallMsg | null = null;
    b.serve = async (peer, msg, input) => {
      seen = msg;
      return { result: { ok: true, data: { echoed: input, from: peer.name }, cursor: 'c:7.42', warnings: ['w'] }, spool: 'abcdefabcdefabcd' };
    };
    const got = await a.calls.call(to(a, b), 'device_get', { device: 'id:aabbcc000001' }, opts({ mode: 'holder', client: 'mcp', files: { out: { out: 'take.wav' } } }));
    expect(got).toEqual({ result: { ok: true, data: { echoed: { device: 'id:aabbcc000001' }, from: 'hub-a' }, cursor: 'c:7.42', warnings: ['w'] }, spool: 'abcdefabcdefabcd' });
    expect(seen).toMatchObject({ t: 'call', op: 'device_get', mode: 'holder', client: 'mcp', files: { out: { out: 'take.wav' } } });
    // A failure is a Result too, as the op threw it.
    b.serve = async () => ({ result: errorResult(new FrError('DEVICE_OFFLINE', 'gone', { details: { moved: true, at: 'hub-c' } }), 'c:7.43') });
    const failed = await a.calls.call(to(a, b), 'device_get', {}, opts());
    expect(failed.result).toMatchObject({ ok: false, cursor: 'c:7.43', error: { code: 'DEVICE_OFFLINE', retryable: true, details: { moved: true, at: 'hub-c' } } });
    // A handler that throws something else does not take the link down.
    b.serve = async () => {
      throw new Error('boom');
    };
    expect((await a.calls.call(to(a, b), 'x', {}, opts())).result.error).toMatchObject({ code: 'INTERNAL', message: 'boom' });
    // The hub that served them logged each by op and caller, never the input.
    const logged = b.log.filter((l) => l.event === 'peer_call');
    expect(logged.map((l) => [l.op, l.from, l.ok])).toEqual([['device_get', 'hub-a', true], ['device_get', 'hub-a', false], ['x', 'hub-a', false]]);
    expect(JSON.stringify(logged)).not.toContain('aabbcc000001');
    expect(a.calls.counters).toMatchObject({ calls_out: 3, calls_lost: 0 });
    expect(b.calls.counters.calls_in).toBe(3);
  });

  it('an input and an answer too large for one control frame cross as data frames, whole', async () => {
    const [a, b] = await pair();
    const big = randomBytes(900_000).toString('base64'); // 1.2 MB of JSON: more than a control frame may carry
    b.serve = async (_p, _m, input) => ({ result: okResult({ back: input.blob, n: String(input.blob).length }, 'c:1.2') });
    const got = await a.calls.call(to(a, b), 'app_upload', { blob: big }, opts({ timeoutMs: 10_000 }));
    expect(got.result.ok).toBe(true);
    expect((got.result.data as { n: number }).n).toBe(big.length);
    expect((got.result.data as { back: string }).back === big).toBe(true);
    expect(a.calls.counters.bodies).toBe(1);
    expect(b.calls.counters.bodies).toBe(1);
    // The link carried them without a break, and small calls still go inline.
    expect(a.downs).toEqual([]);
    expect((await a.calls.call(to(a, b), 'hub_status', {}, opts())).result.ok).toBe(true);
    expect(a.calls.counters.bodies).toBe(1);
  });

  it('a call times out after the op\'s wait plus the margin, and its late answer is dropped', async () => {
    const [a, b] = await pair();
    let release!: () => void;
    b.serve = () => new Promise((r) => (release = () => r({ result: okResult({}, 'c:1.1') })));
    const t0 = Date.now();
    const got = await a.calls.call(to(a, b), 'audio_level', {}, opts({ timeoutMs: 300, repeatable: true }));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    expect(got.result.error).toMatchObject({ code: 'TIMEOUT', retryable: true, details: { hub: 'hub-b', op: 'audio_level' } });
    expect(got.result.error!.message).toContain('hub hub-b did not answer audio_level');
    release();
    await until(() => a.calls.counters.results_late === 1, 2000, 'the late answer');
    expect(a.calls.pending()).toBe(0);
    // The op's own wait is its wait_s, else total_timeout_s, else timeout_s.
    expect(opWaitMs({ wait_s: 110, timeout_s: 5 })).toBe(110_000);
    expect(opWaitMs({ total_timeout_s: 30, timeout_s: 5 })).toBe(30_000);
    expect(opWaitMs({ timeout_s: 5 })).toBe(5000);
    expect(opWaitMs({})).toBe(0);
  });

  it('a peer that goes away mid-call gives an error naming the hub, retryable only for a read-only or idempotent op', async () => {
    const [a, b] = await pair();
    b.serve = () => new Promise(() => undefined); // never answers
    const read = a.calls.call(to(a, b), 'device_get', {}, opts({ timeoutMs: 20_000, repeatable: true }));
    const write = a.calls.call(to(a, b), 'command_send', {}, opts({ timeoutMs: 20_000, repeatable: false }));
    await sleep(100);
    await b.links.stop();
    const [r, w] = await Promise.all([read, write]);
    expect(r.result.error).toMatchObject({ code: 'HUB_UNREACHABLE', retryable: true, details: { hub: 'hub-b', op: 'device_get' } });
    expect(r.result.error!.message).toContain('hub hub-b is not reachable: it went away while the op ran');
    expect(w.result.error).toMatchObject({ code: 'HUB_UNREACHABLE', retryable: false, details: { hub: 'hub-b', op: 'command_send' } });
    expect(w.result.error!.message).toContain('command_send may have run there, so it is not tried again by itself');
    // To a hub that is away nothing is sent, and that is always safe to try again.
    const none = await a.calls.call(to(a, b), 'command_send', {}, opts({ repeatable: false }));
    expect(none.result.error).toMatchObject({ code: 'HUB_UNREACHABLE', retryable: true });
    expect(a.calls.counters.calls_lost).toBe(2);
    // What the registry marks: every read op, and the ops marked idempotent.
    expect(opRepeatable(findOp('device_get')!)).toBe(true);
    expect(opRepeatable(findOp('device_hubs_set')!)).toBe(true);
    expect(opRepeatable(findOp('command_send')!)).toBe(false);
    expect(opRepeatable(findOp('ota_deploy')!)).toBe(false);
  });
});

describe('data channels', () => {
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

  it('a file is written under a temporary name, checked by size and SHA-256, then renamed', async () => {
    const [a, b] = await pair();
    const dir = tmp('fr-chan-');
    const src = join(dir, 'src.bin');
    const bytes = randomBytes(300_000);
    writeFileSync(src, bytes);
    writeFileSync(join(dir, 'empty'), '');
    b.channels.provide('file', (_peer, ref) => ({ path: join(dir, String(ref.name)) }));
    const dest = join(dir, 'out', 'copy.bin');
    const got = await a.channels.pull(to(a, b), 'file', { name: 'src.bin' }, dest);
    expect(got).toEqual({ bytes: 300_000, sha256: sha(bytes) });
    expect(readFileSync(dest).equals(bytes)).toBe(true);
    expect(readdirSync(join(dir, 'out'))).toEqual(['copy.bin']);
    // An empty file is a file.
    expect(await a.channels.pull(to(a, b), 'file', { name: 'empty' }, join(dir, 'out', 'e'))).toEqual({ bytes: 0, sha256: sha(Buffer.alloc(0)) });
    expect(statSync(join(dir, 'out', 'e')).size).toBe(0);
    // A hash known beforehand (a blob's name) is checked too: what does not match is not kept.
    await expect(a.channels.pull(to(a, b), 'file', { name: 'src.bin' }, join(dir, 'out', 'bad.bin'), { sha256: 'ab'.repeat(32) })).rejects.toThrow(/arrived damaged .*nothing was kept/);
    // The provider says why it sends nothing; a kind nobody serves is another version's.
    await expect(a.channels.pull(to(a, b), 'file', { name: 'none' }, join(dir, 'out', 'n'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(a.channels.pull(to(a, b), 'stream', {}, join(dir, 'out', 's'))).rejects.toMatchObject({ code: 'HUB_VERSION_MISMATCH' });
    await expect(a.channels.pull(to(a, b), 'file', { name: 'src.bin' }, join(dir, 'out', 'big'), { maxBytes: 1000 })).rejects.toThrow(/more than the 1000/);
    expect(readdirSync(join(dir, 'out')).sort()).toEqual(['copy.bin', 'e']);
    await until(() => a.channels.open() + b.channels.open() === 0, 3000, 'every channel closed at both ends');
    expect(a.channels.counters).toMatchObject({ pulls: 6, pulls_failed: 4, bytes_in: 600_000 });
  });

  it('50 MB crosses with the heartbeat alive: pings answered throughout, the provider never past its window, one copy on disk', async () => {
    // A ping every 40 ms and away after 200 ms of silence: a file that held the connection for longer would end it.
    // The file crosses three times over, so the transfers last several away times on any machine.
    const timing = { ...FAST, pingMs: 40, awayMs: 200 };
    const [a, b] = await pair(timing);
    const dir = tmp('fr-chan-big-');
    const src = join(dir, 'recording.wav');
    const block = randomBytes(1 << 20);
    const hash = createHash('sha256');
    for (let i = 0; i < 50; i++) {
      block.writeUInt32LE(i, 0);
      writeFileSync(src, block, { flag: 'a' });
      hash.update(block);
    }
    const want = hash.digest('hex');
    b.channels.provide('file', () => ({ path: src }));
    // What the provider has sent beyond what the receiver has taken, sampled while it runs, and the pings answered.
    let ahead = 0;
    const rtts = new Set<number>();
    const sampler = setInterval(() => {
      ahead = Math.max(ahead, b.channels.counters.bytes_out - a.channels.counters.bytes_in);
      const rtt = a.links.view(b.id)?.rtt_ms;
      if (typeof rtt === 'number') {
        rtts.add(rtt);
      }
    }, 5);
    const t0 = Date.now();
    const dest = join(dir, 'pulled.wav');
    try {
      for (let round = 0; round < 3; round++) {
        const got = await a.channels.pull(to(a, b), 'file', {}, dest);
        expect(got).toEqual({ bytes: 50 << 20, sha256: want });
        expect(statSync(dest).size).toBe(50 << 20);
        expect(readdirSync(dir).sort()).toEqual(['pulled.wav', 'recording.wav']); // no temporary file left
      }
    } finally {
      clearInterval(sampler);
    }
    const ms = Date.now() - t0;
    // The link never went away at either end, and the same connection carried it all.
    expect(a.downs).toEqual([]);
    expect(b.downs).toEqual([]);
    expect(a.links.counters.away + b.links.counters.away).toBe(0);
    expect(a.links.connections()).toBe(1);
    expect(a.links.view(b.id)!.reachable && b.links.view(a.id)!.reachable).toBe(true);
    // Pings were answered while it ran: more than one round trip was measured.
    expect(rtts.size).toBeGreaterThanOrEqual(2);
    // The provider kept within its window of what the receiver had taken.
    expect(ahead).toBeLessThanOrEqual(WINDOW + (1 << 20));
    // 64 KiB chunks: 800 data frames a file, none larger.
    expect(a.frames).toBe(2400);
    console.log(`[measured] 3 x 50 MB over the link on loopback: ${ms} ms (${Math.round((150 * 1000) / ms)} MB/s), away after ${timing.awayMs} ms of silence, provider at most ${(ahead / 1048576).toFixed(2)} MB ahead, ${rtts.size} distinct ping round trips`);
  }, 120_000);

  it('a call made while a large file crosses is answered at once', async () => {
    const [a, b] = await pair();
    const dir = tmp('fr-chan-mix-');
    const src = join(dir, 'big.bin');
    writeFileSync(src, randomBytes(24 << 20));
    b.channels.provide('file', () => ({ path: src }));
    const pull = a.channels.pull(to(a, b), 'file', {}, join(dir, 'copy.bin'));
    await until(() => a.channels.counters.bytes_in > 1 << 20, 5000, 'the transfer under way');
    const times: number[] = [];
    while (a.channels.open() > 0 && times.length < 20) {
      const t0 = performance.now();
      expect((await a.calls.call(to(a, b), 'hub_status', {}, opts())).result.ok).toBe(true);
      times.push(performance.now() - t0);
    }
    await pull;
    expect(times.length).toBeGreaterThan(0);
    // Behind at most the data queued on the socket (512 KiB) and one chunk: far inside the heartbeat's away time.
    expect(Math.max(...times)).toBeLessThan(400);
  }, 30_000);

  it('a transfer cut by a lost link leaves no file under the final name and no partial one', async () => {
    const [a, b] = await pair();
    const dir = tmp('fr-chan-cut-');
    const src = join(dir, 'src.bin');
    writeFileSync(src, randomBytes(32 << 20));
    b.channels.provide('file', () => ({ path: src }));
    mkdirSync(join(dir, 'out'));
    const dest = join(dir, 'out', 'copy.bin');
    const pull = a.channels.pull(to(a, b), 'file', {}, dest);
    await until(() => a.channels.counters.bytes_in > 2 << 20, 5000, 'the transfer under way');
    expect(readdirSync(join(dir, 'out')).some((n) => n.startsWith('copy.bin.part-'))).toBe(true);
    await b.links.stop();
    await expect(pull).rejects.toMatchObject({ code: 'HUB_UNREACHABLE' });
    await expect(pull).rejects.toThrow(/the link to hub hub-b was lost at \d+\/33554432 bytes of file .*nothing was kept/);
    expect(readdirSync(join(dir, 'out'))).toEqual([]);
    expect(a.channels.open()).toBe(0);
    // An existing file under the final name is as it was after a transfer that fails.
    writeFileSync(dest, 'the old one');
    await expect(a.channels.pull(to(a, b), 'file', {}, dest)).rejects.toMatchObject({ code: 'HUB_UNREACHABLE' });
    expect(readFileSync(dest, 'utf8')).toBe('the old one');
  }, 30_000);

  it('a provider that stops sending is given up after the stall time; a receiver that gives up stops the provider', async () => {
    const [a, b] = await pair();
    const dir = tmp('fr-chan-stall-');
    const src = join(dir, 'src.bin');
    writeFileSync(src, randomBytes(8 << 20));
    // A provider that never answers its open: the receiver gives up.
    b.channels.provide('slow', () => new Promise(() => undefined));
    await expect(a.channels.pull(to(a, b), 'slow', {}, join(dir, 'x'), { stallMs: 200 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(existsSync(join(dir, 'x'))).toBe(false);
    // A receiver that is cancelled mid-way: the provider hears the close and stops reading the file.
    b.channels.provide('file', () => ({ path: src }));
    const ac = new AbortController();
    const pull = a.channels.pull(to(a, b), 'file', {}, join(dir, 'y'), { signal: ac.signal });
    await until(() => a.channels.counters.bytes_in > 0, 5000, 'the transfer under way');
    ac.abort();
    await expect(pull).rejects.toMatchObject({ code: 'TIMEOUT' });
    await until(() => b.channels.open() === 0, 3000, 'the provider to stop');
    expect(readdirSync(dir).sort()).toEqual(['src.bin']);
    expect(b.channels.counters.bytes_out).toBeLessThan(8 << 20);
    expect(a.downs).toEqual([]);
  }, 30_000);
});

describe('the files of an op that was passed on', () => {
  function home(): string {
    const dir = tmp('fr-home-pass-');
    const prev = process.env.FR_HOME;
    process.env.FR_HOME = dir;
    cleanups.push(() => (prev === undefined ? delete process.env.FR_HOME : (process.env.FR_HOME = prev)));
    return dir;
  }

  it('the spool: one per call under FR_HOME/storage/.peers, listed for the caller, never read outside itself', () => {
    const h = home();
    const s = newSpool();
    expect(s.dir).toBe(join(spoolRoot(), s.id));
    expect(spoolRoot().endsWith(join('storage', '.peers'))).toBe(true);
    expect(s.dir.includes(h.split('/').at(-1)!)).toBe(true);
    const out = spoolOutPath(s.id, 'out', 'take.wav');
    expect(out).toBe(join(s.dir, 'o-out', 'take.wav'));
    writeFileSync(out, 'RIFF');
    writeFileSync(`${out}.tmp-123`, 'half'); // a writer's temporary file is not the caller's
    mkdirSync(join(s.dir, 'o-dir', 'frames'), { recursive: true });
    writeFileSync(join(s.dir, 'o-dir', 'frames', '0001.jpg'), 'jpg1');
    writeFileSync(spoolInPath(s.id, 'file', 'in.wav'), 'input'); // nor is what the caller sent
    expect(listSpool(s.id)).toEqual({ root: s.dir, files: [{ path: 'o-dir/frames/0001.jpg', size: 4 }, { path: 'o-out/take.wav', size: 4 }] });
    expect(spoolFile(s.id, 'o-out/take.wav')).toBe(out);
    for (const bad of ['../secrets.json', 'o-out/../../secrets.json', 'i-file/in.wav', '/etc/passwd', 'o-out//take.wav', 'o-out/./take.wav', '']) {
      expect(() => spoolFile(s.id, bad), bad).toThrow(/not a file of that spool/);
    }
    expect(() => spoolFile('../../x', 'o-out/take.wav')).toThrow(/not a spool id/);
    expect(() => spoolOutPath(s.id, 'out', '../x.wav')).toThrow(/not a file name/);
    expect(() => spoolOutPath(s.id, '../out', 'x.wav')).toThrow(/not an input field/);
    expect(() => spoolFile(s.id, 'o-out/gone.wav')).toThrow(/not in the spool any more/);
    expect(dropSpool(s.id)).toBe(true);
    expect(existsSync(s.dir)).toBe(false);
    expect(dropSpool(s.id)).toBe(false);
    expect(listSpool(s.id).files).toEqual([]);
  });

  it('a path of this machine is taken out of the input, and a result\'s paths become this machine\'s again', () => {
    const h = home();
    const offers = new Offers();
    const record = findOp('audio_record')! as unknown as OpDef;
    const out = join(h, 'audio', 'take.wav');
    const split = splitFiles(record, { device: 'id:aa', seconds: 3, out }, offers);
    expect(split.input).toEqual({ device: 'id:aa', seconds: 3 });
    expect(split.files).toEqual({ out: { out: 'take.wav' } });
    expect(split.wants).toEqual({ out });
    // As when the op runs here: an absolute path under FR_HOME.
    expect(() => splitFiles(record, { out: 'take.wav' }, offers)).toThrow(/must be an absolute path/);
    expect(() => splitFiles(record, { out: '/tmp/elsewhere/take.wav' }, offers)).toThrow(/outside FR_HOME/);
    // Without a path there is nothing to take out.
    expect(splitFiles(record, { device: 'x' }, offers)).toMatchObject({ files: undefined, wants: {}, tokens: [] });
    // An input file is offered by a token that is good until released.
    const wavFile = join(realpathSync(tmp('fr-in-')), 'in.wav');
    writeFileSync(wavFile, 'RIFFdata');
    const play = splitFiles(findOp('audio_play')! as unknown as OpDef, { device: 'x', file: wavFile }, offers);
    expect(play.input).toEqual({ device: 'x' });
    expect(play.files!.in!.file).toMatchObject({ name: 'in.wav', size: 8, token: play.tokens[0] });
    expect(offers.path(play.tokens[0])).toBe(wavFile);
    offers.release(play.tokens);
    expect(() => offers.path(play.tokens[0])).toThrow(/not on offer/);
    expect(() => splitFiles(findOp('audio_play')! as unknown as OpDef, { file: join(tmpdir(), 'fr-none-such.wav') }, offers)).toThrow(/no file/);
    // Nothing of the hub's own leaves this machine, whatever the op (storage_put's rule for a source) ...
    writeFileSync(join(h, 'secrets.json'), '{}');
    for (const name of ['audio_play', 'storage_put']) {
      expect(() => splitFiles(findOp(name)! as unknown as OpDef, { device: 'x', file: join(h, 'secrets.json'), path: '/x' }, offers), name).toThrow(/one of the hub's own files/);
    }
    // ... and storage_get writes only under FR_HOME/storage and over nothing, as when it runs here.
    const get = findOp('storage_get')! as unknown as OpDef;
    expect(() => splitFiles(get, { device: 'x', path: '/a.bin', out: join(h, 'secrets.json') }, offers)).toThrow(/outside .*storage/);
    mkdirSync(join(h, 'storage'), { recursive: true });
    writeFileSync(join(h, 'storage', 'have.bin'), 'x');
    expect(() => splitFiles(get, { device: 'x', path: '/a.bin', out: join(h, 'storage', 'have.bin') }, offers)).toThrow(/overwrites nothing/);
    expect(splitFiles(get, { device: 'x', path: '/a.bin', out: join(h, 'storage', 'new.bin') }, offers).files).toEqual({ out: { out: 'new.bin' } });
    // Where a spool entry lands, and what a result says of it.
    const root = '/home/arduino/.fractonica/storage/.peers/0123456789abcdef';
    expect(destOf({ out }, 'o-out/take.wav')).toBe(out);
    expect(destOf({ out: join(h, 'captures', 'run') }, 'o-out/run/0001.jpg')).toBe(join(h, 'captures', 'run', '0001.jpg'));
    expect(destOf({ out }, 'o-out/take.wav.json')).toBe(join(h, 'audio', 'take.wav.json'));
    expect(destOf({ out }, 'o-other/take.wav')).toBeNull();
    expect(localPaths({ path: `${root}/o-out/take.wav`, samples: 3, nested: [{ file: `${root}/o-out/take.wav` }], other: '/home/arduino/x' }, root, { out })).toEqual({ path: out, samples: 3, nested: [{ file: out }], other: '/home/arduino/x' });
  });

  it('a job that runs at another hub is remembered in hub.db, with the files still to pull', () => {
    const dir = tmp('fr-db-pass-');
    const db = openDb(join(dir, 'hub.db'));
    cleanups.push(() => db.close());
    const row = rememberJob(db, { job_id: 'j_aaaaaaaaaaaa', hub_id: '0000000000bb', hub_name: 'hub-b', op: 'audio_record', wants: { out: '/x/take.wav' }, spool: '0123456789abcdef' });
    expect(row).toMatchObject({ hub_id: '0000000000bb', hub_name: 'hub-b', wants: { out: '/x/take.wav' }, spool: '0123456789abcdef', pulled_at: null });
    rememberJob(db, { job_id: 'j_bbbbbbbbbbbb', hub_id: '0000000000bb', hub_name: 'hub-b', op: 'ota_deploy' });
    expect(remoteJob(db, 'j_bbbbbbbbbbbb')).toMatchObject({ wants: null, spool: null });
    expect(remoteJob(db, 'j_cccccccccccc')).toBeNull();
    expect(unpulledJobs(db, 3600_000).map((j) => j.job_id)).toEqual(['j_aaaaaaaaaaaa']);
    // Another process on the same file (the hub restarted) finds it.
    const again = openDb(join(dir, 'hub.db'));
    cleanups.push(() => again.close());
    expect(remoteJob(again, 'j_aaaaaaaaaaaa')).toMatchObject({ hub_name: 'hub-b', op: 'audio_record' });
    markPulled(again, 'j_aaaaaaaaaaaa', '/remote/spool');
    expect(unpulledJobs(db, 3600_000)).toEqual([]);
    expect(remoteJob(db, 'j_aaaaaaaaaaaa')).toMatchObject({ spool_root: '/remote/spool' });
    expect(remoteJob(db, 'j_aaaaaaaaaaaa')!.pulled_at).toMatch(/^\d{4}-/);
  });

  it('a row the holder changed is stored for the same device id, and never an alias another row here holds', () => {
    const dir = tmp('fr-db-rows-');
    const db = openDb(join(dir, 'hub.db'));
    cleanups.push(() => db.close());
    const registry = new SqliteRegistry(db);
    const add = (id: string, alias: string) => db.prepare("INSERT INTO devices (device_id, alias, alias_rev, tags, role, provisioned, created_at) VALUES (?, ?, 1, '[]', 'node', 1, ?)").run(id, alias, new Date().toISOString());
    add('aabbcc000001', 'mic');
    add('aabbcc000002', 'pad');
    const hub = { db, registry };
    const row = (id: string) => registry.get(id) as Device;
    // device_update at the holder: its alias, rev and tags.
    expect(adoptRow(hub, 'device_update', { device_id: 'aabbcc000001', alias: 'mic-studio', alias_rev: 2, tags: ['studio'] }, 'hub-b')).toBeNull();
    expect(row('aabbcc000001')).toMatchObject({ alias: 'mic-studio', alias_rev: 2, tags: ['studio'] });
    // An older rev is not taken; a name another row holds here is not either, and the answer says so.
    adoptRow(hub, 'device_update', { device_id: 'aabbcc000001', alias: 'older', alias_rev: 1, tags: ['studio'] }, 'hub-b');
    expect(row('aabbcc000001').alias).toBe('mic-studio');
    const clash = adoptRow(hub, 'device_update', { device_id: 'aabbcc000001', alias: 'pad', alias_rev: 3, tags: [] }, 'hub-b');
    expect(clash).toContain('this hub has another board (aabbcc000002) by that name');
    expect(row('aabbcc000001')).toMatchObject({ alias: 'mic-studio', alias_rev: 2, tags: [] });
    // The hub list as the board holds it; one on trial, or one the board left with, is not recorded.
    adoptRow(hub, 'device_hubs_get', { device_id: 'aabbcc000001', hubs: [{ host: 'home.local', ip: '192.168.1.30' }, { host: 'lab.local', ip: null }], rev: 4, trial: false }, 'hub-b');
    expect(row('aabbcc000001').hubs).toMatchObject({ rev: 4, hubs: [{ host: 'home.local', ip: '192.168.1.30' }, { host: 'lab.local', ip: null }] });
    adoptRow(hub, 'device_hubs_set', { device_id: 'aabbcc000001', hubs: [{ host: 'x.local' }], rev: 5, trial: true }, 'hub-b');
    adoptRow(hub, 'device_hubs_set', { device_id: 'aabbcc000001', hubs: [{ host: 'x.local' }], rev: 5, trial: false, left: true }, 'hub-b');
    expect(row('aabbcc000001').hubs!.rev).toBe(4);
    // A device this hub has no row for, and an op that answers no row, change nothing.
    expect(adoptRow(hub, 'device_update', { device_id: 'aabbcc000009', alias: 'new', alias_rev: 1 }, 'hub-b')).toBeNull();
    expect(adoptRow(hub, 'device_get', { device_id: 'aabbcc000002', alias: 'renamed', alias_rev: 9 }, 'hub-b')).toBeNull();
    expect(row('aabbcc000002').alias).toBe('pad');
  });
});

describe('fr --at <hub>', () => {
  it('is taken from the words before the command only: some commands have an --at of their own', () => {
    expect(takeAtHub(['--at', 'uriel', 'ports', 'ls'])).toEqual({ at: 'uriel', rest: ['ports', 'ls'] });
    expect(takeAtHub(['--json', '--at', 'uriel', 'hub', 'status'])).toEqual({ at: 'uriel', rest: ['--json', 'hub', 'status'] });
    expect(takeAtHub(['--at=lab', '--json', 'devices', 'get', 'mic'])).toEqual({ at: 'lab', rest: ['--json', 'devices', 'get', 'mic'] });
    // After the command it is the command's own option.
    expect(takeAtHub(['time', '--at', '2026-11-21T00:00:00Z'])).toEqual({ at: undefined, rest: ['time', '--at', '2026-11-21T00:00:00Z'] });
    expect(takeAtHub(['--at', 'uriel', 'time', '--at', 'x'])).toEqual({ at: 'uriel', rest: ['time', '--at', 'x'] });
    expect(takeAtHub(['devices', 'ls'])).toEqual({ at: undefined, rest: ['devices', 'ls'] });
    // Without a name it is an empty one, which the CLI refuses.
    expect(takeAtHub(['--at'])).toEqual({ at: '', rest: [] });
    expect(takeAtHub(['--at', '--json', 'hub', 'status'])).toEqual({ at: '', rest: ['--json', 'hub', 'status'] });
  });
});

