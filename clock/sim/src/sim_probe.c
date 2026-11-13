/*
 * sim_probe.c - what the core says at an instant, as text, to check a
 * picture against. Host only; it calls the core and nothing else.
 *
 *   probe [<unix seconds>] [utc offset in seconds]      default: SPEC vector A
 *
 * One line per focus level 0..13 with everything the instrument shows for it:
 *   lit beads   the sibling counter of the children: local(F+1) + 1 of factor(F)
 *   arc         the running first-level arc (half-cycle of F+1) of 2 x factor(F),
 *               and how far it is lit, in sixteenths
 *   odometer    the two centre glyphs (2 strokes): state index, value, dotted
 *   next        the next threshold of the level and the span until it
 * then the counter rings (slot and fill of every ancestor), the Sun and the
 * Earth translation. Phases are printed here as sixteenths ONLY because this
 * is a checking tool: no display ever shows a phase as a number (DESIGN.md S9).
 */
#include <stdio.h>
#include <stdlib.h>

#include "fractonica.h"

static int sixteenths(frc_frac_t phase)
{
    return (int)(phase >> 28);
}

static void glyph_text(uint16_t index, char *out, size_t size)
{
    frc_glyph_t g;

    frc_glyph_from_index(index, 2, &g);
    snprintf(out, size, "%2u(%+d%s)", (unsigned)index, g.value, g.dotted ? " dot" : "");
}

int main(int argc, char **argv)
{
    const frc_catalogue_t *cat = &FRC_SAROS_141;
    long long seconds = argc > 1 ? atoll(argv[1]) : 1791460800LL;
    int offset = argc > 2 ? atoi(argv[2]) : 0;
    frc_time_t t = frc_time_from_s(seconds);
    frc_date_t date;
    frc_sync_t sync;
    frc_pentad_t pentad;
    frc_odometer_t odo;
    frc_civil_t civil;
    char text[176], a[24], b[24];
    int level;

    if (!frc_catalogue_contains(cat, t)) {
        printf("%lld: outside the catalogue\n", seconds);
        return 0;
    }
    frc_date_at(cat, t, &date);
    frc_format_date(&date, FRC_DATE_LETTERS, FRC_UNIT_BLINK, text, sizeof text);
    printf("unix %lld\nstamp   %s\n", seconds, text);
    frc_format_date(&date, FRC_DATE_FULL, FRC_UNIT_BLINK, text, sizeof text);
    printf("full    %s\n\n", text);

    printf("focus name  beads-lit  running-arc      odometer              next threshold\n");
    for (level = 0; level <= 13; level++) {
        frc_cycle_t self, child;
        frc_threshold_t next;
        frc_span_t span;
        char name[8], quarter[12], until[48];
        int arcs = 2 * frc_factor((uint8_t)level);

        frc_format_level_name((uint8_t)level, name, sizeof name);
        frc_cycle_at(cat, t, (uint8_t)level, &self);
        frc_cycle_at(cat, t, (uint8_t)(level + 1), &child);
        frc_odometer_at(cat, t, (uint8_t)level, 2, 2, &odo);
        frc_next_threshold(cat, t, (uint8_t)level, &next);
        frc_format_quarter((frc_quarter_t)next.name, 0, quarter, sizeof quarter);
        frc_span_between(cat, t, next.time, &span);
        frc_format_span(&span, 0, until, sizeof until);
        glyph_text(odo.digit[0], a, sizeof a);
        glyph_text(odo.digit[1], b, sizeof b);
        printf("%5d %-4s  %2d of %-2d   %2d of %-2d +%2d/16  %-10s %-10s %-6s in %s   (cycle fill %d/16, slot %d of %d)\n",
               level, name, child.local + 1, frc_factor((uint8_t)level),
               2 * child.local + (child.phase >= FRC_FRAC_HALF), arcs, sixteenths(child.phase << 1), a, b, quarter,
               until, sixteenths(self.phase), self.local + 1, self.siblings);
    }

    if (frc_sync_at(cat, t, &sync) == FRC_OK && frc_pentad_at(cat, t, &pentad) == FRC_OK) {
        frc_span_t span;
        char until[48], quarter[12];

        frc_sync_odometer(cat, t, 2, 3, &odo);
        frc_format_pentad(&pentad, FRC_PENTAD_FULL, 1, text, sizeof text);
        printf("\nsun     sync %d, fill %d/16, running Helion %d of %d (slot %d), Pentad from slot %d, %s\n",
               (int)sync.sync, sixteenths(sync.phase), sync.helion + 1, FRC_SYNC_CYCLES, sync.helion, pentad.first, text);
        glyph_text(odo.digit[0], a, sizeof a);
        glyph_text(odo.digit[1], b, sizeof b);
        printf("        digits %s %s", a, b);
        glyph_text(odo.digit[2], a, sizeof a);
        printf(" %s\n", a);
        frc_span_between(cat, sync.nominal, sync.start, &span);
        frc_format_span_in_unit(&span, FRC_UNIT_FLAVON, until, sizeof until);
        printf("        drift %s (%lld us)\n", until, (long long)sync.drift_us);
        frc_span_between(cat, t, sync.next.time, &span);
        frc_format_span(&span, 0, until, sizeof until);
        frc_format_quarter((frc_quarter_t)sync.next.name, 0, quarter, sizeof quarter);
        printf("        next %s in %s\n", quarter, until);
    } else {
        printf("\nsun     no whole sync here\n");
    }

    frc_civil_from_time(t, offset, &civil);
    frc_format_civil(&civil, offset, text, sizeof text);
    printf("\nearth   %s\n", text);
    frc_format_civil_text(&civil, offset, FRC_CIVIL_DATE_TIME, text, sizeof text);
    printf("        %s ", text);
    frc_format_civil_text(&civil, offset, FRC_CIVIL_OFFSET, text, sizeof text);
    printf("%s\n", text);
    return 0;
}
