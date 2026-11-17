# STEPPER-1: a micro stepper motor on a DRV8833, driven by an ESP32-C3 Super Mini

> **As built, 2026-11-17** (T1–T8 of §12, then the review's twelve findings; nothing flashed, nothing run on hardware
> yet; not committed).
>
> **Where it is:** the capability (`schema/capabilities/stepper.cap.yaml`, D2 but for the nFAULT sentence of its doc,
> CATALOG_HASH 0x616bf0f2), the motion core and `hal::Stepper` (`fr_core/include/fr/{motion,hal}`), the driver
> (`hardware/drivers/drv8833_stepper`),
> `StepperService`, codegen's `fr.stepper` SERVICES entry, the board `esp32c3-supermini`, the profile `c3s-stepper`
> (`slots.lock` boot 1, status 2, motor 3; `firmware/apps/node/dependencies.lock.c3s-stepper`), the guide `stepper-c3`
> (now with `profile`, `covers: [motor]` and the six instance rows) and its four parts, the dashboard's words and
> stepper panel, `tools/fake-stepper.ts` (`dash-dev --stepper`) and the user manual's §22.
>
> **Checks (2026-11-17, after the review's fixes):** `pnpm fr gen --check` 0 stale; `pnpm typecheck` clean; vitest
> per package, all green (protocol 437, codegen 274, sdk 31, time 38, host 33, cli 184, dashboard 315, hub 1555; two
> timing tests, cli's `fr serial idf` lease and hub's `display_snapshot` bounds, failed once under the parallel C++
> build and pass alone; the T2-FLOOD dry run needs `build/host-fleet/fr_fleet` rebuilt after fr_core changes, as its
> staleness check says); the host C++ suite 1034 passed (ASan + UBSan); `wiring_check stepper-c3` against the repo:
> ok, no errors or warnings. The ESP-IDF v6.1 build of `c3s-stepper` for esp32c3 (§10's command, debug) links with no
> compiler warning, both GPTIMER lines in `sdkconfig`, image 0x142ec0 (33 % of the app slot free), DRAM 69.6 % used.
> The map check (re-run after the fixes; `decide` and `on_alarm` still load nothing from flash and call no libgcc):
> - every function the step and fault ISRs reach is in IRAM or ROM. Followed from the disassembly, from `Isr::alarm`,
>   `Isr::fault`, `gptimer_default_isr`, `EspInputSlot::update_from_isr` and the safe-off hook, `auipc`+`jalr` far
>   calls included: 38 functions, among them `StepEngine::on_alarm`, `decide`, `step_us`, `isqrt`, `sqrt_round`,
>   `PhaseTable::at`/`sine`, `drv8833::drive` and every `*_locked`. None loads from flash `.rodata` except to pass an
>   assert's strings. The one call into flash is `update_from_isr`'s `xTaskNotify`, on its task-context branch only
>   (`inject_fault`);
> - the driver and service objects, `s_alarm` and `kCoast` are in DRAM (0x3fc…). `kQuarterSineQ15` stays in flash
>   `.rodata`, read only by `PhaseTable`'s constructor at static init; the ISR reads the engine's DRAM copy. The
>   constructors and destructors are in flash text (static init, task side).
>
>   The short form, after the build:
>   `riscv32-esp-elf-nm -C build/c3s-build/fr_node.elf | grep -E 'Drv8833Stepper::(Isr::|[a-z_]+_locked)|StepEngine::on_alarm|motion::(decide|step_us|isqrt|sqrt_round)\(|PhaseTable::(at|sine)\(|drv8833::drive\(|inst_motor::driver' | awk '$1 !~ /^(403|3fc)/ {bad=1; print} END {exit bad}'`
>   (19 symbols, exit 0).
>
> **The module as wired differs from §8 and D13–D14:** the owner's DRV8833 board has the TB6612-style pinout
> (labelled side: NC AIN2 AIN1 STBY BIN1 BIN2 NC GND | VM NC GND AO1 AO2 BO2 BO1 GND). STBY is the DRV8833's nSLEEP,
> and nFAULT is not brought out. So `c3s-stepper` binds ain1 gpio.6, ain2 gpio.5, sleep gpio.7, bin1 gpio.10,
> bin2 gpio.20 and no `fault` (the driver takes it as optional: no fault ISR, `fault_asserted()` always false;
> `inject_fault` still works); the guide's pull-up check measures STBY only, and the 100 µF is optional. Its config
> is the bench motor as measured: coil 20.5 Ω (set to 20, the safe side), VM 5.2 V (`supply_mv` 5200), `run_ma` 150
> (58 % duty; the motor, an 8 mm camera-lens stepper, is rated 3.3 V, about 160 mA), `hold_pct` 30. GPIO3 and GPIO4
> stay free. The motor's pins 1–4 alternate A1 B1 A2 B2.
>
> **On the bench, 2026-11-17:** provisioned as stepper-c3 (the hub restarted to learn fr.stepper). The first motor
> never moved: STBY high, both coils at the right voltages (1.3 V each at a half step), current flowing and the can
> warm, yet the shaft turned freely even energised. It was faulty; a second motor of the same kind turned at once
> and ran ten turns out and back twice at 150 mA with no lost step. The dashboard's stepper panel threw on a
> negative speed (a spin back): `rateText` now writes a negative rate as the magnitude after a minus sign.
>
> **Where it departs from the text below** (each task's report has the detail):
> - **Engine (§4):** a step's interval is the exact time of its ideal ramp/cruise profile, not `2e6/(√v₀²+√v₁²)`
>   (infinite for a rest-to-rest step); they are equal on a pure ramp. Braking to rest puts the remainder into the
>   first step, so the last step always runs √(2a) → 0. `Start.delay_us` is always 0: the first alarm takes the
>   first step, and the driver places it after the 1 ms wake. Added: `release()`, `vector()`, `speed_sq()`. A
>   request's accel 0 keeps the running one. Bounds also cap v² in position mode. §10.2 10 runs the ends of the
>   ±10⁹ move, not all 2·10⁹ steps.
>   - *Review:* after a slip the returned interval is the from-rest step plus `late_us` (saturated), so the driver's
>     `due + interval` puts the re-ramp's first step √(2/a) after the late alarm, where the step was taken; it had
>     been `late_us` short (up to 100× the acceleration). The `Tick` contract is unchanged.
>   - *Review:* D5's bound clamp `vsq′ = min(vsq′, two_a·r_bound)` cut v² in one step when a move or jog with a lower
>     accel replaced a fast motion near a bound. When v² > 2a·room the step now brakes evenly onto the bound,
>     `vsq′ = v² − ⌈v² / room⌉` (rests exactly there; never harder than the accel it arrived with, which kept
>     v² ≤ 2a_old·room). `step_us` times such a step as a ramp. `review_motion_test.cpp` pins both.
> - **Driver (D5, D7–D9):** `pwm_hz` is 16,000–39,000 (11 bits from 80 MHz top out at 39,062 Hz). The driver keeps
>   an electrical phase offset, so `zero` and a step-mode change while holding do not move the rotor. `command` wakes
>   the bridge only when a motion actually starts. The nFAULT ISR ignores a glitch and any edge while not fully awake.
>   The cut also writes coast to the four channels, and the core task is notified after the critical section. One
>   driver instance per node. Without a sleep pin the wake is immediate.
> - **Service (D10–D11):** a fault puts motion in `fault` from any state (released too, for `inject_fault`). A bad
>   kept value is counted (`settings_ignored()`), not logged. `hold` while moving is BUSY. A zero-length move or jog
>   answers `done` at once without waking the driver. With `m` not kept, `configure` writes every key. The config
>   check refuses more zero values than D10 lists. `run_permille` is at least 1.
>   - *Review (D11):* `m` is a commit mark. When `m` is kept and a key other than `m` changes, `configure` first
>     writes `m = 0` (`kUnmarked`: no layout; it loads as nothing kept and is not counted as ignored), then the
>     changed keys, then the new `m`. A refused write or a reboot in between therefore boots the build's
>     configuration, never old keys mixed with new ones (a refused `supply_mv` after a written `coil_ohm` had booted
>     twice the run duty). This replaces "a reboot mid-way loads either the old set or the new one": that needs two
>     banks of keys; the build's configuration is D11's own fallback when `m` is not written. `m` alone (a flag or
>     `hold_pct`) stays one write.
>   - *Review (D10):* a rest the engine made by itself that the poll has not seen (up to `kPollUs` at the end of every
>     motion) is taken first by `on_fault`, and by `halt` and `release` when the step ISR rests the motion between
>     the service's look and the driver's lock: that motion's done is its own (`reached`, …) and `position_known`
>     stays (the cut came at rest), instead of `done {fault|halted|released}` judged from the last poll's speed.
>   - *Review (D2):* `target` is the running move's; a jog's or a stop's follows the position with each position
>     report (the fake's rule, and what the panel's "going to" mark expects). A stopped move's `done.target` is still
>     the move's.
>   - *Review:* the DRV8833 does not report under-voltage on nFAULT (datasheet, "Device Protection": UVLO has no
>     report; the chip stops and resumes by itself). The capability's doc, §0, §8's part, the part file and the
>     manual's troubleshooting say so; a VM sag is silent and `position_known` does not cover it.
> - **Guide (D14):** `module-pullups` is in the power section, after `vm`, and measures with the real 5 V wiring;
>   its note gives §14's remedies (not the 15 kΩ divider, unsafe with a 4.7 kΩ module pull-up). *Review:* the
>   `first-hold` step and the power-cap safety line name no `run_ma` (pure mode's `heldText` reads `_ma` as a unit
>   and garbled the copy-paste command); the step points at the manual's §22.1 step 3. `map.svg`: the 100 µF is not
>   "optional", and the direction setting is `invert`.
> - **Bring-up (§11, manual §22.1):** the top-speed step first raises `max_speed_hz` (a jog above it is
>   INVALID_ARGS); the manual's troubleshooting lists INVALID_ARGS and a silent supply sag.
> - **Fake board (D16):** `hold` while moving answers BUSY, as the service; HELLO says chip ESP32-C3 (`FakeNode`'s new
>   `chip` option, default C6).
> - **Dashboard (D15):** the Motor block sits above the generic body; `seconds` has unit s; "Set position here"
>   sends `zero {}`. **Manual (D16):** a new §22, not among §3–12.
>
> **Open:** everything in §13's list is still unverified, and the ISR cost per step is unmeasured. In
> `c3s-stepper`, `button_gpio` installs the GPIO ISR service first without `ESP_INTR_FLAG_IRAM`, so the nFAULT cut
> waits while flash is busy (D9 step 7's "when it allows it"; the DRV8833 protects itself meanwhile). No VM
> monitoring: a supply sag below UVLO goes unseen. `fr send` exits 0 on a refused command (`status: invalid_args`),
> so §11's shell loops cannot test its exit code. Next: the owner flashes (with a go-ahead) and runs §11.

> **Draft, 2026-11-17.** Asked for: "work on micro stepper motor implementation … first I need a wiring diagram,
> and while I wire it up, implement robust motor control logic so we could test it", with photos of the parts: a
> red DRV8833 module and a 10 mm micro stepper. The diagram exists (`hardware/wiring/stepper-c3/map.svg`); this
> document designs the rest. Decisions here are proposals the owner can overturn. Anything marked *inferred* was not
> read in a datasheet, in code or on the bench.
>
> Fixed by the owner (2026-11-17):
> - the board is a **new ESP32-C3 Super Mini** (black, blue LED on GPIO8 active low, BOOT on GPIO9, no OLED);
> - the wiring is fixed: GPIO5 → AIN1, GPIO6 → AIN2, GPIO7 → BIN1, GPIO10 → BIN2, GPIO4 → nSLEEP (high = awake),
>   GPIO3 ← nFAULT (low = fault), the board's 5V (USB) → VM, GND common;
> - nothing in this work flashes a board, opens a serial port or starts a hub on port 7420.

## 0. The parts

- **The module** (photo IMG_6979): a red breakout with a genuine-looking TI **DRV8833** (marking "DRV8833 / TI 83K
  AV16"), a **10 µF tantalum** ("106E") on VM, and two small SMD parts beside the chip.
  - The two SMD parts are most likely the chip's own VINT and VCP capacitors (*inferred*: the DRV8833 needs both).
  - No pull-up resistor is visible on the top side; the underside was not photographed. So nSLEEP is probably held
    low only by the chip's internal pull-down, and nFAULT (open drain) has no pull-up (*inferred*).
  - Silkscreen names on such modules vary: VCC = VM, IN1–IN4 = AIN1/AIN2/BIN1/BIN2, OUT1–OUT4, **ULT** = nFAULT,
    **EEP** = nSLEEP (map.svg says so).
- **The DRV8833** (TI datasheet; numbers to re-check against it):
  - VM 2.7–10.8 V;
  - 1.5 A RMS per H-bridge, 2 A peak;
  - logic inputs: VIL ≤ 0.7 V, VIH ≥ 2 V, so 3.3 V logic is fine. Internal pull-downs on every xIN (≈ 100 kΩ) and
    on nSLEEP (≈ 500 kΩ) (*inferred* values);
  - nSLEEP high wakes it in about 1 ms (t_WAKE, *inferred*); low puts every output in high impedance;
  - nFAULT is open drain and goes low on over-current (the bridge retries by itself after about a millisecond) and
    over-temperature only. A VM below the under-voltage lockout (UVLO) is not reported: the chip disables its bridges
    and resets its logic, and resumes by itself once VM recovers (datasheet, "Device Protection");
  - the bridge logic, per coil:

    | xIN1 | xIN2 | Output |
    |---|---|---|
    | 0 | 0 | coast (outputs off): fast decay |
    | 1 | 0 | forward |
    | 0 | 1 | reverse |
    | 1 | 1 | brake (both low sides on): slow decay |

  - The chip has its own dead time, so **no input combination can short the supply**. Any glitch between two input
    states is harmless.
  - **No current regulation here.** Current chopping needs sense resistors on AISEN/BISEN. This module (photo)
    has none, so the ISEN pins are tied to GND (*inferred*). Current is set only by the PWM duty, the coil's
    resistance and VM. Over-current protection trips at about 2 A or more, which a 10–40 Ω coil on 5 V (0.5 A at
    most) never reaches. nFAULT therefore means a short or heat, never "too much current for this
    motor".
- **The motor** (photo IMG_6980): a 10 mm can-stack micro stepper with a mounting flange, a **brass pinion** (not a
  lead screw, so rotation is unlimited) and four pins on a side terminal.
  - Two-phase bipolar, two coils (*inferred*).
  - 18° per full step = 20 steps per turn (*inferred*: typical for the size; the bring-up's one-turn test checks it, §11).
  - Coil resistance 10–40 Ω (map.svg), unknown until measured.
  - Rated 3–5 V (*inferred*).
  - Pull-out rate at 5 V of about 300–800 full steps/s (*inferred*). It runs warm when held at its rated current.
- **The board:** an ESP32-C3 Super Mini (ESP32-C3FH4: single RISC-V core at 160 MHz, 4 MB in-package flash).
  - USB-Serial-JTAG on GPIO18/19.
  - Headers (map.svg): left row `5V GND 3V3 4 3 2 1 0`, right row `5 6 7 8 9 10 20 21`.
  - Strapping pins 2, 8 and 9; none of them is used here.
  - 6 LEDC channels and 4 LEDC timers.
  - 2 general-purpose timers (one per timer group), unused by IDF's own services on this chip (esp_timer uses SYSTIMER).
  - These boards are known to need a reduced Wi-Fi TX power (8.5 dBm). That is why the OLED C3 board has
    `max_tx_power_qdbm: 34`; this one takes the same value.

## 1. Scope

**In:**
- a capability **`fr.stepper`** (D1);
- an L1 contract `hal::Stepper` (D3);
- a pure, hardware-free **motion core** in `fr_core` (D4–D6);
- a driver **`drv8833_stepper`**: microstepping by PWM on the four inputs, a gptimer step ISR and an nFAULT ISR (D7–D9);
- a service `StepperService`: power policy, faults, NVS settings, hub silence, events (D10–D12);
- the board **`esp32c3-supermini`**, the profile **`c3s-stepper`** (D13);
- the wiring guide **`stepper-c3`** and four parts (D14);
- dashboard words and a stepper panel (D15);
- the user manual's section and a simulated stepper for the dashboard (D16);
- the host tests and the ESP-IDF build (§10);
- a first bring-up procedure for the owner (§11).

**Out:**
- current sensing and chopping (needs sense resistors; a later driver for a DRV8825/TMC-class chip implements the
  same `hal::Stepper`);
- stall detection: the DRV8833 cannot report it;
- homing to a switch: a `home` command with an end-stop input is a minor version later;
- jerk-limited (S-curve) profiles (D5 says why);
- dedicated hub ops (`stepper_*`), a plugin skill and a T-gate (D16). The generic `fr send`, `fr wait event` and
  `fr devices get` path drives everything.

## 2. The capability `fr.stepper` (D1–D2)

**D1. One capability for a bipolar stepper, id 0x0012**, version 1.0, `schema/capabilities/stepper.cap.yaml`.

- **Why 0x0012, not 0x0011:** 0x0011 is the next free standard id, but `docs/design/uno-q-host.md` proposes it
  for `fr.host`. Skipping it costs nothing (gaps are allowed) and avoids a second design renumbering.
- Registry line: `0x0012: fr.stepper       # design stepper-s1 D1`. Spec 07 §7.2 gets the row "`0x0012` fr.stepper
  (1.0 since stepper-s1: a two-coil stepper on an H-bridge, motion on the node)".

**Units: everything is in steps.** A step is a full step divided by `step_mode` (micro8: an eighth of a full step).
Position, target and soft limits are steps (i32); speeds are steps per second; acceleration is steps per second per
second.
- The node has no float anywhere: `f32` fields would also fall to a text control in the dashboard.
- Speeds are named `_hz` with `unit: Hz`. The dashboard then says them per Blink in pure mode (as `fr.camera`'s
  `fps_x10` and `fr.scale`'s `rate_hz`), and "steps a second" after ⊕ in Earth mode.
- Acceleration has no unit suffix (`accel`, `unit: Hz/s`). Pure mode shows it as a bare count; Earth mode adds the
  words from `cap-words.ts`.
- Changing `step_mode` rescales every stored step quantity, so the motor's physical behaviour stays put (D11).

**Long-running behaviour** follows the house pattern (fr.led `blink`/`effect_done`, fr.haptic, fr.camera):
- `move_to`, `move_by` and `jog` answer OK at once, `motion` says `moving`, and the event `done {reason, …}` ends the motion.
- A newer move or jog **replaces** the running one without stopping. The planner re-plans from the current speed
  and gives no `done` for the replaced motion.
- `stop`, `halt`, `hold` and `release` are `reliable`, `idempotent`, and answer OK when nothing runs.
- `BUSY` means refused now (moving, a fault's back-off, limits on with an unknown position); `INVALID_ARGS` means
  beyond a configured limit.
- The hub-silence rule of fr.haptic and fr.fixture applies (D12).

**D2. The file, in full:**

```yaml
capability: fr.stepper
id: 0x0012
version: "1.0"
summary: A two-coil stepper motor on an H-bridge driver. It moves to positions smoothly, spins, holds and lets go.
doc: |
  One bipolar stepper motor (two coils, four wires) on a dual H-bridge such as the DRV8833 (design stepper-s1).
  The node counts the position in steps. A step is a full step divided by `step_mode` (micro8: an eighth), so one
  turn is steps_per_rev x the microsteps. Positive steps turn it forward; `invert` swaps the direction.

  Motion runs on the node. A move accelerates at `accel`, cruises at no more than `max_speed_hz` and decelerates to
  rest exactly on its target. move_to, move_by and jog answer OK at once, and `done` ends the motion. A newer move or
  jog replaces the running one without stopping (no `done` for the replaced one) and reverses through zero speed
  when it must. `stop` decelerates; `halt` stops at once (fast motion may lose steps); `release` turns the coils off.

  Power: the coils are driven by PWM with no current sensing. While moving, the coil drive is capped at
  run_ma x coil_ohm / supply_mv of full duty. At rest it is hold_pct of that. The coils go off release_ms after the
  last motion ends. Measure one coil's resistance and set coil_ohm and run_ma with `configure` (kept across reboots).

  At boot the coils are off, the position is 0 and position_known is false until `zero`. A driver fault (nFAULT:
  over-current or over-heat) turns the coils off at once and emits `fault`. A second later, `hold` or a new move
  clears it. A motor supply that sags below the driver's under-voltage lockout is not reported: the bridge stops
  driving and resumes by itself, and steps it missed meanwhile stay counted. A move or jog started from a hub session
  decelerates to a stop 10 s after that hub falls silent.
types:
  StepMode:   { enum: { full: 0, half: 1, micro4: 2, micro8: 3, micro16: 4, micro32: 5 } }
  Motion:     { enum: { released: 0, holding: 1, moving: 2, stopping: 3, fault: 4 } }
  DoneReason: { enum: { reached: 0, stopped: 1, halted: 2, released: 3, limit: 4, fault: 5, hub_lost: 6, elapsed: 7 } }
  FaultCause: { enum: { driver: 0, injected: 1 } }
traits:
  microstep: { id: 1, type: bool, doc: "the driver drives the coils with PWM (micro4 to micro32); else full and half steps only" }
config:
  steps_per_rev: { type: u16, default: 20, range: [4, 10000], doc: "full steps per turn of the shaft (18 degrees a step: 20)" }
  step_mode:     { type: StepMode, default: micro8 }
  max_speed_hz:  { type: u16, default: 1600, range: [1, 10000], unit: Hz, doc: "the fastest speed, steps a second; a move's speed_hz may not exceed it" }
  accel:         { type: u32, default: 8000, range: [10, 200000], unit: Hz/s, doc: "acceleration and deceleration, steps a second per second; a move's accel may not exceed it" }
  start_hz:      { type: u16, default: 80, range: [1, 10000], unit: Hz, doc: "the fastest speed the motor stops at without a ramp; a halt or fault above it makes position_known false" }
  coil_ohm:      { type: u16, default: 10, range: [1, 1000], unit: ohm, doc: "one coil's resistance as measured; too low is the safe side" }
  run_ma:        { type: u16, default: 100, range: [1, 1500], unit: mA, doc: "the coil current to aim at while moving (the motor's rated current, or less)" }
  hold_pct:      { type: u8, default: 30, range: [1, 100], doc: "the current at rest, per cent of run_ma" }
  release_ms:    { type: u16, default: 1000, unit: ms, doc: "time at rest after a motion before the coils go off; 0 = never" }
  supply_mv:     { type: u16, default: 5000, range: [2700, 10800], unit: mV, doc: "the highest VM the driver will see; too high is the safe side" }
  invert:        { type: bool, default: false, doc: "turn the other way for positive steps (as swapping one coil's wires)" }
  limits:        { type: bool, default: false, doc: "keep the position within limit_min..limit_max (needs a known position)" }
  limit_min:     { type: i32, default: -1000000000, range: [-1000000000, 1000000000] }
  limit_max:     { type: i32, default: 1000000000, range: [-1000000000, 1000000000] }
  report_hz:     { type: u8, default: 10, range: [1, 50], unit: Hz, doc: "position and speed reports a second while moving" }
properties:
  position:       { id: 1,  type: i32, range: [-1000000000, 1000000000], doc: "steps, counted from zero at boot or from the last zero" }
  target:         { id: 2,  type: i32, range: [-1000000000, 1000000000], doc: "where the running move ends (the position at rest)" }
  speed_hz:       { id: 3,  type: i32, range: [-10000, 10000], unit: Hz, doc: "steps a second now; negative while turning backward" }
  motion:         { id: 4,  type: Motion }
  position_known: { id: 5,  type: bool, doc: "true after zero; false at boot and after a halt or fault at speed" }
  step_mode:      { id: 6,  type: StepMode }
  max_speed_hz:   { id: 7,  type: u16, unit: Hz }
  accel:          { id: 8,  type: u32, unit: Hz/s }
  start_hz:       { id: 9,  type: u16, unit: Hz }
  coil_ohm:       { id: 10, type: u16, unit: ohm }
  run_ma:         { id: 11, type: u16, unit: mA }
  hold_pct:       { id: 12, type: u8 }
  release_ms:     { id: 13, type: u16, unit: ms }
  supply_mv:      { id: 14, type: u16, unit: mV }
  invert:         { id: 15, type: bool }
  limits:         { id: 16, type: bool }
  limit_min:      { id: 17, type: i32 }
  limit_max:      { id: 18, type: i32 }
  run_duty_pct:   { id: 19, type: u8, doc: "the PWM duty the run current needs, per cent of full: run_ma x coil_ohm / supply_mv, at most 100" }
  steps_per_rev:  { id: 20, type: u16, doc: "full steps per turn (the build's configuration)" }
events:
  done:
    id: 1
    priority: normal
    doc: A motion came to rest or was ended. A motion replaced by a newer move or jog has no done.
    fields:
      reason:   { id: 1, type: DoneReason }
      position: { id: 2, type: i32 }
      target:   { id: 3, type: i32, doc: "the target it had (reached: equal to position)" }
      slips:    { id: 4, type: u16, doc: "times the step timer ran late and the ramp restarted from rest; 0 normally" }
  fault:
    id: 2
    priority: normal
    doc: The driver reported a fault (or one was injected). The coils are off and motion is fault.
    fields:
      cause:    { id: 1, type: FaultCause }
      position: { id: 2, type: i32 }
      recent:   { id: 3, type: u8, doc: "faults in the last minute, this one included; at 3 the node refuses to energise for a minute" }
commands:
  move_to:
    id: 1
    delivery: reliable
    idempotent: true
    doc: >-
      Moves to `position`, replacing any running move or jog without stopping. OK at once; done (reached) at the end.
      INVALID_ARGS beyond the limits or above max_speed_hz or accel; BUSY in a fault's back-off, or with limits on
      and position_known false.
    fields:
      position: { id: 1, type: i32, range: [-1000000000, 1000000000] }
      speed_hz: { id: 2, type: u16, optional: true, range: [1, 10000], unit: Hz, doc: "absent: max_speed_hz" }
      accel:    { id: 3, type: u32, optional: true, range: [10, 200000], unit: Hz/s, doc: "absent: the configured accel" }
    examples: [ { position: 160 }, { position: -800, speed_hz: 400, accel: 2000 } ]
  move_by:
    id: 2
    delivery: reliable
    doc: >-
      Moves by `steps` from the running move's target, or from the position when no move runs. move_to's answers;
      0 steps at rest is done (reached) at once.
    fields:
      steps:    { id: 1, type: i32, range: [-1000000000, 1000000000] }
      speed_hz: { id: 2, type: u16, optional: true, range: [1, 10000], unit: Hz, doc: "absent: max_speed_hz" }
      accel:    { id: 3, type: u32, optional: true, range: [10, 200000], unit: Hz/s, doc: "absent: the configured accel" }
    examples: [ { steps: 160 }, { steps: -20, speed_hz: 200 } ]
  jog:
    id: 3
    delivery: reliable
    idempotent: true
    doc: >-
      Turns at `speed_hz` (negative: backward) until stop, another move, a limit, the hub's silence or `seconds`
      (done elapsed). Speed 0 decelerates to rest, like stop. Answers as move_to.
    fields:
      speed_hz: { id: 1, type: i32, range: [-10000, 10000], unit: Hz }
      accel:    { id: 2, type: u32, optional: true, range: [10, 200000], unit: Hz/s, doc: "absent: the configured accel" }
      seconds:  { id: 3, type: u16, default: 0, doc: "0: until stopped" }
    examples: [ { speed_hz: 400 }, { speed_hz: -800, seconds: 5 } ]
  stop:     { id: 4, delivery: reliable, idempotent: true, doc: "Decelerates to rest (done stopped); OK when nothing moves." }
  halt:     { id: 5, delivery: reliable, idempotent: true, doc: "Stops stepping at once and holds (done halted); above start_hz the position becomes unknown." }
  hold:     { id: 6, delivery: reliable, idempotent: true, doc: "Energises the coils at hold power where the position says, until release or the next motion's end; clears a fault (BUSY in its back-off)." }
  release:  { id: 7, delivery: reliable, idempotent: true, doc: "Coils off and the driver asleep at once; a running motion ends (done released)." }
  zero:
    id: 8
    delivery: reliable
    idempotent: true
    doc: Calls where the shaft is now `position` (0 by default) without moving it; position_known becomes true. BUSY while moving.
    fields:
      position: { id: 1, type: i32, default: 0, range: [-1000000000, 1000000000] }
    examples: [ { position: 100 } ]
  configure:
    id: 9
    delivery: reliable
    idempotent: true
    doc: >-
      Changes the settings given and keeps them across reboots; absent fields stay. BUSY while moving, and for
      step_mode unless released. A new step_mode rescales the position, the limits and the speeds not given in the
      same call. INVALID_ARGS for limit_min >= limit_max, or a step_mode the driver cannot do.
    fields:
      step_mode:    { id: 1,  type: StepMode, optional: true }
      max_speed_hz: { id: 2,  type: u16, optional: true, range: [1, 10000], unit: Hz }
      accel:        { id: 3,  type: u32, optional: true, range: [10, 200000], unit: Hz/s }
      start_hz:     { id: 4,  type: u16, optional: true, range: [1, 10000], unit: Hz }
      coil_ohm:     { id: 5,  type: u16, optional: true, range: [1, 1000], unit: ohm }
      run_ma:       { id: 6,  type: u16, optional: true, range: [1, 1500], unit: mA }
      hold_pct:     { id: 7,  type: u8,  optional: true, range: [1, 100] }
      release_ms:   { id: 8,  type: u16, optional: true, unit: ms }
      supply_mv:    { id: 9,  type: u16, optional: true, range: [2700, 10800], unit: mV }
      invert:       { id: 10, type: bool, optional: true }
      limits:       { id: 11, type: bool, optional: true }
      limit_min:    { id: 12, type: i32, optional: true, range: [-1000000000, 1000000000] }
      limit_max:    { id: 13, type: i32, optional: true, range: [-1000000000, 1000000000] }
    examples: [ { coil_ohm: 20, run_ma: 90 }, { step_mode: micro16, max_speed_hz: 3200, accel: 16000 }, { invert: true } ]
  reset_settings: { id: 10, delivery: reliable, idempotent: true, doc: "Forgets what configure kept; the build's configuration applies again. BUSY unless released." }
  inject_fault:   { id: 11, delivery: reliable, visibility: test, doc: "Runs the fault path as if nFAULT fell (fault injected)." }
```

**Checks this file must pass** (from codegen's rules):
- No command shares a property's name. The events `done` and `fault` share no property's name.
- No event field camelCases to a reserved SDK name. `late` is reserved, hence `slips`.
- No command camelCases to `state` or `name`. The enum is `Motion`, not `State`, so it does not collide with the
  SDK's `StepperState` type.
- Every property is ≤ 200 B; `fast` is unused.
- `zero`, not `set_position`: a `set_position {position}` would make the dashboard's `propertyLink` turn the
  position row into its control. An i32 is a number box, which `PropertyControl` cannot draw, so the command would
  vanish from Actions.
- `reset_settings` matches the dashboard's `isDestructive` (`^reset`) and asks "It cannot be undone." That is wanted.
- `configure`'s fields have the same names and types as the properties, so the dashboard's form pre-fills each
  field from the mirror (`initialValue`).
- **Implicit 0:** 0 is a valid position, a valid `move_by` (a no-op) and a valid jog speed (stop), so no field's
  range excludes it. `zero`'s default is 0.
- `report_hz` makes the hub treat fr.stepper as streaming (`STREAMING_CAPS`): its STATE rows are thinned to one per
  property per second in `hub.db`, which a moving motor needs. The live mirror still has every report.

## 3. The L1 contract `hal::Stepper` (D3)

**D3.** The service decides *what* the motor does; the driver does the timing-critical *how*. Step timing lives in
the driver's ISR, never in fr_core's core-task timers: those are shared, multiplexed on one esp_timer, run on the core
task with milliseconds of jitter, and stall during flash writes. The motion arithmetic is not the driver's: it is the
`fr::motion` core (D4), so a later step/dir or current-sensing driver reuses it.

`firmware/components/fr_core/include/fr/hal/stepper.hpp`:

```cpp
// L1 stepper contract (design stepper-s1 D3): a two-coil stepper whose driver runs fr::motion::StepEngine in its
// own step ISR. Every method is called on the core task and returns in microseconds.
#pragma once
#include <cstdint>
#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/selftest.hpp"
#include "fr/motion/step_engine.hpp"

namespace fr::hal {

struct StepperShape {
    uint8_t microsteps_log2 = 3;   // 0 full .. 5 (32 microsteps)
    bool invert = false;
    uint16_t run_permille = 200;   // the coils' peak PWM duty while stepping, after the service's power cap
};

class Stepper
{
public:
    /** Every pad to coast (all inputs low), the bridge asleep, the step timer and the fault input armed. on_fault runs
     *  on the core task after the driver's ISR has already cut the coils. */
    virtual Status init(Core &core, Callback<void(), 24> on_fault) = 0;
    /** The finest step mode the driver can drive: 5 (micro32) for drv8833_stepper, 1 (half) for a GPIO-only one. */
    virtual uint8_t max_microsteps_log2() const = 0;
    /** At rest only (Err::busy otherwise). Applies from the next energise or step. */
    virtual Status shape(const StepperShape &s) = 0;
    /** Wakes the bridge if asleep and drives the counted position's vector at `permille` of full duty (run or hold
     *  power). Err::busy while a fault is latched or nFAULT is low. */
    virtual Status energise(uint16_t permille) = 0;
    /** Ends any motion at once (the engine records Rest::released), coils to coast, bridge asleep. Never fails. */
    virtual void release() = 0;
    /** Hands the step ISR a request; energises at run power first (the first step at least 1 ms after a wake).
     *  Err::busy while a fault is latched. */
    virtual Status command(const motion::Request &r) = 0;
    /** A consistent copy of the ISR's state, taken under the driver's lock. */
    virtual motion::Snapshot snapshot() const = 0;
    /** At rest only (Err::busy otherwise). */
    virtual Status set_position(int32_t position) = 0;
    /** nFAULT is low now (false without a fault pin). */
    virtual bool fault_asserted() const = 0;
    /** Unlatches a fault: Err::busy while nFAULT is still low. The bridge stays asleep. */
    virtual Status clear_fault() = 0;
    /** FR_TEST_HOOKS: the fault ISR's cut path, as if nFAULT fell. */
    virtual void inject_fault() = 0;
    /** Never energises a coil. */
    virtual Selftest selftest() = 0;

protected:
    ~Stepper() = default;
};

}  // namespace fr::hal
```

## 4. The motion core (D4–D6)

**D4. Pure, integer, heap-free, ISR-safe, in `fr_core`.** Three header-only files under
`firmware/components/fr_core/include/fr/motion/`:
- `phase_table.hpp`: the microstep table (D8);
- `step_planner.hpp`: the per-step speed decision;
- `step_engine.hpp`: the state an ISR owns (position, speed, mode, target, rests, slips, fault latch), the
  request mailbox and the snapshot.

They include nothing from IDF and are built by the host suite as they are. **ISR safety on target:**
- Every function the step ISR reaches is marked `FR_MOTION_ISR`, which is `IRAM_ATTR` under `ESP_PLATFORM` and
  empty on the host. Whichever translation unit's copy of an inline function the linker keeps, it is in IRAM.
- The quarter-sine table is copied into a non-`const` member of the engine at construction. Driver objects are
  static (fr_board.cpp), so the table lives in DRAM, never in flash `.rodata`.
- The ISR path uses only 32-bit add, multiply and divide (the C3 is RV32IMC: hardware divide) and `u32 × u32 → u64`
  multiplies, which compile inline. **No 64-bit division** (a libgcc call, possibly in flash).
- No floating point, no allocation, no `std::function`. The files carry `// fr:realtime`.

**D5. A trapezoid profile, planned one step at a time on v².** Each step boundary decides the speed at the end of
the coming step from the current speed, the distance left and the limits. The constant-acceleration identity for one
unit step makes this exact in integers:

- the state is `vsq` = v² at the last step boundary (steps²/s², u32: at most 10,000² = 10⁸);
- one step at constant acceleration a changes v² by exactly 2a;
- the step's duration is exactly `t = 2 / (v₀ + v₁)`, since distance 1 = (v₀ + v₁)/2 · t, so
  `interval_us = 2,000,000 / (√v₀² + √v₁²)`.

From rest, the first step lasts `√(2/a)`: 15.8 ms at a = 8,000, the exact kinematics, not the factor-of-2 error of
using the end speed alone.

The decision at a step boundary (direction `dir` = ±1; `two_a` = 2a; `r` = the steps that will remain after the
coming one toward the active bound or target, saturated to u32):

```
position mode (a target):
  d = (target − position) · dir                    // i64 subtraction: never overflows (D6 ranges)
  if d ≤ 0 and vsq == 0:      if target == position: rest(reached)           // arrived
                              else: dir = −dir; recompute d                   // reverse from rest
  if d ≤ 0 (target behind) :  vsq′ = vsq ≥ two_a ? vsq − two_a : 0           // decelerate, keep going, come back
  else:                        r = d − 1
                               hi = min(vsq + two_a, vmax², two_a·r)        // two_a·r as u64, saturated
                               lo = vsq > two_a ? vsq − two_a : 0          // the most it can slow in one step
                               vsq′ = max(hi, lo)                           // hi < lo: cannot stop in time: overshoot
velocity mode (jog at signed speed s; stop is s = 0):
  if vsq == 0 and s == 0:      rest(stopped | the reason the service set)
  if vsq == 0:                 dir = sign(s)
  if sign(s) ≠ dir:            vsq′ = vsq − two_a, at least 0                // decelerate to reverse
  else:                        vsq′ = vsq < s² ? min(vsq + two_a, s²) : max(vsq − two_a, s²)
  and a jog never passes its bound: vsq′ = min(vsq′, two_a·r_bound); at the bound with vsq′ == 0: rest(limit)
step: position += dir; interval = 2e6 / (√vsq + √vsq′); vsq = vsq′
```

The rest of it:
- `isqrt` must give each interval within ±1 µs + 0.5 % of the exact kinematics. One way: a 64-bit bitwise square
  root of `vsq·256`, i.e. 16·v (32 iterations, about 2 µs at 160 MHz). The other is Newton seeded with the previous
  step's root (one or two iterations). The host test pins the accuracy, not the method.
- `vmax` is the move's `speed_hz` (≤ `max_speed_hz`), and `a` the move's `accel` (≤ the configured one).
- **Retargeting** is just a new target or speed for the next decision. A farther target keeps accelerating; a
  closer one brakes earlier.
- **A target inside the stopping distance** decelerates at a, passes the target, reverses through zero speed and
  comes back. That is the only overshoot, and it equals the stopping distance at the moment of the retarget.
- **Reversing** a jog decelerates to zero, then accelerates the other way. A step taken at zero speed is never skipped.
- **Stop** is velocity mode with s = 0, so its distance is `⌈vsq / 2a⌉` steps.
- **Halt** sets `vsq = 0` and rests at once (`halted`).
- **Steps at rest:** the last step of a move ends with `vsq′ = 0` exactly on the target, so `done` coincides with
  the last step.

**Why a trapezoid, not an S-curve:**
- The rotor and a light pinion load have little inertia. Jerk limiting pays off on belts and heavy carriages, not here.
- The v² update is exact and integer. Retargeting, reversal and stops all fall out of the same three lines.
- A jerk-limited planner would need a third state, fractional time arithmetic and a harder exact-arrival argument.
- If resonance shows on the bench, `step_mode` (micro16, micro32) is the first remedy. A jerk-limited planner can
  come later behind the same `motion::Request` (a minor version).

**Late steps (flash stalls, long ISRs).** The ISR receives `late_us = now − due`:
- **No catch-up bursts:** the next alarm is `due + interval`, or `now + interval` when that is already past.
- **More than 2 ms late:** the rotor has stood at its last vector, and resuming at speed would stall it. The engine
  sets `vsq = 0`, counts a **slip** and re-ramps from rest toward the same target.
- The position stays exact in both cases. `done.slips` reports the count, so the bench sees a timing problem instead
  of a mysterious loss of steps.

**D6. Ranges that make overflow impossible:**
- Positions, targets and limits stay within ±10⁹, so `target − position` fits an i32 (computed in i64 anyway).
- A jog's implicit bound is ±10⁹ (≈ 28 hours at 10,000 steps/s); it rests there with `limit`.
- Speeds are ≤ 10,000 steps/s (v² ≤ 10⁸) and `two_a` ≤ 400,000, so `vsq + two_a` < 2³².
- `two_a · r` is computed as `u64` and saturated to `u32`.
- Intervals are ≥ 100 µs (10 kHz; 2.5 PWM periods at 25 kHz, D8). The longest is the first step at a = 10: 0.45 s.

**The engine's interface** (`fr::motion`; the names are the contract between T3, T4 and T5 in §12):

```cpp
enum class Rest : uint8_t { none, reached, stopped, halted, released, limit, fault };
struct Request {
    enum class Kind : uint8_t { move_to, jog, stop, halt };
    Kind kind = Kind::stop;
    int32_t target = 0;                  // move_to
    int32_t speed = 0;                   // jog: signed steps/s; stop: 0
    uint32_t vmax = 0, accel = 0;        // steps/s, steps/s²
    int32_t lo = -1000000000, hi = 1000000000;   // the bounds (soft limits or ±1e9)
};
struct Snapshot {
    int32_t position = 0, target = 0;
    int32_t speed = 0;                   // signed steps/s at the last step boundary
    bool running = false;                // an alarm is pending
    uint32_t rests = 0;                  // counts every rest; the service compares it with the last it saw
    Rest last_rest = Rest::none;
    uint16_t slips = 0;                  // of the motion that rested last (or of the running one)
    bool faulted = false;
};
struct Start { bool arm = false; uint32_t delay_us = 0; bool rested_now = false; };
struct Tick  { bool stepped = false; uint8_t phase = 0; bool again = false; uint32_t interval_us = 0; };

class StepEngine {
public:
    void shape(uint8_t microsteps_log2, bool invert);   // at rest
    Start submit(const Request &r);                     // task side, under the driver's lock
    Tick on_alarm(uint32_t late_us);                    // ISR side
    void fault();                                       // either side: stop now, rest(fault), latch
    void clear_fault();
    Status set_position(int32_t p);                     // at rest
    uint8_t phase() const;                              // electrical index 0..127 of the counted position
    Snapshot snapshot() const;
};
```

## 5. The driver `drv8833_stepper` (D7–D9)

**D7. Timing: a gptimer alarm per step, in IRAM, cache-safe.**
- One general-purpose timer at 1 MHz runs freely from init; its 54-bit count never wraps.
- Each step arms the next alarm at an **absolute** count (`due + interval`), so rounding never accumulates.
  `gptimer_set_alarm_action` is ISR-safe. Its config struct lives in static DRAM, as `GPTIMER_CTRL_FUNC_IN_IRAM` requires.
- An alarm set in the past fires at once (*inferred* from the IDF gptimer documentation; the ISR also clamps to
  `now + 2 µs`).
- `sdkconfig: [CONFIG_GPTIMER_ISR_CACHE_SAFE=y, CONFIG_GPTIMER_CTRL_FUNC_IN_IRAM=y]`. The driver's object is
  `noflash` (`linker.lf`, as `fixture_gpio`), so steps continue through NVS and OTA flash writes. Spec 03 says those
  "stall everything" for 30 ms to hundreds.
- **Rejected:**
  - fr_core timers: ms jitter, and they stall during flash writes;
  - esp_timer ISR dispatch: shared with every esp_timer, several µs of overhead per step, one more sdkconfig the
    whole build inherits;
  - a fixed 20 kHz tick with a DDA: 50 µs quantisation and a constant CPU load even when idle.

  A step costs ≈ 3–5 µs of ISR time (*inferred*): planner + table + four LEDC writes. At the 10 kHz cap that is ≤ 5 %
  of the C3.

**D8. Microstepping by PWM on all four inputs, slow decay, 25 kHz, 11 bits.**
- **LEDC:** low-speed mode, **timer 0**, **channels 0–3** (AIN1, AIN2, BIN1, BIN2), APB clock 80 MHz.
  - 25 kHz × 2,048 counts needs 51.2 MHz, so the divider is 1.5625 (LEDC's fractional divider).
  - 25 kHz is above hearing and inside what the DRV8833 switches cleanly. Its output edges take a fraction of a µs
    of a 40 µs period (*inferred* from the sheet's rise and fall times).
  - `pwm_hz` is a driver field (16–40 kHz) in case it whines.
  - All four channels share the timer, so their duties latch at the same period boundary.
- **Slow decay** (brake during the off-time), coil by coil, for a signed amplitude `c` (0 … full = 2,048 counts):

  | Amplitude | xIN1 duty | xIN2 duty | The coil sees |
  |---|---|---|---|
  | c > 0 | full (always high) | full − c | +VM for c/full of each period, shorted otherwise |
  | c < 0 | full − \|c\| | full | −VM for \|c\|/full, shorted otherwise |
  | c = 0 | full | full | shorted (brake) |
  | released | 0 | 0 | open (coast); the bridge asleep as well |

  - With slow decay the coil's average voltage is `c/full · VM`. Its current follows linearly, as V/R less the
    back-EMF, and the ripple is small, because the current recirculates through the low sides at ≈ 0 V.
  - **Fast decay** (coast in the off-time) drives the coil to −VM through the body diodes. The current then decays
    to zero within the period and the average is not proportional to the duty: microsteps would bunch near the poles.
    Without current sensing, voltage-mode slow decay is the only one that gives an even sine, so it is the only mode
    offered.
  - **c = 0 brakes rather than coasts:** this keeps the drive continuous through the zero crossing. In full-step
    (wave) mode it adds a little damping drag at speed, which is acceptable for this motor.
  - Duty 2,048 = 2^bits is steady high on the C3's LEDC (*inferred*: IDF accepts duty up to 2^resolution on chips
    after the ESP32; the bring-up checks that AIN1 reads a steady 3.3 V while holding).
- **The table** (`fr::motion`, `phase_table.hpp`):
  - a quarter sine in Q15, **33 entries** (0°…90° in 32 steps), so one full step (90° electrical) has 32 entries and
    the finest mode is micro32;
  - 128 entries per electrical cycle (4 full steps), by symmetry;
  - `phase(e)` gives `(cos, sin)` in signed Q15;
  - the values, `round(32767 · sin(k·π/64))`, k = 0…32, are pinned by a host test against `std::sin` (±1 LSB):

    `0, 1608, 3212, 4808, 6393, 7962, 9512, 11039, 12539, 14010, 15446, 16846, 18204, 19519, 20787, 22005, 23170,
    24279, 25329, 26319, 27245, 28105, 28898, 29621, 30273, 30852, 31356, 31785, 32137, 32412, 32609, 32728, 32767`
- **The electrical index of a position:** `e = ((invert ? −p : p) · (32 >> microsteps_log2)) & 127`, two's
  complement, correct for negative positions.
  - Full steps (`full`) are **wave drive**: e = 0, 32, 64, 96, one coil at a time at the full amplitude.
  - Half steps alternate one coil and both at 0.707.
  - micro4 to micro32 follow the sine.
  - The current vector's magnitude is the same at every index (sin² + cos² = 1), so torque and heat do not depend
    on the step mode or the position, and full steps are a subset of every finer mode.
- **The amplitude:** `peak = full · permille / 1000` is computed at shape and energise time (≤ 2,048).
  `c = (peak · |q| + 16384) >> 15` fits a u32.
- **The ISR writes duties** with the inline `hal/ledc_ll.h` calls: `ledc_ll_set_duty_int_part`,
  `ledc_ll_set_duty_start`, `ledc_ll_ls_channel_update`. `ledc_set_duty` is neither ISR-safe nor in IRAM. A write
  that straddles a period boundary shows an in-between vector for one 40 µs period, which is harmless (§0: no input
  state shorts anything).

**D9. Sleep, fault, init, hooks:**
- **Init** (before anything can fail):
  1. drive GPIO4 (nSLEEP) low;
  2. drive the four IN pads low as GPIOs;
  3. configure LEDC with duty 0, then hand the pads to LEDC;
  4. configure GPIO3 as an input, with the internal pull-up (`fault_pullup`, default true);
  5. register the safe-off hooks (`register_safe_off`; false when the table is full refuses init);
  6. create, enable and start the gptimer with the alarm disabled;
  7. take an input slot for nFAULT, then install its GPIO ISR (falling edge, `ESP_INTR_FLAG_IRAM` when
     `fr::platform::gpio_isr_service` allows it).
- **Wake:** set the vector's duties, raise nSLEEP, then arm a gptimer "wake" alarm at +1 ms. The DRV8833 needs
  ≈ 1 ms (*inferred*). nFAULT edges are ignored until that alarm. The wake alarm reads nFAULT: low means a fault
  (D11); high starts stepping if a request is pending.
- **Release:** all four duties to 0 (coast), then nSLEEP low.
- **The fault ISR** (IRAM, register writes only, under the driver's `portMUX`):
  1. switch the four pads from LEDC to the GPIO output register, driven low (as `haptic_ledc`'s `all_pads_low`);
  2. drive nSLEEP low;
  3. call `engine.fault()`;
  4. disable the alarm;
  5. update the input slot, so the core task runs `on_fault`.

  The DRV8833 protects itself anyway; cutting in the ISR stops the position counting and the drive within
  microseconds, not at the next core-task tick. `clear_fault` hands the pads back to LEDC.
- **Restart and panic hooks:** the same pads-low and nSLEEP-low register writes.
- **The lock:** the ISRs and the task-side methods (`command`, `snapshot`, `energise`, `set_position`) share one
  `portMUX_TYPE`. On the single-core C3 a critical section is a few dozen cycles with interrupts off. The ISRs take
  it with `portENTER_CRITICAL_ISR`.
- **selftest** never energises:
  - asleep: the IN pads read back low, nSLEEP reads low, and nFAULT reads high ("nFAULT low while asleep: a missing
    pull-up or a wiring fault");
  - energised: "energised, not checked";
  - it also reports the LEDC channels and the gptimer as allocated.
- **ISR or task:**

  | Context | What runs there |
  |---|---|
  | gptimer alarm ISR (IRAM) | `engine.on_alarm`; four LEDC duty writes; arm the next alarm; the wake check |
  | GPIO ISR on nFAULT (IRAM) | cut: pads low, nSLEEP low, `engine.fault()`, alarm off, input slot |
  | core task | the service: commands, a snapshot poll every 20 ms while moving, reports, events, timers |
  | fr_worker | NVS writes from `configure` (only at rest) |
  | restart and panic hooks | pads low, nSLEEP low |

**`hardware/drivers/drv8833_stepper/driver.yaml`, in full:**

```yaml
# Driver manifest (design stepper-s1 D7-D9; spec 07 §7.8). A bipolar stepper on a DRV8833 dual H-bridge module: four
# inputs on LEDC PWM (slow decay, 25 kHz, 11 bits), nSLEEP and nFAULT on bare pins, steps from a gptimer alarm ISR in
# IRAM. bind { ain1, ain2, bin1, bin2: gpio.<n>[, sleep: gpio.<n>][, fault: gpio.<n>] }, each in the board's pins.free.
schema: fractonica/driver@1
id: drv8833_stepper
summary: A two-coil stepper on a DRV8833 module - microsteps by PWM on its four inputs (slow decay, 25 kHz), steps timed by a gptimer ISR, nSLEEP and nFAULT handled; coils off at init.
implements: hal.Stepper
class: fr::drv::Drv8833Stepper          # header: include/fr/drv/drv8833_stepper.hpp
targets: [esp32c3, esp32c6, esp32s3]
binds: gpio                             # bare pins (no board section)
accepts_kinds: [gpio]
config:                                 # same order as Drv8833Stepper::Config
  ain1:        { type: gpio, from: bind.ain1, output: true, doc: "AIN1 (IN1): coil A's first input" }
  ain2:        { type: gpio, from: bind.ain2, output: true, doc: "AIN2 (IN2)" }
  bin1:        { type: gpio, from: bind.bin1, output: true, doc: "BIN1 (IN3): coil B's first input" }
  bin2:        { type: gpio, from: bind.bin2, output: true, doc: "BIN2 (IN4)" }
  sleep:       { type: gpio, from: bind.sleep, optional: true, output: true, doc: "nSLEEP (EEP), high = awake; absent: the module must hold it high, and release only coasts" }
  fault:       { type: gpio, from: bind.fault, optional: true, doc: "nFAULT (ULT), open drain, low = fault; an input" }
  fault_pullup: { type: bool, default: true, doc: "the fault pin's internal pull-up (false when the module pulls nFAULT up to 3.3 V itself)" }
  pwm_hz:      { type: u16, default: 25000, range: [16000, 40000], doc: "PWM frequency on the four inputs (11 bits up to 39 kHz)" }
traits: { microstep: true }
# LEDC: timer 0 and channels 0-3 (fixture_gpio's on the S3: never in one profile with it; haptic_ledc takes channels
# from LEDC_CHANNEL_MAX/2 up, which on the C3 is 3: never in one profile with it on a 6-channel chip, design D-risks).
# gptimer: one of the chip's general-purpose timers, budgeted by the board's resources.gptimer.
resources: { gpio: 6, ledc_channels: 4, ledc_timers: 1, gptimer: 1, input_slot: 1 }
sdkconfig: [CONFIG_GPTIMER_ISR_CACHE_SAFE=y, CONFIG_GPTIMER_CTRL_FUNC_IN_IRAM=y]
dependencies: {}
```

The rest of the driver:
- **Header:** `struct Config { uint8_t ain1 = 0, ain2 = 0, bin1 = 0, bin2 = 0; int8_t sleep = -1; int8_t fault = -1;
  bool fault_pullup = true; uint16_t pwm_hz = 25000; };`. The optional pins are typed as in `ChargerGpio::Config`.
- **CMake:** `idf_component_register(SRCS "src/drv8833_stepper.cpp" INCLUDE_DIRS "include" REQUIRES fr_core PRIV_REQUIRES
  esp_driver_gpio esp_driver_ledc esp_driver_gptimer LDFRAGMENTS "linker.lf")`, with `linker.lf` making
  `drv8833_stepper (noflash)`.
- **The IDF-free mapping** from (cos, sin, peak) to the four duties of D8's table is
  `include/fr/drv/drv8833_bridge.hpp` (constexpr, `FR_MOTION_ISR`), tested on the host (the `hx711_bits.hpp`
  precedent).
- **The source file** is then only IDF glue: pins, LEDC, gptimer, ISRs and hooks.
- **`max_microsteps_log2()`** returns 5.

## 6. The service `StepperService` (D10–D12)

**D10. Shape and policy.**
- **Files:** `fr_core/include/fr/services/stepper_service.hpp` and `src/services/stepper_service.cpp`
  (`// fr:realtime`, IDF-free).
- **Class:** `class StepperService final : public cap::Stepper`, constructor
  `StepperService(hal::Stepper &drv, hal::Settings &settings, const cap::StepperConfig &cfg)` (the generated
  glue's order).
- **Codegen `SERVICES` entry:**
  ```ts
  'fr.stepper': { implements: 'hal.Stepper', service: 'fr::StepperService', header: 'fr/services/stepper_service.hpp',
                  timers: 1, settings: 'fr_stepper',
                  traits: (_cfg, { driverTraits }) => ({ microstep: driverTraits.microstep === true }) },
  ```
- **`init(core)`:**
  1. `drv.init(core, [this]{ on_fault(); })` first, so the coils are off before anything can fail;
  2. check the config (`INVALID_ARGS`: `limit_min ≥ limit_max`, or a step_mode beyond the driver);
  3. load the settings (D11);
  4. call `drv.shape(...)`;
  5. take one core timer (`Err::failed` when the pool is out).
- **The timer** is rescheduled to the earliest of:
  - the 20 ms poll while moving or stopping;
  - the settle deadline;
  - the release deadline;
  - a jog's `seconds`;
  - the fault back-off's end;
  - the hub-silence check (each poll).
- **Boot state:** `motion = released`, `position = 0`, `position_known = false`, `target = 0`. Nothing energises at
  boot. **The position is not kept across reboots:** the rotor can be turned while the board is off, and a lead-screw
  application homes anyway.

**The motion states:**

| From | On | To | The driver |
|---|---|---|---|
| released | move_to, move_by, jog ≠ 0 | moving | `command`: wake, run power |
| released | hold | holding | `energise(hold)` |
| moving | engine rest (reached, limit) | holding | stays at run power for 100 ms (settle), then `energise(hold)`; release timer |
| moving | stop, `seconds` over, hub silent | stopping | `command(stop)` |
| stopping | engine rest | holding | as above |
| moving / stopping | halt | holding | `command(halt)`, done halted at once |
| any | release, or `release_ms` at rest after a motion | released | `release()` |
| any but released | engine fault (on_fault) | fault | (cut already) |
| fault | hold, a move (back-off over, nFAULT high) | holding, moving | `clear_fault`, then as from released |
| fault | release | released | `clear_fault` (no energise) |

- **`hold` is indefinite:** it holds at hold power until `release` or a motion. The idle release applies only after
  a motion ends. `release_ms: 0` means never release after a motion either.
- **Power:**
  - `run_permille = min(1000, run_ma · coil_ohm · 1000 / supply_mv)` (u32 arithmetic);
  - `hold_permille = run_permille · hold_pct / 100`, at least 1 while energised;
  - the `run_duty_pct` property is `⌈run_permille / 10⌉`.
  - **Example:** defaults 100 mA × 10 Ω / 5,000 mV = 20 % of full duty. On a real 20 Ω coil that gives
    0.2 × 5 V / 20 Ω = 50 mA: weak but safe.
  - Every error in the owner's numbers leans to less current: a coil_ohm below the real one, or a supply_mv above
    the real VM. Back-EMF only lowers the current, and copper's resistance rises as it warms.
  - The power in the motor is the same at every position and step mode (D8): `I²·R`. At run_ma 100 on 20 Ω that is
    0.2 W; held at 30 %, 0.018 W.
- **Answers:**
  - `move_to` / `move_by` / `jog`:
    - `INVALID_ARGS` when `speed_hz > max_speed_hz`, `accel` above the configured one, or a target outside
      `[limit_min, limit_max]` (with `limits`) or outside ±10⁹;
    - `BUSY` in the fault back-off;
    - `BUSY` with `limits` on and `position_known` false ("zero it first");
    - a move to where it already rests is OK with `done {reached}` at once;
    - **`move_by` is relative to the running move's target** (two quick `move_by 10` make 20), or to the position
      when no move runs (a jog's position, too).
  - `zero`, `configure`, `reset_settings`: `BUSY` while moving or stopping. `configure {step_mode}` and
    `reset_settings`: `BUSY` unless released.
  - `stop`, `halt`, `hold`, `release` at rest: OK with nothing to do (no event).
- **`position_known` falls to false** after a halt, a release while moving, or a fault, when `|speed|` was above
  `start_hz` at that moment. It is also false at boot. **Only `zero` sets it.**
- **Events:** each poll compares `snapshot.rests` with the last seen, then:
  - emits `done {reason, position, target, slips}` once per rest;
  - maps the engine's `stopped` to the reason the service asked for: `stopped`, `hub_lost` or `elapsed`;
  - emits `done {released}` and `done {halted}` itself when it ends a motion that way;
  - emits `fault {cause, position, recent}` from `on_fault`, then `done {fault}` if a motion was running.
- **Reports:**
  - `motion`, `target`, `position_known` and the settings: on change, at once;
  - `position` and `speed_hz`: at most `report_hz` times a second while moving, plus the exact values at every
    rest (so the mirror's final position is exact);
  - `report_all` re-sends everything.

**D11. Settings, faults, step modes.**
- **Settings** (NVS namespace `fr_stepper`, through `hal::Settings`). Keys are `p<port><k>` (≤ 15 characters), seven
  of them, written in order with the mode key last:
  - `a`: accel;
  - `v`: max_speed_hz | start_hz << 16;
  - `p`: coil_ohm | run_ma << 16;
  - `r`: release_ms | supply_mv << 16;
  - `lo` and `hi`: limit_min and limit_max;
  - `m`: layout 1 | step_mode << 8 | invert << 11 | limits << 12 | hold_pct << 16.

  The writes:
  - `configure` validates everything first, applies it, then writes the changed keys and `m` last. Writes land in
    order (`hal::Settings`), so a reboot mid-way loads either the old set or the new one.
  - A refused write answers `FAILED`. The values stay applied for this boot, and the next boot loads the build's
    configuration if `m` was not written.
  - At boot, values are loaded only when `m` exists and says layout 1, and each is range-checked. A bad value is
    ignored with a log line.
  - `reset_settings` erases `m` alone (one key, `erase`'s limit is 2) and applies the build's configuration.
- **Faults:**
  - `on_fault` runs on the core task. The driver has already cut the coils and the engine has rested (`fault`).
  - The service sets `motion = fault`, notes the time, counts faults in a sliding 60 s window and emits the events (D10).
  - **The back-off:** `hold` and moves answer `BUSY` for 1 s after a fault, and for 60 s once three faults fall
    within a minute (a short in the wiring cycles the DRV8833's over-current retry).
  - After the back-off, `hold` or a move calls `clear_fault`. That answers `BUSY` while nFAULT still reads low;
    otherwise the wake proceeds. If the fault is still there, the wake check (D9) reports it again within about 1 ms
    as a new `fault`.
  - `inject_fault` (`FR_TEST_HOOKS`) calls `drv.inject_fault()`, which runs the same path, cause `injected`.
- **Step mode change** (released only):
  - `position′ = round(position · 2^(new − old))`, and the same for `limit_min` and `limit_max`;
  - `max_speed_hz`, `accel` and `start_hz` are scaled by the same factor and clamped to their ranges, unless the same
    `configure` gives them;
  - `position_known` stays as it was: the rotor moves at most half a coarse step when next energised;
  - the trait `microstep` false refuses micro4 and finer with `INVALID_ARGS`.

**D12. The hub-silence rule.** A move or jog started while the node has a hub session (`fr::core::hub_session()`)
remembers `link_info().hub_epoch`. If it is still moving when 10 s pass after that hub's newest frame, or a WELCOME
of another hub run arrives, the service:
- stops it (**decelerated**, not halted, so no steps are lost);
- emits `done {hub_lost}` when it rests;
- lets the idle release follow.

This is FixtureService's and HapticService's rule, with their constant (`kHubSilentUs`). A motion started with no
hub session (a local app) is not tied to one. A finite `move_to` usually ends long before; the rule exists for `jog`.

## 7. Board and profile (D13)

**D13. A new board manifest, `hardware/boards/esp32c3-supermini.board.yaml`.** The OLED C3 board reserves GPIO5 and 6
for its display and takes GPIO10 as `test_pin`, so it cannot carry this wiring.

```yaml
schema: fractonica/board@1
id: esp32c3-supermini
name: ESP32-C3 Super Mini
idf_target: esp32c3
flash: { size: 4MB, mode: dio, part_profile: fr-4mb-v1 }
psram: null
usb: { kind: usb_serial_jtag, vid: 0x303A, pid: 0x1001, bcd_device: 0x0101, serial_is_mac: true, pins: [18, 19] }
console: usb_serial_jtag
buttons:
  boot: { gpio: 9, active_level: low, pull: up, strapping: true, deep_sleep_wake: false, confidence: H }
leds:
  status: { gpio: 8, kind: gpio, active_level: low, strapping: true, confidence: H }
pins:
  reserved: { usb: [18, 19], flash: [11, 12, 13, 14, 15, 16, 17] }
  strapping: [2, 8, 9]
  # GPIO2 and GPIO8 must be high and GPIO9 high for a SPI boot (GPIO9 low = download mode).
  strapping_levels: { 2: high, 8: high, 9: high }
  free: [0, 1, 2, 3, 4, 5, 6, 7, 10, 20, 21]
  adc1: [0, 1, 2, 3, 4]
# Component side up, USB-C at the top (the owner's board and hardware/wiring/stepper-c3/map.svg).
headers:
  confidence: M
  left: [5V, GND, 3V3, 4, 3, 2, 1, 0]
  right: [5, 6, 7, 8, 9, 10, 20, 21]
boot_uart_tx: 21              # U0TXD: the ROM log prints on it at every boot
en_access: null               # EN is only the RST button
# The Super Mini's antenna is badly matched: at full power it often fails to associate. 8.5 dBm (34 quarter-dBm)
# is the known fix, as on esp32c3-oled042.
rf: { max_tx_power_qdbm: 34, antenna: ceramic }
test_pin: 0
resources: { rmt_tx: 2, rmt_rx: 2, ledc_timers: 4, ledc_channels: 6, i2c: 1, adc1_channel: 5, i2s: 1, gptimer: 2 }
defaults:
  boot:   { cap: fr.button, driver: button_gpio, bind: buttons.boot }
  status: { cap: fr.led,    driver: led_gpio,    bind: leds.status }
detection:
  usb: { vid: 0x303A, pid: 0x1001, bcd_device: 0x0101 }
  # The same chip and USB as esp32c3-oled042: esptool cannot tell them apart. Provisioning takes the profile the
  # user names, as for every ambiguous board.
  esptool: { chip_type: '^ESP32-C3 \(QFN32\)', flash_size: 4MB }
  ambiguous_with: [esp32c3-oled042]
  probe: { leds: [status] }
sources:
  - https://documentation.espressif.com/esp32-c3_datasheet_en.pdf
```

Notes on the board:
- `bcd_device` 0x0101 is *inferred*: it is the same chip's USB-Serial-JTAG as the OLED board.
- If codegen or the hub wants ambiguity declared on both sides, `esp32c3-oled042` gains
  `ambiguous_with: [esp32c3-supermini]` in the same change.
- `test_pin: 0`: on a header, free, and claimed by nothing here.
- `gptimer: 2` is the new resource key the driver draws on. Other boards add it when they first bind the driver.

**The profile `firmware/profiles/c3s-stepper.profile.yaml`.** The prefix `c3s` is C3 Super Mini, as `c3o` is C3
OLED and `c6w` is C6 WROOM.

```yaml
profile: c3s-stepper
board: esp32c3-supermini
app: node
net: { link_profile: default }
caps:
  boot:   { cap: fr.button,  driver: button_gpio, bind: buttons.boot }
  status: { cap: fr.led,     driver: led_gpio,    bind: leds.status }
  motor:  { cap: fr.stepper, driver: drv8833_stepper,
            bind: { ain1: gpio.5, ain2: gpio.6, bin1: gpio.7, bin2: gpio.10, sleep: gpio.4, fault: gpio.3 },
            config: { steps_per_rev: 20, step_mode: micro8, coil_ohm: 10, run_ma: 100, supply_mv: 5000 } }
```

- `fr gen firmware` writes `c3s-stepper.slots.lock` with `boot: 1`, `status: 2`, `motor: 3`, which is committed.
- The first IDF build writes `firmware/apps/node/dependencies.lock.c3s-stepper`, also committed.
- The budget: LEDC 4 of 6 channels and 1 of 4 timers; gptimer 1 of 2; input slots 2 of 8 (boot, motor); core
  timers 1 for the motor.
- **The alias** is `stepper-c3` (the guide's `device:`) unless the owner names it otherwise at provisioning.

## 8. Wiring guide and parts (D14)

**D14. `hardware/wiring/stepper-c3/guide.yaml`, beside the existing `map.svg`.** Two tests fail today for want of
it: `wiring-w1.test.ts` (`no guide.yaml`) and `design-rules.test.ts` (ENOENT). The text carries no milestone codes
(that test's rule). Final form:

```yaml
schema: fractonica/wiring@1
id: stepper-c3
title: Micro stepper on a DRV8833, ESP32-C3 Super Mini
summary: >-
  A 10 mm two-coil micro stepper on a DRV8833 dual H-bridge module, driven from an ESP32-C3 Super Mini: the four
  inputs on GPIO5, 6, 7 and 10, sleep on GPIO4, fault on GPIO3, the motor supply from the board's 5V (USB).
board: esp32c3-supermini
profile: c3s-stepper
device: stepper-c3
design: docs/design/stepper-s1.md
covers: [motor]
safety:
  - "Unplug the board's USB before connecting or moving any wire."
  - "Never plug or unplug the motor while the module has power: the coil's energy arcs on the pins."
  - "The module has no current limit of its own: the firmware's power cap (the coil resistance and run current it is configured with) is the limit. Measure the coil before the first run."
  - "VM comes straight from USB 5 V: keep the motor's wires away from the board's pins; a short on VM is a short on the Mac's port."
bom:
  - { part: esp32c3-supermini-board, qty: 1, note: stepper-c3 }
  - { part: drv8833-module, qty: 1 }
  - { part: micro-stepper-10mm, qty: 1 }
  - { part: capacitor-electrolytic, value: "100 µF", qty: 1, note: "across VM and GND at the module; 10 V or more" }
diagrams:
  - { id: map, title: The C3 Super Mini, the DRV8833 and the motor, file: map.svg }
connections:
  - { pin: gpio.5, instance: motor, bind: ain1, to: "DRV8833 AIN1 (IN1)" }
  - { pin: gpio.6, instance: motor, bind: ain2, to: "DRV8833 AIN2 (IN2)" }
  - { pin: gpio.7, instance: motor, bind: bin1, to: "DRV8833 BIN1 (IN3)" }
  - { pin: gpio.10, instance: motor, bind: bin2, to: "DRV8833 BIN2 (IN4)" }
  - { pin: gpio.4, instance: motor, bind: sleep, to: "DRV8833 nSLEEP (EEP)", via: "high = awake" }
  - { pin: gpio.3, instance: motor, bind: fault, to: "DRV8833 nFAULT (ULT)", via: "the C3's pull-up; low = fault" }
  - { pin: 5v, to: "DRV8833 VM (VCC)", via: "100 µF electrolytic across VM and GND" }
  - { pin: gnd, to: "DRV8833 GND" }
sections:
  - id: check
    title: Before wiring
    diagram: map
    steps:
      - id: coils
        text: "Multimeter on Ω across the motor's pins, two at a time. Two pins that read about 10–40 Ω are one coil (A); the other two are coil B. Pins of different coils read open. Mark them A1, A2, B1, B2."
        check: "Both coils read within a tenth of each other. Write the value down: it becomes coil_ohm."
      - id: module-pullups
        text: "Power the module alone: VM to 5 V and GND (a USB 5 V source), nothing else connected. Measure EEP (nSLEEP) and ULT (nFAULT) to GND."
        check: "EEP reads about 0 V and ULT about 0 V or floating. If either reads about 5 V the module pulls it up to VM: stop here and read the design's note on module pull-ups before connecting GPIO3 or GPIO4."
  - id: power
    title: Motor supply
    diagram: map
    steps:
      - id: vm
        text: "The Super Mini's 5V to the module's VM (VCC), GND to GND. Solder the 100 µF across VM and GND at the module, the stripe (−) to GND."
        pins: [5v, gnd]
        check: "With USB plugged in: VM to GND reads 4.6–5.1 V."
  - id: logic
    title: Inputs, sleep and fault
    diagram: map
    steps:
      - id: inputs
        text: "GPIO5 to AIN1, GPIO6 to AIN2, GPIO7 to BIN1, GPIO10 to BIN2. Keep the four wires short and together."
        pins: [gpio.5, gpio.6, gpio.7, gpio.10]
      - id: sleep-fault
        text: "GPIO4 to nSLEEP (EEP), GPIO3 to nFAULT (ULT). GPIO8 (the LED) and GPIO9 (BOOT) stay free."
        pins: [gpio.4, gpio.3]
        check: "After flashing c3s-stepper, before the motor: fr devices get stepper-c3 shows motor.motion released, and nFAULT reads about 3.3 V. Press the board's reset a few times while measuring AOUT1 to AOUT2: it stays at 0 V."
  - id: motor
    title: The motor
    diagram: map
    steps:
      - id: coils-out
        text: "USB unplugged. Coil A's two pins to AOUT1 and AOUT2, coil B's to BOUT1 and BOUT2 (A1 to AOUT1, B1 to BOUT1)."
        note: "Turning the wrong way later? Swap A1 and A2, or configure invert."
      - id: first-hold
        text: "Plug in USB. Set the coil resistance you measured and the run current with motor.configure, as step 3 of the user manual's stepper first run shows. Then fr send stepper-c3 motor.hold."
        check: "The shaft resists turning by hand; fr send stepper-c3 motor.release lets it go."
      - id: first-turn
        text: "fr send stepper-c3 motor.move_by '{\"steps\": 160}' turns one revolution at eighth steps (20 full steps of 18°)."
        check: "The pinion turns exactly once and stops on its mark; motor.done says reached."
```

**Landing it in two steps.** T2 (§12) lands the guide with `board:` only: no `profile:` and no `covers:`. Rows with
`instance`/`bind` are fine if the checker leaves them unchecked without a profile; otherwise T2 omits those two
keys. A guide with a board and no profile is still checked against the board's free pins. The owner then has it on
the Bench (`/#/bench?v=guide&id=stepper-c3`) while the firmware is written. T6 adds `profile`, `covers` and the
instance rows once the profile exists, and `fr wiring check stepper-c3` must then pass. `map.svg` stays as drawn:
1,000 wide, where the convention is 680. That is unvalidated and only cosmetic.

**The parts** (`hardware/parts/`):

```yaml
schema: fractonica/part@1
id: drv8833-module
name: DRV8833 dual H-bridge module (red)
category: module
summary: Two H-bridges (1.5 A RMS each) for a bipolar stepper or two DC motors, VM 2.7–10.8 V, 3.3 V logic inputs; no current sensing on this module.
specs:
  vm: 2.7–10.8 V
  current: 1.5 A RMS, 2 A peak per bridge
  logic: VIH 2 V, inputs pulled down inside
  sense: ISEN tied to GND (no current limit)
  bulk_cap: 10 µF tantalum on VM
inferred: [sense]
pins:
  - { name: VM (VCC), desc: motor supply }
  - { name: GND, desc: ground }
  - { name: AIN1 AIN2 (IN1 IN2), desc: bridge A inputs }
  - { name: BIN1 BIN2 (IN3 IN4), desc: bridge B inputs }
  - { name: AOUT1 AOUT2 (OUT1 OUT2), desc: coil A }
  - { name: BOUT1 BOUT2 (OUT3 OUT4), desc: coil B }
  - { name: nSLEEP (EEP), desc: "high = awake; low = all outputs off (internal pull-down)" }
  - { name: nFAULT (ULT), desc: "open drain, low on over-current or over-heat (not under-voltage); needs a pull-up" }
notes:
  - "IN1/IN2: 00 coast, 10 forward, 01 reverse, 11 brake. No combination shorts the supply."
  - "Some modules pull EEP up to VM through a resistor or solder jumper; measure it before wiring nSLEEP to a GPIO."
datasheets: [https://www.ti.com/lit/ds/symlink/drv8833.pdf]
```

```yaml
schema: fractonica/part@1
id: micro-stepper-10mm
name: Micro stepper motor, 10 mm, two coils
category: actuator
summary: Tiny bipolar can-stack stepper (camera-lens type) with a brass pinion; 18° a step, 3–5 V, four pins.
specs:
  step_angle: 18° (20 steps a turn)
  coil_resistance: 10–40 Ω
  rated: 3–5 V
  shaft: brass pinion
inferred: [step_angle, coil_resistance, rated]
pins:
  - { name: A1 A2, desc: coil A (find with an ohmmeter) }
  - { name: B1 B2, desc: coil B }
notes:
  - "fr.stepper on drv8833_stepper; set coil_ohm from the measured coil and run_ma at 60 % of the rated current to start."
  - "It runs warm when held: the firmware drops to hold power and lets go after a second at rest."
```

```yaml
schema: fractonica/part@1
id: esp32c3-supermini-board
name: ESP32-C3 Super Mini
category: board
summary: Thumb-sized ESP32-C3 board (4 MB flash, USB-C on USB-Serial-JTAG), blue LED on GPIO8, BOOT on GPIO9.
specs:
  free_pins: GPIO0–7, 10, 20, 21
  strapping: GPIO2, 8, 9
  wifi_tx: 8.5 dBm (antenna)
pins:
  - { name: left, desc: "5V GND 3V3 4 3 2 1 0 (USB up)" }
  - { name: right, desc: "5 6 7 8 9 10 20 21" }
notes:
  - "Board manifest: hardware/boards/esp32c3-supermini.board.yaml."
  - "Its 5V pin is USB VBUS: a motor supply there shares the Mac's port."
```

```yaml
schema: fractonica/part@1
id: capacitor-electrolytic
name: Electrolytic capacitor
category: passive
summary: Aluminium electrolytic, polarised (the stripe marks −); bulk storage on a supply rail.
values: ["100 µF"]
notes:
  - "Rated voltage above the rail with margin: 10 V or more on 5 V."
```

## 9. Dashboard, CLI, docs (D15–D16)

**D15. The generic panel first, then a stepper panel.**
- **Enough to test:** `panels/generic.tsx` already gives Readings (position, speed, motion, the settings) and an
  Action per command. `move_to`'s form pre-fills the current position, `configure`'s form pre-fills every setting,
  and `zero` and `reset_settings` have their confirms.
- **The words, `state/cap-words.ts`** (T7):

  **MEMBERS:**
  - `position`: `{ words: 'position' }`; `target`: `{ words: 'going to' }`; `steps`: `{ words: 'steps' }`
  - `speed_hz`: `{ words: 'speed', earthUnit: 'steps a second' }`
  - `max_speed_hz`: `{ words: 'top speed', earthUnit: 'steps a second' }`
  - `start_hz`: `{ words: 'stop-at-once speed', earthUnit: 'steps a second' }`
  - `accel`: `{ words: 'acceleration', earthUnit: 'steps a second, each second' }`
  - `coil_ohm`: `{ words: 'coil resistance', unit: 'Ω', earthOnly: true }`
  - `run_ma`: `{ words: 'run current', unit: 'mA', earthOnly: true }`
  - `supply_mv`: `{ words: 'motor supply', earthOnly: true }`
  - `hold_pct`: `{ words: 'hold power', unit: '%' }`; `run_duty_pct`: `{ words: 'drive', unit: '%' }`
  - `release_ms`: `{ words: 'lets go after' }`; `position_known`: `{ words: 'position known' }`
  - `steps_per_rev`: `{ words: 'full steps a turn' }`; `slips`: `{ words: 'timing slips' }`;
    `recent`: `{ words: 'faults lately' }`; `seconds`: `{ words: 'for' }`

  **ENUMS:**
  - `StepMode`: full steps, half steps, quarter steps, eighth steps, sixteenth steps, thirty-second steps
  - `Motion`: let go, holding, moving, stopping, fault
  - `DoneReason`: reached, stopped, halted, let go, at a limit, fault, hub went quiet, time up
  - `FaultCause`: driver, injected

  **COMMANDS** (pure-safe: no numbers or units):

  | Command | Verb | Does |
  |---|---|---|
  | move_to | go to | Turns {inst} to the position given, speeding up and slowing down smoothly. |
  | move_by | turn by | Turns {inst} by the steps given. |
  | jog | spin | Spins {inst} at the speed given until it is stopped. |
  | stop | stop | Slows {inst} down to a stop. |
  | halt | halt | Stops {inst} at once; a fast motor may lose its place. |
  | hold | hold | Turns the coils of {inst} on to hold it where it is. |
  | release | let go | Turns the coils of {inst} off. |
  | zero | set position | Calls where {inst} is now its position, without moving it. |
  | configure | configure | Changes how {inst} moves and how hard it drives its coils, and keeps it. |
  | reset_settings | reset settings | Forgets what {inst} was configured with. It cannot be undone. |

  `CAP_WORDS['fr.stepper'] = 'stepper'` lands with the schema (T1), since `device-nav.test.ts` fails without it.
- **The stepper panel** (T7, after T1): `pages/device/panels/stepper.tsx`, registered in `PANELS`.
  - **Headline:** the position and the motion word, with "as last seen" when away (the LED panel's pattern).
  - **Quick:** one control, **Stop** (`motor.stop`), shown only while moving or stopping.
  - **Lens:** `GenericBody` with `extra`, holding:
    - **a shaft dial:** a ring (the UI's `StageRing` style, no bars) with a mark at `(position mod (steps_per_rev ·
      2^step_mode)) / that` of a turn, the target as a second mark, and the motion word under it;
    - **nudges:** `move_by` of −1 turn, −1 full step, +1 full step and +1 turn (computed from `steps_per_rev` and
      `step_mode`); a **Go to** field (`move_to`); **Spin** back and forward at half `max_speed_hz` (`jog`);
      **Stop**, **Halt**, **Hold** and **Let go**;
    - **the fault line:** an `ErrorLine` while `motion` is fault, with the cause and "hold clears it";
    - **"position not known — set position here"** linking `zero` while `position_known` is false.
  - `covers: ['move_to', 'move_by', 'jog', 'stop', 'halt', 'hold', 'release']`. Settings stay in the generic
    Actions (`configure`).
  - The design rules apply: `var(--c-*)` only, no bold, no "Send", texts through `useHubText`.
  - A node test (`test/stepper-panel.test.ts`, `renderToString` with mocked hooks): the headline at rest and away,
    the dial's angle arithmetic (in `state/stepper.ts`, pure), the nudge sizes per step mode, and the fault line.

**D16. CLI, MCP, docs, simulation: no new ops.**
- **No new ops:** `fr send stepper-c3 motor.move_by '{"steps":160}'`, `fr wait event motor.done --since <cursor>`,
  `fr devices get stepper-c3` (the mirror `motor.*`) and `fr events stepper-c3 --types 'motor.*'` cover testing.
- **The cost of `stepper_*` ops is not worth it yet:** `REGISTRY_HASH`, op counts and eight prefix regexes in the
  protocol tests, the parity test, a renderer. They come when an app needs a stepper-aware CLI (for example `fr
  stepper turns`).
- **MCP** needs nothing: its tools are the ops.
- **The user manual:** a section "Stepper motor" with the wiring guide's link (`<http://127.0.0.1:7420/#/bench>`,
  guide `stepper-c3`), the bring-up commands of §11 and the meaning of `done`'s reasons, plus a §19 bench row
  `stepper-c3 | esp32c3-supermini | c3s-stepper | micro stepper on a DRV8833`.
- **No plugin skill yet:** `parity.test.ts` pins the skill list. A `stepper` skill comes with the ops.
- **A simulated stepper for the dashboard** (T8): `tools/fake-stepper.ts`, a `FakeNode` (as `tools/fake-camera.ts`)
  that:
  - answers the commands with the generated codecs;
  - simulates the motion with the same rules at 20 ms ticks (a TypeScript trapezoid; not the C++ engine, its looks
    only);
  - reports `position`, `speed_hz` and `motion`;
  - emits `done` and, on SIGUSR1, a `fault`.

  `tools/dash-dev.ts --stepper` provisions it as the camera flag does, with the image manifest's caps patched for
  the `microstep` trait. AGENTS.md §3 gets the flag's line. The C++ `fr_fleet` stays as it is: its kit profiles are
  C6 and C3-OLED only, and a stepper kit is not worth the C++ work for a panel.

## 10. Tests (all host-side; no board)

**Host C++ suite** (`node tools/host-test.mjs stepper`, ASan + UBSan; new files in `firmware/test/host/tests/`,
globbed):

1. **`stepper_phase_test.cpp`** (T3):
   - the 33 table values against `std::sin` (±1 LSB);
   - `phase(e)` symmetry over 128 indexes (`cos(e) = sin(e + 32)`; quadrant signs);
   - the vector's magnitude constant within 0.1 % at every index;
   - each step mode's indexes: full = {0, 32, 64, 96}, the wave; half steps alternate;
   - `invert` mirrors the sequence;
   - negative positions wrap like positive ones (e(−1) = 128 − 32/m);
   - 4·m steps make one electrical cycle.
2. **`stepper_engine_test.cpp`** (T3). It drives `StepEngine` in a simulated-time loop (alarms at the returned
   intervals) and checks each case against a double-precision reference:
   1. **accel/decel symmetry:** 0 → 1,000 at a = 8,000, vmax = 1,600: the interval sequence is a palindrome (±1 µs).
   2. **kinematics:**
      - the first interval is √(2/a) ± 1 %;
      - the time to vmax is vmax/a ± 1 %, the total move time the trapezoid formula ± 1 %;
      - a short move (d < vmax²/a) is a triangle peaking at √(a·d) ± 1 %;
      - every interval is ≥ 100 µs.
   3. **position exactness:**
      - every step is ±1;
      - the signed sum of steps equals the position;
      - the final position equals the target for 1,000 random (target, vmax, a) sets, seeded.
   4. **limits of the profile:**
      - |Δv²| ≤ 2a at every step;
      - v² ≤ vmax² except while decelerating from a higher earlier vmax;
      - **no overshoot** whenever the target was beyond the stopping distance.
   5. **retarget mid-move:**
      - farther, same direction: v² never falls before the new decel point;
      - nearer but beyond the stopping distance: lands exactly with no overshoot;
      - inside the stopping distance: the overshoot equals the stopping distance at the retarget (±1), turns at zero
        speed, lands exactly;
      - a slower `speed_hz` mid-cruise decelerates at a, never faster.
   6. **reversal:** a target behind at cruise: v² falls by 2a per step, crosses zero once, returns and lands. Jog +s
      → −s does the same.
   7. **stop:** from cruise, the distance is ⌈v²/2a⌉ ± 1 steps (`stopped`); also mid-acceleration and during
      deceleration. A stop at rest returns `rested_now` false and nothing pending.
   8. **halt:** no further steps, `halted`, speed 0.
   9. **jog:** reaches s and holds it; s changes up and down at a; s = 0 rests (`stopped`); at a soft bound it rests
      exactly on the bound with `limit`.
   10. **overflow:** −10⁹ → +10⁹ at a = 200,000, vmax = 10,000 (UBSan clean, exact); a = 10, vmax = 10 over 10⁴ steps
       (the slowest corner, run to the end); a jog started near +10⁹ rests exactly on the bound (`limit`).
   11. **slips:**
       - 1.5 ms late: no slip, no burst (no two steps closer than the interval);
       - 5 ms late at cruise: one slip, v² reset to 0, re-ramped, final position exact;
       - `slips` reported in the snapshot.
   12. **fault:** `fault()` mid-move rests with `fault`, latches, refuses `submit` (`arm` false) until `clear_fault`.
   13. **set_position** is refused while running.
3. **`stepper_bridge_test.cpp`** (T4, `drv8833_bridge.hpp`):
   - D8's table: positive, negative and zero amplitude, release;
   - `peak` from permille (0, 1, 200, 1,000);
   - no duty above full;
   - `c` rounds at ±1 LSB of the exact product;
   - full-step (wave) and half-step vectors give the expected pin duties.
4. **`services_stepper_test.cpp`** (T5) with `tests/fake_stepper.hpp`: a `hal::Stepper` around the **real**
   `StepEngine`, whose "ISR" is a FakeCore timer. It records energise permilles, releases, shapes and wakes, and can
   raise a fault. Over `FakeCore` and `RecordingSink`, with an in-memory `hal::Settings`:
   - **boot:** released, position 0, `position_known` false, no energise, one core timer taken.
   - **move_to:**
     - OK at once, `moving`, `done {reached}` at the engine's time;
     - the final `position` reported exactly;
     - run power for 100 ms, then hold power, then released after `release_ms`;
     - `release_ms` 0 never releases;
     - `hold` holds with no release.
   - **retarget:** one `done` only, for the last target. `move_by` twice mid-move adds to the target.
   - **stop / halt / release** while moving give the matching `done`. At rest they are OK with no event.
     `position_known` falls above `start_hz` and stays below it.
   - **jog** with `seconds`: `done {elapsed}` after a decelerated stop.
   - **faults:**
     - a fake fault mid-move: `fault {driver}`, `done {fault}`, `motion` fault, `position_known` false;
     - `hold` within 1 s is BUSY, after 1 s OK;
     - three in 60 s: BUSY for 60 s;
     - `clear_fault` BUSY while the line is low;
     - `inject_fault` under `FR_TEST_HOOKS`; UNSUPPORTED without.
   - **arguments:**
     - `speed_hz` above `max_speed_hz` and `accel` above the configured one: INVALID_ARGS;
     - limits on: a target outside INVALID_ARGS, an unknown position BUSY, `zero` makes it known;
     - a move to where it rests: `done {reached}` at once;
     - jog 0 = stop.
   - **configure:**
     - the keys written, `m` last;
     - a reboot (a new service over the same settings) loads them;
     - BUSY while moving; `step_mode` BUSY unless released;
     - micro8 → micro16 doubles the position, the limits and the speeds not given;
     - micro32 with `max_microsteps_log2() == 1`: INVALID_ARGS;
     - `limit_min ≥ limit_max`: INVALID_ARGS;
     - `reset_settings` erases `m` and applies the build's configuration;
     - a corrupt stored value is ignored.
   - **power:** `run_duty_pct` and the energise permilles for the default (20 %), a 40 Ω/200 mA motor (100 %,
     capped), and `hold_pct`.
   - **hub silence** (the host's `fixture_link.cpp`): a move under a hub session, the hub quiet for 10 s: decelerated
     stop, `done {hub_lost}`. Another hub's WELCOME does the same. A move with no hub session runs on.
   - **reports:** `position` at most `report_hz` while moving; exact at rest; `speed_hz` 0 at rest.
5. The driver's IDF source is **not** host-built. Shimming gptimer and `hal/ledc_ll.h` into `esp_sim` is a follow-up
   if the bench shows bugs the IDF-free pieces cannot.

**TypeScript and generation:**
- `pnpm fr gen` then `pnpm fr gen --check`: 0 stale.
- `pnpm typecheck`.
- `pnpm vitest run packages/codegen`: the pinned lists (cpp-emit `caps`, model id order, board.test services, the
  driver "known:" lists in board.test and bench.test). Also:
  - a new board.test case: `c3s-stepper` resolves with the budget of D13 and the `sdkconfig.board` lines;
  - a FACTS row for `esp32c3-supermini` (uart 21, rmt_rx 2, en null);
  - the OLED board refusing the same binds (GPIO5/6 reserved).
- `pnpm vitest run packages/protocol` (CATALOG_HASH in `protocol-camera.test.ts`, its history comment) and
  `packages/sdk`.
- `pnpm vitest run packages/hub`: `wiring-w1.test.ts`'s "every guide and part" (stepper-c3 refused today) and any
  board-detection test that now sees two C3 boards.
- `pnpm vitest run packages/dashboard`:
  - `device-nav` (the word);
  - `cap-words` (the `_hz`/`_ms` members);
  - `device-state` (every form seeded from defaults waits only on blank fields);
  - `design-rules` (the guide exists, no milestone codes);
  - `stepper-panel`.
- `fr wiring check stepper-c3` (through a private hub in a test, never 7420): ok, no failed rows.

**The ESP-IDF build** (T6, scratch directories under `build/`):

```sh
pnpm fr gen firmware --profile c3s-stepper --out build/c3s-gen
idf.py -C firmware/apps/node -B build/c3s-build -DFR_GEN_DIR=$PWD/build/c3s-gen -DIDF_TARGET=esp32c3 \
  -DSDKCONFIG=$PWD/build/c3s-build/sdkconfig \
  "-DSDKCONFIG_DEFAULTS=$PWD/firmware/config/sdkconfig.framework;$PWD/firmware/apps/node/sdkconfig.defaults;$PWD/build/c3s-gen/sdkconfig.board;$PWD/firmware/config/sdkconfig.build.debug" build
```

Acceptance:
- it builds warning-free;
- `sdkconfig` has both GPTIMER lines;
- the map file puts `Drv8833Stepper`'s ISR entry points, `StepEngine::on_alarm` and the `isqrt` in IRAM
  (`0x403…` on the C3; a scripted `nm` check in the task's notes);
- `dependencies.lock.c3s-stepper` is committed.

**On the bench** (the owner, §11). An optional `tests/e2e/t-stepper.ts` gate (move, return to a mark, fault inject,
hub silence) is a follow-up.

## 11. First bring-up (for the owner)

0. **Wire it** by the guide (`/#/bench?v=guide&id=stepper-c3`). Check the module's pull-ups first (step
   `module-pullups`, and the risk below).
1. **Measure the coils:** R_A and R_B within 10 % of each other, say 20 Ω. Different coils read open.
2. **Choose the run current.**
   - If the motor's rated voltage V_r is known: `run_ma = 0.6 × V_r / R`.
   - If it is not, assume 3 V: `run_ma = 0.6 × 3000 / R` (20 Ω → 90 mA).
   ```sh
   fr send stepper-c3 motor.configure '{"coil_ohm":20,"run_ma":90}'
   fr devices get stepper-c3            # motor.run_duty_pct ≈ 36
   ```
3. **Hold test:** `fr send stepper-c3 motor.hold`. The shaft resists turning. After 30 s the can is warm at most;
   too hot to touch means lower `run_ma`. Then `motor.release`.
4. **Slow turn:**
   ```sh
   fr send stepper-c3 motor.configure '{"max_speed_hz":160,"accel":800}'
   fr send stepper-c3 motor.move_by '{"steps":160}'     # one turn at micro8 if the motor has 20 full steps
   ```
   - Mark the pinion: it turns exactly once. If not, the step angle differs; `steps_per_rev` is what one turn takes
     in full steps (steps / 8).
   - The wrong way: `configure {"invert":true}` or swap A1/A2.
5. **Repeatability:** five times `move_by 1600` then `move_by -1600`; the mark comes back exactly. `done` says
   `reached` with `slips` 0.
6. **Top speed:**
   - A jog may not exceed `max_speed_hz` (step 4 set 160), so first
     `fr send stepper-c3 motor.configure '{"max_speed_hz":10000}'`.
   - `motor.jog '{"speed_hz":800}'`, then 1600, 2400, 3200 … (`motor.stop` between) until it buzzes without turning
     (stalled; harmless at this current).
   - `max_speed_hz` = 70 % of the last good speed.
   - Then raise `accel` with `configure` until a one-turn move misses its mark; set it to half of that.
   - Expect 300–800 full steps a second at 5 V (2,400–6,400 at micro8; *inferred*). More `run_ma` gives more torque
     and more heat.
7. **Heat:** five minutes of back-and-forth turns:
   ```sh
   for i in $(seq 50); do
     c=$(fr send stepper-c3 motor.move_by '{"steps":160}' --json | jq -r .cursor)
     fr wait event motor.done --since "$c" --timeout 10
   done
   ```
   The motor and the DRV8833 are warm, not hot.
8. **Fault path** (debug build): `fr send stepper-c3 motor.inject_fault` gives `fault {injected}` and motion
   `fault`. `motor.hold` within a second is BUSY; after it, OK.
9. **Keep the result:** the settings persist in NVS. Put the measured `coil_ohm` and `run_ma` (and `steps_per_rev`
   if it differs) into the profile's config too, so a fresh board starts right.

## 12. The work, split for parallel agents

Each task owns its files; no two tasks running at the same time edit the same file. Every task runs the checks of §10
that its files touch and leaves `pnpm test` green for its area.

**Wave 0. Start now, in parallel:**
- **T1. Schema and generation.**
  - Files: `schema/registry.yaml`, `schema/capabilities/stepper.cap.yaml` (D2 verbatim), `pnpm fr gen` and its
    outputs (all the generated dirs).
  - Test pins:
    - `packages/codegen/test/cpp-emit.test.ts` (`'stepper'` after `'clock'`);
    - `packages/codegen/test/model.test.ts` (`[0x0012, 'fr.stepper', 'Stepper', 'standard']`);
    - `packages/protocol/test/protocol-camera.test.ts` (CATALOG_HASH and its history line).
  - `packages/dashboard/src/state/instruments.ts` (`'fr.stepper': 'stepper'`).
  - `docs/spec/07-capabilities-sdk.md`: the §7.2 registry row, and a §7.8 paragraph on the driver (D7–D9).
- **T2. Hardware library.**
  - Files: `hardware/boards/esp32c3-supermini.board.yaml` (D13), and `esp32c3-oled042.board.yaml` only if
    ambiguity must be mutual;
  - the four parts (D14), `hardware/wiring/stepper-c3/guide.yaml` (the board-only form);
  - any hub test that pinned "one C3 board" by detection.
  - The point is to give the owner the Bench guide at once. Checks: `packages/hub`, `packages/dashboard`
    design-rules, `packages/codegen` (board loads).
- **T3. The motion core and the contract.**
  - Files: `firmware/components/fr_core/include/fr/motion/{phase_table,step_planner,step_engine}.hpp`,
    `firmware/components/fr_core/include/fr/hal/stepper.hpp`;
  - `firmware/test/host/tests/stepper_phase_test.cpp`, `stepper_engine_test.cpp`.
  - The interface of §4 is the contract; changing it means telling T4 and T5.

**Wave 1** (T4 after T3; T5 after T1 and T3; T7 and T8 after T1):
- **T4. The driver.**
  - Files: `hardware/drivers/drv8833_stepper/{driver.yaml, CMakeLists.txt, linker.lf, include/fr/drv/drv8833_stepper.hpp,
    include/fr/drv/drv8833_bridge.hpp, src/drv8833_stepper.cpp}`;
  - `firmware/test/host/CMakeLists.txt` (`FR_STEPPER_INCLUDES` on `fr_host_tests`);
  - `firmware/test/host/tests/stepper_bridge_test.cpp`;
  - the driver-list pins in `packages/codegen/test/board.test.ts` and `bench.test.ts`.
- **T5. The service.**
  - Files: `firmware/components/fr_core/include/fr/services/stepper_service.hpp`,
    `firmware/components/fr_core/src/services/stepper_service.cpp`;
  - `firmware/components/fr_core/CMakeLists.txt` (SRCS);
  - `firmware/test/host/tests/{services_stepper_test.cpp, fake_stepper.hpp}`.
  - Not `board.ts`: T6 adds the SERVICES entry.
- **T7. The dashboard.** Files: `packages/dashboard/src/state/cap-words.ts`, `src/state/stepper.ts`,
  `src/pages/device/panels.ts`, `src/pages/device/panels/stepper.tsx` (and a `.css` if needed),
  `test/stepper-panel.test.ts`. Screenshots with `dash-shoot` once T8's fake exists.
- **T8. Docs and simulation.** Files: `docs/user-manual.md` (section and §19 row), `tools/fake-stepper.ts`,
  `tools/dash-dev.ts` (`--stepper`), `AGENTS.md` (§3, the flag's line).

**Wave 2** (after T2, T4 and T5):
- **T6. Integration.**
  - Files: `packages/codegen/src/board.ts` (the SERVICES entry of D10);
  - `packages/codegen/test/board.test.ts`: the services-list message, the FACTS row, the c3s-stepper case. This is
    after T4's edit of the same file;
  - `firmware/profiles/c3s-stepper.profile.yaml` and the generated `c3s-stepper.slots.lock`;
  - `hardware/wiring/stepper-c3/guide.yaml`: `profile`, `covers`, the instance rows;
  - `firmware/apps/node/dependencies.lock.c3s-stepper`;
  - the ESP-IDF build and IRAM check of §10;
  - the whole check list of AGENTS.md §3;
  - an "As built" note at the top of this document.
  - Then the owner flashes (`fr serial idf <dev> flash` or `fr flash`, with their go-ahead) and runs §11.

The order in one line: **T1 ∥ T2 ∥ T3 → T4 ∥ T5 ∥ T7 ∥ T8 → T6.** T2 gives the owner the guide while everything
else is built.

## 13. Verified and not

**Read in the repository** (2026-11-17):
- codegen's capability, driver, board and profile rules, and the generated shapes;
- the glue's constructor order; the resource budget (a new key fails unless the board declares it);
- the haptic and fixture precedents (safe-off hooks, hub silence, LEDC channel and timer use);
- the host suite's FakeCore and its include rules;
- the wiring schemas and cross-check; the dashboard's word, unit and control rules;
- the two tests that fail today for want of `stepper-c3/guide.yaml`.

**Seen in the owner's photos:** a TI DRV8833 with a 10 µF tantalum and two small SMD parts; a 10 mm stepper with a
brass pinion and four pins.

**Not verified** (*inferred*, checked by the bring-up or the first build):
- the step angle and coil resistance;
- the module's pull-ups on EEP and ULT, and ISEN tied to GND;
- the DRV8833's t_WAKE and pull-down values;
- the C3 pads' reset state (below);
- LEDC duty 2^bits giving a steady high; a gptimer alarm in the past firing at once;
- the ISR cost per step; the motor's pull-out rate;
- `bcd_device` 0x0101 for this board.

## 14. Risks

- **Module pull-ups.**
  - If the module pulls **EEP (nSLEEP) up to VM**, the bridge is awake from power-up, and GPIO4 fights a 5 V pull-up.
    The fix is to cut the jumper or remove the resistor.
  - If it pulls **ULT (nFAULT) up to VM**, GPIO3 sees 5 V. The fix is to remove it, or add 15 kΩ from GPIO3 to GND
    (the line then idles near 3 V).
  - The guide's `module-pullups` step finds both before any GPIO is connected. The photo shows no pull-up on the top
    side.
- **Boot glitches.** GPIO4–7 are the C3's JTAG pads (MTMS, MTDI, MTCK, MTDO). If they come out of reset with weak
  pull-ups (*inferred*, not checked), the inputs could read high before init. That is harmless while nSLEEP stays
  low, which the DRV8833's internal pull-down only weakly ensures against a ≈ 45 kΩ pull-up on GPIO4.
  - The guide's reset check (AOUT stays 0 V) catches it.
  - The remedy is a **4.7 kΩ pull-down from GPIO4 to GND**: 0.3 V against a 45 kΩ pull-up, below VIL. Not 10 kΩ:
    that gives ≈ 0.6 V, too near 0.7 V.
  - Codegen's `power_up_glitch` cannot help until the C3's reset states are known and declared.
- **USB 5 V as VM:**
  - motor current steps on the Mac's port and the C3's regulator input; the 100 µF smooths them;
  - at the defaults it is ≈ 0.1 A;
  - a short on VM is a short on USB (the Mac's port protection trips).
  - A brown-out reset mid-move leaves the coils off (init) and the position unknown, as designed.
- **No current regulation:**
  - torque falls with speed (back-EMF and inductance), so voltage-mode drive limits the top speed;
  - a wrong `coil_ohm` or `run_ma` is the only thing between the motor and its rated heat;
  - the defaults are deliberately weak;
  - there is no stall detection: `position_known` is as good as the torque margin.
- **Flash stalls:**
  - if the cache-safe options or the IRAM placement are wrong, steps stop during NVS or OTA writes: slips, not lost
    counts, because the engine restarts the ramp;
  - the map-file check (§10) and `done.slips` on the bench show it;
  - `configure` writes only at rest.
- **LEDC channels are allocated statically per driver** and codegen only sums them. `drv8833_stepper` (timer 0,
  channels 0–3) collides with `fixture_gpio` (timer 0, channels from 0; S3) and, on a 6-channel chip, with
  `haptic_ledc` (from channel 3). Neither shares a profile with it today. A shared LEDC allocator in
  `fr::platform` is the follow-up, not part of this work.
- **Detection:** a second C3 board with the same USB ids makes C3 detection ambiguous. Provisioning then needs the
  profile named, as it does for the C6 Super Mini and the Waveshare LCD. Registered devices are unaffected.
- **Mid-band resonance** of small steppers at a few hundred steps per second. micro16 or micro32, or a different
  `accel` through the band, are the remedies on the bench.
- **The id gap:** 0x0011 stays free for `fr.host`'s proposal. If that never lands, the gap stays, harmlessly.
