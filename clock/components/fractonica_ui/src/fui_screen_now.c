/*
 * fui_screen_now.c - the rows of text under the instrument on the rectangular
 * colour faces (the round face has none: no words on the instrument).
 *
 *   words      "⬠II·2  DELTA TRIFRACTON · END"   240 x 320 only; furniture at
 *              1 px per dot: the SUN and STAMP cards say both at full size
 *   reading    "ε#5 34η 29ι 21λ 3ν"              the stamp's unit terms
 *   countdown  "η END IN 6ι 43λ"                 the focus's next threshold
 *   Earth      "⊕ 2026-10-08 14:00:00"           EARTH mode only
 *
 * Reading, countdown and Earth are 20 px rows (2 px per dot: the size rule
 * of fui_i.h). The civil time of the next threshold has no room at that size
 * here: the LENS card gives it ("END IN 6ι 43λ · ⊕ 14:56:12").
 *
 * Without a reading the rows say why (ruling 7: "the reading is replaced by
 * OUT OF CATALOGUE · α#1 – α#18"), and the instrument above stays engraved.
 *
 * Every row is a LIVE line: fui_ui_update re-checks them at each Blink and
 * redraws only the rows whose text changed.
 */
#include "fui_i.h"

/* The Pentad in its short form, then the finest major by name and quarter. */
static void words_row(fui_painter_t *p, int y)
{
    const fui_ui_t *ui = p->ui;
    char pentad_text[24], words[64];
    fui_text_style_t sol = fui_i_style(p, FUI_STYLE_FURNITURE), label = sol;
    uint8_t major = fui_i_last_major();
    frc_pentad_t pentad;
    frc_cycle_t cycle;
    frc_date_t date;
    fui_str_t s;
    int w_pentad = 0, w_words, x;

    sol.ink = p->theme->sol;
    pentad_text[0] = '\0';
    if (frc_pentad_at(ui->cat, ui->t, &pentad) == FRC_OK &&
        frc_format_pentad(&pentad, FRC_PENTAD_SHORT, 1, pentad_text, sizeof pentad_text) > 0) {
        w_pentad = fui_text_width(&sol, pentad_text, (size_t)-1) + 8;
    }
    fui_i_str_init(&s, words, sizeof words);
    if (frc_cycle_at(ui->cat, ui->t, major, &cycle) == FRC_OK && frc_date_at(ui->cat, ui->t, &date) == FRC_OK) {
        FUI_I_CORE(&s, frc_format_cycle_name(major, cycle.cycle, 0, at_, room_));
        fui_i_str_add(&s, FUI_S_DOT);
        FUI_I_CORE(&s, frc_format_quarter((frc_quarter_t)date.quarter[major], 0, at_, room_));
    }
    w_words = fui_text_width(&label, words, (size_t)-1);
    x = (p->lay->info.width - w_pentad - w_words) / 2;
    if (w_pentad) {
        fui_i_text(p, &sol, x, y, FUI_ALIGN_LEFT, pentad_text, (size_t)-1, FUI_LINE_LIVE);
    }
    fui_i_text(p, &label, x + w_pentad, y, FUI_ALIGN_LEFT, words, (size_t)-1, FUI_LINE_LIVE);
}

/* The unit terms of the stamp (the core's kind "unit"), Nuclide to the
 * Blink: "ε#5 34η 29ι 21λ 3ν". */
static void reading_row(fui_painter_t *p, int y)
{
    const fui_ui_t *ui = p->ui;
    char text[FUI_TEXT_MAX];
    fui_text_style_t style = fui_i_style(p, FUI_STYLE_READING_BIG);
    frc_date_t date;
    fui_str_t s;

    if (frc_date_at(ui->cat, ui->t, &date) != FRC_OK) {
        return;
    }
    fui_i_str_init(&s, text, sizeof text);
    fui_i_add_date_terms(&s, &date, FRC_UNIT_NUCLIDE, fui_i_finest_unit(ui)); /* (a step's unit) */
    fui_i_text(p, &style, p->lay->info.width / 2, y, FUI_ALIGN_CENTER, text, (size_t)-1, FUI_LINE_LIVE);
}

