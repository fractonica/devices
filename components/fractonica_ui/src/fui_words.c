/*
 * fui_words.c - phrases several screens share. Every number, name, span,
 * date term and civil text in them is written by the core; this file only
 * joins those pieces with the face's own furniture words ("IN", "TIME NOT
 * SET") and picks which of the core's civil forms a line uses.
 */
#include "fui_i.h"

/* Append frc_format_civil_text(civil, form); nothing when the core refuses. */
static void add_civil_form(fui_str_t *s, const frc_civil_t *civil, int32_t utc_offset_s, frc_civil_form_t form)
{
    FUI_I_CORE(s, frc_format_civil_text(civil, utc_offset_s, form, at_, room_));
}

/*
 * The Earth translation of an instant, in the core's civil wording
 * (frc_format_civil_text, DESIGN.md S9). Always led by the Earth sign.
 * EARTH mode only: the caller checks the mode.
 *   FUI_CIVIL_TIME   "⊕ 14:00:00"                         a moment of today
 *   FUI_CIVIL_FULL   "⊕ THU 8 OCT 2026 · 14:00:00 UTC+2"  now, with the zone: a card
 *                    line, which wraps only at the dot (date / time and zone)
 *   FUI_CIVIL_DAY    "⊕ 26 JAN 2028 17:07"                a moment of another day:
 *                    the date (with its year) matters more than the seconds
 *   FUI_CIVIL_NOW    "⊕ 2026-10-08 14:00:00"              now, on a row of the NOW face:
 *                    the ISO date, as the row has no room for the weekday and
 *                    the month's name (the zone is said on the SUN and STAMP cards)
 */
void fui_i_add_civil(fui_str_t *s, frc_time_t t, int32_t utc_offset_s, fui_civil_form_t form)
{
    frc_civil_t civil;
    size_t start;

    frc_civil_from_time(t, utc_offset_s, &civil);
    if (frc_civil_validate(&civil) != FRC_OK) {
        return;
    }
    start = s->len;
    fui_i_str_add(s, FUI_S_EARTH " ");
    switch (form) {
    case FUI_CIVIL_TIME:
        add_civil_form(s, &civil, utc_offset_s, FRC_CIVIL_TIME);
        break;
    case FUI_CIVIL_DAY:
        add_civil_form(s, &civil, utc_offset_s, FRC_CIVIL_DAY_MONTH_YEAR);
        fui_i_str_add(s, " ");
        add_civil_form(s, &civil, utc_offset_s, FRC_CIVIL_MINUTE);
        break;
    case FUI_CIVIL_NOW:
        add_civil_form(s, &civil, utc_offset_s, FRC_CIVIL_ISO_DATE);
        fui_i_str_add(s, " ");
        add_civil_form(s, &civil, utc_offset_s, FRC_CIVIL_TIME);
        break;
    default:
        /* FRC_CIVIL_DATE_TIME is DATE, " · ", TIME: written here as its two
         * halves so that each is kept whole and a card breaks at the dot. */
        add_civil_form(s, &civil, utc_offset_s, FRC_CIVIL_DATE);
        fui_i_str_keep(s, start);
        fui_i_str_add(s, FUI_S_DOT);
        start = s->len;
        add_civil_form(s, &civil, utc_offset_s, FRC_CIVIL_TIME);
        fui_i_str_add(s, " ");
        add_civil_form(s, &civil, utc_offset_s, FRC_CIVIL_OFFSET);
        fui_i_str_keep(s, start);
        break;
    }
}

/* The terms of the date from unit `first` to unit `last`, as the stamp
 * writes them, joined by spaces: "ε#5 34η 29ι 21λ 3ν" (frc_format_date_term;
 * Nuclide .. Blink). All nine are the stamp itself. */
void fui_i_add_date_terms(fui_str_t *s, const frc_date_t *date, frc_unit_t first, frc_unit_t last)
{
    int unit;

    for (unit = first; unit <= (int)last; unit++) {
        if (unit > (int)first) {
            fui_i_str_add(s, " ");
        }
        FUI_I_CORE(s, frc_format_date_term(date, (frc_unit_t)unit, at_, room_));
    }
}

/* 1 when `a` and `b` fall on the same civil day at the configured offset. */
int fui_i_same_civil_day(frc_time_t a, frc_time_t b, int32_t utc_offset_s)
{
    frc_civil_t ca, cb;

    frc_civil_from_time(a, utc_offset_s, &ca);
    frc_civil_from_time(b, utc_offset_s, &cb);
    return ca.year == cb.year && ca.month == cb.month && ca.day == cb.day;
}

/* The next civil midnight after `t` at the configured offset: when "today"
 * becomes another day. Earth arithmetic, done by the core's civil functions
 * (frc_time_from_civil carries day + 1 past the end of a month). */
frc_time_t fui_i_next_midnight(frc_time_t t, int32_t utc_offset_s)
{
    frc_civil_t civil;

    frc_civil_from_time(t, utc_offset_s, &civil);
    civil.day = (uint8_t)(civil.day + 1);
    civil.hour = 0;
    civil.minute = 0;
    civil.second = 0;
    civil.microsecond = 0;
    return frc_time_from_civil(&civil, utc_offset_s);
}

