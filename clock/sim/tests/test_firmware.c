/*
 * test_firmware.c - the firmware's own loop (main/app.c, app_console.c,
 * app_shot.c) and the button logic (fhal_button.c), run on the host against
 * the simulated port (sim_port.h). The same files the device builds.
 *
 *   idle hour      an hour at the Helion on the round face: a small, bounded
 *                  number of wake-ups, every one a deadline, none wasted
 *   panel          after a scripted session the panel's memory equals one
 *                  full draw of the state the UI ended in - whole frame and
 *                  band rendering, every face, both modes, late wake-ups
 *   time not set   no deadline at all until the console sets the time; then
 *                  the stamp of SPEC vector A
 *   console        every command; bad input changes nothing
 *   shot           the text of `shot` decodes to the panel's pixels
 *   settings       a burst of changes is ONE save, after the settle time;
 *                  coming back to the stored state is none; a saved record
 *                  restores the state
 *   buffers        app_init refuses a buffer it cannot draw through
 *   buttons        click, long press, double click, bounce
 */
#include <string.h>

#include "fhal_button.h"
#include "sim_port.h"
#include "sim_test.h"

#define T_A FRC_TIME_FROM_S(SIM_VECTOR_A_S)
#define STAMP_A "\xCE\xB1#6 \xCE\xB2#4 \xCE\xB3#9 \xCE\xB4#3 \xCE\xB5#5 34\xCE\xB7 29\xCE\xB9 21\xCE\xBB 3\xCE\xBD"

static sim_port_t port;
static app_t app;
static uint16_t frame_memory[240 * 320];
static uint16_t shot_memory[240 * 320];

/* Boot a device: `band` rows of frame memory (0: the whole frame). 0 on success. */
static int boot(fui_face_t face, fui_mode_t mode, uint8_t focus, int band, frc_time_t wall)
{
    const fui_face_info_t *info = fui_face_info(face);
    app_config_t config;
    app_port_t api;
    size_t whole;

    memset(&config, 0, sizeof config);
    config.face = face;
    config.format = info->mono ? FUI_FMT_MONO_PAGE : FUI_FMT_RGB565_BE;
    whole = fui_canvas_bytes(config.format, info->width, info->height);
    config.buffer = frame_memory;
    config.buffer_bytes = band > 0 ? (size_t)info->width * 2u * (size_t)band : whole;
    config.display_name = "simulated";
    config.settings.version = APP_SETTINGS_VERSION;
    config.settings.mode = (uint8_t)mode;
    config.settings.focus = focus;
    config.settings.utc_offset_min = 120;
    config.settings.brightness = 80;
    sim_port_free(&port);
    sim_port_init(&port, face, config.format, wall);
    api = sim_port_api(&port);
    return app_init(&app, &config, &api);
}

/*
 * WHOLE-FRAME mode: the panel's memory against the frame buffer the UI drew
 * into. The panel only ever received the windows the loop flushed, so
 * equality says every changed pixel was sent, to the right place, in the
 * right byte order.
 */
static int panel_is_frame(void)
{
    const fui_face_info_t *info = fui_face_info(port.panel.face);
    int x, y;

    if (app.banded) {
        return 0;
    }
    for (y = 0; y < info->height; y++) {
        for (x = 0; x < info->width; x++) {
            if (fui_canvas_get(&app.canvas, x, y) != fui_canvas_get(&port.panel.canvas, x, y)) {
                return 0;
            }
        }
    }
    return 1;
}

/*
 * Right after a full redraw (a `shot`): the panel against ONE draw of the
 * same UI state into a whole canvas. In band mode this is "the strips add up
 * to the frame". (Only valid then: between redraws the UI's clock moves on
 * while the glass keeps what was drawn.)
 */
static int panel_is_full_draw(void)
{
    static fui_ui_t copy; /* 1.5 kB: not on the stack */
    const fui_face_info_t *info = fui_face_info(port.panel.face);
    sim_frame_t reference;
    uint64_t panel = sim_frame_hash(&port.panel);

    copy = app.ui;
    copy.frame.redraw = 1;
    copy.frame.dirty = fui_rect_make(0, 0, info->width, info->height);
    sim_frame_init(&reference, port.panel.face);
    fui_ui_draw(&copy, &reference.canvas);
    return panel == sim_frame_hash(&reference);
}

