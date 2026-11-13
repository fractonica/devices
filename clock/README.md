# Fractonica clock for ESP32

Firmware for a small physical Fractonica clock: an ESP32 with a small display, plus a host simulator.
It lives in `clock/` of the [devices](https://github.com/fractonica/devices) repository as a standalone ESP-IDF 5.5 project.
Stage 5 of the merge plan folds it into the device framework at the repository root, on ESP-IDF 6.1.

![Three faces of the firmware drawn by the host simulator at 2026-10-08 12:00 UTC:
on the left the round 240 x 240 face in pure mode, a ring of nested teal arcs
with two phase glyphs at the centre; in the middle the 240 x 320 face in earth
mode, the same ring above the reading ε#5 34η 29ι 21λ 3ν, a countdown and the
civil time 2026-10-08 14:00:00 led by ⊕; on the right the 128 x 64 one-bit face
with a dotted ring, two glyphs and 34η 29ι.](docs/hero.jpg)

*The round GC9A01, the 240 x 320 ST7789 and the one-bit SSD1306 faces at SPEC test vector A (2026-10-08T12:00:00Z), rendered by the host simulator (`sim/`).*

## What it is

Fractonica is an eclipse-anchored harmonic clock. Its anchor is the solar Saros series 141.
It counts time in nested cycles, from the Alpha (about 72 years) down through the Helion to the Blink,
and draws them as nested alternating arcs with phase glyphs.
This firmware shows the present as a ring of nested alternating arcs with a phase-glyph odometer at its centre.
You can step through the cycles, read a card about one of them and read the Sun. It has two modes: PURE shows only Fractonica units, and EARTH adds the Gregorian and SI translation beside them, marked ⊕.
All clock arithmetic and text come from the shared C core.
The same clock runs in the browser at [fractonica.com](https://fractonica.com).

## The Fractonica repositories

| Repository | What it is |
|---|---|
| [core](https://github.com/fractonica/core) | The clock itself: a dependency-free C99 library, and the specification |
| [ios](https://github.com/fractonica/ios) | A SwiftUI app for iPhone, iPad and Mac, built on the core |
| [web](https://github.com/fractonica/web) | The core as WebAssembly and the clock as a static site, live at [fractonica.com](https://fractonica.com) |
| **[devices](https://github.com/fractonica/devices)** (this clock is its `clock/`) | The device framework (firmware, hub, CLI) and this clock firmware with its host simulator |

## Quick start

Clone the core beside the devices repository. From `clock/` the build finds it at `../../core`.

```sh
git clone https://github.com/fractonica/core.git
git clone https://github.com/fractonica/devices.git
```

Try it without hardware. Only a C compiler is needed.

```sh
cd devices/clock/sim
make test           # unit tests, golden images, firmware loop, fuzz under ASan + UBSan
make shots          # every face, screen and mode -> sim/out/*.png
cd ..
tools/simulate.sh --face round240 --screen now --mode pure --out now.png
```

Build and flash with ESP-IDF 5.5, from `clock/`. The board it has run on is an ESP32-C6 with a round GC9A01:

```sh
source ~/esp/v5.5.1/esp-idf/export.sh
idf.py -B build/esp32c6 -DIDF_TARGET=esp32c6 -DSDKCONFIG=build/esp32c6/sdkconfig \
       -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;configs/esp32c6-gc9a01.defaults" build
idf.py -B build/esp32c6 -p /dev/cu.usbmodemXXXX flash monitor
```

If the device hub of this repository is running, it holds the board's USB port: stop it first.

On the serial console (115200 baud), `time <unix seconds>` sets the clock; `date +%s` prints the number.
PlatformIO works too: `pio run -e esp32-gc9a01`.
Choose the display, input and pins with `idf.py menuconfig`, under *Fractonica clock*.

## What is in it

- Four chips: ESP32, ESP32-S3, ESP32-C3 and ESP32-C6 (ESP-IDF 5.5).
- Four displays: GC9A01 240 x 240 round, ST7789 240 x 240 and 240 x 320, SSD1306 128 x 64 one-bit.
- Input from a rotary encoder, three, two or one button, or the serial console alone.
- Time from Wi-Fi + SNTP, the serial console or a compile-time demo instant.
- About 64.5 kB of flash for everything of ours on the ESP32 (core, UI library, drivers, application). The core and the UI library use 0 bytes of RAM, and nothing is allocated after start-up.
- Five screens: NOW (the instrument), SCALES, LENS (a card for any of the 63 levels), SUN and STAMP.
- A host simulator that runs the firmware's own application loop and console against a simulated panel; `make test` includes 140 golden-image checks and 943 firmware-loop checks.

## Status

Version 0.1.0, built on core 0.2.0.
All eleven build variants in `tools/build-all.sh` compile without a warning for the ESP32, S3 and C3, and every face has been rendered and checked against the core on the host.
**It has run on hardware once**, on 2026-11-13: an ESP32-C6 with a round GC9A01 (SCL 6, SDA 7, CS 10, DC 2, RST 3; the BOOT button on GPIO 9 is the one button), `configs/esp32c6-gc9a01.defaults`.
The owner confirmed the colours and the orientation on glass.
The other chips and displays, input timing, Wi-Fi, light sleep and every on-chip measurement are still unverified, and the other default pin maps are assumptions.
The guide has a bring-up checklist for the next board.

## Documentation

- [docs/GUIDE.md](docs/GUIDE.md): the full guide. Every face, wiring tables, configuration, the console, memory and size figures, what is verified, and the bring-up checklist.
- [AGENTS.md](AGENTS.md): the guide for coding agents and engineers working in this repository.
- [SPEC.md](https://github.com/fractonica/core/blob/main/docs/SPEC.md): the clock's specification, in the core repository.

## Licence

See [LICENSE](../LICENSE) at the root of the devices repository.
