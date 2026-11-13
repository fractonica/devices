/*
 * test_raster.c - the rasteriser against brute force.
 *
 *   integer helpers     fui_isqrt exact; fui_sin / fui_cos against libm
 *   one-bit arcs        a full circle on whole-pixel geometry equals the
 *                       classic midpoint circle, pixel for pixel; random arcs
 *                       (any centre, radius, start, signed sweep) are checked
 *                       against the true curve: every inked pixel lies on it,
 *                       every stretch of it is inked, the run is 8-connected
 *                       and one pixel thin; the dotted style inks every third
 *                       pixel; two parts cut at t tile the whole arc
 *   colour arcs         coverage against a 16 x 16 supersampled reference;
 *                       total ink = length x width; two parts = the whole
 *   lines, discs, strokes   total ink against geometry; crisp on pixel centres
 *   large radii         discs and rings up to 249 px, where the squares need
 *                       all 32 unsigned bits (one-bit: exactly the pixels whose
 *                       centre is inside; colour: ink against area / length)
 *   clipping            a clipped drawing equals the unclipped one inside the
 *                       clip and touches nothing outside (what partial redraw
 *                       and band rendering rely on)
 */
#include <math.h>
#include <string.h>

#include "fui_font.h"
#include "fui_glyph.h"
#include "fui_raster.h"
#include "sim_test.h"

#define W 100
#define H 100
#define TWO_PI 6.283185307179586

static uint16_t colour_a[W * H], colour_b[W * H];
static uint8_t mono_a[W * ((H + 7) / 8)], mono_b[W * ((H + 7) / 8)];

static void colour_canvas(fui_canvas_t *c, uint16_t *buf)
{
    memset(buf, 0, sizeof colour_a);
    fui_canvas_init(c, buf, FUI_FMT_RGB565, W, H);
}

static void mono_canvas(fui_canvas_t *c, uint8_t *buf)
{
    memset(buf, 0, sizeof mono_a);
    fui_canvas_init(c, buf, FUI_FMT_MONO_PAGE, W, H);
}

/* Coverage a white pixel shows, 0..1, from its 6-bit green. */
static double alpha_at(const fui_canvas_t *c, int x, int y)
{
    return ((fui_canvas_get(c, x, y) >> 5) & 63) / 63.0;
}

static double ink_total(const fui_canvas_t *c)
{
    double sum = 0;
    int x, y;

    for (y = 0; y < H; y++) {
        for (x = 0; x < W; x++) {
            sum += alpha_at(c, x, y);
        }
    }
    return sum;
}

static int lit_count(const fui_canvas_t *c)
{
    int n = 0, x, y;

    for (y = 0; y < H; y++) {
        for (x = 0; x < W; x++) {
            n += fui_canvas_get(c, x, y) != 0;
        }
    }
    return n;
}

/* --- the true arc, in doubles -------------------------------------------- */

typedef struct true_arc {
    double cx, cy, r, start, sweep; /* pixels, radians; sweep >= 0 after normalising */
} true_arc_t;

static true_arc_t true_arc(const fui_arc_t *a)
{
    true_arc_t t;

    t.cx = a->cx / 256.0;
    t.cy = a->cy / 256.0;
    t.r = a->r / 256.0;
    t.start = a->start * TWO_PI / 65536.0;
    t.sweep = a->sweep * TWO_PI / 65536.0;
    if (t.sweep < 0) {
        t.start += t.sweep;
        t.sweep = -t.sweep;
    }
    return t;
}

/* Is the direction from the centre to (x, y) inside the sweep (grown by `slack` radians)? */
static int in_sweep(const true_arc_t *t, double x, double y, double slack)
{
    double rel = fmod(atan2(y - t->cy, x - t->cx) - t->start, TWO_PI);

    if (rel < 0) {
        rel += TWO_PI;
    }
    return t->sweep >= TWO_PI - 1e-9 || rel <= t->sweep + slack || rel >= TWO_PI - slack;
}