static void test_idle_hour(void)
{
    unsigned wakes, redraws;
    uint64_t whole_hash;

    TEST_SECTION("idle hour: round face at the Helion");
    CHECK_EQ(boot(FUI_FACE_ROUND240, FUI_MODE_PURE, 6, 0, T_A), 0);
    sim_port_run(&port, &app, 3600u * 1000u);
    wakes = app.stats.wakes - port.end_wakes;
    redraws = app.stats.redraws;
    /* The picture changes when the Helion's two-glyph odometer steps (256
     * states in 5.05 h: about 51 an hour) or the Preon's coarse phase does
     * (16 states in 8.4 min: about 114 an hour). Nothing else wakes it. */
    CHECK(wakes >= 100 && wakes <= 200);
    CHECK_EQ(app.stats.messages, 0);
    CHECK_EQ(app.stats.timeouts - port.end_wakes, wakes);
    CHECK_EQ(redraws, wakes + 1); /* the first frame, then one per wake: no wake is wasted */
    CHECK_EQ(app.stats.saves, 0);
    CHECK_EQ(port.flush_errors, 0);
    CHECK(panel_is_frame());
    whole_hash = sim_frame_hash(&port.panel);

    TEST_SECTION("idle hour: the same through 40-row bands");
    CHECK_EQ(boot(FUI_FACE_ROUND240, FUI_MODE_PURE, 6, 40, T_A), 0);
    CHECK_EQ(app.banded, 1);
    sim_port_run(&port, &app, 3600u * 1000u);
    CHECK_EQ(app.stats.wakes - port.end_wakes, wakes);
    CHECK_EQ(app.stats.redraws, redraws);
    CHECK_EQ(app.stats.flushes, redraws * 6); /* 240 rows in strips of 40 */
    CHECK(sim_frame_hash(&port.panel) == whole_hash);
    CHECK_EQ(port.flush_errors, 0);

    TEST_SECTION("idle hour: deadlines kept when every wake is 2 ms late");
    CHECK_EQ(boot(FUI_FACE_ROUND240, FUI_MODE_PURE, 6, 0, T_A), 0);
    port.late_us = 2000;
    sim_port_run(&port, &app, 3600u * 1000u);
    CHECK_EQ(app.stats.wakes - port.end_wakes, wakes);
    CHECK(panel_is_frame());

    TEST_SECTION("idle hour: each wake comes at the UI's instant, the drawing time taken off");
    /* The simulated bus takes 23 ms for a whole round frame (sim_port.h). The
     * UI measures its sleep from the instant it was given, before the draw
     * and the flush; waiting the whole sleep after them showed every change
     * that much late. The loop must wake exactly at the instant the UI named. */
    CHECK_EQ(boot(FUI_FACE_ROUND240, FUI_MODE_PURE, 6, 0, T_A), 0);
    CHECK(port.bus_ns_per_px > 0);
    {
        frc_time_t planned = FRC_TIME_NONE;
        unsigned checked = 0, late = 0;

        port.end_us = 3600u * 1000000u;
        port.ended = 0;
        for (;;) {
            app_step(&app);
            if (planned != FRC_TIME_NONE) {
                checked++;
                late += app.asked_us != planned;
            }
            if (port.ended) {
                break;
            }
            planned = app.ui.frame.next_wake;
        }
        CHECK(checked >= 100);
        CHECK_EQ(late, 0);
        CHECK_EQ(app.stats.late_max_us, 0);
    }

    TEST_SECTION("idle hour: the lateness `info` reports is the port's");
    CHECK_EQ(boot(FUI_FACE_ROUND240, FUI_MODE_PURE, 6, 0, T_A), 0);
    port.late_us = 1700;
    sim_port_run(&port, &app, 600u * 1000u);
    CHECK_EQ(app.stats.late_max_us, 1700);

    TEST_SECTION("idle hour: coarse scales do not wake at all");
    CHECK_EQ(boot(FUI_FACE_ROUND240, FUI_MODE_PURE, 2, 0, T_A), 0);
    sim_port_run(&port, &app, 3600u * 1000u);
    CHECK(app.stats.wakes - port.end_wakes <= 2);
    CHECK(panel_is_frame());

    TEST_SECTION("idle hour: the refresh cap bounds the finest scale");
    CHECK_EQ(boot(FUI_FACE_ROUND240, FUI_MODE_PURE, 13, 0, T_A), 0);
    sim_port_run(&port, &app, 60u * 1000u);
    /* 100 ms minimum frame time: never more than 10 wakes a second, and
     * that many: frames start 100 ms apart, not 100 ms + the 23 ms flush. */
    CHECK(app.stats.wakes - port.end_wakes <= 600);
    CHECK(app.stats.wakes - port.end_wakes >= 590);
}

