/*
 * test_ui.c - the state machine and the frame contract of fui_ui.h.
 *
 *   navigation      the map of fui_ui.h, event by event; wrapping; pages; the
 *                   lens reaching all 63 levels WITHOUT moving the focus;
 *                   SELECT after a scale step inspects that level; the two
 *                   brief labels and their timers
 *   vector A        the model holds SPEC S12's values (odometers, locals, Sun)
 *   frames          first frame is the whole face; nothing is redrawn while
 *                   nothing changed; the UI wakes exactly when the core says
 *                   the picture changes; it never asks for a zero sleep
 *   partial redraw  following next_wake for a while with partial redraws
 *                   leaves the SAME pixels as one full draw of the state the
 *                   UI ended in, on every face and screen, in both modes
 *   bands           a frame drawn through a 16 / 40-row band canvas is the
 *                   frame drawn at once
 *   states          time not set, out of catalogue, a clock set backwards
 *   geometry        no arc of the focused ring crosses the bezel or a counter
 *                   ring, at any focus; the second level is dropped where it
 *                   would (theta); the one-bit quarter ticks are the same
 *                   four pixels on each side of the centre
 *   cards           every page of every LENS card (63 levels), SUN and STAMP
 *                   fits its face in both modes and all three states; no row
 *                   of a colour card is under 2 px per dot; the one-bit face
 *                   never draws the dot font at 1 px per dot; EARTH says all
 *                   PURE says; no fact twice; "pB" is never folded; the one
 *                   red is the visible rung's
 *   words           a span the core wrote is never split over two rows (SUN
 *                   and LENS countdowns at 64 instants on every face); the
 *                   last rung names nothing below the ladder; a rung outside
 *                   every band says "no band"
 *   the Sun         the SUN picture does not depend on the focus; its running
 *                   slot is lit to the Helion's phase; the place in the sync
 *                   and the Pentad gaps agree with the core's Pentads
 *   marks           the quarter ticks are full ink on one pixel column; the
 *                   Earth hallmark of the round face touches nothing; a label
 *                   shows without a reading; one bit keeps an Earth sign
 *   quiet lines     a UI that sleeps as long as its frame allows shows at
 *                   every Blink boundary what a UI that looked then would
 *                   (LENS on levels 0..12, SUN); and it does sleep
 */
#include <math.h>
#include <string.h>

#include "fui_i.h" /* the painter, to measure cards without drawing them */
#include "sim_frame.h"
#include "sim_test.h"

#define T_A FRC_TIME_FROM_S(SIM_VECTOR_A_S)

static void start(fui_ui_t *ui, fui_face_t face, fui_mode_t mode, uint8_t focus)
{
    fui_config_t config;

    memset(&config, 0, sizeof config);
    config.face = face;
    config.mode = mode;
    config.focus = focus;
    config.utc_offset_s = 7200;
    fui_ui_init(ui, &config);
}

/* An event, then an update, as the firmware's loop does. */
static void press(fui_ui_t *ui, fui_event_t event, uint32_t ms)
{
    fui_ui_event(ui, event, ms);
    fui_ui_update(ui, T_A, ms);
}

/* SELECT until the card is left; returns how many pages it showed. */
static int leaf_through(fui_ui_t *ui, fui_screen_t card)
{
    int pages = 0;

    CHECK_EQ(ui->screen, card);
    CHECK_EQ(ui->page, 0);
    while (ui->screen == card && pages < 20) {
        CHECK_EQ(ui->page, pages);
        CHECK_EQ(fui_ui_pages(ui) > pages, 1);
        pages++;
        press(ui, FUI_EV_SELECT, 0);
    }
    CHECK(pages >= 1 && pages < 20);
    return pages;
}

static void test_navigation(void)
{
    fui_ui_t ui;
    const fui_frame_t *f;
    int i, face, mode, pages;

    TEST_SECTION("navigation: the card loop, page by page, on every face");
    for (face = 0; face < FUI_FACE_COUNT; face++) {
        for (mode = 0; mode < 2; mode++) {
            start(&ui, (fui_face_t)face, (fui_mode_t)mode, 6);
            fui_ui_update(&ui, T_A, 0);
            CHECK_EQ(ui.screen, FUI_SCREEN_NOW);
            CHECK_EQ(fui_ui_pages(&ui), 1);
            CHECK_EQ(fui_ui_event(&ui, FUI_EV_NONE, 0), 0);
            CHECK_EQ(fui_ui_event(&ui, FUI_EV_SELECT, 0), 1);
            fui_ui_update(&ui, T_A, 0);
            CHECK_EQ(ui.lens_level, 6);
            (void)leaf_through(&ui, FUI_SCREEN_LENS); /* SELECT turns the pages, then leaves */
            pages = leaf_through(&ui, FUI_SCREEN_SUN);
            /* one bit: the figure, then the lines */
            CHECK(face != FUI_FACE_MONO128 || pages == 2);
            (void)leaf_through(&ui, FUI_SCREEN_STAMP);
            CHECK_EQ(ui.screen, FUI_SCREEN_NOW);
            CHECK_EQ(ui.focus, 6);
        }
    }
    /* an encoder roams the cards too: NEXT is SELECT there, PREV undoes it
     * (on the one-bit face, whose SUN always has two pages: figure, lines) */
    start(&ui, FUI_FACE_MONO128, FUI_MODE_EARTH, 6);
    fui_ui_update(&ui, T_A, 0);
    fui_ui_set_screen(&ui, FUI_SCREEN_SUN);
    fui_ui_update(&ui, T_A, 0);
    CHECK_EQ(fui_ui_pages(&ui), 2);
    press(&ui, FUI_EV_NEXT, 0);
    CHECK_EQ(ui.screen, FUI_SCREEN_SUN);
    CHECK_EQ(ui.page, 1);
    press(&ui, FUI_EV_NEXT, 0);
    CHECK_EQ(ui.screen, FUI_SCREEN_STAMP);
    CHECK_EQ(ui.page, 0);
    press(&ui, FUI_EV_PREV, 0);
    CHECK_EQ(ui.screen, FUI_SCREEN_SUN); /* back where NEXT came from: its last page */
    CHECK_EQ(ui.page, 1);
    press(&ui, FUI_EV_PREV, 0);
    CHECK_EQ(ui.page, 0);
    press(&ui, FUI_EV_PREV, 0);
    CHECK_EQ(ui.screen, FUI_SCREEN_LENS);
    CHECK_EQ(ui.page, 0);
    fui_ui_set_screen(&ui, FUI_SCREEN_STAMP);
    fui_ui_update(&ui, T_A, 0);
    for (i = 0; i < 10 && ui.screen == FUI_SCREEN_STAMP; i++) {
        press(&ui, FUI_EV_NEXT, 0);
    }
    CHECK_EQ(ui.screen, FUI_SCREEN_NOW);
    /* several events to one update (the console's `ev`): the pages are still counted */
    fui_ui_set_screen(&ui, FUI_SCREEN_STAMP);
    fui_ui_update(&ui, T_A, 0);
    fui_ui_event(&ui, FUI_EV_PREV, 0); /* SUN, "its last page" */
    fui_ui_event(&ui, FUI_EV_PREV, 0); /* SUN, first page */
    CHECK_EQ(ui.screen, FUI_SCREEN_SUN);
    CHECK_EQ(ui.page, 0);
    fui_ui_event(&ui, FUI_EV_SELECT, 0);
    fui_ui_event(&ui, FUI_EV_SELECT, 0);
    CHECK_EQ(ui.screen, FUI_SCREEN_STAMP);
    /* a page that no longer exists is brought back into range, and stays put */
    fui_ui_set_screen(&ui, FUI_SCREEN_SUN);
    ui.page = 7;
    f = fui_ui_update(&ui, T_A, 0);
    CHECK_EQ(ui.page, 1);
    CHECK(f->redraw);
    f = fui_ui_update(&ui, T_A, 0);
    CHECK(!f->redraw);

    TEST_SECTION("navigation: scales");
    start(&ui, FUI_FACE_ROUND240, FUI_MODE_PURE, 6);
    fui_ui_update(&ui, T_A, 0);
    fui_ui_event(&ui, FUI_EV_NEXT, 1000);
    CHECK_EQ(ui.screen, FUI_SCREEN_SCALES);
    CHECK_EQ(ui.focus, 7); /* NEXT is finer */
    f = fui_ui_update(&ui, T_A, 1000);
    CHECK(f->redraw);
    /* the deadline is the name's time, unless the rings change sooner */
    CHECK(f->sleep_us > 0 && f->sleep_us <= (int64_t)FUI_NAME_MS * 1000);
    fui_ui_event(&ui, FUI_EV_PREV, 1500);
    fui_ui_event(&ui, FUI_EV_PREV, 1600);
    CHECK_EQ(ui.focus, 5);
    f = fui_ui_update(&ui, T_A, 1600 + FUI_NAME_MS - 1);
    CHECK_EQ(ui.screen, FUI_SCREEN_SCALES); /* the timer restarts at each step */
    f = fui_ui_update(&ui, T_A, 1600 + FUI_NAME_MS);
    CHECK_EQ(ui.screen, FUI_SCREEN_NOW);    /* ... and the name leaves by itself */
    CHECK(f->redraw);
    CHECK_EQ(ui.focus, 5);
    /* SELECT means the same thing whether the name still shows or not:
     * "turn to a level, press to inspect it" opens the lens on that level */
    fui_ui_event(&ui, FUI_EV_NEXT, 9000);
    CHECK_EQ(ui.screen, FUI_SCREEN_SCALES);
    fui_ui_event(&ui, FUI_EV_SELECT, 9001);
    CHECK_EQ(ui.screen, FUI_SCREEN_LENS);
    CHECK_EQ(ui.lens_level, 6);
    CHECK_EQ(ui.focus, 6);
    fui_ui_set_screen(&ui, FUI_SCREEN_NOW);
    fui_ui_event(&ui, FUI_EV_NEXT, 20000);
    fui_ui_update(&ui, T_A, 20000 + FUI_NAME_MS + 500); /* the name has gone */
    CHECK_EQ(ui.screen, FUI_SCREEN_NOW);
    fui_ui_event(&ui, FUI_EV_SELECT, 24000);
    CHECK_EQ(ui.screen, FUI_SCREEN_LENS);
    CHECK_EQ(ui.lens_level, 7);
    /* the limb wraps: 13 -> 0 and 0 -> 13 */
    start(&ui, FUI_FACE_MONO128, FUI_MODE_PURE, FUI_FOCUS_MAX);
    fui_ui_event(&ui, FUI_EV_NEXT, 0);
    CHECK_EQ(ui.focus, 0);
    fui_ui_event(&ui, FUI_EV_PREV, 0);
    CHECK_EQ(ui.focus, FUI_FOCUS_MAX);
    for (i = 0; i < 14; i++) {
        fui_ui_event(&ui, FUI_EV_NEXT, 0);
    }
    CHECK_EQ(ui.focus, FUI_FOCUS_MAX);
    /* a wrapping millisecond counter does not end the label early */
    start(&ui, FUI_FACE_ROUND240, FUI_MODE_PURE, 6);
    fui_ui_event(&ui, FUI_EV_NEXT, 0xFFFFFF00u);
    fui_ui_update(&ui, T_A, 0x00000100u); /* 512 ms later, across the wrap */
    CHECK_EQ(ui.screen, FUI_SCREEN_SCALES);
    fui_ui_update(&ui, T_A, 0xFFFFFF00u + FUI_NAME_MS);
    CHECK_EQ(ui.screen, FUI_SCREEN_NOW);

    TEST_SECTION("navigation: the lens reaches all 63 levels and leaves the focus alone");
    start(&ui, FUI_FACE_ROUND240, FUI_MODE_PURE, 6);
    fui_ui_update(&ui, T_A, 0);
    press(&ui, FUI_EV_SELECT, 0);
    for (i = 7; i <= 62; i++) {
        press(&ui, FUI_EV_NEXT, 0);
        CHECK_EQ(ui.lens_level, i);
        CHECK_EQ(ui.focus, 6); /* inspecting is not refocusing (ruling 9) */
        CHECK_EQ(ui.screen, FUI_SCREEN_LENS);
        CHECK_EQ(ui.page, 0);
    }
    press(&ui, FUI_EV_NEXT, 0);
    CHECK_EQ(ui.lens_level, 0);
    press(&ui, FUI_EV_PREV, 0);
    CHECK_EQ(ui.lens_level, 62);
    CHECK_EQ(ui.focus, 6);
    /* a new level starts on its first page */
    start(&ui, FUI_FACE_ROUND240, FUI_MODE_EARTH, 6);
    fui_ui_update(&ui, T_A, 0);
    press(&ui, FUI_EV_SELECT, 0);
    press(&ui, FUI_EV_SELECT, 0);
    CHECK_EQ(ui.screen, FUI_SCREEN_LENS);
    CHECK_EQ(ui.page, 1);
    press(&ui, FUI_EV_NEXT, 0);
    CHECK_EQ(ui.page, 0);
    CHECK_EQ(ui.lens_level, 7);
    /* the reviewer's walk: from Alpha, one step back in the lens, then out.
     * It ended on focus 13 (ten frames a second, and saved); it ends on 0. */
    start(&ui, FUI_FACE_ROUND240, FUI_MODE_PURE, 0);
    fui_ui_update(&ui, T_A, 0);
    press(&ui, FUI_EV_SELECT, 0);
    press(&ui, FUI_EV_PREV, 0);
    CHECK_EQ(ui.lens_level, 62);
    for (i = 0; i < 20 && ui.screen != FUI_SCREEN_NOW; i++) {
        press(&ui, FUI_EV_SELECT, 0);
    }
    CHECK_EQ(ui.screen, FUI_SCREEN_NOW);
    CHECK_EQ(ui.focus, 0);
    CHECK(ui.frame.sleep_us > (int64_t)3600 * 1000000); /* Alpha: asleep for days, not ten frames a second */
    /* coming back to the lens from NOW starts from the focus again */
    press(&ui, FUI_EV_SELECT, 0);
    CHECK_EQ(ui.lens_level, 0);

    TEST_SECTION("navigation: the mode");
    start(&ui, FUI_FACE_ROUND240, FUI_MODE_PURE, 6);
    fui_ui_update(&ui, T_A, 0);
    fui_ui_event(&ui, FUI_EV_LONG, 100);
    CHECK_EQ(ui.mode, FUI_MODE_EARTH);
    CHECK_EQ(ui.toast, 1);
    f = fui_ui_update(&ui, T_A, 100);
    CHECK(f->redraw);
    CHECK_EQ(f->sleep_us, (int64_t)FUI_TOAST_MS * 1000);
    f = fui_ui_update(&ui, T_A, 100 + FUI_TOAST_MS);
    CHECK_EQ(ui.toast, 0);
    CHECK(f->redraw); /* the label is taken away again */
    fui_ui_event(&ui, FUI_EV_LONG, 5000);
    CHECK_EQ(ui.mode, FUI_MODE_PURE);
    /* on a card the content shows the mode: no label, and the page is kept
     * while it exists (the square face: its Helion LENS has one page in
     * PURE, two in EARTH) */
    start(&ui, FUI_FACE_RECT240, FUI_MODE_PURE, 6);
    fui_ui_update(&ui, T_A, 5000);
    fui_ui_event(&ui, FUI_EV_SELECT, 5001);
    fui_ui_event(&ui, FUI_EV_LONG, 5002);
    CHECK_EQ(ui.mode, FUI_MODE_EARTH);
    CHECK_EQ(ui.toast, 0);
    CHECK_EQ(ui.screen, FUI_SCREEN_LENS);
    fui_ui_update(&ui, T_A, 5002);
    press(&ui, FUI_EV_SELECT, 5003);
    CHECK_EQ(ui.page, 1);
    fui_ui_event(&ui, FUI_EV_LONG, 5004); /* PURE: one page on this face */
    fui_ui_update(&ui, T_A, 5004);
    CHECK_EQ(ui.screen, FUI_SCREEN_LENS);
    CHECK_EQ(ui.page, 0);

    TEST_SECTION("setters clamp");
    fui_ui_set_focus(&ui, 200);
    CHECK_EQ(ui.focus, FUI_FOCUS_MAX);
    fui_ui_set_screen(&ui, (fui_screen_t)99);
    CHECK_EQ(ui.screen, FUI_SCREEN_NOW);
    fui_ui_set_screen(&ui, FUI_SCREEN_SCALES);
    CHECK_EQ(ui.screen, FUI_SCREEN_NOW);
    CHECK(fui_face_info((fui_face_t)99) == NULL);
    CHECK_EQ(fui_face_info(FUI_FACE_MONO128)->mono, 1);
    CHECK_EQ(fui_face_info(FUI_FACE_ROUND240)->round, 1);
    CHECK_EQ(fui_face_info(FUI_FACE_RECT240X320)->height, 320);
}

