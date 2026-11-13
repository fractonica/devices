// /devices/$id/activity (DEVICE-SPEC §1.5): the device's events (filter ?instrument=) and its log (?log=1 opens it).
// Builder PAGE owns it. SEAM STUB: today's RecentEvents and DeviceLog in the frame.

import { useSearch } from '@tanstack/react-router';

import { DeviceLog } from './logs.tsx';
import { RecentEvents } from './events.tsx';
import { DeviceFrame } from './frame.tsx';

export function DeviceActivityPage() {
  const logAsked = (useSearch({ strict: false }) as Record<string, unknown>).log !== undefined;
  return (
    <DeviceFrame section="activity">
      {(d) => (
        <>
          <RecentEvents deviceId={d.device_id} />
          <DeviceLog deviceId={d.device_id} alias={d.alias} usb={!!d.port} openAtFirst={logAsked} />
        </>
      )}
    </DeviceFrame>
  );
}
