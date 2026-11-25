# EPAPER-1: a 4.2-inch e-paper panel under `fr.display`, on an ESP32-C6 Super Mini

> **As built and on the bench, 2026-11-24** (approved by the owner the same day, §13; flashed and measured with the
> owner's go-ahead the same day, §10; nothing committed). The board is the owner's former `pad-c6` (an ESP32-C6 Super
> Mini), now `paper-c6`; the lab hub was restarted on this code (go-ahead). Bench in short: the controller answers as
> an SSD1683 and the picture is upright; full 3.33 s, fast 1.70 s, partial 0.362 s (0.403 s with the high voltage
> turned off after each one); traces stayed very faint up to 60 partials and a fast clean removed them, so the profile
> cleans with a fast refresh every 60 partials. Where the build differs from the proposal below, the text says so; the
> list:
> - **`hal::Epaper` is the driver's contract** (D5): `ssd1683_spi` says `implements: hal.Epaper`, and codegen lets
>   `fr.display` take a driver of a contract derived from `hal.Display` (`ServiceFacts.alsoImplements`).
> - **The driver's `init` touches no controller** (D5): it sets the pins, the bus and the BUSY interrupt; the backend
>   resets and configures the controller right after boot, asynchronously, on its timer (RST low 2 ms, 10 ms, `0x12`,
>   BUSY's fall, the set-up). Until then the selftest says "not reset yet". No blocking wait on the core task anywhere.
> - **A failed refresh postpones the 24 h clean** (D3): found by the host tests, where a dead panel retried the due
>   clean every half second.
> - **Four hub ops, at the end of the registry** (D9): `display_image`, `display_html`, `display_text` (the design's
>   `fr display text`) and `display_refresh` (an op rather than `command_send`, so it waits for `refreshed`). Pictures
>   that are not PNG are drawn by Chrome straight at the panel's size with the same fit (CSS `object-fit`).
>   `CHROME=none` turns Chrome off. After a refresh the op waits up to 1 s for the node's `shown_crc` to reach the
>   hub's mirror, so the next picture is sent as a difference.
> - **The desktop renderer draws e-paper profiles** (D12, `--epaper 1`), with today's script commands: adding `bitmap`
>   and `refresh` lines would change `display_render`'s input, which the rules forbid for an existing op.
> - **The dashboard** (D10) also stops offering `ui_load` and `ui_set` on panels without LVGL.
>
> **Checks:** `pnpm -s typecheck` clean; `pnpm -s fr gen --check` 0 stale; host C++ suite 1,121 passed (19 new
> `EpaperBackend` tests against a fake controller whose glass changes as a real one's, 6 for `ssd1683_spi` against the
> SPI shim, the whole stack from boot to `refreshed`); `c6e-paper` builds for esp32c6 (debug: 1,498,208 B, 24 % of the
> app slot free; static DIRAM 310,651 of 452,112 B; release: 1,288,608 B, 34 % free, DIRAM 290,927 B, once a separate fix to `fr_net`'s `bench.cpp` cleared a GCC 15 array-bounds error that stopped every C6 release build); vitest 3,299 of 3,305 in one full run, the six load-sensitive ones passing alone. On the Mac, the scratch hub's fake
> `paper-c6` took `display_text` through a real Chrome to a full refresh, shown on the dashboard's e-paper block.
>
> Asked for: add an e-paper display to the framework "as a robust shared
> component, the way `fr.stepper`, `fr.buzzer` and `fr.haptic` were added", with partial updates as fast as the
> panel allows, anything rendered on it (images, text, HTML), and later a Fractonica clock face as its default
> screen. Decisions here are proposals the owner can overturn. Anything marked *inferred* was not read in a
> datasheet, in code or on the bench.
>
> Fixed by the owner (2026-11-24):
> - the panel: a **Waveshare 4.2inch e-Paper Module V2, Rev2.2** (400 × 300, black and white, 8-pin header);
> - its **BS resistor is at 0** (4-line SPI, as shipped);
> - the board: a **spare ESP32-C6 Super Mini**, a new profile just for the panel;
> - **the panel first, the clock face in the next round** (§11 says how it will plug in);
> - nothing in this work flashes a board, opens a serial port or starts or restarts a hub (the lab hub on 7420,
>   uriel) without the owner's go-ahead, asked for each action.

## 0. The panel: what is read and what is inferred

Sources: Waveshare's V2 manual (`files.waveshare.com/upload/9/97/4.2-inch-e-Paper-V2-user-manual.pdf`), its Chinese
wiki page (`waveshare.net/wiki/4.2inch_e-Paper_Module_Manual`; the English one refused automated reads), its schematic,
its C, Arduino and Python code (`github.com/waveshareteam/e-Paper`, `EPD_4in2_V2.*`), the SSD1683 datasheet (Rev
1.0), Good Display's GDEY042T81 page, GxEPD2's `GxEPD2_420_GDEY042T81` driver, ESPHome's SSD1683 driver, and the
Fastwave e-ink project.

| Fact | Value | How we know |
|---|---|---|
| Controller | **SSD1683** | *inferred*, strongly: Waveshare's V2 manual never names it, but its LUT block is the SSD1683's 233-byte layout, its RAM window limits (X 0x00–0x31) and 400 × 300 match, and the same glass (identical power figures) is Good Display's GDEY042T81, which is an SSD1683. A forum user runs GxEPD2's GDEY042T81 driver on a "Waveshare 4.2 V2.2". The first full refresh on the bench confirms it (§10). |
| Size | 400 × 300, landscape native, 1 bit per pixel | read (manual) |
| Full refresh | **3 s** (Waveshare), 2 s (Good Display) | read |
| Fast refresh | **1.5 s or 1 s**: the full-screen waveform the controller picks for 110 °C or 90 °C, by writing that temperature into register 0x1A | read (manual, code) |
| Partial refresh | **0.42 s** (Waveshare), 0.3 s (Good Display), 0.4 s (GxEPD2's constant) | read |
| Partials before a full refresh | **5**, says both vendors ("after several partial refreshes, do a full one"; Waveshare's FAQ: after 5 when several areas change) | read; how many *this* glass takes is §10's ghost test |
| Other care | refresh at least once every 24 h; don't leave the panel powered (high voltage) when idle; store it white; 0–50 °C | read (wiki, manual) |
| Old image | in partial mode the controller compares RAM 0x24 (new) with 0x26 (old). The datasheet never says the chip copies new into old after an update; GxEPD2 and ESPHome write 0x26 themselves | read; so our driver manages 0x26 itself (D5) |
| RAM X address | in units of 8 pixels (a byte) | read (datasheet). Waveshare's C partial sets the X cursor without dividing by 8, a bug the Arduino version fixes: our windows are byte-aligned and the cursor is in bytes |
| SPI | write clock at most **20 MHz**; reads 2.5 MHz (unused: the module has no MISO) | read (datasheet) |
| BUSY | high while busy; stays high in deep sleep, where only a hardware reset wakes the chip | read |
| Deep sleep | `0x10 0x01` keeps the RAM (3 µA), `0x10 0x11` loses it (1 µA) | read |
| Reset | the module's RST also drives its power switch (an SI2301 behind an RT9193 regulator and a TXB0108 level shifter); a short pulse (2 ms) is the advice | read (schematic: *inferred* reading of it), GxEPD2's README |
| Supply | 3.3 V or 5 V on VCC, logic at the same level; 5.6 mA typical while refreshing, 2 µA asleep | read |
| BUSY pull | none on the module (the TXB0108 drives it) | *inferred* from the schematic |

**What "partial" means on this panel.** A partial refresh runs the controller's built-in partial waveform over the
whole glass, but only pixels whose old and new values differ are driven; the others get a "no change" waveform and do
not flash. So the time of a partial (about 0.4 s) does not depend on the area. Sending only the changed rectangle
saves SPI and link time (milliseconds), and keeping unchanged pixels unchanged is what keeps them from ghosting.

**Faster than 0.4 s** needs a custom waveform (the controller's LUT register, 227 bytes). Fastwave reports 48–89 ms
per update on a larger SSD1683 panel (against 336 ms built in), at the cost of contrast, grey trails that need
periodic scrubbing, and a burn-in warning; nobody reports it on this 4.2" glass. **Not in this round** (D4); the
built-in waveform with the high voltage kept on between close partials is the fastest safe mode (D4).

## 1. Scope

**In:**
- **`fr.display` 1.3** (additive): an `epaper` trait, `bitmap`, `refresh` and `hold` commands, a `refreshed`
  event, refresh properties, and the e-paper config (D2–D3).
- The driver **`ssd1683_spi`** and a small HAL addition, `hal::Epaper` (D5).
- **`EpaperBackend`** in `fr_core`: the 1-bit frame, the refresh policy, the ghost budget, all host-tested; the 1-bit
  drawing shared with `MonoBackend` (which also gains `bitmap`) (D6).
- Profile **`c6e-paper`** on `esp32c6-supermini`, device alias proposed **`paper-c6`** (D7).
- Wiring guide **`epaper-c6`**, parts `waveshare-epd42-v2` and `esp32c6-supermini-board` (D8).
- Hub ops **`display_image`** and **`display_html`**, CLI `fr display image|html|text|refresh` (D9).
- The dashboard's display panel for e-paper (D10), the fake `paper-c6` on `dash-dev --epaper` (D11), the desktop
  renderer for the new panel (D12), docs (D13), tests (§9).

**Out (this round):** the clock face (`fr.face`, next round, §11); custom waveforms (D4); 4-grey mode; `bitmap` on
LVGL panels (they answer UNSUPPORTED; a follow-up); reading the panel's temperature (no MISO).

## 2. Where rendering happens (D1)

**The node draws primitives; the hub draws everything else and sends pixels.**

- **On the node:** `clear`, `text` (the built-in 5 × 7 font, sizes 1–4), `fill_rect`, and the new `bitmap` (a
  rectangle of 1-bit pixels), into a 1-bit frame the node keeps. The node alone decides when and how the glass
  refreshes (D3), because only it knows what the glass shows and when the panel is free.
- **On the hub:** images (PNG on any hub; JPEG, GIF, WebP and SVG where the hub machine has Chrome), HTML pages and
  text in any font (through a headless Chrome on the hub machine), scaled to the panel, turned into 1-bit pixels, and
  compared with what the node already has: only the changed rectangles go to the node, then one `refresh`.
- **Next round, on the node:** the clock face, drawn by the clock's own UI library and the core.

**Why:**
- The node cannot run a browser, decode every image format, or hold real fonts: the C6 has 512 KB of RAM and a 4 MB
  flash. The hub machine (a Mac, a Raspberry Pi, the UNO Q) can, and the repo already drives Chrome with no
  dependency (`tools/chrome.mjs`).
- Pixels are exact: the PNG the hub keeps of what it sent is what the glass shows.
- The link is not the bottleneck. A whole frame is 15,000 B, about 13 BULK frames; a typical change is a few hundred
  bytes. The panel's 0.4 s partial is the bottleneck.
- A clock must keep ticking when the hub is away, and e-paper keeps showing a stale time without complaint, so the
  face draws on the node (§11).

## 3. The capability: `fr.display` 1.3 (D2–D3)

**D2. Not a new capability, not just a new driver: a minor version.** An e-paper panel is a pixel panel: `clear`,
`text`, `fill_rect`, `snapshot` and the dashboard's display card all apply as they are. A new driver alone cannot
express what it needs on top: pixels from the hub, control over when the glass changes, and news of each refresh. A
separate capability would duplicate the commands, the hub's display ops and the dashboard card. Every change below is
additive (07 §7.3), so a 1.2 firmware keeps working with a 1.3 hub, and the other panels change only in gaining
`bitmap` (mono) or answering it UNSUPPORTED (LVGL).

What 1.3 adds (`schema/capabilities/display.cap.yaml`):

- **Type** `RefreshMode { auto: 0, partial: 1, fast: 2, full: 3 }`.
- **Trait** `epaper` (id 7, bool): the panel keeps its image without power and changes it by refreshes. From the
  driver's `traits:` (`ssd1683_spi`: true).
- **Commands:**
  - **`bitmap {x i16, y i16, w u16, h u16, data bytes≤1200, color rgb = 0xFFFFFF, bg rgb = 0x000000}`** (id 9,
    reliable, `bulk: true`): a rectangle of 1-bit pixels, rows of ceil(w / 8) bytes, MSB first (the snapshot layout of
    `fr/display/backend.hpp`); a 1 takes `color`, a 0 takes `bg`. With the defaults the bits are the frame's own
    (1 = light: paper on e-paper, lit on an OLED). Clipped to the screen; INVALID_ARGS when `data` is not exactly
    ceil(w / 8) × h bytes. Works on mono panels (e-paper and the C3 OLED); UNSUPPORTED on LVGL panels this round.
    1,200 B is 400 pixels × 24 rows, and fits one BULK frame (1,470 B) with room to spare.
  - **`refresh {mode RefreshMode = auto}`** (id 10, reliable) → RESULT `{mode RefreshMode, changed bool}`: refresh
    now (D3). RESULT says which mode will run and whether the frame differs from the glass; the `refreshed` event
    follows when the panel is done (nothing follows when `changed` is false and the mode is `auto` or `partial`).
    UNSUPPORTED where trait `epaper` is false.
  - **`hold {ms u16, 0–10,000}`** (id 11, reliable, idempotent): no automatic refresh for `ms`, or until `refresh`;
    0 releases. A client drawing many pieces (the hub's image op) holds, draws, then refreshes once; if it dies
    half-way, the hold runs out and the glass shows what arrived. UNSUPPORTED where `epaper` is false.
- **Properties** (requires trait `epaper`): `partials` (id 2, u8: partial refreshes since the last fast or full one),
  `shown_crc` (id 3, u32: CRC-32 of what the glass shows, in the snapshot layout; 0 = not known since boot),
  `refresh_ms` (id 4, u16: how long the last refresh took).
- **Event** **`refreshed {mode, ok bool, ms u16, partials u8, x u16, y u16, w u16, h u16, crc u32}`** (id 2, priority
  normal, requires trait `epaper`): one per refresh. `x, y, w, h` is the area that changed (the whole screen for fast
  and full); `ok` false when the panel did not finish in time (D5).
- **Config** (used only where `epaper` is true; the existing `flush_ms` becomes the shortest time between the starts
  of two refreshes, default 20: as soon as the panel is free):
  - `settle_ms` (u16, default 60, 0–1,000): how long after the last drawing command an automatic refresh starts.
  - `full_every` (u8, default **5**, 0–100): automatic partials before an automatic clean refresh; 0 = never.
  - `clean` (`RefreshMode`, default `full`; `fast` allowed): which refresh cleans.
  - `clean_hours` (u8, default 24, 0–168): a clean refresh when the glass has had none for this long, even if
    nothing changed (the vendor's 24 h rule); 0 = off.
  - `burst_ms` (u16, default 1,000, 0–5,000): keep the panel's high voltage on this long after a partial, so the next
    partial starts sooner (D4); 0 = power down after every refresh.
  - `sleep_s` (u16, default 10, 0–3,600): put the controller into deep sleep after this long without a refresh;
    0 = never.
  - `boot_clear` (bool, default false): at boot, show a white screen (a full refresh). False leaves the glass as it
    was, so a sign survives a reboot or an OTA (D3).

**D3. The refresh policy** (the node; `EpaperBackend`, D6):

- **Two frames.** The node keeps `frame` (what has been drawn) and `shown` (what the glass shows). A refresh sends only
  the rectangle where they differ, widened to whole bytes (8 pixels) as the controller addresses them. Drawing the
  same thing again changes nothing and costs no refresh.
- **When:** `settle_ms` after the last drawing command; at once on `refresh`; never during a `hold`; never while a
  refresh runs (the next starts when the panel is free, and at least `flush_ms` after the last one started). At most
  one refresh waits; a waiting one takes the strongest mode asked (full > fast > partial > auto).
- **Which mode:** `auto` is partial, except:
  - a **full** when the glass is not known: the first refresh after boot (unless `boot_clear` did it), after a deep
    sleep that lost the RAM, or after a refresh that failed;
  - the **`clean`** mode when `partials` has reached `full_every`.
  An explicit `partial` runs even when the budget is spent (the client takes the ghosts; the ghost test needs it).
  `fast` and `full` refresh the whole screen even when nothing changed, and set `partials` to 0.
- **Every 24 h** (`clean_hours`) a clean refresh of the same picture, as the vendor asks.
- **Boot:** the frame starts white. With `boot_clear` false the glass keeps its old picture, `shown_crc` is 0 and the
  first refresh is full.
- **Power:** after each refresh the controller's high voltage goes off (the vendor's advice), except during
  `burst_ms` after a partial (D4). After `sleep_s` without a refresh the controller goes to deep sleep; the next
  refresh wakes it with a hardware reset and rewrites both of its RAMs from `shown` before anything else (about 25 ms
  at 10 MHz), so nothing depends on what the RAM kept.
- **Failure:** a refresh whose BUSY does not fall in time (partial 2 s, fast 4 s, full 10 s) emits
  `refreshed {ok: false}`, marks the glass not known, and the next refresh resets and re-initialises the panel first
  (and is full). A panel that did not answer at boot is tried again at each refresh, so plugging it in later works
  without a reboot (with the USB unplugged while wiring, as the guide says).

**D4. How fast, mode by mode** (vendor figures; §10 measures ours):

| Mode | What runs | Time | Flashes | Ghosts |
|---|---|---|---|---|
| partial | the built-in partial waveform; only changed pixels move | 0.3–0.42 s | no | add up; cleaned every `full_every` |
| partial in a burst | the same, the high voltage still on from the last one (GxEPD2's practice) | about 0.1 s less (*inferred* from Fastwave's 91 ms figure) | no | the same |
| fast | the whole screen with the 1.5 s (or 1 s) hot-temperature waveform | 1–1.5 s | yes, briefly | mostly cleared |
| full | the whole screen with the normal waveform | 2–3 s | yes | cleared |

So the panel takes about **2–3 partial updates a second** at best, whatever their size. `burst_ms` 1,000 keeps the
high voltage on only while updates follow each other within a second; after that it goes off, as the vendor wants.
The driver's `fast_ms` config picks 1,500 (default) or 1,000 for `fast`.

## 4. The driver `ssd1683_spi` (D5)

`hardware/drivers/ssd1683_spi/` (`driver.yaml`, `include/fr/drv/ssd1683_spi.hpp`, `src/ssd1683_spi.cpp`):

- **Bind:** bare pins, like `gc9a01_spi`: `bind: { sclk, mosi, cs, dc, rst, busy }`, each in the board's `pins.free`.
  `sclk` and `mosi` go through `fr::platform::spi_bus` (`shared_bus: true`), so another SPI device could share them
  with its own CS.
- **Config:** `width` 400, `height` 300 (native), `spi_mhz` (default 10, 1–20: the datasheet's 20 MHz limit; 10 is
  safe on loose wires, *inferred*), `fast_ms` (1,500 or 1,000).
- **Traits:** `{ color: mono1, ui: false, epaper: true }`. **Resources:** `{ gpio: 6, spi_host: 1 }`.
- **Init** (Waveshare's sequence, corrected): RST high, a 2 ms low pulse, high; wait for BUSY to fall; `0x12`
  (software reset) and wait; `0x21 0x40 0x00`; `0x3C 0x05`; `0x11 0x03` (X then Y increasing); the full window and
  cursor. BUSY is read through a GPIO interrupt on its falling edge, which posts to the core task; no busy-waiting.
- **Writes:** `0x44`/`0x45` window and `0x4E`/`0x4F` cursor in bytes for X; `0x24` (new) or `0x26` (old) then data, in
  chunks the backend hands over (D6).
- **Refreshes** (the `0x22` value, then `0x20`):
  - full: `0x21 0x40 0x00`, `0x3C 0x05`, then `0xF7`;
  - fast: `0x1A 0x6E` (1.5 s) or `0x1A 0x5A` (1 s), then `0xD7` (load the waveform for that temperature and show it;
    GxEPD2's one-step form of Waveshare's `0x91` then `0xC7`);
  - partial: `0x21 0x00 0x00`, `0x3C 0x80`, then `0xFF`, or `0xFC` inside a burst (the high voltage stays on), with
    `0x83` to turn it off when the burst ends (GxEPD2).
- **Deep sleep** `0x10 0x01`; waking is the hardware reset and init above.
- **The old image:** before a partial the backend writes the window's old pixels into 0x26 and its new pixels into
  0x24, so the controller's comparison never depends on what it kept from before.
- **Selftest:** "answered" (*as built*; proposed "init accepted") when BUSY rose and fell around the last step; "absent" when BUSY never rose;
  "stuck busy" when it never fell. The detail adds the counts of refreshes by mode, failures and the last times.
- **`hal::Epaper`** (`fr/hal/epaper.hpp`) derives from `hal::Display` (geometry, init, selftest, no backlight) and
  adds: `write_begin(plane, x8, y, w8, h)`, `write(bytes)`, `refresh(mode, burst)`, `power_off()`, `sleep()`,
  `busy()`, and a ready callback. `flush()` (the `hal::Display` path) answers UNSUPPORTED: the backend uses the e-paper
  calls. Rotation is the backend's, in software (D6); the panel's RAM is always native.

## 5. The backend `EpaperBackend` and the shared 1-bit drawing (D6)

- **`MonoCanvas`** (`fr_core`, new): clear, fill, `text` with the 5 × 7 font, and `bitmap`, over a 1-bit buffer the
  caller owns, in the snapshot layout. It is `MonoBackend`'s drawing code moved out; `MonoBackend`'s output stays the
  same byte for byte (its tests and the desktop renderer's CRCs hold it), and it gains `bitmap`.
- **`EpaperBackend`** (`fr_core`, IDF-free, host-tested with a fake `hal::Epaper` and a virtual clock): a
  `MonoCanvas` over `frame`, plus `shown`, the policy of D3 and the counters.
- **Memory:** `frame` and `shown` are 15,000 B each at 400 × 300; a third, the frame `snapshot` freezes, only in test
  builds. Codegen declares them static, sized for the panel, and hands them in: no heap. 30 KB (45 KB in debug
  builds) of the C6's 512 KB; the free heap is read on the bench (HEARTBEAT `free_heap_kb`).
- **Threading, like `MonoBackend`:** everything runs on the core task. Drawing only touches memory. A refresh writes
  the window to the panel 1 KB per timer firing (0.8 ms at 10 MHz), so the core task handles inputs between chunks;
  BUSY's falling edge posts back to it. One timer drives one small state machine: idle → settle → write → refresh →
  idle (and asleep). No extra task.
- **Consistency while drawing goes on:** each chunk of new pixels is copied into `shown` as it goes out, so `shown` is
  always exactly what the controller holds, even when a command lands between chunks (it shows in the next refresh).
- **Rotation:** `rotation` r0–r270 in software: the frame is in the rotated geometry (300 × 400 at r90), and each
  chunk is turned into the panel's native rows on its way out (r90 and r270 transpose bits; r180 reverses them).
- **`snapshot`** freezes `frame` (what has been drawn), as on every panel; `shown_crc` says what the glass shows.

## 6. Board and profile (D7)

**`firmware/profiles/c6e-paper.profile.yaml`**, board `esp32c6-supermini`, alias proposed **`paper-c6`**:

- `boot` (`fr.button`, `buttons.boot`), `status` (`fr.led`, `led_ws2812` on `leds.rgb`, `max_brightness: 32`);
- `paper` (`fr.display`, `ssd1683_spi`, `bind: { sclk: gpio.19, mosi: gpio.18, cs: gpio.14, dc: gpio.3, rst: gpio.2,
  busy: gpio.1 }`, the config defaults of D2).

| Panel pin | Super Mini | Why there |
|---|---|---|
| VCC | 3V3 (right row) | 3.3 V logic, the module's own regulator after it |
| GND | GND (right row) | |
| CLK | GPIO19 (right row) | free, next to 3V3 |
| DIN | GPIO18 (right row) | free |
| CS | GPIO14 (right row) | free (GPIO15 between them is the board's LED and a strapping pin) |
| DC | GPIO3 (left row) | free, not a strapping pin |
| RST | GPIO2 (left row) | free, not a strapping pin |
| BUSY | GPIO1 (left row) | free, an input |

GPIO20 stays the board's T-LAT test pin; GPIO0 and the pads 21–23 stay free. No strapping pin is used (the C6's are
4, 5, 8, 9, 15). `slots.lock` gains the instances. The core task's stack is 16 KB on any profile with an `fr.display`
(as today).

## 7. Wiring and parts (D8)

- **Guide** `hardware/wiring/epaper-c6/guide.yaml` with `map.svg`: the table of D7; the panel's 8-wire cable (go by
  the labels on the module, not the colours); check BS at 0 before power; unplug the USB before wiring; keep the
  flat flex cable between the module and the glass untouched (it tears); 3.3 V only from the board's 3V3.
- **Parts:** `waveshare-epd42-v2` (pins, the BS jumper, the facts of §0 and their sources), and
  `esp32c6-supermini-board` (none exists yet; the C3's is the model).

## 8. Hub, CLI, dashboard, fake, renderer (D9–D12)

**D9. Hub ops and CLI** (`packages/protocol/src/ops/display.ts`, `packages/hub/src/display/`), both `target:
device` (they run at the hub that holds the board), in `protocol-targets.test.ts`:

- **`display_image {device, instance?, file?, png_base64?, fit = contain, x?, y?, dither = none, threshold = 128,
  invert = false, mode = auto, timeout_s = 20, inline?}`** (`files: { in: ['file'] }`):
  1. Decode: PNG by the hub's own decoder (every PNG colour type; the decoder grows from `display/png.ts`); other
     formats through Chrome on the hub machine; without Chrome, a clear refusal.
  2. Fit to the panel's size after rotation (`contain`, `cover`, `stretch`, or `none` at `x, y`), grey by Rec. 601,
     then a threshold, or a dither when asked (`ordered` or `diffusion`, for photos; the clock's no-dither rule is
     for its own faces).
  3. Compare with the hub's copy of the frame it last sent to that instance. The copy is trusted only when the node's
     `shown_crc` equals its CRC; otherwise the whole frame is sent.
  4. Send `hold {5000}`, then the changed rectangles as `bitmap`s of at most 1,200 B, then `refresh {mode}`, then
     wait for `refreshed`.
  5. Answer `{regions, bytes, mode, ms, partials, ok, png}`: `png` is what was sent, under `FR_HOME/renders`.
- **`display_html {device, instance?, html? | url?, wait_ms = 500, …the same rendering options}`**: the page drawn at
  the panel's size in a headless Chrome on the hub machine (the repo's `chrome.mjs` approach, moved into the hub),
  then the image path. A hub machine with no Chrome or Chromium answers UNSUPPORTED: "render it elsewhere and send a
  PNG with display_image".
- **CLI:** `fr display image <dev> <file> [--dither ordered] [--mode full]`, `fr display html <dev> <file|url>`,
  `fr display text <dev> "…" [--size 48]` (`display_html` with a plain page, any font Chrome has), and
  `fr display refresh <dev> [--mode partial|fast|full]` (*as built:* the op `display_refresh`, which waits for `refreshed`).
- **REGISTRY_HASH moves** (new ops): a CLI from this tree is refused by the lab hub and uriel until they run this code.

**D10. Dashboard.** `panels/display.tsx` grows an e-paper block (with `state/epaper.ts`, tested in node) when the
instance's trait `epaper` is true:
- the picture: the snapshot where the build has it, else the hub's last sent frame;
- one line about the glass: the last refresh's mode and how long it took (in pure mode in Blinks; Earth mode adds
  ⊕ and milliseconds), and "3 partial since the last clean, clean after 5" (words, no bar);
- buttons **Refresh**, **Clean** (fast) and **Full**;
- **Show an image** (a file picker; the file goes inline to `display_image`, with a dither choice), and **Show text**
  (a field to `fr display text`'s page).
`state/cap-words.ts` gains the new members (`settle_ms`, `burst_ms`, `refresh_ms`, `sleep_s`, `clean_hours`, …).

**D11. Fake.** `tools/fake-epaper.ts` on `dash-dev --epaper`: `paper-c6` (profile `c6e-paper`), a model of
`EpaperBackend` in TypeScript: `frame` and `shown`, `clear`, `fill_rect` and `bitmap` exact, `text` with the 5 × 7
glyphs read from `font5x7.cpp`, refreshes that take the vendor's times, `refreshed` events, the properties, the ghost
budget, `snapshot` and `snapshot_read`. SIGUSR1 makes the next refresh time out (the failure path).

**D12. The desktop renderer** (`tools/display`, `display_render`) draws a `c6e-paper` script through
`EpaperBackend` with a host panel whose refreshes are instant, so its CRC equals the board's `snapshot` CRC; scripts
gain `bitmap` and `refresh` lines.

## 9. Docs and tests (D13)

**Docs:** a user-manual section "An e-paper panel" (wiring summary, first run, the modes, ghosts, the image and HTML
commands, troubleshooting); spec 07 (`fr.display` 1.3, `ssd1683_spi`, `hal::Epaper`); spec 04 (the profile); spec
08/09 (the two ops, `fr display image|html|text|refresh`); AGENTS.md (the panel, `dash-dev --epaper`); a pointer in
m2-c5-display.

**Tests:**
- **Host (fr_core, ASan + UBSan):** `MonoCanvas` (`bitmap` clipping and colours; `MonoBackend` byte for byte as
  before); `EpaperBackend` with a fake panel: byte-aligned windows, old then new writes, nothing refreshed when
  `frame` equals `shown`, settle, hold and its expiry, one waiting refresh with the strongest mode, the ghost budget
  and `clean`, an explicit partial past the budget, `clean_hours`, the first refresh full, sleep and wake rewriting
  both RAMs, BUSY timeouts → `ok: false` → reset and full, a burst's `0xFC`/`0x83` against `0xFF`, all four
  rotations, a command landing between chunks.
- **Driver:** its command sequences come from a pure function (`ssd1683::sequence(mode, …)`), host-tested against
  §0's bytes.
- **Codegen:** the manifest, `epaper` → `EpaperBackend` with static buffers sized for the panel, the pins checked
  against `pins.free`, resources; `c6e-paper` generates.
- **Protocol:** vectors and the catalog hash for `fr.display` 1.3; the two ops' targets.
- **Hub (vitest):** the PNG decoder (every colour type, 16-bit, interlaced refused or decoded), fit, threshold and
  dither, the diff into rectangles of at most 1,200 B, a `shown_crc` mismatch → the whole frame, the op flow against
  the fake (hold, bitmaps, refresh, `refreshed`), `display_html` refused without Chrome.
- **Dashboard (vitest):** `state/epaper.ts` words; the design rules.
- **Builds:** `pnpm -s typecheck`, `pnpm -s fr gen --check` (0 stale), `node tools/host-test.mjs`, the ESP-IDF build
  of `c6e-paper` for esp32c6 (debug and release, sizes noted), `pnpm -s test`.

## 10. Bring-up (the owner; each step that flashes or opens a port needs a go-ahead)

1. **Wire** by the guide, USB unplugged; BS at 0.
2. **Flash** `c6e-paper` over USB (go-ahead) and provision it as `paper-c6`. `selftest`: "init accepted".
3. **First picture:** `fr display text paper-c6 "Fractonica"`: a full refresh (the glass is not known yet). This
   confirms the controller (§0).
4. **Times:** ten each of full, fast (1,500 and 1,000) and partial; `refreshed.ms` gives the table.
5. **Speed:** a counter redrawn as fast as the node allows for 60 s, with `burst_ms` 1,000 and then 0: updates per
   second.
6. **Ghost test:** a black square moving across white by explicit partials; a photo after 5, 10, 20 and 50. The
   owner picks `full_every` (the default stays 5 until then).
7. **The hub's side:** a photo with `--dither diffusion`, an HTML page, then a small change: only its rectangle
   flashes nothing and moves.
8. **The day:** leave it 24 h; the log shows the clean refresh.
9. **The hubs** (go-ahead): update uriel's and the lab hub's code so `fr display image` and the panel work there.

**As done, 2026-11-24** (the owner's go-ahead for each step; the owner chose to use `pad-c6` for the panel):
- The lab hub restarted on this code; `c6e-paper` built through it and flashed over USB with plan `app` (identity
  kept), then renamed `pad-c6` → `paper-c6`. Selftest: "answered reset, 400x300 at 10 MHz; 0 SPI errors".
- The first picture (`fr display text`): a full refresh, 3,334 ms; a one-character change: a partial, 2 areas,
  1,168 B sent. The owner saw the picture upright, black on white: the SSD1683 inference holds.
- Times, `refreshed.ms`, every sample the same: **partial 362 ms** with `burst_ms` 1,000, **403 ms** with 0 (the
  power-down is inside BUSY); **fast 1,701 ms** (`fast_ms` 1,500); **full 3,334 ms**. Back to back through the hub
  (two drawing commands, a refresh and its event each): 1.9 updates a second.
- Ghost test (a 40 px square moved by explicit partials after a full refresh): **very faint traces at 10, 30 and 60
  partials**, not growing; **a fast clean removed them**. The owner set `full_every` 60 with `clean` fast and kept
  `burst_ms` 1,000 (after a first wrong reading of the burst's effect, corrected the same hour).
- The hub's difference sending on the board: two text changes went as `diff` and partials; the same text again sent
  nothing. Once a resend of the same text went whole and moved a 240 × 25 area: Chrome may draw the same text a little
  differently from one launch to the next (harmless: only changed pixels move).
- Not done: step 8 (a day on the bench for the 24 h clean), step 9's uriel (its hub still runs older code).

## 11. Next round: the clock face

Not built now; designed so it plugs in without changing this round's parts:
- **`fr.face` 1.0** (id 0x0014), as the merge review planned (its D4, D5): bound to an `fr.display` port the way
  `fr.touch` is; the clock's `fractonica_ui` and the core (`fractonica`) as framework components; time from SNTP and
  the hub's push (review D7).
- **It draws through `EpaperBackend`**: the clock library already reports the rectangle that changed and when to wake
  (`fui_ui_update`'s `dirty` and `sleep_us`) and draws into a 1-bit row-major canvas (`FUI_FMT_MONO_ROW`), which is
  `frame`'s layout. So the face draws into `frame`, and D3's diff and partial refresh do the rest: only what changed
  is sent, and only changed pixels move.
- **Cadence:** a Blink (0.31 s) is faster than any refresh, so the e-paper face shows nothing finer than the Flavon
  (7.8 s); whether it changes every Flavon or every Preon (8.4 min) is a choice for that round, weighing ghosts and
  panel wear (no vendor figure for partial-refresh life was found).
- **Screen ownership:** at boot the face; a client's drawing takes the screen; `face.show` (or a timeout) gives it
  back.
- **A new 400 × 300 one-bit face** in `clock/components/fractonica_ui` (DESIGN.md §11's four marks at a larger scale):
  a design ruling for the owner in that round.

## 12. Risks

- **The controller is inferred** (§0). If it were the V1's UC8176, nothing would show and the selftest would say
  "absent" or "stuck busy"; the driver would then need another sequence.
- **The old-image RAM** is ours to manage (D5). A mistake shows as pixels that do not change; the ghost test sees it.
- **Burst mode** keeps the high voltage on up to a second after a partial: GxEPD2's practice, against the vendor's
  general "power down when idle". `burst_ms: 0` turns it off if the bench shows any harm.
- **Ghosts and wear:** the vendor's 5 partials is conservative; more are common, but how many this glass takes, and
  how long its partial refreshes last, is not published. §10's ghost test sets the number.
- **Temperature:** partial waveforms slow down and look worse in the cold (*inferred*); the panel is specified for
  0–50 °C.
- **The reset line powers the module** (§0): a long low pulse cuts its power; the driver keeps the pulse at 2 ms.
- **RAM on the C6** (D6): 30–45 KB, *inferred* to fit; measured on the bench.
- **Chrome on the hub machine:** the Mac has it; a Raspberry Pi or UNO Q hub may not, and then `display_html` and
  non-PNG images refuse there (PNG still works).
- **The hubs** run code from before this work until updated (D9).

## 13. The owner's answers (2026-11-24)

1. **The design is approved**; build it in the order of §14.
2. The alias **`paper-c6`** and the pins of D7.
3. **`burst_ms` 1,000** (faster partials).
4. **`boot_clear` false**: the glass keeps its picture across a reboot or an OTA.
5. After the ghost test (§10): **`full_every` 60 with a fast clean**, and **`burst_ms` 1,000** kept (0.362 s
   partials against 0.403 s). The capability's defaults stay the vendor's (5, full).
6. The panel goes on **`pad-c6`** (the bench's C6 Super Mini), renamed `paper-c6`; the lab hub restarted on this code.

## 14. Tasks

- **T1** `fr.display` 1.3 in the schema; `fr gen`; protocol vectors.
- **T2** `MonoCanvas` out of `MonoBackend`, `bitmap` on mono panels; host tests.
- **T3** `hal::Epaper`; `EpaperBackend` and its policy; host tests.
- **T4** `ssd1683_spi` driver and its sequence function; host tests of the bytes.
- **T5** codegen: the e-paper backend, its buffers, the driver's pins; `DisplayService`'s new commands, properties and
  event; tests.
- **T6** board part, panel part, profile `c6e-paper`, `slots.lock`, wiring guide and drawing.
- **T7** hub: PNG decoder, fit/threshold/dither, diff, `display_image`, `display_html` (Chrome); CLI; tests.
- **T8** dashboard e-paper block and words; tests.
- **T9** `tools/fake-epaper.ts` on `dash-dev --epaper`; the desktop renderer for e-paper.
- **T10** docs (D13).
- **T11** the checks of §9; then, with the owner's go-ahead, §10.
