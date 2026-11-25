/*
 * fui_face_mono400.c - the corners of the 400 x 300 paper face's NOW
 * (FUI_FACE_MONO400X300; the wave in the middle is fui_i_wave, fui_instrument.c).
 * The owner's layout (2026-11-24):
 *
 *     ε#5                              34η     the Nuclide         the Helion
 *
 *                     (the wave)
 *
 *     ⬠                    ⊕ 13:57      29ι     the Pentad's mark    the Preon
 *     II                (EARTH only)
 *
 * Each count is one term of the stamp as the core writes it
 * (frc_format_date_term): the Nuclide is an ordinal in its Delta ("ε#5",
 * 1..5), the Helion an ordinal in its Nuclide ("34η", 1..77), the Preon a
 * count of the Preons done in the Helion ("29ι", 0..35). The monoline
 * stroke font fui_font_line (the owner's choice): 28 px capitals, a 3 px
 * pen, "77η" 52 px wide; the counts on the right ended 8 px from the edge. With a step coarser
 * than the Preon (the Helion's, theta's) the Preon is finer than the step
 * and is not shown.
 *
 * The Pentad's mark (SPEC S7.5, reference/js ui/pentad.js): a regular
 * pentagon standing on its base round the core's numeral (28 px, serifed)
 * (FRC_PENTAD_NUMERAL: "I", "II", "III"); the Hypopentad's is a square, empty
 * (the core writes no numeral for it). Nothing when the core has no Pentad.
 *
 * EARTH adds the civil time, small (the same font at 14 px), at the bottom
 * centre: the wave is sized smaller in EARTH to stay 4 px above it (122 px
 * from the centre, fui_i_wave_goal). Minutes at a step coarser than the
 * Flavon, seconds otherwise.
 *
 * Without a reading the corners are empty: the centre says why.
 */
#include "fui_i.h"

#define MARGIN    8  /* from the panel's edges to the ink                   */

/* The corners' three sizes of the monoline font: the counts and the
 * Pentad's numeral at 2 px per dot (28 px capitals, a 3 px pen), the Earth
 * time at 1 (14 px, a 1 px pen). */
static fui_text_style_t corner_style(const fui_painter_t *p, int which)
{
    fui_text_style_t s = fui_i_style(p, which == 2 ? FUI_STYLE_EARTH : which == 1 ? FUI_STYLE_NAME
                                                                     : FUI_STYLE_READING_BIG);

    s.font = &fui_font_line;
    s.scale = (uint8_t)(which == 2 ? 1 : 2);
    return s;
}

int fui_i_paper_time(const fui_ui_t *ui, fui_text_style_t *style)
{
    fui_painter_t p;

    fui_i_painter_init(&p, ui, NULL);
    *style = corner_style(&p, 2);
    return fui_i_layout(ui->face)->info.height - MARGIN - style->font->baseline * style->scale;
}
#define MARK_BOX  60 /* the Pentad's mark: the reference's 12-unit box, px
                        (a pentagon 50 px tall: "III" at 3 px per dot fits) */
#define MARK_LINE FUI_FX(3)

/* One corner count: the term of `unit`, its capitals' top or bottom MARGIN
 * from the panel's edge, left- or right-aligned. Holds until that unit's
 * cycle ends. */
static void corner(fui_painter_t *p, const frc_date_t *date, frc_unit_t unit, int top, fui_align_t align)
{
    const fui_layout_t *lay = p->lay;
    fui_text_style_t big = corner_style(p, 0);
    char text[16];
    frc_cycle_t cycle;
    fui_str_t s;
    int x = align == FUI_ALIGN_LEFT ? MARGIN : lay->info.width - MARGIN, y;

    y = top ? MARGIN - big.font->cap_top * big.scale : lay->info.height - MARGIN - big.font->baseline * big.scale;
    fui_i_str_init(&s, text, sizeof text);
    FUI_I_CORE(&s, frc_format_date_term(date, unit, at_, room_));
    fui_i_text(p, &big, x, y, align, text, s.len, 0);
    fui_i_line_until(p, frc_cycle_at(p->ui->cat, p->ui->t, frc_unit_level(unit), &cycle) == FRC_OK ? cycle.end
                                                                                                     : FRC_TIME_NONE);
}

