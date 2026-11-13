// The frame every device sub-page shares (DEVICE-SPEC §1.2): device_get (10 s, shared through the query cache, so
// moving between sub-pages asks nothing new), the header (alias, presence, hardware, Identify, Rename, the stale
// line), the back link and the device sub-nav INSTRUMENTS · ACTIVITY · FACTS · ENGINEERING. Builder PAGE owns it.
// SEAM STUB: a plain header and the sub-nav; PAGE moves today's header from pages/device.tsx here.

import { Link, useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import type { DeviceDetail } from '../../api/types.ts';
import { useOp } from '../../hooks.ts';
import { engrave, ErrorLine, Page, Pending, SubNav } from '../../ui/index.ts';
import '../device.css';

export type DeviceSection = 'instruments' | 'activity' | 'facts' | 'engineering';

/** The route words a device's instance may not take (they are its sub-pages); test: no profile instance uses one. */
export const RESERVED_SEGMENTS: readonly string[] = ['activity', 'facts', 'engineering'];

export interface DeviceFrameProps {
  section: DeviceSection;
  /** True on an instrument page: the panel owns the page's one lumen action, so Identify is not primary. */
  lens?: boolean;
  children: (detail: DeviceDetail, fetchedAt: number) => ReactNode;
}

export function DeviceFrame({ section, children }: DeviceFrameProps) {
  const { id = '' } = useParams({ strict: false }) as { id?: string };
  const q = useOp('device_get', { device: id }, { refetchInterval: 10_000 });
  const d = q.data;
  const nav = [
    { to: '/devices/$id', label: 'instruments', current: section === 'instruments' },
    { to: '/devices/$id/activity', label: 'activity', current: section === 'activity' },
    { to: '/devices/$id/facts', label: 'facts', current: section === 'facts' },
    { to: '/devices/$id/engineering', label: 'engineering', current: section === 'engineering' },
  ].map((i) => ({ ...i, params: { id: d?.alias ?? id } }));
  return (
    <Page title={d?.alias ?? id}>
      <Link to="/devices" className="dev-back caps">
        {engrave('← all devices')}
      </Link>
      <SubNav label={`${d?.alias ?? id} sections`} items={nav} />
      {d ? (
        <div data-device-page={d.alias} data-device-section={section} className="dev-page">
          {children(d, q.dataUpdatedAt)}
        </div>
      ) : q.error ? (
        <ErrorLine error={q.error} what={id} />
      ) : (
        <Pending what={id} />
      )}
    </Page>
  );
}
