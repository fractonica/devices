/*
 * fui_ring.c - the hero: the focused cycle as a ring of nested alternating
 * arcs (DESIGN.md S5), shared by the colour instrument and the one-bit face.
 *
 * GEOMETRY comes from the core and is cached. The carrier is a full circle
 * starting at 12 o'clock; its 2 x frc_factor(F) first-level arcs are the
 * half-cycles of level F+1 (frc_arc_child, even bulging out, odd in); each of
 * those carries frc_factor(F+1) second-level arcs, the half-cycles of level
 * F+2. That is float work (a C3 has no FPU), so fui_i_ring_prepare does it
 * once per focus change and stores the arcs in ui->ring as 12-byte fixed-
 * point records; redraws and bands only read them.
 *
 * FILL comes from the core too, as phases and local indices (ruling 1: a
 * ring is filled with the phase the core returns):
 *   first level   running arc j0 = 2 x local(F+1) + (phase(F+1) >= 1/2),
 *                 lit to phase(F+1) x 2 (the header's half-cycle rule)
 *   second level  half-cycle h = 2 x local(F+2) + (phase(F+2) >= 1/2) of the
 *                 F+1 cycle; the first-level arc j0 holds h, less the
 *                 frc_factor(F+1) of the first half when j0 is the second
 *   Arcs before the running one are elapsed, arcs after it are to come.
 *
 * NESTING stops when an arc would be too small to read (ruling 9): the
 * second level is drawn only if its smallest arc has a radius of 2.3 px.
 * It also stops when the arcs would be too LARGE: a factor of 4 (theta)
 * makes second-level arcs that reach in to 0.56 R, across the bezel and into
 * the odometer. The second level is kept only while it stays outside 0.6 R.
 *
 * REACH: ring->reach_in / reach_out are how near and how far from the centre
 * the ring's ink comes, with the second level when it is drawn. The bezel
 * keeps inside the one and the counter rings outside the other
 * (fui_instrument.c), so no arc crosses a ring.
 */
#include "fui_i.h"

/* Smallest second-level radius worth drawing, Q8 pixels. Ruling 9's "3 pt"
 * scaled to these displays; 2.3 is what delta's and mu's nested arcs have on
 * the square face (R = 40), so the same levels nest on every colour face. */
#define NEST_MIN_RADIUS FUI_FX(2.3)
/* Nearest the nested arcs may come to the centre, in hundredths of R: the
 * bezel, its quarter ticks and the two glyphs need what is inside. */
#define NEST_MIN_REACH_IN 60

fui_arc_t fui_i_arc(const fui_arc16_t *a)
{
    fui_arc_t out;

    out.cx = (fui_fx_t)a->cx * 4;
    out.cy = (fui_fx_t)a->cy * 4;
    out.r = (fui_fx_t)a->r * 4;
    out.start = a->start;
    out.sweep = a->sweep;
    return out;
}

static void store(fui_arc16_t *slot, const frc_arc_t *arc)
{
    fui_arc_t fixed = fui_arc_from_frc(arc);

    slot->cx = (int16_t)((fixed.cx + 2) >> 2); /* Q8 -> Q6 */
    slot->cy = (int16_t)((fixed.cy + 2) >> 2);
    slot->r = (uint16_t)((fixed.r + 2) >> 2);
    slot->start = fixed.start;
    slot->sweep = fixed.sweep;
}

/* How near and how far from the ring's centre the circle of an arc comes.
 * (The whole circle: a bound, and for these arcs the bulge itself.) */
static void reach(const fui_ring_t *ring, const fui_arc16_t *arc, fui_fx_t *in, fui_fx_t *out)
{
    int32_t dx = (int32_t)arc->cx * 4 - ring->cx, dy = (int32_t)arc->cy * 4 - ring->cy;
    int32_t distance = (int32_t)fui_isqrt((uint32_t)(dx * dx + dy * dy));

    *out = distance + (fui_fx_t)arc->r * 4;
    *in = distance - (fui_fx_t)arc->r * 4;
}

