/*
 * fui_raster.h - the rasteriser: lines, circular arcs, discs, rings, strokes.
 *
 * ONE API, TWO OUTPUTS
 *   colour canvas   coverage anti-aliasing. Each pixel gets the share of it
 *                   the ink covers (a box filter across the stroke), blended
 *                   over what is already there; on a face that is the plate.
 *   one-bit canvas  pixel-exact, Bresenham-class: one pixel per step along
 *                   the major axis, 8-connected, no smoothing, no dithering.
 *                   `width` is rounded to whole pixels (at least 1).
 *
 * NUMBERS
 *   fui_fx_t   pixels in Q8 fixed point (256 = one pixel). Pixel (x, y) has
 *              its centre at (x + 0.5, y + 0.5), so FUI_FX(31.5) is the centre
 *              of pixel 31: a one-pixel line through it is crisp.
 *   angles     65536 = one turn (FUI_TURN). 0 = 3 o'clock, positive =
 *              clockwise on screen (y down), the convention of frc_arc_t.
 *   An arc is centre + radius + start + SIGNED sweep, the shape frc_arc_t
 *   has; fui_arc_from_frc (fui_glyph.h) converts one. That conversion is the
 *   only place floats appear: every loop here is integer.
 *
 * LIMITS
 *   Radii and half-extents stay below 250 px: the square of a Q8 distance
 *   then fits 32 bits UNSIGNED (it would not signed past 181 px, and the
 *   disc adds two squares in 64 bits). Larger arcs and discs are not drawn.
 *   Screens here are 320 px at most. tests/test_raster.c draws discs and
 *   rings up to 249 px, and tests/test_fuzz.c runs every primitive on random
 *   input under the address and undefined-behaviour sanitizers.
 */
#ifndef FUI_RASTER_H
#define FUI_RASTER_H

#include "fui_canvas.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef int32_t fui_fx_t;
#define FUI_FX_ONE 256
/** A constant (or int) number of pixels as Q8. */
#define FUI_FX(v) ((fui_fx_t)((v) * 256))
#define FUI_TURN 65536

/** A circular arc. `sweep` is signed and |sweep| <= FUI_TURN (a full circle). */
typedef struct fui_arc {
    fui_fx_t cx, cy;
    fui_fx_t r;
    uint16_t start;
    int32_t  sweep;
} fui_arc_t;

/* --- integer helpers ---------------------------------------------------- */

/** sin / cos of an angle (65536 per turn) in Q14: 16384 = 1. |error| < 1e-4. */
int32_t fui_sin(uint32_t angle);
int32_t fui_cos(uint32_t angle);
/** floor(sqrt(v)). */
uint32_t fui_isqrt(uint32_t v);

/** The point at fraction t (0..65536 = whole sweep) along an arc. */
void fui_arc_point(const fui_arc_t *arc, int32_t t, fui_fx_t *x, fui_fx_t *y);
/**
 * The part of an arc between fractions t0 and t1 (0..65536). Parts cut at
 * the same t share that end exactly, so [0, t] and [t, 65536] tile the arc
 * with no gap and no overlap: the elapsed / to-come split of a ring.
 */
fui_arc_t fui_arc_part(const fui_arc_t *arc, int32_t t0, int32_t t1);

/* --- primitives ---------------------------------------------------------- */

/** A straight line from (x0, y0) to (x1, y1), `width` pixels wide (Q8). */
void fui_draw_line(fui_canvas_t *c, fui_fx_t x0, fui_fx_t y0, fui_fx_t x1, fui_fx_t y1,
                   fui_fx_t width, fui_color_t color);

/** An arc stroked `width` pixels wide (Q8). Butt ends, cut along the radius,
 *  so arcs that share an end point and a tangent join without a seam. */
void fui_draw_arc(fui_canvas_t *c, const fui_arc_t *arc, fui_fx_t width, fui_color_t color);

/**
 * The "to come" style of the one-bit face (DESIGN.md S11): 1 pixel on, 2 off,
 * counted along the arc in the direction of travel. `*phase` carries the count
 * from one arc to the next so a run of arcs is dotted evenly; pass NULL to
 * start at "on". On a colour canvas it draws a solid one-pixel arc: nothing is
 * dashed there.
 */
void fui_draw_arc_dotted(fui_canvas_t *c, const fui_arc_t *arc, fui_color_t color, uint8_t *phase);

/** A filled circle of radius r (Q8). One-bit: the pixels whose centre is inside. */
void fui_fill_disc(fui_canvas_t *c, fui_fx_t cx, fui_fx_t cy, fui_fx_t r, fui_color_t color);

/** A circle outline: an arc of one full turn starting at 12 o'clock. */
void fui_draw_ring(fui_canvas_t *c, fui_fx_t cx, fui_fx_t cy, fui_fx_t r, fui_fx_t width, fui_color_t color);

/** A straight piece of a stroke, in Q6 pixels (64 = one pixel): 8 bytes, so a
 *  glyph's segments fit a small array on the stack. */
typedef struct fui_seg {
    int16_t x0, y0, x1, y1;
} fui_seg_t;
#define FUI_SEG_ONE 64
#define FUI_SEGS_MAX 64

/**
 * Several segments inked as ONE stroke with round caps and joins: a pixel's
 * coverage comes from its distance to the nearest segment, so overlapping
 * segments never darken twice. Made for phase glyphs (a few dozen short
 * segments in a small box); cost grows with box area x segment count.
 * At most FUI_SEGS_MAX segments are used. One-bit: a Bresenham line each.
 */
void fui_draw_segments(fui_canvas_t *c, const fui_seg_t *segs, int count, fui_fx_t width, fui_color_t color);

#ifdef __cplusplus
}
#endif

#endif /* FUI_RASTER_H */