static void test_vector_a(void)
{
    fui_ui_t ui;
    char text[176];
    frc_date_t date;

    TEST_SECTION("vector A: the model holds SPEC S12");
    CHECK(frc_date_at(&FRC_SAROS_141, T_A, &date) == FRC_OK);
    frc_format_date(&date, FRC_DATE_LETTERS, FRC_UNIT_BLINK, text, sizeof text);
    CHECK(strcmp(text, "\xCE\xB1#6 \xCE\xB2#4 \xCE\xB3#9 \xCE\xB4#3 \xCE\xB5#5 34\xCE\xB7 29\xCE\xB9 21\xCE\xBB 3\xCE\xBD") == 0);

    start(&ui, FUI_FACE_ROUND240, FUI_MODE_PURE, 6);
    fui_ui_update(&ui, T_A, 0);
    CHECK_EQ(ui.status, FUI_STATUS_OK);
    CHECK_EQ(ui.reading.odometer[0], 13); /* the Helion odometer [13, 0] */
    CHECK_EQ(ui.reading.odometer[1], 0);
    CHECK_EQ(ui.reading.level[6].local, 0);  /* local 0 of 11 */
    CHECK_EQ(ui.reading.level[7].local, 7);  /* theta: local 7 of 9 -> 8 beads lit */
    CHECK_EQ(ui.reading.next_quarter, FRC_END);
    CHECK_EQ(ui.reading.sun_valid, 1);
    CHECK_EQ(ui.reading.sun_within, 6);      /* Pentad II (5 Helions done) + its 2nd Helion */
    CHECK_EQ(ui.pentad_starts, 0x8421u);     /* SPEC S7.5: Pentads begin at Helions 0, 5, 10, 15 */
    CHECK_EQ(ui.reading.sun_odometer[0], 5); /* sync digits [5, 11, 13] */
    CHECK_EQ(ui.reading.sun_odometer[1], 11);
    CHECK_EQ(ui.reading.sun_odometer[2], 13);
    CHECK_EQ(ui.reading.midnights, 0);       /* pure: no civil midnight is computed */
    CHECK_EQ(ui.ring.children, 18);          /* 2 x 9 half-cycles of theta */
    CHECK_EQ(ui.ring.per_child, 4);          /* each carrying 4 half-cycles of iota */

    start(&ui, FUI_FACE_ROUND240, FUI_MODE_EARTH, 7);
    fui_ui_update(&ui, T_A, 0);
    CHECK_EQ(ui.reading.odometer[0], 5); /* level 7: [5, 4] */
    CHECK_EQ(ui.reading.odometer[1], 4);
    CHECK_EQ(ui.reading.next_quarter, FRC_NODE);
    CHECK_EQ(ui.reading.midnights, 4); /* four civil days to a sync */
    CHECK_EQ(ui.ring.children, 8);

    /* the one-bit face draws the first level only, at any focus */
    start(&ui, FUI_FACE_MONO128, FUI_MODE_PURE, 6);
    fui_ui_update(&ui, T_A, 0);
    CHECK_EQ(ui.ring.children, 18);
    CHECK_EQ(ui.ring.per_child, 0);
}

static void test_frames(void)
{
    fui_ui_t ui;
    const fui_frame_t *f;
    const fui_face_info_t *info;
    frc_odometer_t odo, grid;
    frc_time_t t, wake;
    int face, i;

    TEST_SECTION("frames: first, idle, wake");
    for (face = 0; face < FUI_FACE_COUNT; face++) {
        info = fui_face_info((fui_face_t)face);
        start(&ui, (fui_face_t)face, FUI_MODE_PURE, 6);
        f = fui_ui_update(&ui, T_A, 0);
        CHECK(f->redraw);
        CHECK(f->dirty.x0 == 0 && f->dirty.y0 == 0 && f->dirty.x1 == info->width && f->dirty.y1 == info->height);
        CHECK(f->sleep_us > 0);
        CHECK_EQ(f->next_wake, T_A + f->sleep_us);
        /* the same instant again: nothing to do */
        f = fui_ui_update(&ui, T_A, 0);
        CHECK(!f->redraw);
        /* one microsecond before the wake: still nothing */
        wake = f->next_wake;
        f = fui_ui_update(&ui, wake - 1, 0);
        CHECK(!f->redraw);
    }

    TEST_SECTION("frames: the round face wakes when the core says the rings change");
    start(&ui, FUI_FACE_ROUND240, FUI_MODE_PURE, 6);
    f = fui_ui_update(&ui, T_A, 0);
    frc_odometer_at(&FRC_SAROS_141, T_A, 6, 2, 2, &odo);
    frc_odometer_at(&FRC_SAROS_141, T_A, 8, 2, 1, &grid);
    wake = odo.next_change < grid.next_change ? odo.next_change : grid.next_change;
    CHECK_EQ(f->next_wake, wake); /* no text on this face: the rings alone decide */
    CHECK(f->sleep_us > 20 * 1000000);
    f = fui_ui_update(&ui, wake, 0);
    CHECK(f->redraw);

    TEST_SECTION("frames: never a zero sleep, at any focus");
    for (face = 0; face < FUI_FACE_COUNT; face++) {
        for (i = 0; i <= FUI_FOCUS_MAX; i++) {
            start(&ui, (fui_face_t)face, FUI_MODE_EARTH, (uint8_t)i);
            t = T_A;
            f = fui_ui_update(&ui, t, 0);
            CHECK(f->sleep_us >= (int64_t)ui.min_frame_us);
            t += f->sleep_us;
            f = fui_ui_update(&ui, t, 0);
            CHECK(f->sleep_us >= (int64_t)ui.min_frame_us);
        }
    }
    /* at the very end of the catalogue nothing comes next: no deadline, no spin */
    start(&ui, FUI_FACE_RECT240, FUI_MODE_PURE, 6);
    f = fui_ui_update(&ui, frc_catalogue_last(&FRC_SAROS_141), 0);
    CHECK_EQ(ui.status, FUI_STATUS_OK);
    CHECK(f->sleep_us == -1 || f->sleep_us >= (int64_t)ui.min_frame_us);

    TEST_SECTION("frames: text rows redraw alone");
    info = fui_face_info(FUI_FACE_RECT240X320);
    start(&ui, FUI_FACE_RECT240X320, FUI_MODE_PURE, 6);
    f = fui_ui_update(&ui, T_A, 0);
    t = f->next_wake; /* the next Blink: "3ν" becomes "4ν" */
    CHECK(f->sleep_us < 400000);
    f = fui_ui_update(&ui, t, 0);
    CHECK(f->redraw);
    CHECK(f->dirty.y0 >= 244 && f->dirty.y1 <= 320); /* below the instrument */
    CHECK(f->dirty.x0 == 0 && f->dirty.x1 == info->width);
    CHECK(f->dirty.y1 - f->dirty.y0 <= 20);          /* one row of text */

    TEST_SECTION("states");
    start(&ui, FUI_FACE_ROUND240, FUI_MODE_PURE, 6);
    f = fui_ui_update(&ui, FRC_TIME_NONE, 0);
    CHECK_EQ(ui.status, FUI_STATUS_TIME_UNSET);
    CHECK(f->redraw);
    CHECK_EQ(f->sleep_us, -1);
    CHECK_EQ(f->next_wake, FRC_TIME_NONE);
    f = fui_ui_update(&ui, FRC_TIME_NONE, 5000);
    CHECK(!f->redraw);
    /* the time arrives: the whole face is redrawn */
    f = fui_ui_update(&ui, T_A, 6000);
    CHECK_EQ(ui.status, FUI_STATUS_OK);
    CHECK(f->redraw && f->dirty.x1 == 240 && f->dirty.y1 == 240);
    /* out of the catalogue (ruling 7) */
    f = fui_ui_update(&ui, frc_catalogue_last(&FRC_SAROS_141) + 1, 7000);
    CHECK_EQ(ui.status, FUI_STATUS_OUT_OF_CATALOGUE);
    CHECK(f->redraw);
    CHECK_EQ(f->sleep_us, -1);
    CHECK_EQ(ui.reading.level[6].valid, 0); /* nothing lit */
    f = fui_ui_update(&ui, frc_catalogue_first(&FRC_SAROS_141) - 1, 7000);
    CHECK_EQ(ui.status, FUI_STATUS_OUT_OF_CATALOGUE);
    /* a clock set backwards redraws everything */
    f = fui_ui_update(&ui, T_A, 8000);
    f = fui_ui_update(&ui, T_A - 5 * 1000000, 8000);
    CHECK(f->redraw && f->dirty.x1 == 240 && f->dirty.y1 == 240);
    /* a brief label still times out without a clock */
    start(&ui, FUI_FACE_MONO128, FUI_MODE_PURE, 6);
    fui_ui_update(&ui, FRC_TIME_NONE, 0);
    fui_ui_event(&ui, FUI_EV_LONG, 10);
    f = fui_ui_update(&ui, FRC_TIME_NONE, 10);
    CHECK_EQ(f->sleep_us, (int64_t)FUI_TOAST_MS * 1000);
    CHECK_EQ(f->next_wake, FRC_TIME_NONE);
    /* invalidate */
    start(&ui, FUI_FACE_ROUND240, FUI_MODE_PURE, 6);
    fui_ui_update(&ui, T_A, 0);
    fui_ui_invalidate(&ui);
    f = fui_ui_update(&ui, T_A, 0);
    CHECK(f->redraw && f->dirty.x1 == 240);
}

