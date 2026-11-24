# HAPTIC-1: a solenoid and a vibration motor on the stepper's ESP32-C3, fed by a lithium-ion capacitor

> **As built, 2026-11-21** (approved by the owner the same day; not yet on the bench: §10 waits for the owner's
> go-ahead and the Schottky diodes). Where the build differs from the proposal below, the text says so (D4, D5). Asked
> for: "add vibro (haptic) feedback to Fractonica devices as a shared component, the way
> the stepper and the buzzer were added", with a micro solenoid and a cylinder vibration motor (ERM). This document
> designs it. Decisions here are proposals the owner can overturn. Anything marked *inferred* was not read in a
> datasheet, in code or on the bench.
>
> Fixed by the owner (2026-11-21):
> - both loads go on **stepper-c3** (ESP32-C3 Super Mini, profile `c3s-stepper`), beside the motor and the buzzer;
> - the **solenoid**: 5.7 Ω coil (measured), 4 mm stroke, spring return, nothing printed on it, sold as 3 V;
> - the **supply**: the owner's **LIC-H-0825**, a 90 F lithium-ion capacitor (part `lic-h-0825`), through their
>   **protected TP4056 module**;
> - the **switch**: the owner's **AO3400**s, bare SOT-23s (no adapter boards); the IRF530N is not used (§0);
> - the **diodes**: the owner has **1N4007**s only; strength control needs Schottkys (§0);
> - GPIO0's T-LAT test pin may go; the panel gets **named patterns and a metronome** (D2, D11);
> - the owner wants to control the **solenoid's tap rate and strength as finely as possible**;
> - nothing in this work flashes a board, opens a serial port or restarts a hub (lab on 7420, uriel) without the
>   owner's go-ahead, asked for each action.
>
> **Most of the capability exists already.** `fr.haptic` 1.0 (design power-p1 D6–D7) is one capability for an ERM
> or a solenoid: `pulse`, `play`, `stop`, the `cut` event, kick-then-hold for a solenoid, an on-time limit, a duty
> budget, refusal and cut on a low supply, and the hub-silence stop. Its driver `haptic_ledc`, its service and the
> hub's `haptic_*` ops and `fr haptic` CLI exist; `c6w-scale` declares two instances. What is missing for this work
> is: tap trains with live rate and strength, strength on a solenoid, a `done` event, a second PWM source (the C3's
> LEDC channels are all taken), a dashboard panel, a fake, a guide for the C3 and the docs.

## 0. The parts and the switch

- **The solenoid:** 5.7 Ω. At 3 V it draws 0.53 A (1.6 W), at 4.2 V 0.74 A (3.1 W). "3 V" is taken as the voltage it
  takes continuously (*inferred*: nothing is printed on it). The coil's inductance is not known; at a few mH its
  current settles in about a millisecond (L/R), so at 20 kHz PWM the current follows the average voltage, and the
  pull follows its square (*inferred*).
- **The motor:** the cylinder ERM with the JST lead (part `erm-cylinder`: 3 V, about 80–120 mA, *inferred*). The
  owner did not give its current; §10 step 2 measures its resistance.
