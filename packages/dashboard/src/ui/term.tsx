// Logs (design README "Hub" 9): xterm.js on the plate, themed from the tokens. Text bone, errors fault, warnings ash,
// debug etch-3, the hub's own stage lines lumen; the terminal's 16 ANSI colours are mapped onto the same tokens, so
// a device's colour sequences stay in the palette. xterm and its fit addon load on first use (a chunk of their own).
//
//   <Term onOpen={(t) => { t.line('hello'); t.line('boom', 'error'); return () => {} }} />
//
// `onOpen` runs once the terminal is open and may return a cleanup; device output is untrusted, so write it through
// line(), which drops every control sequence but colour (state/format.ts termSafe) before adding the level's colour.
// To re-open it for another source, give it a React key (a device id, a job id).

import type { ITheme, Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';

import { hubColors } from '../design/hub-tokens.ts';
import { termSafe } from '../state/format.ts';

export type TermLevel = 'error' | 'warn' | 'info' | 'debug' | 'event';

const SGR: Record<TermLevel, string | undefined> = { error: '31', warn: '33', info: undefined, debug: '90', event: '36' };

/** A log line's level letter (E W I D V) or stream (err, event) as a TermLevel. */
export function termLevel(level?: string | null, stream?: string | null): TermLevel {
  if (level === 'E' || stream === 'err') {
    return 'error';
  }
  if (level === 'W') {
    return 'warn';
  }
  if (level === 'D' || level === 'V') {
    return 'debug';
  }
  return stream === 'event' ? 'event' : 'info';
}

/** The xterm theme from the tokens: every colour is a token's. */
export function termTheme(): ITheme {
  const c = hubColors();
  return {
    background: c.plate,
    foreground: c.bone,
    cursor: c.plate,
    cursorAccent: c.plate,
    selectionBackground: c.lumenDim,
    selectionForeground: c.bone,
    black: c.void,
    red: c.fault,
    green: c.lumenMid,
    yellow: c.ash,
    blue: c.lumenMid,
    magenta: c.ash,
    cyan: c.lumen,
    white: c.bone,
    brightBlack: c.etch3,
    brightRed: c.fault,
    brightGreen: c.lumen,
    brightYellow: c.bone,
    brightBlue: c.lumen,
    brightMagenta: c.bone,
    brightCyan: c.lumen,
    brightWhite: c.nowCore,
  };
}

export interface TermHandle {
  term: Terminal;
  /** One line, made safe, in the level's colour. */
  line(text: string, level?: TermLevel): void;
  clear(): void;
}

/** Opens a themed terminal in `host`; the caller disposes it. */
export async function openTerminal(host: HTMLElement): Promise<TermHandle & { dispose(): void }> {
  const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
  const term = new Terminal({
    convertEol: true,
    disableStdin: true,
    cursorBlink: false,
    cursorStyle: 'underline',
    cursorInactiveStyle: 'none',
    fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
    fontSize: 12,
    lineHeight: 1.25,
    scrollback: 5000,
    theme: termTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  const refit = () => {
    try {
      fit.fit();
    } catch {
      // not laid out yet
    }
  };
  refit();
  const ro = new ResizeObserver(refit);
  ro.observe(host);
  return {
    term,
    line(text, level = 'info') {
      const safe = termSafe(text);
      const sgr = SGR[level];
      term.writeln(sgr ? `\x1b[${sgr}m${safe}\x1b[0m` : safe);
    },
    clear: () => term.clear(),
    dispose() {
      ro.disconnect();
      term.dispose();
    },
  };
}

export interface TermProps {
  /** Called once the terminal is open; may return a cleanup (unsubscribe). */
  onOpen: (t: TermHandle) => void | (() => void);
  /** CSS height (default 320px). */
  height?: string;
  /** What it shows, for assistive technology ("desk-pad log"). */
  label?: string;
}

export function Term({ onOpen, height, label }: TermProps) {
  const host = useRef<HTMLDivElement>(null);
  const open = useRef(onOpen);
  open.current = onOpen;
  useEffect(() => {
    let cancelled = false;
    let handle: (TermHandle & { dispose(): void }) | null = null;
    let cleanup: void | (() => void);
    void openTerminal(host.current!).then((h) => {
      if (cancelled) {
        h.dispose();
        return;
      }
      handle = h;
      cleanup = open.current(h);
    });
    return () => {
      cancelled = true;
      if (typeof cleanup === 'function') {
        cleanup();
      }
      handle?.dispose();
    };
  }, []);
  return <div ref={host} className="ui-term" role="log" aria-label={label} style={height ? { ['--term-height' as string]: height } : undefined} />;
}