/*
 * Follow next_wake with partial redraws; what has accumulated in the frame
 * buffer must equal ONE full draw of the state the UI is in at the end. (Not
 * a fresh UI at the final instant: between two ring changes the rings stay
 * as they were last drawn, while a fresh UI would read the clock anew.)
 */
static void test_partial_redraw(void)
{
    static sim_frame_t live, fresh;
    static uint8_t kept[240 * 320 * 2];
    fui_ui_t ui, other;
    int face, screen, mode, focus, step, page, partial = 0, total = 0;

    TEST_SECTION("partial redraw == full redraw");
    for (face = 0; face < FUI_FACE_COUNT; face++) {
        const fui_face_info_t *info = fui_face_info((fui_face_t)face);
        size_t bytes = fui_canvas_bytes(info->mono ? FUI_FMT_MONO_PAGE : FUI_FMT_RGB565, info->width, info->height);

        for (screen = 0; screen < FUI_SCREEN_COUNT; screen++) {
            for (mode = 0; mode < 2; mode++) {
                for (page = 0; page < 3; page++) { /* a card's first three pages (fewer: its last again) */
                    /* a fine focus on the instrument so the rings move during the run */
                    focus = screen <= FUI_SCREEN_SCALES ? 9 : 6;
                    if (page > 0 && screen <= FUI_SCREEN_SCALES) {
                        continue;
                    }
                    start(&ui, (fui_face_t)face, (fui_mode_t)mode, (uint8_t)focus);
                    sim_goto_screen(&ui, (fui_screen_t)screen, 0);
                    ui.page = (uint8_t)page;
                    sim_frame_init(&live, (fui_face_t)face);
                    {
                        frc_time_t t = T_A;
                        const fui_frame_t *f = sim_render(&ui, &live, t, 0, 0);
                        uint64_t hash_live;

                        for (step = 0; step < 40; step++) {
                            if (f->sleep_us < 0) {
                                break;
                            }
                            t += f->sleep_us;
                            f = sim_render(&ui, &live, t, 0, 0);
                            total++;
                            partial += f->redraw && (f->dirty.y1 - f->dirty.y0) < info->height;
                        }
                        hash_live = sim_frame_hash(&live);
                        memcpy(kept, live.canvas.buf, bytes);

                        /* the same state drawn whole (sim_frame_init shares one buffer) */
                        other = ui;
                        other.frame.redraw = 1;
                        other.frame.dirty = fui_rect_make(0, 0, info->width, info->height);
                        sim_frame_init(&fresh, (fui_face_t)face);
                        fui_ui_draw(&other, &fresh.canvas);
                        CHECK(memcmp(kept, fresh.canvas.buf, bytes) == 0);
                        CHECK(hash_live == sim_frame_hash(&fresh));
                    }
                }
            }
        }
    }
    /* and the test did exercise partial redraws, not only full ones */
    CHECK(partial > 100);
    CHECK(total > 1000);
}

static void test_bands(void)
{
    static sim_frame_t frame;
    fui_ui_t ui;
    int face, screen, band, page;

    TEST_SECTION("banded rendering == whole-face rendering");
    for (face = 0; face < FUI_FACE_COUNT; face++) {
        for (screen = 0; screen < FUI_SCREEN_COUNT; screen++) {
            for (page = 0; page < (screen >= FUI_SCREEN_LENS ? 3 : 1); page++) {
                uint64_t whole = 0;

                for (band = 0; band <= 40; band += (band ? 24 : 16)) { /* 0 (whole), 16, 40 rows */
                    start(&ui, (fui_face_t)face, FUI_MODE_EARTH, 6);
                    sim_goto_screen(&ui, (fui_screen_t)screen, 0);
                    ui.page = (uint8_t)page;
                    sim_frame_init(&frame, (fui_face_t)face);
                    sim_render(&ui, &frame, T_A, 0, band);
                    if (band == 0) {
                        whole = sim_frame_hash(&frame);
                    } else {
                        CHECK(sim_frame_hash(&frame) == whole);
                    }
                }
            }
        }
    }
}

/* How near and how far from the ring's centre a cached arc's circle comes, in pixels. */
static void arc_reach(const fui_ring_t *ring, const fui_arc16_t *arc, double *in, double *out)
{
    double dx = arc->cx / 64.0 - ring->cx / 256.0, dy = arc->cy / 64.0 - ring->cy / 256.0;
    double d = sqrt(dx * dx + dy * dy);

    *in = d - arc->r / 64.0;
    *out = d + arc->r / 64.0;
}

static void test_geometry(void)
{
    /* the colour faces' instrument, and the paper face's, which is the same at 5/4 */
    static const fui_face_t colour[] = { FUI_FACE_ROUND240, FUI_FACE_RECT240, FUI_FACE_RECT240X320,
                                         FUI_FACE_MONO400X300 };
    sim_frame_t frame;
    fui_ui_t ui;
    unsigned f;
    int focus, i, d;

    TEST_SECTION("geometry: the ring keeps clear of the bezel and the counter rings");
    for (f = 0; f < sizeof colour / sizeof colour[0]; f++) {
        for (focus = 0; focus <= FUI_FOCUS_MAX; focus++) {
            const fui_ring_t *ring = &ui.ring;
            double radius, in, out;
            int arcs;

            start(&ui, colour[f], FUI_MODE_PURE, (uint8_t)focus);
            fui_ui_update(&ui, T_A, 0);
            radius = ring->radius / 256.0;
            arcs = ring->children * ring->per_child;
            for (i = 0; i < ring->children + arcs; i++) {
                const fui_arc16_t *arc = &ring->arc[i < ring->children ? i : FUI_RING_CHILDREN + i - ring->children];

                arc_reach(ring, arc, &in, &out);
                CHECK(in >= ring->reach_in / 256.0 - 0.5);   /* the bezel is inside reach_in */
                CHECK(out <= ring->reach_out / 256.0 + 0.5); /* the first counter ring outside reach_out */
            }
            /* The nested arcs leave the centre to the odometer ... */
            CHECK(ring->per_child == 0 || ring->reach_in / 256.0 >= 0.6 * radius);
            /* ... and the whole ring fits the face with room for a counter ring. */
            CHECK(ring->reach_out / 256.0 <= 1.6 * radius);
            /* Which levels nest is a decision of AGENTS.md, held here. */
            CHECK_EQ(ring->per_child != 0,
                     focus == 2 || focus == 3 || focus == 6 || focus == 10 || focus == 11);
        }
    }

    TEST_SECTION("geometry: one-bit quarter ticks");
    start(&ui, FUI_FACE_MONO128, FUI_MODE_PURE, 6);
    sim_frame_init(&frame, FUI_FACE_MONO128);
    sim_render(&ui, &frame, T_A, 0, 0);
    for (d = 9; d <= 12; d++) { /* four pixels, 9..12 from the centre pixel (31, 31) */
        CHECK(fui_canvas_get(&frame.canvas, 31 - d, 31) && fui_canvas_get(&frame.canvas, 31 + d, 31));
        CHECK(fui_canvas_get(&frame.canvas, 31, 31 - d) && fui_canvas_get(&frame.canvas, 31, 31 + d));
    }
    for (focus = 0; focus <= FUI_FOCUS_MAX; focus++) {
        /* inside the ticks' reach the picture is the ticks alone: mirror images */
        start(&ui, FUI_FACE_MONO128, FUI_MODE_PURE, (uint8_t)focus);
        sim_frame_init(&frame, FUI_FACE_MONO128);
        sim_render(&ui, &frame, T_A, 0, 0);
        for (d = 1; d <= 8; d++) {
            CHECK_EQ(fui_canvas_get(&frame.canvas, 31 - d, 31), fui_canvas_get(&frame.canvas, 31 + d, 31));
            CHECK_EQ(fui_canvas_get(&frame.canvas, 31, 31 - d), fui_canvas_get(&frame.canvas, 31, 31 + d));
        }
    }
}

/* ------------------------------------------------------------------------- */
/* What a page SAYS: its rows through fui_ui_lines                            */
/* ------------------------------------------------------------------------- */

#define ROWS_MAX 24
#define WORDS_MAX 4096

typedef struct page_text {
    const fui_ui_t *ui;
    int  rows;
    int  top, bottom;        /* rows of pixels the text spans */
    int  outside;            /* rows of text that leave the face (or its visible circle) */
    int  small;              /* rows under the size rule (see collect) */
    int  folded_pb;          /* rows that would draw "pB" in capitals */
    char head[ROWS_MAX];     /* 1: a card's head (the level letter, on every page) */
    int  x[ROWS_MAX], y[ROWS_MAX], w[ROWS_MAX], h[ROWS_MAX]; /* each row's box */
    char text[ROWS_MAX][FUI_TEXT_MAX];
} page_text_t;

static int contains(const char *text, const char *word)
{
    return strstr(text, word) != NULL;
}

