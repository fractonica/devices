// Links between the Bench page's views: the /bench route with the view in its search (?v=guide&id=…), so a view is
// bookmarkable and Back works, without routes of its own (state/bench-view.ts benchRoute reads it).

import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { type BenchRoute, benchSearch } from '../../state/bench-view.ts';

export function BenchLink({ to, children, className }: { to: BenchRoute; children: ReactNode; className?: string }) {
  return (
    <Link to="/bench" search={benchSearch(to) as never} className={className}>
      {children}
    </Link>
  );
}
