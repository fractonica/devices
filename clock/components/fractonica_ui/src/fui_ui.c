/*
 * fui_ui.c - the state machine: events in; "redraw this, wake then" out.
 * The contract and the navigation map are in fui_ui.h.
 *
 * WHAT CHANGES A FRAME, AND HOW EACH IS NOTICED
 *   the scene    screen, page, focus, mode, status, a brief label: anything the
 *                user or the device did. Hashed into ui->scene; a new hash
 *                redraws the whole face.
 *   the rings    the arcs' fill, the glyphs, the beads. The core says when
 *                they next change (fui_i_ring_next); at that instant the
 *                model is read again and the instrument's rectangle redrawn.
 *   the text     lines flagged FUI_LINE_LIVE. They are re-formatted (without
 *                drawing) at every Blink boundary, and at every civil second
 *                when a line shows seconds; only rows whose text changed
 *                are redrawn. A line that knows how long its text holds (a
 *                countdown, a Pentad) says so instead (fui_i_line_until) and
 *                is looked at again only then.
 * The UI task sleeps until the soonest of those instants, never less than
 * min_frame_us: nothing here polls faster than the display can show.
 *
 * WITH A STEP (fui_ui_set_step) the instant of the frame is the start of the
 * step level's running cycle, not `now`: between two boundaries of that
 * level it does not move, so nothing above is due, and the only deadline is
 * the cycle's end. At that end the instant jumps to the next start; the
 * rings are redrawn if the core's next change lies in between, and every
 * line is formatted again (the readings go down to the step's unit, so the
 * text changes at each boundary).
 */
#include "fui_i.h"

static frc_time_t sooner(frc_time_t a, frc_time_t b)
{
    if (a == FRC_TIME_NONE) {
        return b;
    }
    if (b == FRC_TIME_NONE) {
        return a;
    }
    return a < b ? a : b;
}

/* Everything that decides WHAT is on screen, apart from the time itself. */
static uint32_t scene_hash(const fui_ui_t *ui)
{
    uint8_t state[9];
    uint32_t h;

    state[0] = ui->face;
    state[1] = ui->screen;
    state[2] = ui->mode;
    state[3] = ui->focus;
    state[4] = ui->lens_level;
    state[5] = ui->toast;
    state[6] = ui->status;
    state[7] = ui->page;
    state[8] = ui->step;
    h = fui_i_hash(FUI_I_HASH_SEED, state, sizeof state);
    return fui_i_hash(h, &ui->utc_offset_s, sizeof ui->utc_offset_s);
}

void fui_i_paint(fui_painter_t *p)
{
    const fui_ui_t *ui = p->ui;

    switch (ui->screen) {
    case FUI_SCREEN_LENS:
        fui_i_screen_lens(p);
        break;
    case FUI_SCREEN_SUN:
        if (ui->status == FUI_STATUS_OK) {
            fui_i_screen_sun(p);
        } else {
            fui_i_screen_stamp(p); /* the same "no reading" card */
        }
        break;
    case FUI_SCREEN_STAMP:
        fui_i_screen_stamp(p);
        break;
    default: /* NOW and SCALES: the instrument */
        if (p->lay->tiny) {
            fui_i_now_mono(p);
        } else if (p->lay->wave_reach > 0) {
            fui_i_wave(p); /* the paper face: the wave alone, the readings in the corners */
            fui_i_now_corners(p);
        } else {
            /* A redraw of the text rows alone (every Blink on the rectangular
             * faces) need not walk the instrument's 200 arcs and lines just to
             * have each one clipped away: it lies wholly above them. */
            if (!p->canvas || p->canvas->clip.y0 < p->lay->instrument_bottom) {
                fui_i_instrument(p);
            }
            fui_i_now_rows(p);
        }
        break;
    }
}

void fui_i_painter_init(fui_painter_t *p, const fui_ui_t *ui, fui_canvas_t *canvas)
{
    p->canvas = canvas;
    p->ui = ui;
    p->theme = ui->theme;
    p->lay = fui_i_layout(ui->face);
    p->sink = NULL;
    p->sink_ctx = NULL;
    p->lines = 0;
    p->flags = 0;
    p->pages = 1;
    p->until = FRC_TIME_NONE;
    p->layout_hash = FUI_I_HASH_SEED;
}

