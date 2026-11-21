// A registry row changed at another hub that does not replicate the registry (design multi-hub-m2 §7.1; a hub of step
// 2.2, while the hubs of a network are being updated one by one). Between two hubs of step 2.3 the row arrives by
// replication (peers/registry.ts) and this module is not used (passing.ts `received`). For the older peer: an op that
// changes a row and needs the board (a rename, a tag, the hub list) runs at the hub that holds the board, and this hub,
// which passed it on, stores the fields that hub answered for the same device id, so its own copy of the row does not
// go stale. Only what the answer says, only for a row this hub has, and never an alias another of its rows holds (the
// answer then carries a warning). What it writes is stamped as this hub's write and replicates to the other hubs.

import type { DeviceHubs, HubContext } from '../context.ts';
import { setDeviceHubs } from '../registry/store.ts';

/** The ops whose answer is a row, or a part of one, that this hub keeps a copy of. */
export const ROW_OPS: ReadonlySet<string> = new Set(['device_update', 'device_hubs_set', 'device_hubs_get', 'device_adopt']);

interface RowAnswer {
  device_id?: unknown;
  alias?: unknown;
  alias_rev?: unknown;
  tags?: unknown;
  hubs?: unknown;
  rev?: unknown;
  trial?: unknown;
  left?: unknown;
}

/**
 * Stores what `data` (the answer of `op` at hub `at`) says of its device's row. Returns a warning when part of it
 * could not be taken, else null.
 */
export function adoptRow(hub: Pick<HubContext, 'db' | 'registry'>, op: string, data: unknown, at: string): string | null {
  if (!ROW_OPS.has(op) || !data || typeof data !== 'object') {
    return null;
  }
  const a = data as RowAnswer;
  const id = typeof a.device_id === 'string' ? a.device_id : null;
  const mine = id ? hub.registry.get(id) : null;
  if (!id || !mine) {
    return null;
  }
  if (op === 'device_hubs_set' || op === 'device_hubs_get') {
    // The board's own list as that hub read it; one still on trial is not recorded (hubs.ts), nor one the board left with.
    if (Array.isArray(a.hubs) && typeof a.rev === 'number' && a.trial === false && a.left !== true && (mine.hubs?.rev ?? 0) !== a.rev) {
      const hubs = (a.hubs as { host?: unknown; ip?: unknown }[]).filter((h) => typeof h?.host === 'string').map((h) => ({ host: h.host as string, ip: typeof h.ip === 'string' && h.ip ? h.ip : null }));
      const stored: DeviceHubs | null = a.rev === 0 && !hubs.length ? null : { rev: a.rev, hubs, set_at: new Date().toISOString() };
      setDeviceHubs(hub.db, id, stored);
    }
    return null;
  }
  let warning: string | null = null;
  hub.db.transaction(() => {
    if (Array.isArray(a.tags) && a.tags.every((t) => typeof t === 'string')) {
      hub.db.prepare('UPDATE devices SET tags = ? WHERE device_id = ?').run(JSON.stringify(a.tags), id);
    }
    if (typeof a.alias === 'string' && typeof a.alias_rev === 'number' && a.alias_rev >= mine.alias_rev && (a.alias !== mine.alias || a.alias_rev !== mine.alias_rev)) {
      const other = hub.db.prepare('SELECT device_id FROM devices WHERE alias = ? AND device_id != ?').get(a.alias, id) as { device_id: string } | undefined;
      if (other) {
        warning = `hub ${at} now calls ${id} ${a.alias}, but this hub has another board (${other.device_id}) by that name: this hub still calls it ${mine.alias} (the two registries are not one yet)`;
      } else {
        hub.db.prepare('UPDATE devices SET alias = ?, alias_rev = ? WHERE device_id = ?').run(a.alias, a.alias_rev, id);
      }
    }
  })();
  return warning;
}
