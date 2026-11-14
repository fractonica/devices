// One vocabulary for the states every page names (stage 4 integration): a device's presence in words, an event as
// the words a device's "last word" line uses, and the fleet's count. The beads are ui/bead.tsx presenceBead; these are
// the words beside them, so the Hub, Devices, Device and Settings pages say the same thing the same way.

import type { HubEvent } from '@fractonica/protocol/client';

import { fieldWords } from './device-units.ts';

const PRESENCE_WORDS: Record<string, string> = {
  online: 'online',
  suspect: 'suspect',
  offline: 'offline',
  unknown: 'not heard yet',
  // the hub does not answer now (shell/link.ts usePresence): the page cannot say
  not_known: 'not known',
};

/** A device's presence as a word: online, suspect (seen lately, not answering now), offline, not heard yet. */
export function presenceWord(presence: string | null | undefined): string {
  return PRESENCE_WORDS[presence ?? 'unknown'] ?? presence ?? 'not heard yet';
}

const CLIENT_WORDS: Record<string, string> = { dashboard: 'the dashboard', cli: 'the CLI', mcp: 'an agent', app: 'an app' };

/** "stopped, 949 frames": how a stream ended, from its stream.ended fields. */
function streamEnd(f: Readonly<Record<string, unknown>>): string {
  const reason = typeof f.reason === 'string' ? f.reason.replace(/_/g, ' ') : null;
  const n = typeof f.records === 'number' ? `${f.records} frame${f.records === 1 ? '' : 's'}` : null;
  return [reason, n].filter(Boolean).join(', ');
}

/**
 * The words an event is shown as on a device's line: the hub's own words for presence and links, a command sent
 * ("the dashboard sent blink to flash"), a stream ("cam ended a stream: stopped, 949 frames"), else its type in words.
 */
export function eventWords(e: Pick<HubEvent, 'type'> & { fields?: Readonly<Record<string, unknown>> | undefined }): string {
  const f = e.fields ?? {};
  switch (e.type) {
    case 'op.called': {
      const who = typeof f.client === 'string' ? (CLIENT_WORDS[f.client] ?? f.client) : 'a client';
      if (f.op === 'command_send' && typeof f.command === 'string') {
        return `${who} sent ${f.command.replace(/_/g, ' ')}${typeof f.instance === 'string' ? ` to ${f.instance}` : ''}`;
      }
      return typeof f.op === 'string' ? `${who} ran ${f.op.replace(/_/g, ' ')}` : `${who} ran an op`;
    }
    case 'stream.started':
      return `${typeof f.instance === 'string' ? f.instance : 'it'} started a stream`;
    case 'stream.ended': {
      const how = streamEnd(f);
      return `${typeof f.instance === 'string' ? f.instance : 'it'} ended a stream${how ? `: ${how}` : ''}`;
    }
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
    case 'device.renamed':
    case 'registry.drift':
      return 'renamed';
    default: {
      // a camera's own word that its stream ended (beside the hub's stream.ended, which counts the frames)
      if (e.type.endsWith('.stream_ended')) {
        return `${e.type.slice(0, -'.stream_ended'.length)} said its stream ended`;
      }
      // a capability's event in words: "button.down" → "button down", "status.color" → "color changed"
      const dot = e.type.lastIndexOf('.');
      const cap = dot > 0 ? e.type.slice(0, dot).split('.').pop()! : '';
      const w = fieldWords(e.type.slice(dot + 1));
      return !cap ? w : /^(status|state)$/.test(cap) ? `${w} changed` : `${cap.replace(/_/g, ' ')} ${w}`;
    }
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

const ERROR_WORDS: Record<string, string> = {
  HUB_UNREACHABLE: 'hub not answering',
  DEVICE_OFFLINE: 'device offline',
  DEVICE_UNREACHABLE: 'device not answering',
  INVALID_ARGS: 'not accepted',
  NOT_FOUND: 'not found',
  PORT_BUSY_EXTERNAL: 'port held elsewhere',
  PORT_LEASED: 'port lent',
  PORT_NOT_FOUND: 'port gone',
  LOCKED: 'busy',
  TIMEOUT: 'timed out',
  TARGET_MISMATCH: 'another chip',
  BUILD_FAILED: 'build failed',
  INTERNAL: 'hub error',
  CANCELLED: 'stopped',
  NOT_JOINED: 'not joined',
};

/** An error's code as the words on its line ("port held elsewhere"); a network the board cannot join is said as such. */
export function errorWord(code: string, message = ''): string {
  if (code === 'INCOMPATIBLE_PROFILE') {
    return /\bnetwork\b/.test(message) ? 'network not for this board' : 'profile not for this board';
  }
  return ERROR_WORDS[code] ?? code.toLowerCase().replace(/_/g, ' ');
}

/** What a failed action on a page is called in its toast: "Couldn't rename", never the op's name or its code. */
const ACT_WORDS: Record<string, string> = {
  command_send: 'the command did not go through',
  device_update: 'not changed',
  input_simulate: 'the input did not go through',
  message_send: 'the message did not go through',
  job_cancel: 'could not stop the job',
  port_lend: 'could not lend the port',
  port_claim: 'could not change the port',
  port_ignore: 'could not change the port',
  serial_release: 'could not take the port back',
  network_set: 'the network was not saved',
  build_start: 'the build did not start',
  ota_deploy: 'the update did not start',
  binding_set: 'the binding was not saved',
  binding_clear: 'the binding was not cleared',
  diag_exec: 'the diagnostic did not run',
  display_render: 'nothing was drawn',
  display_snapshot: 'no picture came back',
  part_stock: 'the stock was not changed',
};

/**
 * A failed action as its toast: a title in words, and a body that says what happened and what to do, with the code
 * left for the title attribute. Known codes get the page's own advice.
 */
export function actFailure(op: string, err: { code: string; message: string }, steps: readonly string[]): { title: string; body: string } {
  const w = ACT_WORDS[op] ?? 'that did not work';
  const title = w.charAt(0).toUpperCase() + w.slice(1);
  const advice =
    err.code === 'DEVICE_OFFLINE' || err.code === 'DEVICE_UNREACHABLE'
      ? ['try again when it is back online']
      : err.code === 'HUB_UNREACHABLE'
        ? // the page's own refusal already says so (hooks.ts useAct): the advice would repeat it
          /\b(?:not answering|does not answer)\b/.test(err.message)
          ? []
          : ['the hub does not answer; the page tries again by itself']
        : steps;
  return { title, body: [err.message, ...advice].join(' — ') };
}

/** A device's answer to a command in words (DEVICE-SPEC G8): what Outcome writes beside its bead. */
const OUTCOME_WORDS: Record<string, string> = {
  ok: 'done',
  sent: 'sent; this command is not answered',
  busy: 'busy: it runs another stream',
  unsupported: 'this build does not have that',
  offline: 'offline: nothing was sent',
  timeout: 'no answer in time',
  not_found: 'not found',
  injection_disabled: 'this build does not take test commands',
  failed: 'it tried and failed',
  refused: 'refused',
};

/** The words of a command's status; invalid_args carries the device's reason ("the device refused the values: …"). */
export function outcomeWords(status: string, error?: string | null): string {
  if (status === 'invalid_args') {
    return `the device refused the values${error ? `: ${error}` : ''}`;
  }
  return OUTCOME_WORDS[status] ?? status.replace(/_/g, ' ');
}
