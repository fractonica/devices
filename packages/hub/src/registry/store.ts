// The `devices` table behind the Registry interface (spec 08 §8.8, 06 §6.3; design c3 §4). Every call
// reads SQLite (better-sqlite3 is synchronous and the table is small), so the registry holds no copy that
// could drift from the rows the provisioning and flash jobs write through the functions below.
//   - addr is allocated from 0x0001 and never reused for another device: kv `registry.addr_hwm` keeps the
//     highest addr ever handed out or reported by a HELLO on this hub's net, so a forgotten device's addr
//     stays retired.
//   - A device seen only through HELLO is a row with provisioned 0 and addr NULL (design c3 §9 item 5).
//   - alias_rev only grows; the node keeps the highest rev it was given (06 §6.3), so the registry also
//     moves past any rev a HELLO reports, and its own alias wins on the next push.
//   - A board this hub flashed for another hub (device_provision `for_hub`, 06 §6.4) is that hub's: a row this hub
//     had for it becomes one seen only (provisioned 0, addr and net NULL), tagged `moved` (markMovedAway); the other
//     hub's row comes from device_enroll (enroll.ts), tagged `new` until a person accepts it.
//   - One network, several hubs (design multi-hub-m1): only the network's registrar allocates addresses. A hub that
//     joined a network (network.ts registrarOf) refuses to prepare an identity that would need a new address
//     (prepareIdentity); its rows of that network come from the registrar with their identity (storeSharedIdentity).
//     `hubs` is the board's ordered hub list as device_hubs_set pushed it.

import { existsSync, readFileSync } from 'node:fs';

import { ArtifactManifestSchema, boardHash, DEFAULT_NETWORK, type DeviceRole, FrError } from '@fractonica/protocol';

import type { Device, DeviceHubs, HelloSeen, Presence, Registry } from '../context.ts';
import { type Db, kvGet, kvSet } from '../db.ts';
import { fleetNetId, notRegistrar, registrarOf } from '../network.ts';
import { aliasProblem, checkAlias, defaultAlias } from './names.ts';
import { selectDevices } from './selector.ts';

/** First and last node address (05 §5.5): 0x0000 is the hub, 0xF000 and up are groups and specials. */
export const ADDR_MIN = 0x0001;
export const ADDR_MAX = 0xefff;

/** Image header chip ids (HELLO `chip`, manifest `chip_id`) and the registry's chip names. */
export const CHIP_IDS: Readonly<Record<string, number>> = { esp32: 0, esp32c3: 5, esp32s3: 9, esp32c6: 13, esp32c5: 23 };

export function chipName(chipId: number): string | null {
  return Object.entries(CHIP_IDS).find(([, id]) => id === chipId)?.[0] ?? null;
}

/**
 * What the hub last wrote into a device's fr_ident (the `provision` column). Never a secret: the Wi-Fi
 * password is rendered from secrets.json into a temp dir and goes nowhere else (design c3 §8).
 */
export interface ProvisionRecord {
  /** ISO time of the write. */
  at: string;
  /** The job that wrote it: device_provision, or a flash_start plan. */
  via: 'provision' | 'full' | 'identity' | 'recover';
  build_id: string | null;
  fw_id: string | null;
  profile: string | null;
  board: string | null;
  part_profile: string | null;
  /** Where fr_ident sits in this device's flash; frozen per part_profile (06 §6.2). */
  ident: { offset: number; size: number };
  addr: number;
  alias: string;
  alias_rev: number;
  epoch_floor: number;
  net: number;
  hub_host: string;
  ssid: string;
  /** The stored network it names (design csi-c1 D5); absent in records from before csi-c1 (default). */
  network?: string;
  /** fr_ident `prov_ts`: Unix seconds. */
  prov_ts: number;
  /** What the esptool probe reported (device_provision only). */
  probe?: Record<string, unknown>;
  /**
   * Set on the flashing hub when the fr_ident it wrote names another hub (device_provision `for_hub`, 06 §6.4): that
   * hub's API as it was called. addr, alias, net and hub_host above are then that hub's, the row here is not
   * provisioned (markMovedAway), and the port policy does not adopt the board's port (ports/policy.ts).
   */
  for_hub?: string;
  /** Set on the hub a board was enrolled on (device_enroll): another hub wrote the fr_ident this record describes. */
  enrolled?: true;
  /**
   * Design multi-hub-m1: the other hubs of the network this hub gave the row to (device_share, or a `for_hub`
   * provisioning for a hub of the same network), by their API as called.
   */
  shared_with?: string[];
}

