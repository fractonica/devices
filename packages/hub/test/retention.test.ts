// Growth of hub.db and hub.log: finished jobs and their logs pruned by age and count (retention.ts), orphan job_logs
// swept, incremental vacuum on a new database, `main.ts --compact` (fr hub compact) refusing while a hub runs and
// shrinking the file otherwise, live-only events (per-frame telemetry) never written, and hub.log rotation by size.
// Every database here is a synthetic one in a temp FR_HOME.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { rotateLog } from '@fractonica/host';
import { CATALOG } from '@fractonica/protocol/gen';

import { openDb } from '../src/db.ts';
import { LIVE_ONLY_STATE } from '../src/router/index.ts';
import { EventStore } from '../src/events/index.ts';
import { autoVacuumMode, compactDb, dbSpace, JobRetention, spaceWarning } from '../src/retention.ts';
import { CursorSeq } from '../src/seq.ts';

const MAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts');
const dir = mkdtempSync(join(tmpdir(), 'fr-retention-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fresh = (name: string) => join(mkdtempSync(join(dir, `${name}-`)), 'hub.db');

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

function addJob(db: ReturnType<typeof openDb>, id: string, createdAt: string, status: string, lines: number): void {
  db.prepare('INSERT INTO jobs (job_id, kind, status, created_at, json) VALUES (?, ?, ?, ?, ?)').run(id, 'build', status, createdAt, JSON.stringify({ job_id: id, status }));
  const ins = db.prepare('INSERT INTO job_logs (job_id, line, ts, stream, text) VALUES (?, ?, ?, ?, ?)');
  for (let i = 1; i <= lines; i++) {
    ins.run(id, i, createdAt, 'out', `line ${i} ${'x'.repeat(200)}`);
  }
}

describe('JobRetention', () => {
  it('deletes finished jobs past the age, keeps queued and working ones, and their logs go with them', async () => {
    const db = openDb(fresh('age'));
    addJob(db, 'j_old_done', daysAgo(40), 'done', 5);
    addJob(db, 'j_old_failed', daysAgo(31), 'failed', 3);
    addJob(db, 'j_old_working', daysAgo(40), 'working', 2);
    addJob(db, 'j_new', daysAgo(1), 'done', 4);
    const r = await new JobRetention(db, () => ({ days: 30, rows: 1000 })).prune();
    expect(r).toMatchObject({ jobs: 2, job_logs: 8, orphan_logs: 0 });
    const ids = (db.prepare('SELECT job_id FROM jobs ORDER BY job_id').all() as { job_id: string }[]).map((x) => x.job_id);
    expect(ids).toEqual(['j_new', 'j_old_working']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM job_logs').get()).toEqual({ n: 6 });
    db.close();
  });

  it('keeps only the newest `rows` jobs, and sweeps job_logs whose job is gone', async () => {
    const db = openDb(fresh('rows'));
    for (let i = 0; i < 50; i++) {
      addJob(db, `j_${String(i).padStart(3, '0')}`, new Date(Date.now() - (50 - i) * 60_000).toISOString(), 'done', 2);
    }
    db.prepare('INSERT INTO job_logs (job_id, line, ts, stream, text) VALUES (?, ?, ?, ?, ?)').run('j_lost', 1, daysAgo(0), 'out', 'orphan');
    const r = await new JobRetention(db, () => ({ days: 30, rows: 10 })).prune();
    expect(r).toMatchObject({ jobs: 40, job_logs: 80, orphan_logs: 1 });
    const ids = (db.prepare('SELECT job_id FROM jobs ORDER BY created_at').all() as { job_id: string }[]).map((x) => x.job_id);
    expect(ids).toEqual(Array.from({ length: 10 }, (_, i) => `j_${String(40 + i).padStart(3, '0')}`));
    db.close();
  });

  it('gives free pages back on a new database (auto_vacuum incremental), not on an old one until compacted', async () => {
    const file = fresh('vacuum');
    const db = openDb(file);
    expect(autoVacuumMode(db)).toBe(2);
    for (let i = 0; i < 200; i++) {
      addJob(db, `j_${i}`, daysAgo(60), 'done', 20);
    }
    db.pragma('wal_checkpoint(TRUNCATE)');
    const r = await new JobRetention(db, () => ({ days: 30, rows: 1000 })).prune();
    expect(r.jobs).toBe(200);
    expect(r.freed_pages).toBeGreaterThan(100);
    db.close();

    // A database made before (auto_vacuum NONE) keeps its free pages until compactDb.
    const Database = (await import('better-sqlite3')).default;
    const legacy = new Database(fresh('legacy'));
    legacy.exec('CREATE TABLE t (x TEXT)'); // a first table before any auto_vacuum pragma: mode NONE for good
    legacy.close();
    const old = openDb(legacy.name);
    expect(autoVacuumMode(old)).toBe(0);
    for (let i = 0; i < 300; i++) {
      addJob(old, `j_${i}`, daysAgo(60), 'done', 40);
    }
    await new JobRetention(old, () => ({ days: 30, rows: 1000 })).prune();
    old.pragma('wal_checkpoint(TRUNCATE)');
    const space = dbSpace(old);
    expect(space.auto_vacuum).toBe('none');
    expect(space.free_bytes).toBeGreaterThan(space.bytes / 2);
    expect(spaceWarning({ ...space, bytes: 400e6, free_bytes: 300e6 })).toMatch(/fr hub compact/);
    expect(spaceWarning({ ...space, auto_vacuum: 'incremental', bytes: 400e6, free_bytes: 300e6 })).toBeNull();
    const c = compactDb(old);
    expect(c.after_bytes).toBeLessThan(c.before_bytes / 2);
    expect(autoVacuumMode(old)).toBe(2);
    old.close();
  });
});

describe('main.ts --compact (fr hub compact)', () => {
  const compact = (home: string) =>
    spawnSync(process.execPath, ['--conditions=@fractonica/source', MAIN, '--compact'], { env: { ...process.env, FR_HOME: home }, encoding: 'utf8', timeout: 60_000 });

  it('compacts a stopped hub home and refuses while hub.lock names a live hub', () => {
    const home = dirname(fresh('home'));
    const db = openDb(join(home, 'hub.db'));
    db.close();
    const ok = compact(home);
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout.trim().split('\n').at(-1)!)).toMatchObject({ ok: true, data: { db: join(home, 'hub.db') } });
    // A stand-in for a running hub: a sleeping node whose command line names packages/hub/src/main.ts (what
    // runningHubPid checks with ps). It opens nothing.
    const decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', join(home, 'packages', 'hub', 'src', 'main.ts')], { stdio: 'ignore' });
    try {
      writeFileSync(join(home, 'hub.lock'), String(decoy.pid));
      const refused = compact(home);
      expect(refused.status).toBe(3);
      expect(JSON.parse(refused.stdout.trim())).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
    } finally {
      decoy.kill();
    }
  });

  it('says so when there is no database yet', () => {
    const home = dirname(fresh('empty'));
    const r = compact(home);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ ok: true, data: { skipped: 'no database yet' } });
    expect(existsSync(join(home, 'hub.db'))).toBe(false);
  });
});

