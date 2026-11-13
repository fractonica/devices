/*
 * fui_arc.c - circular arcs by start + signed sweep: the shape every ring of
 * the instrument is made of.
 *
 * COLOUR (arc_aa): scan the rows of the arc's bounding box. In each row the
 * ink lies in one or two spans, found with two square roots (the chords of
 * the outer and the inner edge of the stroke). Every pixel of a span is
 * visited once: its distance to the circle gives its coverage, and two
 * half-plane tests against the start and end radius decide whether it is
 * inside the sweep. Because a pixel belongs to exactly one side of a cut,
 * two arcs that meet on a common radius (the two halves of a split slot, or
 * consecutive children of a carrier, which are tangent there) join without a
 * double-blended seam or a notch.
 *
 * ONE-BIT (arc_mono): walk the sweep in pieces that stay inside one of the
 * four 90-degree wedges around the centre (right, bottom, left, top). Inside
 * a wedge the curve is a function of its major axis (x in the top and bottom
 * wedges, y in the side ones): one pixel per major step, the nearest to the
 * true curve, which is Bresenham's rule for a circle whose centre and radius
 * need not be whole pixels. Pieces are walked in the direction of travel so
 * the dotted style can count pixels along the arc.
 */
#include "fui_raster_priv.h"

/* A pixel within this of a cut line (Q14 * Q8 units; 1/64 px) counts as
 * inside on both sides. Rounding may otherwise leave a pixel to neither of
 * two arcs that meet there, and a notch shows where a faint overlap cannot. */
#define CUT_SLACK 65536

/* Bounding box of the centre line: the extreme cos / sin over the sweep (Q14). */
static void sweep_extent(uint32_t a0, int32_t sweep, int32_t *cmin, int32_t *cmax, int32_t *smin, int32_t *smax)
{
    uint32_t a1 = a0 + (uint32_t)sweep, k;
    int32_t c0 = fui_cos(a0), c1 = fui_cos(a1), s0 = fui_sin(a0), s1 = fui_sin(a1);

    *cmin = c0 < c1 ? c0 : c1;
    *cmax = c0 > c1 ? c0 : c1;
    *smin = s0 < s1 ? s0 : s1;
    *smax = s0 > s1 ? s0 : s1;
    for (k = 0; k < 4; k++) {
        /* does the sweep pass the axis direction k * 90 degrees? */
        if (((k * 0x4000u - a0) & 0xFFFFu) <= (uint32_t)sweep) {
            switch (k) {
            case 0:  *cmax = 16384;  break;
            case 1:  *smax = 16384;  break;
            case 2:  *cmin = -16384; break;
            default: *smin = -16384; break;
            }
        }
    }
}

