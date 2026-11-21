# MULTI-HUB-1: one network, several hubs

> **Built 2026-11-20, not yet on a board.** What is here is in the code and passes the host C++ suite, vitest and one
> ESP-IDF target build (`c3s-stepper`). Nothing in it has run on an ESP32 or on the UNO Q; §8 says what that leaves
> unverified. Anything marked *open* is a question this step did not answer.

## 0. What was decided

1. **One network, many hubs.** A network is a net id, one address space and the registry rows of its boards. Several
   hubs can serve it. A board keeps one identity (addr, net, alias) whichever hub it is connected to.
2. **A board has an ordered list of hubs.** The first is its default. When the hub it is on goes away it connects to
   the next; while on a hub that is not the first it looks at the hubs above about once a minute and returns when one
   answers, with enough hysteresis not to flap.
3. **The list, and so the default hub, is set over the air.**
4. **Later, not here:** a link between the hubs that replicates the registry and routes an operation to the hub that
   holds a board's session. §7 says what this step leaves for it.

Two things were already there and are what this builds on: a hub takes any HELLO that carries its net id
(`packages/hub/src/router/index.ts`, the `foreign_net` check), and a node finds its hub by a chain that ends with any
hub's advert ([05 §5.12.5](../spec/05-network.md)).

## 1. Words

- **Registrar.** The one hub of a network that hands out addresses. A hub is its own registrar until it joins
  another hub's network (`network_join`); from then on the hub it joined is. There is one address space, so there is
  one allocator: two hubs that both allocated would sooner or later give two boards one address.
- **Member.** A hub that joined. It holds rows the registrar gave it and allocates nothing.
- **Hub list.** Up to four hubs, each a host name and an optional IPv4 to fall back to, in priority order, with a
  `rev` that only grows. The board holds it; the registry keeps a copy.

## 2. The board

### 2.1 `fr.node` 1.1

`schema/capabilities/node.cap.yaml`. Two commands and one type, all additive (the minor version went from 1.0 to 1.1):

| | |
|---|---|
| `Hub { host: string ≤ 63, ip: string ≤ 15 }` | `ip` empty: no fallback address |
| `hubs_set { hubs: array<Hub> ≤ 4, rev: u32 }` (id 11) | reliable, idempotent. `EXPIRED` for a rev at or below the one held (the same list and rev again is OK), `INVALID_ARGS` for a host or ip that is not one or a host named twice, `BUSY` while an earlier list waits to apply, `UNSUPPORTED` on a gateway or a radio-off build. An empty list takes the list away |
| `hubs_get` → `{ hubs, rev, on: u8, trial: bool }` (id 12) | `on` is the index in `hubs` of the hub the TCP session is with, 255 for none of them (no TCP session, no list, a hub found by its advert). `trial`: no hub of the list has WELCOMEd the board yet |

There is no property and no event: a hub with a session knows the board is on it, and asks for the rest. Firmware
before 1.1 answers `UNSUPPORTED` to both (the generated dispatch's default), which the hub reports as
`CAPABILITY_UNSUPPORTED`.

### 2.2 Where the list is kept

- **ESP32:** `nvs:fr_hubs` in the RW partition, beside `fr_net2` (`fr_id`: `id.h` `fr_hub_list_t`, `id.cpp`
  `fr_id_load_hubs` / `fr_id_save_hubs`). Keys: `n` (u8 count), `rev` (u32), `base` (u32, `fr_ident`'s `prov_ts` when it
  was pushed), `h0`..`h3` (host), `i0`..`i3` (ip, absent for none). The namespace is erased and rewritten in one commit,
  so a power cut leaves the old list or the new one.
- **It is written only once a hub of the list has WELCOMEd the board**, never while the list is on trial. A reboot
  during a trial is therefore the list before it.
- **A reprovision supersedes it.** At boot a list whose `base` is not `fr_ident`'s `prov_ts` is dropped
  (`hub_list_superseded`, `fr/net/hub_plan.hpp`), as a `net_set` override is: a flash writes `fr_ident` and leaves the RW
  partition alone, and the hub it names must win.
- **A rev that only grows.** `hub_push_check` (same header): a push is taken only with a rev above the one held. A list
  taken away is stored as `n = 0` with its rev, so an older list cannot come back.
- **POSIX runtime:** three keys in the identity file (`fr_posix` `IdentityFile`): `hubs_rev`, `hubs` (`host[/ip]`
  entries separated by spaces) and `hubs_base`, the `hub` the list was pushed under. A `hub` changed since (`set-hub`,
  the POSIX counterpart of a reprovision) drops the list at load. `hub` itself is never rewritten by a list.
- **With no list** nothing differs from before: `fr_ident`'s `hub_host` and `hub_ip` (or the `net_set` override's
  `hub_host`), then the advert.
