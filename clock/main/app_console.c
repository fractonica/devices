/*
 * app_console.c - what a console line does. Portable C99 (see app.h).
 *
 *   help                       this list
 *   time [<unix seconds>]      show the clock / set it (UTC)
 *   stamp                      the stamp and the date in words
 *   mode [pure|earth]
 *   focus [<level 0..13>]
 *   screen [now|scales|lens|sun|stamp]
 *   utc [<minutes east>]       EARTH mode's fixed offset
 *   bright [<0..100>]
 *   ev <n|p|s|l>...            input events, as if from the buttons; answers
 *                              with the screen and the page reached
 *   shot                       the frame as text (tools/shot.py makes a PNG)
 *   info                       versions, state, loop counters, heap, stacks
 *   reboot
 *
 * The console is a DIAGNOSTIC channel, not the display: it may say the time
 * in Earth terms (ISO 8601, UTC) whatever the mode is, and it always prints
 * the stamp with it. Every Fractonica text comes from the core.
 *
 * Runs in the UI task (app_step calls it for APP_MSG_LINE), so a command may
 * touch the UI state directly; the loop redraws right after.
 */
#include "app.h"

#include <stdlib.h>
#include <string.h>

/* The next word of `*p` (words are separated by spaces); NULL at the end.
 * The line is not modified: `*length` is the word's length. */
static const char *next_word(const char **p, size_t *length)
{
    const char *start;

    while (**p == ' ' || **p == '\t') {
        (*p)++;
    }
    if (**p == '\0') {
        return NULL;
    }
    start = *p;
    while (**p != '\0' && **p != ' ' && **p != '\t') {
        (*p)++;
    }
    *length = (size_t)(*p - start);
    return start;
}

static int word_is(const char *word, size_t length, const char *name)
{
    return strlen(name) == length && strncmp(word, name, length) == 0;
}

/* A whole decimal number, optionally signed. 0 when the word is not one. */
static int word_number(const char *word, size_t length, long long *out)
{
    char text[24];
    char *end;

    if (length == 0 || length >= sizeof text) {
        return 0;
    }
    memcpy(text, word, length);
    text[length] = '\0';
    *out = strtoll(text, &end, 10);
    return *end == '\0' && end != text;
}

/* ------------------------------------------------------------------------- */
/* stamp / time                                                               */
/* ------------------------------------------------------------------------- */

static void print_stamp(app_t *app)
{
    const frc_catalogue_t *cat = app->ui.cat;
    frc_time_t now = app->port.now_us(app->port.ctx);
    frc_civil_t civil;
    frc_date_t date;
    frc_pentad_t pentad;
    frc_sync_t sync;
    char text[176], ascii[64];

    if (now == FRC_TIME_NONE) {
        app_printf(app, "time not set (set it with: time <unix seconds>)\n");
        return;
    }
    if (frc_date_at(cat, now, &date) == FRC_OK) {
        frc_format_date(&date, FRC_DATE_LETTERS, FRC_UNIT_BLINK, text, sizeof text);
        frc_to_ascii(text, ascii, sizeof ascii);
        app_printf(app, "stamp  %s\n", text);
        app_printf(app, "ascii  %s\n", ascii);
        frc_format_date(&date, FRC_DATE_FULL, FRC_UNIT_BLINK, text, sizeof text);
        app_printf(app, "date   %s\n", text);
        if (frc_pentad_at(cat, now, &pentad) == FRC_OK
            && frc_format_pentad(&pentad, FRC_PENTAD_FULL, 1, text, sizeof text) > 0) {
            app_printf(app, "sun    %s", text);
            if (frc_sync_at(cat, now, &sync) == FRC_OK) {
                /* "4 820", or "−12" for a sync before the anchor (U+2212, as the stamp is UTF-8 too) */
                frc_format_count_signed(sync.sync, text, sizeof text);
                app_printf(app, ", sync %s", text);
            }
            app_printf(app, "\n");
        }
    } else {
        app_printf(app, "stamp  none: the instant is outside the eclipse catalogue\n");
    }
    /* Diagnostics may speak Earth: the same instant as ISO 8601, UTC. */
    frc_civil_from_time(now, 0, &civil);
    if (frc_format_civil(&civil, 0, text, sizeof text) > 0) {
        app_printf(app, "earth  %s (unix %lld)\n", text, (long long)(now / FRC_US_PER_SECOND));
    }
}

