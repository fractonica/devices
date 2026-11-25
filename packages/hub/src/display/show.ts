// Anything on a 1-bit panel (design epaper-e1 D9): display_image, display_html, display_text and display_refresh,
// spread into DISPLAY_HANDLERS (ops.ts).
//
// The hub renders, the node shows. A picture is decoded (raster.ts for PNG; chrome.ts for anything else, and for
// pages), fitted to the panel's size after rotation (its build's traits), turned into mono1 pixels, and compared with
// the frame the hub last sent to that panel: only the rectangles that differ go, each one fr.display `bitmap` of at
// most EPAPER_BITMAP_MAX_BYTES, under a `hold`, then one `refresh`; the op waits for the `refreshed` event. The hub's
// copy is trusted only while the node's shown_crc property equals its CRC (anything else drawn there, a reboot, a
// failed refresh: the whole frame goes). A mono panel that is not e-paper (the C3 OLED) gets the bitmaps alone: it
// flushes itself.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { crc32 } from 'node:zlib';

import { paths } from '@fractonica/host';
import { EPAPER_BITMAP_MAX_BYTES, EPAPER_HOLD_MAX_MS, type EpaperRefreshMode, FrError } from '@fractonica/protocol';

import type { Device, HubContext, HubEvent, OpInput } from '../context.ts';
import { manifestCapsByFwPrefix } from '../artifacts.ts';
import { resolveOne } from '../registry/hub.ts';
import { routerInfo } from '../router/index.ts';
import { instancesOf, sendCommandTo } from '../router/ops.ts';
import { capturePage, findChrome, noChrome, textPage } from './chrome.ts';
import { decodePng, type Dither, type Fit, fitImage, monoRegions, monoToPng, toMono } from './raster.ts';

/** An fr.display instance a picture can go to: its size after rotation, and whether it is e-paper. */
export interface MonoPanel {
  name: string;
  width: number;
  height: number;
  epaper: boolean;
}

/** What the show ops answer (DisplayShowSchema). */
export interface DisplayShow {
  device: string;
  alias: string;
  instance: string;
  width: number;
  height: number;
  sent: 'diff' | 'full' | 'none';
  regions: number;
  bytes: number;
  mode: EpaperRefreshMode | 'none';
  ok: boolean;
  ms?: number;
  partials?: number;
  crc?: number;
  path: string;
  took_ms: number;
  png_base64?: string;
}

/** The frame the hub last sent to a panel, by `<device>/<instance>`, and its CRC. */
interface Sent {
  mono: Uint8Array;
  width: number;
  height: number;
  crc: number;
}
const sentFrames = new WeakMap<HubContext, Map<string, Sent>>();

function sentOf(hub: HubContext): Map<string, Sent> {
  let m = sentFrames.get(hub);
  if (!m) {
    m = new Map();
    sentFrames.set(hub, m);
  }
  return m;
}

/** The hub's copy of what it last sent to `instance` (the dashboard's picture when no snapshot is possible). */
export function lastSent(hub: HubContext, device: string, instance: string): Sent | undefined {
  return sentOf(hub).get(`${device}/${instance}`);
}

/** The device's `name` fr.display instance (else its only one), with a 1-bit panel; its size from its build's traits. */
export function monoPanel(hub: HubContext, dev: Device, name: string | undefined): MonoPanel {
  const displays = (instancesOf(hub, dev) ?? []).filter((c) => c.cap === 'fr.display');
  const inst = name === undefined ? (displays.length === 1 ? displays[0] : undefined) : displays.find((c) => c.name === name);
  if (!inst) {
    const names = displays.map((c) => c.name).join(', ') || 'none';
    throw new FrError(name === undefined && displays.length > 1 ? 'INVALID_ARGS' : 'NOT_FOUND', name === undefined ? `${dev.alias} has ${displays.length > 1 ? 'several' : 'no'} fr.display instances (${names}): name one` : `${dev.alias} has no fr.display instance ${name} (instances: ${names})`, {
      remediation: [{ tool: 'capability_list', args: { device: dev.alias }, cli: `fr caps ls --device ${dev.alias}` }],
    });
  }
  const traits = manifestTraits(hub, dev, inst.name);
  const width = Number(traits?.width ?? 0);
  const height = Number(traits?.height ?? 0);
  if (!traits || !(width > 0) || !(height > 0)) {
    throw new FrError('CAPABILITY_UNSUPPORTED', `${dev.alias} ${inst.name}: the hub has no manifest for its firmware, so it does not know the panel's size`, {
      hint: 'build and flash it through this hub (fr build, fr flash), or register its build',
    });
  }
  if (traits.color !== 'mono1') {
    throw new FrError('CAPABILITY_UNSUPPORTED', `${dev.alias} ${inst.name} is a ${String(traits.color)} panel: pictures go to 1-bit panels (e-paper, the C3 OLED) for now`);
  }
  return { name: inst.name, width, height, epaper: traits.epaper === true };
}