describe('live-only events', () => {
  it('reach subscribers and are never written', () => {
    const db = openDb(fresh('events'));
    const seq = new CursorSeq(db);
    const events = new EventStore(db, seq, 1);
    const seen: string[] = [];
    events.subscribe((e) => seen.push(e.type));
    events.publish({ type: 'cam.frames', device: 'aabbccddeeff', t_hub_us: 1, fields: { frames: 1 }, part: 'state', member: 'frames' }, { durable: false });
    events.publish({ type: 'cam.streaming', device: 'aabbccddeeff', t_hub_us: 2, fields: { streaming: true }, part: 'state', member: 'streaming' });
    events.flush();
    expect(seen).toEqual(['cam.frames', 'cam.streaming']);
    expect(events.query({ limit: 10 }).map((e) => e.type)).toEqual(['cam.streaming']);
    expect(events.liveOnly).toBe(1);
    events.stop();
    db.close();
  });

  it("are the camera's per-frame members (frames, fps_x10, last_bytes), by catalog id", () => {
    const cam = CATALOG.capabilities.find((c) => c.name === 'fr.camera')!;
    expect([...LIVE_ONLY_STATE].sort()).toEqual([`${cam.id}:fps_x10`, `${cam.id}:frames`, `${cam.id}:last_bytes`]);
  });
});

describe('rotateLog', () => {
  it('keeps `keep` old files, renaming or copying and truncating in place', () => {
    const d = mkdtempSync(join(dir, 'log-'));
    const file = join(d, 'hub.log');
    writeFileSync(file, 'a'.repeat(100));
    expect(rotateLog(file, { maxBytes: 200, keep: 2, how: 'rename' })).toBe(false);
    writeFileSync(file, 'b'.repeat(300));
    expect(rotateLog(file, { maxBytes: 200, keep: 2, how: 'rename' })).toBe(true);
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, 'c'.repeat(300));
    expect(rotateLog(file, { maxBytes: 200, keep: 2, how: 'copytruncate' })).toBe(true);
    expect(statSync(file).size).toBe(0);
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('c'.repeat(300));
    expect(readFileSync(`${file}.2`, 'utf8')).toBe('b'.repeat(300));
    writeFileSync(file, 'd'.repeat(300));
    rotateLog(file, { maxBytes: 200, keep: 2, how: 'copytruncate' });
    expect(readFileSync(`${file}.2`, 'utf8')).toBe('c'.repeat(300));
    expect(existsSync(`${file}.3`)).toBe(false);
  });
});
