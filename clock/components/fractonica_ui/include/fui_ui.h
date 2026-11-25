/*
 * fui_ui.h - the clock's screens and its state machine. THE entry point of
 * fractonica_ui for firmware: events in, "what to redraw and when to wake" out.
 *
 * THE LOOP (the whole contract with the UI task)
 *
 *     static fui_ui_t ui;                       // all UI state: no heap
 *     fui_ui_init(&ui, &config);
 *     for (;;) {
 *         const fui_frame_t *f = fui_ui_update(&ui, now_us_or_FRC_TIME_NONE, monotonic_ms);
 *         if (f->redraw) {
 *             fui_ui_draw(&ui, &canvas);        // once, or once per band
 *             flush(f->dirty);                  // or the canvas's own dirty box
 *         }
 *         event = wait_for_input(f->sleep_us);  // -1: until an event
 *         if (event != FUI_EV_NONE) fui_ui_event(&ui, event, monotonic_ms);
 *     }
 *
 *   - `now` is Unix MICROSECONDS (frc_time_t), or FRC_TIME_NONE while the
 *     device does not know the time: the screens then say so instead of
 *     showing a wrong reading.
 *   - `monotonic_ms` only times the two brief labels (the level name after a
 *     scale step, the mode word after a toggle); it may wrap.
 *   - fui_ui_draw is a pure function of the state fui_ui_update left: call it
 *     again for every band of a banded canvas, it draws the same frame.
 *   - Nothing blinks: a frame is redrawn only because the clock moved, the
 *     user did something, or a brief label expired.
 *
 * NAVIGATION (four events)
 *
 *     NOW ──NEXT / PREV──▶ SCALES   focus one level finer / coarser (0..13,
 *      ▲  ◀─ 2.5 s without ─┘  │    wrapping); the level is named at the centre
 *      │       input           │
 *      │                     SELECT (the level just turned to is inspected)
 *      │                       ▼
 *      └────────SELECT───────▶ LENS ─SELECT─▶ SUN ─SELECT─▶ STAMP ─SELECT─▶ NOW
 *
 *     SELECT  always means "further": on a card with several PAGES it turns
 *             the page, and leaves the card from its last page.
 *     LENS    NEXT / PREV step the inspected level through ALL 63 (0..62,
 *             wrapping). Inspecting never refocuses the instrument: the focus
 *             changes on NOW / SCALES only (ruling 9: rungs 14..62 are
 *             inspectable, not focusable).
 *     SUN     NEXT = SELECT; PREV = a page back, then LENS   (an encoder roams)
 *     STAMP   NEXT = SELECT; PREV = a page back, then SUN's last page
 *     LONG    anywhere: PURE <-> EARTH. On NOW / SCALES the mode is named at
 *             the centre for 1.5 s.
 *
 * PAGES. Text on a card is never smaller than 2 px per dot on colour (DESIGN.md
 * S3), so a card that does not fit its face flows over as many pages as it
 * takes; the beads at the bottom count them. fui_ui_pages() tells how many.
 *
 * MODES
 *   PURE   only Fractonica: no date, hour, zone, hertz, metre, per cent.
 *   EARTH  adds the Gregorian / SI translation, every one led by the Earth
 *          sign, at the fixed UTC offset of the configuration.
 *
 * THE STEP (fui_ui_set_step, fui_config_t.step; for a panel that should move
 * seldom, such as e-paper, where every change is a partial refresh). With a
 * step level L (the Helion, theta, the Preon, kappa or the Flavon) every
 * screen shows the instant the running cycle of L BEGAN (frc_cycle_at's
 * start) and the frame asks to wake at its END: the face changes exactly on
 * each boundary of L and at no other time, except that input and the brief
 * labels (the level's name, the mode's) still redraw at once and clear on
 * time. Readings go down to L's unit and no finer: at the Preon the count
 * "34η 29ι" and the countdown in whole Preons; at the Flavon "34η 29ι 21λ"
 * and "6ι 44λ"; kappa and theta, which are not units, read down to the
 * Preon and the Helion; the paper face's corners end at the Preon. The
 * civil time of EARTH shows minutes ("⊕ 14:00")
 * at every step coarser than the Flavon. FUI_STEP_NONE (0, the default) is
 * the behaviour of every face without a step: unchanged.
 *
 * THE 400 x 300 PAPER FACE (FUI_FACE_MONO400X300). One bit, black ink on
 * white paper: its default theme, fui_theme_paper, paints the ground with
 * SET bits and every ink with CLEAR bits, which a panel whose memory holds
 * 1 = white (the Waveshare 4.2" e-paper) shows as black on white. Give
 * fui_ui_draw a FUI_FMT_MONO_ROW canvas of 400 x 300 over that memory (50
 * bytes a row, bit 7 = the leftmost pixel, 15,000 bytes; or a band of whole
 * rows); pass .theme = &fui_theme_mono for a panel whose 1 is black. NOW
 * (the owner's layout): the WAVE alone in the middle, the focused level's
 * two nested levels round an inner circle with the two glyphs, as large as
 * its room (one-bit rules: elapsed solid, to come dotted 1 on / 2 off, now a
 * block); in the corners the Nuclide "ε#5" (top left), the
 * Helion "34η" (top right), the Preon "29ι" (bottom right), and the Pentad's
 * mark (a pentagon round its numeral; bottom left), all in the monoline
 * stroke font fui_font_line (28 px capitals, a 3 px pen); EARTH adds the
 * civil time at the bottom centre in it (14 px, 1 px pen). Lines are 2 px
 * (arcs, the inner circle; to come dotted 2 on / 3 off), the glyphs' strokes
 * 3 px. The cards use the whole panel.
 */
