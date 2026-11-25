/*
 * fui_i.h - PRIVATE. What the face, screen and state-machine files share.
 *
 * HOW A FRAME IS MADE
 *   fui_ui_update (fui_ui.c) reads the core into ui->reading (fui_model.c),
 *   then runs the screen's paint function ONCE WITHOUT A CANVAS: text lines
 *   are formatted and hashed, nothing is drawn. Comparing the hashes with the
 *   previous frame's tells which rows changed. fui_ui_draw runs the same
 *   paint function with a canvas clipped to the dirty rectangle.
 *   So a screen is one function, `paint(painter)`, and it must:
 *     - send every text through fui_i_text / fui_i_card_line (never straight
 *       to fui_text_draw), so the line is hashed and its row is known;
 *     - draw shapes only `if (p->canvas)`;
 *     - take ring and glyph state from ui->reading, never from the core, so
 *       a partial redraw of a text row finds the rings as they were drawn.
 *   Text is formatted from the core at ui->t at paint time: no text is stored.
 */
#ifndef FUI_I_H
#define FUI_I_H

#include "fui_font.h"
#include "fui_glyph.h"
#include "fui_ui.h"

/* ------------------------------------------------------------------------- */
/* Layout: where things sit on each face                                      */
/* ------------------------------------------------------------------------- */

typedef struct fui_layout {
    fui_face_info_t info;
    /* the instrument (DESIGN.md S5, S11) */
    fui_fx_t cx, cy;       /* centre                                              */
    fui_fx_t radius;       /* R of the focused ring's carrier                     */
    fui_fx_t gap;          /* g: between minor counter rings                      */
    fui_fx_t gap_major;    /* gM: between major counter rings                     */
    fui_fx_t ring_limit;   /* no counter ring beyond this radius                  */
    uint32_t u;            /* centre odometer: px per design unit, Q16            */
    /* rows under the instrument (cell tops; -1 = the face has no such row)   */
    int16_t  instrument_bottom; /* rows [0, this) belong to the instrument        */
    int16_t  words_y, reading_y, countdown_y, earth_y;
    /* cards (LENS, SUN, STAMP) */
    int16_t  card_top;     /* a page's column lies in rows [card_top, card_bottom) */
    int16_t  card_bottom;
    int16_t  card_marks_y; /* the row of the page beads                           */
    int16_t  card_cy;      /* the centre of the Sun's ring                        */
    /* what differs between the one-bit faces                                  */
    uint8_t  tiny;         /* 1: the 128 x 64 face (DESIGN.md S11): its own NOW
                              (fui_face_mono.c), the ring's first level only,
                              written text at 1 px per dot, the dot font for the
                              count, cards without heads, the SUN figure on a page
                              of its own. 0: the colour faces' arrangements (the
                              400 x 300 paper face too, with one-bit marks)       */
    int16_t  wave_reach;   /* > 0: NOW is the WAVE alone (the 400 x 300 paper face):
                              the focused ring, its inner circle and glyphs, sized
                              so its ink reaches this far from the centre (px), the
                              readings in the corners (fui_face_mono400.c)        */
    int16_t  wave_reach_earth; /* the same in EARTH, which takes the bottom centre */
    int16_t  sun_r;        /* the Sun's ring on the SUN card, px (colour: 112; the
                              card's other measures scale with it)                */
    uint32_t sun_u;        /* the three glyphs of the SUN card, Q16 px per unit   */
} fui_layout_t;

const fui_layout_t *fui_i_layout(uint8_t face);

/** The pixel that holds a Q8 coordinate. */
static inline int fui_i_px(fui_fx_t v)
{
    return (int)(v >> 8);
}

/* ------------------------------------------------------------------------- */
/* Painter: one pass over a screen, with or without a canvas                  */
/* ------------------------------------------------------------------------- */

#define FUI_LINE_LIVE    0x01u /* the text changes with time: re-check every Blink */
#define FUI_LINE_SECONDS 0x02u /* shows civil seconds: re-check every second too   */
/* A line that changes with time but KNOWS it cannot before some instant is
 * not flagged LIVE: it calls fui_i_line_until instead, and the UI task sleeps
 * through the Blinks in between (a countdown in Preons is otherwise formatted
 * 1,600 times for every time it changes). */

