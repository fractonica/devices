// Hub entry point: `node --conditions=@fractonica/source packages/hub/src/main.ts [--port 7420]`.
// Normally started by `fr hub start --detach` (spec 08 §8.2 lifecycle).

import { existsSync, fstatSync, mkdirSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { idfStatus, liveConfig, paths, pytoolsStatus, readIdfLock, rotateLog, type IdfStatus, type PytoolsStatus } from '@fractonica/host';
import { HUB_API_PORT, HUB_VERSION, PEER_LINK_PORT, REGISTRY_HASH } from '@fractonica/protocol';

import { createAppServer } from './apps/server.ts';
import { sweepAudioTempsAtStart } from './audio/ops.ts';
import { sweepJpegTempsAtStart } from './camera/ops.ts';
import { sweepCsiTempsAtStart } from './csi/ops.ts';
import { createBindings } from './bindings/index.ts';
import { guarded, installCrashHandlers, stopBackstop } from './crash.ts';
import type { HubContext, HubRunOptions } from './context.ts';
import { nextHubEpoch, nextHubRun, openDb } from './db.ts';
import { createEvents } from './events/index.ts';
import { isFixtureDevice } from './fixture/fence.ts';
import { createFixture, DEFAULT_BENCH } from './fixture/index.ts';
import { buildServer } from './http.ts';
import { JobRunner } from './jobs.ts';
import { createAdvert } from './lan/advert.ts';
import { createLnp } from './lan/lnp.ts';
import { createLatencyProbe } from './latency/probe.ts';
import { NODE_LINK_PORT, SerialFrameTap, SleepGuard } from './links/index.ts';
import { bridgeBinding, serialBridgeArg } from './links/serial-bridge.ts';
import { holdPort, runningHubPid, writePidfile } from './lock.ts';
import { createLogIngest } from './logs/ingest.ts';
import { LogStore } from './logstore.ts';
import { createOta, NODE_HTTP_PORT } from './ota/index.ts';
import { hubIdentity } from './peers/identity.ts';
import { createPeers } from './peers/index.ts';
import { installPassing } from './peers/passing.ts';
import { createPortHolders } from './ports/holders.ts';
import { createLeases } from './ports/leases.ts';
import { createPortPolicy } from './ports/policy.ts';
import { createPrompts } from './prompts.ts';
import { createRegistry, sweepIdentAtStart } from './registry/index.ts';
import { compactDb, JobRetention } from './retention.ts';
import { RingRetention } from './ring.ts';
import { createRouter } from './router/index.ts';
import { createScaleCounters } from './router/scale.ts';
import { settlePowerTests } from './power/test.ts';
import { cellTracker, stopCellTracker } from './power/tracker.ts';
import { CursorSeq } from './seq.ts';
import { SerialPortManager } from './serial.ts';
import { listenLoopbackV6 } from './web/guard.ts';
import { restoreApps } from './app-host/ops.ts';
import { createTimeThresholds } from './time/thresholds.ts';
import { createStaticSite } from './web/static.ts';
import { createWsServer } from './web/ws.ts';

const HOST = '127.0.0.1';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** What an uncaught exception still writes before the exit: set once the stores exist. */
let crashFlush: (() => void) | null = null;

/** Whether this process's stdout is hub.log (started by `fr hub start`): then the hub rotates it itself. */
function stdoutIsHubLog(): boolean {
  try {
    const out = fstatSync(1);
    const log = statSync(paths.log());
    return out.isFile() && out.ino === log.ino && out.dev === log.dev;
  } catch {
    return false;
  }
}

/**
 * `main.ts --compact` (`fr hub compact`): VACUUM hub.db and turn on incremental auto_vacuum, with no hub running.
 * Prints one JSON line (ok, data or error) and exits 0, or 3 when a hub runs.
 */
function compactMain(): void {
  const pid = runningHubPid(paths.lock());
  if (pid) {
    console.log(JSON.stringify({ ok: false, error: { code: 'LOCKED', message: `hub pid ${pid} is running: stop it first (fr hub stop)` } }));
    process.exit(3);
  }
  if (!existsSync(paths.db())) {
    console.log(JSON.stringify({ ok: true, data: { db: paths.db(), skipped: 'no database yet' } }));
    return;
  }
  const db = openDb(paths.db());
  try {
    console.log(JSON.stringify({ ok: true, data: { db: paths.db(), ...compactDb(db) } }));
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--compact')) {
    compactMain();
    return;
  }
  // First: an uncaught exception from here on is logged, the queued rows are written, and the exit is non-zero (70);
  // an unhandled rejection is logged and the hub keeps running.
  installCrashHandlers({ flush: () => crashFlush?.() });
  const port = Number(arg('--port', String(HUB_API_PORT)));
  // TCP and UDP for node links, and the node HTTP port (spec 08 §8.10). Other values only for a second
  // hub in a test setup (with FR_HOME elsewhere): `--node-host 127.0.0.1` keeps it to loopback FakeNodes,
  // and `--no-serial` leaves the USB ports, which belong to the running hub, alone.
  const nodePort = Number(arg('--node-port', String(NODE_LINK_PORT)));
  const nodeHost = arg('--node-host', '0.0.0.0');
  // The node HTTP listener (OTA images, spec 08 §8.10) binds where the node links do; a test hub passes
  // its own port (0: ephemeral), never the running hub's 7422.
  const nodeHttpPort = Number(arg('--node-http-port', String(NODE_HTTP_PORT)));
  // The hubs' link (design multi-hub-m2 §3.1) binds where the node links do, and only while this hub holds its
  // network's key. 7423 for a hub on the usual node port; a test hub (another node port) takes any free port unless
  // told one, so it never meets the running hub's.
  const peerPort = Number(arg('--peer-port', String(nodePort === NODE_LINK_PORT ? PEER_LINK_PORT : 0)));
  // `--serial-bridge 127.0.0.1:<port>` (design m2-c1-hil §5.1, tests only): the serial ports are a test's virtual
  // USB hub on loopback (packages/hub/test/virtual-usb.ts), never the Mac's; it implies leaving those alone. A
  // malformed flag (no value, `=` with nothing, not loopback) stops the start, before any port is opened.
  const serialBridge = serialBridgeArg(process.argv.slice(2));
  const useSerial = serialBridge !== null || !process.argv.includes('--no-serial');
  // The HIL bench (design m2-c1-hil D7): hardware/bench/<name>.bench.yaml of this checkout.
  const benchName = arg('--bench', process.env.FR_BENCH || DEFAULT_BENCH);
  // How this hub runs, for the C6 parts (design c6 §3.3); --no-advert keeps it out of mDNS.
  const runOpts: HubRunOptions = {
    apiHost: HOST,
    apiPort: port,
    nodeHost,
    nodePort,
    nodeHttpPort,
    noAdvert: process.argv.includes('--no-advert'),
    serial: useSerial,
    peerPort,
  };
  mkdirSync(paths.home(), { recursive: true });
  // Single instance: hold the API address before opening hub.db or any serial port.
  const guard = await holdPort(HOST, port);
  if (!guard) {
    const pid = runningHubPid(paths.lock());
    if (pid) {
      console.log(JSON.stringify({ event: 'already_running', pid }));
      process.exit(0);
    }
    throw new Error(`${HOST}:${port} is in use by a program that is not a Fractonica hub`);
  }
  // One hub per FR_HOME, whatever its port: two would share hub.db and fight over the USB ports.
  const sibling = runningHubPid(paths.lock());
  if (sibling) {
    console.log(JSON.stringify({ event: 'already_running', pid: sibling, home: paths.home(), message: `hub pid ${sibling} already runs from this FR_HOME on another port` }));
    process.exit(0);
  }
  const lock = writePidfile(paths.lock());
  process.on('exit', () => lock.release()); // also on a failed start and the stop backstop
  // fr_ident renders (with the Wi-Fi password) a killed hub left behind: nobody's now, before any job runs.
  const swept = sweepIdentAtStart();
  if (swept.length) {
    console.log(JSON.stringify({ event: 'ident_renders_removed', count: swept.length }));
  }
  // WAV temp files of recordings a killed hub left beside their `out` (audio-a1): nobody's now either.
  const audioTemps = sweepAudioTempsAtStart();
  if (audioTemps.length) {
    console.log(JSON.stringify({ event: 'audio_temps_removed', count: audioTemps.length }));
  }
  // .csi temp files of streams a killed hub left beside their `out` (csi-c1 D11).
  const csiTemps = sweepCsiTempsAtStart();
  if (csiTemps.length) {
    console.log(JSON.stringify({ event: 'csi_temps_removed', count: csiTemps.length }));
  }
  // Frame-file temps of jpeg streams a killed hub left (camera-c1 D10, D14).
  const jpegTemps = sweepJpegTempsAtStart();
  if (jpegTemps.length) {
    console.log(JSON.stringify({ event: 'jpeg_temps_removed', count: jpegTemps.length }));
  }

  const hubSourceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const db = openDb(paths.db());
  const run = nextHubRun(db);
  // Inside this hub's epoch slot once it has one (design multi-hub-m2 §9), so two hubs of a network never give one epoch.
  const hubEpoch = nextHubEpoch(db);
  // This hub's id is made here once per FR_HOME; its name is its host's until it is given one (fr hub name).
  const identity = hubIdentity(db);
  // One cursor space for logs and events (spec 08 §8.7).
  const seq = new CursorSeq(db);
  // Every `@fr1:` line passes the log store's frame decoder: the tap there feeds the serial node link.
  const frames = new SerialFrameTap(db);
  const logs = new LogStore(db, run, { frames, seq });
  // config.json, re-read when it changes; a section the file stops giving keeps its last good value. Its problems are
  // logged when they appear (and once more when they are gone).
  let configProblems = false;
  const hubConfig = liveConfig(paths.config(), {
    onProblems: (problems) => {
      for (const problem of problems) {
        console.error(JSON.stringify({ event: 'config_problem', message: problem }));
      }
      if (!problems.length && configProblems) {
        console.error(JSON.stringify({ event: 'config_ok', file: paths.config() }));
      }
      configProblems = problems.length > 0;
    },
  });
  hubConfig.read();
  // Which ports the hub opens (config.json ports; mode adopted unless the file says all).
  const portPolicy = createPortPolicy(db, hubConfig);
  const serial = new SerialPortManager(logs, db, { policy: portPolicy, ...(serialBridge ? { binding: bridgeBinding(serialBridge) } : {}) });
  const jobs = new JobRunner(db);
  const registry = createRegistry(db);
  const events = createEvents(db, seq, run);
  crashFlush = () => {
    for (const step of [() => events.stop(), () => logs.close(), () => db.close()]) {
      try {
        step();
      } catch {
        // the crash is what gets logged; a store that cannot be written now stays as it is
      }
    }
  };
  const eventsRing = new RingRetention(db, 'events', () => seq.head());
  // Finished jobs and their logs (config.json retention), read at each pass so an edit applies without a restart.
  // Nothing is deleted while the file has given no valid retention settings since the start.
  const jobsRetention = new JobRetention(db, () => {
    const read = hubConfig.read();
    const r = read.config.retention;
    return read.unset.includes('retention') ? null : { days: r.jobs_days, rows: r.jobs_rows };
  });
  // hub.log by size (config.json log), when it is this process's stdout.
  const rotateOwnLog = () => {
    if (stdoutIsHubLog()) {
      const { max_bytes, keep } = hubConfig.read().config.log;
      if (rotateLog(paths.log(), { maxBytes: max_bytes, keep, how: 'copytruncate' })) {
        console.log(JSON.stringify({ event: 'log_rotated', file: paths.log(), keep }));
      }
    }
  };
  const logTimer = setInterval(guarded('log.rotate', rotateOwnLog), 60_000);
  logTimer.unref();
  const sleepGuard = new SleepGuard();
  // The Mac stays awake while a node session is up or an OTA job runs (design c4 §4): an OTA's node may
  // be between sessions (REBOOTING) for up to a minute, and sleeping then strands it.
  let nodeSessions = 0;
  let otaActive = false;
  const holdAwake = () => sleepGuard.update(nodeSessions + (otaActive ? 1 : 0));
  // This process's scale counters (design m2-c2 D16): the router and the LOG ingest (D21) count into one set.
  const scale = createScaleCounters();
  const router = createRouter({
    db,
    logs,
    serial,
    seq,
    registry,
    events,
    hubEpoch,
    links: { host: nodeHost, tcpPort: nodePort, udpPort: nodePort },
    onSessions: (n) => {
      nodeSessions = n;
      holdAwake();
    },
    logIngest: createLogIngest(logs, scale),
    scale,
    // No WELCOME on a USB cable for a board another hub holds over Wi-Fi (design multi-hub-m2 §6): `hub` exists by the first HELLO.
    heldOverTcp: (id) => hub.peers?.heldOverTcp(id) ?? null,
    // A board's session ending here while another hub holds it says where it is (design multi-hub-m2 §8).
    heldByPeer: (id) => hub.peers?.holder(id)?.name ?? null,
  });
  frames.attach((device, line) => router.serialLine(device, line));
  // Node <-> node (design c5 §4): the router carries hub broadcasts; bindings resolve, push and re-push.
  // The fixture fence on resolved ends and stored rows (design m2-c1-hil D15): `hub` exists by the first call.
  const bindings = createBindings({ db, registry, router, events, isFixture: (id) => isFixtureDevice(hub, id) });
  const ota = createOta({
    db,
    router,
    registry,
    events,
    jobs,
    http: { host: nodeHost, port: nodeHttpPort },
    onActive: (active) => {
      otaActive = active;
      holdAwake();
    },
  });

  let idf: IdfStatus | null = null;
  let pytools: PytoolsStatus | null = null;
  const refreshEnv = async () => {
    try {
      // readIdfLock throws synchronously while the checkout's lock file is missing or half-written.
      idf = await idfStatus(readIdfLock(hubSourceDir));
    } catch {
      idf = null;
    }
    pytools = await pytoolsStatus().catch(() => null);
  };
  await refreshEnv();
  const envTimer = setInterval(guarded('env.refresh', refreshEnv), 60_000);

  // The C6 parts (design c6 §3.3), each from the module its stream owns; they reach the rest through `hub`.
  const ctx = () => hub;
  const hub: HubContext = {
    db,
    logs,
    serial,
    portPolicy,
    jobs,
    jobsRetention,
    startedAt: Date.now(),
    hubSourceDir,
    idf: () => idf,
    pytools: () => pytools,
    seq,
    registry,
    router,
    events,
    hubEpoch,
    ota,
    broadcast: router,
    bindings,
    run: runOpts,
    prompts: createPrompts(ctx, runOpts),
    leases: createLeases(ctx, runOpts),
    portHolders: createPortHolders(ctx, runOpts),
    lnp: createLnp(ctx, runOpts),
    advert: createAdvert(ctx, runOpts),
    appServer: createAppServer(ctx, runOpts),
    wsServer: createWsServer(ctx, runOpts),
    staticSite: createStaticSite(ctx, runOpts),
    latencyProbe: createLatencyProbe(ctx, runOpts),
    sleepGuard,
    fixture: createFixture(ctx, runOpts, { benchName }),
    peers: createPeers(ctx, runOpts),
  };
  const app = buildServer(hub, port);
  await new Promise<void>((r) => guard.close(() => r()));
  await app.listen({ host: HOST, port });
  runOpts.apiPort = (app.server.address() as AddressInfo).port; // the bound one (a test hub may ask for 0)
  // [::1] too (design c6 D9): a browser may resolve localhost to ::1 first. Not fatal when it fails.
  const v6 = await listenLoopbackV6(app);
  if (useSerial) {
    serial.start(); // only once this process owns the address
  }
  await events.start();
  // The /app bridge is the event bus's first listener and /ws its second (design c6 D7): both subscribe
  // in start(), before the router, bindings or OTA do.
  await hub.appServer.start();
  await hub.wsServer.start();
  eventsRing.start();
  jobsRetention.start();
  await router.start(); // node links (TCP/UDP :7421) once the API is up
  bindings.start(); // its router hooks and event subscriptions, once the router runs
  cellTracker(hub); // POWER-1 (design power-p1 D9): cells' samples and sessions, power.* events, once the router runs
  hub.fixture!.start(); // the HIL fixture module (design m2-c1-hil): its bus subscription, once the router runs
  await ota.start(); // the node HTTP listener (:7422) serves only nodes with a session, so after the router
  // The hubs' link (design multi-hub-m2): its listener and dialers when this hub holds its network's key, and its
  // subscription to the bus for who is where, once the router runs.
  // Step 2.2: before the link comes up, so the first call a peer sends is served (ops passed on, files, firmware).
  const stopPassing = installPassing(hub);
  await hub.peers!.start();
  // The rest of C6: prompts, the lease sweeper, the LAN self-test, the advert (of :7421, so after the
  // router), the latency probe and the dashboard's staleness check.
  for (const part of [hub.prompts, hub.leases, hub.lnp, hub.advert, hub.latencyProbe, hub.staticSite]) {
    await part.start();
  }
  // Apps (design uno-q-services): on a Linux hub with systemd, recorded apps get their units back after a reflash.
  await restoreApps(hub);
  // Fractonica time: time.threshold events as quarter boundaries pass (config.json time; stored down to the Helion).
  const thresholds = createTimeThresholds({ events, config: () => hubConfig.read().config.time });
  await thresholds.start().catch((e: unknown) => console.error(JSON.stringify({ event: 'time_thresholds_failed', message: (e as Error).message })));
  console.log(
    JSON.stringify({
      event: 'listening',
      version: HUB_VERSION,
      registry_hash: REGISTRY_HASH,
      port: runOpts.apiPort,
      // Where the dashboard is served (design c6 D10), on the bound port.
      dashboard: hub.staticSite.dashboard().url,
      // The bound ports (a test hub asks for 0); UDP shares TCP's number unless --node-port names both.
      node_port: router.ports()?.tcp ?? nodePort,
      node_udp_port: router.ports()?.udp ?? nodePort,
      node_http_port: ota.httpPort(),
      // A node HTTP port that is taken leaves the hub up; OTA over Wi-Fi fails with no_http_listener.
      ...(ota.listenError() ? { node_http_error: ota.listenError() } : {}),
      ...(useSerial ? { ports_mode: portPolicy.config().config.ports.mode } : { serial: false }),
      ...(serialBridge ? { serial_bridge: `${serialBridge.host}:${serialBridge.port}` } : {}),
      ...(v6.error ? { v6_error: v6.error } : {}),
      run,
      hub_epoch: hubEpoch,
      hub: identity,
      // The hubs' link: its bound port when this hub holds a key (a line `peer_link_listening` follows a later join).
      ...(hub.peers!.status().link.port !== null ? { peer_port: hub.peers!.status().link.port } : {}),
      pid: process.pid,
    }),
  );

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(JSON.stringify({ event: 'stopping', signal }));
    // Backstop: a close that hangs must not keep the address and the ports from the next hub. It exits 1 (and logs
    // stop_forced), so a hang is not mistaken for a clean stop.
    stopBackstop(5000);
    clearInterval(envTimer);
    clearInterval(logTimer);
    jobsRetention.stop();
    thresholds.stop();
    // Jobs still running here (`fr hub stop --force`, or a signal from elsewhere) are aborted: that
    // kills their build groups and sidecars, and lets them record "cancelled" while the db is open.
    jobs.cancelAll();
    // A capacity test switches its load off (retried) and keeps its session while the router still runs (power-p1 D10).
    await settlePowerTests(hub).catch(() => undefined);
    // C6 parts first: their sockets close (1001) before the API does, leases end (hub_stop) and reopen
    // nothing, the advert's dns-sd is killed, pending prompts are cancelled while the bus still runs.
    for (const part of [hub.appServer, hub.wsServer, hub.staticSite, hub.latencyProbe, hub.advert, hub.lnp, hub.leases, hub.prompts]) {
      await Promise.resolve(part.stop()).catch(() => undefined);
    }
    await app.close().catch(() => undefined);
    // Before the router: the peers see this hub's link close at once, not its boards leave one by one.
    stopPassing();
    await Promise.resolve(hub.peers?.stop()).catch(() => undefined);
    await Promise.resolve(ota.stop()).catch(() => undefined);
    // Before the router: it releases every driven line over the fixture's session.
    await Promise.resolve(hub.fixture?.stop()).catch(() => undefined);
    bindings.stop();
    stopCellTracker(hub);
    await Promise.resolve(router.stop()).catch(() => undefined);
    frames.attach(null);
    sleepGuard.stop();
    await serial.stop().catch(() => undefined);
    eventsRing.stop();
    await Promise.resolve(events.stop()).catch(() => undefined);
    logs.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