#ifndef FUI_UI_H
#define FUI_UI_H

#include "fractonica.h"
#include "fui_canvas.h"
#include "fui_font.h"
#include "fui_raster.h"
#include "fui_theme.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum fui_face {
    FUI_FACE_ROUND240    = 0, /* 240 x 240 round colour (GC9A01): the instrument alone   */
    FUI_FACE_RECT240     = 1, /* 240 x 240 colour (ST7789): instrument + reading rows    */
    FUI_FACE_RECT240X320 = 2, /* 240 x 320 colour (ST7789): the same with more rows      */
    FUI_FACE_MONO128     = 3, /* 128 x 64 one-bit (SSD1306)                              */
    FUI_FACE_MONO400X300 = 4, /* 400 x 300 one-bit e-paper (Waveshare 4.2"): the wave and
                                 four corners, black on white (see THE 400 x 300 ...) */
    FUI_FACE_COUNT       = 5
} fui_face_t;

typedef enum fui_screen {
    FUI_SCREEN_NOW    = 0,
    FUI_SCREEN_SCALES = 1,
    FUI_SCREEN_LENS   = 2,
    FUI_SCREEN_SUN    = 3,
    FUI_SCREEN_STAMP  = 4,
    FUI_SCREEN_COUNT  = 5
} fui_screen_t;

typedef enum fui_mode {
    FUI_MODE_PURE  = 0,
    FUI_MODE_EARTH = 1
} fui_mode_t;

typedef enum fui_event {
    FUI_EV_NONE   = 0,
    FUI_EV_NEXT   = 1, /* encoder clockwise, "down" button            */
    FUI_EV_PREV   = 2, /* encoder counter-clockwise, "up" button      */
    FUI_EV_SELECT = 3, /* short press                                 */
    FUI_EV_LONG   = 4  /* long press                                  */
} fui_event_t;

typedef enum fui_status {
    FUI_STATUS_OK               = 0,
    FUI_STATUS_TIME_UNSET       = 1, /* now == FRC_TIME_NONE                   */
    FUI_STATUS_OUT_OF_CATALOGUE = 2  /* now outside the catalogue (ruling 7)   */
} fui_status_t;

/** Levels the instrument can focus: 0..FUI_FOCUS_MAX (depths 1..14, ruling 9). */
#define FUI_FOCUS_MAX 13
/** The focus a fresh clock starts on: the Helion. */
#define FUI_FOCUS_DEFAULT 6
/** How long SCALES names the level, and how long a mode toggle is named. */
#define FUI_NAME_MS  2500u
#define FUI_TOAST_MS 1500u

/** The levels a face may step by (see THE STEP above): the level's number. */
typedef enum fui_step {
    FUI_STEP_NONE   = 0,  /* no step: the face moves as the clock does (default)   */
    FUI_STEP_HELION = 6,  /* 5.052 h                                                */
    FUI_STEP_THETA  = 7,  /* 33.7 min                                               */
    FUI_STEP_PREON  = 8,  /* 8.421 min                                              */
    FUI_STEP_KAPPA  = 9,  /* 1.684 min                                              */
    FUI_STEP_FLAVON = 10  /* 7.773 s                                                */
} fui_step_t;

typedef struct fui_face_info {
    int16_t width, height;
    uint8_t mono;  /* 1: one-bit canvas (FUI_FMT_MONO_*), 0: RGB565 */
    uint8_t round; /* 1: only the inscribed circle is visible       */
} fui_face_info_t;

/** Size and kind of a face: what canvas to give fui_ui_draw. NULL if unknown. */
const fui_face_info_t *fui_face_info(fui_face_t face);

