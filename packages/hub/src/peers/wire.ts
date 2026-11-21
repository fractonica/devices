// What the hubs' link carries (design multi-hub-m2 §3.3): length-prefixed frames on the one TLS connection between
// two hubs. A frame is `u32 length (big endian) | u8 kind | payload`, the length counting the kind and the payload.
//   kind 1  a control message: one JSON object `{ t, v, ... }`, UTF-8.
//   kind 2  bytes of a data channel (a file, a firmware image, a message too large for one control frame): `u32
//           channel (big endian) | bytes`, at most DATA_CHUNK bytes each so pings and control messages go between them.
// Step 2.1's messages: `hello` and its answer `ready` or `refuse`, `members`, `presence`, `ping`/`pong`.
// Step 2.2's (design multi-hub-m2 §7): `call` and `result` (one op passed on, and its Result envelope), and the data
// channels: `open` (the end that wants the bytes asks for them by kind and reference), `accept` (their size), `ack`
// (the receiver's credit: how many bytes it has taken), `close` (either end: done, with the count and the SHA-256, or
// why not). A hub of step 2.1 drops all six as unknown types and counts their data frames.
// Step 2.3's (design multi-hub-m2 §5, §16): `registry`, the rows of the network's registry and their revs. A hub of
// step 2.2 drops it as an unknown type (and is sent none: its hello does not say `registry`).
// Step 2.4's (design multi-hub-m2 §8, §17): `event`, the events and job changes a hub publishes, to every peer whose
// hello says `events` (a hub of step 2.3 says none and is sent none); and a data channel of kind `stream` (`open`,
// `accept`, `ack`, `close` as for a file), whose data frames carry a live stream's text frames and blocks, each behind
// one byte that says which (STREAM_TEXT, STREAM_BLOCK_MORE, STREAM_BLOCK_END). A hub whose hello does not say
// `streams` is opened none (it would answer that it serves no such channel).
// Every control message names its type `t` and the version `v` of that type, so `hello`, `members`, `presence`,
// `registry` and `event` change apart from each other and from the op registry: two hubs on different versions still
// know who is where while one of them is being updated. A reader takes the fields it knows and leaves the rest (the
// schemas are loose), drops a type it does not know and refuses only what breaks the
// framing. Nothing in any message is a secret: the key is the TLS layer's.

import { z } from 'zod';

import { HubMemberSchema } from '@fractonica/protocol';

/** The framing's version, said in `hello`. A hub that does not speak it is refused there. */
export const PEER_WIRE = 1;

export const FRAME_CONTROL = 1;
export const FRAME_DATA = 2;
/** A control message is small (a member list of four, a presence snapshot of a fleet); a data frame is a block. */
export const MAX_CONTROL_BYTES = 1 << 20;
export const MAX_FRAME_BYTES = 4 << 20;

const hub12 = z.string().regex(/^[0-9a-f]{12}$/);

/** The first message each end sends: who it is and what it runs. */
export const HelloSchema = z.looseObject({
  t: z.literal('hello'),
  v: z.number().int(),
  wire: z.number().int(),
  hub_id: hub12,
  name: z.string().min(1).max(31),
  net: z.number().int().min(1).max(0xffff),
  registry_hash: z.string(),
  hub_epoch: z.number().int().min(0).max(0xffff),
  members_version: z.number().int().min(0),
  /** Where its link listens now: the port of "the address it last had" (an accepted connection comes from another one). */
  link_port: z.number().int().min(1).max(65535).optional(),
  hub_version: z.string().optional(),
  /** The version of the `registry` message it speaks (step 2.3); absent from a hub that does not replicate the registry. */
  registry: z.number().int().min(1).optional(),
  /** The version of the `event` message it speaks and sends (step 2.4); absent from a hub that relays no events. */
  events: z.number().int().min(1).optional(),
  /** The version of the `stream` data channel it serves and opens (step 2.4); absent from a hub that relays no streams. */
  streams: z.number().int().min(1).optional(),
});
export type Hello = z.infer<typeof HelloSchema>;

/**
 * A hub's answer to a hello it takes (the right network, a member it knows): from then on it reads this connection.
 * A connection is in use only once both ends said it, so a hub the other end refuses never counts that hub reachable.
 */
