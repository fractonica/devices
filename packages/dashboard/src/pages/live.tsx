// LIVE, route `/live` (HARDWARE-REVIEW §4 "Screens" 6; design README "Hub" 10): the hub's event stream as hairline
// rows, newest first. Times are the core's (`29ι 21λ 3ν`), with ⊕ HH:MM:SS.mmm after them in ash in Earth mode only.
// Filters are device beads and type chips; time.threshold events are quiet engraved lines; an event's cursor stays
// behind "copy cursor" in its open row. Pause keeps every event (they wait, counted) and Resume shows them. "From a
// cursor" reads the stored events after one (events_read), oldest first, and pages on.
//
// The list is virtual over the shell's scrolling column (#main), with each row measured, so an open row may grow.
// The stream is the live store's ring (state/live.ts); the page's rules are in state/live-view.ts.

import './live.css';

import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { HubEvent } from '@fractonica/protocol/client';

import { OpError } from '../api/rest.ts';
import { useLive, useOp } from '../hooks.ts';
import { rest } from '../runtime.ts';
import { RING_MAX } from '../state/live.ts';
import {
  deviceKey,
  familiesOf,
  fieldsText,
  filterIsEmpty,
  HUB_KEY,
  isThreshold,
  type LiveFilter,
  liveKeep,
  NO_FILTER,
  pauseSeq,
  shownEvents,
  summary,
  thresholdWords,
  toggled,
  waitingCount,
} from '../state/live-view.ts';
import { Bead, type BeadState, Button, ButtonRow, Caps, Chip, ChipRow, CopyButton, Disclosure, EmptyState, engrave, ErrorLine, FTime, Page, presenceBead, Row, Section, TextField, useMode, useSpanOf } from '../ui/index.ts';

interface History {
  from: string;
  events: HubEvent[];
  next: string;
  truncated: boolean;
}

interface RowCtx {
  pure: boolean;
  spanOf?: (us: bigint) => string;
  beadOf: (key: string) => BeadState | undefined;
}

/** A time.threshold: an engraved line, the level and its quarter, with the instant it passed. */
function ThresholdLine({ e }: { e: HubEvent }) {
  const w = thresholdWords(e.fields);
  return (
    <div className="live-threshold" data-type={e.type}>
      <span className="live-time">
        <FTime at={w?.at ?? e.t_hub_us} />
      </span>
      <span className="live-threshold-rule" aria-hidden="true" />
      <span className="live-threshold-word caps">{w ? `${w.symbol} ${engrave(w.unit ?? '')} · ${engrave(w.quarter)}`.replace(/\s+·/, ' ·') : engrave('threshold')}</span>
      <span className="live-threshold-rule" aria-hidden="true" />
    </div>
  );
}

/** One event: time, device, type and its fields on a line; open, the fields in full and the cursor's actions. */
const EventLine = memo(function EventLine({ e, open, onToggle, onReadFrom, ctx }: { e: HubEvent; open: boolean; onToggle: (cursor: string) => void; onReadFrom: (cursor: string) => void; ctx: RowCtx }) {
  if (isThreshold(e)) {
    return <ThresholdLine e={e} />;
  }
  const key = deviceKey(e);
  const who = e.alias ?? e.device ?? 'hub';
  const bead = key === HUB_KEY ? undefined : ctx.beadOf(key);
  const text = summary(e.fields, { pure: ctx.pure, spanOf: ctx.spanOf });
  return (
    <div className="live-event" data-open={open ? '' : undefined} data-type={e.type} data-device={e.alias ?? ''}>
      <button type="button" className="live-line" aria-expanded={open} onClick={() => onToggle(e.cursor)}>
        <span className="live-time">
          <FTime at={e.t_hub_us} />
        </span>
        <span className="live-who">
          {bead ? <Bead state={bead} size={6} /> : <span className="live-hub-mark" aria-hidden="true" />}
          <span className={key === HUB_KEY ? 'live-who-name caps' : 'live-who-name'}>{key === HUB_KEY ? 'HUB' : who}</span>
        </span>
        <span className="live-type">
          {e.type}
          {e.late ? <span className="live-flag caps">LATE</span> : null}
          {e.replayed ? <span className="live-flag caps">REPLAYED</span> : null}
        </span>
        <span className="live-fields">{text}</span>
      </button>
      {open ? (
        <div className="live-open">
          {e.fields && Object.keys(e.fields).length ? <pre className="live-json">{fieldsText(e.fields, { pure: ctx.pure, spanOf: ctx.spanOf })}</pre> : <p className="live-none">No fields.</p>}
          <ButtonRow>
            <CopyButton text={e.cursor} label="Copy cursor" what={e.type} />
            <Button variant="quiet" onClick={() => onReadFrom(e.cursor)}>
              Read on from here
            </Button>
          </ButtonRow>
        </div>
      ) : null}
    </div>
  );
});

