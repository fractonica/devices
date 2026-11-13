// The frame of every page: the ground, the rail of sigils (left on desktop, a bottom row on phone; design README
// "Hub" 8), the PURE / EARTH toggle, the live connection's bead, the notices over the page and the toasts. The hub's
// state is polled here (hub_status every 5 s) and its prompts reconciled into the live store, as before.

import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';

import { useLive, useOp } from '../hooks.ts';
import { hubClock, store } from '../runtime.ts';
import { Bead, type BeadState } from '../ui/index.ts';
import { Ground } from './ground.tsx';
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

const CONN_BEAD: Record<string, BeadState> = { open: 'online', connecting: 'waiting', closed: 'fault', idle: 'idle', stopped: 'idle' };

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

function Rail({ prompts, warnings }: { prompts: number; warnings: number }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const conn = useLive((s) => s.conn);
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
            {n.sigil === 'hub' && prompts ? (
              <span className="badge">
                <Bead state="waiting" label={`${prompts} pending prompt${prompts > 1 ? 's' : ''}`} size={6} />
              </span>
            ) : null}
            {n.sigil === 'settings' && warnings ? (
              <span className="badge">
                <Bead state="waiting" label={`${warnings} hub warning${warnings > 1 ? 's' : ''}`} size={6} />
              </span>
            ) : null}
          </Link>
        ))}
      </nav>
      <div className="rail-foot">
        <span className="live-mark" title={`live updates: ${conn.status}`} data-conn={conn.status}>
          <Bead state={CONN_BEAD[conn.status] ?? 'idle'} label={`live updates ${conn.status}`} />
          <span className="caps">LIVE</span>
        </span>
      </div>
    </div>
  );
}

export function Shell() {
  const status = useOp('hub_status', {}, { refetchInterval: 5000 });
  const prompts = useLive((s) => Object.keys(s.prompts).length);
  // hub_status.prompts is the hub's own list of pending prompts (D3).
  useEffect(() => {
    if (status.data?.prompts) {
      store.getState().reconcilePrompts(status.data.prompts, hubClock.now());
    }
  }, [status.data]);
  // the readiness contract with tools/dash-shoot.mjs (as the site's): the shell has drawn and the hub has answered once
  useEffect(() => {
    if (status.data || status.error) {
      document.documentElement.dataset.ready = '1';
    }
  }, [status.data, status.error]);
  return (
    <>
      <Ground />
      <div className="shell">
        <Rail prompts={prompts} warnings={status.data?.warnings.length ?? 0} />
        <main className="shell-main" id="main">
          <div className="shell-column">
            <Notices status={status.data} statusError={status.error} />
            <Outlet />
          </div>
        </main>
      </div>
      <Toasts />
    </>
  );
}