/* A session that visits every screen and both modes. */
static void script_session(void)
{
    static const struct { unsigned at_ms; fui_event_t event; } STEPS[] = {
        { 1000, FUI_EV_NEXT },   { 1300, FUI_EV_NEXT },  { 5000, FUI_EV_PREV },   { 9000, FUI_EV_LONG },
        { 12000, FUI_EV_SELECT }, { 14000, FUI_EV_NEXT }, { 15000, FUI_EV_NEXT }, { 20000, FUI_EV_SELECT },
        { 31000, FUI_EV_LONG },  { 40000, FUI_EV_SELECT }, { 52000, FUI_EV_PREV }, { 60000, FUI_EV_SELECT },
        { 61000, FUI_EV_SELECT }, { 61500, FUI_EV_SELECT }, { 70000, FUI_EV_NEXT },
    };
    size_t i;

    for (i = 0; i < sizeof STEPS / sizeof STEPS[0]; i++) {
        sim_port_event(&port, STEPS[i].at_ms, STEPS[i].event);
    }
}

static void test_panel(void)
{
    static const int BANDS[] = { 40, 16, 1 };
    enum { CHECKPOINTS = 11 };
    uint64_t whole[CHECKPOINTS];
    int face, mode, b, i, late;

    TEST_SECTION("panel: whole frame == what was flushed; bands == whole frame");
    for (face = 0; face < FUI_FACE_COUNT; face++) {
        const fui_face_info_t *info = fui_face_info((fui_face_t)face);

        for (mode = 0; mode < 2; mode++) {
            for (late = 0; late <= 1700; late += 1700) {
                /* Stop at several moments: in the middle of a label, on each card. */
                CHECK_EQ(boot((fui_face_t)face, (fui_mode_t)mode, 6, 0, T_A), 0);
                port.late_us = (uint32_t)late;
                script_session();
                for (i = 0; i < CHECKPOINTS; i++) {
                    sim_port_run(&port, &app, 2000u + (unsigned)i * 9000u);
                    CHECK(panel_is_frame());
                    whole[i] = sim_frame_hash(&port.panel);
                }
                CHECK_EQ(port.flush_errors, 0);
                CHECK_EQ(app.stats.messages, 15);

                for (b = 0; b < 3 && !info->mono; b++) { /* the one-bit frame is always whole */
                    CHECK_EQ(boot((fui_face_t)face, (fui_mode_t)mode, 6, BANDS[b], T_A), 0);
                    port.late_us = (uint32_t)late;
                    script_session();
                    for (i = 0; i < CHECKPOINTS; i++) {
                        sim_port_run(&port, &app, 2000u + (unsigned)i * 9000u);
                        if (sim_frame_hash(&port.panel) != whole[i]) {
                            printf("     panel differs: face %s, mode %s, band %d, at %d ms on screen %s\n",
                                   fui_face_name((fui_face_t)face), fui_mode_name((fui_mode_t)mode), BANDS[b],
                                   2000 + i * 9000, fui_screen_name((fui_screen_t)app.ui.screen));
                        }
                        CHECK(sim_frame_hash(&port.panel) == whole[i]);
                    }
                    CHECK_EQ(port.flush_errors, 0);
                }
            }
        }
    }

    TEST_SECTION("panel: fine focus on every face");
    for (face = 0; face < FUI_FACE_COUNT; face++) {
        CHECK_EQ(boot((fui_face_t)face, FUI_MODE_EARTH, 11, 0, T_A), 0);
        sim_port_run(&port, &app, 20000);
        CHECK(panel_is_frame());
        whole[0] = sim_frame_hash(&port.panel);
        if (face != FUI_FACE_MONO128) {
            CHECK_EQ(boot((fui_face_t)face, FUI_MODE_EARTH, 11, 24, T_A), 0);
            sim_port_run(&port, &app, 20000);
            CHECK(sim_frame_hash(&port.panel) == whole[0]);
        }
        CHECK_EQ(port.flush_errors, 0);
    }
}