uint8_t fui_ui_pages(const fui_ui_t *ui)
{
    fui_painter_t p;

    if (ui->screen == FUI_SCREEN_NOW || ui->screen == FUI_SCREEN_SCALES) {
        return 1;
    }
    /* A card's pages are known once its lines are laid out: do that. */
    fui_i_painter_init(&p, ui, NULL);
    fui_i_paint(&p);
    return p.pages;
}

void fui_ui_lines(const fui_ui_t *ui, fui_line_sink_t sink, void *ctx)
{
    fui_painter_t p;

    fui_i_painter_init(&p, ui, NULL);
    p.sink = sink;
    p.sink_ctx = ctx;
    fui_i_paint(&p);
}

/* When the live lines are next worth re-checking. */
static frc_time_t text_next(const fui_ui_t *ui, unsigned flags)
{
    frc_time_t next = FRC_TIME_NONE;
    frc_cycle_t blink;

    if (ui->status != FUI_STATUS_OK) {
        return FRC_TIME_NONE;
    }
    /* Every span and date the faces show moves on the Blink grid or coarser. */
    if ((flags & FUI_LINE_LIVE) && frc_cycle_at(ui->cat, ui->t, frc_unit_level(FRC_UNIT_BLINK), &blink) == FRC_OK &&
        blink.end > ui->t) {
        next = blink.end;
    }
    if (flags & FUI_LINE_SECONDS) {
        /* the next whole civil second (floor, also before 1970) */
        frc_time_t into = ui->t % FRC_US_PER_SECOND;

        if (into < 0) {
            into += FRC_US_PER_SECOND;
        }
        next = sooner(next, ui->t - into + FRC_US_PER_SECOND);
    }
    return next;
}

/* The rectangle the rings and glyphs of the current screen live in. */
static fui_rect_t ring_rect(const fui_ui_t *ui)
{
    const fui_layout_t *lay = fui_i_layout(ui->face);
    int bottom = lay->info.height;

    if (ui->screen == FUI_SCREEN_NOW || ui->screen == FUI_SCREEN_SCALES) {
        bottom = lay->instrument_bottom; /* the rows of text under it keep their own pace */
    }
    return fui_rect_make(0, 0, lay->info.width, bottom);
}

/*
 * Format every line of the screen without drawing, and compare with what the
 * last frame showed. Returns the rows that changed (empty: none; the whole
 * face: the lines moved). Stores the new hashes and schedules the next check.
 */
static fui_rect_t check_text(fui_ui_t *ui, int compare)
{
    const fui_layout_t *lay = fui_i_layout(ui->face);
    fui_rect_t changed = fui_rect_make(0, 0, 0, 0);
    fui_painter_t p;
    uint8_t i;
    int moved = 0;

    fui_i_painter_init(&p, ui, NULL);
    fui_i_paint(&p);
    if (ui->page >= p.pages) {
        /* The card has fewer pages than the one asked for: PREV asked for
         * "the last" (fui_ui_event), or the card grew shorter as time went
         * (a line left it). Show its last page; that is a new scene. */
        ui->page = (uint8_t)(p.pages - 1);
        ui->scene = scene_hash(ui);
        fui_i_painter_init(&p, ui, NULL);
        fui_i_paint(&p);
        moved = 1;
    }
    if (compare) {
        if (moved || p.lines != ui->line_count || p.layout_hash != ui->layout_hash) {
            changed = fui_rect_make(0, 0, lay->info.width, lay->info.height);
        } else {
            for (i = 0; i < p.lines; i++) {
                if (p.hash[i] != ui->line_hash[i]) {
                    /* the whole row band: the old text may have been wider */
                    fui_rect_t rows = fui_rect_make(0, p.top[i], lay->info.width, p.bottom[i]);

                    changed = fui_rect_union(&changed, &rows);
                }
            }
        }
    }
    ui->line_count = p.lines;
    ui->layout_hash = p.layout_hash;
    for (i = 0; i < p.lines; i++) {
        ui->line_hash[i] = p.hash[i];
    }
    /* Lines flagged LIVE are looked at again at the next Blink; lines that
     * named an instant (fui_i_line_until), then. */
    ui->text_next = sooner(text_next(ui, p.flags), ui->status == FUI_STATUS_OK ? p.until : FRC_TIME_NONE);
    return changed;
}

/* ------------------------------------------------------------------------- */

/* Where the Pentads begin on the Sun's ring: bit j is set when slot j is the
 * first Helion of a Pentad (frc_pentad_t.first). Every sync is laid out
 * alike (SPEC S7.5), so the anchor's sync is asked. */
