// One registry across the hubs of a network (design multi-hub-m2 §5, §16), the part that needs no link: what of a
// `devices` row is the network's, the revs that order two copies of it, and the merge of a copy another hub sent.
//
// What is shared, in four parts that are ordered apart (so a rename at one hub and a tag at another both survive):
//   row    addr, net, network, provisioned, tags, board, profile, chip, role        `row_rev` and the hub that wrote it
//   alias  alias and alias_rev                                                        alias_rev, then its own rev
//   hubs   the board's hub list (with the list's own rev, which the board keeps)      its own rev, then the list's
//   fw     fw_id                                                                      its own rev
// What stays this hub's own and never crosses: last_seen, last_epoch, created_at, the provision record (what THIS hub
// wrote into an fr_ident, the port's probe, `for_hub`), the USB port, presence, and rows that are not the network's (a
// board seen only through HELLO, a board of another net id).
//
// A rev is a hybrid clock (kv `registry.clock`): the wall clock in ms, never going back, plus one when two writes meet
// in one ms, and never below a rev this hub has seen from a peer. So "the later write" is the later one by the clock
// when the hubs' clocks agree, and still one order when they do not. The higher rev wins; the higher hub id on a tie.
//
// Nothing here is told what changed. `scan` compares each row of the network with what was last stamped (the table
// `registry_sync` keeps the stamped values) and stamps the parts that differ as this hub's writes. So every writer of
// `devices` replicates without knowing of this module: an op, a job, a HELLO, a hub of an older version that ran on
// this hub.db for a while. A row of the network that is gone from `devices` becomes a tombstone the same way.
//
// Rows from before this step have no rev. The first scan gives them one: 1 on the registrar, 0 on a member (the hub
// list's rev 0 on both, so the list's own rev decides; the firmware id's the time this hub last saw the board, so the
// hub that saw it last decides), so that where two old copies differ the registrar's is kept.
// Two rules stand above the revs:
//   - An address is the registrar's to give and is never replaced by another one through replication: a copy whose
//     addr or net differs from the one this hub holds is not taken, and is reported.
//   - Two boards with one alias: the one whose alias was written later keeps it, the other becomes `<alias>-<3 hex of
//     its id>` with the tag `renamed`.

import { createHash } from 'node:crypto';

import { ALIAS_MAX, aliasProblem, DEFAULT_NETWORK, DEVICE_ROLES, type DeviceRole } from '@fractonica/protocol';

import type { DeviceHubs } from '../context.ts';
import { type Db, kvGet, kvSet } from '../db.ts';
import { fleetNetId, registrarOf } from '../network.ts';

/** The version of the `registry` message and of the rows in it; said in a hub's hello. */
export const REGISTRY_WIRE = 1;
/** The tag of a board that lost its alias to another one given the same alias while two hubs could not see each other. */
export const TAG_RENAMED = 'renamed';
/** A tombstone is kept this long: a hub that was away longer brings a deleted row back with its old copy. */
export const TOMBSTONE_MS = 365 * 24 * 3600 * 1000;
/** The revs of rows from before the registry was replicated: the registrar's copy outranks a member's. */
export const LEGACY_REV_REGISTRAR = 1;
export const LEGACY_REV_MEMBER = 0;

const CLOCK_KEY = 'registry.clock';
const NET_KEY = 'registry.sync_net';

/** A rev and the hub that wrote it. */
export type Stamp = [rev: number, hub: string];

export interface CoreValue {
  addr: number | null;
  net: number | null;
  network: string;
  provisioned: boolean;
  tags: string[];
  board: string | null;
  profile: string | null;
  chip: string | null;
  role: DeviceRole;
}

/** One row as it crosses the link. A tombstone is `id`, `row` and `gone`. Never a secret: no password is in `devices`. */
export interface WireRow {
  id: string;
  /** The row's rev and the hub that wrote it (design multi-hub-m2 §5). */
  row: Stamp;
  gone?: boolean;
  core?: CoreValue;
  alias?: { at: Stamp; alias: string; alias_rev: number };
  hubs?: { at: Stamp; list: DeviceHubs | null };
  fw?: { at: Stamp; fw_id: string | null };
}

/** This hub as the merge needs it. */
export interface SyncSelf {
  hubId: string;
}

interface DevRow {
  device_id: string;
  addr: number | null;
  alias: string;
  alias_rev: number;
  net: number | null;
  board: string | null;
  profile: string | null;
  chip: string | null;
  tags: string;
  role: string;
  fw_id: string | null;
  provisioned: number;
  network: string | null;
  hubs: string | null;
  provision: string | null;
  last_seen: string | null;
}

interface SyncRow {
  device_id: string;
  gone: number;
  gone_at: string | null;
  alias: string | null;
  row_rev: number;
  row_hub: string;
  core: string | null;
  alias_at: number | null;
  alias_hub: string | null;
  alias_v: string | null;
  hubs_at: number | null;
  hubs_hub: string | null;
  hubs_v: string | null;
  fw_at: number | null;
  fw_hub: string | null;
  fw_v: string | null;
  hash: string;
}

const DEV_COLUMNS = 'device_id, addr, alias, alias_rev, net, board, profile, chip, tags, role, fw_id, provisioned, network, hubs, provision, last_seen';

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