static void test_time_not_set(void)
{
    TEST_SECTION("time not set: asleep until told the time");
    CHECK_EQ(boot(FUI_FACE_ROUND240, FUI_MODE_PURE, 6, 0, FRC_TIME_NONE), 0);
    sim_port_line(&port, 3600u * 1000u, "stamp");
    sim_port_line(&port, 3600u * 1000u + 500u, "time 1791460800");
    sim_port_run(&port, &app, 3599u * 1000u);
    CHECK_EQ(app.ui.status, FUI_STATUS_TIME_UNSET);
    CHECK_EQ(app.stats.wakes - port.end_wakes, 0); /* an hour, not one wake */
    CHECK_EQ(app.stats.redraws, 1);                /* the "time not set" face */
    CHECK(panel_is_frame());

    sim_port_run(&port, &app, 3600u * 1000u + 100u);
    CHECK(strstr(port.out, "time not set") != NULL);
    sim_port_clear_output(&port);

    sim_port_run(&port, &app, 3600u * 1000u + 600u);
    CHECK_EQ(port.time_sets, 1);
    CHECK_EQ(app.ui.status, FUI_STATUS_OK);
    CHECK(strstr(port.out, "stamp  " STAMP_A "\n") != NULL);
    CHECK(strstr(port.out, "ascii  a#6 b#4 g#9 d#3 e#5 34h 29i 21l 3n\n") != NULL);
    CHECK(strstr(port.out, "Delta Trifracton End") != NULL);
    CHECK(strstr(port.out, "Pentad II") != NULL);
    CHECK(strstr(port.out, "sync 4") != NULL);
    CHECK(strstr(port.out, "earth  2026-10-08T12:00:00.000Z (unix 1791460800)\n") != NULL);
    CHECK(panel_is_frame());
    /* From here the clock runs and the UI has deadlines again. */
    sim_port_run(&port, &app, 2u * 3600u * 1000u);
    CHECK(app.stats.timeouts - port.end_wakes > 100);

    TEST_SECTION("time: out of the catalogue is said, not shown");
    CHECK_EQ(boot(FUI_FACE_MONO128, FUI_MODE_PURE, 6, 0, T_A), 0);
    sim_port_line(&port, 1000, "time 99999999999");
    sim_port_line(&port, 2000, "time yesterday");
    sim_port_run(&port, &app, 3000);
    CHECK_EQ(app.ui.status, FUI_STATUS_OUT_OF_CATALOGUE);
    CHECK(strstr(port.out, "outside the eclipse catalogue") != NULL);
    CHECK(strstr(port.out, "usage: time") != NULL);
    CHECK_EQ(port.time_sets, 1);
    CHECK(panel_is_frame());

    TEST_SECTION("time: an instant int64 microseconds cannot run on from is refused");
    CHECK_EQ(boot(FUI_FACE_ROUND240, FUI_MODE_PURE, 6, 0, T_A), 0);
    sim_port_line(&port, 1000, "time 9223372036854"); /* frc_time_from_s takes it; a second on, it overflows */
    sim_port_line(&port, 1100, "time 100000000001");
    sim_port_line(&port, 1200, "time -100000000001");
    sim_port_run(&port, &app, 2000);
    CHECK_EQ(port.time_sets, 0);
    CHECK_EQ(app.ui.status, FUI_STATUS_OK);
    sim_port_line(&port, 2100, "time 100000000000"); /* the limit itself: out of catalogue, and runs on */
    sim_port_line(&port, 2200, "time -100000000000");
    sim_port_run(&port, &app, 4000);
    CHECK_EQ(port.time_sets, 2);
    CHECK_EQ(app.ui.status, FUI_STATUS_OUT_OF_CATALOGUE);
    CHECK(app.ui.frame.next_wake == FRC_TIME_NONE || app.ui.frame.next_wake >= app.ui.t);

    TEST_SECTION("time: set by somebody else (SNTP) wakes the loop");
    CHECK_EQ(boot(FUI_FACE_ROUND240, FUI_MODE_PURE, 6, 0, FRC_TIME_NONE), 0);
    sim_port_run(&port, &app, 1000);
    port.wall_us = T_A; /* the network set the system time ... */
    sim_port_time_changed(&port, 1500); /* ... and said so */
    sim_port_run(&port, &app, 2000);
    CHECK_EQ(app.ui.status, FUI_STATUS_OK);
    CHECK_EQ(app.stats.redraws, 2);
    CHECK(panel_is_frame());
}

