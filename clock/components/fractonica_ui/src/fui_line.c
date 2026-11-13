/*
 * fui_line.c - straight lines.
 *
 * Colour: step along the major axis one pixel column (or row) at a time; in
 * each column the line's centre is known exactly, and the few pixels around
 * it get the box-filter coverage of fui_i_cover across the stroke. The first
 * and last columns are weighted by how much of them the line spans, so a
 * tick that ends mid-pixel fades instead of jumping.
 *
 * One-bit: Bresenham between the pixels that hold the two ends.
 */
#include "fui_raster_priv.h"

void fui_i_line_px(fui_canvas_t *c, int x0, int y0, int x1, int y1, fui_color_t color)
{
    int dx = x1 > x0 ? x1 - x0 : x0 - x1, sx = x0 < x1 ? 1 : -1;
    int dy = y1 > y0 ? y0 - y1 : y1 - y0, sy = y0 < y1 ? 1 : -1; /* dy <= 0 */
    int err = dx + dy;

    fui_canvas_touch(c, (x0 < x1 ? x0 : x1), (y0 < y1 ? y0 : y1), (x0 > x1 ? x0 : x1) + 1, (y0 > y1 ? y0 : y1) + 1);
    for (;;) {
        int twice = 2 * err;

        if (x0 >= c->clip.x0 && x0 < c->clip.x1 && y0 >= c->clip.y0 && y0 < c->clip.y1) {
            fui_px_set(c, x0, y0, color);
        }
        if (x0 == x1 && y0 == y1) {
            break;
        }
        if (twice >= dy) {
            err += dy;
            x0 += sx;
        }
        if (twice <= dx) {
            err += dx;
            y0 += sy;
        }
    }
}

static void line_mono(fui_canvas_t *c, fui_fx_t x0, fui_fx_t y0, fui_fx_t x1, fui_fx_t y1,
                      fui_fx_t width, fui_color_t color)
{
    int n = (int)((width + 128) >> 8), i;
    int ax = fui_i_floor8(x0), ay = fui_i_floor8(y0), bx = fui_i_floor8(x1), by = fui_i_floor8(y1);
    int steep = (by > ay ? by - ay : ay - by) > (bx > ax ? bx - ax : ax - bx);

    if (n < 1) {
        n = 1;
    }
    /* Wider than a pixel: parallel lines stacked across the minor axis. */
    for (i = 0; i < n; i++) {
        int off = i - (n - 1) / 2;

        if (steep) {
            fui_i_line_px(c, ax + off, ay, bx + off, by, color);
        } else {
            fui_i_line_px(c, ax, ay + off, bx, by + off, color);
        }
    }
}

static void line_aa(fui_canvas_t *c, fui_fx_t x0, fui_fx_t y0, fui_fx_t x1, fui_fx_t y1,
                    fui_fx_t width, fui_color_t color)
{
    int32_t adx = x1 > x0 ? x1 - x0 : x0 - x1, ady = y1 > y0 ? y1 - y0 : y0 - y1;
    int steep = ady > adx;
    int32_t hw = width / 2, dx, dy, len4, cosine, reach, t;
    int64_t slope;
    int u, u_first, u_last, cu0, cu1, cv0, cv1;

    if (adx < 64 && ady < 64) {
        /* Shorter than a quarter pixel: it is a dot of the stroke's width. */
        fui_fill_disc(c, (x0 + x1) / 2, (y0 + y1) / 2, hw, color);
        return;
    }
    /* Work in (u, v) = (major, minor): swap x and y for a steep line. */
    if (steep) {
        t = x0; x0 = y0; y0 = t;
        t = x1; x1 = y1; y1 = t;
        cu0 = c->clip.y0; cu1 = c->clip.y1; cv0 = c->clip.x0; cv1 = c->clip.x1;
    } else {
        cu0 = c->clip.x0; cu1 = c->clip.x1; cv0 = c->clip.y0; cv1 = c->clip.y1;
    }
    if (x0 > x1) {
        t = x0; x0 = x1; x1 = t;
        t = y0; y0 = y1; y1 = t;
    }
    dx = x1 - x0; /* > 0 */
    dy = y1 - y0;
    /* Length in Q4 so the squares fit 32 bits for a line across the screen. */
    len4 = (int32_t)fui_isqrt((uint32_t)((dx >> 4) * (dx >> 4) + (dy >> 4) * (dy >> 4)));
    cosine = len4 > 0 ? ((dx >> 4) << 8) / len4 : 256; /* Q8, 181..256 */
    reach = ((hw + 128) * 363) >> 8;                   /* (hw + 0.5) * sqrt(2), the tallest column */
    slope = (int64_t)dy * 65536 / dx; /* Q16; a multiply: dy may be negative, and << of a negative is UB */

    u_first = fui_i_floor8(x0);
    u_last = fui_i_floor8(x1 - 1);
    if (steep) {
        fui_canvas_touch(c, fui_i_floor8((y0 < y1 ? y0 : y1) - reach), u_first,
                         fui_i_floor8((y0 > y1 ? y0 : y1) + reach) + 1, u_last + 1);
    } else {
        fui_canvas_touch(c, u_first, fui_i_floor8((y0 < y1 ? y0 : y1) - reach),
                         u_last + 1, fui_i_floor8((y0 > y1 ? y0 : y1) + reach) + 1);
    }
    if (u_first < cu0) u_first = cu0;
    if (u_last >= cu1) u_last = cu1 - 1;

    for (u = u_first; u <= u_last; u++) {
        int32_t left = (int32_t)u * 256, right = left + 256, span, mid, centre;
        int v, v_first, v_last;

        if (left < x0) left = x0;
        if (right > x1) right = x1;
        span = right - left; /* how much of this column the line crosses, 0..256 */
        if (span <= 0) {
            continue;
        }
        mid = (left + right) / 2;
        centre = y0 + (int32_t)(((int64_t)(mid - x0) * slope) >> 16);
        v_first = fui_i_floor8(centre - reach);
        v_last = fui_i_floor8(centre + reach);
        if (v_first < cv0) v_first = cv0;
        if (v_last >= cv1) v_last = cv1 - 1;
        for (v = v_first; v <= v_last; v++) {
            int32_t across = (int32_t)v * 256 + 128 - centre;
            unsigned cover;

            if (across < 0) {
                across = -across;
            }
            /* distance to the line = vertical offset * cos(slope angle) */
            cover = (fui_i_cover((across * cosine) >> 8, hw) * (unsigned)span) >> 8;
            if (cover) {
                if (steep) {
                    fui_px_blend(c, v, u, color, cover);
                } else {
                    fui_px_blend(c, u, v, color, cover);
                }
            }
        }
    }
}

void fui_draw_line(fui_canvas_t *c, fui_fx_t x0, fui_fx_t y0, fui_fx_t x1, fui_fx_t y1,
                   fui_fx_t width, fui_color_t color)
{
    if (fui_canvas_is_mono(c)) {
        line_mono(c, x0, y0, x1, y1, width, color);
    } else {
        line_aa(c, x0, y0, x1, y1, width, color);
    }
}
