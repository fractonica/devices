/*
 * sim_port.c - see sim_port.h.
 */
#include "sim_port.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------------------- */
/* app_port_t                                                                 */
/* ------------------------------------------------------------------------- */

static frc_time_t port_now_us(void *ctx)
{
    return ((sim_port_t *)ctx)->wall_us;
}

static uint32_t port_uptime_ms(void *ctx)
{
    return (uint32_t)(((sim_port_t *)ctx)->mono_us / 1000u);
}

static void advance(sim_port_t *p, uint64_t to_us)
{
    if (to_us > p->mono_us) {
        if (p->wall_us != FRC_TIME_NONE) {
            p->wall_us += (frc_time_t)(to_us - p->mono_us);
        }
        p->mono_us = to_us;
    }
}

/* No sleeping: jump to whatever comes first - a scripted message, the
 * deadline, or the end of the run. */
static int port_wait(void *ctx, int64_t timeout_us, app_msg_t *msg)
{
    sim_port_t *p = ctx;
    uint64_t deadline = timeout_us < 0 ? UINT64_MAX : p->mono_us + (uint64_t)timeout_us + p->late_us;
    uint64_t message = p->script_next < p->script_count ? p->script[p->script_next].at_us : UINT64_MAX;

    if (message <= deadline && message <= p->end_us) {
        advance(p, message);
        *msg = p->script[p->script_next++].msg;
        return 1;
    }
    if (deadline <= p->end_us) {
        advance(p, deadline);
        return 0;
    }
    advance(p, p->end_us);
    p->ended = 1;
    p->end_wakes++;
    return 0;
}

/* The panel's controller: put the window's pixels where it says. The checks
 * are the real drivers' (fhal_display_spi.c, fhal_display_ssd1306.c). */
static void port_flush(void *ctx, int x0, int y0, int x1, int y1, const void *pixels)
{
    sim_port_t *p = ctx;
    const fui_face_info_t *info = fui_face_info(p->panel.face);
    const uint8_t *bytes = pixels;
    int x, y, width = x1 - x0;

    if (x0 < 0 || y0 < 0 || x1 > info->width || y1 > info->height || x0 >= x1 || y0 >= y1 || pixels == NULL) {
        p->flush_errors++;
        return;
    }
    /* The bus is busy while the window goes out; the flush returns after. */
    advance(p, p->mono_us + (uint64_t)(x1 - x0) * (uint64_t)(y1 - y0) * p->bus_ns_per_px / 1000u);
    if (info->mono) {
        if (x0 != 0 || x1 != info->width || (y0 & 7) || ((y1 & 7) && y1 != info->height)) {
            p->flush_errors++; /* the SSD1306 takes whole pages of whole rows (the last may be short) */
            return;
        }
        for (y = y0; y < y1; y++) {
            for (x = 0; x < width; x++) {
                int bit = (bytes[x + ((y - y0) / 8) * width] >> (y & 7)) & 1;

                fui_canvas_pixel(&p->panel.canvas, x, y, (fui_color_t)bit);
            }
        }
        return;
    }
    for (y = y0; y < y1; y++) {
        for (x = x0; x < x1; x++) {
            const uint8_t *px = bytes + ((size_t)(y - y0) * (size_t)width + (size_t)(x - x0)) * 2u;
            uint16_t value;

            if (p->format == FUI_FMT_RGB565_BE) {
                value = (uint16_t)((px[0] << 8) | px[1]); /* as the SPI panel reads the wire */
            } else {
                memcpy(&value, px, 2);
            }
            fui_canvas_pixel(&p->panel.canvas, x, y, value);
        }
    }
}

static void port_write(void *ctx, const char *text, size_t bytes)
{
    sim_port_t *p = ctx;

    if (p->out_length + bytes + 1 > p->out_room) {
        size_t room = (p->out_length + bytes + 1) * 2;
        char *grown = realloc(p->out, room);

        if (!grown) {
            return;
        }
        p->out = grown;
        p->out_room = room;
    }
    memcpy(p->out + p->out_length, text, bytes);
    p->out_length += bytes;
    p->out[p->out_length] = '\0';
}

static void port_line_done(void *ctx)
{
    (void)ctx;
}

static void port_set_time(void *ctx, frc_time_t unix_us)
{
    sim_port_t *p = ctx;

    p->wall_us = unix_us;
    p->time_sets++;
}

static void port_save(void *ctx, const app_settings_t *settings)
{
    sim_port_t *p = ctx;

    p->stored = *settings;
    p->saves++;
}

static void port_brightness(void *ctx, uint8_t percent)
{
    ((sim_port_t *)ctx)->brightness = percent;
}

static void port_info(void *ctx, app_t *app)
{
    sim_port_t *p = ctx;

    app_printf(app, "host     simulated port, up %llu ms\n", (unsigned long long)(p->mono_us / 1000u));
}

static void port_restart(void *ctx)
{
    ((sim_port_t *)ctx)->restarts++;
}

app_port_t sim_port_api(sim_port_t *port)
{
    app_port_t api;

    memset(&api, 0, sizeof api);
    api.ctx = port;
    api.now_us = port_now_us;
    api.uptime_ms = port_uptime_ms;
    api.wait = port_wait;
    api.flush = port_flush;
    api.write = port_write;
    api.line_done = port_line_done;
    api.set_time = port_set_time;
    api.save = port_save;
    api.brightness = port_brightness;
    api.info = port_info;
    api.restart = port_restart;
    return api;
}

/* ------------------------------------------------------------------------- */