- **The capacitor: LIC-H-0825** (owner's label; part `lic-h-0825`): 90 F ±20 %, a **lithium-ion capacitor**, not a
  double-layer supercapacitor. Working range 2.5–4.0 V, surge and maximum charge 4.2 V at 1 A, **damaged below
  2.5 V**; ESR ≤ 250 mΩ at 1 kHz and **≤ 600 mΩ DC**; 500 mA continuous, **2.5 A for 1 s**. From 4.2 V to 2.8 V it
  holds ½ × 90 × (4.2² − 2.8²) ≈ 440 J: minutes of the solenoid held fully on, far more than the duty budget (D3)
  lets through, and the charger refills it as it goes.
- **The solenoid on this cell:** 5.7 Ω + up to 0.6 Ω DC ESR + about 0.1 Ω of AO3400 and protection MOSFETs: from a
  full cell **0.63–0.66 A**, the coil sees about **3.6–3.7 V** (2.2–2.5 W) and the cell's terminal dips by about
  0.4 V while it is on. That is above the cell's 500 mA continuous rating and well inside its 2.5 A-for-1-s rating:
  `max_on_ms` 1,000 and the 30 % budget (D3) keep it there (on average at most 0.2 A).
- **The switch: AO3400(A) for both loads.** The IRF530N is **not** logic-level: its V_GS(th) is 2–4 V and its
  R_DS(on) is rated at V_GS = 10 V, so a 3.3 V GPIO may only half-turn it on; it would run hot and the solenoid would
  pull weakly. The AO3400 is fully on from 3.3 V (about 50 mΩ at V_GS 2.5 V: 20 mW at 0.66 A). Each gate gets
  **100 Ω in series** from the GPIO and **10 kΩ from gate to GND**, so the load stays off while the C3 boots, resets
  or is flashed. A second AO3400 switches the motor; an NPN (S8050) would also carry 100 mA, but D4 drives the motor
  with sub-microsecond pulses, which an NPN's storage time smears.
- **The owner's AO3400s are bare SOT-23s.** Pin 1 gate, pin 2 source, pin 3 drain (alone on its side; part
  `ao3400a`). Without an adapter board: tin the three legs, solder the 100 Ω and the 10 kΩ straight to the gate leg,
  a wire to the source leg (GND) and one to the drain leg (the load's −), then sleeve or glue it to a scrap of
  perfboard so the legs carry no strain. At 0.66 A it dissipates about 20 mW: it stays cool without copper.
- **Flyback diodes: Schottky 1N5819**, one across each load, stripe to +. **The owner has only 1N4007s.** A 1N4007
  takes microseconds to stop conducting after the MOSFET turns back on; for that time the supply is shorted through
  the AO3400, at every PWM edge: wasted current, a warm AO3400 and a ringing supply. That rules it out wherever the
  output is PWM: the solenoid's strength (`level` below 100) and its hold (a tap longer than `kick_ms`), and the
  motor always (its sigma-delta output switches at hundreds of kHz, D4). **Until Schottkys arrive** (1N5819, 1N5817,
  SS14 or SS34 for the solenoid; any of those or a 1N4148 for the motor), a 1N4007 across the solenoid is fine for
  full-strength taps no longer than `kick_ms` (`level` 100, `ms` ≤ 30): at `rated_mv` 4,200 the output is then plain
  on and off. The motor waits for its Schottky. Nothing in the build waits for them; §10 says which steps do.
- **The charger:** a protected TP4056 module (TP4056 + DW01 + 8205A; pads IN+/IN−, B+/B−, OUT+/OUT−), fed from the
  board's 5V pin. TP4056 charges to 4.2 V; the DW01 cuts the cell off near 2.4 V (*inferred* from DW01A sheets), a
  hardware floor just under the LIC's 2.5 V. IN−, OUT− and the board's GND are one node; B− sits behind the
  protection MOSFETs. Part `tp4056-protected`.
- **The board's pins:** `c3s-stepper` uses GPIO4 (buzzer) and 5, 6, 7, 10, 20 (motor). Of the free pins, GPIO2 is a
  strapping pin that must be high at boot and GPIO21 carries the ROM's boot log (idle high): neither may switch a
  load. That leaves **GPIO0, 1 and 3**, all on ADC1. GPIO0 is the board's T-LAT test pin (D7).
- **LEDC on the C3:** 6 channels and 4 timers. The motor holds timer 0 and channels 0–3, the buzzer timer 2 and
  channel 4. **One channel is left (5).** `haptic_ledc` today takes channels from `LEDC_CHANNEL_MAX / 2` up, which
  is 3 on the C3: it would take the motor's channel (stepper-s1 §11 and buzzer-b1 D4 noted this clash).
- **The C3's sigma-delta modulator (SDM):** 4 channels, used by no Fractonica driver (read in IDF's
  `soc/esp32c3/include/soc/soc_caps.h`: `SOC_SDM_CHANNELS_PER_GROUP 4`; driver `esp_driver_sdm`). It outputs a
  pulse-density stream with 256 levels (`sdm_channel_set_pulse_density`, −128..127) at an oversampling rate of
  312.5 kHz or more (80 MHz over an 8-bit prescaler). A motor averages it like PWM.

## 1. Scope

**In:**
- `fr.haptic` 1.1 (additive): a `tap` command, strength (`level`) on a solenoid's kick, a `done` event, and a
  `done {hub_lost}` where the hub-silence stop was silent (D1–D3);
