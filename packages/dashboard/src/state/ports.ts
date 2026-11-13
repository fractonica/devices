// The USB serial ports as every page says them (Provision's Plug in step and Settings › Ports; the port policy of
// stage 2): what a port is to the hub in words with a bead (watched by the hub / lent to pid … / in use by a job /
// held by <program> / ignored / not watched), why, the policy actions it offers with the undo of each (Lend, Release,
// Ignore and Stop ignoring, Claim and Unclaim), what stops provisioning on it with the fix the page runs in place, the
// policy mode in words, and the lend times offered as Fractonica spans. Pure, so the tests run in node.

import { Unit } from '@fractonica/time/browser';
import type { PortInfo } from '@fractonica/protocol/client';

import type { BeadState } from '../ui/bead.tsx';

export type PortAction = 'lend' | 'release' | 'ignore' | 'unignore' | 'claim' | 'unclaim';

export const PORT_ACTION_LABEL: Record<PortAction, string> = {
  lend: 'Lend',
  release: 'Release',
  ignore: 'Ignore',
  unignore: 'Stop ignoring',
  claim: 'Claim',
  unclaim: 'Unclaim',
};

export interface PortView {
  bead: BeadState;
  /** What the port is to the hub, in words: "watched by the hub", "lent to pid 77", "held by Google Chrome". */
  word: string;
  /** Why (the policy) or what to do, in a second line. */
  detail: string;
  /** The policy actions it offers, in order (an action's undo once it is done: Ignore ↔ Stop ignoring, …). */
  actions: PortAction[];
  /** A board on it is new to the registry. */
  isNew: boolean;
  /** The port's name for people: its basename. */
  name: string;
}

const POLICY_WHY: Record<string, string> = {
  adopted: 'its board is registered',
  claimed: 'claimed: the hub watches it although its board is not registered',
  all: 'policy mode all: every ESP32 and USB-UART port',
  not_adopted: 'its board is not registered; Claim lets it say hello',
  ignored: 'on the ignore list: the hub never opens it',
  config_invalid: 'config.json has no valid port settings: the hub opens no port until it is fixed',
};

/** The programs that hold a port open (lsof), for people: "Google Chrome", "Google Chrome and screen". */
export function holders(p: Pick<PortInfo, 'external' | 'holder'>): string {
  const apps = [...new Set((p.external ?? []).map((h) => h.app))];
  if (apps.length) {
    return apps.length === 1 ? apps[0]! : `${apps.slice(0, -1).join(', ')} and ${apps.at(-1)}`;
  }
  return p.holder ?? 'another program';
}

/** A port's state as words, a bead and the actions the port policy allows on it; `registered`: its board is known. */
export function portView(p: PortInfo, registered = false): PortView {
  const name = p.path.split('/').pop() ?? p.path;
  // a native-USB board has a device id from its USB serial before it is registered: new is what the registry says
  const isNew = !registered && !p.alias;
  const why = p.policy ? (POLICY_WHY[p.policy] ?? p.policy) : '';
  const view = (bead: BeadState, word: string, detail: string, actions: PortAction[]): PortView => ({ bead, word, detail, actions, isNew, name });
  if (p.lease || p.state === 'leased') {
    if (p.lease?.by === 'job') {
      return view('waiting', 'in use by a job', 'a flash or a provision of the hub; free again when it ends', []);
    }
    const pid = p.lease?.holder_pid !== undefined ? ` to pid ${p.lease.holder_pid}` : '';
    return view('waiting', `lent${pid}`, 'the hub takes it back when the lease ends', p.lease ? ['release'] : []);
  }
  const unclaim: PortAction[] = p.policy === 'claimed' ? ['unclaim'] : [];
  switch (p.state) {
    case 'open':
      return view('online', 'watched by the hub', why, ['lend', 'ignore', ...unclaim]);
    case 'busy_external':
      return view('waiting', `held by ${holders(p)}`, 'close it there, or ignore the port so the hub stops trying', ['ignore', ...unclaim]);
    case 'ignored':
      return view('offline', 'ignored', why || POLICY_WHY.ignored!, ['lend', 'unignore']);
    case 'unwatched':
      return view('idle', 'not watched', why, ['lend', 'ignore', ...(p.policy === 'config_invalid' ? [] : (['claim'] as PortAction[]))]);
    case 'error':
      return view('fault', 'error', p.holder ?? why, ['lend', 'ignore', ...unclaim]);
    case 'closed':
    default:
      return view('offline', 'closed', why, ['lend', 'ignore', ...unclaim]);
  }
}

export type BlockFix = 'release' | 'unignore' | 'recheck';

export interface PortBlock {
  /** A code for the line, as the hub would name it (PORT_LEASED, PORT_BUSY_EXTERNAL, …). */
  code: string;
  /** Why provisioning cannot start on this port now. */
  message: string;
  /** The fix the page runs in place (none: a job holds it; wait for it). */
  fix: BlockFix | null;
  fixLabel?: string;
}

