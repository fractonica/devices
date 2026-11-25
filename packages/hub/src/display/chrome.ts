// A page drawn by a headless Chrome on the hub machine at a panel's exact size (design epaper-e1 D9: display_html,
// display_text, and display_image's pictures that are not PNG). The DevTools protocol over Node's own WebSocket, as
// tools/chrome.mjs does for the dashboard's screenshots, but for any page: no readiness contract, a fixed viewport at
// one device pixel per CSS pixel, a throw-away profile, and the page's content treated as untrusted (it runs in that
// profile and nothing it does reaches the hub).

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FrError } from '@fractonica/protocol';

/** Where Chrome or Chromium usually is, after $CHROME. */
const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
];

/** How long Chrome may take to start and print its DevTools address. */
const START_MS = 15_000;

/** The Chrome this machine has: $CHROME, else the usual places; null when none, or when CHROME=none. */
export function findChrome(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CHROME === 'none') {
    return null;
  }
  for (const c of [env.CHROME, ...CANDIDATES]) {
    if (c && existsSync(c)) {
      return c;
    }
  }
  return null;
}

/** UNSUPPORTED with what to do instead. */
export function noChrome(): FrError {
  return new FrError('CAPABILITY_UNSUPPORTED', 'this hub machine has no Chrome or Chromium (set CHROME= to one; CHROME=none turns it off)', {
    hint: 'render the page elsewhere and send the PNG with display_image (fr display image <device> page.png)',
  });
}

export interface CaptureOptions {
  width: number;
  height: number;
  /** The page: a document or a fragment; or `url` (http or https). */
  html?: string;
  url?: string;
  /** After the load event, before the capture (fonts, scripts). */
  waitMs: number;
  /** For everything: start, load, capture. */
  timeoutMs: number;
}

interface Message {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
}

/** The page drawn at width x height, one device pixel per CSS pixel, white behind it, as a PNG. */
export async function capturePage(chrome: string, o: CaptureOptions): Promise<Uint8Array> {
  if ((o.html === undefined) === (o.url === undefined)) {
    throw new FrError('INVALID_ARGS', 'give html or url, one of them');
  }
  if (o.url !== undefined && !/^https?:\/\//i.test(o.url)) {
    throw new FrError('INVALID_ARGS', `url ${o.url} is not http or https: the hub loads only web pages (send a local file's content as html)`);
  }
  const deadline = Date.now() + o.timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  const profile = mkdtempSync(join(tmpdir(), 'fr-chrome-'));
  let child: ChildProcess | undefined;
  let socket: WebSocket | undefined;
  try {
    child = spawn(
      chrome,
      ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--mute-audio', 'about:blank'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const endpoint = await new Promise<string>((found, fail) => {
      let log = '';
      const timer = setTimeout(() => fail(new FrError('TIMEOUT', `Chrome did not start within ${Math.min(START_MS, left())} ms`)), Math.min(START_MS, left()));
      child!.stderr!.setEncoding('utf8');
      child!.stderr!.on('data', (chunk: string) => {
        log += chunk;
        const m = log.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) {
          clearTimeout(timer);
          found(m[1]);
        }
      });
      child!.once('error', (e) => {
        clearTimeout(timer);
        fail(new FrError('INTERNAL', `Chrome did not start: ${e.message}`));
      });
      child!.once('exit', (code) => {
        clearTimeout(timer);
        fail(new FrError('INTERNAL', `Chrome exited with ${code}: ${log.slice(-400)}`));
      });
    });

    const ws = new WebSocket(endpoint);
    socket = ws;
    await new Promise<void>((open, fail) => {
      ws.addEventListener('open', () => open(), { once: true });
      ws.addEventListener('error', () => fail(new FrError('INTERNAL', 'could not connect to Chrome')), { once: true });
    });
    const pending = new Map<number, { done: (r: Record<string, unknown>) => void; fail: (e: Error) => void; method: string }>();
    const listeners = new Set<(m: Message) => void>();
    let nextId = 1;
    ws.addEventListener('message', (event) => {
      const m = JSON.parse(String(event.data)) as Message;
      if (m.id !== undefined) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) {
          p?.fail(new FrError('INTERNAL', `${p.method}: ${m.error.message}`));
        } else {
          p?.done(m.result ?? {});
        }
        return;
      }
      for (const l of listeners) {
        l(m);
      }
    });
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<Record<string, unknown>>((done, fail) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          fail(new FrError('TIMEOUT', `Chrome did not answer ${method} in time`));
        }, left());
        pending.set(id, { done: (r) => (clearTimeout(timer), done(r)), fail: (e) => (clearTimeout(timer), fail(e)), method });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    const once = (sessionId: string, method: string) =>
      new Promise<void>((done, fail) => {
        const timer = setTimeout(() => {
          listeners.delete(l);
          fail(new FrError('TIMEOUT', `the page did not finish loading in time (${method})`));
        }, left());
        const l = (m: Message) => {
          if (m.sessionId === sessionId && m.method === method) {
            clearTimeout(timer);
            listeners.delete(l);
            done();
          }
        };
        listeners.add(l);
      });

    const { targetId } = (await send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
    const { sessionId } = (await send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: o.width, height: o.height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 255, g: 255, b: 255, a: 1 } }, sessionId);
    const loaded = once(sessionId, 'Page.loadEventFired');
    if (o.url !== undefined) {
      const nav = (await send('Page.navigate', { url: o.url }, sessionId)) as { errorText?: string };
      if (nav.errorText) {
        throw new FrError('INVALID_ARGS', `Chrome could not load ${o.url}: ${nav.errorText}`);
      }
    } else {
      const { frameTree } = (await send('Page.getFrameTree', {}, sessionId)) as { frameTree: { frame: { id: string } } };
      await send('Page.setDocumentContent', { frameId: frameTree.frame.id, html: o.html }, sessionId);
      // setDocumentContent fires no load event of its own: reload-free pages count as loaded once fonts settle.
      void send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => 1)', awaitPromise: true }, sessionId).then(() => listeners.forEach((l) => l({ sessionId, method: 'Page.loadEventFired' })));
    }
    await loaded;
    if (o.waitMs > 0) {
      await new Promise((r) => setTimeout(r, Math.min(o.waitMs, left())));
    }
    const shot = (await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: o.width, height: o.height, scale: 1 }, captureBeyondViewport: false }, sessionId)) as { data: string };
    return new Uint8Array(Buffer.from(shot.data, 'base64'));
  } finally {
    try {
      socket?.close();
    } catch {
      // already closed
    }
    child?.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  }
}

/** The page display_text draws: the text black on white, wrapped to the panel, in `font` at `sizePx`. */
export function textPage(text: string, sizePx: number, font: string, align: 'left' | 'center' | 'right'): string {
  if (!/^[\w\s,'"-]+$/.test(font)) {
    throw new FrError('INVALID_ARGS', `font ${JSON.stringify(font)} is not a plain CSS font-family list (letters, digits, spaces, commas, quotes, hyphens)`);
  }
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const justify = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
  return [
    '<!doctype html><meta charset="utf-8">',
    '<style>',
    'html,body{margin:0;width:100%;height:100%;background:#fff;color:#000}',
    `body{display:flex;align-items:center;justify-content:${justify};box-sizing:border-box;padding:6px}`,
    `div{font-family:${font};font-size:${sizePx}px;line-height:1.15;text-align:${align};white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%}`,
    '</style>',
    `<div>${esc}</div>`,
  ].join('');
}
