// The frame every device sub-page shares (DEVICE-SPEC §1.2): device_get (10 s, shared through the query cache, so
// moving between sub-pages asks nothing new), the header (alias, presence, hardware, firmware, Identify, Rename, the
// stale line), the back link and the device sub-nav INSTRUMENTS · ACTIVITY · FACTS · ENGINEERING. Builder PAGE owns it.
//
// Identify is the page's one lumen action, except on an instrument page (and on the Overview of a device with one
// instrument, which draws that instrument's page inline): there the panel owns it. Rename replaces the URL with the
// same sub-page under the new alias.

import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';

import { OpError } from '../../api/rest.ts';
import type { DeviceDetail } from '../../api/types.ts';
import { useOp } from '../../hooks.ts';
import { usePresence } from '../../shell/link.ts';
import { hardwareLine, shortId } from '../../state/device-link.ts';
import { presenceWord } from '../../state/words.ts';
import { Bead, Button, Caps, EmptyState, engrave, ErrorLine, Page, Pending, presenceBead, SubNav } from '../../ui/index.ts';
import { IdentifyButton, RenameForm, useFlash } from './bits.tsx';
import { LUMEN_PANELS } from './panels.ts';
import { useInstrumentRows } from './use-instruments.ts';
import '../device.css';
import '../devices.css';

export type DeviceSection = 'instruments' | 'activity' | 'facts' | 'engineering';

/** The route words a device's instance may not take (they are its sub-pages); test: no profile instance uses one. */
export const RESERVED_SEGMENTS: readonly string[] = ['activity', 'facts', 'engineering'];

export interface DeviceFrameProps {
  section: DeviceSection;
  /**
   * True on an instrument page: when its panel has the page's one lumen action (panels.ts LUMEN_PANELS), Identify is
   * not primary. 'single' on the Overview: the same, when the device has exactly one instrument (R9: its page is drawn
   * inline).
   */
  lens?: boolean | 'single';
  children: (detail: DeviceDetail, fetchedAt: number) => ReactNode;
}

const ROUTES: Record<DeviceSection, string> = {
  instruments: '/devices/$id',
  activity: '/devices/$id/activity',
  facts: '/devices/$id/facts',
  engineering: '/devices/$id/engineering',
};

function BackLink({ alias, instance }: { alias: string; instance: string | undefined }) {
  if (instance) {
    return (
      <Link to="/devices/$id" params={{ id: alias }} search={{ from: instance } as never} className="dev-back caps" data-back="instruments">
        {engrave(`← ${alias} · instruments`)}
      </Link>
    );
  }
  return (
    <Link to="/devices" className="dev-back caps" data-back="devices">
      {engrave('← all devices')}
    </Link>
  );
}

export function DeviceFrame({ section, lens = false, children }: DeviceFrameProps) {
  const { id = '', instance } = useParams({ strict: false }) as { id?: string; instance?: string };
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const q = useOp('device_get', { device: id }, { refetchInterval: 10_000 });
  const d = q.data;
  const flashing = useFlash(d?.device_id ?? '');
  const [renaming, setRenaming] = useState(false);
  const said = usePresence();
  const { instruments } = useInstrumentRows(d);
  const shown = lens === 'single' ? (instruments.length === 1 ? instruments[0] : undefined) : lens ? instruments.find((r) => r.inst.name === instance) : undefined;
  const onLens = !!shown && LUMEN_PANELS.has(shown.inst.cap);
  const onInstrument = section === 'instruments' && !!instance;

  if (!d) {
    const notFound = q.error instanceof OpError && q.error.code === 'NOT_FOUND';
    return (
      <Page title={id} sub={q.error ? (notFound ? 'not in the registry' : 'the hub does not answer') : 'reading'}>
        <div className="dev-page" data-device-section={section}>
          <BackLink alias={id} instance={undefined} />
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
        </div>
      </Page>
    );
  }

  const hw = hardwareLine(d);
  const fw = shortId(d.fw_id ?? d.router?.fw_id_prefix);
  const presence = said(d.presence);
  const nav = (['instruments', 'activity', 'facts', 'engineering'] as const).map((s) => ({ to: ROUTES[s], params: { id: d.alias }, label: s, current: section === s }));
  const renamed = (alias: string) => {
    const to = onInstrument ? '/devices/$id/$instance' : ROUTES[section];
    void navigate({ to: to as never, params: (onInstrument ? { id: alias, instance } : { id: alias }) as never, search: search as never, replace: true });
  };
  return (
    <Page
      title={d.alias}
      documentTitle={onInstrument ? `${d.alias} · ${instance}` : undefined}
      sub={
        <span className="dev-sub" data-flash={flashing ? '' : undefined}>
          <Bead state={presenceBead(presence)} label={presenceWord(presence)} showLabel />
          {hw ? <span>{engrave(hw)}</span> : null}
          {fw ? (
            <span className="dev-sub-fw">
              {engrave('firmware ')}
              <span className="mono">{fw}</span>
            </span>
          ) : null}
        </span>
      }
      actions={
        renaming ? null : (
          <>
            <IdentifyButton device={d} variant={onLens ? 'default' : 'primary'} />
            <Button onClick={() => setRenaming(true)} data-action="rename" data-opens={`rename:${d.device_id}`}>
              Rename
            </Button>
          </>
        )
      }
    >
      <div data-device-page={d.alias} data-device-section={section} className="dev-page">
        <BackLink alias={d.alias} instance={onInstrument ? instance : undefined} />
        {renaming ? <RenameForm device={d} onDone={() => setRenaming(false)} onRenamed={renamed} /> : null}
        {q.error instanceof OpError && q.error.code === 'HUB_UNREACHABLE' ? (
          <p className="dev-stale" role="status">
            <Bead state="offline" label="stale" /> <Caps>as the hub last said: it does not answer now</Caps>
          </p>
        ) : q.error ? (
          <ErrorLine error={q.error} what={d.alias} fix={{ label: 'Try again', onClick: () => void q.refetch(), busy: q.isFetching }} />
        ) : null}
        <SubNav label={`${d.alias} sections`} items={nav} />
        {children(d, q.dataUpdatedAt)}
      </div>
    </Page>
  );
}
