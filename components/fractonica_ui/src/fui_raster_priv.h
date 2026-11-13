/*
 * fui_raster_priv.h - PRIVATE. What the rasteriser files share.
 */
#ifndef FUI_RASTER_PRIV_H
#define FUI_RASTER_PRIV_H

#include "fui_raster.h"
#include "fui_px.h"

/* Squares of Q8 distances must fit 32 bits unsigned: 250 px * 256 = 64000 < 65536
 * (signed, they would overflow from 181 px: square magnitudes as uint32_t). */
#define FUI_I_MAX_REACH (250 * FUI_FX_ONE)

/** floor(v / 256) for negative values too (>> on a negative int is an
 *  arithmetic shift on every compiler this builds with: gcc, clang). */
static inline int fui_i_floor8(int32_t v)
{
    return (int)(v >> 8);
}

/**
 * Coverage 0..255 of a pixel whose centre is `d` (Q8, >= 0) from the middle
 * of a stroke of half-width `hw` (Q8): the overlap of the pixel's unit
 * interval [d - 0.5, d + 0.5] with the ink [-hw, hw]. A box filter across
 * the stroke: exact for an edge parallel to the pixel grid, within a few per
 * cent for a slanted one. A hairline thinner than a pixel tops out at its
 * own width, as it should.
 */
static inline unsigned fui_i_cover(int32_t d, int32_t hw)
{
    int32_t hi = d + 128 < hw ? d + 128 : hw;
    int32_t lo = d - 128 > -hw ? d - 128 : -hw;
    int32_t overlap = hi - lo;

    if (overlap <= 0) {
        return 0;
    }
    return overlap > 255 ? 255u : (unsigned)overlap;
}

/** A one-pixel Bresenham line between two pixels, both ends inked, clipped. */
void fui_i_line_px(fui_canvas_t *c, int x0, int y0, int x1, int y1, fui_color_t color);

#endif /* FUI_RASTER_PRIV_H */
