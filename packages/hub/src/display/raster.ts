// Pictures for 1-bit panels (design epaper-e1 §8 D9, display_image): a PNG decoded to RGBA, fitted to the panel as
// grey, turned into mono1 pixels, and cut into the rectangles that changed, each small enough for one `bitmap`.
// Pure functions, no I/O; node:zlib's inflate and CRC-32 and nothing else.
//
// mono1 is the framework's snapshot layout (png.ts, fr.display `bitmap`): row-major from the top-left, each row
// ceil(width / 8) bytes, MSB first (bit 7 of a row's first byte is x = 0), padding bits 0; a 1 bit is a light pixel
// (white paper), a 0 bit dark (ink).

import { crc32, inflateSync } from 'node:zlib';

import { framebufferToPng } from './png.ts';

/** An image of 8-bit RGBA pixels, row-major from the top-left (not premultiplied). */
export interface RgbaImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export type Fit = 'contain' | 'cover' | 'stretch' | 'none';

export type Dither = 'none' | 'ordered' | 'diffusion';

export interface MonoOptions {
  dither: Dither;
  /** The grey level (0..255) that comes out half light; default 128. */
  threshold?: number;
  /** Swap light and dark. */
  invert?: boolean;
}

/** A byte-aligned rectangle of a mono1 frame: `data` is ceil(w / 8) x h bytes in mono1 layout. */
export interface MonoRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  data: Uint8Array;
}

/** The largest width or height decodePng and fitImage take. */
export const RASTER_MAX_SIDE = 16384;

/** The most pixels decodePng decodes (64 Mi, 256 MiB of RGBA). */
export const PNG_MAX_PIXELS = 64 * 1024 * 1024;

/**
 * The bytes of unchanged pixels monoRegions lets one rectangle take on to save starting another: about what one more
 * `bitmap` costs on the link (its framing and the round trip of its reliable delivery), counted in bytes.
 */
export const REGION_SLACK = 64;

// ---------------------------------------------------------------------------------------------------------------
// PNG decoding

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

const COLOUR_NAMES: Record<number, string> = {
  0: 'greyscale',
  2: 'RGB',
  3: 'palette',
  4: 'greyscale+alpha',
  6: 'RGBA',
};

/** Adam7: the first column, first row, column step and row step of each of the seven passes. */
const ADAM7: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

const NO_INTERLACE: readonly (readonly [number, number, number, number])[] = [[0, 0, 1, 1]];

interface Header {
  width: number;
  height: number;
  depth: number;
  colour: number;
  interlace: number;
}

function hex32(v: number): string {
  return `0x${v.toString(16).padStart(8, '0')}`;
}

