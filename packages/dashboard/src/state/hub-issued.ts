// Fields only the hub can issue (DEVICE-SPEC §2.4, rule G3): a device command whose field names a stream the hub
// opened (stream_id: the POST path the board sends to; play_id: the GET path it pulls from) can never be filled by a
// person, because a made-up id points the board at a path the hub never opened. Such a command is never a form on the
// device page, neither on an instrument page nor in Engineering › Commands; the hub runs it through its own op
// (camera_stream, csi_stream, audio_record, audio_play), and the page says so (pages/device/panels/hub-runs.tsx).
//
// test/hub-issued.test.ts checks this table against the catalog: every field whose doc says "issued by the hub" is
// here, and every entry names a real command and field. stream_stop's stream_id is here too although its doc does
// not say so: it is the running stream's id, which only the hub knows.

import type { CatalogCommand } from '@fractonica/protocol/gen';

/** cap → command → its hub-issued fields. */
export const HUB_ISSUED: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  'fr.camera': { stream_start: ['stream_id'], stream_stop: ['stream_id'], sd_fetch: ['stream_id'] },
  'fr.csi': { stream_start: ['stream_id'], stream_stop: ['stream_id'] },
  'fr.audio_in': { stream_start: ['stream_id'], stream_stop: ['stream_id'] },
  'fr.audio_out': { play: ['play_id'] },
};

/** The hub-issued fields of a command ([] for an ordinary command). */
export function hubIssuedFields(cap: string, cmd: Pick<CatalogCommand, 'name'> | string): readonly string[] {
  return HUB_ISSUED[cap]?.[typeof cmd === 'string' ? cmd : cmd.name] ?? [];
}

/** True when a person cannot fill this command: it is never offered as a form. */
export function isHubIssued(cap: string, cmd: Pick<CatalogCommand, 'name'> | string): boolean {
  return hubIssuedFields(cap, cmd).length > 0;
}

/** How the hub runs a hub-issued command: its op, and the `fr` command line a person can copy (null: none fits). */
export interface HubWay {
  op: string;
  /** The words of what it does, pure-safe. */
  words: string;
  /** A purpose-built panel on the instrument's page does it (the pointer links there). */
  panel: boolean;
  cli: (alias: string, instance: string) => string | null;
}

const WAYS: Readonly<Record<string, HubWay>> = {
  'fr.camera': { op: 'camera_stream', words: 'Watch, Record and Play on the camera’s page do this', panel: true, cli: (a) => `fr camera stream ${a}` },
  'fr.csi': { op: 'csi_stream', words: 'the hub streams it', panel: false, cli: (a, i) => `fr csi stream ${a} --instance ${i} --seconds 60` },
  'fr.audio_in': { op: 'audio_record', words: 'the hub records it to a file', panel: false, cli: (a, i) => `fr audio record ${a} <absolute .wav under FR_HOME> --instance ${i} --seconds 10` },
  'fr.audio_out': { op: 'audio_play', words: 'the hub plays a file or a tone on it', panel: false, cli: (a, i) => `fr audio play ${a} <absolute .wav> --instance ${i}` },
};

/** The way the hub runs a capability's hub-issued commands; null for a capability without any. */
export function hubWay(cap: string): HubWay | null {
  return WAYS[cap] ?? null;
}
