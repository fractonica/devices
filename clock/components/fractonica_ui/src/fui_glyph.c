/*
 * fui_glyph.c - the geometry boundary: core glyphs and core arcs to pixels.
 *
 * Glyphs: frc_glyph_segments hands us the strokes of SPEC S9.1 as straight
 * pieces; we scale them, collect them on the stack and ink them as one stroke
 * (fui_draw_segments). The dot of a falling state is a disc. No glyph shape
 * is decided here.
 *
 * Arcs: fui_arc_from_frc is the single float-to-fixed conversion.
 */
#include "fui_glyph.h"

/* Most segments a glyph may bring: 5 strokes x (1 stem + 2 cubics x 4 steps)
 * = 45. Two-stroke glyphs with 8 steps a cubic need 34. */
#define GLYPH_SEGS 48

typedef struct collector {
    fui_seg_t seg[GLYPH_SEGS];
    int       count;
    int32_t   ox, oy; /* origin, Q6 */
    uint32_t  u;      /* px per unit, Q16 */
} collector_t;

/* A glyph coordinate (hundredths of a unit) as Q6 pixels from the origin:
 * coord * u / 100, with u in Q16 -> / 1024 for Q6. Rounded to nearest, halves
 * away from zero, so the -1 stroke stays the exact mirror of the +1 stroke. */
static int32_t scale_coord(int16_t coord, uint32_t u)
{
    int64_t n = (int64_t)coord * (int64_t)u;

    return (int32_t)(n < 0 ? -((-n + 51200) / 102400) : (n + 51200) / 102400);
}

static void collect(void *ctx, int16_t x0, int16_t y0, int16_t x1, int16_t y1)
{
    collector_t *k = (collector_t *)ctx;
    fui_seg_t *s;

    if (k->count >= GLYPH_SEGS) {
        return;
    }
    s = &k->seg[k->count++];
    s->x0 = (int16_t)(k->ox + scale_coord(x0, k->u));
    s->y0 = (int16_t)(k->oy + scale_coord(y0, k->u));
    s->x1 = (int16_t)(k->ox + scale_coord(x1, k->u));
    s->y1 = (int16_t)(k->oy + scale_coord(y1, k->u));
}

void fui_glyph_draw(fui_canvas_t *c, const frc_glyph_t *glyph, fui_fx_t ox, fui_fx_t oy,
                    uint32_t u, fui_color_t color)
{
    collector_t k;
    /* Ink 0.3 u and the dot radius 0.3 u, in Q8 pixels. */
    fui_fx_t ink = (fui_fx_t)(((uint64_t)FRC_GLYPH_INK * u + 12800) / 25600);
    fui_fx_t dot_r = (fui_fx_t)(((uint64_t)FRC_GLYPH_DOT_RADIUS * u + 12800) / 25600);
    /* Curve steps: about one segment per pixel and a half of curve, within
     * what the collector holds for this stroke count. */
    uint32_t steps = (u >> 16) + 1, room;

    if (!glyph || glyph->strokes == 0 || glyph->strokes > FRC_MAX_STROKES) {
        return;
    }
    room = (GLYPH_SEGS / glyph->strokes - 1u) / 2u;
    if (steps < 4) steps = 4;
    if (steps > 8) steps = 8;
    if (steps > room) steps = room;

    k.count = 0;
    k.ox = ox >> 2;
    k.oy = oy >> 2;
    k.u = u;
    frc_glyph_segments(glyph, (uint8_t)steps, collect, &k);
    fui_draw_segments(c, k.seg, k.count, ink, color);
    if (glyph->dotted) {
        fui_fill_disc(c, ox, oy + scale_coord(FRC_GLYPH_DOT_Y, u) * 4, dot_r, color);
    }
}

void fui_glyph_draw_index(fui_canvas_t *c, uint16_t index, uint8_t strokes, fui_fx_t ox, fui_fx_t oy,
                          uint32_t u, fui_color_t color)
{
    frc_glyph_t glyph;

    if (frc_glyph_from_index(index, strokes, &glyph) == FRC_OK) {
        fui_glyph_draw(c, &glyph, ox, oy, u, color);
    }
}

void fui_odometer_draw(fui_canvas_t *c, const uint16_t *digits, uint8_t count, uint8_t strokes,
                       fui_fx_t ox, fui_fx_t oy, fui_fx_t pitch, uint32_t u, fui_color_t color)
{
    uint8_t i;

    for (i = 0; i < count; i++) {
        fui_glyph_draw_index(c, digits[i], strokes, ox + (fui_fx_t)i * pitch, oy, u, color);
    }
}

fui_fx_t fui_glyph_origin_y(fui_fx_t cy, uint8_t strokes, uint32_t u)
{
    /* (3 d - 2.05) / 2 units = (300 d - 205) / 2 hundredths, as Q8 pixels. */
    int64_t half_box = ((int64_t)(300 * strokes - 205) * (int64_t)u) / 200;

    return cy - (fui_fx_t)(half_box >> 8);
}

#ifndef FRC_NO_FLOAT

fui_fx_t fui_fx_from_float(float pixels)
{
    float scaled = pixels * 256.0f;

    return (fui_fx_t)(scaled < 0.0f ? scaled - 0.5f : scaled + 0.5f);
}

fui_arc_t fui_arc_from_frc(const frc_arc_t *arc)
{
    /* 65536 / (2 pi) binary-angle units per radian */
    const float per_radian = 10430.378f;
    fui_arc_t out;
    float start = arc->start * per_radian, sweep = arc->sweep * per_radian;

    out.cx = fui_fx_from_float(arc->cx);
    out.cy = fui_fx_from_float(arc->cy);
    out.r = fui_fx_from_float(arc->radius);
    /* The start wraps to one turn; the sweep keeps its sign and size. */
    out.start = (uint16_t)(int32_t)(start < 0.0f ? start - 0.5f : start + 0.5f);
    out.sweep = (int32_t)(sweep < 0.0f ? sweep - 0.5f : sweep + 0.5f);
    return out;
}

#endif /* FRC_NO_FLOAT */
