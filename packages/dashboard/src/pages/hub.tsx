// HUB (home), route `/`. STUB of the stage 4 foundation, for the Hub page builder (HARDWARE-REVIEW §4 "Screens" 1):
// the present as a small instrument computed by the core (Earth line in Earth mode only), the fleet as beads on a
// carrier with a last-event line per device, one line of hub health (hub_doctor checks as beads, each with its fix),
// pending agent prompts and leases as a banner. What is here now shows the primitives and the core in the browser.
//
// Pattern: keep a component that redraws with time (useReading, FTime relative) small, so a Blink's redraw does not
// re-render the page around it.

import { useLive, useOp } from '../hooks.ts';
import { FTime, Page, presenceBead, Reading, Row, Section, useMode, useReading } from '../ui/index.ts';

/** The present: the core's reading, redrawn at each Blink, with the ⊕ date line in Earth mode. */
function Present() {
  const { mode } = useMode();
  const reading = useReading(mode);
  if (!reading) {
    return <Row label="The present" value="—" />;
  }
  const next = reading.countdowns[0];
  const major = reading.majors[reading.majors.length - 1];
  return (
    <>
      <Row id="reading" label={major ? `${major.name} · ${major.quarter}` : 'Now'} value={<Reading className="ui-reading" text={reading.terms.slice(4).join(' ')} />} earth={reading.earth?.line} />
      {next?.next ? <Row label={`${next.symbol} ${next.next.quarter} in`} value={<Reading text={next.next.span} />} earth={next.next.earth ? `${next.next.earth.when} · ${next.next.earth.in}` : undefined} /> : null}
      <Row label="Pentad" value={reading.pentad.detail} />
    </>
  );
}

function Fleet() {
  const devices = useOp('device_list', { selector: 'all' });
  const events = useLive((s) => s.events);
  const list = devices.data?.devices ?? [];
  const online = list.filter((d) => d.presence === 'online').length;
  const last = events[events.length - 1];
  return (
    <Section title="Fleet" aside={<span className="caps">{`${online} OF ${list.length} ONLINE`}</span>}>
      {list.map((d) => (
        <Row key={d.device_id} bead={presenceBead(d.presence)} beadLabel={d.presence} name={d.alias} to="/devices/$id" params={{ id: d.alias }} value={<span className="ash">{d.profile ?? d.chip ?? ''}</span>} />
      ))}
      <Row label="Last event" value={last ? <FTime at={last.t_hub_us} form="relative" /> : '—'} />
    </Section>
  );
}

export function HubPage() {
  return (
    <Page title="Hub" sub="The present and the fleet">
      <Section title="The present">
        <Present />
      </Section>
      <Fleet />
    </Page>
  );
}