/* Distance from a point to the arc. */
static double arc_distance(const true_arc_t *t, double x, double y)
{
    double rho = hypot(x - t->cx, y - t->cy), d0, d1;

    if (in_sweep(t, x, y, 0)) {
        return fabs(rho - t->r);
    }
    d0 = hypot(x - (t->cx + t->r * cos(t->start)), y - (t->cy + t->r * sin(t->start)));
    d1 = hypot(x - (t->cx + t->r * cos(t->start + t->sweep)), y - (t->cy + t->r * sin(t->start + t->sweep)));
    return d0 < d1 ? d0 : d1;
}

static fui_arc_t random_arc(double r_min, double r_max)
{
    fui_arc_t a;

    a.cx = (fui_fx_t)(test_uniform(46, 54) * 256);
    a.cy = (fui_fx_t)(test_uniform(46, 54) * 256);
    a.r = (fui_fx_t)(test_uniform(r_min, r_max) * 256);
    a.start = (uint16_t)test_random();
    a.sweep = (int32_t)test_uniform(-65536, 65536);
    if (test_random() % 8 == 0) {
        a.sweep = (test_random() & 1) ? FUI_TURN : -FUI_TURN;
    }
    return a;
}

/* ------------------------------------------------------------------------- */

static void test_integers(void)
{
    uint32_t v;
    double worst = 0;

    TEST_SECTION("isqrt");
    for (v = 0; v < 70000; v++) {
        uint32_t root = fui_isqrt(v);

        CHECK(root * root <= v && (root + 1) * (root + 1) > v);
    }
    CHECK_EQ(fui_isqrt(0xFFFFFFFFu), 65535);
    CHECK_EQ(fui_isqrt(64000u * 64000u), 64000);
    CHECK_EQ(fui_isqrt(64000u * 64000u - 1), 63999);

    TEST_SECTION("sin / cos");
    for (v = 0; v < 65536; v += 7) {
        double angle = v * TWO_PI / 65536.0;
        double es = fabs(fui_sin(v) / 16384.0 - sin(angle)), ec = fabs(fui_cos(v) / 16384.0 - cos(angle));

        if (es > worst) worst = es;
        if (ec > worst) worst = ec;
    }
    CHECK(worst < 1.5e-4);
    CHECK_EQ(fui_sin(0), 0);
    CHECK_EQ(fui_sin(0x4000), 16384);
    CHECK_EQ(fui_cos(0x8000), -16384);
    CHECK_EQ(fui_sin(0xC000), -16384);
}

/* The classic midpoint circle, as every textbook has it. */
static void midpoint_circle(fui_canvas_t *c, int cx, int cy, int r)
{
    int x = 0, y = r, d = 1 - r;

    while (x <= y) {
        fui_canvas_pixel(c, cx + x, cy + y, 1); fui_canvas_pixel(c, cx - x, cy + y, 1);
        fui_canvas_pixel(c, cx + x, cy - y, 1); fui_canvas_pixel(c, cx - x, cy - y, 1);
        fui_canvas_pixel(c, cx + y, cy + x, 1); fui_canvas_pixel(c, cx - y, cy + x, 1);
        fui_canvas_pixel(c, cx + y, cy - x, 1); fui_canvas_pixel(c, cx - y, cy - x, 1);
        if (d < 0) {
            d += 2 * x + 3;
        } else {
            d += 2 * (x - y) + 5;
            y--;
        }
        x++;
    }
}

static void test_mono_circle_is_midpoint(void)
{
    fui_canvas_t ours, theirs;
    int r;

    TEST_SECTION("one-bit: full circle == midpoint circle");
    for (r = 1; r <= 45; r++) {
        fui_arc_t arc;
        int start;

        for (start = 0; start < 3; start++) {
            mono_canvas(&ours, mono_a);
            mono_canvas(&theirs, mono_b);
            arc.cx = FUI_FX(50) + 128; /* the centre of pixel (50, 50) */
            arc.cy = FUI_FX(50) + 128;
            arc.r = FUI_FX(r);
            arc.start = (uint16_t)(start * 0x3777);
            arc.sweep = start == 2 ? -FUI_TURN : FUI_TURN;
            fui_draw_arc(&ours, &arc, FUI_FX_ONE, 1);
            midpoint_circle(&theirs, 50, 50, r);
            CHECK(memcmp(mono_a, mono_b, sizeof mono_a) == 0);
        }
    }
}

