// /devices/$id/facts (DEVICE-SPEC §1.6): today's data column, whole (link, time, running, build, registry, tags).
// Builder PAGE owns it. SEAM STUB.

import { DataColumn } from './data-column.tsx';
import { DeviceFrame } from './frame.tsx';

export function DeviceFactsPage() {
  return <DeviceFrame section="facts">{(d, at) => <DataColumn detail={d} fetchedAt={at} />}</DeviceFrame>;
}
