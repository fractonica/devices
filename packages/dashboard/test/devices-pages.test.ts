// The Devices page and a device's sub-pages (src/pages/devices.tsx, device.tsx, device/page-*.tsx; DEVICE-SPEC §1),
// rendered to strings with the runtime's QueryClient seeded: 30 devices from one device_list and no query per row
// (design m2-c2 D16); a device's Instruments rows, an instrument's page with typed controls from the catalog and no
// JSON, Activity, Facts and Engineering; one primary per page, no button that says "Send", no hub-issued field; and
// nothing Earth in pure mode (design ruling 11), while Earth mode adds ⊕ translations.

import { QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { loadCore } from '@fractonica/time';

const h = vi.hoisted(() => ({ core: null as unknown, mode: 'pure' as 'pure' | 'earth', id: 'desk-pad', instance: undefined as string | undefined, search: {} as Record<string, unknown> }));

vi.mock('../src/time/hooks.ts', () => ({
  useFractonica: () => h.core,
  useCoreError: () => null,
  useNowFor: (core: { frc: { now(): bigint } } | null) => (core ? core.frc.now() : null),
  useReading: () => null,
}));
vi.mock('../src/shell/mode.ts', () => ({
  useMode: () => ({ mode: h.mode, earth: h.mode === 'earth', setMode: () => {}, toggle: () => {} }),
}));
vi.mock('@tanstack/react-router', async () => {
  const react = await import('react');
  return {
    Link: ({ children, params, to, className, search }: { children?: ReactNode; params?: Record<string, string>; to: string; className?: string; search?: Record<string, unknown> }) => {
      const path = to.replace(/\$(\w+)/g, (_, k: string) => params?.[k] ?? '');
      const q = search ? Object.entries(search).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${String(v)}`).join('&') : '';
      return react.createElement('a', { href: `#${path}${q ? `?${q}` : ''}`, className }, children);
    },
    useParams: () => ({ id: h.id, ...(h.instance ? { instance: h.instance } : {}) }),
    useNavigate: () => () => {},
    useSearch: () => h.search,
  };
});
// CSS imports are nothing in node
vi.mock('../src/pages/devices.css', () => ({}));
vi.mock('../src/pages/device.css', () => ({}));
vi.mock('../src/pages/device/panels/camera/camera.css', () => ({}));

type Runtime = typeof import('../src/runtime.ts');
let runtime: Runtime;
let devices: typeof import('../src/pages/devices.tsx');
let device: typeof import('../src/pages/device.tsx');
let lens: typeof import('../src/pages/device/page-lens.tsx');
let activity: typeof import('../src/pages/device/page-activity.tsx');
let facts: typeof import('../src/pages/device/page-facts.tsx');
let engineering: typeof import('../src/pages/device/page-engineering.tsx');

beforeAll(async () => {
  (globalThis as { location?: unknown }).location ??= { protocol: 'http:', host: '127.0.0.1:7420', search: '' };
  h.core = await loadCore();
  runtime = await import('../src/runtime.ts');
  devices = await import('../src/pages/devices.tsx');
  device = await import('../src/pages/device.tsx');
  lens = await import('../src/pages/device/page-lens.tsx');
  activity = await import('../src/pages/device/page-activity.tsx');
  facts = await import('../src/pages/device/page-facts.tsx');
  engineering = await import('../src/pages/device/page-engineering.tsx');
});

/** Anything Earth: a clock time, a civil date, an Earth unit, a per cent, the Earth sign. */
const EARTH = /⊕|\d{1,2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T|\b\d+\s?(h|min|s|ms|Hz|mV|dBm)\b|%/;
/** Text a reader sees: tags dropped, attributes kept (aria-label and title count). */
const visible = (html: string) => html.replace(/ style="[^"]*"/g, '');

function row(i: number, presence = 'online') {
  return {
    device_id: `02f2000000${String(i).padStart(2, '0')}`,
    addr: i,
    alias: `sim-${String(i).padStart(2, '0')}`,
    alias_rev: 1,
    net: 1,
    board: null,
    profile: 'c6-pad',
    chip: 'esp32c6',
    tags: [],
    role: 'node',
    fw_id: '3f2a9c01b2d40011',
    provisioned: true,
    last_seen: '2026-11-13T18:13:05.849Z',
    last_epoch: 1,
    created_at: '2026-11-13T18:13:04.942Z',
    presence,
    live: presence === 'online' ? { links: ['tcp'], udp_blocked: false, rssi_ap: -50 - i, uptime_s: 31, fw_id_prefix: '3f2a9c01b2d40011' } : null,
  };
}

const DETAIL = {
  ...row(1),
  alias: 'desk-pad',
  provision: null,
  router: {
    presence: 'online',
    links: ['tcp'],
    udp_ms_ago: 777,
    udp_blocked: false,
    epoch: 1,
    addr: 1,
    fw_id_prefix: '3f2a9c01b2d40011',
    ota_state: 'valid',
    hello_caps: 115,
    hb_interval_ms: 1000,
    last_rx_ms_ago: 724,
    clock: { offset_us: -12, uncertainty_us: 1521.5, skew_ppm: 0, rtt_us: 3043, at_us: 1794593585875185, samples: 8 },
    heartbeat: { uptime_s: 31, rssi_ap: -72, tx_fail: 0, rx_drop: 0, free_heap_kb: 200, vbat_mv: 0 },
    properties: { 'boot.pressed': false, 'status.on': true, 'status.brightness': 64, 'status.color': 0xff8800 },
    instances: [
      { name: 'boot', port: 1, cap_id: 1, cap: 'fr.button' },
      { name: 'status', port: 2, cap_id: 2, cap: 'fr.led' },
    ],
    gw: null,
    gateway: null,
  },
};

function render(el: ReturnType<typeof createElement>) {
  return renderToString(createElement(QueryClientProvider, { client: runtime.queryClient }, el));
}

describe('the Devices page', () => {
  it('renders 30 rows from one device_list, with no query per row, and nothing Earth in pure mode', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    runtime.queryClient.clear();
    const list = Array.from({ length: 30 }, (_, k) => row(k + 1, k === 29 ? 'offline' : 'online'));
    runtime.queryClient.setQueryData(['device_list', {}], { devices: list, count: 30, truncated: false });
    h.mode = 'pure';
    const html = render(createElement(devices.DevicesPage));
    vi.unstubAllGlobals();
    expect(html.match(/ data-device="/g)).toHaveLength(30);
    expect(html).toContain('data-count="30"');
    expect(html).toContain('29 OF 30 ONLINE');
    expect(html).toContain('>3f2a9c01<');
    // online first: the offline one is last
    expect(html.lastIndexOf('data-presence="offline"')).toBeGreaterThan(html.lastIndexOf('data-presence="online"'));
    // the filter appears with many devices
    expect(html).toContain('FIND');
    expect(visible(html)).not.toMatch(EARTH);
    expect(runtime.queryClient.getQueryCache().getAll().map((q) => q.queryKey)).toEqual([['device_list', {}]]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('says what to do when there is no device', () => {
    runtime.queryClient.clear();
    runtime.queryClient.setQueryData(['device_list', {}], { devices: [], count: 0, truncated: false });
    const html = render(createElement(devices.DevicesPage));
    expect(html).toContain('NO DEVICES YET');
    expect(html).toContain('href="#/provision"');
  });

  it('adds the signal in dBm only in Earth mode', () => {
    runtime.queryClient.clear();
    runtime.queryClient.setQueryData(['device_list', {}], { devices: [row(1)], count: 1, truncated: false });
    h.mode = 'earth';
    const html = render(createElement(devices.DevicesPage));
    h.mode = 'pure';
    expect(html).toContain('-51 dBm');
    expect(html).toContain('⊕');
  });
});

/** The owner's camera board as the hub knows it (e32a-cam: status, flash, cam). */
const CAM = {
  ...row(2),
  alias: 'cam-esp32',
  profile: 'e32a-cam',
  board: 'aithinker-esp32-cam',
  chip: 'esp32',
  provision: null,
  router: {
    ...DETAIL.router,
    hello_caps: 99,
    properties: { 'status.on': false, 'flash.on': false, 'cam.streaming': false, 'cam.sd': 1, 'cam.frames': 58500, 'cam.fps_x10': 0, 'cam.last_bytes': 38400, 'cam.sd_free_mb': 3712 },
    instances: [
      { name: 'status', port: 1, cap_id: 2, cap: 'fr.led' },
      { name: 'flash', port: 2, cap_id: 2, cap: 'fr.led' },
      { name: 'cam', port: 3, cap_id: 11, cap: 'fr.camera' },
    ],
  },
};

type Sub = 'overview' | 'lens' | 'activity' | 'facts' | 'engineering';

/** A device sub-page as HTML, for `id` (and `instance` on an instrument page), with `search`. */
function page(sub: Sub, opts: { id?: string; instance?: string; search?: Record<string, unknown>; mode?: 'pure' | 'earth' } = {}): string {
  runtime.queryClient.clear();
  runtime.queryClient.setQueryData(['device_get', { device: 'desk-pad' }], DETAIL);
  runtime.queryClient.setQueryData(['device_get', { device: 'cam-esp32' }], CAM);
  h.id = opts.id ?? 'desk-pad';
  h.instance = opts.instance;
  h.search = opts.search ?? {};
  h.mode = opts.mode ?? 'pure';
  const component = { overview: device.DevicePage, lens: lens.DeviceLensPage, activity: activity.DeviceActivityPage, facts: facts.DeviceFactsPage, engineering: engineering.DeviceEngineeringPage }[sub];
  try {
    return render(createElement(component));
  } finally {
    h.mode = 'pure';
    h.instance = undefined;
    h.search = {};
  }
}

/** The words on every <button> of a page, tags inside dropped. */
const buttonTexts = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, '').trim());

describe('a device’s Instruments (the Overview)', () => {
  it('lists its instruments as rows linking to their pages, beside a glance, with nothing Earth in pure mode', () => {
    const html = page('overview');
    expect(html).toContain('data-device-page="desk-pad"');
    expect(html).toContain('data-device-section="instruments"');
    expect(html).toContain('href="#/devices/desk-pad/boot"');
    expect(html).toContain('href="#/devices/desk-pad/status"');
    expect(html).toContain('BUTTON');
    expect(html).toContain('LIGHT');
    // the light's one quick control: its on/off ring
    expect(html).toMatch(/data-quick="status"[\s\S]*?role="switch" aria-checked="true"/);
    // the glance: signal in words, the clock in spans; facts and activity one link away
    expect(html).toContain('fair');
    expect(html).toContain('±');
    expect(html).toContain('href="#/devices/desk-pad/facts"');
    expect(html).toContain('href="#/devices/desk-pad/activity"');
    // the sub-nav, no JSON, nothing Earth
    expect(html).toMatch(/INSTRUMENTS[\s\S]*ACTIVITY[\s\S]*FACTS[\s\S]*ENGINEERING/);
    expect(html).not.toMatch(/\{"|":/);
    expect(visible(html)).not.toMatch(EARTH);
  });

  it('gives cam-esp32 three rows, the camera’s with a WATCH link that starts the view', () => {
    const html = page('overview', { id: 'cam-esp32' });
    for (const i of ['status', 'flash', 'cam']) {
      expect(html).toContain(`href="#/devices/cam-esp32/${i}"`);
    }
    expect(html.match(/ data-instrument="/g)).toHaveLength(3);
    expect(html).toContain('CAMERA');
    expect(html).toContain('href="#/devices/cam-esp32/cam?watch=1"');
    expect(visible(html)).not.toMatch(EARTH);
  });
});

describe('an instrument’s page', () => {
  it('draws a light’s properties as its controls, its actions with what they do, and no JSON', () => {
    const html = page('lens', { instance: 'status' });
    expect(html).toContain('data-lens="status"');
    // the strip of its siblings and the caption in words
    expect(html).toContain('href="#/devices/desk-pad/boot"');
    expect(html).toContain('LIGHT · PORT 2');
    // the back link goes to the Instruments row it came from
    expect(html).toContain('href="#/devices/desk-pad?from=status"');
    // on is a switch, brightness a slider, color a colour well, all sending `set`; set's own form is hidden
    expect(html).toMatch(/role="switch" aria-checked="true" aria-label="status state"/);
    expect(html).toMatch(/type="range"[^>]*aria-label="status brightness"/);
    expect(html).toMatch(/type="color"[^>]*value="#ff8800"/);
    expect(html).not.toContain('data-command="status.set"');
    // toggle and stop are buttons that say what they do to what; blink is a fold with its line
    expect(html).toContain('data-command="status.toggle"');
    expect(html).toContain('TOGGLE STATUS');
    expect(html).toContain('Turns status on if it is off, off if it is on.');
    expect(html).toContain('BLINK');
    expect(html).toContain('Blinks status the number of times chosen');
    // the way to its raw commands
    expect(html).toContain('href="#/devices/desk-pad/engineering?instrument=status"');
    expect(html).not.toMatch(/\{"|":/);
    expect(visible(html)).not.toMatch(EARTH);
  });

  it('keeps a button’s gestures in a Simulate fold on a test build', () => {
    const html = page('lens', { instance: 'boot' });
    expect(html).toContain('SIMULATE');
    expect(html).not.toContain('data-command="boot.inject"');
  });

  it('says so for an instrument the device does not have, naming those it has', () => {
    const html = page('lens', { instance: 'nope' });
    expect(html).toContain('NO INSTRUMENT CALLED NOPE ON DESK-PAD');
    expect(html).toContain('href="#/devices/desk-pad/status"');
    expect(html).toContain('ALL INSTRUMENTS');
  });

  it('never offers a field only the hub can issue, nor a stream_id', () => {
    for (const instance of ['status', 'flash', 'cam']) {
      const html = page('lens', { id: 'cam-esp32', instance });
      expect(html, instance).not.toMatch(/stream_id|STREAM ID/i);
      expect(visible(html), instance).not.toMatch(EARTH);
    }
  });
});

describe('Activity, Facts and Engineering', () => {
  it('Activity filters the events by instrument and opens the log on ?log=1', () => {
    const html = page('activity', { id: 'cam-esp32', search: { instrument: 'cam', log: '1' } });
    expect(html).toContain('data-device-section="activity"');
    expect(html).toContain('EVENTS OF CAM');
    expect(html).toMatch(/aria-pressed="true"[^>]*>[\s\S]{0,80}CAM/);
    expect(html).toContain('cam-esp32 log');
    expect(visible(html)).not.toMatch(EARTH);
  });

  it('Facts holds the data column: signal as a word, the clock plainly; Earth mode adds ⊕', () => {
    const html = page('facts');
    expect(html).toContain('desk-pad facts');
    expect(html).toContain('fair');
    expect(html).toMatch(/in step<!-- --> with the hub, to within/);
    expect(visible(html)).not.toMatch(EARTH);
    const earth = page('facts', { mode: 'earth' });
    expect(earth).toContain('-72 dBm');
    expect(earth).toContain('1.5 ms');
  });

  it('Engineering opens an instrument’s raw commands as forms, and the hub’s way for a hub-issued one', () => {
    const html = page('engineering', { id: 'cam-esp32', search: { instrument: 'cam' } });
    expect(html).toContain('data-console="cam"');
    expect(html).toContain('THE CAM PAGE DOES THIS');
    const status = page('engineering', { search: { instrument: 'status' } });
    expect(status).toContain('data-command="status.toggle"');
    expect(status).toContain('SEND AS JSON');
    // stream_start never a form: the hub runs it
    expect(html).toContain('its page does this (WATCH, RECORD…, PLAY)');
    expect(html).not.toContain('data-command="cam.stream_start"');
    expect(visible(html)).not.toMatch(EARTH);
  });
});

describe('every sub-page', () => {
  const all: [string, Sub, { id?: string; instance?: string; search?: Record<string, unknown> }][] = [
    ['overview', 'overview', {}],
    ['status', 'lens', { instance: 'status' }],
    ['boot', 'lens', { instance: 'boot' }],
    ['activity', 'activity', {}],
    ['facts', 'facts', {}],
    ['engineering', 'engineering', { search: { instrument: 'status' } }],
    ['cam overview', 'overview', { id: 'cam-esp32' }],
    ['cam status', 'lens', { id: 'cam-esp32', instance: 'status' }],
    ['cam cam', 'lens', { id: 'cam-esp32', instance: 'cam' }],
    ['cam engineering', 'engineering', { id: 'cam-esp32', search: { instrument: 'cam' } }],
  ];

  it('has exactly one lumen action and no button that says Send', () => {
    for (const [name, sub, opts] of all) {
      const html = page(sub, opts);
      expect(html.match(/data-variant="primary"/g) ?? [], name).toHaveLength(1);
      expect(buttonTexts(html).filter((t) => /^send$/i.test(t)), name).toEqual([]);
    }
  });
});

describe('the face block (design face-f1 D10)', () => {
  it('renders nothing without an fr.face instance, and the face in words with its presses with one', async () => {
    const face = await import('../src/pages/device/face.tsx');
    const inst = (cap: string) => ({ name: cap.slice(3), port: 1, cap, cap_id: 1, v: '', traits: null });
    expect(renderToString(createElement(face.FaceMirror, { instances: [inst('fr.led')], deviceId: 'd' }))).toBe('');
    const router = { properties: { 'face.shown': false, 'face.time_valid': true, 'face.time_source': 'hub', 'face.step': 'preon', 'face.power_save': false } };
    const html = render(createElement(face.FaceMirror, { instances: [inst('fr.face')], deviceId: 'd', detail: { presence: 'online', router } as never }));
    expect(html).toContain('data-face="d"');
    expect(html).toContain('yielded: a picture from the hub is on the panel');
    expect(html).toContain('knows the time, from the hub');
    expect(html).toContain('every Preon');
    for (const a of ['face-show', 'face-prev', 'face-next', 'face-select', 'face-long']) {
      expect(html).toContain(`data-action="${a}"`);
    }
    expect(html).not.toContain('data-face-sound');  // no buzzer on this device
    expect(face.faceWords({ power_save: true }).save).toMatch(/off the network/);
  });

  it('says what the face sounds like on a device with a buzzer (D19)', async () => {
    const face = await import('../src/pages/device/face.tsx');
    const inst = (cap: string) => ({ name: cap.slice(3), port: 1, cap, cap_id: 1, v: '', traits: null });
    const router = { properties: { 'face.chime': 'preon', 'face.clicks': true } };
    const html = render(createElement(face.FaceMirror, { instances: [inst('fr.face'), inst('fr.buzzer')], deviceId: 'd', detail: { presence: 'online', router } as never }));
    expect(html).toContain('chimes each Preon and longer; keys click');
    expect(face.faceWords({ chime: 'off', clicks: false }, true).sound).toBe('chimes never; keys silent');
    expect(face.faceWords({ chime: 'helion' }, false).sound).toBeNull();
  });
});