static void command_time(app_t *app, const char *arg, size_t length)
{
    long long seconds;
    frc_time_t t;

    if (arg != NULL) {
        /* Any instant the system clock can keep running from for millennia:
         * the catalogue, and far enough either side of it to see "out of
         * catalogue". Not the whole int64 range: microseconds near its end
         * would overflow a second later (the system clock, the UI's deadlines). */
        if (!word_number(arg, length, &seconds) || seconds < -APP_TIME_LIMIT_S || seconds > APP_TIME_LIMIT_S
            || (t = frc_time_from_s(seconds)) == FRC_TIME_NONE) {
            app_printf(app, "usage: time <unix seconds>   e.g. time 1791460800 (|s| <= %lld)\n",
                       (long long)APP_TIME_LIMIT_S);
            return;
        }
        app->port.set_time(app->port.ctx, t);
    }
    print_stamp(app);
}

/* ------------------------------------------------------------------------- */
/* state                                                                      */
/* ------------------------------------------------------------------------- */

static void command_mode(app_t *app, const char *arg, size_t length)
{
    if (arg != NULL) {
        if (word_is(arg, length, "pure")) {
            fui_ui_set_mode(&app->ui, FUI_MODE_PURE);
        } else if (word_is(arg, length, "earth")) {
            fui_ui_set_mode(&app->ui, FUI_MODE_EARTH);
        } else {
            app_printf(app, "usage: mode pure|earth\n");
            return;
        }
    }
    app_printf(app, "mode %s\n", fui_mode_name((fui_mode_t)app->ui.mode));
}

static void command_focus(app_t *app, const char *arg, size_t length)
{
    long long level;
    char name[8];

    if (arg != NULL) {
        if (!word_number(arg, length, &level) || level < 0 || level > FUI_FOCUS_MAX) {
            app_printf(app, "usage: focus <level 0..%d>   (6 is the Helion)\n", FUI_FOCUS_MAX);
            return;
        }
        fui_ui_set_focus(&app->ui, (uint8_t)level);
    }
    frc_format_level_name(app->ui.focus, name, sizeof name);
    app_printf(app, "focus %d (%s)\n", app->ui.focus, name);
}

static void command_screen(app_t *app, const char *arg, size_t length)
{
    int screen;

    if (arg != NULL) {
        for (screen = 0; screen < FUI_SCREEN_COUNT; screen++) {
            if (word_is(arg, length, fui_screen_name((fui_screen_t)screen))) {
                break;
            }
        }
        if (screen == FUI_SCREEN_COUNT) {
            app_printf(app, "usage: screen now|scales|lens|sun|stamp\n");
            return;
        }
        fui_ui_set_screen(&app->ui, (fui_screen_t)screen);
    }
    app_printf(app, "screen %s\n", fui_screen_name((fui_screen_t)app->ui.screen));
}

static void command_utc(app_t *app, const char *arg, size_t length)
{
    long long minutes;

    if (arg != NULL) {
        if (!word_number(arg, length, &minutes) || minutes < -720 || minutes > 840) {
            app_printf(app, "usage: utc <minutes east of UTC, -720..840>   e.g. utc 120\n");
            return;
        }
        fui_ui_set_utc_offset(&app->ui, (int32_t)minutes * 60);
    }
    app_printf(app, "utc %+d min (EARTH mode only)\n", (int)(app->ui.utc_offset_s / 60));
}

static void command_bright(app_t *app, const char *arg, size_t length)
{
    long long percent;

    if (arg != NULL) {
        if (!word_number(arg, length, &percent) || percent < 0 || percent > 100) {
            app_printf(app, "usage: bright <0..100>\n");
            return;
        }
        app_set_brightness(app, (int)percent);
    }
    app_printf(app, "bright %d\n", app->brightness);
}

/* ev n p s l: the four input events, in any number and with or without spaces. */
static void command_ev(app_t *app, const char *rest)
{
    uint32_t now_ms = app->port.uptime_ms(app->port.ctx);
    int count = 0, pages;

    for (; *rest != '\0'; rest++) {
        fui_event_t event;

        switch (*rest) {
        case 'n': case 'N': event = FUI_EV_NEXT;   break;
        case 'p': case 'P': event = FUI_EV_PREV;   break;
        case 's': case 'S': event = FUI_EV_SELECT; break;
        case 'l': case 'L': event = FUI_EV_LONG;   break;
        case ' ': case '\t': continue;
        default:
            app_printf(app, "usage: ev <n|p|s|l>...   next, previous, select, long\n");
            return;
        }
        (void)fui_ui_event(&app->ui, event, now_ms);
        count++;
    }
    /* (A card's page is counted from 1 here, as its beads show it.) */
    pages = fui_ui_pages(&app->ui);
    app_printf(app, "%d event%s: screen %s, page %d of %d, mode %s, focus %d\n", count, count == 1 ? "" : "s",
               fui_screen_name((fui_screen_t)app->ui.screen), (app->ui.page < pages ? app->ui.page : pages - 1) + 1,
               pages, fui_mode_name((fui_mode_t)app->ui.mode), app->ui.focus);
}

