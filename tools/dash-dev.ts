// A scratch hub with simulated devices, for working on the dashboard (stage 4) without a board or the lab hub.
//
//   node tools/host-test.mjs --fleet                                   # once: builds build/host-fleet/fr_fleet
//   pnpm -C packages/dashboard build                                   # or `vite build --watch` in another shell
//   node --conditions=@fractonica/source tools/dash-dev.ts [--nodes 5] [--url-file <file>] [--camera [--no-card]] [--stepper]
//
// It starts fr_fleet (tests/sim/lib/fleet.ts) with a few nodes, one of them on USB through the fleet's serial bridge
// and one spare that is provisioned but never powered (so the registry shows an offline device), and a private hub
// (tests/sim/lib/private-hub.ts): an ephemeral loopback port (never 7420), FR_HOME and TMPDIR in a fresh temp dir,
// no real serial port (--serial-bridge to the fleet's virtual USB hub) and no mDNS advert. The hub serves the
// dashboard from this checkout's packages/dashboard/dist, so a rebuild shows on reload.
//
// --camera adds cam-esp32, a fake ESP32-CAM (tools/fake-camera.ts: e32a-cam's status, flash and cam, a live view of
// a moving test pattern, a card with two recordings), provisioned like the rest, with a build manifest that gives its
// camera the ov2640 sensor and the uxga buffers. SIGUSR2 cuts the fake camera's link (it goes offline) and the next
// SIGUSR2 brings it back, for the camera page's offline state. --no-card leaves its card slot empty.
//
// --stepper adds stepper-c3, a fake stepper board (tools/fake-stepper.ts: c3s-stepper's boot, status, motor and
// buzzer, a motor that moves on a trapezoid in time, reports, ends each motion with done and backs off after a fault,
// and a buzzer that plays tones, beeps and melodies in time and ends each with done, tools/fake-buzzer.ts),
// provisioned the same way, with a build manifest that gives its motor the drv8833_stepper driver and the microstep
// trait, and its buzzer ledc_buzzer's traits. SIGUSR1 raises a driver fault on it (nFAULT fell), for the panel's fault
// line.
//
// It prints one JSON line {"url": ..., "home": ...} (and writes the URL to --url-file), then runs until SIGINT or
// SIGTERM, when it stops the fleet and the hub and removes the temp home.

import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type FleetSpec, simMac } from '@fractonica/protocol';

import { Fleet, fleetBin, fleetBinExists } from '../tests/sim/lib/fleet.ts';
import { startPrivateHub } from '../tests/sim/lib/private-hub.ts';
import { type FakeCamera, startFakeCamera } from './fake-camera.ts';
import { BUZZER_CONFIG, BUZZER_TRAITS } from './fake-buzzer.ts';
import { C3S_STEPPER_CONFIG, type FakeStepper, startFakeStepper } from './fake-stepper.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const N = Math.max(1, Math.min(12, Number(opt('nodes') ?? 5)));
const urlFile = opt('url-file');
const camera = args.includes('--camera');
const noCard = args.includes('--no-card');
const stepper = args.includes('--stepper');
/** The fake boards' MACs: outside the fleet's simMac range. */
const CAM_MAC = '02cafe000001';
const STEP_MAC = '02cafe000002';
const CAM_IMAGE = randomBytes(256);
const STEP_IMAGE = randomBytes(256);
const NET = 42;
/** Generic place names, so screenshots read like a small lab; the last one is the spare (never powered: offline). */
const NAMES = ['desk-pad', 'hall-pad', 'porch-analog', 'shelf-pad', 'bench-analog', 'door-pad', 'window-pad', 'roof-analog', 'stair-pad', 'garden-analog', 'gate-pad', 'lamp-pad'];
const alias = (k: number) => (k === N ? 'attic-pad' : NAMES[k % NAMES.length]!);
const profile = (a: string) => (a.endsWith('analog') ? ('c3o-analog' as const) : ('c6-pad' as const));
const USB = [1];

if (!fleetBinExists()) {
  console.error(`no fleet binary at ${fleetBin()}: run \`node tools/host-test.mjs --fleet\` first`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'fr-dash-dev-'));
const spec: FleetSpec = {
  schema: 'fractonica/fleet-spec@1',
  seed: 11,
  pace: 1,
  verbosity: 0,
  state_dir: join(dir, 'state'),
  medium: {
    topology: 'one_room',
    rssi_dbm: [-85, -45],
    asymmetry_db: 3,
    rssi_sigma_db: 2,
    loss: [0.001, 0.015],
    dup: 0,
    latency_us: [50, 200],
    rate: { broadcast: '1M', unicast: '1M' },
    collisions: true,
    capture_db: 10,
  },
  ap: { channel: 6, rssi_dbm: [-75, -45], uplink_ms: [0.5, 3], downlink_ms: [0.5, 3], udp_loss: 0, gaps: null, phy_rate: 24, http_kbps: 0, assoc_ms: [200, 500] },
  nodes: Array.from({ length: N + 1 }, (_, k) => ({
    alias: alias(k),
    mac: simMac(k + 1),
    addr: k + 1,
    net: NET,
    epoch: 1,
    alias_rev: 1,
    rng_seed: 2000 + k,
    hb_ms: 1000,
    health_ms: 60_000,
    usb: USB.includes(k),
    udp: 'shared' as const,
    ota: true,
    radio: { channel: 6, bcast_rate: '1M' as const, ucast_rate: '1M' as const },
    profile: profile(alias(k)),
    spare: k === N,
  })),
};

