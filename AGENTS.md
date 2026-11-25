# AGENTS.md — working in the Fractonica devices repository

The guide for a coding agent (or engineer) changing this repository. Two projects live here:

- **The device framework**, at the root: node firmware (ESP-IDF v6.1), hardware library, schema and codegen, the
  hub, the `fr` CLI and MCP tools, the SDK, the dashboard, the plugin. This file covers it.
- **The clock firmware**, in `clock/`: a standalone ESP-IDF 5.5 project with a host simulator. Read
  [clock/AGENTS.md](clock/AGENTS.md) before touching anything under `clock/`. It is to be folded into the
  framework in stage 5 of the merge plan (`HARDWARE-REVIEW.md` in the owner's workspace, not published).

To *drive* devices (devices, ports, build, flash, OTA, logs, tests) through `fr` or MCP rather than change the code,
read [plugin/AGENTS.md](plugin/AGENTS.md).

## 1. Rules

1. **Never flash, open a serial port or start a hub on port 7420 without the owner's go-ahead.** A running hub
   holds the ports of the boards in its registry with an exclusive lock (config.json `ports.mode` `adopted`; `all`
   takes every ESP32 and USB-UART port), so `idf.py flash` on such a port fails while it runs, and starting a hub can
   take a board from the owner. Tests start private hubs on random ports with their own `FR_HOME` and fake or virtual
   ports; keep it that way. To lend a port: `fr serial lease <dev> -- <cmd> '$FR_PORT'` (single quotes) or
   `fr serial idf <dev> flash monitor`; `fr ports` shows who holds what.
2. **The schema is the source of truth.** Change `schema/` (or `hardware/`, `firmware/profiles/`), then run
   `pnpm fr gen`; never edit the generated directories by hand (`packages/protocol/src/gen`, `packages/sdk/src/gen`,
   `schema/vectors`, `firmware/components/fr_proto/gen`, `firmware/components/fr_caps/gen`,
   `firmware/test/host/gen`). `pnpm fr gen --check` must report 0 stale.
3. **No personal data in commits**: no hostnames, home paths, device MACs, Wi-Fi names or passwords. The HIL bench as
   wired (`hardware/bench/lab.bench.yaml`) is git-ignored; `hardware/bench/bench.example.yaml` is the committed
   example with placeholder ids. Wi-Fi passwords never go on a command line (`fr net set --password-stdin`).
4. **Never edit the sibling repositories** (`../core`, `../web`, `../ios`) or the owner's workspace files
   (`../design`, `../reference`, `../SPEC.md`).
5. The temporal core (`../core`) owns every Fractonica number, name and text. The framework must not re-implement
   clock arithmetic (see the clock's rules in `clock/AGENTS.md`). In TypeScript it is `packages/time`: the web
   repository's `fractonica.wasm` and binding, vendored byte for byte and pinned by `packages/time/time.lock`. Never
   edit the vendored files; to take a newer core, update `../web` and run `pnpm fr gen` (it copies them and rewrites
   the lock; `fr gen --check` reports drift).
6. Do not push. Changes to `.github/workflows/*` need the owner to push them (the local token lacks that scope).
7. Security scope: a LAN lab, unauthenticated (README "Security"). Do not describe it as more.
8. **Every op declares where it runs among several hubs** (`target` in its definition, `packages/protocol/src/ops`;
   design multi-hub-m2 §7.1, §15): `device` (it runs at the hub that holds the board; name the board fields with
   `boards` when they are not `device`), `selector` (with `across`: `split`, `one`, `live` or `here`), `fleet`, `port`
   or `hub`. An op that takes a `since` cursor runs at the hub the cursor is from (§17): add it to `SINCE_OPS` in
   `peers/passing.ts`, and read the cursor only through `sinceSeqOf` (`events/index.ts`). An op with a path field says so in `files` (`out`: written where the op runs and pulled to the calling
   hub; `in`: fetched from it). Add the op to the list of its target in `packages/protocol/test/protocol-targets.test.ts`.
   An op reaches a hub through one point, `POST /api/v1/op/<name>` (`packages/hub/src/http.ts`), which asks
   `peers/passing.ts` where it runs: do not call a handler past it for a client. Do not change an existing op's input
   to add a feature: `REGISTRY_INPUTS_HASH` and the protocol tests' checkpoints pin them.

9. **The registry is one across the hubs of a network** (design multi-hub-m2 §5, §16; `packages/hub/src/registry/sync.ts`).
   A write to `devices` replicates by itself: nothing has to call anything, the scan finds it. A new column of
   `devices` is this hub's own until it is added to one of the parts in `sync.ts` (and then to its wire row and its
   tests); never add one that holds a secret or something about this machine (a port, a path). An address is only
   ever allocated by the registrar (`registry/alloc.ts`): do not call `prepareIdentity` for a board without one
   before `ensureAddress`. Do not move `REGISTRY_HASH` for a change that only replicates: the `registry` message has
   its own version (`REGISTRY_WIRE`).

10. **The bus carries the whole network, for those who ask** (design multi-hub-m2 §8, §17; `packages/hub/src/peers/events.ts`).
   `hub.events.subscribe(fn)` gets this hub's own events, and is what any part that acts on this hub's sessions uses
   (the router, bindings, OTA, a job). Only what shows a client the fleet subscribes with `subscribeFleet` and reads
   with `relayed: true` (`/ws`, `/app`, the waits, `events_read`): it also gets what the other hubs relay, marked
   `hub`. A new event type crosses when it has a `device`; one without a device, or one each hub makes for itself,
   needs a line in `crosses` and in §17.1's table. Never put a secret or a path of this machine into an event: every
   hub of the network and every `/ws` client reads it. Do not move `REGISTRY_HASH` for a change to the `event`
   message or the stream channel: each has its own version in the hello (`EVENTS_WIRE`, `STREAMS_WIRE`).

## 2. Setup

Node 24.12 or later, pnpm 11, uv (Python 3.12 for the esptool sidecar), and for firmware ESP-IDF v6.1 at the commit
in `firmware/idf-version.lock` (`~/esp/v6.1/esp-idf`).

```sh
pnpm install
pnpm fr doctor --fix     # host checks; writes the fr shim to ~/.local/bin, builds the dashboard
```

Everything TypeScript runs from source (`node --conditions=@fractonica/source`); the `dist/` exports are not built.
`packages/cli/bin/fr.mjs` starts the CLI that way; `pnpm fr` and the shim run it. A fresh Mac's steps are in
[docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).
`source ~/esp/v6.1/esp-idf/export.sh` fails when Python 3.10 is first on PATH: `fr` captures its own IDF
environment (`packages/host/src/idf.ts`), or put the uv Python 3.12 first on PATH before sourcing it.

## 3. Checks (run before saying something works)

```sh
pnpm typecheck                         # tsc: root, packages/dashboard
pnpm test                              # vitest (no boards needed); under load run one area at a time:
pnpm vitest run packages/hub           #   packages/{protocol,codegen,sdk,host,hub,cli,dashboard,time}
node tools/host-test.mjs               # host C++ suite (ASan + UBSan); builds build/host-tests/fr_net_node,
                                       #   which the hub's interop tests use
pnpm fr gen --check                    # generated files: 0 stale
```

A firmware build of one profile without a hub:

```sh
pnpm fr gen firmware --profile c6w-scale --out <gen>
idf.py -C firmware/apps/node -B <build> -DFR_GEN_DIR=<gen> -DIDF_TARGET=esp32c6 -DSDKCONFIG=<build>/sdkconfig \
  "-DSDKCONFIG_DEFAULTS=$PWD/firmware/config/sdkconfig.framework;$PWD/firmware/apps/node/sdkconfig.defaults;<gen>/sdkconfig.board;$PWD/firmware/config/sdkconfig.build.debug" build
```

(`fr build --profile <p>` does the same through a hub.) The e2e and HIL gates in `tests/e2e` need boards and a
person or the HIL fixture: run them only when asked.

The clock: `cd clock/sim && make test`, and its own ESP-IDF 5.5 builds (`clock/AGENTS.md`).

The dashboard (`packages/dashboard`, stage 4) is drawn in the site's Astrolabe language:

- **The token rule.** Colours only from the site's token table, `src/design/tokens.js` (vendored byte for byte and
  locked by `tokens.lock`, like the core; `fr gen` refreshes it) plus the hub's one extension, the `fault` colour, in
  `src/design/hub-tokens.ts`: `var(--c-*)` in CSS, never a hex, `rgb()` or colour name. Dark only, no bold, nothing
  that pulses or blinks, no bars or percentages. Two faces: `--font-reading` (ids, paths and firmware too, with
  tabular figures: the `.mono` class) and `--font-caps`; the monospace stack only for what a person copies (`<Code>`,
  `<code>`) and the log terminal. `test/design-rules.test.ts` fails on any of it.
