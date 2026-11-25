/*
 * fui_instrument.c - THE INSTRUMENT on a colour canvas (DESIGN.md S5, S11):
 *
 *   outside   one counter ring per ancestor of the focus, nearest first, each
 *             with its "planet"; the Sun's ring after zeta's while the focus
 *             is the Helion or finer. As many as fit inside ring_limit.
 *   the hero  the focused cycle: carrier, nested arcs, beads (fui_ring.c)
 *   inside    the bezel with its graduations, the four quarter ticks (the
 *             next one lit), the two-glyph odometer at the centre
 *   across    the alidade: one hairline through the point of now
 *
 * The round face shows no words on the instrument. The centre is lent to a
 * brief label when the user has just done something (the level's name after
 * a scale step, the mode after a toggle): a label always shows, reading or
 * not, so that the first turn of a clock that has no time yet is answered.
 * Without a reading the round face says why at the centre, on a plate cut
 * out of the engraving; the rectangular faces say it in their rows.
 *
 * PIXELS. The centre of a 240-wide face is x = 120.0, the edge between two
 * pixel columns. A 1 px line along an axis through it would be two columns
 * at half ink (a lumen tick drawn in #5A9D94). Marks that lie on an axis are
 * therefore moved half a pixel onto a pixel centre (radial_tick), as the
 * glyph stems are.
 *
 * All positions scale with the layout's radius, so the 240 x 240 square face
 * draws the same instrument at 5/7 size (R 40).
 *
 * ONE BIT (the 400 x 300 paper face, R 70: the round face at 5/4). The same
 * instrument with DESIGN.md S11's four marks: solid = elapsed, dotted (1 on,
 * 2 off) = to come, block = now, bead = count. Every token is ink; what the
 * tokens say on colour is said so: the counter rings' slots and the hero's
 * two levels are solid to now and dotted after it, the bezel's graduations
 * likewise (a dotted tick for one to come), the next quarter tick is 2 px
 * wide, the point of now is a block in a cleared frame. No glow, no alidade
 * (a hairline in full ink would cross every ring), no dithering, no inverse
 * video. The labels at the centre are written at 2 px per dot.
 */
#include "fui_i.h"

/* Pixels at the reference radius (R = 56) scaled to this face's radius. */
static fui_fx_t scaled(const fui_layout_t *lay, fui_fx_t at_r56)
{
    return (fui_fx_t)(((int64_t)at_r56 * lay->radius) / FUI_FX(56));
}

static void polar(const fui_layout_t *lay, fui_fx_t r, uint32_t angle, fui_fx_t *x, fui_fx_t *y)
{
    *x = lay->cx + (fui_fx_t)(((int64_t)r * fui_cos(angle)) >> 14);
    *y = lay->cy + (fui_fx_t)(((int64_t)r * fui_sin(angle)) >> 14);
}

/* A phase (fraction of a turn from 12 o'clock, clockwise) as an angle. */
static uint32_t phase_angle(frc_frac_t phase)
{
    return 0xC000u + (phase >> 16);
}

void fui_i_slots(fui_canvas_t *c, const fui_slots_t *s)
{
    /* The gap is given in pixels along the ring: gap / r radians. */
    int32_t gap = (int32_t)(((int64_t)s->gap * 10430) / s->r);
    /* One-bit: "to come" is dotted (DESIGN.md S11); on colour it is `rest`. */
    int mono = fui_canvas_is_mono(c);
    uint8_t dots = 0;
    fui_arc_t arc;
    int j;

    arc.cx = s->cx;
    arc.cy = s->cy;
    arc.r = s->r;
    for (j = 0; j < s->count; j++) {
        int32_t a0 = (j * FUI_TURN) / s->count, a1 = ((j + 1) * FUI_TURN) / s->count;
        /* DESIGN.md S5: wider gaps before the first Helion of each Pentad. */
        int32_t extra = ((s->wide >> j) & 1u) ? (gap * 7) / 5 : 0;

        arc.start = (uint16_t)(0xC000 + a0 + gap / 2 + extra);
        arc.sweep = a1 - a0 - gap - extra;
        if (arc.sweep <= 0) {
            continue;
        }
        dots = 0; /* every slot starts on a dot, so the slots stay countable */
        if (s->current < 0 || j > s->current) {
            if (mono) {
                fui_draw_arc_dotted(c, &arc, s->rest, &dots);
            } else {
                fui_draw_arc(c, &arc, s->width, s->rest);
            }
        } else if (j < s->current) {
            fui_draw_arc(c, &arc, s->width, s->done);
        } else {
            int32_t lit = (int32_t)(s->fraction >> 16);
            fui_arc_t part = fui_arc_part(&arc, lit, 65536);

            if (mono) {
                fui_draw_arc_dotted(c, &part, s->rest, &dots);
            } else {
                fui_draw_arc(c, &part, s->width, s->rest);
            }
            part = fui_arc_part(&arc, 0, lit);
            fui_draw_arc(c, &part, (s->width * 6) / 5, s->lit);
        }
    }
}

