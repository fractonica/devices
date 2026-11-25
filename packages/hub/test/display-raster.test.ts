// Design epaper-e1 §8 D9 (display_image's pixels): the PNG decoder (every colour type and bit depth, the five filters,
// Adam7, tRNS, the refusals), fitting to the panel as grey, threshold and dither into mono1, and the changed
// rectangles of at most 1,200 B that rebuild the frame exactly. The PNGs are built here with node:zlib.

import { crc32, deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { framebufferToPng } from '../src/display/png.ts';
import { applyRegions, decodePng, fitImage, type MonoRegion, monoRegions, monoToPng, REGION_SLACK, type RgbaImage, toMono } from '../src/display/raster.ts';

// ---------------------------------------------------------------------------------------------------------------
// A small PNG writer of our own

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CH: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function ihdr(width: number, height: number, depth: number, colour: number, interlace = 0): Buffer {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(width, 0);
  b.writeUInt32BE(height, 4);
  b[8] = depth;
  b[9] = colour;
  b[12] = interlace;
  return b;
}

function paethOf(a: number, b: number, c: number): number {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Filter type f of a scanline against the one above; any other f leaves the bytes as they are. */
function filterRow(f: number, row: Uint8Array, up: Uint8Array, bpp: number): Uint8Array {
  return row.map((v, i) => {
    const a = i >= bpp ? row[i - bpp] : 0;
    const b = up[i];
    const c = i >= bpp ? up[i - bpp] : 0;
    const pred = [0, a, b, (a + b) >> 1, paethOf(a, b, c)][f] ?? 0;
    return (v - pred) & 0xff;
  });
}

interface Spec {
  width: number;
  height: number;
  colour: number;
  depth: number;
  /** The samples of pixel (x, y) at the image's bit depth. */
  sample: (x: number, y: number) => number[];
  plte?: Uint8Array;
  trns?: Uint8Array;
  interlace?: boolean;
  /** The filter type of the n-th scanline written (default n % 5: every filter). */
  filter?: (n: number) => number;
}

/** The scanlines of a spec, each a filter byte then its filtered bytes, as IDAT inflates to. */
function scanlines(s: Spec): Uint8Array {
  const bits = CH[s.colour] * s.depth;
  const bpp = Math.max(1, bits >> 3);
  const out: number[] = [];
  let n = 0;
  for (const [x0, y0, dx, dy] of s.interlace ? ADAM7 : [[0, 0, 1, 1]]) {
    const pw = s.width > x0 ? Math.ceil((s.width - x0) / dx) : 0;
    const ph = s.height > y0 ? Math.ceil((s.height - y0) / dy) : 0;
    if (!pw || !ph) {
      continue;
    }
    const stride = Math.ceil((pw * bits) / 8);
    let up = new Uint8Array(stride);
    for (let j = 0; j < ph; j++) {
      const row = new Uint8Array(stride);
      let bit = 0;
      for (let i = 0; i < pw; i++) {
        for (const v of s.sample(x0 + i * dx, y0 + j * dy)) {
          if (s.depth === 16) {
            row[bit >> 3] = v >> 8;
            row[(bit >> 3) + 1] = v & 0xff;
          } else if (s.depth === 8) {
            row[bit >> 3] = v;
          } else {
            row[bit >> 3] |= v << (8 - s.depth - (bit & 7));
          }
          bit += s.depth;
        }
      }
      const f = (s.filter ?? ((k: number) => k % 5))(n++);
      out.push(f, ...filterRow(f, row, up, bpp));
      up = row;
    }
  }
  return Uint8Array.from(out);
}

function assemble(chunks: [string, Uint8Array][]): Buffer {
  return Buffer.concat([SIG, ...chunks.map(([t, d]) => chunk(t, d))]);
}

/** The PNG of a spec, its deflated data split over two IDAT chunks. */
function makePng(s: Spec, idat: Uint8Array = deflateSync(scanlines(s))): Buffer {
  const half = idat.length >> 1;
  return assemble([
    ['IHDR', ihdr(s.width, s.height, s.depth, s.colour, s.interlace ? 1 : 0)],
    ...(s.plte ? [['PLTE', s.plte] as [string, Uint8Array]] : []),
    ...(s.trns ? [['tRNS', s.trns] as [string, Uint8Array]] : []),
    ['IDAT', idat.subarray(0, half)],
    ['IDAT', idat.subarray(half)],
    ['IEND', new Uint8Array(0)],
  ]);
}

/** A sample of channel k at (x, y) that covers the depth's range. */
function sampleAt(depth: number, x: number, y: number, k: number): number {
  const v = x * 37 + y * 101 + k * 59;
  return depth === 16 ? (v * 1021 + 77) & 0xffff : v % (1 << depth);
}

/** A sample widened to 8 bits as the spec says: 16 bits keep the high byte, 1/2/4 bits repeat. */
function to8(depth: number, v: number): number {
  return depth === 16 ? v >> 8 : (v * 255) / ((1 << depth) - 1);
}

function expectedRgba(s: Spec, pixel: (samples: number[]) => number[]): Uint8Array {
  const out = new Uint8Array(s.width * s.height * 4);
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      out.set(pixel(s.sample(x, y)), (y * s.width + x) * 4);
    }
  }
  return out;
}