void fui_i_ring_prepare(fui_ui_t *ui)
{
    const fui_layout_t *lay = fui_i_layout(ui->face);
    fui_ring_t *ring = &ui->ring;
    frc_arc_t root, child, grand;
    uint8_t slots = (uint8_t)(2 * frc_factor(ui->focus)), per = frc_factor((uint8_t)(ui->focus + 1));
    uint8_t j, k;
    fui_fx_t nest_in, nest_out;
    float smallest;

    if (ring->valid && ring->focus == ui->focus && ring->cx == lay->cx && ring->cy == lay->cy &&
        ring->radius == lay->radius) {
        return;
    }
    ring->valid = 1;
    ring->focus = ui->focus;
    ring->cx = lay->cx;
    ring->cy = lay->cy;
    ring->radius = lay->radius;
    ring->children = slots;
    ring->per_child = 0;

    root.cx = (float)lay->cx / 256.0f;
    root.cy = (float)lay->cy / 256.0f;
    root.radius = (float)lay->radius / 256.0f;
    root.start = -FRC_PI / 2.0f; /* a cycle starts at 12 o'clock ... */
    root.sweep = 2.0f * FRC_PI;  /* ... and runs clockwise */
    for (j = 0; j < slots; j++) {
        child = frc_arc_child(&root, slots, j, j & 1);
        store(&ring->arc[j], &child);
    }
    /* How near and how far the first-level arcs come to the centre: every
     * arc has the same radius and its centre the same distance from ours. */
    reach(ring, &ring->arc[0], &ring->reach_in, &ring->reach_out);

    /* The second level: only on colour, only if it fits the cache and its
     * smaller kind of arc (the one on an inward-bulging parent) is readable. */
    if (lay->info.mono || (unsigned)slots * per > FUI_RING_GRAND) {
        return;
    }
    child = frc_arc_child(&root, slots, 0, 0);
    grand = frc_arc_child(&child, per, 0, 0);
    smallest = grand.radius;
    child = frc_arc_child(&root, slots, 1, 1);
    grand = frc_arc_child(&child, per, 0, 0);
    if (grand.radius < smallest) {
        smallest = grand.radius;
    }
    if (fui_fx_from_float(smallest) < NEST_MIN_RADIUS) {
        return;
    }
    /* The arcs on the first two first-level arcs (one bulging out, one in)
     * are the whole pattern, turned: their reach is everybody's. */
    nest_in = ring->reach_in;
    nest_out = ring->reach_out;
    for (j = 0; j < slots; j++) {
        child = frc_arc_child(&root, slots, j, j & 1);
        for (k = 0; k < per; k++) {
            fui_arc16_t *slot = &ring->arc[FUI_RING_CHILDREN + j * per + k];
            fui_fx_t in, out;

            grand = frc_arc_child(&child, per, k, (j * per + k) & 1);
            store(slot, &grand);
            if (j < 2) {
                reach(ring, slot, &in, &out);
                nest_in = in < nest_in ? in : nest_in;
                nest_out = out > nest_out ? out : nest_out;
            }
        }
        if (j == 1 && nest_in < (lay->radius * NEST_MIN_REACH_IN) / 100) {
            return; /* too large: first level only (per_child stays 0) */
        }
    }
    ring->per_child = per;
    ring->reach_in = nest_in;
    ring->reach_out = nest_out;
}

/* One arc of the ring, lit from its start to `lit` (0..65536). */
typedef struct arc_ink {
    fui_color_t done, rest;
    fui_fx_t    done_width, rest_width;
} arc_ink_t;

static void split_arc(fui_canvas_t *c, const fui_arc_t *arc, int32_t lit, const arc_ink_t *ink)
{
    if (lit < 65536) {
        fui_arc_t rest = fui_arc_part(arc, lit, 65536);

        fui_draw_arc(c, &rest, ink->rest_width, ink->rest);
    }
    if (lit > 0) {
        fui_arc_t done = fui_arc_part(arc, 0, lit);

        fui_draw_arc(c, &done, ink->done_width, ink->done);
    }
}

