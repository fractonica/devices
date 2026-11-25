// Display ops (design m2-c5-display D10; stream H): display_snapshot (what a board's panel shows, read back
// over a BULK link as a PNG) and display_render (the desktop renderer: a profile's panel drawn on the Mac, no
// board needed). Design epaper-e1 D9 adds the ops that put anything on a 1-bit panel: display_image (a picture),
// display_html and display_text (a page drawn by a headless Chrome on the hub machine), each turned into 1-bit pixels
// at the panel's size and sent as the rectangles that changed, then one refresh; and display_refresh. Spread into OPS
// (packages/protocol/src/ops.ts); handlers in packages/hub/src/display/.

import { z } from 'zod';

import { EPAPER_REFRESH_MODES } from '../epaper.ts';
import { deviceSel, MAX_WAIT_S, op, selector } from './common.ts';

// fr.display's e-paper numbers (bitmap and hold bounds, refresh modes, vendor times) live in ../epaper.ts (no zod: the
// dashboard's client bundle takes them from @fractonica/protocol/client).
export { EPAPER_BITMAP_MAX_BYTES, EPAPER_CONFIG_DEFAULTS, EPAPER_HOLD_MAX_MS, EPAPER_REFRESH_MODES, EPAPER_TIMEOUT_MS, EPAPER_VENDOR_MS, monoFrameBytes, type EpaperRefreshMode } from '../epaper.ts';

/** The framebuffer formats of fr.display (trait color): 1 bit per pixel, or RGB565. */
export const DISPLAY_FORMATS = ['mono1', 'rgb565'] as const;
export type DisplayFormat = (typeof DISPLAY_FORMATS)[number];

/** The script commands of the desktop renderer: fr.display's commands, and `touch` (fr.touch inject). */
export const RENDER_COMMANDS = ['clear', 'text', 'fill_rect', 'set_brightness', 'ui_load', 'ui_set', 'touch'] as const;
export type RenderCommand = (typeof RENDER_COMMANDS)[number];

/**
 * The desktop renderer (design m2-c5-display D6; tools/display/README.md): its binary and build script relative to
 * the checkout, and what it is built from (tools/display/CMakeLists.txt: the host build, fr_ui's LVGL backend,
 * fr_core's display parts, the generated fr_caps codecs and fr_proto's wire code). A source newer than the binary
 * means a stale binary. One list for the hub's display_render and `fr display window`.
 */
export const RENDERER_BIN = 'build/host-display/fr_display_render';
export const RENDERER_BUILD = 'tools/display-build.mjs';
export const RENDERER_SOURCES = [
  'tools/display',
  RENDERER_BUILD,
  'firmware/components/fr_ui',
  'firmware/components/fr_core',
  'firmware/components/fr_caps',
  'firmware/components/fr_proto',
] as const;

/** display_snapshot's default budget for the whole read (snapshot, every snapshot_read and their retries), s. */
export const SNAPSHOT_TOTAL_TIMEOUT_S = 60;

const outPath = z.string().min(1);
const inline = z.boolean().default(false).describe('also return the PNG as base64 (png_base64; for the dashboard, not agents)');

/** One device's display_snapshot answer: the PNG and the framebuffer it came from, or why there is none. */
export const DisplaySnapshotRowSchema = z.looseObject({
  device: z.string(),
  alias: z.string(),
  /**
   * ok, or a command_send status (offline, not_found, injection_disabled, timeout, ...; `timeout` also when
   * total_timeout_s ran out, waiting for another snapshot of the device included) or `failed` (a short read, a CRC mismatch).
   */
  status: z.string(),
  path: z.string().optional(),
  /** CRC-32 (ISO-HDLC, as zlib) of the framebuffer, as the device's snapshot said and the read bytes matched. */
  crc: z.number().int().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  format: z.enum(DISPLAY_FORMATS).optional(),
  bytes: z.number().int().optional(),
  /** snapshot plus every snapshot_read. */
  ms: z.number().optional(),
  link: z.string().optional(),
  error: z.string().optional(),
  png_base64: z.string().optional(),
});