/** The RGBA of a sample tuple of a non-palette colour type. */
function plainPixel(colour: number, depth: number): (v: number[]) => number[] {
  const e = (v: number): number => to8(depth, v);
  return (v) =>
    colour === 0 ? [e(v[0]), e(v[0]), e(v[0]), 255] : colour === 2 ? [e(v[0]), e(v[1]), e(v[2]), 255] : colour === 4 ? [e(v[0]), e(v[0]), e(v[0]), e(v[1])] : v.map(e);
}

function plainSpec(colour: number, depth: number, width = 11, height = 6): Spec {
  return { width, height, colour, depth, sample: (x, y) => Array.from({ length: CH[colour] }, (_, k) => sampleAt(depth, x, y, k)) };
}

function palette(n: number): Uint8Array {
  return Uint8Array.from({ length: n * 3 }, (_, i) => (i * 73 + 11) & 0xff);
}

function paletteSpec(depth: number, entries = 1 << depth, width = 11, height = 6): Spec {
  return { width, height, colour: 3, depth, plte: palette(entries), sample: (x, y) => [(x * 5 + y * 3) % entries] };
}

const NON_PALETTE: [number, number][] = [
  [0, 1],
  [0, 2],
  [0, 4],
  [0, 8],
  [0, 16],
  [2, 8],
  [2, 16],
  [4, 8],
  [4, 16],
  [6, 8],
  [6, 16],
];

