/*
 * fui_screen_lens.c - LENS: the card of one level, any of the 63.
 *
 *   (seal) η                            colour faces, the head of every page:
 *                                       the level's ring in miniature, its letter
 *   HELION · UNIT · DEPTH 7             WHAT IT IS: name (unit name, or the letter's
 *   11 IN ζ · MADE OF 9 θ               word), kind, depth; cycles per parent,
 *                                       children per cycle (nothing above α, nothing
 *                                       below ο2: the ladder ends there)
 *   1η · 36ι · 2 340λ                   HOW LONG: its length as a span, then counted
 *   1 per 58 500 Blinks                 in finer units; its rate ("7 pB" below the Blink)
 *   END IN 6ι 43λ · ⊕ 14:56:12          WHEN: the next threshold, levels 0..12 (changes
 *                                       with time); EARTH adds its civil time, or a
 *                                       line "⊕ 25 JAN 2028 17:07" when it is another day
 *   AUDIBLE                             AS A WAVE: its band, or NO BAND (ruling 4; the one
 *   1η light · ⊕ 5.453 Tm               red of the design for the visible rung); the
 *   ⊕ 5.052 h · 54.98 µHz               length light covers in a cycle; EARTH adds the
 *                                       metres beside it, period and frequency under it
 *   BOUNDED 24ι 1λ · DIAMOND 3.5ν       240 x 320 only: the same length in the six
 *   WATER 2.05ξ · AIR 5.15ο             other media of SPEC S16.3, as spans of light
 *   NERVE 1.80ο · CHEMICAL 6.15χ
 *
 * Each group above is one PART of the card (fui_i.h): a part is kept on one
 * page, and the card takes the pages it needs at 2 px per dot (two or three
 * on the 240 x 240 faces, two on 128 x 64, one on 240 x 320 in PURE and on
 * the 400 x 300 paper face).
 *
 * EARTH only ever adds (DESIGN.md S1.5): no Fractonica line gives way to a
 * translation, on any face.
 *
 * Every value is formatted by the core (frc_format_level_in_unit, _level_rate,
 * _light_span, _period, _frequency, _length ...); this file orders the lines.
 * The ladder is laid from the Saros interval that holds the instant
 * (frc_interval_at), or the reference interval while the time is unknown.
 */
#include "fui_i.h"

/* The Saros interval the Earth figures and the bands are computed for. */
static frc_interval_t lens_interval(const fui_ui_t *ui)
{
    frc_interval_t interval;

    if (ui->status != FUI_STATUS_OK || frc_interval_at(ui->cat, ui->t, &interval) != FRC_OK) {
        interval.num = FRC_INTERVAL_REFERENCE_MS;
        interval.den = 1;
    }
    return interval;
}

/* A level's seal (DESIGN.md S5): carrier + its 2 x factor first-level arcs.
 * The icon IS the factor: beta's and gamma's differ because 13 != 5. */
static void seal(fui_painter_t *p, uint8_t level, int cx, int cy, fui_color_t ink)
{
    frc_arc_t root, child;
    fui_arc_t arc;
    uint8_t slots = (uint8_t)(2 * frc_factor(level)), j;

    root.cx = (float)cx + 0.5f;
    root.cy = (float)cy + 0.5f;
    root.radius = 9.0f;
    root.start = -FRC_PI / 2.0f;
    root.sweep = 2.0f * FRC_PI;
    arc = fui_arc_from_frc(&root);
    fui_draw_arc(p->canvas, &arc, FUI_FX_ONE, p->theme->etch2);
    for (j = 0; j < slots; j++) {
        child = frc_arc_child(&root, slots, j, j & 1);
        arc = fui_arc_from_frc(&child);
        fui_draw_arc(p->canvas, &arc, FUI_FX_ONE, ink);
    }
}

