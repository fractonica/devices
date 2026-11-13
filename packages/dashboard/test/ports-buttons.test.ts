// The Ports page's policy buttons (legacy/pages/ports.tsx PolicyButtons, until the Settings page replaces it): each port state offers the actions that change it,
// and the undo of each: Ignore / Stop ignoring, Claim / Unclaim, Lend (a lent port has only its Release button).
// Rendered to a string; no hub is called.

import { QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import type { PortInfo } from '@fractonica/protocol/browser';

type Runtime = typeof import('../src/runtime.ts');
type Page = typeof import('../src/legacy/pages/ports.tsx');

let runtime: Runtime;
let page: Page;

beforeAll(async () => {
  // runtime.ts builds its /ws URL from the page's location at import.
  (globalThis as { location?: unknown }).location ??= { protocol: 'http:', host: '127.0.0.1:7420' };
  runtime = await import('../src/runtime.ts');
  page = await import('../src/legacy/pages/ports.tsx');
});

function actions(port: Partial<PortInfo>): string[] {
  const full: PortInfo = { path: '/dev/cu.usbmodem1201', state: 'open', lines: 0, ...port } as PortInfo;
  const html = renderToString(createElement(QueryClientProvider, { client: runtime.queryClient }, createElement(page.PolicyButtons, { port: full })));
  return [...html.matchAll(/data-action="([a-z]+)"/g)].map((m) => m[1]);
}

describe('PolicyButtons', () => {
  it('a watched port: Lend and Ignore', () => {
    expect(actions({ state: 'open', policy: 'adopted' })).toEqual(['lend', 'ignore']);
  });

  it('an ignored port: Lend and Stop ignoring, no Claim', () => {
    expect(actions({ state: 'ignored', policy: 'ignored' })).toEqual(['lend', 'unignore']);
  });

  it('a port the hub leaves alone: Lend, Ignore and Claim', () => {
    expect(actions({ state: 'unwatched', policy: 'not_adopted' })).toEqual(['lend', 'ignore', 'claim']);
  });

  it('a claimed port: Lend, Ignore and Unclaim', () => {
    expect(actions({ state: 'open', policy: 'claimed' })).toEqual(['lend', 'ignore', 'unclaim']);
  });

  it('a port closed because config.json is broken: no Claim (the file must be fixed first)', () => {
    expect(actions({ state: 'unwatched', policy: 'config_invalid' })).toEqual(['lend', 'ignore']);
  });

  it('a lent port: none (its Release button ends the lease)', () => {
    expect(actions({ state: 'leased', lease: { lease_id: 'l_0123456789ab', expires_at: new Date().toISOString() } as PortInfo['lease'] })).toEqual([]);
  });
});
