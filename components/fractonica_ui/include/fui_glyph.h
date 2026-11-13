/*
 * fui_glyph.h - phase glyphs and arcs taken from the core and put on a canvas.
 *
 * This is the GEOMETRY BOUNDARY of the library. The core owns the shapes:
 *   - a glyph's strokes come from frc_glyph_segments (SPEC S9.1), in
 *     hundredths of a design unit;
 *   - an arc comes from frc_arc_child / frc_arc_point as a float frc_arc_t.
 * Here they are scaled to pixels and handed to the integer rasteriser. The
 * arc conversion is the only float code in fractonica_ui.
 *
 * GLYPH SIZE: `u` is pixels per design unit in Q16 (FUI_U_PX(5) = 5 px).
 * Ink is 0.3 u wide. On the one-bit face use FUI_U_MONO (10/3 px: 1 px ink)
 * with the origin on a pixel centre, x and y ending in .5: stems and bars then
 * fall on whole pixel columns and rows (SPEC S9.2), a stem segment is exactly
 * 10 px, and the curves are 8-connected pixel runs.
 */
#ifndef FUI_GLYPH_H
#define FUI_GLYPH_H

#include "fractonica.h"
#include "fui_raster.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Whole pixels per design unit as the Q16 the glyph functions take. */
#define FUI_U_PX(px) ((uint32_t)(px) << 16)
/** 10/3 px per unit: the one-bit face, 1 px ink (DESIGN.md S6). */
#define FUI_U_MONO 218453u

/**
 * Draw one glyph. (ox, oy) is where the glyph's origin goes: the TOP of its
 * stem (Q8 pixels). The glyph then spans x in [-2.15 u, 2.15 u] and y in
 * [-2.2 u, (3 strokes + 0.15) u] around it (frc_glyph_bounds).
 */
void fui_glyph_draw(fui_canvas_t *c, const frc_glyph_t *glyph, fui_fx_t ox, fui_fx_t oy,
                    uint32_t u, fui_color_t color);

/** The same from a state index (frc_glyph_from_index). */
void fui_glyph_draw_index(fui_canvas_t *c, uint16_t index, uint8_t strokes, fui_fx_t ox, fui_fx_t oy,
                          uint32_t u, fui_color_t color);

/**
 * An odometer: `count` glyphs side by side, stems `pitch` (Q8 px) apart,
 * digit[0] leftmost with its origin at (ox, oy).
 */
void fui_odometer_draw(fui_canvas_t *c, const uint16_t *digits, uint8_t count, uint8_t strokes,
                       fui_fx_t ox, fui_fx_t oy, fui_fx_t pitch, uint32_t u, fui_color_t color);

/**
 * Where the stem top goes so that the glyph BOX is centred on `cy`
 * (DESIGN.md S6: the box is centred on y = (3 d - 2.05) / 2 units).
 */
fui_fx_t fui_glyph_origin_y(fui_fx_t cy, uint8_t strokes, uint32_t u);

#ifndef FRC_NO_FLOAT
/** Pixels as a float to Q8, rounded to nearest. */
fui_fx_t fui_fx_from_float(float pixels);
/** A core arc (radians, floats) as a rasteriser arc (65536 per turn, Q8). */
fui_arc_t fui_arc_from_frc(const frc_arc_t *arc);
#endif

#ifdef __cplusplus
}
#endif

#endif /* FUI_GLYPH_H */
