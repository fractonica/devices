/*
 * sim_firmware.c - the firmware's loop on the host: main/app.c running
 * against the simulated port (sim_port.h), with scripted time, input and
 * console lines. It answers "how often does the UI task wake, and what does
 * it send to the panel?" without a board.
 *
 *   fractonica-fwsim [--face round240|rect240|rect240x320|mono|mono400x300]
 *                    [--t <unix seconds>|none]     start-up clock (default: SPEC vector A)
 *                    [--mode pure|earth] [--focus 0..13] [--utc-offset <minutes>]
 *                    [--band <rows>]               band rendering (0: the whole frame)
 *                    [--seconds <n>]               how long to run (default 3600)
 *                    [--late <us>]                 every deadline wake this late (default 1000)
 *                    [--script "<items>"]          see below
 *                    [--out panel.png]             the panel's memory at the end
 *                    [--brief]                     one line of counters only
 *                    [--stack]                     run the loop on a painted stack and print
 *                                                  its high-water mark (THIS host's ABI: a
 *                                                  64-bit one, so an upper cousin of the
 *                                                  chip's figure, not the figure itself)
 *
 * --script items are separated by ';' and happen in order:
 *   W<ms>          let time pass
 *   N  P  S  L     an input event: next, previous, select, long
 *   anything else  a console line, e.g.  time 1791460800   or   shot
 * e.g. --script "W2000; N; N; W6000; mode earth; W1000; info"
 *
 * What it proves and what it cannot: this is the device's own app_step, so
 * the wake-ups, redraws and flushed windows are the device's - given that
 * the port behaves (the queue, the timers and the drivers are not here).
 */
#define _POSIX_C_SOURCE 200112L /* posix_memalign, under -std=c99 on glibc */

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sim_png.h"
#include "sim_port.h"

static sim_port_t port;
static app_t app;
static uint16_t frame_memory[240 * 320];
static char script_text[4096];

static int usage(void)
{
    fprintf(stderr, "usage: fractonica-fwsim [--face F] [--t <unix s>|none] [--mode pure|earth] [--focus n]\n"
                    "                        [--utc-offset min] [--band rows] [--seconds n] [--late us]\n"
                    "                        [--script \"W<ms>; N; P; S; L; <console line>\"] [--out panel.png] [--brief] [--stack]\n");
    return 2;
}

/* --stack: the loop on its own thread, whose stack was filled with a
 * pattern first; what is no longer the pattern afterwards has been used. */
#define STACK_BYTES (512u * 1024u)
#define STACK_FILL  0xA5

static uint64_t run_ms;

static void *run_loop(void *arg)
{
    (void)arg;
    sim_port_run(&port, &app, run_ms);
    return NULL;
}

/* Returns the high-water mark in bytes, or 0 when the thread could not be made. */
static size_t run_on_painted_stack(void)
{
    pthread_attr_t attr;
    pthread_t thread;
    unsigned char *stack = NULL;
    size_t untouched = 0;

    if (posix_memalign((void **)&stack, 16384, STACK_BYTES) != 0) {
        return 0;
    }
    memset(stack, STACK_FILL, STACK_BYTES);
    pthread_attr_init(&attr);
    if (pthread_attr_setstack(&attr, stack, STACK_BYTES) != 0 || pthread_create(&thread, &attr, run_loop, NULL) != 0) {
        free(stack);
        return 0;
    }
    pthread_join(thread, NULL);
    while (untouched < STACK_BYTES && stack[untouched] == STACK_FILL) { /* the stack grows down */
        untouched++;
    }
    free(stack);
    return STACK_BYTES - untouched;
}

/* Schedule the script; returns the time it ends, in ms, or -1. */
static long long schedule(const char *script)
{
    uint64_t at_ms = 0;
    char *item;

    if (strlen(script) >= sizeof script_text) {
        return -1;
    }
    strcpy(script_text, script);
    for (item = strtok(script_text, ";"); item != NULL; item = strtok(NULL, ";")) {
        size_t n;

        while (*item == ' ') {
            item++;
        }
        n = strlen(item);
        while (n > 0 && item[n - 1] == ' ') {
            item[--n] = '\0';
        }
        if (n == 0) {
            continue;
        }
        if (item[0] == 'W' && n > 1 && strspn(item + 1, "0123456789") == n - 1) {
            at_ms += strtoull(item + 1, NULL, 10);
        } else if (n == 1 && strchr("NPSL", item[0])) {
            fui_event_t event = item[0] == 'N' ? FUI_EV_NEXT : item[0] == 'P' ? FUI_EV_PREV
                                : item[0] == 'S' ? FUI_EV_SELECT : FUI_EV_LONG;

            if (sim_port_event(&port, at_ms, event) != 0) return -1;
        } else if (sim_port_line(&port, at_ms, item) != 0) {
            return -1;
        }
    }
    return (long long)at_ms;
}

