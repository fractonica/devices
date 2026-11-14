// A device's instances joined to the catalog, shared by the frame, the Overview, the instrument pages and Engineering
// (page-lens.tsx re-exports useInstruments and NOT_INSTRUMENTS, the seam). capability_list is one query in the cache,
// so every sub-page reads the same answer.

import { CATALOG, type CatalogCapability } from '@fractonica/protocol/gen';

import type { DeviceDetail } from '../../api/types.ts';
import { useOp } from '../../hooks.ts';
import { type InstanceView, joinCatalog } from '../../state/caps.ts';

/** The capability-node instances that are the node's own, never instruments. */
export const NOT_INSTRUMENTS: readonly string[] = ['fr.node', 'fr.ota', 'fr.diag'];

export interface InstrumentRows {
  /** Every instance, the node's own included, in the hub's order. */
  instances: InstanceView[];
  /** Every instance with its catalog entry, in port order. */
  rows: { inst: InstanceView; cap: CatalogCapability | undefined }[];
  /** The rows that are instruments (not fr.node, fr.ota, fr.diag). */
  instruments: { inst: InstanceView; cap: CatalogCapability | undefined }[];
  /** capability_list has not answered and the router names no instance. */
  pending: boolean;
  error: unknown;
}

/** The device's instances (capability_list's, else the router's) joined to the catalog; works before device_get answers. */
export function useInstrumentRows(detail: DeviceDetail | undefined): InstrumentRows {
  const q = useOp('capability_list', { device: `id:${detail?.device_id ?? ''}` }, { enabled: !!detail });
  const listed = q.data?.device?.instances;
  const instances: InstanceView[] = listed?.length
    ? listed
    : (detail?.router?.instances?.map((i) => ({ name: i.name, port: i.port, cap: i.cap, cap_id: i.cap_id, v: '', traits: null })) ?? []);
  const caps = (q.data?.caps as unknown as CatalogCapability[] | undefined) ?? CATALOG.capabilities;
  const rows = joinCatalog(instances, caps);
  return {
    instances,
    rows,
    instruments: rows.filter((r) => !NOT_INSTRUMENTS.includes(r.inst.cap)),
    pending: q.isPending && !!detail && !detail.router?.instances?.length,
    error: q.error,
  };
}
