/*
 * test_canvas.c - the drawing surface: the documented memory layouts (a
 * driver depends on them bit for bit), the clip rectangle, the dirty box,
 * and band rendering through fui_canvas_set_origin.
 */
#include <string.h>

#include "fui_raster.h"
#include "sim_test.h"

static uint8_t buf[64 * 64 * 2], ref[64 * 64 * 2];

static void test_layouts(void)
{
    fui_canvas_t c;
    uint16_t word;

    TEST_SECTION("layout: SSD1306 pages");
    memset(buf, 0, sizeof buf);
    fui_canvas_init(&c, buf, FUI_FMT_MONO_PAGE, 128, 20);
    CHECK_EQ(fui_canvas_bytes(FUI_FMT_MONO_PAGE, 128, 64), 1024);
    CHECK_EQ(fui_canvas_bytes(FUI_FMT_MONO_PAGE, 128, 20), 128 * 3); /* rounded up to pages */
    fui_canvas_pixel(&c, 5, 0, 1);   /* page 0, bit 0 */
    fui_canvas_pixel(&c, 5, 7, 1);   /* page 0, bit 7 */
    fui_canvas_pixel(&c, 127, 9, 1); /* page 1, bit 1 */
    CHECK_EQ(buf[5], 0x81);
    CHECK_EQ(buf[128 + 127], 0x02);
    fui_canvas_pixel(&c, 5, 0, 0);
    CHECK_EQ(buf[5], 0x80);
    CHECK_EQ(fui_canvas_get(&c, 5, 7), 1);
    CHECK_EQ(fui_canvas_get(&c, 5, 0), 0);

    TEST_SECTION("layout: one-bit rows");
    memset(buf, 0, sizeof buf);
    fui_canvas_init(&c, buf, FUI_FMT_MONO_ROW, 20, 4);
    CHECK_EQ(fui_canvas_bytes(FUI_FMT_MONO_ROW, 20, 4), 12); /* 3 bytes a row */
    fui_canvas_pixel(&c, 0, 0, 1);  /* row 0, byte 0, bit 7 */
    fui_canvas_pixel(&c, 9, 1, 1);  /* row 1, byte 1, bit 6 */
    CHECK_EQ(buf[0], 0x80);
    CHECK_EQ(buf[3 + 1], 0x40);
    CHECK_EQ(fui_canvas_get(&c, 9, 1), 1);

    TEST_SECTION("layout: RGB565 in both byte orders");
    memset(buf, 0, sizeof buf);
    fui_canvas_init(&c, buf, FUI_FMT_RGB565, 8, 2);
    CHECK_EQ(fui_canvas_bytes(FUI_FMT_RGB565, 240, 240), 115200);
    fui_canvas_pixel(&c, 3, 1, 0x1234);
    memcpy(&word, buf + (8 + 3) * 2, 2);
    CHECK_EQ(word, 0x1234);
    fui_canvas_init(&c, buf, FUI_FMT_RGB565_BE, 8, 2);
    fui_canvas_pixel(&c, 3, 1, 0x1234);
    CHECK_EQ(buf[(8 + 3) * 2], 0x12); /* high byte first: what an SPI panel takes */
    CHECK_EQ(buf[(8 + 3) * 2 + 1], 0x34);
    CHECK_EQ(fui_canvas_get(&c, 3, 1), 0x1234);

    TEST_SECTION("blend");
    CHECK_EQ(FUI_RGB565(255, 255, 255), 0xFFFF);
    CHECK_EQ(FUI_RGB565(0, 0, 0), 0);
    CHECK_EQ(fui_blend565(0x0000, 0xFFFF, 32), 0xFFFF);
    CHECK_EQ(fui_blend565(0x1234, 0xFFFF, 0), 0x1234);
    CHECK_EQ(fui_blend565(0x0000, 0xFFFF, 16), 0x7BEF); /* half of each channel */
    CHECK_EQ(fui_blend565(0xFFFF, 0x0000, 16), 0x7BEF); /* and downwards too */
    fui_canvas_init(&c, buf, FUI_FMT_RGB565_BE, 8, 2);
    fui_canvas_clear(&c, 0);
    fui_canvas_blend(&c, 1, 1, 0xFFFF, 128);
    CHECK_EQ(fui_canvas_get(&c, 1, 1), 0x7BEF);
    fui_canvas_init(&c, buf, FUI_FMT_MONO_PAGE, 8, 8);
    fui_canvas_clear(&c, 0);
    fui_canvas_blend(&c, 1, 1, 1, 127);
    CHECK_EQ(fui_canvas_get(&c, 1, 1), 0); /* one bit: a threshold at half */
    fui_canvas_blend(&c, 1, 1, 1, 128);
    CHECK_EQ(fui_canvas_get(&c, 1, 1), 1);
}