void fui_i_ring_paint(fui_painter_t *p, fui_ring_now_t *now)
{
    const fui_ui_t *ui = p->ui;
    const fui_ring_t *ring = &ui->ring;
    const fui_reading_t *rd = &ui->reading;
    const fui_theme_t *t = p->theme;
    const fui_level_t *focus = &rd->level[ui->focus];
    const fui_level_t *one = &rd->level[ui->focus + 1], *two = &rd->level[ui->focus + 2];
    fui_canvas_t *c = p->canvas;
    int mono = p->lay->info.mono;
    int lit = focus->valid && one->valid && two->valid;
    int j0 = -1, k0 = 0, j, k;
    int32_t t1 = 0, t2 = 0;
    fui_arc_t arc;
    arc_ink_t ink;
    uint8_t dots = 0;

    now->valid = 0;
    if (!c || !ring->valid) {
        return;
    }
    if (lit) {
        int second_half = one->phase >= FRC_FRAC_HALF;
        int h = 2 * two->local + (two->phase >= FRC_FRAC_HALF);

        j0 = 2 * one->local + second_half;
        t1 = (int32_t)((uint32_t)(one->phase << 1) >> 16);
        k0 = h - (second_half ? ring->per_child : 0);
        t2 = (int32_t)((uint32_t)(two->phase << 1) >> 16);
        if (j0 >= ring->children) {
            j0 = ring->children - 1; /* cannot happen with a valid reading */
        }
    }

    if (mono) {
        /* DESIGN.md S11: first level only, elapsed solid, to come dotted. */
        for (j = 0; j < ring->children; j++) {
            arc = fui_i_arc(&ring->arc[j]);
            if (j < j0) {
                fui_draw_arc(c, &arc, FUI_FX_ONE, t->lumen);
            } else if (j == j0) {
                fui_arc_t done = fui_arc_part(&arc, 0, t1), rest = fui_arc_part(&arc, t1, 65536);

                fui_draw_arc(c, &done, FUI_FX_ONE, t->lumen);
                fui_draw_arc_dotted(c, &rest, t->lumen, &dots);
            } else {
                fui_draw_arc_dotted(c, &arc, t->lumen, &dots);
            }
        }
    } else {
        /* The carrier: the cycle itself, its elapsed part in resting lumen. */
        arc.cx = ring->cx;
        arc.cy = ring->cy;
        arc.r = ring->radius;
        arc.start = 0xC000u;
        arc.sweep = FUI_TURN;
        ink.done = t->lumen_dim;
        ink.rest = t->etch2;
        ink.done_width = ink.rest_width = FUI_FX_ONE;
        split_arc(c, &arc, lit ? (int32_t)(focus->phase >> 16) : 0, &ink);

        /* Second level under the first, as in the design's paint order. */
        if (ring->per_child) {
            for (j = 0; j < ring->children; j++) {
                /* "near": inside the running F+1 cycle, where detail is brightest */
                int near = lit && (j / 2 == j0 / 2);

                ink.done = near ? t->lumen : t->lumen_mid;
                ink.rest = t->etch2;
                ink.done_width = ink.rest_width = FUI_FX_ONE;
                for (k = 0; k < ring->per_child; k++) {
                    int32_t part = j < j0 ? 65536 : j > j0 ? 0 : k < k0 ? 65536 : k > k0 ? 0 : t2;

                    arc = fui_i_arc(&ring->arc[FUI_RING_CHILDREN + j * ring->per_child + k]);
                    split_arc(c, &arc, part, &ink);
                }
            }
        }
        /* First level: the hero line. */
        ink.done = t->lumen;
        ink.rest = t->etch3;
        ink.done_width = FUI_FX(1.4);
        ink.rest_width = FUI_FX_ONE;
        for (j = 0; j < ring->children; j++) {
            arc = fui_i_arc(&ring->arc[j]);
            split_arc(c, &arc, j < j0 ? 65536 : j > j0 ? 0 : t1, &ink);
        }
    }

    /* The point of now sits on the deepest arc drawn, at its own fraction. */
    if (lit) {
        if (ring->per_child && k0 >= 0 && k0 < ring->per_child) {
            arc = fui_i_arc(&ring->arc[FUI_RING_CHILDREN + j0 * ring->per_child + k0]);
            fui_arc_point(&arc, t2, &now->x, &now->y);
        } else {
            arc = fui_i_arc(&ring->arc[j0]);
            fui_arc_point(&arc, t1, &now->x, &now->y);
        }
        now->valid = 1;
    }
}
