/*
 * fui_canvas.h - one small drawing surface over a frame buffer the CALLER owns.
 *
 * WHY IT LOOKS LIKE THIS
 *   - The firmware has no heap after start-up, so the canvas never allocates:
 *     it is a view (pointer, size, format) over static memory.
 *   - Two families of displays share every face: RGB565 colour panels
 *     (GC9A01, ST7789) and one-bit panels (SSD1306). The rasteriser asks the
 *     canvas which family it is and picks anti-aliasing or pixel-exact output.
 *   - A colour frame is 115 kB (240 x 240) or 154 kB (240 x 320): more than a
 *     classic ESP32 wants to give away. So a canvas may be a BAND of the
 *     screen: `fui_canvas_set_origin` says where the buffer sits, drawing
 *     keeps using screen coordinates, and the caller renders band after band.
 *   - Drivers should send only what changed: every primitive widens `dirty`
 *     (a bounding box in screen coordinates) and the driver flushes that box.
 *
 * COORDINATES
 *   Integer pixel (x, y) is the square [x, x+1) x [y, y+1); its centre is at
 *   (x + 0.5, y + 0.5). x grows right, y grows DOWN. Rectangles are half-open:
 *   [x0, x1) x [y0, y1).
 *
 * ONE-BIT LAYOUTS (documented because a driver has to match them)
 *   FUI_FMT_MONO_PAGE  the SSD1306's own memory: byte = 8 pixels stacked
 *                      VERTICALLY, bit 0 on top. Pixel (x, y) is
 *                      buf[x + (y / 8) * w] bit (y % 8). The height is rounded
 *                      up to whole pages. Send the buffer as it is (horizontal
 *                      addressing mode, pages top to bottom).
 *   FUI_FMT_MONO_ROW   rows of bytes, bit 7 = leftmost pixel. Pixel (x, y) is
 *                      buf[y * ((w + 7) / 8) + x / 8] bit (7 - x % 8).
 * COLOUR LAYOUTS
 *   FUI_FMT_RGB565     uint16_t per pixel in the CPU's byte order.
 *   FUI_FMT_RGB565_BE  the same pixel with its two bytes swapped: high byte
 *                      first in memory, which is what SPI panels take. Use it
 *                      on a little-endian MCU so a flush is a plain transfer.
 *
 * A colour (fui_color_t) is an RGB565 value on colour canvases and 0 / 1 on
 * one-bit canvases (any non-zero value is ink).
 */
#ifndef FUI_CANVAS_H
#define FUI_CANVAS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef uint16_t fui_color_t;

/** r, g, b in 0..255 as RGB565, each channel rounded to nearest. */
#define FUI_RGB565(r, g, b) \
    ((fui_color_t)(((((r) * 31 + 127) / 255) << 11) | ((((g) * 63 + 127) / 255) << 5) | (((b) * 31 + 127) / 255)))

typedef enum fui_format {
    FUI_FMT_RGB565    = 0,
    FUI_FMT_RGB565_BE = 1,
    FUI_FMT_MONO_PAGE = 2,
    FUI_FMT_MONO_ROW  = 3
} fui_format_t;

/** Half-open rectangle in screen pixels. Empty when x1 <= x0 or y1 <= y0. */
typedef struct fui_rect {
    int16_t x0, y0, x1, y1;
} fui_rect_t;

typedef struct fui_canvas {
    uint8_t   *buf;
    int16_t    w, h;     /* size of the buffer in pixels                        */
    int16_t    ox, oy;   /* screen position of the buffer's top-left pixel      */
    uint16_t   stride;   /* bytes per row (colour, MONO_ROW) or per page (PAGE) */
    uint8_t    format;   /* fui_format_t                                        */
    fui_rect_t clip;     /* screen coordinates; always inside the buffer        */
    fui_rect_t dirty;    /* bounding box of everything drawn since the reset    */
    uint8_t    pen;      /* ONE BIT: arcs and glyph strokes this many px wide   */
    uint8_t    dash_on;  /* ONE BIT: a dotted arc inks `dash_on` pixels of its  */
    uint8_t    dash_off; /* path, then skips `dash_off` (fui_canvas_set_pen)    */
} fui_canvas_t;

/** Bytes a buffer of this format and size needs (MONO_PAGE rounds h up to 8). */
size_t fui_canvas_bytes(fui_format_t format, int w, int h);