/* The Pentad's mark in the bottom left corner. */
static void pentad_mark(fui_painter_t *p)
{
    const fui_ui_t *ui = p->ui;
    const fui_layout_t *lay = p->lay;
    fui_text_style_t numeral = corner_style(p, 1);
    /* the reference's 12 x 12 box: a pentagon round (6, 6.55) of radius 5.55,
     * a square from 1.75 to 10.25; here MARK_BOX px, its bottom MARGIN up */
    /* (the base, at 11.04 units, is a 3 px band ending on the counts' last row) */
    int x0 = MARGIN, y0 = lay->info.height - MARGIN - 2 - (MARK_BOX * 1104) / 1200, i;
    fui_fx_t cx = FUI_FX(x0) + FUI_FX(MARK_BOX) / 2, cy = FUI_FX(y0) + (FUI_FX(MARK_BOX) * 655) / 1200;
    fui_fx_t r = (FUI_FX(MARK_BOX) * 555) / 1200, px[5], py[5];
    frc_pentad_t pentad;
    char text[8];
    int n;

    if (frc_pentad_at(ui->cat, ui->t, &pentad) != FRC_OK) {
        return;
    }
    fui_i_line_until(p, pentad.end);
    fui_i_mark(p, y0, lay->info.height - MARGIN + 2, &pentad.index, sizeof pentad.index);
    n = frc_format_pentad(&pentad, FRC_PENTAD_NUMERAL, 0, text, sizeof text);
    if (p->canvas) {
        if (pentad.index == 3) {
            /* the Hypopentad: a square of about the pentagon's weight */
            fui_fx_t a = FUI_FX(x0) + (FUI_FX(MARK_BOX) * 175) / 1200, b = FUI_FX(x0) + (FUI_FX(MARK_BOX) * 1025) / 1200;
            fui_fx_t ay = FUI_FX(y0) + (FUI_FX(MARK_BOX) * 175) / 1200, by = FUI_FX(y0) + (FUI_FX(MARK_BOX) * 1025) / 1200;

            px[0] = a; py[0] = ay;
            px[1] = b; py[1] = ay;
            px[2] = b; py[2] = by;
            px[3] = a; py[3] = by;
            for (i = 0; i < 4; i++) {
                fui_draw_line(p->canvas, px[i], py[i], px[(i + 1) % 4], py[(i + 1) % 4], MARK_LINE, p->theme->bone);
            }
        } else {
            for (i = 0; i < 5; i++) {
                /* from 12 o'clock, a fifth of a turn each (65536 a turn, 0 at 3 o'clock) */
                uint32_t angle = 0xC000u + (uint32_t)((i * FUI_TURN) / 5);

                px[i] = cx + (fui_fx_t)(((int64_t)r * fui_cos(angle)) >> 14);
                py[i] = cy + (fui_fx_t)(((int64_t)r * fui_sin(angle)) >> 14);
            }
            for (i = 0; i < 5; i++) {
                fui_draw_line(p->canvas, px[i], py[i], px[(i + 1) % 5], py[(i + 1) % 5], MARK_LINE, p->theme->bone);
            }
            for (i = 0; i < 5; i++) {
                /* round the corners the stacked lines leave notched */
                fui_fill_disc(p->canvas, px[i], py[i], FUI_FX(1.6), p->theme->bone);
            }
        }
    }
    /* the numeral's capitals centred at 6.3 of the box's 12 units down when
     * 21 px tall (a little above the pentagon's centre, 6.55, where it is
     * wider, so "III" keeps 2 px from both sides), at 6.6 when 28 px (its
     * serifs then keep 3 px from the slopes at the top) */
    {
        int caps = (numeral.font->baseline - numeral.font->cap_top) * numeral.scale;
        int centre = y0 + (MARK_BOX * (caps > 24 ? 66 : 63)) / 120;

        fui_i_text(p, &numeral, fui_i_px(cx), centre - numeral.font->cap_top * numeral.scale - caps / 2,
                   FUI_ALIGN_CENTER, text, n > 0 ? (size_t)n : 0, 0);
    }
}

void fui_i_now_corners(fui_painter_t *p)
{
    const fui_ui_t *ui = p->ui;
    const fui_layout_t *lay = p->lay;
    frc_date_t date;

    if (ui->status != FUI_STATUS_OK || frc_date_at(ui->cat, ui->t, &date) != FRC_OK) {
        return; /* the centre of the wave says why */
    }
    corner(p, &date, FRC_UNIT_NUCLIDE, 1, FUI_ALIGN_LEFT);
    corner(p, &date, FRC_UNIT_HELION, 1, FUI_ALIGN_RIGHT);
    if (fui_i_finest_unit(ui) >= FRC_UNIT_PREON) {
        corner(p, &date, FRC_UNIT_PREON, 0, FUI_ALIGN_RIGHT);
    }
    pentad_mark(p);

    if (ui->mode == FUI_MODE_EARTH) {
        fui_text_style_t small;
        int seconds = fui_i_civil_seconds(ui), y = fui_i_paper_time(ui, &small);
        char text[32];
        fui_str_t s;

        fui_i_str_init(&s, text, sizeof text);
        fui_i_add_civil(&s, ui->t, ui->utc_offset_s, seconds ? FUI_CIVIL_TIME : FUI_CIVIL_MINUTE);
        fui_i_text(p, &small, fui_i_px(lay->cx), y, FUI_ALIGN_CENTER, text, s.len, seconds ? FUI_LINE_SECONDS : 0u);
    }
}