static void test_console(void)
{
    TEST_SECTION("console: state commands");
    CHECK_EQ(boot(FUI_FACE_RECT240, FUI_MODE_PURE, 6, 0, T_A), 0);
    sim_port_line(&port, 100, "mode earth");
    sim_port_line(&port, 200, "focus 8");
    sim_port_line(&port, 300, "screen lens");
    sim_port_line(&port, 400, "utc -300");
    sim_port_line(&port, 500, "bright 30");
    sim_port_run(&port, &app, 1000);
    CHECK_EQ(app.ui.mode, FUI_MODE_EARTH);
    CHECK_EQ(app.ui.focus, 8);
    CHECK_EQ(app.ui.screen, FUI_SCREEN_LENS);
    CHECK_EQ(app.ui.utc_offset_s, -300 * 60);
    CHECK_EQ(port.brightness, 30);
    CHECK(strstr(port.out, "mode earth\n") != NULL);
    CHECK(strstr(port.out, "focus 8 (\xCE\xB9)\n") != NULL); /* iota, named by the core */
    CHECK(strstr(port.out, "screen lens\n") != NULL);
    CHECK(strstr(port.out, "utc -300 min") != NULL);
    CHECK(panel_is_frame());

    TEST_SECTION("console: queries, events, bad input");
    sim_port_clear_output(&port);
    sim_port_line(&port, 1100, "mode");
    sim_port_line(&port, 1200, "focus 14");
    sim_port_line(&port, 1300, "screen moon");
    sim_port_line(&port, 1400, "mode alien");
    sim_port_line(&port, 1500, "utc 9999");
    sim_port_line(&port, 1600, "bright 101");
    sim_port_line(&port, 1700, "frobnicate");
    sim_port_line(&port, 1800, "   ");
    sim_port_run(&port, &app, 2000);
    CHECK_EQ(app.ui.mode, FUI_MODE_EARTH);
    CHECK_EQ(app.ui.focus, 8);
    CHECK_EQ(app.ui.screen, FUI_SCREEN_LENS);
    CHECK_EQ(app.ui.utc_offset_s, -300 * 60);
    CHECK_EQ(port.brightness, 30);
    CHECK(strstr(port.out, "mode earth\n") != NULL);
    CHECK(strstr(port.out, "usage: focus") != NULL);
    CHECK(strstr(port.out, "usage: screen") != NULL);
    CHECK(strstr(port.out, "usage: mode") != NULL);
    CHECK(strstr(port.out, "usage: utc") != NULL);
    CHECK(strstr(port.out, "usage: bright") != NULL);
    CHECK(strstr(port.out, "unknown command") != NULL);

    sim_port_clear_output(&port);
    sim_port_line(&port, 2100, "screen now");
    sim_port_line(&port, 2200, "ev s s s l"); /* the lens of iota has two pages in EARTH on this face */
    sim_port_line(&port, 2300, "ev x");
    sim_port_line(&port, 2400, "info");
    sim_port_line(&port, 2500, "help");
    sim_port_line(&port, 2600, "reboot");
    sim_port_run(&port, &app, 3000);
    CHECK_EQ(app.ui.screen, FUI_SCREEN_SUN);
    CHECK_EQ(app.ui.mode, FUI_MODE_PURE);
    CHECK(strstr(port.out, "4 events: screen sun, page 1 of 1, mode pure, focus 8\n") != NULL);
    CHECK(strstr(port.out, "state    screen sun (page 1 of 1), mode pure, focus 8") != NULL);
    CHECK(strstr(port.out, "usage: ev") != NULL);
    CHECK(strstr(port.out, "fractonica-clock " APP_VERSION ", core " FRC_VERSION ", SPEC " FRC_SPEC_VERSION) != NULL);
    CHECK(strstr(port.out, "face rect240 240x240, buffer 115200 bytes (whole frame)") != NULL);
    CHECK(strstr(port.out, "loop     wakes ") != NULL);
    CHECK(strstr(port.out, "draw     redraws ") != NULL);
    CHECK(strstr(port.out, "host     simulated port") != NULL);
    CHECK(strstr(port.out, "shot ") != NULL);
    CHECK_EQ(port.restarts, 1);
    CHECK_EQ(port.saves, 1); /* reboot stores what was still settling */
    CHECK_EQ(port.stored.screen, FUI_SCREEN_SUN);
    CHECK(panel_is_frame());

    TEST_SECTION("console: a card's pages, and the lens that leaves the focus alone");
    CHECK_EQ(boot(FUI_FACE_ROUND240, FUI_MODE_EARTH, 6, 0, T_A), 0);
    sim_port_line(&port, 100, "ev s");     /* the lens of the Helion: two pages in EARTH on this face */
    sim_port_line(&port, 200, "ev s");
    sim_port_line(&port, 300, "ev nnn");   /* three rungs finer: the first page again */
    sim_port_line(&port, 400, "ev ss");    /* through its pages to the Sun */
    sim_port_run(&port, &app, 1000);
    CHECK(strstr(port.out, "1 event: screen lens, page 1 of 2, mode earth, focus 6\n") != NULL);
    CHECK(strstr(port.out, "1 event: screen lens, page 2 of 2, mode earth, focus 6\n") != NULL);
    CHECK(strstr(port.out, "3 events: screen lens, page 1 of 2, mode earth, focus 6\n") != NULL);
    /* the Sun's card fits one page here since its drift is in Flavons and
     * the civil line is the core's ("THU 8 OCT 2026 / 14:00:00 UTC+2") */
    CHECK(strstr(port.out, "2 events: screen sun, page 1 of 1, mode earth, focus 6\n") != NULL);
    CHECK_EQ(app.ui.lens_level, 9);
    CHECK_EQ(app.ui.focus, 6); /* what `info` shows and the settings store */
    CHECK(panel_is_frame());
    sim_port_run(&port, &app, 8000); /* past the settle time */
    CHECK_EQ(port.stored.focus, 6);
}

