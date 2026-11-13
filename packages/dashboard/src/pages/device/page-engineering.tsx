// /devices/$id/engineering (DEVICE-SPEC §1.7): diagnostics, bindings, updates, Commands (the expert console, every
// raw device command; ?instrument= opens one) and the raw JSON. Builder PAGE owns it. SEAM STUB: today's fold.

import { Engineering } from './engineering.tsx';
import { DeviceFrame } from './frame.tsx';

export function DeviceEngineeringPage() {
  return <DeviceFrame section="engineering">{(d) => <Engineering detail={d} />}</DeviceFrame>;
}
