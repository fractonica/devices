// `fr time …` (src/time.ts): the fast path in bin/fr.mjs (in process) and in src/main.ts (before the registry), the
// Result envelope and exit codes, pure and Earth text, --watch redrawing at the core's next change and ending on
// Ctrl-C, and the time_* MCP tools answered with no hub. No hub is started: FR_HUB names a closed port.

import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { callTool, HubGate, type McpDeps } from '../src/mcp.ts';
import { isTimeCommand } from '../src/time.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'fr.mjs');
const MAIN = resolve(HERE, '..', 'src', 'main.ts');
const ENV = { ...process.env, FR_HUB: 'http://127.0.0.1:9', NO_COLOR: '1', TZ: 'UTC' };
const A_STAMP = 'α#6 β#4 γ#9 δ#3 ε#5 34η 29ι 21λ 3ν';

/** `fr …` through bin/fr.mjs (the fast path runs in that process) or src/main.ts (the dispatcher). */
function fr(args: string[], via: 'bin' | 'main' = 'bin') {
  const argv = via === 'bin' ? [BIN, ...args] : ['--conditions=@fractonica/source', MAIN, ...args];
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', env: ENV, timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('fr time', { timeout: 120_000 }, () => {
  it('takes the fast path for `time` only', () => {
    expect(isTimeCommand(['time'])).toBe(true);
    expect(isTimeCommand(['--json', 'time', 'ladder'])).toBe(true);
    expect(isTimeCommand(['logs', 'time'])).toBe(false);
    expect(isTimeCommand(['--help'])).toBe(false);
  });

  it('reads vector A with --at, as an envelope with --json, through both entries', () => {
    for (const via of ['bin', 'main'] as const) {
      const r = fr(['--json', 'time', '--at', '2026-10-08T12:00:00Z'], via);
      expect(r.code, r.err).toBe(0);
      const env = JSON.parse(r.out) as { ok: boolean; cursor: string; data: { stamp: string; countdowns: { next: { span: string } }[] } };
      expect(env).toMatchObject({ ok: true, cursor: '', data: { stamp: A_STAMP } });
      expect(env.data.countdowns[0].next.span).toBe('6ι 43λ');
    }
  });

  it('prints the NOW layout pure by default, and the Earth translations with --earth', () => {
    const pure = fr(['time', '--at', '1791460800']);
    expect(pure.code).toBe(0);
    expect(pure.out.split('\n')[0]).toBe(A_STAMP);
    expect(pure.out).toContain('η  HELION   1 OF 11  END IN   6ι 43λ');
    expect(pure.out).not.toMatch(/⊕|UTC|OCT|\d:\d\d/);
    const earth = fr(['time', '--at', '1791460800', '--earth']);
    expect(earth.out).toContain('⊕ THU 8 OCT 2026 · 12:00:00 UTC');
    expect(earth.out).toContain('⊕ 12:56:12 · 56 min 12 s');
  });

  it('answers the subcommands, --at and --earth on either side of them', () => {
    const ladder = JSON.parse(fr(['--json', 'time', 'ladder', '--at', '1791460800', '--to', 'θ']).out) as { data: { rungs: { symbol: string; cycle: string }[] } };
    expect(ladder.data.rungs.map((g) => g.symbol).join('')).toBe('αβγδεζηθ');
    expect(ladder.data.rungs[6].cycle).toBe('717211');
    const before = JSON.parse(fr(['--json', 'time', '--at', '1791460800', 'ladder', '--to', '2']).out) as { data: { unix_us: string; rungs: unknown[] } };
    expect(before.data).toMatchObject({ unix_us: '1791460800000000' });
    expect(before.data.rungs).toHaveLength(2);
    expect(fr(['time', 'stamp', '1791460800000ms']).out.split('\n')[0]).toBe(A_STAMP);
    const parsed = JSON.parse(fr(['--json', 'time', 'parse', 'ε#5 34η', '--context', '1791460800']).out) as { data: { finest: { symbol: string } } };
    expect(parsed.data.finest.symbol).toBe('η');
    const next = fr(['time', 'next', 'helion', '--quarter', 'end', '--count', '2', '--at', '1791460800']);
    expect(next.out).toContain('α#6 β#4 γ#9 δ#3 ε#5 36η 0ι 0λ 0ν');
    expect(fr(['time', 'span', '1791460800', '1791464172428000us']).out.split('\n')[0]).toBe('SPAN  +6ι 43λ');
    expect(fr(['time', 'sync', '--at', '1791460800']).out).toMatch(/^SOLAR SYNC {2}4\u202f820$/m);
  });

  it('refuses outside the catalogue and bad arguments with INVALID_ARGS, exit 64', () => {
    const out = fr(['--json', 'time', '--at', '1500-01-01T00:00:00Z']);
    expect(out.code).toBe(64);
    expect(JSON.parse(out.out)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS', details: { reason: 'out_of_catalogue' } } });
    const text = fr(['time', 'next', 'omega']);
    expect(text.code).toBe(64);
    expect(text.err).toMatch(/^error INVALID_ARGS: no level "omega"/);
    expect(fr(['time', 'next', 'η', '--count', 'x']).code).toBe(64);
    expect(fr(['time', 'bogus']).code).toBe(64);
    expect(fr(['time', '--help']).code).toBe(0);
    // pure: no Gregorian date in the refusal unless --earth, then marked ⊕
    const pure = fr(['time', '--at', '1500-01-01T00:00:00Z']);
    expect(pure.err).toBe('error INVALID_ARGS: the instant is outside the catalogue: OUT OF CATALOGUE · α#1 – α#18\n');
    expect(fr(['time', '--earth', '--at', '1500-01-01T00:00:00Z']).err).toMatch(/\(⊕ 1613-05-19T17:41:53\.032Z to 2857-06-13T09:33:55\.816Z\)$/m);
  });

  it('refuses an unreadable --at with --watch as without it: INVALID_ARGS, exit 64, nothing drawn', () => {
    const json = fr(['--json', 'time', '--watch', '--at', 'garbage']);
    expect(json.code).toBe(64);
    expect(JSON.parse(json.out)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS', details: { reason: 'parse' } } });
    const text = fr(['time', '--watch', '--at', 'garbage']);
    expect(text.code).toBe(64);
    expect(text.out).toBe('');
    expect(text.err).toMatch(/^error INVALID_ARGS: cannot read "garbage" as an instant/);
  });

  it('takes an instant before 1970 (negative Unix time) as an argument, with or without a unit', () => {
    const stamp = (args: string[]) => (JSON.parse(fr(['--json', 'time', ...args]).out) as { data: { unix_us: string } }).data.unix_us;
    expect(stamp(['stamp', '-6000000000000000us'])).toBe('-6000000000000000');
    expect(stamp(['stamp', '-6000000000'])).toBe('-6000000000000000');
    expect(stamp(['stamp', '-6000000000000ms'])).toBe('-6000000000000000');
    expect(stamp(['--at', '-6000000000000000us', 'ladder', '--to', '2'])).toBe('-6000000000000000');
    expect(stamp(['ladder', '--at', '-6000000000000000us'])).toBe('-6000000000000000');
    const span = JSON.parse(fr(['--json', 'time', 'span', '-6000000000000000us', '-5000000000', '--parts', '2']).out) as { data: { from_us: string; to_us: string } };
    expect(span.data).toMatchObject({ from_us: '-6000000000000000', to_us: '-5000000000000000' });
    // an unknown option is still one, and a negative --count is still refused
    expect(fr(['time', 'stamp', '--bogus']).code).toBe(64);
    const count = fr(['--json', 'time', 'next', 'η', '--count', '-3']);
    expect(count.code).toBe(64);
    expect(JSON.parse(count.out).error.message).toBe("option '--count <n>' argument '-3' is invalid. not a whole number");
  });

  it('says partial_sync, not out_of_catalogue, for the sync at the catalogue\'s first instant', () => {
    const r = fr(['--json', 'time', 'sync', '--at', '-11253795486968000us']);
    expect(r.code).toBe(64);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS', details: { reason: 'partial_sync' } } });
    expect(fr(['--json', 'time', '--at', '-11253795486968000us']).code).toBe(0);
  });

  it('is listed by fr --help, which loads the full program', () => {
    const r = fr(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^\s+time \[options\]\s+Fractonica time now/m);
  });

  it('--watch redraws at each change the core reports and ends cleanly on Ctrl-C', async () => {
    const child = spawn(process.execPath, [BIN, '--json', 'time', '--watch'], { env: ENV });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    // three Blinks or so
    await new Promise((res) => setTimeout(res, 1500));
    child.kill('SIGINT');
    const code = await new Promise<number | null>((res) => child.on('exit', (c) => res(c)));
    expect(code).toBe(0);
    const readings = out
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { data: { unix_us: string; stamp: string; next_change_us: string } }).data);
    expect(readings.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < readings.length; i++) {
      // each redraw comes at (never before) the change the previous reading named, and shows it
      expect(BigInt(readings[i].unix_us) >= BigInt(readings[i - 1].next_change_us) - 1000n).toBe(true);
      expect(readings[i].stamp).not.toBe(readings[i - 1].stamp);
    }
  });
});

