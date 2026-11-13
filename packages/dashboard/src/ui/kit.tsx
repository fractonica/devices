// Small shared pieces (lifted from the Settings, Live and Bench pages in the stage 4 integration): a duration said as a
// Fractonica span (⊕ its Earth duration in Earth mode), a hub text in the mode's units, a copy button whose word says
// it copied (nothing moves), a chip that toggles, inline code, and the Line (a row with a detail line and its own
// buttons).

import './kit.css';

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { type Core } from '@fractonica/time/browser';

import { earthDuration, spanText as spanAgo } from '../state/device-units.ts';
import { pureText } from '../state/pure-text.ts';
import { type BeadState, Bead } from './bead.tsx';
import { useMode } from '../shell/mode.ts';
import { Earth, engrave, Reading } from './text.tsx';
import { useFractonica } from '../time/hooks.ts';

/** A duration in µs as the core's span ("0.048ν", "1ι 12λ"); a negative one with a minus. */
export function spanText(core: Core, us: bigint | number, parts = 2): string {
  return spanAgo(core, typeof us === 'bigint' ? Number(us) : us, parts);
}

/** A span text maker bound to the core (undefined while it loads), for code that writes strings (summary lines). */
export function useSpanOf(): ((us: bigint) => string) | undefined {
  const core = useFractonica();
  return useMemo(() => (core ? (us: bigint) => spanText(core, us) : undefined), [core]);
}

/**
 * A text of the hub's in the mode's units (state/pure-text.ts): Earth mode shows it whole; pure mode says its
 * durations as spans and leaves out a clause that states another Earth measure.
 */
export function useHubText(): (text: string) => string {
  const { earth } = useMode();
  const spanOf = useSpanOf();
  return (text) => (earth ? text : pureText(text, spanOf));
}

/**
 * A duration: the Fractonica span, and in Earth mode the civil duration after it in ash, led by ⊕ ("0.048ν ⊕ 14.9 ms").
 * `us` is µs; `sign` goes before both ("±"); null renders an en dash.
 */
export function Span({ us, parts = 2, sign = '' }: { us: number | bigint | null | undefined; parts?: number; sign?: string }) {
  const core = useFractonica();
  if (us === null || us === undefined || !core) {
    return <span className="ui-ftime">–</span>;
  }
  const n = typeof us === 'bigint' ? Number(us) : us;
  return (
    <span className="ui-ftime">
      <Reading text={`${sign}${spanText(core, n, parts)}`} />
      <Earth className="ui-span-earth">{`${sign}${earthDuration(core, n)}`}</Earth>
    </span>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // an insecure context or a refused permission: the old way
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** A quiet button that copies `text`; its word becomes "Copied" (or "Not copied") until the next press or a while later. */
export function CopyButton({ text, label = 'Copy', what }: { text: string; label?: string; what?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const word = state === 'ok' ? 'Copied' : state === 'failed' ? 'Not copied' : label;
  return (
    <button
      type="button"
      className="ui-button"
      data-variant="quiet"
      aria-label={what ? `${label}: ${what}` : undefined}
      onClick={async () => {
        const ok = await copyText(text);
        setState(ok ? 'ok' : 'failed');
        if (timer.current) {
          clearTimeout(timer.current);
        }
        timer.current = setTimeout(() => setState('idle'), 2400);
      }}
      data-copied={state === 'ok' ? '' : undefined}
    >
      <span className="ui-button-text" aria-live="polite">
        {engrave(word)}
      </span>
    </button>
  );
}

/** A toggle chip: hairline caps word (or a bead and a name), lumen when pressed. */
export function Chip({ pressed, onToggle, children, bead, beadLabel, title, count }: { pressed: boolean; onToggle: () => void; children: string; bead?: BeadState; beadLabel?: string; title?: string; count?: number }) {
  return (
    <button type="button" className="ui-chip" aria-pressed={pressed} onClick={onToggle} title={title}>
      {bead ? <Bead state={bead} label={beadLabel} size={6} /> : null}
      <span className="ui-chip-word">{bead ? children : engrave(children)}</span>
      {count !== undefined ? <span className="ui-chip-count">{count}</span> : null}
    </button>
  );
}

/** A line of chips that wraps. */
export function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ui-chips" role="group" aria-label={label}>
      {children}
    </div>
  );
}

/** A command or id in the monospace face, selectable. */
export function Code({ children }: { children: ReactNode }) {
  return <code className="ui-code">{children}</code>;
}

/**
 * A row that carries more than Row: a bead and a label (caps) or a name (bone), a value on the right, a detail line in
 * ash under them and the row's own buttons; on a hairline like every row. Used for checks, ports and networks.
 */
export function Line({
  bead,
  beadLabel,
  label,
  name,
  value,
  detail,
  actions,
  children,
  id,
}: {
  bead?: BeadState;
  beadLabel?: string;
  label?: string;
  name?: ReactNode;
  value?: ReactNode;
  detail?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  id?: string;
}) {
  return (
    <div className="ui-line" data-row={id}>
      <div className="ui-line-head">
        <span className="ui-line-lead">
          {bead ? (
            <span className="ui-line-bead">
              <Bead state={bead} label={beadLabel} />
            </span>
          ) : null}
          {label ? <span className="ui-line-label caps">{engrave(label)}</span> : null}
          {name ? <span className="ui-line-name">{name}</span> : null}
        </span>
        {value !== undefined ? <span className="ui-line-value">{value}</span> : null}
      </div>
      {detail ? <div className="ui-line-detail">{detail}</div> : null}
      {children}
      {actions ? <div className="ui-line-actions">{actions}</div> : null}
    </div>
  );
}
