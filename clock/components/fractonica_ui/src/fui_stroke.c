/*
 * fui_stroke.c - several short segments inked as one stroke (phase glyphs).
 *
 * WHY NOT fui_draw_line PER SEGMENT: a glyph's curve arrives as a dozen
 * segments a pixel or two long. Drawn one by one, their anti-aliased edges
 * overlap and blend twice, and the curve comes out lumpy. Here a pixel is
 * inked once, by its distance to the NEAREST segment, which also gives the
 * round caps and joins SPEC S9.1 asks for.
 *
 * Cost: box area x segments, with a four-compare reject per pair. A two-stroke
 * glyph at u = 5 px is a 22 x 42 box and under 30 segments: about a
 * millisecond on an ESP32. It is not meant for long lines.
 *
 * Coordinates are Q6 pixels (fui_seg_t), distances come out in Q6.
 */
#include "fui_raster_priv.h"

/* Distance (Q6) from pixel centre (px, py) to one segment, or `far` when the
 * pixel is outside the segment's box grown by `far`. `inv_len` is 65536 / length. */
/* Distance (Q6) from a pixel centre to a point `(wx, wy)` away, or `far`
 * when it is at least that: only near distances matter, and the square of a
 * far one need not fit 32 bits. */
static int32_t point_distance(int32_t wx, int32_t wy, int32_t far)
{
    if (wx >= far || wx <= -far || wy >= far || wy <= -far) {
        return far;
    }
    return (int32_t)fui_isqrt((uint32_t)(wx * wx + wy * wy));
}

static int32_t seg_distance(const fui_seg_t *s, int32_t inv_len, int32_t px, int32_t py, int32_t far)
{
    int32_t min_x = s->x0 < s->x1 ? s->x0 : s->x1, max_x = s->x0 < s->x1 ? s->x1 : s->x0;
    int32_t min_y = s->y0 < s->y1 ? s->y0 : s->y1, max_y = s->y0 < s->y1 ? s->y1 : s->y0;
    int32_t vx, vy, wx, wy;
    int64_t dot, vv, cross;

    if (px < min_x - far || px > max_x + far || py < min_y - far || py > max_y + far) {
        return far;
    }
    vx = s->x1 - s->x0;
    vy = s->y1 - s->y0;
    wx = px - s->x0;
    wy = py - s->y0;
    /* 64-bit: a segment may span the whole int16 range (products to 2^32) */
    dot = (int64_t)wx * vx + (int64_t)wy * vy;
    vv = (int64_t)vx * vx + (int64_t)vy * vy;
    if (dot <= 0) { /* before the start: distance to the start point */
        return point_distance(wx, wy, far);
    }
    if (dot >= vv) { /* past the end */
        return point_distance(px - s->x1, py - s->y1, far);
    }
    cross = (int64_t)wx * vy - (int64_t)wy * vx; /* |cross| / length = distance to the line */
    if (cross < 0) {
        cross = -cross;
    }
    cross = (cross * inv_len) >> 16;
    return cross < far ? (int32_t)cross : far;
}

void fui_draw_segments(fui_canvas_t *c, const fui_seg_t *segs, int count, fui_fx_t width, fui_color_t color)
{
    uint16_t inv_len[FUI_SEGS_MAX];
    int32_t hw = width / 2;        /* Q8 */
    int32_t far = (hw >> 2) + 33;  /* Q6: beyond half-width + half a pixel there is no ink */
    int32_t min_x, min_y, max_x, max_y;
    int i, x0, y0, x1, y1, x, y;

    if (count <= 0) {
        return;
    }
    if (count > FUI_SEGS_MAX) {
        count = FUI_SEGS_MAX;
    }
    if (fui_canvas_is_mono(c)) {
        if (c->pen > 1) {
            /* the canvas's wider pen (fui_canvas_set_pen); an even one's
             * squares sit half a pixel right and down: move the path back */
            int32_t shift = FUI_I_PEN_SHIFT(c) >> 2; /* Q8 -> Q6 */

            for (i = 0; i < count; i++) {
                fui_i_line_pen(c, (segs[i].x0 - shift) >> 6, (segs[i].y0 - shift) >> 6, (segs[i].x1 - shift) >> 6,
                               (segs[i].y1 - shift) >> 6, color);
            }
            return;
        }
        for (i = 0; i < count; i++) {
            fui_i_line_px(c, segs[i].x0 >> 6, segs[i].y0 >> 6, segs[i].x1 >> 6, segs[i].y1 >> 6, color);
        }
        return;
    }
    min_x = max_x = segs[0].x0;
    min_y = max_y = segs[0].y0;
    for (i = 0; i < count; i++) {
        int32_t vx = segs[i].x1 - segs[i].x0, vy = segs[i].y1 - segs[i].y0;
        uint64_t len2 = (uint64_t)((int64_t)vx * vx) + (uint64_t)((int64_t)vy * vy);
        uint32_t len, shift = 0;

        /* up to 2 x 65535^2: halve the length until its square fits 32 bits */
        while (len2 > UINT32_MAX) {
            len2 >>= 2;
            shift++;
        }
        len = fui_isqrt((uint32_t)len2) << shift;

        /* A segment under 1/64 px has no direction: the end-point branches
         * of seg_distance handle it, the reciprocal is never used. */
        inv_len[i] = len ? (uint16_t)(65535u / len) : 0;
        if (segs[i].x0 < min_x) min_x = segs[i].x0;
        if (segs[i].x1 < min_x) min_x = segs[i].x1;
        if (segs[i].x0 > max_x) max_x = segs[i].x0;
        if (segs[i].x1 > max_x) max_x = segs[i].x1;
        if (segs[i].y0 < min_y) min_y = segs[i].y0;
        if (segs[i].y1 < min_y) min_y = segs[i].y1;
        if (segs[i].y0 > max_y) max_y = segs[i].y0;
        if (segs[i].y1 > max_y) max_y = segs[i].y1;
    }
    x0 = (int)((min_x - far) >> 6);
    y0 = (int)((min_y - far) >> 6);
    x1 = (int)((max_x + far) >> 6) + 1;
    y1 = (int)((max_y + far) >> 6) + 1;
    if (x0 < c->clip.x0) x0 = c->clip.x0;
    if (y0 < c->clip.y0) y0 = c->clip.y0;
    if (x1 > c->clip.x1) x1 = c->clip.x1;
    if (y1 > c->clip.y1) y1 = c->clip.y1;
    if (x1 <= x0 || y1 <= y0) {
        return;
    }
    fui_canvas_touch(c, x0, y0, x1, y1);

    for (y = y0; y < y1; y++) {
        int32_t py = (int32_t)y * 64 + 32;

        for (x = x0; x < x1; x++) {
            int32_t px = (int32_t)x * 64 + 32, nearest = far;

            for (i = 0; i < count; i++) {
                int32_t d = seg_distance(&segs[i], inv_len[i], px, py, far);

                if (d < nearest) {
                    nearest = d;
                }
            }
            if (nearest < far) {
                unsigned cover = fui_i_cover(nearest * 4, hw);

                if (cover) {
                    fui_px_blend(c, x, y, color, cover);
                }
            }
        }
    }
}
