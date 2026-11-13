/*
 * fui_font.c - UTF-8 decoding, glyph lookup, and the text drawer.
 * The tables are in fui_font_small.c and fui_font_text.c (generated).
 */
#include "fui_font.h"
#include "fui_px.h"

uint32_t fui_utf8_next(const char **text)
{
    const unsigned char *p = (const unsigned char *)*text;
    uint32_t cp, min;
    int more, i;

    if (p[0] == 0) {
        return 0;
    }
    if (p[0] < 0x80) {
        *text += 1;
        return p[0];
    }
    if ((p[0] & 0xE0) == 0xC0) {
        cp = p[0] & 0x1Fu; more = 1; min = 0x80;
    } else if ((p[0] & 0xF0) == 0xE0) {
        cp = p[0] & 0x0Fu; more = 2; min = 0x800;
    } else if ((p[0] & 0xF8) == 0xF0) {
        cp = p[0] & 0x07u; more = 3; min = 0x10000;
    } else {
        *text += 1;
        return 0xFFFD;
    }
    for (i = 1; i <= more; i++) {
        if ((p[i] & 0xC0) != 0x80) { /* also stops at the NUL */
            *text += 1;
            return 0xFFFD;
        }
        cp = (cp << 6) | (p[i] & 0x3Fu);
    }
    *text += more + 1;
    return cp < min ? 0xFFFD : cp;
}

/* The glyph record of a code point, or NULL. */
static const uint8_t *find_glyph(const fui_font_t *font, uint32_t cp)
{
    uint16_t lo, hi;

    if (cp >= 0x20 && cp <= 0x7E) {
        return font->glyphs + (size_t)(cp - 0x20) * (1u + font->height);
    }
    lo = 95;
    hi = font->count;
    while (lo < hi) {
        uint16_t mid = (uint16_t)((lo + hi) / 2);

        if (font->codepoints[mid] < cp) {
            lo = (uint16_t)(mid + 1);
        } else {
            hi = mid;
        }
    }
    if (lo < font->count && font->codepoints[lo] == cp) {
        return font->glyphs + (size_t)lo * (1u + font->height);
    }
    return NULL;
}

int fui_font_has(const fui_font_t *font, uint32_t codepoint)
{
    return find_glyph(font, codepoint) != NULL;
}

#define CP_EARTH 0x2295u

/* Capitals, unless the text has reached its Earth tail (FUI_TEXT_EARTH_TAIL).
 * `*earth` is the caller's "past the Earth sign" state, 0 at the start. */
static uint32_t fold(const fui_text_style_t *style, uint32_t cp, int *earth)
{
    if (cp == CP_EARTH && (style->flags & FUI_TEXT_EARTH_TAIL)) {
        *earth = 1;
    }
    if ((style->flags & FUI_TEXT_CAPS) && !*earth && cp >= 'a' && cp <= 'z') {
        return cp - ('a' - 'A');
    }
    return cp;
}

int fui_text_width(const fui_text_style_t *style, const char *text, size_t bytes)
{
    const char *p = text;
    int width = 0, earth = 0;
    uint32_t cp;

    /* `bytes` may be SIZE_MAX ("to the NUL"): compare counts, not pointers. */
    while ((size_t)(p - text) < bytes && (cp = fui_utf8_next(&p)) != 0) {
        const uint8_t *glyph = find_glyph(style->font, fold(style, cp, &earth));

        width += ((glyph ? glyph[0] : style->font->box) + 1) * style->scale;
    }
    /* The blank column after the last glyph is not part of the text. */
    return width > 0 ? width - style->scale : 0;
}

/* One dot of a glyph: a scale x scale block, clipped. */
static void dot(fui_canvas_t *c, int x, int y, int scale, fui_color_t ink)
{
    int px, py;

    for (py = y; py < y + scale; py++) {
        if (py < c->clip.y0 || py >= c->clip.y1) {
            continue;
        }
        for (px = x; px < x + scale; px++) {
            if (px >= c->clip.x0 && px < c->clip.x1) {
                fui_px_set(c, px, py, ink);
            }
        }
    }
}

int fui_text_draw(fui_canvas_t *c, const fui_text_style_t *style, int x, int y, const char *text, size_t bytes)
{
    const fui_font_t *font = style->font;
    const char *p = text;
    int scale = style->scale, height = font->height * scale, x_start = x, row, col, earth = 0;
    uint32_t cp;

    while ((size_t)(p - text) < bytes && (cp = fui_utf8_next(&p)) != 0) {
        const uint8_t *glyph;
        fui_color_t ink = style->ink;
        int width;

        cp = fold(style, cp, &earth);
        glyph = find_glyph(font, cp);
        width = glyph ? glyph[0] : font->box;
        if (earth) {
            ink = style->ink_earth;
        } else if ((style->flags & FUI_TEXT_TWO_TONE) && (cp == '#' || (cp >= 0x03B1 && cp <= 0x03C9))) {
            ink = style->ink_symbol;
        }
        /* Skip glyphs wholly outside the clip: most of a card, in a partial redraw. */
        if (x + width * scale > c->clip.x0 && x < c->clip.x1 && y + height > c->clip.y0 && y < c->clip.y1) {
            for (row = 0; row < font->height; row++) {
                uint8_t bits;

                if (glyph) {
                    bits = glyph[1 + row];
                } else if (row < font->cap_top || row >= font->baseline) {
                    bits = 0;
                } else if (row == font->cap_top || row == font->baseline - 1) {
                    bits = (uint8_t)(0xFF00u >> width); /* top and bottom of the box */
                } else {
                    bits = (uint8_t)(0x80u | (0x80u >> (width - 1)));
                }
                for (col = 0; bits != 0; col++, bits = (uint8_t)(bits << 1)) {
                    if (bits & 0x80u) {
                        dot(c, x + col * scale, y + row * scale, scale, ink);
                    }
                }
            }
        }
        x += (width + 1) * scale;
    }
    if (x > x_start) {
        fui_canvas_touch(c, x_start, y, x, y + height);
    }
    return x > x_start ? x - scale : x;
}