function parseHeader(data: Uint8Array): Header {
  if (data.length !== 13) {
    throw new Error(`PNG IHDR is ${data.length} B, not 13`);
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = dv.getUint32(0);
  const height = dv.getUint32(4);
  const [depth, colour, compression, filter, interlace] = [data[8], data[9], data[10], data[11], data[12]];
  for (const [name, v] of [
    ['width', width],
    ['height', height],
  ] as const) {
    if (v < 1 || v > RASTER_MAX_SIDE) {
      throw new Error(`PNG ${name} ${v} is out of range (1..${RASTER_MAX_SIDE})`);
    }
  }
  if (width * height > PNG_MAX_PIXELS) {
    throw new Error(`PNG of ${width}x${height} is ${width * height} pixels, over the limit of ${PNG_MAX_PIXELS}`);
  }
  const depths = DEPTHS[colour];
  if (!depths) {
    throw new Error(`PNG colour type ${colour} does not exist (0, 2, 3, 4 or 6)`);
  }
  if (!depths.includes(depth)) {
    throw new Error(`PNG ${COLOUR_NAMES[colour]} (colour type ${colour}) at bit depth ${depth}: allowed are ${depths.join(', ')}`);
  }
  if (compression !== 0) {
    throw new Error(`PNG compression method ${compression} (only 0 exists)`);
  }
  if (filter !== 0) {
    throw new Error(`PNG filter method ${filter} (only 0 exists)`);
  }
  if (interlace > 1) {
    throw new Error(`PNG interlace method ${interlace} (0 none or 1 Adam7)`);
  }
  return { width, height, depth, colour, interlace };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Undoes the filters of one pass's `rows` scanlines in place (each a filter byte then `stride` bytes) at `off`. */
function unfilter(raw: Uint8Array, off: number, stride: number, rows: number, bpp: number, pass: number): void {
  for (let y = 0; y < rows; y++) {
    const f = raw[off];
    const s = off + 1;
    const up = s - stride - 1; // the previous scanline of this pass (y > 0)
    switch (f) {
      case 0:
        break;
      case 1:
        for (let i = bpp; i < stride; i++) {
          raw[s + i] += raw[s + i - bpp];
        }
        break;
      case 2:
        if (y > 0) {
          for (let i = 0; i < stride; i++) {
            raw[s + i] += raw[up + i];
          }
        }
        break;
      case 3:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? raw[s + i - bpp] : 0;
          const b = y > 0 ? raw[up + i] : 0;
          raw[s + i] += (a + b) >> 1;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? raw[s + i - bpp] : 0;
          const b = y > 0 ? raw[up + i] : 0;
          const c = i >= bpp && y > 0 ? raw[up + i - bpp] : 0;
          raw[s + i] += paeth(a, b, c);
        }
        break;
      default:
        throw new Error(`PNG scanline ${y}${pass ? ` of Adam7 pass ${pass}` : ''}: unknown filter type ${f} (0..4)`);
    }
    off += stride + 1;
  }
}

/** The `count` samples of a scanline at `s`, at their full bit depth. */
function readSamples(raw: Uint8Array, s: number, count: number, depth: number, out: Uint16Array): void {
  if (depth === 8) {
    for (let i = 0; i < count; i++) {
      out[i] = raw[s + i];
    }
  } else if (depth === 16) {
    for (let i = 0; i < count; i++) {
      out[i] = (raw[s + 2 * i] << 8) | raw[s + 2 * i + 1];
    }
  } else {
    const per = 8 / depth;
    const mask = (1 << depth) - 1;
    for (let i = 0; i < count; i++) {
      out[i] = (raw[s + Math.floor(i / per)] >> (8 - depth * ((i % per) + 1))) & mask;
    }
  }
}

/**
 * Decodes a PNG of any colour type (greyscale, RGB, palette, greyscale+alpha, RGBA) and any bit depth the spec allows
 * for it (1, 2, 4, 8, 16), with all five filters, Adam7 interlace and tRNS (palette, greyscale and RGB), into 8-bit
 * RGBA: 16-bit samples keep their high byte, 1-, 2- and 4-bit greys are widened to 0..255. Checks the signature, each
 * chunk's CRC, the chunk order (IHDR first, PLTE and tRNS before IDAT, IDATs together, IEND) and the size (each side
 * 1..16384, at most 64 Mi pixels; the data may not inflate past what the image needs). Ancillary chunks are skipped;
 * a palette index past the PLTE reads as opaque black. Throws an Error that says plainly what is wrong.
 */
export function decodePng(png: Uint8Array): RgbaImage {
  const n = png.length;
  if (n < SIGNATURE.length || SIGNATURE.some((b, i) => png[i] !== b)) {
    throw new Error('not a PNG: the file does not start with the PNG signature');
  }
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let header: Header | null = null;
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let afterIdat = false;
  let ended = false;
  let o = SIGNATURE.length;
  while (o < n && !ended) {
    if (o + 8 > n) {
      throw new Error(`PNG truncated: the chunk header at byte ${o} runs past the end of the ${n}-byte file`);
    }
    const len = dv.getUint32(o);
    const type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
    if (!/^[A-Za-z]{4}$/.test(type)) {
      throw new Error(`PNG chunk at byte ${o} has no valid type: the file is corrupt`);
    }
    if (len > 0x7fffffff || o + 12 + len > n) {
      throw new Error(`PNG truncated: chunk ${type} at byte ${o} declares ${len} B, past the end of the ${n}-byte file`);
    }
    const stored = dv.getUint32(o + 8 + len);
    const computed = crc32(png.subarray(o + 4, o + 8 + len));
    if (stored !== computed) {
      throw new Error(`PNG chunk ${type} at byte ${o}: CRC mismatch (stored ${hex32(stored)}, computed ${hex32(computed)}): the file is corrupt`);
    }
    const data = png.subarray(o + 8, o + 8 + len);
    if (!header && type !== 'IHDR') {
      throw new Error(`PNG: the first chunk is ${type}, not IHDR`);
    }
    if (type !== 'IDAT' && idat.length) {
      afterIdat = true;
    }
    switch (type) {
      case 'IHDR':
        if (header) {
          throw new Error('PNG has a second IHDR chunk');
        }
        header = parseHeader(data);
        break;
      case 'PLTE': {
        const h = header as Header;
        if (plte) {
          throw new Error('PNG has a second PLTE chunk');
        }
        if (idat.length) {
          throw new Error('PNG PLTE comes after IDAT');
        }
        if (h.colour === 0 || h.colour === 4) {
          throw new Error(`PNG PLTE in a ${COLOUR_NAMES[h.colour]} image (colour type ${h.colour}), where it is not allowed`);
        }
        if (len === 0 || len % 3 !== 0 || len > 768) {
          throw new Error(`PNG PLTE of ${len} B is not 1..256 RGB entries`);
        }
        plte = data;
        break;
      }
      case 'tRNS': {
        const h = header as Header;
        if (trns) {
          throw new Error('PNG has a second tRNS chunk');
        }
        if (idat.length) {
          throw new Error('PNG tRNS comes after IDAT');
        }
        if (h.colour === 4 || h.colour === 6) {
          throw new Error(`PNG tRNS in a ${COLOUR_NAMES[h.colour]} image (colour type ${h.colour}), which has its own alpha`);
        }
        if (h.colour === 3) {
          if (!plte) {
            throw new Error('PNG tRNS comes before PLTE');
          }
          if (len > plte.length / 3) {
            throw new Error(`PNG tRNS has ${len} entries for a palette of ${plte.length / 3}`);
          }
        } else if (len !== (h.colour === 0 ? 2 : 6)) {
          throw new Error(`PNG tRNS of ${len} B in a ${COLOUR_NAMES[h.colour]} image, which needs ${h.colour === 0 ? 2 : 6}`);
        }
        trns = data;
        break;
      }
      case 'IDAT':
        if (afterIdat) {
          throw new Error('PNG IDAT chunks are not consecutive');
        }
        idat.push(data);
        break;
      case 'IEND':
        ended = true;
        break;
      default:
        if (!(png[o + 4] & 0x20)) {
          throw new Error(`PNG has an unknown critical chunk ${type}`);
        }
    }
    o += 12 + len;
  }
  if (!header) {
    throw new Error('PNG truncated: no IHDR chunk');
  }
  if (!ended) {
    throw new Error(`PNG truncated: no IEND chunk (the file ends at byte ${n})`);
  }
  if (!idat.length) {
    throw new Error('PNG has no IDAT chunk (no image data)');
  }
  const { width, height, depth, colour, interlace } = header;
  if (colour === 3 && !plte) {
    throw new Error('PNG palette image (colour type 3) has no PLTE chunk');
  }

  const channels = CHANNELS[colour];
  const bits = channels * depth;
  const bpp = Math.max(1, bits >> 3);
  const passes = interlace ? ADAM7 : NO_INTERLACE;
  const sizes = passes.map(([x0, y0, dx, dy]) => {
    const pw = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const ph = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    return { pw, ph, stride: Math.ceil((pw * bits) / 8) };
  });
  const need = sizes.reduce((sum, s) => sum + (s.pw && s.ph ? s.ph * (s.stride + 1) : 0), 0);
  const what = `a ${width}x${height} ${COLOUR_NAMES[colour]} image at ${depth} bits${interlace ? ', interlaced,' : ''}`;
  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: need });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(`PNG image data inflates past the ${need} B ${what} needs`);
    }
    throw new Error(`PNG image data does not inflate (${err.message}): it is truncated or corrupt`);
  }
  if (raw.length !== need) {
    throw new Error(`PNG image data inflates to ${raw.length} B; ${what} needs ${need}: it is truncated`);
  }

  // Each colour type's sample tuple -> 8-bit RGBA.
  const rgba = new Uint8Array(width * height * 4);
  const scale = depth === 16 ? 0 : 255 / ((1 << depth) - 1); // 255, 85, 17 or 1: exact integers
  const to8 = (v: number): number => (depth === 16 ? v >> 8 : v * scale);
  const lut = new Uint8Array(256 * 4);
  if (colour === 3) {
    const p = plte as Uint8Array;
    for (let i = 0; i < 256; i++) {
      if (i * 3 < p.length) {
        lut.set(p.subarray(i * 3, i * 3 + 3), i * 4);
      }
      lut[i * 4 + 3] = trns && i < trns.length ? trns[i] : 255;
    }
  }
  const key = trns && colour !== 3 ? Array.from({ length: trns.length / 2 }, (_, i) => (trns[2 * i] << 8) | trns[2 * i + 1]) : null;
  const samples = new Uint16Array(width * channels);

  let off = 0;
  passes.forEach(([x0, y0, dx, dy], p) => {
    const { pw, ph, stride } = sizes[p];
    if (!pw || !ph) {
      return;
    }
    unfilter(raw, off, stride, ph, bpp, interlace ? p + 1 : 0);
    for (let j = 0; j < ph; j++) {
      readSamples(raw, off + j * (stride + 1) + 1, pw * channels, depth, samples);
      let q = ((y0 + j * dy) * width + x0) * 4;
      const step = dx * 4;
      for (let i = 0; i < pw; i++, q += step) {
        switch (colour) {
          case 0: {
            const v = samples[i];
            rgba[q] = rgba[q + 1] = rgba[q + 2] = to8(v);
            rgba[q + 3] = key && v === key[0] ? 0 : 255;
            break;
          }
          case 2: {
            const [r, g, b] = [samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]];
            rgba[q] = to8(r);
            rgba[q + 1] = to8(g);
            rgba[q + 2] = to8(b);
            rgba[q + 3] = key && r === key[0] && g === key[1] && b === key[2] ? 0 : 255;
            break;
          }
          case 3: {
            const k = samples[i] * 4;
            rgba[q] = lut[k];
            rgba[q + 1] = lut[k + 1];
            rgba[q + 2] = lut[k + 2];
            rgba[q + 3] = lut[k + 3];
            break;
          }
          case 4:
            rgba[q] = rgba[q + 1] = rgba[q + 2] = to8(samples[i * 2]);
            rgba[q + 3] = to8(samples[i * 2 + 1]);
            break;
          default:
            rgba[q] = to8(samples[i * 4]);
            rgba[q + 1] = to8(samples[i * 4 + 1]);
            rgba[q + 2] = to8(samples[i * 4 + 2]);
            rgba[q + 3] = to8(samples[i * 4 + 3]);
        }
      }
    }
    off += ph * (stride + 1);
  });
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------------------------------------------
// Fitting