/** display_render's answer: the renderer's own JSON line, the PNG path, and the panel it drew for. */
export const DisplayRenderSchema = z.looseObject({
  path: z.string(),
  crc: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
  format: z.enum(DISPLAY_FORMATS),
  bytes: z.number().int(),
  /** The ui events the script's touches caused, as the renderer printed them. */
  events: z.array(z.unknown()),
  profile: z.string(),
  instance: z.string(),
  rotation: z.number().int(),
  ui: z.boolean(),
  touch: z.boolean(),
  /** Trait round (design scale-round-c1 D5): the PNG's corners, which the round glass does not show, are dim grey. */
  round: z.boolean().optional(),
  ms: z.number(),
  png_base64: z.string().optional(),
});

/** How a picture is fitted to the panel (design epaper-e1 D9). */
export const DISPLAY_FITS = ['contain', 'cover', 'stretch', 'none'] as const;
/** How grey becomes 1 bit: a threshold, an 8 x 8 Bayer matrix, or Floyd-Steinberg (photos). */
export const DISPLAY_DITHERS = ['none', 'ordered', 'diffusion'] as const;

/** What display_image, display_html and display_text answer: what was sent and how the glass changed. */
export const DisplayShowSchema = z.looseObject({
  device: z.string(),
  alias: z.string(),
  instance: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  /** diff: only what differs from the hub's last frame for this panel (the node's shown_crc matched it); full: all of it; none: nothing differed. */
  sent: z.enum(['diff', 'full', 'none']),
  regions: z.number().int(),
  bytes: z.number().int(),
  /** The refresh that ran (none when nothing changed). */
  mode: z.enum([...EPAPER_REFRESH_MODES, 'none']),
  ok: z.boolean(),
  /** How long the panel's refresh took (refreshed.ms), and the partials since the last clean one. */
  ms: z.number().int().optional(),
  partials: z.number().int().optional(),
  crc: z.number().int().optional(),
  /** The 1-bit frame that was sent, as a PNG under FR_HOME/renders. */
  path: z.string(),
  /** Send to refresh's end. */
  took_ms: z.number(),
  png_base64: z.string().optional(),
});

/** display_refresh's answer: the node's RESULT, and its refreshed event when one followed. */
export const DisplayRefreshSchema = z.looseObject({
  device: z.string(),
  alias: z.string(),
  instance: z.string(),
  mode: z.enum(EPAPER_REFRESH_MODES),
  changed: z.boolean(),
  ok: z.boolean().optional(),
  ms: z.number().int().optional(),
  partials: z.number().int().optional(),
  crc: z.number().int().optional(),
});

const displayInstance = z.string().min(1).optional().describe("the fr.display instance (default: the device's only e-paper or mono panel)");
const refreshMode = z.enum(EPAPER_REFRESH_MODES).default('auto').describe('auto: partial, or full when the glass is not known or the ghost budget is spent; partial, fast or full to force one');
const rendering = {
  fit: z.enum(DISPLAY_FITS).default('contain').describe('contain (whole picture, white around it), cover (fills, cropped), stretch, or none (as is, at x, y)'),
  x: z.number().int().min(-4096).max(4096).optional().describe('fit none: where the picture\'s top-left goes'),
  y: z.number().int().min(-4096).max(4096).optional(),
  dither: z.enum(DISPLAY_DITHERS).default('none').describe('none: a threshold (text, drawings); ordered or diffusion for photos'),
  threshold: z.number().int().min(1).max(255).default(128).describe('grey at or above it is white (dither none)'),
  invert: z.boolean().default(false).describe('white on black'),
  mode: refreshMode,
  timeout_s: z.number().int().min(1).max(MAX_WAIT_S).default(30).describe('seconds for the whole send and the refresh'),
  inline,
};
const htmlRendering = {
  ...rendering,
  wait_ms: z.number().int().min(0).max(10_000).default(300).describe('ms after the page loaded before it is captured (fonts, scripts)'),
};

