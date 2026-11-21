// `call` and `result` over the hubs' link (design multi-hub-m2 §3.3, §7): one op passed to a peer, and its whole
// Result envelope back. This module is the request/response layer and nothing above it: ids, timeouts, a peer that
// goes away mid-call, and JSON too large for one control frame (sent as data frames on a channel the message names).
// What a call means (which op, where it may run, what its files are) is its owner's (passing.ts), through `serve`.
//
// - A call never rejects: every way it can fail is a failed Result that names the hub, so the client of the calling
//   hub gets an envelope whatever happened.
// - Timeouts. The caller waits the op's own wait plus a margin (the caller of `call` gives the sum); the answer of a
//   call that timed out here is dropped when it comes.
// - A peer that goes away mid-call: HUB_UNREACHABLE naming the hub, `retryable` only when the op is read-only or
//   idempotent (the op may have run, or half run, at that hub).
// - Nothing here logs an input: a call is logged at the hub that serves it by its op, the calling hub, how long it
//   took and how it ended.

import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type { ErrorCode, Result, ToolError } from '@fractonica/protocol';

import type { PeerLinks, PeerView } from './link.ts';
import { type BodyRef, type CallMsg, DATA_CHUNK, EnvelopeSchema, MAX_CONTROL_BYTES, type PeerMessage, type ResultMsg } from './wire.ts';

/** JSON larger than this travels as data frames, not inside the control message (which is capped at MAX_CONTROL_BYTES). */
export const BODY_INLINE_MAX = 256 * 1024;
/** A body's channel numbers have the top bit set: they never meet the numbers of the channels a hub opens (channels.ts). */
const BODY_CH = 0x80000000;
/** A body announced and not complete after this is dropped (its sender went away or stalled). */
const BODY_MS = 30_000;

/** A failed Result with `retryable` said outright (FrError derives it from the code alone). */
export function failed(code: ErrorCode, message: string, extra: { retryable?: boolean; hint?: string; details?: Record<string, unknown>; remediation?: ToolError['remediation'] } = {}): Result {
  return {
    ok: false,
    cursor: '',
    error: {
      code,
      message,
      retryable: extra.retryable ?? false,
      ...(extra.hint ? { hint: extra.hint } : {}),
      ...(extra.remediation ? { remediation: extra.remediation } : {}),
      ...(extra.details ? { details: extra.details } : {}),
    },
  };
}

export interface CallOptions {
  mode: CallMsg['mode'];
  /** The calling client's origin (design c6 D18): the job the op starts at the peer records it. */
  client?: string;
  /** The whole wait: the op's own plus the margin. */
  timeoutMs: number;
  /** The op is read-only or idempotent: a call cut by a lost link may be tried again. */
  repeatable: boolean;
  files?: CallMsg['files'];
  signal?: AbortSignal;
}

/** What a call answers: the peer's Result envelope, and the spool it wrote the call's `out` files in. */
export interface CallAnswer {
  result: Result;
  spool?: string;
}

export interface CallsDeps {
  links: Pick<PeerLinks, 'send' | 'sendData' | 'drained'>;
  /** Runs a call that arrived from `peer` and answers it; a throw becomes a failed Result. */
  serve(peer: PeerView, msg: CallMsg, input: Record<string, unknown>): Promise<CallAnswer>;
  log?(line: Record<string, unknown>): void;
}

interface Pending {
  peer: string;
  name: string;
  op: string;
  repeatable: boolean;
  resolve(a: CallAnswer): void;
  timer: NodeJS.Timeout;
}

interface Body {
  size: number;
  chunks: Buffer[];
  have: number;
  done(json: unknown | undefined): void;
  timer: NodeJS.Timeout;
}

export interface CallCounters {
  calls_out: number;
  calls_in: number;
  /** Calls this hub made that ended without the peer's answer: timed out, or the peer went away. */
  calls_lost: number;
  /** Answers that came for a call no longer waited for. */
  results_late: number;
  bodies: number;
}

export class PeerCalls {
  #deps: CallsDeps;
  #pending = new Map<string, Pending>();
  /** Bodies being received: `<hub id>:<channel>`. */
  #bodies = new Map<string, Body>();
  #bodyN = 0;
  readonly counters: CallCounters = { calls_out: 0, calls_in: 0, calls_lost: 0, results_late: 0, bodies: 0 };