int main(int argc, char **argv)
{
    app_config_t config;
    app_port_t api;
    const fui_face_info_t *info;
    const char *script = "", *out = NULL;
    frc_time_t t = FRC_TIME_FROM_S(SIM_VECTOR_A_S);
    long long seconds = 3600, script_end;
    int band = 0, brief = 0, late = 1000, stack = 0, i;
    size_t whole, stack_used = 0;
    char text[176];
    frc_date_t date;

    memset(&config, 0, sizeof config);
    config.face = FUI_FACE_ROUND240;
    config.display_name = "simulated";
    config.settings.version = APP_SETTINGS_VERSION;
    config.settings.focus = FUI_FOCUS_DEFAULT;
    config.settings.brightness = 80;
    for (i = 1; i < argc; i++) {
        const char *arg = argv[i], *value = i + 1 < argc ? argv[i + 1] : NULL;

        if (strcmp(arg, "--brief") == 0) {
            brief = 1;
            continue;
        }
        if (strcmp(arg, "--stack") == 0) {
            stack = 1;
            continue;
        }
        if (!value) {
            return usage();
        }
        i++;
        if (strcmp(arg, "--face") == 0) {
            int face = sim_parse_face(value);

            if (face < 0) return usage();
            config.face = (fui_face_t)face;
        } else if (strcmp(arg, "--mode") == 0) {
            int mode = sim_parse_mode(value);

            if (mode < 0) return usage();
            config.settings.mode = (uint8_t)mode;
        } else if (strcmp(arg, "--t") == 0) {
            t = strcmp(value, "none") == 0 ? FRC_TIME_NONE : frc_time_from_s(strtoll(value, NULL, 10));
        } else if (strcmp(arg, "--focus") == 0) {
            config.settings.focus = (uint8_t)atoi(value);
        } else if (strcmp(arg, "--utc-offset") == 0) {
            config.settings.utc_offset_min = (int16_t)atoi(value);
        } else if (strcmp(arg, "--band") == 0) {
            band = atoi(value);
        } else if (strcmp(arg, "--seconds") == 0) {
            seconds = strtoll(value, NULL, 10);
        } else if (strcmp(arg, "--late") == 0) {
            late = atoi(value);
        } else if (strcmp(arg, "--script") == 0) {
            script = value;
        } else if (strcmp(arg, "--out") == 0) {
            out = value;
        } else {
            return usage();
        }
    }

    info = fui_face_info(config.face);
    config.format = info->mono ? FUI_FMT_MONO_PAGE : FUI_FMT_RGB565_BE; /* as the device */
    whole = fui_canvas_bytes(config.format, info->width, info->height);
    config.buffer = frame_memory;
    config.buffer_bytes = band > 0 && !info->mono ? (size_t)info->width * 2u * (size_t)band : whole;
    if (config.buffer_bytes > whole) {
        config.buffer_bytes = whole;
    }

    sim_port_init(&port, config.face, config.format, t);
    port.late_us = (uint32_t)late;
    api = sim_port_api(&port);
    if (app_init(&app, &config, &api) != 0) {
        fprintf(stderr, "app_init refused the frame buffer (%zu bytes)\n", config.buffer_bytes);
        return 1;
    }
    script_end = schedule(script);
    if (script_end < 0) {
        fprintf(stderr, "the script is too long\n");
        return 2;
    }
    if (seconds * 1000 < script_end) {
        seconds = (script_end + 999) / 1000;
    }
    run_ms = (uint64_t)seconds * 1000u;
    if (stack) {
        stack_used = run_on_painted_stack();
        if (stack_used == 0) {
            fprintf(stderr, "--stack: cannot run on a painted stack here\n");
            return 1;
        }
    } else {
        sim_port_run(&port, &app, run_ms);
    }

    text[0] = '\0';
    if (port.wall_us != FRC_TIME_NONE && frc_date_at(&FRC_SAROS_141, port.wall_us, &date) == FRC_OK) {
        frc_format_date(&date, FRC_DATE_LETTERS, FRC_UNIT_BLINK, text, sizeof text);
    }
    if (brief) {
        printf("%-11s %-5s focus %2d %-12s %6llds: wakes %6u (deadline %6u, message %3u)  redraws %6u  "
               "flushes %6u  pixels %10llu  saves %u\n",
               fui_face_name(config.face), fui_mode_name((fui_mode_t)app.ui.mode), app.ui.focus,
               app.banded ? "bands" : "whole frame", seconds, app.stats.wakes - port.end_wakes,
               app.stats.timeouts - port.end_wakes, app.stats.messages, app.stats.redraws, app.stats.flushes,
               (unsigned long long)app.stats.pixels, app.stats.saves);
    } else {
        if (port.out_length) {
            printf("--- console ---\n%s--- end of console ---\n", port.out);
        }
        printf("face %s, %s (%zu bytes of frame memory), deadline wakes %d us late\n", fui_face_name(config.face),
               app.banded ? "band rendering" : "whole frame", config.buffer_bytes, late);
        printf("ran %lld s; ended on screen %s, mode %s, focus %d; stamp %s\n", seconds,
               fui_screen_name((fui_screen_t)app.ui.screen), fui_mode_name((fui_mode_t)app.ui.mode), app.ui.focus,
               text[0] ? text : (port.wall_us == FRC_TIME_NONE ? "(time not set)" : "(out of catalogue)"));
        printf("wakes   %u  = %u deadline + %u message\n", app.stats.wakes - port.end_wakes,
               app.stats.timeouts - port.end_wakes, app.stats.messages);
        printf("redraws %u, windows flushed %u, pixels flushed %llu, settings saved %u\n", app.stats.redraws,
               app.stats.flushes, (unsigned long long)app.stats.pixels, app.stats.saves);
        printf("panel hash %016llx, flush errors %u\n", (unsigned long long)sim_frame_hash(&port.panel),
               port.flush_errors);
    }
    if (stack) {
        printf("stack   %zu bytes high-water mark of the loop on this host (%zu-bit pointers)\n", stack_used,
               sizeof(void *) * 8);
    }
    if (out) {
        int w, h;
        uint8_t *rgb = sim_frame_rgb(&port.panel, config.face == FUI_FACE_MONO128 ? 4 : 2, &w, &h);

        if (!rgb || sim_png_write(out, rgb, w, h) != 0) {
            fprintf(stderr, "cannot write %s\n", out);
            return 1;
        }
        free(rgb);
    }
    sim_port_free(&port);
    return port.flush_errors ? 1 : 0;
}