static void test_shot(void)
{
    static const int BANDS[] = { 0, 40, 7 };
    sim_frame_t decoded;
    int face, b;

    TEST_SECTION("shot: the text decodes to the panel's pixels");
    for (face = 0; face < FUI_FACE_COUNT; face++) {
        for (b = 0; b < 3; b++) {
            if (BANDS[b] != 0 && fui_face_info((fui_face_t)face)->mono) {
                continue;
            }
            CHECK_EQ(boot((fui_face_t)face, FUI_MODE_EARTH, 6, BANDS[b], T_A), 0);
            sim_port_line(&port, 500, "shot");
            sim_port_run(&port, &app, 500); /* stop there: a Blink later the glass has moved on */
            CHECK(strstr(port.out, "SHOT BEGIN ") != NULL);
            CHECK_EQ(sim_shot_decode(port.out, &decoded, shot_memory), 0);
            CHECK_EQ(decoded.face, face);
            CHECK(sim_frame_hash(&decoded) == sim_frame_hash(&port.panel));
            CHECK(panel_is_full_draw());
        }
    }

    TEST_SECTION("shot: a damaged copy is refused");
    {
        char *row = strstr(port.out, "SHOT 20 ");

        CHECK(row != NULL);
        if (row) {
            row[10] = row[10] == '0' ? '1' : '0';
            CHECK_EQ(sim_shot_decode(port.out, &decoded, shot_memory), -1);
        }
        CHECK_EQ(sim_shot_decode("no shot here", &decoded, shot_memory), -1);
    }
}

static void test_settings(void)
{
    app_settings_t record;
    app_config_t config;
    app_port_t api;
    int i;

    TEST_SECTION("settings: a burst of changes is one save");
    CHECK_EQ(boot(FUI_FACE_ROUND240, FUI_MODE_PURE, 6, 0, T_A), 0);
    sim_port_run(&port, &app, 60000);
    CHECK_EQ(port.saves, 0); /* the start-up state is not written */
    for (i = 0; i < 10; i++) {
        sim_port_event(&port, 61000u + (unsigned)i * 200u, FUI_EV_NEXT); /* ten clicks in two seconds */
    }
    sim_port_run(&port, &app, 62800u + APP_SAVE_SETTLE_MS - 100u);
    CHECK_EQ(port.saves, 0); /* still settling */
    sim_port_run(&port, &app, 62800u + APP_SAVE_SETTLE_MS + 100u);
    CHECK_EQ(port.saves, 1);
    CHECK_EQ(port.stored.focus, 2); /* 6 + 10 steps, wrapping after 13 */
    CHECK_EQ(port.stored.screen, FUI_SCREEN_NOW); /* SCALES is stored as NOW */
    CHECK(app_settings_valid(&port.stored));
    sim_port_run(&port, &app, 3600u * 1000u);
    CHECK_EQ(port.saves, 1);

    TEST_SECTION("settings: back to the stored state is no save");
    sim_port_event(&port, 3601000, FUI_EV_LONG);
    sim_port_event(&port, 3603000, FUI_EV_LONG);
    sim_port_run(&port, &app, 3700000);
    CHECK_EQ(port.saves, 1);
    sim_port_event(&port, 3701000, FUI_EV_LONG);
    sim_port_line(&port, 3702000, "utc 345");
    sim_port_line(&port, 3703000, "bright 55");
    sim_port_run(&port, &app, 3800000);
    CHECK_EQ(port.saves, 2);
    CHECK_EQ(port.stored.mode, FUI_MODE_EARTH);
    CHECK_EQ(port.stored.utc_offset_min, 345);
    CHECK_EQ(port.stored.brightness, 55);

    TEST_SECTION("settings: a stored record restores the state");
    record = port.stored;
    record.screen = FUI_SCREEN_STAMP;
    memset(&config, 0, sizeof config);
    config.face = FUI_FACE_ROUND240;
    config.format = FUI_FMT_RGB565_BE;
    config.buffer = frame_memory;
    config.buffer_bytes = 240u * 240u * 2u;
    config.settings = record;
    config.display_name = "simulated";
    sim_port_free(&port);
    sim_port_init(&port, FUI_FACE_ROUND240, FUI_FMT_RGB565_BE, T_A);
    api = sim_port_api(&port);
    CHECK_EQ(app_init(&app, &config, &api), 0);
    CHECK_EQ(app.ui.mode, FUI_MODE_EARTH);
    CHECK_EQ(app.ui.focus, 2);
    CHECK_EQ(app.ui.screen, FUI_SCREEN_STAMP);
    CHECK_EQ(app.ui.utc_offset_s, 345 * 60);
    CHECK_EQ(port.brightness, 55);
    sim_port_run(&port, &app, 60000);
    CHECK_EQ(port.saves, 0);

    TEST_SECTION("settings: a record that is not ours is refused");
    record.version = 9;
    CHECK(!app_settings_valid(&record));
    record = port.stored;
    record.focus = 14;
    CHECK(!app_settings_valid(&record));
    memset(&record, 0xFF, sizeof record); /* erased flash */
    CHECK(!app_settings_valid(&record));
    CHECK_EQ(sizeof(app_settings_t), 8);
}