static void collect(void *ctx, const char *text, size_t bytes, int x, int y, const fui_text_style_t *style)
{
    page_text_t *page = (page_text_t *)ctx;
    const fui_face_info_t *info = fui_face_info((fui_face_t)page->ui->face);
    int width = fui_text_width(style, text, bytes), height = fui_text_height(style);
    char *copy;

    if (page->rows >= ROWS_MAX || bytes >= FUI_TEXT_MAX) {
        page->outside++;
        return;
    }
    page->head[page->rows] = style->scale >= 3;
    page->x[page->rows] = x;
    page->y[page->rows] = y;
    page->w[page->rows] = width;
    page->h[page->rows] = height;
    copy = page->text[page->rows++];
    memcpy(copy, text, bytes);
    copy[bytes] = '\0';
    page->top = y < page->top ? y : page->top;
    page->bottom = y + height > page->bottom ? y + height : page->bottom;

    /* inside the face; on the round one, inside the circle the glass shows */
    if (x < 0 || y < 0 || x + width > info->width || y + height > info->height) {
        page->outside++;
    } else if (info->round) {
        int dx = x < info->width - (x + width) ? info->width / 2 - x : x + width - info->width / 2;
        int dy = y < info->height - (y + height) ? info->height / 2 - y : y + height - info->height / 2;

        if (dx * dx + dy * dy > (info->width / 2) * (info->width / 2)) {
            page->outside++;
        }
    }
    /* THE SIZE RULE (fui_i.h). Colour: 2 px per dot, except furniture, which
     * the tests that know the screen allow for. One bit: the 3 x 5 dot font
     * only at 2 px per dot (the Earth sign alone is drawn 5 x 5). */
    if (info->mono) {
        if (style->font == &fui_font_small && style->scale < 2 && strcmp(copy, FUI_S_EARTH) != 0) {
            page->small++;
        }
    } else if (style->scale < 2) {
        page->small++;
    }
    /* "pB" is the unit ruling 3 fixes: never drawn "PB". */
    if (contains(copy, "pB") && (style->flags & FUI_TEXT_CAPS)) {
        page->folded_pb++;
    }
}

static void read_page(const fui_ui_t *ui, page_text_t *page)
{
    memset(page, 0, sizeof *page);
    page->ui = ui;
    page->top = 32767;
    page->bottom = -32768;
    fui_ui_lines(ui, collect, page);
}

/* Append the words of a page to `words` (space separated; the middle dots
 * that only separate facts are left out: a wrapped line drops them too, and
 * so is the head, which every page repeats). */
static void add_words(char *words, const page_text_t *page)
{
    int i;

    for (i = 0; i < page->rows; i++) {
        const char *p = page->head[i] ? "" : page->text[i];

        while (*p != '\0') {
            const char *end = p;
            size_t n;

            while (*end != '\0' && *end != ' ') {
                end++;
            }
            n = (size_t)(end - p);
            if (n > 0 && !(n == 2 && memcmp(p, "\xC2\xB7", 2) == 0) && strlen(words) + n + 2 < WORDS_MAX) {
                strncat(words, p, n);
                strcat(words, " ");
            }
            p = *end == ' ' ? end + 1 : end;
        }
    }
}

/* Is every word of `pure`, in order, also in `earth`? ("EARTH only adds") */
static int is_subsequence(const char *pure, const char *earth)
{
    while (*pure != '\0') {
        const char *end = strchr(pure, ' ');
        size_t n = end ? (size_t)(end - pure) : strlen(pure);
        const char *at = earth;

        for (;;) {
            const char *stop = strchr(at, ' ');
            size_t m = stop ? (size_t)(stop - at) : strlen(at);

            if (m == 0 && !stop) {
                return 0; /* ran out of EARTH words */
            }
            if (m == n && memcmp(at, pure, n) == 0) {
                earth = stop ? stop + 1 : at + m;
                break;
            }
            if (!stop) {
                return 0;
            }
            at = stop + 1;
        }
        pure = end ? end + 1 : pure + n;
    }
    return 1;
}

/* Every page of the card `ui` is on: fits, obeys the size rule; its words
 * are appended to `words`. Returns the number of pages. */
static int check_card(fui_ui_t *ui, frc_time_t t, char *words)
{
    static page_text_t page;
    const fui_layout_t *lay = fui_i_layout(ui->face);
    int pages, i, rows = 0;

    ui->page = 0;
    fui_ui_invalidate(ui);
    fui_ui_update(ui, t, 0);
    pages = fui_ui_pages(ui);
    CHECK(pages >= 1 && pages <= FUI_CARD_PAGES);
    for (i = 0; i < pages; i++) {
        ui->page = (uint8_t)i;
        fui_ui_invalidate(ui);
        fui_ui_update(ui, t, 0);
        CHECK_EQ(ui->page, i);
        read_page(ui, &page);
        CHECK(page.rows > 0 && page.rows < FUI_MAX_LINES); /* < : the hash table did not fill */
        CHECK_EQ(ui->line_count, page.rows);
        CHECK_EQ(page.outside, 0);
        CHECK(page.top >= 0 && page.bottom <= lay->info.height);
        CHECK_EQ(page.small, 0);     /* no row of a card is furniture */
        CHECK_EQ(page.folded_pb, 0);
        rows += page.rows;
        if (words) {
            add_words(words, &page);
        }
    }
    CHECK(rows > 0);
    return pages;
}

static void test_cards(void)
{
    static const frc_time_t when[] = { T_A, FRC_TIME_FROM_S(946684800LL), FRC_TIME_FROM_S(2886085800LL),
                                       FRC_TIME_NONE, FRC_TIME_FROM_S(99999999999LL) };
    static char pure[WORDS_MAX], earth[WORDS_MAX];
    static page_text_t page;
    static sim_frame_t frame;
    fui_ui_t ui;
    int face, screen, level, i, j, pages, red_levels;
    unsigned w;

    TEST_SECTION("cards: every page fits its face at 2 px per dot; EARTH only adds");
    for (face = 0; face < FUI_FACE_COUNT; face++) {
        for (w = 0; w < sizeof when / sizeof when[0]; w++) {
            for (screen = FUI_SCREEN_LENS; screen <= FUI_SCREEN_STAMP; screen++) {
                for (level = 0; level < (screen == FUI_SCREEN_LENS ? FRC_LEVEL_COUNT : 1); level++) {
                    start(&ui, (fui_face_t)face, FUI_MODE_PURE, 6);
                    ui.screen = (uint8_t)screen;
                    ui.lens_level = (uint8_t)level;
                    pure[0] = earth[0] = '\0';
                    (void)check_card(&ui, when[w], pure);
                    fui_ui_set_mode(&ui, FUI_MODE_EARTH);
                    pages = check_card(&ui, when[w], earth);
                    /* EARTH adds; it never takes a Fractonica word away. */
                    CHECK(is_subsequence(pure, earth));
                    if (when[w] == T_A) {
                        CHECK(strlen(earth) > strlen(pure)); /* and with a reading it does add */
                    }
                    /* the page count docs/GUIDE.md states, at the Helion, in EARTH
                     * (the 400 x 300 paper face holds it on one) */
                    if (when[w] == T_A && screen == FUI_SCREEN_LENS && level == 6) {
                        CHECK_EQ(pages, face == FUI_FACE_MONO400X300 ? 1 : 2);
                    }
                }
            }
        }
    }

    TEST_SECTION("cards: PURE says no Earth unit; a fact is said once");
    for (face = 0; face < FUI_FACE_COUNT; face++) {
        for (level = 0; level < FRC_LEVEL_COUNT; level++) {
            start(&ui, (fui_face_t)face, FUI_MODE_PURE, 6);
            ui.screen = FUI_SCREEN_LENS;
            ui.lens_level = (uint8_t)level;
            pure[0] = '\0';
            pages = check_card(&ui, T_A, pure);
            CHECK(!contains(pure, FUI_S_EARTH));
            CHECK(!contains(pure, "Hz") && !contains(pure, " m ") && !contains(pure, " s ") && !contains(pure, ":"));
            CHECK(!contains(pure, "%"));
            /* "11η · 11η · 396ι": no row holds the same fact twice, and no
             * two rows of a card are the same (zeta, theta, kappa, mu were) */
            for (i = 0; i < pages; i++) {
                ui.page = (uint8_t)i;
                fui_ui_invalidate(&ui);
                fui_ui_update(&ui, T_A, 0);
                read_page(&ui, &page);
                for (j = 0; j < page.rows; j++) {
                    const char *first = page.text[j], *dot = strstr(first, FUI_S_DOT);

                    while (dot) {
                        const char *second = dot + strlen(FUI_S_DOT), *next = strstr(second, FUI_S_DOT);
                        size_t a = (size_t)(dot - first), b = next ? (size_t)(next - second) : strlen(second);

                        CHECK(!(a == b && memcmp(first, second, a) == 0));
                        first = second;
                        dot = next;
                    }
                }
            }
        }
    }
    /* the exact line of the finding, as the card now says it */
    start(&ui, FUI_FACE_RECT240X320, FUI_MODE_PURE, 6);
    ui.screen = FUI_SCREEN_LENS;
    ui.lens_level = 5;
    pure[0] = '\0';
    (void)check_card(&ui, T_A, pure);
    CHECK(contains(pure, "11\xCE\xB7 396\xCE\xB9 25\xE2\x80\xAF" "740\xCE\xBB ")); /* "11η · 396ι · 25 740λ" */
    ui.lens_level = 6;
    pure[0] = '\0';
    (void)check_card(&ui, T_A, pure);
    CHECK(contains(pure, "1\xCE\xB7 36\xCE\xB9 2\xE2\x80\xAF" "340\xCE\xBB ")); /* a unit level still counts two finer units */
    /* "pB" reaches the one-bit face as the core wrote it */
    start(&ui, FUI_FACE_MONO128, FUI_MODE_PURE, 6);
    ui.screen = FUI_SCREEN_LENS;
    ui.lens_level = 13;
    pure[0] = '\0';
    (void)check_card(&ui, T_A, pure);
    CHECK(contains(pure, "7 pB "));

    TEST_SECTION("cards: the one red is the seal and band of the rung that is light");
    red_levels = 0;
    for (level = 0; level < FRC_LEVEL_COUNT; level++) {
        frc_interval_t interval;
        int x, y, red = 0, visible;

        CHECK(frc_interval_at(&FRC_SAROS_141, T_A, &interval) == FRC_OK);
        visible = frc_band((uint8_t)level, interval) == FRC_BAND_VISIBLE;
        start(&ui, FUI_FACE_ROUND240, FUI_MODE_PURE, 6);
        ui.screen = FUI_SCREEN_LENS;
        ui.lens_level = (uint8_t)level;
        for (i = 0; i < 3; i++) {
            ui.page = (uint8_t)i;
            fui_ui_invalidate(&ui);
            sim_frame_init(&frame, FUI_FACE_ROUND240);
            sim_render(&ui, &frame, T_A, 0, 0);
            for (y = 0; y < 240; y++) {
                for (x = 0; x < 240; x++) {
                    red += fui_canvas_get(&frame.canvas, x, y) == fui_theme_astrolabe.h_alpha;
                }
            }
        }
        CHECK_EQ(red > 0, visible);
        red_levels += visible;
    }
    CHECK_EQ(red_levels, 1); /* S16.2 on Saros 141: one rung in the visible band */
}

/* ------------------------------------------------------------------------- */
/* What the rows say: spans whole, the ladder's ends, "no band"               */
/* ------------------------------------------------------------------------- */

#define ALL_ROWS 64

/* Every row of every page of the card `ui` is on at `t`, as it reads: the
 * no-break spaces that keep a value together are spaces again. */
static int card_rows(fui_ui_t *ui, frc_time_t t, char rows[ALL_ROWS][FUI_TEXT_MAX])
{
    static page_text_t page;
    int pages, i, j, n = 0;

    ui->page = 0;
    fui_ui_invalidate(ui);
    fui_ui_update(ui, t, 0);
    pages = fui_ui_pages(ui);
    for (i = 0; i < pages; i++) {
        ui->page = (uint8_t)i;
        fui_ui_invalidate(ui);
        fui_ui_update(ui, t, 0);
        read_page(ui, &page);
        for (j = 0; j < page.rows && n < ALL_ROWS; j++) {
            const char *from = page.text[j];
            char *to = rows[n++];

            while (*from != '\0') {
                if ((unsigned char)from[0] == 0xC2 && (unsigned char)from[1] == 0xA0) {
                    *to++ = ' ';
                    from += 2;
                } else {
                    *to++ = *from++;
                }
            }
            *to = '\0';
        }
    }
    return n;
}

static int some_row_has(char rows[ALL_ROWS][FUI_TEXT_MAX], int n, const char *text)
{
    int i;

    for (i = 0; i < n; i++) {
        if (contains(rows[i], text)) {
            return 1;
        }
    }
    return 0;
}

