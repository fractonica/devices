import Database from 'better-sqlite3';

import { runSlot, slotRun } from '@fractonica/protocol';

export type Db = Database.Database;

/**
 * The registry table (spec 08 §8.8, design c3 §4): columns as context.ts Device, tags a JSON array, provision
 * the JSON provision record (never a secret). addr is NULL until provisioned and never reused; alias and addr
 * are unique. `role` takes protocol DEVICE_ROLES; `fixture` came with M2-C1 (design m2-c1-hil D6), and an
 * older database's CHECK is widened by rebuilding the table (migrateRoleCheck).
 */
function devicesTable(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
     device_id TEXT PRIMARY KEY, addr INTEGER UNIQUE CHECK (addr BETWEEN 1 AND 61439),
     alias TEXT NOT NULL UNIQUE COLLATE NOCASE, alias_rev INTEGER NOT NULL DEFAULT 0,
     net INTEGER, board TEXT, profile TEXT, chip TEXT, tags TEXT NOT NULL DEFAULT '[]',
     role TEXT NOT NULL DEFAULT 'node' CHECK (role IN ('node', 'gateway', 'fixture')), fw_id TEXT,
     provisioned INTEGER NOT NULL DEFAULT 0, last_seen TEXT, last_epoch INTEGER, created_at TEXT NOT NULL,
     provision TEXT, network TEXT NOT NULL DEFAULT 'default', hubs TEXT)`;
}

/**
 * The networks table (design csi-c1 D4): one row per named network (`default` is the one of hubs before csi-c1), each
 * with its band; net_id is the fleet's, the same in every row (network.ts). `id` stays the rowid, as before csi-c1.
 */
function networksTable(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
     id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE DEFAULT 'default', ssid TEXT NOT NULL, bssid TEXT, country TEXT,
     band TEXT NOT NULL DEFAULT 'auto' CHECK (band IN ('auto', '2g', '5g')), updated_at TEXT NOT NULL,
     net_id INTEGER CHECK (net_id BETWEEN 1 AND 65535), hub_host TEXT)`;
}

/**
 * PRAGMA user_version: the schema changes ADD COLUMN cannot make, done once each. 0 is every database before
 * M2-C1; 1 has the `fixture` role (migrateRoleCheck); 2 has named networks (migrateNetworks, design csi-c1 D4).
 */