// ---- the clock ----

function clock(db: Db): number {
  const n = Number(kvGet(db, CLOCK_KEY) ?? '0');
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** The next rev: the wall clock in ms, or one past the last rev when the clock has not moved past it. */
export function nextRev(db: Db, now: number = Date.now()): number {
  const rev = Math.max(clock(db) + 1, Math.floor(now));
  kvSet(db, CLOCK_KEY, String(rev));
  return rev;
}

/** A rev a peer wrote: this hub's next one is above it. */
function observe(db: Db, rev: number): void {
  if (Number.isSafeInteger(rev) && rev > clock(db)) {
    kvSet(db, CLOCK_KEY, String(rev));
  }
}

// ---- values ----

function parseTags(text: string): string[] {
  try {
    const t: unknown = JSON.parse(text);
    return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function parseHubs(text: string | null): DeviceHubs | null {
  if (!text) {
    return null;
  }
  try {
    const v = JSON.parse(text) as Partial<DeviceHubs> | null;
    if (!v || typeof v.rev !== 'number' || !Array.isArray(v.hubs)) {
      return null;
    }
    return {
      rev: v.rev,
      hubs: v.hubs.filter((h) => !!h && typeof h.host === 'string').map((h) => ({ host: h.host, ip: typeof h.ip === 'string' && h.ip ? h.ip : null })),
      set_at: typeof v.set_at === 'string' ? v.set_at : '',
    };
  } catch {
    return null;
  }
}

const role = (r: string): DeviceRole => ((DEVICE_ROLES as readonly string[]).includes(r) ? (r as DeviceRole) : 'node');

function coreOf(r: DevRow): CoreValue {
  return { addr: r.addr, net: r.net, network: r.network ?? DEFAULT_NETWORK, provisioned: r.provisioned === 1, tags: parseTags(r.tags), board: r.board, profile: r.profile, chip: r.chip, role: role(r.role) };
}

/** The stamped form of each part: one spelling per value, so two hubs that hold the same thing hold the same text. */
const coreText = (c: CoreValue) => JSON.stringify([c.addr, c.net, c.network, c.provisioned ? 1 : 0, c.tags, c.board, c.profile, c.chip, c.role]);
const aliasText = (alias: string, rev: number) => JSON.stringify([alias, rev]);
const hubsText = (h: DeviceHubs | null) => (h ? JSON.stringify([h.rev, h.hubs.map((x) => [x.host, x.ip]), h.set_at]) : 'null');
const fwText = (fw: string | null) => JSON.stringify(fw);

function coreFrom(text: string): CoreValue {
  const [addr, net, network, provisioned, tags, board, profile, chip, r] = JSON.parse(text) as [number | null, number | null, string, number, string[], string | null, string | null, string | null, DeviceRole];
  return { addr, net, network, provisioned: provisioned === 1, tags, board, profile, chip, role: r };
}

function hubsFrom(text: string | null): DeviceHubs | null {
  if (!text || text === 'null') {
    return null;
  }
  const [rev, hubs, set_at] = JSON.parse(text) as [number, [string, string | null][], string];
  return { rev, hubs: hubs.map(([host, ip]) => ({ host, ip })), set_at };
}

/** A sync row as it crosses the link. */
function wireOf(s: SyncRow): WireRow {
  if (s.gone) {
    return { id: s.device_id, row: [s.row_rev, s.row_hub], gone: true };
  }
  const [alias, alias_rev] = JSON.parse(s.alias_v ?? '["",0]') as [string, number];
  return {
    id: s.device_id,
    row: [s.row_rev, s.row_hub],
    core: coreFrom(s.core!),
    alias: { at: [s.alias_at ?? 0, s.alias_hub ?? ''], alias, alias_rev },
    hubs: { at: [s.hubs_at ?? 0, s.hubs_hub ?? ''], list: hubsFrom(s.hubs_v) },
    fw: { at: [s.fw_at ?? 0, s.fw_hub ?? ''], fw_id: JSON.parse(s.fw_v ?? 'null') as string | null },
  };
}

/** What two hubs compare: every stamp and every stamped value of the row. */
function hashOf(s: Omit<SyncRow, 'hash'>): string {
  return s.gone
    ? sha(JSON.stringify(['gone', s.row_rev, s.row_hub]))
    : sha(JSON.stringify([s.row_rev, s.row_hub, s.core, s.alias_at, s.alias_hub, s.alias_v, s.hubs_at, s.hubs_hub, s.hubs_v, s.fw_at, s.fw_hub, s.fw_v]));
}

/** The digest hash of a row as a peer sent it: equal to this hub's own for the row when the two hold the same. */
export function wireHash(w: WireRow): string {
  if (w.gone) {
    return sha(JSON.stringify(['gone', w.row[0], w.row[1]]));
  }
  return sha(
    JSON.stringify([
      w.row[0],
      w.row[1],
      coreText(w.core!),
      w.alias!.at[0],
      w.alias!.at[1],
      aliasText(w.alias!.alias, w.alias!.alias_rev),
      w.hubs?.at[0] ?? 0,
      w.hubs?.at[1] ?? '',
      hubsText(w.hubs?.list ?? null),
      w.fw?.at[0] ?? 0,
      w.fw?.at[1] ?? '',
      fwText(w.fw?.fw_id ?? null),
    ]),
  );
}

// ---- the table ----

const syncRow = (db: Db, id: string) => db.prepare('SELECT * FROM registry_sync WHERE device_id = ?').get(id) as SyncRow | undefined;
const devRow = (db: Db, id: string) => db.prepare(`SELECT ${DEV_COLUMNS} FROM devices WHERE device_id = ?`).get(id) as DevRow | undefined;

function putSync(db: Db, s: Omit<SyncRow, 'hash'>): SyncRow {
  const full: SyncRow = { ...s, hash: hashOf(s) };
  db.prepare(
    `INSERT INTO registry_sync (device_id, gone, gone_at, alias, row_rev, row_hub, core, alias_at, alias_hub, alias_v, hubs_at, hubs_hub, hubs_v, fw_at, fw_hub, fw_v, hash)
     VALUES (@device_id, @gone, @gone_at, @alias, @row_rev, @row_hub, @core, @alias_at, @alias_hub, @alias_v, @hubs_at, @hubs_hub, @hubs_v, @fw_at, @fw_hub, @fw_v, @hash)
     ON CONFLICT(device_id) DO UPDATE SET gone = excluded.gone, gone_at = excluded.gone_at, alias = excluded.alias, row_rev = excluded.row_rev, row_hub = excluded.row_hub,
       core = excluded.core, alias_at = excluded.alias_at, alias_hub = excluded.alias_hub, alias_v = excluded.alias_v, hubs_at = excluded.hubs_at, hubs_hub = excluded.hubs_hub,
       hubs_v = excluded.hubs_v, fw_at = excluded.fw_at, fw_hub = excluded.fw_hub, fw_v = excluded.fw_v, hash = excluded.hash`,
  ).run(full);
  return full;
}

/** Whether a `devices` row is the network's: it holds an address of this hub's net id. */
function ofNetwork(r: DevRow, net: number): boolean {
  return r.addr !== null && r.net === net;
}

/**
 * The sync table belongs to one net id. A hub that joined another network (its net id changed) starts it again: what it
 * held of the old network is not the new one's. Returns whether the rows found now are rows from before replication.
 */
function tableFor(db: Db, net: number): boolean {
  const have = kvGet(db, NET_KEY);
  if (have === String(net)) {
    return false;
  }
  db.prepare('DELETE FROM registry_sync').run();
  kvSet(db, NET_KEY, String(net));
  return true;
}

/** The tag `moved` on a provisioned row of this network said "also at another hub of it" before 2.3: taken off. */
function dropMoved(db: Db, r: DevRow): DevRow {
  const tags = parseTags(r.tags);
  if (r.provisioned !== 1 || !tags.includes('moved')) {
    return r;
  }
  const kept = JSON.stringify(tags.filter((t) => t !== 'moved'));
  db.prepare('UPDATE devices SET tags = ? WHERE device_id = ?').run(kept, r.device_id);
  return { ...r, tags: kept };
}

function fresh(r: DevRow, rev: { row: number; alias: number; hubs: number; fw: number }, hub: string): Omit<SyncRow, 'hash'> {
  return {
    device_id: r.device_id,
    gone: 0,
    gone_at: null,
    alias: r.alias,
    row_rev: rev.row,
    row_hub: hub,
    core: coreText(coreOf(r)),
    alias_at: rev.alias,
    alias_hub: hub,
    alias_v: aliasText(r.alias, r.alias_rev),
    hubs_at: rev.hubs,
    hubs_hub: hub,
    hubs_v: hubsText(parseHubs(r.hubs)),
    fw_at: rev.fw,
    fw_hub: hub,
    fw_v: fwText(r.fw_id),
  };
}

/** One device: its `devices` row against what was last stamped. Returns whether the stamps changed. */
function scanRow(db: Db, self: SyncSelf, net: number, r: DevRow | undefined, s: SyncRow | undefined, legacy: boolean): boolean {
  if (!r) {
    if (!s || s.gone) {
      return false;
    }
    // A row of the network that is gone from `devices`: deleted here. The tombstone carries the rev of the delete.
    putSync(db, { ...s, gone: 1, gone_at: new Date().toISOString(), row_rev: nextRev(db), row_hub: self.hubId, core: null, alias_at: null, alias_hub: null, alias_v: null, hubs_at: null, hubs_hub: null, hubs_v: null, fw_at: null, fw_hub: null, fw_v: null });
    return true;
  }
  if (!s || s.gone) {
    // Not the network's (seen only, another net id): this hub's own. One that is, and has no stamps or a tombstone's:
    // a new row, or a deleted board provisioned again.
    if (!ofNetwork(r, net)) {
      return false;
    }
    if (legacy) {
      // A row from before the registry was replicated. The registrar's copy outranks a member's; the hub list's own
      // rev decides between two lists; the firmware id is the one of the hub that saw the board last (a HELLO is
      // where it comes from), so its rev is that time.
      const row = registrarOf(db) ? LEGACY_REV_MEMBER : LEGACY_REV_REGISTRAR;
      const seen = r.last_seen ? Date.parse(r.last_seen) : NaN;
      putSync(db, fresh(dropMoved(db, r), { row, alias: row, hubs: 0, fw: Number.isFinite(seen) && seen > 0 ? Math.floor(seen) : 0 }, self.hubId));
    } else {
      const rev = nextRev(db);
      putSync(db, fresh(r, { row: rev, alias: rev, hubs: rev, fw: rev }, self.hubId));
    }
    return true;
  }
  const core = coreText(coreOf(r));
  const alias = aliasText(r.alias, r.alias_rev);
  const hubs = hubsText(parseHubs(r.hubs));
  const fw = fwText(r.fw_id);
  if (core === s.core && alias === s.alias_v && hubs === s.hubs_v && fw === s.fw_v) {
    return false;
  }
  const rev = nextRev(db);
  putSync(db, {
    ...s,
    alias: r.alias,
    ...(core !== s.core ? { core, row_rev: rev, row_hub: self.hubId } : {}),
    ...(alias !== s.alias_v ? { alias_v: alias, alias_at: rev, alias_hub: self.hubId } : {}),
    ...(hubs !== s.hubs_v ? { hubs_v: hubs, hubs_at: rev, hubs_hub: self.hubId } : {}),
    ...(fw !== s.fw_v ? { fw_v: fw, fw_at: rev, fw_hub: self.hubId } : {}),
  });
  return true;
}

/**
 * Stamps what changed in `devices` since the last scan as this hub's writes. Returns the device ids whose stamps
 * changed (they are what the peers have not heard yet). Nothing on a hub that has no network record.
 */
export function scan(db: Db, self: SyncSelf, ids?: readonly string[]): string[] {
  const net = fleetNetId(db);
  if (net === null) {
    return [];
  }
  const changed: string[] = [];
  db.transaction(() => {
    const legacy = tableFor(db, net);
    if (ids && !legacy) {
      for (const id of ids) {
        if (scanRow(db, self, net, devRow(db, id), syncRow(db, id), false)) {
          changed.push(id);
        }
      }
      return;
    }
    const rows = new Map((db.prepare(`SELECT ${DEV_COLUMNS} FROM devices`).all() as DevRow[]).map((r) => [r.device_id, r]));
    const stamped = new Map((db.prepare('SELECT * FROM registry_sync').all() as SyncRow[]).map((s) => [s.device_id, s]));
    for (const id of new Set([...rows.keys(), ...stamped.keys()])) {
      if (scanRow(db, self, net, rows.get(id), stamped.get(id), legacy)) {
        changed.push(id);
      }
    }
  })();
  return changed;
}

/** Tombstones older than TOMBSTONE_MS are dropped. Returns how many. */
export function pruneTombstones(db: Db, now: number = Date.now()): number {
  return db.prepare('DELETE FROM registry_sync WHERE gone = 1 AND gone_at IS NOT NULL AND gone_at < ?').run(new Date(now - TOMBSTONE_MS).toISOString()).changes;
}

// ---- what a peer is told ----

export interface Digest {
  /** One hash over every row: two hubs that hold the same registry say the same. */
  hash: string;
  rows: [id: string, hash: string][];
  /** How many of them are tombstones. */
  tombstones: number;
}

export function digest(db: Db): Digest {
  const rows = db.prepare('SELECT device_id, hash, gone FROM registry_sync ORDER BY device_id').all() as { device_id: string; hash: string; gone: number }[];
  return { hash: sha(rows.map((r) => `${r.device_id}:${r.hash}`).join(',')), rows: rows.map((r) => [r.device_id, r.hash]), tombstones: rows.filter((r) => r.gone).length };
}

export function wireRows(db: Db, ids: readonly string[]): WireRow[] {
  const out: WireRow[] = [];
  for (const id of ids) {
    const s = syncRow(db, id);
    if (s) {
      out.push(wireOf(s));
    }
  }
  return out;
}

/** The stamps of one row, for device_get and a test: null for a row that is this hub's own. */
export function rowStamps(db: Db, id: string): { row_rev: number; row_hub: string; gone: boolean; hash: string } | null {
  const s = syncRow(db, id);
  return s ? { row_rev: s.row_rev, row_hub: s.row_hub, gone: s.gone === 1, hash: s.hash } : null;
}

// ---- the merge ----

/** Something a merge did that the hub acts on: an event, a push of the new alias to a board it holds. */
export type Effect =
  | { kind: 'new'; device: string; alias: string; addr: number | null; provisioned: boolean }
  | { kind: 'alias'; device: string; alias: string; alias_rev: number; previous: string; renamed: boolean }
  /** `provisioned`: the row became a provisioned board with an address here (it was not one before): its addr. */
  | { kind: 'row'; device: string; alias: string; addr_changed: boolean; provisioned?: number }
  | { kind: 'gone'; device: string; alias: string };

/** A copy that was not taken, and why: the two hubs then disagree until a person settles it. */
export interface Conflict {
  kind: 'addr' | 'addr_held' | 'net' | 'bad';
  device: string;
  message: string;
}

export interface ApplyReport {
  /** Rows of the message this hub now holds as they were sent. */
  taken: number;
  /** Device ids whose stamps changed here. */
  changed: string[];
  /** Device ids this hub holds otherwise than the sender (newer here, merged, renamed, in conflict): it is told. */
  differ: string[];
  effects: Effect[];
  conflicts: Conflict[];
}

const cmp = (a: number | string, b: number | string) => (a < b ? -1 : a > b ? 1 : 0);
const cmpStamp = (a: Stamp, b: Stamp) => cmp(a[0], b[0]) || cmp(a[1], b[1]);

const TAG_RE = /^[a-z0-9][a-z0-9_.-]{0,30}$/;
const label = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null);
const stamp = (v: unknown): Stamp | null =>
  Array.isArray(v) && v.length === 2 && Number.isSafeInteger(v[0]) && (v[0] as number) >= 0 && typeof v[1] === 'string' && /^[0-9a-f]{0,12}$/.test(v[1]) ? [v[0] as number, v[1]] : null;

/** A row as a peer sent it, checked field by field; null for one this hub cannot hold. */
function checked(w: WireRow): WireRow | null {
  const row = stamp(w?.row);
  if (!w || typeof w.id !== 'string' || !/^[0-9a-f]{12}$/.test(w.id) || !row) {
    return null;
  }
  if (w.gone === true) {
    return { id: w.id, row, gone: true };
  }
  const c = w.core;
  const a = w.alias;
  const aliasAt = stamp(a?.at);
  if (!c || !a || !aliasAt || typeof a.alias !== 'string' || aliasProblem(a.alias) || !Number.isSafeInteger(a.alias_rev) || a.alias_rev < 0 || a.alias_rev > 0xffffffff) {
    return null;
  }
  const addr = c.addr === null ? null : Number.isInteger(c.addr) && c.addr >= 1 && c.addr <= 0xefff ? c.addr : undefined;
  const net = c.net === null ? null : Number.isInteger(c.net) && c.net >= 1 && c.net <= 0xffff ? c.net : undefined;
  if (addr === undefined || net === undefined || !Array.isArray(c.tags) || c.tags.length > 64 || !c.tags.every((t) => typeof t === 'string' && TAG_RE.test(t))) {
    return null;
  }
  const hubsAt = stamp(w.hubs?.at) ?? [0, ''];
  const fwAt = stamp(w.fw?.at) ?? [0, ''];
  const list = w.hubs?.list ? parseHubs(JSON.stringify(w.hubs.list)) : null;
  const fw = w.fw?.fw_id;
  return {
    id: w.id,
    row,
    core: {
      addr,
      net,
      network: label(c.network) ?? DEFAULT_NETWORK,
      provisioned: c.provisioned === true,
      tags: [...c.tags],
      board: label(c.board),
      profile: label(c.profile),
      chip: label(c.chip),
      role: role(String(c.role)),
    },
    alias: { at: aliasAt, alias: a.alias.toLowerCase(), alias_rev: a.alias_rev },
    hubs: { at: hubsAt, list: list && list.hubs.length <= 8 ? list : null },
    fw: { at: fwAt, fw_id: typeof fw === 'string' && /^[0-9a-f]{8,64}$/.test(fw) ? fw : null },
  };
}

/** An address a row of the network holds is never handed out by this hub, should it allocate (store.ts allocateAddr). */
function retire(db: Db, addr: number | null): void {
  if (addr !== null && addr > Number(kvGet(db, 'registry.addr_hwm') ?? '0')) {
    kvSet(db, 'registry.addr_hwm', String(addr));
  }
}

const otherWithAlias = (db: Db, alias: string, except: string) => db.prepare(`SELECT ${DEV_COLUMNS} FROM devices WHERE alias = ? AND device_id != ?`).get(alias, except) as DevRow | undefined;
const otherWithAddr = (db: Db, addr: number, except: string) => db.prepare('SELECT device_id, alias, net FROM devices WHERE addr = ? AND device_id != ?').get(addr, except) as { device_id: string; alias: string; net: number | null } | undefined;

/** `<alias>-<3 hex of the device id>`, with more of the id while another device holds that too. */
export function renamedAlias(db: Db, alias: string, deviceId: string): string {
  for (let n = 3; n <= 12; n++) {
    const suffix = `-${deviceId.slice(-n)}`;
    const a = `${alias.slice(0, ALIAS_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!aliasProblem(a) && !otherWithAlias(db, a, deviceId)) {
      return a;
    }
  }
  return `node-${deviceId}`;
}

function addTag(tagsJson: string, tag: string): string {
  const tags = parseTags(tagsJson);
  return JSON.stringify(tags.includes(tag) ? tags : [...tags, tag]);
}

/**
 * Two boards, one alias (design multi-hub-m2 §5): the incoming row `w` wants an alias the local row `other` holds. The
 * one whose alias was written later keeps it; a row that is this hub's own (never the network's) always gives way; with
 * nothing to tell them apart the lower device id keeps it. The other becomes `<alias>-<3 hex>` tagged `renamed`.
 * Returns the alias `w` is stored under.
 */
function settleAlias(db: Db, self: SyncSelf, w: WireRow, other: DevRow, report: ApplyReport): { alias: string; alias_rev: number; renamed: boolean } {
  const want = w.alias!;
  const so = syncRow(db, other.device_id);
  const theirs: Stamp = so && !so.gone && so.alias_at !== null ? [so.alias_at, so.alias_hub ?? ''] : [-1, ''];
  const order = cmpStamp(want.at, theirs) || cmp(other.device_id, w.id);
  if (order > 0) {
    // The local board gives way. It is renamed as a write of this hub, which every hub that sees both rows makes alike.
    const to = renamedAlias(db, other.alias, other.device_id);
    const rev = Math.min(other.alias_rev + 1, 0xffffffff);
    db.prepare('UPDATE devices SET alias = ?, alias_rev = ?, tags = ? WHERE device_id = ?').run(to, rev, addTag(other.tags, TAG_RENAMED), other.device_id);
    report.effects.push({ kind: 'alias', device: other.device_id, alias: to, alias_rev: rev, previous: other.alias, renamed: true });
    return { alias: want.alias, alias_rev: want.alias_rev, renamed: false };
  }
  return { alias: renamedAlias(db, want.alias, w.id), alias_rev: Math.min(want.alias_rev + 1, 0xffffffff), renamed: true };
}

/** The provision record of a row that was "flashed for another hub" and is this network's after all: no `for_hub`. */
function recordInNetwork(text: string | null): string | null {
  if (!text?.includes('"for_hub"')) {
    return text;
  }
  try {
    const rec = JSON.parse(text) as { for_hub?: string; shared_with?: string[] };
    if (typeof rec.for_hub !== 'string') {
      return text;
    }
    const { for_hub, ...rest } = rec;
    return JSON.stringify({ ...rest, shared_with: [...new Set([...(rec.shared_with ?? []), for_hub])] });
  } catch {
    return text;
  }
}

function applyRow(db: Db, self: SyncSelf, net: number, sent: WireRow, from: string, report: ApplyReport): void {
  const w = checked(sent);
  if (!w) {
    report.conflicts.push({ kind: 'bad', device: typeof sent?.id === 'string' ? sent.id.slice(0, 12) : '?', message: `hub ${from} sent a row this hub cannot read: left out` });
    return;
  }
  const theirs = wireHash(w);
  // What this hub wrote and has not stamped yet is stamped first, so it is ordered against the copy that arrived.
  const before = syncRow(db, w.id)?.hash ?? null;
  scanRow(db, self, net, devRow(db, w.id), syncRow(db, w.id), false);
  for (const s of [w.row, w.alias?.at, w.hubs?.at, w.fw?.at]) {
    if (s) {
      observe(db, s[0]);
    }
  }
  const s = syncRow(db, w.id);
  const r = devRow(db, w.id);

  const done = () => {
    const now = syncRow(db, w.id)?.hash ?? null;
    if (now !== before) {
      report.changed.push(w.id);
    }
    if (now === theirs) {
      report.taken++;
    } else {
      report.differ.push(w.id);
    }
  };

  if (w.gone) {
    if (s && cmpStamp([s.row_rev, s.row_hub], w.row) >= 0) {
      return done(); // deleted here too and no earlier, or written again since that delete
    }
    if (s && !s.gone && r) {
      db.prepare('DELETE FROM devices WHERE device_id = ?').run(w.id);
      report.effects.push({ kind: 'gone', device: w.id, alias: r.alias });
    }
    putSync(db, { device_id: w.id, gone: 1, gone_at: new Date().toISOString(), alias: r?.alias ?? s?.alias ?? null, row_rev: w.row[0], row_hub: w.row[1], core: null, alias_at: null, alias_hub: null, alias_v: null, hubs_at: null, hubs_hub: null, hubs_v: null, fw_at: null, fw_hub: null, fw_v: null });
    return done();
  }

  const c = w.core!;
  if (c.net !== null && c.net !== net) {
    report.conflicts.push({ kind: 'net', device: w.id, message: `hub ${from} holds ${w.alias!.alias} (${w.id}) under net id ${c.net}, not this network's ${net}: left out` });
    return done();
  }

  if (!s || s.gone) {
    if (s?.gone && cmpStamp([s.row_rev, s.row_hub], w.row) >= 0) {
      return done(); // deleted here after that copy was written: it stays deleted, and the sender hears of it
    }
    // A row this hub does not hold as the network's: new here, or its own row of the same board (seen only, flashed
    // for another hub, another net id). The network's identity takes that row's place, as device_share's did.
    const held = c.addr === null ? undefined : otherWithAddr(db, c.addr, w.id);
    if (held) {
      report.conflicts.push({ kind: 'addr_held', device: w.id, message: `hub ${from} holds ${w.alias!.alias} (${w.id}) at addr ${c.addr}, which ${held.alias} (${held.device_id}) holds on this hub${held.net !== net ? ` under net id ${String(held.net)}` : ''}: the row was not taken` });
      return done();
    }
    const clash = otherWithAlias(db, w.alias!.alias, w.id);
    const named = clash ? settleAlias(db, self, w, clash, report) : { alias: w.alias!.alias, alias_rev: w.alias!.alias_rev, renamed: false };
    const tags = JSON.stringify(named.renamed && !c.tags.includes(TAG_RENAMED) ? [...c.tags, TAG_RENAMED] : c.tags);
    const hubs = w.hubs?.list ? JSON.stringify(w.hubs.list) : null;
    if (r) {
      db.prepare(
        `UPDATE devices SET addr = ?, alias = ?, alias_rev = ?, net = ?, network = ?, provisioned = ?, tags = ?, board = COALESCE(?, board), profile = COALESCE(?, profile),
           chip = COALESCE(?, chip), role = ?, fw_id = COALESCE(?, fw_id), hubs = ?, provision = ? WHERE device_id = ?`,
      ).run(c.addr, named.alias, Math.max(named.alias_rev, r.alias_rev), c.net, c.network, c.provisioned ? 1 : 0, tags, c.board, c.profile, c.chip, c.role, w.fw?.fw_id ?? null, hubs, recordInNetwork(r.provision), w.id);
    } else {
      db.prepare(
        `INSERT INTO devices (device_id, addr, alias, alias_rev, net, network, provisioned, tags, board, profile, chip, role, fw_id, hubs, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(w.id, c.addr, named.alias, named.alias_rev, c.net, c.network, c.provisioned ? 1 : 0, tags, c.board, c.profile, c.chip, c.role, w.fw?.fw_id ?? null, hubs, new Date().toISOString());
    }
    // Stamped as it was sent; what this hub made of it otherwise (a rename, a value it kept) is stamped as its own write.
    putSync(db, {
      device_id: w.id,
      gone: 0,
      gone_at: null,
      alias: named.alias,
      row_rev: w.row[0],
      row_hub: w.row[1],
      core: coreText(c),
      alias_at: w.alias!.at[0],
      alias_hub: w.alias!.at[1],
      alias_v: aliasText(w.alias!.alias, w.alias!.alias_rev),
      hubs_at: w.hubs!.at[0],
      hubs_hub: w.hubs!.at[1],
      hubs_v: hubsText(w.hubs!.list),
      fw_at: w.fw!.at[0],
      fw_hub: w.fw!.at[1],
      fw_v: fwText(w.fw!.fw_id),
    });
    retire(db, c.addr);
    scanRow(db, self, net, devRow(db, w.id), syncRow(db, w.id), false);
    report.effects.push({ kind: 'new', device: w.id, alias: named.alias, addr: c.addr, provisioned: c.provisioned });
    return done();
  }

  // Both hold it: each part by its own order.
  const next: Omit<SyncRow, 'hash'> = { ...s };
  const set: string[] = [];
  const args: unknown[] = [];
  let rowChanged = false;
  let addrChanged = false;
  let becameProvisioned = false;
  /** A part's rev was taken, whether or not its value differed. */
  let stamped = false;
  const core = coreText(c);
  const mine = coreFrom(s.core!);
  if (r && mine.addr !== null && c.addr !== null && (mine.addr !== c.addr || mine.net !== c.net)) {
    // An address is never replaced by another through replication, whichever copy is newer: the registrar gave one of
    // them, and a person says which. Both hubs find it and say so; the rest of the row (alias, hub list) still merges.
    report.conflicts.push({ kind: 'addr', device: w.id, message: `${r.alias} (${w.id}) is addr ${mine.addr} here and addr ${c.addr} at hub ${from}: neither copy was changed` });
  } else if (r && (cmpStamp(w.row, [s.row_rev, s.row_hub]) || cmp(core, s.core!)) > 0) {
    const held = c.addr !== null && c.addr !== mine.addr ? otherWithAddr(db, c.addr, w.id) : undefined;
    if (held) {
      report.conflicts.push({ kind: 'addr_held', device: w.id, message: `hub ${from} holds ${r.alias} (${w.id}) at addr ${c.addr}, which ${held.alias} (${held.device_id}) holds on this hub: the row was not changed` });
    } else {
      // The same value under a higher rev (two copies from before 2.3 that agree): the rev is taken, nothing is written.
      if (core !== s.core) {
        set.push('addr = ?', 'net = ?', 'network = ?', 'provisioned = ?', 'tags = ?', 'board = ?', 'profile = ?', 'chip = ?', 'role = ?');
        args.push(c.addr, c.net, c.network, c.provisioned ? 1 : 0, JSON.stringify(c.tags), c.board, c.profile, c.chip, c.role);
        rowChanged = true;
        addrChanged = mine.addr !== c.addr || mine.provisioned !== c.provisioned;
        becameProvisioned = c.provisioned && c.addr !== null && !(mine.provisioned && mine.addr !== null);
      }
      next.core = core;
      next.row_rev = w.row[0];
      next.row_hub = w.row[1];
      stamped = true;
    }
  }
  const [myAlias, myAliasRev] = JSON.parse(s.alias_v!) as [string, number];
  const a = w.alias!;
  let renamedHere = false;
  if (r && (cmp(a.alias_rev, myAliasRev) || cmpStamp(a.at, [s.alias_at ?? 0, s.alias_hub ?? '']) || cmp(a.alias, myAlias)) > 0) {
    const clash = a.alias === myAlias ? undefined : otherWithAlias(db, a.alias, w.id);
    const named = clash ? settleAlias(db, self, w, clash, report) : { alias: a.alias, alias_rev: a.alias_rev, renamed: false };
    if (named.alias !== r.alias || Math.max(named.alias_rev, r.alias_rev) !== r.alias_rev) {
      set.push('alias = ?', 'alias_rev = ?');
      args.push(named.alias, Math.max(named.alias_rev, r.alias_rev));
    }
    stamped = true;
    next.alias_v = aliasText(a.alias, a.alias_rev);
    next.alias_at = a.at[0];
    next.alias_hub = a.at[1];
    next.alias = named.alias;
    renamedHere = named.renamed;
    if (named.alias !== r.alias) {
      report.effects.push({ kind: 'alias', device: w.id, alias: named.alias, alias_rev: Math.max(named.alias_rev, r.alias_rev), previous: r.alias, renamed: named.renamed });
    }
  }
  const h = w.hubs!;
  const mineHubs = hubsFrom(s.hubs_v);
  const hubs = hubsText(h.list);
  if ((cmp(h.at[0], s.hubs_at ?? 0) || cmp(h.list?.rev ?? -1, mineHubs?.rev ?? -1) || cmp(h.at[1], s.hubs_hub ?? '') || cmp(hubs, s.hubs_v ?? 'null')) > 0) {
    if (hubs !== s.hubs_v) {
      set.push('hubs = ?');
      args.push(h.list ? JSON.stringify(h.list) : null);
    }
    stamped = true;
    next.hubs_v = hubs;
    next.hubs_at = h.at[0];
    next.hubs_hub = h.at[1];
  }
  const f = w.fw!;
  const fw = fwText(f.fw_id);
  if ((cmpStamp(f.at, [s.fw_at ?? 0, s.fw_hub ?? '']) || cmp(fw, s.fw_v ?? 'null')) > 0) {
    if (fw !== s.fw_v) {
      set.push('fw_id = ?');
      args.push(f.fw_id);
    }
    stamped = true;
    next.fw_v = fw;
    next.fw_at = f.at[0];
    next.fw_hub = f.at[1];
  }
  if (stamped) {
    if (set.length) {
      db.prepare(`UPDATE devices SET ${set.join(', ')} WHERE device_id = ?`).run(...args, w.id);
    }
    putSync(db, next);
    if (renamedHere) {
      const now = devRow(db, w.id)!;
      db.prepare('UPDATE devices SET tags = ? WHERE device_id = ?').run(addTag(now.tags, TAG_RENAMED), w.id);
    }
    // What this hub holds otherwise than it was sent (the renamed alias and its tag) is its own write, stamped now.
    scanRow(db, self, net, devRow(db, w.id), syncRow(db, w.id), false);
    if (rowChanged) {
      retire(db, c.addr);
      report.effects.push({ kind: 'row', device: w.id, alias: devRow(db, w.id)!.alias, addr_changed: addrChanged, ...(becameProvisioned ? { provisioned: c.addr! } : {}) });
    }
  }
  done();
}

/**
 * Merges rows a peer sent into this hub's registry. One transaction per row: a row this hub cannot store leaves the
 * others as they are. Never throws for what a peer sent.
 */
export function applyRows(db: Db, self: SyncSelf, rows: readonly WireRow[], from: string): ApplyReport {
  const report: ApplyReport = { taken: 0, changed: [], differ: [], effects: [], conflicts: [] };
  const net = fleetNetId(db);
  if (net === null) {
    return report;
  }
  if (kvGet(db, NET_KEY) !== String(net)) {
    scan(db, self); // this hub's own rows get their revs before the first copy of another hub's is merged
  }
  for (const w of rows) {
    const mark = { effects: report.effects.length, conflicts: report.conflicts.length, changed: report.changed.length, differ: report.differ.length, taken: report.taken };
    try {
      db.transaction(() => applyRow(db, self, net, w, from, report))();
    } catch (e) {
      // A row SQLite refused (a constraint this merge did not foresee): what it did is rolled back, and it is said.
      report.effects.length = mark.effects;
      report.conflicts.length = mark.conflicts;
      report.changed.length = mark.changed;
      report.differ.length = mark.differ;
      report.taken = mark.taken;
      const id = typeof w?.id === 'string' ? w.id.slice(0, 12) : '?';
      report.conflicts.push({ kind: 'bad', device: id, message: `the row of ${id} from hub ${from} could not be stored (${(e as Error).message})` });
      if (typeof w?.id === 'string') {
        report.differ.push(w.id);
      }
    }
  }
  // A local board that gave way to an incoming alias was renamed above: its stamps follow, and the peers hear of it.
  for (const e of report.effects) {
    if (e.kind === 'alias' && e.renamed && !report.changed.includes(e.device)) {
      if (scan(db, self, [e.device]).length) {
        report.changed.push(e.device);
      }
    }
  }
  return report;
}

/** The rows of the network that carry the tag `renamed`, for hub_status. */
export function renamedRows(db: Db): { device_id: string; alias: string }[] {
  return (db.prepare("SELECT device_id, alias, tags FROM devices WHERE tags LIKE '%\"renamed\"%' ORDER BY alias").all() as { device_id: string; alias: string; tags: string }[])
    .filter((r) => parseTags(r.tags).includes(TAG_RENAMED))
    .map((r) => ({ device_id: r.device_id, alias: r.alias }));
}

/** How many rows of the network this hub holds, and how many tombstones. */
export function syncCounts(db: Db): { rows: number; tombstones: number } {
  const r = db.prepare('SELECT COALESCE(SUM(gone = 0), 0) AS live, COALESCE(SUM(gone = 1), 0) AS gone FROM registry_sync').get() as { live: number; gone: number };
  return { rows: r.live, tombstones: r.gone };
}