/**
 * The first `<instance>.<member>` event of `dev` from now on; off() stops listening. (audio/ops.ts has the same; it is
 * not imported from there: audio/ops imports display/ops, which imports this file.)
 */
function nextCapEvent(hub: HubContext, dev: Device, type: string): { event: Promise<HubEvent>; off: () => void } {
  let resolveFn!: (e: HubEvent) => void;
  const event = new Promise<HubEvent>((r) => (resolveFn = r));
  const off = hub.events.subscribe((e) => {
    if (e.device === dev.device_id && e.type === type && e.part === 'event') {
      off();
      resolveFn(e);
    }
  });
  return { event, off };
}

/** `p`'s value, or undefined after `ms`. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** The instance's traits in its running firmware's manifest, or null (as power/common.ts's manifestEntry, not imported: a cycle). */
function manifestTraits(hub: HubContext, dev: Device, instance: string): Record<string, unknown> | null {
  const fw = routerInfo(hub.router, dev.device_id)?.fw_id_prefix ?? dev.fw_id;
  try {
    const c = fw ? manifestCapsByFwPrefix(hub.db, fw)?.find((x) => x.name === instance) : undefined;
    return (c?.traits as Record<string, unknown> | null | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Waits (at most `ms`) until the device's mirrored property `key` is `value`; whether it is. */
async function mirrorSays(hub: HubContext, dev: Device, key: string, value: unknown, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  for (;;) {
    if (routerInfo(hub.router, dev.device_id)?.properties[key] === value) {
      return true;
    }
    if (performance.now() >= end) {
      return false;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A command that must succeed, as an error that names it. */
async function must(hub: HubContext, dev: Device, inst: string, cmd: string, args: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  const o = await sendCommandTo(hub, dev, inst, cmd, args, { ack: 'result', timeoutMs });
  if (o.status !== 'ok') {
    const code =
      o.status === 'offline'
        ? 'DEVICE_OFFLINE'
        : o.status === 'timeout'
          ? 'TIMEOUT'
          : o.status === 'unsupported'
            ? 'CAPABILITY_UNSUPPORTED'
            : o.status === 'busy'
              ? 'DEVICE_BUSY'
              : o.status === 'invalid_args'
                ? 'INVALID_ARGS'
                : o.status === 'not_found'
                  ? 'NOT_FOUND'
                  : o.status === 'injection_disabled'
                    ? 'INJECTION_DISABLED'
                    : 'DELIVERY_FAILED';
    throw new FrError(code, `${dev.alias} ${inst}.${cmd}: ${o.error ?? o.status}`, { details: { status: o.status, ...(o.details ?? {}) } });
  }
  return o.fields ?? {};
}

/** A file-name stamp: the ISO time without separators, to the millisecond. */
function stamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, '');
}

interface Rendering {
  fit: Fit;
  x?: number;
  y?: number;
  dither: Dither;
  threshold: number;
  invert: boolean;
  mode: EpaperRefreshMode;
  timeout_s: number;
  inline: boolean;
}

/** `mono` on the panel: the changed rectangles, then (e-paper) one refresh and its refreshed event. */
export async function showMono(hub: HubContext, dev: Device, panel: MonoPanel, mono: Uint8Array, r: Rendering, t0: number): Promise<DisplayShow> {
  const { width, height } = panel;
  const deadline = t0 + r.timeout_s * 1000;
  const left = () => Math.max(1000, deadline - performance.now());
  const key = `${dev.device_id}/${panel.name}`;
  const cache = sentOf(hub);
  const prev = cache.get(key);
  const nodeCrc = routerInfo(hub.router, dev.device_id)?.properties[`${panel.name}.shown_crc`];
  const trusted = panel.epaper && prev !== undefined && prev.width === width && prev.height === height && typeof nodeCrc === 'number' && nodeCrc !== 0 && nodeCrc === prev.crc;
  const regions = monoRegions(trusted ? prev!.mono : null, mono, width, height, EPAPER_BITMAP_MAX_BYTES);
  const bytes = regions.reduce((n, g) => n + g.data.length, 0);
  const png = monoToPng(mono, width, height);
  const path = join(paths.home(), 'renders', `${dev.alias}-${panel.name}-${stamp()}.png`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, png);
  const base = {
    device: dev.device_id,
    alias: dev.alias,
    instance: panel.name,
    width,
    height,
    regions: regions.length,
    bytes,
    path,
    ...(r.inline ? { png_base64: Buffer.from(png).toString('base64') } : {}),
  };
  const crc = crc32(mono);
  const ms = () => Math.round(performance.now() - t0);
  if (regions.length === 0 && (r.mode === 'auto' || r.mode === 'partial')) {
    return { ...base, sent: 'none', mode: 'none', ok: true, crc, took_ms: ms() };
  }
  const sent = trusted ? 'diff' : 'full';
  if (!panel.epaper) {
    for (const g of regions) {
      await must(hub, dev, panel.name, 'bitmap', { x: g.x, y: g.y, w: g.w, h: g.h, data: Buffer.from(g.data).toString('hex') }, left());
    }
    return { ...base, sent, mode: 'none', ok: true, took_ms: ms() };
  }
  await must(hub, dev, panel.name, 'hold', { ms: Math.min(EPAPER_HOLD_MAX_MS, Math.round(left())) }, left());
  for (const g of regions) {
    await must(hub, dev, panel.name, 'bitmap', { x: g.x, y: g.y, w: g.w, h: g.h, data: Buffer.from(g.data).toString('hex') }, left());
  }
  const next = nextCapEvent(hub, dev, `${panel.name}.refreshed`);
  let res: Record<string, unknown>;
  try {
    res = await must(hub, dev, panel.name, 'refresh', { mode: r.mode }, left());
  } catch (e) {
    next.off();
    cache.delete(key);
    throw e;
  }
  if (res.changed !== true && (r.mode === 'auto' || r.mode === 'partial')) {
    // The node's frame already was this picture: nothing to refresh, and the copy is right.
    next.off();
    cache.set(key, { mono, width, height, crc });
    return { ...base, sent, mode: 'none', ok: true, crc, took_ms: ms() };
  }
  const ev = await within(next.event, left());
  next.off();
  if (!ev) {
    cache.delete(key);
    throw new FrError('TIMEOUT', `${dev.alias} ${panel.name}: no refreshed event within ${r.timeout_s} s (the picture is sent; the panel may still show it)`);
  }
  const f = ev.fields ?? {};
  const ok = f.ok === true;
  const evCrc = typeof f.crc === 'number' ? f.crc : 0;
  if (ok && evCrc === crc) {
    cache.set(key, { mono, width, height, crc });
    // The node reports shown_crc beside the event; the next op trusts the copy only once the mirror says so.
    await mirrorSays(hub, dev, `${panel.name}.shown_crc`, evCrc, Math.min(1000, left()));
  } else {
    cache.delete(key);
  }
  return {
    ...base,
    sent,
    mode: (String(f.mode ?? res.mode ?? r.mode) as EpaperRefreshMode) ?? r.mode,
    ok,
    ...(typeof f.ms === 'number' ? { ms: f.ms } : {}),
    ...(typeof f.partials === 'number' ? { partials: f.partials } : {}),
    crc: evCrc,
    took_ms: ms(),
  };
}

/** fitImage's fits as CSS object-fit, for a picture Chrome draws. */
const OBJECT_FIT: Record<Fit, string> = { contain: 'contain', cover: 'cover', stretch: 'fill', none: 'none' };

/**
 * A picture as grey at the panel's size: PNG decoded by raster.ts and fitted by fitImage; anything else (JPEG, GIF,
 * WebP, SVG) drawn by Chrome straight at the panel's size with the same fit (CSS object-fit), white around it.
 */
async function pictureGrey(bytes: Uint8Array, panel: MonoPanel, fit: Fit, at: { x: number; y: number } | undefined, timeoutMs: number): Promise<Uint8Array> {
  const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (isPng) {
    let img;
    try {
      img = decodePng(bytes);
    } catch (e) {
      throw new FrError('INVALID_ARGS', `the picture does not decode as PNG: ${(e as Error).message}`);
    }
    return fitImage(img, panel.width, panel.height, fit, at);
  }
  const chrome = findChrome();
  if (!chrome) {
    throw new FrError('CAPABILITY_UNSUPPORTED', 'only PNG pictures decode on a hub machine without Chrome or Chromium (set CHROME= to one)', {
      hint: 'convert it to PNG first (e.g. sips -s format png in.jpg --out out.png on a Mac)',
    });
  }
  const pos = fit === 'none' ? `object-position:${at?.x ?? 0}px ${at?.y ?? 0}px;` : '';
  const html = `<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:#fff}img{display:block;width:100%;height:100%;object-fit:${OBJECT_FIT[fit]};${pos}}</style><img src="data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}">`;
  const png = await capturePage(chrome, { width: panel.width, height: panel.height, html, waitMs: 100, timeoutMs });
  return fitImage(decodePng(png), panel.width, panel.height, 'stretch');
}

function rendering(input: Rendering): Rendering {
  return input;
}

export const SHOW_HANDLERS = {
  display_image: async (input: OpInput<'display_image'>, hub: HubContext): Promise<DisplayShow> => {
    const t0 = performance.now();
    if ((input.file === undefined) === (input.png_base64 === undefined)) {
      throw new FrError('INVALID_ARGS', 'give file or png_base64, one of them');
    }
    if (input.file !== undefined && !isAbsolute(input.file)) {
      throw new FrError('INVALID_ARGS', `file must be an absolute path (got ${input.file})`);
    }
    const dev = resolveOne(hub, input.device);
    const panel = monoPanel(hub, dev, input.instance);
    let bytes: Uint8Array;
    try {
      bytes = input.file !== undefined ? new Uint8Array(readFileSync(input.file)) : new Uint8Array(Buffer.from(input.png_base64!, 'base64'));
    } catch (e) {
      throw new FrError('INVALID_ARGS', `the picture cannot be read: ${(e as Error).message}`);
    }
    const at = input.x !== undefined || input.y !== undefined ? { x: input.x ?? 0, y: input.y ?? 0 } : undefined;
    const grey = await pictureGrey(bytes, panel, input.fit, at, input.timeout_s * 1000);
    const mono = toMono(grey, panel.width, panel.height, { dither: input.dither, threshold: input.threshold, invert: input.invert });
    return showMono(hub, dev, panel, mono, rendering(input), t0);
  },

  display_html: async (input: OpInput<'display_html'>, hub: HubContext): Promise<DisplayShow> => {
    const t0 = performance.now();
    if ((input.html === undefined) === (input.url === undefined)) {
      throw new FrError('INVALID_ARGS', 'give html or url, one of them');
    }
    const dev = resolveOne(hub, input.device);
    const panel = monoPanel(hub, dev, input.instance);
    const chrome = findChrome();
    if (!chrome) {
      throw noChrome();
    }
    const png = await capturePage(chrome, { width: panel.width, height: panel.height, html: input.html, url: input.url, waitMs: input.wait_ms, timeoutMs: input.timeout_s * 1000 });
    const grey = fitImage(decodePng(png), panel.width, panel.height, input.fit, input.x !== undefined || input.y !== undefined ? { x: input.x ?? 0, y: input.y ?? 0 } : undefined);
    const mono = toMono(grey, panel.width, panel.height, { dither: input.dither, threshold: input.threshold, invert: input.invert });
    return showMono(hub, dev, panel, mono, rendering(input), t0);
  },

  display_text: async (input: OpInput<'display_text'>, hub: HubContext): Promise<DisplayShow> => {
    const t0 = performance.now();
    const dev = resolveOne(hub, input.device);
    const panel = monoPanel(hub, dev, input.instance);
    const chrome = findChrome();
    if (!chrome) {
      throw noChrome();
    }
    const html = textPage(input.text, input.size_px, input.font, input.align);
    const png = await capturePage(chrome, { width: panel.width, height: panel.height, html, waitMs: input.wait_ms, timeoutMs: input.timeout_s * 1000 });
    const grey = fitImage(decodePng(png), panel.width, panel.height, 'stretch');
    const mono = toMono(grey, panel.width, panel.height, { dither: input.dither, threshold: input.threshold, invert: input.invert });
    return showMono(hub, dev, panel, mono, rendering(input), t0);
  },

  display_refresh: async (input: OpInput<'display_refresh'>, hub: HubContext) => {
    const dev = resolveOne(hub, input.device);
    const panel = monoPanel(hub, dev, input.instance);
    if (!panel.epaper) {
      throw new FrError('CAPABILITY_UNSUPPORTED', `${dev.alias} ${panel.name} is not e-paper: it shows what is drawn by itself`);
    }
    const timeoutMs = input.timeout_s * 1000;
    const next = nextCapEvent(hub, dev, `${panel.name}.refreshed`);
    let res: Record<string, unknown>;
    try {
      res = await must(hub, dev, panel.name, 'refresh', { mode: input.mode }, timeoutMs);
    } catch (e) {
      next.off();
      throw e;
    }
    const base = { device: dev.device_id, alias: dev.alias, instance: panel.name, mode: String(res.mode ?? input.mode) as EpaperRefreshMode, changed: res.changed === true };
    if (!base.changed && (input.mode === 'auto' || input.mode === 'partial')) {
      next.off();
      return base;
    }
    const ev = await within(next.event, timeoutMs);
    next.off();
    if (!ev) {
      throw new FrError('TIMEOUT', `${dev.alias} ${panel.name}: no refreshed event within ${input.timeout_s} s`);
    }
    const f = ev.fields ?? {};
    return {
      ...base,
      mode: String(f.mode ?? base.mode) as EpaperRefreshMode,
      ok: f.ok === true,
      ...(typeof f.ms === 'number' ? { ms: f.ms } : {}),
      ...(typeof f.partials === 'number' ? { partials: f.partials } : {}),
      ...(typeof f.crc === 'number' ? { crc: f.crc } : {}),
    };
  },
};
