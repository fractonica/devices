// Dashboard entry (spec 08 §8.9; stage 4): applies the site's theme (the vendored tokens.js and the hub's `fault`),
// starts the live connection and the temporal core's load, then renders the routes in the shell.

import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { router } from './app.tsx';
import { applyHubTheme, setHubIcon } from './design/hub-tokens.ts';
import { queryClient, startLive } from './runtime.ts';
import { loadCore } from './time/core.ts';

import '@xterm/xterm/css/xterm.css';
import './styles/base.css';
import './ui/ui.css';

applyHubTheme(document.documentElement);
setHubIcon();
void loadCore().catch(() => {}); // a page that needs it says why it failed (useCoreError)
void startLive();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