/* Are the lit pixels one 8-connected piece? */
static int connected(const fui_canvas_t *c, int total)
{
    static uint8_t seen[W * H];
    static int stack[W * H];
    int top = 0, reached = 0, x, y, dx, dy;

    memset(seen, 0, sizeof seen);
    for (y = 0; y < H && top == 0; y++) {
        for (x = 0; x < W; x++) {
            if (fui_canvas_get(c, x, y)) {
                stack[top++] = y * W + x;
                seen[y * W + x] = 1;
                break;
            }
        }
    }
    while (top > 0) {
        int at = stack[--top];

        reached++;
        for (dy = -1; dy <= 1; dy++) {
            for (dx = -1; dx <= 1; dx++) {
                int nx = at % W + dx, ny = at / W + dy;

                if (nx >= 0 && nx < W && ny >= 0 && ny < H && !seen[ny * W + nx] && fui_canvas_get(c, nx, ny)) {
                    seen[ny * W + nx] = 1;
                    stack[top++] = ny * W + nx;
                }
            }
        }
    }
    return reached == total;
}

static void test_mono_arcs(void)
{
    fui_canvas_t c, d;
    int round, x, y, i;

    TEST_SECTION("one-bit: random arcs against the true curve");
    for (round = 0; round < 1500; round++) {
        fui_arc_t arc = random_arc(1.5, 40);
        true_arc_t t = true_arc(&arc);
        double length = t.r * t.sweep, worst = 0;
        int lit, samples = (int)(length * 8) + 8, dotted, extra = 0, missing = 0, cut;
        uint8_t phase = 0;
        fui_arc_t part;

        mono_canvas(&c, mono_a);
        fui_draw_arc(&c, &arc, FUI_FX_ONE, 1);
        lit = lit_count(&c);

        /* soundness: an inked pixel is the nearest to the curve in its column
         * or row, so its centre is within half a pixel of the arc */
        for (y = 0; y < H; y++) {
            for (x = 0; x < W; x++) {
                if (fui_canvas_get(&c, x, y)) {
                    double dist = arc_distance(&t, x + 0.5, y + 0.5);

                    if (dist > worst) worst = dist;
                }
            }
        }
        CHECK(worst <= 0.5 + 0.04);

        /* completeness: walking the curve, an inked pixel is always at hand */
        for (i = 0; i <= samples; i++) {
            double angle = t.start + t.sweep * i / samples;
            double px = t.cx + t.r * cos(angle), py = t.cy + t.r * sin(angle);
            int found = 0, bx = (int)floor(px), by = (int)floor(py);

            for (y = by - 1; y <= by + 1 && !found; y++) {
                for (x = bx - 1; x <= bx + 1; x++) {
                    if (fui_canvas_get(&c, x, y) && fabs(x + 0.5 - px) <= 1.5 && fabs(y + 0.5 - py) <= 1.5) {
                        found = 1;
                        break;
                    }
                }
            }
            if (!found && length >= 1.5) {
                missing++;
            }
        }
        CHECK_EQ(missing, 0);

        /* one piece, one pixel thin: about one pixel per unit of the longer
         * axis travelled, which is between 0.70 and 1.0 of the arc length */
        if (length >= 3) {
            CHECK(connected(&c, lit));
            CHECK(lit <= length * 1.02 + 6);
            CHECK(lit >= length * 0.68 - 4);
        }

        /* dotted: 1 on, 2 off, on the same pixels */
        mono_canvas(&d, mono_b);
        fui_draw_arc_dotted(&d, &arc, 1, &phase);
        dotted = lit_count(&d);
        for (i = 0; i < (int)sizeof mono_a; i++) {
            CHECK_EQ(mono_b[i] & ~mono_a[i], 0);
        }
        CHECK(dotted >= lit / 3 - 4 && dotted <= lit / 3 + 4);
        CHECK(phase < 3);

        /* two parts cut at the same fraction tile the arc */
        cut = (int)test_uniform(0, 65536);
        mono_canvas(&d, mono_b);
        part = fui_arc_part(&arc, 0, cut);
        fui_draw_arc(&d, &part, FUI_FX_ONE, 1);
        part = fui_arc_part(&arc, cut, 65536);
        fui_draw_arc(&d, &part, FUI_FX_ONE, 1);
        for (y = 0; y < H; y++) {
            for (x = 0; x < W; x++) {
                int whole = fui_canvas_get(&c, x, y), parts = fui_canvas_get(&d, x, y);

                extra += parts && !whole;
                missing += whole && !parts;
            }
        }
        /* at the cut the two parts may each round to a different pixel */
        CHECK(missing <= 1 && extra <= 2);
    }
}

