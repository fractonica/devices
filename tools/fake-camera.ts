// A fake ESP32-CAM for the scratch hub (tools/dash-dev.ts --camera; DEVICE-SPEC §6.11): a FakeNode
// (packages/hub/test/fake-node.ts) with e32a-cam's instances (status and flash fr.led, cam fr.camera) that behaves as the
// board() rig of packages/hub/test/camera-c1.test.ts does, against a real private hub:
// - stream_start POSTs mjpg1 frames to the hub's node HTTP port (to hub, both), one every max(interval_ms, 100) ms, for
//   `seconds` or `max_frames` or until stream_stop, then the zero chunk and stream_ended; `to sd` and `both` also keep
//   the frames as a recording on its card. The frames are real JPEGs of a moving pattern (a tiny grayscale encoder
//   below, no dependency), at the frame size asked for, so a browser draws them.
// - set keeps the sensor's settings (a frame size above max_frame_size is INVALID_ARGS); sd_list pages the card's
//   recordings (two at the start); sd_fetch POSTs a recording's frames (flags b0); sd_delete removes one.
// - The properties (frames, fps_x10, last_bytes, streaming, sd mounted, sd_free_mb) follow what it does. With
//   `card: false` the slot is empty (sd none) and a recording to the card is refused.
// Never a real board, a serial port or the lab hub: it speaks only to the private hub it is given.

import { connect as tcpConnect } from 'node:net';

import { decodeMember, encodeMember } from '@fractonica/protocol/gen';
import { encodeJpegBlock } from '@fractonica/sdk/camera';

import { FakeNode, STATUS } from '../packages/hub/test/fake-node.ts';

/** e32a-cam's instances: status 1, flash 2 (fr.led), cam 3 (fr.camera). */
export const CAM_CAPS = [
  { port: 1, cap_id: 0x0002, name: 'status' },
  { port: 2, cap_id: 0x0002, name: 'flash' },
  { port: 3, cap_id: 0x000b, name: 'cam' },
];

const SIZES = ['qvga', 'vga', 'svga', 'xga', 'sxga', 'uxga'] as const;
type Size = (typeof SIZES)[number];
const DIMS: Record<Size, [number, number]> = { qvga: [320, 240], vga: [640, 480], svga: [800, 600], xga: [1024, 768], sxga: [1280, 1024], uxga: [1600, 1200] };
const PROP = { frames: 1, fps_x10: 2, last_bytes: 3, streaming: 4, sd: 5, sd_free_mb: 6 } as const;

// ---- a grayscale baseline JPEG: each 8×8 block one shade (DC only), enough for a moving test pattern ----

const ZIGZAG_LEN = 64;
/** The standard luminance DC Huffman table (ITU T.81 K.3). */
const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
/** An AC table with one symbol, EOB (0x00), code `0`: every block has no AC coefficient. */
const AC_BITS = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const AC_VALS = [0];

function huffCodes(bits: number[], vals: number[]): Map<number, { code: number; len: number }> {
  const out = new Map<number, { code: number; len: number }>();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]!; i++) {
      out.set(vals[k++]!, { code, len });
      code++;
    }
    code <<= 1;
  }
  return out;
}
const DC = huffCodes(DC_BITS, DC_VALS);

class BitWriter {
  bytes: number[] = [];
  #acc = 0;
  #n = 0;
  put(code: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) {
      this.#acc = (this.#acc << 1) | ((code >> i) & 1);
      if (++this.#n === 8) {
        this.bytes.push(this.#acc);
        if (this.#acc === 0xff) {
          this.bytes.push(0); // byte stuffing
        }
        this.#acc = 0;
        this.#n = 0;
      }
    }
  }
  flush(): void {
    while (this.#n !== 0) {
      this.put(1, 1);
    }
  }
}

const seg = (marker: number, body: number[]) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];

