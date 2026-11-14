// The fr.camera panel rendered to strings (DEVICE-SPEC §3, §6.10), with the runtime's QueryClient seeded with a
// camera_status: one primary action (WATCH), no stream_id anywhere, the Record form's CARD choices disabled without a
// card, and nothing Earth in pure mode while Earth mode adds ⊕. HubRuns (§3.10) links the camera's commands to its
// page and gives fr.csi's a copyable fr line.

import { QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { CATALOG } from '@fractonica/protocol/gen';
import { loadCore } from '@fractonica/time';

const h = vi.hoisted(() => ({ core: null as unknown, mode: 'pure' as 'pure' | 'earth' }));

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
    Link: ({ children, params, to, className, search }: { children?: ReactNode; params?: Record<string, string>; to: string; className?: string; search?: Record<string, string> }) =>
      react.createElement(
        'a',
        { href: `#${to.replace('$id', params?.id ?? '').replace('$instance', params?.instance ?? '')}${search ? `?${new URLSearchParams(search).toString()}` : ''}`, className, 'data-variant': 'quiet' },
        children,
      ),
    useParams: () => ({ id: 'cam-esp32' }),
    useNavigate: () => () => {},
    useSearch: () => ({}),
  };
});
vi.mock('../src/pages/device/panels/camera/camera.css', () => ({}));

type Runtime = typeof import('../src/runtime.ts');
let runtime: Runtime;
let camera: typeof import('../src/pages/device/panels/camera/index.tsx');
let record: typeof import('../src/pages/device/panels/camera/record.tsx');
let hubRuns: typeof import('../src/pages/device/panels/hub-runs.tsx');

beforeAll(async () => {
  (globalThis as { location?: unknown }).location ??= { protocol: 'http:', host: '127.0.0.1:7420', search: '' };
  (globalThis as { __FRACTONICA__?: unknown }).__FRACTONICA__ = { token: 'tok-for-tests' };
  h.core = await loadCore();
  runtime = await import('../src/runtime.ts');
  camera = await import('../src/pages/device/panels/camera/index.tsx');
  record = await import('../src/pages/device/panels/camera/record.tsx');
  hubRuns = await import('../src/pages/device/panels/hub-runs.tsx');
});