/** The tag device_enroll gives a device that was not provisioned on this hub before: waiting to be named and accepted. */
export const TAG_NEW = 'new';
/** The tag a row keeps on the hub that flashed its board for another hub (markMovedAway), until it is provisioned here again. */
export const TAG_MOVED = 'moved';

interface Row {
  device_id: string;
  addr: number | null;
  alias: string;
  alias_rev: number;
  net: number | null;
  board: string | null;
  profile: string | null;
  chip: string | null;
  tags: string;
  role: DeviceRole;
  fw_id: string | null;
  provisioned: number;
  last_seen: string | null;
  last_epoch: number | null;
  created_at: string;
  provision: string | null;
  /** Absent in a row read from a table older than csi-c1 (never after openDb). */
  network?: string;
  /** JSON DeviceHubs, or NULL (design multi-hub-m1); absent in a row read before openDb added the column. */
  hubs?: string | null;
}

/** devices.hubs as stored: null for none, or for something that is not a list. */
function parseHubs(text: string | null | undefined): DeviceHubs | null {
  if (!text) {
    return null;
  }
  try {
    const v = JSON.parse(text) as Partial<DeviceHubs> | null;
    if (!v || typeof v.rev !== 'number' || !Array.isArray(v.hubs)) {
      return null;
    }
    const hubs = v.hubs
      .filter((h): h is { host: string; ip: string | null } => !!h && typeof h.host === 'string')
      .map((h) => ({ host: h.host, ip: typeof h.ip === 'string' && h.ip ? h.ip : null }));
    return { rev: v.rev, hubs, set_at: typeof v.set_at === 'string' ? v.set_at : '' };
  } catch {
    return null;
  }
}

function toDevice(r: Row): Device {
  let tags: string[] = [];
  try {
    const t: unknown = JSON.parse(r.tags);
    tags = Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    // a hand-edited row: no tags rather than no registry
  }
  return {
    device_id: r.device_id,
    addr: r.addr,
    alias: r.alias,
    alias_rev: r.alias_rev,
    net: r.net,
    board: r.board,
    profile: r.profile,
    chip: r.chip,
    tags,
    role: r.role,
    fw_id: r.fw_id,
    provisioned: r.provisioned === 1,
    last_seen: r.last_seen,
    last_epoch: r.last_epoch,
    created_at: r.created_at,
    network: r.network ?? DEFAULT_NETWORK,
    hubs: parseHubs(r.hubs),
  };
}

function row(db: Db, deviceId: string): Row | undefined {
  return db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId) as Row | undefined;
}

function mustRow(db: Db, deviceId: string): Row {
  const r = row(db, deviceId);
  if (!r) {
    throw new FrError('NOT_FOUND', `no device ${deviceId} in the registry`, { remediation: [{ tool: 'device_list', cli: 'fr devices ls' }] });
  }
  return r;
}

/** The device holding `alias` (any case) other than `except`, if any. */
function aliasHolder(db: Db, alias: string, except: string): string | null {
  const r = db.prepare('SELECT device_id FROM devices WHERE alias = ? AND device_id != ?').get(alias, except) as { device_id: string } | undefined;
  return r?.device_id ?? null;
}

export function aliasTaken(alias: string, holder: string): FrError {
  return new FrError('INVALID_ARGS', `alias ${alias} is taken by device ${holder}`, {
    remediation: [{ tool: 'device_get', args: { device: alias }, cli: `fr devices get ${alias}` }],
    details: { alias, device_id: holder },
  });
}

/** `<prefix>-<short id>`, with `-2`, `-3`, ... while another device holds it. */
function freeDefaultAlias(db: Db, prefix: string, deviceId: string): string {
  for (let n = 1; ; n++) {
    const a = defaultAlias(prefix, deviceId, n);
    if (!aliasHolder(db, a, deviceId)) {
      return a;
    }
  }
}

/**
 * Whether a row's alias is one nobody chose: the registry's made-up `<chip>-<short id>` for a HELLO-only
 * row, or the `new-<short id>` an UNASSIGNED node announces (fr_id_load) while it was never renamed (a
 * person's device_update to that spelling carries alias_rev >= 1).
 */