/* A planet: a disc knocked out of its ring by a ground-coloured surround. */
static void planet(fui_painter_t *p, fui_fx_t r, frc_frac_t phase, fui_fx_t size, fui_color_t color)
{
    fui_fx_t x, y;

    polar(p->lay, r, phase_angle(phase), &x, &y);
    fui_fill_disc(p->canvas, x, y, size + FUI_FX(1.7), p->theme->ground);
    fui_fill_disc(p->canvas, x, y, size, color);
}

/* A tick along a radius, from r0 to r1. On an axis (12, 3, 6, 9 o'clock) it
 * is set on the nearest pixel centre, so a 1 px tick is one full column or
 * row of ink, not two halves. */
static void radial_tick(fui_painter_t *p, fui_fx_t r0, fui_fx_t r1, uint32_t angle, fui_fx_t width, fui_color_t color)
{
    fui_fx_t x0, y0, x1, y1;

    polar(p->lay, r0, angle, &x0, &y0);
    polar(p->lay, r1, angle, &x1, &y1);
    if ((angle & 0x3FFFu) == 0) {
        if (angle & 0x4000u) { /* 6 and 12 o'clock: vertical */
            x0 = x1 = ((p->lay->cx - 1) & ~0xFF) | 0x80;
        } else {
            y0 = y1 = ((p->lay->cy - 1) & ~0xFF) | 0x80;
        }
    }
    fui_draw_line(p->canvas, x0, y0, x1, y1, width, color);
}

/* One bit: a tick still to come, dotted as every "to come" is: a pixel at
 * r0 and every 3 px out to r1. */
static void radial_dots(fui_painter_t *p, fui_fx_t r0, fui_fx_t r1, uint32_t angle, fui_color_t color)
{
    fui_fx_t r, x, y;

    for (r = r0; r <= r1; r += FUI_FX(3)) {
        polar(p->lay, r, angle, &x, &y);
        fui_canvas_pixel(p->canvas, fui_i_px(x), fui_i_px(y), color);
    }
}

void fui_i_now_block(fui_painter_t *p, fui_fx_t x, fui_fx_t y, int half, fui_color_t ink)
{
    int px = fui_i_px(x), py = fui_i_px(y);

    fui_canvas_fill_rect(p->canvas, px - half - 1, py - half - 1, 2 * half + 3, 2 * half + 3, p->theme->ground);
    fui_canvas_fill_rect(p->canvas, px - half, py - half, 2 * half + 1, 2 * half + 1, ink);
}

/* The counter rings; returns the radius of the outermost one drawn (or the
 * hero's own reach when there is none), which is where the alidade ends. */
