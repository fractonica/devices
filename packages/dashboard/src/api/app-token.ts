// The hub's /app token (DEVICE-SPEC §3.1): the hub writes `window.__FRACTONICA__={token:"…"}` into the dashboard's
// index.html (no-store, admitted by its CSP hash), exactly as it does for an app page. The device page's camera panel
// needs it for `/app/stream`. Read once and kept in this module: never written to storage, a URL, a log, a toast or
// an op.

let read = false;
let token: string | null = null;

/** The token the hub injected, or null (a page not served by the hub, an older hub, or a hub without secrets). */
export function appToken(): string | null {
  if (!read) {
    read = true;
    const g = (globalThis as { __FRACTONICA__?: { token?: unknown } }).__FRACTONICA__;
    token = typeof g?.token === 'string' && g.token ? g.token : null;
  }
  return token;
}