- a driver **`haptic_sdm`**: the motor on a sigma-delta channel (D4);
- `haptic_ledc` takes the LEDC channel codegen hands it; driver.yaml files declare their fixed LEDC slots and
  codegen refuses an overlap (D5);
- `c3s-stepper` gains `cap` (fr.battery, the LIC), `kick` (the solenoid) and `buzz` (the motor), and gives up its
  T-LAT test pin (D6–D8);
- the guide `stepper-c3` gains a haptics part; a new part for the solenoid (D9);
- the hub's `haptic_tap` op and `fr haptic tap` (D10);
- a haptic panel in the dashboard (D11) and a fake one on the fake stepper board (D12);
- the user manual, spec 07, AGENTS.md (D13); host, codegen, fake and panel tests (§9);
- the bring-up for the owner (§10).

**Out:**
- a fixed `supply_mv` for a haptic with no `fr.battery` behind it (a load on plain USB 5 V). Here the LIC is the
  supply. A follow-up when a board needs it;
- the CHRG and STDBY status pins of the charger: no pin is left, so the LIC's charger state reads `none`, and the
  hub's charge and discharge learning has no sessions to find (its voltage and levels work);
- a shared LEDC allocator at runtime (D5 does the static half in codegen);
- haptics the node starts by itself (a tap on a button press): only commands start one.

## 2. The capability `fr.haptic` 1.1 (D1–D3)

**D1. One capability, two instances.** The solenoid and the motor are both `fr.haptic` (kinds `solenoid` and `erm`).
That is what power-p1 built the capability for: an app pulses either the same way, and the kind decides the
protection. A separate `fr.solenoid` would duplicate the commands, the supply rules and the hub's ops. The version goes
to **1.1**; every change below is additive (07 §7.3: minor is additive), and a 1.0 firmware keeps working with a 1.1
hub.

**D2. What 1.1 adds:**