static uint32_t pentad_starts(const frc_catalogue_t *cat)
{
    frc_pentad_t pentad;
    uint32_t starts = 0;
    uint8_t index;

    for (index = 0; frc_pentad_by_number(cat, 0, index, &pentad) == FRC_OK; index++) {
        if (pentad.first < FRC_SYNC_CYCLES) {
            starts |= (uint32_t)1 << pentad.first;
        }
    }
    return starts;
}

void fui_ui_init(fui_ui_t *ui, const fui_config_t *config)
{
    uint8_t *bytes = (uint8_t *)ui;
    size_t i;

    for (i = 0; i < sizeof *ui; i++) {
        bytes[i] = 0;
    }
    ui->face = (uint8_t)((unsigned)config->face < FUI_FACE_COUNT ? config->face : FUI_FACE_ROUND240);
    ui->cat = config->catalogue ? config->catalogue : &FRC_SAROS_141;
    /* The paper face is black ink on white paper by default (fui_theme.h). */
    ui->theme = config->theme ? config->theme
                : ui->face == FUI_FACE_MONO400X300 ? &fui_theme_paper
                : (fui_i_layout(ui->face)->info.mono ? &fui_theme_mono : &fui_theme_astrolabe);
    ui->utc_offset_s = config->utc_offset_s;
    ui->min_frame_us = config->min_frame_us ? config->min_frame_us
                                            : (fui_i_layout(ui->face)->info.mono ? 50000u : 100000u);
    ui->mode = (uint8_t)(config->mode == FUI_MODE_EARTH ? FUI_MODE_EARTH : FUI_MODE_PURE);
    ui->focus = (uint8_t)(config->focus <= FUI_FOCUS_MAX ? config->focus : FUI_FOCUS_DEFAULT);
    ui->lens_level = ui->focus;
    if (!fui_ui_set_step(ui, config->step)) {
        ui->step = FUI_STEP_NONE;
    }
    ui->pentad_starts = pentad_starts(ui->cat);
    ui->screen = FUI_SCREEN_NOW;
    ui->status = FUI_STATUS_TIME_UNSET;
    ui->t = FRC_TIME_NONE;
    ui->ring_next = FRC_TIME_NONE;
    ui->text_next = FRC_TIME_NONE;
    ui->invalid = 1;
    ui->frame.sleep_us = -1;
    ui->frame.next_wake = FRC_TIME_NONE;
}

void fui_ui_invalidate(fui_ui_t *ui)
{
    ui->invalid = 1;
}

void fui_ui_set_mode(fui_ui_t *ui, fui_mode_t mode)
{
    ui->mode = (uint8_t)(mode == FUI_MODE_EARTH ? FUI_MODE_EARTH : FUI_MODE_PURE);
    ui->invalid = 1;
}

void fui_ui_set_focus(fui_ui_t *ui, uint8_t level)
{
    ui->focus = (uint8_t)(level <= FUI_FOCUS_MAX ? level : FUI_FOCUS_MAX);
    ui->lens_level = ui->focus;
    ui->invalid = 1;
}

void fui_ui_set_screen(fui_ui_t *ui, fui_screen_t screen)
{
    ui->screen = (uint8_t)((unsigned)screen < FUI_SCREEN_COUNT ? screen : FUI_SCREEN_NOW);
    if (ui->screen == FUI_SCREEN_SCALES) {
        ui->screen = FUI_SCREEN_NOW; /* SCALES is a moment, not a place to restore to */
    }
    ui->lens_level = ui->focus;
    ui->page = 0;
    ui->toast = 0;
    ui->invalid = 1;
}

void fui_ui_set_utc_offset(fui_ui_t *ui, int32_t utc_offset_s)
{
    ui->utc_offset_s = utc_offset_s;
    ui->invalid = 1;
}

int fui_ui_set_step(fui_ui_t *ui, int level)
{
    if (level != FUI_STEP_NONE && (level < FUI_STEP_HELION || level > FUI_STEP_FLAVON)) {
        return 0;
    }
    ui->step = (uint8_t)level;
    ui->invalid = 1;
    return 1;
}

/* value + step on a ring of `count` */
static uint8_t wrap_step(uint8_t value, int step, int count)
{
    return (uint8_t)((value + count + step) % count);
}