static void test_words(void)
{
    static char rows[ALL_ROWS][FUI_TEXT_MAX];
    frc_time_t when[64];
    const frc_catalogue_t *cat = &FRC_SAROS_141;
    int face, level, w, n, count = 0, checked = 0;
    char text[FUI_TEXT_MAX], below[8];
    fui_ui_t ui;

    /* SPEC vectors A, B, C, the instants the review found (a Valley with two
     * parts: "Valley in 29ι 7λ" once wrapped before "7λ"), and random ones */
    when[count++] = T_A;
    when[count++] = FRC_TIME_FROM_S(946684800LL);
    when[count++] = FRC_TIME_FROM_S(2886085800LL);
    when[count++] = FRC_TIME_FROM_S(1700000000LL);
    when[count++] = FRC_TIME_FROM_S(2200000123LL);
    while (count < 64) {
        when[count++] = FRC_TIME_FROM_S(946684800LL + (long long)(test_random() % 3000000000u));
    }

    TEST_SECTION("words: a span the core wrote is never split over two rows");
    for (face = 0; face < FUI_FACE_COUNT; face++) {
        for (w = 0; w < count; w++) {
            frc_sync_t sync;
            frc_threshold_t next;
            frc_span_t span;

            /* the SUN card's countdown to the sync's next quarter */
            start(&ui, (fui_face_t)face, FUI_MODE_PURE, 6);
            ui.screen = FUI_SCREEN_SUN;
            n = card_rows(&ui, when[w], rows);
            if (frc_sync_at(cat, when[w], &sync) == FRC_OK && sync.next.time != FRC_TIME_NONE &&
                frc_span_between(cat, when[w], sync.next.time, &span) == FRC_OK &&
                frc_format_span(&span, 0, text, sizeof text) > 0) {
                CHECK(some_row_has(rows, n, text));
                checked++;
            }
            /* the LENS card's countdown, levels 0..12 */
            for (level = 0; level <= frc_unit_level(FRC_UNIT_BLINK); level += 3) {
                ui.screen = FUI_SCREEN_LENS;
                ui.lens_level = (uint8_t)level;
                n = card_rows(&ui, when[w], rows);
                if (frc_next_threshold(cat, when[w], (uint8_t)level, &next) == FRC_OK && next.time != FRC_TIME_NONE &&
                    frc_span_between(cat, when[w], next.time, &span) == FRC_OK &&
                    frc_format_span(&span, 0, text, sizeof text) > 0) {
                    CHECK(some_row_has(rows, n, text));
                    checked++;
                }
            }
        }
    }
    CHECK(checked > 1000);
    /* and the row the review saw: the whole span, led by "in" */
    start(&ui, FUI_FACE_ROUND240, FUI_MODE_PURE, 6);
    ui.screen = FUI_SCREEN_SUN;
    n = card_rows(&ui, FRC_TIME_FROM_S(1700000000LL), rows);
    CHECK(some_row_has(rows, n, "in 29\xCE\xB9 7\xCE\xBB"));

    TEST_SECTION("words: the ladder ends at its last rung (nothing below \xCE\xBF" "2)");
    frc_format_level_name(FRC_LEVEL_COUNT, below, sizeof below); /* "π2": named by the core, not on the ladder */
    for (face = 0; face < FUI_FACE_COUNT; face++) {
        for (w = 0; w < 2; w++) {
            for (level = FRC_LEVEL_COUNT - 2; level < FRC_LEVEL_COUNT; level++) {
                start(&ui, (fui_face_t)face, w ? FUI_MODE_EARTH : FUI_MODE_PURE, 6);
                ui.screen = FUI_SCREEN_LENS;
                ui.lens_level = (uint8_t)level;
                n = card_rows(&ui, T_A, rows);
                CHECK(!some_row_has(rows, n, below));
                CHECK_EQ(some_row_has(rows, n, "made of"), level + 1 < FRC_LEVEL_COUNT);
                CHECK(some_row_has(rows, n, " in ")); /* its parent is still said */
            }
        }
    }

    TEST_SECTION("words: a rung outside every band reads \"no band\" (ruling 4)");
    for (face = 0; face < FUI_FACE_COUNT; face++) {
        frc_interval_t interval;

        CHECK_EQ(frc_interval_at(cat, T_A, &interval), FRC_OK);
        for (level = 0; level < FRC_LEVEL_COUNT; level++) {
            int none = frc_band(level, interval) == FRC_BAND_NONE;

            start(&ui, (fui_face_t)face, FUI_MODE_PURE, 6);
            ui.screen = FUI_SCREEN_LENS;
            ui.lens_level = (uint8_t)level;
            n = card_rows(&ui, T_A, rows);
            CHECK_EQ(some_row_has(rows, n, "no band"), none);
        }
    }
}

/* ------------------------------------------------------------------------- */

static uint64_t shot(fui_face_t face, fui_mode_t mode, uint8_t focus, fui_screen_t screen, frc_time_t t,
                     const char *events, sim_frame_t *frame)
{
    fui_ui_t ui;
    uint32_t ms = 0;

    start(&ui, face, mode, focus);
    sim_frame_init(frame, face);
    fui_ui_update(&ui, t, ms);
    sim_goto_screen(&ui, screen, ms);
    sim_script(&ui, events, &t, &ms);
    fui_ui_invalidate(&ui);
    sim_render(&ui, frame, t, ms, 0);
    return sim_frame_hash(frame);
}

static void test_sun(void)
{
    static const frc_time_t when[] = { T_A, FRC_TIME_FROM_S(946684800LL), FRC_TIME_FROM_S(2886085800LL) };
    static sim_frame_t frame;
    frc_time_t first = frc_catalogue_first(&FRC_SAROS_141), last = frc_catalogue_last(&FRC_SAROS_141);
    fui_ui_t ui;
    int face, mode, focus, i, lit;
    unsigned w;

    TEST_SECTION("the Sun: one picture of an instant, whatever the focus");
    for (face = 0; face < FUI_FACE_COUNT; face++) {
        for (mode = 0; mode < 2; mode++) {
            for (w = 0; w < sizeof when / sizeof when[0]; w++) {
                uint64_t at_helion = shot((fui_face_t)face, (fui_mode_t)mode, 6, FUI_SCREEN_SUN, when[w], "", &frame);

                for (focus = 0; focus <= FUI_FOCUS_MAX; focus++) {
                    CHECK(shot((fui_face_t)face, (fui_mode_t)mode, (uint8_t)focus, FUI_SCREEN_SUN, when[w], "", &frame) ==
                          at_helion);
                }
            }
        }
    }
    /* and the running slot IS lit behind the Sun at focus 0: sol pixels on the
     * ring just before the Sun's disc (r = 112 around (120, 120), 3 degrees back) */
    start(&ui, FUI_FACE_ROUND240, FUI_MODE_PURE, 0);
    ui.screen = FUI_SCREEN_SUN;
    sim_frame_init(&frame, FUI_FACE_ROUND240);
    sim_render(&ui, &frame, T_A, 0, 0);
    {
        double angle = (FRC_FRAC_TO_DOUBLE(ui.reading.sun_phase) - 0.25) * 2.0 * 3.14159265358979 - 0.07;
        int x = (int)(120.0 + 112.0 * cos(angle)), y = (int)(120.0 + 112.0 * sin(angle)), dx, dy;

        lit = 0;
        for (dy = -1; dy <= 1; dy++) {
            for (dx = -1; dx <= 1; dx++) {
                lit += fui_canvas_get(&frame.canvas, x + dx, y + dy) == fui_theme_astrolabe.sol;
            }
        }
        CHECK(lit >= 1);
    }

    TEST_SECTION("the Sun: the slot's phase and place are the core's");
    for (focus = 0; focus <= FUI_FOCUS_MAX; focus += 13) {
        for (i = 0; i < 3000; i++) {
            frc_time_t t = first + (frc_time_t)(((uint64_t)test_random() << 21) % (uint64_t)(last - first));
            frc_cycle_t helion;
            frc_pentad_t pentad;
            frc_sync_t sync;

            start(&ui, FUI_FACE_ROUND240, FUI_MODE_PURE, (uint8_t)focus);
            fui_ui_update(&ui, t, 0);
            if (frc_sync_at(&FRC_SAROS_141, t, &sync) != FRC_OK) {
                CHECK_EQ(ui.reading.sun_valid, 0);
                continue;
            }
            CHECK_EQ(ui.reading.sun_valid, 1);
            CHECK(frc_cycle_at(&FRC_SAROS_141, t, FRC_SYNC_LEVEL, &helion) == FRC_OK);
            CHECK(ui.reading.sun_slot_phase == helion.phase); /* ruling 1 */
            /* an independent count of the place: the core's Pentad and the
             * Helion's place in it (SPEC S7.5: Pentads of 5, 5, 5 and 4) */
            CHECK(frc_pentad_at(&FRC_SAROS_141, t, &pentad) == FRC_OK);
            CHECK_EQ(ui.reading.sun_within, pentad.index * 5 + pentad.helion - 1);
        }
    }
}

static int same_colour_count(const sim_frame_t *frame, int x0, int y0, int x1, int y1, fui_color_t colour)
{
    int x, y, n = 0;

    for (y = y0; y < y1; y++) {
        for (x = x0; x < x1; x++) {
            n += fui_canvas_get(&frame->canvas, x, y) == colour;
        }
    }
    return n;
}

