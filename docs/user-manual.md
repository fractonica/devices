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
| "BUSY" | One stream at a time: stop the live view (**STOP** on the camera's page), **STOP THAT STREAM** or **STOP RECORDING** there, or `fr jobs cancel <job id>`. |
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
percentage), and nothing that blinks. The rail (left on a computer, along the bottom on a phone) has six pages; the
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

- **WATCH** (the page's one lit button) shows the camera live in the page, through the hub. **STOP** ends it; leaving
  the page or hiding the tab stops it too (it comes back when the tab does, "Paused while this tab was hidden").
  **KEEP THIS FRAME** saves the frame you see to this computer.
- **PHOTO** takes one photo on the hub (with the flash LED when **with the flash** is on); while watching, the view
  pauses around it. The photo shows under the view with **SAVE** and its path (in pure mode the date in the file name
  is a ⊕; **COPY PATH** copies it whole).
- **RECORD…** opens the recording settings in place: where (**HUB**, **CARD**, **HUB AND CARD**; the card choices
  need a card mounted at boot), how long (until stopped, or a span), the pace (as fast as it can, or one frame every
  span), whether to show it while it records, and under **MORE SETTINGS** a frame count, frame size and detail.
  **START RECORDING** starts a hub job: a small ring shows how far it is, **STOP RECORDING** stops it and keeps what
  came, and the end says how many frames, how it ended and where they are.
- **Now** says its state in words (idle, watching, recording to the card, busy, offline, …), the frame size and
  detail, the rate per Blink, the last frame's size, this stream's counts, how long it has run, where it is watched,
  the card (and room for about how many frames) and the sensor; Earth mode adds frames a second and megabytes.
- **SENSOR SETTINGS** (kept until the board restarts): frame size (sizes above what its buffers take are off),
  detail from coarse to fine, flip, mirror, brightness, contrast and saturation. Each change is sent once your hand
  rests; while watching, a size or detail change restarts the view. After a restart the fold offers **APPLY AGAIN**.
- **CARD RECORDINGS** (when a card is in) lists them newest first: **PLAY** brings one to the hub and shows it,
  **DELETE** asks in place and removes it from the card (copies on the hub stay). While a stream runs, both wait.
- **One stream at a time.** When the camera is busy with a stream that is not shown (a card recording started from
  the CLI, say), WATCH says so, starts by itself when it ends, and offers **STOP THAT STREAM**. Engineering ›
  Commands offers **STOP STREAM <id>** for the running stream too.

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

