/*
 * app.h - the clock application: the UI task's loop, the settings it keeps
 * and the console commands, WITHOUT a line of ESP-IDF.
 *
 * WHY IT IS PORTABLE
 *   No board is attached to the machine this was written on, and ESP-IDF's
 *   QEMU is not installed there. So everything the firmware decides - when to
 *   wake, what to redraw, what to send to the panel, what a console line
 *   does, when the settings are written - lives in app.c / app_console.c /
 *   app_shot.c, which include only the UI library and the core. They reach
 *   the hardware through the few functions of app_port_t:
 *     main/app_main.c            the ESP-IDF port (FreeRTOS queue, drivers)
 *     sim/src/sim_port.c         the host port (a scripted clock and inputs,
 *                                a model of the panel's memory)
 *   sim/tests/test_firmware.c runs the SAME app_step the device runs and
 *   counts its wake-ups; `make firmware` in sim/ prints them.
 *
 * THE LOOP (one call of app_step)
 *     update   fui_ui_update(now): what changed, how long to sleep
 *     draw     fui_ui_draw into the frame buffer or band by band, then
 *              port.flush of exactly the window that changed
 *     settle   if the user's settings changed, remember when to save them
 *     wait     port.wait(what is left of the UI's sleep after the drawing):
 *              blocks until a message or the deadline
 *     handle   an input event, a console line, "the time was set"
 *   The task never polls: it leaves port.wait only for a reason.
 *
 * THREADS
 *   Everything in this file runs in the UI task. Other tasks (input timers,
 *   the console reader, the network) only put app_msg_t values into the
 *   queue behind port.wait.
 */
#ifndef APP_H
#define APP_H

#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>

#include "fui_ui.h"