export const ReadySchema = z.looseObject({ t: z.literal('ready'), v: z.number().int() });
export type Ready = z.infer<typeof ReadySchema>;

/** Why a hub closes a connection after the other end's hello, said before it does. */
export const REFUSALS = ['net', 'unknown_hub', 'self', 'wire'] as const;
export const RefuseSchema = z.looseObject({
  t: z.literal('refuse'),
  v: z.number().int(),
  code: z.enum(REFUSALS).or(z.string()),
  message: z.string(),
});
export type Refuse = z.infer<typeof RefuseSchema>;

/** The member list, whole, at a version (members.ts): sent by a hub that holds a newer one than its peer said. */
export const MembersSchema = z.looseObject({
  t: z.literal('members'),
  v: z.number().int(),
  version: z.number().int().min(1),
  members: z.array(HubMemberSchema).min(1).max(8),
});
export type MembersMsg = z.infer<typeof MembersSchema>;

/** A board whose session a hub holds. */
export const HeldSchema = z.looseObject({
  device: hub12,
  /** The links its session runs over, best first (tcp, serial, gateway). */
  links: z.array(z.string()).max(4),
  /** The fw id prefix of its HELLO (16 hex), and its boot epoch. */
  fw: z.string().nullable(),
  epoch: z.number().int().nullable(),
});
export type Held = z.infer<typeof HeldSchema>;

/**
 * Who is where (design multi-hub-m2 §6). `full`: every board the sender holds, replacing what the receiver had from
 * it (sent when the link comes up). Otherwise a change: `up` the boards whose session started or whose links changed,
 * `gone` those whose session ended.
 */
export const PresenceSchema = z.looseObject({
  t: z.literal('presence'),
  v: z.number().int(),
  full: z.boolean(),
  up: z.array(HeldSchema).max(4096),
  gone: z.array(hub12).max(4096),
});
export type PresenceMsg = z.infer<typeof PresenceSchema>;

/** A JSON value too large for one control frame, sent as data frames on `ch` right after the message that names it. */
export const BodyRefSchema = z.looseObject({ ch: z.number().int().min(0).max(0xffffffff), size: z.number().int().min(0).max(64 << 20) });
export type BodyRef = z.infer<typeof BodyRefSchema>;

/** How a passed-on op is run by the hub that receives it. */
export const CALL_MODES = ['holder', 'at', 'sys'] as const;

/**
 * One op passed to a peer (design multi-hub-m2 §7). `mode`: `holder`, sent because the caller believes this hub holds
 * the op's board (answered DEVICE_OFFLINE with `at` when it no longer does); `at`, the caller named this hub (run it
 * here whatever it acts on); `sys`, a service of the link itself (calls.ts), not an op. A call that arrived over the
 * link is never passed on again. `client` is the calling client's origin (design c6 D18). `files`: paths of the
 * caller's machine taken out of the input: `out` fields the receiver writes in a spool of its own (the caller pulls
 * them), `in` fields the receiver first fetches from the caller by token.
 */
export const CallSchema = z.looseObject({
  t: z.literal('call'),
  v: z.number().int(),
  id: z.string().min(1).max(64),
  op: z.string().min(1).max(64),
  mode: z.enum(CALL_MODES),
  input: z.record(z.string(), z.unknown()).optional(),
  body: BodyRefSchema.optional(),
  client: z.string().max(16).optional(),
  timeout_ms: z.number().int().min(0).max(3_600_000),
  files: z
    .looseObject({
      out: z.record(z.string(), z.string().max(255)).optional(),
      in: z.record(z.string(), z.looseObject({ token: z.string().max(64), name: z.string().max(255), size: z.number().int().min(0) })).optional(),
    })
    .optional(),
});
export type CallMsg = z.infer<typeof CallSchema>;

/** A Result envelope as it crosses the link (packages/protocol result.ts). */
export const EnvelopeSchema = z.looseObject({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.looseObject({ code: z.string(), message: z.string(), retryable: z.boolean() }).optional(),
  cursor: z.string(),
  warnings: z.array(z.string()).optional(),
});

