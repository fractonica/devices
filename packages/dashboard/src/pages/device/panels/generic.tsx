// The generic capability panel (DEVICE-SPEC §2.2–§2.3): an instrument drawn from the catalog. Builder PAGE owns this
// file. SEAM STUB: the Lens is today's InstanceBlock until PAGE rewrites it under rules G1–G9 (human words, enums by
// name, no examples as values, no hub-issued forms, verb buttons with a "does" line, optional fields folded, spans).

import { InstanceBlock } from '../capabilities.tsx';
import type { CapPanel, CapPanelProps } from '../panels.ts';

function GenericLens({ detail, inst, cap, instances }: CapPanelProps) {
  return <InstanceBlock detail={detail} inst={inst} cap={cap} instances={instances} />;
}

/** The rung's reading: the first property with a value (stub; PAGE words it through state/cap-words.ts). */
function GenericHeadline({ cap, mirror }: CapPanelProps) {
  const first = cap.properties.find((p) => mirror[p.name] !== undefined && mirror[p.name] !== null);
  return first ? <span>{String(mirror[first.name])}</span> : <span className="ash">—</span>;
}

export const GENERIC_PANEL: CapPanel = { Lens: GenericLens, Headline: GenericHeadline };
