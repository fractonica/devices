// A fake e-paper board for the scratch hub and the hub's tests (tools/dash-dev.ts --epaper; design epaper-e1 D11):
// paper-c6, profile c6e-paper (boot 1, status 2, paper 3). EpaperSim answers fr.display 1.3 as EpaperBackend does
// (design epaper-e1 D3), on a simulated clock, so the dashboard's e-paper block and the hub's display ops can be worked
// on without a board:
// - two 1-bit frames, what is drawn (`frame`) and what the glass shows (`shown`), in the snapshot layout (1 = white);
//   clear, fill_rect and bitmap exact; text with the firmware's own 5 x 7 glyphs (read from font5x7.cpp, so they cannot
//   drift); ui_load and ui_set UNSUPPORTED; set_brightness accepted and ignored;
// - refreshes: settle_ms after the last drawing command, at once on `refresh`, never during a `hold`, one at a time
//   (one waits, with the strongest mode asked); auto is partial, or full while the glass is not known, or `clean`
//   once full_every partials ran; fast and full redraw even with nothing new; each takes the vendor's time
//   (EPAPER_VENDOR_MS) and ends with `refreshed`; partials, shown_crc and refresh_ms reported on change;
// - failNext(): the next refresh does not finish: refreshed {ok: false} after its timeout, the glass not known.
// Not modelled: the burst, deep sleep and the 24 h clean (the backend's host tests cover them).
// Never a real board, a serial port or the lab hub: it speaks only to the private hub it is given.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

import { EPAPER_CONFIG_DEFAULTS, EPAPER_TIMEOUT_MS, EPAPER_VENDOR_MS, type EpaperRefreshMode, monoFrameBytes } from '@fractonica/protocol';
import { decodeMember, encodeMember, findCap, STATUS } from '@fractonica/protocol/gen';

import { FakeNode } from '../packages/hub/test/fake-node.ts';

/** c6e-paper's instances and slots (design epaper-e1 D7). */
export const PAPER_CAPS = [
  { port: 1, cap_id: 0x0001, name: 'boot' },
  { port: 2, cap_id: 0x0002, name: 'status' },
  { port: 3, cap_id: 0x0003, name: 'paper' },
];
export const PAPER_PORT = 3;
/** HELLO's chip for c6e-paper's board, the ESP32-C6 (esp_chip_model_t; the hub's CHIP_IDS). */
const ESP32C6 = 13;
/** The panel after rotation r0, and its traits as the build reports them (ssd1683_spi's). */
export const PAPER_TRAITS = { width: 400, height: 300, color: 'mono1', ui: false, touch: false, round: false, epaper: true } as const;
/** fr.display's config as the fake uses it. */
export interface PaperConfig {
  rotation: string;
  brightness: number;
  max_brightness: number;
  flush_ms: number;
  settle_ms: number;
  full_every: number;
  clean: 'full' | 'fast';
  clean_hours: number;
  burst_ms: number;
  sleep_s: number;
  boot_clear: boolean;
}
/** c6e-paper's config (its profile, from the bench): full_every 60 with a fast clean, burst_ms 1000, boot_clear false. */
export const PAPER_CONFIG: Readonly<PaperConfig> = { rotation: 'r0', brightness: 255, max_brightness: 255, flush_ms: 20, ...EPAPER_CONFIG_DEFAULTS, full_every: 60, clean: 'fast' };

/** The firmware's 5 x 7 font, one byte per column, bit 0 the top row (fr_core's font5x7.cpp). */
function loadFont(): number[][] {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'firmware', 'components', 'fr_core', 'src', 'display', 'font5x7.cpp'), 'utf8');
  const rows = [...src.matchAll(/\{(0x[0-9A-Fa-f]{2}(?:,\s*0x[0-9A-Fa-f]{2}){4})\}/g)].map((m) => m[1].split(',').map((x) => parseInt(x.trim(), 16)));
  if (rows.length !== 0x7e - 0x20 + 1) {
    throw new Error(`font5x7.cpp: expected ${0x7e - 0x20 + 1} glyphs, read ${rows.length}`);
  }
  return rows;
}
let FONT: number[][] | null = null;

/** Rec. 601 luma at least 50 %: a mono panel lights (here: leaves white) such a colour (mono_lit). */
export const monoLit = (rgb: number) => 299 * ((rgb >> 16) & 0xff) + 587 * ((rgb >> 8) & 0xff) + 114 * (rgb & 0xff) >= 127_500;