static void test_buffers(void)
{
    app_config_t config;
    app_port_t api;

    TEST_SECTION("buffers: what app_init accepts");
    memset(&config, 0, sizeof config);
    config.settings.version = APP_SETTINGS_VERSION;
    config.buffer = frame_memory;
    sim_port_free(&port);
    sim_port_init(&port, FUI_FACE_ROUND240, FUI_FMT_RGB565_BE, T_A);
    api = sim_port_api(&port);

    config.face = FUI_FACE_ROUND240;
    config.format = FUI_FMT_RGB565_BE;
    config.buffer_bytes = 240 * 2;
    CHECK_EQ(app_init(&app, &config, &api), 0); /* one row is enough ... */
    CHECK_EQ(app.banded, 1);
    config.buffer_bytes = 240 * 2 - 1;
    CHECK_EQ(app_init(&app, &config, &api), -1); /* ... less is not */
    config.buffer = (uint8_t *)frame_memory + 1;
    config.buffer_bytes = 240 * 240 * 2;
    CHECK_EQ(app_init(&app, &config, &api), -1); /* 16-bit pixels at an odd address */
    config.buffer = frame_memory;
    config.format = FUI_FMT_MONO_PAGE;
    CHECK_EQ(app_init(&app, &config, &api), -1); /* a one-bit buffer for a colour face */

    config.face = FUI_FACE_MONO128;
    config.buffer_bytes = 1024;
    CHECK_EQ(app_init(&app, &config, &api), 0);
    CHECK_EQ(app.banded, 0);
    config.buffer_bytes = 1023;
    CHECK_EQ(app_init(&app, &config, &api), -1); /* the one-bit frame is never banded */
    config.buffer = NULL;
    CHECK_EQ(app_init(&app, &config, &api), -1);
}

/* ------------------------------------------------------------------------- */
/* Buttons                                                                    */
/* ------------------------------------------------------------------------- */

/* Feed a button a list of (time, level) changes and timer expiries exactly
 * as fhal_input.c does: a level is delivered `debounce` ms after its last
 * edge, a timer when the state machine asked for one. Collects the actions. */
typedef struct edge {
    uint32_t at_ms;
    int      level;
} edge_t;

static int run_button(const fhal_button_config_t *config, const edge_t *edges, int count, uint32_t debounce,
                      uint32_t until_ms, fhal_button_action_t *actions, uint32_t *times, int room)
{
    fhal_button_t button;
    uint32_t now = 0, timer_at = 0;
    int next = 0, timer_on = 0, moved = 0, found = 0, level = 0;

    fhal_button_reset(&button);
    while (now <= until_ms) {
        /* an edge restarts the debounce timer (the interrupt) */
        while (next < count && edges[next].at_ms == now) {
            level = edges[next].level;
            moved = 1;
            timer_on = 1;
            timer_at = now + debounce;
            next++;
        }
        if (timer_on && now == timer_at) { /* the timer callback */
            fhal_button_action_t action;
            uint32_t again;

            timer_on = 0;
            again = fhal_button_update(&button, config, now, moved ? level : -1, &action);
            moved = 0;
            if (action != FHAL_BUTTON_NONE && found < room) {
                actions[found] = action;
                times[found] = now;
                found++;
            }
            if (again) {
                timer_on = 1;
                timer_at = now + again;
            }
        }
        now++;
    }
    return found;
}

