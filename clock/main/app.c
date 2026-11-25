/*
 * app.c - the UI task's loop: update, draw, flush, settle, wait, handle.
 * Portable C99 (see app.h for why); the device and the host simulator run
 * this very file.
 */
#include "app.h"

#include <stdio.h>
#include <string.h>

/* ------------------------------------------------------------------------- */
/* Settings                                                                   */
/* ------------------------------------------------------------------------- */

int app_settings_valid(const app_settings_t *s)
{
    return s->version == APP_SETTINGS_VERSION && s->mode <= FUI_MODE_EARTH && s->focus <= FUI_FOCUS_MAX
           && s->screen < FUI_SCREEN_COUNT && s->utc_offset_min >= -720 && s->utc_offset_min <= 840
           && s->brightness <= 100 && s->reserved == 0;
}

void app_settings_now(const app_t *app, app_settings_t *out)
{
    memset(out, 0, sizeof *out); /* also the padding-free record's reserved byte */
    out->version = APP_SETTINGS_VERSION;
    out->mode = app->ui.mode;
    out->focus = app->ui.focus;
    /* SCALES is a moment of NOW (it falls back by itself), not a place to start in. */
    out->screen = (uint8_t)(app->ui.screen == FUI_SCREEN_SCALES ? FUI_SCREEN_NOW : app->ui.screen);
    out->utc_offset_min = (int16_t)(app->ui.utc_offset_s / 60);
    out->brightness = app->brightness;
}

/*
 * Wear-aware saving: a change (re)starts a settle time; the record is handed
 * to the port only when the state has stayed the same that long, and not at
 * all when the user came back to what is stored. `*timeout_us` is shortened
 * so the loop wakes when the save is due.
 */
static void settle_settings(app_t *app, uint32_t now_ms, int64_t *timeout_us)
{
    app_settings_t now;
    int32_t left_ms;

    app_settings_now(app, &now);
    if (memcmp(&now, &app->seen, sizeof now) != 0) {
        app->seen = now;
        app->save_pending = (uint8_t)(memcmp(&now, &app->saved, sizeof now) != 0);
        app->save_due_ms = now_ms + APP_SAVE_SETTLE_MS;
    }
    if (!app->save_pending) {
        return;
    }
    left_ms = (int32_t)(app->save_due_ms - now_ms); /* wrap-safe */
    if (left_ms <= 0) {
        app->port.save(app->port.ctx, &now);
        app->saved = now;
        app->save_pending = 0;
        app->stats.saves++;
    } else if (*timeout_us < 0 || *timeout_us > (int64_t)left_ms * 1000) {
        *timeout_us = (int64_t)left_ms * 1000;
    }
}

void app_save_now(app_t *app)
{
    app_settings_t now;

    app_settings_now(app, &now);
    if (memcmp(&now, &app->saved, sizeof now) != 0) {
        app->port.save(app->port.ctx, &now);
        app->saved = now;
        app->stats.saves++;
    }
    app->seen = now;
    app->save_pending = 0;
}

void app_set_brightness(app_t *app, int percent)
{
    app->brightness = (uint8_t)(percent < 0 ? 0 : percent > 100 ? 100 : percent);
    app->port.brightness(app->port.ctx, app->brightness);
}

/* ------------------------------------------------------------------------- */
/* Drawing                                                                    */
/* ------------------------------------------------------------------------- */

static void flush(app_t *app, int x0, int y0, int x1, int y1, const void *pixels)
{
    app->port.flush(app->port.ctx, x0, y0, x1, y1, pixels);
    app->stats.flushes++;
    app->stats.pixels += (uint64_t)((x1 - x0) * (y1 - y0));
}

/* The whole frame is in RAM: one drawing pass, then the changed rows go out
 * straight from the frame buffer (full-width rows are contiguous there). */