- **With a list** it takes the place of `hub_host` from both `fr_ident` and a `net_set` override.

### 2.3 Which hub

The rules are one header, `firmware/components/fr_net/include/fr/net/hub_plan.hpp` (`HubPlan`, IDF-free, no sockets),
which the ESP32 link (`fr_net/src/esp/hub_link.cpp`), the POSIX runtime (`fr_posix/src/links.cpp`) and the host suite's
node (`test/host/tools/net_node.cpp`) all follow. The link tells the plan what happened and asks what to do next.

| | Default | Rule |
|---|---|---|
| Give a hub up | 10 s **and** 3 attempts | A hub that gives no session (no address, no connection, or a connection with no WELCOME) for that long, counted from the first attempt at it, is left for the next. The reconnect backoff (0.25 → 5 s) is the existing one and starts over for the next hub, which is tried at once. With a hub whose machine answers (connection refused) that is about 12.5 s after the session ended; with one that is away (3 s connect timeouts) about 13.5 s |
| WELCOME wait | 4 s | With a list, a connection that gets no WELCOME this long is closed and counts as a failed attempt (a hub of another network stays silent). Without a list the board waits as before |
| Order | | After a lost session: the hub the board was on, then the others in list order, then one lookup of any hub's advert (the old last resort), then the list from its top. At boot: the list from its top |
| Probe period | 60 s | With a session on a hub that is not the first, every hub above it is probed: a TCP connect to its node port on a socket of its own, closed at once |
| Probe confirm | 10 s | A hub that answers is probed again this much later, and only a second answer makes the board return. One answer followed by none is forgotten |
| Probe back-off | ×2, up to 480 s | A return that gets no session (the hub accepts connections but does not WELCOME) doubles the period until a return works |
| Trial | 60 s | §2.4 |
| Busy | | No probe, and so no return, while an OTA job runs over the hub the board is on (`fr::net::esp::hub_busy`, set from the heartbeat's `ota_busy`) |

A hub found by its advert ranks below the whole list: every listed hub is probed from it.

On the ESP32 a probe's name lookup runs on the `fr_net` task with a 300 ms mDNS timeout (a hub that is back answers in
tens of ms); the session's frames wait behind it, at most that long once a minute while the board is on a fallback
hub. On POSIX a probe resolves and connects on a thread of its own.

### 2.4 Setting the list, and its trial

`hubs_set` is applied about 300 ms after its RESULT, so the RESULT leaves on the session it came over (as `net_set`).

- **The list names the hub the board is on** (by the name the board has for it: its `hub_host`, or its list entry):
  the list is in force and stored at once, the session stays. If that hub is not first in the new list, the hubs
  above it are probed at once, so the board reaches a new default hub after its two answers, about 10 s later.
- **It does not:** the board closes its session, goes to the list's first hub and is on trial. A WELCOME from any hub
  of the list confirms and stores it. With none within 60 s the board returns to the list it had (the one in NVS) and
  keeps its old rev. During a trial the advert step is left out: only a hub of the list can confirm it. A Wi-Fi outage
  does not use up the trial; its 60 s count from when the network is back.

### 2.5 What follows the hub the board is on

On the ESP32 the hub's address is two atomics in `hub_link.cpp`, `hub_ip_` and `hub_port_`, written only by
`Hub::resolve` for the hub of the current connection attempt. A probe has its own socket and address and never writes
them. Everything that addresses "the hub" reads them:

| Use | Where |
|---|---|
| The TCP session | `Hub::start_connect` (`hub_link.cpp:684`) |
| UDP datagrams to :7421 | `Hub::udp_send` (`hub_link.cpp:1094`) |
| The OTA download | `OtaHost::endpoint` (`fr_core/src/core.cpp:979`): `status().hub_ip`, and only with a TCP session |
| HTTP streams (camera, audio, CSI) to :7422 | `AudioStreamHost::endpoint` (`core.cpp:1016`), which calls the OTA endpoint; the services read it when a stream starts |
| diag `info` (`hub.host`, `hub.ip`) | `Hub::fill` (`hub_link.cpp:1111`): the host is the list entry's |