/** What stops provisioning on a port before anything starts (the hub would refuse it), with the in-page fix. */
export function portBlock(p: PortInfo): PortBlock | null {
  if (p.policy === 'config_invalid') {
    return { code: 'CONFIG_INVALID', message: "The hub's config.json has no valid ports settings, so it opens no port. Fix the file; the hub reads it again on its own.", fix: 'recheck', fixLabel: 'Check again' };
  }
  switch (p.state) {
    case 'leased':
      return p.lease?.by === 'job'
        ? { code: 'LOCKED', message: 'A job of the hub is using this port (a flash or another provision). It is free again when that job ends.', fix: null }
        : { code: 'PORT_LEASED', message: 'This port is lent to another program. Release it to provision here; the program loses the port.', fix: 'release', fixLabel: 'Release' };
    case 'busy_external':
      return {
        code: 'PORT_BUSY_EXTERNAL',
        message: `${holders(p)} has this port open. Close the connection there (a Web Serial tab, a serial monitor), then check again.`,
        fix: 'recheck',
        fixLabel: 'Check again',
      };
    case 'ignored':
      return { code: 'PORT_IGNORED', message: 'The hub ignores this port. Stop ignoring it to provision the board on it.', fix: 'unignore', fixLabel: 'Stop ignoring' };
    case 'error':
      return { code: 'PORT_ERROR', message: 'The port reports an error. Unplug the board and plug it in again.', fix: 'recheck', fixLabel: 'Check again' };
    default:
      return null;
  }
}

/** Ports for the list: new boards first, then by name; stable. */
export function sortPorts<P extends PortInfo>(ports: readonly P[], registered: (p: P) => boolean): P[] {
  return [...ports].sort((a, b) => Number(registered(a) || !!a.alias) - Number(registered(b) || !!b.alias) || a.path.localeCompare(b.path));
}

/** The port the page should offer first: the one plugged in since the page opened, else the only new board, else the only port. */
export function suggestPort<P extends PortInfo>(ports: readonly P[], seen: ReadonlySet<string>, registered: (p: P) => boolean): P | null {
  const fresh = ports.filter((p) => !seen.has(p.path));
  if (fresh.length === 1) {
    return fresh[0]!;
  }
  const unknown = ports.filter((p) => !registered(p) && !p.alias);
  if (unknown.length === 1) {
    return unknown[0]!;
  }
  return ports.length === 1 ? ports[0]! : null;
}

/** The policy mode in words (config.json ports.mode). */
export function modeWords(mode: string | undefined): { word: string; detail: string } {
  if (mode === 'all') {
    return { word: 'All ports', detail: 'the hub opens every ESP32 and USB-UART port it sees' };
  }
  if (mode === 'adopted') {
    return { word: 'Adopted only', detail: 'the hub opens only the ports of registered boards and the ports you claim' };
  }
  return { word: mode ?? 'unknown', detail: '' };
}

// ------------------------------------------------------------------ spans

const PREON = Unit.PREON;
const FLAVON = Unit.FLAVON;

/** What the lend choices need of the core: a unit's level and its period now, in seconds. */
export interface SpanCore {
  unitLevel(unit: number): number | null;
  periodSeconds(level: number, interval: unknown): number;
  formatUnitSymbol(unit: number): string;
}

export interface LendChoice {
  /** The lease's TTL for port_lend (whole seconds, 1..1800). */
  ttl_s: number;
  /** The span in Fractonica notation ("1ι", "30λ"). */
  label: string;
}

/** The lease cap (spec 09 §9.2): 30 min. */
export const LEASE_MAX_S = 1800;

/**
 * The lend times offered: whole Preons that fit the lease cap (1ι, 2ι, 3ι; about 8, 17 and 25 minutes) and, first,
 * 30λ, so a short flash need not hold the port long. Labels are the core's symbols; the seconds are what the op takes.
 */
export function lendChoices(frc: SpanCore, interval: unknown): LendChoice[] {
  const out: LendChoice[] = [];
  const flavon = frc.unitLevel(FLAVON);
  const preon = frc.unitLevel(PREON);
  if (flavon !== null) {
    const s = Math.round(30 * frc.periodSeconds(flavon, interval));
    if (s >= 1 && s <= LEASE_MAX_S) {
      out.push({ ttl_s: s, label: `30${frc.formatUnitSymbol(FLAVON)}` });
    }
  }
  if (preon !== null) {
    const one = frc.periodSeconds(preon, interval);
    for (let n = 1; n * one <= LEASE_MAX_S; n++) {
      out.push({ ttl_s: Math.floor(n * one), label: `${n}${frc.formatUnitSymbol(PREON)}` });
    }
  }
  return out;
}