/** The scroll offset of `el` inside the shell's scrolling column. */
function offsetIn(el: HTMLElement, scroller: HTMLElement): number {
  return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

function EventList({ events, ctx, open, onToggle, onReadFrom }: { events: readonly HubEvent[]; ctx: RowCtx; open: string | null; onToggle: (c: string) => void; onReadFrom: (c: string) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  const scroller = () => document.getElementById('main');
  useLayoutEffect(() => {
    const el = list.current;
    const main = scroller();
    if (!el || !main) {
      return;
    }
    const measure = () => setMargin(offsetIn(el, main));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(main.firstElementChild ?? main);
    return () => ro.disconnect();
  }, []);
  const rows = useVirtualizer({
    count: events.length,
    getScrollElement: scroller,
    estimateSize: () => 38,
    overscan: 12,
    scrollMargin: margin,
    getItemKey: (i) => events[i]!.cursor,
  });
  return (
    <div ref={list} className="live-list" data-list="live" role="list" aria-label="Events, newest first">
      <div style={{ height: rows.getTotalSize(), position: 'relative' }}>
        {rows.getVirtualItems().map((v) => {
          const e = events[v.index]!;
          return (
            <div key={v.key} role="listitem" data-index={v.index} ref={rows.measureElement} className="live-slot" style={{ transform: `translateY(${v.start - margin}px)` }}>
              <EventLine e={e} open={open === e.cursor} onToggle={onToggle} onReadFrom={onReadFrom} ctx={ctx} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function LivePage() {
  const ring = useLive((s) => s.events);
  const conn = useLive((s) => s.conn);
  const devices = useOp('device_list', { selector: 'all' });
  const { earth } = useMode();
  const spanOf = useSpanOf();
  const [filter, setFilter] = useState<LiveFilter>(NO_FILTER);
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [cursor, setCursor] = useState('');
  const [readError, setReadError] = useState<unknown>(null);
  const [reading, setReading] = useState(false);

  const list = useMemo(() => devices.data?.devices ?? [], [devices.data]);
  const presence = useMemo(() => new Map(list.map((d) => [d.device_id, presenceBead(d.presence)])), [list]);
  const ctx = useMemo<RowCtx>(() => ({ pure: !earth, spanOf, beadOf: (k) => presence.get(k) }), [earth, spanOf, presence]);
  const keep = useMemo(() => liveKeep(filter), [filter]);
  const source = history ? history.events : ring;
  const shown = useMemo(() => (history ? history.events.filter(keep) : shownEvents(ring, pausedAt, keep)), [history, ring, pausedAt, keep]);
  const waiting = useMemo(() => waitingCount(ring, pausedAt, keep), [ring, pausedAt, keep]);
  const families = useMemo(() => {
    const f = familiesOf(source);
    for (const fam of filter.families) {
      if (!f.some((x) => x.family === fam)) {
        f.push({ family: fam, count: 0 });
      }
    }
    return f;
  }, [source, filter.families]);
  const hubCount = useMemo(() => source.filter((e) => e.device === undefined).length, [source]);

  const toggleRow = useCallback((c: string) => setOpen((o) => (o === c ? null : c)), []);
  const readFrom = useCallback(async (since: string, append = false) => {
    setReadError(null);
    setReading(true);
    try {
      const page = await rest.op('events_read', { since, max_events: 1000 });
      setHistory((h) => ({ from: append && h ? h.from : since, events: append && h ? [...h.events, ...page.events] : page.events, next: page.next_cursor, truncated: page.truncated }));
      setOpen(null);
    } catch (err) {
      setReadError(err instanceof OpError ? err : String(err));
    } finally {
      setReading(false);
    }
  }, []);
  const onReadFrom = useCallback((c: string) => void readFrom(c), [readFrom]);

  const paused = pausedAt !== null;
  const sub = history
    ? `${history.events.length} stored after ${history.from} · oldest first`
    : paused
      ? waiting
        ? `paused · ${waiting} new waiting`
        : 'paused · nothing new yet'
      : conn.status === 'open'
        ? `live · the newest ${RING_MAX} are kept`
        : 'live updates not connected';

  const action = history ? (
    <Button variant="primary" onClick={() => setHistory(null)} data-action="back-to-live">
      Back to live
    </Button>
  ) : (
    <Button variant={paused ? 'primary' : 'default'} data-action="pause" onClick={() => setPausedAt((p) => (p === null ? pauseSeq(ring) : null))} aria-label={paused ? `Resume, ${waiting} new` : 'Pause'}>
      {paused ? (waiting ? `Resume · ${waiting} new` : 'Resume') : 'Pause'}
    </Button>
  );

  let body;
  if (!source.length) {
    body =
      conn.status === 'open' || history ? (
        <EmptyState title={history ? 'Nothing stored after it' : 'No events yet'}>{history ? 'The hub has no event after that cursor.' : 'Events show here the moment the hub sees them: a device coming online, a button, a job, a threshold of time.'}</EmptyState>
      ) : (
        <EmptyState title="Waiting for the hub">The page connects to the hub's live updates by itself; events show here once it does.</EmptyState>
      );
  } else if (!shown.length) {
    body = (
      <EmptyState
        title="Nothing matches"
        action={
          <Button onClick={() => setFilter(NO_FILTER)} data-action="clear">
            Show everything
          </Button>
        }
      >
        {paused ? 'No event before the pause passes these filters.' : 'No event in the stream passes these filters yet.'}
      </EmptyState>
    );
  } else {
    body = <EventList events={shown} ctx={ctx} open={open} onToggle={toggleRow} onReadFrom={onReadFrom} />;
  }

  return (
    <Page title="Live" sub={sub} actions={action}>
      <section className="live-filters" aria-label="Filters">
        <div className="live-filter">
          <span className="live-filter-label caps">{engrave('devices')}</span>
          <ChipRow label="Devices">
            {list.map((d) => (
              <Chip key={d.device_id} pressed={filter.devices.has(d.device_id)} onToggle={() => setFilter((f) => ({ ...f, devices: toggled(f.devices, d.device_id) }))} bead={presenceBead(d.presence)} beadLabel={d.presence} title={d.alias}>
                {d.alias}
              </Chip>
            ))}
            <Chip pressed={filter.devices.has(HUB_KEY)} onToggle={() => setFilter((f) => ({ ...f, devices: toggled(f.devices, HUB_KEY) }))} count={hubCount}>
              hub
            </Chip>
          </ChipRow>
        </div>
        {families.length ? (
          <div className="live-filter">
            <span className="live-filter-label caps">{engrave('types')}</span>
            <ChipRow label="Types">
              {families.map((f) => (
                <Chip key={f.family} pressed={filter.families.has(f.family)} onToggle={() => setFilter((x) => ({ ...x, families: toggled(x.families, f.family) }))} count={f.count}>
                  {f.family}
                </Chip>
              ))}
            </ChipRow>
          </div>
        ) : null}
        {!filterIsEmpty(filter) ? (
          <div className="live-filter-clear">
            <Button variant="quiet" onClick={() => setFilter(NO_FILTER)} data-action="clear">
              Clear filters
            </Button>
          </div>
        ) : null}
      </section>

      <Section title={history ? 'Stored events' : 'Events'} aside={<Caps>{`${shown.length} shown`}</Caps>}>
        {history?.truncated ? (
          <Row label="More stored" value={<Button variant="quiet" busy={reading} onClick={() => void readFrom(history.next, true)}>Load the next 1000</Button>} />
        ) : null}
        {devices.error ? <ErrorLine error={devices.error} what="Devices" /> : null}
        {body}
      </Section>

      <Disclosure title="From a cursor">
        <form
          className="live-cursor-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (cursor.trim()) {
              void readFrom(cursor.trim());
            }
          }}
        >
          <TextField label="Cursor" value={cursor} onChange={setCursor} placeholder="c:<run>.<seq>" mono note="Reads the stored events after it, oldest first. Copy one from an open event, or from fr events." />
          <ButtonRow>
            <Button type="submit" disabled={!cursor.trim()} busy={reading}>
              Read after it
            </Button>
          </ButtonRow>
          <ErrorLine error={readError} what="Read" />
        </form>
      </Disclosure>
    </Page>
  );
}