/** A JPEG of `w`×`h` whose 8×8 blocks take `shade(bx, by)` (0..255). */
export function grayJpeg(w: number, h: number, shade: (bx: number, by: number) => number): Uint8Array {
  const bw = Math.ceil(w / 8);
  const bh = Math.ceil(h / 8);
  const dqt = seg(0xdb, [0x00, 8, ...new Array<number>(ZIGZAG_LEN - 1).fill(1)]);
  const sof = seg(0xc0, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0]);
  const dht = [...seg(0xc4, [0x00, ...DC_BITS, ...DC_VALS]), ...seg(0xc4, [0x10, ...AC_BITS, ...AC_VALS])];
  const sos = seg(0xda, [1, 1, 0x00, 0, 63, 0]);
  const bw2 = new BitWriter();
  let prev = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const dc = Math.max(-127, Math.min(127, Math.round(shade(bx, by)) - 128)); // DCT DC = 8×(mean−128), quantized by 8
      const diff = dc - prev;
      prev = dc;
      const mag = Math.abs(diff);
      const cat = mag === 0 ? 0 : Math.floor(Math.log2(mag)) + 1;
      const c = DC.get(cat)!;
      bw2.put(c.code, c.len);
      if (cat > 0) {
        bw2.put(diff > 0 ? diff : diff + (1 << cat) - 1, cat);
      }
      bw2.put(0, 1); // EOB
    }
  }
  bw2.flush();
  return Uint8Array.from([0xff, 0xd8, ...dqt, ...sof, ...dht, ...sos, ...bw2.bytes, 0xff, 0xd9]);
}

/** Frame `i` of the test pattern: a soft diagonal ramp drifting, a bright bar sweeping across, a ring. */
export function patternFrame(size: Size, i: number, opts: { flip?: boolean; mirror?: boolean; brightness?: number } = {}): Uint8Array {
  const [w, h] = DIMS[size];
  const bw = Math.ceil(w / 8);
  const bh = Math.ceil(h / 8);
  const bar = (i * 3) % bw;
  const cx = bw / 2 + Math.cos(i / 9) * (bw / 4);
  const cy = bh / 2 + Math.sin(i / 9) * (bh / 4);
  const r = Math.min(bw, bh) / 6;
  const lift = (opts.brightness ?? 0) * 18;
  return grayJpeg(w, h, (x0, y0) => {
    const x = opts.mirror ? bw - 1 - x0 : x0;
    const y = opts.flip ? bh - 1 - y0 : y0;
    let v = 40 + ((x + y + i) % 64) * 1.2;
    if (Math.abs(x - bar) < 2) {
      v = 220;
    }
    const d = Math.hypot(x - cx, y - cy);
    if (Math.abs(d - r) < 1.2) {
      v = 245;
    }
    return Math.max(0, Math.min(255, v + lift));
  });
}

// ---- the board ----

export interface FakeCameraOptions {
  mac: string;
  addr: number;
  net: number;
  alias: string;
  aliasRev: number;
  epoch: number;
  fwPrefix?: string;
  hub: { tcp: number; udp: number; http: number };
  /** The largest frame size its buffers take (trait max_frame_size). */
  maxFrameSize?: Size;
  /** Recordings on the card at the start. */
  recordings?: number;
  /** False: the slot is empty (sd none; a recording to the card is INVALID_ARGS, sd_list UNSUPPORTED). */
  card?: boolean;
}

const enc = (cap: string, part: 'args' | 'result' | 'event' | 'state', member: string, v: unknown) => {
  const e = encodeMember(cap, part, member, v);
  if (!e.ok) {
    throw new Error(`${cap}.${member}: ${e.detail}`);
  }
  return e.value;
};
const dec = <T>(cap: string, member: string, bytes: Uint8Array): T => {
  const d = decodeMember(cap, 'args', member, bytes);
  if (!d.ok) {
    throw new Error(`${cap}.${member}: ${d.error}`);
  }
  return d.value as T;
};

function chunk(data: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`${data.length.toString(16)}\r\n`), Buffer.from(data), Buffer.from('\r\n')]);
}

export interface FakeCamera {
  node: FakeNode;
  stop(): Promise<void>;
}

