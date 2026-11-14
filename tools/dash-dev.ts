// A scratch hub with simulated devices, for working on the dashboard (stage 4) without a board or the lab hub.
//
//   node tools/host-test.mjs --fleet                                   # once: builds build/host-fleet/fr_fleet
//   pnpm -C packages/dashboard build                                   # or `vite build --watch` in another shell
//   node --conditions=@fractonica/source tools/dash-dev.ts [--nodes 5] [--url-file <file>] [--camera [--no-card]]
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

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const N = Math.max(1, Math.min(12, Number(opt('nodes') ?? 5)));
const urlFile = opt('url-file');
const camera = args.includes('--camera');
const noCard = args.includes('--no-card');
/** The fake camera's MAC: outside the fleet's simMac range. */
const CAM_MAC = '02cafe000001';
const CAM_IMAGE = randomBytes(256);
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

const fleet = await Fleet.spawn(spec, { specPath: join(dir, 'fleet-spec.json') });
const hub = await startPrivateHub({
  devices: [
    ...spec.nodes.map((n) => ({ mac: n.mac, alias: n.alias, net: NET, profile: n.profile })),
    ...(camera ? [{ mac: CAM_MAC, alias: 'cam-esp32', net: NET, profile: 'e32a-cam', board: 'aithinker-esp32-cam', chip: 'esp32' }] : []),
  ],
  ...(camera ? { images: [{ image: CAM_IMAGE, raw: true, profile: 'e32a-cam', buildType: 'debug' as const, manifest: { board: 'aithinker-esp32-cam', target: 'esp32' } }] } : {}),
  serialBridge: fleet.bridge,
});
await fleet.startNodes({ tcp: hub.node.tcp, udp: hub.node.udp, http: hub.node.http });

/** The registered image's manifest (builds/<build_id>/manifest.json under the temp home), given e32a-cam's caps and traits. */
function giveManifestCaps(home: string): void {
  const find = (dir: string): string | null => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        const f = find(p);
        if (f) {
          return f;
        }
      } else if (name === 'manifest.json' && p.includes('e32a-cam')) {
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
  const led = (name: string, port: number) => ({ name, port, cap: 'fr.led', cap_id: 2, version: '1.0', driver: 'led_gpio', config: {}, traits: { color: 'mono', dimmable: false } });
  m.caps = [
    led('status', 1),
    led('flash', 2),
    { name: 'cam', port: 3, cap: 'fr.camera', cap_id: 11, version: '1.0', driver: 'dvp_camera', config: {}, traits: { sensor: 1, max_frame_size: 'uxga' } },
  ];
  writeFileSync(file, JSON.stringify(m, null, 2));
}

let cam: FakeCamera | null = null;
if (camera) {
  giveManifestCaps(hub.home);
  const row = hub.rows.get(CAM_MAC)!;
  try {
    cam = await startFakeCamera({
      mac: CAM_MAC,
      addr: row.addr,
      net: row.net,
      alias: row.alias,
      aliasRev: row.alias_rev,
      epoch: row.epoch_floor + 1,
      fwPrefix: hub.images[0]!.fw_id.slice(0, 16),
      hub: hub.node,
      card: !noCard,
    });
  } catch (e) {
    await fleet.quit().catch(() => {});
    await hub.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}
if (urlFile) {
  writeFileSync(urlFile, `${hub.url}\n`);
}
console.log(JSON.stringify({ url: hub.url, home: hub.home, nodes: N, spare: alias(N), ...(camera ? { camera: 'cam-esp32' } : {}) }));

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  await cam?.stop().catch(() => {});
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
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