static fui_fx_t counter_rings(fui_painter_t *p, fui_fx_t first)
{
    const fui_ui_t *ui = p->ui;
    const fui_reading_t *rd = &ui->reading;
    const fui_theme_t *t = p->theme;
    const fui_layout_t *lay = p->lay;
    fui_fx_t r = first, outermost = ui->ring.reach_out;
    fui_slots_t s;
    int level;
    uint8_t i;

    s.cx = lay->cx;
    s.cy = lay->cy;
    for (level = ui->focus - 1; level >= 0 && r <= lay->ring_limit; level--) {
        const fui_level_t *self = &rd->level[level], *child = &rd->level[level + 1];
        int major = frc_level_kind((uint8_t)level) == FRC_KIND_MAJOR, lit = self->valid && child->valid;

        /* Ring L has frc_factor(L) slots, one per child cycle: slots before
         * the running child are complete, the running one is lit to the
         * child's own phase. So zeta's ring is the Helion's sibling counter. */
        s.r = r;
        s.count = frc_factor((uint8_t)level);
        s.wide = 0;
        s.current = lit ? (int16_t)child->local : -1;
        s.fraction = child->phase;
        s.gap = FUI_FX(3.2);
        /* DESIGN.md S2 / S4: majors are engraved more faintly (0.8 px, their
         * completed slots lumen-etch); the lit part of the running slot is
         * lumen-mid on every counter ring. */
        s.width = major ? FUI_FX(0.8) : FUI_FX_ONE;
        s.done = major ? t->lumen_etch : t->lumen_dim;
        s.lit = t->lumen_mid;
        s.rest = t->etch2;
        fui_i_slots(p->canvas, &s);
        if (lit) {
            planet(p, r, self->phase, major ? FUI_FX(1.6) : FUI_FX(1.9), major ? t->lumen_mid : t->lumen);
        }
        outermost = r;

        if (level == FRC_SYNC_LEVEL - 1) {
            /* The Sun's ring: 19 Helions = one solar sync, outside the ring
             * that counts the Helions (zeta's), before the next ancestor. */
            r += lay->gap;
            if (r <= lay->ring_limit) {
                s.r = r;
                s.count = FRC_SYNC_CYCLES;
                s.wide = ui->pentad_starts;
                s.current = rd->sun_valid ? (int16_t)rd->sun_within : -1;
                s.fraction = rd->sun_slot_phase; /* the running Helion's own phase */
                s.gap = FUI_FX(2.4);
                s.width = FUI_FX_ONE;
                s.done = t->sol_dim;
                s.lit = t->sol;
                s.rest = t->sol_empty;
                fui_i_slots(p->canvas, &s);
                /* EARTH: the civil midnights of this sync, hung on the Sun's ring. */
                for (i = 0; i < rd->midnights; i++) {
                    radial_tick(p, r - FUI_FX(3), r + FUI_FX(3), phase_angle(rd->midnight[i]), FUI_FX_ONE, t->bone);
                }
                if (rd->sun_valid) {
                    planet(p, r, rd->sun_phase, FUI_FX(2.1), t->sol);
                }
                outermost = r;
            }
            r += (lay->gap * 116) / 100;
        } else {
            /* the next ring out is the parent's: closer when it is a major's */
            r += level > 0 && frc_level_kind((uint8_t)(level - 1)) == FRC_KIND_MAJOR ? lay->gap_major : lay->gap;
        }
    }
    return outermost;
}

/* Beads: one per whole child cycle, on the carrier where that cycle starts;
 * lit through the running one. The sibling counter of the children. */
static void beads(fui_painter_t *p)
{
    const fui_ui_t *ui = p->ui;
    const fui_level_t *child = &ui->reading.level[ui->focus + 1];
    const fui_theme_t *t = p->theme;
    uint8_t n = frc_factor(ui->focus), j;
    /* one bit: a little larger, so a hollow bead is a ring of pixels */
    int mono = fui_canvas_is_mono(p->canvas);
    fui_fx_t size = mono ? FUI_FX(2.5) : FUI_FX(1.8), hollow = mono ? FUI_FX(2) : FUI_FX(1.4);

    for (j = 0; j < n; j++) {
        fui_fx_t x, y;

        polar(p->lay, p->lay->radius, 0xC000u + (uint32_t)((j * FUI_TURN) / n), &x, &y);
        if (mono) {
            x = (x & ~0xFF) | 0x80; /* on a pixel centre: every bead the same shape */
            y = (y & ~0xFF) | 0x80;
        }
        if (child->valid && j <= child->local) {
            fui_fill_disc(p->canvas, x, y, size, t->bone);
        } else {
            fui_fill_disc(p->canvas, x, y, size, t->ground);
            fui_draw_ring(p->canvas, x, y, hollow, FUI_FX(0.8), t->etch3);
        }
    }
}

/* The inner bezel: graduated outward in grandchild cycles, every child cycle
 * a long tick; ticks up to the running one are lit. Then the four quarter
 * ticks inward: end at 12, peak at 3, node at 6, valley at 9; the next one lit. */