/*
 * How long the text of a countdown to `boundary` holds: the core says the
 * instant its text next changes (frc_span_next_change, max_parts 0 as
 * fui_i_add_span writes it), and the UI task sleeps until exactly then.
 * tests/test_ui.c "quiet lines" holds this against a look at every Blink.
 */
void fui_i_span_until(fui_painter_t *p, frc_time_t boundary)
{
    fui_i_line_until(p, frc_span_next_change(p->ui->cat, p->ui->t, boundary, 0));
}

/* "End in 6ι 43λ": the next threshold of a level as a span from now. */
void fui_i_add_countdown(fui_str_t *s, const fui_ui_t *ui, uint8_t level, fui_painter_t *p)
{
    frc_threshold_t next;
    frc_span_t span;

    if (frc_next_threshold(ui->cat, ui->t, level, &next) != FRC_OK || next.time == FRC_TIME_NONE ||
        frc_span_between(ui->cat, ui->t, next.time, &span) != FRC_OK) {
        if (p) {
            fui_i_line_until(p, FRC_TIME_NONE);
        }
        return;
    }
    fui_i_add_quarter_in(s, (frc_quarter_t)next.name, &span);
    if (p) {
        fui_i_span_until(p, next.time);
    }
}

void fui_i_add_span(fui_str_t *s, const frc_span_t *span)
{
    size_t start = s->len;

    FUI_I_CORE(s, frc_format_span(span, 0, at_, room_));
    fui_i_str_keep(s, start);
}

/* "Valley in 29ι 7λ": the row may end after the quarter's name, never inside
 * "in 29ι 7λ" (an orphan "7λ" would read as a value of its own). */
void fui_i_add_quarter_in(fui_str_t *s, frc_quarter_t quarter, const frc_span_t *span)
{
    FUI_I_CORE(s, frc_format_quarter(quarter, 0, at_, room_));
    fui_i_str_add(s, " in" FUI_S_NBSP);
    fui_i_add_span(s, span);
}

/* The finest major level: the last one the core calls FRC_KIND_MAJOR (Delta).
 * The words row and the counter rings ask this instead of knowing "3". */
uint8_t fui_i_last_major(void)
{
    uint8_t level = 0;

    while (level + 1 < FRC_LEVEL_COUNT && frc_level_kind((uint8_t)(level + 1)) == FRC_KIND_MAJOR) {
        level++;
    }
    return level;
}

/* "Helion" for a unit level, the letter's word ("Zeta") for the others. */
void fui_i_add_level_title(fui_str_t *s, uint8_t level)
{
    int unit = frc_unit_of_level(level);

    if (unit >= 0) {
        FUI_I_CORE(s, frc_format_unit_name((frc_unit_t)unit, 0, at_, room_));
    } else {
        FUI_I_CORE(s, frc_format_level_word(level, at_, room_));
    }
}

/*
 * What a face says instead of a reading. Pure-safe wording: no Earth unit.
 *   time not set        TIME / NOT SET
 *   out of catalogue    OUT OF / CATALOGUE / α#1 – α#18   (ruling 7; the two
 *                       Alpha names come from the core)
 */
int fui_i_status_lines(const fui_ui_t *ui, char line[3][44])
{
    fui_str_t s;
    uint64_t alphas;

    if (ui->status == FUI_STATUS_TIME_UNSET) {
        fui_i_str_init(&s, line[0], 44);
        fui_i_str_add(&s, "Time");
        fui_i_str_init(&s, line[1], 44);
        fui_i_str_add(&s, "not set");
        return 2;
    }
    if (ui->status == FUI_STATUS_OUT_OF_CATALOGUE) {
        fui_i_str_init(&s, line[0], 44);
        fui_i_str_add(&s, "Out of");
        fui_i_str_init(&s, line[1], 44);
        fui_i_str_add(&s, "catalogue");
        fui_i_str_init(&s, line[2], 44);
        alphas = frc_cycle_count(ui->cat, 0);
        FUI_I_CORE(&s, frc_format_cycle_name(0, 0, 1, at_, room_));
        fui_i_str_add(&s, FUI_S_ENDASH);
        FUI_I_CORE(&s, frc_format_cycle_name(0, alphas ? alphas - 1 : 0, 1, at_, room_));
        return 3;
    }
    return 0;
}

const char *fui_screen_name(fui_screen_t screen)
{
    static const char *const names[FUI_SCREEN_COUNT] = { "now", "scales", "lens", "sun", "stamp" };

    return (unsigned)screen < FUI_SCREEN_COUNT ? names[screen] : "?";
}

const char *fui_mode_name(fui_mode_t mode)
{
    return mode == FUI_MODE_EARTH ? "earth" : "pure";
}

const char *fui_face_name(fui_face_t face)
{
    static const char *const names[FUI_FACE_COUNT] = { "round240", "rect240", "rect240x320", "mono" };

    return (unsigned)face < FUI_FACE_COUNT ? names[face] : "?";
}