static void command_info(app_t *app)
{
    const fui_face_info_t *info = fui_face_info((fui_face_t)app->ui.face);
    char name[8];

    app_printf(app, "fractonica-clock %s, core %s, SPEC %s\n", APP_VERSION, FRC_VERSION, FRC_SPEC_VERSION);
    app_printf(app, "display  %s, face %s %dx%d, buffer %u bytes (%s)\n", app->display_name,
               fui_face_name((fui_face_t)app->ui.face), info->width, info->height, (unsigned)app->buffer_bytes,
               app->banded ? "bands" : "whole frame");
    frc_format_level_name(app->ui.focus, name, sizeof name);
    app_printf(app, "state    screen %s (page %d of %d), mode %s, focus %d (%s), utc %+d min, bright %d\n",
               fui_screen_name((fui_screen_t)app->ui.screen), app->ui.page + 1, fui_ui_pages(&app->ui),
               fui_mode_name((fui_mode_t)app->ui.mode), app->ui.focus, name, (int)(app->ui.utc_offset_s / 60),
               app->brightness);
    app_printf(app, "loop     wakes %u (deadline %u, message %u), saves %u\n", (unsigned)app->stats.wakes,
               (unsigned)app->stats.timeouts, (unsigned)app->stats.messages, (unsigned)app->stats.saves);
    app_printf(app, "draw     redraws %u (last %u ms, longest %u ms), flushes %u, pixels %llu\n",
               (unsigned)app->stats.redraws, (unsigned)app->stats.draw_ms, (unsigned)app->stats.draw_max_ms,
               (unsigned)app->stats.flushes, (unsigned long long)app->stats.pixels);
    app_printf(app, "ui       %u bytes of state, next wake in %lld us, latest wake %lu us after its instant\n",
               (unsigned)sizeof app->ui, (long long)app->ui.frame.sleep_us, (unsigned long)app->stats.late_max_us);
    if (app->port.info) {
        app->port.info(app->port.ctx, app);
    }
}

static void command_help(app_t *app)
{
    app_printf(app, "time [<unix seconds>]   show / set the clock (UTC)\n");
    app_printf(app, "stamp                   the stamp and the date in words\n");
    app_printf(app, "mode [pure|earth]       focus [<0..13>]       screen [now|scales|lens|sun|stamp]\n");
    app_printf(app, "utc [<minutes east>]    bright [<0..100>]\n");
    app_printf(app, "ev <n|p|s|l>...         input events: next, previous, select, long\n");
    app_printf(app, "shot                    the frame as text (tools/shot.py makes a PNG)\n");
    app_printf(app, "info                    versions, state, loop counters, heap, stacks\n");
    app_printf(app, "reboot\n");
}

void app_console_line(app_t *app, const char *line)
{
    const char *p = line, *command, *arg;
    size_t command_length = 0, arg_length = 0;

    command = next_word(&p, &command_length);
    if (command == NULL) {
        return;
    }
    if (word_is(command, command_length, "ev")) {
        command_ev(app, p);
        return;
    }
    arg = next_word(&p, &arg_length);

    if (word_is(command, command_length, "time")) {
        command_time(app, arg, arg_length);
    } else if (word_is(command, command_length, "stamp")) {
        print_stamp(app);
    } else if (word_is(command, command_length, "mode")) {
        command_mode(app, arg, arg_length);
    } else if (word_is(command, command_length, "focus")) {
        command_focus(app, arg, arg_length);
    } else if (word_is(command, command_length, "screen")) {
        command_screen(app, arg, arg_length);
    } else if (word_is(command, command_length, "utc")) {
        command_utc(app, arg, arg_length);
    } else if (word_is(command, command_length, "bright")) {
        command_bright(app, arg, arg_length);
    } else if (word_is(command, command_length, "shot")) {
        app_shot(app);
    } else if (word_is(command, command_length, "info")) {
        command_info(app);
    } else if (word_is(command, command_length, "reboot")) {
        app_save_now(app); /* do not lose a change that was still settling */
        if (app->port.restart) {
            app->port.restart(app->port.ctx);
        }
    } else if (word_is(command, command_length, "help") || word_is(command, command_length, "?")) {
        command_help(app);
    } else {
        app_printf(app, "unknown command (try: help)\n");
    }
}