- **Pure mode** shows only Fractonica units (no clock time, date, zone, Hz, metre or per cent, also in `aria-label`);
  Earth mode keeps the Fractonica value and adds the Earth one after ⊕. Any text the dashboard did not write (the hub's,
  a device's, the catalogue's, a guide's, a toast's) goes through `useHubText()` (`src/state/pure-text.ts`: `pureText`
  in pure mode, whose output always passes `pureSafe`; `earthText` in Earth mode); the Bench's through
  `pages/bench/said.tsx` (`useHeldText()`: `heldText` puts ⊕ where it holds a value back, never dropping a clause
  someone wires from). A relative time under one Blink is a word ("just now"), never a counting fraction
  (`src/time/wake.ts`).
- **The live link.** `src/shell/link.ts` says when `/ws` has been down a moment or the hub does not answer its status:
  the notices say so, presence reads as not known and `useAct` refuses at once. REST calls time out after 10 s
  (`runtime.ts`), except the long ops (`hooks.ts` LONG_OPS).
- **Layout.** `src/ui`: the primitives (Page, Section, Row, Bead, Button, StageRing, ErrorLine, Pending, FTime, Span,
  …; their README). `src/pages/<page>.tsx` and `<page>.css` (classes prefixed with the page's name), the page's parts
  in `src/pages/<page>/`, components two pages share in `src/pages/shared/` (a port's actions, the network form).
  `src/state/*`: pure logic, tested in node (`words.ts` is the one vocabulary for states, `checks.ts` the doctor
  checks, `ports.ts` the ports). `src/api`, `runtime.ts`, `hooks.ts`: the tested plumbing (reconnect, resume, jobs).
  `src/app.tsx`: the routes (hash history; old paths redirect).
- **The device page** is four sub-pages in one frame (`pages/device/frame.tsx`: INSTRUMENTS · ACTIVITY · FACTS ·
  ENGINEERING) plus one page per instrument (`page-lens.tsx`, `/devices/$id/$instance`). An instrument is drawn by its
  capability's panel from the registry `pages/device/panels.ts` (`Lens`, `Headline`, `Quick?`, `covers?`):
  `panels/camera/*`, `panels/led.tsx`, `panels/display.tsx` (an e-paper panel adds `pages/device/epaper.tsx` with `state/epaper.ts`), `panels/stepper.tsx`, `panels/buzzer.tsx`, `panels/haptic.tsx` (with `state/haptic.ts`), else `panels/generic.tsx`. A new purpose-built panel goes
  there; `CapPanelProps` is built only by `usePanelProps`. Words and units of a capability's members live in
  `state/cap-words.ts` (a test fails on a `_x10`/`_ms`/`_mb`/… member it does not cover); a command whose field only the
  hub can issue (`state/hub-issued.ts`) is never a form, it renders `HubRuns`. No button under `pages/device` says
  "Send". The camera panel reads the `/app` token the hub injects into the dashboard's index (`api/app-token.ts`) and
  streams through `api/stream.ts` (only `@fractonica/sdk/wire` and `/camera` are bundled).

To see it with simulated devices and never a board or the lab hub:

```sh
node tools/host-test.mjs --fleet                                    # once: build/host-fleet/fr_fleet
pnpm -C packages/dashboard build                                    # after each change (or `watch`)
node --conditions=@fractonica/source tools/dash-dev.ts --url-file /tmp/hub.url   # a scratch hub + fleet; Ctrl-C ends it
#   add --camera for a fake ESP32-CAM (cam-esp32: live frames, a card; --no-card empties the slot; SIGUSR2 takes it offline and back)
#   add --stepper for a fake stepper board (stepper-c3: c3s-stepper's motor moving in time and its buzzer playing in time, done events; SIGUSR1 raises a driver fault;
#     its haptics too: the LIC `cap`, the solenoid `kick` and the vibration motor `buzz` (tools/fake-haptic.ts); SIGUSR2 drains the LIC to 3.0 V)
#   add --epaper for a fake e-paper board (paper-c6: c6e-paper's 400 x 300 `paper`, refreshes in the vendor's times, the ghost budget,
#     refreshed events, tools/fake-epaper.ts; SIGUSR1 also makes its next refresh time out). display_text and display_html need a Chrome.
node tools/dash-shoot.mjs --url "$(cat /tmp/hub.url)" --out <dir> /=hub /devices=devices   # PNGs at 1440 and 390
```

`dash-shoot` fails on any console error or warning (a CSP refusal included); `--mode earth` shoots Earth mode,
`--full` the whole scrolling page; `#/ui` is the specimen of every primitive.

## 4. Layout

| Path | What |
|---|---|
| `schema/` | `protocol.yaml`, `registry.yaml`, `capabilities/*.cap.yaml`; `vectors/` generated |
| `hardware/` | `boards/`, `drivers/`, `parts/`, `wiring/`; `bench/bench.example.yaml` |
| `firmware/` | `apps/` (node, gateway, hwprobe), `components/fr_*`, `profiles/`, `partitions/`, `config/`, `test/host/` |
| `packages/protocol` | ops registry, frames, generated types; `packages/codegen`: the YAML → C++/TS/vectors generator |
| `packages/hub` | the daemon (serial, links, registry, jobs, OTA, bench modules: camera, audio, CSI, scale, power, fixture, app host; `src/peers`: the link between the hubs of one network, the ops, jobs, files and firmware it passes on, the registry it replicates, and the events and live streams it relays, design multi-hub-m2) |
| `packages/cli` | `fr` and `fr mcp`; `packages/host`: doctor, IDF env, pytools; `packages/sdk`; `packages/dashboard` |
| `packages/time` | the temporal core (vendored wasm and binding, `time.lock`), its readings and layouts: `fr time`, the `time_*` ops |
| `tests/` | `e2e/` gate scenarios, `sim/` virtual fleet, `spikes/` |
| `docs/` | `spec/` (start at its README), `design/`, `user-manual.md` |
| `clock/` | the clock firmware; its own AGENTS.md |

## 5. Known gaps

The review's findings still open (the clock on the framework, a setup command with prebuilt images, CI) are its
stages 5 and 6. Stage 2 (port policy, crash handling, `hub.db` growth, MCP safety, `fr` from anywhere), stage 3 (the
temporal core in the CLI and hub: `packages/time`, `fr time`, the `time_*` ops, `time.threshold` events, the SDK's
`HubError`) and stage 4 (the dashboard in the site's language) are done. Left for stage 5 with the clock: pushing time
to devices (`time_push`: since FACE-1 a node takes the hub's time from WELCOME, BEACON and TIME on its own, design
face-f1 D1), devices reporting their core version, a scheduler on thresholds, and a drawn face mirror. FACE-1 did
`fr clock` → `fr rtc` (`fr clock` stays an alias), `fr.face` (the clock on the e-paper panel, with power save, three
keys and a buzzer's clicks and chimes) and the dashboard's face block (`pages/device/face.tsx`); verified on paper-c6
with a camera on the glass (design face-f1 §13.1, §17, D20). Power save itself is untried on the board. The docs under `docs/spec` and
`docs/design` still cite `docs/research`, `docs/spikes` and `hosts/`, which are not in this repository (they stay in
the archived `fractonica/hardware`); the docs rewrite is stage 6.