static void arc_aa(fui_canvas_t *c, const fui_arc_t *arc, fui_fx_t width, fui_color_t color)
{
    int32_t r = arc->r, hw = width / 2, sweep = arc->sweep;
    uint32_t a0 = arc->start;
    int32_t r_out, r_in, pad, cmin, cmax, smin, smax, sx, sy, ex, ey, inv = 0;
    uint32_t r2, out2, in2;
    int full, wide, exact, x0, y0, x1, y1, x, y;

    if (sweep < 0) {
        a0 = (a0 + (uint32_t)sweep) & 0xFFFFu;
        sweep = -sweep;
    }
    r_out = r + hw + 128; /* beyond this a pixel gets no ink */
    r_in = r - hw - 128;
    if (sweep == 0 || r <= 0 || r_out >= FUI_I_MAX_REACH) {
        return;
    }
    full = sweep >= FUI_TURN;
    wide = sweep > FUI_TURN / 2;
    if (full) {
        cmin = smin = -16384;
        cmax = smax = 16384;
    } else {
        sweep_extent(a0, sweep, &cmin, &cmax, &smin, &smax);
    }
    pad = hw + 256;
    x0 = fui_i_floor8(arc->cx + (fui_fx_t)(((int64_t)r * cmin) >> 14) - pad);
    x1 = fui_i_floor8(arc->cx + (fui_fx_t)(((int64_t)r * cmax) >> 14) + pad) + 1;
    y0 = fui_i_floor8(arc->cy + (fui_fx_t)(((int64_t)r * smin) >> 14) - pad);
    y1 = fui_i_floor8(arc->cy + (fui_fx_t)(((int64_t)r * smax) >> 14) + pad) + 1;
    if (x0 < c->clip.x0) x0 = c->clip.x0;
    if (y0 < c->clip.y0) y0 = c->clip.y0;
    if (x1 > c->clip.x1) x1 = c->clip.x1;
    if (y1 > c->clip.y1) y1 = c->clip.y1;
    if (x1 <= x0 || y1 <= y0) {
        return;
    }
    fui_canvas_touch(c, x0, y0, x1, y1);

    sx = fui_cos(a0);
    sy = fui_sin(a0);
    ex = fui_cos(a0 + (uint32_t)sweep);
    ey = fui_sin(a0 + (uint32_t)sweep);
    r2 = (uint32_t)r * (uint32_t)r;
    out2 = (uint32_t)r_out * (uint32_t)r_out;
    in2 = r_in > 0 ? (uint32_t)r_in * (uint32_t)r_in : 0;
    /* Distance to the circle: an exact root for small arcs, where there are
     * few pixels; elsewhere the root's series around r (see below). */
    exact = r < 6 * FUI_FX_ONE;
    if (!exact) {
        inv = (1 << 24) / (2 * r);
    }

    for (y = y0; y < y1; y++) {
        int32_t py = (int32_t)y * 256 + 128 - arc->cy, apy = py < 0 ? -py : py;
        int32_t xo, xi;
        uint32_t py2;
        int side;

        if (apy >= r_out) {
            continue;
        }
        py2 = (uint32_t)apy * (uint32_t)apy;
        xo = (int32_t)fui_isqrt(out2 - py2);
        xi = (r_in > 0 && apy < r_in) ? (int32_t)fui_isqrt(in2 - py2) : 0;
        /* xi == 0: the row crosses the stroke once, one span [-xo, xo];
         * otherwise the hollow middle splits it into a left and a right span. */
        for (side = 0; side < (xi > 0 ? 2 : 1); side++) {
            int32_t lo = xi > 0 ? (side ? xi : -xo) : -xo;
            int32_t hi = xi > 0 ? (side ? xo : -xi) : xo;
            int xa = fui_i_floor8(arc->cx + lo - 128 + 255), xb = fui_i_floor8(arc->cx + hi - 128);

            if (xa < x0) xa = x0;
            if (xb >= x1) xb = x1 - 1;
            for (x = xa; x <= xb; x++) {
                int32_t px = (int32_t)x * 256 + 128 - arc->cx, d;
                uint32_t apx = (uint32_t)(px < 0 ? -px : px);
                /* unsigned: a signed square overflows past 181 px; the sum
                 * stays under out2 + a pixel's worth, inside 32 bits */
                uint32_t d2 = apx * apx + py2;
                unsigned cover;

                if (exact) {
                    d = (int32_t)fui_isqrt(d2) - r;
                } else {
                    /* sqrt(r^2 + e) - r = e/2r - (e/2r)^2 / 2r + ...; the
                     * next term is under 0.02 px for r >= 6, |d| <= 1.5. */
                    int32_t e = (int32_t)(d2 - r2);
                    int32_t d1 = (int32_t)(((int64_t)e * inv) >> 24);

                    d = d1 - (int32_t)(((int64_t)d1 * d1 * inv) >> 24);
                }
                cover = fui_i_cover(d < 0 ? -d : d, hw);
                if (!cover) {
                    continue;
                }
                if (!full) {
                    int after_start = sx * py - sy * px >= -CUT_SLACK;
                    int before_end = px * ey - py * ex >= -CUT_SLACK;

                    /* Up to half a turn the sweep is where both hold; a
                     * longer one is where either holds. */
                    if (wide ? !(after_start || before_end) : !(after_start && before_end)) {
                        continue;
                    }
                }
                fui_px_blend(c, x, y, color, cover);
            }
        }
    }
}

/* ------------------------------------------------------------------------- */
/* One-bit                                                                    */
/* ------------------------------------------------------------------------- */