static void test_colour_arcs(void)
{
    static const double widths[4] = { 0.75, 1.0, 1.4, 2.0 };
    fui_canvas_t c, d;
    double mean_sum = 0;
    int round, x, y, sx, sy, mean_n = 0;

    TEST_SECTION("colour: arc coverage against supersampling");
    for (round = 0; round < 400; round++) {
        fui_arc_t arc = random_arc(1.0, 40), part;
        true_arc_t t = true_arc(&arc);
        double width = widths[round % 4], hw = width / 2, length = t.r * t.sweep, total, worst = 0;
        double ex0 = t.cx + t.r * cos(t.start), ey0 = t.cy + t.r * sin(t.start);
        double ex1 = t.cx + t.r * cos(t.start + t.sweep), ey1 = t.cy + t.r * sin(t.start + t.sweep);
        int cut, differ = 0;

        colour_canvas(&c, colour_a);
        fui_draw_arc(&c, &arc, (fui_fx_t)(width * 256), 0xFFFF);
        for (y = 0; y < H; y++) {
            for (x = 0; x < W; x++) {
                double got = alpha_at(&c, x, y), want = 0, err;
                int near_end = hypot(x + 0.5 - ex0, y + 0.5 - ey0) < 2.5 || hypot(x + 0.5 - ex1, y + 0.5 - ey1) < 2.5;

                if (fabs(hypot(x + 0.5 - t.cx, y + 0.5 - t.cy) - t.r) > hw + 1.5) {
                    CHECK(got == 0); /* nothing far from the stroke */
                    continue;
                }
                for (sy = 0; sy < 16; sy++) {
                    for (sx = 0; sx < 16; sx++) {
                        double px = x + (sx + 0.5) / 16, py = y + (sy + 0.5) / 16;

                        want += fabs(hypot(px - t.cx, py - t.cy) - t.r) <= hw && in_sweep(&t, px, py, 0);
                    }
                }
                want /= 256;
                err = fabs(got - want);
                /* The ends are cut square along the radius, not filtered: a
                 * pixel there may be half off. Elsewhere the box filter holds. */
                if (!near_end || t.sweep >= TWO_PI - 1e-9) {
                    if (err > worst) worst = err;
                    if (want > 0 || got > 0) {
                        mean_sum += err;
                        mean_n++;
                    }
                }
            }
        }
        CHECK(worst <= 0.30);

        /* total ink = length x width (a thin stroke's area), ends aside */
        total = ink_total(&c);
        if (t.r >= 3) {
            CHECK(fabs(total - length * width) <= 0.04 * length * width + 2.5);
        }

        /* the elapsed / to-come split: two parts ink what the whole inks */
        cut = (int)test_uniform(0, 65536);
        colour_canvas(&d, colour_b);
        part = fui_arc_part(&arc, 0, cut);
        fui_draw_arc(&d, &part, (fui_fx_t)(width * 256), 0xFFFF);
        part = fui_arc_part(&arc, cut, 65536);
        fui_draw_arc(&d, &part, (fui_fx_t)(width * 256), 0xFFFF);
        for (y = 0; y < H; y++) {
            for (x = 0; x < W; x++) {
                differ += fabs(alpha_at(&c, x, y) - alpha_at(&d, x, y)) > 0.02;
            }
        }
        CHECK(differ <= 4); /* only pixels whose centre is on the cut line itself */
    }
    CHECK(mean_n > 0 && mean_sum / mean_n <= 0.05);
}

