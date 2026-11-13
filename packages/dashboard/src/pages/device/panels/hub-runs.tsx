// A device command the hub runs (DEVICE-SPEC §2.4, rule G3): drawn in place of a form wherever a command has a
// hub-issued field (state/hub-issued.ts). Builder CAMERA owns this file; builder PAGE renders it from the generic
// panel (for a hub-issued command no purpose-built panel covers) and from Engineering › Commands (for every one).
// SEAM STUB: the words and the copyable `fr` line; CAMERA adds the camera's link and its running-stream STOP.

import type { CatalogCommand } from '@fractonica/protocol/gen';

import type { DeviceDetail } from '../../../api/types.ts';
import type { InstanceView } from '../../../state/caps.ts';
import { fieldWords } from '../../../state/device-units.ts';
import { hubWay } from '../../../state/hub-issued.ts';
import { Code, Row } from '../../../ui/index.ts';

export interface HubRunsProps {
  detail: DeviceDetail;
  inst: InstanceView;
  cmd: CatalogCommand;
}

export function HubRuns({ detail, inst, cmd }: HubRunsProps) {
  const way = hubWay(inst.cap);
  const cli = way?.cli(detail.alias, inst.name) ?? null;
  return (
    <Row
      label={fieldWords(cmd.name)}
      id={`${inst.name}.${cmd.name}`}
      value={<span className="ash">{`the hub runs this: ${way?.words ?? 'not from this page'}`}</span>}
      extra={cli ? <Code>{cli}</Code> : undefined}
    />
  );
}