typedef struct mono_pen {
    fui_canvas_t *c;
    fui_color_t   color;
    int           dotted;
    unsigned      count;        /* pixels inked or skipped so far            */
    int           x[2], y[2];   /* the last two pixels                       */
    int           have;         /* how many of them are set                  */
} mono_pen_t;

static void pen_plot(mono_pen_t *pen, int x, int y)
{
    const fui_canvas_t *c = pen->c;

    /* Where two pieces meet they overlap by a pixel or two (see mono_piece):
     * count each pixel once, or the dots would bunch at the diagonals. */
    if ((pen->have > 0 && pen->x[0] == x && pen->y[0] == y) || (pen->have > 1 && pen->x[1] == x && pen->y[1] == y)) {
        return;
    }
    pen->x[1] = pen->x[0];
    pen->y[1] = pen->y[0];
    pen->x[0] = x;
    pen->y[0] = y;
    if (pen->have < 2) {
        pen->have++;
    }
    if ((!pen->dotted || pen->count % 3u == 0) &&
        x >= c->clip.x0 && x < c->clip.x1 && y >= c->clip.y0 && y < c->clip.y1) {
        fui_px_set(pen->c, x, y, pen->color);
    }
    pen->count++;
}

/* The piece's major coordinate (x in the top and bottom wedges) at an angle. */
static int32_t major_at(const fui_arc_t *arc, int x_major, uint32_t angle)
{
    return (x_major ? arc->cx : arc->cy) +
           (int32_t)(((int64_t)arc->r * (x_major ? fui_cos(angle) : fui_sin(angle)) + 8192) >> 14);
}

/*
 * One piece of the sweep inside wedge `wedge` (0 right, 1 bottom, 2 left,
 * 3 top), from angle a to angle b, travelling `dir` (+1 clockwise).
 * `before` / `after`: how much of the arc's sweep lies before a / after b
 * (0: the piece starts / ends the arc itself rather than at a wedge border).
 * `from` / `to`: the angles where the whole arc starts and ends.
 */
static void mono_piece(mono_pen_t *pen, const fui_arc_t *arc, uint32_t wedge, uint32_t a, uint32_t b,
                       int dir, int32_t before, int32_t after, uint32_t from, uint32_t to)
{
    int x_major = (wedge & 1u) != 0;
    int32_t r = arc->r;
    uint32_t r2 = (uint32_t)r * (uint32_t)r;
    int32_t major_c = x_major ? arc->cx : arc->cy, minor_c = x_major ? arc->cy : arc->cx;
    int32_t ma = major_at(arc, x_major, a), mb = major_at(arc, x_major, b);
    int minor_sign = (wedge == 0 || wedge == 1) ? 1 : -1;
    /* Clockwise with y down: down the right side, leftwards along the bottom,
     * up the left side, rightwards along the top. */
    int inc = ((wedge == 0 || wedge == 3) ? 1 : -1) * dir;
    /* Past a wedge border the curve keeps going the same way along this axis
     * for another 45 degrees: 0.29 r. Never reach further than that. */
    int32_t reach = (r * 75) >> 8, grow_lo = 0, grow_hi = 2, lo, hi, d;
    int m, m_end;

    if (reach > 128) {
        reach = 128;
    }
    /*
     * In travel order the piece owns the pixel columns (rows) whose centre
     * lies in [lo, hi). At a wedge border the range reaches half a pixel
     * further: the neighbouring piece changes major axis there, and without
     * the overlap a diagonal step could skip a pixel. It never reaches past
     * the arc's own end, though. At that end two units of slack close the
     * join with an arc that continues this one.
     */
    if (before > 0) {
        grow_lo = reach;
        if (before < 0x2000 && (d = inc * (ma - major_at(arc, x_major, from))) < grow_lo) {
            grow_lo = d > 0 ? d : 0;
        }
    }
    if (after > 0) {
        grow_hi = reach;
        if (after < 0x2000 && (d = inc * (major_at(arc, x_major, to) - mb) + 2) < grow_hi) {
            grow_hi = d > 0 ? d : 0;
        }
    }
    lo = inc * ma - grow_lo;
    hi = inc * mb + grow_hi;
    if (inc > 0) {
        m = fui_i_floor8(lo - 128 + 255);     /* first centre >= lo */
        m_end = fui_i_floor8(hi - 128 + 255); /* first centre >= hi: one past */
    } else {
        m = fui_i_floor8(-lo - 128);          /* last centre <= -lo */
        m_end = fui_i_floor8(-hi - 128);      /* last centre <= -hi: one past */
    }
    for (; m != m_end; m += inc) {
        int32_t dm = (int32_t)m * 256 + 128 - major_c, minor;
        uint32_t dm2 = (uint32_t)(dm * dm);
        int n;

        if ((inc > 0 && m > m_end) || (inc < 0 && m < m_end)) {
            break; /* an empty range */
        }
        minor = minor_c + minor_sign * (int32_t)(dm2 < r2 ? fui_isqrt(r2 - dm2) : 0);
        n = fui_i_floor8(minor);
        if (x_major) {
            pen_plot(pen, m, n);
        } else {
            pen_plot(pen, n, m);
        }
    }
}

