// BENCH, route `/bench` (HARDWARE-REVIEW §4 "Screens" 7; design wiring-w1 D4): what used to be the separate bench app
// (web/bench, /apps/bench/), folded into the dashboard in the hub's language. Three views, named in the route's
// search so each is bookmarkable and Back works:
//
//   /bench                         Guides: every wiring guide, its steps as light            bench/guides.tsx
//   /bench?v=guide&id=<guide>      a guide: safety, parts, sections with drawings, the pins  bench/guide.tsx
//   /bench?v=parts                 Parts: the catalogue by category, a search                bench/parts.tsx
//   /bench?v=part&id=<part>        a part: specs, pins, notes, datasheets, stock             bench/parts.tsx
//   /bench?v=shopping              Shopping: what the unfinished guides still need           bench/parts.tsx
//
// "Read the files again" (wiring_reload) picks up edits to hardware/wiring and hardware/parts without a restart.

import './bench.css';

import { Link, useSearch } from '@tanstack/react-router';

import { useAct } from '../hooks.ts';
import { type BenchRoute, benchRoute, benchSearch, benchTab } from '../state/bench-view.ts';
import { HELD } from '../state/pure-text.ts';
import { Button, engrave, Page, useMode } from '../ui/index.ts';
import { clearDiagrams } from './bench/diagram.tsx';
import { GuideView } from './bench/guide.tsx';
import { GuidesView } from './bench/guides.tsx';
import { PartsView, PartView, ShoppingView } from './bench/parts.tsx';
import { HeldMarks } from './bench/said.tsx';

const TABS: { to: BenchRoute; label: string; tab: ReturnType<typeof benchTab> }[] = [
  { to: { view: 'guides' }, label: 'Guides', tab: 'guides' },
  { to: { view: 'parts' }, label: 'Parts', tab: 'parts' },
  { to: { view: 'shopping' }, label: 'Shopping', tab: 'shopping' },
];

const SUB: Record<ReturnType<typeof benchTab>, string> = {
  guides: 'wiring guides, step by step',
  parts: 'the parts catalogue and what is on hand',
  shopping: 'what the unfinished guides still need',
};

function Tabs({ current }: { current: ReturnType<typeof benchTab> }) {
  return (
    <nav className="ui-subnav" aria-label="Bench">
      {TABS.map((t) => (
        <Link key={t.tab} to="/bench" search={benchSearch(t.to) as never} className="ui-subnav-item caps" aria-current={t.tab === current ? 'page' : undefined}>
          {engrave(t.label)}
        </Link>
      ))}
    </nav>
  );
}

export function BenchPage() {
  const { earth } = useMode();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const route = benchRoute(search);
  const tab = benchTab(route);
  const reload = useAct('wiring_reload', {
    done: (r) => `read ${r.guides} guides and ${r.parts} parts${r.refused.length ? `; ${r.refused.length} refused` : ''}`,
    refresh: ['wiring_list', 'wiring_show', 'part_list', 'part_show', 'wiring_shopping'],
  });
  return (
    <Page
      title="Bench"
      sub={SUB[tab]}
      actions={
        <Button
          variant="quiet"
          busy={reload.isPending}
          data-action="reload"
          onClick={() => {
            clearDiagrams();
            reload.mutate({});
          }}
        >
          Read the files again
        </Button>
      }
    >
      <Tabs current={tab} />
      {earth ? null : (
        <p className="bench-pure-note">
          <span className="caps">{engrave('pure')}</span> marks the ratings, sizes and values parts are sold by with <HeldMarks text={HELD} />; <span className="caps">{engrave('earth')}</span> shows them.
        </p>
      )}
      <div className="bench-body" data-view={route.view}>
        {route.view === 'guides' ? <GuidesView /> : null}
        {route.view === 'guide' ? <GuideView key={route.id} id={route.id} /> : null}
        {route.view === 'parts' ? <PartsView /> : null}
        {route.view === 'part' ? <PartView key={route.id} id={route.id} /> : null}
        {route.view === 'shopping' ? <ShoppingView /> : null}
      </div>
    </Page>
  );
}
