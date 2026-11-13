// A page's own sections as engraved words on a hairline (Settings: health, networks, ports …): the current one in
// lumen with a lumen hairline under it. Scrolls sideways at phone width rather than wrapping, its cut edge faded.

import { Link } from '@tanstack/react-router';

import { useRef } from 'react';

import { useMoreRight } from './overflow.ts';
import { engrave } from './text.tsx';

export interface SubNavItem {
  /** A route ("/settings/$section") and its params, or a plain path. */
  to: string;
  params?: Record<string, string>;
  label: string;
  /** Marks it current (the caller knows its route). */
  current?: boolean;
}

export function SubNav({ items, label }: { items: readonly SubNavItem[]; label?: string }) {
  const ref = useRef<HTMLElement>(null);
  useMoreRight(ref);
  return (
    <nav className="ui-subnav" aria-label={label} ref={ref}>
      {items.map((i) => (
        // the router's Link with a typed route string: the params are the caller's
        <Link key={`${i.to}:${JSON.stringify(i.params ?? {})}`} to={i.to as never} params={i.params as never} className="ui-subnav-item caps" aria-current={i.current ? 'page' : undefined}>
          {engrave(i.label)}
        </Link>
      ))}
    </nav>
  );
}
