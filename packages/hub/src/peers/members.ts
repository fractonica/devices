// The member list (design multi-hub-m2 §4): the hubs of this hub's network, kept by the registrar and held by every
// member in hub.db (`hub_members`). A row is a hub's id, its name in the network, its host name, the address and link
// port it gave when it joined, its epoch slot (0: the registrar) and when it joined. The list has a version that only
// the registrar raises (kv `hub.members_version`); a hub takes a list with a higher version from any peer it knows and
// passes it on, so a third hub joining becomes known to the second. Each hub also remembers, for itself only, where a
// peer's link last came from (seen_addr, seen_port): the second of the three places it looks for that peer (link.ts).
// Nothing here is a secret.

import { EPOCH_SLOTS, FrError, type HubMember } from '@fractonica/protocol';

import { type Db, kvGet, kvSet } from '../db.ts';

const VERSION_KEY = 'hub.members_version';

/** A member with what this hub alone knows of it. */
export interface MemberRow extends HubMember {
  seen_addr: string | null;
  seen_port: number | null;
  seen_at: string | null;
}

interface Row {
  hub_id: string;
  name: string;
  host: string;
  addr: string | null;
  link_port: number;
  slot: number;
  joined_at: string;
  seen_addr: string | null;
  seen_port: number | null;
  seen_at: string | null;
}

const fromRow = (r: Row): MemberRow => ({ id: r.hub_id, name: r.name, host: r.host, addr: r.addr, link_port: r.link_port, slot: r.slot, joined_at: r.joined_at, seen_addr: r.seen_addr, seen_port: r.seen_port, seen_at: r.seen_at });

/** A row as the list carries it between hubs: without this hub's own `seen_*`. */
export function publicMember(m: HubMember): HubMember {
  return { id: m.id, name: m.name, host: m.host, addr: m.addr, link_port: m.link_port, slot: m.slot, joined_at: m.joined_at };
}

/** Every member, the registrar first. Empty on a hub that is alone. */
export function listMembers(db: Db): MemberRow[] {
  return (db.prepare('SELECT * FROM hub_members ORDER BY slot').all() as Row[]).map(fromRow);
}

