// SETTINGS, routes `/settings` and `/settings/$section` (health, networks, ports, builds, agents, about). STUB of the
// stage 4 foundation, for the Settings page builder (HARDWARE-REVIEW §4 "Screens" 4, 5, 8): hub_doctor checks with
// "run fix" buttons, networks, IDF and toolchain status, LAN and latency, ports (Watched / Lent / Ignored / Held, with
// Lend, Ignore and Claim), builds and artifacts with the stage ring, agents and leases, and About (core, SPEC,
// REGISTRY_HASH, catalog_hash). Until then the old Network, Ports, Builds and Agents pages are mounted in their
// sections, and Health and About show what hub_status says.

import { useParams } from '@tanstack/react-router';

import { useOp } from '../hooks.ts';
import { LegacyMount } from '../legacy/mount.tsx';
import { AgentsPage as LegacyAgents } from '../legacy/pages/agents.tsx';
import { BuildsPage as LegacyBuilds } from '../legacy/pages/builds.tsx';
import { NetworkPage as LegacyNetwork } from '../legacy/pages/network.tsx';
import { PortsPage as LegacyPorts } from '../legacy/pages/ports.tsx';
import { Bead, ErrorLine, FTime, Page, Row, Section, SubNav, useFractonica } from '../ui/index.ts';

export const SETTINGS_SECTIONS = ['health', 'networks', 'ports', 'builds', 'agents', 'about'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

function Health() {
  const status = useOp('hub_status', {});
  const s = status.data;
  if (status.error) {
    return <ErrorLine error={status.error} what="Hub status" />;
  }
  return (
    <Section title="Hub" aside={<Bead state={s ? (s.warnings.length ? 'waiting' : 'online') : 'idle'} />}>
      <Row label="Devices" value={s ? `${s.devices.online} of ${s.devices.registered} online` : '—'} />
      <Row label="Dashboard" value={s?.dashboard ? (s.dashboard.stale ? 'older than its source' : 'up to date') : '—'} />
      {s?.sleep_guard?.active ? <Row label="Sleep" value="the hub keeps this Mac awake while it works; closing the lid still sleeps it" /> : null}
      {(s?.warnings ?? []).map((w) => (
        <Row key={w} bead="waiting" label="Warning" value={w} />
      ))}
    </Section>
  );
}

function About() {
  const status = useOp('hub_status', {});
  const core = useFractonica();
  const s = status.data;
  const started = s ? Date.now() * 1000 - s.uptime_s * 1_000_000 : null;
  return (
    <Section title="About">
      <Row label="Hub" value={s ? `${s.version} · run ${s.run}` : '—'} />
      <Row label="Started" value={started ? <FTime at={started} form="relative" /> : '—'} />
      <Row label="Registry" value={<span className="mono">{s?.registry_hash ?? '—'}</span>} />
      <Row label="Temporal core" value={core ? `${core.frc.version} · SPEC ${core.frc.specVersion}` : '—'} />
    </Section>
  );
}

export function SettingsPage() {
  const { section } = useParams({ strict: false }) as { section?: string };
  const current: SettingsSection = (SETTINGS_SECTIONS as readonly string[]).includes(section ?? '') ? (section as SettingsSection) : 'health';
  return (
    <Page title="Settings">
      <SubNav label="Settings" items={SETTINGS_SECTIONS.map((id) => ({ to: '/settings/$section', params: { section: id }, label: id, current: id === current }))} />
      {current === 'health' ? <Health /> : null}
      {current === 'about' ? <About /> : null}
      {current === 'networks' ? (
        <LegacyMount>
          <LegacyNetwork />
        </LegacyMount>
      ) : null}
      {current === 'ports' ? (
        <LegacyMount>
          <LegacyPorts />
        </LegacyMount>
      ) : null}
      {current === 'builds' ? (
        <LegacyMount>
          <LegacyBuilds />
        </LegacyMount>
      ) : null}
      {current === 'agents' ? (
        <LegacyMount>
          <LegacyAgents />
        </LegacyMount>
      ) : null}
    </Page>
  );
}
