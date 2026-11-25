# AGENTS.md — working on the Fractonica ESP32 clock (`clock/`)

This project is the `clock/` directory of the devices repository. The repository
root is the Fractonica device framework (its own AGENTS.md); the clock is a
standalone ESP-IDF 5.5 project until stage 5 of the merge plan folds it into
the framework on ESP-IDF 6.1. Paths below are relative to `clock/`.

The guide for a coding agent (or engineer) picking this repository up. It tells
you where everything is, how to build and test it, and what you must not break.

- **What it is:** firmware for a small physical Fractonica clock (ESP32 /
  ESP32-S3 / ESP32-C3, one small display, a few buttons or an encoder).
- **State of the work:** all five stages are done: the portable UI library
  (`components/fractonica_ui`), the host simulator (`sim/`), the hardware
  layer (`components/fractonica_hal`), the application (`main/`), the
  ESP-IDF / PlatformIO project, an integration pass in which every face was
  rendered at SPEC vectors A, B and C and checked against the core, and a
  review pass (stage 5) whose 17 findings are answered in section 11. It
  is built and tested against core 0.2.0 (section 11) and
  builds for all three chips without a warning. **It has run on hardware
  once**: on 2026-11-13 on an ESP32-C6 with a round GC9A01
  (`configs/esp32c6-gc9a01.defaults`: SCL 6, SDA 7, CS 10, DC 2, RST 3, BOOT
  GPIO 9 as the one button), where the owner confirmed colours and
  orientation on glass. Section 11 says what else is and is not verified, and
  docs/GUIDE.md has the bring-up checklist for the next board.
- **The clock itself is not here.** All Fractonica arithmetic, tables, names
  and text live in the organisation's sibling checkout `../../core` (read
  `../../core/AGENTS.md`, "I need X → call Y"). The look is specified in
  `../../design/astrolabe/DESIGN.md` (section 11 is the small displays) with
  rulings in `../../design/README.md`.
- **Before you say something works:** `cd sim && make test`; after a drawing
  change `make shots` (or `make matrix`, all 949) and LOOK at the PNGs in
  `sim/out/`, with `make probe` beside them for what the core says; after a
  firmware change `tools/build-all.sh` (every chip and display, fails on a
  warning).

## 1. The rules (they are not negotiable)

1. **Everything Fractonica comes from the core**: every number, name, symbol,
   phase, boundary, span, date, glyph state and formatted quantity. This code
   never re-implements clock arithmetic, tables, naming or number formatting.
   Arc geometry comes from `frc_arc_child`, glyph strokes from
   `frc_glyph_segments`. What the UI may do: join core texts with its own
   furniture words ("IN", "MADE OF"), choose which of the core's forms a line
   uses, draw, and decide HOW LONG TO SLEEP from what the core returns (never
   what to show). If the core lacks something, add it to section 10 and, only
   if you cannot proceed, put a stand-in in `src/fui_shim.c` (the one shim
   file; today it holds one stand-in, `fui_shim_format_span_to`, for the
   step's countdowns: section 10).
2. **Never edit** `../../core`, `../../design`, `../../reference`, `../../ios`, `../../web`, `../../SPEC.md`.
3. **No heap after start-up.** `fractonica_ui`, `main/app*.c` (not
   `app_main.c`) and `fhal_button.c` reference no allocator at all (`make
   test` checks the objects with `nm`). All UI state is one caller-owned
   `fui_ui_t`; the frame buffer, both task stacks, the queue, the semaphores
   and the timers are static (`main/app_main.c`, the HAL). ESP-IDF drivers may
   allocate their objects while `app_main` runs, never later.
4. **No busy waiting, no polling.** The UI task sleeps for
   `fui_frame_t.sleep_us` or until a message; a display flush waits on a
   semaphore; buttons are an interrupt plus a timer; the console blocks in
   the driver. See "How a frame is made" and section 5 before changing that.
5. **PURE mode shows only Fractonica**: no date, weekday, hour, zone, Hz,
   metre, SI unit, per cent. EARTH adds translations, each led by ⊕ and drawn
   in ash, beside or under the Fractonica value: it never replaces one
   (`test_ui` "cards": EARTH has every line PURE has). Nothing blinks or
   pulses; no inverse video and no dithering on one bit; no percentages
   anywhere.
6. **C99, warning-free** under ESP-IDF's flags plus `-Wall -Wextra` (the sim
   builds with `-Wpedantic -Wshadow -Werror` too; `tools/build-all.sh` fails
   on any warning). `fractonica_ui` and `main/app.c`, `app_console.c`,
   `app_shot.c` include no ESP-IDF header: the host builds the same files.
   ESP-IDF compiles C as gnu17; `fractonica_ui` is held to `-std=gnu99` there
   too (its CMakeLists). The HAL and `app_main.c` cannot be (ESP-IDF's own
   headers need C11), so they keep to C99 by hand: no `_Static_assert` (use
   `APP_CHECK` in `app_main.c`), no C11 library.
   Float only where the core hands it floats (arc geometry, `fui_glyph.c`,
   `fui_ring.c`, the seal in `fui_screen_lens.c`); none in the HAL or `main/`.
7. **No third-party graphics library** (no LVGL, U8g2, Adafruit GFX) and no
   downloaded code. The rasteriser and the fonts are ours.
8. **No pin number in C.** Hardware choices are Kconfig
   (`main/Kconfig.projbuild`); `fhal_board.h` is the one file that turns them
   into constants.
9. Report honestly: what you ran, what it printed, what you could not verify.
   Nothing has been flashed; say so until it has.

## 2. Layout

```
CMakeLists.txt                   the ESP-IDF project; finds the core (FRACTONICA_CORE_DIR, ./core, ../core, ../../core)
sdkconfig.defaults               what every build starts from (size optimisation, 1 ms tick, 4 MB flash)
sdkconfig.defaults.<target>      per chip: esp32, esp32s3, esp32c3, esp32c6
configs/*.defaults               variants added with -DSDKCONFIG_DEFAULTS: displays, inputs, wifi, band ...
                                 (ci-wifi.defaults: the build matrix's placeholder network name, not for a clock)
platformio.ini                   the same project for PlatformIO, one environment per board + display
main/
  Kconfig.projbuild              EVERY hardware choice (menu "Fractonica clock"), with the pin defaults
  app.h                          the application's contract: messages, settings record, app_port_t
  app.c                          PORTABLE: the UI task's loop (app_step), whole-frame / band drawing, settle-then-save
  app_console.c                  PORTABLE: what each console command does
  app_shot.c                     PORTABLE: `shot`, the frame as text
  app_main.c                     ESP-IDF: app_main, the UI task, the queue, app_port_t on the HAL, `info`
components/fractonica/           wrapper: registers the core's sources as the component "fractonica"
components/fractonica_hal/       ESP-IDF specific
  include/fhal_board.h           the pin map: CONFIG_FRACTONICA_* -> FHAL_* constants (the only place)
  include/fhal_display.h         THE display interface: info, init, flush(window), brightness, sleep
  src/fhal_display_spi.c         GC9A01 + ST7789: SPI bus, esp_lcd panel IO, rotation, backlight, blocking flush
  src/fhal_panel_gc9a01.c/.h     our GC9A01 panel driver (esp_lcd panel interface, init sequence)
  src/fhal_display_ssd1306.c     SSD1306: new I2C master driver + esp_lcd's SSD1306 driver
  include/fhal_input.h  src/fhal_input.c    buttons (GPIO interrupt + FreeRTOS timer), encoder (PCNT or GPIO)
  include/fhal_button.h src/fhal_button.c   PORTABLE: click / double / long state machine
  include/fhal_time.h   src/fhal_time.c     system time, who set it, kept in RTC memory; demo instant
  include/fhal_net.h    src/fhal_net.c      Wi-Fi + SNTP state machine (fhal_net_off.c when not built)
  include/fhal_settings.h src/fhal_settings.c   one small record in NVS, written only when changed
  include/fhal_console.h  src/fhal_console.c    the line reader task (UART or USB-Serial-JTAG)
  include/fhal_power.h    src/fhal_power.c      automatic light sleep (optional); fhal_power_keep_pin: a pin stays driven in sleep
components/fractonica_ui/        PORTABLE C99 (host + ESP-IDF). The UI library.
  include/fui_ui.h               THE entry point: state machine, frame contract, navigation map
  include/fui_canvas.h           frame-buffer view: formats, clip, dirty box, bands
  include/fui_raster.h           lines, arcs, discs, strokes (Q8 pixels, 65536-per-turn angles)
  include/fui_font.h             bitmap fonts + UTF-8 text drawer
  include/fui_glyph.h            core glyphs / core arcs -> pixels (the float boundary)
  include/fui_theme.h            DESIGN.md colour tokens as RGB565, and the one-bit theme
  src/fui_i.h                    PRIVATE: layout, painter, text assembly, internal prototypes
  src/fui_ui.c                   events, update (what changed, when to wake), draw
  src/fui_model.c                the one place that reads the clock for rings and glyphs
  src/fui_ring.c                 the hero ring: cached geometry from frc_arc_child, fill from phases
  src/fui_instrument.c           the colour instrument: counter rings, Sun ring, bezel, alidade, centre
  src/fui_face_mono.c            NOW / SCALES on 128 x 64 one-bit
  src/fui_face_mono400.c         the corners of the 400 x 300 paper face's NOW (its wave: fui_i_wave, fui_instrument.c)
  src/fui_shim.c                 stand-ins for what the core lacks (section 10): fui_shim_format_span_to
  src/fui_screen_now.c           rows of text under the instrument (rectangular faces)
  src/fui_screen_lens.c          LENS card            src/fui_screen_sun.c    SUN card
  src/fui_screen_stamp.c         STAMP card, and the "no reading" card
  src/fui_paint.c                layouts of the four faces, text styles, line hashing, wrapping
  src/fui_words.c                shared phrases (countdown, civil time, date terms, status lines)
  src/fui_canvas.c fui_px.h      canvas and the inline pixel accessors
  src/fui_arc.c fui_line.c fui_disc.c fui_stroke.c fui_trig.c   the rasteriser
  src/fui_glyph.c                glyph + arc conversion
  src/fui_font.c                 decoder, lookup, drawer
  src/fui_font_small.c fui_font_text.c   GENERATED font tables (never edit)
  src/fui_font_line.c            GENERATED too: the paper face's monoline stroke font, a subset
                                 (tools/fonts/fui_font_line.txt; packed: 3-byte records + the points, 1.4 kB)
  src/fui_theme.c                the palettes
  CMakeLists.txt                 ESP-IDF component, REQUIRES fractonica
docs/                            GUIDE.md (the long manual) and its pictures: every face on its screens (`make pictures`; kept);
                                 hero.jpg, README.md's front picture (laid out by hand from three of them; `make pictures` leaves it)
sim/                             host build (system cc only)
  Makefile                       make | test | shots | matrix | probe | pictures | golden | firmware | wakes | stats | stack | bench | info | sizes | fonts
  src/sim_main.c                 fractonica-sim: one frame of the UI library -> PNG
  src/sim_firmware.c             fractonica-fwsim: main/app.c run with scripted time, input, console; --stack
  src/sim_port.c                 the host port of app_port_t: jumping clock, panel model, console capture
  src/sim_probe.c                probe: what the CORE says at an instant, to check a picture against (links the core only)
  src/sim_stats.c                fractonica-stats: primitives, pixels and host time of each redraw
  src/sim_frame.c sim_png.c      frame buffer, scripted input, RGB, hash; our PNG writer
  tests/test_raster.c test_canvas.c test_font.c test_ui.c test_golden.c    the UI library
  tests/test_firmware.c          the application loop, the console, the screenshot, settings, buttons
  tests/test_fuzz.c              random input under the address + undefined-behaviour sanitizers
  golden/hashes.txt              golden image hashes
tools/
  build-all.sh                   the build matrix (idf.py, optionally pio); fails on any warning
  size.sh                        per-component flash / RAM of the builds; tables-in-flash check
  stack-report.py                the UI task's deepest chain of frames (-fstack-usage + -fcallgraph-info), per target
  shot.py                        `shot` console output (log or serial port) -> PNG
  simulate.sh                    build + run fractonica-sim
  render-matrix.sh               all 949 pictures: faces x screens x pages x modes x focus x lens levels at vectors A, B, C + states
  contact-sheet.py               lay many pictures on one sheet for a review (needs Pillow; nothing else uses it)
  size-report.sh                 the UI library alone with the cross compilers (no ESP-IDF build)
  genfont.py  fonts/*.txt        font art (ASCII) -> C tables
  png-compress.py                recompress the guide's pictures
```

