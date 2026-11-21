// Another hub's API as this hub calls it (device_provision `for_hub`, 06 §6.4 "For another hub"): one op is a POST of
// its JSON input to `<base>/api/v1/op/<name>`, answered with a Result envelope, as the CLI calls a hub
// (packages/cli/src/client.ts). The other hub's web guard (web/guard.ts) wants Content-Type application/json, no
// foreign Origin (none is sent) and a Host that is its own loopback name and port: an SSH tunnel to it must therefore
// listen on 127.0.0.1 at that hub's own API port. Every failure is an FrError that names the other hub; nothing sent or
// logged here is a secret (device_enroll takes and answers no Wi-Fi credentials).

import { ERROR_CODES, type ErrorCode, FrError, HUB_API_PORT, type Result, type ToolError } from '@fractonica/protocol';

/** One call's budget: the other hub answers device_enroll and device_get from SQLite and memory. */
export const REMOTE_CALL_MS = 8000;

export type Fetch = typeof fetch;

/** `for_hub` as given, without a trailing slash: what is called, logged and recorded. */
export function hubBase(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new FrError('INVALID_ARGS', `${JSON.stringify(url)} is not the URL of a hub API`, { hint: 'e.g. http://127.0.0.1:7520' });
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
    throw new FrError('INVALID_ARGS', `${JSON.stringify(url)} is not the base URL of a hub API (scheme, host and port only)`, { hint: 'e.g. http://127.0.0.1:7520' });
  }
  return u.origin;
}

/** What to try when the other hub does not answer, or answers that the request was not for it. */
function reachHint(base: string): string {
  return `is that hub running, and the tunnel to it open? It answers only as 127.0.0.1 at its own API port, so a tunnel listens on that same port here (ssh -N -L <port>:127.0.0.1:<port> <user>@<its host>; this hub's own API is ${HUB_API_PORT}), then: curl ${base}/api/v1/health`;
}

function unreachable(base: string, why: string): FrError {
  return new FrError('HUB_UNREACHABLE', `the hub at ${base} is not reachable (${why})`, {
    hint: reachHint(base),
    details: { for_hub: base },
  });
}

function asCode(code: unknown): ErrorCode {
  return (ERROR_CODES as readonly unknown[]).includes(code) ? (code as ErrorCode) : 'INTERNAL';
}

/**
 * Calls op `name` of the hub at `base` and returns its data. Throws an FrError naming that hub: HUB_UNREACHABLE when
 * nothing answers, TIMEOUT past `timeoutMs`, HUB_VERSION_MISMATCH when it does not know the op, else the other hub's
 * own error code with its message (its remediation commands are that hub's, so they go into details, not into
 * remediation here).
 */
export async function remoteOp<T = unknown>(
  base: string,
  name: string,
  input: Record<string, unknown>,
  opts: { timeoutMs?: number; signal?: AbortSignal; fetch?: Fetch } = {},
): Promise<T> {
  const ms = opts.timeoutMs ?? REMOTE_CALL_MS;
  const timeout = AbortSignal.timeout(ms);
  let status: number;
  let body: unknown;
  try {
    const r = await (opts.fetch ?? fetch)(`${base}/api/v1/op/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      redirect: 'error',
    });
    status = r.status;
    const text = await r.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  } catch (e) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason instanceof Error ? opts.signal.reason : new FrError('INTERNAL', 'cancelled');
    }
    if (timeout.aborted) {
      throw new FrError('TIMEOUT', `the hub at ${base} did not answer ${name} within ${ms} ms`, { hint: reachHint(base), details: { for_hub: base } });
    }
    const cause = (e as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
    const why = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : e instanceof Error ? e.message : String(e);
    throw unreachable(base, why);
  }
  const res = body as Partial<Result<T>> | null | undefined;
  if (!res || typeof res !== 'object' || typeof res.ok !== 'boolean') {
    throw unreachable(base, `HTTP ${status}, not a hub's answer`);
  }
  if (res.ok) {
    return res.data as T;
  }
  const err = (res.error ?? {}) as Partial<ToolError>;
  const message = typeof err.message === 'string' ? err.message : `HTTP ${status}`;
  const details = { for_hub: base, op: name, status, error: err };
  if (status === 404 && err.code === 'NOT_FOUND' && message.startsWith('unknown op')) {
    throw new FrError('HUB_VERSION_MISMATCH', `the hub at ${base} does not know ${name}: it runs an older version`, {
      hint: 'update that hub to this checkout and restart it, then provision again',
      details,
    });
  }
  if (status === 421 || status === 403 || status === 415) {
    // Its web guard: the Host is not its own (a tunnel on another port), or something in between rewrote the request.
    throw new FrError('HUB_UNREACHABLE', `the hub at ${base} refused the request: ${message}`, { hint: reachHint(base), details });
  }
  throw new FrError(asCode(err.code), `the hub at ${base} refused ${name}: ${message}`, {
    hint: typeof err.hint === 'string' ? `on that hub: ${err.hint}` : `the board was not touched; fix this on the hub at ${base} and provision again`,
    details,
  });
}

/**
 * Whether a hub answers at `base` (GET /api/v1/health), before a job is started for it: HUB_UNREACHABLE naming it
 * otherwise. Returns its version.
 */
export async function remoteHealth(base: string, opts: { timeoutMs?: number; fetch?: Fetch } = {}): Promise<{ version: string | null }> {
  const ms = opts.timeoutMs ?? 3000;
  let r: Response;
  try {
    r = await (opts.fetch ?? fetch)(`${base}/api/v1/health`, { signal: AbortSignal.timeout(ms), redirect: 'error' });
  } catch (e) {
    const cause = (e as { cause?: { code?: unknown } } | null)?.cause;
    const timedOut = /abort|timeout/i.test(`${(e as Error)?.name} ${(e as Error)?.message}`);
    throw unreachable(base, timedOut ? `no answer within ${ms} ms` : typeof cause?.code === 'string' ? cause.code : e instanceof Error ? e.message : String(e));
  }
  type Health = { ok?: unknown; version?: unknown; error?: { message?: unknown } } | null;
  const body = await (r.json() as Promise<Health>).catch((): Health => null); // not JSON: not a hub
  if (!r.ok || body?.ok !== true) {
    const said = typeof body?.error?.message === 'string' ? `: ${body.error.message}` : '';
    throw unreachable(base, `HTTP ${r.status}${said}`);
  }
  return { version: typeof body.version === 'string' ? body.version : null };
}
