// What the dashboard says without being asked (spec 08 §8.9, design c6 D3): the notices over every page (the hub not
// answering, `/ws` reconnecting, a dashboard built for another op registry, a stale build) as error lines and rows
// (the hub's own warnings and the lid note are on Settings › Health, and the Settings sigil carries a bead for them); and the toasts (pending prompt_human requests until their wait ends, job ends,
// action results) as a stack of hairline rows in the bottom right. Times are spans from the core (FTime), never
// seconds, so pure mode stays pure.

import type { OpError } from '../api/rest.ts';
import type { HubStatusView } from '../api/types.ts';
import { useLive, useNow } from '../hooks.ts';
import { store } from '../runtime.ts';
import { pendingPrompts, type Tone } from '../state/live.ts';
import { Bead, type BeadState, Button, ErrorLine, FTime, Row } from '../ui/index.ts';

/** The dashboard's build-time op registry hash (vite.config.ts), to compare with the hub's hello. */
declare const __FR_REGISTRY_HASH__: string | undefined;
const BUILT_FOR = typeof __FR_REGISTRY_HASH__ === 'string' ? __FR_REGISTRY_HASH__ : undefined;

const TONE_BEAD: Record<Tone, BeadState> = { ok: 'online', info: 'online', warn: 'waiting', bad: 'fault' };

/** The notices at the top of every page; nothing when all is well. */
export function Notices({ status, statusError }: { status: HubStatusView | undefined; statusError: OpError | null }) {
  const conn = useLive((s) => s.conn);
  const out = [];
  if (statusError?.code === 'HUB_UNREACHABLE') {
    out.push(<ErrorLine key="down" message={<>The hub at {location.host} does not answer. Start it with <code>fr hub start</code>; this page reconnects by itself.</>} />);
  } else if (conn.status === 'closed' && conn.attempts > 1) {
    out.push(<Row key="ws" bead="waiting" label="Live updates" value="reconnecting: what the pages show may be behind" id="ws-down" />);
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

/** The toast stack: prompts first (they stay until answered), then job ends and action results. */
export function Toasts() {
  const now = useNow(1000);
  const prompts = useLive((s) => s.prompts);
  const toasts = useLive((s) => s.toasts);
  const pending = pendingPrompts({ prompts }, now);
  if (!pending.length && !toasts.length) {
    return null;
  }
  return (
    <div className="ui-toasts" aria-live="polite">
      {pending.map((p) => (
        <div key={p.prompt_id} className="ui-toast" data-tone="prompt" role="alert" data-prompt={p.prompt_id}>
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
              ) : null}{' '}
              · ends <FTime at={p.expires_at} form="relative" />
            </p>
          </div>
        </div>
      ))}
      {toasts.slice(-5).map((t) => (
        <div key={t.id} className="ui-toast" data-toast={t.tone} data-job={t.job_id}>
          <Bead state={TONE_BEAD[t.tone]} />
          <div className="ui-toast-body">
            <p className="ui-toast-title">{t.title}</p>
            {t.body ? <p className="ui-toast-text">{t.body}</p> : null}
          </div>
          <Button variant="quiet" aria-label="dismiss" onClick={() => store.getState().dismiss(t.id)}>
            Dismiss
          </Button>
        </div>
      ))}
    </div>
  );
}