/** A 1-bit frame in the snapshot layout. */
export class MonoFrame {
  readonly width: number;
  readonly height: number;
  readonly stride: number;
  readonly bytes: Uint8Array;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.stride = Math.ceil(width / 8);
    this.bytes = new Uint8Array(monoFrameBytes(width, height));
  }
  get(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height && ((this.bytes[y * this.stride + (x >> 3)] >> (7 - (x & 7))) & 1) === 1;
  }
  set(x: number, y: number, on: boolean): void {
    const i = y * this.stride + (x >> 3);
    const bit = 0x80 >> (x & 7);
    this.bytes[i] = on ? this.bytes[i] | bit : this.bytes[i] & ~bit;
  }
  /** The clipped rectangle; whether anything was on the frame. */
  fill(x: number, y: number, w: number, h: number, on: boolean): boolean {
    const x0 = Math.max(x, 0);
    const y0 = Math.max(y, 0);
    const x1 = Math.min(x + w, this.width) - 1;
    const y1 = Math.min(y + h, this.height) - 1;
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        this.set(xx, yy, on);
      }
    }
    return x0 <= x1 && y0 <= y1;
  }
}

type Rank = 0 | 1 | 2 | 3 | 4; // none, auto, partial, fast, full
const RANK: Record<EpaperRefreshMode, Rank> = { auto: 1, partial: 2, fast: 3, full: 4 };

/** Where the panel's STATE and EVENT bodies go (the JSON form of the generated codecs). */
export interface EpaperOut {
  state(name: 'brightness' | 'partials' | 'shown_crc' | 'refresh_ms', value: number): void;
  event(name: 'refreshed', fields: { mode: EpaperRefreshMode; ok: boolean; ms: number; partials: number; x: number; y: number; w: number; h: number; crc: number }): void;
}

export interface EpaperSimOptions {
  width?: number;
  height?: number;
  config?: Partial<PaperConfig>;
  /** Milliseconds, never going back. */
  now: () => number;
  out: EpaperOut;
}

/** fr.display on an e-paper panel (EpaperBackend's policy) on a simulated clock: commands answer at once, tick() moves time on. */
export class EpaperSim {
  readonly frame: MonoFrame;
  readonly shown: MonoFrame;
  readonly cfg: Readonly<PaperConfig>;
  glassKnown = false;
  partials = 0;
  refreshMs = 0;
  shownCrc = 0;
  /** The refresh running: its mode, when it ends, and the area it changes. */
  running: { mode: Exclude<EpaperRefreshMode, 'auto'>; endsAt: number; box: [number, number, number, number]; fail: boolean } | null = null;
  #pending: Rank = 0;
  #dirtyAt: number | null = null;
  #holdUntil = 0;
  #failNext = false;
  #now: () => number;
  #out: EpaperOut;
  #frozen: Uint8Array | null = null;

  constructor(o: EpaperSimOptions) {
    const w = o.width ?? PAPER_TRAITS.width;
    const h = o.height ?? PAPER_TRAITS.height;
    this.frame = new MonoFrame(w, h);
    this.shown = new MonoFrame(w, h);
    this.frame.fill(0, 0, w, h, true);
    this.shown.fill(0, 0, w, h, true);
    this.cfg = { ...PAPER_CONFIG, ...(o.config ?? {}) };
    this.#now = o.now;
    this.#out = o.out;
    if (this.cfg.boot_clear) {
      this.#pending = 4;
    }
  }

  /** The next refresh does not finish (BUSY stuck): refreshed {ok: false} at its timeout. */
  failNext(): void {
    this.#failNext = true;
  }