static void bezel(fui_painter_t *p, fui_fx_t r_in)
{
    const fui_ui_t *ui = p->ui;
    const fui_reading_t *rd = &ui->reading;
    const fui_level_t *child = &rd->level[ui->focus + 1], *grand = &rd->level[ui->focus + 2];
    const fui_theme_t *t = p->theme;
    const fui_layout_t *lay = p->lay;
    int per = frc_factor((uint8_t)(ui->focus + 1)), count = frc_factor(ui->focus) * per;
    int lit = rd->level[ui->focus].valid && child->valid && grand->valid;
    /* The running graduation: whole child cycles done x per + grandchild index. */
    int done = lit ? child->local * per + grand->local : -1;
    /* Under 3 px apart the short ticks would merge: keep the long ones only. */
    int fine = (int32_t)(((int64_t)r_in * 6434) >> 10) / count >= 3 * FUI_FX_ONE; /* 2 pi r / count */
    int mono = fui_canvas_is_mono(p->canvas), i;

    fui_draw_ring(p->canvas, lay->cx, lay->cy, r_in, FUI_FX_ONE, t->etch2);
    for (i = 0; i < count; i++) {
        int is_long = i % per == 0;
        uint32_t angle = 0xC000u + (uint32_t)((i * FUI_TURN) / count);
        /* one bit: the tick leaves a pixel's gap above the bezel circle, so
         * a dotted one is not read as part of it */
        fui_fx_t r0 = mono ? r_in + FUI_FX(2) : r_in, r1 = r_in + scaled(lay, is_long ? FUI_FX(4.6) : FUI_FX(2.4));

        if (!is_long && !fine) {
            continue;
        }
        if (mono && i > done) {
            radial_dots(p, r0, r1, angle, t->etch3);
        } else {
            radial_tick(p, r0, r1, angle, FUI_FX(0.9), i <= done ? t->lumen_mid : t->etch3);
        }
    }
    for (i = 0; i < 4; i++) {
        /* frc_quarter_t in order: peak 0 at 3 o'clock, node, valley, end at 12 */
        int next = lit && rd->next_quarter == i;

        radial_tick(p, r_in - scaled(lay, FUI_FX(5)), r_in, (uint32_t)i * 0x4000u,
                    next ? (mono ? FUI_FX(2) : FUI_FX(1.3)) : FUI_FX_ONE, next ? t->lumen : t->etch3);
    }
}

/* Words at the centre: up to three short lines stacked around the middle,
 * on a plate of ground cut out of whatever is engraved there (the bezel, its
 * ticks; for the status of the round face, the ring itself). */
static void centre_lines(fui_painter_t *p, const char *const *line, const fui_style_id_t *style, int count)
{
    int cx = fui_i_px(p->lay->cx), cy = fui_i_px(p->lay->cy), total = 0, widest = 0, y, i;

    for (i = 0; i < count; i++) {
        fui_text_style_t st = fui_i_style(p, style[i]);
        int width = fui_text_width(&st, line[i], (size_t)-1);

        total += fui_text_height(&st) + (i ? 2 : 0);
        widest = width > widest ? width : widest;
    }
    y = cy - total / 2;
    if (p->canvas) {
        fui_canvas_fill_rect(p->canvas, cx - widest / 2 - 4, y - 2, widest + 8, total + 4, p->theme->ground);
    }
    for (i = 0; i < count; i++) {
        fui_text_style_t st = fui_i_style(p, style[i]);

        fui_i_text(p, &st, cx, y, FUI_ALIGN_CENTER, line[i], (size_t)-1, 0);
        y += fui_text_height(&st) + 2;
    }
}

/* What the centre shows: a brief label, the status, or the odometer, its
 * glyphs at `u` px per design unit (Q16), their strokes `pen` px on one bit. */
