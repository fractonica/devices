// DEVICE, route `/devices/$id` (an alias or a device id): the device's Instruments, the first of its four sub-pages
// (DEVICE-SPEC §1.3; the others are Activity, Facts and Engineering, pages/device/page-*.tsx, all in one frame,
// pages/device/frame.tsx). One row per instrument, in port order: the port, the instance, the capability's word, its
// panel's headline and at most one quick control; the whole row opens the instrument's page. Many instances of one
// capability fold into one group row. Beside the rows, a glance (link, last word, clock, up for) with ALL FACTS ›, and
// Lately (the device's last three events) with ALL ACTIVITY ›. At phone width the glance comes first.
//
// A device with one instrument draws that instrument's page here, under the glance; with none, it says why.
// `?from=<instance>` (an instrument page's back link) scrolls to that row, focuses its link and lights its hairline.

import { Link, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';

import type { CatalogCapability } from '@fractonica/protocol/gen';

import type { DeviceDetail } from '../api/types.ts';
import { opMissing } from '../api/rest.ts';
import { useLive } from '../hooks.ts';
import { usePresence } from '../shell/link.ts';
import type { InstanceView } from '../state/caps.ts';
import { CLOCK_WORDS, type ClockInfo, clockState, heartbeatOf, lastInstanceEvent } from '../state/device-link.ts';
import { capWord, deviceEvents, groupInstruments } from '../state/instruments.ts';
import { eventWords, presenceWord } from '../state/words.ts';
import { EmptyState, engrave, ErrorLine, FTime, Pending, presenceBead, Row, Section, Span } from '../ui/index.ts';
import { Signal, useFlash } from './device/bits.tsx';
import { FaceMirror } from './device/face.tsx';
import { DeviceFrame } from './device/frame.tsx';
import { CatalogMissing, LensBody, usePanelProps } from './device/page-lens.tsx';
import { panelFor } from './device/panels.ts';
import { useInstrumentRows } from './device/use-instruments.ts';
import './device.css';
import './devices.css';

type InstRow = { inst: InstanceView; cap: CatalogCapability | undefined };

/** Whether an instance raised an event in the flash window (the live store's last event of the device). */
function useInstanceFlash(deviceId: string, inst: string): boolean {
  const flashing = useFlash(deviceId);
  const last = useLive((s) => s.lastByDevice[deviceId]);
  return flashing && !!last && last.type.startsWith(`${inst}.`);
}

function RungBody({ detail, inst, cap, instances }: { detail: DeviceDetail; inst: InstanceView; cap: CatalogCapability; instances: readonly InstanceView[] }) {
  const props = usePanelProps(detail, inst, cap, instances);
  const { Headline, Quick } = panelFor(cap.name);
  return (
    <>
      <span className="dev-rung-value">
        <Headline {...props} />
      </span>
      {Quick ? (
        <span className="dev-rung-quick" data-quick={inst.name}>
          <Quick {...props} />
        </span>
      ) : null}
    </>
  );
}

/** One instrument's row: the link covers port, name, word and headline; the quick control sits beside it. */
function Rung({ detail, row, instances, lit }: { detail: DeviceDetail; row: InstRow; instances: readonly InstanceView[]; lit: boolean }) {
  const { inst, cap } = row;
  const event = useInstanceFlash(detail.device_id, inst.name);
  const link = (
    <Link to="/devices/$id/$instance" params={{ id: detail.alias, instance: inst.name }} className="dev-rung-link" data-rung-link={inst.name}>
      <span className="dev-rung-port">{inst.port}</span>
      <span className="dev-rung-text">
        <span className="dev-rung-name">{inst.name}</span>
        <span className="dev-rung-word caps">{engrave(capWord(inst.cap))}</span>
      </span>
    </Link>
  );
  return (
    <div className="dev-rung" data-instrument={inst.name} data-flash={event || lit ? '' : undefined}>
      {link}
      {cap ? (
        <RungBody detail={detail} inst={inst} cap={cap} instances={instances} />
      ) : (
        <span className="dev-rung-value ash">not in this catalog</span>
      )}
      <span className="dev-rung-go caps" aria-hidden="true">
        ›
      </span>
    </div>
  );
}

/** Many instances of one capability as one row; pressing it unfolds them in place. */
function GroupRung({ detail, cap, rows, label, instances, from }: { detail: DeviceDetail; cap: string; rows: InstRow[]; label: string; instances: readonly InstanceView[]; from: string | null }) {
  const [open, setOpen] = useState(() => rows.some((r) => r.inst.name === from));
  const latest = useLive((s) => {
    let best: { name: string; at: number } | null = null;
    for (const r of rows) {
      const e = lastInstanceEvent(s.events, detail.device_id, r.inst.name);
      if (e && (!best || e.t_hub_us > best.at)) {
        best = { name: r.inst.name, at: e.t_hub_us };
      }
    }
    return best;
  });
  return (
    <div className="dev-group" data-group={cap}>
      <button type="button" className="dev-rung dev-rung-link dev-group-head" aria-expanded={open} onClick={() => setOpen(!open)} data-instrument-group={cap}>
        <span className="dev-rung-port">{rows[0]!.inst.port}</span>
        <span className="dev-rung-text">
          <span className="dev-rung-name">{label}</span>
          <span className="dev-rung-word caps">{engrave(`${capWord(cap)} ×${rows.length}`)}</span>
        </span>
        <span className="dev-rung-value">
          {latest ? (
            <span>
              {latest.name} changed <FTime at={latest.at} form="relative" />
            </span>
          ) : (
            <span className="ash">—</span>
          )}
        </span>
        <span className="dev-rung-go caps" aria-hidden="true">
          {open ? '−' : '+'}
        </span>
      </button>
      {open ? (
        <div className="dev-group-members">
          {rows.map((r) => (
            <Rung key={r.inst.name} detail={detail} row={r} instances={instances} lit={r.inst.name === from} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The glance: this run's link, the last word, the clock and how long it has been up; then ALL FACTS ›. */
function Glance({ detail, fetchedAt }: { detail: DeviceDetail; fetchedAt: number }) {
  const said = usePresence();
  const presence = said(detail.presence) ?? 'unknown';
  const r = detail.router;
  const hb = heartbeatOf(r?.heartbeat as Record<string, unknown> | null | undefined);
  const heardAt = r?.last_rx_ms_ago != null ? (fetchedAt - r.last_rx_ms_ago) * 1000 : null;
  const clock = (r?.clock ?? null) as ClockInfo | null;
  const cs = clockState(clock);
  return (
    <Section
      title="At a glance"
      aside={
        <Link to="/devices/$id/facts" params={{ id: detail.alias }} className="dev-more caps" data-link="facts">
          {engrave('all facts ›')}
        </Link>
      }
    >
      <Row label="Link" bead={presenceBead(presence)} beadLabel={presenceWord(presence)} value={r ? <Signal rssi={hb?.rssi_ap} /> : <span>{presenceWord(presence)}</span>} />
      <Row
        label="Last word"
        value={heardAt !== null ? <FTime at={heardAt} form="relative" /> : detail.last_seen ? <FTime at={detail.last_seen} form="relative" /> : <span className="ash">never</span>}
      />
      {r ? (
        <Row
          label="Clock"
          value={
            cs === 'none' || !clock ? (
              <span className="ash">not synced</span>
            ) : (
              <span>
                {CLOCK_WORDS[cs]}, <Span us={clock.uncertainty_us} sign="±" />
              </span>
            )
          }
        />
      ) : null}
      {hb?.uptime_s !== undefined ? <Row label="Up for" value={<Span us={hb.uptime_s * 1_000_000} />} /> : null}
    </Section>
  );
}

/** The device's last three events, then ALL ACTIVITY ›. */
function Lately({ detail }: { detail: DeviceDetail }) {
  const ring = useLive((s) => s.events);
  const events = useMemo(() => deviceEvents(ring, detail.device_id, null, 3), [ring, detail.device_id]);
  return (
    <Section
      title="Lately"
      aside={
        <Link to="/devices/$id/activity" params={{ id: detail.alias }} className="dev-more caps" data-link="activity">
          {engrave('all activity ›')}
        </Link>
      }
    >
      {events.length ? (
        events.map((e) => <Row key={e.cursor} name={<span className="dev-lately-type">{eventWords(e)}</span>} value={<FTime at={e.t_hub_us} form="relative" />} />)
      ) : (
        <Row label="Nothing yet" value={<span className="ash">its events show here as they come</span>} />
      )}
    </Section>
  );
}

function NoInstruments({ detail }: { detail: DeviceDetail }) {
  return detail.provision && detail.presence !== 'online' && !detail.last_seen ? (
    <EmptyState
      title="Provisioned, not on Wi-Fi yet"
      action={
        <Link to="/provision" className="ui-button" data-variant="default">
          <span className="ui-button-text">{engrave('Provision it again')}</span>
        </Link>
      }
    >
      It answered over USB when it was flashed but has not greeted the hub over Wi-Fi. Check its network in Settings › Networks (the name and the password), or provision it again.
    </EmptyState>
  ) : (
    <EmptyState title="No capabilities known yet">
      The device says what it has when it greets the hub. {detail.presence === 'online' ? 'It has not said yet this run.' : 'Once it is powered and on the network, it will.'}
    </EmptyState>
  );
}

function Overview({ detail, fetchedAt }: { detail: DeviceDetail; fetchedAt: number }) {
  const { instances, instruments, pending, error } = useInstrumentRows(detail);
  const from = ((useSearch({ strict: false }) as Record<string, unknown>).from as string | undefined) ?? null;
  const [lit, setLit] = useState(from);
  useEffect(() => {
    if (!from || pending) {
      return;
    }
    const row = document.querySelector(`[data-instrument="${CSS.escape(from)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    // the focus goes back to the row the person came from, not to the page's start
    (row?.querySelector('[data-rung-link]') as HTMLElement | null)?.focus({ preventScroll: true });
    setLit(from);
    const t = setTimeout(() => setLit(null), 600);
    return () => clearTimeout(t);
  }, [from, pending]);
  const items = groupInstruments(instruments);
  const single = instruments.length === 1 ? instruments[0]! : null;
  return (
    <div className="dev-ov" data-caps={instruments.length}>
      <div className="dev-ov-glance">
        <Glance detail={detail} fetchedAt={fetchedAt} />
      </div>
      <div className="dev-ov-rows">
        <FaceMirror instances={instances} deviceId={detail.device_id} detail={detail} />
        {error && !opMissing(error) ? <ErrorLine error={error} what="The capability list" /> : null}
        {pending ? (
          <Pending what="its instruments" />
        ) : single ? (
          single.cap ? (
            <LensBody detail={detail} inst={single.inst} cap={single.cap} instances={instances} />
          ) : (
            <CatalogMissing cap={single.inst.cap} />
          )
        ) : !instruments.length ? (
          <Section title="Instruments">
            <NoInstruments detail={detail} />
          </Section>
        ) : (
          <Section title="Instruments" aside={<span className="caps ash">{engrave(`${instruments.length}`)}</span>}>
            <div className="dev-rungs">
              {items.map((it) =>
                it.kind === 'one' ? (
                  <Rung key={it.row.inst.name} detail={detail} row={it.row} instances={instances} lit={lit === it.row.inst.name} />
                ) : (
                  <GroupRung key={it.cap} detail={detail} cap={it.cap} rows={it.rows} label={it.label} instances={instances} from={lit} />
                ),
              )}
            </div>
          </Section>
        )}
      </div>
      <div className="dev-ov-lately">
        <Lately detail={detail} />
      </div>
    </div>
  );
}

export function DevicePage() {
  return <DeviceFrame section="instruments" lens="single">{(d, at) => <Overview detail={d} fetchedAt={at} />}</DeviceFrame>;
}
