# Getting started

From a fresh Mac to a board on the hub. Everything here works as described on the current `main`; where a step is
slower or needs more than it should, this guide says so.

## What runs where

- **The hub** is a Node process on your Mac. It keeps the device registry (`~/.fractonica/hub.db`), reads the USB
  serial ports of the boards it knows, builds and flashes firmware, updates boards over Wi-Fi, and serves a dashboard
  at <http://127.0.0.1:7420/>.
- **`fr`** is the command line for the hub (and for the local tasks that need no hub: `fr doctor`, `fr gen`).
- **The boards** run the node firmware, built per *profile* (`firmware/profiles/`) with ESP-IDF 6.1.

## 1. Prerequisites

| What | Why | How |
|---|---|---|
| macOS with Xcode command-line tools | git, a compiler for native modules | `xcode-select --install` |
| Node 24.12 or later | the hub and `fr` | `brew install node@24` (or any manager; `.node-version` names major version 24) |
| pnpm 11 | the workspace | `brew install pnpm` (or `corepack enable`) |
| uv | Python 3.12 for the esptool sidecar that flashes boards | `brew install uv`, then `uv python install 3.12` |
| ESP-IDF v6.1 at the pinned commit | **only to build firmware** | see [Building firmware](#5-building-firmware) |

Today a first board needs a firmware build, so in practice you need ESP-IDF too before you can provision one (there
are no prebuilt images yet). Everything else (the hub, the dashboard, monitoring boards that already run the
firmware) works without it.

## 2. Install

```sh
git clone https://github.com/fractonica/esp32.git devices    # to be renamed fractonica/devices; GitHub redirects
cd devices
pnpm install
pnpm fr doctor --fix
```

`pnpm fr` runs the CLI from this checkout (`packages/cli/bin/fr.mjs`). `fr doctor --fix`:

- writes the `fr` shim to `~/.local/bin/fr`, which runs this checkout's CLI with the Node it was written with. If
  `~/.local/bin` is not on your `PATH`, doctor says so: add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc`.
- installs the esptool sidecar into `~/.fractonica/pytools` (with uv's Python 3.12),
- builds the dashboard and the bench app the hub serves,
- checks Node, ESP-IDF, the macOS firewall, the LAN route and the serial ports, and prints what it could not fix.

Doctor exits 1 while ESP-IDF is missing; that is expected until you build firmware. After a `git pull` that moved
the checkout or changed the dashboard, run `fr doctor --fix` again.

From here `fr` works from any directory. A command that needs a checkout (`fr gen`, `fr build`, `fr deploy`,
`fr test run`) uses the checkout around the current directory, or else the one the shim points at, and says so.

## 3. Start the hub

Start it **from Terminal** (not from an editor or an agent): macOS gives Local Network access to the app that
starts it, and without that access boards on Wi-Fi cannot reach the hub.

```sh
fr hub start
fr hub status
```

The first start makes macOS ask whether Terminal may find devices on the local network: allow it. `fr hub status`
shows the version, the ports and devices, and any warnings. The dashboard is at <http://127.0.0.1:7420/>.

Store the Wi-Fi network your boards join. You type the password at a prompt that does not echo it; it is kept in
`~/.fractonica/secrets.json` (mode 0600) and never printed:

```sh
fr net set --ssid "<your network>" --password-stdin
```

Stop it with `fr hub stop` (it refuses while a job runs; `--force` aborts them). `fr hub restart` picks up new code.

## 4. USB ports: what the hub takes and how to lend one

By default the hub opens only the ports of boards it knows: boards it has provisioned or heard from. Every other
ESP32 or USB-UART port is listed but left closed, free for `idf.py`, esptool, a terminal or a browser.

```sh
fr ports
```

```
PATH                   BOARD    VIA    STATE                           LINES
/dev/cu.usbmodem1101   pad-c6   usb    watched by hub                  1204
/dev/cu.usbmodem1201   -        usb    not opened (board not adopted)  0
/dev/cu.usbserial-110  -        ch340  ignored                         0
```

A port the hub watches is opened with an exclusive lock, so `idf.py flash` or esptool on it fails with "Could not
exclusively lock port". Lend it instead of stopping the hub:

```sh
fr serial idf pad-c6 flash monitor                              # idf.py -p <port> flash monitor, in this directory, while lent
fr serial lease pad-c6 -- esptool --port '$FR_PORT' chip-id     # any command; '$FR_PORT' in single quotes, so fr fills it in
fr ports lend /dev/cu.usbmodem1101 --ttl 600                    # or lend it for 10 minutes to start something by hand
```

The port is given back when the command exits. `fr serial idf` runs the `idf.py` on your `PATH` (source your
project's ESP-IDF `export.sh` first) and passes its arguments on; put `--` before options (`fr serial idf pad-c6 --
-C ../my-app flash`). In `fr serial lease`, write `'$FR_PORT'` in single quotes: in double quotes your shell replaces
it with nothing before `fr` runs. `fr flash <board>` (framework firmware) leases the port by itself.

Other port commands, also on the dashboard's Ports page and as MCP tools:

| Command | What it does |
|---|---|
| `fr ports ignore <port>` | the hub never opens it, also after a re-plug. `<port>` is a registered board's name (plugged in or not: it follows the board), a path, a MAC or USB serial, or `VID:PID` (`1a86:7523`: every port of that adapter). Anything else is refused. `--remove` undoes it |
| `fr ports claim <port>` | the hub opens a port it left alone, so an unknown board running the node firmware says HELLO and is registered. `--remove` undoes it |
| `fr ports lend <port> [--ttl s]` | as above |

The settings live in `~/.fractonica/config.json`:

```json
{
  "ports": { "mode": "adopted", "ignore": ["/dev/cu.usbmodem1101"], "claim": [] }
}
```

`"mode": "all"` makes the hub open every ESP32 and USB-UART port, as it did before this policy. A mistake in the
file is reported by `fr hub status` and the defaults apply until it is fixed.

## 5. Building firmware

ESP-IDF v6.1 at the commit in `firmware/idf-version.lock`, in `~/esp/v6.1/esp-idf`:

```sh
mkdir -p ~/esp/v6.1
git clone -b v6.1 --recursive https://github.com/espressif/esp-idf.git ~/esp/v6.1/esp-idf
git -C ~/esp/v6.1/esp-idf checkout "$(node -p "JSON.parse(require('fs').readFileSync('firmware/idf-version.lock', 'utf8')).idf.commit")"
git -C ~/esp/v6.1/esp-idf submodule update --init --recursive
~/esp/v6.1/esp-idf/install.sh esp32,esp32c3,esp32c5,esp32c6,esp32s3
fr doctor
```

`fr doctor` prints the exact commands if the checkout is at another commit. You never need to `source export.sh`:
`fr` captures the IDF environment itself (sourcing it fails when an older Python is first on `PATH`).

Build a profile (the first build takes several minutes; later ones are incremental):

```sh
fr build --profile c6-pad
```

`fr profiles ls` lists the profiles with their boards.

## 6. Your first board

1. Plug the board in. It shows in `fr ports` as `not opened (board not adopted)`.
2. Build its profile if you have not (`fr build --profile <profile>`).
3. Provision it: the hub probes the chip, registers it, writes the firmware and its identity (alias, network) in
   one flash, resets it and waits for it to say HELLO over USB and then over Wi-Fi.

   ```sh
   fr devices provision --port /dev/cu.usbmodem1201 --profile c6-pad --alias pad-c6
   ```

   Or on the dashboard: **Ports**, then **Provision** on the port. Pick a profile that is already built: the wizard
   lists every profile, and an unbuilt one fails after the probe with the `fr build` command to run.
4. From now on the hub watches the board's port, also after it resets or is re-plugged. Check it:

   ```sh
   fr devices get pad-c6
   fr logs pad-c6 --follow
   ```

Later firmware updates go over Wi-Fi: `fr deploy pad-c6` builds and updates it. The [user manual](user-manual.md) has
every feature task by task.

## 7. Agents (Claude Code)

The plugin in `plugin/` gives Claude Code the hub's operations as MCP tools (`fr mcp`). It starts no hub by itself:
start one from Terminal first. To let the first tool call start it, run the server as `fr mcp --autostart`, or set
`FR_MCP_AUTOSTART=1`, or `"mcp": {"autostart": true}` in `~/.fractonica/config.json`. Tools that flash, provision,
update over the air, reset or delete are marked destructive, so the client asks you before running them; Wi-Fi
passwords never go through MCP. See [plugin/README.md](../plugin/README.md).

## 8. Troubleshooting

| You see | Do this |
|---|---|
| `fr: command not found` | `pnpm fr doctor --fix` in the checkout, then put `~/.local/bin` on `PATH` |
| `fr hub status` warns that macOS denies the hub Local Network access, or boards stay `offline` over Wi-Fi | System Settings → Privacy & Security → Local Network: allow the app that started the hub (Terminal), then `fr hub restart` from Terminal |
| doctor's `firewall` check fails | System Settings → Network → Firewall → Options: turn off "Block all incoming connections", or allow the Node the hub runs on |
| `idf.py` or esptool: "Could not exclusively lock port" | the hub watches that port: `fr serial idf <board> flash monitor`, `fr serial lease <board> -- <cmd> '$FR_PORT' …`, `fr ports lend <port>`, or `fr ports ignore <port>` |
| `PORT_BUSY_EXTERNAL`: a port "is held by …" | another program has it open (a Chrome Web Serial tab, `screen`, a serial monitor): close it, or click Disconnect in the page, then retry. `fr ports` names the program |
| A board you plugged in is `not opened` | expected for a board the hub does not know: provision it, or `fr ports claim <port>` if it already runs the node firmware |
| `fr ports` says `not opened (config.json has no valid ports settings)` | `~/.fractonica/config.json` has had a problem since the hub started (`fr hub status` names it), so the hub opens no port: fix the file and it applies within about 2 s. A file broken while the hub runs keeps the settings read before it |
| `HUB_VERSION_MISMATCH` after a `git pull` | `fr hub restart` (with `--force` if a job is stuck), and reconnect the MCP server in Claude Code (`/mcp`) |
| `hub.db` is large | it is pruned by itself; `fr hub status` says when `fr hub stop && fr hub compact && fr hub start` would give space back |
| A crash | `~/.fractonica/hub.log` (and `hub.log.1`…) has an `uncaught_exception` line with the stack; `fr hub start` starts it again |

## 9. Upgrading

- **The registry changed** (new port operations), so `REGISTRY_HASH` differs: after pulling, run `fr hub restart`,
  then reconnect the MCP server (`/mcp` in Claude Code). Until then every call but `hub_status` answers
  `HUB_VERSION_MISMATCH`.
- **The shim changed**: run `fr doctor --fix` once; it rewrites `~/.local/bin/fr` to run `packages/cli/bin/fr.mjs`.
- **The hub now leaves unknown boards' ports alone.** Boards already in your registry are watched as before. Add
  `"ports": {"mode": "all"}` to `~/.fractonica/config.json` for the old behaviour, or `fr ports ignore` a board the
  hub should never take.
- **`fr mcp` no longer starts the hub.** Start it from Terminal, or opt in (section 7).
- **An older `hub.db`** keeps the space pruning frees until `fr hub compact` (hub stopped). Finished jobs older than
  30 days, and beyond the newest 5000, are now deleted; `"retention": {"jobs_days": 90, "jobs_rows": 20000}` keeps more.

## 10. Security

This is a lab tool for a network you trust, with boards you own:

- Node links (TCP and UDP 7421) and OTA images (HTTP 7422) are served on the local network **without
  authentication**: anything on the LAN can talk to the hub's node ports and to the boards.
- OTA checks an image's **integrity** (SHA-256), not its **authenticity**: there is no signature, so it proves the
  image arrived intact, not who made it.
- Wi-Fi credentials are stored on each board **unencrypted**, in NVS (the read-only `fr_ident` partition the hub
  writes), so anyone with the board can read them; on the Mac they are in `~/.fractonica/secrets.json` (mode 0600).
- The hub's API and dashboard listen on loopback only (127.0.0.1 and ::1) and check the Host and Origin headers;
  they have no login.