  /** One command (JSON-form args): its RESULT status and fields. */
  command(name: string, a: Record<string, unknown>): { status: number; fields?: Record<string, unknown> } {
    const n = (k: string, d = 0) => (typeof a[k] === 'number' ? (a[k] as number) : d);
    switch (name) {
      case 'clear':
        this.#drew(this.frame.fill(0, 0, this.frame.width, this.frame.height, monoLit(n('color'))));
        return { status: STATUS.OK };
      case 'fill_rect':
        this.#drew(this.frame.fill(n('x'), n('y'), n('w'), n('h'), monoLit(n('color'))));
        return { status: STATUS.OK };
      case 'text':
        this.#drew(this.#text(n('x'), n('y'), String(a.text ?? ''), n('size', 1), n('color', 0xffffff), n('bg', 0)));
        return { status: STATUS.OK };
      case 'bitmap': {
        // The generated decoder hands bytes in the JSON form: hex.
        const data = typeof a.data === 'string' ? new Uint8Array(Buffer.from(a.data, 'hex')) : a.data instanceof Uint8Array ? a.data : new Uint8Array(0);
        const w = n('w');
        const h = n('h');
        if (data.length !== Math.ceil(w / 8) * h) {
          return { status: STATUS.INVALID_ARGS };
        }
        const one = monoLit(n('color', 0xffffff));
        const zero = monoLit(n('bg', 0));
        const x0 = n('x');
        const y0 = n('y');
        let any = false;
        for (let r = 0; r < h; r++) {
          for (let c = 0; c < w; c++) {
            const x = x0 + c;
            const y = y0 + r;
            if (x >= 0 && y >= 0 && x < this.frame.width && y < this.frame.height) {
              const bit = ((data[r * Math.ceil(w / 8) + (c >> 3)] >> (7 - (c & 7))) & 1) === 1;
              this.frame.set(x, y, bit ? one : zero);
              any = true;
            }
          }
        }
        this.#drew(any);
        return { status: STATUS.OK };
      }
      case 'set_brightness':
        return { status: STATUS.OK };
      case 'ui_load':
      case 'ui_set':
        return { status: STATUS.UNSUPPORTED };
      case 'hold': {
        const ms = n('ms');
        this.#holdUntil = ms === 0 ? 0 : this.#now() + ms;
        return { status: STATUS.OK };
      }
      case 'refresh': {
        const mode = (typeof a.mode === 'string' ? a.mode : 'auto') as EpaperRefreshMode;
        const changed = this.diff() !== null;
        const r = Math.max(this.#pending, RANK[mode]) as Rank;
        this.#holdUntil = 0;
        this.#dirtyAt = null;
        this.#pending = r <= 2 && !changed && this.#pending === 0 ? 0 : r;
        return { status: STATUS.OK, fields: { mode: this.#resolve(r), changed } };
      }
      case 'snapshot': {
        this.#frozen = this.frame.bytes.slice();
        return { status: STATUS.OK, fields: { crc: crc32(this.#frozen), width: this.frame.width, height: this.frame.height, format: 'mono1', bytes: this.#frozen.length } };
      }
      case 'snapshot_read': {
        if (!this.#frozen) {
          return { status: STATUS.FAILED };
        }
        const off = n('offset');
        if (off > this.#frozen.length) {
          return { status: STATUS.INVALID_ARGS };
        }
        return { status: STATUS.OK, fields: { data: Buffer.from(this.#frozen.slice(off, off + n('len', 1024))).toString('hex') } };
      }
      default:
        return { status: STATUS.UNSUPPORTED };
    }
  }

  /** Where frame differs from shown: [x, y, w, h] widened to whole bytes, or null. */
  diff(): [number, number, number, number] | null {
    const { stride } = this.frame;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < this.frame.height; y++) {
      for (let b = 0; b < stride; b++) {
        if (this.frame.bytes[y * stride + b] !== this.shown.bytes[y * stride + b]) {
          x0 = Math.min(x0, b * 8);
          x1 = Math.max(x1, Math.min(b * 8 + 7, this.frame.width - 1));
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
      }
    }
    return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
  }

  /** Moves time on: settle, holds, the refresh running and the one waiting. */
  tick(): void {
    const now = this.#now();
    if (this.running && now >= this.running.endsAt) {
      this.#finish(now);
    }
    if (this.#dirtyAt !== null && now >= this.#holdUntil && now >= this.#dirtyAt + this.cfg.settle_ms) {
      this.#pending = Math.max(this.#pending, 1) as Rank;
      this.#dirtyAt = null;
    }
    if (!this.running && this.#pending !== 0) {
      this.#start(now);
    }
  }

  /** Every property, as a get_state asks. */
  reportAll(): void {
    this.#out.state('brightness', 255); // no backlight: the property says 255, as DisplayService does
    this.#out.state('partials', this.partials);
    this.#out.state('shown_crc', this.glassKnown ? this.shownCrc : 0);
    this.#out.state('refresh_ms', this.refreshMs);
  }

  #resolve(r: Rank): Exclude<EpaperRefreshMode, 'auto'> {
    if (r === 4) {
      return 'full';
    }
    if (r === 3) {
      return 'fast';
    }
    if (!this.glassKnown) {
      return 'full';
    }
    if (r === 2) {
      return 'partial';
    }
    return this.cfg.full_every > 0 && this.partials >= this.cfg.full_every ? (this.cfg.clean === 'fast' ? 'fast' : 'full') : 'partial';
  }

  #drew(any: boolean): void {
    if (any) {
      this.#dirtyAt = this.#now();
    }
  }

  #start(now: number): void {
    const r = this.#pending;
    const d = this.diff();
    this.#pending = 0;
    if (r <= 2 && !d) {
      return; // auto or partial with nothing to show
    }
    const mode = this.#resolve(r);
    const box: [number, number, number, number] = mode === 'partial' ? d! : [0, 0, this.frame.width, this.frame.height];
    const fail = this.#failNext;
    this.#failNext = false;
    // The writes copy the frame into shown as they go (the backend's rule); the glass changes when the refresh ends.
    this.shown.bytes.set(this.frame.bytes);
    this.running = { mode, endsAt: now + (fail ? EPAPER_TIMEOUT_MS[mode] : EPAPER_VENDOR_MS[mode]), box, fail };
  }

  #finish(now: number): void {
    const run = this.running!;
    this.running = null;
    const before = { partials: this.partials, crc: this.glassKnown ? this.shownCrc : 0, ms: this.refreshMs };
    this.refreshMs = Math.round(now - (run.endsAt - (run.fail ? EPAPER_TIMEOUT_MS[run.mode] : EPAPER_VENDOR_MS[run.mode])));
    if (run.fail) {
      this.glassKnown = false;
    } else {
      this.glassKnown = true;
      this.shownCrc = crc32(this.shown.bytes);
      this.partials = run.mode === 'partial' ? Math.min(255, this.partials + 1) : 0;
    }
    const crc = this.glassKnown ? this.shownCrc : 0;
    this.#out.event('refreshed', { mode: run.mode, ok: !run.fail, ms: this.refreshMs, partials: this.partials, x: run.box[0], y: run.box[1], w: run.box[2], h: run.box[3], crc });
    if (this.partials !== before.partials) {
      this.#out.state('partials', this.partials);
    }
    if (crc !== before.crc) {
      this.#out.state('shown_crc', crc);
    }
    if (this.refreshMs !== before.ms) {
      this.#out.state('refresh_ms', this.refreshMs);
    }
  }

  #text(x: number, y: number, s: string, size: number, color: number, bg: number): boolean {
    FONT ??= loadFont();
    const k = Math.min(4, Math.max(1, size));
    const fg = monoLit(color);
    const back = monoLit(bg);
    let cx = x;
    let any = false;
    for (const ch of Buffer.from(s, 'utf8')) {
      if (cx >= this.frame.width) {
        break;
      }
      if (ch >= 0x80 && ch <= 0xbf) {
        continue; // a UTF-8 continuation byte: its lead byte drew the '?'
      }
      const g = FONT[(ch >= 0x20 && ch <= 0x7e ? ch : 0x3f) - 0x20]!;
      any = this.frame.fill(cx, y, 6 * k, 8 * k, back) || any;
      if (fg !== back) {
        for (let col = 0; col < 5; col++) {
          for (let row = 0; row < 7; row++) {
            if ((g[col] >> row) & 1) {
              this.frame.fill(cx + col * k, y + row * k, k, k, fg);
            }
          }
        }
      }
      cx += 6 * k;
    }
    return any;
  }
}

export interface FakePaperOptions {
  mac: string;
  addr: number;
  net: number;
  alias: string;
  aliasRev: number;
  epoch: number;
  fwPrefix?: string;
  hub: { tcp: number; udp: number };
  config?: Partial<PaperConfig>;
}

export interface FakePaper {
  node: FakeNode;
  sim: EpaperSim;
  stop(): Promise<void>;
}

const enc = (part: 'event' | 'state', member: string, v: unknown) => {
  const e = encodeMember('fr.display', part, member, v);
  if (!e.ok) {
    throw new Error(`fr.display.${member}: ${e.detail}`);
  }
  return e.value;
};

/** paper-c6 on the given hub: its display ticking every 10 ms of real time. */
export async function startFakePaper(o: FakePaperOptions): Promise<FakePaper> {
  const node = new FakeNode({ mac: o.mac, addr: o.addr, net: o.net, alias: o.alias, aliasRev: o.aliasRev, epoch: o.epoch, hub: o.hub, chip: ESP32C6, ...(o.fwPrefix ? { fwPrefix: o.fwPrefix } : {}) });
  node.describeAs(PAPER_CAPS);
  const cap = findCap('fr.display')!;
  let closed = false;
  const sim = new EpaperSim({
    now: () => performance.now(),
    ...(o.config ? { config: o.config } : {}),
    out: {
      state(name, value) {
        if (!closed) {
          node.state(PAPER_PORT, cap.properties.find((p) => p.name === name)!.id, enc('state', name, { [name]: value }));
        }
      },
      event(name, fields) {
        if (!closed) {
          node.event(PAPER_PORT, cap.events.find((e) => e.name === name)!.id, enc('event', name, fields));
        }
      },
    },
  });
  for (const c of cap.commands) {
    node.handlers.set(`${PAPER_PORT}/${c.id}`, (args) => {
      const d = decodeMember('fr.display', 'args', c.name, args);
      if (!d.ok) {
        return { status: STATUS.INVALID_ARGS };
      }
      const r = sim.command(c.name, d.value as Record<string, unknown>);
      if (r.status !== STATUS.OK || !r.fields || !c.result) {
        return { status: r.status };
      }
      const fields = encodeMember('fr.display', 'result', c.name, r.fields);
      return fields.ok ? { status: r.status, fields: fields.value } : { status: STATUS.FAILED };
    });
  }
  await node.connect(10_000);
  sim.reportAll();
  const timer = setInterval(() => sim.tick(), 10);
  return {
    node,
    sim,
    async stop() {
      closed = true;
      clearInterval(timer);
      node.close();
    },
  };
}