static void draw_whole(app_t *app, const fui_rect_t *dirty)
{
    const fui_face_info_t *info = fui_face_info((fui_face_t)app->ui.face);
    int y0 = dirty->y0, y1 = dirty->y1;
    size_t offset;

    fui_ui_draw(&app->ui, &app->canvas);
    if (info->mono) {
        /* The SSD1306 takes whole pages of 8 rows; the buffer is laid out so.
         * (A face whose height is not whole pages ends at its last row.) */
        y0 &= ~7;
        y1 = (y1 + 7) & ~7;
        if (y1 > info->height) {
            y1 = info->height;
        }
        offset = (size_t)(y0 / 8) * app->canvas.stride;
    } else {
        offset = (size_t)y0 * app->canvas.stride;
    }
    flush(app, 0, y0, info->width, y1, (const uint8_t *)app->buffer + offset);
    if (app->shot) {
        app_shot_rows(app, dirty->y0, dirty->y1);
    }
}

/* The buffer holds a strip: the changed window is drawn strip by strip, each
 * through a canvas exactly as wide as the window so that its pixels are
 * contiguous. fui_ui_draw is a pure function of the UI state, so every strip
 * shows the same frame. */
static void draw_banded(app_t *app, const fui_rect_t *dirty)
{
    int width = dirty->x1 - dirty->x0;
    int rows = (int)(app->buffer_bytes / 2u / (size_t)width);
    int y;

    for (y = dirty->y0; y < dirty->y1; y += rows) {
        int height = dirty->y1 - y < rows ? dirty->y1 - y : rows;

        fui_canvas_init(&app->canvas, app->buffer, (fui_format_t)app->canvas.format, width, height);
        fui_canvas_set_origin(&app->canvas, dirty->x0, y);
        fui_ui_draw(&app->ui, &app->canvas);
        flush(app, dirty->x0, y, dirty->x1, y + height, app->buffer);
        if (app->shot) {
            app_shot_rows(app, y, y + height);
        }
    }
}

void app_refresh(app_t *app)
{
    uint32_t started_ms = app->port.uptime_ms(app->port.ctx);
    frc_time_t now = app->port.now_us(app->port.ctx);
    const fui_frame_t *frame = fui_ui_update(&app->ui, now, started_ms);

    /* The UI measured its sleep from THIS instant: app_step takes off what
     * the drawing below spends of it (time_left). */
    app->asked_us = now;
    app->asked_ms = started_ms;
    if (app->due_us != FRC_TIME_NONE && now != FRC_TIME_NONE && now >= app->due_us
        && now - app->due_us < INT32_MAX && (uint32_t)(now - app->due_us) > app->stats.late_max_us) {
        app->stats.late_max_us = (uint32_t)(now - app->due_us); /* `info`: how late the device wakes */
    }
    app->due_us = FRC_TIME_NONE;
    if (!frame->redraw) {
        return;
    }
    app->stats.redraws++;
    if (app->banded) {
        draw_banded(app, &frame->dirty);
    } else {
        draw_whole(app, &frame->dirty);
    }
    /* How long the picture took, for `info`: the first thing to look at on a
     * board, where rasterising and the bus are no longer free. */
    app->stats.draw_ms = app->port.uptime_ms(app->port.ctx) - started_ms;
    if (app->stats.draw_ms > app->stats.draw_max_ms) {
        app->stats.draw_max_ms = app->stats.draw_ms;
    }
}

/* ------------------------------------------------------------------------- */
/* The loop                                                                   */
/* ------------------------------------------------------------------------- */

