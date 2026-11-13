/*
 * app_shot.c - `shot`: the frame on the panel, copied to the console as text
 * so a host script (tools/shot.py) can turn it into a PNG. A screenshot of
 * the real device, taken over the serial cable: hardware in the loop.
 *
 * There may be no frame buffer to read (band rendering), and reading the
 * panel back is not possible on these write-only buses. So a shot REDRAWS:
 * the whole face is invalidated, drawn and flushed as usual, and each strip
 * is copied out as it passes. What the console receives is what the panel
 * received.
 *
 * FORMAT (lines; anything else on the console - log lines - is ignored)
 *   SHOT BEGIN <width> <height> rgb565|mono <face>
 *   SHOT <y> <data>          one line per row, top to bottom
 *   SHOT END <hash>
 * <data>, rgb565: runs of equal pixels, each `nn` `pppp` in hex: nn = run
 *   length 1..255, pppp = the pixel as RGB565 (the VALUE, not its byte order
 *   on the wire). The face is mostly ground, so a frame is 20..60 kB of text
 *   instead of 230.
 * <data>, mono: the row's pixels packed 8 to a byte, leftmost = bit 7, in hex.
 * <hash>: 32-bit FNV-1a over every pixel's value, low byte then high byte,
 *   row by row (a mono pixel is 0 or 1): the script refuses a damaged copy.
 */
#include "app.h"

#define FNV_OFFSET 2166136261u
#define FNV_PRIME  16777619u

static const char HEX[] = "0123456789abcdef";

/* A small line assembler: text goes to the port when the chunk fills. */
typedef struct out {
    app_t *app;
    size_t length;
    char   text[128];
} out_t;

static void out_flush(out_t *o)
{
    if (o->length) {
        o->app->port.write(o->app->port.ctx, o->text, o->length);
        o->length = 0;
    }
}

static void out_hex(out_t *o, unsigned value, int digits)
{
    if (o->length + (size_t)digits > sizeof o->text) {
        out_flush(o);
    }
    while (digits-- > 0) {
        o->text[o->length++] = HEX[(value >> (4 * digits)) & 15u];
    }
}

static uint32_t hash_pixel(uint32_t hash, unsigned value)
{
    hash = (hash ^ (value & 0xFFu)) * FNV_PRIME;
    return (hash ^ (value >> 8)) * FNV_PRIME;
}

void app_shot_rows(app_t *app, int y0, int y1)
{
    const fui_face_info_t *info = fui_face_info((fui_face_t)app->ui.face);
    out_t o;
    int x, y;

    o.app = app;
    o.length = 0;
    for (y = y0; y < y1; y++) {
        app_printf(app, "SHOT %d ", y);
        if (info->mono) {
            unsigned byte = 0;

            for (x = 0; x < info->width; x++) {
                unsigned v = fui_canvas_get(&app->canvas, x, y) ? 1u : 0u;

                app->shot_hash = hash_pixel(app->shot_hash, v);
                byte = (byte << 1) | v;
                if ((x & 7) == 7 || x == info->width - 1) {
                    out_hex(&o, byte << (7 - (x & 7)), 2);
                    byte = 0;
                }
            }
        } else {
            unsigned run = 0, value = 0;

            for (x = 0; x < info->width; x++) {
                unsigned v = fui_canvas_get(&app->canvas, x, y);

                app->shot_hash = hash_pixel(app->shot_hash, v);
                if (run && (v != value || run == 255)) {
                    out_hex(&o, run, 2);
                    out_hex(&o, value, 4);
                    run = 0;
                }
                value = v;
                run++;
            }
            out_hex(&o, run, 2);
            out_hex(&o, value, 4);
        }
        out_flush(&o);
        app_printf(app, "\n");
    }
}

void app_shot(app_t *app)
{
    const fui_face_info_t *info = fui_face_info((fui_face_t)app->ui.face);

    app_printf(app, "SHOT BEGIN %d %d %s %s\n", info->width, info->height, info->mono ? "mono" : "rgb565",
               fui_face_name((fui_face_t)app->ui.face));
    app->shot = 1;
    app->shot_hash = FNV_OFFSET;
    fui_ui_invalidate(&app->ui);
    app_refresh(app); /* draws and flushes the whole face; app_shot_rows copies it */
    app->shot = 0;
    app_printf(app, "SHOT END %08x\n", (unsigned)app->shot_hash);
}