function isMadeUpAlias(r: Row): boolean {
  if (r.alias_rev === 0 && r.alias === defaultAlias('new', r.device_id)) {
    return true;
  }
  for (const prefix of [r.chip, 'node']) {
    for (let n = 1; prefix && n <= 9; n++) {
      if (r.alias === defaultAlias(prefix, r.device_id, n)) {
        return true;
      }
    }
  }
  return false;
}

/** Whether this hub's network has another hub (the member list of the hubs' link names more than this one). */
function inNetworkOfHubs(db: Db): boolean {
  return (db.prepare('SELECT COUNT(*) AS n FROM hub_members').get() as { n: number }).n > 1;
}

function addrHwm(db: Db): number {
  const hwm = Number(kvGet(db, 'registry.addr_hwm') ?? '0');
  return Number.isInteger(hwm) ? hwm : 0;
}

/** Next node address, never one handed out before (kv `registry.addr_hwm`). Call inside a transaction. */
function allocateAddr(db: Db): number {
  const max = (db.prepare('SELECT MAX(addr) AS m FROM devices').get() as { m: number | null }).m ?? 0;
  const next = Math.max(addrHwm(db), max) + 1;
  if (next > ADDR_MAX) {
    throw new FrError('INTERNAL', `the node address space is used up (0x${ADDR_MIN.toString(16)}-0x${ADDR_MAX.toString(16)})`);
  }
  kvSet(db, 'registry.addr_hwm', String(next));
  return next;
}

/**
 * Retires the addr a HELLO reports on this hub's net, so provisioning never hands it to another device
 * even while the sender's row is HELLO-only (a hub.db restored from a backup older than its provisioning).
 * A HELLO from another net, or before any network record, does not count: it must not burn the address
 * space. Call inside a transaction.
 */
function retireHelloAddr(db: Db, hello: HelloSeen): void {
  if (hello.addr < ADDR_MIN || hello.addr > ADDR_MAX) {
    return; // 0xFFFE: UNASSIGNED
  }
  const netId = fleetNetId(db);
  if (netId === null || netId !== hello.net || hello.addr <= addrHwm(db)) {
    return;
  }
  kvSet(db, 'registry.addr_hwm', String(hello.addr));
}

interface ArtifactInfo {
  fw_id: string;
  board: string | null;
  profile: string;
}

/**
 * Artifacts found by HELLO prefix, per database. An artifact never changes once built, so a hit is kept;
 * a miss is asked again, since the image may be ingested later. Bounded: one entry per firmware seen.
 */
const byPrefixOf = new WeakMap<Db, Map<string, ArtifactInfo>>();
const BY_PREFIX_MAX = 256;

/** Full fw_id and the artifact's board and profile for a HELLO fw_id prefix, when the hub built that image. */
function artifactByPrefix(db: Db, prefix: string): ArtifactInfo | null {
  if (!/^[0-9a-f]{8,64}$/.test(prefix)) {
    return null;
  }
  let byPrefix = byPrefixOf.get(db);
  if (!byPrefix) {
    byPrefix = new Map();
    byPrefixOf.set(db, byPrefix);
  }
  const hit = byPrefix.get(prefix);
  if (hit) {
    return hit;
  }
  const r = db
    .prepare('SELECT fw_id, profile, manifest_path FROM artifacts WHERE substr(fw_id, 1, ?) = ? ORDER BY built_at DESC LIMIT 1')
    .get(prefix.length, prefix) as { fw_id: string; profile: string; manifest_path: string } | undefined;
  if (!r) {
    return null;
  }
  let board: string | null = null;
  try {
    if (existsSync(r.manifest_path)) {
      board = ArtifactManifestSchema.parse(JSON.parse(readFileSync(r.manifest_path, 'utf8'))).board;
    }
  } catch {
    // an unreadable manifest only costs the board name
  }
  const info = { fw_id: r.fw_id, board, profile: r.profile };
  if (byPrefix.size >= BY_PREFIX_MAX) {
    byPrefix.clear();
  }
  byPrefix.set(prefix, info);
  return info;
}

export class SqliteRegistry implements Registry {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  get(deviceId: string): Device | null {
    const r = row(this.#db, deviceId);
    return r ? toDevice(r) : null;
  }