typedef struct fui_painter {
    fui_canvas_t       *canvas;  /* NULL: measure and hash only */
    const fui_ui_t     *ui;
    const fui_theme_t  *theme;
    const fui_layout_t *lay;
    fui_line_sink_t     sink;    /* tests / simulator: told every line (NULL in firmware) */
    void               *sink_ctx;
    uint8_t             lines;   /* text lines so far           */
    uint8_t             flags;   /* FUI_LINE_* of all of them   */
    uint8_t             pages;   /* pages of the card painted (1: not a paged screen) */
    frc_time_t          until;   /* soonest instant a line said it may change; FRC_TIME_NONE: none said */
    uint32_t            layout_hash;
    uint32_t            hash[FUI_MAX_LINES];
    int16_t             top[FUI_MAX_LINES], bottom[FUI_MAX_LINES];
} fui_painter_t;

/** A painter for the screen `ui` is on; `canvas` NULL to measure and hash only. */
void fui_i_painter_init(fui_painter_t *p, const fui_ui_t *ui, fui_canvas_t *canvas);
/** Paint the current screen of p->ui (fui_ui.c dispatches by status and screen). */
void fui_i_paint(fui_painter_t *p);

typedef enum fui_align {
    FUI_ALIGN_LEFT   = 0, /* x is the left edge  */
    FUI_ALIGN_CENTER = 1, /* x is the middle     */
    FUI_ALIGN_RIGHT  = 2  /* x is the right edge */
} fui_align_t;

/** One line of text: hashed, its rows recorded, drawn when there is a canvas.
 *  @return its width in pixels. */
int fui_i_text(fui_painter_t *p, const fui_text_style_t *style, int x, int y, fui_align_t align,
               const char *text, size_t bytes, unsigned flags);

/** "A line of this screen will not change before `t`" (a boundary the core
 *  gave). FRC_TIME_NONE, or an instant that is not in the future, means "I
 *  cannot tell": the lines are then re-checked every Blink, as LIVE ones are. */
void fui_i_line_until(fui_painter_t *p, frc_time_t t);
/** The same for a line that shows frc_format_span(span, 0) of the span from
 *  now to `boundary`: the core says when that text next changes
 *  (frc_span_next_change; fui_words.c). */
void fui_i_span_until(fui_painter_t *p, frc_time_t boundary);

/*
 * The text styles of the faces, built from the theme (fui_paint.c).
 *
 * SIZE RULE (DESIGN.md S3, "never smaller than 6.2 pt"): on a colour face a
 * line that tells something is drawn at 2 px per dot or more: 14 px capitals,
 * 1.9 mm on a 1.28 inch panel. One pixel per dot (0.95 mm capitals) is kept
 * for FURNITURE: a word beside a sign that already says it, and the Earth
 * hallmark of the round face. On the 128 x 64 one-bit face everything
 * written out uses the 5 x 7 font at 1 px per dot (1.2 mm on a 0.96 inch
 * panel, the size these displays are read at); the 3 x 5 dot font is drawn
 * at 2 px per dot only. The 400 x 300 paper face takes the colour faces'
 * sizes (2 px per dot, 3 for the title: 3 mm capitals on 4.2 inches), and
 * its label words are written at 2 px per dot too (no furniture there).
 */
typedef enum fui_style_id {
    FUI_STYLE_READING = 0, /* digits bone, unit letters ash, capitals; an Earth tail in ash */
    FUI_STYLE_READING_BIG, /* the reading row; on one bit the 3 x 5 dot font at 2 px per dot */
    FUI_STYLE_VALUE,       /* bone, AS WRITTEN on every face (case matters: "pB", "Tm")     */
    FUI_STYLE_LABEL,       /* ash capitals: a fact said in words (a band, a major's name)   */
    FUI_STYLE_NAME,        /* bone capitals: names, the status                              */
    FUI_STYLE_EARTH,       /* ash, as written: every Earth translation                      */
    FUI_STYLE_TITLE,       /* the level letter, large, lumen                                */
    FUI_STYLE_SOL,         /* the Sun's capitals                                            */
    FUI_STYLE_FURNITURE,   /* ash capitals at 1 px per dot: repeats what a sign beside it says */
    FUI_STYLE_MARK         /* ash, 1 px per dot, as written: the Earth hallmark             */
} fui_style_id_t;

fui_text_style_t fui_i_style(const fui_painter_t *p, fui_style_id_t id);

