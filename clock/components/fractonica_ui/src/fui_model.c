/*
 * fui_model.c - the one place that READS THE CLOCK for the rings and glyphs.
 *
 * fui_i_read asks the core for everything the instrument and the Sun's ring
 * show at ui->t and stores it in ui->reading; the faces draw from that
 * snapshot only. Nothing is computed here: every field is a value the core
 * returned (a phase, a local index, a quarter, a glyph state).
 *
 * fui_i_ring_next asks the core WHEN that picture next changes, so the UI
 * task can sleep until then instead of polling (SPEC S5: "schedule screen
 * updates from that time").
 */
#include "fui_i.h"

static void read_sun(fui_ui_t *ui)
{
    fui_reading_t *r = &ui->reading;
    frc_sync_t sync;
    frc_cycle_t helion;
    frc_odometer_t odo;
    uint8_t i;

    r->sun_valid = 0;
    r->sun_slot_phase = 0;
    r->midnights = 0;
    /* In the catalogue's first and last partial sync there is no sync reading.
     * The running Helion is read HERE, for the Sun's ring itself: the levels
     * of fui_i_read stop two below the focus, and the SUN screen is the same
     * picture whatever the instrument is focused on. */
    if (frc_sync_at(ui->cat, ui->t, &sync) != FRC_OK || frc_cycle_at(ui->cat, ui->t, FRC_SYNC_LEVEL, &helion) != FRC_OK ||
        frc_sync_odometer(ui->cat, ui->t, 2, 3, &odo) != FRC_OK) {
        return;
    }
    r->sun_valid = 1;
    r->sun_phase = sync.phase;
    r->sun_within = sync.helion;        /* which slot of the Sun's ring is running ... */
    r->sun_slot_phase = helion.phase;   /* ... and how far it is lit (ruling 1) */
    for (i = 0; i < 3; i++) {
        r->sun_odometer[i] = odo.digit[i];
    }
    if (ui->mode == FUI_MODE_EARTH) {
        /* EARTH: where the civil midnights of the configured zone fall on the
         * Sun's ring. Midnight is Earth arithmetic (86,400 s days); its place
         * on the ring is the sync phase the core gives for that instant. */
        frc_time_t midnight = fui_i_next_midnight(sync.start, ui->utc_offset_s);

        while (midnight != FRC_TIME_NONE && midnight < sync.end && r->midnights < 5) {
            frc_sync_t at;

            if (midnight > sync.start && frc_sync_at(ui->cat, midnight, &at) == FRC_OK && at.sync == sync.sync) {
                r->midnight[r->midnights++] = at.phase;
            }
            midnight += FRC_US_PER_DAY;
        }
    }
}

void fui_i_read(fui_ui_t *ui)
{
    fui_reading_t *r = &ui->reading;
    frc_odometer_t odo;
    frc_threshold_t next;
    uint8_t level;

    for (level = 0; level < FUI_FOCUS_MAX + 3; level++) {
        r->level[level].valid = 0;
        r->level[level].phase = 0;
        r->level[level].local = 0;
        r->level[level].quarter = 0;
    }
    r->odometer[0] = r->odometer[1] = 0;
    r->next_quarter = FRC_PEAK;
    r->sun_valid = 0;
    r->midnights = 0;
    if (ui->status != FUI_STATUS_OK) {
        return;
    }
    for (level = 0; level <= ui->focus + 2; level++) {
        frc_cycle_t cycle;

        if (frc_cycle_at(ui->cat, ui->t, level, &cycle) == FRC_OK) {
            r->level[level].valid = 1;
            r->level[level].phase = cycle.phase;
            r->level[level].local = cycle.local;
            r->level[level].quarter = cycle.quarter;
        }
    }
    if (frc_odometer_at(ui->cat, ui->t, ui->focus, 2, 2, &odo) == FRC_OK) {
        r->odometer[0] = odo.digit[0];
        r->odometer[1] = odo.digit[1];
    }
    if (frc_next_threshold(ui->cat, ui->t, ui->focus, &next) == FRC_OK) {
        r->next_quarter = next.name;
    }
    read_sun(ui);
}

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

frc_time_t fui_i_ring_next(const fui_ui_t *ui)
{
    frc_odometer_t odo;
    frc_time_t next = FRC_TIME_NONE;

    if (ui->status != FUI_STATUS_OK) {
        return FRC_TIME_NONE;
    }
    switch (ui->screen) {
    case FUI_SCREEN_NOW:
    case FUI_SCREEN_SCALES:
        /* The centre odometer's finer glyph ... */
        if (frc_odometer_at(ui->cat, ui->t, ui->focus, 2, 2, &odo) == FRC_OK) {
            next = sooner(next, odo.next_change);
        }
        /* ... and the light creeping along the ring. Two levels below the
         * focus, 16 states a cycle: a step is under a pixel of arc on every
         * face, so the fill looks continuous without a frame being wasted. */
        if (frc_odometer_at(ui->cat, ui->t, (uint8_t)(ui->focus + 2), 2, 1, &odo) == FRC_OK) {
            next = sooner(next, odo.next_change);
        }
        break;
    case FUI_SCREEN_SUN:
        /* The finest of the three sync glyphs: about 84 s a state. */
        if (frc_sync_odometer(ui->cat, ui->t, 2, 3, &odo) == FRC_OK) {
            next = sooner(next, odo.next_change);
        }
        break;
    default:
        break; /* LENS and STAMP are text: their lines are re-checked instead */
    }
    return next;
}
