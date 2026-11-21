# Fractonica user manual

Fractonica runs a network of ESP32 boards from your Mac. A **hub** on the Mac runs the boards you register with it: it builds and flashes firmware, updates boards over Wi-Fi, collects their logs and events, and lets you, your apps and AI agents drive them. Each board runs the same **node firmware**, assembled from a **profile** that lists its **capabilities** (a button, an LED, a display, a microphone, a camera, …).

This manual is task-first: every section is a set of steps you can follow at the bench, with what you should see. The design notes in [`design/`](design/) and the spec in [`spec/`](spec/README.md) have the full detail.

Contents:

1. [First-time setup](#1-first-time-setup)
2. [Everyday basics](#2-everyday-basics)
3. [Camera (ESP32-CAM)](#3-camera-esp32-cam)
4. [Weighing scale and round display](#4-weighing-scale-and-round-display)
5. [LCD board, micro-SD card and clock](#5-lcd-board-micro-sd-card-and-clock)
6. [Audio: microphone and speaker](#6-audio-microphone-and-speaker)
7. [Electrosmog listener](#7-electrosmog-listener)
8. [Wi-Fi sensing (CSI) and its sound modes](#8-wi-fi-sensing-csi-and-its-sound-modes)
9. [Buttons, LEDs, bindings and messages](#9-buttons-leds-bindings-and-messages)
10. [Displays and touch](#10-displays-and-touch)
11. [Analog input](#11-analog-input)
12. [The gateway](#12-the-gateway)
13. [Adding a new board](#13-adding-a-new-board)
14. [Firmware updates](#14-firmware-updates)
15. [Testing](#15-testing)
16. [Apps and the SDK](#16-apps-and-the-sdk)
17. [AI agents](#17-ai-agents)
18. [Troubleshooting](#18-troubleshooting)
19. [The bench](#19-the-bench)
20. [Fractonica time](#20-fractonica-time)
21. [The dashboard](#21-the-dashboard)
22. [Stepper motor](#22-stepper-motor)

`fr` runs from any directory once `fr doctor --fix` has written its shim (section 1); commands that build use the checkout around the current directory, or else the one the shim points at. Add `--json` to any of them for machine-readable output, and `--help` to see all options.

---

## 1. First-time setup

You do this once per Mac. [GETTING-STARTED.md](GETTING-STARTED.md) has the same steps with more detail, ESP-IDF, the
first board and troubleshooting.

1. **Install the prerequisites:** Node 24.12 or later, pnpm 11 and uv (`brew install node@24 pnpm uv`, then
   `uv python install 3.12`). ESP-IDF v6.1 is needed only to build firmware ([GETTING-STARTED §5](GETTING-STARTED.md#5-building-firmware)).

2. **Install the checkout and the `fr` command.** `pnpm fr` runs the CLI from the checkout; `fr doctor --fix` writes
   the `fr` shim into `~/.local/bin`, installs the esptool sidecar, builds the dashboard, and checks the rest:

   ```bash
   git clone https://github.com/fractonica/esp32.git devices && cd devices
   pnpm install
   pnpm fr doctor --fix
   ```

   From then on `fr` works from any directory (put `~/.local/bin` on your `PATH` if doctor says it is not).

3. **Start the hub from Terminal**, not from an editor or an agent, so macOS grants Local Network access to Terminal
   (allow it when macOS asks):

   ```bash
   fr hub start
   ```

4. **Check it is healthy.** You should see the version, the IDF pin, the USB ports and how many devices are online:

   ```bash
   fr hub status
   ```

5. **Store your Wi-Fi network.** Boards join it to reach the hub. Type the password when asked; it is kept only in `~/.fractonica/secrets.json` and never printed:

   ```bash
   fr net set --ssid "<your network>" --password-stdin
   ```

   A second network, for example a 5 GHz one, gets its own name: `fr net set --name 5ghz --ssid "<network>" --band 5g --password-stdin`.

6. **Open the dashboard** at <http://127.0.0.1:7420/>. Its rail has six pages: Hub, Devices, Provision, Live, Bench and
   Settings ([section 21](#21-the-dashboard)). To set up a new board without the command line, open **Provision** and
   plug the board in.

7. **Know which ports the hub takes.** It opens only the USB ports of boards it knows (registered ones); the others
   stay free for `idf.py`, esptool or a browser. `fr ports` shows each port as watched by the hub, lent, held by
   another program, ignored, or not opened. To use a watched port from another program, lend it:
   `fr serial idf <board> flash monitor` runs `idf.py -p <port> flash monitor` while the port is lent, and
   `fr serial lease <board> -- <command> '$FR_PORT'` does the same for any command (single quotes, so `fr` fills the
   port in, not your shell). `fr ports ignore <port>` keeps the hub off a port for good; `fr ports claim <port>` lets it read a board it does not know yet.

---

## 2. Everyday basics

| What | Command |
|---|---|
| Which boards exist and which are online | `fr devices ls` |
| One board in detail (links, firmware, properties) | `fr devices get cam-esp32` |
| USB ports the hub sees | `fr ports ls` |
| A board's recent log lines | `fr logs cam-esp32` |
| Follow the log live | `fr logs cam-esp32 --follow` |
| Only warnings and errors | `fr logs cam-esp32 --level W` |
| Events (button presses, state changes, boots) | `fr events cam-esp32` |
| Run a capability command | `fr send pad-c3 status.blink '{"count":3}'` |
| Board health over USB (heap, firmware, reset reason) | `fr diag cam-esp32 info` |
| Reset a USB-attached board | `fr devices reset cam-esp32` |
| Rename a board | `fr devices set pad-c3 --alias kitchen-pad` |
| Running and recent jobs (builds, OTA, streams) | `fr jobs ls` |
| Restart the hub after pulling new code | `fr hub restart` |
| Fractonica time now (no hub needed) | `fr time` ([section 20](#20-fractonica-time)) |

A **selector** names one or more boards: an alias (`cam-esp32`), `id:<12 hex>`, `tag:<tag>`, `chip:esp32c3`, `online`, or `all`, comma-separated, with `!` to negate.

Files the hub writes (photos, recordings, WAVs) always go under `~/.fractonica/` (FR_HOME). A path you give must be inside it.

---

## 3. Camera (ESP32-CAM)

**The board:** cam-esp32, an AI-Thinker ESP32-CAM with an OV2640 sensor and a micro-SD card, on its CAM-MB programmer base. The base's micro-USB carries power and a USB-to-serial bridge (CH340). The red LED on the back lights while it boots; the white LED on the front is the flash.

**What it does:** photos to the Mac, a live view in the browser, short streams and timelapses to the Mac, recordings on the card without the hub (list, fetch, delete), sensor settings, the flash LED.

### 3.1 Test the camera, step by step

1. **Connect the board.** Plug the CAM-MB base into the Mac with a micro-USB **data** cable (many micro-USB cables carry power only: if nothing shows up in step 2, try another cable). Leave the SD card in.

2. **Check the hub sees the port.** You should see a row with `ch340` and the device id `80f3da0006d4`:

   ```bash
   fr ports ls
   ```

3. **Check the board is online.** Within about 10 s of power-up:

   ```bash
   fr camera status cam-esp32
   ```

   You should see something like:

   ```text
   cam-esp32 cam: 0 frames, 0.0 fps, last 0 B, idle, sd mounted (2963 MB free), sensor ov2640, max uxga
   no stream
   ```

   `sd mounted` means the card was found at boot. `sd none` means no card at boot (see 3.4).

4. **Take a photo.** It prints the path of the JPEG on the Mac, its size and how long it took (about 150 to 200 ms):

   ```bash
   fr camera snap cam-esp32
   ```

   Open it:

   ```bash
   open ~/.fractonica/captures/cam-esp32/
   ```

   With the flash LED lit for the shot:

   ```bash
   fr camera snap cam-esp32 --flash
   ```

5. **Watch it live in the browser.** Open the dashboard at <http://127.0.0.1:7420/>, **Devices** › **cam-esp32**,
   and press **WATCH** on the `cam` row (or open the row and press **WATCH**). You should see the picture at about 9 to
   12 frames per second. On the same page:
   - **PHOTO** takes a photo on the Mac (with **with the flash** on, the white LED lights for it); **KEEP THIS FRAME**
     saves the frame shown.
   - **RECORD…** records to the Mac, the card or both, for a span you choose (steps 6 to 8 from the page).
   - **SENSOR SETTINGS** change frame size, detail, brightness, contrast, saturation, flip and mirror. A size or detail
     change restarts the live view on its own.
   - **CARD RECORDINGS** lists, plays and deletes what is on the card.
   - Press **STOP** when done; leaving the page stops it too.

   The older standalone page, <http://127.0.0.1:7420/apps/cam/>, still works where it is installed. The whole page is
   described in *The device page* (§21).

6. **Stream a short clip to the Mac.** 15 s of frames, one JPEG each, into a new folder under `~/.fractonica/captures/cam-esp32/`:

   ```bash
   fr camera stream cam-esp32 --seconds 15
   ```

   The result shows frames, dropped, bytes and fps.

7. **Make a timelapse.** One frame a second for a minute:

   ```bash
   fr camera stream cam-esp32 --seconds 60 --interval-ms 1000
   ```

8. **Record on the card**, with no hub involved in the frames. Ten frames, one a second:

   ```bash
   fr camera stream cam-esp32 --seconds 20 --interval-ms 1000 --max-frames 10 --to sd
   ```

   The result names the recording id. List what is on the card:

   ```bash
   fr camera sd ls cam-esp32
   ```

   Copy a recording to the Mac (into `~/.fractonica/captures/cam-esp32/sd-<id>/`):

   ```bash
   fr camera sd fetch cam-esp32 <recording id>
   ```

   Delete it from the card (the Mac copy stays):

   ```bash
   fr camera sd rm cam-esp32 <recording id>
   ```

   `--to both` sends frames to the Mac and writes the card at the same time.

9. **Change settings** until the next reboot:

   ```bash
   fr camera set cam-esp32 --frame-size xga --quality 10
   fr camera set cam-esp32 --vflip --hmirror
   ```

   Sizes: `qvga` 320×240, `vga` 640×480, `svga` 800×600 (the default), `xga` 1024×768, `sxga` 1280×1024, `uxga` 1600×1200. Quality runs 4 (best, biggest) to 63. A reboot (`fr devices reset cam-esp32`) restores the profile's defaults.

10. **Run the automated test.** No person needed; about two minutes. It takes ten photos, streams 20 s, records, fetches and deletes on the card, checks a setting, and resets the board through its USB bridge:

    ```bash
    fr test run t-camera --tier target --args=--device --args=cam-esp32
    ```

    You should see `T-CAMERA PASS`. For one part only, add `--args=--phase --args=snap` (or `live`, `card`, `set`, `bridge`).

### 3.2 What to expect

| Measure | Typical on cam-esp32 |
|---|---|
| Photo, end to end | 150–200 ms |
| Live view at svga | 9–12 fps, about 300–350 KB/s |
| Frame size at svga | 27–42 KB (bigger in low light or with the flash) |
| Card fetch | about 6 frames/s |

The Wi-Fi link sets the frame rate: bigger frames mean fewer per second.

### 3.3 Update its firmware

Always update this board over Wi-Fi:

```bash
fr deploy cam-esp32 --via wifi
```

Without `--via wifi` the hub picks the USB route for a board on a USB bridge, and that fails while the SD card is in (see 3.4).

### 3.4 Camera troubleshooting

| You see | Do this |
|---|---|
| No `ch340` port in `fr ports ls` | Try another micro-USB cable: many carry power only. |
| `sd none` in the status | The card is checked at boot only. Insert it, then `fr devices reset cam-esp32`. |
| "Wrong boot mode detected (0xb)" when flashing over USB | The SD card holds a boot pin high once used. Unplug the board, take the card out, plug it back in, flash, then put the card back. Over Wi-Fi this never happens. |
| Low frame rate | Use a smaller frame size or more light; check the board's Wi-Fi signal in `fr devices get cam-esp32` (`rssi_ap`). |
| "BUSY" | One stream at a time: stop the live view (**STOP** on the camera's page), **STOP THAT STREAM** or **STOP RECORDING** there (a recording started elsewhere shows there too), or `fr jobs cancel <job id>`. A view open in another tab is not busy: the page says *watched in another place* and **WATCH** joins it. |
| "The camera is busy with a stream this hub does not know of" | The board kept a stream going after its link dropped. **STOP IT ON THE BOARD** on the camera's page ends it; if the page cannot name the stream, restart the board (`fr devices reset cam-esp32`). |
| The free space looks too small | The figure is the card's own (FAT) count; check the card on the Mac. |

---

## 4. Weighing scale and round display

**The board:** scale-c6, an ESP32-C6 board (an ESP32-C6-WROOM-1-N8 module, 8 MB flash, no PSRAM) with two parts wired to it: an **HX711** load-cell amplifier with its load cell (DT on GPIO18, SCK on GPIO23) and a **1.28" round GC9A01 display**, 240×240 (CS 10, DC 2, SDA 7, SCL 6; RST not wired). The scale is the `scale` instance (`fr.scale`), the display the `round` instance (`fr.display`).

**On this bench the load cell is a tension sensor for sound, not a kitchen scale.** The board streams every change at 80 a second; read the values as relative force (raw counts scaled by a default factor). Calibrating in grams (step 4) is optional.

**What it does:** weight (or force) live in the browser and on the round display, tare and calibration that survive a reboot, a "settled" event when something is put on or taken off, recordings of every reading at up to 80 a second, and drawing or LVGL layouts on the round display.

### 4.1 Test the scale, step by step

1. **Connect the board** to the Mac with USB. Within about 10 s it joins Wi-Fi.

2. **Check the scale answers:**

   ```bash
   fr scale status scale-c6
   ```

   You should see something like `scale-c6 scale: 0.10 g, stable, calibrated, 95 Hz`. The rate is the HX711's own: about 80–100 when its RATE pin is set to "80 Hz", 10–12 when set to "10 Hz", **0 when the chip does not answer** (check its VCC, GND, DT and SCK wires).

3. **Zero it** with nothing on the scale:

   ```bash
   fr scale tare scale-c6
   ```

   The reading goes to about 0 g. The zero is kept across reboots.

4. **Calibrate it once (optional)** with something whose weight you know (at least 100 g; a sealed food package is good). Put it on, wait a second, then give its weight in grams:

   ```bash
   fr scale calibrate scale-c6 500
   ```

   The scale factor is kept across reboots. `fr scale reset scale-c6` forgets the zero and the calibration. "BUSY" means the reading was not stable yet: wait a moment and repeat.

5. **Watch it in the browser:** open <http://127.0.0.1:7420/apps/scale/>. You see the weight in grams with a stability dot, a 30 s plot, the HX711's rate and noise, and the Tare and Calibrate buttons. **Live at 80 Hz** shows every reading.

6. **Show the weight on the round display:** on the same page, tick **Show on the round display**. The display shows the weight as a large number with a gauge arc, updated up to 5 times a second while the page is open. **Gauge full scale** sets the weight at which the arc is full.

7. **Record every reading** for 10 s at 80 a second to a CSV file (`t_ms,weight_mg,stable`):

   ```bash
   fr scale watch scale-c6 --seconds 10
   ```

   The result gives the number of samples, the rate, and the mean, standard deviation, minimum and maximum.

8. **Run the automated test** (about 20 s, no person needed). It checks the rate, the noise on the empty scale, that a tare survives a reboot, and the round display's layout:

   ```bash
   fr test run t-scale --tier target --args=--device --args=scale-c6
   ```

   You should see `T-SCALE PASS`. With a known weight at hand, add `--args=--known-g --args=500` (you are asked to put it on and take it off).

### 4.2 The round display

Drawing works as on the other panels (section 10), with the instance `round`:

```bash
fr send scale-c6 round.clear
fr send scale-c6 round.text '{"x":60,"y":105,"text":"hello","size":3}'
```

Keep content inside the circle: the corners of the 240×240 frame are not on the glass. The display reports the trait `round: true`, so apps and agents know. Preview it on the Mac, corners greyed: `fr display render c6w-scale --commands '[{"cmd":"text","args":{"x":60,"y":105,"text":"123.4 g","size":3}}]'`. This board has no PSRAM, so `fr display snapshot` (reading the screen back) is not available on it.

### 4.3 What to expect

| Measure | Typical on scale-c6 |
|---|---|
| HX711 conversions | 95–96 a second (its "80 Hz" setting runs fast) |
| Readings delivered in a watch | about 79 a second |
| Noise on the empty scale | about 140–180 mg standard deviation |
| Reports | every change, 80 a second (this profile; the capability's default is 10 a second with a 100 mg deadband) |
| Free memory with Wi-Fi up | about 60 KB |

### 4.4 Scale troubleshooting

| You see | Do this |
|---|---|
| Rate 0 Hz | The HX711 does not answer: check its VCC and GND first (a broken VCC wire was the cause on the bench), then DT and SCK. |
| Rate about 10 Hz | The module's RATE pin is set to 10 Hz; for 80 Hz it must be tied to VCC (a solder change on most modules). |
| The weight drifts slowly | Load cells creep a little after a change and with temperature: tare again before an exact weighing. |
| Calibrate says nothing is on the scale | Put the known weight on first; after a wrong calibration, `fr scale reset scale-c6`, tare, and calibrate again. |
| The round display shows `--` | The page lost the board for a moment; it reloads the layout by itself. |

---

## 5. LCD board, micro-SD card and clock

**The board:** lcd-c6, a **Waveshare ESP32-C6-LCD-1.47** (ESP32-C6FH4, 4 MB flash, no PSRAM) with its own **1.47" ST7789 display**, 172×320 (the `screen` instance, `fr.display`), a **micro-SD (TF) slot** on the display's SPI bus (the `card` instance, `fr.storage`) and an RGB LED. A **DS3231 real-time clock** module is wired to it: SDA to GPIO18, SCL to GPIO19, VCC to 3.3 V, GND (the `clock` instance, `fr.clock`). The wiring guide is on the dashboard's Bench page: <http://127.0.0.1:7420/#/bench>, guide `clock-lcd-c6`.

**What it does:** layouts and drawing on the display (its backlight is capped at half, as Waveshare advises: full brightness overheats the panel), files to and from the card, a clock that keeps time on its coin cell through power cuts, set from the Mac to the second boundary, and a drift measurement against the Mac.

### 5.1 Test the card, step by step

1. **Put a micro-SD card in** (FAT32, as cards come; format a new exFAT card as FAT32 on the Mac first) and **connect the board** with USB. Within about 10 s it joins Wi-Fi.

2. **Check the card:**

   ```bash
   fr storage info lcd-c6
   ```

   You should see `lcd-c6 card: mounted, SDHC, … MB free of … MB`. `none` means no card or it did not mount: reseat it and run the command again (the board tries again on every `info`). `error` means the card or its filesystem failed.

3. **List it, put a file on, get it back:**

   ```bash
   fr storage ls lcd-c6 /
   fr storage put lcd-c6 /Users/you/notes.txt
   fr storage get lcd-c6 /notes.txt
   ```

   `put` copies a file from the Mac (absolute path, up to 64 MB) to the card, to `/<its name>` unless you give a card path as the third word. `get` copies it to `~/.fractonica/storage/lcd-c6/notes.txt`. `fr storage rm lcd-c6 /notes.txt` removes it; `fr storage mkdir lcd-c6 /logs` makes a directory.

4. **Measure it:**

   ```bash
   fr storage bench lcd-c6
   ```

   It writes 1 MB of a test pattern, reads it back, compares every byte and removes it: `write … KB/s, read … KB/s, identical`. `DIFFERS at byte …` means a bad card or a bus problem.

### 5.2 Test the clock, step by step

1. **Set it from the Mac:**

   ```bash
   fr clock sync lcd-c6
   ```

   The hub sets the DS3231 so its next second starts with the Mac's. "Busy" right after the board comes online: wait a few seconds and repeat.

2. **Read it:**

   ```bash
   fr clock read lcd-c6
   ```

   You should see `lcd-c6 clock: 2026-11-05T14:00:00Z, valid, +3.2 ms against the Mac (±1.4 ms), 24.50 °C`. The time is UTC. **NOT valid** means the clock lost power since it was set (no coin cell, or a flat one): sync it again.

3. **Unplug the board for a minute and plug it back:** `fr clock read lcd-c6` still says valid and a few ms from the Mac. The coin cell kept it counting.

4. **Measure its drift** (optional; it takes as long as you ask):

   ```bash
   fr clock drift lcd-c6 60
   ```

   After an hour: `0.80 ppm fast (0.069 s a day)`. A DS3231 is within about ±2 ppm. When a long run suggests a trim, `fr clock aging lcd-c6 <value>` applies it (positive slows the clock, about 0.1 ppm a step).

### 5.3 The display and the automated test

Drawing works as on the other panels (section 10), with the instance `screen`; the panel is 172 wide and 320 tall. Then run the automated test (about a minute, no person needed):

```bash
fr test run t-lcdc6 --tier target --args=--device --args=lcd-c6
```

It loads a test pattern on the display, benches the card, syncs the clock and checks it through a reboot, and runs the display and the card together for 30 s. You should see `T-LCDC6 PASS`. Add `--args=--look` to be asked whether the pattern is right (red, green, blue and white bands from the top, a thin white border touching all four edges, the backlight not at full): press BOOT once for yes, hold it 2 s for no.

### 5.4 Card and clock troubleshooting

| You see | Do this |
|---|---|
| `none` from `fr storage info` | Reseat the card and run it again; a card formatted exFAT or NTFS will not mount: format it FAT32 on the Mac. |
| `DIFFERS at byte …` in the bench | Try another card; if every card differs, the display and the card are fighting over their bus: report it with the run's output. |
| The clock reads NOT valid after a power cut | The coin cell is missing or flat. A plain CR2032 on the common DS3231 module: remove the module's charging diode (see the wiring guide), or fit a rechargeable LIR2032. |
| The clock does not answer | Check SDA (GPIO18), SCL (GPIO19), 3.3 V and GND to the module. |
| The border is missing on one side of the display | The panel's column offset is off: report it (the driver's offset for this panel is 34). |

---

## 6. Audio: microphone and speaker

**The board:** mic-s3, an ESP32-S3 with an INMP441 microphone (`mic`) and a MAX98357A amplifier with a small speaker (`spk`).

1. **Check the microphone hears something.** A quiet room reads about −37 to −39 dBFS; −90 means no signal at all:

   ```bash
   fr audio level mic-s3
   ```

2. **Record 10 s to a WAV on the Mac:**

   ```bash
   fr audio record mic-s3 ~/.fractonica/audio/take.wav --seconds 10
   open ~/.fractonica/audio/take.wav
   ```

   The result shows peak and RMS level, clipping and dropped samples (samples lost to Wi-Fi are written as silence, so the length is always exact).

3. **Play it back on the board's speaker,** or any WAV:

   ```bash
   fr audio play mic-s3 ~/.fractonica/audio/take.wav
   ```

4. **Play a tone:**

   ```bash
   fr audio tone mic-s3 1000 --ms 500
   ```

5. **Listen live** through the board's own speaker (the microphone to the speaker on the board):

   ```bash
   fr audio monitor mic-s3 --from mic --to spk --seconds 30 --volume 40
   ```

6. **Automated test** (loopback tone, a minute of quiet, the level):

   ```bash
   fr test run t-audio --tier target --args=--device --args=mic-s3
   ```

Note: the INMP441 picks up the board's own Wi-Fi transmissions as soft thumps. Keep the microphone's wires short and away from the antenna.

---

## 7. Electrosmog listener

**The board:** mic-s3 again, with a radio detector on GPIO1 (`rf`: a diode, a capacitor, a resistor and a short wire antenna) read by the ADC as an audio source.

1. **Hear it live on the speaker:**

   ```bash
   fr audio monitor mic-s3 --from rf --to spk --seconds 60
   ```

2. **Record it:**

   ```bash
   fr audio record mic-s3 ~/.fractonica/audio/rf.wav --instance rf --seconds 30
   ```

A floating input hears 50 Hz mains loudly; the germanium diode is weak at 2.4 GHz (a Schottky diode such as 1N5711 or HSMS-2850 is the planned upgrade).

---

## 8. Wi-Fi sensing (CSI) and its sound modes

**The board:** csi-c5, an ESP32-C5 dev board that reads the Wi-Fi channel state information (CSI) of the router's traffic on 5 GHz. Movement in the room changes the signal.

1. **Check it:** motion, signal strength and the source it listens to:

   ```bash
   fr csi status csi-c5
   ```

2. **Watch it live** at <http://127.0.0.1:7420/apps/csi/>: pick **csi-c5**, press **Start**. The plots show the subcarriers and a **Motion** trace; walk around and it should rise clearly. **Reset baseline** makes "now" the still reference.

3. **Turn it into sound** on the same page, in the **Sound** card (start at a low volume):
   - **Drone:** one voice per band of subcarriers; movement brightens the chord. **Raw pitch** lets each voice bend with its band.
   - **Parrot:** listens for a while, then speaks what it heard as one compressed word; a still room stays silent.
   - **Laughter:** waits for movement, records it, then laughs at it; rate, pitch and vowel follow how you moved.
   - **Babble:** the same, in an invented robot language of syllables and pauses.

4. **Save records to a file** for later analysis:

   ```bash
   fr csi stream csi-c5 --seconds 30 --out ~/.fractonica/csi/walk.csi
   ```

csi-c5 joins the hub's `5ghz` network. Its source can also be a second board transmitting (`--source peer --peer <device>`).

---

## 9. Buttons, LEDs, bindings and messages

**The boards:** the pads (pad-c3, pad-c3b, pad-c6, pad-s3, pad-s3t): each has a BOOT button (`boot`) and a status LED (`status`), most have a display.

1. **Blink an LED:**

   ```bash
   fr send pad-c3 status.blink '{"count":3}'
   ```

   Other LED commands: `status.set`, `status.toggle`, `status.stop`.

2. **Press a button without touching it** (debug builds):

   ```bash
   fr input pad-c6 boot click
   ```

   Gestures: `press`, `release`, `click`, `double_click`, `long_press`. Then see the events:

   ```bash
   fr events pad-c6 --types 'boot.*'
   ```

3. **Bind one board's button to another board's LED.** The binding lives on the boards and works over ESP-NOW even without the hub:

   ```bash
   fr bind pad-c6.boot.down pad-c3.status.blink '{"count":1}'
   ```

   Press BOOT on pad-c6 and pad-c3 blinks. List and remove bindings:

   ```bash
   fr bind ls
   fr bind rm pad-c6 all
   ```

4. **Broadcast a message** to every node:

   ```bash
   fr msg broadcast ping
   ```

5. **See latency** per board and link (PING round trip, input to hub):

   ```bash
   fr latency
   ```

6. **Make a board identify itself** (its first LED blinks so you can find it): `fr send pad-c3 node.identify '{"ms":3000}'`.

---

## 10. Displays and touch

**The boards:** pad-c3 and pad-c3b (a 0.42" OLED, `oled`), pad-s3 (a 1.9" LCD, `lcd`), pad-s3t (a 2" touch LCD, `lcd` and `touch`), scale-c6 (a 1.28" round LCD, `round`: see [4.2](#42-the-round-display)).

1. **Write on a display:**

   ```bash
   fr send pad-s3 lcd.clear
   fr send pad-s3 lcd.text '{"x":10,"y":20,"text":"hello","size":2}'
   ```

   Other commands: `fill_rect`, `set_brightness`, and `ui_load` / `ui_set` for LVGL layouts.

2. **See what a panel shows**, as a PNG on the Mac:

   ```bash
   fr display snapshot pad-s3 lcd --out ~/.fractonica/display/
   ```

3. **Preview a profile's panel on the Mac with no board:** a window that behaves like the device (the mouse is the finger on touch panels):

   ```bash
   fr display window --profile s3t-pad
   ```

   Or render it once to a PNG: `fr display render s3t-pad`.

4. **Touch:** a tap on pad-s3t arrives as `touch.*` events (`fr events pad-s3t --types 'touch.*'`); simulate a tap with `fr input pad-s3t touch --x 100 --y 80` (or the gesture `long_press`, `swipe_up`, … before the flags).

---

## 11. Analog input

**The profile:** c3o-analog (a pad-c3 board with `analog` on an ADC pin). It streams the value at 20 Hz by default.

1. Put the profile on a C3 pad over USB: `fr build --profile c3o-analog`, then `fr flash pad-c3b --profile c3o-analog --plan full` (see [14](#14-firmware-updates)).
2. Read it: `fr send pad-c3b analog.read`.
3. Watch it stream: `fr events pad-c3b --types 'analog.*'`.
4. On a debug build, fake a value: `fr input pad-c3b analog --mv 1650`.

---

## 12. The gateway

**The board:** gw-c6, a nanoESP32-C6 on the Mac's USB. It bridges ESP-NOW nodes that have no Wi-Fi link to the hub over USB. It needs no setup: plug it in and the hub uses it for nodes it cannot reach over Wi-Fi. `fr devices get <node>` shows `gw` among its links when traffic goes through it.

---

## 13. Adding a new board

1. **Plug it in** and find its port:

   ```bash
   fr ports ls
   ```

2. **Pick or write a profile.** `fr profiles ls` lists them with their board and capabilities; `fr boards ls` lists the board descriptions. A new board needs a board file in `hardware/boards/` and a profile in `firmware/profiles/`.

3. **Build it** (about a minute the first time):

   ```bash
   fr build --profile e32a-cam
   ```

4. **Provision it:** first flash, identity, Wi-Fi and registration in one step (about 1 to 2 minutes):

   ```bash
   fr devices provision --port /dev/cu.usbserial-110 --profile e32a-cam --alias cam-esp32
   ```

5. **Check it came online:** `fr devices get cam-esp32`.

The dashboard does the same without a command: **Provision** › New board ([section 21](#21-the-dashboard)).

For an ESP32-CAM, take the SD card out before provisioning (see 3.4).

### 13.1 A board for another hub

A hub that cannot flash (no USB ports, no builds: a home hub on a small Linux board) gets its ESP32 boards flashed at
the hub that can. The board is plugged into this Mac, flashed here, and then belongs to the other hub: it joins Wi-Fi
and connects there.

Before the first one:

- Both hubs run the same version of this checkout.
- The other hub has a network stored (on that hub: `fr net set --ssid <ssid>`; it needs no password). The Wi-Fi the
  board joins is **this** hub's stored network (`fr net get`), so the other hub must be on that same Wi-Fi.
- This Mac reaches the other hub's API. A hub answers only as `127.0.0.1` at its own port, so open an SSH tunnel on that
  same port and leave it running:

  ```bash
  ssh -N -L 7520:127.0.0.1:7520 <user>@home-hub.local
  curl http://127.0.0.1:7520/api/v1/health      # the other hub answers
  ```

Then provision as in step 4, naming the other hub:

```bash
fr devices provision --port /dev/cu.usbserial-110 --profile e32a-cam --for-hub http://127.0.0.1:7520
```

The other hub registers the board (address, alias, its own network id) and marks it with the tag `new`; this hub writes
that identity and its own Wi-Fi into the board. The result says `for_hub`, the alias the other hub gave, and
`wifi: joined` once the other hub sees the board online (it waits 30 seconds). Nothing is written to the board when the
other hub does not answer or refuses (an alias another device has, no stored network).

On the other hub the board now waits to be named and accepted: `fr devices ls tag:new`, then
`fr devices set <alias> --alias kitchen-cam --tag -new`. `--alias` on the provision command names it at once.

On this hub the board is not a device: a new board gets no row here. A board that was registered here (one you move)
stays in `fr devices ls` as seen only, with the tag `moved`, and the hub stops watching its USB port (in the default
port mode, `adopted`), so the board can stay plugged in for power. Its bindings on this hub are yours to clear
(`fr bind ls`). To take it back, provision it again without `--for-hub`.

To put a newer build on such a board from this Mac, provision it for the other hub again: it keeps its address and
alias there. Do not `fr flash --plan full` it from this hub: that erases the identity the other hub gave it
(`--plan app` keeps it).

All of this is for a hub with a network of its own. When the other hub has joined this hub's network (§13.2), the
same command makes a board of the network: this hub keeps its row (no `moved` tag, its port stays watched), every hub
of the network holds the same row (§13.5), and the board connects to the other hub first. The result then says
`shared`.

### 13.2 A second hub in the same network

Two hubs can serve one network. A board then has one address and one alias on both, and an ordered list of hubs: it
connects to the first, moves to the next when that one goes away, and comes back by itself. Example: the Mac
(`lab-hub.local`) and a home hub (`home-hub.local`).

The hubs keep a link to each other (§13.3): each knows which hub a board is on, a command for a board runs at
the hub that has it, whichever hub you send it to (§13.4), and every hub holds every board's row (§13.5). What is not
there yet: each hub keeps its own bindings and apps, and a live view or a wait for an event works only at the hub the
board is on.

**Once: make the home hub a member.** One hub of a network hands out the addresses (its registrar); the other joins
it. On the home hub, with a tunnel to the Mac's API open (as in §13.1, here on port 7420):

```bash
fr net join --hub http://127.0.0.1:7420
fr hub restart              # when the answer asks for it
fr net get                  # registrar: http://127.0.0.1:7420
fr hub peers                # both hubs, and whether the link between them is up (§13.3)
```

The home hub takes the Mac's network id (and its Wi-Fi name, when it had none stored; never the password). From then
on the Mac gives every new board its address: `fr devices provision`, `adopt` and `enroll` on the home hub ask the
Mac for it over the link, and refuse while the Mac's hub is not reachable (§13.5). If the home hub already had boards
of its own, the join is refused and lists them; `--force` joins anyway, and each of those boards then needs a new
identity (an ESP32 a flash, the answer says how).

**Per board: set its hubs.** The home hub holds the board's row by itself (§13.5). On either hub:

```bash
fr devices hubs set pad-c6 --hub lab-hub.local --hub home-hub.local
fr devices hubs get pad-c6                                    # the list, its rev, and "on": 0 (the first hub)
```

The first `--hub` is the board's default. `--hub home-hub.local/192.168.1.30` adds an address to fall back to when the
name does not resolve. A list that names the hub the board is on is kept at once. Any other is tried: the board goes
to its first hub, and if no hub of the list takes it within 60 seconds it returns to the list it had. `--none` takes
the list away (the board uses the hub it was flashed for). A board needs firmware from this version on; an older one
answers `CAPABILITY_UNSUPPORTED`.

A new board is provisioned on whichever hub has its USB cable (`fr devices provision --port <port>`), then
`fr devices hubs set` as above. `--for-hub http://127.0.0.1:7520` (§13.1) only chooses the hub the board connects to
first.

**What failover looks like.** Stop the Mac's hub: the board keeps trying it for about 10 to 15 seconds, then connects
to the home hub, where `fr devices get pad-c6` shows it online with the same address and alias. Start the Mac's hub
again: within a minute or two the board notices (it looks once a minute and wants two answers 10 seconds apart) and
returns; the home hub shows it offline. It does not return while a firmware update is running over the hub it is on.
On either hub, `fr devices get` shows `hubs` (the list that hub recorded) and `hub_now.here` (whether the board is
connected to this hub right now).

Things to know:

- Both hubs must run the same version of this checkout.
- A board on one hub's USB cable and the other hub's Wi-Fi stays on the Wi-Fi one. The hub with the cable has it
  until its Wi-Fi is up, then shows it offline (reason `held by hub <name> over Wi-Fi`) and `at` the other hub; it
  still reads its serial log and can flash it (§13.3). While the link between the hubs is down, a board with
  **older firmware** in that position flips between the two hubs every few seconds: update its firmware before you
  give it a second hub, or unplug the cable.
- A flash from a hub (`fr flash --plan full`, `fr devices provision`) makes that hub the board's hub again and drops
  the list; set it again afterwards.
- A rename, a tag or a hub list is the same on every hub within a moment (§13.5). While the board is connected it is
  made at the hub that has the board, which tells the board its new name. Bindings are per hub.

### 13.3 The link between the hubs

The hubs of a network keep one encrypted connection between each pair, on port 7423 of the LAN. Over it each hub
tells the others which boards it has, so every hub can say where a board is, and passes on the commands for a board
that another hub has (§13.4).

**It starts with the join.** `fr net join` (§13.2) gives the joining hub three things from the registrar: the
network's key, its name in the network and an epoch slot. The key is 32 random bytes that only the hubs hold; it is
kept in `~/.fractonica/secrets.json` (like the Wi-Fi passwords) and no command ever prints it. The link starts by
itself afterwards, and comes back by itself after a restart, a sleep or a network change.

**Two hubs that joined before this version** need the join once more. Update both hubs, restart both, then on the
member (the hub that joined), with the tunnel to the registrar open:

```bash
fr net join --hub http://127.0.0.1:7420     # the same command as the first time; nothing else changes
fr hub peers
```

Until then `fr hub status` on the member warns that it holds no network key, and nothing else is different.

**A hub's name.** Each hub has a short name, shown wherever a board's place is shown. It is the host name without
its domain unless you give it one, and two hubs of a network cannot share a name:

```bash
fr hub name lab             # lowercase letters, digits and "-", at most 31
```

Name a hub before it joins when two machines are named alike. Later, the registrar renames itself at once; a member
asks the registrar, so the tunnel to it must be open.

**Who is where.**

```bash
fr hub peers
# network 41235: this hub is lab (5d1c20a0b1c2, slot 0); registrar lab; link listening on 7423
# HUB             ID            ROLE       SLOT  REACHABLE  SINCE                EPOCH  REGISTRY      BOARDS  ADDRESS
# lab (this hub)  5d1c20a0b1c2  registrar  0     -          2026-11-21 10:00:00  12     8910d0ce4075  3       192.168.1.20:7423
# home            a0b1c2d3e4f5  member     1     yes        2026-11-21 10:00:04  16390  8910d0ce4075  1       192.168.1.30:51234
# registry: 14 rows; home in step, 10 sent, 0 received

fr devices ls               # each board has `at`: the name of the hub it is connected to
fr devices get pad-c6       # answered by home: presence online, at: home
```

`at` is this hub's own name for a board that is connected here and another hub's name for a board that hub reports.
Such a board is `online`: a command for it is passed to that hub. When the hub that had a board cannot be reached,
the board is `unknown`, `at` still names that hub, and `presence_reason` says `hub home is not reachable`. `at` is
`null` when no hub has reported the board. A hub that stops is given up at once; one that falls silent (a sleeping
Mac, a pulled network cable) after 6 seconds. REGISTRY is the version of the commands each hub runs: keep both the
same, or the hubs still say who is where but pass no command to each other (§13.4).

**A board on one hub's cable and the other's Wi-Fi.** While the other hub reports the board over Wi-Fi, the hub with
the cable does not take the board's session on USB, so the board no longer shows up online there for a few seconds
each time it connects. It keeps the port: `fr logs`, `fr flash` and `fr diag` work. When the board leaves the other
hub, or that hub goes away, the hub with the cable takes it within a second or two.

**When the link does not come up.** `fr hub peers` says why for each hub (`not reachable (…)`):

- `the two hubs hold different network keys`, or `holds no network key`: join again on the member.
- `is not in the member list`: the hub that says so has not heard of the other yet. The registrar tells it when the
  two are next connected.
- `ECONNREFUSED`, `no TLS session`: the other hub is stopped, asleep, or port 7423 is closed between them. Either
  hub may open the connection, so one direction is enough. On a Mac, the hub needs the Local Network permission to
  open it (`fr hub status`, `lnp`); the firewall must let `node` accept it.
- `fr hub status` warns when this hub's epoch is outside its slot: `fr hub restart` once.

A network has at most four hubs. Leaving a network, and moving the registrar, are not built yet.

### 13.4 A board on another hub

With the link up, any hub is a way in to every board of the network. No tunnel and no `FR_HUB` are needed for it.

```bash
fr devices get mic-s3                       # the Mac asks; home, which has the board, answers
fr audio level mic-s3
fr audio record mic-s3 ~/.fractonica/audio/take.wav --seconds 10     # the WAV ends up on the Mac
fr camera snap cam-esp32 --out ~/.fractonica/captures/shot.jpg
fr devices hubs set mic-s3 --hub home-hub.local --hub lab-hub.local
fr ota mic-s3                               # the Mac's newest build; home fetches it, then updates the board
```

The answer is the other hub's, as if you had asked there. In `--json` the envelope has `at` (the hub that ran the
command) when that is not the hub you asked.

**Naming a hub.** `--at <hub>` before the command runs it on that hub, whatever it is about. This is how you reach
another hub's own things: its USB ports, its status, its builds, its jobs.

```bash
fr --at home hub status
fr --at home ports ls
fr --at home jobs ls
fr --at home flash pad-c6 --plan app        # a board on the home hub's USB cable
```

The name is the one in `fr hub peers`. `--at` goes before the command: some commands have an `--at` of their own
(`fr time --at <instant>`). Over REST it is the header `X-Fr-At: <hub>`; an agent passes `at_hub` to any tool.
`--at` with this hub's own name runs the command here and passes nothing on.

**Jobs and files.** A job runs on the hub that has the board. `fr jobs get`, `wait`, `logs` and `cancel` find it by
its id from any hub (the answer says `at`); `fr jobs ls` lists this hub's own jobs, `fr --at home jobs ls` the other
hub's. A file you asked for with a path (`--out`, the WAV of `fr audio record`) is written on the other hub first and
copied over the link when the job ends, so it is where you ran the command; the path must be under `~/.fractonica` on
this hub, as always. Without a path the file stays on the other hub, and the result says where. A file a command
reads (`fr audio play mic-s3 chime.wav`) is copied the other way first.

**Firmware.** `fr ota <board>` uses the newest build of the hub you ask. The hub that has the board fetches it over
the link, checks it and serves it to the board itself. `fr deploy` (build, then update) works only for boards on the
hub you ask: for a board on another hub run `fr build`, then `fr ota`.

**Several boards.** `fr send` and `fr input` (a command to several boards) are split between the hubs and the
answers joined; each row says `at`. What answers one page, one job or one set of files (`fr logs`, `fr events`,
`fr ota`, `fr latency`, `fr display snapshot`) needs its boards on one hub and says where each is otherwise.

**Live: events, waits, the camera.** Each hub sends the others what its boards do, as it happens. So:

```bash
fr wait device pad-c6 --state online                 # the Mac waits; pad-c6 may come up on any hub
fr send pad-c6 status.blink                          # answered by home; the cursor in the answer is home's
fr wait event status.effect_done --selector pad-c6 --since <that cursor>    # runs on home, where the cursor is from
fr events                                            # the Mac's own events, and the last ten minutes of the others', marked hub
```

- `fr wait event` and `fr wait device` cover boards on any hub, boards on several hubs at once, and a board that
  changes hub while you wait. A dashboard or an app connected to one hub sees every board live; each event from
  another hub says `hub`.
- A wait runs on the hub its `--since` cursor came from. You do not have to think about it: pass the cursor you were
  given. A cursor of a hub that is off answers `HUB_UNREACHABLE`: take a new one (`fr hub status`).
- Logs stay on the hub that reads them. `fr logs <board>` and `fr logs <board> --follow` read them there by
  themselves. `fr wait log` and `fr assert logs` need a cursor of that hub: the cursor of a command to that board,
  or `fr --at home hub status`. With another cursor they say which hub to ask.
- A camera or CSI view (the dashboard's panel, an app's `streams.subscribe`) works from any hub: the hub with the
  board runs the stream and the link carries it. If the link is slow, pictures are skipped, not delayed. Closing the
  view stops the stream at the board. When the board changes hub, the view goes on there by itself after a moment;
  when its hub goes away the view says so and waits.
- One stream per board, wherever you ask: `DEVICE_BUSY … for a client of hub home` names the hub whose view has it.

**What it refuses, and what it says.**

| You see | It means |
|---|---|
| `HUB_VERSION_MISMATCH … hub home runs another version` | The two hubs' REGISTRY differ (`fr hub peers`). Update both and restart each. |
| `HUB_UNREACHABLE … hub home is not reachable` | The link is down, or the hub went away while the command ran. A command that only reads is safe to run again (`retryable`); one that changes something may have run there. |
| `DEVICE_OFFLINE … it is at hub lab now` | The board moved while the command was on its way. A command that only reads was already tried again at the new hub; run another one again yourself. |
| `… log lines do not cross the hubs' link: mic-s3 is at hub home …` | `fr wait log` or `fr assert logs` with a cursor of this hub for a board whose log is on another. Take a cursor there (`fr --at home hub status`, or the cursor of a command to the board) and use it. |
| `cursor c:… is hub home's, not this hub's` | A cursor of one hub given to another with `--at`. Without `--at` the command goes to the right hub by itself. |
| `hub home went away while wait_for_event waited` | The hub with the board stopped or its link dropped during the wait. Run it again when `fr hub peers` shows it. |
| `… which does not relay its events (… before step 2.4 …)` | The other hub runs an older version. Update it and restart it; meanwhile `fr --at home wait …`. |
| `… is at hub home, which does not relay live streams` | The same, for a camera view. |
| `both boards must be on one hub` | A binding or a latency probe between boards on two hubs. |
| `no hub named …` | `--at` with a name that is not in `fr hub peers`. |
| `HUB_UNREACHABLE … the network's registrar, hands out addresses, and it is not reachable` | A new board on a member while the registrar's hub is off or the link is down (§13.5). |

A cursor (`c:<run>.<seq>`) belongs to the hub that gave it, and its run number says which hub that is (the
registrar's runs count from 1, the first member's from 1,000,000,001, the next one's from 2,000,000,001). A command
answered by another hub returns that hub's cursor; a wait or a read with `--since` goes to the hub the cursor is from.
After a hub first joins a network, `fr hub status` asks for one restart so that its cursors carry its number.

`fr hub peers` ends with the live data: `events: home 1240 sent, 318 received`, and `dropped` or `missed` when a
slow link lost some (`fr hub status` then warns on both hubs; the events themselves are stored on the hub that has
the board). `fr hub status` also warns while another hub runs a version that relays no events.

### 13.5 One registry

Every hub of a network holds every board of it: its address, alias, tags, hub list, board, profile and firmware.
A board made, renamed, tagged or deleted on one hub is the same on the others within a moment, and a hub that was
off, asleep or restarted gets what it missed when its link comes back. Nothing has to be shared by hand:
`fr devices share` toward a hub of the network answers that the row is there already.

What stays each hub's own: when it last saw a board, the USB port, what it wrote into a board's flash (`provision` in
`fr devices get`), boards it has only seen (`provisioned: false`), bindings, apps, logs, events and jobs. No Wi-Fi
password and nothing else of `secrets.json` ever crosses.

```bash
fr hub peers                # last line: registry: 14 rows; home in step, 10 sent, 0 received
fr devices get pad-c6       # replication: { row_rev, row_hub }: when the row was last written, and by which hub
```

**A new board on a member.** The registrar (the hub the others joined) still gives every address. A member asks it
over the link, so `fr devices provision`, `adopt` and `enroll` work on any hub while the registrar is reachable. While
it is not, they answer `HUB_UNREACHABLE … only that hub, the network's registrar, hands out addresses, and it is not
reachable over the hubs' link now`: start that hub and run the command again. Everything else (renames, tags, hub
lists, commands, updates) works without the registrar.

**Two edits at once.** A rename on one hub and a tag on another both stay. Of two renames of one board the one with
the higher `alias_rev` stays (a hub that renamed twice wins over one that renamed once), then the later one. Of two
other edits of one row the later stays.

**Two boards given one name** on two hubs that could not see each other: the later one keeps it. The other becomes
`<name>-<3 hex digits of its id>` with the tag `renamed`, its board is told, and `fr hub status` on every hub says so
until you settle it:

```bash
fr devices set kitchen-a1f --alias pantry --tag -renamed
```

**An address that differs.** If two hubs hold one board at two addresses (a database restored from a backup, two
networks merged by hand), neither is changed. `fr hub status` and `fr hub peers` on both name the board and the two
addresses, and `fr hub peers` shows `differs` until it is settled. The registrar's is the network's. On the other hub:

```bash
fr devices enroll <device id> --addr <the registrar's addr> --net <net id> --alias <alias>
```

A board that carries the other address in its flash needs its identity written again (`fr flash <board> --plan identity`).

**A hub that was not updated** does not replicate. `fr hub status` on the updated hub says
`hub home does not replicate the registry`, `fr hub peers` shows `does not replicate`, commands for its boards still
pass, and `fr devices share` still gives it a row by hand. Update it and restart it.

**The first time two hubs from before this version meet**, each takes the rows it lacks. For a row both hold, nothing
changes where the two copies agree. Where they differ: the registrar's tags, board and profile stay, the alias with
the higher `alias_rev`, the hub list with the higher rev, the firmware of the hub that saw the board last, and never
another address (above). Boards connected to a hub that gained rows receive the network's address table (the
DIRECTORY, as after any provisioning); no board is told a new name or hub list unless its row's really differed.

**Deleting a board.** There is no command for it yet. A row removed from one hub's database is removed from the
others and stays removed: a hub that returns with an older copy within a year does not bring it back. A board that
still connects afterwards shows up again as seen only.

Not yet through the link: the dashboard's live pages and an app's events and streams for a board on another hub
(the dashboard lists such a board as online, and its buttons reach it), and the registry itself (§13.2).

---

## 14. Firmware updates

| What | Command |
|---|---|
| Build, update over the best link, wait for it to come back | `fr deploy cam-esp32` |
| The same over Wi-Fi only | `fr deploy cam-esp32 --via wifi` |
| Several boards at once | `fr deploy pad-c3,pad-c6` |
| Update to a specific build | `fr ota cam-esp32 --build <build id>` |
| Switch a board to another profile (over USB) | `fr build --profile c3o-analog`, then `fr flash pad-c3b --profile c3o-analog --plan full` |
| Flash over USB (a board that lost its firmware) | `fr flash cam-esp32 --plan full` |
| List built firmware | `fr artifacts ls` |

An update that fails its health check after reboot rolls back to the previous firmware on its own. On the dashboard,
**Provision** › Over the air previews an update (what each device would do) and then deploys it, with a ring per device.

---

## 15. Testing

| Tier | What it covers | Command |
|---|---|---|
| host | TypeScript unit tests (vitest) and the firmware's C++ host tests | `fr test run --tier host` |
| target | Gates on real boards | `fr test run <gate> --tier target` |
| hil | Gates that use the HIL fixture's wired lines | `fr test run --tier hil` |
| sim | The virtual fleet | `fr test run --tier sim` |

The target gates, with whether they need a person or USB:

| Gate | Checks | Needs |
|---|---|---|
| t-camera | Photos, live stream, card, settings, USB bridge | nothing |
| t-scale | Scale rate, noise, tare across a reboot, the round display's layout | nothing (a person with `--known-g`) |
| t-audio | Speaker-to-microphone loopback, quiet, level | nothing (a person with `--voice`) |
| t-led | LED commands | nothing |
| t-codec | The wire codec against golden vectors | nothing |
| t-flood | Broadcast delivery across the network | nothing |
| t-display | What panels draw | a person |
| t-input | Button gestures | a person, USB |
| t-lat | Button-to-hub latency | wiring, USB |
| t-ota, t-prov, t-ports, t-pres | Updates, provisioning, ports, presence | a person, USB |
| t-nn, t-gw-link, t-vbat, t-agent | Node-to-node, gateway, battery, the agent flow | a person |

Pass extra flags to a gate with `--args=<flag>` once per word; add `--allow-human` when you are at the bench. `fr test report <job id>` shows a finished run's figures.

---

## 16. Apps and the SDK

Web apps live in `web/<name>/` and the hub serves each at `http://127.0.0.1:7420/apps/<name>/`, with an access token injected:

| App | What it does |
|---|---|
| [/apps/cam/](http://127.0.0.1:7420/apps/cam/) | The camera: live view, snapshots, flash, settings, card recordings |
| [/apps/csi/](http://127.0.0.1:7420/apps/csi/) | Wi-Fi sensing: subcarriers, motion, the four sound modes |
| [/apps/scale/](http://127.0.0.1:7420/apps/scale/) | The scale: live weight, plot, tare, calibration, the weight on the round display |
| [/apps/demo/](http://127.0.0.1:7420/apps/demo/) | The M1 demo: two pads' button events, an app-level relay with its latency, a broadcast ping |

To write your own, generate a typed device registry for `@fractonica/sdk` into your app:

```bash
fr codegen client --out web/myapp/src/fractonica
```

The SDK gives you the devices by alias, their commands and events, and live streams (camera frames, CSI blocks, audio).

---

## 17. AI agents

Every `fr` command is also an MCP tool, served by `fr mcp`.

- **Claude Code:** run `claude --plugin-dir <checkout>/plugin`, or install it once with `/plugin marketplace add <checkout>` then `/plugin install fractonica@fractonica`. Its skills teach the agent each area: fleet-ops, build-deploy, e2e-verify, hil-rig, audio, camera and scale.
- **Other agents:** [`plugin/AGENTS.md`](../plugin/AGENTS.md) has the same guidance with CLI equivalents.
- **The hub:** `fr mcp` starts no hub by itself; start it from Terminal first (`fr hub start`). To let the first tool call start it, run the server as `fr mcp --autostart`, or set `FR_MCP_AUTOSTART=1`, or `"mcp": {"autostart": true}` in `~/.fractonica/config.json`.
- **Safety:** tools that flash, provision, update over the air, reset or delete are marked destructive, so the agent's client asks you before running them. A Wi-Fi password never goes through an agent: you type it into `fr net set --password-stdin`.
- Ask in plain words, for example "take a photo with cam-esp32 and show it to me" or "record ten seconds from mic-s3".

---

## 18. Troubleshooting

| You see | Do this |
|---|---|
| `fr` says no hub is running | `fr hub start` from Terminal. |
| `idf.py` or esptool: "Could not exclusively lock port" | The hub watches that port: `fr serial idf <board> flash monitor`, or `fr serial lease <board> -- <command> '$FR_PORT'`, or `fr ports lend <port>`, or `fr ports ignore <port>`. |
| A board you plugged in shows `not opened` in `fr ports` | The hub does not know it yet: provision it (section 13), or `fr ports claim <port>` if it already runs the node firmware. |
| A board is `offline` | Check its power and `fr logs <board>`; reset it with `fr devices reset <board>` if it is on USB. |
| `HUB_VERSION_MISMATCH` after pulling code | `fr hub restart` (`--force` if it refuses), then reconnect the MCP server in Claude Code (`/mcp`). |
| `fr hub restart` refuses: a job is working | Wait, or cancel it (`fr jobs ls`, `fr jobs cancel <id>`). An open CSI or camera app page keeps its stream job alive: close the page, or use `fr hub restart --force`. |
| A flash fails to connect | Reset into download mode: `fr devices reset <port> --mode bootloader`, or hold BOOT and tap RST, then flash again. |
| A board joined the wrong Wi-Fi | `fr net ls`, then `fr flash <board> --plan identity --network <name>`. |
| The dashboard looks out of date | `fr doctor --fix` rebuilds it (or `pnpm -C packages/dashboard build` in the checkout). |

---

## 19. The bench

| Alias | Board | Profile | What it is for |
|---|---|---|---|
| cam-esp32 | AI-Thinker ESP32-CAM (ESP32, OV2640, micro-SD) | e32a-cam | Camera |
| scale-c6 | ESP32-C6-WROOM-1-N8 board with an HX711 and a round GC9A01 | c6w-scale | Weighing scale, round display |
| lcd-c6 | Waveshare ESP32-C6-LCD-1.47 (ST7789 172×320, micro-SD) with a DS3231 clock | c6l-lcd | Display, SD card, real-time clock |
| mic-s3 | ESP32-S3 WROOM-1 N16R8 | s3a-audio | Microphone, speaker, electrosmog detector |
| csi-c5 | DOIT ESPC5-32 (ESP32-C5) | c5d-csi | Wi-Fi sensing on 5 GHz |
| pad-c3, pad-c3b | ESP32-C3 with a 0.42" OLED | c3o-pad | Button, LED, display |
| pad-c6 | ESP32-C6 SuperMini | c6-pad | Button, LED |
| pad-s3 | Waveshare ESP32-S3 1.9" LCD | s3l-pad | Button, LED, display |
| pad-s3t | Waveshare ESP32-S3 2" touch LCD | s3t-pad | Button, display, touch |
| gw-c6 | nanoESP32-C6 | c6g-gateway | ESP-NOW gateway on USB |
| stepper-c3 | esp32c3-supermini | c3s-stepper | micro stepper on a DRV8833 |
| (fixture) | ESP32-S3 DevKitC-1 | s3k-fixture | HIL fixture: presses buttons and sets voltages on wired lines |

Boards that are not plugged in show as `unknown` or `offline` in `fr devices ls`; that is normal.

---

## 20. Fractonica time

`fr time` reads the Fractonica clock: the eclipse-anchored harmonic clock of the sibling repository
[`core`](https://github.com/fractonica/core), the same one the site [fractonica.com](https://fractonica.com) shows.
Every number and word comes from the core itself, through its WebAssembly build (`packages/time`, a copy of the web
repository's module pinned by `packages/time/time.lock`); `fr` only reads your arguments and lays the answer out.
It needs no hub and no network: it works right after `pnpm install`.

1. **Now.** The stamp first, then the Pentad, the four majors with the quarter each is in, the Helion and θ counting
   down to the end of their quarter, the solar sync, and the next thresholds of the coarser levels, as the site's NOW
   screen lists them. At SPEC test vector A (`--at 2026-10-08T12:00:00Z`):

   ```text
   α#6 β#4 γ#9 δ#3 ε#5 34η 29ι 21λ 3ν

   PENTAD II  ·  HELION 2 OF 5

   α  ALPHA HEXAFRACTON  VALLEY
   β  BETA TETRAFRACTON  VALLEY
   γ  GAMMA NONAFRACTON  VALLEY
   δ  DELTA TRIFRACTON   END

   η  HELION   1 OF 11  END IN   6ι 43λ
   θ  BETWEEN  8 OF 9   NODE IN  43λ 21ν

   SOLAR SYNC  4 820
   DRIFT       −6 235λ
   NODE IN     2η 24ι

   NEXT THRESHOLDS
   ζ    PEAK    1η 33ι
   SUN  NODE    2η 24ι
   ε    NODE    4η 24ι
   δ    END     43η 6ι
   γ    VALLEY  4ε 23η
   ```

   Pure Fractonica by default: no Gregorian date, clock time, time zone or Earth unit. `--earth` adds the civil
   translation of each line, marked ⊕ (`⊕ THU 8 OCT 2026 · 12:00:00 UTC`, `⊕ 12:56:12 · 56 min 12 s`), in the Mac's
   local time zone.

2. **Watch it.** `fr time --watch` redraws at the instant the core says the reading next changes (about every
   Blink, 0.31 s), never on a fixed timer. Ctrl-C ends it.

3. **The ladder.** `fr time ladder` lists every level from α down to ν (the Blink; `--to <level>` for fewer or more,
   down to χ): the running cycle's place in its parent, the quarter it is in, and how long until that quarter ends.
   A level is named by its symbol (`η`), its word (`Eta`, `Helion`) or its depth (`7`), as the DEPTH column numbers
   them.

   ```text
   LADDER  ·  α#6 β#4 γ#9 δ#3 ε#5 34η 29ι 21λ 3ν

   DEPTH  RUNG  KIND     CYCLE    QUARTER  ENDS IN
       1  α     ALPHA    6 OF 18  VALLEY   1γ 4ε
       2  β     BETA     4 OF 5   VALLEY   1γ 4ε
       3  γ     GAMMA    9 OF 13  VALLEY   4ε 23η
       4  δ     DELTA    3 OF 5   END      43η 6ι
       5  ε     NUCLIDE  5 OF 5   NODE     4η 24ι
       6  ζ     BETWEEN  4 OF 7   PEAK     1η 33ι
       7  η     HELION   1 OF 11  END      6ι 43λ
       8  θ     BETWEEN  8 OF 9   NODE     43λ 21ν
       9  ι     PREON    2 OF 4   NODE     11λ 9ν
      10  κ     BETWEEN  2 OF 5   VALLEY   1λ 15ν
      11  λ     FLAVON   9 OF 13  PEAK     2.8ν
      12  μ     BETWEEN  1 OF 5   VALLEY   0.29ν
      13  ν     BLINK    4 OF 5   NODE     0.037ν
   ```

4. **Convert.** `fr time stamp 2026-10-08T12:00:00Z` prints the stamp and the date in words;
   `fr time parse 'α#6 β#4 γ#9 δ#3 ε#5 34η 29ι 21λ 3ν'` prints the instant it names (the first microsecond of its
   finest unit) in Unix µs, UTC and local time. A partial stamp (`'ε#5 34η'`) is read in today's date, or in the date
   of `--context <instant>`; ASCII letters work too (`a#6 b#4 g#9 …`).

5. **Plan.** `fr time next η --quarter end --count 3` lists the next three Helion ends, each with its stamp and how
   far away it is; `fr time span <from> <to>` says the span between two instants (`+6ι 43λ`); `fr time sync` shows
   the solar sync, its Pentad and drift. The catalogue's first and last solar syncs are partial, so inside them
   `fr time sync` has no reading (`INVALID_ARGS`, `details.reason: partial_sync`) while the other commands read
   normally.

**Instants.** Every `--at`, `<from>`, `<to>` and `<instant>` takes `now`; Unix time in **seconds**
(`1791460800`, `1791460800.25`; a bare number is always seconds, whatever its length), or in milliseconds or
microseconds with a suffix (`1791460800000ms`, `1791460800000000us`); a stamp; or an ISO date
(`2026-10-08T12:00:00Z`; one without an offset is read in the local time zone). Unix time before 1970 is negative
and is written as it is, as an argument or an option value (`fr time stamp -6000000000`,
`fr time span -6000000000000000us now`). Readings exist only inside the catalogue of Saros 141, from 1613 to 2857
(`α#1` to `α#18`): an instant outside it is refused (`INVALID_ARGS`, exit 64, "OUT OF CATALOGUE · α#1 – α#18"),
never extrapolated. The refusal names the Gregorian bounds only with `--earth` (marked ⊕); `--json` gives them in
`details` as Unix µs (`first_us`, `last_us`).

**`--json`** prints the standard envelope (`{ok, data, cursor}`); instants in it are Unix µs as decimal strings
(the catalogue runs past 2^53 µs). The same answers come from the hub and from agents: the operations `time_now`,
`time_convert`, `time_ladder` and `time_next` (REST and MCP; `fr mcp` answers them itself, with no hub).

**Threshold events.** While it runs, the hub publishes `time.threshold` as each quarter boundary of a level passes:

```bash
fr wait event time.threshold --since "$(fr events --json | jq -r .data.next_cursor)" --where '{"symbol":"η"}' --timeout 110
```

α down to η (the Helion) are stored with the other events (about 20 a day); θ and ι are live only (seen by `/ws`, the
dashboard's Live view and a wait already waiting, never stored); finer levels are not announced. Change this in
`~/.fractonica/config.json`: `"time": {"durable_to": "δ", "live_to": "η"}`, or `"thresholds": false` for none.
`durable_to` goes down to θ at most (θ adds about 170 rows a day, and `hub.db` keeps event rows); a deeper level is
logged as a config problem and θ is used. `live_to` goes down to ν (the Blink). After the hub has been asleep, the
thresholds of the last minute are announced in time order; older ones are skipped.

---

## 21. The dashboard

The hub serves the dashboard at <http://127.0.0.1:7420/>. It is drawn in the same instrument language as
[fractonica.com](https://fractonica.com): dark, hairline rows, engraved capitals, light for progress (never a bar or a
percentage), and nothing that blinks. Whatever you can press sits on a plate (a button, a tab, a fold, a row that
opens a page); what is only to be read has none. The rail (left on a computer, along the bottom on a phone) has six pages; the
switch at its top (on a phone, in the page's top right corner) is **PURE / EARTH**, as on the site: pure mode shows
only Fractonica units, Earth mode keeps them and adds the clock time, dates and physical units after a ⊕. On the
Bench, pure mode puts a small ⊕ where a guide, a part or a drawing states a rating or a size (“below ⊕ it is damaged”),
so every sentence keeps its shape and a safety limit is never silently gone; a guide's step or safety line also says
*values in earth*, and Earth mode shows each value after its ⊕. Identifiers (a USB serial, a MAC) are always shown as
written.

| Page | What it is for |
|---|---|
| **Hub** | The present moment as a small instrument computed by the temporal core, the fleet as beads (one per device, lit when online) with each device's last word, one line of hub health (the hub's last checks at once, with when they ran, and **Run fixes** for what the hub can fix itself), a banner for what **needs you** (an agent's prompt, a port lent to a program) and, quietly, what is **running**. At most ten devices are listed, those that need a look first; all of them are on Devices. |
| **Devices** | Every registered board on one line: presence, profile and chip, signal, firmware, its last event, Identify. **PROVISION A BOARD** starts a new one. |
| **Device** (open one) | One device in four sub-pages, **INSTRUMENTS · ACTIVITY · FACTS · ENGINEERING**, under its name, presence, Identify and Rename. **Instruments** has one row per instrument (a light, the camera, a button, …) with its reading and at most one quick control, beside a glance (link, last word, clock) and its last events; a row opens that instrument's own page. **Activity** holds its events (filter by instrument) and its log; **Facts** its link, clock sync, running state, build and registry; **Engineering** diagnostics, bindings, OTA history, every raw command and the raw record. See *The device page* below. |
| **Provision** | **New board**: six steps (plug in · network · board · name · flash · done), with a ring of nine arcs that light as the hub's stages complete; the flash arc fills with the bytes written. **Firmware**: profiles with Build, the builds kept, recent jobs. **Over the air**: preview, then deploy. A job page, `#/provision/<job>`, survives a reload. |
| **Live** | The event stream as rows, newest first, with Fractonica times (⊕ the clock time in Earth mode). Filter by device and by type; Pause holds the list while events keep coming. |
| **Bench** | The wiring guides step by step (tick each step off; the hub remembers), the parts catalogue with what is on hand, and a shopping list. Old links to `/apps/bench/` land here. |
| **Settings** | **Health** (`fr doctor`'s checks: **Run fix** on a check runs that check's fix only, and its row says what the fix changes; a fix that rewrites the `fr` command in `~/.local/bin` asks first, and a hub started with its own `FR_HOME` leaves that one to you as a command to copy; other fixes as a command to copy or steps), **Networks** (Wi-Fi for the nodes, add or change one; a password is never shown again), **Ports** (every USB port and who holds it), **Agents** (prompts, leases, agent jobs), **Storage** (`hub.db`), **About** (versions and what this build is pinned to). |

**The device page.** Open a device from **Devices**. Each sub-page has its own address
(`#/devices/<alias>`, `…/<instrument>`, `…/activity`, `…/facts`, `…/engineering`), so Back walks the tabs.

- **Instruments** lists the device's instruments in port order: the port, the name, what it is (LIGHT, CAMERA,
  BUTTON, ANALOG INPUT, …), its reading in words and, for a light, its on/off ring; a camera row has a quiet
  **WATCH**. Four or more of one kind (an analog board's `ch0`–`ch13`) fold into one row that opens in place. A device
  with one instrument shows that instrument's page right there.
- **An instrument's page** (press its row) has a strip of its sibling instruments (←/→ move along it) and a caption
  (`CAMERA · PORT 3 · OV2640 · UP TO UXGA`). A generic instrument shows its **readings** (a property a command sets is
  its own switch or slider), its everyday **actions**, each with a line saying what it does and a button that names
  it (`BLINK STATUS`; never "Send"), its events, and at the foot **EXPERT · ITS OWN COMMANDS ›**. A choice is a list
  of words (*hub*, *card*, *hub and card*), a duration is a span with its rung (ν λ ι), optional fields sit under
  **MORE SETTINGS**, and a required field stays empty until you fill it: an example is only a hint (`e.g. 3`). A
  board built with test injection adds a **SIMULATE** fold (button gestures, an analog value).
- **Engineering › Commands** has every command each instance takes (the node's own too), as the same forms, each with
  **SEND AS JSON** for what a form cannot say. A command whose id only the hub can issue (a camera or CSI stream, an
  audio play) is never a form: the row says how the hub runs it, with a link to the page that does it or the `fr`
  command to copy.

**The camera's page** (`#/devices/cam-esp32/cam`, or **WATCH** on its row, which starts the view at once):

- Under the buttons, each one says what it does, or why it waits (`PHOTO · RECORD… The camera is watched in another
  place too; they wait until that view closes.`). The lit button is the one you most likely want: **WATCH** when
  nothing runs, **STOP** while you watch, **STOP RECORDING** while a recording runs.
- **WATCH** shows the camera live in the page, through the hub. **STOP** ends it; leaving the page or hiding the tab
  stops it too (it comes back when the tab does, "Paused while this tab was hidden"). If the view is stopped from
  elsewhere (another tab, the CLI) the page goes back to idle and says so. **KEEP THIS FRAME** saves the frame you see
  to this computer. A view that ends because you left the page leaves no notice behind on the next page.
- **Watched in another place:** when another tab or app already shows the camera, the page says so (STATE *watched in
  another place*) and **WATCH** joins that view; nothing here stops someone else's view.
- **PHOTO** takes one photo on the hub (with the flash LED when **with the flash** is on). When nothing was showing,
  the photo appears in the view itself, captioned *the photo* with **SAVE**; while watching, the view pauses around it
  and a small copy shows under the buttons. The line under the buttons gives its path (in pure mode from the captures
  folder, the date in the file name a ⊕; **COPY PATH** copies it whole).
- **RECORD…** opens the recording settings in place: where (**HUB**, **CARD**, **HUB AND CARD**; the card choices
  need a card mounted at boot), how long (until stopped, or a span), the pace (as fast as it can, or one frame every
  span), whether to show it while it records, and under **MORE SETTINGS** a frame count, frame size and detail.
  **START RECORDING** starts a hub job: a small ring shows how far it is, **STOP RECORDING** (lit) stops it and keeps
  what came, **STOP WATCHING** only hides the view (the recording goes on), and the end says how many frames, how it
  ended and where they are, with its first and last frame to open. A recording to the card adds its row to **CARD
  RECORDINGS** at once.
- **A recording started elsewhere** (another tab, the CLI, an agent, or this page before you left it) shows here as
  *recording to the hub* with **STOP RECORDING** and **WATCH**, which joins it; leaving the page never stops it.
- **Now** says its state in words (idle, watching, recording to the card, busy, offline, …), the frame size and
  detail, the rate per Blink, the last frame's size, this stream's counts, how long it has run, where it is watched,
  the card (and room for about how many frames) and the sensor; Earth mode adds frames a second and megabytes.
- **SENSOR SETTINGS** (kept until the board restarts): frame size (sizes above what its buffers take are off),
  detail from coarse to fine, flip, mirror, brightness, contrast and saturation. Each change is sent once your hand
  rests; while watching, a size or detail change restarts the view. After a restart the fold offers **APPLY AGAIN**.
- **CARD RECORDINGS** (when a card is in) lists them newest first: **PLAY** brings one to the hub and shows it (the
  state reads *playing recording 7 from the card*), **DELETE** (a quiet red word) asks in place and removes it from the
  card (copies on the hub stay). While a stream runs, both wait (the fold's aside reads STREAMING). While a recording
  plays, its ring stands in PLAY's place and **STOP PLAYING** under the view stops it (what came stays on the hub).
- **ON THE HUB** lists the camera's recent photos and recordings that came to the hub, each with a small picture (the
  photo, or a recording's last frame), its first and last frame to open, and its path.
- **One stream at a time.** When the camera is busy with a stream that is not shown (a photo or a recording taken from
  the CLI), the buttons that wait say why, and **STOP THAT STREAM** stops it. Engineering › Commands offers **STOP
  STREAM <id>** for the running stream too. When the board refuses a start because it still runs a stream the hub lost
  track of (its link dropped mid-stream), the page says so instead of a failure, with **STOP IT ON THE BOARD**.
- **Activity** names each stream by what it was for (*cam's live view ended: stopped, 38 frames*, *cam took a photo*,
  *cam sent recording 7 from the card*) and each command by what it asked (*the dashboard asked status to toggle*);
  press a row for its raw type and fields. When the board goes offline mid-view, the page drops the stream's rows and marks
  the card *as last seen*.

**Provisioning a board, step by step.**

1. Open **Provision** and plug the board in with a USB cable that carries data. It appears within a moment, lit; a
   board you plug in while the page is open is chosen for you. If something else holds the port (a serial monitor, a
   Web Serial tab), or the port is lent or ignored, the page says so and offers the fix (Release, Stop ignoring,
   Check again) before anything starts. A port's policy (Lend, Ignore, Claim) is behind its quiet **Port…**:
   provisioning needs none of it.
2. **Network:** pick one of the stored Wi-Fi networks, or **Add a network** in place. A 5g-only network is muted for
   a board known to be another chip than the ESP32-C5.
3. **Board:** the profiles for the board's chip come first, built ones before the rest; **Automatic** lets the hub
   choose. An unbuilt profile offers **Build and provision**.
4. **Name:** checked as you type (31 characters at most, letters, digits and hyphens; not one another board has).
5. **Provision:** the ring lights stage by stage. **Stop** asks once more in place (**Keep going** leaves it running);
   a stopped job is drawn where it stopped, not as an error. The job's output is folded under the steps. The page's
   address carries the choices, so a reload shows them.
6. **Done:** the board's name, profile, Wi-Fi and whether it reached the hub, with **Open device** and **Identify**. A
   board that was flashed but did not join the Wi-Fi leaves the ring's JOIN arc in the error colour and offers
   **Change the network and provision again** and **Open its log**.

**When the hub stops answering**, a line at the top of every page says so; until it is back, presence is drawn as not
known and actions are refused at once (nothing is sent to run minutes later).

**Ports on the dashboard.** Each port says what it is to the hub: *watched by the hub*, *lent* (with when the lease
ends), *in use by a job*, *held by* another program, *ignored* or *not watched*. **Lend** hands it to another program
for a span you pick (30λ to 3ι, the lease cap of 30 minutes); **Release** takes it back; **Ignore** and **Stop
ignoring**, **Claim** and **Unclaim** change the port policy. The same words and buttons are on Provision's first step
and in Settings › Ports. The dashboard never opens a port itself.

---

## 22. Stepper motor

**The board:** stepper-c3, an **ESP32-C3 Super Mini** (black, blue LED on GPIO8, BOOT on GPIO9) driving a **10 mm
two-coil micro stepper** with a brass pinion through a **DRV8833** dual H-bridge module with the TB6612-style pinout:
AIN2 on GPIO5, AIN1 on GPIO6, STBY (the DRV8833's nSLEEP) on GPIO7, BIN1 on GPIO10, BIN2 on GPIO20, the motor supply
(VM) from the board's 5V pin, that is from USB. This module does not bring out nFAULT, so the node cannot see a driver
fault; the chip still protects itself. The motor is the `motor` instance (`fr.stepper`). The wiring guide is on the dashboard's Bench page:
<http://127.0.0.1:7420/#/bench>, guide `stepper-c3`; follow it before the first power-up, its first steps measure the
coils and check the module's STBY pull-up.

**What it does:** moves to a position or by some steps, speeding up and slowing down smoothly; spins at a speed until
stopped; stops smoothly, halts at once, holds the shaft and lets it go. The position is counted in **steps**: at the
default eighth steps (`micro8`) one full step of 18° is 8 steps, so one turn of a 20-step motor is 160. There is no
current sensing: the coil current is capped by the settings `coil_ohm` and `run_ma`, which you set from the measured
coil. At boot the coils are off, the position is 0 and *position known* is false until you set it (`zero`).

### 22.1 First run, step by step

1. **Provision it** (section 13) with the profile `c3s-stepper` and the alias `stepper-c3`. Then
   `fr devices get stepper-c3` shows `motor.motion released`.

2. **Measure one coil** with a multimeter, probe to probe across two motor pins (the guide's first step): say 20 Ω.
   Both coils read within a tenth of each other. On the bench motor the coils alternate: pins 1 and 3 are coil A,
   2 and 4 coil B (pin 1 to AO1, 3 to AO2, 2 to BO1, 4 to BO2).

3. **Set the run current.** The profile starts from the bench motor (rated 3.3 V, about 160 mA): `coil_ohm` 20,
   `supply_mv` 5200, `run_ma` 150 (`motor.run_duty_pct` about 58) and 30 % of it at rest. `supply_mv` must be the
   real VM: set lower, the cap lets more current through than `run_ma` says. For another coil, aim at 60 % of the motor's rated
   current: `run_ma = 0.6 × V_rated / R`, and with the rating unknown assume 3 V (30 Ω → 60 mA):

   ```bash
   fr send stepper-c3 motor.configure '{"coil_ohm":30,"run_ma":60}'
   fr devices get stepper-c3            # motor.run_duty_pct about 35
   ```

   The settings are kept across reboots. `fr send stepper-c3 motor.reset_settings` forgets them (only while the
   coils are off).

4. **Hold test:** `fr send stepper-c3 motor.hold`. The shaft resists turning by hand. After 30 s the can is warm at
   most; too hot to touch means a lower `run_ma`. Then `fr send stepper-c3 motor.release`.

5. **One slow turn:**

   ```bash
   fr send stepper-c3 motor.configure '{"max_speed_hz":160,"accel":800}'
   fr send stepper-c3 motor.move_by '{"steps":160}'
   ```

   Mark the pinion: it turns exactly once and stops on its mark, and `fr events stepper-c3 --types 'motor.*'` ends
   with `motor.done` `reached`. If it turns more or less than once, the motor's step angle differs: `steps_per_rev` is
   the steps a turn took divided by 8. Turning the wrong way: `motor.configure '{"invert":true}'`, or swap the two
   wires of one coil.

6. **Repeatability:** five times `motor.move_by '{"steps":1600}'` then `'{"steps":-1600}'`. The mark comes back
   exactly, and each `done` says `reached` with `slips` 0.

7. **Top speed:** a spin may not be faster than `max_speed_hz` (step 5 set 160), so first
   `fr send stepper-c3 motor.configure '{"max_speed_hz":10000}'`. Then `motor.jog '{"speed_hz":800}'`, then 1600,
   2400, 3200, … with `motor.stop` between, until it buzzes without turning (a stall: harmless at this current). Set
   `max_speed_hz` to 70 % of the last speed that turned. Then raise `accel` with `motor.configure` until a one-turn
   move misses its mark, and set it to half of that. Expect 2,400–6,400 steps a second at eighth steps on 5 V.

8. **Heat:** five minutes of turns, each waiting for its `done`:

   ```bash
   for i in $(seq 50); do
     c=$(fr send stepper-c3 motor.move_by '{"steps":160}' --json | jq -r .cursor)
     fr wait event motor.done --since "$c" --timeout 10
   done
   ```

   The motor and the DRV8833 are warm, not hot.

9. **Fault path** (a debug build): `fr send stepper-c3 motor.inject_fault` gives `motor.fault` `injected` and motion
   `fault`. `motor.hold` within a second answers BUSY; after it, OK.

10. **Keep the result:** put the measured `coil_ohm` and `run_ma` (and `steps_per_rev` if it differs) into the
    profile's motor config too, so a freshly provisioned board starts right.

### 22.2 Commands and what `done` says

| Command | What it does |
|---|---|
| `motor.move_to '{"position":160}'` | Goes to a position (optional `speed_hz`, `accel`, at most the configured ones). |
| `motor.move_by '{"steps":-20}'` | Moves by some steps from the running move's target, or from where it rests. |
| `motor.jog '{"speed_hz":400}'` | Spins (negative: backward) until stopped, or for `seconds`. Speed 0 is a stop. |
| `motor.stop` | Slows down to rest. |
| `motor.halt` | Stops at once and holds; a fast motor may lose its place (*position known* becomes false). |
| `motor.hold` / `motor.release` | Coils on at hold power / off. Hold also clears a fault. |
| `motor.zero '{"position":0}'` | Calls where the shaft is now that position, without moving it; *position known* becomes true. |
| `motor.configure '{…}'` | Speeds, acceleration, coil and current, hold power, when to let go, direction, soft limits. |

A move answers OK at once; `motor.done` ends it. A newer move or spin replaces the running one without stopping, and
the replaced one has no `done`. The coils drop to hold power after a motion and go off `release_ms` (1 s) later.

| `done` reason | Meaning |
|---|---|
| `reached` | It arrived exactly on its target. |
| `stopped` | `stop` (or a spin of speed 0) brought it to rest. |
| `halted` | `halt` stopped it at once. |
| `released` | `release` turned the coils off while it moved. |
| `limit` | It reached a soft limit (`limits` on, between `limit_min` and `limit_max`). |
| `fault` | The driver reported a fault (`motor.fault` comes first): the coils are off. |
| `hub_lost` | It was started from the hub, and the hub fell silent for 10 s: it slowed to a stop by itself. |
| `elapsed` | A spin's `seconds` ran out. |

`slips` counts the times the step timer ran late and the motor started its ramp again from rest; it is 0 normally.

### 22.3 Stepper troubleshooting

| You see | Do this |
|---|---|
| Moves answer BUSY | A fault's back-off (1 s; a minute after three faults in a minute), or `limits` on with the position not known: `motor.zero` first. |
| Moves answer INVALID_ARGS | `speed_hz` above the configured `max_speed_hz`, `accel` above the configured `accel`, or a position beyond the soft limits (or ±1,000,000,000): raise them with `motor.configure` first. |
| `motor.fault` `driver` | The DRV8833 reported a short or over-heat (only on a module that brings out nFAULT, bound as `fault`). Unplug USB and check the motor's wires; then `motor.hold`. |
| The motor warms but never moves, snaps or holds | The coils carry current but the rotor does not follow: a faulty motor (its rotor slips on the shaft). First check that the warm motor is the one you watch (these come two on a cable); then fit another. |
| It buzzes but does not turn | Too fast or too weak: lower `max_speed_hz` or `accel`, or raise `run_ma` within the motor's rating. |
| It misses its mark after fast moves | Steps were lost at speed: lower `accel`, or try `step_mode` `micro16` (with the coils off: `motor.release` first). |
| It stops turning or lost its place with no `motor.fault` | stepper-c3's module has no fault pin: an over-current or over-heat stops the bridge without a report. Unplug USB, check the motor's wires and let it cool; then `motor.zero` again. Or the supply sagged: below about 2.6 V the DRV8833 stops driving without reporting it and resumes by itself. Use a stronger USB port or supply, then `motor.zero` again. |
| The shaft is hot | `run_ma` is too high for the coil, or `coil_ohm` is set above the real resistance: measure again. |

## 23. Buzzer

**The part:** a **passive buzzer module** with three pins, S, + and − (KY-006 style, no transistor), on **stepper-c3**
(section 22's ESP32-C3 Super Mini): S on **GPIO4**, − on GND, + left free. Passive means it has no oscillator of its
own: the board makes a square wave at the note's pitch, so it plays tones and melodies, and the wave's duty sets how
loud it is. It is the `buzzer` instance (`fr.buzzer`, driver `ledc_buzzer`) of the profile `c3s-stepper`. The wiring
guide `stepper-c3` on the dashboard's Bench page (<http://127.0.0.1:7420/#/bench>) has a section for it.

**What it does:** beeps (once, a number of times, or until stopped), plays a tone at a pitch for a length, plays a
short melody of up to 32 notes, and sets its volume. One sound at a time: a new one replaces the one playing. Each
sound ends with a `buzzer.done` event that says how it ended. The motor and the buzzer run side by side.

### 23.1 First run, step by step

1. **Meter the module** before wiring it (the guide's first buzzer step), the module off the board, the multimeter on
   Ω:
   - S to − reads **open**: a piezo disc. Wire S straight to GPIO4.
   - S to − reads **10–50 Ω**: a magnetic buzzer. Its coil would draw more than a GPIO should give: put a **100 Ω
     resistor in series with S**. It is a little quieter and safe for the pin.
   - + to S and + to − read open: + is not connected. Leave it free.
2. **Wire it**, USB unplugged: S to GPIO4 (through the resistor for a magnetic buzzer), − to GND.
3. **Firmware:** the buzzer is in `c3s-stepper` since buzzer-b1. Build the profile on the lab hub
   (`fr build --profile c3s-stepper`) and update stepper-c3 (`fr ota` or a flash; section 14). The hub that holds the
   board must know `fr.buzzer` too: a hub started before this version needs a restart. Then
   `fr devices get stepper-c3` lists `buzzer` with `playing` false and `volume` 50.
4. **One beep:**

   ```bash
   fr send stepper-c3 buzzer.beep
   fr events stepper-c3 --types 'buzzer.*'      # ends with buzzer.done {sound: beep, reason: done}
   ```

5. **A tone for a second, then a sweep** to find the loudest pitch (a magnetic buzzer is loudest near its resonance,
   about 2–3 kHz):

   ```bash
   fr send stepper-c3 buzzer.tone '{"freq_hz":2000,"ms":1000}'
   for f in 1000 1500 2000 2500 3000 3500 4000; do
     fr send stepper-c3 buzzer.tone "{\"freq_hz\":$f,\"ms\":400}"; sleep 0.6
   done
   ```

   Put the loudest into the profile's buzzer config as `beep_hz` (default 2000), so a beep that names no pitch uses
   it: `buzzer: { cap: fr.buzzer, driver: ledc_buzzer, bind: gpio.4, config: { beep_hz: 2500 } }`.

6. **Volume:** `fr send stepper-c3 buzzer.set_volume '{"volume":10}'`, then 50 and 100, each followed by a beep. 100
   is a 50 % square wave, the loudest; 50 is half the loudness; 0 is silent (sounds still run their time). The volume
   set this way lasts until the board restarts; the profile's `volume` is the one it boots with.

7. **A melody:** a rising chime.

   ```bash
   fr send stepper-c3 buzzer.melody '{"freq_hz":[1047,1319,1568,2093],"ms":[110,110,110,330]}'
   ```

8. **Side by side with the motor:** `fr send stepper-c3 motor.move_by '{"steps":1600}'` and, while it turns,
   `fr send stepper-c3 buzzer.beep '{"count":3}'`: both run, and the motor's `done` still says `reached`.

The dashboard's buzzer page (the instrument `buzzer` of stepper-c3) has the same: BEEP, THREE BEEPS, KEEP BEEPING,
four tunes and STOP over the volume slider and the forms for a tone, beep or melody of your own. The device's Overview
row offers BEEP while the buzzer is quiet and STOP while it plays.

### 23.2 Commands and what `done` says

| Command | What it does |
|---|---|
| `buzzer.beep` | One beep at `beep_hz`. `'{"count":3,"on_ms":80,"off_ms":80}'`: three short ones; `count` 0 beeps until `stop`. Optional `freq_hz` and `volume`. |
| `buzzer.tone '{"freq_hz":440,"ms":500}'` | A tone at a pitch for a length (up to 60 s). Optional `volume`. |
| `buzzer.melody '{"freq_hz":[…],"ms":[…]}'` | Up to 32 notes: pitches (0 is a rest) and lengths, two lists of the same length. `gap_ms` (default 10) of silence ends each note, inside its length, so two equal notes sound as two; `repeat` plays it again (0: until `stop`). Optional `volume`. |
| `buzzer.stop` | Ends what plays. |
| `buzzer.set_volume '{"volume":30}'` | How loud, 0–100, for what plays now and later. |

A command answers when its sound starts; a `volume` given with a sound is for that sound only. Pitches run from
100 Hz to 20 kHz on this driver (traits `min_hz`, `max_hz`).

| `done` reason | Meaning |
|---|---|
| `done` | It played to its end. |
| `stopped` | `stop` ended it. |
| `replaced` | Another sound took its place. |
| `hub_lost` | It was started from the hub, and the hub fell silent for 10 s (or restarted): it stopped by itself, so nothing beeps forever with nobody to stop it. |
| `error` | The buzzer refused a note; it is silent. |

### 23.3 Buzzer troubleshooting

| You see | Do this |
|---|---|
| Commands answer INVALID_ARGS | A pitch below 100 Hz or above 20 kHz, a melody whose two lists differ in length or hold more than 32 notes, or a note of 0 ms. |
| `done` comes but nothing is heard | `volume` is 0 (`fr devices get stepper-c3`), or S is on + instead of GPIO4, or − is not on GND. A steady 3.3 V on S only clicks: that is normal for a passive buzzer. |
| It is quiet | The pitch is far from the buzzer's resonance: sweep (23.1 step 5) and set `beep_hz`. A 100 Ω resistor costs some loudness; with a piezo disc (S to − open) it is not needed. |
| It beeps on steady voltage by itself | It is an active buzzer (its own oscillator). `ledc_buzzer` still sounds it, but at its own pitch: tones and melodies all sound the same. |
| A 3-pin module with a transistor (VCC, I/O, GND) stays on, or sounds only when the pin is low | It is active low: set `active_low: true` in the profile's buzzer config, and power its VCC from 3V3, never 5 V. |
| `buzzer.done` `hub_lost` | The hub went quiet for 10 s while a sound it started was playing. Normal when the hub restarts. |