/** The answer to a `call`: the op's whole Result envelope, and the spool its `out` files were written in. */
export const ResultSchema = z.looseObject({
  t: z.literal('result'),
  v: z.number().int(),
  id: z.string().min(1).max(64),
  result: EnvelopeSchema.optional(),
  body: BodyRefSchema.optional(),
  spool: z.string().max(64).optional(),
});
export type ResultMsg = z.infer<typeof ResultSchema>;

/** The end that wants a stream of bytes asks for it: `kind` and `ref` say which (channels.ts). */
export const OpenSchema = z.looseObject({
  t: z.literal('open'),
  v: z.number().int(),
  ch: z.number().int().min(0).max(0x7fffffff),
  kind: z.string().min(1).max(32),
  ref: z.record(z.string(), z.unknown()),
});
export type OpenMsg = z.infer<typeof OpenSchema>;

/** The provider's answer to an `open` it serves: how many bytes follow as data frames. */
export const AcceptSchema = z.looseObject({ t: z.literal('accept'), v: z.number().int(), ch: z.number().int().min(0), size: z.number().int().min(0) });
export type AcceptMsg = z.infer<typeof AcceptSchema>;

/** The receiver's credit: it has taken `bytes` of the channel so far (the provider keeps at most a window ahead). */
export const AckSchema = z.looseObject({ t: z.literal('ack'), v: z.number().int(), ch: z.number().int().min(0), bytes: z.number().int().min(0) });
export type AckMsg = z.infer<typeof AckSchema>;

/**
 * The end of a channel. From the provider after its last byte: `ok`, `bytes` and `sha256` of what it sent, or why it
 * sends nothing (`code`, `message`). From the receiver: it gives the channel up.
 */
export const CloseSchema = z.looseObject({
  t: z.literal('close'),
  v: z.number().int(),
  ch: z.number().int().min(0),
  ok: z.boolean(),
  bytes: z.number().int().min(0).optional(),
  sha256: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});
export type CloseMsg = z.infer<typeof CloseSchema>;

/** A rev and the hub that wrote it (registry/sync.ts). */
const StampSchema = z.tuple([z.number().int().min(0), z.string().max(12)]);

/** One row of the registry as it crosses (registry/sync.ts WireRow, which checks every field again before it stores one). */
export const RegistryRowSchema = z.looseObject({
  id: hub12,
  row: StampSchema,
  gone: z.boolean().optional(),
  core: z.looseObject({ addr: z.number().int().nullable(), net: z.number().int().nullable(), tags: z.array(z.string()).max(64) }).optional(),
  alias: z.looseObject({ at: StampSchema, alias: z.string().max(63), alias_rev: z.number().int().min(0) }).optional(),
  hubs: z.looseObject({ at: StampSchema }).optional(),
  fw: z.looseObject({ at: StampSchema }).optional(),
});

/** How many rows one `registry` message carries at most: a row is a few hundred bytes, a control frame at most 1 MiB. */
export const REGISTRY_ROWS_MAX = 64;
/** How many rows a digest names: a registry of this size is far past what a network holds. */
export const REGISTRY_DIGEST_MAX = 8192;

/**
 * The registry of the network (design multi-hub-m2 §5, §16), versioned by `v` on its own and not by the op registry's
 * hash: two hubs on different versions of the ops keep each other's rows current. `k`:
 *   `digest`  every row the sender holds as `[device id, hash]`: the receiver answers with the rows it holds otherwise;
 *   `rows`    rows with their revs: the receiver merges them and answers with those it then holds otherwise, or `state`;
 *   `state`   nothing to send: only `hash` and `n`. It is never answered.
 * Every message says the sender's `hash` over its whole registry and its row count `n` (tombstones included): two hubs
 * are in step when they say the same hash. Nothing in it is a secret: no password is in a registry row.
 */
export const RegistrySchema = z.looseObject({
  t: z.literal('registry'),
  v: z.number().int().min(1),
  k: z.enum(['digest', 'rows', 'state']),
  hash: z.string().max(64),
  n: z.number().int().min(0),
  digest: z.array(z.tuple([hub12, z.string().max(64)])).max(REGISTRY_DIGEST_MAX).optional(),
  rows: z.array(RegistryRowSchema).max(REGISTRY_ROWS_MAX).optional(),
});
export type RegistryMsg = z.infer<typeof RegistrySchema>;