static void test_lines(void)
{
    fui_canvas_t c;
    int round, x;

    TEST_SECTION("colour: a line on pixel centres is crisp");
    colour_canvas(&c, colour_a);
    fui_draw_line(&c, FUI_FX(10), FUI_FX(20.5), FUI_FX(30), FUI_FX(20.5), FUI_FX_ONE, 0xFFFF);
    for (x = 0; x < W; x++) {
        CHECK(alpha_at(&c, x, 20) == ((x >= 10 && x < 30) ? 1.0 : 0.0));
        CHECK(alpha_at(&c, x, 19) == 0 && alpha_at(&c, x, 21) == 0);
    }
    colour_canvas(&c, colour_a);
    fui_draw_line(&c, FUI_FX(40.5), FUI_FX(10), FUI_FX(40.5), FUI_FX(50), FUI_FX_ONE, 0xFFFF);
    CHECK(fabs(ink_total(&c) - 40) < 0.01);

    TEST_SECTION("colour: line ink = length x width");
    for (round = 0; round < 600; round++) {
        double x0 = test_uniform(15, 85), y0 = test_uniform(15, 85), x1 = test_uniform(15, 85), y1 = test_uniform(15, 85);
        double width = test_uniform(0.5, 2.5), length = hypot(x1 - x0, y1 - y0), total;

        colour_canvas(&c, colour_a);
        fui_draw_line(&c, (fui_fx_t)(x0 * 256), (fui_fx_t)(y0 * 256), (fui_fx_t)(x1 * 256), (fui_fx_t)(y1 * 256),
                      (fui_fx_t)(width * 256), 0xFFFF);
        total = ink_total(&c);
        if (length > 2) {
            CHECK(fabs(total - length * width) <= 0.05 * length * width + 1.5);
        }
    }

    TEST_SECTION("one-bit: lines");
    for (round = 0; round < 300; round++) {
        int x0 = (int)test_uniform(5, 95), y0 = (int)test_uniform(5, 95), x1 = (int)test_uniform(5, 95), y1 = (int)test_uniform(5, 95);
        int dx = abs(x1 - x0), dy = abs(y1 - y0);

        mono_canvas(&c, mono_a);
        fui_draw_line(&c, FUI_FX(x0) + 128, FUI_FX(y0) + 128, FUI_FX(x1) + 128, FUI_FX(y1) + 128, FUI_FX_ONE, 1);
        /* Bresenham: both ends inked, one pixel per step of the longer axis */
        CHECK(fui_canvas_get(&c, x0, y0) && fui_canvas_get(&c, x1, y1));
        CHECK_EQ(lit_count(&c), (dx > dy ? dx : dy) + 1);
        CHECK(connected(&c, lit_count(&c)));
    }
}

static void test_discs_and_strokes(void)
{
    fui_canvas_t c;
    int round;

    TEST_SECTION("colour: disc ink = pi r^2");
    for (round = 0; round < 300; round++) {
        double r = test_uniform(0.8, 30), cx = test_uniform(40, 60), cy = test_uniform(40, 60);

        colour_canvas(&c, colour_a);
        fui_fill_disc(&c, (fui_fx_t)(cx * 256), (fui_fx_t)(cy * 256), (fui_fx_t)(r * 256), 0xFFFF);
        CHECK(fabs(ink_total(&c) - 3.14159265 * r * r) <= 0.03 * 3.14159265 * r * r + 0.6);
    }

    TEST_SECTION("one-bit: a disc of radius 1 on a pixel centre is a plus");
    mono_canvas(&c, mono_a);
    fui_fill_disc(&c, FUI_FX(50.5), FUI_FX(50.5), FUI_FX_ONE, 1);
    CHECK_EQ(lit_count(&c), 5);
    CHECK(fui_canvas_get(&c, 50, 50) && fui_canvas_get(&c, 49, 50) && fui_canvas_get(&c, 51, 50) &&
          fui_canvas_get(&c, 50, 49) && fui_canvas_get(&c, 50, 51));

    TEST_SECTION("colour: a stroke of segments is inked once, round ends");
    for (round = 0; round < 200; round++) {
        /* an L of two segments with round caps and a round join */
        double x0 = test_uniform(30, 40), y0 = test_uniform(30, 40), len = test_uniform(6, 25), width = test_uniform(1, 2.5);
        fui_seg_t seg[2];
        /* two capsules sharing the corner's disc: 2 l w + 5 pi w^2 / 16 - w^2 / 4 */
        double want = 2 * len * width + 5 * 3.14159265 * width * width / 16 - width * width / 4;

        seg[0].x0 = (int16_t)(x0 * 64); seg[0].y0 = (int16_t)(y0 * 64);
        seg[0].x1 = (int16_t)((x0 + len) * 64); seg[0].y1 = seg[0].y0;
        seg[1].x0 = seg[0].x1; seg[1].y0 = seg[0].y1;
        seg[1].x1 = seg[1].x0; seg[1].y1 = (int16_t)((y0 + len) * 64);
        colour_canvas(&c, colour_a);
        fui_draw_segments(&c, seg, 2, (fui_fx_t)(width * 256), 0xFFFF);
        CHECK(fabs(ink_total(&c) - want) <= 0.05 * want + 1.0);
    }
}