No other code in `firmware/` reads the hub's address (searched: `hub_host`, `hub_ip`, `hub_port`, 7421, 7422).

POSIX: the TCP link resolves the plan's hub at every connect and hands that address to the UDP link
(`links.cpp`, `TcpLink::start_connect`); the runtime has no OTA. The host suite's node moves its UDP port and its OTA
and stream HTTP port with the TCP link (`on_hub`).

## 3. The hubs

Four new ops at the end of the registry (`MULTI_HUB_OPS`), and two changed ones. Another hub is called as `for_hub`
calls it (`registry/remote.ts`): a POST to its API, through an SSH tunnel that listens on that hub's own port.

| Op | CLI | What |
|---|---|---|
| `network_join { hub, force? }` | `fr net join --hub <url>` | This hub takes that hub's net id, and its SSID, country and band when it has no network stored (never a password), and records it as the registrar (kv `net.registrar`). Refused while boards are provisioned here under the hub's own net id, unless forced; the answer names them and how each gets a new identity. Its own epoch counter is moved a quarter of the u16 space away from the registrar's (§4 a) |
| `device_share { device, with_hub }` | `fr devices share <device> --with-hub <url>` | That hub's `device_enroll` with the board's addr, net, alias, alias_rev and an epoch floor. Refused when that hub's net id is not the board's, with the hint to join. Answers that hub's host name and address, which is what goes into the board's list |
| `device_hubs_set { device, hub[], none? }` | `fr devices hubs set <device> --hub <host>[/<ipv4>] ...` | Asks the board for its rev (`hubs_get`), sends `hubs_set` with the next one above the board's and the row's, records the list in the row (`devices.hubs`), then says what became of it: `on` and `trial` when the board is still here, `left` when it went to another hub |
| `device_hubs_get { device }` | `fr devices hubs get <device>` | `hubs_get`. The row follows what the board holds (a list not on trial), since any hub of the network may have set it |
| `device_enroll` (changed) | | With `addr`, `net` and `alias` it stores exactly that identity: nothing allocated, no tag `new`, idempotent. Refused when `net` is not this hub's or another device holds the addr or alias. `chip` and `profile` are then optional (a Linux node has none), as they are for a node enrolled by `alias` alone |
| `device_provision --for-hub` (changed) | | For a hub of this hub's own network (the same net id) the board is both hubs': this hub keeps its provisioned row (no `moved`, its port still adopted), `fr_ident` names the other hub, and the other hub gets the same row. For a hub of another network it is as before |

`device_get` gains `hubs` (the row's copy) and `hub_now` (`here`: its TCP session is with this hub; `on`, `rev`,
`trial`: its last `hubs_get` answer in this hub run). `network_get` and `network_list` gain `registrar`. `hub_status`
gains `hub_epoch`.

**The registrar rule** is in `registry/store.ts` `prepareIdentity`, which every allocation goes through
(`device_provision`, `device_adopt`, `device_enroll` without an identity): on a member hub it refuses unless the row
already holds an address of the shared net, with an error that names the registrar and `fr devices share`.
`device_provision` checks the same before its job starts. A row given with an explicit identity
(`storeSharedIdentity`) allocates nothing and is fine; its address is retired on the member too.

**A member that flashes for the registrar.** `device_provision --for-hub <registrar>` on a member lets the registrar
allocate (its plain `device_enroll`) and stores the row it answers.

**A Linux node after its hub joined.** The node still carries the hub's old net id. While its session from before the
join lasts, an explicit-identity enroll for it (the registrar: `fr devices enroll <id> --alias <a>`, then
`fr devices share`) makes the member push the identity as `device_adopt` does (MSG `fr.adopt`); the node saves it and
restarts into the shared network. The answer says `adopt: pushed`. For an ESP32 in that state it says `needs_flash`:
its identity is in `fr_ident`.

## 4. Four questions

### a. The hub at the other end changes

