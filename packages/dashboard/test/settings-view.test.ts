// Settings' rules: a doctor check as a bead and the fix it offers (src/state/checks.ts), the database's space and the
// network form (src/state/settings-view.ts), and the hub's texts in pure mode (src/state/pure-text.ts). The ports are
// test/ports.test.ts.

import { beforeAll, describe, expect, it } from 'vitest';

import { type Core, loadCore } from '@fractonica/time';

import {
  compactAdvice,
  type NetworkDraft,
  networkErrors,
  networkSetInput,
  sizeText,
} from '../src/state/settings-view.ts';
import { checkBead, checkFix, checkName, sortChecks, worstLevel } from '../src/state/checks.ts';
import { pureDurations } from '../src/state/pure-text.ts';

let core: Core;
beforeAll(async () => {
  core = await loadCore();
});

describe('doctor checks', () => {
  it('maps levels to beads and puts errors first, then warnings', () => {
    expect([checkBead('ok'), checkBead('warn'), checkBead('error')]).toEqual(['online', 'waiting', 'fault']);
    const sorted = sortChecks([
      { id: 'a', level: 'ok' },
      { id: 'b', level: 'warn' },
      { id: 'c', level: 'error' },
      { id: 'd', level: 'warn' },
    ] as const);
    expect(sorted.map((c) => c.id)).toEqual(['c', 'b', 'd', 'a']);
    expect(worstLevel([{ level: 'ok' }, { level: 'warn' }])).toBe('warn');
    expect(worstLevel([{ level: 'ok' }])).toBe('ok');
    expect(worstLevel([{ level: 'warn' }, { level: 'error' }])).toBe('error');
  });

  it('offers a command to copy, the Ports section, or steps to read', () => {
    expect(checkFix({ id: 'pytools', fix: 'fr doctor --fix' })).toEqual({ kind: 'command', command: 'fr doctor --fix', text: 'fr doctor --fix' });
    expect(checkFix({ id: 'ccache', fix: 'brew install ccache' })).toMatchObject({ kind: 'command', command: 'brew install ccache' });
    expect(checkFix({ id: 'shim_path', fix: `add 'export PATH="$HOME/.local/bin:$PATH"' to ~/.zshrc` })).toMatchObject({ kind: 'command', command: 'export PATH="$HOME/.local/bin:$PATH"' });
    expect(checkFix({ id: 'x', fix: 'run `fr hub restart` after that' })).toMatchObject({ kind: 'command', command: 'fr hub restart' });
    expect(checkFix({ id: 'serial', fix: 'close the other program (e.g. a Chrome Web Serial tab)' })).toMatchObject({ kind: 'page', params: { section: 'ports' } });
    expect(checkFix({ id: 'firewall', fix: 'System Settings → Network → Firewall → Options → turn off "Block all incoming connections"' })).toMatchObject({ kind: 'steps' });
    expect(checkFix({ id: 'lan', fix: 'exclude local networks in the VPN' })).toMatchObject({ kind: 'steps' });
    expect(checkFix({ id: 'node' })).toBeNull();
  });

  it('names checks for people', () => {
    expect(checkName('idf_env')).toBe('IDF environment');
    expect(checkName('loop_delay')).toBe('Event loop');
    expect(checkName('some_new_check')).toBe('some new check');
  });
});

describe('storage', () => {
  it('writes sizes in decimal units', () => {
    expect(sizeText(812)).toBe('812 bytes');
    expect(sizeText(258048)).toBe('258 KB');
    expect(sizeText(48_304_128)).toBe('48.3 MB');
    expect(sizeText(1.2e9)).toBe('1.2 GB');
    expect(sizeText(-1)).toBe('–');
  });

  it('advises compacting only an older file with much free space', () => {
    expect(compactAdvice({ bytes: 1e9, free_bytes: 5e8, auto_vacuum: 'incremental' }).worth).toBe(false);
    expect(compactAdvice({ bytes: 1e9, free_bytes: 5e8, auto_vacuum: 'none' }).worth).toBe(true);
    expect(compactAdvice({ bytes: 1e9, free_bytes: 1e7, auto_vacuum: 'none' }).worth).toBe(false);
  });
});

describe('pure mode', () => {
  it('says the civil durations in a hub text as spans and leaves the rest', () => {
    const spanOf = (us: bigint) => `[${us}]`;
    expect(pureDurations('event loop delay p99 7.47 ms over the last 30 s (above 5 ms)', spanOf)).toBe('event loop delay p99 [7470] over the last [30000000] (above [5000])');
    expect(pureDurations('5 steps, 3 sessions, 64 MB', spanOf)).toBe('5 steps, 3 sessions, 64 MB');
    expect(pureDurations('every 2 h, after 1 min', spanOf)).toBe('every [7200000000], after [60000000]');
  });

  it('gives real spans with the core', () => {
    const { frc, cat } = core;
    const t = frc.now();
    const spanOf = (us: bigint) => frc.formatSpan(cat.spanBetween(t, t + us), 2);
    const out = pureDurations('over the last 60 s', spanOf);
    expect(out).toMatch(/^over the last 7λ \d+ν$/);
    expect(out).not.toMatch(/\bs\b/);
  });
});

describe('the network form', () => {
  const draft = (d: Partial<NetworkDraft>): NetworkDraft => ({ name: 'default', ssid: 'lab', password: '', open: false, band: 'auto', country: '', bssid: '', ...d });

  it('says what is wrong, by field', () => {
    expect(networkErrors(draft({}))).toEqual({});
    expect(networkErrors(draft({ name: 'Lab 5G', ssid: '' }))).toMatchObject({ name: expect.any(String), ssid: expect.any(String) });
    expect(networkErrors(draft({ password: 'short' })).password).toBeDefined();
    expect(networkErrors(draft({ password: 'x'.repeat(65) })).password).toBeDefined();
    expect(networkErrors(draft({ open: true, password: 'short' })).password).toBeUndefined();
    expect(networkErrors(draft({ country: 'DEU', bssid: 'nope' }))).toMatchObject({ country: expect.any(String), bssid: expect.any(String) });
  });

  it('sends the password only when typed, as empty for an open network, and tidies the rest', () => {
    expect(networkSetInput(draft({}))).toEqual({ name: 'default', ssid: 'lab', band: 'auto' });
    expect(networkSetInput(draft({ password: 'secret-123' }))).toMatchObject({ password: 'secret-123' });
    expect(networkSetInput(draft({ open: true, password: 'ignored' })).password).toBe('');
    expect(networkSetInput(draft({ country: 'de', bssid: '3C:84:6A:12:34:56' }))).toMatchObject({ country: 'DE', bssid: '3c:84:6a:12:34:56' });
  });
});