const EARTH = /⊕|\d{1,2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T|\b\d+\s?(h|min|s|ms|Hz|mV|dBm|MB|KB)\b|%/;
const visible = (html: string) => html.replace(/ style="[^"]*"/g, '');

const DEV = 'a0b1c2d3e4f5';
const INSTANCES = [
  { name: 'status', port: 1, cap: 'fr.led', cap_id: 2, v: '1.0', traits: null },
  { name: 'flash', port: 2, cap: 'fr.led', cap_id: 2, v: '1.0', traits: null },
  { name: 'cam', port: 3, cap: 'fr.camera', cap_id: 11, v: '1.0', traits: null },
];
const DETAIL = {
  device_id: DEV,
  addr: 0x43,
  alias: 'cam-esp32',
  alias_rev: 1,
  net: 1,
  board: 'aithinker-esp32-cam',
  profile: 'e32a-cam',
  chip: 'esp32',
  tags: [],
  role: 'node',
  fw_id: '3f2a9c01b2d40011',
  provisioned: true,
  last_seen: '2026-11-13T18:13:05.849Z',
  last_epoch: 1,
  created_at: '2026-11-13T18:13:04.942Z',
  presence: 'online',
  provision: null,
  router: { presence: 'online', hello_caps: 115, properties: {}, instances: INSTANCES.map(({ name, port, cap, cap_id }) => ({ name, port, cap, cap_id })) },
};

function status(over: Record<string, unknown> = {}) {
  return { device: DEV, alias: 'cam-esp32', instance: 'cam', frames: 1204, fps_x10: 97, last_bytes: 38_400, streaming: false, sd: 'mounted', sd_free_mb: 3712, sensor: 'ov2640', max_frame_size: 'uxga', stream: null, ...over };
}

function props(presence = 'online') {
  const cap = CATALOG.capabilities.find((c) => c.name === 'fr.camera')!;
  return {
    detail: { ...DETAIL, presence } as never,
    inst: INSTANCES[2]!,
    cap,
    members: { properties: [...cap.properties], commands: [...cap.commands], events: [...cap.events] },
    mirror: { frames: 1204, fps_x10: 0, last_bytes: 38_400, streaming: false, sd: 'mounted', sd_free_mb: 3712 },
    instances: INSTANCES,
  };
}

function render(el: ReturnType<typeof createElement>) {
  return renderToString(createElement(QueryClientProvider, { client: runtime.queryClient }, el));
}

function seed(s: Record<string, unknown>) {
  runtime.queryClient.clear();
  runtime.queryClient.setQueryData(['camera_status', { device: `id:${DEV}`, instance: 'cam' }], s);
}

describe('the camera Lens', () => {
  it('has one primary action, WATCH; PHOTO, RECORD…, the flash toggle; Now in words; no stream_id; pure has nothing Earth', () => {
    vi.stubGlobal('fetch', vi.fn());
    seed(status());
    h.mode = 'pure';
    const html = render(createElement(camera.CAMERA_PANEL.Lens, props()));
    vi.unstubAllGlobals();
    expect(html.match(/data-variant="primary"/g)).toHaveLength(1);
    expect(html).toMatch(/data-action="watch"[^>]*data-variant="primary"/);
    expect(html).toContain('>WATCH<');
    expect(html).toContain('>PHOTO<');
    expect(html).toContain('>RECORD…<');
    expect(html).toContain('WITH THE FLASH');
    expect(html).toContain('Shows the camera live here. It stops when you leave this page.');
    expect(html).toContain('data-camera-state="idle"');
    expect(html).toContain('aria-label="live view of cam"');
    expect(html).toContain('Nothing shown yet. WATCH starts the camera.');
    expect(html).toContain('ov2640 · up to uxga');
    expect(html).toMatch(/in · room for about 97.000 frames/);
    expect(html).toMatch(/38.400 B/);
    expect(html).not.toMatch(/stream_id|stream id|>Send</i);
    expect(html).toContain('SENSOR SETTINGS');
    expect(html).toContain('CARD RECORDINGS');
    expect(visible(html)).not.toMatch(EARTH);
  });

  it('Earth mode adds ⊕ translations', () => {
    seed(status());
    h.mode = 'earth';
    const html = render(createElement(camera.CAMERA_PANEL.Lens, props()));
    h.mode = 'pure';
    expect(html).toContain('⊕');
    expect(html).toMatch(/3.712 MB free/);
    expect(html).toMatch(/37\.5 KB/);
  });

  it('says offline and disables everything while the board is away', () => {
    seed(status({ sd: null, sd_free_mb: null }));
    const html = render(createElement(camera.CAMERA_PANEL.Lens, props('offline')));
    expect(html).toContain('data-camera-state="offline"');
    expect(html).toContain('cam-esp32 is offline. The camera shows nothing until the board is back on the network.');
    expect(html).toMatch(/data-action="watch"[^>]*disabled=""[^>]*data-variant="primary"/);
    expect(html).toMatch(/data-action="photo"[^>]*disabled=""/);
    expect(html).toMatch(/data-action="record"[^>]*disabled=""/);
  });

  it('a recording to the card someone else runs: STATE says so, RECORD… waits', () => {
    seed(status({ streaming: true, stream: { stream_id: 941, to: 'sd', started_at: '2026-11-14T00:00:00.000Z', seconds: 0, interval_ms: 0, frames: 12, dropped: 0, bytes: 1, subscribers: 0, gaps: 0, job_id: 'j1' } }));
    const html = render(createElement(camera.CAMERA_PANEL.Lens, props()));
    expect(html).toContain('data-camera-state="recording"');
    expect(html).toContain('recording to the card');
    expect(html).toContain('Recording to the card. Frames stay on the card until you play them.');
    expect(html).toMatch(/data-action="record"[^>]*disabled=""/);
    expect(html).toContain('a stream runs; stop it first');
    expect(html).not.toContain('STOP RECORDING'); // not this page's recording: HubRuns and Engineering stop it
    expect(visible(html)).not.toMatch(EARTH);
  });

  it('the Record form: CARD and HUB AND CARD disabled with no card, the lengths as spans, START RECORDING says what it does', () => {
    const el = createElement(record.RecordForm, { cardIn: false, maxFrameSize: 'svga', busy: false, disabled: false, onStart: () => {}, onCancel: () => {} });
    const html = render(el);
    expect(html).toMatch(/<button[^>]*aria-checked="false"[^>]*disabled=""[^>]*title="no card in the board"[^>]*><span class="ui-chip-word">CARD</);
    expect(html).toMatch(/disabled=""[^>]*><span class="ui-chip-word">HUB AND CARD</);
    expect(html).toMatch(/aria-checked="true"[^>]*><span class="ui-chip-word">HUB</);
    expect(html).toContain('until stopped');
    expect(html).toContain('>START RECORDING<');
    expect(html).toMatch(/Records to the hub for [^<]*ν[^<]*, as fast as it can, and shows it here\./);
    expect(html).not.toMatch(/stream_id/);
    expect(visible(html)).not.toMatch(EARTH);
    const withCard = render(createElement(record.RecordForm, { cardIn: true, maxFrameSize: 'svga', busy: false, disabled: false, onStart: () => {}, onCancel: () => {} }));
    expect(withCard).not.toMatch(/disabled=""[^>]*><span class="ui-chip-word">CARD</);
  });

  it('the Overview row: a headline in words, a quiet WATCH link with ?watch=1', () => {
    seed(status());
    const head = render(createElement(camera.CAMERA_PANEL.Headline, props()));
    expect(head).toContain('idle · card in');
    const quick = render(createElement(camera.CAMERA_PANEL.Quick!, props()));
    expect(quick).toContain('href="#/devices/cam-esp32/cam?watch=1"');
    expect(quick).toContain('data-variant="quiet"');
    expect(quick).not.toContain('primary');
    seed(status({ stream: { stream_id: 9, to: 'sd', started_at: null, seconds: 0, interval_ms: 0, frames: 0, dropped: 0, bytes: 0, subscribers: 0, gaps: 0 } }));
    expect(render(createElement(camera.CAMERA_PANEL.Headline, props()))).toContain('recording to the card');
    expect(camera.CAMERA_PANEL.covers).toEqual(expect.arrayContaining(['stream_start', 'stream_stop', 'sd_fetch']));
  });
});

describe('HubRuns', () => {
  it('points the camera’s stream commands at its page; gives fr.csi a copyable fr line; never a form', () => {
    runtime.queryClient.clear();
    const cam = CATALOG.capabilities.find((c) => c.name === 'fr.camera')!;
    const html = render(createElement(hubRuns.HubRuns, { detail: DETAIL as never, inst: INSTANCES[2]!, cmd: cam.commands.find((c) => c.name === 'stream_start')! }));
    expect(html).toContain('the hub runs this: Watch, Record and Play on the camera’s page do this');
    expect(html).toContain('href="#/devices/cam-esp32/cam"');
    expect(html).not.toMatch(/<input|<textarea|<select/);
    const csi = CATALOG.capabilities.find((c) => c.name === 'fr.csi')!;
    const c = render(createElement(hubRuns.HubRuns, { detail: DETAIL as never, inst: { name: 'csi', port: 3, cap: 'fr.csi', cap_id: 9, v: '1.0', traits: null }, cmd: csi.commands.find((x) => x.name === 'stream_start')! }));
    expect(c).toContain('fr csi stream cam-esp32 --instance csi --seconds 60');
    expect(c).toContain('COPY');
    expect(c).not.toMatch(/<input|<textarea|<select/);
  });

  it('offers STOP STREAM for the camera’s running stream, never a typed id', () => {
    seed(status({ stream: { stream_id: 941, to: 'hub', started_at: null, seconds: 0, interval_ms: 0, frames: 0, dropped: 0, bytes: 0, subscribers: 1, gaps: 0, job_id: 'j7' } }));
    const cam = CATALOG.capabilities.find((c) => c.name === 'fr.camera')!;
    const html = render(createElement(hubRuns.HubRuns, { detail: DETAIL as never, inst: INSTANCES[2]!, cmd: cam.commands.find((c) => c.name === 'stream_stop')! }));
    expect(html).toContain('STOP STREAM 941');
    expect(html).not.toMatch(/<input/);
  });
});
