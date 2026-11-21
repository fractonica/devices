# BUZZER-1: a passive buzzer as a shared component, first on the stepper's ESP32-C3 Super Mini

> **As built, 2026-11-21** (T1–T7 of §12; approved by the owner the same day; not committed).
>
> **On the bench, 2026-11-21:** with the owner's go-aheads, stepper-c3 was flashed over USB from the lab hub (plan app,
> build `node/c3s-stepper/debug/eab2ee08b785`). The module was wired S to GPIO4 and − to GND, not metered, so the test
> stayed short, at volume 30 or less except one 120 ms beep at 100. It boots with
> `ledc_buzzer: GPIO4 on LEDC channel 4 (timer 2)` beside the motor's timer 0 and channels 0–3.
>
> Sent with `fr diag <port> call buzzer.*`, because uriel, which holds the board, runs hub code from before
> `fr.buzzer`: one beep, a 2 kHz tone, a sweep of seven tones from 1 to 4 kHz, beeps at volume 10, 50 and 100, and the
> rising chime. Each answered OK, and each ended with `done {done}` (4 beeps, 8 tones, 1 melody; read at uriel by port
> number). A 50 Hz tone answered INVALID_ARGS. Selftest before and after: all four instruments ok, the buzzer pad idle.
> The owner heard it beep. The loudest pitch of the sweep is still to be picked for `beep_hz` (default 2000). The motor
> was not moved during the test.
>
> **Where it is:**
> - the capability `schema/capabilities/buzzer.cap.yaml` (0x0013, registry row);
> - `hal::ToneOutput` (`fr_core/include/fr/hal/tone.hpp`) and `BuzzerService` (`fr/services/buzzer_service.hpp`,
>   `src/services/buzzer_service.cpp`);
> - the driver `hardware/drivers/ledc_buzzer`;
> - codegen's `fr.buzzer` SERVICES entry, its `beep_hz` check and `ONE_PER_FIRMWARE` (`packages/codegen/src/board.ts`);
> - `c3s-stepper`'s `buzzer` on gpio.4 (`slots.lock` buzzer 4);
> - the guide `stepper-c3` (covers `[motor, buzzer]`, a buzzer section, the drawing), the part `passive-buzzer-module`;
> - the dashboard's words, `state/buzzer.ts` and `panels/buzzer.tsx`;
> - `tools/fake-buzzer.ts` on the fake stepper board (`dash-dev --stepper`);
> - the user manual's §23, spec 07's capability list and driver note, AGENTS.md.
>
> **Checks (2026-11-21):**
> - `pnpm fr gen --check`: 0 stale. `pnpm typecheck`: clean.
> - Vitest: 3,150 of 3,151 in each full run. The one left over was a known timing test that fails under the parallel
>   load and passes alone (stepper-s1's two: cli's `fr serial idf` lease once, hub's `display_snapshot` bounds once).
>   New: `services_buzzer` (host), `fake-buzzer` (hub, 10), `buzzer-panel` (dashboard, 10), BUZZER-1 in codegen's
>   `board.test.ts` (6) and the guide's buzzer test. The catalog hash is now 0xf3b9dd7e.
> - The host C++ suite: 1,084 passed (ASan + UBSan), 21 of them the buzzer's.
> - The ESP-IDF v6.1 build of `c3s-stepper` for esp32c3 (debug) links with no compiler warning: image 0x1497c0, 31 %
>   of the app slot free. The lab hub built the same image (`fr build --profile c3s-stepper`).
> - The panel on `dash-dev --stepper`: the chime and KEEP BEEPING played on the fake, and STOP from the Overview row
>   worked. The guide's drawing showed the buzzer, with no console error.
>
> **Where it departs from the text below:**
> - **Beep (D2):** the last beep's pause is not played: `done` comes at the last beep's end ("pauses between beeps").
>   The service marks a beep's last pass with `trim_tail_`; a melody keeps its last gap, so its length is the sum of
>   its notes.
> - **Driver (D4):** a `static_assert` keeps `LEDC_CHANNEL_MAX` at 6 or more. The timer starts at 1 kHz with duty 0
>   (`kInitHz`).
> - **Dashboard (D9):** the Buzzer block has three beeps (once, three, until stop), four tunes in the sixth octave
>   (1–2.8 kHz, nearer a magnetic buzzer's resonance than the fifth) and STOP. The generic Actions keep tone, beep and
>   melody as forms for one's own sounds. Volume is the generic Readings' slider, since `volume` links to `set_volume`
>   by name. The Overview's one control is BEEP while quiet and STOP while playing.
> - **Fake (D10):** `BuzzerSim` is checked at the fake board's 20 ms tick, so its `done` comes up to one tick late.
>   It sits on port 4 of the fake stepper board, beside the motor.
> - **Bring-up (§10):** a hub running code from before this work delivers the buzzer's events by port number and
>   answers its commands `not_found`. Until uriel's hub has this code, `fr send stepper-c3 buzzer.*` does not reach
>   the board while uriel holds it. `fr diag <port> call buzzer.beep` over its USB works with any hub: the node
>   decodes the JSON itself (`diag_json.cpp`).

> **Draft, 2026-11-21.** Asked for: "add a piezo buzzer to Fractonica devices as a shared component: one capability
> and one driver that any board profile can include, the way the stepper was added". This document designs it.
> Decisions here are proposals the owner can overturn. Anything marked *inferred* was not read in a datasheet, in
> code or on the bench.
>
> Fixed by the owner (2026-11-21):
> - the part is a **passive buzzer module with three pins, S / + / −, and no transistor** (KY-006 style): it needs a
>   frequency from the board, and the buzzer hangs straight off S, active high;
> - it goes on **stepper-c3** (ESP32-C3 Super Mini, profile `c3s-stepper`), **GPIO4**; GPIO3 stays free;
> - it plays **beep patterns, tones and short melodies**;
> - it is a **new capability, `fr.buzzer`**, not `fr.audio_out`, `fr.haptic` or `fr.led`;
> - no fleet-wide hub op or `fr beep` command: the generic `fr send` / `fr wait event` path drives it, as for the
>   stepper;
> - nothing in this work flashes a board, opens a serial port or restarts the hub on port 7420 without the owner's
>   go-ahead, asked for each action.

## 0. The parts

- **The module** (KY-006 style, not photographed): a small buzzer on a three-pin header.
  - S is the signal, − is GND. On most KY-006 boards **+ is not connected** to anything (*inferred*); §10 step 1
    checks it with a meter before anything is wired.
  - The buzzer itself is one of two kinds, and the board cannot tell them apart:
    - a **piezo disc**: capacitive, reads open on an ohmmeter, a few mA from a GPIO at most;
    - a **magnetic (electromagnetic) buzzer**: a coil of about 16–42 Ω (*inferred*, typical 12 mm parts), loudest
      near its resonance of about 2–2.7 kHz (*inferred*).
  - A magnetic coil straight on a GPIO draws more than the pin should give: 3.3 V across 16 Ω plus the pin's own
    output resistance is well above the C3's 20 mA default drive (*inferred*; the coil's inductance lowers it at a few
    kHz). §10 step 1 measures it; a coil under 100 Ω gets a **100 Ω resistor in series with S** (about 28 mA peak at
    most, quieter but inside the pin's rating).
- **The board:** the ESP32-C3 Super Mini of `c3s-stepper` (design stepper-s1 §0). GPIO4 is on the left header
  between 3V3 and GPIO3. It is not a strapping pin. The motor holds LEDC timer 0 and channels 0–3. Timers 1–3 and
  channels 4–5 are free.
- **LEDC on IDF v6.1** (read in `esp_driver_ledc/src/ledc.c`):
  - the low-speed timers of the C3, C6 and S3 share one clock source. `LEDC_AUTO_CLK` tries the sources in order
    (APB or PLL 80 MHz first) and takes the first that reaches the frequency. A timer that would need another source
    than one already in use fails with "timer clock conflict";
  - at 10 bits the 80 MHz source reaches 77 Hz to 78 kHz. Every pitch from 100 Hz to 20 kHz therefore stays on the
    clock the stepper already uses;
  - `ledc_set_freq` keeps the timer's source and resolution and changes only its divider, so the duty, counted in
    steps, keeps its proportion.

## 1. Scope

**In:**
- a capability **`fr.buzzer`** (D1–D2);
- an L1 contract `hal::ToneOutput` (D3);
- a driver **`ledc_buzzer`**: a square wave from one LEDC channel at the note's pitch, with volume set by the duty
  (D4);
- a service `BuzzerService`: sounds timed to the microsecond from their start, replacement, stop, volume, hub silence
  and events (D5–D6);
- codegen's `fr.buzzer` SERVICES entry (D7);
- `c3s-stepper` gains the instance `buzzer` on GPIO4. The guide `stepper-c3` gains a buzzer section, and a new part,
  `passive-buzzer-module`, is added (D8);
- the dashboard's words and a buzzer panel (D9);
- a fake buzzer on the fake stepper board (`dash-dev --stepper`), and the user manual's §23 (D10);
- host tests and the ESP-IDF build (§9);
- the bring-up for the owner (§10).

**Out:**
- an **active** buzzer (fixed pitch, on/off). The capability is ready for one (trait `pitched` false), but its driver
  (a plain GPIO switch) waits until there is such a part;
- PCM, WAV or tunes from the hub: that is `fr.audio_out`;
- tune text formats such as RTTTL or note names on the wire: the wire carries pitches and lengths;
- sounds the node starts by itself (a boot chirp, a click on a button press): only commands start a sound;
- a fleet op (`buzzer_beep` over a selector) and `fr beep`: declined by the owner for now. They can come later as
  their own ops without changing the capability;
- a shared LEDC allocator for every driver (D4 says why it would be good; it is a follow-up).

## 2. The capability `fr.buzzer` (D1–D2)

**D1. One capability for a buzzer, id 0x0013**, version 1.0, `schema/capabilities/buzzer.cap.yaml`.

- **Why 0x0013:** 0x0011 stays held for `fr.host` (design uno-q-host), and 0x0012 is `fr.stepper`.
- **Why not `fr.audio_out`:** it is built around PCM. Its config `sample_hz`, its traits `max_sample_hz` and `bits`,
  and its command `play` (PCM pulled from the hub over HTTP) mean nothing for a buzzer, which would answer half the
  capability with UNSUPPORTED. Its `tone` is a sine. A buzzer plays a square wave and also needs patterns and
  melodies.
- **Why not `fr.haptic`:** its patterns fit an active buzzer, but it has no pitch. It is also built around a load's
  supply: its compensation, its BUSY at a critical cell and its cut-offs are wrong for a buzzer.
- **Why not `fr.led`:** a light. Its `blink` is the model for `beep` below.

**D2. Members.**

```yaml
types:
  Sound:      { enum: { tone: 0, beep: 1, melody: 2 } }
  DoneReason: { enum: { done: 0, stopped: 1, replaced: 2, hub_lost: 3, error: 4 } }
traits:
  pitched: { id: 1, type: bool, default: true }   # plays the pitch asked; false: a fixed-pitch (active) buzzer
  volume:  { id: 2, type: bool, default: false }  # loudness can be set (the duty of a passive buzzer)
  min_hz:  { id: 3, type: u16 }                   # the lowest pitch it plays (ledc_buzzer: 100)
  max_hz:  { id: 4, type: u16 }                   # the highest (ledc_buzzer: 20000)
config:
  volume:  { type: u8,  default: 50, range: [0, 100], unit: "%", doc: "volume at boot" }
  beep_hz: { type: u16, default: 2000, range: [20, 20000], unit: Hz, doc: "the pitch of a beep that names none; a magnetic buzzer is loudest near its resonance" }
properties:
  playing: { id: 1, type: bool }
  volume:  { id: 2, type: u8, unit: "%" }
events:
  done: { id: 1, fields: { sound: Sound, reason: DoneReason } }
commands:
  tone:       { id: 1, fields: { freq_hz: u16 [20, 20000] Hz, ms: u16 = 500 [1, 60000] ms, volume?: u8 [0, 100] % } }
  beep:       { id: 2, fields: { count: u16 = 1 [0, 1000], on_ms: u16 = 100 [10, 10000], off_ms: u16 = 100 [10, 10000],
                                 freq_hz?: u16 [20, 20000] Hz, volume?: u8 } }
  melody:     { id: 3, fields: { freq_hz: array<u16> max 32, ms: array<u16> max 32, gap_ms: u8 = 10 [0, 100],
                                 repeat: u8 = 1 [0, 100], volume?: u8 } }
  stop:       { id: 4, idempotent: true }
  set_volume: { id: 5, idempotent: true, fields: { volume: u8 [0, 100] % } }
```

All commands use reliable delivery. The rules:
- **One sound at a time.** A `tone`, `beep` or `melody` replaces whatever plays, and the sound it replaced ends with
  `done {replaced}`. `stop` ends it with `done {stopped}`, and answers OK when nothing plays.
- **A command answers when its sound starts.** `done` reports how the sound ended. `playing` is true from the start
  to the end.
- **`beep`** works like `fr.led`'s `blink`: `count` beeps of `on_ms` with `off_ms` between them, at `freq_hz` or else
  config `beep_hz`. `count` 0 beeps until `stop`. A beep pattern that is not even (long, short, short) is a `melody`
  at one pitch.
- **`melody`** takes up to 32 notes as two lists of the same length: pitch (0 is a rest) and length. `gap_ms` of
  silence ends each note, inside its length and at most half of it, so two equal notes in a row sound as two notes.
  `repeat` 0 plays until `stop`. The worst case is about 210 B, over the 200 B realtime budget but inside one 250 B
  frame. The hub sends a command as BULK by itself when it does not fit (`router/index.ts`).
- **INVALID_ARGS** for: a pitch outside the traits' `min_hz`–`max_hz` (a rest excepted); a melody with no notes, with
  lists of different lengths, or with a note of 0 ms.
- **Volume.** A command's own `volume` holds for that sound only. `set_volume` changes `volume` at once for what
  plays and for what plays later; it is not kept across a reboot (config `volume` is the boot value). Volume 0 plays
  silence: the timing runs, and `done` still says `done`. A buzzer whose trait `volume` is false plays every volume
  above 0 at full loudness.
- **A buzzer that is not pitched** (trait `pitched` false) sounds at its own pitch for every note other than a rest.
- **Hub silence** (as `fr.haptic`): a sound started while a hub session existed ends with `done {hub_lost}` 10 s
  after that hub's newest frame, or at once on a WELCOME from another hub run. Nothing beeps "until stop" with
  nobody left to stop it. A sound started without a hub session (a local app) runs to its end.
- **`done {error}`**: the driver refused a write mid-sound. The output is silenced.

The capability's own `doc:` says all of the above, briefly.

## 3. The L1 contract `hal::ToneOutput` (D3)

`firmware/components/fr_core/include/fr/hal/tone.hpp`:

```cpp
class ToneOutput {
public:
    /** The pin claimed and driven silent. Board init. */
    virtual Status init(Core &core) = 0;
    /** A square wave at freq_hz with the given duty (permille, 0-500; 0 is silent). Core task, well under 1 ms. */
    virtual Status play(uint16_t freq_hz, uint16_t duty_permille) = 0;
    /** Silent now (the pad at its idle level). */
    virtual Status silence() = 0;
    virtual bool pitched() const = 0;
    virtual uint16_t min_hz() const = 0;
    virtual uint16_t max_hz() const = 0;
    virtual Selftest selftest() = 0;
};
```

**The service owns volume.** The loudness of a buzzer driven by a square wave follows the wave's fundamental, whose
amplitude is proportional to sin(π·duty). The service therefore maps volume v (0–100) to
`duty = asin(v / 100) / π`: 100 is 500 ‰ (a 50 % square, the loudest), 50 is 167 ‰ (half the amplitude, −6 dB),
10 is 32 ‰, 1 is 3 ‰. In other words, volume is linear in amplitude. `duty_for_volume()` is a pure function, tested
on the host.

## 4. The driver `ledc_buzzer` (D4)

`hardware/drivers/ledc_buzzer/` (driver.yaml, CMakeLists.txt, include, src), modelled on `haptic_ledc`:

- `implements: hal.ToneOutput`, `binds: gpio`, `bind: gpio.<n>` (one pin from the board's `pins.free`), targets
  esp32c3, esp32c6, esp32c5, esp32s3.
- Config: `out` (from the bind, an output) and `active_low` (default false; true for a module that switches the
  buzzer through a PNP, which idles high: LEDC's `output_invert` and an idle level of high).
- LEDC low-speed **timer 2** and **channel `LEDC_CHANNEL_MAX − 2`** (4 on the C3, C5 and C6; 6 on the S3), 10-bit
  duty, `LEDC_AUTO_CLK`. Traits: `{ pitched: true, volume: true, min_hz: 100, max_hz: 20000 }`.
  - These slots stay clear of `drv8833_stepper` (timer 0, channels 0–3), `dvp_camera` (timer 0, channel 0),
    `st7789_spi` (timer 3, the top channel) and `fixture_gpio` (timer 0, channels from 0 up). They also stay clear
    of one `haptic_ledc` frequency (timer 1, channels from `MAX/2` up).
  - Never put it in one profile with two `haptic_ledc` instances on a six-channel chip (their second channel is 4),
    or with two `haptic_ledc` frequencies (timer 2). driver.yaml says so, as the others do.
  - The real fix for this whole family is one allocator for LEDC timers and channels that every driver asks. That is
    a follow-up, not this work.
- `init`: the pad is driven to its idle level before LEDC takes it; restart and panic hooks
  (`platform::register_safe_off`) drive it idle with register writes, because a CPU reset keeps LEDC running and
  the tone would otherwise last through a panic, the coredump and the boot. The timer is configured at `beep_hz`'s
  neighbourhood (1 kHz) with duty 0. A second instance on one node is refused (`Err::busy`).
- `play(hz, duty)`: `ledc_set_freq` only when the pitch changes, then `ledc_set_duty` + `ledc_update_duty`. The
  divider change can cut one period short: at most a click, not audible over the new note (*inferred*). `silence()`
  sets duty 0 (the pad rests at its idle level; LEDC keeps running).
- `selftest`: when silent, the pad must read its idle level; a playing pad is not checked.
- `resources: { gpio: 1, ledc_channels: 1, ledc_timers: 1 }`. No sdkconfig, no ISR, no task.

## 5. The service `BuzzerService` (D5–D6)

**D5. Timing.** Everything runs on the core task, with one fr_core timer. A sound is a list of steps (pitch,
duty, length):
- a tone is one step;
- a beep is on, off, …;
- a melody note is its sound, then its gap.

Each step's end is computed from the sound's start (start + the sum of the lengths so far), so a melody of 32 notes
does not drift by the timers' latency. The timer is armed for the next step's end or 1 s, whichever comes first; the
1 s wake checks hub silence during a long note. On a fire the service catches up to `now` (a late fire skips no
step's write; it shortens the next one). Steps of the same pitch and duty in a row do not rewrite the driver. Repeats
(`count`, `repeat`) loop over the list without copying it.

**D6. The rest.**
- `cap::Buzzer` comes from codegen. The service holds the program (at most 64 steps: 32 notes with their gaps), the
  volume and the hub session it was started under. Like `HapticService`, it reads `core::link_info()` for hub
  silence.
- `init` initialises the driver first, so the pad is silent before anything else can fail. Config is checked:
  `beep_hz` must fall within the driver's range, or init fails with `invalid_args`, which codegen also refuses at
  build time.
- The traits come from the driver (`pitched()`, `min_hz()`, `max_hz()`, plus `volume` from driver.yaml).
- No settings in NVS, nothing kept across reboots.

## 6. Codegen, profile, guide (D7–D8)

**D7.** `packages/codegen/src/board.ts` SERVICES:
`'fr.buzzer': { implements: 'hal.ToneOutput', service: 'fr::BuzzerService', header: 'fr/services/buzzer_service.hpp',
timers: 1, traits from driver.yaml }`. A profile check refuses `beep_hz` outside the driver's `min_hz`–`max_hz`, and
more than one `ledc_buzzer` instance.

**D8.**
- `firmware/profiles/c3s-stepper.profile.yaml` gains
  `buzzer: { cap: fr.buzzer, driver: ledc_buzzer, bind: gpio.4 }`, and `slots.lock` gains `buzzer: 4`.
- The guide `hardware/wiring/stepper-c3`:
  - `covers: [motor, buzzer]`;
  - a bom row for the new part `hardware/parts/passive-buzzer-module.part.yaml`, plus an optional 100 Ω resistor;
  - the connections gpio.4 → S (through the resistor for a magnetic buzzer) and GND → −;
  - a section "Buzzer" with §10's steps 1–4;
  - the module drawn on `map.svg` beside GPIO4.

## 7. Dashboard (D9)

- `state/cap-words.ts`: the members (`freq_hz` "pitch", `ms` "for", `on_ms` "on", `off_ms` "off", `gap_ms` "gap",
  `beep_hz` "beep pitch", …) and the commands' verbs (beep, play a tone, play a melody, stop, set volume).
- `panels/buzzer.tsx` (+ `.css`), registered in `pages/device/panels.ts`, drawn like the stepper panel:
  - the headline: quiet, or beeping / playing a tone / playing a melody;
  - Quick: Beep, Stop;
  - the lens: a Beep block (count, on, off), a Tone block (pitch, length), a Melody block with a few tunes kept as
    data in `state/buzzer.ts` (rising chime, falling chime, alert, scale), the volume as light on a hairline, and the
    last `done`;
  - pitch reads as cycles per Blink in pure mode (the core's pB) and adds ⊕ Hz in Earth mode, as every rate does
    (`device-units.ts`); lengths are spans.
- Tests: `test/buzzer-panel.test.ts` and the design-rules test as it stands.

## 8. Fake board and manual (D10)

- `tools/fake-buzzer.ts`: the buzzer's rules on the fake stepper board (`dash-dev --stepper`, which fakes
  `c3s-stepper`), in time:
  - `playing` set and cleared;
  - `done` with its reason;
  - replacement, stop and hub silence;
  - the same INVALID_ARGS as the service.

  A hub test drives it through a scratch hub (`packages/hub/test/fake-buzzer.test.ts`, as `fake-stepper.test.ts`).
- `docs/user-manual.md` §23 "Buzzer": wiring, the first run (§10), the commands with `fr send` examples, what `done`
  says, and troubleshooting (silent: + vs S, a magnetic coil without its resistor, volume 0; quiet: off resonance,
  where a pitch sweep finds the loudest).
- `docs/spec/07-capabilities-sdk.md`: `fr.buzzer` in the capability list. `AGENTS.md`: `--stepper` now includes the
  buzzer.

## 9. Tests and build

- **Host C++** (`firmware/test/host/tests/services_buzzer_test.cpp`, with a fake `ToneOutput` and FakeCore):
  - `duty_for_volume`;
  - a tone's start and end;
  - a beep's edges at the exact microseconds;
  - a 32-note melody's schedule with no drift, including after a late fire;
  - the gap rule (half a note at most);
  - repeat and count 0;
  - replacement and stop, and their `done` reasons;
  - `set_volume` mid-sound;
  - volume 0;
  - INVALID_ARGS;
  - hub silence and a new hub run;
  - a driver error;
  - the unpitched rule.
- **Codegen:** the driver, the profile, the SERVICES entry and the D7 checks (`board.test.ts`); `pnpm fr gen`;
  `--check` 0 stale.
- **TypeScript:** `pnpm typecheck`; vitest per package (protocol, codegen, sdk, hub with the fake buzzer test,
  dashboard with the panel test).
- **ESP-IDF v6.1:** the `c3s-stepper` build for esp32c3 (AGENTS.md §3's command, debug) links with no new warning.
  The map shows `ledc_buzzer` on timer 2 and channel 4 beside the motor's timer 0 and channels 0–3.

## 10. Bring-up (the owner; flashing needs a go-ahead)

1. **Meter, module off the board.** Ω between S and −: open means a piezo; 10–50 Ω means a magnetic coil, so fit
   100 Ω in series with S. Ω between + and S, and between + and −: open on both means + is not connected; leave it
   free.
2. **Wire, USB unplugged.** S → GPIO4 (through the resistor when step 1 found a coil), − → GND, + free.
3. **Firmware.** Rebuild `c3s-stepper` on the lab hub (`fr build --profile c3s-stepper`). Then, with a go-ahead, OTA
   or flash stepper-c3. The hub that holds the board must know `fr.buzzer`: the lab hub needs a restart (go-ahead),
   and uriel needs the new code if the board is there.
4. **First sounds.**
   - `fr send stepper-c3 buzzer.beep` gives one short beep;
   - `fr send stepper-c3 buzzer.tone '{"freq_hz": 2000, "ms": 1000}'`;
   - a sweep from 1000 to 4000 Hz in steps of 250 finds the loudest pitch, which becomes `beep_hz` in the profile;
   - `buzzer.set_volume` at 10, 50 and 100;
   - `buzzer.melody '{"freq_hz": [523, 659, 784, 1047], "ms": [150, 150, 150, 400]}'` plays a rising chime;
   - `fr events stepper-c3 --types 'buzzer.*'` shows each `buzzer.done`;
   - the motor still runs while the buzzer plays (`motor.move_by`).

## 11. Risks

- **Direct GPIO drive of a magnetic coil** (§0): the series resistor of §10 step 1 is the answer. The default drive
  strength is kept.
- **LEDC slots** (D4): fixed per driver and checked only by the comments, as for every LEDC driver today. The
  combinations this layout refuses are named in driver.yaml.
- **One buzzer per node** (one timer). A second instance is refused at init and by codegen.
- **Frequency accuracy:** the fractional divider gives the right average pitch with a little jitter (*inferred*,
  inaudible).

## 12. Tasks

1. T1: the capability, the registry row and `pnpm fr gen`.
2. T2: `hal::ToneOutput`, `BuzzerService` and the host tests.
3. T3: the driver `ledc_buzzer` and codegen's SERVICES entry and checks.
4. T4: the profile, the slots, the guide and the part; the ESP-IDF build.
5. T5: the fake buzzer and the hub test.
6. T6: the dashboard's words, panel and test.
7. T7: the manual's §23, spec 07 and AGENTS.md.
8. T8: the full checks; then, with go-aheads, §10 on the bench.
