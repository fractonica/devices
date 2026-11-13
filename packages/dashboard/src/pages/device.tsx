// DEVICE, route `/devices/$id` (an alias or a device id; HARDWARE-REVIEW §4 "Screens" 3), laid out like the site's
// LENS: the name engraved with its presence and hardware, Identify (the page's one lumen action) and Rename; on the
// left the device's instruments, its capabilities as rows of typed controls generated from the catalog (sparklines in
// lumen, no JSON), then its recent events and its log on demand; on the right the data column (link, time, running,
// build, registry). An "Engineering" fold at the end holds diagnostics, bindings, OTA history and the raw JSON. A
// device with a face (stage 5) gets its mirror first (device/face.tsx is the seam). At phone width the data column
// comes first and everything stacks.
//
// device_get is refetched every 10 s and on its events (runtime.ts); properties update live from the store.

import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';

import { OpError } from '../api/rest.ts';
import { useOp } from '../hooks.ts';
import type { InstanceView } from '../state/caps.ts';
import { hardwareLine, shortId } from '../state/device-link.ts';
import { presenceWord } from '../state/words.ts';
import { Bead, Button, Caps, EmptyState, engrave, ErrorLine, Page, Pending, presenceBead } from '../ui/index.ts';
import { IdentifyButton, RenameForm, useFlash } from './device/bits.tsx';
import { Capabilities } from './device/capabilities.tsx';
import { DataColumn } from './device/data-column.tsx';
import { Engineering } from './device/engineering.tsx';
import { RecentEvents } from './device/events.tsx';
import { FaceMirror } from './device/face.tsx';
import { DeviceLog } from './device/logs.tsx';
import './device.css';
import './devices.css';


function BackLink() {
  return (
    <Link to="/devices" className="dev-back caps">
      {engrave('← all devices')}
    </Link>
  );
}

export function DevicePage() {
  const { id } = useParams({ from: '/devices/$id' });
  const navigate = useNavigate();
  const q = useOp('device_get', { device: id }, { refetchInterval: 10_000 });
  const d = q.data;
  const flashing = useFlash(d?.device_id ?? '');
  const [renaming, setRenaming] = useState(false);

  if (!d) {
    const notFound = q.error instanceof OpError && q.error.code === 'NOT_FOUND';
    return (
      <Page title={id} sub={q.error ? (notFound ? 'not in the registry' : 'the hub does not answer') : 'reading'}>
        <BackLink />
        {notFound ? (
          <EmptyState
            title={`No device called ${id}`}
            action={
              <Link to="/devices" className="ui-button" data-variant="primary">
                <span className="ui-button-text">{engrave('All devices')}</span>
              </Link>
            }
          >
            It may have been renamed or forgotten. The devices this hub knows are on the Devices page.
          </EmptyState>
        ) : q.error ? (
          <ErrorLine error={q.error} what={id} fix={{ label: 'Try again', onClick: () => void q.refetch(), busy: q.isFetching }} />
        ) : (
          <Pending what={id} />
        )}
      </Page>
    );
  }

  const instances: InstanceView[] = (d.router?.instances ?? []).map((i) => ({ name: i.name, port: i.port, cap: i.cap, cap_id: i.cap_id, v: '', traits: null }));
  const hw = hardwareLine(d);
  const fw = shortId(d.fw_id ?? d.router?.fw_id_prefix);
  return (
    <Page
      title={d.alias}
      sub={
        <span className="dev-sub" data-flash={flashing ? '' : undefined}>
          <Bead state={presenceBead(d.presence)} label={presenceWord(d.presence)} showLabel />
          {hw ? <span>{engrave(hw)}</span> : null}
          {fw ? <span className="dev-sub-fw">{engrave('firmware ')}<span className="mono">{fw}</span></span> : null}
        </span>
      }
      actions={
        renaming ? null : (
          <>
            <IdentifyButton device={d} variant="primary" />
            <Button onClick={() => setRenaming(true)} data-action="rename">
              Rename
            </Button>
          </>
        )
      }
    >
      <div data-device-page={d.alias} className="dev-page">
        <BackLink />
        {renaming ? (
          <RenameForm device={d} onDone={() => setRenaming(false)} onRenamed={(a) => void navigate({ to: '/devices/$id', params: { id: a }, replace: true })} />
        ) : null}
        {q.error instanceof OpError && q.error.code === 'HUB_UNREACHABLE' ? (
          <p className="dev-stale" role="status">
            <Bead state="offline" label="stale" /> <Caps>as the hub last said: it does not answer now</Caps>
          </p>
        ) : q.error ? (
          <ErrorLine error={q.error} what={d.alias} fix={{ label: 'Try again', onClick: () => void q.refetch(), busy: q.isFetching }} />
        ) : null}
        <div className="dev-grid">
          <div className="dev-main">
            <FaceMirror instances={instances} deviceId={d.device_id} />
            <Capabilities detail={d} />
            <RecentEvents deviceId={d.device_id} />
            <DeviceLog deviceId={d.device_id} alias={d.alias} usb={!!d.port} />
          </div>
          <aside className="dev-side" aria-label={`${d.alias} facts`}>
            <DataColumn detail={d} fetchedAt={q.dataUpdatedAt} />
          </aside>
        </div>
        <Engineering detail={d} />
      </div>
    </Page>
  );
}
