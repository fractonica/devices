// A fold: a caps title on a hairline with a + mark (− when open); the body below it. "Engineering", "Job output".

import { type ReactNode, useId, useState } from 'react';

import { engrave } from './text.tsx';

export interface DisclosureProps {
  title: string;
  /** Right of the title (a count, a bead). */
  aside?: ReactNode;
  defaultOpen?: boolean;
  /** Controlled: open state and its setter. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The key of the in-place form it opens (ui/in-place.ts): focus comes back to the title when that form closes. */
  opens?: string;
  children: ReactNode;
}

export function Disclosure({ title, aside, defaultOpen = false, open, onOpenChange, opens, children }: DisclosureProps) {
  const [own, setOwn] = useState(defaultOpen);
  const isOpen = open ?? own;
  const id = useId();
  const set = (v: boolean) => {
    setOwn(v);
    onOpenChange?.(v);
  };
  return (
    <div className="ui-disclosure">
      <button type="button" className="ui-disclosure-toggle" aria-expanded={isOpen} aria-controls={id} data-opens={opens} onClick={() => set(!isOpen)}>
        <svg className="mark" width="9" height="9" viewBox="-4.5 -4.5 9 9" aria-hidden="true">
          <path d="M-4 0H4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          <path className="bar" d="M0 -4V4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
        <span className="caps">{engrave(title)}</span>
        {aside ? <span className="ui-disclosure-aside">{aside}</span> : null}
      </button>
      {isOpen ? (
        <div className="ui-disclosure-body" id={id}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
