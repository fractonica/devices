// /devices/$id/engineering (DEVICE-SPEC §1.7): what an engineer reads and a first-time user never needs, each a fold
// that asks the hub only once it is opened: diagnostics, bindings, updates over the air, Commands (the expert console:
// every raw device command, commands.tsx; ?instrument= opens that instrument's and scrolls to it) and the raw JSON.
// Builder PAGE owns it.

import { useSearch } from '@tanstack/react-router';

import type { DeviceDetail } from '../../api/types.ts';
import { Caps, Disclosure } from '../../ui/index.ts';
import { EngineeringCommands } from './commands.tsx';
import { Bindings, Diagnostics, OtaHistory, RawJson } from './engineering.tsx';
import { DeviceFrame } from './frame.tsx';

function Engineering({ detail }: { detail: DeviceDetail }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const instrument = typeof search.instrument === 'string' ? search.instrument : null;
  const reachable = !!detail.port || detail.presence === 'online' || detail.presence === 'suspect';
  return (
    <div className="dev-engineering-body">
      <Disclosure title="Diagnostics" aside={<Caps>the node’s own counters</Caps>}>
        <Diagnostics deviceId={detail.device_id} reachable={reachable} />
      </Disclosure>
      <Disclosure title="Bindings" aside={<Caps>node to node</Caps>}>
        <Bindings deviceId={detail.device_id} alias={detail.alias} />
      </Disclosure>
      <Disclosure title="Updates over the air">
        <OtaHistory deviceId={detail.device_id} />
      </Disclosure>
      <EngineeringCommands detail={detail} open={instrument} />
      <Disclosure title="Raw" aside={<Caps>device_get</Caps>}>
        <RawJson value={detail} id="device_get" />
      </Disclosure>
    </div>
  );
}

export function DeviceEngineeringPage() {
  return <DeviceFrame section="engineering">{(d) => <Engineering detail={d} />}</DeviceFrame>;
}
