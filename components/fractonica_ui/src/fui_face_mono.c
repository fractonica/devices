/*
 * fui_face_mono.c - NOW and SCALES on the 128 x 64 one-bit face (DESIGN.md S11).
 *
 * Four marks carry everything: SOLID ARC = elapsed, DOTTED ARC = to come,
 * BLOCK = now, BEAD = count. No inverse video, no dithering, nothing blinks.
 *
 *   left 64 x 64    the focused ring: carrier R = 19 at (31.5, 31.5),
 *                   first-level arcs only, four 4 px quarter ticks, the now
 *                   block (3 x 3 with a cleared 1 px frame)
 *   right, top      the focus's sibling counter: a row of beads, 3 x 3 lit
 *                   through the running one, 1 x 1 for the rest
 *   right, middle   the two-glyph odometer at u = 10/3 px, 1 px ink, stems
 *                   on pixel columns 84 and 108
 *   right, bottom   the count ("34η 29ι") in the dot font at 2 px per dot:
 *                   the two terms of the date that the focus sits between;
 *                   two columns stay blank at the right edge
 *
 *   bottom left     EARTH only: the Earth sign, 5 x 5, in the corner the ring
 *                   leaves free. It stays while the mode does: the mode's name
 *                   in the bottom row is gone after 1.5 s.
 *
 * The bottom row is lent to a brief label after a scale step (the level's
 * name) or a mode toggle, with or without a reading; without one the middle
 * says why, in the 5 x 7 font.
 */
#include "fui_i.h"

#define RIGHT_X0   64  /* first column right of the ring          */
#define RIGHT_MID  96  /* centre of the right half's text         */
#define BEADS_X0   69
#define BEADS_Y    1
#define STEM_LEFT  FUI_FX(84.5)
#define STEM_TOP   FUI_FX(20.5)
#define STEM_PITCH FUI_FX(24)
#define COUNT_Y    48  /* cell top: body rows 50..59, descenders to 63 */

static void quarter_ticks(fui_painter_t *p)
{
    const fui_layout_t *lay = p->lay;
    /* 4 px long, ending 2 px inside the nearest the arcs come: pixels 9..12
     * from the centre pixel for the Helion. The centre is a pixel centre
     * (31.5), so WHOLE offsets put both ends of a tick on pixel centres and
     * the four ticks come out the same length at the same distance. (Ends on
     * pixel edges round one way: right and bottom sat a pixel further out.) */
    fui_fx_t outer = (p->ui->ring.reach_in - FUI_FX(2)) & ~(FUI_FX_ONE - 1);
    int i;

    if (outer > FUI_FX(12)) {
        outer = FUI_FX(12);
    }
    for (i = 0; i < 4; i++) {
        int32_t co = fui_cos((uint32_t)i * 0x4000u), si = fui_sin((uint32_t)i * 0x4000u);

        fui_draw_line(p->canvas, lay->cx + (fui_fx_t)(((int64_t)(outer - FUI_FX(3)) * co) >> 14),
                      lay->cy + (fui_fx_t)(((int64_t)(outer - FUI_FX(3)) * si) >> 14),
                      lay->cx + (fui_fx_t)(((int64_t)outer * co) >> 14),
                      lay->cy + (fui_fx_t)(((int64_t)outer * si) >> 14), FUI_FX_ONE, p->theme->etch3);
    }
}

/* The sibling counter of the focus (SPEC S6.1): one bead per cycle of the
 * parent, lit through the running one. */
static void bead_row(fui_painter_t *p)
{
    const fui_ui_t *ui = p->ui;
    const fui_level_t *focus = &ui->reading.level[ui->focus];
    /* Level 0 has no parent: its "siblings" are the Alphas of the catalogue. */
    uint64_t count = ui->focus ? frc_siblings(ui->focus) : frc_cycle_count(ui->cat, 0);
    int n = count > 20 ? 20 : (int)count, pitch, size, j;

    if (n <= 0) {
        return;
    }
    pitch = n <= 11 ? 5 : 58 / n; /* 13 siblings: 4 px; 18 Alphas: 3 px */
    size = pitch >= 4 ? 3 : 2;
    for (j = 0; j < n; j++) {
        if (focus->valid && j <= focus->local) {
            fui_canvas_fill_rect(p->canvas, BEADS_X0 + j * pitch, BEADS_Y, size, 3, p->theme->bone);
        } else {
            fui_canvas_pixel(p->canvas, BEADS_X0 + j * pitch + size / 2, BEADS_Y + 1, p->theme->bone);
        }
    }
}