static void test_clip_and_dirty(void)
{
    fui_canvas_t c;
    fui_rect_t r, d;
    int x, y, n;

    TEST_SECTION("clip");
    memset(buf, 0, sizeof buf);
    fui_canvas_init(&c, buf, FUI_FMT_RGB565, 64, 64);
    CHECK(!fui_canvas_dirty(&c, &d));
    r = fui_rect_make(10, 20, 30, 25);
    fui_canvas_set_clip(&c, &r);
    fui_canvas_fill_rect(&c, -100, -100, 500, 500, 0xFFFF);
    for (n = 0, y = 0; y < 64; y++) {
        for (x = 0; x < 64; x++) {
            int inside = x >= 10 && x < 30 && y >= 20 && y < 25;

            CHECK_EQ(fui_canvas_get(&c, x, y), inside ? 0xFFFF : 0);
            n += inside;
        }
    }
    CHECK_EQ(n, 100);
    fui_canvas_pixel(&c, 9, 20, 0x1111);  /* just outside */
    fui_canvas_blend(&c, 30, 24, 0x1111, 255);
    CHECK_EQ(fui_canvas_get(&c, 9, 20), 0);
    CHECK_EQ(fui_canvas_get(&c, 30, 24), 0);

    TEST_SECTION("dirty box");
    CHECK(fui_canvas_dirty(&c, &d));
    CHECK(d.x0 == 10 && d.y0 == 20 && d.x1 == 30 && d.y1 == 25); /* the fill, clipped */
    fui_canvas_dirty_reset(&c);
    CHECK(!fui_canvas_dirty(&c, &d));
    fui_canvas_set_clip(&c, NULL);
    fui_canvas_pixel(&c, 3, 4, 1);
    fui_canvas_pixel(&c, 40, 50, 1);
    CHECK(fui_canvas_dirty(&c, &d));
    CHECK(d.x0 == 3 && d.y0 == 4 && d.x1 == 41 && d.y1 == 51); /* the union of both */
    fui_canvas_pixel(&c, 500, 500, 1); /* off the buffer: no effect */
    fui_canvas_dirty(&c, &d);
    CHECK(d.x1 == 41 && d.y1 == 51);
    /* an empty clip draws nothing and dirties nothing */
    fui_canvas_dirty_reset(&c);
    r = fui_rect_make(70, 70, 90, 90);
    fui_canvas_set_clip(&c, &r);
    fui_canvas_clear(&c, 0xFFFF);
    fui_draw_line(&c, 0, 0, FUI_FX(64), FUI_FX(64), FUI_FX_ONE, 0xFFFF);
    CHECK(!fui_canvas_dirty(&c, &d));
    CHECK_EQ(fui_canvas_get(&c, 50, 5), 0);
    CHECK_EQ(fui_canvas_get(&c, 32, 32), 0); /* the line would have crossed here */

    TEST_SECTION("rectangles");
    r = fui_rect_make(0, 0, 0, 0);
    d = fui_rect_make(5, 6, 7, 8);
    r = fui_rect_union(&r, &d);
    CHECK(r.x0 == 5 && r.y1 == 8); /* an empty one does not count */
    d = fui_rect_make(1, 7, 6, 20);
    r = fui_rect_intersect(&r, &d);
    CHECK(r.x0 == 5 && r.y0 == 7 && r.x1 == 6 && r.y1 == 8);
    d = fui_rect_make(10, 10, 12, 12);
    r = fui_rect_intersect(&r, &d);
    CHECK(fui_rect_is_empty(&r));
}