static void test_marks(void)
{
    static const fui_face_t colour[] = { FUI_FACE_ROUND240, FUI_FACE_RECT240, FUI_FACE_RECT240X320 };
    static sim_frame_t frame, other;
    static uint8_t kept[240 * 320 * 2];
    const fui_theme_t *t = &fui_theme_astrolabe;
    fui_ui_t ui;
    unsigned f;
    int focus, x, y, face;

    TEST_SECTION("marks: the quarter ticks are full ink on a pixel column");
    for (f = 0; f < sizeof colour / sizeof colour[0]; f++) {
        const fui_layout_t *lay = fui_i_layout((uint8_t)colour[f]);
        int cx = lay->cx >> 8, cy = lay->cy >> 8;

        for (focus = 0; focus <= FUI_FOCUS_MAX; focus++) {
            int r_in, mid, next;

            start(&ui, colour[f], FUI_MODE_PURE, (uint8_t)focus);
            sim_frame_init(&frame, colour[f]);
            sim_render(&ui, &frame, T_A, 0, 0);
            r_in = (lay->radius * 71) / 100;
            if (r_in > ui.ring.reach_in - FUI_FX(1.5)) {
                r_in = ui.ring.reach_in - FUI_FX(1.5);
            }
            /* a pixel in the middle of each tick's length, on the column / row left of
             * (above) the axis: exactly the token, not a blend of it with the ground */
            mid = (r_in - ((FUI_FX(5) * lay->radius) / FUI_FX(56)) / 2) >> 8;
            next = ui.reading.next_quarter;
            CHECK(fui_canvas_get(&frame.canvas, cx + mid, cy - 1) == (next == FRC_PEAK ? t->lumen : t->etch3));
            CHECK(fui_canvas_get(&frame.canvas, cx - 1, cy + mid) == (next == FRC_NODE ? t->lumen : t->etch3));
            CHECK(fui_canvas_get(&frame.canvas, cx - 1 - mid, cy - 1) == (next == FRC_VALLEY ? t->lumen : t->etch3));
            CHECK(fui_canvas_get(&frame.canvas, cx - 1, cy - 1 - mid) == (next == FRC_END ? t->lumen : t->etch3));
            /* ... and the unlit ones are one pixel wide: their neighbours are ground */
            if (next != FRC_PEAK) {
                CHECK(fui_canvas_get(&frame.canvas, cx + mid, cy - 2) == t->ground);
                CHECK(fui_canvas_get(&frame.canvas, cx + mid, cy) == t->ground);
            }
        }
    }

    TEST_SECTION("marks: the Earth hallmark of the round face touches nothing");
    for (focus = 0; focus <= FUI_FOCUS_MAX; focus++) {
        int x0 = 108, y0 = 142, differ = 0; /* the sign's 7 x 7 (columns 109..115, rows 143..149) and a pixel around it */

        (void)shot(FUI_FACE_ROUND240, FUI_MODE_PURE, (uint8_t)focus, FUI_SCREEN_NOW, T_A, "", &frame);
        /* PURE: nothing at all is drawn where EARTH puts the sign ... */
        CHECK_EQ(same_colour_count(&frame, x0, y0, x0 + 9, y0 + 9, t->ground), 81);
        memcpy(kept, frame.canvas.buf, 240 * 240 * 2);
        (void)shot(FUI_FACE_ROUND240, FUI_MODE_EARTH, (uint8_t)focus, FUI_SCREEN_NOW, T_A, "", &frame);
        /* ... and EARTH draws it there, in ash */
        CHECK(same_colour_count(&frame, x0 + 1, y0 + 1, x0 + 8, y0 + 8, t->ash) >= 20);
        for (y = 0; y < 240 && focus < FRC_SYNC_LEVEL; y++) { /* (from the Helion on, EARTH also hangs midnights on the Sun's ring) */
            for (x = 0; x < 240; x++) {
                int inside = x >= x0 && x < x0 + 9 && y >= y0 && y < y0 + 9;

                differ += !inside && memcmp(kept + (y * 240 + x) * 2, (uint8_t *)frame.canvas.buf + (y * 240 + x) * 2, 2) != 0;
            }
        }
        CHECK_EQ(differ, 0);
    }

    TEST_SECTION("marks: a label answers without a reading; one bit keeps the Earth sign");
    for (face = 0; face < FUI_FACE_COUNT; face++) {
        uint64_t plain = shot((fui_face_t)face, FUI_MODE_PURE, 6, FUI_SCREEN_NOW, FRC_TIME_NONE, "", &frame);
        uint64_t plain7 = shot((fui_face_t)face, FUI_MODE_PURE, 7, FUI_SCREEN_NOW, FRC_TIME_NONE, "", &frame);

        /* LONG: the mode is named although the time is not set */
        CHECK(shot((fui_face_t)face, FUI_MODE_PURE, 6, FUI_SCREEN_NOW, FRC_TIME_NONE, "L", &frame) != plain);
        /* NEXT: the level is named, not only the engraving changed */
        CHECK(shot((fui_face_t)face, FUI_MODE_PURE, 6, FUI_SCREEN_NOW, FRC_TIME_NONE, "N", &frame) != plain7);
        /* and when the name has gone the status is back */
        CHECK(shot((fui_face_t)face, FUI_MODE_PURE, 6, FUI_SCREEN_NOW, FRC_TIME_NONE, "N W3000", &frame) == plain7);
        /* out of catalogue likewise */
        CHECK(shot((fui_face_t)face, FUI_MODE_PURE, 6, FUI_SCREEN_NOW, FRC_TIME_FROM_S(99999999999LL), "L", &frame) !=
              shot((fui_face_t)face, FUI_MODE_PURE, 6, FUI_SCREEN_NOW, FRC_TIME_FROM_S(99999999999LL), "", &other));
        /* every face tells EARTH from PURE on NOW after the mode's name has gone */
        CHECK(shot((fui_face_t)face, FUI_MODE_PURE, 6, FUI_SCREEN_NOW, T_A, "L W2000 P N W3000", &frame) !=
              shot((fui_face_t)face, FUI_MODE_PURE, 6, FUI_SCREEN_NOW, T_A + FRC_TIME_FROM_S(5), "", &other));
    }
    /* one bit, EARTH: the 5 x 5 sign in the bottom left corner, rows 57..61 */
    (void)shot(FUI_FACE_MONO128, FUI_MODE_EARTH, 6, FUI_SCREEN_NOW, T_A, "", &frame);
    CHECK_EQ(same_colour_count(&frame, 0, 57, 5, 62, 1), 17);
    CHECK_EQ(same_colour_count(&frame, 0, 55, 7, 64, 1), 17); /* nothing else near it */
    (void)shot(FUI_FACE_MONO128, FUI_MODE_PURE, 6, FUI_SCREEN_NOW, T_A, "", &frame);
    CHECK_EQ(same_colour_count(&frame, 0, 55, 7, 64, 1), 0);

    TEST_SECTION("marks: one-bit labels keep their size, a margin, and the ring's room");
    /* Every level's name after a scale step, and the mode after a toggle, in
     * the 3 x 5 dot font at 2 px per dot (once "ε NUCLIDE" fell back to the
     * 1 px font, and "η HELION" inked the last column of the panel). Its ink
     * stays two columns from the right edge and two from the ring's. */
    {
        static uint8_t plain[64][128]; /* (sim frames share one buffer: keep a copy) */
        int events;

        for (focus = 0; focus <= FUI_FOCUS_MAX; focus++) {
            for (events = 0; events < 2; events++) {
                int ring_right = -1, label_left = 128, label_right = -1, label_top = 64, label_bottom = -1;

                (void)shot(FUI_FACE_MONO128, FUI_MODE_PURE, (uint8_t)focus, FUI_SCREEN_NOW, T_A, "", &other);
                for (y = 0; y < 64; y++) {
                    for (x = 0; x < 128; x++) {
                        plain[y][x] = fui_canvas_get(&other.canvas, x, y) != 0;
                    }
                }
                (void)shot(FUI_FACE_MONO128, FUI_MODE_PURE, (uint8_t)focus,
                           events == 0 ? FUI_SCREEN_SCALES : FUI_SCREEN_NOW, T_A, events == 0 ? "" : "L", &frame);
                for (y = 46; y < 64; y++) {
                    for (x = 0; x < 128; x++) {
                        int was = plain[y][x];
                        int is = fui_canvas_get(&frame.canvas, x, y) != 0;

                        if (was && x < 64) {
                            ring_right = x > ring_right ? x : ring_right;
                        }
                        /* the label's ink: what is not the ring's (the count it
                         * replaces lies right of the ring; the Earth sign at x 0..4) */
                        if (is && !(was && x < 64) && x > 8) {
                            label_left = x < label_left ? x : label_left;
                            label_right = x > label_right ? x : label_right;
                            label_top = y < label_top ? y : label_top;
                            label_bottom = y > label_bottom ? y : label_bottom;
                        }
                    }
                }
                CHECK(label_right >= 0);
                CHECK(label_right <= 125);               /* two blank columns at the edge */
                CHECK(label_left >= ring_right + 3);     /* and two beside the ring */
                CHECK(label_bottom - label_top + 1 >= 10); /* capitals 5 dots x 2 px: never the 7 px font */
            }
        }
    }

    TEST_SECTION("marks: the NOW rows are 2 px per dot; furniture is only what is listed");
    for (face = 0; face < FUI_FACE_COUNT; face++) {
        static page_text_t page;
        int mode;

        for (mode = 0; mode < 2; mode++) {
            start(&ui, (fui_face_t)face, (fui_mode_t)mode, 6);
            fui_ui_update(&ui, T_A, 0);
            read_page(&ui, &page);
            CHECK_EQ(page.outside, 0);
            /* furniture: the words row of the tall face (Pentad mark + the
             * Delta's name: 2 texts), the Earth hallmark of the round face */
            CHECK_EQ(page.small, face == FUI_FACE_RECT240X320 ? 2 : face == FUI_FACE_ROUND240 && mode ? 1 : 0);
            /* (the paper face's corners: ε, η, ι and the Pentad's numeral;
             * EARTH adds the civil time) */
            CHECK_EQ(page.rows, face == FUI_FACE_ROUND240 ? mode : face == FUI_FACE_RECT240 ? 2 + mode
                                : face == FUI_FACE_RECT240X320 ? 4 + mode : face == FUI_FACE_MONO400X300 ? 4 + mode
                                : 1 + mode);
            /* the status, when there is no reading, is never furniture */
            start(&ui, (fui_face_t)face, (fui_mode_t)mode, 6);
            fui_ui_update(&ui, FRC_TIME_NONE, 0);
            read_page(&ui, &page);
            CHECK(page.rows >= 1);
            CHECK_EQ(page.small, 0);
            CHECK_EQ(page.outside, 0);
        }
    }
}

/*
 * A UI that sleeps as long as its frame says must show, at every Blink
 * boundary, the lines a UI that looked just then would show. Holds the
 * "this text cannot change before ..." promises of fui_i_line_until /
 * fui_i_span_until against the plain rule (look every Blink).
 */
static void test_quiet_lines(void)
{
    static const fui_face_t faces[] = { FUI_FACE_ROUND240, FUI_FACE_MONO128 };
    frc_time_t first = frc_catalogue_first(&FRC_SAROS_141), last = frc_catalogue_last(&FRC_SAROS_141);
    fui_ui_t ui, look;
    frc_cycle_t blink;
    frc_time_t t, wake;
    unsigned f, mode, start_no;
    int card, step, i, wakes, lens6_wakes = 0, sun_wakes = 0;

    TEST_SECTION("quiet lines: sleeping through Blinks never leaves a stale line");
    for (f = 0; f < sizeof faces / sizeof faces[0]; f++) {
        for (mode = FUI_MODE_PURE; mode <= FUI_MODE_EARTH; mode++) {
            for (card = 0; card <= 13; card++) { /* LENS on levels 0..12, then SUN */
                for (start_no = 0; start_no < 5; start_no++) {
                    /* A, B, C, two minutes before a civil midnight at UTC+2
                     * (EARTH: a threshold of "another day" becomes today's),
                     * then anywhere in the catalogue */
                    t = start_no == 0 ? T_A : start_no == 1 ? FRC_TIME_FROM_S(946684800LL)
                        : start_no == 2 ? FRC_TIME_FROM_S(2886085800LL)
                        : start_no == 3 ? T_A + FRC_TIME_FROM_S(9 * 3600 + 58 * 60)
                        : first + (frc_time_t)(((uint64_t)test_random() << 20) % (uint64_t)(last - first - FRC_US_PER_DAY));
                    /* Begin on a Blink boundary: the next one is then a whole
                     * Blink away, beyond the 100 ms the UI never wakes within. */
                    CHECK(frc_cycle_at(&FRC_SAROS_141, t, 12, &blink) == FRC_OK);
                    t = blink.end;
                    start(&ui, faces[f], (fui_mode_t)mode, 6);
                    start(&look, faces[f], (fui_mode_t)mode, 6);
                    ui.screen = look.screen = (uint8_t)(card == 13 ? FUI_SCREEN_SUN : FUI_SCREEN_LENS);
                    ui.lens_level = look.lens_level = (uint8_t)(card == 13 ? 6 : card);
                    /* the page that holds the countdown: the last one of the
                     * one-bit SUN, the first elsewhere (or the only one) */
                    ui.page = look.page = (uint8_t)(card == 13 && faces[f] == FUI_FACE_MONO128 ? 1 : 0);
                    wake = fui_ui_update(&ui, t, 0)->next_wake;
                    wakes = 0;
                    for (step = 0; step < 800; step++) {
                        CHECK(frc_cycle_at(&FRC_SAROS_141, t, 12, &blink) == FRC_OK);
                        t = blink.end; /* the next Blink boundary */
                        if (wake != FRC_TIME_NONE && t >= wake) {
                            wake = fui_ui_update(&ui, t, 0)->next_wake;
                            wakes++;
                        }
                        fui_ui_invalidate(&look);
                        fui_ui_update(&look, t, 0);
                        CHECK_EQ(ui.line_count, look.line_count);
                        for (i = 0; i < look.line_count && i < ui.line_count; i++) {
                            CHECK(ui.line_hash[i] == look.line_hash[i]);
                        }
                    }
                    if (f == 0 && mode == FUI_MODE_PURE && start_no == 0) {
                        lens6_wakes = card == 6 ? wakes : lens6_wakes;
                        sun_wakes = card == 13 ? wakes : sun_wakes;
                    }
                }
            }
        }
    }
    /* And it does sleep: 800 Blinks at A are 32 Flavons. The Helion's
     * countdown ("6ι 43λ") changes once a Flavon and costs three looks each;
     * the Sun's ("2η 24ι") does not change at all in that time. Looking every
     * Blink would be 800 wakes. */
    CHECK(lens6_wakes > 30 && lens6_wakes < 130);
    CHECK(sun_wakes < 12);
}

