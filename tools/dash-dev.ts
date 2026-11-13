// A scratch hub with simulated devices, for working on the dashboard (stage 4) without a board or the lab hub.
//
//   node tools/host-test.mjs --fleet                                   # once: builds build/host-fleet/fr_fleet
//   pnpm -C packages/dashboard build                                   # or `vite build --watch` in another shell
//   node --conditions=@fractonica/source tools/dash-dev.ts [--nodes 5] [--url-file <file>]
//
// It starts fr_fleet (tests/sim/lib/fleet.ts) with a few nodes, one of them on USB through the fleet's serial bridge
// and one spare that is provisioned but never powered (so the registry shows an offline device), and a private hub
// (tests/sim/lib/private-hub.ts): an ephemeral loopback port (never 7420), FR_HOME and TMPDIR in a fresh temp dir,
// no real serial port (--serial-bridge to the fleet's virtual USB hub) and no mDNS advert. The hub serves the
// dashboard from this checkout's packages/dashboard/dist, so a rebuild shows on reload.
//
// It prints one JSON line {"url": ..., "home": ...} (and writes the URL to --url-file), then runs until SIGINT or
// SIGTERM, when it stops the fleet and the hub and removes the temp home.

import { writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type FleetSpec, simMac } from '@fractonica/protocol';

import { Fleet, fleetBin, fleetBinExists } from '../tests/sim/lib/fleet.ts';
import { startPrivateHub } from '../tests/sim/lib/private-hub.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const N = Math.max(1, Math.min(12, Number(opt('nodes') ?? 5)));
const urlFile = opt('url-file');
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
  devices: spec.nodes.map((n) => ({ mac: n.mac, alias: n.alias, net: NET, profile: n.profile })),
  serialBridge: fleet.bridge,
});
await fleet.startNodes({ tcp: hub.node.tcp, udp: hub.node.udp, http: hub.node.http });
if (urlFile) {
  writeFileSync(urlFile, `${hub.url}\n`);
}
console.log(JSON.stringify({ url: hub.url, home: hub.home, nodes: N, spare: alias(N) }));

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  await fleet.quit().catch(() => {});
  await hub.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