function checkSide(v: number, name: string): void {
  if (!Number.isInteger(v) || v < 1 || v > RASTER_MAX_SIDE) {
    throw new RangeError(`${name} ${v} is out of range (an integer 1..${RASTER_MAX_SIDE})`);
  }
}

/** num / den rounded half up, exactly, for non-negative integers held in doubles (below 2^53). */
function roundDiv(num: number, den: number): number {
  let q = Math.floor(num / den);
  let r = num - q * den;
  if (r < 0) {
    q--;
    r += den;
  } else if (r >= den) {
    q++;
    r -= den;
  }
  return 2 * r >= den ? q + 1 : q;
}

/** One axis of a resampling: for each destination index from `from`, its source indices and integer weights. */
interface Taps {
  first: number[];
  count: number[];
  idx: number[];
  w: number[];
  /** What each destination's weights add up to. */
  total: number;
}

/**
 * The taps of `s` source pixels drawn as `d` destination pixels, for destination indices from..to-1. d <= s: a box
 * filter (each destination averages the source it covers, by area, in units of 1/d of a source pixel). d > s:
 * bilinear between the two nearest source centres (in units of 1/(2d)), the edges clamped.
 */
function taps(s: number, d: number, from: number, to: number): Taps {
  const t: Taps = { first: [], count: [], idx: [], w: [], total: d <= s ? s : 2 * d };
  for (let X = from; X < to; X++) {
    t.first.push(t.idx.length);
    if (d <= s) {
      const a = X * s;
      const b = a + s;
      const i1 = Math.floor((b - 1) / d);
      for (let i = Math.floor(a / d); i <= i1; i++) {
        t.idx.push(i);
        t.w.push(Math.min((i + 1) * d, b) - Math.max(i * d, a));
      }
    } else {
      const pos = (2 * X + 1) * s - d; // the source position of X's centre, minus half a pixel, in 1/(2d)
      const i0 = Math.floor(pos / (2 * d));
      const frac = pos - i0 * 2 * d;
      t.idx.push(Math.min(Math.max(i0, 0), s - 1), Math.min(Math.max(i0 + 1, 0), s - 1));
      t.w.push(2 * d - frac, frac);
    }
    t.count.push(t.idx.length - t.first[t.first.length - 1]);
  }
  return t;
}

