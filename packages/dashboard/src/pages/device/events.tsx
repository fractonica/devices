// A device's recent events, from the live store's ring (newest first): the event in words (state/words.ts eventWords:
// "the dashboard asked flash to blink", "cam’s live view ended: stopped, 949 frames"); the words open a fold with its raw
// type and fields,
// and its time in Fractonica notation (⊕ the clock time in Earth mode); the last 50, all or one instrument's (state/instruments.ts
// deviceEvents). The full stream, with filters, is on Live.

import { Link } from '@tanstack/react-router';
import { type ReactNode, useMemo } from 'react';

import type { HubEvent } from '@fractonica/protocol/client';

import { useLive } from '../../hooks.ts';
import { fieldPairs } from '../../state/device-link.ts';
import { deviceEvents } from '../../state/instruments.ts';
import { eventWords } from '../../state/words.ts';
import { fieldWords, impliedUnit } from '../../state/device-units.ts';
import { UnitValue } from './bits.tsx';
import { Caps, FTime, Section, engrave } from '../../ui/index.ts';

const SHOWN = 50;

function EventRow({ e }: { e: HubEvent }) {
  const pairs = fieldPairs(e.fields);
  return (
    <li className="dev-event" data-event={e.type}>
      <details className="dev-event-raw">
        <summary className="dev-event-type">{eventWords(e)}</summary>
        <span className="dev-event-fields">
          <span className="ash mono">{e.type}</span>
          {pairs.map(([k, v]) => (
            <span key={k}>
              <span className="ash">{fieldWords(k)}</span> {typeof v === 'number' && impliedUnit(k) ? <UnitValue value={v} unit={impliedUnit(k)} /> : String(v)}
            </span>
          ))}
        </span>
      </details>
      <span className="dev-event-time">
        <FTime at={e.t_hub_us} />
      </span>
    </li>
  );
}

export function RecentEvents({ deviceId, instrument = null, filter }: { deviceId: string; instrument?: string | null; filter?: ReactNode }) {
  const ring = useLive((s) => s.events);
  const events = useMemo(() => deviceEvents(ring, deviceId, instrument, SHOWN), [ring, deviceId, instrument]);
  return (
    <Section
      title={instrument ? `Events of ${instrument}` : 'Recent events'}
      aside={
        <Link to="/live" className="dev-more caps" data-link="live">
          {engrave('in live ›')}
        </Link>
      }
    >
      {filter}
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