/* ------------------------------------------------------------------------- */
/* The step (fui_ui_set_step) and the paper face (FUI_FACE_MONO400X300)       */
/* ------------------------------------------------------------------------- */

/* Does any row of the page count in a unit finer than `finest` (a digit
 * before its symbol: "21λ", not the level letter of "ι Peak in")? The SUN's
 * drift is left out: a fact of the sync in whole Flavons (the lead's ruling),
 * the same all through it, not a reading that moves. */
static int finer_unit_shown(const page_text_t *page, frc_unit_t finest)
{
    int unit, i;

    for (unit = finest + 1; unit < FRC_UNIT_COUNT; unit++) {
        char symbol[8];

        frc_format_unit_symbol((frc_unit_t)unit, symbol, sizeof symbol);
        for (i = 0; i < page->rows; i++) {
            const char *at = page->text[i];

            if (strncmp(at, "drift", 5) == 0) {
                continue;
            }
            while ((at = strstr(at, symbol)) != NULL) {
                if (at > page->text[i] && at[-1] >= '0' && at[-1] <= '9') {
                    return 1;
                }
                at++;
            }
        }
    }
    return 0;
}

static int page_has_row(const page_text_t *page, const char *text)
{
    int i;

    for (i = 0; i < page->rows; i++) {
        if (strcmp(page->text[i], text) == 0) {
            return 1;
        }
    }
    return 0;
}

static void test_step(void)
{
    static const int LEVELS[] = { FUI_STEP_HELION, FUI_STEP_THETA, FUI_STEP_PREON, FUI_STEP_KAPPA, FUI_STEP_FLAVON };
    static const frc_unit_t FINEST[] = { FRC_UNIT_HELION, FRC_UNIT_HELION, FRC_UNIT_PREON, FRC_UNIT_PREON,
                                         FRC_UNIT_FLAVON };
    static page_text_t page;
    const frc_catalogue_t *cat = &FRC_SAROS_141;
    const fui_frame_t *f;
    frc_cycle_t cycle, next_cycle;
    frc_threshold_t next;
    frc_span_t span;
    fui_config_t config;
    fui_ui_t ui;
    char text[FUI_TEXT_MAX];
    frc_time_t t;
    unsigned l;
    int face, focus, k, w, wakes, redraws;

    TEST_SECTION("step: what it takes");
    start(&ui, FUI_FACE_MONO400X300, FUI_MODE_PURE, 6);
    CHECK_EQ(ui.step, FUI_STEP_NONE); /* every face's default: no step */
    for (k = -1; k <= 12; k++) {
        int valid = k == 0 || (k >= 6 && k <= 10);

        CHECK_EQ(fui_ui_set_step(&ui, FUI_STEP_PREON), 1);
        CHECK_EQ(fui_ui_set_step(&ui, k), valid);
        CHECK_EQ(ui.step, valid ? k : FUI_STEP_PREON); /* refused: left as it was */
    }
    memset(&config, 0, sizeof config);
    config.face = FUI_FACE_MONO400X300;
    config.step = 99;
    fui_ui_init(&ui, &config);
    CHECK_EQ(ui.step, FUI_STEP_NONE);
    config.step = FUI_STEP_FLAVON;
    fui_ui_init(&ui, &config);
    CHECK_EQ(ui.step, FUI_STEP_FLAVON);

    TEST_SECTION("step: the face shows the cycle's start and wakes at its end, on every face");
    for (face = 0; face < FUI_FACE_COUNT; face++) {
        for (l = 0; l < sizeof LEVELS / sizeof LEVELS[0]; l++) {
            for (w = 0; w < 3; w++) {
                frc_time_t from = w == 0 ? T_A : w == 1 ? FRC_TIME_FROM_S(946684800LL) : FRC_TIME_FROM_S(2886085800LL);

                start(&ui, (fui_face_t)face, FUI_MODE_EARTH, 6);
                CHECK_EQ(fui_ui_set_step(&ui, LEVELS[l]), 1);
                t = from + 1234567; /* somewhere inside a cycle */
                CHECK(frc_cycle_at(cat, t, (uint8_t)LEVELS[l], &cycle) == FRC_OK);
                f = fui_ui_update(&ui, t, 0);
                CHECK(f->redraw);
                CHECK_EQ(ui.t, cycle.start);
                if (cycle.end - t >= (frc_time_t)ui.min_frame_us) {
                    CHECK_EQ(f->next_wake, cycle.end);
                }
                /* anywhere in the cycle: nothing moves */
                f = fui_ui_update(&ui, cycle.end - 1, 0);
                CHECK(!f->redraw);
                CHECK_EQ(ui.t, cycle.start);
                /* follow the wakes: each is a boundary, one a cycle, none between */
                t = cycle.end;
                wakes = redraws = 0;
                for (k = 0; k < 12; k++) {
                    f = fui_ui_update(&ui, t, 0);
                    wakes++;
                    redraws += f->redraw;
                    CHECK(frc_cycle_at(cat, t, (uint8_t)LEVELS[l], &next_cycle) == FRC_OK);
                    CHECK_EQ(next_cycle.start, t);
                    CHECK_EQ(ui.t, t);
                    CHECK_EQ(f->next_wake, next_cycle.end);
                    t = f->next_wake;
                }
                CHECK_EQ(wakes, 12);
                /* the faces with a reading show a count down to a unit step:
                 * it changes at every boundary (theta and kappa are not units:
                 * their count moves at the Helion's and the Preon's; the
                 * 128 x 64 face has room for two terms only, the paper face's
                 * corners end at the Preon) */
                if ((face == FUI_FACE_RECT240 || face == FUI_FACE_RECT240X320 ||
                     (face == FUI_FACE_MONO400X300 && LEVELS[l] <= FUI_STEP_PREON)) &&
                    frc_unit_of_level((uint8_t)LEVELS[l]) >= 0) {
                    CHECK_EQ(redraws, 12);
                } else {
                    CHECK(redraws <= 12);
                }
            }
        }
    }

    TEST_SECTION("step: readings go down to the step's unit and no finer");
    for (l = 0; l < sizeof LEVELS / sizeof LEVELS[0]; l++) {
        for (focus = 0; focus <= FUI_FOCUS_MAX; focus++) {
            for (w = 0; w < 4; w++) {
                frc_time_t when = w == 0 ? T_A : FRC_TIME_FROM_S(946684800LL + (long long)(test_random() % 3000000000u));

                for (face = 0; face < FUI_FACE_COUNT; face++) {
                    int screen;

                    for (screen = FUI_SCREEN_NOW; screen <= FUI_SCREEN_STAMP; screen++) {
                        if (screen == FUI_SCREEN_SCALES || screen == FUI_SCREEN_LENS) {
                            continue; /* (the LENS says a level's length in its units) */
                        }
                        start(&ui, (fui_face_t)face, FUI_MODE_PURE, (uint8_t)focus);
                        CHECK_EQ(fui_ui_set_step(&ui, LEVELS[l]), 1);
                        fui_ui_set_screen(&ui, (fui_screen_t)screen);
                        fui_ui_update(&ui, when, 0);
                        read_page(&ui, &page);
                        CHECK(!finer_unit_shown(&page, FINEST[l]));
                    }
                }
            }
        }
    }
    /* the owner's corners at the instant the step shows (vector A: ε#5 34η 29ι 21λ 3ν,
     * Pentad II): the core's terms, nothing finer than the step */
    start(&ui, FUI_FACE_MONO400X300, FUI_MODE_PURE, 6);
    fui_ui_set_step(&ui, FUI_STEP_PREON);
    fui_ui_update(&ui, T_A, 0);
    read_page(&ui, &page);
    CHECK(page_has_row(&page, "\xCE\xB5#5") && page_has_row(&page, "34\xCE\xB7") && page_has_row(&page, "29\xCE\xB9"));
    CHECK(page_has_row(&page, "II"));
    CHECK_EQ(page.rows, 4);
    fui_ui_set_step(&ui, FUI_STEP_FLAVON); /* the corners stop at the Preon: the same rows */
    fui_ui_update(&ui, T_A, 0);
    read_page(&ui, &page);
    CHECK(page_has_row(&page, "29\xCE\xB9"));
    CHECK_EQ(page.rows, 4);
    fui_ui_set_step(&ui, FUI_STEP_HELION); /* the Preon is finer than the step: not shown */
    fui_ui_update(&ui, T_A, 0);
    read_page(&ui, &page);
    CHECK(page_has_row(&page, "34\xCE\xB7") && !page_has_row(&page, "29\xCE\xB9"));
    CHECK_EQ(page.rows, 3);
    /* EARTH: minutes at the Preon, seconds at the Flavon; led by the Earth sign */
    start(&ui, FUI_FACE_MONO400X300, FUI_MODE_EARTH, 6);
    fui_ui_set_step(&ui, FUI_STEP_PREON);
    fui_ui_update(&ui, T_A, 0);
    read_page(&ui, &page);
    CHECK(page_has_row(&page, FUI_S_EARTH " 13:57"));
    CHECK_EQ(page.rows, 5);
    fui_ui_set_step(&ui, FUI_STEP_FLAVON);
    fui_ui_update(&ui, T_A, 0);
    read_page(&ui, &page);
    CHECK(page_has_row(&page, FUI_S_EARTH " 13:59:58"));
    /* a countdown at a step: the core's span cut to the step's unit (the shim);
     * under one unit "0" of it */
    {
        frc_span_t cut;

        CHECK(frc_cycle_at(cat, T_A, FUI_STEP_PREON, &cycle) == FRC_OK);
        CHECK(frc_next_threshold(cat, cycle.start, 6, &next) == FRC_OK);
        CHECK(frc_span_between(cat, cycle.start, next.time, &span) == FRC_OK);
        fui_shim_format_span_to(&span, 0, FRC_UNIT_PREON, text, sizeof text);
        CHECK_EQ(strcmp(text, "7\xCE\xB9"), 0); /* 29ι + 7ι = 36ι, the Helion's END */
        CHECK(frc_span_between(cat, T_A, next.time, &span) == FRC_OK);
        fui_shim_format_span_to(&span, 0, FRC_UNIT_PREON, text, sizeof text);
        CHECK_EQ(strcmp(text, "6\xCE\xB9"), 0); /* 6ι 43λ live, cut */
        fui_shim_format_span_to(&span, 0, FRC_UNIT_FLAVON, text, sizeof text);
        CHECK_EQ(strcmp(text, "6\xCE\xB9 43\xCE\xBB"), 0);
        fui_shim_format_span_to(&span, 0, FRC_UNIT_BLINK, text, sizeof text);
        frc_format_span(&span, 0, text + 64, sizeof text - 64);
        CHECK_EQ(strcmp(text, text + 64), 0); /* the Blink: frc_format_span itself */
        CHECK(frc_span_between(cat, T_A, T_A + 60 * 1000000, &cut) == FRC_OK);
        fui_shim_format_span_to(&cut, 0, FRC_UNIT_PREON, text, sizeof text);
        CHECK_EQ(strcmp(text, "0\xCE\xB9"), 0);
    }

    TEST_SECTION("step: labels still come and go on time; input redraws at once");
    start(&ui, FUI_FACE_MONO400X300, FUI_MODE_PURE, 6);
    fui_ui_set_step(&ui, FUI_STEP_PREON);
    CHECK(frc_cycle_at(cat, T_A, FUI_STEP_PREON, &cycle) == FRC_OK);
    fui_ui_update(&ui, T_A, 1000);
    fui_ui_event(&ui, FUI_EV_NEXT, 1000);
    f = fui_ui_update(&ui, T_A, 1000);
    CHECK(f->redraw && f->dirty.y1 == 300 && f->dirty.x1 == 400);
    CHECK_EQ(ui.screen, FUI_SCREEN_SCALES);
    CHECK_EQ(ui.t, cycle.start);
    CHECK_EQ(f->sleep_us, (int64_t)FUI_NAME_MS * 1000); /* the name's end, before the cycle's */
    f = fui_ui_update(&ui, T_A + FRC_TIME_FROM_S(1), 2000); /* (1 s later: nothing) */
    CHECK(!f->redraw);
    f = fui_ui_update(&ui, T_A + (frc_time_t)FUI_NAME_MS * 1000, 1000 + FUI_NAME_MS);
    CHECK_EQ(ui.screen, FUI_SCREEN_NOW);
    CHECK(f->redraw);
    CHECK_EQ(ui.t, cycle.start);
    CHECK_EQ(f->next_wake, cycle.end);
    fui_ui_event(&ui, FUI_EV_LONG, 5000);
    f = fui_ui_update(&ui, T_A + FRC_TIME_FROM_S(4), 5000);
    CHECK(f->redraw && ui.toast);
    CHECK_EQ(f->sleep_us, (int64_t)FUI_TOAST_MS * 1000);
    f = fui_ui_update(&ui, T_A + FRC_TIME_FROM_S(4) + FUI_TOAST_MS * 1000, 5000 + FUI_TOAST_MS);
    CHECK(f->redraw && !ui.toast);
    CHECK_EQ(f->next_wake, cycle.end);
    fui_ui_event(&ui, FUI_EV_SELECT, 9000);
    f = fui_ui_update(&ui, T_A + FRC_TIME_FROM_S(9), 9000);
    CHECK(f->redraw);
    CHECK_EQ(ui.screen, FUI_SCREEN_LENS);
    CHECK_EQ(ui.t, cycle.start);
    /* no step again: the face moves as the clock does */
    fui_ui_set_step(&ui, FUI_STEP_NONE);
    fui_ui_set_screen(&ui, FUI_SCREEN_NOW);
    f = fui_ui_update(&ui, T_A, 9000);
    CHECK_EQ(ui.t, T_A);
    CHECK(f->next_wake < cycle.end);
}

