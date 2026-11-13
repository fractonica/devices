// LEGACY (stage 4 foundation): the old pages' building blocks, re-drawn on the new primitives (src/ui) so that the
// old pages stay usable, without Tailwind, inside the new shell until the page builders replace them. Same exports
// and props as before; `className` is accepted and ignored. Do not use these in new pages: import from src/ui.

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

import { Bead, type BeadState, Button as UiButton, ErrorLine, Section, StageRing } from '../../ui/index.ts';

export type BadgeTone = 'ok' | 'warn' | 'bad' | 'info' | 'muted';

const BEAD: Record<BadgeTone, BeadState> = { ok: 'online', warn: 'waiting', bad: 'fault', info: 'online', muted: 'idle' };

export function Badge({ tone = 'muted', children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return (
    <span className="legacy-badge" data-tone={tone} title={title}>
      <Bead state={BEAD[tone]} size={6} />
      <span className="caps">{children}</span>
    </span>
  );
}

/** A presence (online, suspect, offline, unknown) as a badge tone. */
export function presenceTone(p: string | undefined): BadgeTone {
  return p === 'online' ? 'ok' : p === 'suspect' ? 'warn' : p === 'offline' ? 'bad' : 'muted';
}

/** A job status as a badge tone. */
export function statusTone(s: string | undefined): BadgeTone {
  return s === 'completed' ? 'ok' : s === 'failed' ? 'bad' : s === 'cancelled' ? 'warn' : s === 'working' ? 'info' : 'muted';
}

export function Dot({ tone }: { tone: BadgeTone }) {
  return <Bead state={tone === 'bad' ? 'offline' : BEAD[tone]} />;
}

type ButtonTone = 'default' | 'primary' | 'danger' | 'ghost';
const VARIANT = { default: 'default', primary: 'primary', danger: 'destructive', ghost: 'quiet' } as const;

export function Button({ tone = 'default', className: _c, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone }) {
  return (
    <UiButton variant={VARIANT[tone]} {...props}>
      {typeof children === 'string' ? children : <span className="ui-button-text">{children}</span>}
    </UiButton>
  );
}

export function Panel({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className="legacy-panel">
      <Section title={typeof title === 'string' ? title : undefined} aside={typeof title === 'string' ? actions : (<>{title}{actions}</>)} body="loose">
        {children}
      </Section>
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <label className="ui-field">
      <span className="ui-field-label caps">{label.toUpperCase()}</span>
      {children}
      {error ? <span className="ui-field-error">{error}</span> : hint ? <span className="ui-field-note">{hint}</span> : null}
    </label>
  );
}

export function Input({ className: _c, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="ui-input mono" {...props} />;
}

export function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string }) {
  return (
    <select className="ui-select" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function KV({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="legacy-kv">
      {items.map(([k, v]) => (
        <div key={k} className="ui-row">
          <dt className="ui-row-label caps">{k.toUpperCase()}</dt>
          <dd className="ui-row-values">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="legacy-empty">{children}</p>;
}

export function Mono({ children }: { children: ReactNode; className?: string }) {
  return <span className="mono">{children}</span>;
}

export function Json({ value }: { value: unknown }) {
  return <pre className="legacy-json">{JSON.stringify(value, null, 2)}</pre>;
}

/** A failed op: its code and message, what to do, or that this hub does not have the op yet. */
export function ErrorBox({ error, what }: { error: unknown; what?: string }) {
  return <ErrorLine error={error} what={what} />;
}

/** Progress as light: one arc lit to the fraction (no bar, no percentage); unknown leaves it engraved. */
export function Progress({ pct }: { pct?: number }) {
  return <StageRing stages={['working']} current={0} fraction={pct === undefined ? undefined : pct / 100} size={96} />;
}

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="legacy-table">
      <table>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} className="caps">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