/* 1 when the `bytes` bytes at `a` and at `b` are the same text. */
static int same_text(const char *a, const char *b, size_t bytes)
{
    while (bytes > 0 && *a == *b) {
        a++;
        b++;
        bytes--;
    }
    return bytes == 0;
}

/* --- what it is: name, kind, depth; its place among its neighbours -------- */
static void part_identity(fui_card_t *card)
{
    const fui_ui_t *ui = card->p->ui;
    uint8_t level = ui->lens_level;
    fui_str_t s;

    fui_i_str_init(&s, card->text, FUI_TEXT_MAX);
    if (card->head == 0) {
        /* no head on this face (one bit): the letter leads the first line */
        FUI_I_CORE(&s, frc_format_level_name(level, at_, room_));
        fui_i_str_add(&s, " ");
    }
    fui_i_add_level_title(&s, level);
    fui_i_str_add(&s, FUI_S_DOT);
    FUI_I_CORE(&s, frc_format_level_kind(frc_level_kind(level), at_, room_));
    fui_i_str_add(&s, FUI_S_DOT "depth ");
    FUI_I_CORE(&s, frc_format_count((uint64_t)level + 1, at_, room_));
    fui_i_card_line(card, FUI_STYLE_READING, card->text, 0);

    /* "11 in ζ · made of 9 θ" (frc_format_level_in_parent, _children). The
     * ladder has no rung above the first and none below the last (SPEC: "the
     * ladder ends at depth 63 and an implementation gives nothing below it",
     * although the core can NAME a level 63, "π2"); the core refuses both. */
    fui_i_str_init(&s, card->text, FUI_TEXT_MAX);
    if (level > 0) {
        FUI_I_CORE(&s, frc_format_level_in_parent(level, at_, room_));
    }
    if (level + 1 < FRC_LEVEL_COUNT) {
        if (level > 0) {
            fui_i_str_add(&s, FUI_S_DOT);
        }
        fui_i_str_add(&s, "made of ");
        FUI_I_CORE(&s, frc_format_level_children(level, at_, room_));
    }
    fui_i_card_line(card, FUI_STYLE_READING, card->text, 0);
}

/* --- how long: a span, whole counts of up to two finer units, the rate ---- */
static void part_size(fui_card_t *card)
{
    uint8_t level = card->p->ui->lens_level;
    frc_span_t span;
    fui_str_t s;
    int unit, shown;

    if (level <= frc_unit_level(FRC_UNIT_BLINK) && frc_span_of_level(level, &span) == FRC_OK) {
        size_t lead;

        fui_i_str_init(&s, card->text, FUI_TEXT_MAX);
        fui_i_add_span(&s, &span);
        lead = s.len;
        for (unit = 0, shown = 0; unit < FRC_UNIT_COUNT && shown < 2; unit++) {
            size_t before = s.len, piece;

            if (frc_unit_level((frc_unit_t)unit) <= level) {
                continue;
            }
            fui_i_str_add(&s, FUI_S_DOT);
            piece = s.len;
            FUI_I_CORE(&s, frc_format_level_in_unit(level, (frc_unit_t)unit, at_, room_));
            /* A level between two units is led by the finer one already
             * ("11η" for zeta): the count in that unit is the span itself,
             * byte for byte. Said once. */
            if (s.len - piece == lead && same_text(card->text, card->text + piece, lead)) {
                s.len = before;
                card->text[before] = '\0';
                continue;
            }
            shown++;
        }
        fui_i_card_line(card, FUI_STYLE_VALUE, card->text, 0);
    }
    fui_i_str_init(&s, card->text, FUI_TEXT_MAX);
    FUI_I_CORE(&s, frc_format_level_rate(level, 4, at_, room_));
    fui_i_card_line(card, FUI_STYLE_VALUE, card->text, 0);
}