/* The dirty box holds every pixel a primitive changed. */
static void test_dirty_covers_changes(void)
{
    fui_canvas_t c;
    fui_rect_t d;
    int round, mono, x, y;

    TEST_SECTION("dirty box covers what a primitive changed");
    for (round = 0; round < 400; round++) {
        for (mono = 0; mono < 2; mono++) {
            fui_arc_t arc;
            fui_color_t ink = mono ? 1 : 0xFFFF;

            memset(buf, 0, sizeof buf);
            fui_canvas_init(&c, buf, mono ? FUI_FMT_MONO_PAGE : FUI_FMT_RGB565, 64, 64);
            arc.cx = (fui_fx_t)test_uniform(0, 64 * 256);
            arc.cy = (fui_fx_t)test_uniform(0, 64 * 256);
            arc.r = (fui_fx_t)test_uniform(256, 40 * 256);
            arc.start = (uint16_t)test_random();
            arc.sweep = (int32_t)test_uniform(-65536, 65536);
            switch (round % 4) {
            case 0:  fui_draw_arc(&c, &arc, FUI_FX(1.4), ink); break;
            case 1:  fui_draw_arc_dotted(&c, &arc, ink, NULL); break;
            case 2:  fui_fill_disc(&c, arc.cx, arc.cy, arc.r / 4, ink); break;
            default: fui_draw_line(&c, arc.cx, arc.cy, arc.cx + arc.sweep / 8, arc.cy + arc.r, FUI_FX(1.6), ink); break;
            }
            if (!fui_canvas_dirty(&c, &d)) {
                d = fui_rect_make(0, 0, 0, 0);
            }
            for (y = 0; y < 64; y++) {
                for (x = 0; x < 64; x++) {
                    if (fui_canvas_get(&c, x, y)) {
                        CHECK(x >= d.x0 && x < d.x1 && y >= d.y0 && y < d.y1);
                    }
                }
            }
            CHECK(d.x0 >= 0 && d.y0 >= 0 && d.x1 <= 64 && d.y1 <= 64);
        }
    }
}

/* A frame drawn band by band is the frame drawn at once. */
static void test_bands(void)
{
    static uint8_t band[64 * 16 * 2];
    fui_canvas_t whole, strip;
    int mono, y0, x, y, pass;

    TEST_SECTION("bands: set_origin keeps screen coordinates");
    for (mono = 0; mono < 2; mono++) {
        fui_format_t format = mono ? FUI_FMT_MONO_PAGE : FUI_FMT_RGB565_BE;
        fui_color_t ink = mono ? 1 : 0xFFFF;

        memset(ref, 0, sizeof ref);
        fui_canvas_init(&whole, ref, format, 64, 64);
        fui_canvas_init(&strip, band, format, 64, 16);
        for (y0 = 0; y0 <= 64; y0 += 16) {
            fui_canvas_t *c = y0 == 64 ? &whole : &strip;
            fui_arc_t arc;

            if (c == &strip) {
                memset(band, 0, sizeof band);
                fui_canvas_set_origin(&strip, 0, y0);
                CHECK(strip.clip.y0 == y0 && strip.clip.y1 == y0 + 16);
            }
            for (pass = 0; pass < 2; pass++) {
                arc.cx = FUI_FX(30.5);
                arc.cy = FUI_FX(33.25);
                arc.r = FUI_FX(pass ? 9.5 : 22);
                arc.start = 0x1234;
                arc.sweep = pass ? -50000 : 60000;
                fui_draw_arc(c, &arc, FUI_FX(1.4), ink);
            }
            fui_draw_line(c, FUI_FX(2), FUI_FX(3), FUI_FX(61), FUI_FX(60), FUI_FX_ONE, ink);
            fui_fill_disc(c, FUI_FX(40), FUI_FX(31), FUI_FX(5), ink);
            if (c == &strip) {
                /* compare this band with the same rows of the reference later:
                 * keep it by drawing the reference last and checking back */
                for (y = y0; y < y0 + 16; y++) {
                    for (x = 0; x < 64; x++) {
                        /* stash in buf as plain values */
                        buf[(y * 64 + x) * 2] = (uint8_t)(fui_canvas_get(&strip, x, y) & 0xFF);
                        buf[(y * 64 + x) * 2 + 1] = (uint8_t)(fui_canvas_get(&strip, x, y) >> 8);
                    }
                }
                CHECK_EQ(fui_canvas_get(&strip, 5, y0 - 1), 0); /* outside the band reads 0 */
            }
        }
        for (y = 0; y < 64; y++) {
            for (x = 0; x < 64; x++) {
                fui_color_t banded = (fui_color_t)(buf[(y * 64 + x) * 2] | (buf[(y * 64 + x) * 2 + 1] << 8));

                CHECK_EQ(banded, fui_canvas_get(&whole, x, y));
            }
        }
    }
}

int main(void)
{
    test_layouts();
    test_clip_and_dirty();
    test_dirty_covers_changes();
    test_bands();
    TEST_SUMMARY("canvas");
}