/*
 * Radii up to the documented limit (249.x px). A Q8 offset past 181 px has a
 * square that no longer fits a SIGNED 32-bit int, and a disc's corner holds
 * the sum of two such squares: once the disc inked wrong pixels there.
 */
#define BIG 320
static uint16_t big_colour[BIG * BIG];
static uint8_t big_mono[BIG * BIG / 8];

static void test_large_radii(void)
{
    static const double RADII[] = { 150, 181.5, 182, 200, 230, 248.5, 249.4 };
    fui_canvas_t c;
    size_t i;
    int x, y;

    TEST_SECTION("large radii: discs and rings up to 249 px");
    for (i = 0; i < sizeof RADII / sizeof RADII[0]; i++) {
        fui_fx_t r = (fui_fx_t)(RADII[i] * 256);
        long long r2 = (long long)r * r;
        int wrong = 0;
        double ink = 0, want;

        /* one bit: exactly the pixels whose centre is inside, the far corner included */
        memset(big_mono, 0, sizeof big_mono);
        fui_canvas_init(&c, big_mono, FUI_FMT_MONO_ROW, BIG, BIG);
        fui_fill_disc(&c, 0, 0, r, 1);
        for (y = 0; y < BIG; y++) {
            for (x = 0; x < BIG; x++) {
                long long px = x * 256LL + 128, py = y * 256LL + 128;

                wrong += (fui_canvas_get(&c, x, y) != 0) != (px * px + py * py <= r2);
            }
        }
        CHECK_EQ(wrong, 0);

        /* colour: a quarter disc's ink is a quarter of pi r^2 */
        memset(big_colour, 0, sizeof big_colour);
        fui_canvas_init(&c, big_colour, FUI_FMT_RGB565, BIG, BIG);
        fui_fill_disc(&c, 0, 0, r, 0xFFFF);
        for (y = 0; y < BIG; y++) {
            for (x = 0; x < BIG; x++) {
                ink += ((fui_canvas_get(&c, x, y) >> 5) & 63) / 63.0;
            }
        }
        want = 3.14159265 * (r / 256.0) * (r / 256.0) / 4;
        CHECK(fabs(ink - want) <= 0.005 * want + 2);

        /* colour: a quarter ring's ink is its length x width (its outer
         * reach, r + 0.75 + 0.5 px, must stay under the limit too) */
        if (RADII[i] + 1.25 >= 250) {
            continue;
        }
        memset(big_colour, 0, sizeof big_colour);
        fui_draw_ring(&c, 0, 0, r, FUI_FX(1.5), 0xFFFF);
        for (ink = 0, y = 0; y < BIG; y++) {
            for (x = 0; x < BIG; x++) {
                ink += ((fui_canvas_get(&c, x, y) >> 5) & 63) / 63.0;
            }
        }
        want = 3.14159265 * 2 * (r / 256.0) / 4 * 1.5;
        CHECK(fabs(ink - want) <= 0.03 * want + 2);
    }
}