  constructor(deps: CallsDeps) {
    this.#deps = deps;
  }

  /** Calls in flight to peers (hub_status). */
  pending(): number {
    return this.#pending.size;
  }

  /** One op (or link service) at `peer`. Resolves with its answer, or with a failed Result naming the hub. */
  call(peer: PeerView, op: string, input: Record<string, unknown>, opts: CallOptions): Promise<CallAnswer> {
    if (!peer.reachable) {
      return Promise.resolve({ result: unreachable(peer, op, 'the link to it is down', true) });
    }
    const id = randomBytes(9).toString('base64url');
    this.counters.calls_out++;
    return new Promise<CallAnswer>((resolve) => {
      const finish = (a: CallAnswer) => {
        const p = this.#pending.get(id);
        if (p) {
          clearTimeout(p.timer);
          this.#pending.delete(id);
          opts.signal?.removeEventListener('abort', onAbort);
          resolve(a);
        }
      };
      const onAbort = () => {
        this.counters.calls_lost++;
        finish({ result: failed('TIMEOUT', `${op} at hub ${peer.name} was given up by its caller; it may still run there`, { retryable: opts.repeatable }) });
      };
      const timer = setTimeout(() => {
        this.counters.calls_lost++;
        finish({
          result: failed('TIMEOUT', `hub ${peer.name} did not answer ${op} within ${Math.round(opts.timeoutMs / 1000)} s`, {
            retryable: opts.repeatable,
            hint: `the op may still be running at hub ${peer.name}: fr --at ${peer.name} jobs ls`,
            details: { hub: peer.name, op },
          }),
        });
      }, opts.timeoutMs);
      this.#pending.set(id, { peer: peer.id, name: peer.name, op, repeatable: opts.repeatable, resolve: finish, timer });
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const head = { t: 'call' as const, v: 1, id, op, mode: opts.mode, ...(opts.client ? { client: opts.client } : {}), timeout_ms: Math.round(opts.timeoutMs), ...(opts.files ? { files: opts.files } : {}) };
      void this.#sendJson(peer, head, 'input', input).then((sent) => {
        if (!sent) {
          this.counters.calls_lost++;
          finish({ result: unreachable(peer, op, 'the link to it went down', true) });
        }
      });
    });
  }

  /** A `call` or a `result` from `peer`; false for another message. */
  onMessage(peer: PeerView, msg: PeerMessage): boolean {
    if (msg.t === 'call') {
      this.counters.calls_in++;
      void this.#withJson(peer, msg.input, msg.body).then((input) => this.#serve(peer, msg, input));
      return true;
    }
    if (msg.t === 'result') {
      void this.#withJson(peer, msg.result, msg.body).then((result) => this.#result(peer, msg, result));
      return true;
    }
    return false;
  }

  /** Bytes of a data channel: true when they were a body's. */
  onData(peer: PeerView, ch: number, bytes: Buffer): boolean {
    if (ch < BODY_CH) {
      return false;
    }
    const key = `${peer.id}:${ch}`;
    const b = this.#bodies.get(key);
    if (b) {
      b.chunks.push(Buffer.from(bytes));
      b.have += bytes.length;
      if (b.have >= b.size) {
        this.#bodies.delete(key);
        clearTimeout(b.timer);
        let json: unknown;
        try {
          json = JSON.parse(Buffer.concat(b.chunks, b.have).toString('utf8'));
        } catch {
          json = undefined;
        }
        b.done(json);
      }
    }
    return true;
  }

  /** `peer` went away: every call to it ends now, and what it was sending is dropped. */
  onDown(peer: PeerView, why: string): void {
    for (const p of [...this.#pending.values()]) {
      if (p.peer === peer.id) {
        this.counters.calls_lost++;
        p.resolve({ result: unreachable(peer, p.op, `it went away while the op ran (${why})`, p.repeatable) });
      }
    }
    for (const [key, b] of [...this.#bodies]) {
      if (key.startsWith(`${peer.id}:`)) {
        this.#bodies.delete(key);
        clearTimeout(b.timer);
        b.done(undefined);
      }
    }
  }

  stop(): void {
    for (const p of [...this.#pending.values()]) {
      p.resolve({ result: failed('HUB_UNREACHABLE', `this hub is stopping: ${p.op} at hub ${p.name} was given up`, { retryable: p.repeatable }) });
    }
    for (const b of this.#bodies.values()) {
      clearTimeout(b.timer);
    }
    this.#bodies.clear();
  }

  // ---- in ----

  async #serve(peer: PeerView, msg: CallMsg, input: unknown): Promise<void> {
    const t0 = performance.now();
    let answer: CallAnswer;
    if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) {
      answer = { result: failed('INVALID_ARGS', `${msg.op}: the input did not arrive whole`, { retryable: true }) };
    } else {
      try {
        answer = await this.#deps.serve(peer, msg, (input ?? {}) as Record<string, unknown>);
      } catch (e) {
        answer = { result: failed('INTERNAL', e instanceof Error ? e.message : String(e)) };
      }
    }
    // As a local op is counted (hub_status `rest`), a peer's call is logged: the op, the calling hub, never its input.
    this.#deps.log?.({ event: 'peer_call', op: msg.op, from: peer.name, mode: msg.mode, ms: Math.round(performance.now() - t0), ok: answer.result.ok, ...(answer.result.ok ? {} : { code: answer.result.error?.code }) });
    await this.#sendJson(peer, { t: 'result' as const, v: 1, id: msg.id, ...(answer.spool ? { spool: answer.spool } : {}) }, 'result', answer.result);
  }

  #result(peer: PeerView, msg: ResultMsg, result: unknown): void {
    const p = this.#pending.get(msg.id);
    if (!p || p.peer !== peer.id) {
      this.counters.results_late++;
      return;
    }
    const parsed = EnvelopeSchema.safeParse(result);
    p.resolve(
      parsed.success
        ? { result: parsed.data as unknown as Result, ...(msg.spool ? { spool: msg.spool } : {}) }
        : { result: failed('INTERNAL', `hub ${peer.name} answered ${p.op} with something that is not a Result`, { retryable: p.repeatable, details: { hub: peer.name } }) },
    );
  }

  // ---- JSON that may not fit a control frame ----

  /** Sends `head` with `value` under `field`, or as a body on a channel when it is large. False when the link is gone. */
  async #sendJson(peer: PeerView, head: Record<string, unknown>, field: 'input' | 'result', value: unknown): Promise<boolean> {
    const json = Buffer.from(JSON.stringify(value ?? null), 'utf8');
    if (json.length <= BODY_INLINE_MAX && json.length + 512 < MAX_CONTROL_BYTES) {
      return this.#deps.links.send(peer.id, { ...head, [field]: value } as unknown as PeerMessage);
    }
    this.#bodyN = (this.#bodyN + 1) & 0x7fffffff;
    const ch = (BODY_CH | this.#bodyN) >>> 0;
    this.counters.bodies++;
    if (!this.#deps.links.send(peer.id, { ...head, body: { ch, size: json.length } } as unknown as PeerMessage)) {
      return false;
    }
    for (let at = 0; at < json.length; at += DATA_CHUNK) {
      if (!(await this.#deps.links.drained(peer.id)) || !this.#deps.links.sendData(peer.id, ch, json.subarray(at, at + DATA_CHUNK))) {
        return false;
      }
    }
    return true;
  }

  /** The JSON of a message: what it carries inline, or its body once the data frames are in (undefined when they never are). */
  #withJson(peer: PeerView, inline: unknown, body: BodyRef | undefined): Promise<unknown> {
    if (!body) {
      return Promise.resolve(inline);
    }
    if (body.size === 0) {
      return Promise.resolve(undefined);
    }
    return new Promise<unknown>((resolve) => {
      const key = `${peer.id}:${body.ch}`;
      const timer = setTimeout(() => {
        this.#bodies.delete(key);
        resolve(undefined);
      }, BODY_MS);
      this.#bodies.set(key, { size: body.size, chunks: [], have: 0, done: resolve, timer });
    });
  }
}

function unreachable(peer: Pick<PeerView, 'name' | 'last_error'>, op: string, why: string, retryable: boolean): Result {
  return failed('HUB_UNREACHABLE', `hub ${peer.name} is not reachable: ${why}${retryable ? '' : `; ${op} may have run there, so it is not tried again by itself`}`, {
    retryable,
    hint: `fr hub peers shows the link to hub ${peer.name}`,
    remediation: [{ tool: 'hub_peers', cli: 'fr hub peers' }],
    details: { hub: peer.name, op, ...(peer.last_error ? { last_error: peer.last_error } : {}) },
  });
}
