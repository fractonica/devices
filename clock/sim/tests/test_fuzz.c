/*
 * test_fuzz.c - random input against the rasteriser and the whole UI, built
 * with the address and undefined-behaviour sanitizers (sim/Makefile compiles
 * this program, the UI library and the core with -fsanitize=address,undefined
 * -fno-sanitize-recover=all: the first overflow, out-of-bounds access or
 * undefined shift stops the run with the sanitizer's report).
 *
 *   raster   every primitive on random canvases (all four formats, any
 *            origin, any clip), with centres, radii, sweeps and widths up to
 *            and past the documented limits: nothing outside the clip may
 *            change, and nothing may be undefined
 *   ui       random sessions on every face, whole frame and bands: instants
 *            anywhere (the catalogue's edges, far outside it, near the ends
 *            of int64, not set), random events, time running as the device
 *            runs it; the frame contract holds (sleep is -1 or >= 0, the
 *            wake instant is never in the past)
 *
 * The other tests check that the pictures are RIGHT; this one checks that no
 * input makes the code step outside C. Deterministic: a failure repeats.
 */
#include <stdlib.h>
#include <string.h>

#include "fui_ui.h"
#include "sim_test.h"

static int32_t between(int32_t lo, int32_t hi)
{
    return lo + (int32_t)(test_random() % (unsigned)(hi - lo + 1));
}

