// The frame of every page: the ground, the rail of sigils (left on desktop, a bottom row on phone; design README
// "Hub" 8: no bar, no badge), the PURE / EARTH toggle (in the rail; at phone width in the page's top right corner, so it
// scrolls away with the page), the notices over the page (the live link down among them) and the toasts. The hub's
// state is polled here (hub_status every 5 s) and its prompts reconciled into the live store, as before.

import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';

import { useOp } from '../hooks.ts';
import { hubClock, store } from '../runtime.ts';
import { Ground } from './ground.tsx';
import { linkRestDown, useLinkDown } from './link.ts';
import { LookPicker } from './look-picker.tsx';
import { useMode } from './mode.ts';
import { Notices, Toasts } from './notices.tsx';
import { ModeRing, Sigil, type SigilName } from './sigils.tsx';

/** The rail, in order: route, sigil, engraved word. */
export const NAV: readonly { to: string; sigil: SigilName; word: string }[] = [
  { to: '/', sigil: 'hub', word: 'HUB' },
  { to: '/devices', sigil: 'devices', word: 'DEVICES' },
  { to: '/provision', sigil: 'provision', word: 'PROVISION' },
  { to: '/live', sigil: 'live', word: 'LIVE' },
  { to: '/bench', sigil: 'bench', word: 'BENCH' },
  { to: '/settings', sigil: 'settings', word: 'SETTINGS' },
];

function ModeToggle() {
  const { mode, toggle } = useMode();
  const word = mode === 'earth' ? 'EARTH' : 'PURE';
  return (
    <button type="button" className="mode-toggle" onClick={toggle} aria-pressed={mode === 'earth'} aria-label={`Mode: ${word}. Switch to ${mode === 'earth' ? 'PURE' : 'EARTH'}`}>
      <ModeRing />
      <span className="caps">{word}</span>
    </button>
  );
}

function Rail() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const current = (to: string) => (to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`));
  return (
    <div className="rail">
      <div className="rail-top">
        <ModeToggle />
      </div>
      <nav className="sigils" aria-label="Pages">
        {NAV.map((n) => (
          <Link key={n.to} to={n.to} className="sigil" aria-current={current(n.to) ? 'page' : undefined} data-nav={n.sigil}>
            <Sigil name={n.sigil} />
            <span className="caps">{n.word}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function Shell() {
  const linkDown = useLinkDown();
  const status = useOp('hub_status', {}, { refetchInterval: 5000, noRetry: true });
  // hub_status.prompts is the hub's own list of pending prompts (D3).
  useEffect(() => {
    if (status.data?.prompts) {
      store.getState().reconcilePrompts(status.data.prompts, hubClock.now());
    }
  }, [status.data]);
  useEffect(() => {
    linkRestDown(status.error?.code === 'HUB_UNREACHABLE');
  }, [status.error]);
  // the readiness contract with tools/dash-shoot.mjs (as the site's): the shell has drawn and the hub has answered once
  useEffect(() => {
    if (status.data || status.error) {
      document.documentElement.dataset.ready = '1';
    }
  }, [status.data, status.error]);
  return (
    <>
      <Ground />
      <div className="shell" data-link={linkDown ? 'down' : undefined}>
        <Rail />
        <main className="shell-main" id="main">
          <div className="shell-column">
            <div className="shell-mode">
              <ModeToggle />
            </div>
            <Notices status={status.data} statusError={status.error} />
            <Outlet />
          </div>
        </main>
      </div>
      <Toasts hubDown={status.error?.code === 'HUB_UNREACHABLE'} />
      <LookPicker />
    </>
  );
}
