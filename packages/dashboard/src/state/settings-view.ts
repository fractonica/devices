// Settings' own rules (HARDWARE-REVIEW §4 "Screens" 8): the hub's database space and the advice on compacting it, and
// the network form's checks and its network_set input. The checks are state/checks.ts and the ports state/ports.ts,
// which the Hub and Provision pages share. Pure, so the tests run in node.

// ------------------------------------------------------------------ storage

export interface DbSpace {
  bytes: number;
  free_bytes: number;
  auto_vacuum: 'none' | 'full' | 'incremental' | string;
}

/** Bytes for people: 812 bytes, 252 KB, 48.3 MB, 1.2 GB (decimal, as the hub's own warning counts). */
export function sizeText(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    return '–';
  }
  if (n < 1000) {
    return `${n} bytes`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Whether compacting is worth it and why (the hub's own rule, retention.ts spaceWarning, said as advice). */
export function compactAdvice(db: DbSpace): { worth: boolean; text: string } {
  if (db.auto_vacuum === 'incremental') {
    return { worth: false, text: 'Space from pruned rows goes back to the disk after each pruning pass; nothing to do.' };
  }
  const worth = db.free_bytes > 64e6 && db.free_bytes > db.bytes / 4;
  return worth
    ? { worth, text: 'Much of the file is free space that this older database keeps. Compact it once: from then on it returns space by itself.' }
    : { worth, text: 'This older database keeps freed space in the file. Compacting it once makes it return space by itself; not urgent while the free part is small.' };
}

/** The commands that compact the database: the hub must be stopped (a running hub refuses with LOCKED). */
export const COMPACT_COMMAND = 'fr hub stop && fr hub compact && fr hub start';


// ------------------------------------------------------------------ networks

export interface NetworkDraft {
  name: string;
  ssid: string;
  password: string;
  /** An open network: no password (stored as empty). */
  open: boolean;
  band: 'auto' | '2g' | '5g';
  country: string;
  bssid: string;
}

export type NetworkErrors = Partial<Record<keyof NetworkDraft, string>>;

/** The form's problems by field, as the hub's network_set input rules say (empty when it may be saved). */
export function networkErrors(d: NetworkDraft): NetworkErrors {
  const e: NetworkErrors = {};
  if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(d.name)) {
    e.name = 'a lowercase label of at most 31 characters, e.g. default or lab-5g';
  }
  if (d.ssid.length < 1 || d.ssid.length > 32) {
    e.ssid = 'the network name the router broadcasts, 1 to 32 characters';
  }
  if (!d.open && d.password.length > 64) {
    e.password = 'at most 64 characters';
  }
  if (!d.open && d.password.length > 0 && d.password.length < 8) {
    e.password = 'a WPA password has 8 characters or more';
  }
  if (d.country && !/^[A-Za-z]{2}$/.test(d.country)) {
    e.country = 'a 2-letter code, e.g. DE';
  }
  if (d.bssid && !/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(d.bssid)) {
    e.bssid = 'a router MAC, six pairs: 3c:84:6a:12:34:56';
  }
  return e;
}

/**
 * network_set's input from the form. The password goes only when typed (an empty field keeps the stored one), or as
 * empty for an open network; the country upper-cased, the BSSID lower-cased, empty optional fields left out.
 */
export function networkSetInput(d: NetworkDraft): { name: string; ssid: string; band: 'auto' | '2g' | '5g'; password?: string; country?: string; bssid?: string } {
  return {
    name: d.name,
    ssid: d.ssid,
    band: d.band,
    ...(d.open ? { password: '' } : d.password ? { password: d.password } : {}),
    ...(d.country ? { country: d.country.toUpperCase() } : {}),
    ...(d.bssid ? { bssid: d.bssid.toLowerCase() } : {}),
  };
}
