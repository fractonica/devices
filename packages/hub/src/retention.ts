// Retention of the tables that grow with every job (jobs, job_logs), and of the free pages pruning leaves behind.
// Finished jobs older than `retention.jobs_days` (config.json, default 30), or beyond the newest `retention.jobs_rows`
// (default 5000), are deleted with their job_logs; queued and working jobs are never touched. Like the logs and events
// ring (ring.ts), it runs off a timer in small batches and yields between them, so a large backlog (the first run on a
// database that was never pruned) never stalls serial ingestion, node links or HTTP. job_logs rows whose job is gone
// (a crash between the two deletes, or an older hub) are swept the same way.
//
// Space: SQLite keeps deleted pages in the file. A database created by this hub has auto_vacuum INCREMENTAL (db.ts), so
// after each pass a bounded `PRAGMA incremental_vacuum` returns some of them to the file system. An older database is
// in auto_vacuum NONE until `fr hub compact` (a full VACUUM, with the hub stopped) converts it; hub_status says when
// that is worth doing. No VACUUM ever runs inside the hub: on a large file it would block the event loop for minutes.

import type { Db } from './db.ts';
import { guarded } from './crash.ts';

export interface JobRetentionLimits {
  days: number;
  rows: number;
}

const FIRST_MS = 10_000;
const EVERY_MS = 60 * 60_000;
const BATCH = 200;
const LOG_BATCH = 5000;
/** Pages returned per incremental_vacuum step (4 KiB pages: about 8 MB). */
const VACUUM_PAGES = 2000;

/** What one prune pass did. */
export interface PruneReport {
  jobs: number;
  job_logs: number;
  orphan_logs: number;
  freed_pages: number;
  ms: number;
}

export class JobRetention {
  #db: Db;
  #limits: () => JobRetentionLimits | null;
  #timers: NodeJS.Timeout[] = [];
  #running = false;
  /** The last pass, for hub_status. */
  last: PruneReport | null = null;

  /** `limits` null: no limits known (config.json has never given valid retention settings): the pass deletes nothing. */
  constructor(db: Db, limits: () => JobRetentionLimits | null) {
    this.#db = db;
    this.#limits = limits;
  }

  /** First pass 10 s after start, then hourly. Unref'd. */
  start(): void {
    if (this.#timers.length) {
      return;
    }
    const tick = guarded('jobs.prune', () => this.prune());
    this.#timers = [setTimeout(tick, FIRST_MS).unref(), setInterval(tick, EVERY_MS).unref()];
  }

  stop(): void {
    for (const t of this.#timers) {
      clearTimeout(t);
    }
    this.#timers = [];
  }

  /** One full pass, in batches with a yield between them; stops early once the db closes. */
  async prune(): Promise<PruneReport> {
    const report: PruneReport = { jobs: 0, job_logs: 0, orphan_logs: 0, freed_pages: 0, ms: 0 };
    if (this.#running) {
      return report;
    }
    this.#running = true;
    const t0 = performance.now();
    try {
      const limits = this.#limits();
      if (!limits) {
        return report;
      }
      const { days, rows } = limits;
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      // Finished jobs past the age limit or beyond the newest `rows` (the row cap counts every job, finished or not).
      const pick = this.#db.prepare(
        `SELECT job_id FROM jobs WHERE status NOT IN ('queued', 'working')
           AND (created_at < @cutoff OR created_at < COALESCE((SELECT created_at FROM jobs ORDER BY created_at DESC LIMIT 1 OFFSET @keep), ''))
         ORDER BY created_at LIMIT @batch`,
      );
      const delLogs = this.#db.prepare('DELETE FROM job_logs WHERE job_id = ?');
      const delJob = this.#db.prepare('DELETE FROM jobs WHERE job_id = ?');
      const batch = this.#db.transaction((ids: string[]) => {
        for (const id of ids) {
          report.job_logs += delLogs.run(id).changes;
          report.jobs += delJob.run(id).changes;
        }
      });
      while (this.#db.open) {
        const ids = (pick.all({ cutoff, keep: rows - 1, batch: BATCH }) as { job_id: string }[]).map((r) => r.job_id);
        if (!ids.length) {
          break;
        }
        batch(ids);
        await yieldTick();
      }
      // job_logs of jobs that are gone.
      const orphans = this.#db.prepare(
        'DELETE FROM job_logs WHERE rowid IN (SELECT l.rowid FROM job_logs l LEFT JOIN jobs j ON j.job_id = l.job_id WHERE j.job_id IS NULL LIMIT ?)',
      );
      while (this.#db.open) {
        const n = orphans.run(LOG_BATCH).changes;
        report.orphan_logs += n;
        if (n < LOG_BATCH) {
          break;
        }
        await yieldTick();
      }
      if (this.#db.open) {
        report.freed_pages = incrementalVacuum(this.#db);
      }
    } finally {
      this.#running = false;
    }
    report.ms = Math.round(performance.now() - t0);
    this.last = report;
    if (report.jobs || report.orphan_logs) {
      console.log(JSON.stringify({ event: 'jobs_pruned', ...report }));
    }
    return report;
  }
}

