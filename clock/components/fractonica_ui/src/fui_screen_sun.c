/*
 * fui_screen_sun.c - SUN: the solar sync (SPEC S7). 19 Helions against four
 * civil days, drawn as the Sun's ring grown to fill the face, with the
 * reading inside it. Solar yellow is used here and nowhere else.
 *
 *   the ring     19 slots (Helions), wider gaps before each Pentad; slots
 *                done / running / to come; the Sun as its planet. EARTH adds
 *                a tick at every civil midnight of the configured zone.
 *                The running slot is lit to the running Helion's own phase,
 *                read for this screen (fui_model.c): it does not depend on
 *                what the instrument is focused on.
 *   ⬠II·2                     the head: the Pentad mark (SPEC S7.5: Pentad II,
 *   three glyphs              its 2nd Helion) and the sync phase as an
 *                             odometer (SPEC S7.3)
 *   SOLAR SYNC 4 820          the sync's number
 *   DRIFT −6 236λ             how far its start has slipped from the civil
 *                             grid, in whole Flavons (never in seconds here)
 *   NODE IN 2η 24ι            the next quarter of the sync
 *   ⊕ THU 8 OCT 2026          EARTH only (the zone is said once, here and on
 *   14:00:00 UTC+2            STAMP)
 *
 * The lines are a card (fui_i.h) inside the ring: its rows are chords of the
 * ring, and what does not fit turns the page.
 *
 * One-bit: page 1 is the figure, the ring (R = 26) in the left 64 x 64 with
 * the Pentad mark, the glyphs and the sync's number on the right, as the NOW
 * face is built; the lines follow from page 2, written out at full width.
 * In the catalogue's first and last partial sync there is no sync reading
 * (frc_sync_at: FRC_ERR_RANGE): the ring stays engraved and only the Pentad
 * is said.
 */
#include "fui_i.h"

static void sun_ring(fui_painter_t *p, fui_fx_t cx, fui_fx_t cy, fui_fx_t r)
{
    const fui_reading_t *rd = &p->ui->reading;
    const fui_theme_t *t = p->theme;
    fui_slots_t s;
    uint8_t i;

    s.cx = cx;
    s.cy = cy;
    s.r = r;
    s.count = FRC_SYNC_CYCLES;
    s.wide = p->ui->pentad_starts;
    s.current = rd->sun_valid ? (int16_t)rd->sun_within : -1;
    s.fraction = rd->sun_slot_phase;
    /* 19 slots share 163 px on the one-bit ring (R = 26): a 3 px gap would
     * leave a completed Helion 5 px and the first of each Pentad 2. */
    s.gap = p->lay->info.mono ? FUI_FX(1.6) : FUI_FX(3);
    s.width = FUI_FX(1.4);
    s.done = t->sol_dim;
    s.lit = t->sol;
    s.rest = t->sol_empty;
    fui_i_slots(p->canvas, &s);
    for (i = 0; i < rd->midnights; i++) {
        /* a tick across the ring; on one bit, inside it, clear of the dots */
        uint32_t angle = 0xC000u + (rd->midnight[i] >> 16);
        int32_t co = fui_cos(angle), si = fui_sin(angle);
        fui_fx_t from = p->lay->info.mono ? r - FUI_FX(6) : r - FUI_FX(4);
        fui_fx_t to = p->lay->info.mono ? r - FUI_FX(2) : r + FUI_FX(4);

        fui_draw_line(p->canvas, cx + (fui_fx_t)(((int64_t)from * co) >> 14), cy + (fui_fx_t)(((int64_t)from * si) >> 14),
                      cx + (fui_fx_t)(((int64_t)to * co) >> 14), cy + (fui_fx_t)(((int64_t)to * si) >> 14),
                      FUI_FX_ONE, t->bone);
    }
    if (rd->sun_valid) {
        uint32_t angle = 0xC000u + (rd->sun_phase >> 16);
        fui_fx_t x = cx + (fui_fx_t)(((int64_t)r * fui_cos(angle)) >> 14);
        fui_fx_t y = cy + (fui_fx_t)(((int64_t)r * fui_sin(angle)) >> 14);

        if (p->lay->info.mono) {
            /* the block that means "now" on the one-bit face */
            fui_canvas_fill_rect(p->canvas, fui_i_px(x) - 2, fui_i_px(y) - 2, 5, 5, t->ground);
            fui_canvas_fill_rect(p->canvas, fui_i_px(x) - 1, fui_i_px(y) - 1, 3, 3, t->sol);
        } else {
            fui_fill_disc(p->canvas, x, y, FUI_FX(5), t->ground);
            fui_fill_disc(p->canvas, x, y, FUI_FX(3), t->sol);
        }
    }
}

