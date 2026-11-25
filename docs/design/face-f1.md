# FACE-1: the Fractonica clock face on the e-paper panel (`fr.face` 1.0), a power-save mode, and `fr.clock` → `fr.rtc`

> **Approved by the owner, 2026-11-24; being built.** Asked for (EPAPER-1's brief, deferred to this round by the owner): "the
> default screen a Fractonica clock face, redrawing only the changed regions", on `paper-c6` (design epaper-e1). The
> owner's answers so far are in §14. This is stage 5 of HARDWARE-REVIEW cut to the e-paper: the round GC9A01 clock,
> retiring the standalone clock firmware (`clock/main`, its HAL, PlatformIO) and the dashboard's drawn mirror stay
> for later (§12). The owner then added a **power-save mode** (§10): deep sleep between redraws, Wi-Fi never on, the
> time from a DS3231 only. Anything *inferred* was not read in code, a datasheet or on the bench.

> **As built, 2026-11-24 (uncommitted, not yet on glass).** Where it differs from the text below:
> - **The command is `input`**, not `step_ui`; **`power_save` is not a profile setting** (only the node's NVS flag: a
>   node that left the network at its first boot after a flash could not be reached).
> - **The wake key uses a new driver `button_pin`** (button_gpio's class on a bare pin): button_gpio binds only a
>   board's `buttons` entries. The C6 Super Mini's manifest gains GPIO6 and 7 in `pins.free` (plain GPIOs; JTAG is on
>   the USB Serial/JTAG by default). GPIO4 and 5 are strapping pins that need no level (codegen warns, as for scale-c6).
> - **The offline boot** turns off what the radio-off build turns off: no Wi-Fi, ESP-NOW, TCP or UDP link. The USB
>   serial link to a hub stays (it is no radio; while asleep the USB is gone anyway).
> - **The countdown counts from the instant shown**: at the Preon step and test vector A it reads `END IN 7ι` (the
>   Helion's 36ι less the 29ι shown), not the live `6ι`. The core cannot yet format a span to a finest unit; the
>   library's one stand-in (`clock/components/fractonica_ui/src/fui_shim.c`) cuts the span to whole units and lets the
>   core write it (clock/AGENTS.md §10 asks the core for `frc_format_span_to`).
> - **The layout changed on the bench** (the owner's sketch, after seeing the first one on glass): only the wave in
>   the middle (the focused level's arcs with its second level, the now block, the inner circle and the two glyphs,
>   resized per focus to reach 146 px from the centre); the Nuclide `ε#5` top left, the Helion `34η` top right, the
>   Preon `29ι` bottom right (the 5 × 7 font at 4 px per dot, 28 px capitals; the Preon hidden at the Helion and θ
>   steps); the Pentad mark bottom left (a pentagon with the core's numeral, `II`); in EARTH mode `⊕ 13:57` small at the
>   bottom centre and the wave 14 % smaller. No countdown on NOW. The core has no count form for the Nuclide, only the
>   ordinal `ε#5` (the owner sketched `03ε`). Lines are 1 px; "now" is a 7 × 7 block. The pictures are
>   `clock/docs/mono400x300-*.png` (black on white, drawn 2× larger).
> - **LP memory** holds the kept glass: 15,196 of the C6's 16,384 B. A host test caught a dangling wall-clock listener
>   (FaceService now clears it when it goes).
> - **Checks (2026-11-24):** typecheck clean; `fr gen --check` 0 stale; host C++ 1,136 passed (FaceService 10, wall
>   clock 4, the RTC's); vitest 3,323 of 3,330 in one full run, the 7 passing alone (load flakes; e2e-gates-f after
>   `node tools/host-test.mjs --fleet`); the clock's `make test` green with every earlier golden unchanged (190 scenes),
>   its eleven standalone builds clean; `c6e-paper` debug 1,640,960 B (17 % free), DIRAM 323,829 B, LP SRAM 15,196 B;
>   release 1,425,920 B (28 % free), DIRAM 303,383 B, LP SRAM 15,136 B. Built with idf.py directly: the lab hub runs
>   EPAPER-1's code and refuses this tree's CLI (`fr build`) until it is restarted on it.

> **Three keys and sounds, 2026-11-25** (§17, D18–D19, the owner's request after the bench): left and right buttons on
> GPIO 21 and 22 (not 12 and 13, the USB lines) for prev and next, the centre key selecting; a buzzer on GPIO 23 that
> clicks at each press and chimes when a Preon or longer begins; `chime` and `clicks` settings. Not yet on glass.

## 0. What is there to build on

- **The clock library** `clock/components/fractonica_ui` (C99, no heap, no IDF header) draws the clock's five screens
  (NOW, SCALES, LENS, SUN, STAMP) for four faces (round 240, rect 240, rect 240 × 320, one-bit 128 × 64). Its loop is
  `fui_ui_update(now)` → `{redraw, dirty, sleep_us}` → `fui_ui_draw(canvas)`. It runs on a C6 with a GC9A01 today
  (clock/AGENTS.md), on ESP-IDF 5.5.
- **The core** (`../core`, sibling checkout, C99, 0.2.0) does all Fractonica arithmetic and text; the clock reaches it
  through the wrapper component `clock/components/fractonica` (`FRACTONICA_CORE_DIR`, else the sibling checkout).
- **Both build clean under ESP-IDF 6.1's GCC 15.2** (checked for this note: the library as gnu99 and gnu23, the core as
  gnu23, a C++ file including `fui_ui.h` under gnu++26 with `-Wpedantic`; all headers have `extern "C"`).
  Flash on a C3: about 32 KB for the library and 29 KB for the core; RAM: one 1,552-byte `fui_ui_t`, no heap; deepest
  stack chain 2.3 KB (clock/AGENTS.md §8).
- **The panel** (epaper-e1): `EpaperBackend` keeps the 1-bit frame (MSB-first rows, 1 = white), diffs it against the
  glass and refreshes only the changed bytes, partial 0.36 s; a fast clean every 60 partials (the owner's setting).
- **What is missing in the framework** (verified): no service can draw into the backend's frame (it is `const` outside
  the backend); no service hears another's events (one `cap::Sink` per capability, to the network); a service with no
  driver cannot be generated; and **the node has no wall clock**: only the DS3231 driver calls `settimeofday`. The hub
  already sends its Unix time to every node (WELCOME `hub_time_us`, BEACON `hub_time_us`, and `t1` of every
  TIME.SYNC_REQ, in bursts every 60 s), but the node ignores it.

## 1. Scope

**In:** the wall clock on the node (D1); `fr.face` 1.0 (D2); a 400 × 300 one-bit face in the clock library (D3) with
an adjustable step (D4); the driver that wraps the library (D5); `FaceService` and its hooks into the display and the
button (D6, D7); codegen (D8); `c6e-paper` gains a face (D9); the face's page on the dashboard (D10); `fr.clock` →
`fr.rtc` (D11); docs and tests (D12); the power-save mode, with a DS3231 and a second button on `paper-c6`
(D13–D17).

**Out (follow-ups, §12):** the round GC9A01 clock profile without LVGL; moving `fractonica_ui` out of `clock/` and
retiring the standalone firmware; a drawn face mirror in the dashboard; the face on the C3's 128 × 64 OLED; SNTP.

## 2. Time on the node (D1)

**D1.** A node-wide **wall clock** in `fr_core` (`fr/wall_clock.hpp`, IDF-free; the platform sets the system clock with
`settimeofday` so logs and `time()` agree):
- **From the hub, with no protocol change.** `Net` takes the hub's Unix time from WELCOME and BEACON (`hub_time_us`) and
  from each TIME.SYNC_REQ (`t1`, against the arrival time `rx_at_` the link already records). The one-way delay only
  makes a sample late, so of each burst the node keeps the sample that implies the latest time (the least-delayed
  one): a few milliseconds over Wi-Fi *(inferred)*, against a finest step of 7.8 s.
- **From the RTC.** `fr.rtc`'s seeding at boot (D11) goes through the same clock, ranked below the hub: an RTC seed
  never overrides the hub's time; the hub's time replaces the RTC's.
- **Across a reboot.** ESP-IDF keeps the system time across a software reset (OTA, crash) but not a power-on. A marker
  in RTC no-init memory, as the clock firmware does, says the time is still good, so the face does not drop to "time
  not set" after an OTA.
- Steps are applied at once (the face wakes 50 ms after each boundary, so a step of a few ms cannot show a count going
  back). The node keeps its own time while the hub is away: the C6's crystal drifts a few seconds a day at most
  *(inferred: 10–50 ppm)*, corrected on the next burst.
- **SNTP is not added** (the review's D7 had it): with the hub's time the node needs no internet server, and a node
  that has lost the hub keeps running on its own clock. It can follow if a node ever runs without a hub.

## 3. The capability `fr.face` 1.0 (D2)

**D2.** `schema/capabilities/face.cap.yaml`, id **0x0014** (free; planned in epaper-e1 §11). Bound to an `fr.display`
instance of the same node, the way `fr.touch` is, and optionally to an `fr.button` and an `fr.rtc`.

- **Config** (profile): `display` (instance, required), `button` and `rtc` (instances, optional; power save needs
  both), `mode` (pure | earth, default
  pure), `focus` (0..13, default 6, the Helion), `step` (D4, default preon), `utc_offset_min` (−720..840, default 0;
  EARTH mode's fixed offset), `wait_time_s` (default 30: how long after boot the face waits for
  the time before it says "time not set", so a reboot does not flash that screen),
  `awake_s` (default 30; D15).
- **Properties:** `mode`, `screen` (now, scales, lens, sun, stamp), `focus`, `step`, `utc_offset_min`, `shown` (the face
  has the screen), `time_valid` (the node knows the time), `power_save`. Changes are reported as usual.
- **Commands:**
  - `show {}`: take the screen back (a full redraw).
  - `input {event: next | prev | select | long}`: what a button would do (the clock's four events).
  - `set {mode?, focus?, screen?, step?, utc_offset_min?, power_save?}`: any of them; saved in NVS (D6).
    `power_save: true` is the last thing the hub hears from the node (D13).
- **No event.** `time_valid` and `shown` changing are reported as property changes.
- The hub needs **no new op**: `command_send` carries these, and the CLI and the dashboard build their controls from
  the catalog. The catalog changes (a new capability and the rename): every image is rebuilt, which fr.display 1.3
  already asks for.

## 4. The 400 × 300 face (D3)

**D3.** A fifth face in the clock library, **`FUI_FACE_MONO400X300`**, black ink on white paper (a one-bit theme with
ground white, ink black: the paper's own look; the library's rule "no inverse video" is about not inverting inside a
face, and it holds). The owner chose this layout:

```
+------------------------------+-----------+
|                              |   34η     |   the count, one unit per row, down to the step (D4)
|          the ring            |   29ι     |
|        300 x 300, R ~ 70     |           |
|     (the colour faces'       |  END IN   |   the countdown to the focus's next threshold
|      instrument, one bit)    |   6ι      |
|                              |           |
|                              | ⊕ 14:00   |   EARTH mode only: the civil time and date, small
+------------------------------+-----------+
```

- **The ring** is the colour faces' instrument (two nested levels, counter rings, quarter ticks, the now block, the
  odometer glyphs at the centre) drawn with DESIGN.md §11's one-bit rules: elapsed solid, to come dotted 1 on / 2 off,
  no glow, no colour, no dithering. Its geometry is already size-generic (centre and radius from the layout table;
  arcs from the core). At this size one-pixel lines (0.21 mm on this glass) may be thin: the bench decides whether
  arcs and strokes go to 2 px (a ruling for the owner when the pictures are on glass).
- **The column** (x 300..399): the 5 × 7 font at 2 px per dot (14 px capitals). Every token fits in 100 px (the widest,
  `35ι 64λ`, is 72 px; `VALLEY IN` 98 px); EARTH rows in the 3 × 5 font at 2 px per dot.
- **The cards** (LENS, SUN, STAMP) use the whole 400 × 300 with the colour faces' rows in the 5 × 7 font at 2 px; the
  one-bit SUN card, today fixed to 128 × 64, gets a 400 × 300 layout.
- Work in the library: the enum and its layout row, a NOW painter for this face, the ring's redraw box, text styles per
  face, the SUN card; the simulator's golden images, shots and tests take the new face (`make test`, `make shots`),
  and the PNGs go to the owner before anything is flashed.

## 5. The step: how often the face moves (D4)

**D4.** The owner asked for an adjustable cadence with the **Preon** as the default. A new library setting
`fui_ui_set_step(ui, level)`:
- The face shows the instant **at the start of the running cycle of the step level** (`frc_cycle_at`'s `start`) and
  wakes at its end (`end`, plus 50 ms): every Preon by default, on the Preon's boundary, not 8.4 minutes after an
  arbitrary moment.
- **The reading goes down to the step, no finer**: at the Preon the count is `34η 29ι` and the countdown `6ι`; at the
  Flavon `34η 29ι 21λ` and `6ι 43λ`. A finer unit would only show a frozen number.
- Values: `flavon` (7.8 s), `kappa` (1.7 min), `preon` (8.4 min, default), `theta` (34 min), `helion` (5.1 h); set in
  the profile and changed live with `set {step}` (saved in NVS).
- A label (the level named for 2.5 s after a scale step, the mode word for 1.5 s) still shows and clears on time: two
  extra partial refreshes per button use.
- Without a step (the other faces) the library behaves as today; their golden images do not change.

At the Preon: about 170 partial refreshes a day and a fast clean (1.7 s flash) about every 8.4 h; at the Flavon about
11,000 a day and a clean every 8 minutes (epaper-e1 §10's settings: 60 partials, fast clean).

## 6. The driver `fractonica_face` (D5)

**D5.** `hardware/drivers/fractonica_face/` implements a new **`hal::Face`** (`fr/hal/face.hpp`): `init(kind, cfg)`,
`update(unix_us | none, now_ms) → {redraw, dirty, sleep_us}`, `draw(canvas, box)`, `event(e)`, the setters and getters
of D2. It is the only component that includes the C library, so profiles without a face link neither the library nor
the core, and `FaceService` is tested on the host against a fake face, like the panel's FakeEpaper.
- `binds: none` (the Wi-Fi CSI driver's precedent); the face kind comes from the bound panel's traits (400 × 300 mono1
  → MONO400X300; codegen refuses any other panel this round).
- A new driver-manifest field `component_dirs` puts `clock/components/fractonica` and
  `clock/components/fractonica_ui` on the build's component path only for profiles that bind this driver. The library
  stays in `clock/` (one copy, its simulator and golden tests unchanged); the core is the sibling checkout, as for the
  clock today (or `FRACTONICA_CORE_DIR`).
- The library builds as gnu99 (its own CMakeLists); the core as the IDF default (gnu23), checked warning-free.

## 7. `FaceService` and its hooks (D6, D7)

**D6.** `fr/services/face_service.hpp/.cpp` in `fr_core`:
- **The loop** runs on one core timer, never polling: `update(now)` → if `redraw`, paint the dirty box into the
  panel's frame (D7) → arm the timer for `sleep_us`. The panel's own settle timer then sends one partial refresh with
  only the changed bytes (epaper-e1 D3). Drawing a whole 400 × 300 face is a few milliseconds of work on the core
  task *(inferred; measured on the bench)*.
- **The face's button** (on `paper-c6` the new key on GPIO 4, D16): click → `next`, double click → `select`, a hold of
  0.6–5 s → `long` (on release, so a longer hold does not also switch the mode), a hold of 5 s → power save on or off
  (D13; acted on at 5 s, while still held). There is no `prev` on one button (the hub's `input` has it).
- **Who has the screen.** At boot the face. When a hub client draws (`fill`, `text`, `bitmap`, `clear`, a picture,
  HTML), the face lets go (`shown` false) and stops painting; `show`, or a press of the face's button, takes the screen
  back with a full redraw (that press is not passed on as a clock event). Brightness and `refresh` are not drawing.
- **Saved across reboots** in NVS (namespace `fr_face`, keys with the port): mode, focus, step, UTC offset; SCALES is
  saved as NOW, as the clock does; written once the state has held for 5 s.
- **Time not set:** the face waits `wait_time_s` after boot for the wall clock (D1), then shows the library's "time not
  set" screen; it redraws as soon as the time comes.

**D7.** The hooks it needs, kept small:
- `Backend::paint(box, fn)`: the backend hands `fn` its writable 1-bit canvas clipped to `box`, then treats `box` as
  drawn (EpaperBackend now; the base refuses, so LVGL panels are unchanged). The library's canvas wraps the same
  memory (`FUI_FMT_MONO_ROW` is MSB-first rows, as the frame is; the face's theme maps ink to the frame's black).
- `DisplayService::set_screen_listener(listener)`: called when a hub command draws (D6).
- `ButtonService::set_listener(listener)`: presses, releases and clicks on the node, as `TouchListener` does for touch.
- `RtcService`: read the DS3231 into the wall clock, set it from the wall clock, and set or clear its alarm (D14).
- Codegen wires them through the existing peer mechanism, extended to a list of peers (D8).

## 8. Codegen, the profile (D8, D9)

**D8.**
- `ServiceFacts` for `fr.face`: implements `hal.Face`, peers `display` → `bind_display(DisplayService&)`, `button` →
  `bind_button(ButtonService&)` and `rtc` → `bind_rtc(RtcService&)`; `peer` becomes a list (fr.haptic's `supply`
  keeps working).
- The driver manifest gains `component_dirs` (D5); `components.cmake` lists them after the driver's own directory.
- Checks: the `display` instance exists, is `fr.display` and has the epaper trait at 400 × 300; the `button` instance,
  when given, is `fr.button`; the face's step is a valid level; `power_save` needs a `button` on a wake pin (GPIO 0–7
  on the C6) and an `rtc` with its `sqw` pin on a wake pin.

**D9.** `c6e-paper` gains three instances (slots.lock ports 4–6); the panel keeps its settings, `boot_clear` false:
- `face: { cap: fr.face, driver: fractonica_face, config: { display: paper, button: key, rtc: rtc } }`;
- `rtc: { cap: fr.rtc, driver: ds3231_i2c, bind: { sda: gpio.6, scl: gpio.7, sqw: gpio.5 } }`;
- `key: { cap: fr.button, driver: button_gpio, bind: gpio.4, config: { pull: up } }`.
BOOT stays the plain `boot` button. The wiring guide `epaper-c6` gains the DS3231 (VCC 3V3, GND, SDA 6, SCL 7,
SQW 5) and the key (GPIO 4 to GND), with lcd-clock-c1's note on the ZS-042's charging diode and a CR2032.

## 9. The dashboard (D10)

**D10.** `pages/device/face.tsx` replaces its placeholder with the face's controls: mode, focus, step and UTC offset;
Show; the four `input` buttons; a line stating whether the face has the screen and whether the node knows the
time; and a Power save switch that says, before it is turned on, that the device then leaves the network until the key
is held 5 s. The panel's picture is the e-paper block's (epaper-e1 D11). A drawn mirror (the face rendered in the browser
from the reported state) needs the clock library in WebAssembly: a follow-up.

## 10. Power save (D13–D17)

The owner asked for a mode that relies only on the DS3231, sleeps between redraws and never turns Wi-Fi on. The
owner's answers: the DS3231 on SDA 6, SCL 7, its SQW alarm pin on GPIO 5; **deep sleep**; a second button on GPIO 4
to wake it (the C6 can wake from deep sleep only on GPIO 0–7, so BOOT on GPIO 9 cannot).

**D13. Turning it on and off.**
- **On:** `set {power_save: true}` from the hub, or holding the key 5 s. Before it goes, the node sets the DS3231 from
  the wall clock when the hub's time is good (so the clock starts right), says BYE with reason `sleep` (the hub shows
  it asleep, not lost), and saves the mode in NVS. If neither the hub's time nor a valid DS3231 is there, it refuses
  (`time not set`): a clock that does not know the time would sleep for nothing.
- **Off:** holding the key 5 s (the only way, since nothing listens on the network). The node saves the mode, restarts
  and joins the hub as usual; the hub's time then takes over from the DS3231.
- The mode is the node's NVS flag only (no profile default: a node that left the network at its first boot after a
  flash could not be reached to say otherwise).

**D14. Time and waking.**
- At each wake the DS3231 is read into the wall clock (D1, source `rtc`); nothing else sets the time in power save.
- Before sleeping, the face asks the DS3231 for an **alarm at the next step boundary**, rounded up to the second (the
  chip counts whole seconds): its SQW pin pulls GPIO 5 low and wakes the C6, so each redraw lands within a second of
  the boundary. The wake clears the alarm flag (a flag left set would hold SQW low and wake the chip at once).
- A timer wake 2 minutes after the alarm is armed as well, in case the alarm never comes (a loose wire): the face then
  draws and says so in the log; the C6's sleep timer is too rough to keep time by *(inferred: its slow internal
  oscillator)*, so it is only the backstop.
- The DS3231 keeps time to about ±2 ppm, a minute a year at most (datasheet, 0–40 °C); its aging trim
  (`rtc_aging`) is set while the node is on the network.

**D15. One wake.**
- The node boots (a deep-sleep wake is a fresh boot), reads the NVS mode, and **does not start the network at all**:
  no Wi-Fi, no ESP-NOW, no hub link (`fr_net` constructed, never started; events go nowhere).
- The face draws the new instant; the panel sends one partial refresh, then the controller goes into its own deep
  sleep; the pins the panel needs (RST, CS, DC) are held, and the C6 sleeps until the alarm or the key. Awake about
  1–1.5 s per step *(inferred; measured on the bench)*.
- **The picture on the glass survives the sleep** (e-paper keeps it with no power), but the C6's RAM does not, and
  partial refreshes need the old picture. The `shown` frame (15,000 B) lives in the C6's LP memory, which stays
  powered in deep sleep (16 KB on the C6; that it fits beside what ESP-IDF keeps there is *inferred*, the link map
  checks it), with a CRC: after a wake the panel knows its glass and sends only the change. A power-on, or a CRC that
  does not match, gives one fast refresh instead.
- The panel's ghost budget (partials since a clean, the 24 h clean) is kept the same way, counted in wall time.
- **The key** wakes it: the wake press itself only wakes (the gesture is over before the node is up); then the key works
  as usual for `awake_s` (30 s) after the last press, the node staying awake, still with no network. Holding the key
  through the wake for 5 s leaves power save (D13).

**D16. Wiring and the second button.** The key on GPIO 4 to GND, pulled up by the C6 (the LP pull-up, held in deep
sleep; an external 10 kΩ to 3V3 if the bench shows otherwise). SQW is open-drain, pulled up by the ZS-042 module to
its VCC. GPIO 4 and 5 are strapping pins only with non-default eFuses (board manifest); GPIO 6 and 7 are free.

**D17. What it draws.** Wake, at the Preon step: about 1–1.5 s awake at tens of mA every 8.4 min, a fraction of a
milliampere on average *(inferred)*; asleep the C6 takes about 7 µA (datasheet). The rest is the boards: the Super
Mini's power LED and the ZS-042's LED stay lit and draw more than the sleeping chip (*inferred*); for a battery, remove
them (and the ZS-042's charging diode with a CR2032). Running from a battery and measuring it are follow-ups.

## 11. `fr.clock` → `fr.rtc` (D11)

**D11.** The owner chose to rename in this change, so one reflash covers both.
- The capability keeps id **0x0010** (ids are never reused); `clock.cap.yaml` → `rtc.cap.yaml`, the service
  `ClockService` → `RtcService`, generated files `fr.clock.*` → `fr.rtc.*`.
- Ops `clock_read`, `clock_sync`, `clock_set`, `clock_aging`, `clock_drift` → `rtc_*`; CLI `fr clock …` → `fr rtc …`,
  and **`fr clock` stays as an alias** (the CLI has no alias mechanism today: one is added for command groups).
- The profile `c6l-lcd` keeps its instance name `clock` and port 5; the driver `ds3231_i2c` already implements
  `hal.Rtc` and keeps its name; the skill `storage-clock` keeps its name, its text says `fr rtc`.
- Its boot seed of the node's time goes through D1's wall clock (ranked below the hub).
- `fr.rtc` keeps version 1.0: the same contract under a new name. The DS3231 driver gains an optional `sqw` bind pin
  and the alarm used by power save (D14), internal to the node: no command exposes it this round.
- Boards flashed before the rename report the old capability name from their stored build manifests until they are
  reflashed *(inferred)*.
- `CATALOG_HASH`, `REGISTRY_INPUTS_HASH` and `REGISTRY_HASH` move again (they already moved for fr.display 1.3); the
  lab hub and uriel refuse a CLI from this tree until they run it.

## 12. Docs, tests, follow-ups (D12)

**D12.** Spec 07 (fr.face, fr.rtc, the id table), 05 (the node's wall clock from TIME and WELCOME), 09 (`rtc_*`, the
alias); the user manual (§25 gains the face and power save; the RTC section renamed); AGENTS.md; clock/AGENTS.md (the fifth face, the
step); `lcd-clock-c1.md` and `epaper-e1.md` §11 pointers here.

Tests: the library's `make test` with the new face and the step (goldens for the other faces unchanged); host C++
(wall clock, FaceService against a fake face and the fake panel: boot, wait for time, steps, show and yield, buttons,
NVS; power save against a fake sleep and a fake DS3231: on and off, the alarm and the backstop, the network never
started, the glass kept across a wake and a CRC mismatch); codegen (the driver, peers list, component dirs, refusals); protocol (fr.face, the rename, hashes); hub and CLI
(the rename, the alias); dashboard (the face page). Builds: `c6e-paper` debug and release; size and static RAM
recorded.

**Follow-ups:** the round GC9A01 clock profile without LVGL and the rest of stage 5; the face on the C3 OLED (its
128 × 64 face exists; MonoBackend needs `paint`); a drawn mirror; SNTP; running from a battery, with its reading.

## 13. Bring-up (each step that flashes or opens a port needs the owner's go-ahead)

1. The simulator's PNGs of the new face (NOW pure and earth, SCALES, LENS, SUN, STAMP, time not set) to the owner.
2. Flash `paper-c6` (USB or OTA through the lab hub). The face appears after the time arrives; a log line says where
   the time came from.
3. Watch a few Preon steps: one partial each, only the changed area moves; compare with the core's reading.
4. Buttons: click, double click, long press; the label clears.
5. `display_text` takes the screen; a click or `show` gives it back.
6. `set {step: flavon}` for a few minutes, then back; reboot (the state and the time survive a software reset).
7. Line widths: the owner judges the one-pixel ring on glass (D3).
8. The owner wires the DS3231 (SDA 6, SCL 7, SQW 5) and the key (GPIO 4); `rtc_read` shows a valid time after
   `rtc_sync`.
9. Power save on from the hub: the device leaves the network; with `step: flavon` for a few minutes, each redraw comes
   within a second of its boundary and only the change moves; the serial log (with the owner's go-ahead to open the
   port) shows each wake and how long it was awake.
10. The key wakes it and works for 30 s; holding it 5 s leaves power save and the node rejoins the hub.

### 13.1 As done (2026-11-24, the owner's go-ahead: lab hub restarted on this code, paper-c6 updated over the hub)

- Builds `49792e472340`, then `72748b62f47c` (power save refused while the RTC does not answer: it was not wired, and
  power save without its clock would have left the board off the network not knowing the time), then `64d0604f3394`
  (`set` redraws at once: it had waited for the wake the old step asked for). Each update 9.4 s through the hub.
- Selftest: the panel answered; `rtc` "DS3231 does not answer" (not wired yet); the face "400x300, shown, time hub,
  can sleep". `face.set {power_save: true}` answers FAILED without the DS3231.
- Step 2-3: after boot one full refresh (3.33 s, the glass not known). At `step: flavon` one partial (0.362 s) every
  7.74-7.84 s (the Flavon is 7.773 s), each covering only what changed: 24 x 70 px for the λ count, up to 312 x 203
  when the ring's arcs moved. Back to the Preon after.
- Step 5: `display_text` took the screen (`shown` false), nothing was painted over it for two steps, `face.show` gave
  it back with one partial.
- Step 7: the owner looked at the glass ("looks good") and asked for the layout above; build `15b238d7dda2` has it.
- Then "thicker lines and a different font": the wave and the inner circle at 2 px (to come dotted 2 on, 3 off), the
  glyph strokes at 3 px, the now block 9 x 9 (a one-bit "pen" on the canvas, `fui_canvas_set_pen`; other faces keep
  1 px). Three corner fonts were drawn for the owner (dots, a new bold bitmap, a new monoline stroke font); the owner
  picked the monoline one; the other two were then removed (the library 41 KB of flash on RISC-V, the line font's
  table 1.4 KB). Build `d0ec7bbe61ad` (debug, 1,644,688 B) runs on paper-c6.
- Not done yet: the key and the DS3231 (steps 4, 8-10).

## 14. The owner's answers (2026-11-24)

1. **Scope:** the e-paper face only; the round clock and retiring the standalone firmware later.
2. **`fr.clock` → `fr.rtc` in this same change**, `fr clock` kept as an alias.
3. **Layout:** the ring on the left, the reading stacked in a column on the right.
4. **Cadence:** adjustable, the Preon by default.
5. **Power save** (added by the owner): rely only on the DS3231, sleep between redraws, never turn Wi-Fi on. The
   DS3231 on SDA 6, SCL 7 with SQW on GPIO 5; deep sleep; a second button on GPIO 4 to wake it.
6. **The design is approved** (with power save); build it in the order of §16.
7. **Three keys and sounds** (2026-11-25, §17): two more buttons for left and right, "move between periods", the centre
   button "switches the face"; a buzzer on GPIO 23; sounds for period rollovers of a Preon or longer, configurable
   later; a sound for each button press. The owner had wired the buttons to GPIO 12 and 13 and offered 21 and 22.

## 15. Risks

- **Thin lines.** One-pixel arcs and glyph strokes at R ≈ 70 may look faint on this glass; widening them is library
  work on the one-bit rasteriser (D3, bench step 7).
- **The core is a sibling checkout.** A machine without `../core` (or `FRACTONICA_CORE_DIR`) cannot build `c6e-paper`;
  the error says so. Other profiles are unaffected.
- **Hub time accuracy** is the least one-way delay of a burst: milliseconds on Wi-Fi *(inferred)*; through a gateway,
  BEACON's delay is unknown but small against 7.8 s.
- **Wear at a fine step:** the Flavon is about 11,000 partials a day; the panel's partial-refresh life is not published.
- **Catalog change:** every fleet device needs a reflash (already true for fr.display 1.3).
- **LP memory.** The kept frame needs 15,000 of the C6's 16 KB of LP memory; if ESP-IDF's own use leaves less, the
  face re-draws the last instant into `shown` instead (the drawing is a function of the state) and checks the CRC.
- **A device in power save is off the network**: no OTA, no logs, no commands until the key brings it back. With a broken
  key the way back is a USB flash that erases NVS; the C6 can be reached asleep through its download mode (BOOT
  held while plugging it in).
- **The framework was never booted from deep sleep before**: anything that starts the radio outside `fr_net`, or a slow
  start-up, shows on the bench (step 9).

## 16. Tasks

- **T1** `fr.rtc` rename (schema, service, codegen, protocol, hub, CLI alias, dashboard, docs, tests); `fr gen`.
- **T2** D1 wall clock (fr_core) and `Net` feeding it; RTC seed through it; host tests.
- **T3** Library: step (D4), then the 400 × 300 face (D3); simulator tests and PNGs to the owner.
- **T4** `fr.face` schema (D2); `hal::Face`; the driver (D5); `Backend::paint`, the screen and button listeners (D7);
  `FaceService` (D6); host tests.
- **T5** Codegen (D8), profile (D9), protocol vectors and hashes.
- **T6** Dashboard (D10); docs (D12).
- **T6b** Power save: the DS3231 alarm and `sqw`, the offline boot, the sleep and wake platform, the glass in LP memory,
  the key; host tests; the wiring guide (D13–D17).
- **T7** Checks: typecheck, `fr gen --check`, host C++, vitest, the library's `make test`, `c6e-paper` debug and
  release builds. Then the bench (§13) with the owner's go-ahead.

## 17. Three keys and sounds (D18, D19; 2026-11-25)

Asked for by the owner after the bench (§14 item 7). Built the same day; not yet on glass.

**D18. Three keys.** `fr.face` gains `left` and `right` (fr.button instances, empty: none). With either bound:

- **left** is the library's PREV and **right** its NEXT, each at the **press** (no wait for a second click): on NOW and
  SCALES the focus one level coarser or finer, "between periods"; on LENS the inspected level; on SUN and STAMP a
  page back or forward (the library's own rules, fui_ui.h NAVIGATION).
- **the centre** (`button`) turns the screen: a release before 0.6 s is SELECT (NOW → LENS → SUN → STAMP → NOW, "switches
  the face"), 0.6–5 s LONG (pure ↔ earth), a 5 s hold power save on or off as before. It acts at the release, so two
  quick presses are two selects.
- Any key takes the screen back from a hub picture (no clock input) and keeps a power-save node awake `awake_s`.
- Without left and right the one key keeps D6's gestures (click next, double click select).

The two buttons go **to GND** like the centre one (`button_pin`: the C6's pull-up, active low). **Not on GPIO 12 and
13**: the Super Mini's USB data lines (the board manifest reserves them), the node's link to the hub; a press there
would cut it. They are on **GPIO 21 and 22** (the board's free pins), which are not deep-sleep wake pins (the C6 wakes
on LP IO 0–7 only; 0 is the only one left): in power save the centre key wakes the node, then all three work. Codegen
refuses one button instance named as two keys (a ButtonService has one listener).

**D19. Sounds.** `fr.face` gains `buzzer` (an fr.buzzer instance), `chime` (enum `off`, `helion`, `theta`, `preon`; default
`preon`: the shortest period whose start chimes) and `clicks` (bool, default true); `chime` and `clicks` are also
properties and `set` fields, kept in NVS (keys `f<port>c`, `f<port>k`) as the owner asked for "the ability to configure
later". The sounds (pitches where a piezo or magnetic buzzer is loudest, 2–4 kHz; at the buzzer's own volume):

| When | Sound |
|---|---|
| left / centre / right pressed | a 20 ms click at 2.4 / 2.7 / 3.0 kHz |
| a long press, at its release | 60 ms at 1.8 kHz |
| power save on / off (5 s hold) | two notes falling / rising (2.7 and 1.8 kHz) |
| power save refused (the RTC does not answer) | two low notes (1.2 kHz) |
| a Preon begins | one note (G7) |
| a θ (34 min) begins | two notes (E7 G7) |
| a Helion begins | three rising notes (C7 E7 G7) |
| anything longer begins | four (C7 E7 G7 C8) |

`clicks` covers every key sound; `chime` the rest. **The chime** comes when the face moves onto the very next cycle of
its step and a period of `chime` or longer began there: `hal::Face::rollover(from, to, step)` asks the core for the
cycles' global indices (`frc_cycle_at`), and answers the coarsest level whose cycle changed, or nothing when the step's
cycle is not the next one (a time that jumped or went back, the first update after a boot). So the face chimes only
while it has the screen and knows the time, and only at the steps it moves on: with the step at the Helion a Preon
chime never comes. In power save the instant the node went to sleep (KeepHeader) is the "from", so an alarm wake at the
next step chimes; the node then stays awake until the sound has ended, and leaving power save restarts after its
sound (both at most kSoundWaitUs).

The sounds are the node's own: `BuzzerService::tone_local` and `melody_local` play like `tone` and `melody`, except that
a hub gone quiet never ends them (fr.buzzer's hub-silence rule is for sounds the hub started). A host test found every
chime cut to its first note by that rule while the hub was silent.

**Wiring:** the buzzer module's S to GPIO 23 (through 100 Ω for a magnetic buzzer), − to GND, + free (passive buzzer,
`ledc_buzzer`, as stepper-c3's). An active buzzer needs another driver. In deep sleep GPIO 23 is not held: the pad
floats, which a passive buzzer ignores. The wiring guide `epaper-c6` gains a section for the keys and the buzzer.

**Profile:** c6e-paper gains `left`, `right` (button_pin) and `buzzer` (ledc_buzzer, gpio.23) at slots.lock ports 7–9;
the face names them. The dashboard's face block gains a Back press and, on a device with a buzzer, a Sound row
("chimes each Preon and longer; keys click"). Catalog hash 0xd7e86b68 → **0xc76ae4a2** (then **0x4ba4b62a** with the
doc of the wake keys below); the op registry is unchanged.

**The keys' pins, as the owner wired them.** The first map (left 21, centre 4, right 22) and a second (centre 22, right
4: "swap the middle one with the right one") both missed: the owner's row is **left GPIO 22, middle GPIO 21, right GPIO
4**, so the centre `key` is on GPIO 21, `left` on 22 and `right` on 4 (ports unchanged: key 5, left 7, right 8). GPIO 4
is the one key on a wake pin, so power save wakes on **any of the face's keys on a wake pin** (codegen: `can_sleep`
needs a centre button, one key on a wake pin and the RTC's alarm on one; `SleepPins.keys` is their mask): the right key
wakes the node, the centre key held 5 s leaves power save. A key held through the wake is no input (ButtonService never
makes a click or a press of a button held through boot). The second map ran on paper-c6 (`35c395d6b20c`, the owner's
go-ahead): right (GPIO 4) next at the press, GPIO 22 select at its release, the Preon chime at 14:26:49 UTC.

**D20. Partial refreshes on the real controller.** On the bench a card's text came back around the wave after the face
had replaced it (the owner's photo; then reproduced with cam-esp32-2 pointed at the glass, through the plain display
path: the face, the three cards and the face again in one second, then three focus changes, and the card's header and
lines reappeared outside the wave's box while the corners vanished; no key, no buzzer). The cause: the SSD1683 on the
Waveshare 4.2" V2 runs with its factory display options (the driver sends no 0x37), and after a partial refresh its two
RAMs trade places, so the RAM written as `next` for the following refresh holds the picture from two refreshes back.
EpaperBackend wrote `next` over the change only and `prev` over the change and the last one; around a small change
after a large one, `next` then still held the card. Now **both planes are written over the change and the last
refresh's change** (`stale_`: where the RAMs last differed, tracked while `next` is written, so a drawing between
chunks counts), which is right whether the RAMs trade places, keep their contents or are copied. The cost is bytes: a
small change after a full-screen one writes the larger box once more (about 2 × 14 KB at 10 MHz, some 25 ms). The host
fake now trades its RAMs after a partial (as the panel does), a test replays the bench's case, and the randomized test
(draws at any moment) runs on both kinds of controller. Earlier on the bench the leftovers were put down to buzzer
noise; the camera showed that was wrong.
On paper-c6 (the owner's go-ahead, build `681033586826` over USB, 2026-11-25): selftest all ok; the camera's runs
that brought the card back before (the face, the three cards and the face in one burst, then three and two focus
changes; cards and a focus change; two steps back) left the face clean, corners and all, no card text.

**Checks (2026-11-25):** host C++ face 17 (5 new: three keys, clicks and chimes with their settings kept, power save's
chime and its wait, leaving after the sound, sounds kept through a silent hub), buzzer 21; vitest codegen 301,
protocol 510, dashboard 342; `fr gen --check` 0 stale; `fr wiring check epaper-c6` ok.

**On the bench (2026-11-25, the owner's go-ahead):** the lab hub restarted on this code; `c6e-paper` built through it
(`6124285116a6`, 1,668,256 B). An update over Wi-Fi was refused by the node (identity: paper-c6's NVS identity still
names `c6-pad`, the profile it was provisioned with as pad-c6; every update so far went over USB, which keeps the
identity); over USB it took 9.3 s. Selftest: all nine instances ok, the face "3 keys, sound, can sleep", the DS3231
answering (now wired), the buzzer's LEDC channel 4 silent at idle. The hub reports `face.chime preon`, `face.clicks
true`.
Then the owner pressed the keys (2026-11-25 16:09-16:11 MSK, watched in the hub's events): left (GPIO 21) and right
(GPIO 22) act at the press (on NOW and SCALES the focus 6 → 13, then 0 → 13 again; on the cards a page back or on),
the centre turns now → lens → sun → stamp → now at its release, two quick presses being two selects; every press
clicks (`buzzer.done tone done` 20-90 ms after the key's `down`). The Preon chime came at 16:11:02, the boundary
`fr time` gave, a tone with no key pressed. Seen in passing: while keys are pressed fast with both the USB and the
Wi-Fi link up, the hub resyncs the node's state every few seconds (spec 05, "Properties and ordering": a HEARTBEAT's `state_seq` ahead of
the newest STATE seen, so some STATE frames were dropped); each click adds `buzzer.playing` twice and a `done` event to
the key's own reports. Nothing is lost (the resync restores it); quieter local sounds (no `done`, no `playing`) are a
possible follow-up.