/** The `event` message's version (said in the hello as `events`), its own and not the op registry's hash. */
export const EVENTS_WIRE = 1;
/** One `event` message carries at most this many events and job changes, and about this many bytes of them. */
export const EVENT_BATCH_MAX = 256;
export const EVENT_BATCH_BYTES = 64 * 1024;

/** A job's status, stage or progress as it crosses (what a `/ws` job frame says, and which of them changed). */
export const JobChangeSchema = z.looseObject({
  job_id: z.string().min(1).max(64),
  kind: z.string().max(32),
  status: z.string().max(32),
  stage: z.string().max(128).optional(),
  progress: z.looseObject({ pct: z.number().optional(), message: z.string().max(1024).optional() }).optional(),
  change: z.enum(['status', 'stage', 'progress']),
});
export type JobChangeMsg = z.infer<typeof JobChangeSchema>;

/**
 * What a hub publishes, for its peers (design multi-hub-m2 §8, §17). `events`: events of this hub's own bus, as it
 * stored them (its own `seq` and `cursor`), oldest first; never one it was itself sent by a peer, so nothing is relayed
 * twice. `snapshot`: these are the current values of properties (sent when a link comes up), not new events. `jobs`:
 * changes of the jobs it runs. `now_us`: its hub clock when it wrote the message: the receiver moves each event's
 * `t_hub_us` into its own clock by it. `dropped`: events it did not send since its last message, because its queue to
 * this peer was full (the link was slow). Nothing in an event is a secret: an event is what any `/ws` client reads.
 */
export const EventSchema = z.looseObject({
  t: z.literal('event'),
  v: z.number().int().min(1),
  now_us: z.number(),
  /** Each is checked by itself against the HubEvent schema when it is taken (peers/events.ts): one bad event costs only itself. */
  events: z.array(z.unknown()).max(EVENT_BATCH_MAX).optional(),
  snapshot: z.boolean().optional(),
  /** On a snapshot's first message: what the receiver kept of this hub's state before is replaced. */
  first: z.boolean().optional(),
  jobs: z.array(JobChangeSchema).max(EVENT_BATCH_MAX).optional(),
  dropped: z.number().int().min(0).optional(),
});
export type EventMsg = z.infer<typeof EventSchema>;

/** The `stream` channel's version (said in the hello as `streams`). */
export const STREAMS_WIRE = 1;
/** The first byte of a `stream` channel's data frame: a text frame (JSON, whole), or bytes of a block and whether more follow. */
export const STREAM_TEXT = 0;
export const STREAM_BLOCK_MORE = 1;
export const STREAM_BLOCK_END = 2;

export const PingSchema = z.looseObject({ t: z.enum(['ping', 'pong']), v: z.number().int(), n: z.number().int() });
export type PingMsg = z.infer<typeof PingSchema>;

/** The control messages of steps 2.1 to 2.4. */
export type PeerMessage = Hello | Ready | Refuse | MembersMsg | PresenceMsg | PingMsg | CallMsg | ResultMsg | OpenMsg | AcceptMsg | AckMsg | CloseMsg | RegistryMsg | EventMsg;

const SCHEMAS: Record<string, z.ZodType> = {
  hello: HelloSchema,
  ready: ReadySchema,
  refuse: RefuseSchema,
  members: MembersSchema,
  presence: PresenceSchema,
  ping: PingSchema,
  pong: PingSchema,
  call: CallSchema,
  result: ResultSchema,
  open: OpenSchema,
  accept: AcceptSchema,
  ack: AckSchema,
  close: CloseSchema,
  registry: RegistrySchema,
  event: EventSchema,
};

/** The bytes of one data frame's payload after its channel: small, so a ping waits behind one chunk, not a megabyte. */
export const DATA_CHUNK = 64 * 1024;

/** Bytes of channel `ch` as a data frame. */
export function encodeData(ch: number, bytes: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(9 + bytes.length);
  out.writeUInt32BE(5 + bytes.length, 0);
  out[4] = FRAME_DATA;
  out.writeUInt32BE(ch >>> 0, 5);
  out.set(bytes, 9);
  return out;
}

/** One control message as a frame. */
export function encodeControl(msg: PeerMessage): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const out = Buffer.allocUnsafe(5 + body.length);
  out.writeUInt32BE(1 + body.length, 0);
  out[4] = FRAME_CONTROL;
  body.copy(out, 5);
  return out;
}

