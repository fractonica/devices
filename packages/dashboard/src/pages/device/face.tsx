// SEAM for the face mirror (HARDWARE-REVIEW §4 "Screens" 3; stage 5): a device with an `fr.face` capability will show
// its face here, rendered by the dashboard through the core from the device's reported state (a PSRAM-less board
// cannot return a snapshot), with its mode and screen controls. The capability does not exist yet (it arrives with
// the clock firmware in stage 5), so this renders nothing unless an instance of it is present; then it says the
// mirror is coming. The stage 5 builder replaces FaceMirror's body and keeps its place at the top of the device page.

import type { InstanceView } from '../../state/caps.ts';
import { EmptyState, Section } from '../../ui/index.ts';

/** The capability name the face mirror answers to (design decision D4: `fr.face`). */
export const FACE_CAP = 'fr.face';

export function faceInstances(instances: readonly InstanceView[]): InstanceView[] {
  return instances.filter((i) => i.cap === FACE_CAP);
}

export function FaceMirror({ instances, deviceId }: { instances: readonly InstanceView[]; deviceId: string }) {
  const faces = faceInstances(instances);
  if (!faces.length) {
    return null;
  }
  return (
    <div className="dev-face" data-face={deviceId}>
      <Section title="Face" id="face">
        <EmptyState title="The face mirror is coming">This device has a face. Its mirror, drawn from the state it reports, arrives with the clock firmware.</EmptyState>
      </Section>
    </div>
  );
}