typedef struct fui_config {
    fui_face_t             face;
    const frc_catalogue_t *catalogue;    /* NULL: &FRC_SAROS_141                          */
    const fui_theme_t     *theme;        /* NULL: Astrolabe on colour, fui_theme_paper on
                                            FUI_FACE_MONO400X300, fui_theme_mono on the
                                            other one-bit face                            */
    int32_t                utc_offset_s; /* EARTH mode's fixed offset (ruling 6)          */
    uint32_t               min_frame_us; /* shortest time between two wakes; 0: 100 ms on
                                            colour (10 fps), 50 ms on one-bit             */
    fui_mode_t             mode;         /* start-up mode                                 */
    uint8_t                focus;        /* start-up focus, 0..FUI_FOCUS_MAX              */
    uint8_t                step;         /* fui_step_t; 0 (FUI_STEP_NONE): no step. Any
                                            other value is taken as no step               */
} fui_config_t;

/** What fui_ui_update tells the UI task. */
typedef struct fui_frame {
    uint8_t    redraw;    /* 1: call fui_ui_draw, then flush `dirty`                      */
    fui_rect_t dirty;     /* the screen rectangle that changed (the whole face, the
                             rows of the lines that changed, or the instrument)           */
    int64_t    sleep_us;  /* sleep this long unless an event arrives; -1: no deadline     */
    frc_time_t next_wake; /* now + sleep_us, or FRC_TIME_NONE (no deadline / no time)     */
} fui_frame_t;

/* ------------------------------------------------------------------------- */
/* State. The caller owns one fui_ui_t (static); treat the fields as private. */
/* ------------------------------------------------------------------------- */

/** One level's place at the model's instant, from frc_cycle_at. */
typedef struct fui_level {
    frc_frac_t phase;
    uint16_t   local;
    uint8_t    quarter;
    uint8_t    valid;
} fui_level_t;

/** Everything the rings and glyphs show, read from the core in one go. */
typedef struct fui_reading {
    fui_level_t level[FUI_FOCUS_MAX + 3]; /* levels 0 .. focus + 2                        */
    uint16_t    odometer[2];              /* the focus: two 2-stroke glyphs               */
    uint8_t     next_quarter;             /* frc_quarter_t of the focus's next threshold  */
    uint8_t     sun_valid;                /* a whole solar sync holds the instant         */
    uint8_t     sun_within;               /* Helion of the sync, 0..18                    */
    uint8_t     midnights;                /* EARTH: civil midnights inside the sync       */
    frc_frac_t  sun_phase;
    frc_frac_t  sun_slot_phase;           /* the running Helion's own phase: how far its
                                             slot of the Sun's ring is lit, whatever the
                                             instrument is focused on                     */
    uint16_t    sun_odometer[3];          /* three 2-stroke glyphs (SPEC S7.3)            */
    frc_frac_t  midnight[5];              /* their sync phases                            */
} fui_reading_t;

/** A cached arc of the focused ring: Q6 pixels, 12 bytes. */
typedef struct fui_arc16 {
    int16_t  cx, cy;
    uint16_t r;
    uint16_t start;
    int32_t  sweep;
} fui_arc16_t;

#define FUI_RING_CHILDREN 26 /* 2 x 13: the most first-level half-cycle arcs      */
#define FUI_RING_GRAND    72 /* the most second-level arcs worth drawing (18 x 4) */

/**
 * The geometry of the focused ring: float work done once per focus change
 * (frc_arc_child), then reused by every redraw and every band.
 */
typedef struct fui_ring {
    uint8_t     valid;
    uint8_t     focus;
    uint8_t     children;  /* 2 x frc_factor(focus)                                 */
    uint8_t     per_child; /* frc_factor(focus + 1), or 0: second level not drawn   */
    fui_fx_t    cx, cy, radius;
    fui_fx_t    reach_in;  /* nearest and farthest the arcs drawn (both levels) come */
    fui_fx_t    reach_out; /* to the centre: the bezel and the counter rings keep clear */
    fui_fx_t    goal;      /* the reach it was sized to (the paper face); 0: R fixed */
    fui_arc16_t arc[FUI_RING_CHILDREN + FUI_RING_GRAND];
} fui_ring_t;

#define FUI_MAX_LINES 16