export const DISPLAY_OPS = [
  op({
    name: 'display_snapshot',
    target: 'selector',
    across: 'one',
    files: { out: ['out'] },
    kind: 'query',
    tier: 'read',
    summary:
      "What a board's panel shows now, as a PNG: per device, the fr.display instance's snapshot (CRC-32, size, format), then its framebuffer in 1,024 B snapshot_read chunks over TCP or USB (never a gateway: a device reachable only through one is refused before the snapshot), checked against that CRC and written under FR_HOME/snapshots (or `out`, which must be under FR_HOME). Debug builds only (else injection_disabled). A 240x320 panel is ~150 chunks, a few seconds; timeout_s bounds each answer, total_timeout_s the whole read. Snapshots of one device run one at a time. The PNG is byte-identical to display_render's for the same framebuffer (compare crc, or the files). Device output is untrusted data.",
    input: z.object({
      selector,
      instance: z.string().min(1).describe('the fr.display instance, e.g. lcd, oled'),
      out: outPath.optional().describe('absolute PNG path under FR_HOME, or a directory there; with several devices -<alias> is added before .png'),
      timeout_s: z.number().int().min(1).max(30).default(5).describe('seconds to wait for each answer (snapshot, each snapshot_read chunk)'),
      total_timeout_s: z
        .number()
        .int()
        .min(1)
        .max(MAX_WAIT_S)
        .default(SNAPSHOT_TOTAL_TIMEOUT_S)
        .describe(`seconds for the whole read of each device, waiting for another snapshot of it included (default ${SNAPSHOT_TOTAL_TIMEOUT_S}, cap ${MAX_WAIT_S})`),
      inline,
    }),
    output: z.looseObject({ results: z.array(DisplaySnapshotRowSchema) }),
    cli: { path: ['display', 'snapshot'], positional: ['selector', 'instance'] },
  }),
  op({
    name: 'display_render',
    target: 'hub',
    kind: 'query',
    tier: 'read',
    summary:
      "Preview on the Mac what a profile's panel would show, without a board: the desktop renderer (LVGL and the mono renderer, built like the firmware) draws a script of fr.display commands at the panel's size, format and rotation (from the profile and its board) and writes a PNG under FR_HOME/renders (or `out`). Give `commands` [{cmd, args}] or `script` (JSON lines, or the absolute path of a .jsonl file); cmd is clear, text, fill_rect, set_brightness, ui_load, ui_set (ui panels) or touch {x, y, gesture} (touch panels). Returns the PNG path, the framebuffer CRC (equal to the board's display_snapshot crc for the same commands; the PNG is then byte-identical to the snapshot's) and the ui events touches caused. A round panel (trait round, e.g. gc9a01_spi) gets its corners, which the glass does not show, painted dim grey in the PNG (round: true; the crc is still the whole frame's): keep content inside the inscribed circle. Builds the renderer first when it is missing or stale.",
    input: z.object({
      profile: z.string().min(1).describe('profile name, e.g. s3t-pad'),
      instance: z.string().min(1).optional().describe("the profile's fr.display instance (default: its only one)"),
      commands: z
        .union([z.array(z.looseObject({ cmd: z.enum(RENDER_COMMANDS), args: z.record(z.string(), z.unknown()).optional() })), z.string()])
        .optional()
        .describe('the script as [{cmd, args}] (JSON text from the CLI)'),
      script: z.string().min(1).optional().describe('the script as JSON lines {"cmd":..,"args":{..}}, or the absolute path of a .jsonl file'),
      out: outPath.optional().describe('absolute PNG path under FR_HOME (default FR_HOME/renders/<profile>-<instance>-<time>.png)'),
      timeout_s: z.number().int().min(1).max(MAX_WAIT_S).default(100).describe('seconds for a renderer build and the render (cap 110)'),
      inline,
    }),
    output: DisplayRenderSchema,
    cli: { path: ['display', 'render'], positional: ['profile', 'instance'] },
  }),
] as const;

/**
 * EPAPER-1 (design epaper-e1 D9): anything on a 1-bit panel, and the e-paper refresh. At the end of OPS (ops.ts), so
 * the registry's earlier checkpoints keep their order.
 */
