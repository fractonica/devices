// What the dashboard says without being asked (spec 08 §8.9, design c6 D3): the notices over every page (the hub not
// answering, `/ws` reconnecting, a dashboard built for another op registry, a stale build) as error lines and rows
// (the hub's own warnings and the lid note are on Settings › Health); and the toasts (pending prompt_human requests until their wait ends, job ends,
// action results) as a stack of hairline rows in the bottom right. Times are spans from the core (FTime), never
// seconds, so pure mode stays pure.

import type { OpError } from '../api/rest.ts';
import type { HubStatusView } from '../api/types.ts';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { useLive, useOp } from '../hooks.ts';
import { hubClock, store } from '../runtime.ts';
import { useLinkDown } from './link.ts';
import { pendingPrompts, type Tone } from '../state/live.ts';
import { Bead, type BeadState, Button, engrave, ErrorLine, FTime, Row, useHubText } from '../ui/index.ts';

/** The dashboard's build-time op registry hash (vite.config.ts), to compare with the hub's hello. */
declare const __FR_REGISTRY_HASH__: string | undefined;
const BUILT_FOR = typeof __FR_REGISTRY_HASH__ === 'string' ? __FR_REGISTRY_HASH__ : undefined;

const TONE_BEAD: Record<Tone, BeadState> = { ok: 'online', info: 'online', warn: 'waiting', bad: 'fault' };

/** The notices at the top of every page; nothing when all is well. */
export function Notices({ status, statusError }: { status: HubStatusView | undefined; statusError: OpError | null }) {
  const conn = useLive((s) => s.conn);
  const down = useLinkDown();
  const out = [];
  if (statusError?.code === 'HUB_UNREACHABLE') {
    out.push(<ErrorLine key="down" message={<>The hub at {location.host} does not answer. Start it with <code>fr hub start</code>; this page reconnects by itself.</>} />);
  } else if (down) {
    out.push(<Row key="ws" bead="waiting" label="Live updates" value="reconnecting: what the pages show may be behind, and actions wait for it" id="ws-down" />);
  }
  const hubHash = conn.hello?.registry_hash ?? status?.registry_hash;
  if (BUILT_FOR && hubHash && hubHash !== BUILT_FOR) {
    out.push(
      <ErrorLine
        key="hash"
        message={
          <>
            This dashboard was built for op registry {BUILT_FOR}, the hub runs {hubHash}: rebuild it (<code>fr doctor --fix</code>) or restart the hub.
          </>
        }
      />,
    );
  }
  if (status?.dashboard?.stale) {
    out.push(<Row key="stale" bead="waiting" label="Dashboard" value={<>older than its source: <code>fr doctor --fix</code> rebuilds it</>} id="dashboard-stale" />);
  }
  return out.length ? (
    <div className="shell-notices" data-notices="">
      {out}
    </div>
  ) : null;
}

const PHONE = '(max-width: 699.98px)';

/** Redraws when the first of `ends` (ISO, the hub's wall clock) has passed: a prompt's wait ending. Nothing to wait for, no timer. */
function useUntilFirst(ends: readonly string[]): void {
  const [, tick] = useState(0);
  const first = ends.reduce<number | null>((m, e) => {
    const t = Date.parse(e);
    return Number.isFinite(t) && (m === null || t < m) ? t : m;
  }, null);
  useEffect(() => {
    if (first === null) {
      return;
    }
    const t = setTimeout(() => tick((n) => n + 1), Math.max(50, Math.min(first - hubClock.now().wall + 50, 2 ** 31 - 1)));
    return () => clearTimeout(t);
  }, [first]);
}

/** The height of the stack at the bottom, as --toasts-h on the root, so a page can scroll clear of it. */
function useStackHeight(el: HTMLElement | null): void {
  useEffect(() => {
    const root = document.documentElement;
    if (!el) {
      root.style.removeProperty('--toasts-h');
      return;
    }
    const ro = new ResizeObserver(() => root.style.setProperty('--toasts-h', `${Math.ceil(el.getBoundingClientRect().height)}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--toasts-h');
    };
  }, [el]);
}

/**
 * The toast stack: prompts first (they stay until answered; on a phone folded to one line that opens), then job ends
 * and action results. One polite live region announces what is added; a countdown is not read out as it changes.
 * While the hub is not answering the prompts are held back: their waits may be over.
 */
export function Toasts({ hubDown = false }: { hubDown?: boolean }) {
  const prompts = useLive((s) => s.prompts);
  const toasts = useLive((s) => s.toasts);
  const say = useHubText();
  const devices = useOp('device_list', {});
  const alias = (id: string) => devices.data?.devices.find((d) => d.device_id === id)?.alias ?? id;
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const phone = useSyncExternalStore(
    (l) => {
      const m = matchMedia(PHONE);
      m.addEventListener('change', l);
      return () => m.removeEventListener('change', l);
    },
    () => matchMedia(PHONE).matches,
    () => false,
  );
  const pending = hubDown ? [] : pendingPrompts({ prompts }, hubClock.now());
  useUntilFirst(pending.map((p) => p.expires_at));
  const shown = toasts.slice(-5);
  useStackHeight(pending.length || shown.length ? box : null);
  if (!pending.length && !shown.length) {
    return null;
  }
  const folded = phone && pending.length > 0 && !open;
  return (
    <div className="ui-toasts" ref={setBox} aria-live="polite" aria-relevant="additions" data-folded={folded ? '' : undefined}>
      {folded ? (
        <button type="button" className="ui-toast ui-toast-fold" data-tone="prompt" onClick={() => setOpen(true)} aria-expanded={false}>
          <Bead state="waiting" label="action needed" />
          <span className="caps label">{engrave(`action needed · ${pending.length}`)}</span>
          <span className="ui-toast-more caps">{engrave('show')}</span>
        </button>
      ) : (
        <>
          {phone && pending.length ? (
            <button type="button" className="ui-toast-fold-close caps" onClick={() => setOpen(false)} aria-expanded>
              {engrave('hide')}
            </button>
          ) : null}
          {pending.map((p) => (
            <div key={p.prompt_id} className="ui-toast" data-tone="prompt" data-prompt={p.prompt_id}>
              <Bead state="waiting" label="action needed" />
              <div className="ui-toast-body">
                <p className="caps label">ACTION NEEDED</p>
                <p className="ui-toast-title">{p.text}</p>
                <p className="ui-toast-text">
                  waiting for <code>{p.types.join(', ')}</code>
                  {p.selector ? (
                    <>
                      {' '}
                      on <code>{p.selector}</code>
                    </>
                  ) : null}
                  <span aria-hidden="true">
                    {' '}
                    · ends <FTime at={p.expires_at} form="relative" />
                  </span>
                </p>
              </div>
            </div>
          ))}
        </>
      )}
      {shown.map((t) => {
        let title = t.title;
        for (const id of t.targets ?? []) {
          title = title.replace(id, alias(id));
        }
        return (
          <div key={t.id} className="ui-toast" data-toast={t.tone} data-job={t.job_id} title={t.code ? t.code.toLowerCase().replace(/_/g, ' ') : undefined}>
            <Bead state={TONE_BEAD[t.tone]} />
            <div className="ui-toast-body">
              <p className="ui-toast-title">{say(title)}</p>
              {t.body ? <p className="ui-toast-text">{say(t.body)}</p> : null}
            </div>
            <Button variant="quiet" aria-label="dismiss" onClick={() => store.getState().dismiss(t.id)}>
              Dismiss
            </Button>
          </div>
        );
      })}
    </div>
  );
}