export async function startFakeCamera(o: FakeCameraOptions): Promise<FakeCamera> {
  const node = new FakeNode({ mac: o.mac, addr: o.addr, net: o.net, alias: o.alias, aliasRev: o.aliasRev, epoch: o.epoch, hub: { tcp: o.hub.tcp, udp: o.hub.udp }, ...(o.fwPrefix ? { fwPrefix: o.fwPrefix } : {}) });
  node.describeAs(CAM_CAPS);
  const max: Size = o.maxFrameSize ?? 'uxga';
  const settings = { frame_size: 'svga' as Size, quality: 12, vflip: false, hmirror: false, brightness: 0 };
  const card = o.card !== false;
  let recordings = Array.from({ length: card ? (o.recordings ?? 2) : 0 }, (_, k) => ({ id: 4100 + k * 7, frames: 40 + k * 25, bytes: (40 + k * 25) * 7300 }));
  let frames = 0;
  let sdFreeMb = 3712;
  const running = new Map<number, () => void>();
  let closed = false;

  const prop = (name: keyof typeof PROP, v: unknown) => {
    if (!closed) {
      node.state(3, PROP[name], enc('fr.camera', 'state', name, { [name]: v }));
    }
  };
  const ended = (streamId: number, reason: string, n: number, dropped: number, bytes: number) => {
    if (!closed) {
      node.event(3, 1, enc('fr.camera', 'event', 'stream_ended', { stream_id: streamId, reason, frames: n, dropped, bytes }));
    }
  };

  /** POSTs `count` frames (Infinity: until stopped) every `everyMs`; also counts them for the card when `card`. */
  const post = (streamId: number, count: number, everyMs: number, size: Size, quality: number, flags: number, toHub: boolean) =>
    new Promise<{ sent: number; bytes: number; stopped: boolean }>((resolve) => {
      let stopped = false;
      running.set(streamId, () => (stopped = true));
      let sent = 0;
      let bytes = 0;
      const t0 = Date.now();
      const run = async (write: ((b: Buffer) => void) | null) => {
        prop('streaming', true);
        for (let i = 0; i < count && !stopped && !closed; i++) {
          const jpeg = patternFrame(size, frames + i, { flip: settings.vflip, mirror: settings.hmirror, brightness: settings.brightness });
          if (write) {
            const [w, h] = DIMS[size];
            write(chunk(encodeJpegBlock({ seq: sent, index: i, tUs: (Date.now() - t0) * 1000, width: w, height: h, quality, frameSize: size, flags }, jpeg)));
          }
          sent++;
          bytes += jpeg.length;
          if (sent % 5 === 0) {
            prop('frames', frames + sent);
            prop('fps_x10', Math.round(10_000 / everyMs));
            prop('last_bytes', jpeg.length);
          }
          await new Promise((r) => setTimeout(r, everyMs));
        }
        frames += sent;
        prop('frames', frames);
        prop('fps_x10', 0);
        prop('streaming', false);
        running.delete(streamId);
      };
      if (!toHub) {
        void run(null).then(() => resolve({ sent, bytes, stopped }));
        return;
      }
      const s = tcpConnect(o.hub.http, '127.0.0.1');
      s.on('error', () => undefined);
      s.on('connect', async () => {
        s.write(`POST /v1/stream/in/${streamId} HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\nX-Fr-Device: ${o.mac}\r\nX-Fr-Kind: jpeg\r\nX-Fr-Format: mjpg1\r\nConnection: close\r\n\r\n`);
        await run((b) => !s.destroyed && s.write(b));
        s.resume();
        s.end('0\r\n\r\n');
        s.on('close', () => resolve({ sent, bytes, stopped }));
      });
    });

  // fr.camera stream_start
  node.handlers.set('3/1', (args) => {
    const a = dec<{ stream_id: number; seconds: number; interval_ms: number; max_frames: number; to: string; frame_size?: Size; quality?: number }>('fr.camera', 'stream_start', args);
    if (running.size > 0) {
      return { status: STATUS.BUSY };
    }
    if (!card && a.to !== 'hub') {
      return { status: STATUS.INVALID_ARGS };
    }
    const size = a.frame_size ?? settings.frame_size;
    if (SIZES.indexOf(size) > SIZES.indexOf(max)) {
      return { status: STATUS.INVALID_ARGS };
    }
    const every = Math.max(a.interval_ms, 100);
    const count = a.max_frames > 0 ? a.max_frames : a.seconds ? Math.max(1, Math.round((a.seconds * 1000) / every)) : Infinity;
    setImmediate(async () => {
      const got = await post(a.stream_id, count, every, size, a.quality ?? settings.quality, 0, a.to !== 'sd');
      if (a.to !== 'hub' && got.sent > 0) {
        recordings.push({ id: a.stream_id, frames: got.sent, bytes: got.bytes });
        sdFreeMb = Math.max(0, sdFreeMb - Math.ceil(got.bytes / 1e6));
        prop('sd_free_mb', sdFreeMb);
      }
      ended(a.stream_id, got.stopped ? 'stopped' : 'done', got.sent, 0, got.bytes);
    });
    return undefined;
  });
  // stream_stop
  node.handlers.set('3/2', (args) => {
    const a = dec<{ stream_id: number }>('fr.camera', 'stream_stop', args);
    const stop = running.get(a.stream_id);
    if (!stop) {
      return { status: STATUS.NOT_FOUND };
    }
    stop();
    return undefined;
  });
  // set
  node.handlers.set('3/3', (args) => {
    const a = dec<Partial<typeof settings>>('fr.camera', 'set', args);
    if (a.frame_size !== undefined && SIZES.indexOf(a.frame_size) > SIZES.indexOf(max)) {
      return { status: STATUS.INVALID_ARGS };
    }
    Object.assign(settings, Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)));
    return undefined;
  });
  // sd_list
  node.handlers.set('3/4', (args) => {
    const a = dec<{ from: number }>('fr.camera', 'sd_list', args);
    const page = recordings.slice(a.from, a.from + 64);
    const next = a.from + 64 < recordings.length ? a.from + 64 : 0;
    return { fields: enc('fr.camera', 'result', 'sd_list', { recordings: page, next }) };
  });
  // sd_fetch
  node.handlers.set('3/5', (args) => {
    const a = dec<{ stream_id: number; recording: number; from_frame: number }>('fr.camera', 'sd_fetch', args);
    const rec = recordings.find((r) => r.id === a.recording);
    if (!rec) {
      return { status: STATUS.NOT_FOUND };
    }
    if (running.size > 0) {
      return { status: STATUS.BUSY };
    }
    setImmediate(async () => {
      const got = await post(a.stream_id, rec.frames - a.from_frame, 100, settings.frame_size, settings.quality, 1, true);
      ended(a.stream_id, got.stopped ? 'stopped' : 'done', got.sent, 0, got.bytes);
    });
    return undefined;
  });
  // sd_delete
  node.handlers.set('3/6', (args) => {
    const a = dec<{ recording: number }>('fr.camera', 'sd_delete', args);
    recordings = recordings.filter((r) => r.id !== a.recording);
    return undefined;
  });
  // the LEDs' set (the flash around a photo)
  for (const port of [1, 2]) {
    node.handlers.set(`${port}/1`, (args) => {
      const a = dec<{ on?: boolean }>('fr.led', 'set', args);
      if (a.on !== undefined) {
        node.state(port, 1, enc('fr.led', 'state', 'on', { on: a.on }));
      }
      return undefined;
    });
  }

  await node.connect(10_000);
  prop('frames', 0);
  prop('fps_x10', 0);
  prop('last_bytes', 0);
  prop('streaming', false);
  prop('sd', card ? 'mounted' : 'none');
  prop('sd_free_mb', card ? sdFreeMb : 0);
  return {
    node,
    async stop() {
      closed = true;
      for (const s of running.values()) {
        s();
      }
      node.close();
    },
  };
}