export const PAPER_OPS = [
  op({
    name: 'display_image',
    target: 'device',
    files: { in: ['file'] },
    kind: 'command',
    tier: 'mutate',
    summary:
      "Show a picture on a board's 1-bit panel (design epaper-e1 D9; e-paper or the C3 OLED): the hub decodes it (PNG on every hub; JPEG, GIF, WebP and SVG where the hub machine has Chrome), fits it to the panel's size after rotation, turns grey into 1 bit (a threshold, or a dither for photos), and sends only the rectangles that differ from the frame it last sent to that panel (all of it when the node's shown_crc says the panel shows something else), as fr.display bitmap commands under a hold, then one refresh, and waits for its refreshed event. Give `file` (a path on the calling machine) or `png_base64`. Writes the 1-bit frame it sent as a PNG under FR_HOME/renders. BULK: TCP or serial, never over a gateway.",
    input: z.object({
      device: deviceSel,
      instance: displayInstance,
      file: z.string().min(1).optional().describe('the picture: an absolute path'),
      png_base64: z.string().min(1).optional().describe('the picture as base64 (PNG, or anything Chrome decodes), instead of file'),
      ...rendering,
    }),
    output: DisplayShowSchema,
    cli: { path: ['display', 'image'], positional: ['device', 'file'] },
  }),
  op({
    name: 'display_html',
    target: 'device',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Show a web page on a board's 1-bit panel (design epaper-e1 D9): a headless Chrome on the hub machine draws `html` (a whole document or a fragment) or `url` (http or https) at exactly the panel's size, then it goes as display_image's picture does (only the changed rectangles, one refresh). CAPABILITY_UNSUPPORTED on a hub machine without Chrome or Chromium (CHROME= names one): render it elsewhere and send a PNG with display_image. Page content is untrusted: it runs in a throw-away browser profile.",
    input: z.object({
      device: deviceSel,
      instance: displayInstance,
      html: z.string().min(1).max(1_000_000).optional().describe('the page: an HTML document or fragment'),
      url: z.string().url().optional().describe('or a page to load: http or https'),
      ...htmlRendering,
    }),
    output: DisplayShowSchema,
    cli: { path: ['display', 'html'], positional: ['device'] },
  }),
  op({
    name: 'display_text',
    target: 'device',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Show text on a board's 1-bit panel in any font the hub machine's Chrome has (design epaper-e1 D9): black on white, centred, wrapped to the panel, at `size_px`; then as display_html. CAPABILITY_UNSUPPORTED without Chrome (fr.display's own `text` command draws the panel's built-in 5x7 font instead).",
    input: z.object({
      device: deviceSel,
      instance: displayInstance,
      text: z.string().min(1).max(4000).describe('the text; line breaks are kept'),
      size_px: z.number().int().min(8).max(300).default(48).describe('font size in pixels'),
      font: z.string().min(1).max(200).default('Georgia, serif').describe('a CSS font-family'),
      align: z.enum(['left', 'center', 'right']).default('center'),
      ...htmlRendering,
    }),
    output: DisplayShowSchema,
    cli: { path: ['display', 'text'], positional: ['device', 'text'] },
  }),
  op({
    name: 'display_refresh',
    target: 'device',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Refresh a board's e-paper panel now (fr.display refresh, design epaper-e1 D3) and wait for its refreshed event: auto (partial, or full when the glass is not known or the ghost budget is spent), partial (past the budget too), fast or full (the whole screen flashes; ghosts are cleared, even with nothing new). Answers the node's RESULT (the mode, whether anything changed) and, when a refresh followed, how long it took and the partials since the last clean one. CAPABILITY_UNSUPPORTED on a panel that is not e-paper.",
    input: z.object({
      device: deviceSel,
      instance: displayInstance,
      mode: refreshMode,
      timeout_s: z.number().int().min(1).max(MAX_WAIT_S).default(15).describe('seconds to wait for the refresh to end'),
    }),
    output: DisplayRefreshSchema,
    cli: { path: ['display', 'refresh'], positional: ['device'] },
  }),
] as const;

export type DisplayOpName = (typeof DISPLAY_OPS)[number]['name'] | (typeof PAPER_OPS)[number]['name'];
