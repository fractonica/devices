// DEVICES, route `/devices` (HARDWARE-REVIEW §4 "Screens" 3): the fleet as rows on hairlines, online first. Each row:
// the presence bead, the alias, the profile and board, the signal, the firmware and the last event as a Fractonica
// time (relative, redrawn when its text changes), and Identify. The whole row opens the device. A row's hairline
// lights for 600 ms on an input from that device. At phone width a row stacks into two lines; there is no table.
//
// device_list is the page's only query (design m2-c2 D16): each row carries its link (`live`), so 30 devices cost
// one device_list, not 30 device_gets; live events invalidate it (runtime.ts), and it is refetched every 10 s for
// presence changes a quiet device makes.

import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import type { DeviceView } from '@fractonica/protocol/client';

import { OpError } from '../api/rest.ts';
import { useLive, useOp } from '../hooks.ts';
import { eventWords, presenceWord } from '../state/words.ts';
import { byPresenceThenAlias, filterDevices, fleetCountOf, hardwareLine, liveOf, shortId } from '../state/device-link.ts';
import { Bead, Caps, EmptyState, engrave, ErrorLine, FTime, Page, Pending, presenceBead, Section, TextField } from '../ui/index.ts';
import { IdentifyButton, Signal, useFlash } from './device/bits.tsx';
import './devices.css';

/** A filter field appears from this many devices. */
const FILTER_FROM = 9;


function LastEvent({ deviceId }: { deviceId: string }) {
  const last = useLive((s) => s.lastByDevice[deviceId]);
  if (!last) {
    return <span className="ash">—</span>;
  }
  return (
    <span className="devs-last">
      <span className="devs-last-type">{eventWords(last)}</span>
      <FTime at={last.t_hub_us} form="relative" />
    </span>
  );
}

function DeviceRow({ device }: { device: DeviceView }) {
  const flashing = useFlash(device.device_id);
  const live = liveOf(device);
  const fw = shortId(device.fw_id ?? live?.fw_id_prefix);
  const hw = hardwareLine(device);
  return (
    <li className="devs-row" data-device={device.alias} data-device-id={device.device_id} data-presence={device.presence} data-flash={flashing ? '' : undefined}>
      <span className="devs-bead">
        <Bead state={presenceBead(device.presence)} label={presenceWord(device.presence)} />
      </span>
      <span className="devs-name">
        <Link to="/devices/$id" params={{ id: device.alias }} className="devs-link" title={device.alias}>
          {device.alias}
        </Link>
        <span className="devs-hw">
          {hw || <span className="ash">profile not known</span>}
          {!device.provisioned ? <Caps tone="bone">{' · seen only'}</Caps> : null}
        </span>
      </span>
      <span className="devs-signal" aria-label="signal">
        {device.presence === 'online' || device.presence === 'suspect' ? <Signal rssi={live?.rssi_ap} /> : <span className="ash">{presenceWord(device.presence)}</span>}
      </span>
      <span className="devs-fw mono" title={device.fw_id ?? undefined}>
        {fw || <span className="ash">—</span>}
      </span>
      <span className="devs-event">
        <LastEvent deviceId={device.device_id} />
      </span>
      <span className="devs-actions">
        {device.presence === 'online' || device.presence === 'suspect' ? <IdentifyButton device={device} variant="quiet" /> : null}
      </span>
    </li>
  );
}

function Head() {
  return (
    <div className="devs-head" aria-hidden="true">
      <span />
      <Caps>Device</Caps>
      <Caps>Signal</Caps>
      <Caps>Firmware</Caps>
      <Caps>Last event</Caps>
      <span />
    </div>
  );
}

/** The page's one primary action, a link drawn as a lumen button. */
function ProvisionLink() {
  return (
    <Link to="/provision" className="ui-button" data-variant="primary" data-action="provision">
      <span className="ui-button-text">{engrave('Provision a board')}</span>
    </Link>
  );
}

export function DevicesPage() {
  const q = useOp('device_list', {}, { refetchInterval: 10_000 });
  const [query, setQuery] = useState('');
  const all = (q.data?.devices ?? []).slice().sort(byPresenceThenAlias);
  const shown = filterDevices(all, query);
  const unreachable = q.error instanceof OpError && q.error.code === 'HUB_UNREACHABLE';
  return (
    <Page
      title="Devices"
      sub={q.data ? (all.length ? fleetCountOf(all, query ? shown.length : undefined) : 'none yet') : q.error ? (unreachable ? 'the hub does not answer' : 'the list could not be read') : 'reading'}
      actions={q.data && !all.length ? undefined : <ProvisionLink />}
    >
      {q.error && !(unreachable && q.data) ? (
        <ErrorLine error={q.error} what={unreachable ? undefined : 'The device list'} fix={{ label: 'Try again', onClick: () => void q.refetch(), busy: q.isFetching }} />
      ) : null}
      {!q.data && !q.error ? <Pending what="the registry" /> : null}
      {q.data && !all.length ? (
        <EmptyState
          title="No devices yet"
          action={<ProvisionLink />}
        >
          Plug a board in with a USB cable and provision it: it joins your network, says hello to this hub, and shows up
          here.
        </EmptyState>
      ) : null}
      {all.length ? (
        <Section
          title="Fleet"
          aside={unreachable ? <Caps>as the hub last said</Caps> : q.data?.truncated ? <Caps>{`first ${all.length} of ${q.data.count}`}</Caps> : undefined}
        >
          {all.length >= FILTER_FROM ? (
            <div className="devs-filter">
              <TextField label="Find" value={query} onChange={setQuery} placeholder="alias, profile, tag" type="search" />
            </div>
          ) : null}
          <Head />
          <ul className="devs-list" data-count={all.length} data-stale={unreachable ? '' : undefined}>
            {shown.map((d) => (
              <DeviceRow key={d.device_id} device={d} />
            ))}
          </ul>
          {query && !shown.length ? <p className="devs-none ash">No device matches “{query}”.</p> : null}
        </Section>
      ) : null}
    </Page>
  );
}