- **`tap {period_ms, ms, level, count, accent, accent_level}`** (command 4, reliable): a train of `count` taps
  (0 = until stop), one every `period_ms`, each on for `ms` at `level`; with `accent` N above 0, the first tap and
  every Nth after it play at `accent_level` instead (a metronome's first beat of the bar).
  - Ranges: `period_ms` 20–60,000 (50 taps a second down to one a minute); `ms` 1 to `period_ms − 1` and at most
    `max_on_ms`; `level` 1–100, default 100; `count` 0–10,000, default 1; `accent` 0–32, default 0 (none);
    `accent_level` 1–100, default 100.
  - **A tap while a tap train runs changes it in place and keeps the beat:** the next tap comes `period_ms` (the new
    one) after the last tap started, or at once if that time has passed; the count starts again. No `done` for the
    old settings. So a dashboard slider can send new values while the train runs, with no double tap and no gap.
    The bar's position is kept too: a changed `accent` counts from the taps already played.
    A `pulse` or `play` replaces a train (`done {replaced}`), and a tap replaces a pulse or a pattern.
  - INVALID_ARGS for `ms` ≥ `period_ms`, `ms` above `max_on_ms`, and for a train whose share of on-time is above the
    duty budget: `ms × 100 > cooldown_pct × period_ms` (30 % for a solenoid). A train inside the budget is then never
    cut for it, however long it runs (unless pulses before it spent part of the window).
  - BUSY as `pulse`: at or below the supply's critical voltage, a solenoid below critical + 300 mV, no fresh supply
    reading, or the budget already spent.
- **`level` drives a solenoid's kick.** In 1.0 a solenoid kicked at 100 % for `kick_ms` whatever `level` said. In 1.1
  the kick averages `level` % of `rated_mv`, compensated by the supply as for a motor:
  `duty = level × rated_mv / supply_mv`, capped at 100 %. The hold after the kick is `hold_pct` of `rated_mv`, or
  `level` if that is lower (a soft tap never holds harder than it kicked).
  `level` 100, the default, with `rated_mv` at or above the supply (the power bench's `kick`: 5,000 mV on a ≤ 4.2 V
  cell) still saturates at 100 %, so 1.0 behaviour is unchanged for anyone who never set a level.
- **Strength, then, has two controls per tap:** `level` (how hard it pulls: the force goes with the square of the
  average voltage) and `ms` (how long: a short kick stops the plunger before the end of its stroke, a soft tick with
  no knock; a longer one ends in a knock against the stop). Below some level the solenoid does not move against its
  spring at all; §10 finds that level and the shortest full-stroke `ms` on the bench.
- **`done {program, reason}`** (event 2, reliable, as `fr.buzzer`'s): every `pulse`, `play` and `tap` ends with exactly
  one. `program`: `pulse | play | tap`. `reason`: `done` (ran to its end), `stopped` (`stop`), `replaced` (another
  program), `hub_lost` (D3), `cut` (the supply or the on-time limit; a `cut` event with the reason and the supply's
  voltage comes first, as in 1.0).
- `active` stays true from a program's start to its `done`.

**D3. Protection, restated with this solenoid's numbers.** Nothing here is new except the `done`; the defaults are
power-p1's:

| Rule | Solenoid (`kick`) | Motor (`buzz`) |
|---|---|---|
| Kick, then hold | each on-step at `level` for its first `kick_ms` (30), then at `hold_pct` (40 %) of `rated_mv` | — |
| Longest on-time without a break (`max_on_ms`) | 1,000 ms, then `cut {max_on}` | 10,000 ms |
| Duty budget (`cooldown_pct` of any 10 s) | 30 %: BUSY when spent, `cut {max_on}` if a program runs into it | 100 % (none) |
| Refused to start | at or below 3,100 mV (the LIC's critical 2,800 + 300) | at or below 2,800 mV |
| Cut | at critical (2,800) or the floor (2,700), or a stale reading | the same |
| The hub falls silent | stops 10 s after the newest frame of the hub that started it, or at a new hub run: `done {hub_lost}` | the same |
| Boot, reset, flashing, panic | gate held low by the 10 kΩ; the pad latched low before the peripheral takes it; restart and panic hooks drive it low (`register_safe_off`) | the same (D4) |

**Heat:** from a full LIC the coil takes 2.2–2.5 W while on (§0: the cell's ESR drops 0.4 V). Inside the 30 %
budget that averages at most 0.75 W, under the 1.6 W it takes continuously at its 3 V (*inferred*). A one-second
hold is a 30 ms kick at `level` and then 40 %: about 1.5 V, 0.26 A, 0.4 W. So `rated_mv: 4200` (level 100 = all the
LIC gives; **level 71 ≈ 3 V** before the ESR's drop) is safe on this coil, and gives the most force the owner asked
for.

## 3. The driver `haptic_sdm` (D4)

`hardware/drivers/haptic_sdm/` (driver.yaml, CMakeLists.txt, include, src), `implements: hal.HapticOutput`, like
`haptic_ledc`:

- `binds: gpio`, `bind: { out: gpio.<n> }` (a pin in `pins.free`, an `output` field), targets esp32c3, esp32c6,
  esp32s3, esp32c5 (all `SOC_SDM_SUPPORTED`). Traits `{ pwm: true }`.
- Config: `out`; `rate_hz` (default 312,500, the lowest the prescaler gives: fewest edges, least switching heat).
- `write(permille)`: 0 puts the pad back on the GPIO output register, driven low (a density of −128 is not trusted
  to be a steady low); anything above routes the SDM channel to the pad at density `permille × 255 / 1000 − 128`
  (255/256 at 1000: never quite full on, which a motor does not notice).
- `init`: the pad low before the channel is created; the restart and panic hooks of `haptic_ledc` (pads to the GPIO
  register, low, IRAM, register writes only) for this pad too; selftest reads the idle pad back low, as
  `haptic_ledc`'s does. *As built:* `sdm_new_channel` routes the modulator to the pad at density 0 (half on), so the
  driver reads the channel's GPIO-matrix signal back (`gpio_ll_get_io_config`), parks the pad low at once, and routes
  that signal back on the first write above 0. The density mapping is checked by `static_assert`s in the header
  instead of a host test (drivers are not in the host build).
- `resources: { gpio: 1, sdm_channels: 1 }`; the boards gain `resources.sdm_channels` (4 on the C3, C6 and C5, 8 on
  the S3).
- **Switching heat:** at a density of one half the AO3400 switches about 312,000 times a second. With 100 Ω on the
  gate each edge takes about 0.3 µs (*inferred* from its ~6 nC gate charge), about 20 mW at 100 mA. A 1N5819 or
  1N4148 recovers fast enough; a 1N4007 does not (§0).
- **Why not LEDC for the motor:** no channel is left (§0). **Why not the SDM for the solenoid:** at 0.66 A the same
  edges would heat the AO3400 about seven times more; LEDC's 20 kHz keeps the solenoid's edges few.

## 4. LEDC channels for `haptic_ledc` (D5)

- `haptic_ledc::Config` gains **`channel`**, filled by codegen, not by the profile. The driver takes that channel
  instead of counting from `LEDC_CHANNEL_MAX / 2` itself.
- The drivers with fixed LEDC slots: `drv8833_stepper` timer 0 and channels 0–3, `ledc_buzzer` timer 2 and channel
  `MAX − 2`, `st7789_spi` timer 3 and channel `MAX − 1`, `dvp_camera` timer 0 and channel 0, `fixture_gpio` timer 0
  and one channel per `pwm` line from 0. Their code does not change. *As built:* the slots live in codegen
  (`board.ts` `LEDC_SLOTS`), not in driver.yaml: two of them depend on the instance (a panel only with a backlight, a
  fixture line only with `drive: pwm`), which a static list cannot say. The `channel` field is `from: ledc_channel`.
- Codegen gives each `haptic_ledc` instance, in profile order, the first channel no declared slot or earlier instance
  holds, counting from `MAX / 2` up and then down from `MAX / 2 − 1`. On `c6w-scale` that is 3 and 4, as today; on
  `c3s-stepper` it is 5 (*as built:* in port order, the slots.lock's).
- Codegen refuses a profile whose declared channels overlap (today it only adds them up), and one that puts
  `ledc_buzzer` beside two `haptic_ledc` frequencies (the second would take timer 2, the buzzer's).
- This is the static half of the shared LEDC allocator that stepper-s1 and buzzer-b1 named as the real fix: the
  clashes are found at `fr gen`, not on the bench. A runtime allocator stays a follow-up.

## 5. The profile (D6–D8)

**D6. The LIC is an `fr.battery`**, so both loads get compensation and protection from it:

```yaml
test_pin: none   # GPIO0 is the motor's now (D7)
caps:
  # … boot, status, motor, buzzer as now …
  cap:  { cap: fr.battery, driver: tp4056, bind: { sense: gpio.3 },
          config: { chemistry: lic, full_mv: 4200, report_hz: 10 } }
  kick: { cap: fr.haptic, driver: haptic_ledc, bind: { out: gpio.1 },
          config: { kind: solenoid, rated_mv: 4200, supply: cap } }
  buzz: { cap: fr.haptic, driver: haptic_sdm, bind: { out: gpio.0 },
          config: { kind: erm, rated_mv: 3000, supply: cap } }
```

- `cap`: sense through 1 MΩ / 1 MΩ with 100 nF to GND (4.2 V reads 2.1 V, inside the C3's 2.5 V full scale at 12 dB).
  No status pins, no test load, no gate. `full_mv: 4200` because the TP4056 charges to 4.2 V, the LIC-H-0825's
  maximum charge voltage (its working range tops at 4.0 V: §11); the LIC's other levels stay the chemistry's (low
  3,000, critical 2,800, floor 2,700, all above its 2.5 V). `report_hz: 10` so the panel shows each kick's dip.
- `kick`: `rated_mv: 4200` (D3). `kick_ms`, `hold_pct`, `max_on_ms` and `cooldown_pct` stay the solenoid defaults
  (30 ms, 40 %, 1,000 ms, 30 %) until the bench says otherwise.
- `buzz`: `rated_mv: 3000`, the motor's rating. From a full LIC that is a 71 % density at level 100. Power-p1 notes
  the transistor's drop may want +200 mV, checked by feel; an AO3400 drops a few millivolts, so not here.
- `slots.lock`: `cap` 5, `kick` 6, `buzz` 7.

**D7. Pins:** GPIO1 the solenoid's gate, GPIO0 the motor's gate, GPIO3 the LIC's sense. **GPIO0 is the board's T-LAT
test pin**, which debug builds drive for `diag pin_pulse`, and codegen refuses an instance on it. stepper-c3 is not on
the T-LAT bench (it lives on uriel), so the profile sets `test_pin: none`: `pin_pulse` then answers unsupported on
this board. The other way round (the motor on a pin we do not have) would mean dropping the sense, and with it the
compensation and every supply rule.

**D8. Budgets on the C3:** LEDC channels 6 of 6 (motor 4, buzzer 1, `kick` 1), timers 3 of 4 (0, 2, and 1 for
`kick`'s 20 kHz), SDM 1 of 4, ADC1 1 of 5, instances 7 of 16. GPIO left after this: 2 and 21, which cannot switch a
load (§0).

## 6. Wiring and parts (D9)

The guide `stepper-c3` gains `covers: [motor, buzzer, cap, kick, buzz]`, a haptics section and the drawing's new
parts:

| C3 pin | Goes to | Parts |
|---|---|---|
| 5V | TP4056 module IN+ | — |
| GND | TP4056 IN−, OUT−; both AO3400 sources; the divider's bottom | — |
| — | TP4056 B+ / B− to the LIC + / − | LIC-H-0825; the stripe on its sleeve marks − |
| — | TP4056 OUT+ to the solenoid's +, the motor's + and the divider's top | — |
| GPIO3 | the divider's middle | 1 MΩ from OUT+, 1 MΩ to GND, 100 nF to GND |
| GPIO1 | AO3400 #1 gate (pin 1) | 100 Ω in series; 10 kΩ gate to GND; source (pin 2) to GND; drain (pin 3) to the solenoid's −; 1N5819 across the solenoid, stripe to + (a 1N4007 only for full-strength taps, §0) |
| GPIO0 | AO3400 #2 gate (pin 1) | 100 Ω in series; 10 kΩ gate to GND; source (pin 2) to GND; drain (pin 3) to the motor's −; 1N5819 or 1N4148 across the motor, stripe to + (never a 1N4007, §0) |

- New part: `solenoid-micro-3v` (5.7 Ω measured, 4 mm stroke, spring return, 0.53 A at 3 V). Reused: `lic-h-0825`
  (the owner's cell, already a part), `ao3400a` (bare SOT-23, soldered as §0 says), `erm-cylinder`, `diode` (1N5819;
  its 1N4007 line gains "not under PWM"), `tp4056-protected`, `resistor`, `capacitor-ceramic`.
- Safety lines the guide adds: never short the LIC or let it run below 2.5 V; the LIC goes through the protected
  module, never straight to a load; gates get their pull-downs before the first power-up; the diode's stripe to +.

## 7. Hub, dashboard and fake (D10–D12)

**D10. Hub and CLI.** The power module's `haptic_pulse`, `haptic_play` and `haptic_stop` gain **`haptic_tap {device,
instance?, period_ms | hz, ms, level, count}`** (`hz` is turned into `period_ms`, rounded), and the CLI
`fr haptic tap <dev> [--hz 8 | --period-ms 125] [--ms 15] [--level 70] [--count 0] [--instance kick]`. `kick.done`
and `buzz.done` reach the bus like any event; `power.haptic_cut` is unchanged. `fr send stepper-c3 kick.tap '{…}'`
works as for any command. **uriel needs this hub code** for any of it to reach the board while uriel holds it
(buzzer-b1's lesson); `fr diag <port> call kick.tap …` over USB works meanwhile.

**D11. Dashboard.** `panels/haptic.tsx` with `state/haptic.ts`, one block per instance:
- **Solenoid:** TAP (one tap at the settings below); a tap train with **rate** (0.5–25 taps a second, shown in Hz and
  ms), **strength** (level, 1–100 %) and **tap length** (ms, 1 to the kick length, then up to `max_on_ms` with a mark
  where the hold starts), **count** (once, 2, 5, 10, until stop); START and STOP. While a train runs, slider changes go
  to the board at most five times a second and keep the beat (D2). Values the board would refuse (above the duty
  budget) are held back, and the panel says why ("at 20 taps a second a tap can be 15 ms at most").
- **Named patterns** (owner, 2026-11-21), built from `play` and `tap` at the block's strength and tap length:
  solenoid — double tap, triple tap, heartbeat, knock-knock, roll (a fast burst of ten); motor — short, double,
  long, heartbeat. A pattern the board would refuse (over the budget at the chosen tap length) is greyed with why.
- **Metronome** (owner, 2026-11-21) on the solenoid: tempo (20–600 beats a minute, inside the duty budget at the
  chosen tap length), beats to the bar (1–12: `accent`), and the first beat's strength (`accent_level`); START and
  STOP; tempo changes keep the beat (D2). Firmware times every beat; the panel only sends the settings.
- **Motor:** BUZZ (pulse) with strength and length; STOP.
- Both: `active`, the supply's voltage and level from `cap` (a dip on each kick), the last `done` or `cut` in words,
  and BUSY explained ("the capacitor is at 3.0 V; the solenoid starts above 3.1 V").
- The Overview row's one control: TAP / BUZZ while still, STOP while running.

**D12. Fake.** `tools/fake-haptic.ts` on the fake stepper board (`dash-dev --stepper`), beside the motor and the
buzzer: `kick` and `buzz` timed at the fake board's tick with the service's rules (duty budget, on-time limit, the
beat kept on change, the accent, `done` and `cut`), and a fake LIC-H-0825 `cap` that drops 0.65 A × 0.6 Ω while
the solenoid is on, drains by I·t / 90 F and recharges at 1 A to 4.2 V. SIGUSR2 drains it to 3.0 V, to show BUSY and
`cut`.

## 8. Docs (D13)

- User manual: a new §24 "Haptics on stepper-c3": the wiring summary, the first run (§10), the commands and the
  panel, what BUSY and `cut` mean, troubleshooting.
- Spec 07: `fr.haptic` 1.1 in the capability list, `haptic_sdm` and the LEDC channel handover in the driver notes.
- AGENTS.md: the panel list gains `panels/haptic.tsx`, `dash-dev --stepper` gains the haptics.
- power-p1: a line under D6–D7 pointing here for 1.1, and the 1N4007 → 1N5819 note for PWM.

## 9. Tests and build

- **Host (fr_core, ASan + UBSan):** tap trains timed from their start; the beat kept on a changed tap; the count
  restarting; refusals (ms ≥ period, over the budget, over max_on); a solenoid's kick duty from `level`,
  `rated_mv` and the supply, and its hold; `done` for every way a program ends, exactly once; `done {hub_lost}`;
  (`haptic_sdm`'s density mapping: `static_assert`s in its header, D4).
- **Codegen:** `haptic_ledc` handed channel 5 on `c3s-stepper` and 3, 4 on `c6w-scale`; an overlap refused; the
  buzzer with two haptic frequencies refused; `sdm_channels` budgeted; `test_pin: none` lets `buzz` take GPIO0.
- **Protocol:** vectors and the catalog hash for `fr.haptic` 1.1.
- **Hub:** `haptic_tap` (hz rounding, the instance chosen, refusals passed through), the fake (vitest).
- **Dashboard:** the panel (vitest): the budget hint, the beat-keeping sends, the Overview control.
- **Builds:** `pnpm -s typecheck`, `pnpm -s fr gen --check` (0 stale), the firmware host tests, the ESP-IDF build of
  `c3s-stepper` for esp32c3, `pnpm -s test` (two known timing flakes pass alone).

## 10. Bring-up (the owner; flashing needs a go-ahead)

1. **Before power:** both AO3400 gates read 10 kΩ to GND; each diode's stripe goes to +; the LIC reads above 2.5 V on
   its own (below that, stop: it may be damaged). With a 1N4007 still across the solenoid, steps 6–7 stay at
   `level` 100 and `ms` ≤ 30, and the motor (step 5) is not wired yet (§0).
2. **Meter the motor:** its resistance (a current estimate, for the part file).
3. **Charger and sense, no loads:** USB in; OUT+ climbs to 4.2 V; GPIO3 reads half of OUT+.
4. **Flash** (go-ahead): `fr build --profile c3s-stepper`, flashed over USB as the buzzer was. `selftest`: both pads
   idle low, `cap` reading. `cap.mv` within 50 mV of the meter, else `cap.calibrate`.
5. **Motor:** `buzz.pulse {ms: 300, level: 30}`, then 60 and 100: felt, `done {done}`, `cap.mv` dips.
6. **Solenoid, single taps** (go-ahead for each step up): `kick.tap {ms: 15, level: 40}`, then raise `level` by 10
   until it strikes cleanly; then shorten `ms` to the shortest full stroke. Feel the AO3400 and the coil after 20
   taps: cool or barely warm.
7. **Trains:** `kick.tap {period_ms: 500, ms: 15, level: 70, count: 10}`, then 250, 125, 80, 50 ms: note the fastest
   rate at which every tap still strikes (the spring's return sets it). Then 30 s at 8 taps a second: the coil stays
   under 50 °C to the touch.
8. **Refusals:** a tap train over the budget answers INVALID_ARGS; a 2 s `kick.pulse` answers INVALID_ARGS
   (above `max_on_ms`).
9. **uriel** (go-ahead): update its hub so `fr send` and the panel reach the board.

## 11. Risks

- **USB current.** The TP4056 draws its charge current (1 A as sold, set by the module's 1.2 kΩ PROG resistor) from
  the board's 5V, beside the motor's 150 mA and the C3's Wi-Fi peaks: up to about 1.5 A from the USB port that feeds
  stepper-c3 (uriel's, *inferred*). The LIC only charges hard after it was drawn down, but a port that sags resets
  the board. If step 3 or 7 shows resets, swap the PROG resistor for 2.4 kΩ (about 0.5 A).
- **The LIC held at 4.2 V.** The TP4056 charges to 4.2 V and tops it up from about 4.05 V. That is the LIC-H-0825's
  maximum charge voltage, above its 4.0 V working top: allowed, but it ages the cell faster than 4.0 V would. No pin
  is left to stop the charger at 4.0 V; for a bench board that is accepted. Unplugged for weeks, the divider, the
  DW01 and the charger's leakage (a few µA) draw it down slowly; store it charged, not flat (the part's note).
- **The diodes.** Until Schottkys replace the 1N4007s, strength control and the motor wait (§0).
- **Tap timing** comes from the core task's timers: jitter of about a millisecond under Wi-Fi and the motor's work
  (*inferred*). At 25 taps a second that is 2–3 % of a period. Good enough for feel; a hardware timer is a follow-up
  if the bench shows worse.
- **The coil's real rating** is unknown. The duty budget is the protection; step 7's touch test is the check. If it
  runs hot, `cooldown_pct` goes down.
- **The fastest clean rate** is mechanical (the spring's return through 4 mm). The protocol allows 50 taps a second;
  the panel's slider stops at 25 until step 7 says more.
- **uriel's hub** runs code from before this work until updated (D10).

## 12. The owner's answers (2026-11-21)

1. The capacitor is a **LIC-H-0825** (90 F; its datasheet row is in §0 and the part `lic-h-0825`).
2. A **protected TP4056 module**: yes.
3. **Bare AO3400s and 1N4007s**: the AO3400s are soldered without adapters (§0); Schottkys are needed for PWM (§0).
4. Giving up the **T-LAT test pin** (GPIO0): yes.
5. **Named patterns and a metronome**: yes (D2's `accent`, D11). The motor is not locked to the metronome's beat:
   that needs the two instances tied in firmware, a follow-up if the solenoid's accent is not enough.

## 13. Tasks

- **T1** `fr.haptic` 1.1 in the schema; `HapticService` tap trains, solenoid level, `done`; host tests.
- **T2** `haptic_sdm` driver; `sdm_channels` on the boards.
- **T3** `haptic_ledc` `channel`; driver.yaml LEDC slots; codegen's handover and checks; tests.
- **T4** `c3s-stepper` instances, `test_pin: none`, slots.lock; `fr gen`.
- **T5** guide `stepper-c3` haptics section and drawing; part `solenoid-micro-3v`; `diode` and
  `solenoid-push-pull-mini` notes (no 1N4007 under PWM).
- **T6** hub `haptic_tap` op and `fr haptic tap`; tests.
- **T7** dashboard panel and words; tests.
- **T8** `tools/fake-haptic.ts` on `dash-dev --stepper`; tests.
- **T9** user manual §24, spec 07, AGENTS.md, power-p1 pointer.
- **T10** the checks of §9; then, with the owner's go-ahead, §10.