/* --- when: the next threshold, while a cycle outlasts a Blink ------------- */
static void part_threshold(fui_card_t *card)
{
    fui_painter_t *p = card->p;
    const fui_ui_t *ui = p->ui;
    uint8_t level = ui->lens_level;
    frc_threshold_t next;
    fui_str_t s;
    int when, today;

    if (ui->status != FUI_STATUS_OK || level > frc_unit_level(FRC_UNIT_BLINK)) {
        return;
    }
    next.name = FRC_PEAK;
    next.time = FRC_TIME_NONE;
    when = ui->mode == FUI_MODE_EARTH && frc_next_threshold(ui->cat, ui->t, level, &next) == FRC_OK &&
           next.time != FRC_TIME_NONE;
    today = when && fui_i_same_civil_day(ui->t, next.time, ui->utc_offset_s);

    fui_i_str_init(&s, card->text, FUI_TEXT_MAX);
    /* Not LIVE: the countdown tells the painter how long its text holds,
     * and the threshold's own time changes only when the countdown does. */
    fui_i_add_countdown(&s, ui, level, p);
    if (today) {
        fui_i_str_add(&s, FUI_S_DOT);
        fui_i_add_civil(&s, next.time, ui->utc_offset_s, FUI_CIVIL_TIME);
    }
    fui_i_card_line(card, FUI_STYLE_READING, card->text, 0);
    if (when && !today) {
        /* another day: a time alone would mislead, so the date gets a line */
        fui_i_str_init(&s, card->text, FUI_TEXT_MAX);
        fui_i_add_civil(&s, next.time, ui->utc_offset_s, FUI_CIVIL_DAY);
        fui_i_card_line(card, FUI_STYLE_EARTH, card->text, 0);
        /* at midnight it may have become "today" and move up a line */
        fui_i_line_until(p, fui_i_next_midnight(ui->t, ui->utc_offset_s));
    }
}

/* --- as a wave: band, the span of light, and the Earth translation -------- */
static void part_wave(fui_card_t *card)
{
    fui_painter_t *p = card->p;
    const fui_ui_t *ui = p->ui;
    uint8_t level = ui->lens_level;
    int earth = ui->mode == FUI_MODE_EARTH;
    frc_interval_t interval = lens_interval(ui);
    frc_band_t band = frc_band(level, interval);
    fui_str_t s;

    {
        /* "audible", "gamma ray"; a rung outside every band reads "no band"
         * (ruling 4), in the same ash: it is a fact about the rung too. */
        fui_text_style_t style = fui_i_style(p, FUI_STYLE_LABEL);

        if (band == FRC_BAND_VISIBLE) {
            style.ink = p->theme->h_alpha; /* DESIGN.md S2: the one red, for the rung that is light */
        }
        fui_i_str_init(&s, card->text, FUI_TEXT_MAX);
        FUI_I_CORE(&s, frc_format_band(band, at_, room_));
        fui_i_card_styled(card, &style, card->text, 0);
    }
    /* The length, said as a span of light (ruling 2). EARTH never replaces
     * it: the metres are set beside it and the period and frequency under. */
    fui_i_str_init(&s, card->text, FUI_TEXT_MAX);
    FUI_I_CORE(&s, frc_format_light_span(level, frc_medium_speed(FRC_MEDIUM_VACUUM), 1, at_, room_));
    fui_i_str_keep(&s, 0); /* "24ι 1λ light" is one value */
    if (earth) {
        fui_i_str_add(&s, FUI_S_DOT FUI_S_EARTH " ");
        FUI_I_CORE(&s, frc_format_length(level, interval, frc_medium_speed(FRC_MEDIUM_VACUUM), 4, at_, room_));
    }
    fui_i_card_line(card, FUI_STYLE_VALUE, card->text, 0);
    if (earth) {
        fui_i_str_init(&s, card->text, FUI_TEXT_MAX);
        fui_i_str_add(&s, FUI_S_EARTH " ");
        FUI_I_CORE(&s, frc_format_period(level, interval, 4, at_, room_));
        fui_i_str_add(&s, FUI_S_DOT);
        FUI_I_CORE(&s, frc_format_frequency(level, interval, 4, at_, room_));
        fui_i_card_line(card, FUI_STYLE_EARTH, card->text, 0);
    }
}

