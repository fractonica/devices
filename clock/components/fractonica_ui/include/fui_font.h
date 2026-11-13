/*
 * fui_font.h - our own bitmap fonts and the UTF-8 text drawer.
 *
 * The core writes every reading as UTF-8 ("α#6 β#4 ... 34η 29ι", "−2η 23ι",
 * "1.420 × 10¹⁴ pB", "⊕ ..."). These fonts hold exactly what those texts
 * need: ASCII, the 24 Greek letters, the minus U+2212, the narrow no-break
 * space U+202F (a thin gap between digit groups), superscript digits, the
 * multiplication sign, dashes, the Earth sign, the Pentad shapes. The art
 * lives in tools/fonts/<name>.txt; tools/genfont.py writes the tables.
 *
 *   fui_font_small  3 x 5 class, 8-row cell: the one-bit face (drawn at
 *                   scale 2 for the count, scale 1 for cards)
 *   fui_font_text   5 x 7 class, 10-row cell: the colour faces
 *
 * A code point without a glyph draws as a hollow box, so a gap is seen on
 * the display; sim/tests/test_font.c fails the build before that happens.
 *
 * TABLE LAYOUT (all const, in flash)
 *   codepoints[count]  sorted. The first 95 are ASCII 0x20..0x7E, so ASCII is
 *                      indexed directly and only the rest is searched.
 *   glyphs             count records of (1 + height) bytes: the width in
 *                      columns (1..8), then one byte per row, bit 7 leftmost.
 *   Glyphs are proportional; `1` blank column follows each.
 */
#ifndef FUI_FONT_H
#define FUI_FONT_H

#include "fui_canvas.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct fui_font {
    const uint16_t *codepoints;
    const uint8_t  *glyphs;
    uint16_t        count;
    uint8_t         height;    /* rows per cell                                 */
    uint8_t         cap_top;   /* first row of a capital / digit                */
    uint8_t         baseline;  /* first row below the baseline (descenders)     */
    uint8_t         box;       /* width of the missing-glyph box                */
} fui_font_t;

extern const fui_font_t fui_font_small;
extern const fui_font_t fui_font_text;

/** Draw ASCII a-z as A-Z: the engraved capitals of DESIGN.md S3. Greek is
 *  never folded (the letters are symbols and stay lowercase). */
#define FUI_TEXT_CAPS     0x01u
/** Draw Greek letters and '#' in `ink_symbol`: the reading style of
 *  DESIGN.md S3 (digits bone, unit letters and '#' ash). */
#define FUI_TEXT_TWO_TONE 0x02u
/** From the Earth sign U+2295 to the end of the text: `ink_earth`, and the
 *  letters as written (an SI prefix must keep its case: Mm is not mm). So a
 *  line may carry a Fractonica value and its translation beside it, each in
 *  its own voice (DESIGN.md S1.5: Earth is an annotation, in ash, led by the
 *  sign). */
#define FUI_TEXT_EARTH_TAIL 0x04u

typedef struct fui_text_style {
    const fui_font_t *font;
    uint8_t           scale;      /* pixels per dot, 1..8                       */
    uint8_t           flags;      /* FUI_TEXT_*                                 */
    fui_color_t       ink;
    fui_color_t       ink_symbol; /* used with FUI_TEXT_TWO_TONE                */
    fui_color_t       ink_earth;  /* used with FUI_TEXT_EARTH_TAIL              */
} fui_text_style_t;

/**
 * Decode one code point and advance *text. Returns 0 at the terminating NUL
 * (without advancing) and U+FFFD for a byte sequence that is not UTF-8
 * (advancing one byte), so a damaged string still ends.
 */
uint32_t fui_utf8_next(const char **text);

/** 1 when the font has a glyph for the code point. */
int fui_font_has(const fui_font_t *font, uint32_t codepoint);

/** Width in pixels of the first `bytes` bytes of `text` (or up to its NUL). */
int fui_text_width(const fui_text_style_t *style, const char *text, size_t bytes);

/** Height in pixels of a line: font height x scale. */
static inline int fui_text_height(const fui_text_style_t *style)
{
    return style->font->height * style->scale;
}

/**
 * Draw the first `bytes` bytes of `text` (or up to its NUL) with the cell's
 * top-left corner at (x, y). Opaque dots only: the background is untouched.
 * @return the x just after the last glyph.
 */
int fui_text_draw(fui_canvas_t *c, const fui_text_style_t *style, int x, int y, const char *text, size_t bytes);

#ifdef __cplusplus
}
#endif

#endif /* FUI_FONT_H */