typedef struct fui_ui {
    /* configuration */
    const frc_catalogue_t *cat;
    const fui_theme_t     *theme;
    int32_t                utc_offset_s;
    uint32_t               min_frame_us;
    uint8_t                face;
    /* where the user is */
    uint8_t                screen;      /* fui_screen_t                               */
    uint8_t                mode;        /* fui_mode_t                                 */
    uint8_t                focus;       /* 0..FUI_FOCUS_MAX                           */
    uint8_t                lens_level;  /* 0..62                                      */
    uint8_t                page;        /* page of the card being shown, 0-based;
                                           past the last one means "the last"         */
    uint8_t                toast;       /* 1 while the mode word is shown             */
    uint8_t                invalid;     /* 1: the next update redraws everything      */
    uint8_t                status;      /* fui_status_t at `t`                        */
    uint8_t                step;        /* fui_step_t                                 */
    uint32_t               scales_since_ms;
    uint32_t               toast_since_ms;
    /* the frame being shown */
    frc_time_t             t;           /* instant of the texts (with a step: the start
                                           of the step's running cycle)               */
    frc_time_t             ring_next;   /* when the rings / glyphs next change        */
    frc_time_t             text_next;   /* when the live text lines are next checked  */
    uint32_t               scene;       /* hash of everything but the time            */
    uint32_t               layout_hash; /* where the text lines sit                   */
    uint32_t               line_hash[FUI_MAX_LINES];
    uint8_t                line_count;
    uint32_t               pentad_starts; /* bit j: slot j of the Sun's ring begins a Pentad */
    fui_reading_t          reading;
    fui_ring_t             ring;
    fui_frame_t            frame;
} fui_ui_t;

/* ------------------------------------------------------------------------- */
/* API                                                                        */
/* ------------------------------------------------------------------------- */

/** Start on NOW with the configured mode, focus and step. Never fails: a bad
 *  face, focus or step falls back to FUI_FACE_ROUND240 / FUI_FOCUS_DEFAULT /
 *  FUI_STEP_NONE. */
void fui_ui_init(fui_ui_t *ui, const fui_config_t *config);

/**
 * Feed one input event (see NAVIGATION above).
 * @return 1 when the state changed: call fui_ui_update right away.
 */
int fui_ui_event(fui_ui_t *ui, fui_event_t event, uint32_t now_ms);

/**
 * Advance to instant `now` (FRC_TIME_NONE: time not set). Reads the core,
 * decides what changed and when to wake next. The returned frame is valid
 * until the next call. Cheap when nothing is due: a few integer compares.
 */
const fui_frame_t *fui_ui_update(fui_ui_t *ui, frc_time_t now, uint32_t now_ms);

/**
 * Draw the current frame's dirty rectangle into `canvas` (cleared to the
 * ground first). The canvas may be the whole face or a band of it
 * (fui_canvas_set_origin); the format must match fui_face_info().mono (one
 * bit: FUI_FMT_MONO_PAGE or FUI_FMT_MONO_ROW, the same picture in either;
 * which bit value is ink is the theme's: see THE 400 x 300 PAPER FACE).
 */
void fui_ui_draw(const fui_ui_t *ui, fui_canvas_t *canvas);

/** Make the next update redraw the whole face (after a display reset). */
void fui_ui_invalidate(fui_ui_t *ui);

/* Setters for restoring a saved state or applying a setting; each makes the
 * next update a full redraw. Out-of-range values are clamped. */
void fui_ui_set_mode(fui_ui_t *ui, fui_mode_t mode);
void fui_ui_set_focus(fui_ui_t *ui, uint8_t level);
void fui_ui_set_screen(fui_ui_t *ui, fui_screen_t screen);
void fui_ui_set_utc_offset(fui_ui_t *ui, int32_t utc_offset_s);

/**
 * THE STEP (see the top of this file): from the next update on, every screen
 * shows the instant the running cycle of level `level` began, and the frame
 * wakes at that cycle's end (fui_frame_t.next_wake == frc_cycle_at(...).end,
 * unless a brief label ends sooner). Levels: FUI_STEP_HELION 6, _THETA 7,
 * _PREON 8, _KAPPA 9, _FLAVON 10, or FUI_STEP_NONE (0) for none. The next
 * update redraws the whole face.
 * @return 1 when set; 0 for any other value (the step is left as it was).
 */
int fui_ui_set_step(fui_ui_t *ui, int level);

/** Pages of the card being shown (1 on NOW and SCALES). The page shown is
 *  ui->page, 0-based. */
uint8_t fui_ui_pages(const fui_ui_t *ui);

/**
 * For tests, the simulator and logs: every text row of the page being shown,
 * in the order painted, exactly as written (capitals are folded only when
 * drawn: see style->flags). (x, y) is the top left corner of the row's cell.
 * Nothing is drawn. The firmware does not need this.
 */
typedef void (*fui_line_sink_t)(void *ctx, const char *text, size_t bytes, int x, int y,
                                const fui_text_style_t *style);
void fui_ui_lines(const fui_ui_t *ui, fui_line_sink_t sink, void *ctx);

/** Names for logs and the simulator: "now", "pure", "round240". */
const char *fui_screen_name(fui_screen_t screen);
const char *fui_mode_name(fui_mode_t mode);
const char *fui_face_name(fui_face_t face);

#ifdef __cplusplus
}
#endif

#endif /* FUI_UI_H */