static void test_buttons(void)
{
    static const fhal_button_config_t SELECT = { 600, 300, 1, 0 }; /* click + long        */
    static const fhal_button_config_t NEXT = { 600, 300, 0, 0 };   /* click on press      */
    static const fhal_button_config_t ONE = { 600, 300, 1, 1 };    /* click, double, long */
    fhal_button_action_t actions[8];
    uint32_t times[8];
    int n;

    TEST_SECTION("buttons: click and long press");
    {
        static const edge_t CLICK[] = { { 100, 1 }, { 250, 0 } };
        static const edge_t HOLD[] = { { 100, 1 }, { 1500, 0 } };

        n = run_button(&SELECT, CLICK, 2, 15, 3000, actions, times, 8);
        CHECK_EQ(n, 1);
        CHECK_EQ(actions[0], FHAL_BUTTON_CLICK);
        CHECK_EQ(times[0], 265); /* on the debounced release */
        n = run_button(&SELECT, HOLD, 2, 15, 3000, actions, times, 8);
        CHECK_EQ(n, 1); /* the long press, and nothing on the release */
        CHECK_EQ(actions[0], FHAL_BUTTON_LONG);
        CHECK_EQ(times[0], 115 + 600);
        n = run_button(&NEXT, HOLD, 2, 15, 3000, actions, times, 8);
        CHECK_EQ(n, 1);
        CHECK_EQ(actions[0], FHAL_BUTTON_CLICK);
        CHECK_EQ(times[0], 115); /* at once: nothing to wait for */
    }

    TEST_SECTION("buttons: a bouncing contact is one press");
    {
        static const edge_t BOUNCE[] = { { 100, 1 }, { 102, 0 }, { 103, 1 }, { 107, 0 }, { 109, 1 },
                                         { 300, 0 }, { 301, 1 }, { 304, 0 } };
        static const edge_t GLITCH[] = { { 100, 1 }, { 105, 0 } }; /* shorter than the debounce */

        n = run_button(&SELECT, BOUNCE, 8, 15, 3000, actions, times, 8);
        CHECK_EQ(n, 1);
        CHECK_EQ(actions[0], FHAL_BUTTON_CLICK);
        n = run_button(&SELECT, GLITCH, 2, 15, 3000, actions, times, 8);
        CHECK_EQ(n, 0);
    }

    TEST_SECTION("buttons: one button - click, double click, hold");
    {
        static const edge_t CLICK[] = { { 100, 1 }, { 200, 0 } };
        static const edge_t TWICE[] = { { 100, 1 }, { 200, 0 }, { 350, 1 }, { 450, 0 } };
        static const edge_t SLOW[] = { { 100, 1 }, { 200, 0 }, { 700, 1 }, { 800, 0 } };
        static const edge_t HOLD[] = { { 100, 1 }, { 1000, 0 } };

        n = run_button(&ONE, CLICK, 2, 15, 3000, actions, times, 8);
        CHECK_EQ(n, 1);
        CHECK_EQ(actions[0], FHAL_BUTTON_CLICK);
        CHECK_EQ(times[0], 215 + 300); /* after the double-click gap */
        n = run_button(&ONE, TWICE, 4, 15, 3000, actions, times, 8);
        CHECK_EQ(n, 1);
        CHECK_EQ(actions[0], FHAL_BUTTON_DOUBLE);
        CHECK_EQ(times[0], 365); /* on the second press */
        n = run_button(&ONE, SLOW, 4, 15, 3000, actions, times, 8);
        CHECK_EQ(n, 2); /* too far apart: two clicks */
        CHECK_EQ(actions[0], FHAL_BUTTON_CLICK);
        CHECK_EQ(actions[1], FHAL_BUTTON_CLICK);
        n = run_button(&ONE, HOLD, 2, 15, 3000, actions, times, 8);
        CHECK_EQ(n, 1);
        CHECK_EQ(actions[0], FHAL_BUTTON_LONG);
    }

    TEST_SECTION("buttons: the millisecond counter may wrap");
    {
        fhal_button_t button;
        fhal_button_action_t action;
        uint32_t again;

        fhal_button_reset(&button);
        again = fhal_button_update(&button, &SELECT, 0xFFFFFF00u, 1, &action);
        CHECK_EQ(action, FHAL_BUTTON_NONE);
        CHECK_EQ(again, 600);
        again = fhal_button_update(&button, &SELECT, 0xFFFFFF00u + 600u, -1, &action); /* past the wrap */
        CHECK_EQ(action, FHAL_BUTTON_LONG);
        CHECK_EQ(again, 0);
    }
}

int main(void)
{
    test_idle_hour();
    test_panel();
    test_time_not_set();
    test_console();
    test_shot();
    test_settings();
    test_buffers();
    test_buttons();
    sim_port_free(&port);
    TEST_SUMMARY("firmware");
}