/* The card after `screen` in the SELECT loop, on its first page. */
static void card_forward(fui_ui_t *ui)
{
    ui->screen = (uint8_t)(ui->screen == FUI_SCREEN_LENS ? FUI_SCREEN_SUN
                           : ui->screen == FUI_SCREEN_SUN ? FUI_SCREEN_STAMP : FUI_SCREEN_NOW);
    ui->page = 0;
}

int fui_ui_event(fui_ui_t *ui, fui_event_t event, uint32_t now_ms)
{
    int step = event == FUI_EV_NEXT ? 1 : -1, card = ui->screen >= FUI_SCREEN_LENS;
    uint8_t pages = 1;

    if (card && event != FUI_EV_NONE && event != FUI_EV_LONG) {
        /* How many pages the card has NOW: events may come several to an
         * update (the console's `ev`), so this is asked, not remembered. */
        pages = fui_ui_pages(ui);
        if (ui->page >= pages) {
            ui->page = (uint8_t)(pages - 1);
        }
    }
    switch (event) {
    case FUI_EV_LONG:
        ui->mode = (uint8_t)(ui->mode == FUI_MODE_PURE ? FUI_MODE_EARTH : FUI_MODE_PURE);
        if (!card) {
            /* The instrument itself hardly changes: say the mode once. */
            ui->screen = FUI_SCREEN_NOW;
            ui->toast = 1;
            ui->toast_since_ms = now_ms;
        }
        return 1;

    case FUI_EV_SELECT:
        ui->toast = 0;
        if (!card) {
            /* NOW, and SCALES too: "turn to a level, press to inspect it".
             * SELECT never means "dismiss the name" (it leaves by itself). */
            ui->screen = FUI_SCREEN_LENS;
            ui->lens_level = ui->focus;
            ui->page = 0;
        } else if (ui->page + 1 < pages) {
            ui->page++;
        } else {
            card_forward(ui);
        }
        return 1;

    case FUI_EV_NEXT:
    case FUI_EV_PREV:
        ui->toast = 0;
        switch (ui->screen) {
        case FUI_SCREEN_NOW:
        case FUI_SCREEN_SCALES:
            /* Turn the limb: one level finer (NEXT) or coarser (PREV). */
            ui->focus = wrap_step(ui->focus, step, FUI_FOCUS_MAX + 1);
            ui->lens_level = ui->focus;
            ui->screen = FUI_SCREEN_SCALES;
            ui->scales_since_ms = now_ms;
            break;
        case FUI_SCREEN_LENS:
            /* All 63 rungs. Only the lens moves: looking at a rung does not
             * refocus the instrument (and so is not saved as its focus). */
            ui->lens_level = wrap_step(ui->lens_level, step, FRC_LEVEL_COUNT);
            ui->page = 0;
            break;
        default: /* SUN and STAMP: NEXT is SELECT; PREV undoes it */
            if (step > 0) {
                if (ui->page + 1 < pages) {
                    ui->page++;
                } else {
                    card_forward(ui);
                }
            } else if (ui->page > 0) {
                ui->page--;
            } else if (ui->screen == FUI_SCREEN_SUN) {
                ui->screen = FUI_SCREEN_LENS; /* its pages are SELECT's: from the first */
            } else {
                ui->screen = FUI_SCREEN_SUN;
                ui->page = 0xFF; /* its last page: brought into range by the next update */
            }
            break;
        }
        return 1;

    default:
        return 0;
    }
}

