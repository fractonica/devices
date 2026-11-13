// Nothing to show yet: a hollow engraved ring, a caps title, a sentence that says what to do, and that action.

import type { ReactNode } from 'react';

import { engrave } from './text.tsx';

export interface EmptyStateProps {
  title: string;
  children?: ReactNode;
  /** The one thing to do about it (a Button). */
  action?: ReactNode;
}

export function EmptyState({ title, children, action }: EmptyStateProps) {
  return (
    <div className="ui-empty">
      <svg className="ui-empty-mark" width="24" height="24" viewBox="-12 -12 24 24" aria-hidden="true">
        <circle r="7" fill="none" stroke="currentColor" strokeWidth="1" />
      </svg>
      <p className="ui-empty-title caps">{engrave(title)}</p>
      {children ? <div className="ui-empty-text">{children}</div> : null}
      {action ? <div className="ui-empty-action">{action}</div> : null}
    </div>
  );
}