/*
 * A CARD: a column of centred lines that flows over as many PAGES as it
 * takes (fui_paint.c). The screen gives the card its PARTS, each a function
 * that writes lines which belong together:
 *   - a line too long for its row wraps, first where a " · " or a comma
 *     separates two facts, then at a space; all rows of a line stay on a page;
 *   - a part that does not fit what is left of a page starts the next page
 *     (a part taller than a page flows on, line by line);
 *   - every page is centred between the card's top and bottom, under the HEAD
 *     (rows the screen draws itself at the top of every page: a seal, glyphs);
 *   - only the page being shown (ui->page) reaches the painter, so only its
 *     lines are hashed and drawn.
 * To centre a page before drawing it, the parts are run several times: they
 * must do nothing but write lines.
 */
#define FUI_CARD_PAGES 8 /* pages whose centring is remembered; more still flow */

typedef struct fui_card fui_card_t;
typedef void (*fui_card_part_t)(fui_card_t *card);

struct fui_card {
    /* set by the screen before fui_i_card_run (fui_i_card_init gives the face's defaults) */
    fui_painter_t *p;
    char          *text;       /* scratch of FUI_TEXT_MAX bytes shared by the parts          */
    int16_t        top, bottom; /* rows of a page: head first, then the column              */
    int16_t        marks_y;    /* row of the page beads                                      */
    int16_t        gap;        /* blank rows between text rows                               */
    int16_t        head;       /* rows the screen draws at the top of every page             */
    int16_t        clip_cy, clip_r; /* a round column: rows are chords of this circle
                                       (clip_r 0: the face's width)                          */
    uint8_t        first_page; /* 1: page 0 is a figure the screen draws; lines start on 1   */
    /* the flow (fui_paint.c) */
    uint8_t        page;       /* the page being filled                                      */
    uint8_t        rows;       /* rows on it so far                                          */
    uint8_t        emit;       /* 0: measuring                                               */
    int16_t        y;          /* top of the next row                                        */
    int16_t        start[FUI_CARD_PAGES]; /* where each page's column starts (after centring) */
    int16_t       *ends;       /* while measuring: where each page's column ended, or NULL   */
    /* told by fui_i_card_run */
    int16_t        head_y;     /* top of the head on the page being shown                    */
};

void fui_i_card_init(fui_card_t *card, fui_painter_t *p, char *text);
/** Lay the parts out, send the shown page's lines to the painter, draw the
 *  page beads, set p->pages and card->head_y. */
void fui_i_card_run(fui_card_t *card, const fui_card_part_t *part, int parts);
/** For a part: one line, in a style of the face ... */
void fui_i_card_line(fui_card_t *card, fui_style_id_t style, const char *text, unsigned flags);
/** ... or in a style of the part's own (an ink the table does not have). */
void fui_i_card_styled(fui_card_t *card, const fui_text_style_t *style, const char *text, unsigned flags);
/** Two lines that stay on one page: a name and, under it, what is said of it. */
void fui_i_card_pair(fui_card_t *card, fui_style_id_t style, const char *text, fui_style_id_t under_style,
                     const char *under, unsigned flags);
/** Blank rows before the next line, unless it is the first of its page. */
void fui_i_card_space(fui_card_t *card, int rows);

/* ------------------------------------------------------------------------- */
/* Text assembly: pieces from the core joined with the face's own words       */
/* ------------------------------------------------------------------------- */

/* The longest single text the core writes is under 160 bytes (a full date). */
#define FUI_TEXT_MAX 176

typedef struct fui_str {
    char  *buf;
    size_t size, len;
} fui_str_t;

void fui_i_str_init(fui_str_t *s, char *buf, size_t size);
void fui_i_str_add(fui_str_t *s, const char *text);
/**
 * Keep what `s` holds from byte `from` on together on one row: its spaces
 * become no-break spaces (U+00A0), which a card never wraps at and the fonts
 * draw as a space. For ONE value the core wrote in several words: a span
 * ("29ι 7λ") split over two rows reads as two values. (Left as it is when
 * the buffer has no room for the longer spaces.)
 */
void fui_i_str_keep(fui_str_t *s, size_t from);
/**
 * Append what a core format function writes. Inside `call`, `at_` is where
 * to write and `room_` how much room there is:
 *     FUI_I_CORE(&s, frc_format_span(&span, 2, at_, room_));
 * A negative status appends nothing.
 */
#define FUI_I_CORE(s, call)                              \
    do {                                                 \
        char *at_ = (s)->buf + (s)->len;                 \
        size_t room_ = (s)->size - (s)->len;             \
        int n_ = (call);                                 \
        if (n_ > 0) {                                    \
            (s)->len += (size_t)n_;                      \
        } else {                                         \
            at_[0] = '\0';                               \
        }                                                \
    } while (0)

