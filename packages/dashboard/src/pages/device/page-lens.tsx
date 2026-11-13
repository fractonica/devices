// /devices/$id/$instance (DEVICE-SPEC §1.4): one instrument's page. The frame, the instrument strip (its siblings),
// a caption line, then the registry's panel (panels.ts). Builder PAGE owns it. SEAM: panelProps is how every
// CapPanelProps is built (the Overview's rungs use it too); the strip and the caption are PAGE's to add.

import { useParams } from '@tanstack/react-router';

import { CATALOG, type CatalogCapability } from '@fractonica/protocol/gen';

import type { DeviceDetail } from '../../api/types.ts';
import { useLive, useOp } from '../../hooks.ts';
import { type InstanceView, joinCatalog, visibleMembers } from '../../state/caps.ts';
import { EmptyState } from '../../ui/index.ts';
import { DeviceFrame } from './frame.tsx';
import { type CapPanelProps, panelFor } from './panels.ts';

/** The capability-node instances that are the node's own, never instruments. */
export const NOT_INSTRUMENTS: readonly string[] = ['fr.node', 'fr.ota', 'fr.diag'];

/** The device's instances (capability_list's, else the router's) joined to the catalog, in port order. */
export function useInstruments(detail: DeviceDetail): { instances: InstanceView[]; rows: { inst: InstanceView; cap: CatalogCapability | undefined }[] } {
  const q = useOp('capability_list', { device: `id:${detail.device_id}` });
  const listed = q.data?.device?.instances;
  const instances: InstanceView[] = listed?.length
    ? listed
    : (detail.router?.instances?.map((i) => ({ name: i.name, port: i.port, cap: i.cap, cap_id: i.cap_id, v: '', traits: null })) ?? []);
  const caps = (q.data?.caps as unknown as CatalogCapability[] | undefined) ?? CATALOG.capabilities;
  return { instances, rows: joinCatalog(instances, caps) };
}

/** A live property mirror and the visible members of one instance: the props every panel component gets. */
export function usePanelProps(detail: DeviceDetail, inst: InstanceView, cap: CatalogCapability, instances: readonly InstanceView[]): CapPanelProps {
  const live = useLive((s) => s.properties[detail.device_id]);
  const routerProps = (detail.router?.properties ?? {}) as Record<string, unknown>;
  const members = visibleMembers(cap, inst.traits, detail.router?.hello_caps ?? null);
  const mirror: Record<string, unknown> = {};
  for (const p of members.properties) {
    const key = `${inst.name}.${p.name}`;
    mirror[p.name] = live?.[key]?.value ?? routerProps[key];
  }
  return { detail, inst, cap, members, mirror, instances };
}

function LensBody({ detail, inst, cap, instances }: { detail: DeviceDetail; inst: InstanceView; cap: CatalogCapability; instances: readonly InstanceView[] }) {
  const props = usePanelProps(detail, inst, cap, instances);
  const { Lens } = panelFor(cap.name);
  return (
    <div data-lens={inst.name}>
      <Lens {...props} />
    </div>
  );
}

function Lens({ detail, name }: { detail: DeviceDetail; name: string }) {
  const { instances, rows } = useInstruments(detail);
  const row = rows.find((r) => r.inst.name === name && !NOT_INSTRUMENTS.includes(r.inst.cap));
  if (!row) {
    return <EmptyState title={`No instrument called ${name} on ${detail.alias}`}>Its instruments are on its Instruments page.</EmptyState>;
  }
  if (!row.cap) {
    return <p className="ash">This dashboard’s catalog does not know {row.inst.cap}; rebuild it (fr doctor --fix).</p>;
  }
  return <LensBody detail={detail} inst={row.inst} cap={row.cap} instances={instances} />;
}

export function DeviceLensPage() {
  const { instance = '' } = useParams({ strict: false }) as { instance?: string };
  return (
    <DeviceFrame section="instruments" lens>
      {(d) => <Lens detail={d} name={instance} />}
    </DeviceFrame>
  );
}
