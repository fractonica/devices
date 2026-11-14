// The device page's data column, LENS-style (caps label left, value right, rows on hairlines): this hub run's link
// (presence, links, signal, last heard), the clock stated plainly, the running node (uptime, memory, losses), the build
// (firmware, core version, profile, board) and the registry (address, USB, tags, first and last seen). Every time is
// Fractonica (spans, FTime); Earth mode adds ⊕ translations.

import { useState } from 'react';

import type { DeviceDetail } from '../../api/types.ts';
import { useAct } from '../../hooks.ts';
import { usePresence } from '../../shell/link.ts';
import { CLOCK_WORDS, type ClockInfo, clockState, hardwareLine, heartbeatOf, linksText, shortId } from '../../state/device-link.ts';
import { countText } from '../../state/device-units.ts';
import { presenceWord } from '../../state/words.ts';
import { Button, Earth, FTime, presenceBead, Row, Section, Span, TextField } from '../../ui/index.ts';
import { Signal } from './bits.tsx';

const PRESENCE_TEXT: Record<string, string> = {
  online: 'online',
  suspect: 'suspect: heartbeats are late',
  offline: 'offline',
  unknown: 'not seen since the hub started',
  not_known: 'not known: the hub does not answer',
};

function ClockRows({ clock }: { clock: ClockInfo | null }) {
  const state = clockState(clock);
  if (!clock || state === 'none') {
    return (
      <Row
        label="Clock"
        bead="idle"
        beadLabel="not synced"
        value={<span>not synced</span>}
        extra="its events carry the time the hub received them"
      />
    );
  }
  return (
    <>
      <Row
        label="Clock"
        bead={state === 'in-step' ? 'online' : 'waiting'}
        beadLabel={CLOCK_WORDS[state]}
        value={
          <span>
            {CLOCK_WORDS[state]} with the hub, to within <Span us={clock.uncertainty_us} sign="±" />
          </span>
        }
        extra={`${countText(null, clock.samples)} samples`}
      />
      <Row label="Round trip" value={<Span us={clock.rtt_us} />} />
    </>
  );
}

function Tags({ detail }: { detail: DeviceDetail }) {
  const [edit, setEdit] = useState<string | null>(null);
  const act = useAct('device_update', { done: () => 'tags saved', refresh: ['device_list', 'device_get'] });
  if (edit === null) {
    return (
      <Row label="Tags">
        <span className="dev-tags">
          {detail.tags.length ? detail.tags.map((t) => <span key={t} className="dev-tag mono">{t}</span>) : <span className="ash">none</span>}
          <Button variant="quiet" onClick={() => setEdit('')} aria-label={`Edit the tags of ${detail.alias}`}>
            Edit
          </Button>
        </span>
      </Row>
    );
  }
  return (
    <form
      className="dev-tags-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (edit.trim()) {
          act.mutate({ device: `id:${detail.device_id}`, tag: edit.trim() }, { onSuccess: () => setEdit(null) });
        }
      }}
      onKeyDown={(e) => e.key === 'Escape' && setEdit(null)}
    >
      <TextField label="Tag edits" value={edit} onChange={setEdit} autoFocus mono placeholder="+lab, -old" note="+tag adds, -tag removes; separate them with commas" />
      <span className="dev-rename-buttons">
        <Button type="submit" busy={act.isPending} disabled={!edit.trim()}>
          Apply
        </Button>
        <Button variant="quiet" onClick={() => setEdit(null)}>
          Cancel
        </Button>
      </span>
    </form>
  );
}

export function DataColumn({ detail, fetchedAt }: { detail: DeviceDetail; fetchedAt: number }) {
  const said = usePresence();
  const presence = said(detail.presence) ?? 'unknown';
  const r = detail.router;
  const hb = heartbeatOf(r?.heartbeat as Record<string, unknown> | null | undefined);
  const fw = detail.fw_id ?? r?.fw_id_prefix ?? null;
  const heardAt = r?.last_rx_ms_ago != null ? (fetchedAt - r.last_rx_ms_ago) * 1000 : null;
  return (
    <div className="dev-data">
      <Section title="Link">
        <Row label="Presence" bead={presenceBead(presence)} beadLabel={presenceWord(presence)} value={PRESENCE_TEXT[presence] ?? presence} />
        {r ? (
          <>
            <Row label="Links" value={r.links.length ? linksText(r.links, r.gw) : <span className="ash">none open</span>} extra={r.udp_blocked ? 'UDP is blocked on this network: it talks over TCP only' : undefined} />
            <Row label="Signal" value={<Signal rssi={hb?.rssi_ap} />} />
            <Row label="Last word" value={heardAt !== null ? <FTime at={heardAt} form="relative" /> : '—'} extra="any frame from it, this run" />
          </>
        ) : (
          <Row label="This run" value={<span className="ash">no greeting from it since the hub started</span>} />
        )}
        <Row label="Last greeting" value={detail.last_seen ? <FTime at={detail.last_seen} form="relative" /> : <span className="ash">never</span>} extra={detail.last_seen ? 'its last HELLO to the hub, kept across runs' : undefined} />
      </Section>
      {r ? (
        <Section title="Time">
          <ClockRows clock={r.clock as ClockInfo | null} />
        </Section>
      ) : null}
      {hb ? (
        <Section title="Running">
          {hb.uptime_s !== undefined ? <Row label="Up for" value={<Span us={hb.uptime_s * 1_000_000} />} /> : null}
          {hb.free_heap_kb !== undefined ? (
            // a count of bytes in pure mode (no kilo), ⊕ KB in Earth mode; 0 is a heartbeat that does not say
            <Row label="Free memory" value={hb.free_heap_kb > 0 ? `${countText(null, hb.free_heap_kb * 1024)} B` : '—'} earth={hb.free_heap_kb > 0 ? `${countText(null, hb.free_heap_kb)} KB` : undefined} />
          ) : null}
          {hb.vbat_mv ? <Row label="Battery" value={<span>{countText(null, hb.vbat_mv)}<Earth className="dev-earth-inline">{`${hb.vbat_mv} mV`}</Earth></span>} /> : null}
          <Row label="Send failures" value={countText(null, hb.tx_fail ?? 0)} extra={`${countText(null, hb.rx_drop ?? 0)} received frames dropped`} />
        </Section>
      ) : null}
      <Section title="Build">
        <Row label="Firmware" value={fw ? <span className="mono">{shortId(fw, 16)}</span> : <span className="ash">not known</span>} extra={r?.ota_state ? `image ${r.ota_state}` : undefined} />
        <Row label="Core" value={<span className="ash">not reported by this firmware</span>} />
        <Row label="Hardware" value={hardwareLine(detail) || <span className="ash">not known</span>} />
        {r?.epoch != null ? <Row label="Epoch" value={countText(null, r.epoch)} /> : null}
      </Section>
      <Section title="Registry">
        <Row label="Address" value={detail.addr != null ? `${detail.addr} on net ${detail.net ?? '—'}` : <span className="ash">none: seen only</span>} />
        <Row
          label="USB"
          value={detail.port ? <span className="mono">{detail.port.replace(/^\/dev\/(cu\.)?/, '')}</span> : <span className="ash">not plugged in</span>}
          extra={detail.port ? detail.port_state : undefined}
        />
        <Tags detail={detail} />
        <Row label="Id" value={<span className="mono">{detail.device_id}</span>} />
        <Row label="Registered" value={<FTime at={detail.created_at} form="relative" />} />
      </Section>
    </div>
  );
}