/* Draw one of each primitive (the same ones for a given seed). */
static void draw_scene(fui_canvas_t *c, unsigned long long seed)
{
    fui_text_style_t style;
    fui_seg_t seg[3];
    fui_color_t ink = fui_canvas_is_mono(c) ? 1 : 0xFFFF;
    fui_arc_t arc;
    uint8_t phase = 1;
    int i;

    test_seed = seed;
    for (i = 0; i < 6; i++) {
        arc = random_arc(2, 45);
        fui_draw_arc(c, &arc, FUI_FX(1.4), ink);
        arc = random_arc(2, 45);
        fui_draw_arc_dotted(c, &arc, ink, &phase);
        fui_draw_line(c, (fui_fx_t)test_uniform(-2000, 28000), (fui_fx_t)test_uniform(-2000, 28000),
                      (fui_fx_t)test_uniform(-2000, 28000), (fui_fx_t)test_uniform(-2000, 28000), FUI_FX(1.2), ink);
        fui_fill_disc(c, (fui_fx_t)test_uniform(0, 25600), (fui_fx_t)test_uniform(0, 25600), (fui_fx_t)test_uniform(200, 3000), ink);
    }
    seg[0].x0 = 1000; seg[0].y0 = 1000; seg[0].x1 = 3000; seg[0].y1 = 1500;
    seg[1].x0 = 3000; seg[1].y0 = 1500; seg[1].x1 = 3500; seg[1].y1 = 4000;
    seg[2].x0 = 3500; seg[2].y0 = 4000; seg[2].x1 = 5200; seg[2].y1 = 4100;
    fui_draw_segments(c, seg, 3, FUI_FX(1.5), ink);
    fui_glyph_draw_index(c, 5, 2, FUI_FX(60.5), FUI_FX(40.5), FUI_U_PX(5), ink);
    style.font = &fui_font_text;
    style.scale = 2;
    style.flags = 0;
    style.ink = style.ink_symbol = ink;
    fui_text_draw(c, &style, 4, 30, "34\xCE\xB7 29\xCE\xB9 Blinks", (size_t)-1);
    fui_canvas_fill_rect(c, 70, 60, 50, 50, ink);
}

static void test_clipping(void)
{
    fui_canvas_t whole, clipped;
    int round, mono, x, y;

    TEST_SECTION("clipping: inside equals the unclipped drawing, outside is untouched");
    for (round = 0; round < 60; round++) {
        fui_rect_t clip, dirty;
        int x0 = (int)test_uniform(-10, 90), y0 = (int)test_uniform(-10, 90);
        unsigned long long seed = 1000003ULL * (unsigned long long)(round + 1);

        clip = fui_rect_make(x0, y0, x0 + (int)test_uniform(1, 70), y0 + (int)test_uniform(1, 70));
        for (mono = 0; mono < 2; mono++) {
            if (mono) {
                mono_canvas(&whole, mono_a);
                mono_canvas(&clipped, mono_b);
            } else {
                colour_canvas(&whole, colour_a);
                colour_canvas(&clipped, colour_b);
            }
            draw_scene(&whole, seed);
            fui_canvas_set_clip(&clipped, &clip);
            draw_scene(&clipped, seed);
            for (y = 0; y < H; y++) {
                for (x = 0; x < W; x++) {
                    int inside = x >= clip.x0 && x < clip.x1 && y >= clip.y0 && y < clip.y1;

                    CHECK_EQ(fui_canvas_get(&clipped, x, y), inside ? fui_canvas_get(&whole, x, y) : 0);
                }
            }
            /* and the dirty box never leaves the clip */
            if (fui_canvas_dirty(&clipped, &dirty)) {
                CHECK(dirty.x0 >= clip.x0 && dirty.y0 >= clip.y0 && dirty.x1 <= clip.x1 && dirty.y1 <= clip.y1);
                CHECK(dirty.x0 >= 0 && dirty.y0 >= 0 && dirty.x1 <= W && dirty.y1 <= H);
            }
        }
    }
}

int main(void)
{
    test_integers();
    test_mono_circle_is_midpoint();
    test_mono_arcs();
    test_colour_arcs();
    test_lines();
    test_discs_and_strokes();
    test_large_radii();
    test_clipping();
    TEST_SUMMARY("raster");
}