const fui_frame_t *fui_ui_update(fui_ui_t *ui, frc_time_t now, uint32_t now_ms)
{
    const fui_layout_t *lay = fui_i_layout(ui->face);
    fui_rect_t whole = fui_rect_make(0, 0, lay->info.width, lay->info.height);
    fui_rect_t dirty = fui_rect_make(0, 0, 0, 0);
    uint8_t status;
    uint32_t scene, label_ms = 0;
    int backwards, stepped = 0, has_label = 0;
    int64_t sleep = -1;
    frc_time_t wake, shown = now, step_end = FRC_TIME_NONE;

    /* The brief labels end by themselves (unsigned difference: wrap-safe). */
    if (ui->screen == FUI_SCREEN_SCALES && (uint32_t)(now_ms - ui->scales_since_ms) >= FUI_NAME_MS) {
        ui->screen = FUI_SCREEN_NOW;
    }
    if (ui->toast && (uint32_t)(now_ms - ui->toast_since_ms) >= FUI_TOAST_MS) {
        ui->toast = 0;
    }

    status = (uint8_t)(now == FRC_TIME_NONE ? FUI_STATUS_TIME_UNSET
                       : frc_catalogue_contains(ui->cat, now) ? FUI_STATUS_OK : FUI_STATUS_OUT_OF_CATALOGUE);
    if (status == FUI_STATUS_OK && ui->step != FUI_STEP_NONE) {
        /* THE STEP: show the instant the step level's running cycle began;
         * the face next moves when it ends (none after the catalogue's last
         * instant, which belongs to the last cycle: there end == now). */
        frc_cycle_t cycle;

        if (frc_cycle_at(ui->cat, now, ui->step, &cycle) == FRC_OK) {
            shown = cycle.start;
            step_end = cycle.end > now ? cycle.end : FRC_TIME_NONE;
        }
        stepped = ui->status == FUI_STATUS_OK && ui->t != shown;
    }
    /* A clock set backwards makes every scheduled instant meaningless. */
    backwards = status == FUI_STATUS_OK && ui->status == FUI_STATUS_OK && ui->t != FRC_TIME_NONE && shown < ui->t;
    ui->status = status;
    ui->t = shown;
    scene = scene_hash(ui);

    if (ui->invalid || scene != ui->scene || backwards) {
        ui->invalid = 0;
        ui->scene = scene;
        fui_i_ring_prepare(ui);
        fui_i_read(ui);
        ui->ring_next = fui_i_ring_next(ui);
        (void)check_text(ui, 0); /* (may bring ui->page into range, and then renews ui->scene) */
        dirty = whole;
    } else if (status == FUI_STATUS_OK) {
        int ring_due = ui->ring_next != FRC_TIME_NONE && shown >= ui->ring_next;

        if (ring_due) {
            fui_i_read(ui);
            ui->ring_next = fui_i_ring_next(ui);
            dirty = ring_rect(ui);
        }
        /* A ring redraw may repaint text rows too: re-check them with it so
         * the stored hashes match what is on screen. (At a step boundary
         * every line is looked at: the readings end at the step's unit.) */
        if (ring_due || stepped || (ui->text_next != FRC_TIME_NONE && shown >= ui->text_next)) {
            fui_rect_t rows = check_text(ui, 1);

            dirty = fui_rect_union(&dirty, &rows);
        }
    }

    ui->frame.dirty = fui_rect_intersect(&dirty, &whole);
    ui->frame.redraw = (uint8_t)!fui_rect_is_empty(&ui->frame.dirty);

    /* Sleep until the clock next changes something on screen (with a step:
     * until the step's cycle ends, and never before) ... */
    wake = ui->step != FUI_STEP_NONE ? step_end : sooner(ui->ring_next, ui->text_next);
    if (status == FUI_STATUS_OK && wake != FRC_TIME_NONE) {
        sleep = wake - now;
        if (sleep < (int64_t)ui->min_frame_us) {
            sleep = (int64_t)ui->min_frame_us;
        }
    }
    /* ... or until a brief label has had its time. */
    if (ui->screen == FUI_SCREEN_SCALES) {
        label_ms = FUI_NAME_MS - (uint32_t)(now_ms - ui->scales_since_ms);
        has_label = 1;
    }
    if (ui->toast) {
        uint32_t left = FUI_TOAST_MS - (uint32_t)(now_ms - ui->toast_since_ms);

        label_ms = has_label && label_ms < left ? label_ms : left;
        has_label = 1;
    }
    if (has_label && (sleep < 0 || sleep > (int64_t)label_ms * 1000)) {
        sleep = (int64_t)label_ms * 1000;
    }
    ui->frame.sleep_us = sleep;
    /* (An instant the int64 cannot hold after the sleep - only a clock set
     * near its end, out of every catalogue - has no wake instant.) */
    ui->frame.next_wake = (status != FUI_STATUS_TIME_UNSET && sleep >= 0 && now <= INT64_MAX - sleep)
                              ? now + sleep : FRC_TIME_NONE;
    return &ui->frame;
}

void fui_ui_draw(const fui_ui_t *ui, fui_canvas_t *canvas)
{
    fui_painter_t p;

    fui_canvas_set_clip(canvas, &ui->frame.dirty);
    if (!fui_rect_is_empty(&canvas->clip)) {
        fui_canvas_clear(canvas, ui->theme->ground);
        fui_i_painter_init(&p, ui, canvas);
        fui_i_paint(&p);
    }
    fui_canvas_set_clip(canvas, NULL);
}