describe('time_* MCP tools', () => {
  const noHub: McpDeps = {
    call: () => Promise.reject(new Error('no hub call expected')),
    health: () => Promise.resolve(null),
    log: () => undefined,
  };

  it('answer with no hub, from the core, and check their arguments', async () => {
    const gate = new HubGate(noHub);
    const r = await callTool('time_now', { at: '2026-10-08T12:00:00Z' }, {}, gate, noHub);
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({ ok: true, data: { stamp: A_STAMP } });
    const conv = await callTool('time_convert', { at: A_STAMP }, {}, gate, noHub);
    expect(conv.structuredContent).toMatchObject({ ok: true, data: { iso: '2026-10-08T11:59:59.855Z' } });
    const bad = await callTool('time_next', { level: 'η', quarter: 'noon' }, {}, gate, noHub);
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS', details: { reason: 'parse' } } });
    // the core's quarter word in any case, as `fr time next --quarter End`
    const upper = await callTool('time_next', { level: 'η', quarter: 'End', at: '2026-10-08T12:00:00Z' }, {}, gate, noHub);
    expect(upper.structuredContent).toMatchObject({ ok: true, data: { quarter: 'End' } });
    const out = await callTool('time_ladder', { at: '3000-01-01T00:00:00Z' }, {}, gate, noHub);
    expect(out.structuredContent).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS', details: { reason: 'out_of_catalogue' } } });
    // other tools still need the hub
    const hubOnly = await callTool('hub_status', {}, {}, gate, noHub);
    expect(hubOnly.structuredContent).toMatchObject({ ok: false, error: { code: 'HUB_UNREACHABLE' } });
  });
});