/** One control message already serialized (an `event` batch, whose events were serialized once for every peer) as a frame. */
export function encodeControlJson(json: string): Buffer {
  const n = Buffer.byteLength(json, 'utf8');
  const out = Buffer.allocUnsafe(5 + n);
  out.writeUInt32BE(1 + n, 0);
  out[4] = FRAME_CONTROL;
  out.write(json, 5, 'utf8');
  return out;
}

/** What a decoder hands on: a message this step knows, a control message of a type or shape it does not, or data. */
export type Decoded =
  | { kind: 'message'; msg: PeerMessage }
  | { kind: 'unknown'; t: string | null }
  | { kind: 'data'; ch: number; bytes: Buffer };

/** A frame that breaks the framing: the connection is closed. */
export class WireError extends Error {}

/** Parses a control frame's payload; `unknown` for a type of a later step or a message that does not have its fields. */
export function parseControl(payload: Buffer): Decoded {
  let v: unknown;
  try {
    v = JSON.parse(payload.toString('utf8'));
  } catch {
    throw new WireError('a control frame that is not JSON');
  }
  const t = v !== null && typeof v === 'object' && typeof (v as { t?: unknown }).t === 'string' ? (v as { t: string }).t : null;
  const schema = t === null ? undefined : SCHEMAS[t];
  if (!schema) {
    return { kind: 'unknown', t };
  }
  const parsed = schema.safeParse(v);
  return parsed.success ? { kind: 'message', msg: parsed.data as PeerMessage } : { kind: 'unknown', t };
}

/**
 * Cuts a byte stream into frames. `push` returns what the bytes so far complete; it throws WireError on bad framing.
 * The bytes not yet a whole frame are kept as the chunks they came in and joined once, when the frame is whole: a
 * megabyte frame arriving in TLS records costs one copy, not one per record.
 */
export class FrameDecoder {
  #chunks: Buffer[] = [];
  #have = 0;

  #take(n: number): Buffer {
    let head = this.#chunks[0];
    if (head.length < n) {
      head = Buffer.concat(this.#chunks, this.#have);
      this.#chunks = [head];
    }
    const out = head.subarray(0, n);
    if (head.length === n) {
      this.#chunks.shift();
    } else {
      this.#chunks[0] = head.subarray(n);
    }
    this.#have -= n;
    return out;
  }

  /** The first `n` bytes without taking them (n is small: a frame's length and kind). */
  #peek(n: number): Buffer {
    if (this.#chunks[0].length >= n) {
      return this.#chunks[0];
    }
    const out = Buffer.allocUnsafe(n);
    let at = 0;
    for (const c of this.#chunks) {
      at += c.copy(out, at, 0, Math.min(c.length, n - at));
      if (at >= n) {
        break;
      }
    }
    return out;
  }

  push(chunk: Buffer): Decoded[] {
    if (chunk.length) {
      this.#chunks.push(chunk);
      this.#have += chunk.length;
    }
    const out: Decoded[] = [];
    for (;;) {
      if (this.#have < 4) {
        return out;
      }
      const len = this.#peek(4).readUInt32BE(0);
      if (len < 1 || len > MAX_FRAME_BYTES) {
        throw new WireError(`a frame of ${len} bytes`);
      }
      if (this.#have < 4 + len) {
        return out;
      }
      const frame = this.#take(4 + len);
      const kind = frame[4];
      const payload = frame.subarray(5);
      if (kind === FRAME_CONTROL) {
        if (payload.length > MAX_CONTROL_BYTES) {
          throw new WireError(`a control message of ${payload.length} bytes`);
        }
        out.push(parseControl(payload));
      } else if (kind === FRAME_DATA) {
        // A data frame is its channel and bytes; one too short to name a channel is nothing this step knows.
        out.push(payload.length < 4 ? { kind: 'unknown', t: null } : { kind: 'data', ch: payload.readUInt32BE(0), bytes: payload.subarray(4) });
      } else {
        // A frame kind of a later version: its length is known, so it is skipped, not fatal.
        out.push({ kind: 'unknown', t: null });
      }
    }
  }
}