static void arc_mono(fui_canvas_t *c, const fui_arc_t *arc, fui_color_t color, int dotted, uint8_t *phase)
{
    mono_pen_t pen;
    uint32_t a = arc->start;
    int32_t left = arc->sweep, reach = arc->r + 2 * FUI_FX_ONE, total, done = 0;
    int dir = 1;
    uint32_t to;

    if (left < 0) {
        left = -left;
        dir = -1;
    }
    if (left > FUI_TURN) {
        left = FUI_TURN;
    }
    if (left == 0 || arc->r <= 0 || arc->r >= FUI_I_MAX_REACH) {
        return;
    }
    pen.c = c;
    pen.color = color;
    pen.dotted = dotted;
    pen.count = phase ? *phase : 0u;
    pen.have = 0;
    total = left;
    to = (a + (uint32_t)(dir * total)) & 0xFFFFu;
    /* The circle's box is a fair bound for the dirty box of a small arc. */
    fui_canvas_touch(c, fui_i_floor8(arc->cx - reach), fui_i_floor8(arc->cy - reach),
                     fui_i_floor8(arc->cx + reach) + 1, fui_i_floor8(arc->cy + reach) + 1);

    while (left > 0) {
        /* Wedge borders are the diagonals: 45 degrees + k * 90. */
        uint32_t offset = (a + 0x2000u) & 0x3FFFu, wedge, b;
        int32_t step;

        if (dir > 0) {
            step = 0x4000 - (int32_t)offset;
            wedge = ((a + 0x2000u) >> 14) & 3u;
        } else {
            step = offset ? (int32_t)offset : 0x4000;
            wedge = ((a + 0x2000u - 1u) >> 14) & 3u;
        }
        if (step > left) {
            step = left;
        }
        b = (a + (uint32_t)(dir * step)) & 0xFFFFu;
        mono_piece(&pen, arc, wedge, a, b, dir, done, left - step, arc->start, to);
        a = b;
        left -= step;
        done += step;
    }
    if (phase) {
        *phase = (uint8_t)(pen.count % 3u);
    }
}

/* ------------------------------------------------------------------------- */

void fui_draw_arc(fui_canvas_t *c, const fui_arc_t *arc, fui_fx_t width, fui_color_t color)
{
    if (fui_canvas_is_mono(c)) {
        arc_mono(c, arc, color, 0, NULL);
    } else {
        arc_aa(c, arc, width, color);
    }
}

void fui_draw_arc_dotted(fui_canvas_t *c, const fui_arc_t *arc, fui_color_t color, uint8_t *phase)
{
    if (fui_canvas_is_mono(c)) {
        arc_mono(c, arc, color, 1, phase);
    } else {
        arc_aa(c, arc, FUI_FX_ONE, color);
    }
}

void fui_draw_ring(fui_canvas_t *c, fui_fx_t cx, fui_fx_t cy, fui_fx_t r, fui_fx_t width, fui_color_t color)
{
    fui_arc_t ring;

    ring.cx = cx;
    ring.cy = cy;
    ring.r = r;
    ring.start = 0xC000u; /* 12 o'clock */
    ring.sweep = FUI_TURN;
    fui_draw_arc(c, &ring, width, color);
}