static void centre(fui_painter_t *p, uint32_t u, int pen)
{
    const fui_ui_t *ui = p->ui;
    const fui_layout_t *lay = p->lay;
    char text[3][44];
    const char *line[3];
    fui_style_id_t style[3];
    fui_str_t s;
    int n;

    if (ui->toast) {
        /* The mode, named once after a toggle (DESIGN.md S8: PURE is an
         * empty ring, EARTH the ring with its cross). The word under the sign
         * is furniture: the sign says it. */
        line[0] = ui->mode == FUI_MODE_EARTH ? FUI_S_EARTH : FUI_S_RING;
        line[1] = ui->mode == FUI_MODE_EARTH ? "Earth" : "Pure";
        style[0] = FUI_STYLE_READING_BIG;
        style[1] = lay->info.mono ? FUI_STYLE_NAME : FUI_STYLE_FURNITURE; /* paper: no 1 px words */
        centre_lines(p, line, style, 2);
    } else if (ui->screen == FUI_SCREEN_SCALES) {
        /* The level just stepped to: its letter, then its name. */
        fui_i_str_init(&s, text[0], sizeof text[0]);
        FUI_I_CORE(&s, frc_format_level_name(ui->focus, at_, room_));
        fui_i_str_init(&s, text[1], sizeof text[1]);
        fui_i_add_level_title(&s, ui->focus);
        line[0] = text[0]; line[1] = text[1];
        style[0] = FUI_STYLE_TITLE;
        style[1] = lay->info.mono ? FUI_STYLE_NAME : FUI_STYLE_FURNITURE;
        centre_lines(p, line, style, 2);
    } else if (ui->status != FUI_STATUS_OK) {
        if (lay->reading_y < 0) { /* a face without rows: said here */
            n = fui_i_status_lines(ui, text);
            line[0] = text[0]; line[1] = text[1]; line[2] = text[2];
            style[0] = style[1] = FUI_STYLE_NAME;
            style[2] = FUI_STYLE_READING;
            centre_lines(p, line, style, n);
        }
    } else {
        if (p->canvas) {
            /* The focused level's odometer: two 2-stroke glyphs, stems 5.6 u
             * apart (a whole number of pixels), each stem and the top bar on
             * a pixel centre so they stay crisp. */
            fui_fx_t pitch = (fui_fx_t)((((uint64_t)u * 56) / 10) >> 16) * FUI_FX_ONE;
            fui_fx_t left = ((lay->cx - pitch / 2) & ~0xFF) | 0x80;
            fui_fx_t top = (fui_glyph_origin_y(lay->cy, 2, u) & ~0xFF) | 0x80;

            if (pen > 1) {
                fui_canvas_set_pen(p->canvas, pen, 1, 2);
            }
            fui_odometer_draw(p->canvas, ui->reading.odometer, 2, 2, left, top, pitch, u, p->theme->lumen);
            fui_canvas_set_pen(p->canvas, 1, 1, 2);
        }
        if (lay->info.round && ui->mode == FUI_MODE_EARTH) {
            /* The round face has no row for a translation: the Earth sign is
             * its hallmark of the mode (and of whose midnights hang on the
             * Sun's ring). Left of the 6 o'clock tick, under the left glyph's
             * foot: on the axis the room between the glyphs' feet and the
             * tick shrinks to 9 px when a coarse factor (5: gamma, lambda)
             * pulls the bezel in, and the sign sat on the tick like an orb on
             * a stem. Here it is clear of both at every focus (test_ui). */
            fui_text_style_t st = fui_i_style(p, FUI_STYLE_MARK);

            fui_i_text(p, &st, fui_i_px(lay->cx) - 8, fui_i_px(lay->cy) + 22, FUI_ALIGN_CENTER, FUI_S_EARTH, (size_t)-1, 0);
        }
    }
}

