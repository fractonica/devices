// The ports as Provision's Plug in step and Settings › Ports both say them (src/state/ports.ts): every state's words,
// bead and policy actions with the undo of each (the port policy of stage 2), what blocks provisioning on a port with
// the fix the page runs in place, the board to offer first, the policy mode in words, and the lend times in Fractonica
// spans from the real core.

import { beforeAll, describe, expect, it } from 'vitest';

import type { PortInfo } from '@fractonica/protocol/browser';
import { type Core, loadCore } from '@fractonica/time';

import { LEASE_MAX_S, lendChoices, modeWords, portBlock, portView, suggestPort } from '../src/state/ports.ts';

let core: Core;
beforeAll(async () => {
  core = await loadCore();
});

const port = (p: Partial<PortInfo>): PortInfo => ({ path: '/dev/cu.usbmodem1101', state: 'open', lines: 0, ...p }) as PortInfo;

describe('ports in Settings', () => {

  it('says each state in words, with a bead and the actions it allows, the undo of each among them', () => {
    expect(portView(port({ state: 'open', policy: 'adopted' }))).toMatchObject({ word: 'watched by the hub', bead: 'online', actions: ['lend', 'ignore'] });
    expect(portView(port({ state: 'open', policy: 'claimed' })).actions).toEqual(['lend', 'ignore', 'unclaim']);
    expect(portView(port({ state: 'ignored', policy: 'ignored' }))).toMatchObject({ word: 'ignored', bead: 'offline', actions: ['lend', 'unignore'] });
    expect(portView(port({ state: 'unwatched', policy: 'not_adopted' }))).toMatchObject({ word: 'not watched', bead: 'idle', actions: ['lend', 'ignore', 'claim'] });
    // a broken config.json: no claim until it is fixed
    expect(portView(port({ state: 'unwatched', policy: 'config_invalid' })).actions).toEqual(['lend', 'ignore']);
    expect(portView(port({ state: 'busy_external', external: [{ app: 'Google Chrome', pid: 42 }] as PortInfo['external'] }))).toMatchObject({ word: 'held by Google Chrome', bead: 'waiting', actions: ['ignore'] });
    expect(portView(port({ state: 'error' })).bead).toBe('fault');
  });

  it('a lent port says to whom and offers only Release', () => {
    const v = portView(port({ state: 'leased', lease: { lease_id: 'l_0123456789ab', expires_at: '2026-11-13T18:00:00Z', holder_pid: 77 } as PortInfo['lease'] }));
    expect(v).toMatchObject({ word: 'lent to pid 77', bead: 'waiting', actions: ['release'] });
    expect(portView(port({ state: 'leased', lease: { lease_id: 'l_0123456789ab', expires_at: 'x' } as PortInfo['lease'] })).word).toBe('lent');
  });

  it('says the policy mode in words', () => {
    expect(modeWords('adopted').word).toBe('Adopted only');
    expect(modeWords('all').word).toBe('All ports');
    expect(modeWords(undefined).word).toBe('unknown');
  });

  it('offers lend times in Fractonica spans within the lease cap, from the core', () => {
    const { frc, cat } = core;
    const choices = lendChoices(frc as never, cat.intervalAt(frc.now()));
    expect(choices.map((c) => c.label)).toEqual(['30λ', '1ι', '2ι', '3ι']);
    for (const c of choices) {
      expect(Number.isInteger(c.ttl_s)).toBe(true);
      expect(c.ttl_s).toBeGreaterThan(0);
      expect(c.ttl_s).toBeLessThanOrEqual(LEASE_MAX_S);
    }
    // a Preon is about 505 s, a Flavon about 7.8 s
    expect(choices[1]!.ttl_s).toBeGreaterThan(480);
    expect(choices[1]!.ttl_s).toBeLessThan(530);
  });
});

describe('ports on the Plug in step', () => {
  it('say what each port is to the hub, with the bead and the policy actions it offers', () => {
    expect(portView(port({ state: 'open', policy: 'adopted' }), true)).toMatchObject({ bead: 'online', word: 'watched by the hub', actions: ['lend', 'ignore'], isNew: false });
    expect(portView(port({ state: 'unwatched', policy: 'not_adopted' }), false)).toMatchObject({ bead: 'idle', word: 'not watched', actions: ['lend', 'ignore', 'claim'], isNew: true });
    expect(portView(port({ state: 'ignored', policy: 'ignored' }), false)).toMatchObject({ bead: 'offline', word: 'ignored', actions: ['lend', 'unignore'] });
    expect(portView(port({ state: 'open', policy: 'claimed' }), false).actions).toEqual(['lend', 'ignore', 'unclaim']);
    const lent = port({ state: 'leased', lease: { lease_id: 'l_000000000001', expires_at: '2026-11-13T12:00:00Z' } });
    expect(portView(lent, true)).toMatchObject({ bead: 'waiting', word: 'lent', actions: ['release'] });
    expect(portView(port({ state: 'leased', lease: { lease_id: 'l_000000000002', expires_at: 'x', by: 'job' } }), true)).toMatchObject({ word: 'in use by a job', actions: [] });
    const held = port({ state: 'busy_external', external: [{ app: 'Google Chrome', pid: 7 }, { app: 'screen', pid: 9 }] });
    expect(portView(held, false)).toMatchObject({ bead: 'waiting', word: 'held by Google Chrome and screen', actions: ['ignore'] });
    expect(portView(port({ state: 'error' }), false).bead).toBe('fault');
    expect(portView(port({ path: '/dev/cu.usbmodem-fr-02f200000007' }), false).name).toBe('cu.usbmodem-fr-02f200000007');
  });

  it('block provisioning before it starts with the fix the page runs in place', () => {
    expect(portBlock(port({ state: 'open' }))).toBeNull();
    expect(portBlock(port({ state: 'unwatched' }))).toBeNull();
    expect(portBlock(port({ state: 'busy_external', external: [{ app: 'Google Chrome', pid: 715 }] }))).toMatchObject({ fix: 'recheck', message: expect.stringMatching(/^Google Chrome has this port open/) });
    expect(portBlock(port({ state: 'leased', lease: { lease_id: 'l_000000000001', expires_at: 'x' } }))).toMatchObject({ fix: 'release', fixLabel: 'Release' });
    expect(portBlock(port({ state: 'leased', lease: { lease_id: 'l_000000000001', expires_at: 'x', by: 'job' } }))).toMatchObject({ fix: null });
    expect(portBlock(port({ state: 'ignored' }))).toMatchObject({ fix: 'unignore' });
    expect(portBlock(port({ state: 'closed', policy: 'config_invalid' }))?.message).toMatch(/config.json/);
  });

  it('offer the board plugged in since the page opened, else the only new board, else the only port', () => {
    const a = port({ path: '/dev/a' });
    const b = port({ path: '/dev/b', alias: 'desk-pad' });
    const known = (p: PortInfo) => p.alias !== undefined;
    expect(suggestPort([a, b], new Set(['/dev/b']), known)).toBe(a);
    expect(suggestPort([a, b], new Set(['/dev/a', '/dev/b']), known)).toBe(a); // the only unknown one
    expect(suggestPort([b], new Set(['/dev/b']), known)).toBe(b);
    expect(suggestPort([a, port({ path: '/dev/c' })], new Set(['/dev/a', '/dev/c']), known)).toBeNull();
  });
});