/**
 * Draws grey (sw x sh) scaled to dw x dh with its top-left at (ox, oy) of out (W x H), clipped. Separable integer
 * weights, one rounding per pixel: the sums stay exact in doubles for sides up to RASTER_MAX_SIDE.
 */
function resample(grey: Uint8Array, sw: number, sh: number, dw: number, dh: number, ox: number, oy: number, out: Uint8Array, W: number, H: number): void {
  const x0 = Math.max(0, -ox);
  const x1 = Math.min(dw, W - ox);
  const y0 = Math.max(0, -oy);
  const y1 = Math.min(dh, H - oy);
  if (x0 >= x1 || y0 >= y1) {
    return;
  }
  const tx = taps(sw, dw, x0, x1);
  const ty = taps(sh, dh, y0, y1);
  const vw = x1 - x0;
  const den = tx.total * ty.total;
  const cache = new Map<number, Float64Array>();
  const across = (j: number): Float64Array => {
    let h = cache.get(j);
    if (!h) {
      h = new Float64Array(vw);
      const row = j * sw;
      for (let X = 0; X < vw; X++) {
        let sum = 0;
        for (let k = tx.first[X], e = k + tx.count[X]; k < e; k++) {
          sum += tx.w[k] * grey[row + tx.idx[k]];
        }
        h[X] = sum;
      }
      cache.set(j, h);
    }
    return h;
  };
  const acc = new Float64Array(vw);
  for (let Y = y0; Y < y1; Y++) {
    const f = ty.first[Y - y0];
    const e = f + ty.count[Y - y0];
    for (const j of cache.keys()) {
      if (j < ty.idx[f]) {
        cache.delete(j); // rows only move down
      }
    }
    acc.fill(0);
    for (let k = f; k < e; k++) {
      const wy = ty.w[k];
      if (wy === 0) {
        continue;
      }
      const h = across(ty.idx[k]);
      for (let X = 0; X < vw; X++) {
        acc[X] += wy * h[X];
      }
    }
    const o = (oy + Y) * W + ox + x0;
    for (let X = 0; X < vw; X++) {
      out[o + X] = roundDiv(acc[X], den);
    }
  }
}

