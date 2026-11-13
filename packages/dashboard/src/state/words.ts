// One vocabulary for the states every page names (stage 4 integration): a device's presence in words, an event as
// the words a device's "last word" line uses, and the fleet's count. The beads are ui/bead.tsx presenceBead; these are
// the words beside them, so the Hub, Devices, Device and Settings pages say the same thing the same way.

import type { HubEvent } from '@fractonica/protocol/client';

const PRESENCE_WORDS: Record<string, string> = {
  online: 'online',
  suspect: 'suspect',
  offline: 'offline',
  unknown: 'not heard yet',
};

/** A device's presence as a word: online, suspect (seen lately, not answering now), offline, not heard yet. */
export function presenceWord(presence: string | null | undefined): string {
  return PRESENCE_WORDS[presence ?? 'unknown'] ?? presence ?? 'not heard yet';
}

/** The words an event's type is shown as on a device's line: the hub's own words for presence and links, else the type. */
export function eventWords(e: Pick<HubEvent, 'type'>): string {
  switch (e.type) {
    case 'device.online':
      return 'came online';
    case 'device.suspect':
      return 'went quiet';
    case 'device.offline':
      return 'went offline';
    case 'device.provisioned':
      return 'provisioned';
    case 'device.link':
      return 'link changed';
    case 'node.boot':
      return 'started';
    default:
      return e.type;
  }
}

/**
 * The fleet's count as one caps line: "5 of 6 online", "all 6 online", "none of 6 online", "no devices"; with a
 * filter, "2 shown · 5 of 6 online".
 */
export function fleetCount(s: { total: number; online: number; shown?: number }): string {
  const base =
    s.total === 0 ? 'no devices' : s.online === s.total ? (s.total === 1 ? 'online' : `all ${s.total} online`) : s.online === 0 ? `none of ${s.total} online` : `${s.online} of ${s.total} online`;
  return s.shown !== undefined && s.shown !== s.total ? `${s.shown} shown · ${base}` : base;
}