/** The list's version: 0 while there is none. */
export function membersVersion(db: Db): number {
  const n = Number(kvGet(db, VERSION_KEY) ?? '0');
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * Replaces the list with `members` at `version` (a join's answer, a newer list from a peer), keeping what this hub
 * remembers of where each hub was last seen. One transaction: a reader never sees half a list.
 */
export function replaceMembers(db: Db, members: readonly HubMember[], version: number): void {
  db.transaction(() => {
    const seen = new Map(listMembers(db).map((m) => [m.id, m]));
    db.prepare('DELETE FROM hub_members').run();
    const insert = db.prepare('INSERT INTO hub_members (hub_id, name, host, addr, link_port, slot, joined_at, seen_addr, seen_port, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const m of members) {
      const s = seen.get(m.id);
      insert.run(m.id, m.name, m.host, m.addr, m.link_port, m.slot, m.joined_at, s?.seen_addr ?? null, s?.seen_port ?? null, s?.seen_at ?? null);
    }
    kvSet(db, VERSION_KEY, String(version));
  })();
}

/** Where a peer's link last came from: this hub's own note, not part of the list. */
export function noteSeen(db: Db, hubId: string, addr: string, port: number): void {
  db.prepare('UPDATE hub_members SET seen_addr = ?, seen_port = ?, seen_at = ? WHERE hub_id = ?').run(addr, port, new Date().toISOString(), hubId);
}

/** What a hub is admitted as (the registrar's own row included). */
export interface MemberClaim {
  id: string;
  name: string;
  host: string;
  addr: string | null;
  link_port: number;
}

/**
 * The registrar's own row (slot 0), made with the first admission and brought up to date at each: its name, host,
 * address and link port as they are now. Returns whether the list changed.
 */
export function putRegistrar(db: Db, self: MemberClaim): boolean {
  const have = listMembers(db).find((m) => m.id === self.id);
  if (have && have.slot === 0 && have.name === self.name && have.host === self.host && have.addr === self.addr && have.link_port === self.link_port) {
    return false;
  }
  const other = listMembers(db).find((m) => m.id !== self.id && (m.slot === 0 || m.name === self.name));
  if (other) {
    // A list that names another registrar, or another hub by this hub's name: this hub is not what the list says.
    throw new FrError('INVALID_ARGS', `this hub's member list names ${other.name} (${other.id}) as ${other.slot === 0 ? 'its registrar' : `a hub with this hub's name (${self.name})`}`, {
      hint: other.slot === 0 ? 'only the registrar admits a hub: join that hub instead' : `give this hub another name first: fr hub name <name>`,
    });
  }
  db.prepare(
    `INSERT INTO hub_members (hub_id, name, host, addr, link_port, slot, joined_at) VALUES (?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(hub_id) DO UPDATE SET name = excluded.name, host = excluded.host, addr = excluded.addr, link_port = excluded.link_port`,
  ).run(self.id, self.name, self.host, self.addr, self.link_port, have?.joined_at ?? new Date().toISOString());
  return true;
}

/**
 * The registrar admits `hub` (design multi-hub-m2 §4, §9): a hub it knows keeps its slot and gets its name, host,
 * address and port brought up to date; a new one gets the lowest free slot of 1 to 3. Refused when another hub has
 * the name, or the network already has four hubs. Returns the row and whether the list changed.
 */
export function admitMember(db: Db, hub: MemberClaim): { member: MemberRow; changed: boolean } {
  const members = listMembers(db);
  const named = members.find((m) => m.name === hub.name && m.id !== hub.id);
  if (named) {
    throw new FrError('INVALID_ARGS', `the network already has a hub named ${hub.name} (${named.id}${named.slot === 0 ? ', the registrar' : ''}): a hub's name is unique in its network`, {
      hint: 'give the joining hub another name (on it: fr hub name <name>), then join again',
      details: { name: hub.name, held_by: named.id },
    });
  }
  const have = members.find((m) => m.id === hub.id);
  if (have) {
    if (have.slot === 0) {
      throw new FrError('INVALID_ARGS', `hub ${hub.id} is this network's registrar: it cannot join itself`);
    }
    const changed = have.name !== hub.name || have.host !== hub.host || have.addr !== hub.addr || have.link_port !== hub.link_port;
    if (changed) {
      db.prepare('UPDATE hub_members SET name = ?, host = ?, addr = ?, link_port = ? WHERE hub_id = ?').run(hub.name, hub.host, hub.addr, hub.link_port, hub.id);
    }
    return { member: listMembers(db).find((m) => m.id === hub.id)!, changed };
  }
  const taken = new Set(members.map((m) => m.slot));
  const slot = Array.from({ length: EPOCH_SLOTS - 1 }, (_, i) => i + 1).find((s) => !taken.has(s));
  if (slot === undefined) {
    throw new FrError('INVALID_ARGS', `the network already has ${EPOCH_SLOTS} hubs (${members.map((m) => m.name).join(', ')}): each hub needs an epoch slot of its own, and there are ${EPOCH_SLOTS}`, {
      hint: 'a network has at most four hubs, and a hub leaving one is not built yet (design multi-hub-m2 §10)',
      details: { members: members.map((m) => ({ id: m.id, name: m.name, slot: m.slot })) },
    });
  }
  db.prepare('INSERT INTO hub_members (hub_id, name, host, addr, link_port, slot, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(hub.id, hub.name, hub.host, hub.addr, hub.link_port, slot, new Date().toISOString());
  return { member: listMembers(db).find((m) => m.id === hub.id)!, changed: true };
}

/** Raises the list's version by one (the registrar, after a change) and returns it. */
export function bumpMembers(db: Db): number {
  const v = membersVersion(db) + 1;
  kvSet(db, VERSION_KEY, String(v));
  return v;
}
