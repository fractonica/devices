// A hub's identity in its network (design multi-hub-m2 §2, §4): the hub id (6 random bytes, made once per FR_HOME and
// never changed: a member list, a connection and a board's place name hubs by it), the hub name (a short label, unique
// in a network, shown wherever a board's place is shown) and where its peer link is reached. All of it is public and
// lives in hub.db's kv; the network key does not (key.ts).

import { randomBytes } from 'node:crypto';

import { HUB_NAME_RE, PEER_LINK_PORT } from '@fractonica/protocol';

import type { HubRunOptions } from '../context.ts';
import { type Db, hubSlot, kvGet, kvSet } from '../db.ts';
import { hubHostName } from '../network.ts';
import { hubIpv4 } from '../registry/ident.ts';

const HUB_ID_KEY = 'hub.id';
const HUB_NAME_KEY = 'hub.name';

/** This hub's id: 12 lowercase hex, made at the first call for this hub.db and kept. */
export function hubId(db: Db): string {
  const have = kvGet(db, HUB_ID_KEY);
  if (have && /^[0-9a-f]{12}$/.test(have)) {
    return have;
  }
  const id = randomBytes(6).toString('hex');
  kvSet(db, HUB_ID_KEY, id);
  return id;
}

/**
 * A hub name from a host name: its first label, lower-cased, anything that is not a letter, a digit or "-" turned into
 * "-", cut to 31 characters; `hub` when nothing is left (a host name of dots, an empty one).
 */
export function nameFromHost(host: string): string {
  const label = host.split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 31).replace(/^-+|-+$/g, '');
  return HUB_NAME_RE.test(label) ? label : 'hub';
}

/** This hub's name: the one it was given (hub_name_set, or the registrar's answer at a join), else its host's. */
export function hubName(db: Db): string {
  const have = kvGet(db, HUB_NAME_KEY);
  return have && HUB_NAME_RE.test(have) ? have : nameFromHost(hubHostName());
}

export function setHubName(db: Db, name: string): void {
  kvSet(db, HUB_NAME_KEY, name);
}

/** hub_status `hub`, network_join `hub`: id, name and epoch slot (null on a hub that holds none). */
export function hubIdentity(db: Db): { id: string; name: string; slot: number | null } {
  return { id: hubId(db), name: hubName(db), slot: hubSlot(db) };
}

/** Whether a listen host is every interface (the real hub) rather than one address (a test hub on loopback). */
const anyAddress = (host: string) => host === '0.0.0.0' || host === '::' || host === '';

/**
 * Where this hub tells the others to reach it (the member list's `host` and `addr`): its mDNS name and its LAN IPv4. A
 * hub whose node listeners bind one address (a test hub on 127.0.0.1) is reached there and nowhere else, so that
 * address is both: a peer must never look for it on the LAN.
 */
export function advertised(run: Pick<HubRunOptions, 'nodeHost'> | undefined): { host: string; addr: string | null } {
  if (run && !anyAddress(run.nodeHost)) {
    return { host: run.nodeHost, addr: /^\d{1,3}(\.\d{1,3}){3}$/.test(run.nodeHost) ? run.nodeHost : null };
  }
  return { host: hubHostName(), addr: hubIpv4() };
}

/** The peer link port a hub run as `run` asks for: the one given, else 7423. */
export function peerPortOf(run: Pick<HubRunOptions, 'peerPort'> | undefined): number {
  return run?.peerPort ?? PEER_LINK_PORT;
}
