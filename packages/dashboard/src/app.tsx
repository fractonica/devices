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
//   /settings/$section     pages/settings.tsx   SettingsPage      (health networks ports builds agents about)
//   /ui                    pages/specimen.tsx   SpecimenPage      (every primitive; not on the rail)
//
// The old routes (/device/$alias, /ports, /builds, /network, /agents) redirect to their new homes, so a bookmark or a
// link the CLI printed still lands.

import { createHashHistory, createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';

import { BenchPage } from './pages/bench.tsx';
import { DevicePage } from './pages/device.tsx';
import { DevicesPage } from './pages/devices.tsx';
import { HubPage } from './pages/hub.tsx';
import { LivePage } from './pages/live.tsx';
import { ProvisionPage } from './pages/provision.tsx';
import { SettingsPage } from './pages/settings.tsx';
import { SpecimenPage } from './pages/specimen.tsx';
import { Shell } from './shell/shell.tsx';

const root = createRootRoute({ component: Shell });
const parent = () => root;
/** An old path: redirects to its new home. */
const moved = (path: string, to: string, params?: (p: Record<string, string>) => Record<string, string>) =>
  createRoute({
    getParentRoute: parent,
    path,
    beforeLoad: ({ params: p }) => {
      throw redirect({ to: to as never, params: (params ? params(p as Record<string, string>) : undefined) as never, replace: true });
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
  createRoute({ getParentRoute: parent, path: '/settings/$section', component: SettingsPage }),
  createRoute({ getParentRoute: parent, path: '/ui', component: SpecimenPage }),
  moved('/device/$alias', '/devices/$id', (p) => ({ id: p.alias ?? '' })),
  moved('/ports', '/settings/$section', () => ({ section: 'ports' })),
  moved('/builds', '/settings/$section', () => ({ section: 'builds' })),
  moved('/network', '/settings/$section', () => ({ section: 'networks' })),
  moved('/agents', '/settings/$section', () => ({ section: 'agents' })),
]);

export const router = createRouter({ routeTree, history: createHashHistory(), defaultPreload: false });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