static int16_t q6(long v)
{
    return (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
}

/* One random primitive, near the canvas half of the time. `extreme`: sizes
 * up to and past the 250 px limit, segments over the whole int16 range. */
static void random_primitive(fui_canvas_t *c, int ox, int oy, int w, int h, int extreme)
{
    int32_t limit = extreme ? 300 : 130;
    fui_fx_t cx = between(-400 * 256, 700 * 256), cy = between(-400 * 256, 700 * 256);
    fui_color_t ink = (fui_color_t)test_random();

    if (test_random() % 2) {
        cx = (ox + between(-40, w + 40)) * 256 + between(0, 255);
        cy = (oy + between(-40, h + 40)) * 256 + between(0, 255);
    }
    switch (test_random() % 6) {
    case 0:
    case 1: {
        static const int32_t SWEEPS[] = { 0, 1, -1, 65536, -65536, 32768, -32768 };
        fui_arc_t arc, part;
        fui_fx_t px, py;
        uint8_t phase = (uint8_t)(test_random() % 3);

        arc.cx = cx;
        arc.cy = cy;
        arc.r = between(-256, limit * 256);
        arc.start = (uint16_t)test_random();
        arc.sweep = test_random() % 4 ? between(-65536, 65536) : SWEEPS[test_random() % 7];
        if (test_random() % 2) {
            fui_draw_arc(c, &arc, between(0, 40 * 256), ink);
        } else {
            fui_draw_arc_dotted(c, &arc, ink, test_random() % 2 ? &phase : NULL);
        }
        part = fui_arc_part(&arc, between(0, 65536), between(0, 65536));
        fui_arc_point(&arc, between(0, 65536), &px, &py);
        fui_draw_arc(c, &part, between(0, 8 * 256), ink);
        break;
    }
    case 2:
        fui_draw_line(c, cx, cy, cx + between(-limit * 256, limit * 256), cy + between(-limit * 256, limit * 256),
                      between(0, 20 * 256), ink);
        break;
    case 3:
        fui_fill_disc(c, cx, cy, between(-256, limit * 256), ink);
        break;
    case 4:
        fui_draw_ring(c, cx, cy, between(-256, limit * 256), between(0, 20 * 256), ink);
        break;
    default: {
        fui_seg_t seg[FUI_SEGS_MAX + 4];
        long span = extreme ? 65535 : 40 * 64, bx = cx >> 2, by = cy >> 2;
        int count = between(-1, extreme ? FUI_SEGS_MAX + 4 : 12), i;

        for (i = 0; i < FUI_SEGS_MAX + 4; i++) {
            seg[i].x0 = q6(bx + between(-span, span));
            seg[i].y0 = q6(by + between(-span, span));
            seg[i].x1 = q6(bx + between(-span, span));
            seg[i].y1 = q6(by + between(-span, span));
        }
        fui_draw_segments(c, seg, count, between(0, 12 * 256), ink);
        break;
    }
    }
}

static void fuzz_raster(int cases, int extreme)
{
    static uint8_t buf[320 * 320 * 2], before[320 * 320 * 2];
    int i;

    for (i = 0; i < cases; i++) {
        fui_format_t format = (fui_format_t)(test_random() % 4);
        int w = between(1, 320), h = between(1, 320), ox = between(-50, 300), oy = between(-50, 300), x, y, k;
        size_t bytes;
        fui_canvas_t c, b;
        fui_rect_t clip;
        int outside = 0;

        if (format == FUI_FMT_MONO_PAGE) {
            h = (h + 7) & ~7;
            if (h > 320) {
                h = 320;
            }
        }
        bytes = fui_canvas_bytes(format, w, h);
        for (k = 0; k < (int)bytes; k++) {
            buf[k] = (uint8_t)test_random();
        }
        memcpy(before, buf, bytes);
        fui_canvas_init(&c, buf, format, w, h);
        fui_canvas_set_origin(&c, ox, oy);
        clip = fui_rect_make(ox + between(-20, w), oy + between(-20, h), ox + between(0, w + 20), oy + between(0, h + 20));
        fui_canvas_set_clip(&c, &clip);
        for (k = 0; k < 4; k++) {
            random_primitive(&c, ox, oy, w, h, extreme);
        }
        b = c;
        b.buf = before;
        for (y = oy; y < oy + h; y++) {
            for (x = ox; x < ox + w; x++) {
                int inside = x >= c.clip.x0 && x < c.clip.x1 && y >= c.clip.y0 && y < c.clip.y1;

                outside += !inside && fui_canvas_get(&c, x, y) != fui_canvas_get(&b, x, y);
            }
        }
        CHECK_EQ(outside, 0);
    }
}

/* An instant anywhere a clock could be set: mostly the catalogue, but also
 * its edges, far outside, the ends of int64 and "not set". */
static frc_time_t random_instant(void)
{
    const frc_catalogue_t *cat = &FRC_SAROS_141;
    frc_time_t first = frc_catalogue_first(cat), last = frc_catalogue_last(cat);
    uint64_t r = ((uint64_t)test_random() << 32) | test_random();

    switch (test_random() % 8) {
    case 0: return first + between(-1000000, 1000000);
    case 1: return last + between(-1000000, 1000000);
    case 2: return FRC_TIME_NONE;
    case 3: return test_random() % 2 ? INT64_MAX - between(0, 1000) : INT64_MIN + 1 + between(0, 1000);
    case 4: return (frc_time_t)(r >> 1) - (frc_time_t)(1ULL << 62);
    default: return first + (frc_time_t)(r % (uint64_t)(last - first));
    }
}

static void fuzz_ui(int sessions)
{
    static uint8_t buf[240 * 320 * 2];
    static fui_ui_t ui;
    int i, k;

    for (i = 0; i < sessions; i++) {
        fui_config_t config;
        fui_face_t face = (fui_face_t)(test_random() % FUI_FACE_COUNT);
        const fui_face_info_t *info = fui_face_info(face);
        fui_format_t format = info->mono ? FUI_FMT_MONO_PAGE : FUI_FMT_RGB565_BE;
        int banded = !info->mono && test_random() % 2, rows = between(1, 60);
        frc_time_t t = random_instant();
        uint32_t ms = test_random();

        memset(&config, 0, sizeof config);
        config.face = face;
        config.mode = (fui_mode_t)(test_random() % 2);
        config.focus = (uint8_t)(test_random() % 16);
        config.utc_offset_s = (between(0, 1560) - 720) * 60;
        config.min_frame_us = test_random() % 3 ? 0 : test_random() % 5000000;
        fui_ui_init(&ui, &config);
        for (k = 0; k < 12; k++) {
            const fui_frame_t *f;

            if (test_random() % 3 == 0) {
                (void)fui_ui_event(&ui, (fui_event_t)(test_random() % 5), ms);
            }
            f = fui_ui_update(&ui, t, ms);
            CHECK(f->sleep_us >= -1);
            CHECK(f->next_wake == FRC_TIME_NONE || t == FRC_TIME_NONE || f->next_wake >= t);
            if (f->redraw) {
                fui_canvas_t c;

                if (!banded) {
                    fui_canvas_init(&c, buf, format, info->width, info->height);
                    fui_ui_draw(&ui, &c);
                } else {
                    int width = f->dirty.x1 - f->dirty.x0, y, strip = rows * info->width / width;

                    for (y = f->dirty.y0; y < f->dirty.y1; y += strip) {
                        int height = f->dirty.y1 - y < strip ? f->dirty.y1 - y : strip;

                        fui_canvas_init(&c, buf, format, width, height);
                        fui_canvas_set_origin(&c, f->dirty.x0, y);
                        fui_ui_draw(&ui, &c);
                    }
                }
            }
            /* time moves as on the device: to the wake instant; or it jumps */
            if (t != FRC_TIME_NONE && f->sleep_us >= 0 && test_random() % 4) {
                if (t <= INT64_MAX - f->sleep_us) {
                    t += f->sleep_us;
                }
            } else if (test_random() % 5 == 0) {
                t = random_instant();
            }
            ms += test_random() % 3000;
        }
    }
}

int main(void)
{
    TEST_SECTION("raster: realistic sizes");
    fuzz_raster(12000, 0);
    TEST_SECTION("raster: past the limits");
    fuzz_raster(3000, 1);
    TEST_SECTION("ui: random sessions, every face, any instant");
    fuzz_ui(300);
    TEST_SUMMARY("fuzz (address + undefined-behaviour sanitizers)");
}