  byAddr(addr: number): Device | null {
    const r = this.#db.prepare('SELECT * FROM devices WHERE addr = ?').get(addr) as Row | undefined;
    return r ? toDevice(r) : null;
  }

  byAlias(alias: string): Device | null {
    const r = this.#db.prepare('SELECT * FROM devices WHERE alias = ?').get(alias) as Row | undefined;
    return r ? toDevice(r) : null;
  }

  list(): Device[] {
    return (this.#db.prepare('SELECT * FROM devices ORDER BY alias').all() as Row[]).map(toDevice);
  }

  resolve(selector: string, presence: (id: string) => Presence): Device[] {
    return selectDevices(this.list(), selector, presence);
  }

  touchHello(deviceId: string, hello: HelloSeen): Device {
    const db = this.#db;
    const now = new Date().toISOString();
    const chip = chipName(hello.chip);
    const art = artifactByPrefix(db, hello.fw_id_prefix);
    // The board is taken from the artifact only when the HELLO's board_hash agrees with it.
    const board = art?.board && boardHash(art.board) === hello.board_hash >>> 0 ? art.board : null;
    const helloAlias = hello.alias.toLowerCase();
    const helloFw = art?.fw_id ?? (hello.fw_id_prefix || null);
    db.transaction(() => {
      retireHelloAddr(db, hello);
      const r = row(db, deviceId);
      if (!r) {
        // First contact: the device's own alias if it is valid and free, else one made up from its chip;
        // a made-up alias gets a rev above the device's so the router's push replaces the device's.
        const own = !aliasProblem(helloAlias) && !aliasHolder(db, helloAlias, deviceId);
        const alias = own ? helloAlias : freeDefaultAlias(db, chip ?? 'node', deviceId);
        const rev = own ? hello.alias_rev : Math.min(hello.alias_rev + 1, 0xffffffff);
        db.prepare(
          `INSERT INTO devices (device_id, addr, alias, alias_rev, net, board, profile, chip, role, fw_id, provisioned, last_seen, last_epoch, created_at)
           VALUES (?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        ).run(deviceId, alias, rev, board, board ? art!.profile : null, chip, hello.role, helloFw, now, hello.epoch, now);
        return;
      }
      let rev = r.alias_rev;
      let alias = r.alias;
      if (helloAlias === r.alias) {
        rev = Math.max(rev, hello.alias_rev);
      } else if (hello.alias_rev > rev && inNetworkOfHubs(db) && !aliasProblem(helloAlias) && !aliasHolder(db, helloAlias, deviceId)) {
        // Design multi-hub-m2 §16: with several hubs, a board that carries a newer alias than this hub's row got it from
        // another hub of the network, whose write this hub has not heard of yet (it was away). The row follows the
        // board; a push of this hub's older name would undo that rename on every hub.
        alias = helloAlias;
        rev = hello.alias_rev;
      } else if (hello.alias_rev >= rev) {
        rev = Math.min(hello.alias_rev + 1, 0xffffffff);
      }
      // A full fw_id the prefix agrees with is kept (it came from the flash job's artifact).
      const fw = r.fw_id && hello.fw_id_prefix && r.fw_id.startsWith(hello.fw_id_prefix) ? r.fw_id : (helloFw ?? r.fw_id);
      db.prepare(
        `UPDATE devices SET alias = ?, alias_rev = ?, chip = COALESCE(?, chip), role = ?, fw_id = ?, last_seen = ?, last_epoch = ?,
           board = COALESCE(board, ?), profile = COALESCE(profile, ?) WHERE device_id = ?`,
      ).run(alias, rev, chip, hello.role, fw, now, hello.epoch, board, board ? art!.profile : null, deviceId);
    })();
    return this.get(deviceId)!;
  }

  update(deviceId: string, patch: Partial<Pick<Device, 'alias' | 'tags'>>): Device {
    const db = this.#db;
    db.transaction(() => {
      const r = mustRow(db, deviceId);
      if (patch.alias !== undefined) {
        const alias = checkAlias(patch.alias);
        const holder = aliasHolder(db, alias, deviceId);
        if (holder) {
          throw aliasTaken(alias, holder);
        }
        if (alias !== r.alias) {
          db.prepare('UPDATE devices SET alias = ?, alias_rev = ? WHERE device_id = ?').run(alias, Math.min(r.alias_rev + 1, 0xffffffff), deviceId);
        }
      }
      if (patch.tags !== undefined) {
        db.prepare('UPDATE devices SET tags = ? WHERE device_id = ?').run(JSON.stringify(patch.tags), deviceId);
      }
    })();
    return this.get(deviceId)!;
  }
}

/** The identity a provisioning or fr_ident flash writes (06 §6.4 step 4), and the row it came from. */
export interface PreparedIdentity {
  device: Device;
  /** `last_epoch + 1` (u16, serial order, never 0): the boot epoch then exceeds any the hub has seen. */
  epoch_floor: number;
}

/**
 * Registry upsert by device_id for a write of fr_ident (06 §6.4 step 4): reuses addr and alias when
 * known, otherwise allocates the next addr and `<profile>-<short id>` (or the requested alias); stamps
 * net, profile, board and chip. A HELLO-only row's made-up alias gives way to the profile default. The
 * row stays `provisioned: false` until the flash succeeds (markIdentWritten).
 */
export function prepareIdentity(
  db: Db,
  p: {
    deviceId: string;
    alias?: string;
    profile: string | null;
    board: string | null;
    chip: string | null;
    net: number;
    /** The stored network its fr_ident names (devices.network, design csi-c1 D5); omitted: kept (a new row: default). */
    network?: string;
    /**
     * The role the image will HELLO with, when provisioning knows it before that HELLO (a fixture build, design
     * m2-c1-hil D6): set now, so the row is never a provisioned `node` that apps and registry_rev would count.
     * Omitted: kept (a new row: node), until the router takes the device's HELLO.
     */
    role?: DeviceRole;
  },
): PreparedIdentity {
  const requested = p.alias === undefined ? undefined : checkAlias(p.alias);
  let floor = 1;
  db.transaction(() => {
    const r = row(db, p.deviceId);
    // Design multi-hub-m1: in a network this hub joined, addresses are the registrar's to give. A row that holds one
    // of that network (given by the registrar: storeSharedIdentity) is written as it is; anything else would need a
    // new address, or carry one of this hub's old net into the shared one.
    const registrar = registrarOf(db);
    if (registrar && (!r || r.addr === null || r.net !== p.net)) {
      throw notRegistrar(registrar, `${r?.alias ?? p.deviceId} has no address in this network yet`);
    }
    let alias: string;
    if (requested !== undefined) {
      const holder = aliasHolder(db, requested, p.deviceId);
      if (holder) {
        throw aliasTaken(requested, holder);
      }
      alias = requested;
    } else if (r && !(r.provisioned === 0 && isMadeUpAlias(r))) {
      alias = r.alias;
    } else {
      alias = freeDefaultAlias(db, p.profile ?? p.chip ?? 'node', p.deviceId);
    }
    // A provisioned alias carries rev >= 1, and a new spelling outranks whatever fr_ovr holds.
    const rev = !r ? 1 : alias === r.alias ? Math.max(r.alias_rev, 1) : Math.min(r.alias_rev + 1, 0xffffffff);
    const addr = r?.addr ?? allocateAddr(db);
    floor = ((r?.last_epoch ?? 0) + 1) & 0xffff || 1;
    if (!r) {
      db.prepare(
        `INSERT INTO devices (device_id, addr, alias, alias_rev, net, board, profile, chip, role, created_at, network) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(p.deviceId, addr, alias, rev, p.net, p.board, p.profile, p.chip, p.role ?? 'node', new Date().toISOString(), p.network ?? DEFAULT_NETWORK);
    } else {
      db.prepare(
        `UPDATE devices SET addr = ?, alias = ?, alias_rev = ?, net = ?, profile = COALESCE(?, profile), board = COALESCE(?, board),
           chip = COALESCE(?, chip), role = COALESCE(?, role), network = COALESCE(?, network) WHERE device_id = ?`,
      ).run(addr, alias, rev, p.net, p.profile, p.board, p.chip, p.role ?? null, p.network ?? null, p.deviceId);
    }
  })();
  return { device: toDevice(mustRow(db, p.deviceId)), epoch_floor: floor };
}

/** A row's tags as stored, with `add` appended (when absent) and `remove` taken out. */
function tagsWith(r: Row, edit: { add?: string; remove?: string }): string {
  const tags = toDevice(r).tags.filter((t) => t !== edit.remove);
  if (edit.add !== undefined && !tags.includes(edit.add)) {
    tags.push(edit.add);
  }
  return JSON.stringify(tags);
}

/**
 * After fr_ident was written: the row is provisioned, and the record says what was written where. A row that was
 * marked moved to another hub (markMovedAway) is this hub's again, so its `moved` tag goes. `tagNew` (device_enroll)
 * adds the tag `new` when the row was not provisioned before.
 */
export function markIdentWritten(db: Db, deviceId: string, rec: ProvisionRecord, opts: { tagNew?: boolean; keepHubs?: boolean } = {}): Device {
  db.transaction(() => {
    const r = mustRow(db, deviceId);
    const tags = tagsWith(r, { remove: TAG_MOVED, ...(opts.tagNew && r.provisioned === 0 ? { add: TAG_NEW } : {}) });
    // A flash writes a new prov_ts, and the board then drops the hub list it held (06 §6.3): the registry's copy goes
    // with it. `keepHubs`: nothing was flashed (device_adopt, a row shared by another hub of the network).
    db.prepare(
      `UPDATE devices SET provisioned = 1, provision = ?, fw_id = COALESCE(?, fw_id), profile = COALESCE(?, profile), board = COALESCE(?, board),
         tags = ?, hubs = CASE WHEN ? THEN hubs ELSE NULL END WHERE device_id = ?`,
    ).run(JSON.stringify(rec), rec.fw_id, rec.profile, rec.board, tags, opts.keepHubs ? 1 : 0, deviceId);
  })();
  return toDevice(mustRow(db, deviceId));
}

/** The device holding `addr` other than `except`, if any. */
export function addrHolder(db: Db, addr: number, except: string): { device_id: string; alias: string } | null {
  const r = db.prepare('SELECT device_id, alias FROM devices WHERE addr = ? AND device_id != ?').get(addr, except) as { device_id: string; alias: string } | undefined;
  return r ?? null;
}

/**
 * Design multi-hub-m1: the row of a board that already exists in this hub's network, with exactly the identity another
 * hub of the network gave (device_enroll with addr, net and alias). Nothing is allocated: the addr is the registrar's.
 * INVALID_ARGS when another device here holds the addr or the alias. The row stays `provisioned: false` until
 * markIdentWritten, like prepareIdentity's. alias_rev never goes back (06 §6.3); the addr is retired here too, so this
 * hub never hands it out should it allocate again.
 */
export function storeSharedIdentity(
  db: Db,
  p: { deviceId: string; addr: number; net: number; alias: string; alias_rev: number; epoch_floor: number; profile: string | null; board: string | null; chip: string | null; network: string },
): PreparedIdentity {
  const alias = checkAlias(p.alias);
  db.transaction(() => {
    const holder = addrHolder(db, p.addr, p.deviceId);
    if (holder) {
      throw new FrError('INVALID_ARGS', `addr ${p.addr} is held by ${holder.alias} (${holder.device_id}) on this hub`, {
        hint: 'two hubs of one network disagree about who has this address: only the registrar may hand addresses out (fr net get shows it)',
        details: { addr: p.addr, device_id: holder.device_id, alias: holder.alias },
      });
    }
    const named = aliasHolder(db, alias, p.deviceId);
    if (named) {
      throw aliasTaken(alias, named);
    }
    const r = row(db, p.deviceId);
    const rev = Math.max(p.alias_rev, r?.alias_rev ?? 0);
    // epoch_floor is last_epoch + 1 on the hub that gave the row: kept when this hub has seen a later boot itself.
    const seen = Math.max(r?.last_epoch ?? 0, p.epoch_floor - 1);
    if (!r) {
      db.prepare(
        `INSERT INTO devices (device_id, addr, alias, alias_rev, net, board, profile, chip, role, last_epoch, created_at, network) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'node', ?, ?, ?)`,
      ).run(p.deviceId, p.addr, alias, rev, p.net, p.board, p.profile, p.chip, seen || null, new Date().toISOString(), p.network);
    } else {
      db.prepare(
        `UPDATE devices SET addr = ?, alias = ?, alias_rev = ?, net = ?, profile = COALESCE(?, profile), board = COALESCE(?, board),
           chip = COALESCE(?, chip), last_epoch = ?, network = ? WHERE device_id = ?`,
      ).run(p.addr, alias, rev, p.net, p.profile, p.board, p.chip, seen || null, p.network, p.deviceId);
    }
    if (p.addr > addrHwm(db)) {
      kvSet(db, 'registry.addr_hwm', String(p.addr));
    }
  })();
  const d = toDevice(mustRow(db, p.deviceId));
  return { device: d, epoch_floor: ((d.last_epoch ?? 0) + 1) & 0xffff || 1 };
}

/** The hub list device_hubs_set pushed (or device_hubs_get read back); null takes it away. No-op for an unknown device. */
export function setDeviceHubs(db: Db, deviceId: string, hubs: DeviceHubs | null): void {
  db.prepare('UPDATE devices SET hubs = ? WHERE device_id = ?').run(hubs ? JSON.stringify(hubs) : null, deviceId);
}

/** Adds `hub` (an API base URL) to the row's provision record `shared_with`. No-op without a record. */
export function noteSharedWith(db: Db, deviceId: string, hub: string): void {
  const rec = provisionOf(db, deviceId);
  if (!rec || rec.shared_with?.includes(hub)) {
    return;
  }
  rec.shared_with = [...(rec.shared_with ?? []), hub];
  db.prepare('UPDATE devices SET provision = ? WHERE device_id = ?').run(JSON.stringify(rec), deviceId);
}

/**
 * After this hub wrote an fr_ident that names another hub onto a board it has a row for (device_provision `for_hub`):
 * the board is that hub's now. The row stays, as one seen only (provisioned 0, addr and net NULL, like a HELLO-only
 * row; its old addr stays retired through `registry.addr_hwm`), tagged `moved`, with the record of what was written
 * (`for_hub`). The port policy stops adopting its port. Returns null when this hub has no row for the device: a board
 * that was never this hub's gets none.
 */
export function markMovedAway(db: Db, deviceId: string, rec: ProvisionRecord & { for_hub: string }): Device | null {
  let moved = false;
  db.transaction(() => {
    const r = row(db, deviceId);
    if (!r) {
      return;
    }
    moved = true;
    if (r.addr !== null && r.addr > addrHwm(db)) {
      kvSet(db, 'registry.addr_hwm', String(r.addr)); // a row from before the mark was kept: its addr stays retired
    }
    db.prepare(
      `UPDATE devices SET provisioned = 0, addr = NULL, net = NULL, provision = ?, fw_id = COALESCE(?, fw_id), profile = COALESCE(?, profile),
         board = COALESCE(?, board), tags = ? WHERE device_id = ?`,
    ).run(JSON.stringify(rec), rec.fw_id, rec.profile, rec.board, tagsWith(r, { add: TAG_MOVED }), deviceId);
  })();
  return moved ? toDevice(mustRow(db, deviceId)) : null;
}

/**
 * Deletes a device's row (the store's half of `device_forget`, which is not an op yet: 09 §9.4). Its addr stays retired
 * (`registry.addr_hwm`). On a hub of a network the delete replicates: registry/sync.ts finds the row gone and leaves a
 * tombstone with the rev of the delete, so another hub's older copy does not bring it back (design multi-hub-m2 §5).
 * A board that still says HELLO afterwards is a row seen only again. Returns whether there was a row.
 */
export function forgetDevice(db: Db, deviceId: string): boolean {
  let had = false;
  db.transaction(() => {
    const r = row(db, deviceId);
    if (!r) {
      return;
    }
    had = true;
    if (r.addr !== null && r.addr > addrHwm(db)) {
      kvSet(db, 'registry.addr_hwm', String(r.addr));
    }
    db.prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId);
  })();
  return had;
}

/** After an image was flashed to a registered device: the firmware it now runs. No-op for an unknown one. */
export function markImageFlashed(db: Db, deviceId: string, a: { fw_id: string; profile: string; board: string }): void {
  db.prepare('UPDATE devices SET fw_id = ?, profile = ?, board = ? WHERE device_id = ?').run(a.fw_id, a.profile, a.board, deviceId);
}

/** The last fr_ident write's record, or null. */
export function provisionOf(db: Db, deviceId: string): ProvisionRecord | null {
  const r = db.prepare('SELECT provision FROM devices WHERE device_id = ?').get(deviceId) as { provision: string | null } | undefined;
  if (!r?.provision) {
    return null;
  }
  try {
    return JSON.parse(r.provision) as ProvisionRecord;
  } catch {
    return null;
  }
}
