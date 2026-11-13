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
   clock arithmetic (see the clock's rules in `clock/AGENTS.md`).
6. Do not push. Changes to `.github/workflows/*` need the owner to push them (the local token lacks that scope).
7. Security scope: a LAN lab, unauthenticated (README "Security"). Do not describe it as more.

## 2. Setup

Node 24.12 or later, pnpm 11, uv (Python 3.12 for the esptool sidecar), and for firmware ESP-IDF v6.1 at the commit
in `firmware/idf-version.lock` (`~/esp/v6.1/esp-idf`).

```sh
pnpm install
pnpm fr doctor --fix     # host checks; writes the fr shim to ~/.local/bin, builds the dashboard and web/bench
```

Everything TypeScript runs from source (`node --conditions=@fractonica/source`); the `dist/` exports are not built.
`packages/cli/bin/fr.mjs` starts the CLI that way; `pnpm fr` and the shim run it. A fresh Mac's steps are in
[docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).
`source ~/esp/v6.1/esp-idf/export.sh` fails when Python 3.10 is first on PATH: `fr` captures its own IDF
environment (`packages/host/src/idf.ts`), or put the uv Python 3.12 first on PATH before sourcing it.

## 3. Checks (run before saying something works)

```sh
pnpm typecheck                         # tsc: root, packages/dashboard, web/bench
pnpm test                              # vitest (no boards needed); under load run one area at a time:
pnpm vitest run packages/hub           #   packages/{protocol,codegen,sdk,host,hub,cli,dashboard}
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

## 4. Layout

| Path | What |
|---|---|
| `schema/` | `protocol.yaml`, `registry.yaml`, `capabilities/*.cap.yaml`; `vectors/` generated |
| `hardware/` | `boards/`, `drivers/`, `parts/`, `wiring/`; `bench/bench.example.yaml` |
| `firmware/` | `apps/` (node, gateway, hwprobe), `components/fr_*`, `profiles/`, `partitions/`, `config/`, `test/host/` |
| `packages/protocol` | ops registry, frames, generated types; `packages/codegen`: the YAML → C++/TS/vectors generator |
| `packages/hub` | the daemon (serial, links, registry, jobs, OTA, bench modules: camera, audio, CSI, scale, power, fixture, app host) |
| `packages/cli` | `fr` and `fr mcp`; `packages/host`: doctor, IDF env, pytools; `packages/sdk`; `packages/dashboard` |
| `web/bench` | the bench app the hub serves at `/apps/bench/` |
| `tests/` | `e2e/` gate scenarios, `sim/` virtual fleet, `spikes/` |
| `docs/` | `spec/` (start at its README), `design/`, `user-manual.md` |
| `clock/` | the clock firmware; its own AGENTS.md |

## 5. Known gaps

The review's findings still open (the dashboard design, the temporal core in the CLI and hub, the clock on the
framework, a setup command with prebuilt images, CI) are its stages 3 to 6; stage 2 (port policy, crash handling,
`hub.db` growth, MCP safety, `fr` from anywhere) is done. The docs under `docs/spec` and
`docs/design` still cite `docs/research`, `docs/spikes` and `hosts/`, which are not in this repository (they stay
in the archived `fractonica/hardware`); the docs rewrite is stage 6.