**What the core does** (`fr_net/src/core/net.cpp`, `Net::on_welcome`, line 557): a WELCOME with another `hub_epoch`
ends the sessions on the other links (`hub_restarted`), drops the CMDs the old run scheduled, resets the unicast
window to the floor the hub gives and the broadcast window to its base, clears the LATEST table and the link's
`time_synced` (lines 586-624). The node keeps no clock offset: the hub's `NodeClock` is per hub process, and the new
hub's TIME burst starts it. `fr.node.boot` is sent once per boot, so a later hub never gets it (line 639). There are
no held events in the node: an event with no route is dropped, and a reliable frame sent over a session that then
ended has failed (`end_session`, line 1174). A STATE the new hub has not seen comes with its `get_state`. So a change
of hub **looks like a hub restart, provided the two hubs' epochs differ**.

**They may not differ.** Each hub counts its runs from 1 in its own `hub.db` (`packages/hub/src/db.ts`
`nextHubEpoch`), so two hubs are quite likely at the same number. Then the node took the second hub for the first
one's run: the broadcast floor only raised, scheduled CMDs kept, and a duplicate request from the second hub answered
from the response cache with what the first hub got (the cache is keyed by src, epoch and seq, and each hub's seqs
start at 1).

**What was done:**

1. `Link::far_end()` (`fr/net/link.hpp`): a link that can move between hubs says, by a number that changes, when it
   reached another hub than its last connection did. `on_welcome` takes a TCP WELCOME after such a change for a new hub
   run whatever the epoch (lines 575-612): other sessions end, every scheduled CMD is dropped, the response cache is
   emptied, the broadcast window is reset. Tests: `net_welcome_from_another_hub_is_a_new_run_whatever_its_epoch`,
   `net_welcome_from_the_same_hub_keeps_its_run`.
2. `network_join` moves the member's epoch counter `0x4000` away from the registrar's, from its next start on
   (`db.ts` `spreadHubEpoch`), and says so when the two runs are equal at that moment.

**Open.** (1) covers TCP after TCP. A serial session with one hub and a TCP session with another at equal epochs is
still one run to the node (§c). (2) holds only while both hubs restart about equally often, and not at all for hubs
that never joined each other. The hub side has the same blind spot: `#result` matches a RESULT by epoch and seq
(`router/index.ts:2185`). The clean answer is the hubs' link choosing epochs that cannot meet; it changes no frame.

Services that let go when the hub is gone (stepper, haptic, battery, fixture) watch `hub_epoch` and silence. A move
by failover has seconds of silence; a move by failback or a new list at equal epochs has none, and they do not see it.
*Open*, with the same answer.

### b. A switch while an OTA or a stream runs

- **OTA.** The download URL is fixed when the OFFER arrives (`fr_ota/src/core/ota.cpp:196`) and names the hub of the
  session then. The job does not watch the session. If the board leaves that hub, the hub's port 7422 stops serving
  it (it serves only the address of a live TCP session), the download fails after its Range retries
  (`kRangeRetries` 5), and the node's RESULT goes to the hub it is on by then, which does not know the job and ignores
  it. The hub that started the job marks it `FAILED device_offline, retry: true`. Nothing is installed; no board is
  left on a half image. An image already staged is committed only by its own hub's COMMIT.
- **So a board does not leave by choice during an OTA:** failback is held while `ota_busy`. Failover is not a
  choice; a hub that dies mid-OTA fails that OTA as it did before.
- **After an install** the health gate needs a WELCOME from any hub, and the success RESULT goes to whichever hub that
  is. If it is not the one that ran the job, that job ends `device_offline` although the board updated. *Open*: the
  hubs' link.
- **Streams** are not held back. A stream POSTs on its own socket to the address it read at its start
  (`camera_service.cpp`, `audio_in_service.cpp`, `audio_out_service.cpp`, `csi_service.cpp`) and ends `net_lost` when
  that connection fails, not when the session moves. A failback under a long live view moves the session and leaves
  the stream running to the hub the board left. *Open*: whether a stream should hold failback back as OTA does (a
  live view can run for hours), and what the left hub does with it; not tried.
- **`device_hubs_set` during an OTA** is not refused; it ends the OTA as above.

### c. USB to one hub, TCP to another

Both hubs have the board's row, so both answer its HELLO. This is the ordinary case, not a corner: a board flashed at
the Mac for the home hub and left on the Mac's cable.

**Before:** with different epochs, each hub's WELCOME ended the other link's session (the restart rule), the ended
link said HELLO again, and the two went round for ever, a turn every few seconds (the TCP reconnect backoff, 0.25 to
5 s). With equal epochs both sessions stayed, sharing one window.

