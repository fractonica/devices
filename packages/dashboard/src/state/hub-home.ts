// What the Hub page (route `/`, src/pages/hub.tsx) shows besides the instrument, as pure functions over the hub's
// answers and the live store, so they are tested in node: the fleet in its order with each device's last word, the
// hub_doctor checks as beads, the banner of things waiting on a person (agent prompts, lent ports, running jobs), and
// the latest time.threshold events. No Fractonica number is made here: instants stay the hub's, the page writes them
// through the core (FTime).

import type { HubEvent, Prompt } from '@fractonica/protocol/client';

import { type BeadState, presenceBead } from '../ui/bead.tsx';
import { eventWords, presenceWord } from './words.ts';

/** The registry row fields the Hub page reads (device_list's DeviceView). */
export interface FleetDevice {
  device_id: string;
  alias: string;
  presence: string;
  profile?: string | null;
  board?: string | null;
  chip?: string | null;
  last_seen?: string | null;
  role?: string;
}

export interface FleetRow {
  device_id: string;
  alias: string;
  bead: BeadState;
  /** The presence word for assistive technology and the bead's caps label. */
  presence: string;
  /** What it is: profile, else board, else chip; '' when unknown. */
  kind: string;
  /** Its last word: the newest live event's type and time, or when the registry last heard it, or nothing yet. */
  last: { what: string; at: number | string } | null;
}

export interface FleetSummary {
  rows: FleetRow[];
  total: number;
  online: number;
  /** Suspect: seen lately, not answering now. */
  waiting: number;
  offline: number;
}

/** The fleet in the page's order, with each device's last word (`lastByDevice` is the live store's, by device id). */
export function fleetSummary(devices: readonly FleetDevice[], lastByDevice: Readonly<Record<string, Pick<HubEvent, 'type' | 't_hub_us'>>> = {}): FleetSummary {
  const rows = devices
    .filter((d) => d.role !== 'fixture')
    .map((d): FleetRow => {
      const e = lastByDevice[d.device_id];
      const last = e ? { what: eventWords(e), at: e.t_hub_us } : d.last_seen ? { what: 'last heard', at: d.last_seen } : null;
      return {
        device_id: d.device_id,
        alias: d.alias,
        bead: presenceBead(d.presence),
        presence: presenceWord(d.presence),
        kind: d.profile ?? d.board ?? d.chip ?? '',
        last,
      };
    })
    .sort((a, b) => order(a) - order(b) || a.alias.localeCompare(b.alias));
  return {
    rows,
    total: rows.length,
    online: rows.filter((r) => r.bead === 'online').length,
    waiting: rows.filter((r) => r.bead === 'waiting').length,
    offline: rows.filter((r) => r.bead === 'offline' || r.bead === 'idle').length,
  };
}

/** Order on the carrier and in the list: online first, then suspect, offline, never heard; by alias within. */
function order(r: FleetRow): number {
  return r.bead === 'online' ? 0 : r.bead === 'waiting' ? 1 : r.bead === 'offline' ? 2 : 3;
}

// ------------------------------------------------------------------------------------------------- banner

/** port_list's port, as far as the banner reads it. */
export interface BannerPort {
  path: string;
  alias?: string;
  device_id?: string;
  lease?: { lease_id: string; holder_pid?: number; expires_at: string; by?: 'external' | 'job' };
}

/** A running job, as the live store keeps it. */
export interface BannerJob {
  job_id: string;
  kind: string;
  status: string;
  stage?: string;
  targets?: string[];
}

export type BannerItem =
  | { kind: 'prompt'; key: string; text: string; who: string; until: string }
  | { kind: 'lease'; key: string; lease_id: string; port: string; who: string; until: string; byJob: boolean }
  | { kind: 'job'; key: string; job_id: string; title: string; stage: string; provision: boolean };

const RUNNING = new Set(['queued', 'working', 'running', 'waiting']);

/** The last part of a port path ("/dev/cu.usbmodem1101" → "cu.usbmodem1101"). */
export function portName(path: string): string {
  return path.split('/').pop() || path;
}

/**
 * What waits on a person, in the banner's order: an agent's prompts (a real action at the bench), ports lent away
 * from the hub (its devices are not heard over USB meanwhile), then running jobs. Expired prompts are dropped by the
 * live store; leases that have ended are not in port_list.
 */
export function bannerItems(prompts: readonly Prompt[], ports: readonly BannerPort[], jobs: readonly BannerJob[] = []): BannerItem[] {
  const items: BannerItem[] = [];
  for (const p of [...prompts].sort((a, b) => a.expires_at.localeCompare(b.expires_at))) {
    items.push({ kind: 'prompt', key: p.prompt_id, text: p.text, who: p.selector ?? '', until: p.expires_at });
  }
  for (const port of ports) {
    if (port.lease) {
      const who = port.lease.by === 'job' ? 'a job' : port.lease.holder_pid !== undefined ? `pid ${port.lease.holder_pid}` : 'another program';
      items.push({ kind: 'lease', key: port.lease.lease_id, lease_id: port.lease.lease_id, port: port.alias ?? portName(port.path), who, until: port.lease.expires_at, byJob: port.lease.by === 'job' });
    }
  }
  for (const j of jobs) {
    if (RUNNING.has(j.status)) {
      const target = j.targets?.length ? ` ${j.targets.join(', ')}` : '';
      items.push({ kind: 'job', key: j.job_id, job_id: j.job_id, title: `${j.kind.replace(/_/g, ' ')}${target}`, stage: j.stage ?? j.status, provision: j.kind === 'provision' || j.kind === 'device_provision' });
    }
  }
  return items;
}

// --------------------------------------------------------------------------------------------- thresholds

export interface ThresholdLine {
  key: string;
  /** "η peak": the level's symbol and the core's quarter word. */
  words: string;
  /** Unix µs (the event's own `at`, else its t_hub_us). */
  at: bigint;
}

function thresholdAt(e: HubEvent): bigint {
  const at = e.fields?.at;
  if (typeof at === 'string' && /^-?\d+$/.test(at)) {
    return BigInt(at);
  }
  return BigInt(Math.round(e.t_hub_us));
}

/**
 * The newest `max` time.threshold events from the stored ones (events_read) and the live ring, newest first, each
 * once (by cursor). Their words are the hub's (the core's symbol and quarter word).
 */
export function latestThresholds(stored: readonly HubEvent[], live: readonly HubEvent[], max = 3): ThresholdLine[] {
  const seen = new Map<string, HubEvent>();
  for (const e of [...stored, ...live]) {
    if (e.type === 'time.threshold') {
      seen.set(e.cursor, e);
    }
  }
  return [...seen.values()]
    .map((e) => ({ e, at: thresholdAt(e) }))
    .sort((a, b) => (a.at === b.at ? b.e.seq - a.e.seq : a.at > b.at ? -1 : 1))
    .slice(0, max)
    .map(({ e, at }) => ({ key: e.cursor, words: `${String(e.fields?.symbol ?? '')} ${String(e.fields?.quarter ?? '')}`.trim(), at }));
}
