// The device pages' structure (DEVICE-SPEC §1): the reserved route words no instance may take, the words of every
// capability, the Overview's grouping of many instances of one capability, an instrument page's caption, and the
// Activity page's filter by instrument.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { captionWords, capWord, deviceEvents, eventInstance, groupInstruments, hasCapWord } from '../src/state/instruments.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** The instance names of every firmware profile (the keys under `caps:`). */
function profileInstances(): { profile: string; name: string }[] {
  const dir = join(ROOT, 'firmware', 'profiles');
  const out: { profile: string; name: string }[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.profile.yaml'))) {
    const lines = readFileSync(join(dir, f), 'utf8').split('\n');
    let inCaps = false;
    for (const line of lines) {
      if (/^caps:\s*$/.test(line)) {
        inCaps = true;
        continue;
      }
      if (inCaps && /^\S/.test(line)) {
        inCaps = false;
      }
      const m = inCaps ? /^ {2}([A-Za-z0-9_-]+):/.exec(line) : null;
      if (m) {
        out.push({ profile: f, name: m[1]! });
      }
    }
  }
  return out;
}

vi.mock('../src/pages/device.css', () => ({}));
vi.mock('../src/pages/devices.css', () => ({}));

let RESERVED_SEGMENTS: readonly string[] = [];
beforeAll(async () => {
  // the frame's module reaches the runtime, which reads the page's location
  (globalThis as { location?: unknown }).location ??= { protocol: 'http:', host: '127.0.0.1:7420', search: '' };
  ({ RESERVED_SEGMENTS } = await import('../src/pages/device/frame.tsx'));
});

const row = (name: string, cap: string, port: number) => ({ inst: { name, cap, port, cap_id: 0, v: '', traits: null } });

describe('the device routes', () => {
  it('reserve words no profile’s instance takes', () => {
    const all = profileInstances();
    expect(all.length).toBeGreaterThan(20);
    expect(all.map((i) => i.name)).toContain('cam');
    expect(all.filter((i) => RESERVED_SEGMENTS.includes(i.name))).toEqual([]);
  });

  it('have a word for every capability in schema/capabilities', () => {
    const dir = join(ROOT, 'schema', 'capabilities');
    const caps = readdirSync(dir)
      .filter((n) => n.endsWith('.cap.yaml'))
      .map((f) => /^capability:\s*(\S+)/m.exec(readFileSync(join(dir, f), 'utf8'))![1]!);
    expect(caps).toContain('fr.camera');
    expect(caps.filter((c) => !hasCapWord(c))).toEqual([]);
    expect(capWord('fr.analog_in')).toBe('analog input');
    expect(capWord('fr.led')).toBe('light');
  });
});

describe('the Overview’s rows', () => {
  it('fold ch0–ch13 into one group, and keep cam-esp32’s three apart', () => {
    const fixture = [row('status', 'fr.led', 1), ...Array.from({ length: 14 }, (_, i) => row(`ch${i}`, 'fr.analog_in', i + 2)), row('beep', 'fr.audio_out', 20)];
    const items = groupInstruments(fixture);
    expect(items.map((i) => i.kind)).toEqual(['one', 'group', 'one']);
    const g = items[1]!;
    expect(g.kind === 'group' && g.label).toBe('ch0 – ch13');
    expect(g.kind === 'group' && g.rows.length).toBe(14);
    const cam = groupInstruments([row('status', 'fr.led', 1), row('flash', 'fr.led', 2), row('cam', 'fr.camera', 3)]);
    expect(cam.map((i) => (i.kind === 'one' ? i.row.inst.name : i.label))).toEqual(['status', 'flash', 'cam']);
  });

  it('caption an instrument page in words', () => {
    expect(captionWords({ cap: 'fr.camera', port: 3, traits: { sensor: 1, max_frame_size: 5 } })).toBe('camera · port 3 · ov2640 · up to uxga');
    expect(captionWords({ cap: 'fr.led', port: 1, traits: null })).toBe('light · port 1');
  });
});

describe('the Activity filter', () => {
  it('keeps a device’s events, newest first, all or one instrument’s', () => {
    const ring = [
      { device: 'd1', type: 'status.on' },
      { device: 'd1', type: 'cam.stream_ended' },
      { device: 'd2', type: 'cam.stream_ended' },
      { device: 'd1', type: 'device.online' },
      { device: 'd1', type: 'cam.stream_started' },
    ];
    expect(deviceEvents(ring, 'd1', null).map((e) => e.type)).toEqual(['cam.stream_started', 'device.online', 'cam.stream_ended', 'status.on']);
    expect(deviceEvents(ring, 'd1', 'cam').map((e) => e.type)).toEqual(['cam.stream_started', 'cam.stream_ended']);
    expect(deviceEvents(ring, 'd1', null, 2)).toHaveLength(2);
    expect(eventInstance('cam.stream_ended')).toBe('cam');
    expect(eventInstance('boot')).toBeNull();
  });
});
