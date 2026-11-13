/*
 * fui_canvas.c - the drawing surface: formats, clip, dirty box, rectangles.
 * See fui_canvas.h for the layouts. Nothing here allocates or keeps state
 * outside the fui_canvas_t the caller passes.
 */
#include "fui_canvas.h"
#include "fui_px.h"

fui_rect_t fui_rect_make(int x0, int y0, int x1, int y1)
{
    fui_rect_t r;

    r.x0 = (int16_t)x0;
    r.y0 = (int16_t)y0;
    r.x1 = (int16_t)x1;
    r.y1 = (int16_t)y1;
    return r;
}

fui_rect_t fui_rect_intersect(const fui_rect_t *a, const fui_rect_t *b)
{
    fui_rect_t r;

    r.x0 = a->x0 > b->x0 ? a->x0 : b->x0;
    r.y0 = a->y0 > b->y0 ? a->y0 : b->y0;
    r.x1 = a->x1 < b->x1 ? a->x1 : b->x1;
    r.y1 = a->y1 < b->y1 ? a->y1 : b->y1;
    return r;
}

fui_rect_t fui_rect_union(const fui_rect_t *a, const fui_rect_t *b)
{
    fui_rect_t r;

    if (fui_rect_is_empty(a)) {
        return *b;
    }
    if (fui_rect_is_empty(b)) {
        return *a;
    }
    r.x0 = a->x0 < b->x0 ? a->x0 : b->x0;
    r.y0 = a->y0 < b->y0 ? a->y0 : b->y0;
    r.x1 = a->x1 > b->x1 ? a->x1 : b->x1;
    r.y1 = a->y1 > b->y1 ? a->y1 : b->y1;
    return r;
}

static uint16_t stride_of(fui_format_t format, int w)
{
    switch (format) {
    case FUI_FMT_RGB565:
    case FUI_FMT_RGB565_BE:
        return (uint16_t)(w * 2);
    case FUI_FMT_MONO_PAGE:
        return (uint16_t)w;
    default:
        return (uint16_t)((w + 7) / 8);
    }
}

size_t fui_canvas_bytes(fui_format_t format, int w, int h)
{
    if (w <= 0 || h <= 0) {
        return 0;
    }
    if (format == FUI_FMT_MONO_PAGE) {
        return (size_t)w * (size_t)((h + 7) / 8);
    }
    return (size_t)stride_of(format, w) * (size_t)h;
}

void fui_canvas_init(fui_canvas_t *c, void *buf, fui_format_t format, int w, int h)
{
    c->buf = (uint8_t *)buf;
    c->w = (int16_t)w;
    c->h = (int16_t)h;
    c->format = (uint8_t)format;
    c->stride = stride_of(format, w);
    fui_canvas_set_origin(c, 0, 0);
}

void fui_canvas_set_origin(fui_canvas_t *c, int ox, int oy)
{
    c->ox = (int16_t)ox;
    c->oy = (int16_t)oy;
    fui_canvas_set_clip(c, NULL);
    fui_canvas_dirty_reset(c);
}

void fui_canvas_set_clip(fui_canvas_t *c, const fui_rect_t *r)
{
    fui_rect_t whole = fui_rect_make(c->ox, c->oy, c->ox + c->w, c->oy + c->h);

    c->clip = r ? fui_rect_intersect(&whole, r) : whole;
    if (fui_rect_is_empty(&c->clip)) {
        /* Keep it a valid empty box at the origin: loops then run zero times. */
        c->clip = fui_rect_make(c->ox, c->oy, c->ox, c->oy);
    }
}

void fui_canvas_dirty_reset(fui_canvas_t *c)
{
    c->dirty = fui_rect_make(0, 0, 0, 0);
}

int fui_canvas_dirty(const fui_canvas_t *c, fui_rect_t *out)
{
    if (out) {
        *out = c->dirty;
    }
    return !fui_rect_is_empty(&c->dirty);
}

void fui_canvas_touch(fui_canvas_t *c, int x0, int y0, int x1, int y1)
{
    fui_rect_t r;

    /* Clamp in int before narrowing: primitives may pass far-away boxes. */
    if (x0 < c->clip.x0) x0 = c->clip.x0;
    if (y0 < c->clip.y0) y0 = c->clip.y0;
    if (x1 > c->clip.x1) x1 = c->clip.x1;
    if (y1 > c->clip.y1) y1 = c->clip.y1;
    if (x1 <= x0 || y1 <= y0) {
        return;
    }
    r = fui_rect_make(x0, y0, x1, y1);
    c->dirty = fui_rect_union(&c->dirty, &r);
}

void fui_canvas_fill_rect(fui_canvas_t *c, int x, int y, int w, int h, fui_color_t color)
{
    int x0 = x, y0 = y, x1 = x + w, y1 = y + h, px, py;

    if (x0 < c->clip.x0) x0 = c->clip.x0;
    if (y0 < c->clip.y0) y0 = c->clip.y0;
    if (x1 > c->clip.x1) x1 = c->clip.x1;
    if (y1 > c->clip.y1) y1 = c->clip.y1;
    if (x1 <= x0 || y1 <= y0) {
        return;
    }
    if (c->format <= FUI_FMT_RGB565_BE) {
        uint16_t raw = c->format == FUI_FMT_RGB565 ? color : fui_px_swap(color);

        for (py = y0; py < y1; py++) {
            uint16_t *p = fui_px_at(c, x0, py);

            for (px = x0; px < x1; px++) {
                *p++ = raw;
            }
        }
    } else {
        for (py = y0; py < y1; py++) {
            for (px = x0; px < x1; px++) {
                fui_px_set(c, px, py, color);
            }
        }
    }
    fui_canvas_touch(c, x0, y0, x1, y1);
}

void fui_canvas_clear(fui_canvas_t *c, fui_color_t color)
{
    fui_canvas_fill_rect(c, c->clip.x0, c->clip.y0, c->clip.x1 - c->clip.x0, c->clip.y1 - c->clip.y0, color);
}

static int inside_clip(const fui_canvas_t *c, int x, int y)
{
    return x >= c->clip.x0 && x < c->clip.x1 && y >= c->clip.y0 && y < c->clip.y1;
}

void fui_canvas_pixel(fui_canvas_t *c, int x, int y, fui_color_t color)
{
    if (inside_clip(c, x, y)) {
        fui_px_set(c, x, y, color);
        fui_canvas_touch(c, x, y, x + 1, y + 1);
    }
}

void fui_canvas_blend(fui_canvas_t *c, int x, int y, fui_color_t color, unsigned coverage)
{
    if (inside_clip(c, x, y)) {
        fui_px_blend(c, x, y, color, coverage > 255u ? 255u : coverage);
        fui_canvas_touch(c, x, y, x + 1, y + 1);
    }
}

fui_color_t fui_canvas_get(const fui_canvas_t *c, int x, int y)
{
    if (x < c->ox || y < c->oy || x >= c->ox + c->w || y >= c->oy + c->h) {
        return 0;
    }
    return fui_px_get(c, x, y);
}
