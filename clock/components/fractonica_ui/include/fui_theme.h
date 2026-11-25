/*
 * fui_theme.h - the colour tokens of design/astrolabe/DESIGN.md S2.
 *
 * Every colour a face uses is a field of fui_theme_t: no face holds a literal.
 * Adding the "tablet" palette of design/README.md is one more const table.
 * The one-bit themes map every ink to one bit value and the ground to the
 * other; what colour says on the colour faces (elapsed / to come) the one-bit
 * faces say with solid and dotted lines instead, so their fields are only
 * "ink or not". Which bit value the glass shows as dark is the panel's: the
 * SSD1306 lights a set bit (fui_theme_mono: ink 1 on a ground of 0), the
 * Waveshare e-paper whitens it (fui_theme_paper: ink 0 on a ground of 1).
 * Neither is inverse video: each draws ink on its panel's own ground.
 */
#ifndef FUI_THEME_H
#define FUI_THEME_H

#include "fui_canvas.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct fui_theme {
    fui_color_t ground;      /* `void`: the screen                               */
    fui_color_t etch1;       /* machining marks, leaders                         */
    fui_color_t etch2;       /* engraved hairline: nested arcs to come, carriers */
    fui_color_t etch3;       /* strong engraving: first-level arcs to come, ticks */
    fui_color_t ash;         /* secondary text, unit letters, Earth translations */
    fui_color_t bone;        /* numerals, names, beads of completed children     */
    fui_color_t lumen;       /* the cold light: elapsed, now, the next threshold */
    fui_color_t lumen_mid;   /* lumen at rest: elapsed nested arcs, lit ticks    */
    fui_color_t lumen_dim;   /* elapsed carrier; completed slots, minor rings    */
    fui_color_t lumen_etch;  /* completed slots, major rings                     */
    fui_color_t sol;         /* the Sun, and nothing else                        */
    fui_color_t sol_dim;     /* the Sun, completed                               */
    fui_color_t sol_empty;   /* empty sync slots (#2A2616)                       */
    fui_color_t h_alpha;     /* the one red: the rung that is visible light      */
    fui_color_t alidade;     /* bone at 42 % over the ground: the hand           */
    fui_color_t core;        /* the white core of the point of now               */
} fui_theme_t;

/** The Astrolabe palette as RGB565. */
extern const fui_theme_t fui_theme_astrolabe;
/** One bit: ground 0, every ink 1 (a lit OLED pixel is ink). */
extern const fui_theme_t fui_theme_mono;
/** One bit on paper: ground 1 (a set bit: white on a panel whose memory holds
 *  1 = white), every ink 0 (black). The default of FUI_FACE_MONO400X300. */
extern const fui_theme_t fui_theme_paper;

#ifdef __cplusplus
}
#endif

#endif /* FUI_THEME_H */
