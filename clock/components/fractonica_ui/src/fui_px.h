/*
 * fui_px.h - PRIVATE. The unclipped pixel accessors every rasteriser loop
 * uses. Callers have already clipped (x, y) to c->clip, which is inside the
 * buffer; these only translate screen coordinates to the buffer's layout.
 *
 * Kept `static inline` in a header (not behind a function pointer) so the
 * inner loops compile to straight code; the format switch is predictable.
 */
#ifndef FUI_PX_H
#define FUI_PX_H

#include "fui_canvas.h"

static inline uint16_t fui_px_swap(uint16_t v)
{
    return (uint16_t)((v << 8) | (v >> 8));
}

/** Address of a colour pixel. */
static inline uint16_t *fui_px_at(const fui_canvas_t *c, int x, int y)
{
    /* The buffer is the caller's; colour buffers must be 2-byte aligned. */
    return (uint16_t *)(void *)(c->buf + (size_t)(y - c->oy) * c->stride) + (x - c->ox);
}

static inline void fui_px_set(fui_canvas_t *c, int x, int y, fui_color_t color)
{
    int bx = x - c->ox, by = y - c->oy;

    switch (c->format) {
    case FUI_FMT_RGB565:
        *fui_px_at(c, x, y) = color;
        break;
    case FUI_FMT_RGB565_BE:
        *fui_px_at(c, x, y) = fui_px_swap(color);
        break;
    case FUI_FMT_MONO_PAGE: {
        uint8_t *p = c->buf + (size_t)(by >> 3) * c->stride + bx;
        uint8_t bit = (uint8_t)(1u << (by & 7));
        *p = color ? (uint8_t)(*p | bit) : (uint8_t)(*p & ~bit);
        break;
    }
    default: {
        uint8_t *p = c->buf + (size_t)by * c->stride + (bx >> 3);
        uint8_t bit = (uint8_t)(0x80u >> (bx & 7));
        *p = color ? (uint8_t)(*p | bit) : (uint8_t)(*p & ~bit);
        break;
    }
    }
}

static inline fui_color_t fui_px_get(const fui_canvas_t *c, int x, int y)
{
    int bx = x - c->ox, by = y - c->oy;

    switch (c->format) {
    case FUI_FMT_RGB565:
        return *fui_px_at(c, x, y);
    case FUI_FMT_RGB565_BE:
        return fui_px_swap(*fui_px_at(c, x, y));
    case FUI_FMT_MONO_PAGE:
        return (fui_color_t)((c->buf[(size_t)(by >> 3) * c->stride + bx] >> (by & 7)) & 1u);
    default:
        return (fui_color_t)((c->buf[(size_t)by * c->stride + (bx >> 3)] >> (7 - (bx & 7))) & 1u);
    }
}

/** coverage 0..255 of `color` over the pixel. One-bit: a threshold at half. */
static inline void fui_px_blend(fui_canvas_t *c, int x, int y, fui_color_t color, unsigned coverage)
{
    if (c->format <= FUI_FMT_RGB565_BE) {
        uint32_t alpha = (coverage + 4u) >> 3; /* 0..255 -> 0..32 */
        uint16_t *p;

        if (alpha == 0) {
            return;
        }
        p = fui_px_at(c, x, y);
        if (c->format == FUI_FMT_RGB565) {
            *p = alpha >= 32 ? color : fui_blend565(*p, color, alpha);
        } else {
            *p = fui_px_swap(alpha >= 32 ? color : fui_blend565(fui_px_swap(*p), color, alpha));
        }
    } else if (coverage >= 128u) {
        fui_px_set(c, x, y, color);
    }
}

#endif /* FUI_PX_H */