/* --- the tall face has room for the other media (DESIGN.md S9: "media as
 * spans of light"): how far a wave of each travels in one cycle, said as the
 * span light needs for it; a medium by the core's name for it. Two to a line;
 * the " · " lets a pair that is too wide break into two rows. ------------- */
static void add_medium(fui_str_t *s, uint8_t level, int medium)
{
    size_t start;

    FUI_I_CORE(s, frc_format_medium_id((frc_medium_t)medium, at_, room_));
    fui_i_str_add(s, " ");
    start = s->len;
    FUI_I_CORE(s, frc_format_light_span(level, frc_medium_speed((frc_medium_t)medium), 0, at_, room_));
    fui_i_str_keep(s, start);
}

static void part_media(fui_card_t *card)
{
    const fui_layout_t *lay = card->p->lay;
    uint8_t level = card->p->ui->lens_level;
    fui_str_t s;
    int medium;

    if (lay->tiny || lay->info.height <= lay->info.width) {
        return; /* only where a page has room for them beside the rest */
    }
    for (medium = FRC_MEDIUM_BOUNDED; medium < FRC_MEDIUM_COUNT; medium += 2) {
        fui_i_str_init(&s, card->text, FUI_TEXT_MAX);
        add_medium(&s, level, medium);
        if (medium + 1 < FRC_MEDIUM_COUNT) {
            fui_i_str_add(&s, FUI_S_DOT);
            add_medium(&s, level, medium + 1);
        }
        fui_i_card_line(card, FUI_STYLE_READING, card->text, 0);
    }
}

/* --- static facts need no clock, but say so when there is none ------------ */
static void part_status(fui_card_t *card)
{
    const fui_ui_t *ui = card->p->ui;
    char status[3][44];
    fui_str_t s;
    int n, i;

    if (ui->status == FUI_STATUS_OK) {
        return;
    }
    n = fui_i_status_lines(ui, status);
    fui_i_str_init(&s, card->text, FUI_TEXT_MAX);
    for (i = 0; i < n; i++) {
        /* "Out of catalogue", then the range as a fact of its own */
        fui_i_str_add(&s, i == 0 ? "" : i == 2 ? FUI_S_DOT : " ");
        fui_i_str_add(&s, status[i]);
    }
    fui_i_card_line(card, FUI_STYLE_LABEL, card->text, 0);
}

void fui_i_screen_lens(fui_painter_t *p)
{
    static const fui_card_part_t PARTS[] = { part_identity, part_size, part_threshold, part_wave, part_media, part_status };
    const fui_layout_t *lay = p->lay;
    uint8_t level = p->ui->lens_level;
    int mono = lay->tiny; /* the 128 x 64 face has no room for the head */
    char text[FUI_TEXT_MAX];
    fui_card_t card;

    fui_i_card_init(&card, p, text);
    card.head = (int16_t)(mono ? 0 : 34);
    fui_i_card_run(&card, PARTS, (int)(sizeof PARTS / sizeof PARTS[0]));

    if (!mono) {
        /* The head of every page: the seal, then the letter. */
        fui_text_style_t title = fui_i_style(p, FUI_STYLE_TITLE);
        int width, x;

        if (frc_format_level_name(level, text, sizeof text) <= 0) {
            return;
        }
        width = 24 + 8 + fui_text_width(&title, text, (size_t)-1);
        x = (lay->info.width - width) / 2;
        if (p->canvas) {
            int red = frc_band(level, lens_interval(p->ui)) == FRC_BAND_VISIBLE;

            seal(p, level, x + 12, card.head_y + 15, red ? p->theme->h_alpha : p->theme->lumen_mid);
        }
        fui_i_text(p, &title, x + 32, card.head_y, FUI_ALIGN_LEFT, text, (size_t)-1, 0);
    }
}