describe('decodePng', () => {
  it.each(NON_PALETTE)('colour type %i at %i bits, every filter', (colour, depth) => {
    const s = plainSpec(colour, depth);
    const img = decodePng(makePng(s));
    expect([img.width, img.height]).toEqual([11, 6]);
    expect(img.rgba).toEqual(expectedRgba(s, plainPixel(colour, depth)));
  });

  it.each([1, 2, 4, 8])('palette at %i bits', (depth) => {
    const s = paletteSpec(depth);
    const p = s.plte as Uint8Array;
    expect(decodePng(makePng(s)).rgba).toEqual(expectedRgba(s, ([i]) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2], 255]));
  });

  it('palette with tRNS: alpha per entry, entries past tRNS opaque', () => {
    const s = { ...paletteSpec(8, 6), trns: Uint8Array.from([0, 128, 255]) };
    const p = s.plte as Uint8Array;
    const alpha = [0, 128, 255, 255, 255, 255];
    expect(decodePng(makePng(s)).rgba).toEqual(expectedRgba(s, ([i]) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2], alpha[i]]));
  });

  it.each([4, 16])('greyscale %i-bit with tRNS: the keyed grey is transparent', (depth) => {
    const s = plainSpec(0, depth);
    const key = s.sample(3, 2)[0];
    const t = { ...s, trns: Uint8Array.from([key >> 8, key & 0xff]) };
    const img = decodePng(makePng(t));
    expect(img.rgba).toEqual(expectedRgba(t, ([v]) => [to8(depth, v), to8(depth, v), to8(depth, v), v === key ? 0 : 255]));
    expect(img.rgba[(2 * 11 + 3) * 4 + 3]).toBe(0);
  });

  it.each([8, 16])('RGB %i-bit with tRNS: only the exact colour is transparent', (depth) => {
    const s = plainSpec(2, depth);
    const key = s.sample(5, 1);
    const t = { ...s, trns: Uint8Array.from(key.flatMap((v) => [v >> 8, v & 0xff])) };
    const same = (v: number[]): boolean => v.every((c, i) => c === key[i]);
    const img = decodePng(makePng(t));
    expect(img.rgba).toEqual(expectedRgba(t, (v) => [...v.map((c) => to8(depth, c)), same(v) ? 0 : 255]));
    expect(img.rgba[(1 * 11 + 5) * 4 + 3]).toBe(0);
  });

  it.each([0, 1, 2, 3, 4])('filter type %i alone, at 1, 2, 4 and 8 bytes a pixel', (f) => {
    for (const [colour, depth] of [
      [0, 1],
      [4, 8],
      [6, 8],
      [6, 16],
    ]) {
      const s = { ...plainSpec(colour, depth), filter: () => f };
      expect(decodePng(makePng(s)).rgba).toEqual(expectedRgba(s, plainPixel(colour, depth)));
    }
  });

  it.each([
    [1, 1],
    [2, 1],
    [1, 7],
    [3, 3],
    [5, 2],
    [8, 8],
    [9, 9],
    [13, 7],
    [33, 17],
  ])('Adam7 %ix%i decodes equal to its non-interlaced twin', (width, height) => {
    for (const s of [plainSpec(2, 8, width, height), plainSpec(0, 1, width, height), plainSpec(6, 16, width, height), paletteSpec(2, 4, width, height)]) {
      const plain = decodePng(makePng(s));
      const interlaced = makePng({ ...s, interlace: true });
      expect(interlaced[8 + 8 + 12]).toBe(1); // the IHDR says Adam7
      expect(decodePng(interlaced)).toEqual(plain);
    }
    const s = plainSpec(6, 16, width, height);
    expect(decodePng(makePng({ ...s, interlace: true })).rgba).toEqual(expectedRgba(s, plainPixel(6, 16)));
  });

  it('skips ancillary chunks', () => {
    const s = plainSpec(2, 8, 4, 3);
    const png = makePng(s);
    const withText = Buffer.concat([png.subarray(0, 33), chunk('tEXt', Buffer.from('Title\0x')), png.subarray(33)]);
    expect(decodePng(withText)).toEqual(decodePng(png));
  });

  it("reads png.ts's own PNGs: mono1 (a 1 bit white) and rgb565", () => {
    const mono = Uint8Array.from([0b1010_0000, 0b0100_0000]); // 3x2
    const img = decodePng(framebufferToPng(mono, 3, 2, 'mono1'));
    expect(Array.from({ length: 6 }, (_, i) => img.rgba[i * 4])).toEqual([255, 0, 255, 0, 255, 0]);
    expect(Array.from({ length: 6 }, (_, i) => img.rgba[i * 4 + 3])).toEqual([255, 255, 255, 255, 255, 255]);
    const rgb565 = Uint8Array.from([0x00, 0xf8, 0xe0, 0x07]); // red, green
    expect(decodePng(framebufferToPng(rgb565, 2, 1, 'rgb565')).rgba).toEqual(Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255]));
  });

  describe('refuses, saying what is wrong', () => {
    const good = makePng(plainSpec(2, 8, 5, 5));
    const raw = scanlines(plainSpec(2, 8, 5, 5));
    const head = (w: number, h: number, depth: number, colour: number): [string, Uint8Array] => ['IHDR', ihdr(w, h, depth, colour)];
    const tiny = deflateSync(new Uint8Array(2));
    const corrupt = Buffer.from(good);
    corrupt[33 + 8 + 1] ^= 0x40; // a byte of the first IDAT's data

    it.each([
      ['no signature', Buffer.from('GIF89a, not a PNG at all'), /not a PNG: .*signature/],
      ['a corrupt IDAT', corrupt, /chunk IDAT at byte 33: CRC mismatch/],
      ['the signature alone', good.subarray(0, 8), /truncated: no IHDR/],
      ['a cut chunk header', good.subarray(0, 12), /truncated: the chunk header at byte 8/],
      ['a cut IHDR', good.subarray(0, 20), /truncated: chunk IHDR .*past the end/],
      ['a cut IDAT', good.subarray(0, 50), /truncated: chunk IDAT .*past the end/],
      ['no IEND', good.subarray(0, good.length - 12), /truncated: no IEND/],
      ['IHDR not first', assemble([['tEXt', Buffer.from('a\0b')], head(1, 1, 8, 0), ['IDAT', tiny], ['IEND', new Uint8Array(0)]]), /first chunk is tEXt, not IHDR/],
      ['width 0', assemble([head(0, 5, 8, 0)]), /width 0 is out of range \(1\.\.16384\)/],
      ['height 16385', assemble([head(5, 16385, 8, 0)]), /height 16385 is out of range/],
      ['over 64 Mi pixels', assemble([head(10000, 10000, 8, 0), ['IDAT', tiny], ['IEND', new Uint8Array(0)]]), /10000x10000 is 100000000 pixels, over the limit of 67108864/],
      ['RGB at 4 bits', assemble([head(1, 1, 4, 2)]), /RGB \(colour type 2\) at bit depth 4: allowed are 8, 16/],
      ['colour type 5', assemble([head(1, 1, 8, 5)]), /colour type 5 does not exist/],
      ['interlace 2', assemble([['IHDR', ihdr(1, 1, 8, 0, 2)]]), /interlace method 2/],
      ['a palette image without PLTE', assemble([head(1, 1, 8, 3), ['IDAT', tiny], ['IEND', new Uint8Array(0)]]), /palette image .* no PLTE/],
      ['no IDAT', assemble([head(1, 1, 8, 0), ['IEND', new Uint8Array(0)]]), /no IDAT/],
      ['IDATs apart', assemble([head(5, 5, 8, 2), ['IDAT', deflateSync(raw).subarray(0, 4)], ['tEXt', Buffer.from('a\0b')], ['IDAT', deflateSync(raw).subarray(4)], ['IEND', new Uint8Array(0)]]), /IDAT chunks are not consecutive/],
      ['an unknown critical chunk', assemble([head(1, 1, 8, 0), ['ABCD', new Uint8Array(1)], ['IDAT', tiny], ['IEND', new Uint8Array(0)]]), /unknown critical chunk ABCD/],
      ['tRNS in RGBA', assemble([head(1, 1, 8, 6), ['tRNS', new Uint8Array(6)], ['IDAT', tiny], ['IEND', new Uint8Array(0)]]), /tRNS in a RGBA image/],
      ['a short tRNS for RGB', assemble([head(1, 1, 8, 2), ['tRNS', new Uint8Array(2)], ['IDAT', tiny], ['IEND', new Uint8Array(0)]]), /tRNS of 2 B in a RGB image, which needs 6/],
      ['PLTE in greyscale', assemble([head(1, 1, 8, 0), ['PLTE', new Uint8Array(3)], ['IDAT', tiny], ['IEND', new Uint8Array(0)]]), /PLTE in a greyscale image/],
      ['data that does not inflate', makePng(plainSpec(2, 8, 5, 5), Uint8Array.from([1, 2, 3, 4, 5, 6])), /image data does not inflate .*truncated or corrupt/],
      ['a cut zlib stream', makePng(plainSpec(2, 8, 5, 5), deflateSync(raw).subarray(0, 20)), /image data does not inflate/],
      ['too little data', makePng(plainSpec(2, 8, 5, 5), deflateSync(raw.subarray(0, raw.length - 3))), /inflates to 77 B; a 5x5 RGB image at 8 bits needs 80/],
      ['too much data', makePng(plainSpec(2, 8, 5, 5), deflateSync(Buffer.concat([raw, new Uint8Array(9)]))), /inflates past the 80 B/],
      ['an unknown filter type', makePng({ ...plainSpec(2, 8, 5, 5), filter: (n) => (n === 2 ? 7 : 0) }), /scanline 2: unknown filter type 7/],
    ] as [string, Uint8Array, RegExp][])('%s', (_, png, message) => {
      expect(() => decodePng(png)).toThrow(message);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Fitting

/** An opaque grey image from rows of grey levels. */
function greyImage(rows: number[][]): RgbaImage {
  const height = rows.length;
  const width = rows[0].length;
  const rgba = new Uint8Array(width * height * 4);
  rows.flat().forEach((v, i) => rgba.set([v, v, v, 255], i * 4));
  return { width, height, rgba };
}

function grid(grey: Uint8Array, width: number): number[][] {
  return Array.from({ length: grey.length / width }, (_, y) => Array.from(grey.subarray(y * width, (y + 1) * width)));
}

const W = 255;

describe('fitImage', () => {
  it('shrinks by area: 4x2 -> 2x1 is the mean of each 2x2 block, rounded', () => {
    const img = greyImage([
      [0, 40, 200, 255],
      [80, 120, 100, 50],
    ]);
    expect(Array.from(fitImage(img, 2, 1, 'stretch'))).toEqual([60, 151]); // 240 / 4, 605 / 4 = 151.25
    expect(Array.from(fitImage(img, 2, 1, 'contain'))).toEqual([60, 151]); // same aspect
  });

  it('shrinks by area at a ratio that is not whole: 3 -> 2 weighs 2:1 and 1:2', () => {
    expect(Array.from(fitImage(greyImage([[0, 90, 255]]), 2, 1, 'stretch'))).toEqual([30, 200]);
  });

  it('keeps a thin line when shrinking (an average, not the nearest pixel)', () => {
    const rows = Array.from({ length: 8 }, () => Array.from({ length: 8 }, (_, x) => (x === 3 ? 0 : W)));
    expect(grid(fitImage(greyImage(rows), 2, 2, 'stretch'), 2)).toEqual([
      [191, W],
      [191, W],
    ]);
  });

  it('enlarges bilinearly, edges clamped', () => {
    expect(Array.from(fitImage(greyImage([[0, W]]), 4, 1, 'stretch'))).toEqual([0, 64, 191, W]);
  });

  it('composites alpha over white, then Rec. 601 luma, rounded', () => {
    const rgba = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 128, 255, 0, 0, 0, 10, 20, 30, 255]);
    // red 76.245, green 149.685, blue 29.07, black at alpha 128: 127, anything at alpha 0: white, (10, 20, 30): 18.15
    expect(Array.from(fitImage({ width: 6, height: 1, rgba }, 6, 1, 'none'))).toEqual([76, 150, 29, 127, W, 18]);
  });

  it('contain letterboxes in white, centred', () => {
    const black = (w: number, h: number): RgbaImage => greyImage(Array.from({ length: h }, () => new Array<number>(w).fill(0)));
    expect(grid(fitImage(black(2, 1), 4, 4, 'contain'), 4)).toEqual([
      [W, W, W, W],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [W, W, W, W],
    ]);
    expect(grid(fitImage(black(1, 2), 4, 4, 'contain'), 4)).toEqual([
      [W, 0, 0, W],
      [W, 0, 0, W],
      [W, 0, 0, W],
      [W, 0, 0, W],
    ]);
    // An odd pixel of margin goes right: 1x1 in 4x3 is 3x3 at x = 0.
    expect(grid(fitImage(black(1, 1), 4, 3, 'contain'), 4)).toEqual([
      [0, 0, 0, W],
      [0, 0, 0, W],
      [0, 0, 0, W],
    ]);
  });

  it('cover fills and crops, centred', () => {
    const cols = greyImage([
      [0, 50, 100, 150],
      [0, 50, 100, 150],
    ]);
    expect(grid(fitImage(cols, 2, 2, 'cover'), 2)).toEqual([
      [50, 100],
      [50, 100],
    ]);
    const rows = greyImage([[10], [20], [30], [40]]);
    expect(grid(fitImage(rows, 1, 2, 'cover'), 1)).toEqual([[20], [30]]);
    // A 4x2 image covering 2x2 crops columns; stretch squeezes them instead.
    expect(grid(fitImage(cols, 2, 2, 'stretch'), 2)).toEqual([
      [25, 125],
      [25, 125],
    ]);
  });

  it('none places the image unscaled at `at`, clipped, on white', () => {
    const img = greyImage([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ]);
    expect(grid(fitImage(img, 4, 3, 'none', { x: 2, y: -1 }), 4)).toEqual([
      [W, W, 4, 5],
      [W, W, 7, 8],
      [W, W, W, W],
    ]);
    expect(grid(fitImage(img, 2, 2, 'none'), 2)).toEqual([
      [1, 2],
      [4, 5],
    ]);
    expect(grid(fitImage(img, 2, 2, 'none', { x: 5, y: 0 }), 2)).toEqual([
      [W, W],
      [W, W],
    ]);
  });

  it('refuses a bad size', () => {
    const img = greyImage([[0]]);
    expect(() => fitImage(img, 0, 1, 'contain')).toThrow(/width 0 is out of range/);
    expect(() => fitImage({ width: 2, height: 2, rgba: new Uint8Array(4) }, 1, 1, 'contain')).toThrow(/2x2 RGBA image is 16 B, not 4/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Grey -> mono1

function lightCount(mono: Uint8Array): number {
  return mono.reduce((n, b) => {
    let c = n;
    for (let v = b; v; v &= v - 1) {
      c++;
    }
    return c;
  }, 0);
}

const flat = (w: number, h: number, g: number): Uint8Array => new Uint8Array(w * h).fill(g);

describe('toMono', () => {
  const ramp = Uint8Array.from([0, 127, 128, 255, 200, 50, 128, 129, 130]); // 9x1

  it('none: light where grey >= threshold (default 128); invert keeps the padding 0', () => {
    expect(Array.from(toMono(ramp, 9, 1, { dither: 'none' }))).toEqual([0b0011_1011, 0b1000_0000]);
    expect(Array.from(toMono(ramp, 9, 1, { dither: 'none', invert: true }))).toEqual([0b1100_0100, 0]);
    expect(Array.from(toMono(ramp, 9, 1, { dither: 'none', threshold: 200 }))).toEqual([0b0001_1000, 0]);
    expect(Array.from(toMono(flat(13, 2, 0), 13, 2, { dither: 'none', invert: true }))).toEqual([0xff, 0xf8, 0xff, 0xf8]);
  });

  it('ordered: a flat 50 % grey is a checkerboard', () => {
    const mono = toMono(flat(16, 4, 128), 16, 4, { dither: 'ordered' });
    expect(Array.from(mono)).toEqual([0xaa, 0xaa, 0x55, 0x55, 0xaa, 0xaa, 0x55, 0x55]);
  });

  it('ordered: a flat grey g lights (g - 2) / 4 + 1 of every 64 pixels', () => {
    for (let k = 0; k < 64; k++) {
      expect(lightCount(toMono(flat(8, 8, 4 * k + 2), 8, 8, { dither: 'ordered' }))).toBe(k + 1);
      expect(lightCount(toMono(flat(8, 8, 4 * k + 1), 8, 8, { dither: 'ordered' }))).toBe(k);
    }
    expect(lightCount(toMono(flat(8, 8, 0), 8, 8, { dither: 'ordered' }))).toBe(0);
    expect(lightCount(toMono(flat(8, 8, 255), 8, 8, { dither: 'ordered' }))).toBe(64);
    expect(lightCount(toMono(flat(32, 32, 64), 32, 32, { dither: 'ordered' }))).toBe(256); // 25 %
    expect(lightCount(toMono(flat(32, 32, 192), 32, 32, { dither: 'ordered' }))).toBe(768); // 75 %
    // The threshold shifts it: 128 at threshold 192 reads as 64.
    expect(lightCount(toMono(flat(32, 32, 128), 32, 32, { dither: 'ordered', threshold: 192 }))).toBe(256);
  });

  it('diffusion: Floyd–Steinberg, serpentine, integer (worked by hand)', () => {
    expect(Array.from(toMono(flat(4, 1, 128), 4, 1, { dither: 'diffusion' }))).toEqual([0b1010_0000]);
    // 3x2 of 100: row 0 left to right gives dark, light, dark; row 1 (110, 82, 108) right to left the same.
    expect(Array.from(toMono(flat(3, 2, 100), 3, 2, { dither: 'diffusion' }))).toEqual([0b0100_0000, 0b0100_0000]);
    expect(lightCount(toMono(flat(10, 10, 0), 10, 10, { dither: 'diffusion' }))).toBe(0);
    expect(lightCount(toMono(flat(10, 10, 255), 10, 10, { dither: 'diffusion' }))).toBe(100);
  });

  it('diffusion: a 50 % grey comes out about half light, the same every time', () => {
    const a = toMono(flat(64, 64, 128), 64, 64, { dither: 'diffusion' });
    expect(Math.abs(lightCount(a) - 2048)).toBeLessThanOrEqual(41); // within 1 %
    expect(toMono(flat(64, 64, 128), 64, 64, { dither: 'diffusion' })).toEqual(a);
    const ramp2 = Uint8Array.from({ length: 256 * 16 }, (_, i) => i % 256);
    expect(Math.abs(lightCount(toMono(ramp2, 256, 16, { dither: 'diffusion' })) / 4096 - 127.5 / 255)).toBeLessThan(0.01);
    const inv = toMono(flat(61, 7, 77), 61, 7, { dither: 'diffusion', invert: true });
    const pos = toMono(flat(61, 7, 77), 61, 7, { dither: 'diffusion' });
    expect(lightCount(inv) + lightCount(pos)).toBe(61 * 7);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Changed rectangles

function frame(width: number, height: number, fill = 0): Uint8Array {
  const stride = Math.ceil(width / 8);
  const f = new Uint8Array(stride * height).fill(fill);
  return clearPadding(f, width, height);
}

function clearPadding(f: Uint8Array, width: number, height: number): Uint8Array {
  const stride = Math.ceil(width / 8);
  if (width & 7) {
    for (let y = 0; y < height; y++) {
      f[y * stride + stride - 1] &= (0xff00 >> (width & 7)) & 0xff;
    }
  }
  return f;
}

function setPixel(f: Uint8Array, width: number, x: number, y: number, on: boolean): void {
  const i = y * Math.ceil(width / 8) + (x >> 3);
  f[i] = on ? f[i] | (0x80 >> (x & 7)) : f[i] & ~(0x80 >> (x & 7));
}

function fillRect(f: Uint8Array, width: number, x: number, y: number, w: number, h: number, on: boolean): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      setPixel(f, width, xx, yy, on);
    }
  }
}

/** The invariants of every rectangle: byte-aligned, inside, data cut from next, at most maxBytes, no overlap. */
function checkRegions(regions: MonoRegion[], next: Uint8Array, width: number, height: number, maxBytes: number, label = ''): void {
  const stride = Math.ceil(width / 8);
  const covered = new Uint8Array(next.length);
  for (const r of regions) {
    const bw = Math.ceil(r.w / 8);
    expect(r.x % 8, label).toBe(0);
    expect(r.w % 8 === 0 || r.x + r.w === width, label).toBe(true);
    expect(r.x >= 0 && r.y >= 0 && r.w >= 1 && r.h >= 1 && r.x + r.w <= width && r.y + r.h <= height, label).toBe(true);
    expect(r.data.length, label).toBe(bw * r.h);
    expect(r.data.length, label).toBeLessThanOrEqual(maxBytes);
    for (let row = 0; row < r.h; row++) {
      for (let c = 0; c < bw; c++) {
        const i = (r.y + row) * stride + r.x / 8 + c;
        expect(r.data[row * bw + c], label).toBe(next[i]);
        expect(covered[i]++, `${label}: byte ${i} in two rectangles`).toBe(0);
      }
    }
  }
}

const bytesOf = (regions: MonoRegion[]): number => regions.reduce((n, r) => n + r.data.length, 0);

/** mulberry32: a small seeded generator, the same sequence everywhere. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('monoRegions', () => {
  it('identical frames: none', () => {
    const f = frame(400, 300, 0xff);
    expect(monoRegions(f, new Uint8Array(f), 400, 300)).toEqual([]);
  });

  it('one changed pixel: one 8-pixel-wide rectangle of one byte', () => {
    const prev = frame(400, 300, 0xff);
    const next = new Uint8Array(prev);
    setPixel(next, 400, 100, 50, false);
    expect(monoRegions(prev, next, 400, 300)).toEqual([{ x: 96, y: 50, w: 8, h: 1, data: Uint8Array.from([0b1111_0111]) }]);
  });

  it('a whole 400x300 frame: rectangles of at most 1,200 B covering its 15,000 B', () => {
    const prev = frame(400, 300, 0xff);
    const next = frame(400, 300, 0);
    for (let i = 0; i < 300; i += 7) {
      fillRect(next, 400, i, i, 5, 3, true); // never a whole byte of 0xff: every byte differs from prev
    }
    for (const [p, label] of [
      [prev, 'all changed'],
      [null, 'prev null'],
      [new Uint8Array(10), 'prev of another size'],
    ] as [Uint8Array | null, string][]) {
      const regions = monoRegions(p, next, 400, 300);
      checkRegions(regions, next, 400, 300, 1200, label);
      expect(bytesOf(regions), label).toBe(15000);
      expect(regions.length, label).toBe(13); // 300 rows of 50 B, 24 rows (1,200 B) a rectangle at most
      expect(applyRegions(p && p.length === next.length ? p : frame(400, 300, 0x5a), 400, 300, regions), label).toEqual(next);
    }
  });

  it('odd widths: the last byte column stops at the right edge', () => {
    const prev = frame(13, 5, 0);
    const next = new Uint8Array(prev);
    setPixel(next, 13, 12, 3, true);
    expect(monoRegions(prev, next, 13, 5)).toEqual([{ x: 8, y: 3, w: 5, h: 1, data: Uint8Array.from([0b0000_1000]) }]);
    const all = frame(13, 5, 0xff);
    const regions = monoRegions(prev, all, 13, 5);
    expect(regions).toEqual([{ x: 0, y: 0, w: 13, h: 5, data: all }]);
    expect(applyRegions(prev, 13, 5, regions)).toEqual(all);
  });

  it('a row wider than maxBytes is split into column pieces', () => {
    const prev = frame(400, 4, 0);
    const next = frame(400, 4, 0xff);
    const regions = monoRegions(prev, next, 400, 4, 20);
    checkRegions(regions, next, 400, 4, 20);
    expect(regions.map((r) => [r.x, r.y, r.w, r.h])).toEqual(
      [0, 1, 2, 3].flatMap((y) => [
        [0, y, 128, 1],
        [128, y, 136, 1],
        [264, y, 136, 1],
      ]),
    );
    expect(applyRegions(prev, 400, 4, regions)).toEqual(next);
  });

  it('the rule: side by side pictures part, a diagonal stays narrow, a T is bar and stem', () => {
    const prev = frame(400, 300, 0xff);
    const sides = new Uint8Array(prev);
    fillRect(sides, 400, 0, 100, 40, 16, false);
    fillRect(sides, 400, 360, 100, 40, 16, false);
    expect(monoRegions(prev, sides, 400, 300).map((r) => [r.x, r.y, r.w, r.h])).toEqual([
      [0, 100, 40, 16],
      [360, 100, 40, 16],
    ]);

    const diagonal = new Uint8Array(prev);
    for (let i = 0; i < 300; i++) {
      setPixel(diagonal, 400, i, i, false);
    }
    const d = monoRegions(prev, diagonal, 400, 300);
    checkRegions(d, diagonal, 400, 300, 1200);
    expect(d.length).toBeLessThanOrEqual(13);
    expect(bytesOf(d)).toBeLessThan(1000); // its bounding box is 11,400 B

    const t = new Uint8Array(prev);
    fillRect(t, 400, 0, 10, 240, 1, false);
    fillRect(t, 400, 120, 11, 1, 189, false);
    const tr = monoRegions(prev, t, 400, 300);
    expect(tr.length).toBe(2);
    expect(bytesOf(tr)).toBeLessThanOrEqual(30 + 189 + 2 * REGION_SLACK);
    expect(applyRegions(prev, 400, 300, tr)).toEqual(t);
  });

  it('applying the rectangles to prev gives next exactly (random frames and edits, seeded)', () => {
    const rand = rng(0xe1d9);
    const int = (n: number): number => Math.floor(rand() * n);
    const randomFrame = (w: number, h: number): Uint8Array => clearPadding(Uint8Array.from({ length: Math.ceil(w / 8) * h }, () => int(256)), w, h);
    for (let trial = 0; trial < 300; trial++) {
      const w = 1 + int(130);
      const h = 1 + int(70);
      const prev = [() => randomFrame(w, h), () => frame(w, h, 0xff), () => frame(w, h, 0)][int(3)]();
      let next: Uint8Array = new Uint8Array(prev);
      for (let e = int(7); e > 0; e--) {
        const [x, y] = [int(w), int(h)];
        switch (int(4)) {
          case 0:
            setPixel(next, w, x, y, !int(2));
            break;
          case 1:
            fillRect(next, w, x, y, 1 + int(w - x), 1 + int(h - y), !int(2));
            break;
          case 2: {
            const [x1, y1] = [int(w), int(h)];
            const steps = Math.max(Math.abs(x1 - x), Math.abs(y1 - y), 1);
            for (let s = 0; s <= steps; s++) {
              setPixel(next, w, Math.round(x + ((x1 - x) * s) / steps), Math.round(y + ((y1 - y) * s) / steps), !int(2));
            }
            break;
          }
          default:
            for (let k = int(40); k > 0; k--) {
              setPixel(next, w, Math.min(w - 1, x + int(9)), Math.min(h - 1, y + int(9)), !int(2));
            }
        }
      }
      if (int(12) === 0) {
        next = randomFrame(w, h);
      }
      const maxBytes = [1, 2, 3, 5, 8, 17, 64, 300, 1200][int(9)];
      const p = int(10) === 0 ? null : int(20) === 0 ? prev.subarray(1) : prev;
      const label = `trial ${trial}: ${w}x${h}, maxBytes ${maxBytes}${p === prev ? '' : ', whole frame'}`;
      const regions = monoRegions(p, next, w, h, maxBytes);
      checkRegions(regions, next, w, h, maxBytes, label);
      expect(bytesOf(regions), label).toBeLessThanOrEqual(next.length);
      expect(applyRegions(p === prev ? prev : randomFrame(w, h), w, h, regions), label).toEqual(next);
      if (p !== prev) {
        expect(bytesOf(regions), label).toBe(next.length);
      }
    }
  });

  it('applyRegions writes only w pixels of a last partial byte inside the frame, and refuses what does not fit', () => {
    const base = frame(16, 1, 0);
    expect(Array.from(applyRegions(base, 16, 1, [{ x: 0, y: 0, w: 3, h: 1, data: Uint8Array.from([0xff]) }]))).toEqual([0b1110_0000, 0]);
    expect(() => applyRegions(base, 16, 1, [{ x: 4, y: 0, w: 8, h: 1, data: new Uint8Array(1) }])).toThrow(/not a byte-aligned rectangle/);
    expect(() => applyRegions(base, 16, 1, [{ x: 8, y: 0, w: 16, h: 1, data: new Uint8Array(2) }])).toThrow(/not a byte-aligned rectangle/);
    expect(() => applyRegions(base, 16, 1, [{ x: 0, y: 0, w: 16, h: 1, data: new Uint8Array(3) }])).toThrow(/data is 3 B, not 2/);
  });
});

describe('monoToPng', () => {
  it("is png.ts's 1-bit greyscale PNG of the frame, and decodes back (a 1 bit white)", () => {
    const mono = frame(13, 3, 0);
    setPixel(mono, 13, 12, 2, true);
    setPixel(mono, 13, 0, 0, true);
    const png = monoToPng(mono, 13, 3);
    expect(Buffer.from(png).equals(framebufferToPng(mono, 13, 3, 'mono1'))).toBe(true);
    expect(png[8 + 8 + 8]).toBe(1); // bit depth 1
    expect(png[8 + 8 + 9]).toBe(0); // greyscale
    const img = decodePng(png);
    const white = Array.from({ length: 13 * 3 }, (_, i) => img.rgba[i * 4]).flatMap((v, i) => (v === 255 ? [i] : []));
    expect(white).toEqual([0, 2 * 13 + 12]);
    expect(toMono(fitImage(img, 13, 3, 'none'), 13, 3, { dither: 'none' })).toEqual(mono);
  });
});