/* Pieces several screens share (fui_words.c). Each appends to `s`. */
typedef enum fui_civil_form {
    FUI_CIVIL_TIME = 0, /* "⊕ 14:00:00"                                   */
    FUI_CIVIL_FULL = 1, /* "⊕ THU 8 OCT 2026 · 14:00:00 UTC+2": a card line */
    FUI_CIVIL_DAY  = 2, /* "⊕ 9 OCT 2026 03:34"                           */
    FUI_CIVIL_NOW  = 3, /* "⊕ 2026-10-08 14:00:00"                        */
    FUI_CIVIL_FULL_MINUTE = 4, /* "⊕ THU 8 OCT 2026 · 14:00 UTC+2": FULL at a step */
    FUI_CIVIL_MINUTE = 5 /* "⊕ 14:00"                                      */
} fui_civil_form_t;
void fui_i_add_civil(fui_str_t *s, frc_time_t t, int32_t utc_offset_s, fui_civil_form_t form);
int fui_i_same_civil_day(frc_time_t a, frc_time_t b, int32_t utc_offset_s);
frc_time_t fui_i_next_midnight(frc_time_t t, int32_t utc_offset_s);
/** "End in 6ι 43λ". With a painter, also tells it until when that text holds
 *  (fui_i_span_until); pass NULL where the line is flagged LIVE anyway. A
 *  card wraps it only before "in": "in 6ι 43λ" is kept whole. */
void fui_i_add_countdown(fui_str_t *s, const fui_ui_t *ui, uint8_t level, fui_painter_t *p);
/** "Valley in 29ι 7λ": a quarter and the span to it, kept as fui_i_add_countdown
 *  keeps it, with no part finer than `finest` (fui_i_add_span_to). */
void fui_i_add_quarter_in(fui_str_t *s, frc_quarter_t quarter, const frc_span_t *span, frc_unit_t finest);
/** frc_format_span(span, 0), kept together (fui_i_str_keep): a level's length. */
void fui_i_add_span(fui_str_t *s, const frc_span_t *span);
/** The same with no part finer than `finest` (FRC_UNIT_BLINK: exactly
 *  fui_i_add_span): a countdown read at a step (fui_shim_format_span_to). */
void fui_i_add_span_to(fui_str_t *s, const frc_span_t *span, frc_unit_t finest);
/** The finest unit a reading shows: FRC_UNIT_BLINK without a step, else the
 *  finest unit not finer than the step level (the Preon at kappa). */
frc_unit_t fui_i_finest_unit(const fui_ui_t *ui);
/** 1 when the civil time shows seconds: no step, or the Flavon's. */
int fui_i_civil_seconds(const fui_ui_t *ui);
void fui_i_add_level_title(fui_str_t *s, uint8_t level);
/** The date's terms from `first` to `last` joined by spaces, each written by
 *  frc_format_date_term: "34η 29ι"; all nine are the stamp. */
void fui_i_add_date_terms(fui_str_t *s, const frc_date_t *date, frc_unit_t first, frc_unit_t last);

/* The Earth sign and friends as UTF-8 literals. */
#define FUI_S_EARTH  "\xE2\x8A\x95"  /* U+2295 */
#define FUI_S_RING   "\xE2\x97\x8B"  /* U+25CB: the empty ring of pure mode */
#define FUI_S_DOT    " \xC2\xB7 "    /* " · " */
#define FUI_S_ENDASH " \xE2\x80\x93 " /* " – " */
#define FUI_S_NBSP   "\xC2\xA0"     /* U+00A0: a space no row ends at (fui_i_str_keep) */

/* ------------------------------------------------------------------------- */
/* Model and ring                                                             */
/* ------------------------------------------------------------------------- */

/** Fill ui->reading from the core at ui->t (all "not valid" unless status OK). */
void fui_i_read(fui_ui_t *ui);
/** When the rings / glyphs of the current screen next change; FRC_TIME_NONE if never. */
frc_time_t fui_i_ring_next(const fui_ui_t *ui);

/** (Re)build ui->ring for the current focus and face if it is stale. */
void fui_i_ring_prepare(fui_ui_t *ui);

/** Where "now" is on the focused ring. */
typedef struct fui_ring_now {
    int      valid;
    fui_fx_t x, y;
} fui_ring_now_t;