static void countdown_row(fui_painter_t *p, int y)
{
    const fui_ui_t *ui = p->ui;
    char text[96];
    fui_text_style_t style = fui_i_style(p, FUI_STYLE_READING);
    fui_str_t s;

    fui_i_str_init(&s, text, sizeof text);
    FUI_I_CORE(&s, frc_format_level_name(ui->focus, at_, room_));
    fui_i_str_add(&s, " ");
    /* LIVE: the reading above shows Blinks, so the row is looked at every
     * Blink. The countdown's own change instants (frc_span_next_change) are
     * NOT asked for here: they lie off the Blink grid, and waking for them
     * too costs 6,892 more wakes an hour at focus 8 (`make wakes`) for a text
     * that is then at most one Blink behind. The cards (LENS, SUN) do ask. */
    fui_i_add_countdown(&s, ui, ui->focus, NULL);
    fui_i_text(p, &style, p->lay->info.width / 2, y, FUI_ALIGN_CENTER, text, (size_t)-1, FUI_LINE_LIVE);
}

static void earth_row(fui_painter_t *p, int y)
{
    char text[64];
    fui_text_style_t style = fui_i_style(p, FUI_STYLE_EARTH);
    fui_str_t s;

    fui_i_str_init(&s, text, sizeof text);
    fui_i_add_civil(&s, p->ui->t, p->ui->utc_offset_s, FUI_CIVIL_NOW);
    if (!fui_i_civil_seconds(p->ui)) {
        /* a step coarser than the Flavon: "⊕ 2026-10-08 14:00" */
        fui_i_str_init(&s, text, sizeof text);
        fui_i_add_civil(&s, p->ui->t, p->ui->utc_offset_s, FUI_CIVIL_DAY);
    }
    fui_i_text(p, &style, p->lay->info.width / 2, y, FUI_ALIGN_CENTER, text, (size_t)-1,
               FUI_LINE_LIVE | FUI_LINE_SECONDS);
}

/* No reading: "TIME NOT SET", or "OUT OF CATALOGUE" over "α#1 – α#18". */
static void status_rows(fui_painter_t *p)
{
    const fui_layout_t *lay = p->lay;
    char line[3][44], text[96];
    fui_text_style_t name = fui_i_style(p, FUI_STYLE_NAME), range = fui_i_style(p, FUI_STYLE_READING);
    int n = fui_i_status_lines(p->ui, line);
    fui_str_t s;

    fui_i_str_init(&s, text, sizeof text);
    fui_i_str_add(&s, line[0]);
    fui_i_str_add(&s, " ");
    fui_i_str_add(&s, line[1]);
    fui_i_text(p, &name, lay->info.width / 2, lay->reading_y + (n > 2 ? 4 : 14), FUI_ALIGN_CENTER, text, (size_t)-1, 0);
    if (n > 2) {
        fui_i_text(p, &range, lay->info.width / 2, lay->countdown_y + 8, FUI_ALIGN_CENTER, line[2], (size_t)-1, 0);
    }
}

void fui_i_now_rows(fui_painter_t *p)
{
    const fui_layout_t *lay = p->lay;
    /* PURE has one row fewer: the others sit lower, evenly in the same space. */
    int earth = p->ui->mode == FUI_MODE_EARTH, spare = earth ? 0 : lay->info.height - lay->earth_y;

    if (lay->reading_y < 0) {
        return; /* the round face: the instrument's centre says everything */
    }
    if (p->ui->status != FUI_STATUS_OK) {
        status_rows(p);
        return;
    }
    if (lay->words_y >= 0) {
        words_row(p, lay->words_y + spare / 6);
        reading_row(p, lay->reading_y + spare / 3);
        countdown_row(p, lay->countdown_y + (spare * 2) / 3);
    } else {
        reading_row(p, lay->reading_y + spare / 3);
        countdown_row(p, lay->countdown_y + (spare * 2) / 3);
    }
    if (earth) {
        earth_row(p, lay->earth_y);
    }
}
