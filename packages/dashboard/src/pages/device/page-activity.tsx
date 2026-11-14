// /devices/$id/activity (DEVICE-SPEC §1.5): the device's last 50 events, all or one instrument's (engraved filter
// words ALL · STATUS · FLASH · CAM; ?instrument= chooses one), and its log (?log=1 opens it). Builder PAGE owns it.

import { useNavigate, useSearch } from '@tanstack/react-router';

import { Chip, ChipRow } from '../../ui/index.ts';
import { RecentEvents } from './events.tsx';
import { DeviceFrame } from './frame.tsx';
import { DeviceLog } from './logs.tsx';
import { useInstrumentRows } from './use-instruments.ts';
import type { DeviceDetail } from '../../api/types.ts';

function Activity({ detail }: { detail: DeviceDetail }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const { instruments } = useInstrumentRows(detail);
  const asked = typeof search.instrument === 'string' ? search.instrument : null;
  const instrument = asked && instruments.some((r) => r.inst.name === asked) ? asked : asked && !instruments.length ? asked : null;
  const choose = (name: string | null) =>
    void navigate({ to: '/devices/$id/activity', params: { id: detail.alias }, search: { ...search, instrument: name ?? undefined } as never, replace: true });
  const filter =
    instruments.length > 1 ? (
      <div className="dev-filter">
        <ChipRow label="Show the events of">
          <Chip pressed={instrument === null} onToggle={() => choose(null)}>
            all
          </Chip>
          {instruments.map((r) => (
            <Chip key={r.inst.name} pressed={instrument === r.inst.name} onToggle={() => choose(instrument === r.inst.name ? null : r.inst.name)}>
              {r.inst.name}
            </Chip>
          ))}
        </ChipRow>
      </div>
    ) : undefined;
  return (
    <div className="dev-activity">
      <RecentEvents deviceId={detail.device_id} instrument={instrument} filter={filter} />
      <DeviceLog deviceId={detail.device_id} alias={detail.alias} usb={!!detail.port} openAtFirst={search.log !== undefined} />
    </div>
  );
}

export function DeviceActivityPage() {
  return <DeviceFrame section="activity">{(d) => <Activity detail={d} />}</DeviceFrame>;
}