**Now** (`Net::on_welcome`, lines 564-574): a WELCOME over serial from another hub run while the TCP session is alive
(a hub frame on TCP within two heartbeat intervals) is not taken, and the serial link sends no HELLO again until the
TCP session ends (`end_session`, line 1178). **TCP wins**: it is the hub of the board's list, the cable is whoever
has the board on the desk. When the TCP session ends, the hub on USB may have the board (a failover by cable), and
loses it again to the next TCP WELCOME. A hub that restarted is told apart by its dead TCP connection: its old
session is silent, and the old rule applies. Tests: `net_serial_welcome_of_another_hub_is_refused_while_tcp_lives`,
`net_serial_welcome_of_a_new_run_is_taken_once_tcp_is_silent`.

**What the hub on USB sees:** the board's HELLO once at boot (before Wi-Fi is up it has the board), and once each
time the TCP session starts; it WELCOMEs, gets no answer, and takes the board offline after its timeout. Its apps see
that `device.online` and `device.offline`. It keeps the port, the serial log and the flash.

**Open:** equal epochs (§a); the hub on USB showing the board online for a few seconds. Both want the hubs' link:
a hub that knows another hub holds the session need not WELCOME on serial at all.

**Old firmware has no such rule.** A board with firmware from before this step, in the registry of two hubs, on one's
cable and the other's Wi-Fi, loops as described under "Before". §6.

### d. Gateways and ESP-NOW-only nodes

Not solved, not broken; what happens:

