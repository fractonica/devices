// /devices/$id/facts (DEVICE-SPEC §1.6): the device's data column, whole (link, time, running, build, registry, tags),
// as it was beside the old single page. Builder PAGE owns it.

import { DataColumn } from './data-column.tsx';
import { DeviceFrame } from './frame.tsx';

export function DeviceFactsPage() {
  return (
    <DeviceFrame section="facts">
      {(d, at) => (
        <div className="dev-facts" aria-label={`${d.alias} facts`}>
          <DataColumn detail={d} fetchedAt={at} />
        </div>
      )}
    </DeviceFrame>
  );
}