/* "4 820", or "−12" for a sync before the anchor eclipse. */
static void add_sync_number(fui_str_t *s, const frc_sync_t *sync)
{
    FUI_I_CORE(s, frc_format_count_signed(sync->sync, at_, room_));
}

/* --- one bit, from page 2: the Pentad in words (page 1 has its mark) ------ */
static void part_pentad(fui_card_t *card)
{
    const fui_ui_t *ui = card->p->ui;
    frc_pentad_t pentad;

    if (frc_pentad_at(ui->cat, ui->t, &pentad) == FRC_OK &&
        frc_format_pentad(&pentad, FRC_PENTAD_FULL, 1, card->text, FUI_TEXT_MAX) > 0) {
        fui_i_card_line(card, FUI_STYLE_SOL, card->text, 0);
    }
}

/* --- the sync: its number, its drift, its next quarter -------------------- */
static void part_sync(fui_card_t *card)
{
    fui_painter_t *p = card->p;
    const fui_ui_t *ui = p->ui;
    frc_sync_t sync;
    frc_span_t span;
    fui_str_t s;

    if (frc_sync_at(ui->cat, ui->t, &sync) != FRC_OK) {
        return;
    }
    fui_i_str_init(&s, card->text, FUI_TEXT_MAX);
    fui_i_str_add(&s, "solar sync ");
    add_sync_number(&s, &sync);
    fui_i_card_line(card, FUI_STYLE_READING, card->text, 0);

    /* Drift: from where the civil grid puts this sync to where it starts,
     * in whole Flavons (DESIGN.md S9: "drift −6 236λ"). */
    if (frc_span_between(ui->cat, sync.nominal, sync.start, &span) == FRC_OK) {
        size_t start;

        fui_i_str_init(&s, card->text, FUI_TEXT_MAX);
        fui_i_str_add(&s, "drift ");
        start = s.len;
        FUI_I_CORE(&s, frc_format_span_in_unit(&span, FRC_UNIT_FLAVON, at_, room_));
        fui_i_str_keep(&s, start); /* "−6 236λ" is one value */
        fui_i_card_line(card, FUI_STYLE_READING, card->text, 0);
    }
    if (sync.next.time != FRC_TIME_NONE && frc_span_between(ui->cat, ui->t, sync.next.time, &span) == FRC_OK) {
        fui_i_str_init(&s, card->text, FUI_TEXT_MAX);
        fui_i_add_quarter_in(&s, (frc_quarter_t)sync.next.name, &span);
        fui_i_span_until(p, sync.next.time);
        fui_i_card_line(card, FUI_STYLE_READING, card->text, 0);
    }
}

/* --- EARTH: the civil date, time and zone of now -------------------------- */
static void part_civil(fui_card_t *card)
{
    const fui_ui_t *ui = card->p->ui;
    fui_str_t s;

    if (ui->mode != FUI_MODE_EARTH) {
        return;
    }
    fui_i_str_init(&s, card->text, FUI_TEXT_MAX);
    fui_i_add_civil(&s, ui->t, ui->utc_offset_s, FUI_CIVIL_FULL);
    fui_i_card_line(card, FUI_STYLE_EARTH, card->text, FUI_LINE_SECONDS);
}