/** The carrier, its first-level arcs and (colour, when cached) the second
 *  level, filled to the reading; returns the point of now. */
void fui_i_ring_paint(fui_painter_t *p, fui_ring_now_t *now);

/** A rasteriser arc from a cached one. */
fui_arc_t fui_i_arc(const fui_arc16_t *a);

/* ------------------------------------------------------------------------- */
/* Faces and screens: each paints one thing                                   */
/* ------------------------------------------------------------------------- */

void fui_i_instrument(fui_painter_t *p);   /* fui_instrument.c: the colour instrument     */
void fui_i_now_rows(fui_painter_t *p);     /* fui_screen_now.c: rows under it (rect faces) */
void fui_i_now_mono(fui_painter_t *p);     /* fui_face_mono.c: the 128 x 64 NOW / SCALES   */
void fui_i_wave(fui_painter_t *p);         /* fui_instrument.c: the paper face's wave alone */
void fui_i_now_corners(fui_painter_t *p);  /* fui_face_mono400.c: the paper face's corners  */
/** The style of the paper face's Earth time and the top of its cell: the
 *  wave keeps above it. fui_face_mono400.c */
int fui_i_paper_time(const fui_ui_t *ui, fui_text_style_t *style);
/** The reach the ring is fitted to on a wave face, Q8 (0: a face whose ring has
 *  the layout's radius). fui_ring.c */
fui_fx_t fui_i_wave_goal(const fui_ui_t *ui);
/** A drawn mark that stands for a line: rows [y0, y1) are redrawn when
 *  `what` changes (a shape the text lines do not cover). fui_paint.c */
void fui_i_mark(fui_painter_t *p, int y0, int y1, const void *what, size_t bytes);
/** The one-bit mark of now: a block 2 half + 1 px square (3 x 3 on the tiny
 *  face, 7 x 7 on the paper face's cards, 9 x 9 in its wave) in a 1 px frame
 *  cleared to the ground. fui_instrument.c */
void fui_i_now_block(fui_painter_t *p, fui_fx_t x, fui_fx_t y, int half, fui_color_t ink);
void fui_i_screen_lens(fui_painter_t *p);  /* fui_screen_lens.c  */
void fui_i_screen_sun(fui_painter_t *p);   /* fui_screen_sun.c   */
void fui_i_screen_stamp(fui_painter_t *p); /* fui_screen_stamp.c */
/** The lines said instead of a reading while status != OK; returns how many
 *  it wrote into `line` (each FUI_TEXT_MAX/4 bytes). fui_words.c */
int fui_i_status_lines(const fui_ui_t *ui, char line[3][44]);
/** The finest of the major levels (Delta), as frc_level_kind tells it. */
uint8_t fui_i_last_major(void);
/** A plain slotted ring (a counter ring, the Sun's ring). fui_instrument.c */
typedef struct fui_slots {
    fui_fx_t    cx, cy, r;
    uint8_t     count;       /* slots                                           */
    uint32_t    wide;        /* bit j: a wider gap before slot j (the Pentads of
                                the Sun's ring: ui->pentad_starts)              */
    int16_t     current;     /* running slot; -1: nothing lit                   */
    frc_frac_t  fraction;    /* how far the running slot is lit                 */
    fui_fx_t    gap;         /* pixels between slots along the ring             */
    fui_fx_t    width;
    fui_color_t done, lit, rest;
} fui_slots_t;
void fui_i_slots(fui_canvas_t *c, const fui_slots_t *s);

/* ------------------------------------------------------------------------- */
/* SHIM: stand-ins for what the core does not offer yet (AGENTS.md section   */
/* 10). Delete each when the core answers.                                    */
/* ------------------------------------------------------------------------- */

/** frc_format_span(span, max_parts) with no part finer than `finest`: the
 *  span cut toward zero to whole `finest` units; under one of them,
 *  frc_format_span_in_unit ("0ι"). FRC_UNIT_BLINK: frc_format_span itself.
 *  Wanted from the core as frc_format_span_to (section 10). fui_shim.c */
int fui_shim_format_span_to(const frc_span_t *span, uint8_t max_parts, frc_unit_t finest, char *buf, size_t size);

/* FNV-1a, the hash of scenes and lines. */
#define FUI_I_HASH_SEED 2166136261u
uint32_t fui_i_hash(uint32_t h, const void *data, size_t bytes);

#endif /* FUI_I_H */
