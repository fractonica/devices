# MULTI-HUB-2: the hubs' link

> **A design, 2026-11-21. Steps 2.1 (link and presence), 2.2 (ops), 2.3 (one registry) and 2.4 (live data) are
> built.** All four are in the code and pass vitest on private hubs with the C++ node; step 2.4 has not run on the two
> real hubs, and one half of it needs firmware that is not written (a running stream holding a board at its hub,
> §17.6). §14, §15, §16 and §17 say what was built, where it differs from the text above them, and what is not
> verified. It follows [MULTI-HUB-1](multi-hub-m1.md) (one
> network, several hubs, a board's hub list), which runs on two real hubs and four devices. §11 lists what the owner
> still has to choose; everything marked *assumed* stands until they say otherwise.

## 0. What it is for

After MULTI-HUB-1 a board has one identity and moves between hubs by itself, but each hub knows only the boards that
are connected to it. An operation sent to the Mac's hub for a board that sits on the home hub answers
`DEVICE_OFFLINE`; a rename on one hub is not on the other; reaching the other hub's API takes an SSH tunnel.

With the hubs' link, **any hub of a network is a way in to every board of it**:

- `fr motor jog stepper-c3` at the Mac moves the motor while the board is on the home hub.
- The home hub's screen lists and controls a board that is on the Mac's hub at the moment.
- `fr ota mic-s3` at the Mac updates a board on the home hub with firmware the Mac built.
- A rename, a tag, a hub list or a new board made at one hub is at every hub.
- The open halves of MULTI-HUB-1 close: epochs that cannot meet, who is where, an OTA whose board lands on another
  hub, the short "online" a hub on the USB cable shows.

## 1. The shape, and two that were not chosen

**Chosen: the hub that has a board's session runs the operation; every other hub passes the operation on to it.**
The unit that crosses the link is an *op* (the same named operation with the same JSON the CLI, the dashboard and
MCP already send, `POST /api/v1/op/<name>`), not a frame of the node protocol.

Why this fits the code: every client reaches a hub through one dispatch point (`packages/hub/src/http.ts`, the
`/api/v1/op/:name` route over `HANDLERS`), and everything a board's session needs lives in one hub process: the hub
epoch and the sequence windows, the response cache, the clock offset, the stream tickets on port 7422, the OTA
server. An op passed on whole needs none of that shared.

Not chosen:

- **Relaying node frames** (hub B sends a CMD through hub A, as a gateway relays ESP-NOW nodes). The session state
  above belongs to one hub per session. Either B would have to share A's (two writers of one window) or the board
  would hold a second session, which MULTI-HUB-1 §c had to forbid. It rewrites the session layer and the user sees
  nothing more than with ops.
- **A board connected to every hub at once.** The firmware has one hub run at a time by design (one window, one
  epoch, one clock offset); an ESP32 would carry several TCP sessions and every service that talks to "the hub"
  (OTA, streams, UDP) would have to choose one. Failover would lose its meaning.

## 2. Words

- **Peer.** Another hub of this hub's network.
- **Holder.** The hub a board's session is with right now. A board has at most one (MULTI-HUB-1 §c).
- **Hub name.** A short name a hub has in its network (`uriel`, `lab`), unique in it, shown wherever a board's place
  is shown. Given at `network_join`; a hub's default is its host name without the domain.
- **Network key.** 32 random bytes every hub of a network holds, and nothing else does. Whoever has it is a hub.

## 3. The link

### 3.1 Transport and trust

- **A new listener on the LAN, port 7423**, beside the node ports (7421 TCP and UDP, 7422 HTTP). The API (7420, 7520
  on the UNO Q) stays on loopback and unauthenticated as it is.
- **TLS with the network key as its pre-shared key**, no certificates. Tried on 2026-11-21 with the Node both hubs
  run (24.22.0, OpenSSL 3.5.8): `node:tls` with `pskCallback` connects with `ECDHE-PSK-CHACHA20-POLY1305` (forward
  secrecy) and refuses a wrong key at the handshake.
- **The key** is made by the registrar the first time a hub joins it, kept in `secrets.json` (never in SQLite,
  results, logs or errors, as the Wi-Fi passwords), and handed to a joining hub in the `network_join` call. That
  call goes over the API as today, so the first contact between two hubs still needs loopback access to both (one
  SSH tunnel, once). `fr net rekey` replaces it on every reachable hub. *(Built in 2.1, without `rekey`: the key
  crosses sealed to a public key the joining hub makes for the call, §14.)*
- **What the key is worth.** A hub that holds it can run any op on any other hub: flash a board on its USB port,
  read a microphone, start an update. That is the same trust as one owner's machines already have in each other,
  and it is more than the node ports ask (nothing). The scope stays a home LAN: the port is not meant for the
  internet. *Assumed:* hubs reach each other by IP (one LAN, or a routed VPN); §11.

### 3.2 Who connects to whom

- **Every pair of hubs keeps one connection** (a network has at most a handful of hubs; a board's list holds four).
  There is no second hop: a hub never passes on what was passed on to it. "Reach a board on A through B or C" means
  B and C each reach A directly.
- Both ends may dial; of two connections between one pair the one the hub with the lower hub id dialled is kept.
  Reconnect with the node link's backoff (0.25 to 5 s). A heartbeat every 2 s; a peer silent for 6 s is *away*.
- **Finding a peer:** the member list (§4) holds each hub's host name and last address. A peer is resolved as a board
  resolves its hub (05 §5.12.5): the name, the address it last had, the address in the list. The `_fractonica._tcp`
  advert is not used: a Linux hub does not advertise (the UNO Q's `hub_status` says `advert: off`; `lan/advert.ts`
  is macOS's `dns-sd`).

### 3.3 What it carries

Length-prefixed messages on the one connection, JSON for control and raw bytes for data channels:

| Message | For |
|---|---|
| `hello` | hub id, hub name, net id, registry hash, hub epoch, the member list's version. *2.1* |
| `ready` / `refuse` | the answer to a hello: taken, or not and why (another network, a hub not in the member list). *2.1, added while building: §14* |
| `members` | the member list, whole, at its version (§4). *2.1* |
| `ping` / `pong` | the heartbeat of §3.2. *2.1* |
| `call` / `result` | one op by name with its input and the calling client (design c6 D18's origin), and its Result envelope |
| `presence` | a board's session here started or ended: device id, links, fw id, node epoch. *2.1* |
| `registry` | row changes and their revs (§5) |
| `event` | a hub event (a STATE, an EVENT, a job's progress) a peer subscribed to (§8) |
| `open` / `data` / `close` | a channel of bytes: a live stream's blocks, a file, a firmware image |

**Versions.** `call` needs the two hubs' registry hashes to be equal, as a CLI and its hub (the answer is
`HUB_VERSION_MISMATCH` naming the hub). `hello`, `presence` and `registry` are versioned on their own, so two hubs
on different versions still know who is where while one of them is being updated.

## 4. Membership

- The registrar keeps the **member list**: hub id (6 random bytes, made once per `FR_HOME`), hub name, host name,
  last address, link port, epoch slot (§9). It replicates like the registry.
- `network_join` (exists) additionally: gets the key, a hub name, a slot; the registrar tells the other members.
- New: `fr hub peers` (each peer: name, reachable, since, registry hash, boards held), `fr net leave` (§10),
  `fr net registrar --move-to <hub>` (§10).

## 5. One registry

MULTI-HUB-1 left rows to be shared by hand (`device_share`). With the link every hub holds every row of the network.

- **Addresses stay the registrar's** (`store.ts` `prepareIdentity`, unchanged). A member asked to provision or enroll
  a new board passes the allocation to the registrar over the link instead of refusing; with the registrar away it
  refuses as today.
- **Everything else can be changed at any hub.** A row carries a `row_rev` and the id of the hub that wrote it; the
  higher rev wins, the higher hub id on a tie. The alias and the hub list keep their own revs (`alias_rev`,
  `hubs.rev`), which the board already enforces. *Why not registrar-only:* the registrar may be a laptop that
  sleeps, and accepting and naming a new board on the home hub's screen must work without it.
- **Two boards given one alias on two hubs that could not see each other:** the later write keeps it, the other
  becomes `<alias>-<3 hex>` with the tag `renamed`, and both hubs say so in `hub_status` warnings.
- **A deleted row** leaves a tombstone with its rev, so an old copy does not bring it back.
- **Not replicated:** bindings and app state (per hub, §11), logs, the event history, jobs, artifacts (fetched when
  needed, §7), Wi-Fi passwords.
- **Retired inside one network:** `device_share` (a no-op that says so), the tag `moved` and a same-network
  `--for-hub`'s second enroll.

## 6. Who is where

- Each hub tells its peers when a board's session starts and ends. `device_list` and `device_get` at any hub answer
  `presence` for the whole network and `at: <hub name>`. `hub_now` (MULTI-HUB-1) gains `at`. *(As built in 2.1: `at`
  is the name of the hub that holds the session, this hub's own name included, and null when no hub this hub can see
  holds it; `presence` stays this hub's own until step 2.2 passes ops on, §14.)*
- A peer that is away makes its boards `unknown`, with `at` and "hub <name> is not reachable".
- **The USB blip goes** (MULTI-HUB-1 §c, open): a hub does not WELCOME a board on serial while a peer reports that
  board's TCP session. It still has the port: logs, flash, serial diag.
- **An update that ends on another hub** (MULTI-HUB-1 §b, open): the OTA job's hub sees the board come up with the
  new fw id at a peer and ends the job `completed`, not `device_offline`.

## 7. Passing an op on

### 7.1 The rule

Each op declares what it acts on (a new field of the op registry, so `REGISTRY_HASH` moves):

| `target` | Ops (examples) | Where it runs |
|---|---|---|
| `device` | `command_send`, `device_update`, `audio_level`, `camera_snap`, `ota_deploy`, `device_hubs_set` | at the holder; with no holder, here (the answer is `DEVICE_OFFLINE` as today) |
| `selector` | `command_send` with `tag:x`, `logs_read` | split by holder, each part run there, the answers merged; a row says which hub it came from |
| `fleet` | `device_list`, `job_list` | here, from the replicated registry and presence; `job_list --all-hubs` asks the peers |
| `port` | `port_list`, `flash_start`, `device_provision`, serial diag | here: a USB port belongs to one machine |
| `hub` | `hub_status`, `build_start`, `network_*` | here |

The dispatch point resolves the targets before the handler runs. A `call` that arrived over the link is never passed
on again (the holder changed in between: `DEVICE_OFFLINE` with `at` naming where the board is now). The caller's hub
tries once more at the new holder when the op is marked read-only or idempotent.

### 7.2 Naming a hub

Any op takes `at: <hub name>` (`fr --at uriel ports ls`, `fr --at uriel hub status`): run it on that hub. That is
how the `port` and `hub` ops of another hub are reached, and it replaces the SSH tunnel and `FR_HUB` for everyday
use. The first join and a hub that lost its key still need the tunnel.

### 7.3 Jobs, files, firmware

- **A job runs at the holder.** The hub that passed the op on remembers `job_id → hub` (ids are 48 random bits) and
  passes `job_get`, `job_wait`, `job_logs` and `job_cancel` on.
- **A file an op leaves** (a photo, a recording) is written at the holder, and the result says `at`. When the caller
  named a place for it (`--out`), the caller's hub pulls the file over a data channel when the job ends, so
  `fr audio record mic-s3 --out take.wav` leaves the file where the command ran.
- **Firmware.** The holder serves an update from its own port 7422. When the build is on another hub (the Mac builds,
  the home hub cannot), the holder first fetches the manifest and the image over a data channel, by fw id, and
  checks the hash. Images are 1.3 to 1.6 MB.
- **An op over two boards on two hubs** (`audio_monitor` from a mic to a speaker, a binding) is refused in this step
  with "both must be on one hub (mic-s3 is at uriel, spk-s3 at lab)".

## 8. Live data

- **Events.** A hub subscribes at each peer to the events of the network's boards (presence, STATE, EVENT, job
  progress) and publishes them into its own bus marked with `hub`. `/ws` (the dashboard) and `/app` clients then see
  one fleet. They are live only at the receiving hub: the row is stored at the holder, once. A wait that reads the
  backlog (`since`) asks the holder.
- **Streams.** `/app/stream` at hub B for a board held by A: B opens a data channel, A runs the stream as it does
  for its own client and sends each block down the channel, B hands the blocks to its client unchanged (`mjpg1`,
  PCM). One more hop for a camera at about 4 frames a second or 16 kHz audio is small.
- **A stream and a failback.** MULTI-HUB-1 left a stream running to the hub the board walked away from. *Assumed:* a
  running stream holds failback back as an OTA does (`hub_busy`), for at most 10 minutes; §11.

## 9. Epochs that cannot meet

Two hubs count their runs apart and may agree by chance (MULTI-HUB-1 §a and §c, open). The registrar gives each
member a **slot** (0 to 3) at the join, and a hub's epoch becomes `slot * 0x4000 + run`, with `run` from 1 to
`0x3FFF` and wrapping inside its slot. No frame changes. MULTI-HUB-1's `spreadHubEpoch` already puts the second hub
a quarter of the space away; the slot makes that a rule that survives any number of restarts.

One place compares epochs for *newer* instead of *different*: a flooded broadcast over ESP-NOW
(`fr_net/src/core/air.cpp`, `epoch_after`). With slots, "newer" between two hubs says nothing. That belongs to §10's
gateways and is not solved here.

## 10. Left open on purpose

- **Gateways and broadcasts with two hubs.** Each hub broadcasts to its own sessions; a fleet broadcast op is passed
  to every hub, and each sends its own. Two hubs' broadcasts flooded over one ESP-NOW channel, and the `epoch_after`
  rule above, stay as MULTI-HUB-1 §d left them. An ESP-NOW-only node is reachable through any hub (it has a holder).
- **Bindings and apps across hubs.** An app hosted on hub B sees a board held by A through the events of §8 and can
  command it through §7. A binding (board to board, run by a hub) whose two boards are on two hubs is refused.
- **Leaving.** `fr net leave`: the hub forgets the key and the peers, keeps its rows, and is its own registrar again
  under a new net id; its boards then need new identities, as at a forced join. `fr net registrar --move-to`: the
  member list and the allocator's high-water mark move to another hub, for a registrar that is going away.
- **More than one LAN.** No relay through a third hub and no hole punching.

## 11. The owner's choices

1. **Where the hubs are.** *Assumed:* all on one LAN, or reachable by IP over a VPN; never over the open internet;
   no hub that can only be reached through another hub.
2. **The registrar.** It is the lab Mac today, which sleeps. With §5 only new boards need it. `--move-to` could make
   the always-on hub the registrar. *Assumed:* it stays where it is until that is asked for.
3. **Streams hold failback** for up to 10 minutes (§8), or a board returns to its default hub on time and a live
   view through the link restarts by itself at the new holder. *Assumed:* hold.
4. **The order** (§12): passing ops on before the registry is replicated, because the four boards' rows are already
   on both hubs and reaching them is what was asked for.

## 12. Steps

Each step is usable by itself, is tested on private hubs first and then on the two real ones, and needs both hubs
on one version.

| Step | What works afterwards |
|---|---|
| **2.1 Link and presence** *(built, §14)* | key, member list, hub names, slots, the TLS link; `fr hub peers`; `device_list` at either hub says where every shared board is; no USB blip |
| **2.2 Ops** *(built, §15)* | `target` per op and the passing rule; `--at <hub>`; jobs; files with `--out`; firmware fetched from the hub that built it. *This is "reach a board on hub A through hub B"* |
| **2.3 Registry** *(built, §16)* | rows, tags, aliases, hub lists and new boards at every hub; a member gets a new board's address from the registrar over the link; `device_share` and `moved` retired inside one network |
| **2.4 Live** *(built, §17; "streams hold failback" is firmware and is not, §17.6)* | events from every hub in `/ws` and `/app`; waits for a board on another hub; stream relay (the home hub's screen shows the camera of a board that is on the Mac's hub), which follows a board that changes hub |

## 13. Tests

Two and three private hubs (`tests/sim/lib/private-hub.ts`) with the C++ node (`fr_net_node`), as
`interop-multi-hub.test.ts`:

- a wrong key and a hub of another network are refused at the handshake; two hubs on different registry hashes keep
  presence and refuse `call`;
- an op for a board on the other hub; a selector that spans both; the board moves between the call and the command;
  the peer goes away mid-op;
- a job passed on: get, wait, logs, cancel; a recording pulled to the caller's path;
- an update of a board on hub B from a build only hub A has; the board comes up on A afterwards;
- three hubs: nothing is passed on twice;
- registry: a rename on each side, both at once, an alias given twice while apart, a delete against an old copy;
- a stream relayed, the board failing over under it;
- equal run numbers on two hubs after many restarts never give one epoch.

On the real hubs: every screen of the UNO Q's HUB page against a board that is on the Mac's hub, and the Mac's CLI
and dashboard against boards on the UNO Q's hub, with no tunnel open.

## 14. Step 2.1 as built

Built 2026-11-21 in `packages/hub/src/peers/` and `packages/protocol/src/ops/peers.ts`. **Not yet on the two real
hubs.** No firmware changed.

### 14.1 What is where

| | |
|---|---|
| Hub id | kv `hub.id`: 6 random bytes as 12 hex, made at the first start of a hub.db (`peers/identity.ts`) |
| Hub name | kv `hub.name`; default the host name's first label, lower-cased; a label of at most 31 of `[a-z0-9-]`. `hub_name_set` (`fr hub name <name>`) |
| Epoch slot | kv `hub.slot` (0: the registrar). `db.ts` `nextHubEpoch` counts `slot * 0x4000 + run`, run 1 to 0x3FFF, wrapping inside the slot (`slotEpoch`); with no slot it counts the whole space as before. MULTI-HUB-1's `spreadHubEpoch` is gone |
| Network key | `secrets.json` `network_key: { net_id, key }` (64 hex), made by the registrar at the first `network_admit` (`peers/key.ts`) |
| Member list | table `hub_members` (`hub_id`, `name`, `host`, `addr`, `link_port`, `slot`, `joined_at`; this hub's own `seen_addr`, `seen_port`, `seen_at` are not replicated) and kv `hub.members_version` (`peers/members.ts`) |
| The link | `peers/link.ts` (TLS-PSK listener and dialers, the handshake, one connection per pair, heartbeat), `peers/wire.ts` (frames and messages). Port 7423 (`--peer-port`; a test hub, one not on node port 7421, takes any free port), bound where the node listeners are, and only while the hub holds the key |
| Presence, `at`, the serial rule | `peers/index.ts` (`createPeers`, HubContext `peers`); `router/index.ts` `#hello`, `yieldSerial`, counters `serial_hello_held` and `serial_yielded` |
| Admission | `peers/admission.ts`: `admit` (the registrar), `requestAdmission` and `storeAdmission` (the joining hub, from `registry/share.ts` `join`) |
| Ops | `network_admit` (`fr net admit`; a hub's join calls it), `hub_name_set` (`fr hub name`), `hub_peers` (`fr hub peers`), at the end of the registry (`PEER_OPS`). `network_join`'s input is unchanged; its answer gains `hub` and `members`. `hub_status` gains `hub {id, name, slot}`; `device_list` and `device_get` rows gain `at`; `hub_now` gains `at` |
| REGISTRY_HASH | `b6d669a67036` → `7113df84c91b` |

**Admission.** `network_join` on the joining hub makes an X25519 key pair for the call and sends the public half with
its hub id, name, host, address and link port to the registrar's `network_admit`. The registrar makes the key if it
has none, gives the hub the lowest free slot of 1 to 3 (it keeps slot 0; a fifth hub is refused), refuses a name
another hub has, and answers the member list and the key sealed to that public key (X25519 with an ephemeral key of
its own, HKDF-SHA256, AES-256-GCM, bound to the net id and the hub id). Nothing changes on the joining hub before
that answer: an older registrar (`HUB_VERSION_MISMATCH`), a taken name or a full network leave it as it was. Joining
the same hub again answers the same slot and list, and is how a hub that joined under MULTI-HUB-1 gets its key.

**The handshake on the link.** TLS 1.2, `ECDHE-PSK-CHACHA20-POLY1305`, PSK identity `fr-net-<net id>`: a wrong key
and a hub of another network fail the TLS handshake. Then each end sends `hello`; an end that takes it (its net id,
a hub id in its member list) answers `ready`, else `refuse` with the reason and closes. A connection is in use once
both ends said `ready`.

### 14.2 Where it differs from the text above, and why

- **`ready` and `refuse`** are not in §3.3. Without `ready` a hub counted a peer reachable on that peer's hello alone,
  and a hub the other end refuses (a third hub its peer has not heard of yet) flapped up and down at every retry.
- **`at` names this hub too** (§6 said null for this hub). One field then answers "where is it" on every hub, and
  null means nobody this hub can see has it. `hub_now.at` was MULTI-HUB-1's time of the board's `hubs_get` answer;
  that is `hub_now.asked_at` now.
- **`presence` is unchanged** in this step: `online` still means this hub can command the board now. §6's
  network-wide presence and `unknown` for an away peer's boards come with step 2.2.
- **The serial rule does one thing more than §6 says.** Besides not answering a serial HELLO while a reachable peer
  reports the board's TCP session, the hub ends a serial session it still has with that board when the report
  arrives (`device.offline`, reason `held by hub <name> over Wi-Fi`). The board gave that session up when it took
  the other hub's WELCOME; without this the hub on the cable showed it online until its silence timeout. A hub that
  has the board's TCP session itself ignores a peer's report (a board moves faster than the report of it).
- **The member list replicates by itself**, not "like the registry" (§4): a hub takes a list with a higher version
  from any peer it knows and passes it on. Only the registrar raises the version.
- **The registrar's own row** follows where it is at each start (its address, its link port), with the version
  raised when it changed. A member's row changes only at its next join; until then its peers find it by its host
  name or the address its link last came from.
- **Renaming a member** asks the registrar through its API (the URL of the join), so it needs the tunnel; over the
  link it needs step 2.2.
- **Not built from §3 and §4:** `fr net rekey`, `fr net leave`, `fr net registrar --move-to`.

### 14.3 Found while building

- **The board says HELLO on the cable once a second** while the hub there does not answer (`hello_retry_ms`; the
  firmware parks its serial link only after a WELCOME it refuses). Each is a `@fr1:` line in that hub's log store
  and one `serial_hello_held`. It works without a firmware change; a board that backs its serial HELLO off while its
  TCP session lives would be quieter. *Open.*
- **A third hub is unknown to the second until the registrar tells it.** With the registrar away between the third
  hub's join and its next contact with the second, the second refuses the third (`unknown_hub`) and the third
  retries every 5 s. §5's replication is the place to fix it.
- **Two hubs with one default name.** The default is the host name, so two hubs on one machine (tests) or two
  machines named alike need `fr hub name` before the join; the registrar's refusal says so.
- **A hub that joins a second network** takes the new key, slot and list; its old network's members are not told
  (`fr net leave` is not built).
- **macOS.** A hub the Mac started dials LAN addresses only with the Local Network permission of the app that
  launched it (`hub_status.lnp`); without it the other hub's dial still makes the pair's one connection.

### 14.4 Tested, and not

**Tested** (vitest, no board):

- `packages/hub/test/peers.test.ts`: the slot arithmetic for every counter value and slot, its wrap, two hubs
  restarting past the wrap, a MULTI-HUB-1 member's moved counter; the key in `secrets.json` and its sealing (another
  key pair, network, hub id or a changed byte does not open it; no error quotes it); the member list's rules (slots,
  a fifth hub, a taken name, a hub admitted again); the frames (cut anywhere, unknown types and fields, bad
  framing); the link between `PeerLinks` instances on loopback (messages both ways, both ends dialling at once six
  times over and one connection kept each time, only the higher id able to dial, a wrong key, another network's
  identity, a hub with no key, a hub not in the member list, a silent peer away after the away time, the next
  candidate address, the backoff, a peer taken back); the router's serial rule; two hubs' routers and peers
  parts in one process with a FakeNode on one hub's cable and the other's Wi-Fi, and the member list over the link
  (a newer list taken, one that leaves the hub out or moves its slot not); a join against a hub that answers no
  `network_admit` (`HUB_VERSION_MISMATCH`, nothing changed).
- `packages/hub/test/interop-peers.test.ts`: three hub processes and the C++ node. A hub alone; a MULTI-HUB-1 member
  (made by writing what that join left into its hub.db) joining again; the key in both `secrets.json` and in no
  answer, no file of either home and nothing either hub printed; joining again; restarts in each hub's slot and the
  link coming back; a third hub known to the second; renames; `at` on every hub for a board on hub A, through a
  failover to B and the return; hub A stopped (`at` null at once) and hub A frozen with SIGSTOP (away after about
  6 s); a fourth hub and a fifth refused.
- `packages/protocol/test/protocol-peers.test.ts`, `packages/cli/test/render-net.test.ts` (`fr hub peers`).

**Not verified:**

- **Nothing ran on the two real hubs**: not the join through an SSH tunnel, not TLS-PSK between the Mac's Node and
  the UNO Q's, not a `.local` name resolving from the Linux hub (it has two more addresses to try), not port 7423
  through the Mac's firewall or its Local Network permission.
- **The serial rule with a real board.** It is tested with a FakeNode, whose HELLO timing is not the firmware's. The
  order it relies on (the other hub's report reaching this hub within the about 4 s a serial handshake with no answers takes to count the board online)
  was not measured on a board; nor was a USB-UART bridge port.
- **TLS 1.3** is not offered: its wrong-key path was not tried.
- **Many boards.** A presence snapshot of a fleet is one message (up to 4096 boards by its schema); the largest
  tried is two.
- **A hub whose secrets.json does not parse** starts without its link and logs `peer_key_unreadable`; tested only
  as far as the read's error.
- **The dashboard** shows nothing of this (`at`, `hub`, `hub_peers` are in the ops' answers).

### 14.5 Onto the two real hubs

Nothing changes for a board, and no firmware is flashed. In order:

1. **Both hubs to this checkout, both restarted** (`fr hub restart`), the registrar first or second: it does not
   matter. The CLI on each machine with them (the registry hash moved). After this each hub runs as under
   MULTI-HUB-1; the member's `fr hub status` warns that it holds no network key.
2. **Names, if wanted**: `fr hub name <name>` on each. The defaults are the host names, which differ.
3. **On the member, the join again**, with the tunnel to the registrar's API open as for the first join:
   `fr net join --hub http://127.0.0.1:<the registrar's API port>`. The registrar makes the key and takes slot 0; the
   member gets the key, its name and slot 1. Its epoch counter is already in slot 1 (MULTI-HUB-1 put it a quarter of
   the space away), so the answer asks for no restart; if it does, restart the member.
4. **`fr hub peers` on both**: each shows the other reachable. If not, the line under the table says why; one
   direction of port 7423 between the two machines is enough.

What can go wrong, and what it costs:

- **The join fails** (the registrar not updated or not restarted, the tunnel closed, a name clash): nothing changed
  on the member. Fix and join again.
- **Port 7423 closed both ways:** no link. Both hubs work as under MULTI-HUB-1; `at` is null for boards on the other
  hub, and a board on one hub's cable and the other's Wi-Fi blips as before.
- **`secrets.json` lost on the registrar:** it makes a new key at the next join, and the other members' links fail
  their handshake ("different network keys") until each joins again. On a member: join again. Boards are not
  touched either way: node links do not use the key.
- **A board cannot be stranded by this step.** The only thing a hub now withholds from a board is its WELCOME on a
  USB cable, and only while another hub that it can reach reports the board's TCP session; that report ends when the
  board's session there ends (3.5 heartbeat intervals of silence at the latest) or that hub is away (6 s). The board
  repeats its HELLO every second meanwhile.
- **Going back** to the version before: the older hub ignores `hub_members`, the `hub.*` kv entries and
  `network_key`; a hub that got a slot keeps counting where its counter is (the older `nextHubEpoch` counts the
  whole space from it). The older CLI is needed with it.

## 15. Step 2.2 as built

Built 2026-11-21 in `packages/hub/src/peers/` and `packages/protocol/src/ops/common.ts`. **Not yet on the two real
hubs.** No firmware changed, no op was added and no op's input changed.

### 15.1 What is where

| | |
|---|---|
| `target` | `OpDef.target` (`device`, `selector`, `fleet`, `port`, `hub`), with `boards` (the input fields that name boards; default `device` or `selector`), `across` (a selector op's rule: `split`, `one`, `live`, `here`) and `files` (`out` and `in` path fields). In every op of the registry; `protocol-targets.test.ts` lists the registry by target and fails for an op without one |
| REGISTRY_HASH | `7113df84c91b` → `8910d0ce4075`. It now covers target, boards, across and files. `REGISTRY_INPUTS_HASH` (names and inputs alone, the old formula) is still `7113df84c91b` |
| `call`, `result` | `peers/wire.ts` (messages), `peers/calls.ts` (ids, timeouts, a peer away mid-call, JSON over 256 KiB as data frames) |
| Data channels | `open`, `accept`, `ack`, `close` and frame kind 2 (`u32 channel \| bytes`, 64 KiB a frame): `peers/channels.ts`; `link.ts` `sendData`, `drained`, `onData` |
| The rule | `peers/passing.ts` `runOp`: called by the one dispatch point, `http.ts` `POST /api/v1/op/:name`. `serve` runs a call that arrived |
| Naming a hub | header `X-Fr-At` (`AT_HEADER`); CLI `fr --at <hub> <command>` (`client.ts` `takeAtHub`); MCP tool argument `at_hub`; OpenAPI lists the header |
| Presence for the network | `peers/index.ts` `presenceView`, `netPresence`: `device_list` and `device_get` rows (`presence`, `at`, `presence_reason`) |
| Jobs | table `peer_jobs` (`peers/remote-jobs.ts`); `passing.ts` `jobOp`, `settleJob`, `follow` |
| Files | `peers/files.ts`: the spool `FR_HOME/storage/.peers/<id>/`, offers, the paths of a pulled file; channel kinds `spool` and `offer`; link services `spool_list`, `spool_drop` |
| Firmware | `peers/firmware.ts`: link service `artifact_get`, channel kind `blob`; `ota/orchestrator.ts` `seenAtPeer` |
| Rows | `peers/rows.ts` `adoptRow` |
| `/app` | `apps/socket.ts` sends a `cmd` through `passing.ts` `commandAnywhere`; `apps/stream.ts` refuses a stream of a board held elsewhere and says it is step 2.4 |
| Counters | `hub_peers.counters`: the link's, `calls_*`, `results_late`, `bodies`, `pulls*`, `serves*`, `bytes_in`, `bytes_out`. `hub_status` warns of a peer on another registry hash |
| Test hooks | `FR_TEST_PEER_REGISTRY_HASH` (the hash a hub tells its peers) and `FR_TEST_PEER_HOLDER` (`<device id>=<hub name>`: the hub this hub takes for a board's holder), both honoured only by a hub whose node port is not 7421 |

**The rule, as `runOp` applies it.** With `X-Fr-At`: that hub (mode `at`: run it there whatever it acts on); this hub's
own name runs it here. Without: `job_get`, `job_wait`, `job_logs`, `job_cancel` follow the job; a `device` op goes to
the reachable peer that reports the board's session, with each board field rewritten to `id:<device id>` (mode
`holder`); a `selector` op by its `across`; everything else runs here. Nothing is sent to a peer that is away
(`HUB_UNREACHABLE`, retryable) or whose hello named another registry hash (`HUB_VERSION_MISMATCH`). The hub that serves
a `holder` call for a device op first checks that it still holds the board, and answers `DEVICE_OFFLINE` with
`details {moved: true, at}` when it does not; it never passes a call on. The caller then runs a read-only or
idempotent op once more where `at` says (here when `at` is its own name or null), and returns the error for any other.

**`across`, per op.**

| `across` | Ops | What happens when a peer holds some of the boards |
|---|---|---|
| `split` | `command_send`, `input_simulate` | this hub's part (the boards it holds and those on no hub) and each peer's part run at once; the `results` rows are merged in the selector's order, each with `at`. A part that failed as a whole gives its boards rows with `status: failed` (or `offline`) and the error |
| `one` | `logs_read`, `events_read`, `latency_stats`, `ota_deploy`, `message_send`, `display_snapshot` | passed whole to the one peer that holds the boards (boards on no hub are left out, with a warning); refused (`CAPABILITY_UNSUPPORTED`, `details.boards[]`) when the boards are on more than one hub |
| `live` | `wait_for_log`, `wait_for_event`, `wait_for_device`, `logs_assert` | refused: "events and logs do not cross the hubs' link yet (step 2.4)", with `fr --at <hub> …` |
| `here` | `deploy` | refused: it builds from this hub's sources; `fr build`, then `fr ota` |

`all` to `logs_read`, `events_read`, `latency_stats`, `wait_for_log`, `wait_for_event` and `logs_assert` is no filter
there, so it stays this hub's own store, as leaving the selector out does.

**The answer.** The other hub's whole envelope, with `at` added and its own `cursor`. A job gets `at`. `device_update`,
`device_hubs_set`, `device_hubs_get` and `device_adopt` also write what they answered (alias, `alias_rev`, tags, the hub
list) into this hub's row of the same device id.

**Jobs.** `received` stores `job_id → hub` for every job a peer answers. The four job ops ask that hub; an id this hub
never saw is asked of each reachable peer (`job_get`) and remembered. A job that left files is followed in the
background (`job_wait` in 60 s steps, for at most 6 h, again after a restart) and its files are pulled once, by
whichever comes first: the follower, or an answer for the job.

**Files.** The calling hub takes `out` and `in` paths out of the input and sends their file names (and a token for an
`in` file). The hub that runs the op puts an `out` at `spool/o-<field>/<name>` and first pulls an `in` to
`spool/i-<field>/<name>`. After the op (or its job) completed, the calling hub lists the spool, pulls every file to the
directory of the path asked for, rewrites the result's paths to its own and drops the spool. A file with no path asked
stays at the other hub, and the envelope's `at` says where.

**Firmware.** For `ota_deploy` without `build`, the calling hub names the newest debug build of the boards' profile
when it has one. The hub that runs any op with a `build` it lacks fetches the manifest and the blobs from the calling
hub, checks each blob against its name, registers the artifact and serves the image from its own 7422. An OTA child
in REBOOTING or VERIFYING whose board a peer reports with the target firmware ends SUCCEEDED (§6's open point).

### 15.2 Where it differs from the text above and from the brief, and why

- **`job_list --all-hubs` is not built.** It needs a new input field on `job_list` (or a new op), and either moves the
  hash of names and inputs that seventeen protocol tests pin by checkpoint. `fr --at <hub> jobs ls` lists another
  hub's jobs.
- **`accept` and `ack`** are not in §3.3's table. `open` needs an answer that says the size before the bytes, and the
  provider needs the receiver's credit; kind 2 frames are the table's `data`.
- **The cursor of a passed-on answer is the other hub's**, not the asked hub's. A cursor is one hub's own space, and
  what the op caused is after that hub's cursor. A wait `since` it has to be asked of that hub (`--at`).
- **`at` on the Result envelope** is new (§7 put `at` in results only). One field then says where any op ran.
- **`REGISTRY_INPUTS_HASH`** is new: the hash split in two so the pinned checkpoints of the names and inputs stay
  what they were, and the tests that compared their own formula with REGISTRY_HASH compare with it.
- **Two boards on two hubs, boards spread for a `one` op, a wait for a board elsewhere** answer
  `CAPABILITY_UNSUPPORTED` with `details.boards[]`. No error code was added.
- **`audio_monitor` is a one-board op** in the registry (a microphone heard on a speaker of the same board), not
  §7.3's two-board example. The two-board ops are `binding_set` and `latency_probe`.
- **Targets that differ from §7.1's examples.** `logs_read` is `one`, not split: it answers one page of one hub's
  cursor. `diag_exec` is `port` as the table says, so `fr diag <alias>` for a board held elsewhere needs `--at`.
  `ota_status`, `binding_list`, `client_generate` and the `cell_*` ops are `hub`: they read this hub's own tables.
- **Input files** (`audio_play`, `storage_put`) cross too, the other way, though §7.3 names only files an op leaves.
  Without it those ops would have failed at the other hub with "no such file".
- **`presence` in `device_list` and `device_get`** is the network's (§6), and so are `online` and `offline` in
  `device_list`'s selector. Every internal rule still reads the router's own presence. `hub_now.at` stays null for a
  board whose hub is away; the row's `at` names that hub, as §6 says.
- **`/app` commands are passed on**; the brief asked only that `/app` reach the dispatch point or fail clearly.
- **`--at` is taken before the command only**, because `fr time --at <instant>` exists. It is refused with commands
  that act on this machine (`fr hub start|stop|restart|compact`, `doctor`, `gen`, `time`, `mcp`, `serial`, `display
  window`).

### 15.3 Found while building

- **2.1's `FrameDecoder`** joined its buffer with every chunk: one copy per TLS record of a frame. It keeps the chunks
  and joins once per frame now. With 64 KiB data frames the old one would have cost four copies a frame, not megabytes.
- **A hub told to stop answers first.** SIGTERM cancels its jobs, so an op that waits for one answers "cancelled"
  before the link closes: the caller sees a cancelled job, not `HUB_UNREACHABLE`. Only a hub that dies or falls silent
  gives that (after up to 6 s).
- **A read op for a board whose hub has just fallen silent** hangs until the link is given up (up to 6 s), then
  answers `HUB_UNREACHABLE`; the next one runs here and shows the board `unknown`.
- **A call written to a pair's first connection just before the second took its place** is lost and times out. Both
  ends dial only when a link comes up, so the window is a few milliseconds at a start.
- **`at` and `presence` were each hub's own in 2.1's and MULTI-HUB-1's interop tests.** `interop-multi-hub.test.ts`
  now asks each hub by its own name; `interop-peers.test.ts` expects the passed-on answers and `unknown` with a reason
  for a board whose hub is away.
- **An `out` under FR_HOME is not checked further by the display ops** (`display_snapshot --out FR_HOME/secrets.json`
  is taken, here and through the link alike). Not changed in this step. *Open.*
- **`storage_put` and `storage_get` have rules about the calling machine** (no file of the hub's own as a source,
  copies only under `FR_HOME/storage` and over nothing) that the other hub cannot check: the calling hub applies them
  before it sends anything, and applies the source rule to every `in` file.
- **The registries are two.** A board passed by its device id is found at the holder because a session makes a row.
  A board named in the same call that the holder has no row for is `NOT_FOUND` there. Step 2.3. *(Gone with step
  2.3: every hub holds every row, §16.)*

### 15.4 Tested, and not

**Tested** (vitest, no board):

- `packages/hub/test/interop-pass.test.ts`: four hub processes and the C++ node. An op for a board on the other hub
  (`device_get`, `audio_level`) both ways; `device_list`; a selector over two hubs (`command_send` split and merged,
  `logs_read` refused and passed, `events_read`, a wait refused as step 2.4 and run with `--at`, `deploy` refused);
  a tag and a hub list changed at the holder and in the caller's row; `X-Fr-At` for another hub, this hub and an
  unknown name; two hubs on different registry hashes (presence kept, `call` refused both ways, a split's rows);
  the board moved between the resolve and the call, with three hubs (one more try for `device_get`, none for
  `clock_sync`, the middle hub passing nothing on); a recording as a job: get, logs, wait, cancel, the other hub's
  list, a hub that never saw the job, the file at the caller's path and the spool gone; a WAV of the caller's machine
  played at the other hub; the calling hub restarted while the job ran; an update of a board on hub B from a build
  only hub A has; two boards on two hubs refused; the other hub frozen mid-op; the key and a recording's bytes in
  nothing a hub printed.
- `packages/hub/test/peers-pass.test.ts`: `call` and `result` between two links (the envelope, a 1.2 MB input and
  answer, a timeout and its late answer, a peer away mid-call for a read op and for another); data channels (size and
  SHA-256, an empty file, a refusal, 3 × 50 MB with a 40 ms ping and a 200 ms away time, a call answered while a file
  crosses, a transfer cut mid-way, a stall, a receiver that gives up); the spool and its paths; `peer_jobs` across two
  openings of one hub.db; `adoptRow`; `takeAtHub`.
- `packages/protocol/test/protocol-targets.test.ts`; `packages/hub/test/ota.test.ts` (a board back at a peer);
  `packages/cli/test/cli.test.ts` (`fr --at`), `mcp.test.ts` (`at_hub`).

**Not verified:**

- **Nothing ran on the two real hubs**: not a call between the Mac's Node and the UNO Q's, not a file or an image
  over a real LAN, not `fr --at` against a hub on another machine.
- **A large file between two machines.** 150 MB crossed on loopback at about 200 MB/s; over Wi-Fi the heartbeat
  shares the link for much longer, and that was not run. A slow disk at the receiver was not simulated either.
- **`camera_snap`, `camera_stream` (a directory of frames), `csi_stream`, `scale_watch`, `storage_get`,
  `display_snapshot` through the link.** They use the same spool and pull as `audio_record`; only `audio_record` and
  `audio_play` ran end to end. A directory is covered by the spool's unit test, not by an op.
- **An OTA job ending at a peer with a real failover.** `seenAtPeer` is tested on the orchestrator with a fake node;
  no test makes a board restart at one hub and come up at another.
- **`input_simulate` split over two hubs, `message_send`, `latency_stats`, `binding_set` at a holder,
  `device_adopt`.** They take the same path as the ops that were run.
- **`/app` commands for a board at another hub** (`commandAnywhere`): typechecked, the `/app` suites pass, no test
  with two hubs.
- **`fr deploy` for a board on another hub** is refused; the refusal ran, a build then `fr ota` from a real checkout
  did not.
- **The dashboard** shows `presence` from `device_list` (a peer's board reads online) and its buttons call ops, which
  are passed on; its live frames (`/ws`) are still this hub's own. Not looked at in a browser.

### 15.5 Onto the two real hubs

Both hubs run 2.1 and are linked. No join again, no new key, no firmware.

1. **Update both to this checkout and restart each** (`fr hub restart`), in either order, and the CLI on each machine
   with them. The restart makes the `peer_jobs` table; nothing else in hub.db changes.
2. **`fr hub peers` on both**: REGISTRY must read the same on both rows. `fr hub status` warns when it does not.
3. **From the Mac, with no tunnel:** `fr devices ls` (the home hub's boards read online, `at` its name),
   `fr devices get <a board there>`, `fr --at <home> hub status`, `fr --at <home> ports ls`, then
   `fr audio level`, `fr audio record … <a path under ~/.fractonica>`, `fr camera snap … --out …`, `fr ota <board>`.

**While one hub runs 2.1 and the other 2.2.** The link stays up and both still say who is where: `hello`, `members`
and `presence` did not change. Their registry hashes differ, so the 2.2 hub passes nothing (`HUB_VERSION_MISMATCH`
naming the other, for an op on a board there and for `--at`), and the 2.1 hub passes nothing because it cannot. On the
2.2 hub `fr devices ls` already shows the other hub's boards as online, and `fr devices get` for one of them answers
`HUB_VERSION_MISMATCH` until the other is updated: use the tunnel or `FR_HUB` meanwhile, as before. A 2.1 hub drops a
`call` or an `open` as an unknown type, but none is sent to it.

**What could leave a hub or a board unreachable.**

- **A board: none.** This step sends nothing new to a board, and changes nothing about which hub answers its HELLO.
  The serial rule is 2.1's.
- **A hub's own API: none.** Port 7420 (7520) and the tunnel work as before. `fr --at <this hub's name>` and `FR_HUB`
  reach a hub directly whatever the link does.
- **A board through the link: when the hashes differ** (above), when port 7423 is closed (as in 2.1: `at` is null and
  ops run here, answering `DEVICE_OFFLINE`), or **when the peer reports a board it cannot command** (a session that is
  `suspect`): the op is passed and answers what that hub answers.
- **An op that used to answer from this hub now answers from the other.** `fr devices get <board at the other hub>`
  shows that hub's row (its tags, its USB port) and returns that hub's cursor. A script that passed such a cursor to a
  wait on this hub gets `HUB_RESTARTED` or a wait from the wrong place: name the hub (`--at`), or ask each hub by its
  own name.
- **`fr logs`, `fr events`, `fr ota` with a selector over both hubs' boards** are refused where 2.1 ran them here for
  the boards this hub knew. `fr logs all` and `fr events` without a selector still read this hub's own.
- **`fr wait …` for a board at the other hub is refused** where 2.1 waited here until the timeout. `fr --at <hub> wait`.
- **Going back to 2.1:** the older hub ignores `peer_jobs` and the spool directory; jobs started through the link stay
  on the hub that ran them (`fr --at` is gone: use the tunnel).


## 16. Step 2.3 as built

Built 2026-11-21 in `packages/hub/src/registry/sync.ts`, `registry/alloc.ts` and `peers/registry.ts`. **Not yet on the
two real hubs.** No firmware changed, no op was added and no op's input changed: `REGISTRY_HASH` is still
`8910d0ce4075` and `REGISTRY_INPUTS_HASH` `7113df84c91b`, so a hub of step 2.2 and one of step 2.3 still pass ops to
each other.

### 16.1 What is where

| | |
|---|---|
| What is shared | `registry/sync.ts`. Of a `devices` row: `addr`, `net`, `network`, `provisioned`, `tags`, `board`, `profile`, `chip`, `role` (the *row*), `alias` and `alias_rev`, `hubs` (the hub list), `fw_id`. This hub's own, never sent: `last_seen`, `last_epoch`, `created_at`, the provision record (what this hub wrote into an fr_ident, the probe, `for_hub`), the USB port, presence. Rows that are not the network's stay local too: a board seen only through HELLO, a board of another net id |
| Revs | Table `registry_sync` beside `devices` (which has no new column): `row_rev`, `row_hub` for the row, `alias_at`/`alias_hub`, `hubs_at`/`hubs_hub`, `fw_at`/`fw_hub` for the three other parts, the stamped values (`core`, `alias_v`, `hubs_v`, `fw_v`), `gone` for a tombstone, `hash`. A rev is a hybrid clock (kv `registry.clock`): ms of the wall clock, never going back, plus one when two writes meet, never below a rev seen from a peer. kv `registry.sync_net`: the net id the table belongs to |
| Stamping | `scan`: compares `devices` with the stamped values and stamps the parts that differ as this hub's writes; a row of the network gone from `devices` becomes a tombstone. Run every second, after every mutating op (`passing.ts` `wrote`), at `device.provisioned` and `registry.drift`, and before any copy from a peer is merged |
| The merge | `applyRows`: each part by its own order (below), the two rules above the revs, the effects and the conflicts it reports |
| The message | `peers/wire.ts` `RegistrySchema`: `registry {v: 1, k: digest \| rows \| state, hash, n, digest?, rows?}`; `hello.registry: 1` |
| The link part | `peers/registry.ts`: a digest when a link comes up and every 30 s, the answers, a change sent at once, a merged row passed on, the per-peer state, the events and the alias push a merge causes, warnings and counters. Created by `peers/index.ts`; `Peers.registry {flush, replicates, status}` |
| Addresses | `registry/alloc.ts`: `ensureAddress` (a member) and `allocate` (the registrar), the link service `addr_alloc` (`passing.ts` `SYS`). Called from `device_enroll` (`enroll.ts` `enrollOp`), `device_provision` (`provision.ts`), `device_adopt` (`app-host/adopt.ts`) and an identity flash (`flashing.ts`) |
| `device_share`, `--for-hub` | `registry/share.ts` `linkedReplica`: the hub at a URL when this hub replicates with it (its `hub_status.hub.id` is in the member list, its link is up, its hello said `registry`). `share` then answers `replicated: true` and sends nothing; `provision.ts` then enrolls nothing there and names that hub in fr_ident from the member list |
| Passing | `peers/passing.ts`: `received` no longer writes the answered row by hand unless the peer does not replicate (`rows.ts` `adoptRow`, kept for a hub of step 2.2) |
| A board with a newer alias | `registry/store.ts` `touchHello`: in a network of several hubs the row follows a board whose alias has a higher `alias_rev` (§16.2) |
| A delete | `registry/store.ts` `forgetDevice` (no op calls it yet, §16.2); any `DELETE` from `devices` is found by `scan` |
| Seen | `hub_peers`: per peer `registry {speaks, in_step, rows, sent, received, taken, conflicts, unanswered, heard_at}`, the hub's `registry {rows, tombstones, hash, conflicts[]}`, counters `registry_*`; `fr hub peers` prints a `registry:` line. `hub_status` warnings. `device_get.replication {row_rev, row_hub}` |
| Test hooks | `FR_TEST_PEER_REGISTRY` (`off`: no `registry` in the hello, none taken, as a hub of step 2.2; `mute`: says it and answers nothing) and `FR_TEST_PEER_REGISTRY_TAP` (a file every `registry` message is appended to), both honoured only by a hub whose node port is not 7421 |

**A row on the wire.**

```
{ id, row: [rev, hub],
  core:  { addr, net, network, provisioned, tags, board, profile, chip, role },
  alias: { at: [rev, hub], alias, alias_rev },
  hubs:  { at: [rev, hub], list: { rev, hubs: [{host, ip}], set_at } | null },
  fw:    { at: [rev, hub], fw_id } }
{ id, row: [rev, hub], gone: true }                      a tombstone
```

**The merge rule.** A copy from a peer is merged part by part; the higher wins:

| Part | Order |
|---|---|
| the row (`core`) | `row_rev`, then the hub id. A tombstone is a row write: it beats an older row and loses to a later one |
| `alias` | `alias_rev`, then its rev (the later write), then the hub id |
| `hubs` | its rev (the later write), then the list's own `rev`, then the hub id |
| `fw` | its rev, then the hub id |

Above the revs:

- **An address is never replaced by another one.** A copy whose `addr` or `net` differs from a non-null one this hub
  holds is not taken, whichever is newer: `core` stays as it is on both hubs (alias, hub list and firmware still
  merge), both hubs report it (`registry.conflicts`, a `hub_status` warning naming both addresses), and the two stay
  "not in step" until a person makes them agree. A copy whose address another device holds here, or whose net id is
  not this network's, is not taken either.
- **Two boards, one alias.** The one whose alias has the later rev keeps it; a row that is this hub's own (seen only)
  always gives way; with equal revs the lower device id keeps it. The other becomes `<alias>-<3 hex of its id>` (more
  digits while that is taken too) with `alias_rev + 1` and the tag `renamed`. Every hub that sees both rows makes the
  same rename, so the hubs agree without asking each other.

**Rows from before this step** have no rev. The first scan under 2.3 gives them one: `row` and `alias` rev 1 on the
registrar and 0 on a member, `hubs` rev 0 on both (so the list's own `rev` decides), `fw` the row's `last_seen` in ms
(so the hub that saw the board last decides). Where two old copies agree nothing is written; the member's copy then
carries the registrar's rev.

**Catching up.** Each end sends its digest (`[device id, hash]` for every row and tombstone) when a link comes up. A
hub answers a digest with the rows it holds otherwise than the sender, or that the sender lacks; the sender of those
merges them and answers with the rows it then still holds otherwise; `state` (only the hash and the count) ends an
exchange and is never answered. A row is sent to a peer once per connection and content, so two hubs that disagree
for good (an address) do not send it back and forth. Sized for a few hundred rows: 64 rows a message, a digest of at
most 8192 entries, about 40 bytes each.

**Addresses.** A member's `ensureAddress` calls `addr_alloc {device_id, alias?, profile, board, chip, role?}` at the
registrar (a `call` of mode `sys`: no registry hash is compared). The registrar runs its own `prepareIdentity` in one
SQLite transaction and answers `{device_id, addr, net, alias, alias_rev, epoch_floor}`: two members that ask at once
get two addresses, the same board asked for twice gets one, and an alias another board of the network holds is
refused there (the registrar holds every row). The member stores exactly that identity (`storeSharedIdentity`) and
goes on as it always did for a board that has an address. The registrar's row is `provisioned: false` until the
member's flash or enrollment is done and replicates back.

### 16.2 Where it differs from §5 and from the brief, and why

- **Four revs per row, not one.** §5 has one `row_rev` and says the alias and the hub list "keep their own revs".
  With one rev for everything a tag set on one hub while another renamed the board would lose one of the two, and a
  HELLO that changes `fw_id` at the holder would undo a tag set elsewhere. So the row, the alias, the hub list and
  the firmware id are ordered apart.
- **A rev is a clock, not a counter.** "The later write keeps it" (two boards, one alias) compares writes of
  different rows on different hubs, which a counter per row cannot order. The hybrid clock is the wall clock when
  the hubs' clocks agree and still one order when they do not; it is never used as a time.
- **The alias is ordered by `alias_rev` first**, then by the later write. `alias_rev` is what 2.2's `adoptRow`
  compared and what a board is told, and it never goes back on any hub. A hub that renamed a board twice while apart
  wins over one that renamed it once later.
- **The hub list is ordered by its own rev first**, not by the list's `rev`. The list's `rev` goes back (a list on
  trial that the board dropped, a flash that takes the list away), and a registry that only takes a higher one would
  keep the dropped list at every other hub.
- **An address that differs changes on neither hub.** The brief says the registrar's stays and a warning says so; the
  member's stays too, because a hub cannot know which address the board carries in its flash, and a directory that
  maps the wrong address does harm. The warning names both; the manual says how to take the registrar's.
- **No op deletes a row today.** The brief asks to make that op replicate; `device_forget` is on the roadmap behind
  the confirmation tier (09 §9.4, roadmap M2-C7), which is not built, and adding it moves both hashes. Built instead:
  `forgetDevice` in the store, and tombstones for any row of the network that disappears from `devices`, whoever
  deleted it. The op is then one call. Tombstones live 365 days.
- **Writers are not hooked; `devices` is compared.** Every write path (ops, jobs, HELLO, `adoptRow`, a hub of an older
  version running on this hub.db for a while) replicates without knowing of this step, at the cost of up to a second
  for a writer that says nothing (ops and provisioning events flush at once).
- **Boards seen only are not replicated.** "Every row of the network" is every row with an address of this net id; a
  board that only said HELLO to one hub is that hub's observation. A row keeps replicating once it was the
  network's (also after it lost its address: a board flashed for a hub of another network).
- **`device_share` is a no-op only toward a hub this hub replicates with.** Toward a hub of the same network that does
  not replicate (step 2.2 during an update, a member that joined before the link and holds no key) it gives the row
  by hand as before. Toward another network it was always refused, and still is.
- **The second enroll of a same-network `--for-hub` is retired the same way**: nothing is enrolled at a hub that
  replicates; the old path stays for one that does not.
- **The tag `moved` is not removed from the code.** It still marks a board flashed for a hub of *another* network.
  Inside one network it goes two ways: the first scan takes it off a provisioned row of this network; and a row seen
  only and tagged `moved` (flashed for a hub that has since joined) takes the network's row when a peer sends it,
  loses the tag, and its provision record's `for_hub` becomes `shared_with`, so the port policy adopts its port again.
- **With the registrar away the code is `HUB_UNREACHABLE`** (retryable), not `INVALID_ARGS`; the message keeps "only
  that hub, the network's registrar, hands out addresses" and adds that it is not reachable. A context with no link
  part at all (some unit tests) refuses with the old `INVALID_ARGS`.
- **The hello says `registry`.** The brief asks for a sensible answer to a peer that never answers; a hub of step 2.2
  is not even asked (no message it would drop, no counter moving there). A peer that says it and answers nothing is
  still handled: counted, shown, warned about after three digests, then asked every fifth period.
- **`adoptRow` stays, for a peer that does not replicate**, so a 2.3 hub beside a 2.2 hub behaves as two 2.2 hubs did.
- **A board that carries a newer alias than the row** (not in the brief). Before, the hub's name always won at a
  HELLO, with a higher `alias_rev`. With several hubs that undoes a rename made at another hub while this one was
  away: the board fails over to the stale hub, is renamed back, and the old name then wins everywhere. Now, in a
  network of more than one hub, the row takes the board's alias when its `alias_rev` is higher, valid and free here.
  A hub that is alone behaves as before.
- **A Linux node connected under another identity** when its row arrives was handed the new identity by
  `device_share` (MSG `fr.adopt`). Replication does not do that by itself: `fr devices adopt <node>` on the hub it is
  connected to does (it asks the registrar for the address).
- **Not done: the member list.** §4 says it replicates "like the registry", and §14.3 left "a third hub is unknown to
  the second until the registrar tells it" for this step. The member list still replicates by itself (2.1's rule:
  a higher version from any peer is taken and passed on); nothing of it moved into the `registry` message.
- **What a merge announces.** A new provisioned row, and a row that becomes provisioned (an address the registrar
  gave, then the member's flash), is published as `device.provisioned` (with `replicated: true`), so the router
  sends the DIRECTORY and apps hear `device.added`; a new alias as `registry.drift`. That is what makes
  a replicated board usable at once, and it means boards connected to a hub that gains rows receive a DIRECTORY.

### 16.3 Found while building

- **The firmware takes any `alias_rev` in `set_alias`** (`fr_id_set_alias` stores what it is sent; only the load of
  `fr_ident` against the override compares revs). "The board enforces `alias_rev`" is in fact the hub's rule at a
  HELLO (`router` pushes when its rev is not lower). Nothing here depends on the board refusing a rev. Not changed.
- **A row can be asked for a few ms before it arrives.** A board enrolled at hub A and named at hub B in the same
  instant is `NOT_FOUND` at B until the row crosses (one message).
- **A pair's second connection replacing the first** resets what was told on it: `in_step` reads null for a moment.
- **An address given and never used.** `addr_alloc` leaves a row with an address and `provisioned: false` at every
  hub when the member's flash then fails, as a failed provisioning leaves one on a hub that is alone. The next
  attempt for that board gets the same address.
- **The port policy follows the registry.** In mode `adopted` a hub watches the USB port of every registered board,
  and after this step that is every board of the network, not only those shared to it by hand.
- **`private-hub.ts` fixes a hub's environment at its first start**, so a test cannot turn one hub from "2.2" to
  "2.3" by restarting it; the pre-2.3 test writes the two databases while the hubs are stopped instead.
- **`networks.name` is each hub's own**, and a row's `network` column replicates as a name. Two hubs that call the
  network differently would each show the other's name in a replicated row. Both real hubs use `default`. *Open.*

### 16.4 Tested, and not

**Tested** (vitest, no board):

- `packages/hub/test/registry-sync.test.ts` (the merge alone, each hub a hub.db): the clock; what a scan stamps and
  what it does not (a HELLO's `last_seen`, a board seen only, a hub without a network, a hub that joins another); a
  row made at one hub at the other without that hub's own columns; an edit at a member at the registrar and a third
  hub; a rename and a tag while apart; both renaming one board (`alias_rev`, the later write, the hub id); one alias
  for two boards, whichever hub hears first, and a third hub; a board seen only that gives way; the hub list back to
  an older list and to none; a delete against an old copy, a HELLO after it, a provisioning after it, an edit after
  it, the tombstone's end; an address that differs, one another board holds, another net id, a row that is none;
  two databases from before 2.3 shaped as the real ones (14 and 4), agreeing and disagreeing (tags, alias, hub list,
  firmware, an address); the tag `moved`; no secret in a row, a digest or the table; three hubs editing, renaming,
  deleting and meeting in random order ending with one registry (12 seeds); the board with a newer alias.
- `packages/hub/test/peers-registry.test.ts` (routers, SQLite registries and the peers part in one process, TLS on
  loopback): catching up when a link comes up and a change at once; a writer that tells nobody; three hubs and a hub
  that was away, both ways, with a delete; one alias twice with a FakeNode on the losing board (it is told
  `<alias>-<3 hex>` at the higher `alias_rev` by its holder; both hubs warn); a member asking for an address (the
  registrar up, two members at once, one board asked twice, a taken alias, the registrar away); a peer whose hello
  says no `registry` (sent nothing, named, its unknown counter at 0); one that says it and answers nothing (three
  digests, then every fifth period, a counter, a line, a warning); every `registry` message of the file against the
  key, the password and the Wi-Fi's name.
- `packages/hub/test/interop-registry.test.ts` (hub processes and the C++ node): three hubs: a board made before the
  joins at every hub, `device_share` a no-op; an edit at a member and a rename on each side; enroll at a member, two
  at once, a taken alias; a board enrolled at hub A failing over to hub C, which never had its row shared, reached
  and renamed there through hub B, with hub A (the registrar) away, then hub A catching up and the board returning
  without a name pushed over it; a hub restarted; a row deleted while a hub was away; one alias twice with real ops
  on hubs that could not see each other, the warning on all three and its end; the taps of all three hubs and
  everything they printed against the key, the password and the Wi-Fi's name. Two hubs whose databases were written
  as 2.2 left them (14 and 4 rows, one address differing) with a C++ node connected to the member during the merge:
  14 rows on both, the four unchanged, no `set_alias`, no hub list and no command at the node, its DIRECTORY at 14,
  the address reported on both hubs and settled by hand. A member that does not replicate: sent nothing, named,
  still passed ops, still given a row by `device_share`.
- `packages/hub/test/provision-for-hub.test.ts` (a fake sidecar, two hubs' link parts in one process): a member
  provisions a new board with an address from the registrar, the registrar holds the row without having enrolled it;
  `--for-hub` the registrar then enrolls nothing there and fr_ident names that hub from the member list;
  `device_share` toward it is a no-op; with the registrar away the provisioning is refused before its job starts.
- `packages/cli/test/render-net.test.ts`: the `registry:` line of `fr hub peers`.
- Changed for the new behaviour: `interop-multi-hub.test.ts`, `interop-pass.test.ts`, `interop-peers.test.ts`,
  `provision-for-hub.test.ts` (the report of this step lists each).

**Not verified:**

- **Nothing ran on the two real hubs**: not the first merge of the real 14 and 4 rows, not replication between the
  Mac's Node and the UNO Q's, not a member's enroll over a real LAN.
- **`device_adopt` and an identity flash (`fr flash --plan identity`) on a member** asking for an address: they call
  the same `ensureAddress` as `device_enroll` and `device_provision`, which are the two that ran.
- **A provisioning with real hardware.** `device_provision` on a member and `--for-hub` a hub that replicates ran
  with the fake sidecar of `provision-for-hub.test.ts`; no board was flashed.
- **Clocks that disagree by more than the gap between two edits.** The order is still one order, but "later" is then
  the hub whose clock is ahead. Tested with clocks set apart on purpose, not with a real drift.
- **More than a few hundred rows**, and a digest past 8192 entries (it is cut and logged).
- **The dashboard**: it shows `device_list` rows, which are now the network's; not looked at in a browser.
- **A hub of step 2.2 as a process.** The 2.2 side is a raw link (the same `link.ts`) and a hub told to behave as one
  (`FR_TEST_PEER_REGISTRY=off`), not the 2.2 code itself.
- **A tombstone older than a year** meeting a hub that still holds the row (the row comes back, as designed).

### 16.5 Onto the two real hubs

Both hubs run 2.2 and are linked. No join again, no new key, no firmware, and the CLI stays compatible (the registry
hash did not move).

**Before anything: a copy of each hub.db.** The first merge writes rows into `devices` on both hubs, and going back
to 2.2 does not take them out. With each hub stopped: copy `~/.fractonica/hub.db` (and `hub.db-wal`, `hub.db-shm` if
they are there). That copy is the way back.

1. **Stop both hubs, copy both databases, update both to this checkout, start the registrar, then the member.**
   Either order works; together is simplest (see "one hub on 2.2" below).
2. **`fr hub peers` on both.** The last line reads `registry: N rows; <the other hub> in step, …` on both, with the
   same N: the registrar's boards that have an address of the network. That is 14 when all 14 are provisioned boards;
   a row the registrar has only seen (`provisioned: false`, `addr: null` in `fr devices ls`), or one provisioned under
   another net id, is not counted and does not cross (§16.2). On the registrar: `N - 4 sent`; on the member: as many
   `received`.
3. **`fr hub status` on both**: no warning that starts with `registry:`, none that says `was renamed` or
   `does not replicate`.
4. **`fr devices ls` on the member**: N boards. `fr devices get` for each of the four on both hubs: the same `addr`,
   `alias`, `alias_rev`, `tags` and `hubs` as before the update.

**What the first merge does to the 14 and the 4.** Each hub's first start under 2.3 gives its rows their revs
(§16.1). When the link comes up the two exchange digests. The member lacks the registrar's other rows that have an
address (ten, when all 14 are provisioned boards) and takes them as they are (a `device.provisioned` event for each
there; their provision records stay the registrar's). For the four rows both hold: where
the two copies agree, nothing is written and the member's copy takes the registrar's rev. Where they differ: the
registrar's tags, board, profile, chip and role replace the member's; the alias with the higher `alias_rev` is taken
by the other hub (the registrar's on a tie); the hub list with the higher `rev` (the higher hub id on a tie); the
firmware id of the hub that saw the board last; and an address that differs changes on neither hub and is reported
on both. Rows the registrar has only seen (`provisioned: false`) stay its own.

**What reaches a board because of the merge.** The four boards, if connected to the member, receive the DIRECTORY
with the network's addresses (14 fit one page; as after any provisioning there). No board is told an alias or a hub
list unless its two rows really differed in the alias: then the hub that holds it tells it the winning name. Nothing
is re-addressed.

**While one hub runs 2.2 and the other 2.3.** The link stays up, ops pass both ways as under 2.2 (the hashes are
equal), who is where is unchanged. The registry does not replicate: the 2.3 hub sends the 2.2 hub no `registry`
message, shows it as `does not replicate` in `fr hub peers` and warns in `fr hub status`. A row changed through a
passed-on op is still copied by hand (2.2's rule, on both sides); `fr devices share` still works by hand. A member on
2.3 that is asked to enroll a new board while the registrar is on 2.2 answers `HUB_VERSION_MISMATCH` (the registrar
has no `addr_alloc`); a member on 2.2 refuses as it always did. An edit made directly on the hub that is still on 2.2
(not through the other) is not known to the 2.3 hub, and at the first merge the registrar's copy of that row is kept
where the two differ (above): keep the mixed time short.

**Every way this step could rename a board, re-address one, or leave one or a hub unreachable.**

- **A rename by the merge**, in three cases, each with a `registry_renamed` or `registry.drift` trace:
  (1) two rows with one alias (not possible between the 14 and the 4 as described, since the four are the same
  boards; possible if the member holds a board *seen only* under an alias one of the registrar's ten has: that row,
  the member's own, becomes `<alias>-<3 hex>` tagged `renamed`, and that board is told if it is connected);
  (2) one board with two aliases on the two hubs: the higher `alias_rev` wins and the holder tells the board;
  (3) a board that connects carrying a higher `alias_rev` than the row: the row takes the board's name (the board is
  told nothing).
- **A new address**: never by replication. Only a board with no address of the network gets one, from the registrar.
- **A board unreachable**: a HELLO is never refused because of the registry (only another net id is). A row deleted
  elsewhere while its board is connected here leaves the session up; the board is a row seen only after its next
  HELLO.
- **A USB port taken.** In port mode `adopted` the member now watches the ports of every board of the network, not 4: a board of
  the registrar's plugged into the member for power or a flash is held by the member's hub (`fr serial lease`, or
  `fr ports` to see who holds what).
- **A hub unreachable**: the step adds no listener and blocks no start. A `registry` message this hub cannot read is
  dropped; a row it cannot store is reported and skipped. The scan reads `devices` once a second (14 rows).
- **A wrong row spreading.** Whatever is wrong in one hub's copy and newer by its rev reaches every hub within a
  second. That is the purpose of the step and its main risk: the copy of hub.db is what undoes it.

**Going back to 2.2.** Stop both hubs, check out 2.2, start both. A 2.2 hub opens a 2.3 database: `devices` has no new
column, and it ignores the table `registry_sync` and the kv entries `registry.clock` and `registry.sync_net`. The
rows the member gained stay there as ordinary provisioned rows without a provision record (harmless: its boards'
HELLOs were taken before too); to have exactly the old state, put the copies of hub.db back. Edits made under 2.2
are stamped as that hub's writes at its next start under 2.3 and replicate then.

**The first minutes.** Watch, on both hubs: `fr hub peers` (the `registry:` line, `in step`); `fr hub status`
warnings; `hub.log` for `registry_conflict`, `registry_renamed` and `registry_storm` (there should be none); that the
four boards stay online with the `at` they had; `router.scale.set_alias_pushes` in `fr hub status` (unchanged) and
`router.counters.directory_pushes` (one more on the member).

## 17. Step 2.4 as built

Built 2026-11-21 in `packages/hub/src/peers/events.ts`, `peers/streams.ts`, `events/index.ts` and `apps/stream.ts`.
**Not yet on the two real hubs.** No firmware changed, no op was added and no op's input changed: `REGISTRY_HASH` is
still `8910d0ce4075` and `REGISTRY_INPUTS_HASH` `7113df84c91b`, so a hub of step 2.3 and one of step 2.4 still pass
ops to each other. hub.db has no new table and no new column.

### 17.1 What is where

| | |
|---|---|
| The `event` message | `peers/wire.ts` `EventSchema`: `event {v: 1, now_us, events?, snapshot?, first?, jobs?, dropped?}`; `hello.events: 1`. Encoded once for every peer (`encodeControlJson`, `link.ts` `sendFrame`) |
| The relay | `peers/events.ts` `createEventRelay`: out (a plain subscriber of this hub's bus and of its job runner, a queue per peer, batches), in (each event checked against the HubEvent schema and published live), the mirror of the peers' boards' properties, the peers' running jobs and pending prompts, counters and warnings. Created by `peers/index.ts`; `Peers.events {relays, states, properties, jobs, onJob, prompts}` |
| Live here, stored there | `events/index.ts` `EventStore.relay`: a relayed event takes this hub's own seq and cursor, carries `hub` (the sender's name) and `hub_cursor` (its cursor at the hub that stored it), is written to no table, and goes only to subscribers of the fleet (`subscribeFleet`: `/ws`, `/app`, the waits). The newest 8192 are kept in memory for 10 minutes for the reads that ask (`query {relayed: true}`): `events_read`, a wait's backlog, a `/ws` `since`, an `/app` resume |
| `hub`, `hub_cursor` | `packages/protocol/src/events.ts` `HubEventSchema` (both optional; absent on a hub's own events); `hub` on the `/ws` `job` frame (`ws.ts`) and on `/app` `evt`, `state`, `presence`, `msg` frames and welcome devices (`packages/sdk/src/wire.ts`) |
| Whose cursor | `packages/protocol/src/cursor.ts` `RUN_SLOT_SIZE`, `runSlot`, `slotRun`; `db.ts` `nextHubRun` (a hub's run is `slot * 1,000,000,000 + its own counter`; kv `hub_run` keeps the counter); `Peers.hubOfRun`; `events/index.ts` `sinceSeqOf` (the one check every `since` passes) |
| The waits | `peers/passing.ts` `runBySince`, `liveHere`; `router/ops.ts` `wait_for_event` (the fleet, the kept relayed events, `watchHolders`), `wait_for_device` (the network's presence, `Peers.heldFw`) |
| `/ws` | `web/ws.ts`: the fleet, `relayed` in a catch-up, a selector's `online` from the network, the first values of a peer's board from the mirror, the peers' jobs (`onRemoteJob`), the refusal of a logs sub (`#logsHere`) |
| `/app` | `apps/server.ts` (the fleet, the resume, the relayed stream sockets), `apps/bridge.ts` (`hub`, no presence-down frame for a board another hub holds), `apps/directory.ts` (`welcomeDevice`: the network's presence, the mirror, `hub`), `apps/socket.ts` (`msg` to one board through `passing.ts` `messageAnywhere`) |
| A board's session ending while another hub holds it | `router/index.ts` `#publishPresence` (`fields.at` on this hub's own `device.offline` and `device.suspect`, from `RouterDeps.heldByPeer`), `peers/events.ts` (the same on a relayed one, from `Peers.heldAt`) |
| The stream channel | `peers/streams.ts` `PeerStreams`: data channel kind `stream`, `hello.streams: 1`; the first byte of each data frame says text or block piece (`STREAM_TEXT`, `STREAM_BLOCK_MORE`, `STREAM_BLOCK_END`, `wire.ts`) |
| The stream socket | `apps/stream.ts` `StreamSocket`: where the board is (`#where`), the relay (`#attachRelay`), following the board (`#watch`, `#follow`, `#cut`, `#startAgain`); the same class serves another hub's client (`StreamSocketHost.relayedFrom`, a `StreamWs` that is the link) |
| Whose stream | `streams/live.ts` `LiveStream.via`, `viaText`, `stopAnywhere`; `camera/ops.ts`, `csi/ops.ts` (DEVICE_BUSY, `camera_status` and `csi_status` `stream.via`, `stream_stop` through the board's hub) |
| Seen | `hub_peers`: per peer `events {speaks, sent, received, dropped, coalesced, missed, queued, mirrored}` and `streams {speaks, open}`; counters `events_*`, `event_msgs_*`, `jobs_*`, `streams_*`, `stream_*`; `fr hub peers` prints an `events:` line. `hub_status` warnings; `hub_status.prompts` lists the peers' prompts with `hub` |
| Test hooks | `FR_TEST_PEER_EVENTS` (`off`: no `events` and no `streams` in the hello, none sent, none taken, as a hub of step 2.3) and `FR_TEST_PEER_EVENTS_TAP` (a file every `event` message is appended to), both honoured only by a hub whose node port is not 7421; `PeersOptions.live`, `PeersOptions.events` for a test in one process |

**The `event` message.**

```
{ t: "event", v: 1, now_us,                 the sender's hub clock when it wrote the message
  events?:  [HubEvent, …]                    at most 256 and about 64 KiB; as the sender stored them (its seq and cursor)
  snapshot?: true, first?: true              these are current values of properties (and pending prompts), not new events;
                                             `first`: they replace what the receiver kept of this hub before
  jobs?:    [{job_id, kind, status, stage?, progress?, change: status | stage | progress}, …]
  dropped?: n }                              events the sender did not send since its last message (its queue was full)
```

A hub sends only events of its own bus. An event it was sent by a peer never reaches the relay (it is published to
fleet subscribers only), so nothing is relayed twice with any number of hubs; a receiver also counts and drops an event
that says `hub`. Every pair of hubs has its own link, so the third hub hears the first one's events from the first.

**What crosses.**

| Event type | Crosses | Why |
|---|---|---|
| `<instance>.<member>`, EVENT | yes | what a board does |
| `<instance>.<member>`, STATE | yes | what a board is; in a queue that is behind, a newer value of one property replaces the older one |
| `device.online`, `device.suspect`, `device.offline`, `device.link` | yes | a session with the sending hub; one that ends while another hub holds the board says `fields.at` |
| `msg`, `op.called`, `ota.job.state`, `stream.started`, `stream.ended`, `audio.stream_started`, `audio.stream_ended`, `hil.edge`, `hil.frame`, `cell.session`, `wiring.step`, `node.boot`, any other event with a `device` | yes | it is about a board |
| `job.state` | yes | the jobs a hub runs (those passed on to it, and its own) |
| `hub.prompt`, `hub.prompt_done` | yes | a wait may run at another hub than the one a person looks at |
| `device.provisioned`, `registry.drift` | no | the registry replicates and publishes them at each hub (step 2.3) |
| `port.attached`, `port.detached`, `port.state`, `port.leased`, `port.released` | no | a USB port belongs to one machine (`fr --at <hub> ports ls`) |
| `hub.warning` | no | one hub's own condition (`fr --at <hub> hub status`) |
| `time.threshold` | no | every hub computes Fractonica time itself, from the same core |
| any other event without a `device` | no | nothing says it concerns the network |

Job progress (which is no event: `/ws` `job` frames) crosses as `jobs`. Log lines do not cross (§17.2).

**Bounds.** One queue per peer: at most 4096 events and 4 MiB. Nothing is written while more than 128 KiB waits on
the connection (tried again every 25 ms), so a ping, a call or a file's chunk waits behind at most that and one batch.
Once more than 64 events wait, a queued STATE gives way to a newer one of the same property; when the queue is full
the oldest EVENT goes first and a property's value only when no event is left, so the newest value of every property
is the last thing lost. Dropped events are counted, told to the peer in the next message (`dropped`), logged
(`peer_events_dropped`, at most once a minute) and warned about in `hub_status` on both hubs for ten minutes. What
still waited when a connection went away, or gave way to the pair's other one, is counted as dropped too, without the
warning. Every event a hub publishes for a peer is one of sent, dropped, or replaced by a newer value (`coalesced`).

**Time.** `t_hub_us` of a relayed event is moved into the receiving hub's clock by `now_us` (its own clock at the read
minus the sender's at the write: the two clocks' offset plus the link's delay). The waits' "nothing older than the
cursor" and a dashboard's ages then compare one clock.

**State.** When a link comes up each hub sends the properties of the boards it holds (the newest stored STATE of
each, as `/ws` does for its snapshot), its running jobs and its pending prompts. The receiver keeps them, and every
STATE after them, per board: what a `/ws` subscription first shows of a board at a peer, and the `props` of an `/app`
welcome. It forgets a board's when that hub says the session ended, and a hub's when it goes away.

**Whose cursor.** A hub in slot `s` counts its runs as `s * 1,000,000,000 + n`. Two hubs then never give one run
number, and any hub can tell which hub gave a cursor. The registrar (slot 0) and a hub that is alone count as before.
A member counts in its slot from its first start after it got the slot; until then `hub_status` and the join's answer
ask for the restart. `sinceSeqOf` answers a cursor of this hub run with its seq, one of an earlier run of this hub with
`HUB_RESTARTED` (as before), and one that another hub gave with `INVALID_ARGS` naming that hub
(`details.cursor_hub`): it is never read as a position in this hub's store.

**The waits and the reads, as `runOp` applies them.** An op with `since` (`wait_for_event`, `wait_for_device`,
`wait_for_log`, `logs_assert`, `logs_read`, `events_read`) runs at the hub whose cursor it is: here for this hub's
own, passed whole (mode `at`) to a peer for that peer's, `HUB_UNREACHABLE` (retryable) while that hub is away.
`wait_for_device` without `since` runs here. `logs_read` and `events_read` without `since` keep step 2.2's rule (the
one hub that holds the boards).

| Op | Here (this hub's cursor) | What it sees |
|---|---|---|
| `wait_for_event` | yes | this hub's events and what every peer relays, the kept ones from the cursor on, then live. A board on any hub, boards on several hubs, a board that changes hub during the wait |
| `wait_for_device` | yes | the network's presence (`at` in each row); with `since`, a `device.online` or `device.offline` after the cursor from any hub. A session that ends while another hub holds the board is no `offline` |
| `wait_for_log`, `logs_assert` | only for boards whose lines are here | this hub's log store. For a board another hub holds, with no USB port of it on this machine: `CAPABILITY_UNSUPPORTED` naming that hub and how to wait there |
| any of them, for a board at a peer that relays no events | refused (`wait_for_event`, `wait_for_device`) | `CAPABILITY_UNSUPPORTED` naming the hub; `fr --at <hub>` |

A hub that goes away while it holds one of a wait's boards ends `wait_for_event`, and `wait_for_device` for
`offline`, at once with `HUB_UNREACHABLE` (retryable, `details {hub, devices}`); `wait_for_device` for `online` goes on
(the board may come to another hub) and names the hub in its timeout. A wait that was passed to a hub that then goes
away ends with step 2.2's `HUB_UNREACHABLE`.

**The stream relay.** B's `/app/stream` socket checks its client's token and resolves the board. When a reachable
peer holds it, B sends `open {ch, kind: "stream", ref: {v, device, instance?, start?}}`: no token. A answers `accept`
and runs a `StreamSocket` of its own for it (the same class, the same code as for A's own client: the instance, the
`start`, the join of a running stream, BUSY, the stop when its last starter leaves), whose "socket" is the channel.

```
data frame of the channel:  u32 channel | u8 kind | bytes
  kind 0  one text frame, whole (stream.welcome, stream.started, stream.ended, stream.gap, error), as A wrote it
  kind 1  a piece of a block, more follow        (pieces of at most 64 KiB - 1)
  kind 2  the last piece of a block
ack   {ch, bytes}      B → A: what B has taken so far (after each text frame and block, and every 64 KiB)
close {ch, ok: false, code?, message}   either end: B's client left or the board is followed elsewhere; A refuses
                                        (code: a WebSocket close code such as 4400) or stops
```

B hands text frames to its client as they are (the welcome only once per socket: a later attachment's welcome becomes
`stream.started`) and each block as one binary message. Kinds on this path today: `csi` (`csi1` blocks) and `jpeg`
(`mjpg1` frames); there is no audio kind on `/app/stream`.

**Flow.** Nothing is queued for a stream and nothing waits. A's socket asks its "socket" how much is buffered: the
bytes sent that B has not acked, or what waits on the connection when that is over 512 KiB. Over the stream's high
water (256 KiB) the block is dropped and counted, and the count goes to the client as `stream.gap` before the next
block that is sent: the code that already protects a hub from a slow browser. B drops and counts the same way for its
own slow client. So a slow link or a slow hub loses blocks at A (the next one sent is the newest), a slow client
loses them at B, both say how many, and neither slows the board or the heartbeat.

**Ends.**

| What happens | A (holds the board) | B (has the client) |
|---|---|---|
| B's client leaves | `close` arrives; A's socket closes; a stream that client started and nobody else holds is stopped at the board (`stream_stop`, then the board's connection is closed) | sends `close` |
| The stream ends at the board | `stream.ended` down the channel; the socket stays for the next stream | hands it on |
| The link drops, or A stops or restarts | every relayed socket of that peer closes at once; streams they started are stopped | `stream.ended` (net_lost) for what the client watched, an `error` `HUB_UNREACHABLE`; the socket stays and follows the board |
| B stops or restarts | the link drops: as above | its sockets close 1001, as before |
| A refuses (no such instance, a `start` of the wrong capability) | an `error` text frame, then `close` with 4400 | hands the error on and closes its client with the same code |

**The board changes hub under a stream.** B's socket watches where the board is (this hub's own `device.online` and
`device.offline`, and what the peers say). When that is another place than the one it is attached to, 300 ms after
the last change, it leaves the old place (a local subscription ends; a relay is closed, so that hub stops what this
client started), tells the client `stream.ended` (net_lost) for what it was watching, and attaches where the board is:
its own streams when this hub now holds it, a relay otherwise. `start` is asked again only when the client had asked
for it and a stream it was watching was cut within the last 20 s; the board may still be ending the old stream, so a
start that is refused as busy, or whose stream ends `error` before its first block, is asked again after 1.5 s, three
times at most. While no hub holds the board the socket stays attached to nothing and waits. A new place that relays
no streams is said as an `error`.

A hub that ran a stream for a board that has left it tells the board to stop through the board's new hub
(`stopAnywhere`: a `command_send` passed on), and closes the board's HTTP connection, which ends the stream at the
board whatever the command did.

**BUSY.** A board's streams are started only by the hub that holds it, so one stream per instance is one rule at one
place: `DEVICE_BUSY` comes from that hub whichever hub is asked. A stream begun for another hub's client records that
hub (`via`): the BUSY message says "for a client of hub <name>", and `camera_status` and `csi_status` answer
`stream.via`.

**Every live path a client can open, and what became of it.**

| Path | Through the link |
|---|---|
| `/app/stream` (the SDK's `streams.subscribe`, the dashboard's camera panel, a CSI app): `csi1` blocks, `mjpg1` frames | relayed, as above |
| `camera_stream`, `camera_snap`, `camera_sd_fetch`, `csi_stream`, `audio_record`, `scale_watch` (`fr camera stream`, `fr csi stream`, …): a job that takes a board's stream into files | the job runs at the board's hub and its files are pulled to where the command ran (step 2.2); with `live` its blocks are on `/app/stream`, which any hub's client joins through the relay; its progress and states are live at every hub (`jobs`, `job.state`) |
| `audio_monitor` (a board's microphone heard on its own speaker), `audio_play`, `audio_level` | ops of one board: passed to its hub (step 2.2). No audio reaches a client as a stream: there is no audio kind on `/app/stream` and no audio view in the dashboard |
| `display_snapshot` | an op, passed on, its PNG pulled (step 2.2). `fr display window` draws a profile's panel on the machine it runs on and uses no hub; the dashboard's face mirror is not built |
| The node HTTP port 7422 (`POST /v1/stream/in/<id>`, the audio routes, an OTA image) | a board and the hub it has its session with; nothing of it crosses, and no client opens it |
| `/ws` `events`, `jobs` | the fleet's, marked `hub` |
| `/ws` `logs`; `fr logs --follow` | a `/ws` logs subscription for a board whose lines are at another hub is refused with the reason; `fr logs --follow` reads page by page at the hub its cursor is from |
| `/ws` `ports` | this machine's ports only |

### 17.2 Where it differs from §8 and from the brief, and why

- **No subscription message.** §8 has a hub subscribe at each peer. Here the hello is the subscription: a hub whose
  hello says `events` is sent everything that crosses, always. A wait's backlog needs the relay to have been running
  before the wait began, so a relay that starts when a client connects would lose exactly the events a wait is for.
- **A wait does not ask the holder for its backlog; the cursor decides where it runs.** §8 says "a wait that reads the
  backlog asks the holder". A cursor of hub B means nothing at hub A, and a wait over boards on two hubs has no one
  holder. So: a cursor says whose it is, an op that reads from a cursor runs at that hub, and every hub's bus carries
  the whole network, with the relayed events of the last ten minutes kept in memory for the backlog. A wait from the
  cursor of an op that the board's hub answered (step 2.2's rule: the answer carries that hub's cursor) still runs at
  the board's hub, on its store.
- **A relayed event is kept in memory at the receiver** (8192, ten minutes), though "live only" was the brief's word.
  It is still stored once, at the holder: no row is written here. Without the memory a wait that starts a moment
  after the event (every `command, then wait since its cursor`) would miss it.
- **`events_read` at a hub answers the relayed events it still keeps, marked `hub`**, with its own stored ones. That
  is the dashboard's seed and what a `/ws` `gap` is re-read from, and it is the same list in the same order as `/ws`
  sent. After ten minutes only the hub's own remain; a board's whole history is at its hub (`events_read` without
  `since` for that board is passed there, as under 2.2).
- **A hub's run number carries its slot.** Not in §8 or the brief; it is what makes "a cursor of one hub is never
  silently applied to another hub's store" hold. Two hubs used to count runs from 1 each, so run 12 of one was
  indistinguishable from run 12 of the other. The cursor's format and every op's input are unchanged.
- **Logs do not cross.** Events were asked for; log lines are a stream of text at any rate a board prints, and one
  hub's store. `wait_for_log` and `logs_assert` run where the lines are and are refused elsewhere with the hub's name;
  `fr logs --follow` reads page by page from the hub its cursor came from (and so also follows a board through
  another hub, as under 2.2); a `/ws` logs subscription for a board whose lines are at another hub is refused (`err`
  `CAPABILITY_UNSUPPORTED`), and the dashboard's log terminal prints that line under the stored tail.
- **`hub.warning`, `port.*` and `time.threshold` stay local**, though a client can subscribe to them: each is one
  hub's own. The other hub events a client can subscribe to cross.
- **All of a peer's jobs cross**, not only those this hub passed on: a dashboard at any hub shows what runs anywhere,
  with `hub` on the frame.
- **`device.offline` and `device.suspect` gain `fields.at`** when another hub holds the board at that moment. Without
  it a client that takes the newest presence event for the truth shows a board offline after every failover.
  `/app` sends no presence-down frame for such an event.
- **A stream's restart after a move is bounded** (20 s, three tries). The brief asks that it follow "where that is
  sound": a client that asked for a stream and was watching one gets it back; a board that comes back an hour later
  does not start streaming because a tab was left open.
- **No data-channel credit window for a stream.** 2.2's channels make the provider wait for credit; a live stream must
  not wait. The same `ack` is used to measure, and the answer to "too far ahead" is a dropped block.
- **`/app` `msg` to one board is passed on** (the brief names commands only): without it an app's MSG to a board on
  another hub answered `offline`.
- **A wait for a board at a hub that relays no events is refused even where presence alone would do**
  (`wait_for_device` without `since` could be answered from who-is-where). One rule for the two event waits is
  easier to explain than two, and the case lasts only while one hub is being updated.
- **Not built: `job_list` across hubs, a logs relay, `hub_status` of the network.** As under 2.2: `fr --at`.

### 17.3 Found while building

- **Most parts of a hub must not see relayed events.** The router, bindings, OTA, the fixture, the power tracker and
  the stream jobs all subscribe to the bus and act on this hub's own sessions. A relayed `stream_ended` would have
  ended a job here; a relayed button press would have fired a binding twice. So the bus has two kinds of subscriber,
  and the default is this hub's own.
- **Two connections of one pair cross at a link's start**, and the one that loses takes the events in flight with it.
  They are counted as dropped and told to the peer; the snapshot that follows on the kept connection brings the state.
- **A board that changes hub keeps streaming to the hub it left**, as MULTI-HUB-1 noted: its HTTP connection there is
  its own. The stream then ends because that hub's last watcher follows the board away, and the hub stops it through
  the board's new hub. A stream nobody watches through a socket (a `camera_stream` job with `seconds`) runs to its
  end at the old hub.
- **The new hub's `stream_start` can arrive before the old hub's `stream_stop`.** Both pass through the board's new
  hub; the firmware answers BUSY and refuses a `stream_stop` of another stream id, so nothing is broken, and the start
  is asked again.
- **A hub that stops answers its jobs first** (§15.3): a relayed stream's job is cancelled, so the client's stream
  ends `stopped` a moment before the link's loss is seen.
- **The stream job of the hub the board left waits for a `stream_ended` that goes to the other hub.** It takes the
  two-second grace and then its HTTP connection's end, so that hub's `camera_status` shows the stream a few seconds
  longer than it ran.
- **`/app` does not announce a board that came online at a peer with instances it never knew.** A board's instances
  come from the manifest of its registry firmware; a hub that lacks that build (built on the other hub) lists the
  board in its welcome with no `caps`. Its events and states still arrive. *Open.*
- **`hub_status.prompts` now lists prompts of other hubs** (with `hub`), because the dashboard replaces its own list
  with that answer a few seconds after an event.
- **A relayed event takes a cursor here, and retention counts cursors.** The `logs` and `events` rings keep the
  newest million cursors (`ring.ts`: rows at or below `head - rows` go), not a million rows. A live-only event already
  took a cursor without a row; now every event another hub relays does too. A fleet whose boards publish a streaming
  STATE (20 a second from one analog input) moves every hub's head by that rate, so each hub's own log and event
  history is then as many hours deep as the whole fleet takes to publish a million events, 7 days at most as before.
  Not changed in this step; kv `logs.retention_rows` and `events.retention_rows` raise it. *Open.*
- **A member's first start under this step changes its run number** (from `n` to `1,000,000,000 + n`). Every cursor
  a client still held from before is `HUB_RESTARTED`, as after any restart.

### 17.4 Tested, and not

**Tested** (vitest, no board):

- `packages/hub/test/peers-live-queue.test.ts` (the relay with a link that is a list of frames): batches in order with
  the hub clock; what crosses and what does not; a connection that takes nothing, then all of it; a link that is gone;
  STATEs giving way (600 values of two properties in a queue of under 20); a full queue (the oldest events first, the
  property's newest value kept, `dropped` told once, the warning); bytes as a bound; a job's changes folded into one;
  what a peer sends published with this hub's seq, the sender's name, the clock moved and `at`; an event that says
  `hub`, one that stays local and one that is none, each refused and counted; a snapshot that replaces the mirror; a
  hub in mode off.
- `packages/hub/test/peers-streams.test.ts` (the stream channel between two links): the `open` and its reference, the
  kind byte and the pieces of each frame on the wire, the same bytes at the other end, the acks, what the pipe says is
  under way when the other hub takes nothing, the close from either end with its code, a hub with no stream server
  and one whose server throws, a block past the limit, the link going away, a hub that is away.
- `packages/hub/test/events.test.ts`, `ops.test.ts` (additions): a relayed event's seq, cursor and origin, who is
  told, what a read with and without `relayed` answers, STATE thinning, the 8192 and the ten minutes; `sinceSeqOf`
  for this run's, an earlier run's and another hub's cursor; `nextHubRun` with and without a slot.
  `packages/cli/test/render-net.test.ts`: the `events:` line of `fr hub peers`.
- `packages/hub/test/peers-live.test.ts` (routers with FakeNodes, the job runner, the peers part, `/ws`, `/app` and the
  op dispatch point in one process, TLS on loopback). Events: a board's presence, STATE and EVENT at the other hub's
  `/ws` and `/app` with `hub`, in that hub's own order, no row there, `events_read` there; each crossing type and each
  staying one; three hubs, 20 events once each and nothing sent on; the snapshot at link-up, a `/ws` selector
  `online`, the `/app` welcome, the mirror forgotten; a job's frames and states with `hub`, and for a late
  subscriber; a board moving A to B and back with `at` and no offline frame to an app. Waits: `wait_for_event` from
  this hub's cursor (backlog and live) and from the board's hub's cursor (passed), `events_read` likewise, another
  hub's cursor refused by name on REST and `/ws`, an earlier run's `HUB_RESTARTED`; a board on no hub that appears on
  a peer; `since` for `wait_for_device`; boards on two hubs waited for at a third; a board that moves during the wait;
  a session that ends while another hub holds the board (no `offline`); a hub that goes away mid-wait (three waits
  end in under 10 s with `HUB_UNREACHABLE`, the wait for `online` goes on and ends well after a failover); the log
  ops refused and passed, `logs_read` three ways, the `/ws` logs refusal; a peer in mode off (sent nothing, counts
  nothing unknown, named, waits refused, `--at` still works). A flood: 11,000 events of 0.5 kB in 2 s over a link of
  200 KiB/s each way: the link never away, a call across answered in under 5 s, at most 600 waiting, every event
  accounted for, both hubs' counters and warnings, the newest value in the mirror. Secrets: every `event` message of
  the file against the key, the password and the Wi-Fi's name. Streams (a registered stream fed by the test): a relay
  with blocks of 0 B to 1 MiB compared byte for byte, the end, the next stream, the client leaving; a starter and a
  watcher, the starter's leaving stopping the stream, a refusal from the holder and one from this hub; the link
  dropping, then the board at this hub; the board moving to a third hub; 100 kB blocks at 2.5 MB/s over 300 KiB/s
  (the link never away, every block arrived or counted in a `stream.gap`, under 1 MB under way); a client that stops
  reading (the other hub sent all 80 blocks, this hub dropped and said how many); a hub in mode off both ways; what
  crossed for a relay, either way, against the `/app` token, the key, the password and the Wi-Fi's name.
- `packages/hub/test/interop-live.test.ts` (three hub processes and two C++ nodes): the members restarted after the
  join and the three runs in three slots; a pad's click and an op's `op.called` at the other two hubs' `/ws` and at
  `/app`, once each; a CSI recording asked at hub B and run at hub A, its `job` frames, `job.state` and `stream.*` at
  hub B; `wait_for_event`, `wait_for_device`, `wait_for_log`, `logs_assert` and `events_read` across; a relayed CSI
  stream whose blocks equal the file hub A wrote, byte for byte; a client at hub B that asks for the stream
  (`csi_status.stream.via` at all three hubs, `DEVICE_BUSY` naming hub B at two, a second client at hub C, the stream
  stopped at the board when the first leaves); hub A stopped under the stream, the board failing over to hub B and
  the stream going on there, hub A back, the board returning by itself and the stream following it through the link,
  nothing left running at hub B; the taps and everything the hubs printed against the key, the password, the Wi-Fi's
  name and the `/app` tokens.
- Changed for the new behaviour: `interop-pass.test.ts`, `interop-peers.test.ts`, `peers-registry.test.ts` (the report
  of this step lists each).

**Not verified:**

- **Nothing ran on the two real hubs**: not an `event` message between the Mac's Node and the UNO Q's, not a relayed
  stream over a real LAN, not the dashboard against a board on the other hub.
- **A camera.** Every relayed stream of the tests is CSI (blocks of a few kB from the C++ node) or a block the test
  made. `fr.camera` takes the same path with frames of up to 1 MiB; no JPEG from a board crossed.
- **A real failover under a real stream.** The C++ node's hub list follows the firmware's rules, but its stream is
  the host build of `fr_stream`; whether an ESP32-CAM that walks back to its default hub keeps or drops its HTTP
  connection to the hub it left, and how long its `stream_stop` then takes, was not seen on a board.
- **The dashboard in a browser.** Its store, its `/ws` client and its stream client were not changed (one line in the
  log terminal was); none of it was looked at with two hubs. The camera panel's handling of `stream.ended` followed by
  `stream.started` on one socket was not tried.
- **A slow real link.** The slow link of the tests is a rate-limited TCP relay on loopback, not Wi-Fi with loss.
- **A hub of step 2.3 as a process.** The 2.3 side is a hub told to behave as one (`PeersOptions.live`), not the 2.3
  code.
- **Clocks apart.** `t_hub_us` is moved by the message's `now_us`; the tests' hubs share one clock, apart from a unit
  test that sets one 7 s behind.
- **More than a few boards**, and a snapshot of a large fleet (one message per 256 properties, written at once when a
  link comes up).
- **An SDK app.** `/app` frames were read raw; `@fractonica/sdk` takes the new `hub` field in its types and was not run
  against a board on another hub.
- **`wait_for_event` with `prompt_human` across hubs**, `/app` `msg` to a board at a peer (`messageAnywhere`), and a
  hub's prompt in the other hub's dashboard: typechecked, their parts tested apart, not end to end.

### 17.5 Onto the two real hubs

Both hubs run 2.3 and are linked. No join again, no new key, no firmware. The CLI stays compatible (the registry hash
did not move), and hub.db needs no copy for this step: nothing new is written to it but the run counter it always
wrote.

1. **Update both to this checkout and restart each** (`fr hub restart`), in either order.
2. **`fr hub status` on both**: no warning that says `does not relay events`, `cursors` or `events were not sent`.
   `run` on the member is now above 1,000,000,000.
3. **`fr hub peers` on both**: the last line reads `events: <the other hub> N sent, M received`, with nothing dropped.
4. **From the Mac, a board on the home hub:** `fr wait device <board> --state online`; `fr events` after pressing its
   button (the event is there, marked `hub`); `fr send <board> status.blink`, then `fr wait event status.effect_done
   --selector <board> --since <the cursor it answered>`.
5. **The home hub's screen, a board on the Mac's hub:** its tile lights on a button press without a reload; its camera
   panel shows the picture.

**While one hub runs 2.3 and the other 2.4.** The link stays up, ops pass both ways (the hashes are equal), the
registry replicates. The 2.4 hub sends the 2.3 hub no `event` message and opens no stream channel at it, shows it as
`relays none` in `fr hub peers` and warns in `fr hub status`. On the 2.4 hub a wait for a board the 2.3 hub holds is
refused naming that hub (`fr --at <hub> wait …` runs it there, as under 2.3), and a stream of such a board is refused
at the socket. On the 2.3 hub everything is as under 2.3: a wait for a board at the other hub is refused as "step
2.4", a stream too. One thing is weaker in this time than before or after it: the 2.3 hub's run numbers do not carry
its slot, so if the two hubs' run counters happen to be equal, a cursor answered by the 2.3 member is taken by the 2.4
registrar for its own. Do not script waits across the two hubs in these minutes.

**Every way this step could leave a hub or a board unreachable, or a board streaming with nobody watching.**

- **A board: none through its session.** Nothing new is sent to a board but `stream_start` and `stream_stop`, by the
  hub that holds it, as before. No HELLO is answered differently.
- **A hub's API: none.** Port 7420 (7520) is as it was. A flood of events for a slow peer costs at most 4 MiB of
  memory per peer; a relayed stream buffers nothing.
- **The link.** Events and streams share it with the heartbeat and the calls. Events hold back at 128 KiB queued on the
  connection and streams drop over 256 KiB under way, so a ping waits behind well under a megabyte. On a link slower
  than about 20 kB/s that could still pass the 6 s; then the link drops and comes back, as it would under a large file
  since 2.2. Watch `fr hub peers` `away`.
- **A board left streaming.** (1) A client that asked for a stream through the link and vanishes without closing (a
  laptop that sleeps): its hub's `/app/stream` ping finds it dead within 6 s and closes the relay; the board's hub
  stops the stream. (2) The link drops: the board's hub closes every relayed socket of that peer at once and stops
  their streams. (3) The hub with the client stops: as (2). (4) The board's hub stops: its jobs are cancelled and the
  board's HTTP connection closes. (5) The board walks to another hub under the stream: the socket follows, the old
  hub stops its stream through the new one and closes the board's connection. What remains: a `camera_stream` or
  `csi_stream` job with `seconds 0` started by a command, not a socket, runs until it is cancelled, on whichever hub
  it started; that is as before this step. Check `fr camera status <board>` on each hub (`stream` null) when in doubt.
- **A wait that now runs somewhere else.** `fr wait …` for a board on the other hub used to be refused and now runs.
  A script that passed a cursor of one hub to another hub by mistake used to get `HUB_RESTARTED` or, with equal run
  numbers, a wait from the wrong place; it now gets the wait run at the right hub, or `INVALID_ARGS` naming it.
- **More in the dashboard.** A dashboard now shows the other hub's boards' events and all its jobs. A toast for a job
  that ended on the other hub is new.
- **Shorter history on a busy fleet.** Each relayed event takes a cursor at the hub that receives it, and the log and
  event rings are trimmed by cursor distance (§17.3). `fr hub status` `db` shows the tables' sizes; compare the oldest
  line of `fr logs all --direction forward` a day after the update with what it was.

**Going back to 2.3.** Stop both hubs, check out 2.3, start both. Nothing in hub.db is new: a 2.3 hub opens a 2.4
database. The member's run number goes back to its own counter (kv `hub_run` was never anything else), which is a
number it has not used since it joined; cursors from before the restart are `HUB_RESTARTED`, as after any restart.

**The first minutes.** Watch, on both hubs: `fr hub peers` (`events:` line, `away` and `events_dropped` in the
counters with `--json`); `fr hub status` warnings; `hub.log` for `peer_events_dropped` and `event_subscriber_failed`
(there should be none); `fr hub status` `ws.gaps` and `process.rss` while a camera is watched through the link; that
the four boards stay online with the `at` they had; and after closing a camera view, `fr camera status <board>` on
the board's hub (`stream` null within a few seconds).

### 17.6 What remains of MULTI-HUB-2

- **Streams hold failback: the firmware half of §8 and §11 item 3.** Not built, by the owner's decision to keep
  firmware out of this step. What it would be: in `firmware/components/fr_core/src/core.cpp`, where the heartbeat's
  vitals are filled, `net::esp::hub_busy(v.ota_busy)` becomes `hub_busy(v.ota_busy || a stream runs)`, with "a stream
  runs" true while `fr_stream` has a POST open or connecting for any of fr.camera, fr.csi and fr.audio_in (and the
  audio out GET), and false again after at most 10 minutes of one stream, so a stream that never ends cannot hold a
  board away from its default hub for good. `hub_link.cpp` already defers the return to a hub above the current one
  while `hub_busy` is set. It needs new firmware on every board and a host test beside `esp_hub_resolve_test.cpp`.
  Until then a board returns to its default hub on time and a stream watched through a socket restarts there by
  itself (§17.1); a stream started by a command does not.
- **Logs across hubs.** A `/ws` logs subscription and the log waits for a board at another hub (§17.2).
- **`job_list` across hubs** (§15.2), **`fr net rekey`, `fr net leave`, `fr net registrar --move-to`** (§10, §14.2),
  **`device_forget` as an op** (§16.2), **the member list in the `registry` message** (§16.2).
- **Bindings and broadcasts across hubs** (§10): a binding between boards on two hubs is still refused; a fleet
  broadcast is each hub's own.
- **The dashboard**: nothing in it says which hub a board is at, or names the hub on a job or an event (`at` and `hub`
  are in the data). Layout was out of scope.
- **`/app` instances of a board whose firmware this hub has no manifest for** (§17.3).
- **Retention by rows, or relayed events that take no cursor of the rings' count** (§17.3).
- **Open from earlier steps:** the serial HELLO a board repeats every second while another hub holds it (§14.3); an
  `out` under FR_HOME not checked by the display ops (§15.3); `networks.name` per hub (§16.3).