int app_init(app_t *app, const app_config_t *config, const app_port_t *port)
{
    const fui_face_info_t *info = fui_face_info(config->face);
    fui_config_t ui;
    size_t whole;

    if (info == NULL || config->buffer == NULL || (info->mono != 0) != (config->format >= FUI_FMT_MONO_PAGE)) {
        return -1;
    }
    whole = fui_canvas_bytes(config->format, info->width, info->height);
    if (!info->mono && ((uintptr_t)config->buffer & 1u)) {
        return -1; /* 16-bit pixels are written as such */
    }

    memset(app, 0, sizeof *app);
    app->port = *port;
    app->display_name = config->display_name;
    app->asked_us = app->due_us = FRC_TIME_NONE;
    app->buffer = config->buffer;
    app->buffer_bytes = config->buffer_bytes;
    if (config->buffer_bytes >= whole) {
        fui_canvas_init(&app->canvas, config->buffer, config->format, info->width, info->height);
        fui_canvas_clear(&app->canvas, 0);
    } else if (!info->mono && config->buffer_bytes >= (size_t)info->width * 2u) {
        app->banded = 1;
        app->canvas.format = (uint8_t)config->format; /* the canvas is made per window */
    } else {
        return -1;
    }

    memset(&ui, 0, sizeof ui);
    ui.face = config->face;
    ui.mode = (fui_mode_t)config->settings.mode;
    ui.focus = config->settings.focus;
    ui.utc_offset_s = (int32_t)config->settings.utc_offset_min * 60;
    ui.min_frame_us = config->min_frame_ms * 1000u;
    fui_ui_init(&app->ui, &ui);
    if (config->settings.screen != FUI_SCREEN_NOW && config->settings.screen != FUI_SCREEN_SCALES) {
        fui_ui_set_screen(&app->ui, (fui_screen_t)config->settings.screen);
    }
    app_set_brightness(app, config->settings.brightness);
    /* What we start from is what is stored (or the build's defaults, which
     * need no storing): nothing is written until the user changes something. */
    app_settings_now(app, &app->saved);
    app->seen = app->saved;
    return 0;
}

/*
 * What is left of the UI's sleep once the frame is drawn and flushed. The UI
 * said "sleep_us from the instant you gave me", and drawing a whole colour
 * frame costs tens of milliseconds of rasterising and bus: waiting the full
 * sleep_us from here would show every change that much late, and space the
 * frames min_frame + draw time apart instead of min_frame. Measured on the
 * wall clock the UI was given (microseconds), or on the monotonic clock
 * while the time is not set (only a brief label's end is waited for then).
 * Never negative (a frame that took longer than the sleep: wake at once;
 * port.wait still yields a tick), never longer than sleep_us (a clock set
 * meanwhile by another task: its message wakes the loop anyway).
 */
static int64_t time_left(app_t *app)
{
    int64_t sleep = app->ui.frame.sleep_us, spent;
    frc_time_t now;

    if (sleep < 0) {
        return -1;
    }
    now = app->asked_us != FRC_TIME_NONE ? app->port.now_us(app->port.ctx) : FRC_TIME_NONE;
    if (now != FRC_TIME_NONE) {
        spent = now - app->asked_us;
    } else {
        spent = (int64_t)(uint32_t)(app->port.uptime_ms(app->port.ctx) - app->asked_ms) * 1000;
    }
    if (spent <= 0) {
        return sleep;
    }
    return spent >= sleep ? 0 : sleep - spent;
}

void app_step(app_t *app)
{
    app_msg_t msg;
    int64_t timeout_us, ui_left;
    uint32_t now_ms;

    app_refresh(app);
    timeout_us = ui_left = time_left(app);
    settle_settings(app, app->port.uptime_ms(app->port.ctx), &timeout_us);

    memset(&msg, 0, sizeof msg);
    if (!app->port.wait(app->port.ctx, timeout_us, &msg)) {
        app->stats.wakes++;
        app->stats.timeouts++;
        if (timeout_us == ui_left) {
            app->due_us = app->ui.frame.next_wake; /* the UI's deadline, not a save's */
        }
        return; /* the deadline: the next step's update finds what is due */
    }
    app->stats.wakes++;
    app->stats.messages++;
    now_ms = app->port.uptime_ms(app->port.ctx);
    switch (msg.kind) {
    case APP_MSG_INPUT:
        (void)fui_ui_event(&app->ui, (fui_event_t)msg.event, now_ms);
        break;
    case APP_MSG_LINE:
        if (msg.line != NULL) {
            app_console_line(app, msg.line);
        }
        if (app->port.line_done) {
            app->port.line_done(app->port.ctx);
        }
        break;
    case APP_MSG_TIME:
    default:
        break; /* nothing to do but look at the clock again */
    }
}

void app_printf(app_t *app, const char *format, ...)
{
    char text[192];
    va_list args;
    int n;

    va_start(args, format);
    n = vsnprintf(text, sizeof text, format, args);
    va_end(args);
    if (n < 0) {
        return;
    }
    if ((size_t)n >= sizeof text) {
        n = (int)sizeof text - 1;
    }
    app->port.write(app->port.ctx, text, (size_t)n);
}
