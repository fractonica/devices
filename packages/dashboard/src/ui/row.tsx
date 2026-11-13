// A row on a hairline (the LENS rows): a caps label (or a name, with a bead) on the left, the value right-aligned,
// an optional extra line under the value and an Earth line (Earth mode only). At phone width the value wraps under
// the label when they do not fit side by side. A row with `to` is a link (TanStack), with `onClick` a button.

import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { type BeadState, Bead } from './bead.tsx';
import { Earth, engrave } from './text.tsx';

export interface RowProps {
  /** A caps label ("RSSI"): ash, engraved. Use `name` instead for a list of things (a device's alias). */
  label?: string;
  /** A name in bone at the value size (a device, a network). */
  name?: ReactNode;
  /** A status bead before the label or name. */
  bead?: BeadState;
  beadLabel?: string;
  /** The value, right-aligned. `children` are the value too. */
  value?: ReactNode;
  children?: ReactNode;
  /** A smaller ash line under the value (a qualifier, a second fact). */
  extra?: ReactNode;
  /** An Earth translation under the value: rendered only in Earth mode, led by ⊕. */
  earth?: ReactNode;
  /** A route: the whole row is a link to it. */
  to?: string;
  params?: Record<string, string>;
  onClick?: () => void;
  /** Lights the hairline in lumen; it fades over 600 ms once unset (an input on the device). */
  flash?: boolean;
  /** data-* hooks for tests. */
  id?: string;
}

export function Row({ label, name, bead, beadLabel, value, children, extra, earth, to, params, onClick, flash, id }: RowProps) {
  const body = (
    <>
      <span className="ui-row-lead">
        {bead ? (
          <span className="bead-slot">
            <Bead state={bead} label={beadLabel} />
          </span>
        ) : null}
        {label ? <span className="ui-row-label caps">{engrave(label)}</span> : null}
        {name ? <span className="ui-row-name">{name}</span> : null}
      </span>
      {value !== undefined || children !== undefined || extra || earth ? (
        <span className="ui-row-values">
          <span className="ui-row-value">
            {value}
            {children}
          </span>
          {extra ? <span className="ui-row-extra">{extra}</span> : null}
          {earth ? (
            <Earth block className="ui-row-earth">
              {earth}
            </Earth>
          ) : null}
        </span>
      ) : null}
    </>
  );
  const data = { 'data-flash': flash ? '' : undefined, 'data-row': id };
  if (to) {
    return (
      <Link to={to as any} params={params as any} className="ui-row" {...data}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" className="ui-row" onClick={onClick} {...data}>
        {body}
      </button>
    );
  }
  return (
    <div className="ui-row" {...data}>
      {body}
    </div>
  );
}