/*
 * The bottom row: the count, or a label (a level's name after a scale step,
 * the mode after a toggle), always in the dot font at 2 px per dot, so it keeps its
 * size as the user steps through the levels. Centred under the odometer when
 * it fits there; a longer one ("η HELION" 64 px, "ε NUCLIDE" 70 px) ends at
 * LABEL_RIGHT and runs left into the corner the ring leaves free at these
 * rows: there the ring's ink ends at column 48 at the Helion and 41 at the
 * Nuclide (55 at theta, whose label is centred). test_ui "one-bit labels"
 * holds the gap. The 5 x 7 font is the last resort, for a wider text.
 */
#define LABEL_RIGHT 126 /* first column the label leaves blank: 2 px from the edge */
#define LABEL_LEFT  56

static void label_row(fui_painter_t *p, const char *text, size_t bytes)
{
    fui_text_style_t style = fui_i_style(p, FUI_STYLE_READING_BIG);
    int width = fui_text_width(&style, text, bytes);

    if (RIGHT_MID + (width + 1) / 2 <= LABEL_RIGHT) {
        fui_i_text(p, &style, RIGHT_MID, COUNT_Y, FUI_ALIGN_CENTER, text, bytes, 0);
    } else if (LABEL_RIGHT - width >= LABEL_LEFT) {
        fui_i_text(p, &style, LABEL_RIGHT, COUNT_Y, FUI_ALIGN_RIGHT, text, bytes, 0);
    } else {
        style = fui_i_style(p, FUI_STYLE_READING);
        fui_i_text(p, &style, LABEL_RIGHT, COUNT_Y + 3, FUI_ALIGN_RIGHT, text, bytes, 0);
    }
}

/*
 * The count under the odometer: the two date terms around the focus, as the
 * stamp writes them (frc_format_date_term): the first unit finer than the
 * focus and the one before it ("34η 29ι" for the Helion and for theta).
 */
static void count_row(fui_painter_t *p)
{
    const fui_ui_t *ui = p->ui;
    char text[FUI_TEXT_MAX];
    frc_date_t date;
    fui_str_t s;
    int unit;

    if (frc_date_at(ui->cat, ui->t, &date) != FRC_OK) {
        return;
    }
    for (unit = 1; unit < FRC_UNIT_BLINK && frc_unit_level((frc_unit_t)unit) <= ui->focus; unit++) {
    }
    fui_i_str_init(&s, text, sizeof text);
    fui_i_add_date_terms(&s, &date, (frc_unit_t)(unit - 1), (frc_unit_t)unit);
    label_row(p, text, s.len);
}

void fui_i_now_mono(fui_painter_t *p)
{
    const fui_ui_t *ui = p->ui;
    char text[3][44];
    fui_ring_now_t now;
    fui_str_t s;
    int i, n;

    if (p->canvas) {
        fui_i_ring_paint(p, &now);
        quarter_ticks(p);
        if (now.valid) {
            /* now = a 3 x 3 block with a 1 px cleared frame */
            int x = fui_i_px(now.x), y = fui_i_px(now.y);

            fui_canvas_fill_rect(p->canvas, x - 2, y - 2, 5, 5, p->theme->ground);
            fui_canvas_fill_rect(p->canvas, x - 1, y - 1, 3, 3, p->theme->lumen);
        }
        bead_row(p);
    }
    if (ui->mode == FUI_MODE_EARTH) {
        fui_text_style_t mark = fui_i_style(p, FUI_STYLE_MARK);

        fui_i_text(p, &mark, 0, 56, FUI_ALIGN_LEFT, FUI_S_EARTH, (size_t)-1, 0); /* dots on rows 57..61 */
    }
    if (ui->status != FUI_STATUS_OK) {
        fui_text_style_t style = fui_i_style(p, FUI_STYLE_NAME);

        n = fui_i_status_lines(ui, text);
        for (i = 0; i < n; i++) {
            fui_i_text(p, &style, RIGHT_MID, 16 + i * 10, FUI_ALIGN_CENTER, text[i], (size_t)-1, 0);
        }
    } else if (p->canvas) {
        fui_odometer_draw(p->canvas, ui->reading.odometer, 2, 2, STEM_LEFT, STEM_TOP, STEM_PITCH,
                          p->lay->u, p->theme->lumen);
    }
    /* The bottom row: a brief label answers the user even while there is no
     * reading (a clock without Wi-Fi boots that way); otherwise the count. */
    fui_i_str_init(&s, text[0], sizeof text[0]);
    if (ui->toast) {
        fui_i_str_add(&s, ui->mode == FUI_MODE_EARTH ? FUI_S_EARTH " Earth" : FUI_S_RING " Pure");
        label_row(p, text[0], s.len);
    } else if (ui->screen == FUI_SCREEN_SCALES) {
        FUI_I_CORE(&s, frc_format_level_name(ui->focus, at_, room_));
        fui_i_str_add(&s, " ");
        fui_i_add_level_title(&s, ui->focus);
        label_row(p, text[0], s.len);
    } else if (ui->status == FUI_STATUS_OK) {
        count_row(p);
    }
}