/* The paper face's NOW: the wave as large as its room, every corner clear of it. */
static void test_wave(void)
{
    static page_text_t page;
    fui_ui_t ui;
    int focus, mode, i;

    static const frc_time_t when[] = { T_A, FRC_TIME_FROM_S(946684800LL), FRC_TIME_FROM_S(2886085800LL),
                                       FRC_TIME_FROM_S(1791460800LL + 79200), FRC_TIME_FROM_S(1791460800LL + 172800),
                                       FRC_TIME_FROM_S(1791460800LL + 1340000) };
    unsigned w;

    TEST_SECTION("wave: sized to its room at every focus; the corners stay clear");
    for (w = 0; w < sizeof when / sizeof when[0]; w++)
    for (mode = 0; mode < 2; mode++) {
        for (focus = 0; focus <= FUI_FOCUS_MAX; focus++) {
            const fui_ring_t *ring = &ui.ring;
            double cx, cy, reach;
            fui_config_t config;

            memset(&config, 0, sizeof config);
            config.face = FUI_FACE_MONO400X300;
            config.mode = (fui_mode_t)mode;
            config.focus = (uint8_t)focus;
            config.utc_offset_s = 7200;
            config.step = FUI_STEP_PREON;
            fui_ui_init(&ui, &config);
            fui_ui_update(&ui, when[w], 0);
            cx = ring->cx / 256.0;
            cy = ring->cy / 256.0;
            reach = ring->reach_out / 256.0;
            CHECK(cx == 199.5 && cy == 149.5);
            /* 146 px; in EARTH 4 px above the time's cell: 122 */
            CHECK_EQ(ring->goal, FUI_FX(mode ? 122 : 146));
            CHECK(ring->reach_out <= ring->goal && ring->reach_out > ring->goal - FUI_FX_ONE);
            read_page(&ui, &page);
            CHECK_EQ(page.outside, 0);
            /* every row's cell (the corners, the Pentad's numeral, EARTH's
             * time) and the Pentad's mark (its 60 px box, bottom left) lie
             * more than 2 px outside the circle the wave's ink keeps to */
            {
                /* three counts, the Pentad's numeral (none for the Hypopentad), EARTH's time */
                frc_pentad_t pentad;
                char numeral[8] = "";

                if (frc_pentad_at(&FRC_SAROS_141, ui.t, &pentad) == FRC_OK) {
                    frc_format_pentad(&pentad, FRC_PENTAD_NUMERAL, 0, numeral, sizeof numeral);
                }
                CHECK_EQ(page.rows, 3 + (numeral[0] != '\0') + mode);
            }
            for (i = 0; i <= page.rows; i++) {
                double x0 = i < page.rows ? page.x[i] : 8, y0 = i < page.rows ? page.y[i] : 234;
                double x1 = i < page.rows ? x0 + page.w[i] : 68, y1 = i < page.rows ? y0 + page.h[i] : 294;
                double nx = cx < x0 ? x0 : cx > x1 ? x1 : cx, ny = cy < y0 ? y0 : cy > y1 ? y1 : cy;

                CHECK(sqrt((nx - cx) * (nx - cx) + (ny - cy) * (ny - cy)) > reach + 2);
            }
        }
    }
}

/* The paper corners' subset fonts hold everything those slots ever write. */
static void test_paper_fonts(void)
{
    static const fui_font_t *const FONTS[] = { &fui_font_line };
    const frc_catalogue_t *cat = &FRC_SAROS_141;
    frc_time_t first = frc_catalogue_first(cat), last = frc_catalogue_last(cat);
    char text[64];
    int k, f, missing = 0, n = 0;

    TEST_SECTION("paper font: the corners' texts at 2,000 instants have every glyph");
    for (k = 0; k < 2000; k++) {
        frc_time_t t = first + (frc_time_t)(((uint64_t)test_random() << 21) % (uint64_t)(last - first));
        frc_date_t date;
        frc_pentad_t pentad;
        frc_civil_t civil;
        int part;

        CHECK(frc_date_at(cat, t, &date) == FRC_OK);
        frc_civil_from_time(t, (int32_t)(test_random() % 50400) - 43200 + 7200, &civil);
        for (part = 0; part < 6; part++) {
            const char *p = text;
            uint32_t cp;

            text[0] = '\0';
            if (part < 3) {
                frc_format_date_term(&date, part == 0 ? FRC_UNIT_NUCLIDE : part == 1 ? FRC_UNIT_HELION : FRC_UNIT_PREON,
                                     text, sizeof text);
            } else if (part == 3) {
                if (frc_pentad_at(cat, t, &pentad) == FRC_OK) {
                    frc_format_pentad(&pentad, FRC_PENTAD_NUMERAL, 0, text, sizeof text);
                }
            } else {
                size_t len;

                strcpy(text, FUI_S_EARTH " ");
                len = strlen(text);
                frc_format_civil_text(&civil, 0, part == 4 ? FRC_CIVIL_TIME : FRC_CIVIL_MINUTE, text + len,
                                      sizeof text - len);
            }
            while ((cp = fui_utf8_next(&p)) != 0) {
                for (f = 0; f < (int)(sizeof FONTS / sizeof FONTS[0]); f++) {
                    missing += !fui_font_has(FONTS[f], cp);
                    n++;
                }
            }
        }
    }
    CHECK_EQ(missing, 0);
    CHECK(n > 20000);
    /* and the numeral V the owner listed, though the core writes I..III only */
    CHECK(fui_font_has(&fui_font_line, 'V'));
    /* ... and nothing else: a letter they lack is the missing box, not a blank */
    CHECK(!fui_font_has(&fui_font_line, 'A'));
}

/* The paper face in the framework's canvas: MONO_ROW, a set bit is white. */
static void test_paper(void)
{
    static uint8_t row[15000], row_mono[15000], band[400 / 8 * 40];
    static sim_frame_t frame;
    fui_config_t config;
    fui_ui_t ui;
    fui_canvas_t c, c_mono, strip;
    int screen, mode, x, y, ink, ground_set, differ, inverse, band_differ;

    TEST_SECTION("paper: black ink (clear bits) on white paper (set bits) in MONO_ROW");
    CHECK_EQ(fui_canvas_bytes(FUI_FMT_MONO_ROW, 400, 300), sizeof row);
    for (screen = 0; screen < FUI_SCREEN_COUNT + 2; screen++) {
        for (mode = 0; mode < 2; mode++) {
            /* NOW, SCALES, LENS, SUN, STAMP at the Preon, then time not set and out of catalogue */
            frc_time_t t = screen == FUI_SCREEN_COUNT ? FRC_TIME_NONE
                           : screen == FUI_SCREEN_COUNT + 1 ? FRC_TIME_FROM_S(99999999999LL) : T_A;

            memset(&config, 0, sizeof config);
            config.face = FUI_FACE_MONO400X300;
            config.mode = (fui_mode_t)mode;
            config.focus = 6;
            config.utc_offset_s = 7200;
            config.step = FUI_STEP_PREON;
            fui_ui_init(&ui, &config);
            CHECK(ui.theme == &fui_theme_paper); /* the face's default */
            fui_ui_update(&ui, t, 0);
            sim_goto_screen(&ui, screen < FUI_SCREEN_COUNT ? (fui_screen_t)screen : FUI_SCREEN_NOW, 0);
            fui_ui_update(&ui, t, 0);
            fui_ui_invalidate(&ui);
            fui_ui_update(&ui, t, 0);

            memset(row, 0, sizeof row); /* the ground must be drawn, not found */
            fui_canvas_init(&c, row, FUI_FMT_MONO_ROW, 400, 300);
            fui_ui_draw(&ui, &c);
            /* the simulator's pages: the same picture */
            sim_frame_init(&frame, FUI_FACE_MONO400X300);
            fui_ui_draw(&ui, &frame.canvas);
            /* the same frame in the OLED's polarity (fui_theme_mono): every pixel the other way */
            ui.theme = &fui_theme_mono;
            memset(row_mono, 0xFF, sizeof row_mono);
            fui_canvas_init(&c_mono, row_mono, FUI_FMT_MONO_ROW, 400, 300);
            fui_ui_draw(&ui, &c_mono);
            ui.theme = &fui_theme_paper;
            /* bands of 40 rows through a strip, as a framework short of RAM would */
            band_differ = 0;
            for (y = 0; y < 300; y += 40) {
                int rows = 300 - y < 40 ? 300 - y : 40, r;

                fui_canvas_init(&strip, band, FUI_FMT_MONO_ROW, 400, rows);
                fui_canvas_set_origin(&strip, 0, y);
                fui_ui_draw(&ui, &strip);
                for (r = 0; r < rows; r++) {
                    band_differ += memcmp(band + r * 50, row + (y + r) * 50, 50) != 0;
                }
            }
            CHECK_EQ(band_differ, 0);

            ink = ground_set = differ = inverse = 0;
            for (y = 0; y < 300; y++) {
                for (x = 0; x < 400; x++) {
                    int bit = (row[y * 50 + x / 8] >> (7 - x % 8)) & 1;
                    int bit_mono = (row_mono[y * 50 + x / 8] >> (7 - x % 8)) & 1;

                    ink += !bit;
                    differ += bit != (fui_canvas_get(&frame.canvas, x, y) != 0);
                    inverse += bit == bit_mono;
                    /* a margin of the panel nothing is drawn in: the ground, set */
                    if (y < 2 || x >= 398) {
                        ground_set += bit;
                    }
                }
            }
            CHECK_EQ(differ, 0);
            CHECK_EQ(inverse, 0);
            CHECK_EQ(ground_set, 2 * 398 + 300 * 2);
            CHECK(ink > 500);           /* there is a picture ... */
            CHECK(ink < 400 * 300 / 4); /* ... in ink on a white ground */
        }
    }
}

int main(void)
{
    test_navigation();
    test_vector_a();
    test_frames();
    test_partial_redraw();
    test_bands();
    test_geometry();
    test_cards();
    test_words();
    test_sun();
    test_marks();
    test_quiet_lines();
    test_step();
    test_wave();
    test_paper_fonts();
    test_paper();
    TEST_SUMMARY("ui");
}