/**
 * Wrap `buf` (at least fui_canvas_bytes long). Origin (0, 0), clip = the whole
 * buffer, dirty = empty. The buffer is NOT cleared.
 */
void fui_canvas_init(fui_canvas_t *c, void *buf, fui_format_t format, int w, int h);

/** Band rendering: the buffer now shows the screen from (ox, oy). Resets the
 *  clip to the whole buffer and empties the dirty box. */
void fui_canvas_set_origin(fui_canvas_t *c, int ox, int oy);

/** Restrict drawing to `r` (intersected with the buffer). NULL = whole buffer. */
void fui_canvas_set_clip(fui_canvas_t *c, const fui_rect_t *r);

/**
 * ONE BIT: the pen of the arcs (fui_draw_arc, _dotted, fui_draw_ring) and the
 * glyph strokes (fui_draw_segments) that follow: `width` px (1..4: a square
 * of that side stamped at every pixel of the 1 px path, so the stroke stays
 * crisp, no grey), and the dotted arcs' pattern, `on` pixels of the path
 * inked and `off` skipped. fui_canvas_init sets 1, 1, 2 (DESIGN.md S11:
 * 1 px, 1 on / 2 off). Colour canvases ignore it; straight lines
 * (fui_draw_line) keep their own `width`.
 */
void fui_canvas_set_pen(fui_canvas_t *c, int width, int on, int off);

static inline int fui_canvas_is_mono(const fui_canvas_t *c)
{
    return c->format >= FUI_FMT_MONO_PAGE;
}

/* --- dirty box ---------------------------------------------------------- */

/** Forget what was drawn: call after a flush. */
void fui_canvas_dirty_reset(fui_canvas_t *c);
/** 1 and the box (screen coordinates) when something was drawn since the reset. */
int fui_canvas_dirty(const fui_canvas_t *c, fui_rect_t *out);
/** Widen the dirty box by `r` clipped to the clip rectangle (primitives call it). */
void fui_canvas_touch(fui_canvas_t *c, int x0, int y0, int x1, int y1);

/* --- pixels and rectangles ---------------------------------------------- */

/** Fill the clip rectangle. */
void fui_canvas_clear(fui_canvas_t *c, fui_color_t color);
/** Fill [x, x+w) x [y, y+h), clipped. */
void fui_canvas_fill_rect(fui_canvas_t *c, int x, int y, int w, int h, fui_color_t color);
/** One pixel, clipped. */
void fui_canvas_pixel(fui_canvas_t *c, int x, int y, fui_color_t color);
/**
 * One pixel covered `coverage`/255 by `color`, blended over what is there.
 * One-bit canvases have no blend: coverage >= 128 sets the pixel.
 */
void fui_canvas_blend(fui_canvas_t *c, int x, int y, fui_color_t color, unsigned coverage);
/** Read a pixel (RGB565 in CPU order, or 0 / 1). 0 outside the buffer. */
fui_color_t fui_canvas_get(const fui_canvas_t *c, int x, int y);

/* --- rectangles as values ----------------------------------------------- */

static inline int fui_rect_is_empty(const fui_rect_t *r)
{
    return r->x1 <= r->x0 || r->y1 <= r->y0;
}
fui_rect_t fui_rect_make(int x0, int y0, int x1, int y1);
fui_rect_t fui_rect_intersect(const fui_rect_t *a, const fui_rect_t *b);
/** The smallest rectangle holding both; an empty one does not count. */
fui_rect_t fui_rect_union(const fui_rect_t *a, const fui_rect_t *b);

/** `fg` over `bg` with alpha 0..32, both RGB565 in CPU order. */
static inline uint16_t fui_blend565(uint16_t bg, uint16_t fg, uint32_t alpha)
{
    /* Spread the three channels so one multiply blends them all. */
    uint32_t b = (bg | ((uint32_t)bg << 16)) & 0x07E0F81Fu;
    uint32_t f = (fg | ((uint32_t)fg << 16)) & 0x07E0F81Fu;
    uint32_t r = (b + (((f - b) * alpha) >> 5)) & 0x07E0F81Fu;
    return (uint16_t)(r | (r >> 16));
}

#ifdef __cplusplus
}
#endif

#endif /* FUI_CANVAS_H */