void sim_port_init(sim_port_t *port, fui_face_t face, fui_format_t format, frc_time_t wall)
{
    const fui_face_info_t *info = fui_face_info(face);

    memset(port, 0, sizeof *port);
    port->wall_us = wall;
    port->format = format;
    port->brightness = -1;
    /* SPI at 40 MHz, 16 bits a pixel; I2C at 400 kHz, 9 clocks a byte of 8 pixels */
    port->bus_ns_per_px = info->mono ? 2813u : 400u;
    port->panel.face = face;
    fui_canvas_init(&port->panel.canvas, port->panel_memory, info->mono ? FUI_FMT_MONO_PAGE : FUI_FMT_RGB565,
                    info->width, info->height);
}

void sim_port_free(sim_port_t *port)
{
    free(port->out);
    port->out = NULL;
    port->out_length = port->out_room = 0;
}

void sim_port_clear_output(sim_port_t *port)
{
    port->out_length = 0;
    if (port->out) {
        port->out[0] = '\0';
    }
}

static int schedule(sim_port_t *port, uint64_t at_ms, const app_msg_t *msg)
{
    if (port->script_count >= SIM_SCRIPT_MAX) {
        return -1;
    }
    port->script[port->script_count].at_us = at_ms * 1000u;
    port->script[port->script_count].msg = *msg;
    port->script_count++;
    return 0;
}

int sim_port_event(sim_port_t *port, uint64_t at_ms, fui_event_t event)
{
    app_msg_t msg = { APP_MSG_INPUT, (uint8_t)event, NULL };

    return schedule(port, at_ms, &msg);
}

int sim_port_line(sim_port_t *port, uint64_t at_ms, const char *line)
{
    app_msg_t msg = { APP_MSG_LINE, 0, line };

    return schedule(port, at_ms, &msg);
}

int sim_port_time_changed(sim_port_t *port, uint64_t at_ms)
{
    app_msg_t msg = { APP_MSG_TIME, 0, NULL };

    return schedule(port, at_ms, &msg);
}

void sim_port_run(sim_port_t *port, app_t *app, uint64_t until_ms)
{
    port->end_us = until_ms * 1000u;
    port->ended = 0;
    while (!port->ended) {
        app_step(app);
    }
    app_refresh(app);
}

/* ------------------------------------------------------------------------- */
/* Reading a `shot` back (the C twin of tools/shot.py)                        */
/* ------------------------------------------------------------------------- */

static int hex_value(const char *p, int digits, unsigned *out)
{
    unsigned v = 0;

    while (digits-- > 0) {
        char c = *p++;

        if (c >= '0' && c <= '9') v = v * 16 + (unsigned)(c - '0');
        else if (c >= 'a' && c <= 'f') v = v * 16 + (unsigned)(c - 'a' + 10);
        else return -1;
    }
    *out = v;
    return 0;
}

int sim_shot_decode(const char *text, sim_frame_t *frame, uint16_t *memory)
{
    const char *begin = NULL, *line, *scan = text;
    char kind[16], face_name[32];
    int width, height, face, rows = 0;
    uint32_t hash = 2166136261u;
    unsigned wanted;

    while ((scan = strstr(scan, "SHOT BEGIN ")) != NULL) { /* the last one */
        begin = scan;
        scan += 11;
    }
    if (!begin || sscanf(begin, "SHOT BEGIN %d %d %15s %31s", &width, &height, kind, face_name) != 4
        || (face = sim_parse_face(face_name)) < 0) {
        return -1;
    }
    frame->face = (fui_face_t)face;
    fui_canvas_init(&frame->canvas, memory, strcmp(kind, "mono") == 0 ? FUI_FMT_MONO_PAGE : FUI_FMT_RGB565, width,
                    height);
    memset(memory, 0, fui_canvas_bytes((fui_format_t)frame->canvas.format, width, height));

    for (line = strchr(begin, '\n'); line != NULL; line = strchr(line, '\n')) {
        int y, used, x = 0;
        const char *p;

        line++;
        if (strncmp(line, "SHOT END ", 9) == 0) {
            return hex_value(line + 9, 8, &wanted) == 0 && wanted == hash && rows == height ? 0 : -1;
        }
        if (sscanf(line, "SHOT %d %n", &y, &used) != 1) {
            continue; /* a log line between the rows */
        }
        if (y != rows) {
            return -1;
        }
        p = line + used;
        if (strcmp(kind, "mono") == 0) {
            for (; x < width; x += 8, p += 2) {
                unsigned byte;
                int bit;

                if (hex_value(p, 2, &byte) != 0) return -1;
                for (bit = 0; bit < 8 && x + bit < width; bit++) {
                    unsigned v = (byte >> (7 - bit)) & 1u;

                    fui_canvas_pixel(&frame->canvas, x + bit, y, (fui_color_t)v);
                    hash = (hash ^ v) * 16777619u;
                    hash = (hash ^ 0u) * 16777619u;
                }
            }
        } else {
            while (x < width) {
                unsigned run, value;

                if (hex_value(p, 2, &run) != 0 || hex_value(p + 2, 4, &value) != 0 || run == 0) return -1;
                p += 6;
                for (; run > 0 && x < width; run--, x++) {
                    fui_canvas_pixel(&frame->canvas, x, y, (fui_color_t)value);
                    hash = (hash ^ (value & 0xFFu)) * 16777619u;
                    hash = (hash ^ (value >> 8)) * 16777619u;
                }
            }
        }
        rows++;
    }
    return -1; /* no SHOT END */
}
