/*
 * fui_disc.c - filled circles: beads, planets, the point of now, glyph dots.
 *
 * Every pixel of the bounding box is classified by its squared distance to
 * the centre: clearly inside (filled), clearly outside (skipped), or on the
 * rim, where one square root gives the coverage. Discs here are a few pixels
 * across, so the box is small; a large disc still costs one root per rim
 * pixel only.
 */
#include "fui_raster_priv.h"

void fui_fill_disc(fui_canvas_t *c, fui_fx_t cx, fui_fx_t cy, fui_fx_t r, fui_color_t color)
{
    int mono = fui_canvas_is_mono(c);
    int32_t r_out = r + 128, r_in = r - 128;
    uint32_t out2, in2, r2;
    int x0, y0, x1, y1, x, y;

    if (r <= 0 || r_out >= FUI_I_MAX_REACH) {
        return;
    }
    x0 = fui_i_floor8(cx - r_out);
    y0 = fui_i_floor8(cy - r_out);
    x1 = fui_i_floor8(cx + r_out) + 1;
    y1 = fui_i_floor8(cy + r_out) + 1;
    if (x0 < c->clip.x0) x0 = c->clip.x0;
    if (y0 < c->clip.y0) y0 = c->clip.y0;
    if (x1 > c->clip.x1) x1 = c->clip.x1;
    if (y1 > c->clip.y1) y1 = c->clip.y1;
    if (x1 <= x0 || y1 <= y0) {
        return;
    }
    fui_canvas_touch(c, x0, y0, x1, y1);
    r2 = (uint32_t)r * (uint32_t)r;
    out2 = (uint32_t)r_out * (uint32_t)r_out;
    in2 = r_in > 0 ? (uint32_t)r_in * (uint32_t)r_in : 0;

    /* Squares of Q8 offsets up to 250 px fit 32 bits only UNSIGNED (a signed
     * product overflows past 181 px), and the corner of the box holds the
     * sum of two: d2 is 64-bit. Only the rim, where d2 < out2 < 2^32, takes
     * the root. */
    for (y = y0; y < y1; y++) {
        int32_t py = (int32_t)y * 256 + 128 - cy;
        uint32_t apy = (uint32_t)(py < 0 ? -py : py), py2 = apy * apy;

        for (x = x0; x < x1; x++) {
            int32_t px = (int32_t)x * 256 + 128 - cx;
            uint32_t apx = (uint32_t)(px < 0 ? -px : px);
            uint64_t d2 = (uint64_t)(apx * apx) + py2;

            if (mono) {
                if (d2 <= r2) {
                    fui_px_set(c, x, y, color);
                }
            } else if (d2 <= in2 && r_in > 0) {
                fui_px_blend(c, x, y, color, 255);
            } else if (d2 < out2) {
                int32_t edge = r_out - (int32_t)fui_isqrt((uint32_t)d2); /* 0..256 across the rim */

                fui_px_blend(c, x, y, color, edge > 255 ? 255u : (unsigned)edge);
            }
        }
    }
}