### Where is ...?

| Looking for | It is in |
|---|---|
| what a face draws | `fui_instrument.c` (colour, and the 400 x 300 paper face in one-bit marks), `fui_face_mono.c` (128 x 64), `fui_face_mono400.c` (the paper face's corners; its wave is `fui_i_wave`), the `fui_screen_*.c` cards; layouts in `fui_paint.c` |
| the step (the face moves once a cycle of a level) | `fui_ui_update` (`fui_ui.c`: the instant shown, the wake); the readings' finest unit: `fui_i_finest_unit`, `fui_i_civil_seconds` (`fui_words.c`) |
| which face a display gets | `app_main()` in `main/app_main.c` (GC9A01 → round240, ST7789 → rect240 / rect240x320, SSD1306 → mono) |
| a pin number | `main/Kconfig.projbuild` defaults (per chip), overridden by `sdkconfig` / `configs/*.defaults` |
| a display's init sequence | `fhal_panel_gc9a01.c`; ESP-IDF's `esp_lcd_panel_st7789.c` / `esp_lcd_panel_ssd1306.c` |
| rotation, mirror, backlight, the ST7789's 80-row offset | `fhal_display_spi.c` |
| when the UI task wakes | `fui_ui_update` (the deadline) → `app_step` in `main/app.c` → `port_wait` in `main/app_main.c`; how long a text line holds: `fui_i_line_until` / `fui_i_span_until` (`fui_paint.c`, `fui_words.c`) |
| which levels nest, where the bezel and the first counter ring sit | `fui_i_ring_prepare` (`fui_ring.c`: `reach_in`, `reach_out`), used by `fui_i_instrument` |
| an Earth translation's wording and colour | `fui_i_add_civil` (`fui_words.c`); the ash, case-keeping tail after ⊕: `FUI_TEXT_EARTH_TAIL` (`fui_font.h`) |
| what is flushed | `draw_whole` / `draw_banded` in `main/app.c` |
| what a button press means | `fhal_button.c` (click / double / long), the table at the top of `fhal_input.c` (which event) |
| a console command | `main/app_console.c`; the platform's part of `info` is `port_info` in `main/app_main.c` |
| what is stored in flash | `app_settings_t` in `main/app.h`; when: `settle_settings` in `main/app.c` |
| the Wi-Fi / SNTP retry rules | the diagram at the top of `fhal_net.c` |

## 3. Build, simulate, test

### Host (no hardware, no ESP-IDF)

```
cd sim
make                 # build/fractonica-sim and build/fractonica-fwsim
make test            # raster, canvas, font, ui, golden, firmware, fuzz (ASan + UBSan), no-heap, fonts up to date
make shots           # 40 face x screen x mode PNGs at SPEC vector A + focus sweeps + states -> out/
make matrix          # = ../tools/render-matrix.sh: 949 PNGs at vectors A, B, C, time not set, out of catalogue -> out/matrix/
make probe           # build/probe [unix s] [utc offset s]: beads, running arc, glyph states, spans, Sun, from the core alone
make pictures        # the guide's pictures -> ../docs/ (kept in the repository)
make golden          # rewrite golden/hashes.txt (only after LOOKING at the new shots)
make firmware        # the firmware loop for a simulated idle hour, every face: wake-ups, redraws, pixels
make wakes           # the same hour at every focus level 0..13 on every face
make stats           # what one redraw costs: primitives, pixels cleared / inked, host time
make stack           # = ../tools/stack-report.py: deepest chain of frames for xtensa and riscv32
make bench info      # host time per redraw; sizes of the state and frame buffers
make sizes           # = ../tools/size-report.sh: the UI library for xtensa-esp32 and riscv32, -Os
make fonts           # after editing tools/fonts/*.txt
```

To review many pictures at once: `tools/contact-sheet.py sheet.png sim/out/matrix/A/focus/round240-*-pure.png --cols 4`
(Pillow). To check one: `sim/build/probe 946684800` prints, per focus level,
"beads-lit 4 of 9, running-arc 6 of 18 +0/16, odometer 5(+3 dot) 6(+2 dot),
next Node in 5ι 58λ", then the Sun: count the beads and the lit arcs in the
picture against it.

```
build/fractonica-sim --face round240|rect240|rect240x320|mono|mono400x300
                     --screen now|scales|lens|sun|stamp   --mode pure|earth
                     --step none|helion|theta|preon|kappa|flavon   (fui_ui_set_step)
                     --t <unix seconds>|none              (default 1791460800, SPEC vector A)
                     --focus <0..13>  --events "N P S L W500"  --utc-offset <seconds>
                     --scale <n>  --band <rows>  --out file.png

build/fractonica-fwsim --face ... --mode ... --focus ... --t <unix s>|none --utc-offset <minutes>
                     --band <rows>  --seconds <n>  --late <us>  --brief  --out panel.png
                     --script "W2000; N; N; W6000; mode earth; info; shot"
```

`fractonica-sim` draws one frame (`--events` are fed after `--screen` is
reached: N next, P prev, S select, L long, `W<ms>` lets time pass).
`fractonica-fwsim` runs the application loop: script items are `W<ms>`, the
four event letters, or a console line; it prints the console output and the
loop's counters and can save the simulated panel. `--stack` runs the loop on
a painted stack and prints its high-water mark (the host's ABI, not the
chip's).

### Firmware (ESP-IDF 5.5)

```
source ~/esp/v5.5.1/esp-idf/export.sh
idf.py -B build/esp32 -DIDF_TARGET=esp32 -DSDKCONFIG=build/esp32/sdkconfig build      # also esp32s3, esp32c3
idf.py -B build/esp32 -DSDKCONFIG=build/esp32/sdkconfig menuconfig                    # "Fractonica clock"
idf.py -B build/esp32 -p <port> flash monitor
idf.py -B build/esp32c6 -DIDF_TARGET=esp32c6 -DSDKCONFIG=build/esp32c6/sdkconfig \
       -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;configs/esp32c6-gc9a01.defaults" build   # the board it ran on
idf.py -B build/x -DIDF_TARGET=esp32c3 -DSDKCONFIG=build/x/sdkconfig \
       -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;configs/ssd1306.defaults;configs/buttons2.defaults" build

tools/build-all.sh            # the matrix below; exit 1 on a failed build OR any "warning" in a log
tools/build-all.sh esp32c3    # one row of it          tools/build-all.sh --pio   # + pio run -e esp32-gc9a01
tools/size.sh                 # per-component flash / RAM of every build/<name>; tables-in-flash check
pio run -e esp32-gc9a01       # PlatformIO (its own ESP-IDF 5.5.0); environments in platformio.ini
```

Always give `-B` and `-DSDKCONFIG` together: one directory and one sdkconfig
per build, nothing in the project root. A `configs/` file only takes effect
when the sdkconfig is first created (delete `build/<name>` to re-apply).

The matrix (`MATRIX` in `tools/build-all.sh`):

| Build | Chip | Display | Input | Extras |
|---|---|---|---|---|
| `esp32`, `esp32s3`, `esp32c3` | each | GC9A01, whole frame | encoder (PCNT; GPIO on C3) | |
| `esp32-wifi-demo` | ESP32 | GC9A01, 40-row bands (the Kconfig default with Wi-Fi there) | encoder | Wi-Fi + SNTP, demo instant |
| `esp32-st7789x320` | ESP32 | ST7789 240 x 320, 40-row bands (the Kconfig default there) | three buttons | |
| `esp32s3-st7789-wifi` | ESP32-S3 | ST7789 240 x 240 | one button | Wi-Fi + SNTP |
| `esp32c3-st7789-band` | ESP32-C3 | ST7789 240 x 240, bands | one button | |
| `esp32c3-ssd1306-wifi` | ESP32-C3 | SSD1306 | two buttons | Wi-Fi + SNTP |
| `esp32-ssd1306-lightsleep` | ESP32 | SSD1306 | three buttons | light sleep |
| `esp32c3-lightsleep` | ESP32-C3 | GC9A01, whole frame | three buttons | light sleep (pins isolated in sleep: the display's are kept) |
| `esp32s3-ssd1306-lightsleep` | ESP32-S3 | SSD1306 | three buttons | light sleep (likewise) |

The Wi-Fi rows add `configs/ci-wifi.defaults`, a placeholder network name:
with the empty default the compiler sees that no network is configured and
the linker drops the Wi-Fi stack, which would leave that code unlinked. On
the light-sleep rows of the C3 / S3 the script also checks that the HAL
calls `gpio_sleep_sel_dis` (the display's pins kept driven in sleep).

Flashed once, by the owner: the ESP32-C6 + GC9A01 build above (2026-11-13).
The framework hub at the repository root holds every ESP32 USB port while it
runs: stop it (or lend the port) before `flash` or `monitor`, and never flash
without the owner's go-ahead. ESP-IDF's QEMU is not installed
(`~/.espressif/tools/qemu-xtensa` is empty).

## 4. Using the library (the contract with the firmware)

```c
static fui_ui_t ui;                              /* 1552 bytes, all the UI state */
static uint16_t frame[240 * 240];                /* or a band: see below */
fui_canvas_t canvas;

fui_config_t config = { .face = FUI_FACE_ROUND240, .utc_offset_s = 7200,
                        .mode = FUI_MODE_PURE, .focus = FUI_FOCUS_DEFAULT };
fui_ui_init(&ui, &config);
fui_canvas_init(&canvas, frame, FUI_FMT_RGB565_BE, 240, 240);   /* _BE: bytes as the SPI panel takes them */

for (;;) {
    const fui_frame_t *f = fui_ui_update(&ui, now_us /* or FRC_TIME_NONE */, monotonic_ms);
    if (f->redraw) {
        fui_canvas_dirty_reset(&canvas);
        fui_ui_draw(&ui, &canvas);               /* draws f->dirty only */
        panel_flush(&canvas, &f->dirty);
    }
    event = wait_for_input(f->sleep_us);         /* -1: no deadline */
    if (event != FUI_EV_NONE) fui_ui_event(&ui, event, monotonic_ms);
}
```

- `now_us` is Unix microseconds (`FRC_TIME_FROM_S(tv.tv_sec) + tv.tv_usec`).
  Pass `FRC_TIME_NONE` until the time is known: the faces say "TIME NOT SET".
- **Bands** (no full frame buffer): make the canvas a strip, e.g. 240 x 40
  (19.2 kB), and for each strip call `fui_canvas_set_origin(&canvas, 0, y)`,
  `fui_ui_draw`, flush. `fui_ui_draw` is a pure function of the state, so every
  band shows the same frame (`tests/test_ui.c` "banded rendering"). One-bit
  bands must start on a multiple of 8 rows.
- **Canvas formats:** `FUI_FMT_RGB565` (CPU order), `FUI_FMT_RGB565_BE` (high
  byte first in memory), `FUI_FMT_MONO_PAGE` (the SSD1306's own pages: send the
  buffer as it is), `FUI_FMT_MONO_ROW`. Layouts are documented bit by bit in
  `fui_canvas.h` and held by `tests/test_canvas.c`.
- **The step** (`fui_ui_set_step(&ui, FUI_STEP_PREON)` or `config.step`;
  levels 6 Helion, 7 theta, 8 Preon, 9 kappa, 10 Flavon; 0 = none, the
  default, which every face had before). With a step every screen shows the
  instant the running cycle of that level BEGAN (`frc_cycle_at(...).start`,
  kept in `ui->t`) and `fui_frame_t.next_wake` is that cycle's END: the face
  changes on each boundary and at no other time, except that input redraws
  at once and the brief labels (2.5 s level name, 1.5 s mode word) come and
  go on time. Readings end at the step's unit (`fui_i_finest_unit`: kappa
  reads to the Preon, theta to the Helion): the count's date terms, the
  stamp, every countdown (cut toward zero by the shim of section 10; under
  one unit "0ι"); EARTH's civil time has minutes at every step coarser than
  the Flavon. The countdown is the span FROM THE INSTANT SHOWN: at vector A
  and the Preon step the face shows 34η 29ι and "END IN 7ι" (29 + 7 = the
  Helion's 36ι), not the live "6ι 43λ" cut to "6ι". `fui_ui_set_step`
  returns 0 and changes nothing for any other value.
- **The paper face** (`FUI_FACE_MONO400X300`, 400 x 300 one bit, made for
  the framework's Waveshare 4.2" e-paper): give `fui_ui_draw` a
  `FUI_FMT_MONO_ROW` canvas over the panel's frame (`fui_canvas_init(&c,
  frame, FUI_FMT_MONO_ROW, 400, 300)`: 50 bytes a row, bit 7 leftmost,
  15,000 bytes; bands of whole rows work too). Its default theme
  `fui_theme_paper` grounds with SET bits and inks with CLEAR bits, which a
  panel whose memory holds 1 = white shows as black on white; pass
  `.theme = &fui_theme_mono` for a panel whose 1 is black. `test_ui`
  "paper" holds it: the ground all set, MONO_ROW = MONO_PAGE pixel for
  pixel, bands = whole, the mono theme's picture its exact inverse.
- **Stack:** the largest frames of the library (xtensa, `-Os`) are the SUN
  screen 464 bytes, LENS 448, `fui_glyph_draw` 448; the deepest chain from
  `app_step` is 2,304 bytes (`tools/stack-report.py`). Section 8 has the
  figures and why the UI task's stack is 6 kB.

### Navigation map

The same map as the top of `fui_ui.h` (the code), and docs/GUIDE.md "Getting around":

```
NOW ──NEXT / PREV──▶ SCALES   focus one level finer / coarser (0..13,
 ▲  ◀─ 2.5 s without ─┘  │    wrapping); the level is named at the centre
 │       input           │
 │                     SELECT (the level just turned to is inspected)
 │                       ▼
 └────────SELECT───────▶ LENS ─SELECT─▶ SUN ─SELECT─▶ STAMP ─SELECT─▶ NOW

SELECT  always means "further": on a card with several PAGES it turns the
        page, and leaves the card from its last page.
LENS    NEXT / PREV step the inspected level through ALL 63 (0..62,
        wrapping). Inspecting never refocuses the instrument: the focus
        changes on NOW / SCALES only (ruling 9).
SUN     NEXT = SELECT; PREV = a page back, then LENS
STAMP   NEXT = SELECT; PREV = a page back, then SUN's last page
LONG    anywhere: PURE <-> EARTH. On NOW / SCALES the mode is named at the
        centre for 1.5 s.
```

The HAL's input kinds (`fhal_input.h`; the UI only sees the four events):
encoder: turn = NEXT / PREV, push = SELECT, hold = LONG; three buttons:
C = PREV, A = SELECT (hold = LONG), B = NEXT; two buttons: A = NEXT (hold =
PREV), B = SELECT (hold = LONG); one button: click = NEXT, double click =
SELECT, hold = LONG (the focus wraps, so NEXT alone reaches every level).
`ev n|p|s|l` on the console injects the same events.

### How a frame is made (read before touching fui_ui.c or a screen)

`fui_ui_update` notices three kinds of change:

| What | How it is noticed | What is redrawn |
|---|---|---|
| the scene (screen, focus, mode, status, a brief label) | a hash of the state | the whole face |
| rings and glyphs | the core says when: `frc_odometer_at(...).next_change` of the focus (2 glyphs) and of the level two below it (16 states a cycle: under a pixel of arc per step); `frc_sync_odometer` on SUN | the instrument's rectangle (the whole face on round and one-bit) |
| live text lines | re-formatted WITHOUT drawing at each Blink boundary (lines flagged `FUI_LINE_LIVE`), at each civil second (`FUI_LINE_SECONDS`), or at the instant a line named with `fui_i_line_until` / `fui_i_span_until` ("my text holds until then"); per-line hashes compared | the rows of the lines that changed |

A screen is ONE function `paint(fui_painter_t *)`, run without a canvas to
hash its text and with one to draw. So in a screen:

- every text goes through `fui_i_text` / `fui_i_card_line` (never
  `fui_text_draw` directly). A line that changes with time must say when to
  look again, one of three ways: `FUI_LINE_LIVE` (every Blink: anything that
  shows Blinks), `FUI_LINE_SECONDS` (every civil second), or a call to
  `fui_i_line_until(p, instant)` with a boundary the core gave (the Helion's
  end for a Pentad line) / `fui_i_span_until(p, boundary)` for a countdown
  to `boundary` written by `frc_format_span` (it sleeps until
  `frc_span_next_change`). A line that does none of these is static.
  `test_ui` "quiet lines" fails if a line goes stale while the UI sleeps;
- shapes are drawn only `if (p->canvas)`;
- ring and glyph state comes from `ui->reading` (filled by `fui_model.c` when
  the rings are due), never straight from the core, so that redrawing a row of
  text finds the rings exactly as they were drawn;
- at most `FUI_MAX_LINES` (16) lines per screen.

`tests/test_ui.c` "partial redraw == full redraw" follows the wake instants
for 40 frames on every face, screen and mode and compares the accumulated
frame buffer with one full draw, byte for byte. Keep it passing.

A redraw of text rows alone does not walk the instrument (`fui_i_paint`
skips it when the clip lies below `instrument_bottom`): on the rectangular
faces that is the redraw of every Blink.

### Faces (`fui_i_layout`, `fui_paint.c`)

| Face | Canvas | Instrument | Text |
|---|---|---|---|
| `FUI_FACE_ROUND240` | 240 x 240 RGB565 | centre (120, 120), R 56, g 8, gM 5.5, rings to r 116, u = 5 px | none (EARTH: ⊕ under the odometer, midnight ticks on the Sun's ring) |
| `FUI_FACE_RECT240` | 240 x 240 RGB565 | the same at 5/7 scale: centre (120, 90), R 40, g 5.7, u = 4 px | reading, countdown, ⊕ row |
| `FUI_FACE_RECT240X320` | 240 x 320 RGB565 | full size, centre (120, 122) | Pentad + words, reading, countdown, ⊕ row; LENS adds the six other media |
| `FUI_FACE_MONO128` | 128 x 64 one-bit | carrier R 19 at (31.5, 31.5), first-level arcs, quarter ticks on pixels 9..12 from the centre pixel | beads, odometer u = 10/3, count |
| `FUI_FACE_MONO400X300` | 400 x 300 one-bit e-paper, black on white (`fui_theme_paper`) | the WAVE alone: the hero's two levels round an inner circle with the glyphs, centre (199.5, 149.5), sized at each focus so its ink reaches 146 px (126 in EARTH), glyphs a whole multiple of 10/3 px per unit (10 px at the Helion); one-bit marks | the corners at 4 px per dot: ε#5, 34η, 29ι, the Pentad's mark; EARTH: the civil time, bottom centre |

Decisions DESIGN.md left open (only F = 6 was art-directed), made here:

- **Counter rings**: the nearest ancestors that fit inside `ring_limit`
  (all seven at the Helion; five or six at finer focus, where the majors fall
  off the edge). The Sun's ring keeps its place after ζ.
- **Coarse factors**: a factor of 4 or 5 makes the arcs large; the bezel then
  shrinks to stay inside them and the first ring moves out. `reach_in` /
  `reach_out` in `fui_ring_t` are the reach of EVERYTHING the ring draws, the
  second level included, so no arc crosses the bezel circle or a counter ring
  (`test_ui` "geometry").
- **Second level**: drawn only when its smallest arc has r ≥ 2.3 px
  (`NEST_MIN_RADIUS`, ruling 9 scaled to these displays: what delta's and
  mu's nested arcs have on the square face, so the same levels nest on every
  colour face) AND the nested arcs stay outside 0.6 R, the room
  the bezel, its ticks and the two glyphs need: focus 2, 3, 6, 10, 11. Theta
  (focus 7, factor 4) fails the second test: its nested arcs would reach in to
  0.56 R, into the odometer, so it shows the first level alone.
- **Bezel graduations**: the short ticks are dropped when they would be under
  3 px apart (factor products 77 and 99).
- **One-bit count**: the two date terms around the focus ("34η 29ι" for η and
  θ, "α#6 β#4" for α), each written by `frc_format_date_term`.
- **One-bit Sun**: SUN is its own screen (LONG is the mode here, not the Sun).
  Its ring's gaps are 1.6 px (3 px on colour): 19 slots share 163 px.
- **A threshold on another civil day** (EARTH): its date with the year and
  the minute (`⊕ 26 JAN 2028 17:07`: `FRC_CIVIL_DAY_MONTH_YEAR` + `MINUTE`),
  not a bare time; on the LENS card it gets a line.
- **Earth wording** (`fui_i_add_civil`, all from `frc_format_civil_text`):
  cards `⊕ THU 8 OCT 2026 · 14:00:00 UTC+2` (DESIGN.md S9's date line; the
  core has no zone names, so the offset), wrapped only at the dot; a
  threshold today `⊕ 14:56:12`; the NOW row of the rectangular faces
  `⊕ 2026-10-08 14:00:00` (`ISO_DATE` + `TIME`: the weekday-and-month form
  is three glyphs too wide for a 20 px row on 240 px).
- **SUN drift** in whole Flavons, `drift −6 235λ` (`frc_format_span_in_unit`,
  cut toward zero; DESIGN.md's mock-up shows −6 236λ, a rounded figure).
- **LENS, length**: `1η light` always; EARTH sets the metres beside it
  (`1η light · ⊕ 5.453 Tm`) and period and frequency under it. The 240 x 320
  face adds the six other media of SPEC S16.3, two to a line.
- **'#' in the dot font is 5 wide**, capitals are used for pure wordings on one
  bit ("1 PER 58 500 BLINKS"); Earth values keep their case (SI prefixes).
- **δ in the dot font** is a hook and a stem over a closed bowl (`.## .#.
  .## #.# .#.`); it differed from ε by two pixels before stage 5.
- **One-bit bottom row**: the count and the brief labels are always the dot
  font at 2 px per dot, centred under the odometer when they fit and
  otherwise ended two columns from the right edge, running left into the
  corner the ring leaves free ("ε NUCLIDE", 70 px). `test_ui` "one-bit
  labels" holds the gaps.
- **A value the core wrote in several words stays on one row**: spans,
  light spans and "in <span>" are joined with U+00A0 (`fui_i_str_keep`), so
  a card wraps "VALLEY / IN 29ι 7λ", never "VALLEY IN 29ι / 7λ".
- **The last rung (ο2)** says "11 in ξ2" and nothing it is "made of": the
  ladder ends there although the core can name a level 63 ("π2").
- **"no band"** (ruling 4) is said on the LENS of every rung outside every
  band (levels 0..12 and 47..62 at the reference interval), in ash. It costs
  the Helion's LENS a second page on the round face in PURE.

- **The 400 x 300 paper face** (design note face-f1 D3; the owner's NOW
  of 2026-11-24, after seeing the first version on glass: "remove the
  rings, leave only the wave and place it in the middle; helion top right,
  preon bottom right, bigger and bolder; epsilon top left, the pentad icon
  bottom left"). NOW is the WAVE (`fui_i_wave`): the hero's two levels
  (the same levels nest as on colour: 2, 3, 6, 10, 11), elapsed solid, to
  come dotted, now a 7 x 7 block in a cleared frame, the inner circle at
  the bezel's place (0.71 R, inside the inward bulges), the two glyphs as
  large as it holds at a whole multiple of 10/3 px per unit (10 px at the
  Helion, 20/3 where the circle is smaller: theta, the nested factors of 5). No counter rings, beads, graduations,
  quarter ticks, carrier or alidade. `fui_i_ring_prepare` sizes R at each
  focus so the ink reaches 146 px (R 114 at the Helion, 98 at theta): 126
  in EARTH, whose civil time ("⊕ 13:57", the dot font at 2 px per dot)
  takes the bottom centre, 6 rows clear of the wave; the wave is a little
  smaller in EARTH for it. The corners (`fui_face_mono400.c`), the 5 x 7
  font at 4 px per dot (28 px capitals, strokes 4 px; no double strike),
  8 px from the edges: the core's terms of the stamp (`frc_format_date_term`):
  the Nuclide as the core writes it, an ordinal in its Delta, "ε#5" (the
  owner wrote "03ε"; the core has no count form for it), the Helion "34η",
  the Preon "29ι", not shown at a step coarser than the Preon. The Pentad's
  mark, bottom left: the reference's pentagon (`reference/js` `ui/pentad.js`,
  its 12-unit box at 60 px, 3 px line) round the core's
  `FRC_PENTAD_NUMERAL` at 3 px per dot ("I", "II", "III"); the Hypopentad's
  empty square; nothing when `frc_pentad_at` fails. Without a reading the
  corners are empty and the centre says why; SCALES' level name and the
  mode word stand at the centre as before. Cards: the whole panel at 2 px
  per dot, 3 blank rows between text rows; the SUN card is the colour card
  at 5/4 (ring r 140); LENS fits one page at the Helion in EARTH; STAMP
  keeps its majors on the first page, 8 rows below the moment. All lines
  The owner saw it on glass and asked for "thicker lines and different font
  maybe": the wave's arcs and the inner circle are 2 px (to come dotted 2
  pixels of the path on, 3 off), the glyph strokes 3 px (2 px read thin
  beside the 28 px corners), the block 9 x 9, the circle 2.5 px clear of the
  arcs' ink. One-bit width comes from the canvas's PEN
  (`fui_canvas_set_pen`: a square stamped at every pixel of the 1 px path,
  so no grey; default 1 px, 1 on / 2 off, so nothing else changed). The
  owner compared three corner types and kept LINE (`fui_font_line`):
  monoline geometric strokes, the counts and the serifed Pentad numeral at
  2 px per dot with a 3 px pen (28 px capitals), the Earth time at 1 px per
  dot with a 1 px pen (14 px); the wave keeps 4 px above the time's cell
  (122 px from the centre in EARTH). A stroke font is a subset
  (`!subset 1`, `!kind strokes` in `tools/genfont.py`: digits, `#`, `:`, I,
  V, ε η ι λ, ⊕), 1.4 kB of flash. Where the inner circle leaves the glyphs
  less than 4/5 of their room at a 10/3 px step (nested factors of 5 in
  EARTH) they go by whole pixels per unit.

**Deviations from DESIGN.md, for the owner to confirm** (made on purpose,
recorded here because the design says otherwise):

- **Words on the 240 x 240 faces.** DESIGN.md S3 says "on 240 × 240 no words
  at all" and S11 "no words, no letters" for the round face. The round NOW
  keeps to that. But SCALES names the level at the centre ("η / HELION", 2.5
  s), a mode toggle names the mode ("⊕ / EARTH", 1.5 s), and the LENS, SUN
  and STAMP cards are text: the design gives the small faces no way to
  inspect a level or read the Sun otherwise. The words under the sign and
  the letter are 1 px-per-dot furniture. To go back to the sign and the
  letter alone, drop `line[1]` in `centre()` (`fui_instrument.c`).
- **One-bit Sun and LONG.** S11: "the Sun ... replaces the count with the
  three-glyph sync odometer on a long press". Here LONG is the mode on every
  face (one rule for every input kind) and the Sun is its own screen, whose
  figure page puts the three-glyph odometer where the count was.
- **One-bit card text at 1 px per dot.** The design's one-bit face has text
  only in the 3 x 5 font at 2 px per dot (the count). The LENS, SUN and
  STAMP cards are written in the 5 x 7 font at 1 px per dot: 7 px capitals,
  about 1.2 mm on a 0.96 inch panel, under DESIGN.md S3's 6.2 pt. At 2 px
  per dot a card would hold about one fact per page. Readable at arm's
  length on the simulator's model; unconfirmed on glass.

## 5. The firmware: how the device runs

```
                      +--------------------- one queue of app_msg_t ---------------------+
 buttons: GPIO irq -> FreeRTOS timer (debounce) -> fhal_button -> INPUT event ---------->|
 encoder: PCNT irq (or GPIO irq + table) ---------------------------> INPUT event ------>|
 console task: blocks in UART read, one line --------------------------> LINE ---------->|   UI task
 Wi-Fi / SNTP in the event loop task: "time was set" ------------------> TIME ---------->|   for (;;) app_step(&app);
                                                                                         v
   app_step:  fui_ui_update(now)  ->  draw (whole frame | bands)  ->  fhal_display_flush(window)
              -> settle settings  ->  xQueueReceive(queue, the UI's deadline less the drawing time)  ->  handle one message
```

- **One task owns the UI.** Only the UI task touches `fui_ui_t`, the frame
  buffer and the display. Everybody else sends a message. Console commands
  run IN the UI task (the console task waits for `line_done`), so a command
  may call any `fui_ui_set_*` directly.
- **The application is portable** (`main/app.c`, `app_console.c`,
  `app_shot.c`): it sees the platform only through `app_port_t` (`main/app.h`).
  `main/app_main.c` implements the port on ESP-IDF, `sim/src/sim_port.c` on
  the host. Put logic in the portable files and it is testable without a
  board (`sim/tests/test_firmware.c`); put only glue in `app_main.c`.
- **Sleeping.** The UI's `sleep_us` counts from the instant it was GIVEN,
  before the draw and the flush; `time_left` (`main/app.c`) takes off what
  they spent (a whole round frame is about 23 ms of SPI), so a change shows
  at its instant and frames at fine focus start `min_frame` apart, not
  `min_frame` + draw time. `info` prints the latest a deadline wake came
  after its instant (`late_max_us`). The simulator's flush moves the clock
  by the modelled bus time (`sim_port.h`), so the tests see this.
  `port_wait` turns the remaining time into queue ticks,
  rounded UP plus one tick: a wake that comes early finds nothing due and the
  UI then sleeps its minimum frame time, i.e. the redraw is 100 ms late. Never
  shorten that rounding. `-1` is `portMAX_DELAY` (time not set: no wake-ups).
- **Drawing strategy = buffer size** (`app_init`). Whole frame: one
  `fui_ui_draw`, then the changed ROWS go out from the frame buffer (full
  width, so they are contiguous). Bands: for the changed WINDOW, a canvas
  exactly as wide as the window is drawn and flushed strip by strip. The
  one-bit face is always whole, flushed in whole pages of 8 rows.
- **The display contract** (`fhal_display.h`): `flush(x0, y0, x1, y1, pixels)`
  gets exactly that window's pixels in the panel's byte layout and returns
  when they are on the wire (it blocks on a semaphore the SPI interrupt
  gives). The first flush lights the panel.
- **Time** (`fhal_time.h`): `fhal_time_now_us()` is `FRC_TIME_NONE` until a
  source has set the clock; who set it is kept in RTC memory beside the RTC
  timer that keeps the time itself across a reset.
- **Settings**: `app_settings_t` (8 bytes: version, mode, focus, screen, UTC
  offset, brightness). A change starts a 5 s settle timer; one NVS write when
  it expires; none if the state came back to what is stored
  (`settle_settings`). The HAL skips a write of identical bytes.
- **Watchdog**: the task watchdog watches the idle tasks. Nothing of ours
  spins, so nothing feeds it; do not subscribe the UI task (it would have to
  wake for that).
- **Stacks**: static, sizes in Kconfig (`FRACTONICA_UI_STACK` 6144,
  `FRACTONICA_CONSOLE_STACK` 3072). The console command `info` prints the
  high-water marks. The 6 kB is about three times the computed need (section 8), because
  it has not been measured on a chip. A new screen with a large local buffer
  moves that need: run `tools/stack-report.py` after adding one.
- **Refresh cap**: `FRACTONICA_MIN_FRAME_MS` → `app_config_t.min_frame_ms` →
  `fui_config_t.min_frame_us` (0: 100 ms colour, 50 ms one-bit).
- **Light sleep** (`FRACTONICA_LIGHT_SLEEP`): tickless idle sleeps whenever
  every task blocks. Buttons then use level interrupts that are also the
  wake-up source (`fhal_input.c`); the console holds a stay-awake lock for a
  minute after each byte (`fhal_console.c`); the encoder and backlight PWM are
  not available; it is not offered with a USB-Serial-JTAG console (Kconfig
  `depends on`). On the C3 / S3 ESP-IDF isolates EVERY pin while the chip
  sleeps (`CONFIG_PM_SLP_DISABLE_GPIO`): each display back end hands its pins
  to `fhal_power_keep_pin` (`gpio_sleep_sel_dis`) so RST, CS, DC, the bus
  and the backlight stay driven; a new display back end must do the same
  (`tools/build-all.sh` checks it on the light-sleep rows). Unverified on a
  chip.

## 6. Recipes

**Add a board** (other pins, same parts): no C changes. Write a defaults file
(model: `configs/*.defaults`) with the `CONFIG_FRACTONICA_PIN_*` values and
whatever else differs, e.g. `configs/myboard.defaults`, and build with
`-DSDKCONFIG_DEFAULTS="sdkconfig.defaults;configs/myboard.defaults"`; add a
PlatformIO environment with the same list in `board_build.cmake_extra_args`,
a row to `MATRIX` in `tools/build-all.sh`, and its wiring table to docs/GUIDE.md.
If the board is THE board of the product, change the per-chip `default` lines
in `main/Kconfig.projbuild` instead.

**Add a display of an existing kind** (another 240 x 240 colour panel on SPI):
a Kconfig choice entry (`FRACTONICA_DISPLAY_...`, and add it to
`FRACTONICA_DISPLAY_SPI`), its name and size in `fhal_board.h`, its face in
`app_main()`. If ESP-IDF has no panel driver for it, write one like
`fhal_panel_gc9a01.c` (implement `esp_lcd_panel_t`, cite the datasheet, static
object) and create it in `fhal_display_spi.c`; add the file in the HAL's
`CMakeLists.txt`. Add a `configs/` file and a matrix row.

**Add a display on another bus or with another pixel layout**: a new back end
file implementing the five functions of `fhal_display.h` (model:
`fhal_display_ssd1306.c`), selected in the HAL's `CMakeLists.txt`. The flush
must return only when the pixels are sent, without spinning. Hand every pin
the back end owns to `fhal_power_keep_pin` after configuring it, or light
sleep on the C3 / S3 lets it float. If the layout is
new, add a canvas format to `fui_canvas.h` (and `tests/test_canvas.c`) and a
`fhal_pixel_format_t`.

**Add a face** (another size): add a `fui_face_t`, a row in `LAYOUTS`
(`fui_paint.c`) and a name in `fui_face_name` (`fui_words.c`). If it is a new
arrangement, write its NOW function beside `fui_face_mono.c` and dispatch to
it in `fui_i_paint` (`fui_ui.c`). Add it to `FACES` in `sim/Makefile`, look at
`make shots`, then `make golden`.

**Add or change a screen**: one `paint` function (see "How a frame is made");
add the enum value, the name, the navigation in `fui_ui_event`, the wake rule
in `fui_i_ring_next` if it has rings or glyphs. Update the map in `fui_ui.h`,
here and in docs/GUIDE.md. (`screen <name>` on the console picks it up from
`fui_screen_name`.)

**Add a console command**: a `command_...` function and a branch in
`app_console_line` (`main/app_console.c`), a line in `command_help`, a check
in `test_console` (`sim/tests/test_firmware.c`), a row in docs/GUIDE.md. It runs
in the UI task: touch the UI freely, print with `app_printf`, never block.
Something only the platform knows goes through a new `app_port_t` function
(implement it in `app_main.c` AND `sim_port.c`).

**Add a setting that is remembered**: a field in `app_settings_t` (keep the
record padding-free and at most `FHAL_SETTINGS_MAX` bytes; bump
`APP_SETTINGS_VERSION` if old records would be misread), its range in
`app_settings_valid`, its value in `app_settings_now`, its use in `app_init`,
its default in `default_settings` (`app_main.c`) from a Kconfig symbol.
`settle_settings` then saves it by itself. Extend `test_settings`.

**Add an input kind**: a Kconfig choice entry, its name / button count in
`fhal_board.h`, its row in the `s_button` table of `fhal_input.c` (which event
a click, a double click and a long press give). The timing rules are in
`fhal_button.c` and tested in `test_buttons`. The UI knows four events only.

**Add a time source**: set the system time, then `fhal_time_mark(source)` (or
`fhal_time_set_us`), then post `APP_MSG_TIME` to the queue (see
`on_time_synced` in `app_main.c`) so the UI task looks at the clock again.

**Add a glyph to a font**: draw it in `tools/fonts/<font>.txt` (both fonts),
`make fonts`, look at it (`tools/genfont.py --preview U+XXXX`), `make test`.
`test_font.c` tells you when the core starts writing a code point no font has.

**Add a theme** ("tablet", design/README.md): one more `const fui_theme_t` in
`fui_theme.c`; pass it in `fui_config_t.theme`. No face holds a colour literal.
A one-bit theme is ground one bit value, every ink the other (`fui_theme_mono`,
`fui_theme_paper`): which is dark is the panel's.

**A drawing changed on purpose**: `make shots`, look, `make golden`, `make
pictures`, commit `sim/golden/hashes.txt` and `docs/` with the change.

## 7. Tests: what each proves

| Program | Holds |
|---|---|
| `test_raster` | `fui_isqrt`, `fui_sin`; a one-bit full circle equals the midpoint circle pixel for pixel; 1500 random one-bit arcs: every pixel within half a pixel of the true curve, no gap, 8-connected, thin, dotted = every third pixel, two parts tile the whole; colour arcs against 16 x 16 supersampling (worst pixel ≤ 0.30, mean ≤ 0.05, ink = length x width); lines, discs, strokes against geometry; **discs and rings up to 249 px** (one bit: exactly the pixels whose centre is inside; colour: ink against area and length); clipped drawing = unclipped inside the clip, nothing outside |
| `test_canvas` | the four memory layouts bit by bit, blending, clip, dirty box, band rendering |
| `test_font` | 520,265 texts from the core's format functions (all 63 levels, both modes' wordings, every Pentad form, every civil form, date terms, signed counts, spans in Flavons, 3,001 instants across the catalogue; core 0.2.0's `<0.001ν` of either sign and a negative civil year, `−0044`, in every civil form): every code point (115 distinct) has a glyph in both fonts; UTF-8 decoding of damaged input; widths; the missing-glyph box |
| `test_ui` | the navigation map, timers, vector A in the model, the frame contract (first / idle / wake / never zero sleep), partial redraw = full redraw, bands = whole, time not set, out of catalogue, clock set backwards; **geometry**: no cached arc reaches inside `reach_in` or outside `reach_out` on any colour face at any focus, which levels nest (2, 3, 6, 10, 11), the one-bit quarter ticks are pixels 9..12 on each side of the centre pixel; **cards**: every LENS card (63 levels), SUN and STAMP fits its face and the line table in both modes at vectors A, B, C, time not set and out of catalogue, and EARTH has at least the lines PURE has; **quiet lines**: a UI that sleeps as long as its frame allows shows, at each of 800 Blink boundaries, the lines a UI that looked then would show (LENS levels 0..12 and SUN, both modes, from A, B, C, two minutes before a civil midnight and a random instant), and it does sleep (fewer than 130 wakes where polling takes 800); **words**: the SUN and LENS countdowns at 64 instants on every face: the core's span text stands whole on one row; the last rung names nothing below the ladder and is "made of" nothing; every rung outside every band says "no band" and no other does; **one-bit labels**: every level's name and both mode words in the dot font at 2 px per dot, ink ≤ column 125 and ≥ 2 columns from the ring's; **step**: the setter takes 0 and 6..10 only; on every face, at every step level from vectors A, B, C, the instant shown is the cycle's start and each wake its end, 12 boundaries in a row, none between (a unit step redraws the readings at each); no NOW, SUN or STAMP row of any face counts in a unit finer than the step's (focus 0..13, four instants); the paper face's corners at the Preon, the Flavon and the Helion step (no ι at the Helion's), "⊕ 13:57" / "⊕ 13:59:58"; the shim's cut ("7ι" from the step's start, "6ι" / "6ι 43λ" from vector A, "0ι" under a Preon, the Blink unchanged); a label still shows and clears on time and input redraws at once; **wave**: at every focus in both modes and six instants, the paper face's wave is centred at (199.5, 149.5) and reaches its goal (146 px; 122 in EARTH) within a pixel, and every corner's cell, the Pentad's mark and EARTH's time lie more than 2 px outside it; **paper font**: the corners' texts at 2,000 instants have every glyph in the line font; **paper**: the 400 x 300 face in MONO_ROW, every screen and both modes, time not set, out of catalogue: ground all set bits, ink in clear bits, MONO_ROW = MONO_PAGE, 40-row bands = whole, `fui_theme_mono` the exact inverse |
| `test_golden` | 190 scenes against `golden/hashes.txt` (the 400 x 300 paper face: every scene of the others, focus 0..13, NOW / SCALES / cards at the Preon, the Flavon and kappa step, Pentad III and the Hypopentad), among them the review's: the SUN card at Unix 1700000000 (a two-part span), the LENS of the last rung, one-bit "ε NUCLIDE" and "δ#5 ε#2"; since stage 6 the LENS of the Flavon ("1 per 25 Blinks"), of mu in EARTH ("1 per 5 Blinks") and of Alpha in EARTH (a threshold on another day, "⊕ 26 JAN 2028 17:07") |
| `test_firmware` | `main/app.c`, `app_console.c`, `app_shot.c` and `fhal_button.c` against the simulated port: an idle hour at the Helion wakes 100..200 times, every wake a deadline and a redraw (whole frame, 40-row bands, wakes 2 ms late); focus 2 does not wake; focus 13 is held to 10 wakes a second; in whole-frame mode the panel model equals the frame buffer after a 15-event session on every face and mode, and band rendering (40 / 16 / 1 rows) leaves the same panel; **each deadline wake comes exactly at the instant the UI named although a whole frame takes 23 ms of simulated bus** (and `late_max_us` reports the port's lateness, 1,700 us when the port is 1.7 ms late); focus 13 starts 590..600 frames a minute; time not set = no wake for an hour, then `time` gives vector A's stamp; `time` refuses instants beyond ±1e11 s (one second after `time 9223372036854` int64 microseconds overflowed) and takes the limit itself; every console command and its refusals; `shot` decodes to the panel's pixels and a damaged copy is refused; ten changes in two seconds are one save after the settle time, a round trip is none, a stored record restores the state; what buffers `app_init` accepts; click, long, double click, bounce, counter wrap |
| `test_fuzz` | built with `-fsanitize=address,undefined -fno-sanitize-recover=all` over the UI library and the core: 15,000 random canvases (four formats, any origin and clip) with every primitive, sizes up to and past the limits and segments over the whole int16 range: nothing outside the clip changes; 300 random UI sessions on every face, whole and banded, at instants anywhere (catalogue edges, ±int64 ends, not set), with random steps (valid and refused); the one-bit pen at random widths and dash patterns, out of range too: sleep is -1 or ≥ 0, the wake instant never lies in the past. Any overflow, negative shift or out-of-bounds access stops it |
| `check-noheap` | no object of the UI library, the application's portable files or the button logic references malloc / calloc / realloc / free |

## 8. Measured

docs/GUIDE.md, "Memory, size and wake-ups", has the tables and how each figure was
obtained. The ones an agent needs at hand (stage 5, sizes, stack and card wakes re-measured in stage 6, image and flash sizes again with core 0.2.0; ESP-IDF 5.5.1, gcc 14.2.0,
`-Os`):

| What | Figure | Command |
|---|---|---|
| Image, default build | ESP32 325,243; S3 355,287; C3 337,046 bytes (core 0.2.0; stage 6: 324,739 / 354,799 / 336,378) | `tools/size.sh` |
| Our code in it (core + UI + HAL + main) | 64.5 / 64.9 / 74.9 kB of flash (core 0.2.0: the core grew 0.46 / 0.46 / 0.65 kB; stage 6: 64.0 / 64.4 / 74.2; stage 5: 61.7 / 62.2 / 71.6: the core's new text functions; the UI library shrank by 0.4 kB) | `tools/size.sh` |
| Core / UI library RAM | **0 / 0** in all eleven builds; tables in `.flash.rodata` | `tools/size.sh` (fails otherwise) |
| UI library alone | 33,887 bytes (xtensa), 35,772 (riscv32), fonts 3,512 of it; `.data` + `.bss` 0 | `make sizes` |
| `fui_ui_t` | 1,552 bytes on the chips: ring cache 1,200 (98 arcs x 12), reading 172 | `make sizes` |
| Static RAM, default build | ESP32 139,796; S3 193,271; C3 195,420: frame 115,200 + UI stack 6,144 + console stack 3,072 + `app_t` 1,744 + about 1,400 | `tools/size.sh` |
| Frame buffers | 240 x 240: 115,200; 240 x 320: 153,600; a 40-row band: 19,200; one-bit: 1,024 | `make info` |
| UI task stack, static worst chain | 2,304 bytes (xtensa, 19 frames), 2,128 (riscv32, 19): the SUN countdown's `frc_span_next_change` (stage 5: 2,080 / 1,952); largest frames SUN 464, LENS 448, `fui_glyph_draw` 448 | `tools/stack-report.py -v` |
| … high-water mark on the HOST (arm64) | stage 5: 2,560 bytes for a session through everything; 1,908 drawing alone. Stage 6: 2,384 for a shorter session (LENS, SUN in both modes, STAMP, `stamp`, `info`, `shot`); the full session was not re-run | `fractonica-fwsim --stack --script …` |
| … configured | `FRACTONICA_UI_STACK` 6,144: about three times the need, until a board says | Kconfig |
| Full redraw, round NOW at the Helion | 57,600 px cleared, 11,543 inked; 166 arcs, 41 lines, 25 discs, 3 rings, 2 glyphs; 0.31 ms on the host | `make stats` |
| Per-Blink redraw, rectangular NOW | 240 x 10 px, 3 to 5 text lines, no instrument walk | `make stats` |
| Wake-ups per hour, round / one-bit NOW | focus 0..3: 0; 4: 4; 5: 33; **6: 153**; 7: 912; 8: 9,120; 9+: 35,643 (one-bit 45,601, then 70,588): the refresh cap | `make wakes` |
| Wake-ups per hour, rectangular NOW | 11,578 (focus 0) to 35,643: the reading shows Blinks | `make wakes` |
| Wake-ups per hour, cards at the Helion | LENS 2,190 (stage 5: 2,953); SUN 51 (EARTH 3,650; stage 5: 65 / 3,664); STAMP 11,580 (EARTH 15,156); time not set 0. Every LENS / SUN wake is a redraw: the countdown wakes when `frc_span_next_change` says | `fractonica-fwsim --script "screen sun" --brief` |
| When a wake comes | exactly at the UI's instant on the host model, with 23 ms of simulated SPI per whole frame (it came 23 ms late before stage 5) | `test_firmware` |

Not measured, because it needs a chip: redraw and flush time, the stack
high-water marks, the heap (docs/GUIDE.md gives estimates from the maps: about 155 /
130 / 110 kB free after start-up on ESP32 / S3 / C3 with the whole frame).

## 9. Common mistakes

- **Passing a depth where a level is meant.** Focus 6 is the Helion (depth 7).
- **Formatting a number yourself.** Use `frc_format_count` and friends through
  `FUI_I_CORE(&s, frc_format_...(…, at_, room_))`.
- **Drawing text with `fui_text_draw` in a screen.** The line is then not
  hashed and a partial redraw leaves it stale.
- **Reading the core for a ring inside a paint function.** Use `ui->reading`.
- **Editing `fui_font_*.c`.** Edit the art, run `make fonts`.
- **Refreshing the golden hashes without looking at the pictures.**
- **Pixel centres.** Pixel (x, y) has its centre at (x + 0.5, y + 0.5):
  `FUI_FX(31.5)` is the middle of pixel 31. Glyph origins on the one-bit face
  must end in .5 or the stems fall between columns.
- **Radii of 250 px or more** are not drawn (the square of a Q8 distance must
  fit 32 bits unsigned): fine for these displays, not for a larger one.
  Square magnitudes as `uint32_t`, never `px * px` on `int32_t` (that
  overflows from 181 px: discs once inked wrong pixels there).
- **Shifting a negative value** (`dy << 16`): undefined in C. Multiply.
  `make test` runs the fuzz under UBSan, which stops at the first one.
- **Formatting a span into a card line without `fui_i_add_span`**: a card
  then may wrap inside it ("29ι" / "7λ").
- **Putting firmware logic in `app_main.c`.** It cannot be tested there. If
  it decides something, it belongs in `app.c` / `app_console.c` behind
  `app_port_t`.
- **Waking early.** A wait shorter than what is left of `sleep_us` (rounding
  ticks down, a periodic "just in case" wake) makes redraws late, not early:
  the UI clamps the next sleep to its minimum frame time. Waiting the whole
  `sleep_us` AFTER drawing is the opposite mistake: every change a draw late.
- **Comparing the panel with a fresh draw at the present instant.** Between
  two redraws the glass keeps what was drawn while the UI's clock moves on
  (live text is checked on Blink boundaries). Tests compare with the frame
  buffer, or right after a full redraw (`test_firmware.c`).
- **Returning from a flush before the pixels are sent.** Band rendering
  reuses the buffer immediately.
- **Touching the UI from another task.** Post an `app_msg_t` instead.
- **A pin number or a CONFIG_FRACTONICA_PIN_* outside `fhal_board.h`.**
- **Calling a blocking function in a FreeRTOS timer callback or in the event
  loop** (`fhal_input.c`, `fhal_net.c`): queue sends there use timeout 0 or a
  short bound.
- **Editing a `configs/` file and rebuilding an existing build directory.**
  Defaults apply only when `sdkconfig` is created: remove `build/<name>`.
- **Hosts and float.** Golden hashes need `-ffp-contract=off` (the Makefile
  sets it); a build that fuses multiply-add moves arcs by a sub-pixel.

## 10. Core requests

What the UI had to work around, and what became of it. Every request of
stages 1 to 5 has been answered by the core (stage 6), and every stand-in
was replaced by the core's call and DELETED, as was the word picker
`fui_i_word`. If the core lacks something again, add a row here with the
exact signature wanted, and only if you cannot proceed a stand-in in
`src/fui_shim.c`.

**Open (the step, FACE-1 D4):**

| Wanted | Why | Stand-in until then |
|---|---|---|
| `int frc_format_span_to(const frc_span_t *span, uint8_t max_parts, frc_unit_t finest, char *buf, size_t size)`: `frc_format_span` with no part finer than `finest`, the span cut toward zero to whole `finest` units; under one of them `"0"` + its symbol ("0ι"). (Optional with it: `frc_span_next_change_to(cat, t, boundary, max_parts, finest)`, the instants that text changes; a face with a step does not need them, it wakes at the step's boundaries.) | A face that moves once a Preon must not write "6ι 43λ": `frc_format_span` limits the NUMBER of parts, not the finest one; `frc_format_span_in_unit` writes one unit only | `fui_shim_format_span_to` (`src/fui_shim.c`): cuts `span->blinks` to a multiple of `frc_unit_blinks(finest)` (fraction dropped) and lets `frc_format_span` write it (the ladder's units divide one another, so the finer parts are zero and left out); under one unit `frc_format_span_in_unit`; `FRC_UNIT_BLINK` is `frc_format_span` unchanged. Used by `fui_i_add_span_to` (countdowns: the rectangular faces' NOW rows, LENS, SUN) |

| Was wanted | Answered by the core with | Where the UI uses it now |
|---|---|---|
| the kind of a level in words | `frc_format_level_kind` ("major", "unit", "between", "sub-Blink") | LENS identity line (was SHIM `fui_shim_kind_word`) |
| the running Helion's place in the sync | `frc_sync_t.helion` (0..18) | `read_sun` (`fui_model.c`), the lit slot of the Sun's ring (was SHIM `fui_shim_sync_place`) |
| where the Pentads begin | `frc_pentad_t.first` (0, 5, 10, 15) | `pentad_starts` (`fui_ui.c`), the wider gaps of the Sun's ring (was SHIM `fui_shim_pentad_starts`) |
| "no band" for a rung outside every band | `frc_format_band(FRC_BAND_NONE)` writes "no band" | LENS wave part (was SHIM `fui_shim_format_band`) |
| a slice of the date | `frc_format_date_term`, one term; the UI joins them with spaces (`fui_i_add_date_terms`) | NOW reading row, one-bit count, STAMP's two halves (were words picked by position from `FRC_DATE_LETTERS` with `fui_i_word`) |
| when a countdown's text next changes | `frc_span_next_change` | `fui_i_span_until(p, boundary)`: LENS and SUN countdowns sleep until exactly then (was an estimate from `frc_span_parts`, one Blink early, then a look every Blink: up to 3/4 Blink late) |
| the Earth line in words | `frc_format_civil_text` (forms TIME, MINUTE, DATE, OFFSET, DAY_MONTH_YEAR, ISO_DATE) | `fui_i_add_civil` (was the ISO text of `frc_format_civil` cut at 'T' and '.') |
| the drift in one unit | `frc_format_span_in_unit(…, FRC_UNIT_FLAVON)` | SUN "drift −6 235λ" (was `frc_format_span`: "−2η 23ι") |
| a signed count | `frc_format_count_signed` | SUN's sync number; `stamp` on the console (was a minus written by the UI before `frc_format_count`) |
| "11 in ζ", "made of 9 θ" | `frc_format_level_in_parent`, `frc_format_level_children` | LENS (was `frc_format_count` + " in " + a level name, composed here) |

Core 0.2.0 functions this client does not call, and when it would have to:

| Core | Why not here (yet) |
|---|---|
| `frc_span_next_change_since(cat, origin, t, max_parts)` | every span on a face is a countdown BEFORE its boundary (`fui_i_span_until`, `frc_span_next_change`). A face that shows an elapsed time, or a signed span that runs past zero, must sleep on `frc_span_next_change` before the boundary and on `frc_span_next_change_since(boundary, now)` from it on |
| `FRC_PREFIX_FACTORS_SIZE`, `frc_format_prefix_factors` | no face writes the prefix and factors of a level |
| `frc_parse_civil` | the console's `time` takes Unix seconds (`word_number`), no civil text |
| `FRC_CIVIL_OFFSET` refuses \|offset\| ≥ 86,400 s ("" and `FRC_ERR_ARG`) | the clock's offset is held to −720..840 minutes (Kconfig `range`, `utc`, `app_settings_valid`), so its Earth lines always carry the zone. `fractonica-sim --utc-offset` takes any seconds: past ±24 h the card's zone is simply left out |

Still the UI's own, and not a stand-in for anything the core says:

| What | Why it stays here |
|---|---|
| `fui_i_str_keep`: the spaces of one value made U+00A0 so a card never wraps inside it | typesetting, not formatting. (Optional request, unchanged: spans written with U+00A0 between their parts, as grouped numbers already use U+202F, would make it unnecessary.) |
| furniture words ("solar sync ", "drift ", "depth ", "made of ", "Time not set", "Out of catalogue") | the face's own labels (rule 1) |
| `fui_i_next_midnight` | when a civil day ends at the configured offset: Earth arithmetic done by the core's `frc_civil_from_time` / `frc_time_from_civil` |

## 11. Verified, not verified, and what comes next

**No shim is left** (stage 6). The core answered every request of section
10; `src/fui_shim.c` (`fui_shim_kind_word`, `fui_shim_sync_place`,
`fui_shim_pentad_starts`, `fui_shim_format_band`), the word picker
`fui_i_word`, the countdown estimate in `fui_i_span_until`, the ISO cutting
in `fui_i_add_civil` and the hand-written minus of the sync number are
deleted, not bypassed. Every number, name and Earth text on a face is now a
core call; what the UI still does itself is listed at the end of section 10.

**FACE-1 (2026-11-24): the step and the 400 x 300 paper face** (design note
`../docs/design/face-f1.md` D3, D4; for the framework's e-paper, ESP-IDF 6.1).
Added `fui_ui_set_step` / `fui_config_t.step`, `FUI_FACE_MONO400X300` (4;
`FUI_FACE_COUNT` 5; "mono400x300"), `fui_theme_paper`, one-bit branches in
the colour instrument, the ring and the SUN card (per-face fields `tiny`,
`wave_reach`, `wave_reach_earth`, `sun_r`, `sun_u` in `fui_layout_t`), and
the shim of section 10. The same day the owner saw it on glass and asked
for the NOW of section 4's decisions (the wave and the corners:
`fui_i_wave`, `fui_face_mono400.c`, `fui_i_mark`, the ring fitted to its
room); only that face's 31 NOW-screen golden scenes and 9 pictures changed. Without a step nothing changes
on the other faces: the 140 golden scenes they had and the 52 pictures in
`docs/` came out byte for byte the same; the standalone app's page flush
now ends at the face's last row (a 300-row one-bit face is not whole
pages). Verified (macOS, Apple silicon), with the thick lines and the line
font: `make test` (ui 1,980,756 checks, golden 190 scenes, firmware
1,010, fuzz 22,200 with random steps and pens, no-heap 29 objects; the 140
golden scenes of the other faces unchanged); the 50 new scenes and the 14 new pictures
(`docs/mono400x300-*.png`) looked at; the library compiled with ESP-IDF
6.1's riscv32-esp-elf-gcc 15.2.0 `-std=gnu99 -Wall -Wextra -Werror`, every
file, no warning. Not verified: anything on glass (line weight, the 7 x 7
block, the dot font's legibility on paper are the bench's).

**Core 0.2.0 (the core's verification round): what it changed here.**
Nothing on a face: `make test` passed from clean with every one of the 140
golden scenes unchanged, and the LENS / SUN / STAMP shots were looked at
again against `sim/build/probe` (drift `−6 235λ`, Node in 2η 24ι, the
kind `UNIT` in the LENS identity line). Why each change of the round leaves
the pictures alone:

- Negative civil years now carry U+2212: the catalogue (Saros 141) starts
  in 1613, so no face writes one; the fonts have U+2212 anyway, and
  `test_font` now sees the new texts (`THU 15 MAR −0044` etc.).
- A span under 1/1000 Blink is `<0.001ν` (either sign): a countdown can
  show it in the last instant before its boundary; `<` is in both fonts and
  `test_font` sees it.
- `FRC_CIVIL_OFFSET` refuses ±24 h and more: the clock's offset range is
  −720..840 minutes (section 10, last table).
- `frc_parse_civil`, `frc_span_next_change_since`, `FRC_PREFIX_FACTORS_SIZE`:
  not called here (section 10, last table).
- Lead's rulings for every client: the SUN drift is
  `frc_format_span_in_unit(drift, FRC_UNIT_FLAVON)` (already so since stage
  6); a level's kind is the core's `frc_format_level_kind` word, in capitals
  where the face engraves capitals (Greek letters keep their case): already
  so; two comments that said "minor unit" now say "units"
  (`fui_screen_now.c`, `fui_screen_stamp.c`).
- The boot log and `info` print `core 0.2.0` (from `FRC_VERSION`); the
  clock's own `APP_VERSION` stays 0.1.0.

Verified with core 0.2.0 (macOS, Apple silicon, ESP-IDF 5.5.1): `cd sim &&
make clean && make test` (font 6,795,158 checks over 520,265 core texts, ui
1,955,189, golden 140, firmware 943, fuzz 22,200, no-heap 26 objects, fonts
up to date); `make shots` (looked at: the LENS and SUN cards of the 240 x 320,
round and one-bit faces) and `make pictures` (52 pictures in `docs/`); `tools/build-all.sh` (eleven rows ok, 0
warnings; not `--clean`, not `--pio`); `tools/size.sh` (all checks passed;
section 8). `make matrix`, `make wakes`, `make firmware` and `make stack`
were not re-run in this round.

**Stage 6: what the core's new outputs changed here** (all looked at, then
`make golden`; 12 new golden scenes):

- LENS of the Flavon and of mu: "0.04 pB" / "0.2 pB" became "1 per 25
  Blinks" / "1 per 5 Blinks" (the core's change; no test literal held them).
- SUN: drift "−2η 23ι" became "−6 235λ" (now `frc_format_span_in_unit`); the
  civil line "⊕ 2026-10-08 · 14:00:00 +02:00" became "⊕ THU 8 OCT 2026 ·
  14:00:00 UTC+2" (also STAMP). On the colour faces the EARTH SUN card now
  fits one page (it had two): `test_ui` "navigation" walks the encoder through
  the one-bit SUN instead (always two pages), `test_firmware` "a card's
  pages" expects "page 1 of 1".
- A threshold on another day: "⊕ 2028-01-26 17:07" became "⊕ 26 JAN 2028
  17:07". The NOW row of the rectangular faces keeps "⊕ 2026-10-08 14:00:00"
  (ISO_DATE + TIME from the core).
- Unchanged, checked by the golden hashes: NOW, SCALES, the stamp (rebuilt
  from date terms), "no band", "11 in ζ · made of 9 θ", the light span.
- The new struct fields (`frc_sync_t.helion`, `frc_pentad_t.first`) are read
  by name; nothing here builds those structs field by field.

**Verified in stage 6** (macOS, Apple silicon, ESP-IDF 5.5.1):

- `cd sim && make clean && make test`: every program of section 7 passes
  (font 6,795,009 checks over 520,249 core texts, ui 1,955,189, golden 140,
  firmware 943, fuzz 22,200 under ASan + UBSan, no-heap 26 objects).
- `make shots` (58 pictures + focus sweeps + states), every changed golden
  scene in `out/golden-diff/` and contact sheets of all four faces opened and
  read against `sim/build/probe` (sync 4 820, slot 6 = Helion 7 of 19,
  Pentad II from slot 5, drift −6 235λ, Node in 2η 24ι; Earth "THU 8 OCT
  2026 · 12:00:00 UTC" at offset 0); then `make golden`, `make pictures`.
- `make wakes`, `make firmware`, the cards with `fractonica-fwsim --script
  "screen lens|sun|stamp"`: section 8.
- `tools/build-all.sh --clean`: all eleven rows ok, 0 warnings. PlatformIO
  (`--pio`) was not re-run in stage 6.
- `tools/size.sh`: all checks passed (core and UI library 0 bytes of RAM in
  all eleven builds, tables in `.flash.rodata`); `make stack`: section 8.

**Verified in stage 5** (PlatformIO Core 6.1.18 too, from removed build directories):

- `tools/build-all.sh --clean --pio`: the eleven `idf.py` builds of section 3
  and `pio run -e esp32-gc9a01`, no warning anywhere; the three Wi-Fi rows
  rebuilt from clean once more with `configs/ci-wifi.defaults` (see section 3).
- `tools/size.sh`: section 8; core and UI library 0 bytes of RAM; tables in
  `.flash.rodata`.
- `cd sim && make clean && make test`: everything in section 7, the
  sanitizer fuzz included.
- By eye: `tools/render-matrix.sh` (949 pictures), every one opened on
  contact sheets at the display's own resolution, against `sim/build/probe`
  and SPEC S12 (syncs 4 820, 2 375, 7 987; Pentad II, Hypopentad, Pentad III).
- The firmware loop on the host, whole frame and bands, with a console
  session and a `shot` decoded by `tools/shot.py`.

**Stage 5: the review findings** (each fixed one has a test or a golden scene):

| Finding | Verdict |
|---|---|
| Light sleep on C3 / S3 lets the display's pins float | fixed: `fhal_power_keep_pin` on every display pin; Kconfig `depends on !ESP_CONSOLE_USB_SERIAL_JTAG`; C3 and S3 light-sleep rows in the matrix, which also check the HAL calls `gpio_sleep_sel_dis` |
| Sleep measured from before the draw and flush | fixed: `time_left` in `main/app.c`; the simulated flush takes bus time; `test_firmware` checks every wake lands on the UI's instant; `info` prints the latest wake |
| Rasteriser overflows above 181 px | fixed at the root (unsigned squares, 64-bit sum in the disc, 64-bit products in the stroke); `test_raster` "large radii"; `test_fuzz` under ASan / UBSan in `make test` |
| Left shift of a negative value in every AA line | fixed (a multiply); caught by `test_fuzz` |
| `time` accepts instants that overflow int64 µs | fixed: `time` takes ±1e11 s; `fhal_time_now_us` refuses unrepresentable seconds; `fui_ui_update` guards `now + sleep`; tests in `test_firmware` and `test_fuzz` |
| Wi-Fi placeholder credentials, any security mode | fixed: empty defaults, no start without a name, WPA2-PSK threshold with a password |
| `stack-report.py` took the newest compiler | fixed: PATH or ESP-IDF's tools.json version, printed; `size-report.sh` likewise |
| Backlight 1..3 % was off | fixed: at least duty 1 |
| `_Static_assert` in `app_main.c` | fixed: `APP_CHECK` (C99); `fractonica_ui` built `-std=gnu99` under ESP-IDF too |
| Two undeclared shims | real (a reporting fault): declared in section 10 with exact requests |
| Span split across rows on the SUN card | fixed: `fui_i_str_keep` / `fui_i_add_span`; `test_ui` "words"; golden `*-sun-valley-span` |
| LENS of ο2 names π2 | fixed; `test_ui` "words"; golden `*-lens-last-rung` |
| Docs navigation contradicted the code | fixed: docs/GUIDE.md (then README.md) and section 4 carry fui_ui.h's map |
| "no band" not shown | fixed through the declared shim `fui_shim_format_band` |
| Words on 240 x 240 faces against DESIGN.md | recorded as deviations for the owner (section 4); behaviour kept |
| One-bit legibility (δ ~ ε, edge, size switching, 1 px/dot cards) | δ redrawn; labels always the dot font, 2 columns from the edge and from the ring (`test_ui` "one-bit labels", golden `mono-scales-nuclide`, `mono-delta-epsilon`); 1 px/dot card text recorded as an owner decision |
| Doc numbers and references | fixed: face table, 2.3 px nesting, `fui_glyph.c` / `fui_glyph.h` references |

**Fixed in stage 3** (each has a test or a golden scene):

- Second-level arcs crossed the bezel and the first two counter rings at
  focus 2, 3, 7, 10, 11 (the ring's reach counted the first level only); at
  theta they ran into the odometer. Reach now covers both levels; theta draws
  one level.
- The one-bit quarter ticks at 3 and 6 o'clock sat one pixel further out than
  those at 9 and 12.
- EARTH replaced Fractonica lines (LENS: the light span by metres; one-bit
  SUN: the drift by the civil time). It adds now, beside or under.
- A threshold days or years away was translated as a bare time of day.
- The Earth tail of a mixed line was drawn in bone and, on one bit, folded to
  capitals (`Tm` → `TM`).
- LENS and SUN were re-formatted every Blink for texts that change every
  Flavon or Preon; the SUN's civil line was looked at every Blink as well as
  every second.
- The per-Blink text redraw of the rectangular faces walked the whole
  instrument to have it clipped away.
- `tools/build-all.sh --clean` left PlatformIO's build and sdkconfig, which
  fail on a new Kconfig option.

**Verified on hardware, 2026-11-13:** the ESP32-C6 + GC9A01 build
(`configs/esp32c6-gc9a01.defaults`) boots and draws the clock; the owner
confirmed the GC9A01's colours and orientation on glass. Nothing was
measured on the chip.

**Not verified** beyond that one run (ESP-IDF's QEMU not installed:
`~/.espressif/tools/qemu-xtensa` is an empty directory, no
`qemu-system-xtensa` / `qemu-system-riscv32` on the PATH). **Nothing has
executed in an emulator, and only the run above on silicon:**

- Booting on any chip but the ESP32-C6. The C6 run exercised boot and the
  GC9A01 path of `components/fractonica_hal` and `main/app_main.c`; nothing
  of it was measured, and the other paths have only been compiled and linked.
- The GC9A01 init sequence on any board but that C6 (colour order and
  orientation are confirmed there only); the colour order, inversion, mirror
  and rotation defaults of the ST7789 and SSD1306; the ST7789's 80-row offset rule; SPI at 40 MHz on wires.
- PCNT limits as detents, the GPIO encoder table on real contacts, debounce
  times; NVS; the RTC keeping time and `RTC_NOINIT_ATTR` across resets;
  Wi-Fi / SNTP; light sleep (wake-up sources, the UART lock); stack and heap
  figures; redraw and flush time; `tools/shot.py --port`; the PlatformIO
  environments other than `esp32-gc9a01`.
- Light sleep on the C3 / S3 with the display's pins kept: built and linked
  (the matrix checks the call), never seen on a panel. Whether the GC9A01 /
  ST7789 keep their picture through every sleep is the first thing to watch
  on such a board (docs/GUIDE.md "Bring-up checklist", step 12).

**First hour with a board**: docs/GUIDE.md, "Bring-up checklist", step by step
(expected boot log, what to change for each wrong picture, `info`, `time`,
`shot` against the simulator, input, persistence). Then move the claims up.

**For the next stages**

- **Row-level flushing.** On the round face a ring change redraws and sends
  the whole frame (115 kB, about 23 ms of SPI at 40 MHz), ten times a second
  at fine focus. If that matters, hash rows of the frame buffer in
  `draw_whole` and send only rows that changed.
- **NOW-row countdown** on the rectangular faces is looked at every Blink
  (it is LIVE) and does not also wake at `frc_span_next_change`'s off-grid
  instants: measured, that would add 21 / 147 / 6,892 wakes an hour at focus
  6 / 7 / 8, for a text at most one Blink behind. One line to change
  (`countdown_row`, `fui_screen_now.c`: pass the painter) if the owner wants
  it exact there too.
- **Dark engraving on real glass.** `etch-2` (#262D36) and the empty Sun
  slots (#2A2616) are near the black level of small IPS panels; the theme is
  one table (`fui_theme.c`) if they need lifting.
- **Layout decisions awaiting the owner** (section 4, "Decisions DESIGN.md
  left open"): theta without a second level, the counter rings that drop off
  at fine focus, R staying 56 at coarse focus, the media rows of the tall
  LENS, the date form of a far threshold.
- **Brightness / sleep policy.** `fhal_display_sleep` exists and is not used:
  dimming or blanking after a time without input is product behaviour to
  decide (nothing may blink or pulse).
- **A real-time clock chip or a battery** would let the clock survive a power
  cut; today it then shows TIME NOT SET until told.
- **Credentials** are build-time (Kconfig), empty by default: then Wi-Fi is
  not started and the log says "no Wi-Fi network configured". With a
  password the station refuses anything weaker than WPA2-PSK. A
  `wifi <ssid> <password>` console command storing them in NVS would let one
  binary serve many networks.
