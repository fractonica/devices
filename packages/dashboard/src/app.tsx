// The dashboard's routes (spec 08 §8.9; stage 4): TanStack Router on a hash history, so the hub serves one index.html
// and needs no SPA fallback (D10). Every page sits in the shell (shell/shell.tsx). One file per page under pages/:
//
//   /                      pages/hub.tsx        HubPage
//   /devices               pages/devices.tsx    DevicesPage
//   /devices/$id           pages/device.tsx     DevicePage        (an alias or a device id)
//   /provision             pages/provision.tsx  ProvisionPage
//   /provision/$job        pages/provision.tsx  ProvisionPage     (resumes a provisioning job)
//   /live                  pages/live.tsx       LivePage
//   /bench                 pages/bench.tsx      BenchPage
//   /settings              pages/settings.tsx   SettingsPage      (health)
//   /settings/$section     pages/settings.tsx   SettingsPage      (health networks ports agents storage about)
//   /ui                    pages/specimen.tsx   SpecimenPage      (every primitive; not on the rail)
//
// The old routes (/device/$alias, /ports, /builds, /network, /agents) redirect to their new homes, so a bookmark or a
// link the CLI printed still lands: builds and their artifacts are Provision › Firmware (/provision?view=firmware).

import { createHashHistory, createRootRoute, createRoute, createRouter, lazyRouteComponent, redirect } from '@tanstack/react-router';

import { HubPage } from './pages/hub.tsx';
import { Shell } from './shell/shell.tsx';

// The Hub page is in the main chunk (it is the first page); every other page is its own chunk, loaded on first visit.
const BenchPage = lazyRouteComponent(() => import('./pages/bench.tsx'), 'BenchPage');
const DevicePage = lazyRouteComponent(() => import('./pages/device.tsx'), 'DevicePage');
const DevicesPage = lazyRouteComponent(() => import('./pages/devices.tsx'), 'DevicesPage');
const LivePage = lazyRouteComponent(() => import('./pages/live.tsx'), 'LivePage');
const ProvisionPage = lazyRouteComponent(() => import('./pages/provision.tsx'), 'ProvisionPage');
const SettingsPage = lazyRouteComponent(() => import('./pages/settings.tsx'), 'SettingsPage');
const SpecimenPage = lazyRouteComponent(() => import('./pages/specimen.tsx'), 'SpecimenPage');

const root = createRootRoute({ component: Shell });
const parent = () => root;
/** An old path: redirects to its new home. */
const moved = (path: string, to: string, params?: (p: Record<string, string>) => Record<string, string>, search?: Record<string, string>) =>
  createRoute({
    getParentRoute: parent,
    path,
    beforeLoad: ({ params: p }) => {
      throw redirect({ to: to as never, params: (params ? params(p as Record<string, string>) : undefined) as never, search: search as never, replace: true });
    },
  });

const routeTree = root.addChildren([
  createRoute({ getParentRoute: parent, path: '/', component: HubPage }),
  createRoute({ getParentRoute: parent, path: '/devices', component: DevicesPage }),
  createRoute({ getParentRoute: parent, path: '/devices/$id', component: DevicePage }),
  createRoute({ getParentRoute: parent, path: '/provision', component: ProvisionPage }),
  createRoute({ getParentRoute: parent, path: '/provision/$job', component: ProvisionPage }),
  createRoute({ getParentRoute: parent, path: '/live', component: LivePage }),
  createRoute({ getParentRoute: parent, path: '/bench', component: BenchPage }),
  createRoute({ getParentRoute: parent, path: '/settings', component: SettingsPage }),
  // the builds live on Provision (firmware); before the general /settings/$section, which would take the path
  moved('/settings/builds', '/provision', undefined, { view: 'firmware' }),
  createRoute({ getParentRoute: parent, path: '/settings/$section', component: SettingsPage }),
  createRoute({ getParentRoute: parent, path: '/ui', component: SpecimenPage }),
  moved('/device/$alias', '/devices/$id', (p) => ({ id: p.alias ?? '' })),
  moved('/ports', '/settings/$section', () => ({ section: 'ports' })),
  moved('/builds', '/provision', undefined, { view: 'firmware' }),
  moved('/network', '/settings/$section', () => ({ section: 'networks' })),
  moved('/agents', '/settings/$section', () => ({ section: 'agents' })),
]);

export const router = createRouter({ routeTree, history: createHashHistory(), defaultPreload: false });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