/** round(a * b / c) for positive integers, at least 1. */
function scaled(a: number, b: number, c: number): number {
  return Math.max(1, Math.floor((2 * a * b + c) / (2 * c)));
}

/**
 * The image as a grey picture of exactly width x height (one byte a pixel, 0 black, 255 white), on white. Each pixel
 * is composited over white by its alpha and turned to Rec. 601 luma, (299 R + 587 G + 114 B) / 1000, in one exact
 * integer step rounded half up. `contain` keeps the aspect inside the frame, centred (white bars); `cover` keeps the
 * aspect and fills the frame, centred, cropping the rest; `stretch` fills the frame ignoring the aspect; `none` puts
 * the image unscaled with its top-left at `at` (default 0, 0; rounded down), clipped. Centring puts an odd pixel of
 * margin or crop on the right or bottom. Scaling is per axis: shrinking averages by area (a box filter, so text and
 * thin lines survive), enlarging is bilinear (edges clamped); integer weights, one rounding, the same on every machine.
 * Throws RangeError for a size outside 1..16384 or an rgba of the wrong length.
 */
export function fitImage(img: { width: number; height: number; rgba: Uint8Array }, width: number, height: number, fit: Fit, at?: { x: number; y: number }): Uint8Array {
  checkSide(width, 'width');
  checkSide(height, 'height');
  const { width: sw, height: sh, rgba } = img;
  checkSide(sw, 'image width');
  checkSide(sh, 'image height');
  if (rgba.length !== sw * sh * 4) {
    throw new RangeError(`a ${sw}x${sh} RGBA image is ${sw * sh * 4} B, not ${rgba.length}`);
  }
  const grey = new Uint8Array(sw * sh);
  for (let i = 0, q = 0; i < grey.length; i++, q += 4) {
    const a = rgba[q + 3];
    const luma = 299 * rgba[q] + 587 * rgba[q + 1] + 114 * rgba[q + 2]; // 1000 x grey
    grey[i] = Math.floor((luma * a + 255000 * (255 - a) + 127500) / 255000);
  }
  const out = new Uint8Array(width * height).fill(255);
  if (fit === 'none') {
    const ox = Math.floor(at?.x ?? 0);
    const oy = Math.floor(at?.y ?? 0);
    if (!Number.isFinite(ox) || !Number.isFinite(oy)) {
      throw new RangeError(`fit none at (${at?.x}, ${at?.y}): not a position`);
    }
    for (let y = Math.max(0, oy); y < Math.min(height, oy + sh); y++) {
      const xa = Math.max(0, ox);
      const xb = Math.min(width, ox + sw);
      if (xa < xb) {
        out.set(grey.subarray((y - oy) * sw + xa - ox, (y - oy) * sw + xb - ox), y * width + xa);
      }
    }
    return out;
  }
  let dw: number;
  let dh: number;
  if (fit === 'stretch') {
    dw = width;
    dh = height;
  } else if (fit === 'contain' || fit === 'cover') {
    // contain: the side whose scale is smaller fills; cover: the side whose scale is larger.
    const heightFills = (sw * height <= sh * width) === (fit === 'contain');
    dw = heightFills ? scaled(sw, height, sh) : width;
    dh = heightFills ? height : scaled(sh, width, sw);
    if (fit === 'contain') {
      dw = Math.min(dw, width);
      dh = Math.min(dh, height);
    } else {
      dw = Math.max(dw, width);
      dh = Math.max(dh, height);
    }
  } else {
    throw new RangeError(`fit ${String(fit)}: not contain, cover, stretch or none`);
  }
  const ox = dw <= width ? Math.floor((width - dw) / 2) : -Math.floor((dw - width) / 2);
  const oy = dh <= height ? Math.floor((height - dh) / 2) : -Math.floor((dh - height) / 2);
  resample(grey, sw, sh, dw, dh, ox, oy, out, width, height);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Grey -> mono1

/** The 8 x 8 Bayer matrix, row-major: a permutation of 0..63. */
const BAYER8 = Uint8Array.from([
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
]);

function checkMono(frame: Uint8Array, width: number, height: number, name: string): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`a ${width}x${height} frame: the sides must be positive integers`);
  }
  const want = Math.ceil(width / 8) * height;
  if (frame.length !== want) {
    throw new RangeError(`${name}: a ${width}x${height} mono1 frame is ${want} B, not ${frame.length}`);
  }
  return want / height;
}