void fui_i_screen_sun(fui_painter_t *p)
{
    static const fui_card_part_t PARTS[] = { part_pentad, part_sync, part_civil };
    const fui_ui_t *ui = p->ui;
    const fui_layout_t *lay = p->lay;
    const fui_reading_t *rd = &ui->reading;
    int mono = lay->info.mono, figure;
    fui_text_style_t sol = fui_i_style(p, FUI_STYLE_SOL);
    char text[FUI_TEXT_MAX];
    frc_pentad_t pentad;
    frc_cycle_t helion;
    fui_card_t card;

    /* None of these lines is LIVE. The Pentad's Helion, the sync's number and
     * its drift hold until the running Helion ends (a sync ends with one);
     * the countdown says for itself how long it holds (fui_i_span_until). */
    fui_i_line_until(p, frc_cycle_at(ui->cat, ui->t, FRC_SYNC_LEVEL, &helion) == FRC_OK ? helion.end : FRC_TIME_NONE);

    fui_i_card_init(&card, p, text);
    if (mono) {
        card.first_page = 1; /* the figure is a page of its own */
        fui_i_card_run(&card, PARTS, 3);
    } else {
        /* Inside the ring (r = 112 on every colour face): rows are chords
         * of a circle 7 px inside it. The head is the Pentad mark (20 rows)
         * and the three glyphs (46 rows at u = 5). */
        card.clip_cy = lay->card_cy;
        card.clip_r = 105;
        card.top = (int16_t)(lay->card_cy - 88);
        card.bottom = (int16_t)(lay->card_cy + 84);
        card.marks_y = (int16_t)(lay->card_cy + 93);
        card.head = 68;
        fui_i_card_run(&card, PARTS + 1, 2);
    }
    figure = !mono || ui->page == 0;

    /* The ring, on every page of the colour faces: the card lies inside it. */
    if (p->canvas && figure) {
        if (mono) {
            sun_ring(p, FUI_FX(31.5), FUI_FX(31.5), FUI_FX(26));
        } else {
            sun_ring(p, FUI_FX(lay->info.width / 2), FUI_FX(lay->card_cy), FUI_FX(112));
        }
    }
    if (!figure) {
        return;
    }
    /* The Pentad mark, the three glyphs; on one bit the sync's number under
     * them in the dot font, as the count sits under the odometer on NOW. */
    text[0] = '\0';
    if (frc_pentad_at(ui->cat, ui->t, &pentad) == FRC_OK) {
        (void)frc_format_pentad(&pentad, FRC_PENTAD_SHORT, 1, text, sizeof text);
    }
    if (mono) {
        frc_sync_t sync;
        fui_str_t s;

        fui_i_text(p, &sol, 96, 0, FUI_ALIGN_CENTER, text, (size_t)-1, 0);
        if (p->canvas && rd->sun_valid) {
            /* stems 20 px apart on columns 76, 96, 116 */
            fui_odometer_draw(p->canvas, rd->sun_odometer, 3, 2, FUI_FX(76.5), FUI_FX(20.5), FUI_FX(20),
                              lay->u, p->theme->sol);
        }
        if (frc_sync_at(ui->cat, ui->t, &sync) == FRC_OK) {
            fui_text_style_t big = fui_i_style(p, FUI_STYLE_READING_BIG);

            fui_i_str_init(&s, text, sizeof text);
            add_sync_number(&s, &sync);
            fui_i_text(p, &big, 96, 46, FUI_ALIGN_CENTER, text, (size_t)-1, 0);
        }
    } else {
        fui_i_text(p, &sol, lay->info.width / 2, card.head_y, FUI_ALIGN_CENTER, text, (size_t)-1, 0);
        if (p->canvas && rd->sun_valid) {
            /* three 2-stroke glyphs, stems 6.4 u apart (DESIGN.md S6), each
             * stem on a pixel centre; the stem top 12 rows under the mark */
            fui_fx_t pitch = FUI_FX(32);

            fui_odometer_draw(p->canvas, rd->sun_odometer, 3, 2, FUI_FX(lay->info.width / 2) - pitch + FUI_FX(0.5),
                              FUI_FX(card.head_y + 33) + FUI_FX(0.5), pitch, FUI_U_PX(5), p->theme->sol);
        }
    }
}
