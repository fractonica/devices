# Fractonica devices

The Fractonica device framework: firmware for small ESP32 devices, the hub that runs them from a Mac, and the
clock firmware that is to become one of them.

- **Node firmware** (`firmware/`): ESP-IDF v6.1, C++23 components `fr_*` (node runtime, network link, OTA,
  identity, diagnostics, an LVGL display backend), built per *profile* from a hardware library of boards, drivers
  and parts (`hardware/`).
- **One schema** (`schema/`): the wire protocol and the capabilities in YAML. Codegen (`packages/codegen`) turns it
  into C++, TypeScript and golden vectors; `fr gen --check` keeps them in step.
- **The hub** (`packages/hub`): a Node daemon on the Mac that owns the USB ports, provisions, flashes, updates over
  the air, routes and logs, with a React dashboard (`packages/dashboard`).
- **One operation registry** (`packages/protocol`), served as REST, as the `fr` CLI (`packages/cli`) and as MCP
  tools, plus an app SDK (`packages/sdk`) and a Claude Code plugin (`plugin/`).
- **The clock** (`clock/`): the Fractonica clock firmware with its host simulator, a standalone ESP-IDF 5.5
  project. It has run on an ESP32-C6 with a round GC9A01. Stage 5 of the merge plan folds it into the framework,
  on ESP-IDF 6.1, as a face capability of the framework node.

"Core" means two things here: the **temporal core** is the Fractonica clock library, the sibling repository
[`core`](https://github.com/fractonica/core) (`../core`); the **node runtime** is the firmware component `fr_core`.

## Layout

```
firmware/    ESP-IDF 6.1: apps (node, gateway, hwprobe), components fr_*, profiles, partitions, host C++ tests
hardware/    boards, drivers, parts, wiring guides; bench/bench.example.yaml (an example HIL bench)
schema/      protocol, registry and capabilities (the source of truth), golden vectors (generated)
packages/    TypeScript: protocol, codegen, sdk, host, hub, cli, dashboard
web/bench/   the hub-served bench app (wiring guides, parts)
apps/        example apps for a Linux hub (fr app deploy)
tests/       e2e and HIL gate scenarios (opt-in, need boards), the virtual-fleet sim
tools/       host-test.mjs (host C++ suite), pytools (esptool sidecar)
plugin/      the Claude Code plugin (fr mcp, skills)
docs/        spec/, design/ (decision records the code cites), user-manual.md
clock/       the clock firmware (ESP-IDF 5.5) and its simulator, until stage 5
```

## Status

This repository was `fractonica/esp32` (the clock). On 2026-11-13 the framework's history from
`fractonica/hardware` was merged in, filtered: the Linux boards (`hosts/`), six bench web apps, the research and
spike notes and personal data were left out; they stay in the archived `fractonica/hardware`. The clock moved to
`clock/`. The merge plan and review is `HARDWARE-REVIEW.md` in the owner's workspace (not published).

Checked at the merge, on the owner's Mac:

- typecheck (root, dashboard, web/bench): clean. vitest, one package at a time: 2,432 of 2,432 passed in the seven
  packages, and web/bench's 8. That is with the virtual-fleet binary built (`node tools/host-test.mjs --fleet`;
  without it 20 fleet tests skip) and a local `hardware/bench/lab.bench.yaml` (not committed; copy
  `bench.example.yaml`; without it the HIL interop suite and the T-HIL dry run skip 10 more). Timing-sensitive cases
  can fail under heavy machine load and pass when re-run alone. On a fresh checkout the first CLI run fetches LVGL and
  builds the desktop renderer (about a minute here). `fr gen --check`: 195 files, 0 stale. Host C++ suite (ASan +
  UBSan): 975 tests, of which `sim_node_strand_runs_its_jobs_in_post_order_one_at_a_time` is a known timing race that
  passes alone.
- ESP-IDF 6.1 build of profile `c6w-scale` (debug): 1,744,992 bytes, 0 compiler warnings, 11 % of its slot free.
- The clock: `cd clock/sim && make test` passes (140 golden images, 943 firmware-loop checks); the ESP-IDF 5.5.1
  build for the ESP32-C6 + GC9A01 is 273,344 bytes, 0 warnings.
- Since the merge (stage 2 of the plan): the hub opens only the USB ports of boards it knows and leaves the others
  to `idf.py`, esptool or a browser (`fr ports`, with lend, ignore and claim); it logs crashes and survives a failing
  timer loop; it prunes finished jobs, keeps per-frame camera telemetry out of `hub.db`, rotates `hub.log` and
  compacts on request (`fr hub compact`); `fr mcp` starts no hub unless asked and marks destructive tools; `fr` runs
  from any directory through `packages/cli/bin/fr.mjs`. Setup is in [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).
- Not done yet (stages 3 to 6 of the plan): the dashboard redesign, the temporal core in the CLI and hub, the clock
  on the framework, a setup command with prebuilt firmware images (a first board still needs ESP-IDF 6.1 and a
  build), CI.

## Security

**A LAN lab, unauthenticated.** Use it on a network you trust, with boards you own:

- Node links (TCP and UDP 7421) and OTA images (HTTP 7422) are served on the local network without authentication.
- OTA checks an image's integrity (SHA-256), not its authenticity: there is no signature.
- Wi-Fi credentials are stored on each board unencrypted, in NVS (the `fr_ident` partition); on the Mac in
  `~/.fractonica/secrets.json` (mode 0600).
- The hub's API and dashboard listen on loopback only and have no login.

## Documentation

- [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md): from a fresh Mac to a provisioned board, port lending,
  troubleshooting, upgrading.
- [docs/user-manual.md](docs/user-manual.md): task by task, every feature on the bench.
- [docs/spec/](docs/spec/README.md): the framework specification; [docs/design/](docs/design/): decision records.
- [AGENTS.md](AGENTS.md): for coding agents and engineers working in this repository;
  [plugin/AGENTS.md](plugin/AGENTS.md): for agents driving the devices through `fr` or MCP.
- [clock/README.md](clock/README.md): the clock firmware.

## Upgrading

The operation registry changed (the port operations), so `REGISTRY_HASH` differs from a hub started from older code:
after pulling, run `fr hub restart` and reconnect the MCP server (`/mcp` in Claude Code), and run `fr doctor --fix`
once to point the `fr` shim at `packages/cli/bin/fr.mjs`. [GETTING-STARTED §9](docs/GETTING-STARTED.md#9-upgrading)
lists the other changes in behaviour (the port policy, `fr mcp` no longer starting the hub, job retention).

## Licence

Apache License 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE). The vendored cJSON
(`firmware/test/host/third_party/cjson/`) keeps its MIT licence.
