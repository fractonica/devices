// A device's recent events, from the live store's ring (newest first): the event, its fields in words, and its time in
// Fractonica notation (⊕ the clock time in Earth mode). The full stream, with filters, is on Live.

import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';

import type { HubEvent } from '@fractonica/protocol/client';

import { useLive } from '../../hooks.ts';
import { fieldPairs, recentEvents } from '../../state/device-link.ts';
import { fieldWords, impliedUnit } from '../../state/device-units.ts';
import { UnitValue } from './bits.tsx';
import { Caps, FTime, Section, engrave } from '../../ui/index.ts';

const SHOWN = 12;

function EventRow({ e }: { e: HubEvent }) {
  const pairs = fieldPairs(e.fields);
  return (
    <li className="dev-event" data-event={e.type}>
      <span className="dev-event-type">{e.type}</span>
      <span className="dev-event-fields">
        {pairs.map(([k, v]) => (
          <span key={k}>
            <span className="ash">{fieldWords(k)}</span> {typeof v === 'number' && impliedUnit(k) ? <UnitValue value={v} unit={impliedUnit(k)} /> : String(v)}
          </span>
        ))}
      </span>
      <span className="dev-event-time">
        <FTime at={e.t_hub_us} />
      </span>
    </li>
  );
}

export function RecentEvents({ deviceId }: { deviceId: string }) {
  const ring = useLive((s) => s.events);
  const events = useMemo(() => recentEvents(ring, deviceId, SHOWN), [ring, deviceId]);
  return (
    <Section
      title="Recent events"
      aside={
        <Link to="/live" className="dev-more caps">
          {engrave('all on live')}
        </Link>
      }
    >
      {events.length ? (
        <ul className="dev-events">
          {events.map((e) => (
            <EventRow key={e.cursor} e={e} />
          ))}
        </ul>
      ) : (
        <p className="dev-quiet">
          <Caps>none yet</Caps> <span className="ash">its events appear here as they come</span>
        </p>
      )}
    </Section>
  );
}