export const DB_SCHEMA_VERSION = 2;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS logs (
     seq INTEGER PRIMARY KEY, run INTEGER NOT NULL, ts_us INTEGER NOT NULL, device TEXT NOT NULL,
     port TEXT NOT NULL, level TEXT, tag TEXT, kind TEXT NOT NULL, text TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS logs_device ON logs(device, seq)`,
  `CREATE TABLE IF NOT EXISTS jobs (
     job_id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL)`,
  // Retention (retention.ts) picks the oldest finished jobs; job_list reads newest first.
  `CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at)`,
  `CREATE TABLE IF NOT EXISTS job_logs (
     job_id TEXT NOT NULL, line INTEGER NOT NULL, ts TEXT NOT NULL, stream TEXT NOT NULL, text TEXT NOT NULL,
     PRIMARY KEY (job_id, line))`,
  `CREATE TABLE IF NOT EXISTS artifacts (
     build_id TEXT PRIMARY KEY, source_dir TEXT NOT NULL, profile TEXT NOT NULL, build_type TEXT NOT NULL,
     fw_id TEXT NOT NULL, built_at TEXT NOT NULL, manifest_path TEXT NOT NULL)`,
  networksTable('networks'),
  `CREATE TABLE IF NOT EXISTS ports_seen (
     usb_serial TEXT PRIMARY KEY, last_path TEXT NOT NULL, vid TEXT, pid TEXT, last_seen TEXT NOT NULL)`,
  // The registry (devicesTable).
  devicesTable('devices'),
  // Hub events (spec 08 §8.7): a ring in the cursor space it shares with logs (seq.ts, ring.ts).
  `CREATE TABLE IF NOT EXISTS events (
     seq INTEGER PRIMARY KEY, run INTEGER NOT NULL, ts_us INTEGER NOT NULL, t_hub_us INTEGER NOT NULL,
     type TEXT NOT NULL, device TEXT, json TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS events_device ON events(device, seq)`,
  `CREATE INDEX IF NOT EXISTS events_type ON events(type, seq)`,
  // OTA child jobs (design c4 §4, ota/orchestrator.ts): one row per device and ota_deploy, `json` the
  // OtaRecord (state, attempt, bytes, timings) that ota_status answers; the parent is an ordinary job.
  `CREATE TABLE IF NOT EXISTS ota_jobs (
     job_id TEXT PRIMARY KEY, parent TEXT NOT NULL, device TEXT NOT NULL, state TEXT NOT NULL,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ota_jobs_device ON ota_jobs(device, created_at)`,
  `CREATE INDEX IF NOT EXISTS ota_jobs_parent ON ota_jobs(parent)`,
  // Bindings (design c5 §4, bindings/): one row per source device and slot, as context.ts BindingRow.
  // from_spec/to_spec are binding_set's from/to as given (FROM and TO are SQL keywords); target_id the
  // target device (NULL: broadcast), so a change at the target end finds the rows to re-resolve; args the
  // JSON, binding the hex of the encoded Binding pushed with fr.node.bind_set; pushed_at NULL while a push
  // is due.
  `CREATE TABLE IF NOT EXISTS bindings (
     device_id TEXT NOT NULL, slot INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 15),
     from_spec TEXT NOT NULL, to_spec TEXT NOT NULL, target_id TEXT, args TEXT, binding TEXT NOT NULL,
     pushed_at TEXT, PRIMARY KEY (device_id, slot))`,
  `CREATE INDEX IF NOT EXISTS bindings_target ON bindings(target_id)`,
  // POWER-1 (design power-p1 D9; power/cells.ts): the user's named cells, where each is installed (`until` NULL while
  // it is there), its samples (thinned: one row per 10 s unless the voltage moved 10 mV or the charger changed) and its
  // sessions (a charge, a discharge in use, a capacity test; `curve` JSON `[t_s, mv]` points, `ended` NULL while open).
  `CREATE TABLE IF NOT EXISTS cells (
     id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
     chemistry TEXT NOT NULL CHECK (chemistry IN ('liion', 'lifepo4', 'lic')), nominal_mah REAL, notes TEXT,
     created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cell_installs (
     id INTEGER PRIMARY KEY, cell INTEGER NOT NULL, device TEXT NOT NULL, instance TEXT NOT NULL,
     since TEXT NOT NULL, until TEXT)`,
  `CREATE INDEX IF NOT EXISTS cell_installs_cell ON cell_installs(cell, id)`,
  `CREATE INDEX IF NOT EXISTS cell_installs_place ON cell_installs(device, instance, id)`,
  `CREATE TABLE IF NOT EXISTS cell_samples (
     cell INTEGER NOT NULL, ts_ms INTEGER NOT NULL, mv INTEGER NOT NULL, charger TEXT, load INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS cell_samples_cell ON cell_samples(cell, ts_ms)`,
  `CREATE TABLE IF NOT EXISTS cell_sessions (
     id INTEGER PRIMARY KEY, cell INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('charge', 'discharge', 'test')),
     device TEXT NOT NULL, instance TEXT NOT NULL, started TEXT NOT NULL, ended TEXT, start_mv INTEGER, end_mv INTEGER,
     duration_s REAL, complete INTEGER NOT NULL DEFAULT 0, mah REAL, wh REAL, r_int_mohm REAL, curve TEXT, json TEXT)`,
  `CREATE INDEX IF NOT EXISTS cell_sessions_cell ON cell_sessions(cell, kind, id)`,
  // WIRING-1 (design wiring-w1 D3; wiring/state.ts): a row per wiring-guide step done, and the parts on hand (`value`
  // '' for a part that comes in no values).
  `CREATE TABLE IF NOT EXISTS wiring_progress (
     guide TEXT NOT NULL, step TEXT NOT NULL, done_at TEXT NOT NULL, PRIMARY KEY (guide, step))`,
  `CREATE TABLE IF NOT EXISTS parts_stock (
     part TEXT NOT NULL, value TEXT NOT NULL DEFAULT '', qty INTEGER NOT NULL CHECK (qty >= 0), location TEXT,
     note TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (part, value))`,
  // The hubs' link (design multi-hub-m2 §4; peers/members.ts): the hubs of this hub's network as the registrar keeps
  // them (this hub included; slot 0 is the registrar). `addr` and `link_port` are what a hub gave when it joined;
  // seen_addr, seen_port and seen_at are this hub's own (where a peer's link last came from) and are not replicated.
  // Never the network key: that is in secrets.json only.
  `CREATE TABLE IF NOT EXISTS hub_members (
     hub_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, host TEXT NOT NULL, addr TEXT, link_port INTEGER NOT NULL,
     slot INTEGER NOT NULL UNIQUE CHECK (slot BETWEEN 0 AND 3), joined_at TEXT NOT NULL,
     seen_addr TEXT, seen_port INTEGER, seen_at TEXT)`,
  // Jobs that run at another hub of the network because an op was passed on there (design multi-hub-m2 §7.3;
  // peers/remote-jobs.ts): which hub, and the files this hub still has to pull when the job ends (`wants`: out field ->
  // the path of this machine it was asked for; `spool`: where that hub writes them; `spool_root`: its directory there).
  `CREATE TABLE IF NOT EXISTS peer_jobs (
     job_id TEXT PRIMARY KEY, hub_id TEXT NOT NULL, hub_name TEXT NOT NULL, op TEXT NOT NULL,
     wants TEXT, spool TEXT, spool_root TEXT, pulled_at TEXT, created_at TEXT NOT NULL)`,
  // One registry across the hubs of a network (design multi-hub-m2 §5, §16; registry/sync.ts): one row per device of
  // the network, beside `devices` (whose columns did not change, so a hub of an older version opens this file as
  // before and ignores this table). `row_rev` and `row_hub`: the rev of the row's last write and the hub that made it;
  // the alias, the hub list and the firmware id have their own (`*_at`, `*_hub`). `core`, `alias_v`, `hubs_v`, `fw_v`:
  // the values those revs stand for, so a change in `devices` that nobody stamped is found by comparing. `gone` 1: a
  // tombstone (the row was deleted at `row_rev`; `alias` is the name it had). `hash`: what two hubs compare.
  `CREATE TABLE IF NOT EXISTS registry_sync (
     device_id TEXT PRIMARY KEY, gone INTEGER NOT NULL DEFAULT 0, gone_at TEXT, alias TEXT,
     row_rev INTEGER NOT NULL, row_hub TEXT NOT NULL, core TEXT,
     alias_at INTEGER, alias_hub TEXT, alias_v TEXT, hubs_at INTEGER, hubs_hub TEXT, hubs_v TEXT,
     fw_at INTEGER, fw_hub TEXT, fw_v TEXT, hash TEXT NOT NULL)`,
];

/** Columns added to tables that earlier hubs created (CREATE TABLE IF NOT EXISTS leaves those as they were). */
const ADDED_COLUMNS: { table: string; column: string; decl: string }[] = [
  // C3: the network id nodes are provisioned with and the hub's mDNS name (network.ts fills both).
  { table: 'networks', column: 'net_id', decl: 'INTEGER CHECK (net_id BETWEEN 1 AND 65535)' },
  { table: 'networks', column: 'hub_host', decl: 'TEXT' },
  // C4: a fault build's kind (spec 03 §3.8; NULL for every other build): implicit picks skip those rows.
  { table: 'artifacts', column: 'fault', decl: 'TEXT' },
  // C6: who started a job (design c6 D18: the X-Fr-Client header, cli|mcp|dashboard|app; NULL without
  // one), so job_list filters in SQL. The json keeps it too.
  { table: 'jobs', column: 'origin', decl: 'TEXT' },
  // CSI-1 (design csi-c1 D5): the network a device's fr_ident names.
  { table: 'devices', column: 'network', decl: "TEXT NOT NULL DEFAULT 'default'" },
  // The port policy (ports/policy.ts): the device a port was last seen carrying (a bridge port's HELLO, a provision's
  // probe), so in mode adopted a known board's port is opened again after a re-plug.
  { table: 'ports_seen', column: 'device_id', decl: 'TEXT' },
  // Design multi-hub-m1: a board's hub list as device_hubs_set pushed it (JSON {rev, hubs, set_at}; NULL: none).
  { table: 'devices', column: 'hubs', decl: 'TEXT' },
  // A bridge port's adapter when device_id was recorded (`vid:pid:serial`, serialport's identity of the adapter): a
  // different adapter in the same USB socket is not taken for that board (ports/policy.ts).
  { table: 'ports_seen', column: 'device_port', decl: 'TEXT' },
];

/**
 * Version 1 (design m2-c1-hil D6): the devices CHECK gains `fixture`. SQLite cannot alter a CHECK, so a table
 * created before it is rebuilt (create the new table, copy every row, drop the old one, rename) in one
 * transaction; rows, the unique alias and addr, and their values are kept. A database whose table already
 * has the new CHECK (a fresh one) is only stamped.
 */
function migrateRoleCheck(db: Db): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'devices'").get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'fixture'")) {
    return;
  }
  const old = (db.prepare('PRAGMA table_info(devices)').all() as { name: string }[]).map((c) => c.name);
  db.exec(devicesTable('devices_v1'));
  const fresh = new Set((db.prepare('PRAGMA table_info(devices_v1)').all() as { name: string }[]).map((c) => c.name));
  const cols = old.filter((c) => fresh.has(c)).join(', ');
  db.exec(`INSERT INTO devices_v1 (${cols}) SELECT ${cols} FROM devices`);
  db.exec('DROP TABLE devices');
  db.exec('ALTER TABLE devices_v1 RENAME TO devices');
}

/**
 * Version 2 (design csi-c1 D4): the single-row networks table (`CHECK (id = 1)`) becomes one row per named network.
 * Its row becomes `default` (band auto), keeping id, ssid, bssid, country, updated_at, net_id and hub_host.
 */
function migrateNetworks(db: Db): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'networks'").get() as { sql: string } | undefined;
  if (!row || !/CHECK\s*\(\s*id\s*=\s*1\s*\)/i.test(row.sql)) {
    return;
  }
  const old = new Set((db.prepare('PRAGMA table_info(networks)').all() as { name: string }[]).map((c) => c.name));
  const cols = ['id', 'ssid', 'bssid', 'country', 'updated_at', 'net_id', 'hub_host'].filter((c) => old.has(c)).join(', ');
  db.exec(networksTable('networks_v2'));
  db.exec(`INSERT INTO networks_v2 (name, band, ${cols}) SELECT 'default', 'auto', ${cols} FROM networks`);
  db.exec('DROP TABLE networks');
  db.exec('ALTER TABLE networks_v2 RENAME TO networks');
}

/** The user_version steps, in order: step i takes a database from version i to i + 1. */
const VERSION_STEPS: ((db: Db) => void)[] = [migrateRoleCheck, migrateNetworks];

export function openDb(file: string): Db {
  const db = new Database(file);
  // Only takes effect on a new, empty database (before its first table): pruning then gives free pages back to the
  // file system (retention.ts). An older database keeps its mode until `fr hub compact`.
  db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  for (const sql of MIGRATIONS) {
    db.exec(sql);
  }
  for (const { table, column, decl } of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let v = version; v < DB_SCHEMA_VERSION; v++) {
    db.transaction(() => {
      VERSION_STEPS[v](db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}

export function kvGet(db: Db, k: string): string | undefined {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as { v: string } | undefined;
  return row?.v;
}

export function kvSet(db: Db, k: string, v: string): void {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
}

/** Writes a kv value and syncs it to the disk before returning: FULL syncs the WAL on commit, and
 * fullfsync makes that F_FULLFSYNC on macOS. */
function kvSetDurable(db: Db, k: string, v: string): void {
  db.pragma('synchronous = FULL');
  db.pragma('fullfsync = ON');
  try {
    kvSet(db, k, v);
  } finally {
    db.pragma('fullfsync = OFF');
    db.pragma('synchronous = NORMAL');
  }
}

/**
 * Increments and returns the hub run counter (part of every cursor). The bump is fsynced (spec 08
 * §8.7): with WAL + synchronous=NORMAL a power loss could roll it back and let a reused run number
 * silently re-base old cursors.
 */
export function nextHubRun(db: Db): number {
  const run = Number(kvGet(db, 'hub_run') ?? '0') + 1;
  kvSetDurable(db, 'hub_run', String(run));
  // In a network of several hubs the run carries this hub's slot (design multi-hub-m2 §17): two hubs then never give
  // one run number, so a cursor is never taken for another hub's. kv keeps the hub's own counter, so a hub that is
  // alone, the registrar (slot 0) and a version from before this count as they always did.
  return slotRun(hubSlot(db) ?? 0, run);
}

/** Whether `run` is one a hub in `slot` gives (hubSlot; null, a hub that is alone, counts as the registrar does). */
export function runInSlot(run: number, slot: number | null): boolean {
  return runSlot(run) === (slot ?? 0);
}

/** An epoch slot's size (design multi-hub-m2 §9): a quarter of the u16 space; a slot's runs are 1..0x3FFF. */
export const EPOCH_SLOT_SIZE = 0x4000;
const EPOCH_SLOT_RUNS = EPOCH_SLOT_SIZE - 1;
/** kv: the epoch slot the registrar gave this hub (0: it is the registrar); absent on a hub that is alone. */
export const HUB_SLOT_KEY = 'hub.slot';

/** This hub's epoch slot (0..3), or null on a hub that holds none. */
export function hubSlot(db: Db): number | null {
  const v = kvGet(db, HUB_SLOT_KEY);
  const n = v === undefined ? NaN : Number(v);
  return Number.isInteger(n) && n >= 0 && n * EPOCH_SLOT_SIZE < 0x10000 ? n : null;
}

/** Whether `epoch` is one a hub in `slot` gives: `slot * 0x4000 + run`, run 1..0x3FFF. */
export function epochInSlot(epoch: number, slot: number): boolean {
  return epoch > slot * EPOCH_SLOT_SIZE && epoch <= slot * EPOCH_SLOT_SIZE + EPOCH_SLOT_RUNS;
}

/**
 * The epoch after `prev` for a hub in `slot` (design multi-hub-m2 §9): `slot * 0x4000 + run`, the run counted from 1 to
 * 0x3FFF and wrapping inside the slot. Two hubs of one network never give one epoch, however often each restarts.
 * A `prev` outside the slot (a hub that just got its slot; a member whose counter MULTI-HUB-1's network_join moved a
 * quarter of the space away from the registrar's) starts the slot's runs at 1: never 0, which a node reads as "no hub
 * yet", and never `slot * 0x4000`, which is no run of any slot.
 */
export function slotEpoch(slot: number, prev: number): number {
  const base = slot * EPOCH_SLOT_SIZE;
  const run = Number.isInteger(prev) && epochInSlot(prev, slot) ? prev - base : 0;
  return base + (run % EPOCH_SLOT_RUNS) + 1;
}

/**
 * Increments and returns the hub epoch, the `epoch` of every hub frame (05 §5.8): a u16 that skips 0
 * when it wraps, so 0 can mean "no hub yet" on a node. Fsynced like the run counter: a rolled-back
 * epoch would let a node's window take this run's frames for replays of the last run's.
 * A hub with an epoch slot (kv `hub.slot`: the registrar gave it one, or it is the registrar of a network another hub
 * joined) counts inside that slot (slotEpoch); a hub that is alone counts the whole space as before.
 */
export function nextHubEpoch(db: Db): number {
  const prev = Number(kvGet(db, 'hub_epoch') ?? '0');
  const slot = hubSlot(db);
  const epoch = slot !== null ? slotEpoch(slot, prev) : Number.isInteger(prev) && prev >= 0 && prev < 0xffff ? prev + 1 : 1;
  kvSetDurable(db, 'hub_epoch', String(epoch));
  return epoch;
}
