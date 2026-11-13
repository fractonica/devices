// Settings › Storage: the hub's database (hub_status.db, stage 2's retention): its size and the free space inside it,
// whether it returns space by itself (auto_vacuum incremental) or keeps it (an older file), the last pruning pass, and
// compacting. Compacting rewrites the whole file (VACUUM), which would stop the hub for as long as that takes, so a
// running hub refuses it (LOCKED): the page says so and gives the three commands to copy, not a button that fails.

import { useOp } from '../../hooks.ts';
import { COMPACT_COMMAND, compactAdvice, type DbSpace, sizeText } from '../../state/settings-view.ts';
import { Caps, Code, CopyButton, EmptyState, ErrorLine, Line, Row, Section, Span } from '../../ui/index.ts';

interface DbView extends DbSpace {
  jobs_pruned?: { jobs: number; job_logs: number; orphan_logs: number; freed_pages: number; ms: number };
}

export function StorageSection() {
  const status = useOp('hub_status', {}, { refetchInterval: 10_000 });
  const s = status.data as (typeof status.data & { db?: DbView; events?: { state_thinned: number; live_only?: number } }) | undefined;
  const db = s?.db;
  if (status.error) {
    return <ErrorLine error={status.error} what="Hub status" />;
  }
  if (s && !db) {
    return <EmptyState title="No database figures">This hub does not report its database (an older hub, or one without a database open).</EmptyState>;
  }
  const advice = db ? compactAdvice(db) : null;
  const pruned = db?.jobs_pruned;
  return (
    <>
      <Section title="Database" aside={<Caps>hub.db</Caps>} id="db">
        <Row label="Size" value={db ? sizeText(db.bytes) : '—'} />
        <Row label="Free inside" value={db ? sizeText(db.free_bytes) : '—'} extra="pages freed by pruning that the file still holds" />
        <Row
          bead={db ? (db.auto_vacuum === 'incremental' ? 'online' : advice?.worth ? 'waiting' : 'idle') : 'idle'}
          label="Returns space"
          value={db ? (db.auto_vacuum === 'incremental' ? 'by itself, after each pass' : 'only when compacted') : '—'}
        />
        <Row
          label="Last pruning"
          value={pruned ? `${pruned.jobs} jobs · ${pruned.job_logs + pruned.orphan_logs} log lines removed` : 'not run yet'}
          extra={pruned ? (pruned.ms > 0 ? <>took <Span us={pruned.ms * 1000} /></> : undefined) : <>the first pass runs soon after the hub starts, then every <Span us={3_600_000_000} parts={1} /></>}
        />
        {s?.events ? <Row label="Events" value={`${s.events.state_thinned} streaming states thinned`} extra={s.events.live_only !== undefined ? `${s.events.live_only} live-only events since the start (fine thresholds, telemetry)` : undefined} /> : null}
      </Section>
      <Section title="Compact" id="compact">
        {advice ? <Line bead={advice.worth ? 'waiting' : 'idle'} label={advice.worth ? 'Worth doing' : 'Not needed'} detail={advice.text} /> : null}
        <Line
          label="With the hub stopped"
          detail={
            <>
              Compacting rewrites the whole file and holds it while it does, so a running hub refuses it with <Code>LOCKED</Code>. Run these in Terminal:
            </>
          }
          actions={
            <>
              <Code>{COMPACT_COMMAND}</Code>
              <CopyButton text={COMPACT_COMMAND} label="Copy commands" />
            </>
          }
        />
      </Section>
    </>
  );
}
