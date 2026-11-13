// The hub_doctor checks as both pages say them (the Hub page's one line of health and Settings › Health): a check's
// name for people, its bead (ok lumen, warning hollow bone, error fault), the order a person reads them in, the line's
// word ("all well", "1 error · 2 warnings"), and the fix it offers (a command to copy, a page, steps). Pure, so the
// tests run in node.

import type { Check } from '@fractonica/protocol/client';

import type { BeadState } from '../ui/bead.tsx';

const CHECK_NAMES: Record<string, string> = {
  node: 'Node.js',
  source: 'Source',
  idf: 'ESP-IDF',
  idf_env: 'IDF environment',
  uv_python: 'Python',
  pytools: 'esptool sidecar',
  ccache: 'ccache',
  shim: 'fr command',
  shim_path: 'fr on PATH',
  firewall: 'Firewall',
  hostname: 'Host name',
  lan: 'LAN route',
  serial: 'Serial ports',
  dashboard: 'Dashboard build',
  lnp: 'Local Network',
  advert: 'Advert',
  loop_delay: 'Event loop',
};

/** A check's name for people ("idf_env" → "IDF environment"; an unknown id with its underscores as spaces). */
export function checkName(id: string): string {
  return CHECK_NAMES[id] ?? id.replace(/^web_/, 'app ').replace(/_/g, ' ');
}

export function checkBead(level: Check['level']): BeadState {
  return level === 'ok' ? 'online' : level === 'warn' ? 'waiting' : 'fault';
}

/** Checks in the order a person reads them: errors, then warnings, then the ones that pass; stable within a level. */
export function sortChecks<T extends Pick<Check, 'level'>>(checks: readonly T[]): T[] {
  const rank = { error: 0, warn: 1, ok: 2 } as const;
  return checks.map((c, i) => ({ c, i })).sort((a, b) => rank[a.c.level] - rank[b.c.level] || a.i - b.i).map(({ c }) => c);
}

/** What a check's fix is, so the page can offer it: a command to copy, a page of the dashboard, or steps to read. */
export type CheckFix =
  | { kind: 'hub'; command: string; text: string }
  | { kind: 'command'; command: string; text: string }
  | { kind: 'page'; to: string; params?: Record<string, string>; label: string; text: string }
  | { kind: 'steps'; text: string };

/** Programs a doctor fix starts with when it is a command to run in Terminal. */
const COMMANDS = /^(fr|pnpm|brew|uv|nvm|git|xcode-select|idf\.py|sudo|export|add|dns-sd)\b/;

/**
 * The fix of a check: `fr doctor --fix` (the hub runs it: hub_doctor_fix), `brew install ccache` (a command to copy and
 * run in Terminal), a port held by another program (the Ports section, where it can be lent or ignored), or System
 * Settings steps (text). A command inside backticks in a longer text is taken out of it.
 */
export function checkFix(check: Pick<Check, 'id' | 'fix'>): CheckFix | null {
  const fix = check.fix?.trim();
  if (!fix) {
    return null;
  }
  if (check.id === 'serial') {
    return { kind: 'page', to: '/settings/$section', params: { section: 'ports' }, label: 'Open ports', text: fix };
  }
  if (/^fr doctor --fix$/.test(fix)) {
    return { kind: 'hub', command: fix, text: 'the hub can run this fix' };
  }
  const quoted = /`([^`]+)`/.exec(fix);
  if (quoted && COMMANDS.test(quoted[1]!.trim())) {
    return { kind: 'command', command: quoted[1]!.trim(), text: fix };
  }
  if (COMMANDS.test(fix) && !fix.includes('→')) {
    // "add 'export PATH=…' to ~/.zshrc" is an instruction, not a command: take the quoted part
    const inner = /'([^']+)'/.exec(fix);
    if (fix.startsWith('add ') && inner) {
      return { kind: 'command', command: inner[1]!, text: fix };
    }
    return { kind: 'command', command: fix, text: fix };
  }
  return { kind: 'steps', text: fix };
}

/** One line of health for the hub page: the worst level among the checks. */
export function worstLevel(checks: readonly Pick<Check, 'level'>[]): Check['level'] {
  return checks.some((c) => c.level === 'error') ? 'error' : checks.some((c) => c.level === 'warn') ? 'warn' : 'ok';
}

/** A hub_doctor check (protocol CheckSchema). */
export type DoctorCheck = Pick<Check, 'id' | 'level' | 'detail' | 'fix' | 'fixed'>;

export interface HealthLine {
  checks: { id: string; level: DoctorCheck['level']; bead: BeadState; label: string }[];
  /** The checks that need something done: errors first, then warnings, each with its fix. */
  issues: DoctorCheck[];
  ok: number;
  warn: number;
  error: number;
  /** The checks' word, on the Hub page and in Settings › Health: "all well", "1 warning", "1 error · 1 warning". */
  word: string;
  /** The line's bead: fault with any error, waiting with a warning, online when all is well. */
  bead: BeadState;
}

const LEVEL_WORD: Record<DoctorCheck['level'], string> = { ok: 'ok', warn: 'warning', error: 'error' };
const LEVEL_ORDER: Record<DoctorCheck['level'], number> = { error: 0, warn: 1, ok: 2 };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function healthLine(checks: readonly DoctorCheck[]): HealthLine {
  const ok = checks.filter((c) => c.level === 'ok').length;
  const warn = checks.filter((c) => c.level === 'warn').length;
  const error = checks.filter((c) => c.level === 'error').length;
  const words = [error ? plural(error, 'error') : '', warn ? plural(warn, 'warning') : ''].filter(Boolean);
  return {
    checks: checks.map((c) => ({ id: c.id, level: c.level, bead: checkBead(c.level), label: `${checkName(c.id)}: ${LEVEL_WORD[c.level]}` })),
    issues: checks.filter((c) => c.level !== 'ok').sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]),
    ok,
    warn,
    error,
    word: checks.length === 0 ? 'no checks' : words.length ? words.join(' · ') : 'all well',
    bead: error ? 'fault' : warn ? 'waiting' : checks.length ? 'online' : 'idle',
  };
}

/** The checks the hub can fix itself (their fix is `fr doctor --fix`: hub_doctor_fix runs it), not ok. */
export function hubFixes<T extends Pick<Check, 'level' | 'fix'>>(checks: readonly T[]): T[] {
  return checks.filter((c) => c.level !== 'ok' && /\bfr doctor --fix\b/.test(c.fix ?? ''));
}