/**
 * A grey picture (one byte a pixel, 0 black, 255 white) as a packed mono1 frame (a 1 bit light). `none`: light where
 * grey >= threshold (default 128). `ordered`: an 8 x 8 Bayer matrix, light where grey + 128 - threshold >= 4 B + 2
 * for the matrix value B (0..63), so a flat grey g gives (g - 2) / 4 + 1 light pixels in 64 at the default threshold,
 * exactly half at 128 (a checkerboard). `diffusion`: Floyd–Steinberg, serpentine (even rows left to right, odd rows
 * right to left), integer: light where the pixel plus the error it received >= threshold; its error (value - 0 or
 * 255) goes 7/16 ahead, 3/16 behind below, 5/16 below, each truncated toward zero, and the rest ahead below; error
 * that falls off the frame is dropped. `invert` swaps light and dark (the padding bits stay 0).
 */
export function toMono(grey: Uint8Array, width: number, height: number, opts: { dither: Dither; threshold?: number; invert?: boolean }): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`a ${width}x${height} picture: the sides must be positive integers`);
  }
  if (grey.length !== width * height) {
    throw new RangeError(`a ${width}x${height} grey picture is ${width * height} B, not ${grey.length}`);
  }
  const t = opts.threshold ?? 128;
  if (!Number.isFinite(t)) {
    throw new RangeError(`threshold ${t}: not a number`);
  }
  const stride = Math.ceil(width / 8);
  const out = new Uint8Array(stride * height);
  const light = (x: number, y: number): void => {
    out[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
  };
  switch (opts.dither) {
    case 'none':
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (grey[y * width + x] >= t) {
            light(x, y);
          }
        }
      }
      break;
    case 'ordered':
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (grey[y * width + x] + 128 - t >= 4 * BAYER8[(y & 7) * 8 + (x & 7)] + 2) {
            light(x, y);
          }
        }
      }
      break;
    case 'diffusion': {
      // Error carried into this row and the next, indexed x + 1: 0 and width + 1 catch what falls off the sides.
      let cur = new Int32Array(width + 2);
      let next = new Int32Array(width + 2);
      for (let y = 0; y < height; y++) {
        next.fill(0);
        const dir = y & 1 ? -1 : 1;
        for (let k = 0; k < width; k++) {
          const x = dir > 0 ? k : width - 1 - k;
          const v = grey[y * width + x] + cur[x + 1];
          let e = v;
          if (v >= t) {
            light(x, y);
            e = v - 255;
          }
          const e7 = Math.trunc((e * 7) / 16);
          const e3 = Math.trunc((e * 3) / 16);
          const e5 = Math.trunc((e * 5) / 16);
          cur[x + 1 + dir] += e7;
          next[x + 1 - dir] += e3;
          next[x + 1] += e5;
          next[x + 1 + dir] += e - e7 - e3 - e5;
        }
        [cur, next] = [next, cur];
      }
      break;
    }
    default:
      throw new RangeError(`dither ${String(opts.dither)}: not none, ordered or diffusion`);
  }
  if (opts.invert) {
    const last = width & 7 ? (0xff00 >> (width & 7)) & 0xff : 0xff;
    for (let y = 0; y < height; y++) {
      for (let c = 0; c < stride; c++) {
        out[y * stride + c] = ~out[y * stride + c] & (c === stride - 1 ? last : 0xff);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Changed rectangles

/** Rows y0..y1 and byte columns c0..c1, inclusive. */
interface Box {
  y0: number;
  y1: number;
  c0: number;
  c1: number;
}

/** The box shrunk to the bytes in it that changed, or null when none did. */
function tighten(diff: Uint8Array, stride: number, b: Box): Box | null {
  let y0 = -1;
  let y1 = -1;
  let c0 = b.c1 + 1;
  let c1 = b.c0 - 1;
  for (let y = b.y0; y <= b.y1; y++) {
    const row = y * stride;
    let any = false;
    for (let c = b.c0; c <= b.c1; c++) {
      if (diff[row + c]) {
        any = true;
        c0 = Math.min(c0, c);
        c1 = Math.max(c1, c);
      }
    }
    if (any) {
      y0 = y0 < 0 ? y : y0;
      y1 = y;
    }
  }
  return y0 < 0 ? null : { y0, y1, c0, c1 };
}

/** Splits a box along its widest band of unchanged rows or byte columns while that band is over REGION_SLACK bytes. */
function cutBands(diff: Uint8Array, stride: number, box: Box, out: Box[]): void {
  const work = [box];
  while (work.length) {
    const b = tighten(diff, stride, work.pop() as Box);
    if (!b) {
      continue;
    }
    const rows = new Uint8Array(b.y1 - b.y0 + 1);
    const cols = new Uint8Array(b.c1 - b.c0 + 1);
    for (let y = b.y0; y <= b.y1; y++) {
      for (let c = b.c0; c <= b.c1; c++) {
        if (diff[y * stride + c]) {
          rows[y - b.y0] = 1;
          cols[c - b.c0] = 1;
        }
      }
    }
    let best = { area: REGION_SLACK, rows: true, at: 0, len: 0 };
    for (const [line, isRows, across] of [
      [rows, true, cols.length],
      [cols, false, rows.length],
    ] as const) {
      for (let i = 0; i < line.length; ) {
        if (line[i]) {
          i++;
          continue;
        }
        let j = i;
        while (!line[j]) {
          j++; // the box is tight, so a band always ends inside it
        }
        if ((j - i) * across > best.area) {
          best = { area: (j - i) * across, rows: isRows, at: i, len: j - i };
        }
        i = j;
      }
    }
    if (!best.len) {
      out.push(b);
    } else if (best.rows) {
      work.push({ ...b, y1: b.y0 + best.at - 1 }, { ...b, y0: b.y0 + best.at + best.len });
    } else {
      work.push({ ...b, c1: b.c0 + best.at - 1 }, { ...b, c0: b.c0 + best.at + best.len });
    }
  }
}

/**
 * The rectangles that carry every byte where `next` differs from `prev` (all of `next` when prev is null or not the
 * same length), each byte-aligned (x a multiple of 8, w too except where it stops at the right edge) with `data` of
 * ceil(w / 8) x h bytes cut from `next`, at most `maxBytes`; sorted top to bottom, then left to right; none overlap.
 * The rule, in byte columns:
 * 1. Rows: each changed row's span runs from its first changed byte to its last. Going down, a rectangle takes the
 *    next changed row (and the unchanged rows between) when the bytes it would then carry outside its rows' spans
 *    grow by at most REGION_SLACK and stay at most the larger of REGION_SLACK and the bytes inside the spans;
 *    otherwise it closes and the row starts a new one.
 * 2. Bands: a rectangle is cut along its largest band of unchanged rows or byte columns (two pictures side by side)
 *    while that band is over REGION_SLACK bytes, and each part shrunk to its changes.
 * 3. Size: a rectangle over maxBytes is split into even column pieces when one row of it is wider than maxBytes, and
 *    each piece into even runs of whole rows that fit; each tile is shrunk to its changes and dropped if it has none.
 * Applying the rectangles to prev (applyRegions) gives next exactly.
 */
export function monoRegions(prev: Uint8Array | null, next: Uint8Array, width: number, height: number, maxBytes = 1200): MonoRegion[] {
  const stride = checkMono(next, width, height, 'next');
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError(`maxBytes ${maxBytes}: not a positive integer`);
  }
  const all = prev === null || prev.length !== next.length;
  const diff = new Uint8Array(next.length);
  for (let i = 0; i < next.length; i++) {
    diff[i] = all || (prev as Uint8Array)[i] !== next[i] ? 1 : 0;
  }

  // 1. Rows into groups.
  const groups: Box[] = [];
  let g: (Box & { inside: number; outside: number }) | null = null;
  for (let y = 0; y < height; y++) {
    let lo = -1;
    let hi = -1;
    for (let c = 0; c < stride; c++) {
      if (diff[y * stride + c]) {
        lo = lo < 0 ? c : lo;
        hi = c;
      }
    }
    if (lo < 0) {
      continue;
    }
    const span = hi - lo + 1;
    if (g) {
      const c0 = Math.min(g.c0, lo);
      const c1 = Math.max(g.c1, hi);
      const inside: number = g.inside + span;
      const outside: number = (c1 - c0 + 1) * (y - g.y0 + 1) - inside;
      if (outside - g.outside <= REGION_SLACK && outside <= Math.max(REGION_SLACK, inside)) {
        g = { y0: g.y0, y1: y, c0, c1, inside, outside };
        continue;
      }
      groups.push(g);
    }
    g = { y0: y, y1: y, c0: lo, c1: hi, inside: span, outside: 0 };
  }
  if (g) {
    groups.push(g);
  }

  // 2. Cut along unchanged bands.
  const boxes: Box[] = [];
  for (const b of groups) {
    cutBands(diff, stride, { y0: b.y0, y1: b.y1, c0: b.c0, c1: b.c1 }, boxes);
  }

  // 3. Tiles of at most maxBytes.
  const tiles: Box[] = [];
  for (const b of boxes) {
    const bw = b.c1 - b.c0 + 1;
    const bh = b.y1 - b.y0 + 1;
    const k = Math.ceil(bw / maxBytes);
    for (let p = 0; p < k; p++) {
      const c0 = b.c0 + Math.floor((p * bw) / k);
      const c1 = b.c0 + Math.floor(((p + 1) * bw) / k) - 1;
      const m = Math.ceil(bh / Math.floor(maxBytes / (c1 - c0 + 1)));
      for (let q = 0; q < m; q++) {
        const t = tighten(diff, stride, { y0: b.y0 + Math.floor((q * bh) / m), y1: b.y0 + Math.floor(((q + 1) * bh) / m) - 1, c0, c1 });
        if (t) {
          tiles.push(t);
        }
      }
    }
  }
  tiles.sort((a, b) => a.y0 - b.y0 || a.c0 - b.c0);

  return tiles.map(({ y0, y1, c0, c1 }) => {
    const bw = c1 - c0 + 1;
    const h = y1 - y0 + 1;
    const data = new Uint8Array(bw * h);
    for (let r = 0; r < h; r++) {
      const s = (y0 + r) * stride + c0;
      data.set(next.subarray(s, s + bw), r * bw);
    }
    return { x: c0 * 8, y: y0, w: Math.min((c1 + 1) * 8, width) - c0 * 8, h, data };
  });
}

/**
 * A copy of the mono1 frame `base` with the rectangles written in, in order. A rectangle's x must be a multiple of 8;
 * a w that is not stops at the right edge (its last byte is copied whole, padding included) or, inside the frame,
 * writes only its w pixels of the last byte. Throws RangeError for a rectangle outside the frame or data of the wrong
 * size.
 */
export function applyRegions(base: Uint8Array, width: number, height: number, regions: readonly { x: number; y: number; w: number; h: number; data: Uint8Array }[]): Uint8Array {
  const stride = checkMono(base, width, height, 'base');
  const out = new Uint8Array(base);
  for (const { x, y, w, h, data } of regions) {
    if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x % 8 || x + w > width || y + h > height) {
      throw new RangeError(`region ${w}x${h} at (${x}, ${y}) is not a byte-aligned rectangle inside the ${width}x${height} frame`);
    }
    const bw = Math.ceil(w / 8);
    if (data.length !== bw * h) {
      throw new RangeError(`region ${w}x${h} at (${x}, ${y}): data is ${data.length} B, not ${bw * h}`);
    }
    const mask = w & 7 && x + w < width ? (0xff00 >> (w & 7)) & 0xff : 0xff;
    for (let r = 0; r < h; r++) {
      const o = (y + r) * stride + x / 8;
      out.set(data.subarray(r * bw, (r + 1) * bw - 1), o);
      const last = o + bw - 1;
      out[last] = (out[last] & ~mask) | (data[(r + 1) * bw - 1] & mask);
    }
  }
  return out;
}

/** A 1-bit greyscale PNG of a mono1 frame (a 1 bit white): png.ts's framebufferToPng for mono1. */
export function monoToPng(mono: Uint8Array, width: number, height: number): Uint8Array {
  return framebufferToPng(mono, width, height, 'mono1');
}