#ifdef __cplusplus
extern "C" {
#endif

#define APP_VERSION "0.1.0"

/** The `time` command takes Unix seconds within +-1e11 (about the years
 *  -1200 to 5100): Saros 141's catalogue with millennia to spare on either
 *  side, and 92,000 times inside what int64 microseconds can count. */
#define APP_TIME_LIMIT_S 100000000000LL

/* ------------------------------------------------------------------------- */
/* Messages into the UI task                                                  */
/* ------------------------------------------------------------------------- */

typedef enum app_msg_kind {
    APP_MSG_INPUT = 1, /* `event`: a button or the encoder                       */
    APP_MSG_LINE  = 2, /* `line`: a console line; port.line_done is called after */
    APP_MSG_TIME  = 3  /* the system time was set by somebody (SNTP): look again */
} app_msg_kind_t;

typedef struct app_msg {
    uint8_t     kind;  /* app_msg_kind_t                  */
    uint8_t     event; /* fui_event_t, for APP_MSG_INPUT  */
    const char *line;  /* NUL-terminated, for APP_MSG_LINE */
} app_msg_t;

/* ------------------------------------------------------------------------- */
/* Settings: what is remembered across power cycles                           */
/* ------------------------------------------------------------------------- */

/* The record as it is stored (8 bytes, no padding). A different `version`
 * or an out-of-range field means "use the defaults". */
#define APP_SETTINGS_VERSION 1

typedef struct app_settings {
    uint8_t version;        /* APP_SETTINGS_VERSION                            */
    uint8_t mode;           /* fui_mode_t                                      */
    uint8_t focus;          /* 0..FUI_FOCUS_MAX                                */
    uint8_t screen;         /* fui_screen_t; SCALES is stored as NOW           */
    int16_t utc_offset_min; /* EARTH mode's fixed offset, minutes east         */
    uint8_t brightness;     /* 0..100                                          */
    uint8_t reserved;       /* 0                                               */
} app_settings_t;

/** How long the state must stay unchanged before it is written to flash. */
#define APP_SAVE_SETTLE_MS 5000u

/** 1 when every field is in range (and the version is ours). */
int app_settings_valid(const app_settings_t *settings);

/* ------------------------------------------------------------------------- */
/* The port: everything the application needs from the platform               */
/* ------------------------------------------------------------------------- */

struct app;

typedef struct app_port {
    void *ctx;

    /** Unix microseconds (UTC), or FRC_TIME_NONE while the time is not known. */
    frc_time_t (*now_us)(void *ctx);
    /** A monotonic millisecond counter; it may wrap. */
    uint32_t (*uptime_ms)(void *ctx);
    /**
     * Block until a message arrives (return 1, *msg filled) or `timeout_us`
     * has FULLY passed (return 0). -1: no deadline. Must not return early:
     * the UI treats an early wake as "nothing is due yet".
     */
    int (*wait)(void *ctx, int64_t timeout_us, app_msg_t *msg);
    /**
     * Send the window [x0, x1) x [y0, y1) to the panel. `pixels` holds
     * exactly that window, row after row, in the canvas format; it may be
     * reused as soon as the call returns.
     */
    void (*flush)(void *ctx, int x0, int y0, int x1, int y1, const void *pixels);
    /** Console output (not NUL-terminated: `bytes` long). */
    void (*write)(void *ctx, const char *text, size_t bytes);
    /** The console line of an APP_MSG_LINE has been dealt with. */
    void (*line_done)(void *ctx);
    /** Set the clock (the `time` command). */
    void (*set_time)(void *ctx, frc_time_t unix_us);
    /** Store the settings (called rarely: see APP_SAVE_SETTLE_MS). */
    void (*save)(void *ctx, const app_settings_t *settings);
    /** Apply a brightness, 0..100. */
    void (*brightness)(void *ctx, uint8_t percent);
    /** Print the platform's lines of `info` with app_printf (heap, stacks ...). */
    void (*info)(void *ctx, struct app *app);
    /** Restart the chip (the `reboot` command). May be NULL. */
    void (*restart)(void *ctx);
} app_port_t;

/* ------------------------------------------------------------------------- */
/* The application                                                            */
/* ------------------------------------------------------------------------- */

typedef struct app_config {
    fui_face_t     face;
    fui_format_t   format;       /* FUI_FMT_RGB565_BE for the SPI panels, FUI_FMT_MONO_PAGE */
    void          *buffer;       /* the frame buffer, or a band of it (see app_init)        */
    size_t         buffer_bytes;
    app_settings_t settings;     /* the state to start in (saved, or the build's defaults)  */
    const char    *display_name; /* for `info`                                              */
    uint32_t       min_frame_ms; /* shortest time between two redraws; 0: the UI library's
                                    own (100 ms on colour, 50 ms on one bit). The price of a
                                    fine focus: levels 9..13 change faster than this.       */
} app_config_t;

/** What the loop has done since start-up; `info` prints it. */
typedef struct app_stats {
    uint32_t wakes;    /* returns from port.wait                               */
    uint32_t timeouts; /* ... because the deadline passed                      */
    uint32_t messages; /* ... because a message arrived                        */
    uint32_t redraws;  /* frames drawn (a frame may be several bands)          */
    uint32_t draw_ms;  /* the last redraw: drawing + flushing, in milliseconds */
    uint32_t draw_max_ms; /* the longest one                                   */
    uint32_t flushes;  /* windows sent to the panel                            */
    uint64_t pixels;   /* pixels sent to the panel                             */
    uint32_t saves;    /* settings handed to port.save                         */
    uint32_t late_max_us; /* the latest a deadline wake came after the instant
                             the UI asked for (tick rounding, the scheduler)   */
} app_stats_t;

typedef struct app {
    fui_ui_t       ui;
    fui_canvas_t   canvas;
    app_port_t     port;
    app_stats_t    stats;
    app_settings_t saved;        /* what port.save last got (or what was loaded)        */
    app_settings_t seen;         /* the state at the last look: a change restarts the settle time */
    const char    *display_name;
    void          *buffer;
    size_t         buffer_bytes;
    uint32_t       save_due_ms;  /* when the pending save is due                        */
    uint8_t        save_pending;
    uint8_t        banded;       /* 1: the buffer is smaller than the frame             */
    uint8_t        brightness;
    uint8_t        shot;         /* 1 while a frame is being copied to the console      */
    uint32_t       shot_hash;
    frc_time_t     asked_us;     /* the instant the last fui_ui_update was given ...    */
    uint32_t       asked_ms;     /* ... and the uptime then: sleep_us counts from them  */
    frc_time_t     due_us;       /* the UI's wake instant when the last wait timed out  */
} app_t;

/**
 * Prepare the application. The buffer decides the drawing strategy:
 *   at least the whole frame   one drawing pass per redraw; the changed rows
 *                              are flushed straight from the frame buffer
 *   smaller (colour only)      band rendering: the changed window is drawn
 *                              and flushed in strips as tall as the buffer
 *                              allows (at least one full-width row)
 * @return 0, or -1 when the buffer is too small (less than one row of a
 *         colour face, or less than the whole one-bit frame) or misaligned
 *         (colour buffers must be 2-byte aligned).
 */
int app_init(app_t *app, const app_config_t *config, const app_port_t *port);

/** One turn of the loop (see the top of this file). Returns after ONE wait. */
void app_step(app_t *app);

/** Run one console line now (the UI task does this for APP_MSG_LINE). */
void app_console_line(app_t *app, const char *line);

/** Formatted console output through port.write (at most 191 bytes a call). */
void app_printf(app_t *app, const char *format, ...)
#if defined(__GNUC__)
    __attribute__((format(printf, 2, 3)))
#endif
    ;

/** The user's state as a settings record (SCALES counts as NOW). */
void app_settings_now(const app_t *app, app_settings_t *out);

/* --- used between app.c, app_console.c and app_shot.c ------------------- */

/** Update the UI at the present instant and draw / flush what changed. */
void app_refresh(app_t *app);
/** Redraw the whole face and copy it to the console as text (`shot`). */
void app_shot(app_t *app);
/** Called by the draw loop for each window while a shot is being taken. */
void app_shot_rows(app_t *app, int y0, int y1);
/** Store the settings now if they differ from what is stored (before a restart). */
void app_save_now(app_t *app);
/** Apply and remember a brightness. */
void app_set_brightness(app_t *app, int percent);

#ifdef __cplusplus
}
#endif

#endif /* APP_H */
