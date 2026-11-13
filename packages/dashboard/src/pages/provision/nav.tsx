// The Provision page's three views as engraved words on a hairline (the shared SubNav's look; SubNav takes no search,
// and the views are `?view=` on the one route): a new board, the firmware (builds and artifacts) and over the air.

import { engrave } from '../../ui/index.ts';

export type ProvisionView = 'board' | 'firmware' | 'ota';

const VIEWS: { view: ProvisionView; label: string }[] = [
  { view: 'board', label: 'New board' },
  { view: 'firmware', label: 'Firmware' },
  { view: 'ota', label: 'Over the air' },
];

export function ProvisionNav({ current }: { current?: ProvisionView }) {
  return (
    <nav className="ui-subnav prov-nav" aria-label="Provision">
      {VIEWS.map((v) => (
        // a plain hash link: the router's Link marks /provision current whatever the search
        <a key={v.view} href={v.view === 'board' ? '#/provision' : `#/provision?view=${v.view}`} className="ui-subnav-item caps" aria-current={v.view === current ? 'page' : undefined} data-view={v.view}>
          {engrave(v.label)}
        </a>
      ))}
    </nav>
  );
}
