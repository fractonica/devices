/*
 * fui_screen_stamp.c - STAMP: the moment written out in full (SPEC S15.3).
 *
 *   PENTAD II,                            a date leads with its Pentad
 *   2ND HELION
 *   α#6 β#4 γ#9 δ#3                       the stamp, broken where the notation
 *   ε#5 34η 29ι 21λ 3ν                    does when a row cannot hold it
 *   ⊕ THU 8 OCT 2026                      EARTH only
 *   14:00:00 UTC+2
 *                                         then, on the pages that follow:
 *   ALPHA HEXAFRACTON                     the major periods by name (bone), each
 *   VALLEY                                with its running quarter under it (ash)
 *   BETA TETRAFRACTON
 *   VALLEY ...
 *
 * Two parts of a card (fui_i.h): the moment, and the majors' names.
 * Without a reading (time not set, out of catalogue) the card says so.
 */
#include "fui_i.h"

/* --- the moment: Pentad, stamp, and in EARTH the civil date and time ------ */
static void part_moment(fui_card_t *card)
{
    fui_painter_t *p = card->p;
    const fui_ui_t *ui = p->ui;
    frc_pentad_t pentad;
    frc_date_t date;
    fui_str_t s;

    if (frc_pentad_at(ui->cat, ui->t, &pentad) == FRC_OK &&
        frc_format_pentad(&pentad, FRC_PENTAD_FULL, 1, card->text, FUI_TEXT_MAX) > 0) {
        fui_i_card_line(card, FUI_STYLE_SOL, card->text, FUI_LINE_LIVE);
    }
    fui_i_card_space(card, p->lay->info.mono ? 0 : 4);
    if (frc_date_at(ui->cat, ui->t, &date) == FRC_OK) {
        /* The stamp is the date's nine terms (frc_format_date_term). Wider
         * than the face's widest row, it breaks where the notation does:
         * the majors above, the units (Nuclide to Blink) below. (Each
         * half may still wrap at a space.) */
        fui_text_style_t style = fui_i_style(p, FUI_STYLE_READING);
        size_t units;

        fui_i_str_init(&s, card->text, FUI_TEXT_MAX);
        fui_i_add_date_terms(&s, &date, FRC_UNIT_ALPHA, FRC_UNIT_DELTA);
        units = s.len + 1;
        fui_i_str_add(&s, " ");
        fui_i_add_date_terms(&s, &date, FRC_UNIT_NUCLIDE, FRC_UNIT_BLINK);
        if (fui_text_width(&style, card->text, (size_t)-1) > p->lay->info.width - 8) {
            card->text[units - 1] = '\0'; /* the space before "ε#5" */
            fui_i_card_line(card, FUI_STYLE_READING, card->text, FUI_LINE_LIVE);
            fui_i_card_line(card, FUI_STYLE_READING, card->text + units, FUI_LINE_LIVE);
        } else {
            fui_i_card_line(card, FUI_STYLE_READING, card->text, FUI_LINE_LIVE);
        }
    }
    if (ui->mode == FUI_MODE_EARTH) {
        fui_i_card_space(card, p->lay->info.mono ? 0 : 4);
        fui_i_str_init(&s, card->text, FUI_TEXT_MAX);
        fui_i_add_civil(&s, ui->t, ui->utc_offset_s, FUI_CIVIL_FULL);
        fui_i_card_line(card, FUI_STYLE_EARTH, card->text, FUI_LINE_LIVE | FUI_LINE_SECONDS);
    }
}

/* --- the major periods by name, each with the quarter it is in ------------ */
static void part_majors(fui_card_t *card)
{
    const fui_ui_t *ui = card->p->ui;
    frc_date_t date;
    uint8_t level;

    if (frc_date_at(ui->cat, ui->t, &date) != FRC_OK) {
        return;
    }
    for (level = 0; frc_level_kind(level) == FRC_KIND_MAJOR; level++) {
        frc_cycle_t cycle;
        char quarter[24];

        if (frc_cycle_at(ui->cat, ui->t, level, &cycle) != FRC_OK ||
            frc_format_cycle_name(level, cycle.cycle, 0, card->text, FUI_TEXT_MAX) <= 0 ||
            frc_format_quarter((frc_quarter_t)date.quarter[level], 0, quarter, sizeof quarter) <= 0) {
            continue;
        }
        /* the name in bone, its quarter under it in ash: a pair, never parted */
        fui_i_card_pair(card, FUI_STYLE_NAME, card->text, FUI_STYLE_LABEL, quarter, FUI_LINE_LIVE);
    }
}

/* --- no reading: why ------------------------------------------------------ */
static void part_no_reading(fui_card_t *card)
{
    const fui_ui_t *ui = card->p->ui;
    char status[3][44];
    int n = fui_i_status_lines(ui, status), i;

    for (i = 0; i < n; i++) {
        fui_i_card_line(card, i < 2 ? FUI_STYLE_NAME : FUI_STYLE_READING, status[i], 0);
    }
}

void fui_i_screen_stamp(fui_painter_t *p)
{
    static const fui_card_part_t PARTS[] = { part_moment, part_majors };
    static const fui_card_part_t NO_READING[] = { part_no_reading };
    char text[FUI_TEXT_MAX];
    fui_card_t card;

    fui_i_card_init(&card, p, text);
    if (p->ui->status != FUI_STATUS_OK) {
        fui_i_card_run(&card, NO_READING, 1);
    } else {
        fui_i_card_run(&card, PARTS, 2);
    }
}
