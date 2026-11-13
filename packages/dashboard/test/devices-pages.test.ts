// The new Devices and Device pages (src/pages/devices.tsx, device.tsx), rendered to strings with the runtime's
// QueryClient seeded: 30 devices from one device_list and no query per row (design m2-c2 D16); the device's
// capabilities as typed controls from the catalog, with no JSON in the main view; and nothing Earth in pure mode
// (design ruling 11), while Earth mode adds ⊕ translations.

import { QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { loadCore } from '@fractonica/time';

const h = vi.hoisted(() => ({ core: null as unknown, mode: 'pure' as 'pure' | 'earth', id: 'desk-pad' }));

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
    Link: ({ children, params, to, className }: { children?: ReactNode; params?: { id?: string }; to: string; className?: string }) =>
      react.createElement('a', { href: `#${to.replace('$id', params?.id ?? '')}`, className }, children),
    useParams: () => ({ id: h.id }),
    useNavigate: () => () => {},
  };
});
// CSS imports are nothing in node
vi.mock('../src/pages/devices.css', () => ({}));
vi.mock('../src/pages/device.css', () => ({}));

type Runtime = typeof import('../src/runtime.ts');
let runtime: Runtime;
let devices: typeof import('../src/pages/devices.tsx');
let device: typeof import('../src/pages/device.tsx');

beforeAll(async () => {
  (globalThis as { location?: unknown }).location ??= { protocol: 'http:', host: '127.0.0.1:7420', search: '' };
  h.core = await loadCore();
  runtime = await import('../src/runtime.ts');
  devices = await import('../src/pages/devices.tsx');
  device = await import('../src/pages/device.tsx');
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

describe('the Device page', () => {
  it('draws capabilities as typed controls from the catalog, with no JSON and nothing Earth in pure mode', () => {
    runtime.queryClient.clear();
    runtime.queryClient.setQueryData(['device_get', { device: 'desk-pad' }], DETAIL);
    h.mode = 'pure';
    const html = render(createElement(device.DevicePage));
    expect(html).toContain('data-device-page="desk-pad"');
    // fr.led: on is a switch, brightness a slider, color a colour well, all sending `set`; set's own form is hidden
    expect(html).toMatch(/role="switch" aria-checked="true" aria-label="status on"/);
    expect(html).toMatch(/type="range"[^>]*aria-label="status brightness"/);
    expect(html).toMatch(/type="color"[^>]*value="#ff8800"/);
    expect(html).not.toContain('data-command="status.set"');
    // toggle and stop are buttons; blink a fold
    expect(html).toContain('data-command="status.toggle"');
    expect(html).toContain('BLINK');
    // inject_enabled: fr.button's gestures
    expect(html).toContain('data-gesture="double_click"');
    // the data column: signal as a word, clock stated plainly in spans
    expect(html).toContain('fair');
    expect(html).toMatch(/in step<!-- --> with the hub, to within/);
    expect(html).toContain('±');
    // no JSON in the main view (Engineering is folded)
    expect(html).not.toMatch(/\{"|":/);
    expect(visible(html)).not.toMatch(EARTH);
  });

  it('adds Earth translations in Earth mode', () => {
    runtime.queryClient.clear();
    runtime.queryClient.setQueryData(['device_get', { device: 'desk-pad' }], DETAIL);
    h.mode = 'earth';
    const html = render(createElement(device.DevicePage));
    h.mode = 'pure';
    expect(html).toContain('-72 dBm');
    expect(html).toContain('1.5 ms');
  });
});

describe('the face mirror seam', () => {
  it('renders nothing without an fr.face instance, and its place with one', async () => {
    const face = await import('../src/pages/device/face.tsx');
    const inst = (cap: string) => ({ name: cap.slice(3), port: 1, cap, cap_id: 1, v: '', traits: null });
    expect(renderToString(createElement(face.FaceMirror, { instances: [inst('fr.led')], deviceId: 'd' }))).toBe('');
    const html = renderToString(createElement(face.FaceMirror, { instances: [inst('fr.face')], deviceId: 'd' }));
    expect(html).toContain('data-face="d"');
    expect(html).toContain('THE FACE MIRROR IS COMING');
  });
});
