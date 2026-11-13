// The fleet beside the instrument: every device as a bead on one carrier (lit first, as a sibling counter reads),
// then a row per device, what needs a look first (suspect, offline, never heard), at most MAX_ROWS (all on Devices): its bead, its name, its last word (the newest live event, or when the
// registry last heard it) as a span from now, and what it is. A row opens the device. No devices yet: an invitation
// to provision, the page's one primary action.

import { useNavigate } from '@tanstack/react-router';
import type { CSSProperties } from 'react';

import { useLive, useOp } from '../../hooks.ts';
import { type FleetRow, fleetSummary } from '../../state/hub-home.ts';
import { fleetCount } from '../../state/words.ts';
import { usePresence } from '../../shell/link.ts';
import { Bead, Button, Caps, EmptyState, ErrorLine, FTime, Pending, Row, Section } from '../../ui/index.ts';

/** The fleet on a carrier: one bead per device on a hairline, in the list's order. */
export function FleetCarrier({ rows, label }: { rows: readonly FleetRow[]; label: string }) {
  return (
    <div className="hub-carrier" role="img" aria-label={label} style={{ '--n': rows.length } as CSSProperties}>
      {rows.map((r) => (
        <span key={r.device_id} className="hub-carrier-bead" data-state={r.bead}>
          <Bead state={r.bead} size={9} label={`${r.alias}: ${r.presence}`} />
        </span>
      ))}
    </div>
  );
}

function LastWord({ row }: { row: FleetRow }) {
  if (!row.last) {
    return <span className="hub-last ash">not heard yet</span>;
  }
  return (
    <span className="hub-last">
      <span className="hub-last-what">{row.last.what}</span> <FTime at={row.last.at} form="relative" parts={1} />
    </span>
  );
}

/** Rows the Hub page lists (the rest are on Devices). */
const MAX_ROWS = 10;

export function Fleet() {
  const navigate = useNavigate();
  const devices = useOp('device_list', { selector: 'all' });
  const lastByDevice = useLive((s) => s.lastByDevice);
  const presence = usePresence();
  if (devices.isPending) {
    return (
      <Section title="Fleet">
        <Pending what="the registry" />
      </Section>
    );
  }
  if (devices.isError) {
    return (
      <Section title="Fleet">
        <ErrorLine error={devices.error} what="The fleet" fix={{ label: 'Try again', onClick: () => void devices.refetch(), busy: devices.isFetching }} />
      </Section>
    );
  }
  const s = fleetSummary(
    devices.data.devices.map((d) => ({ ...d, presence: presence(d.presence) ?? d.presence })),
    lastByDevice,
  );
  if (s.total === 0) {
    return (
      <Section title="Fleet">
        <EmptyState
          title="No devices yet"
          action={
            <Button variant="primary" onClick={() => void navigate({ to: '/provision' })}>
              Provision a board
            </Button>
          }
        >
          Plug a board into this Mac with a USB cable. The hub finds it, names it, puts it on your network and shows it here.
        </EmptyState>
      </Section>
    );
  }
  const count = fleetCount(s);
  // the page is a summary: what needs a look first, then the rest up to MAX_ROWS; all of them are a link away
  const shown = s.listRows.slice(0, MAX_ROWS);
  return (
    <Section title="Fleet" aside={<Caps tone={s.online === s.total ? 'lumen' : 'ash'}>{count}</Caps>}>
      <FleetCarrier rows={s.rows} label={`Fleet: ${count}`} />
      <div className="hub-fleet-rows">
        {shown.map((r) => (
          <Row
            key={r.device_id}
            id={`device-${r.alias}`}
            bead={r.bead}
            beadLabel={r.presence}
            name={
              <>
                <span className="hub-alias">{r.alias}</span>
                {r.kind ? <span className="hub-kind">{r.kind}</span> : null}
              </>
            }
            to="/devices/$id"
            params={{ id: r.alias }}
            value={<LastWord row={r} />}
          />
        ))}
        {s.total > shown.length ? <Row id="all-devices" label={`all ${s.total} on Devices`} to="/devices" value={<span className="ash">{`${s.total - shown.length} more`}</span>} /> : null}
      </div>
    </Section>
  );
}