const yieldTick = () => new Promise((r) => setImmediate(r));

/** auto_vacuum: 0 NONE, 1 FULL, 2 INCREMENTAL. */
export function autoVacuumMode(db: Db): number {
  return db.pragma('auto_vacuum', { simple: true }) as number;
}

/** Returns up to VACUUM_PAGES free pages to the file system when the database is in INCREMENTAL mode; the pages freed. */
export function incrementalVacuum(db: Db, pages = VACUUM_PAGES): number {
  if (autoVacuumMode(db) !== 2) {
    return 0;
  }
  const before = db.pragma('freelist_count', { simple: true }) as number;
  db.pragma(`incremental_vacuum(${Math.max(1, Math.floor(pages))})`);
  return before - (db.pragma('freelist_count', { simple: true }) as number);
}

/** The database file's size and free space, for hub_status. */
export function dbSpace(db: Db): { bytes: number; free_bytes: number; auto_vacuum: 'none' | 'full' | 'incremental' } {
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  const pages = db.pragma('page_count', { simple: true }) as number;
  const free = db.pragma('freelist_count', { simple: true }) as number;
  const mode = autoVacuumMode(db);
  return { bytes: pages * pageSize, free_bytes: free * pageSize, auto_vacuum: mode === 2 ? 'incremental' : mode === 1 ? 'full' : 'none' };
}

/** A hub_status warning when a database without incremental vacuum holds much free space (worth `fr hub compact`). */
export function spaceWarning(space: ReturnType<typeof dbSpace>): string | null {
  const mb = (n: number) => Math.round(n / 1e6);
  if (space.auto_vacuum !== 'incremental' && space.free_bytes > 64e6 && space.free_bytes > space.bytes / 4) {
    return `hub.db is ${mb(space.bytes)} MB, ${mb(space.free_bytes)} MB of it free space: \`fr hub stop\`, \`fr hub compact\`, \`fr hub start\` give it back`;
  }
  return null;
}

/**
 * `fr hub compact` (main.ts --compact, with no hub running): turns on auto_vacuum INCREMENTAL and rewrites the file
 * (VACUUM), so the free pages go back to the file system now and pruning returns them from then on. Blocks for as long
 * as SQLite needs (about a second per 100 MB on a laptop SSD; the timings are in the commit that added it).
 */
export function compactDb(db: Db): { before_bytes: number; after_bytes: number; ms: number } {
  const before = dbSpace(db).bytes;
  const t0 = performance.now();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.pragma('auto_vacuum = INCREMENTAL');
  db.exec('VACUUM');
  db.pragma('wal_checkpoint(TRUNCATE)');
  return { before_bytes: before, after_bytes: dbSpace(db).bytes, ms: Math.round(performance.now() - t0) };
}
