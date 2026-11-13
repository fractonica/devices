// SETTINGS, routes `/settings` and `/settings/$section` (HARDWARE-REVIEW §4 "Screens" 4, 5 and 8; design README "Hub"):
// the hub's own state in sections, each a file under pages/settings/:
//
//   health     hub_doctor's checks with their fixes, the hub's warnings, the hub itself        settings/health.tsx
//   networks   the Wi-Fi networks (list, add, change; passwords never shown), the LAN, latency settings/networks.tsx
//   ports      every USB serial port with its state and Lend / Ignore / Claim and their undo  settings/ports.tsx
//   agents     prompts waiting for a person, serial leases, jobs agents started               settings/agents.tsx
//   storage    hub.db's size and free space, pruning, compacting                               settings/storage.tsx
//   about      versions: hub, op registry, catalog, temporal core and SPEC, the vendored locks  settings/about.tsx
//
// An unknown section shows Health. The old routes (/ports, /network, /agents) redirect here (app.tsx); the builds are
// Provision › Firmware.

import './settings.css';

import { useParams } from '@tanstack/react-router';
import { useEffect } from 'react';

import { Page, SubNav } from '../ui/index.ts';
import { AboutSection } from './settings/about.tsx';
import { AgentsSection } from './settings/agents.tsx';
import { HealthSection } from './settings/health.tsx';
import { NetworksSection } from './settings/networks.tsx';
import { PortsSection } from './settings/ports.tsx';
import { StorageSection } from './settings/storage.tsx';

export const SETTINGS_SECTIONS = ['health', 'networks', 'ports', 'agents', 'storage', 'about'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const SUB: Record<SettingsSection, string> = {
  health: 'checks, fixes and warnings',
  networks: 'Wi-Fi for the nodes, the LAN, latency',
  ports: 'USB serial ports and who holds them',
  agents: 'what agents are doing on the bench',
  storage: 'the hub’s database',
  about: 'versions and what this build is pinned to',
};

export function settingsSection(section: string | undefined): SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(section ?? '') ? (section as SettingsSection) : 'health';
}

export function SettingsPage() {
  const { section } = useParams({ strict: false }) as { section?: string };
  const current = settingsSection(section);
  // the section words scroll sideways at phone width: keep the current one in view
  useEffect(() => {
    document.querySelector('.ui-subnav [aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [current]);
  return (
    <Page title="Settings" sub={SUB[current]}>
      <SubNav label="Settings" items={SETTINGS_SECTIONS.map((id) => ({ to: '/settings/$section', params: { section: id }, label: id, current: id === current }))} />
      <div className="set-body" data-section={current}>
        {current === 'health' ? <HealthSection /> : null}
        {current === 'networks' ? <NetworksSection /> : null}
        {current === 'ports' ? <PortsSection /> : null}
        {current === 'agents' ? <AgentsSection /> : null}
        {current === 'storage' ? <StorageSection /> : null}
        {current === 'about' ? <AboutSection /> : null}
      </div>
    </Page>
  );
}