/** The fake boards, each with a debug image (its test commands shown) registered before the hub starts. */
const fakes = [
  ...(camera ? [{ mac: CAM_MAC, alias: 'cam-esp32', profile: 'e32a-cam', board: 'aithinker-esp32-cam', chip: 'esp32', image: CAM_IMAGE }] : []),
  ...(stepper ? [{ mac: STEP_MAC, alias: 'stepper-c3', profile: 'c3s-stepper', board: 'esp32c3-supermini', chip: 'esp32c3', image: STEP_IMAGE }] : []),
];

const fleet = await Fleet.spawn(spec, { specPath: join(dir, 'fleet-spec.json') });
const hub = await startPrivateHub({
  devices: [
    ...spec.nodes.map((n) => ({ mac: n.mac, alias: n.alias, net: NET, profile: n.profile })),
    ...fakes.map((f) => ({ mac: f.mac, alias: f.alias, net: NET, profile: f.profile, board: f.board, chip: f.chip })),
  ],
  images: fakes.map((f) => ({ image: f.image, raw: true, profile: f.profile, buildType: 'debug' as const, manifest: { board: f.board, target: f.chip } })),
  serialBridge: fleet.bridge,
});
await fleet.startNodes({ tcp: hub.node.tcp, udp: hub.node.udp, http: hub.node.http });

type ManifestCap = { name: string; port: number; cap: string; cap_id: number; version: string; driver: string; config: Record<string, unknown>; traits: Record<string, unknown> };

/** The registered image's manifest of `profile` (builds/<build_id>/manifest.json under the temp home), given these caps and traits. */
function giveManifestCaps(home: string, profile: string, caps: ManifestCap[]): void {
  const find = (dir: string): string | null => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        const f = find(p);
        if (f) {
          return f;
        }
      } else if (name === 'manifest.json' && p.includes(`/${profile}/`)) {
        return p;
      }
    }
    return null;
  };
  const file = find(home);
  if (!file) {
    return;
  }
  const m = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  m.caps = caps;
  writeFileSync(file, JSON.stringify(m, null, 2));
}
const led = (name: string, port: number): ManifestCap => ({ name, port, cap: 'fr.led', cap_id: 2, version: '1.0', driver: 'led_gpio', config: {}, traits: { color: 'mono', dimmable: false } });

/** A fake board's identity as provisioned: its registry row and its image's fw_id prefix. */
function identity(mac: string) {
  const row = hub.rows.get(mac)!;
  const image = hub.images[fakes.findIndex((f) => f.mac === mac)]!;
  return { mac, addr: row.addr, net: row.net, alias: row.alias, aliasRev: row.alias_rev, epoch: row.epoch_floor + 1, fwPrefix: image.fw_id.slice(0, 16) };
}

let cam: FakeCamera | null = null;
let motor: FakeStepper | null = null;
try {
  if (camera) {
    giveManifestCaps(hub.home, 'e32a-cam', [
      led('status', 1),
      led('flash', 2),
      { name: 'cam', port: 3, cap: 'fr.camera', cap_id: 11, version: '1.0', driver: 'dvp_camera', config: {}, traits: { sensor: 1, max_frame_size: 'uxga' } },
    ]);
    cam = await startFakeCamera({ ...identity(CAM_MAC), hub: hub.node, card: !noCard });
  }
  if (stepper) {
    giveManifestCaps(hub.home, 'c3s-stepper', [
      { name: 'boot', port: 1, cap: 'fr.button', cap_id: 1, version: '1.0', driver: 'button_gpio', config: {}, traits: { long_press: true, multi_press_max: 2 } },
      led('status', 2),
      { name: 'motor', port: 3, cap: 'fr.stepper', cap_id: 0x12, version: '1.0', driver: 'drv8833_stepper', config: C3S_STEPPER_CONFIG, traits: { microstep: true } },
      { name: 'buzzer', port: 4, cap: 'fr.buzzer', cap_id: 0x13, version: '1.0', driver: 'ledc_buzzer', config: { ...BUZZER_CONFIG }, traits: { ...BUZZER_TRAITS } },
    ]);
    motor = await startFakeStepper({ ...identity(STEP_MAC), hub: hub.node });
  }
} catch (e) {
  await cam?.stop().catch(() => {});
  await fleet.quit().catch(() => {});
  await hub.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
  throw e;
}
if (urlFile) {
  writeFileSync(urlFile, `${hub.url}\n`);
}
console.log(JSON.stringify({ url: hub.url, home: hub.home, nodes: N, spare: alias(N), ...(camera ? { camera: 'cam-esp32' } : {}), ...(stepper ? { stepper: 'stepper-c3' } : {}) }));

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  await cam?.stop().catch(() => {});
  await motor?.stop().catch(() => {});
  await fleet.quit().catch(() => {});
  await hub.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
let camAway = false;
process.on('SIGUSR2', () => {
  if (!cam) {
    return;
  }
  camAway = !camAway;
  if (camAway) {
    cam.node.close();
  } else {
    void cam.node.connect(10_000).catch(() => {});
  }
});
process.on('SIGUSR1', () => motor?.fault());
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