void fui_i_instrument(fui_painter_t *p)
{
    const fui_ui_t *ui = p->ui;
    const fui_layout_t *lay = p->lay;
    const fui_theme_t *t = p->theme;
    const fui_ring_t *ring = &ui->ring;
    fui_ring_now_t now;
    fui_fx_t r_in, r_first, r_out, x0, y0, x1, y1;

    if (p->canvas) {
        /* The bezel keeps inside the hero's inward bulges and the first
         * counter ring outside its outward ones: 0.71 R and 1.37 R when
         * there is room (DESIGN.md S5), further when a coarse factor (4, 5)
         * makes the arcs large. */
        r_in = (lay->radius * 71) / 100;
        if (r_in > ring->reach_in - FUI_FX(1.5)) {
            r_in = ring->reach_in - FUI_FX(1.5);
        }
        r_first = (lay->radius * 137) / 100;
        if (r_first < ring->reach_out + FUI_FX(3)) {
            r_first = ring->reach_out + FUI_FX(3);
        }
        r_out = counter_rings(p, r_first);
        fui_i_ring_paint(p, &now);
        beads(p);
        bezel(p, r_in);
        if (now.valid && fui_canvas_is_mono(p->canvas)) {
            fui_i_now_block(p, now.x, now.y, 3, t->lumen); /* one bit: the block, no alidade */
        } else if (now.valid) {
            /* The alidade: from the bezel through now to just past the last ring. */
            uint32_t angle = phase_angle(ui->reading.level[ui->focus].phase);

            polar(lay, r_in, angle, &x0, &y0);
            polar(lay, r_out + FUI_FX(5), angle, &x1, &y1);
            fui_draw_line(p->canvas, x0, y0, x1, y1, FUI_FX(0.75), t->alidade);
            /* The point of now: halo, disc, white core. No glow on embedded. */
            fui_draw_ring(p->canvas, now.x, now.y, FUI_FX(5.2), FUI_FX(0.7), t->lumen_mid);
            fui_fill_disc(p->canvas, now.x, now.y, FUI_FX(2.6), t->lumen);
            fui_fill_disc(p->canvas, now.x, now.y, FUI_FX(1.2), t->core);
        }
    }
    centre(p, lay->u, 1);
}

/*
 * THE WAVE (the 400 x 300 paper face, the owner's layout): the focused
 * cycle's two levels alone, sized to their room (fui_i_ring_prepare), round
 * the inner circle with the two glyphs; nothing outside it (no counter
 * rings, beads, graduations, quarter ticks or alidade). One-bit marks:
 * elapsed solid, to come dotted, now a block. Thick for paper (the owner,
 * after the first look on glass): arcs and the circle 2 px, the dots of
 * what is to come 2 pixels of the path on and 3 off, the glyphs' strokes
 * WAVE_GLYPH_PEN px, the block 9 x 9.
 */
#define WAVE_PEN       2
#define WAVE_DASH_ON   2
#define WAVE_DASH_OFF  3
#define WAVE_GLYPH_PEN 3
#define WAVE_BLOCK     4 /* half: 9 x 9 */
void fui_i_wave(fui_painter_t *p)
{
    const fui_ui_t *ui = p->ui;
    const fui_ring_t *ring = &ui->ring;
    /* the inner circle: the bezel's place, inside the hero's inward bulges
     * and 2.5 px clear of them past both pens */
    fui_fx_t r_in = (ring->radius * 71) / 100;
    int32_t k, whole;
    uint32_t u;
    fui_ring_now_t now;

    if (r_in > ring->reach_in - FUI_FX(2.5 + WAVE_PEN)) {
        r_in = ring->reach_in - FUI_FX(2.5 + WAVE_PEN);
    }
    /* The glyphs as large as the circle holds (their box's half-diagonal is
     * 6.48 u, and 3 px to spare), at a whole multiple of 10/3 px per unit so
     * stems and bars fall on whole pixels (fui_glyph.h); where that step
     * would waste more than a fifth of the room (a small circle: the nested
     * factors of 5 in EARTH), at whole pixels per unit instead. */
    k = (int32_t)(((int64_t)(r_in - FUI_FX(3)) * 30) / (648 * FUI_FX_ONE));
    whole = (int32_t)(((int64_t)(r_in - FUI_FX(3)) * 100) / (648 * FUI_FX_ONE));
    u = (uint32_t)(k < 1 ? 1 : k) * FUI_U_MONO;
    if (whole > 0 && (int64_t)u * 5 < (int64_t)FUI_U_PX(whole) * 4) {
        u = FUI_U_PX(whole);
    }
    if (p->canvas) {
        fui_canvas_set_pen(p->canvas, WAVE_PEN, WAVE_DASH_ON, WAVE_DASH_OFF);
        fui_i_ring_paint(p, &now);
        fui_draw_ring(p->canvas, ring->cx, ring->cy, r_in, FUI_FX_ONE, p->theme->etch2);
        fui_canvas_set_pen(p->canvas, 1, 1, 2);
        if (now.valid) {
            fui_i_now_block(p, now.x, now.y, WAVE_BLOCK, p->theme->lumen);
        }
    }
    centre(p, u, WAVE_GLYPH_PEN);
}