- A BEACON carries `hub_epoch` and `hub_ipv4`, and the node reads neither (`fr_net/src/core/gateway.cpp:77-118` takes
  `gw_mac`, the interval and the radio's RSSI). Nothing in the firmware finds a hub by `hub_ipv4`.
- A gateway is a hub's USB device. Two hubs with a gateway each put two gateways on the air. A node keeps the first
  it hears while it lives and then takes the strongest, whichever hub it belongs to; its gateway HELLO then reaches
  that hub, which WELCOMEs it if it has its row. The hub list plays no part: an ESP-NOW-only node is on whichever hub
  its gateway hangs from.
- A gateway session opens only while there is no TCP session (`net.hpp:875`), so a gateway and a TCP session with
  different hubs do not fight: a TCP WELCOME from another run ends the gateway session, and at equal epochs the
  node closes it itself after 5 s of TCP.
- Each hub's bridge also hears the other hub's nodes; it counts them (`gateway_no_session`) and drops them.
- A hub's broadcasts flooded over the air carry its epoch; a node in a session drops another epoch's, and a node with
  no session adopts only a newer one (`air.cpp`, `adopt_hub_run`). Two hubs broadcasting to one network over two
  gateways is the hubs' link's subject (who broadcasts).
- `hubs_set` on a gateway answers `UNSUPPORTED`: its hub link is USB.

## 5. What is where

- **Schema:** `schema/capabilities/node.cap.yaml` (1.1).
- **Firmware:** `fr_net/include/fr/net/hub_plan.hpp` (new), `link.hpp` (`far_end`), `net.hpp`, `src/core/net.cpp`;
  `fr_net/src/esp/hub_resolve.hpp` (`resolve_entry`, `any_hub`), `hub_link.cpp`, `include/fr/net/esp.hpp`;
  `fr_id` (`fr_hubs`); `fr_core` (`core.cpp` `hubs_set`, `hubs_get`, `hub_busy`; `node_net.hpp` the wire helpers);
  `fr_posix` (`links`, `store`, `device`, `runner`).
- **Hub:** `registry/hubs.ts`, `registry/share.ts` (new), `enroll.ts`, `provision.ts`, `store.ts`, `network.ts`,
  `db.ts` (`devices.hubs`, `spreadHubEpoch`), `router/index.ts` (`refreshNet`, `info.net`, `info.chip_id`).
- **Protocol:** `ops/registry.ts` (`MULTI_HUB_OPS`, `device_enroll`), `types.ts`, `ops/network.ts`, `ops/hub.ts`.

## 6. Old and new together

- **The wire did not change.** No envelope, HELLO or WELCOME field moved; `fr.node` gained two commands (1.1). The
  catalog hash changed (0x616bf0f2 → 0x2efa5e5e), which a node session never checks; an SDK app built against the
  old one is sent the new catalog at its hello, as after any capability change.
- **Old firmware, new hub:** works as before. `device_hubs_set` and `device_hubs_get` answer
  `CAPABILITY_UNSUPPORTED`. The board has one hub, the one in its `fr_ident`.
- **New firmware, old hub:** works as before. Nobody sends the list; with no list the firmware's chain, timings and
  log lines are the old ones. The one difference is §c's rule, which needs two hubs to matter.
- **Old CLI or MCP, new hub** (and the reverse) refuse each other as after any op change: the registry hash moved.
- **Two hubs of one network must run the same version** (`device_share`, `network_join` and a same-network `for_hub`
  call ops an older hub does not have; the error says so).
- **Order on real boards.** Hubs first (nothing changes for any board). Then firmware, board by board, by OTA or a
  flash. A second hub's row for a board (`device_share`, or a same-network `--for-hub`) only **after** that board runs
  the new firmware if it is ever on one hub's cable and the other's Wi-Fi: with old firmware that is the loop of §c.
  A list is set last.
- **Can a board be stranded?** Not by a list: the old list is back after 60 s without a WELCOME, a reboot during a
  trial is the old list, and a flash drops any list. A list all of whose hubs are gone for good still ends each round
  with the advert, which finds any hub on the LAN. What can strand a board is `network_join --force` on a hub with
  boards of its own: they keep the old net id until flashed (ESP32) or given a new identity (Linux), and the answer
  names them.

## 7. Left for the hubs' link

- **The registry.** Rows reach another hub when a person shares them. A rename, a tag, a new list or a new board on
  one hub is not on the other until shared or read back (`device_hubs_get` brings a list in line; an alias pushed by
  one hub is overwritten by the other's at the next HELLO there if their revs differ). Bindings, the node directory
  and app state are per hub.
- **Routing.** An op goes to the hub it was sent to. A board that is on the other hub is `DEVICE_OFFLINE` here.
- **Epochs** that cannot meet, and with them the open halves of §a and §c.
- **Who is where.** A hub learns of a move by a session ending or starting. `hub_now.here` is all it can say.
- **OTA and streams across a move** (§b).
- **Leaving a network.** There is no op that makes a member its own registrar again.
- **Gateways and broadcasts with two hubs** (§d).

Nothing here stands in its way: the list and the plan are the board's and know nothing of how hubs talk; the registrar
is one kv entry and one check; a shared row is an ordinary row.

## 8. Tested, and not

**Tested.** Host C++ suite: `hub_plan_test.cpp` (the list's content, the rev rule, the reprovision rule, order,
failover time, failback and its hysteresis, back-off, busy, the trial, a list that names the current hub, no list);
`esp_hub_resolve_test.cpp` (an entry's chain, the advert as a step of its own, the old chain untouched);
`net_cmd_test.cpp` and `net_session_test.cpp` (§a, §c); `dispatch_test.cpp` (the commands' wire form);
`posix_links_test.cpp` (the POSIX runtime's own link: failover, the return, a hub that never WELCOMEs, a pushed list
kept, tried and refused, the identity file's keys). vitest:
`protocol-multi-hub.test.ts`; `provision-for-hub.test.ts` (the explicit identity, join, the registrar rule, share,
`fr.adopt`, both same-network `for_hub` cases); `interop-multi-hub.test.ts` (two hub processes and the C++ node:
join, share, the list over the air, the first hub stopped and started, a new default, a trial that fails, the list
taken away). One target build: `c3s-stepper` (esp32c3).

**Not verified:**

- **Nothing ran on an ESP32.** `hub_link.cpp`'s part (the probe socket in `select()`, the WELCOME peek, the handover
  from the core task, NVS) compiles and follows the tested plan, and was not executed. The same for `fr_id`'s
  `fr_hubs`.
- **`fr_posix` in part.** Its links and identity file run in the host suite (`posix_links_test.cpp`, on the wall
  clock, against two small hubs on loopback). `device.cpp` (the `fr.node` handlers, `attach_hub_link`) was compiled on
  macOS and not run; `runner.cpp`, which wires the stored list into the link, does not build on macOS (as before this
  step) and was only read. `qonu-node` is built in another repository against this component and was not rebuilt.
- **mDNS with two hubs on one LAN**, the timings on real Wi-Fi, a hub that is slow rather than gone.
- **The 300 ms probe lookup** on the `fr_net` task under load.
- **A stream across a failback**, and an OTA job whose board lands on the other hub after its reboot.
- **Gateways with two hubs.**
- **The dashboard** shows nothing of this yet (`hubs`, `hub_now` and `registrar` are in the ops' answers).
