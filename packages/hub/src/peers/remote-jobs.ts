// Jobs that run at another hub (design multi-hub-m2 §7.3): an op passed on starts its job at the hub that runs it,
// and the hub that passed it on remembers `job_id -> hub` (job ids are 48 random bits, so two hubs never give one), in
// hub.db so that job_get, job_wait, job_logs and job_cancel find the job after this hub restarts. A row also keeps the
// files this hub has to pull when the job ends (files.ts). Rows older than KEEP_MS are pruned at a hub start.

import type { Db } from '../db.ts';

/** A remembered job is forgotten this long after it was started (the hub that ran it prunes its own jobs too). */
const KEEP_MS = 30 * 24 * 3600 * 1000;

export interface RemoteJob {
  job_id: string;
  hub_id: string;
  /** The hub's name when the job was started (the member list has its name now). */
  hub_name: string;
  op: string;
  /** `out` field -> the path of this machine the file was asked for; null when the op left nothing to pull. */
  wants: Record<string, string> | null;
  spool: string | null;
  /** The spool's directory at the hub that runs the job, once it was listed. */
  spool_root: string | null;
  pulled_at: string | null;
  created_at: string;
}

interface Row {
  job_id: string;
  hub_id: string;
  hub_name: string;
  op: string;
  wants: string | null;
  spool: string | null;
  spool_root: string | null;
  pulled_at: string | null;
  created_at: string;
}

const fromRow = (r: Row): RemoteJob => ({ ...r, wants: r.wants ? (JSON.parse(r.wants) as Record<string, string>) : null });

export function rememberJob(db: Db, j: Pick<RemoteJob, 'job_id' | 'hub_id' | 'hub_name' | 'op'> & Partial<Pick<RemoteJob, 'wants' | 'spool'>>): RemoteJob {
  const wants = j.wants && Object.keys(j.wants).length ? JSON.stringify(j.wants) : null;
  db.prepare(
    `INSERT INTO peer_jobs (job_id, hub_id, hub_name, op, wants, spool, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET hub_id = excluded.hub_id, hub_name = excluded.hub_name`,
  ).run(j.job_id, j.hub_id, j.hub_name, j.op, wants, wants ? (j.spool ?? null) : null, new Date().toISOString());
  return remoteJob(db, j.job_id)!;
}

export function remoteJob(db: Db, jobId: string): RemoteJob | null {
  const r = db.prepare('SELECT * FROM peer_jobs WHERE job_id = ?').get(jobId) as Row | undefined;
  return r ? fromRow(r) : null;
}

export function markPulled(db: Db, jobId: string, spoolRoot: string): void {
  db.prepare('UPDATE peer_jobs SET pulled_at = ?, spool_root = ? WHERE job_id = ?').run(new Date().toISOString(), spoolRoot, jobId);
}

/** Jobs whose files this hub has not pulled yet, newest first: followed again after a restart. */
export function unpulledJobs(db: Db, sinceMs: number): RemoteJob[] {
  return (db.prepare('SELECT * FROM peer_jobs WHERE wants IS NOT NULL AND pulled_at IS NULL AND created_at > ? ORDER BY created_at DESC LIMIT 50').all(new Date(Date.now() - sinceMs).toISOString()) as Row[]).map(fromRow);
}

export function pruneRemoteJobs(db: Db, now = Date.now()): number {
  return db.prepare('DELETE FROM peer_jobs WHERE created_at < ?').run(new Date(now - KEEP_MS).toISOString()).changes;
}
