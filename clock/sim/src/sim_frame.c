/*
 * sim_frame.c - see sim_frame.h.
 */
#include "sim_frame.h"

#include <stdlib.h>
#include <string.h>

/* One static buffer serves every face: the largest is 240 x 320 RGB565
 * (the 400 x 300 one-bit face takes 15,200 bytes of it). */
static uint16_t frame_buffer[240 * 320];
static uint16_t band_buffer[240 * 64];

void sim_frame_init(sim_frame_t *frame, fui_face_t face)
{
    const fui_face_info_t *info = fui_face_info(face);

    frame->face = face;
    memset(frame_buffer, 0, sizeof frame_buffer);
    fui_canvas_init(&frame->canvas, frame_buffer, info->mono ? FUI_FMT_MONO_PAGE : FUI_FMT_RGB565,
                    info->width, info->height);
}

static int lookup(const char *name, const char *(*label)(int), int count)
{
    int i;

    for (i = 0; i < count; i++) {
        if (strcmp(name, label(i)) == 0) {
            return i;
        }
    }
    return -1;
}

static const char *face_label(int i)   { return fui_face_name((fui_face_t)i); }
static const char *screen_label(int i) { return fui_screen_name((fui_screen_t)i); }
static const char *mode_label(int i)   { return fui_mode_name((fui_mode_t)i); }

int sim_parse_face(const char *name)   { return lookup(name, face_label, FUI_FACE_COUNT); }
int sim_parse_screen(const char *name) { return lookup(name, screen_label, FUI_SCREEN_COUNT); }
int sim_parse_mode(const char *name)   { return lookup(name, mode_label, 2); }

int sim_parse_step(const char *name)
{
    static const char *const names[] = { "none", "helion", "theta", "preon", "kappa", "flavon" };
    static const int levels[] = { FUI_STEP_NONE, FUI_STEP_HELION, FUI_STEP_THETA, FUI_STEP_PREON, FUI_STEP_KAPPA,
                                  FUI_STEP_FLAVON };
    char *end;
    long level;
    size_t i;

    for (i = 0; i < sizeof names / sizeof names[0]; i++) {
        if (strcmp(name, names[i]) == 0) {
            return levels[i];
        }
    }
    level = strtol(name, &end, 10);
    if (*name != '\0' && *end == '\0' && (level == FUI_STEP_NONE || (level >= FUI_STEP_HELION && level <= FUI_STEP_FLAVON))) {
        return (int)level;
    }
    return -1;
}

void sim_goto_screen(fui_ui_t *ui, fui_screen_t screen, uint32_t ms)
{
    fui_ui_set_screen(ui, FUI_SCREEN_NOW);
    if (screen == FUI_SCREEN_SCALES) {
        /* a step and back: same focus, the name showing */
        fui_ui_event(ui, FUI_EV_NEXT, ms);
        fui_ui_event(ui, FUI_EV_PREV, ms);
    } else {
        /* a card, on its first page (SELECT would first turn the pages of
         * the cards before it, and how many those have depends on the face) */
        fui_ui_set_screen(ui, screen);
    }
}

int sim_script(fui_ui_t *ui, const char *script, frc_time_t *t, uint32_t *ms)
{
    const char *p;

    for (p = script; *p != '\0'; p++) {
        switch (*p) {
        case ' ': case ',':
            break;
        /* as the firmware does: an event, then an update right away */
        case 'N': fui_ui_event(ui, FUI_EV_NEXT, *ms);   fui_ui_update(ui, *t, *ms); break;
        case 'P': fui_ui_event(ui, FUI_EV_PREV, *ms);   fui_ui_update(ui, *t, *ms); break;
        case 'S': fui_ui_event(ui, FUI_EV_SELECT, *ms); fui_ui_update(ui, *t, *ms); break;
        case 'L': fui_ui_event(ui, FUI_EV_LONG, *ms);   fui_ui_update(ui, *t, *ms); break;
        case 'W': {
            char *end;
            unsigned long wait = strtoul(p + 1, &end, 10);

            *ms += (uint32_t)wait;
            p = end - 1;
            /* waited time passes on the real clock too */
            if (*t != FRC_TIME_NONE) {
                *t += (frc_time_t)wait * 1000;
            }
            fui_ui_update(ui, *t, *ms);
            break;
        }
        default:
            return -1;
        }
    }
    return 0;
}

const fui_frame_t *sim_render(fui_ui_t *ui, sim_frame_t *frame, frc_time_t t, uint32_t ms, int band)
{
    const fui_frame_t *f = fui_ui_update(ui, t, ms);
    const fui_face_info_t *info = fui_face_info(frame->face);

    if (!f->redraw) {
        return f;
    }
    if (band <= 0) {
        fui_ui_draw(ui, &frame->canvas);
    } else {
        /* Band after band through a small canvas, copied into the frame the
         * way a driver would send each band to the panel. */
        fui_canvas_t strip;
        int y, x, row;

        if (band > 64) {
            band = 64;
        }
        if (info->mono) {
            band = (band + 7) / 8 * 8; /* SSD1306 pages are 8 rows */
        }
        fui_canvas_init(&strip, band_buffer, (fui_format_t)frame->canvas.format, info->width, band);
        for (y = 0; y < info->height; y += band) {
            fui_rect_t part;

            fui_canvas_set_origin(&strip, 0, y);
            fui_ui_draw(ui, &strip);
            if (!fui_canvas_dirty(&strip, &part)) {
                continue;
            }
            for (row = part.y0; row < part.y1; row++) {
                for (x = part.x0; x < part.x1; x++) {
                    fui_canvas_pixel(&frame->canvas, x, row, fui_canvas_get(&strip, x, row));
                }
            }
        }
    }
    return f;
}

uint64_t sim_frame_hash(const sim_frame_t *frame)
{
    const fui_face_info_t *info = fui_face_info(frame->face);
    uint64_t h = 1469598103934665603ULL;
    int x, y;

    for (y = 0; y < info->height; y++) {
        for (x = 0; x < info->width; x++) {
            fui_color_t v = fui_canvas_get(&frame->canvas, x, y);

            h = (h ^ (v & 0xFFu)) * 1099511628211ULL;
            h = (h ^ (v >> 8)) * 1099511628211ULL;
        }
    }
    return h;
}

uint8_t *sim_frame_rgb(const sim_frame_t *frame, int scale, int *w, int *h)
{
    const fui_face_info_t *info = fui_face_info(frame->face);
    int width = info->width * scale, height = info->height * scale, x, y;
    uint8_t *rgb = malloc((size_t)width * (size_t)height * 3u);

    if (!rgb) {
        return NULL;
    }
    for (y = 0; y < height; y++) {
        for (x = 0; x < width; x++) {
            int sx = x / scale, sy = y / scale;
            fui_color_t v = fui_canvas_get(&frame->canvas, sx, sy);
            uint8_t *out = rgb + ((size_t)y * (size_t)width + (size_t)x) * 3u;

            if (info->mono) {
                /* a set bit white, a clear bit near black: an OLED's lit pixel,
                 * or the paper face's ground (fui_theme_paper: black ink on
                 * white). On the OLED from 3x up the last row and column of
                 * each pixel are the gap between dots; paper has none. */
                int gap = frame->face == FUI_FACE_MONO128 && scale >= 3 &&
                          (x % scale == scale - 1 || y % scale == scale - 1);
                uint8_t level = v ? (uint8_t)(gap ? 70 : 255) : (uint8_t)(gap ? 0 : 16);

                out[0] = out[1] = out[2] = level;
            } else {
                out[0] = (uint8_t)(((v >> 11) & 31u) * 255u / 31u);
                out[1] = (uint8_t)(((v >> 5) & 63u) * 255u / 63u);
                out[2] = (uint8_t)((v & 31u) * 255u / 31u);
                if (info->round) {
                    /* what the round glass hides: everything past r = 120 */
                    int dx = 2 * sx + 1 - info->width, dy = 2 * sy + 1 - info->height;

                    if (dx * dx + dy * dy > info->width * info->width) {
                        out[0] = 38; out[1] = 40; out[2] = 44;
                    }
                }
            }
        }
    }
    *w = width;
    *h = height;
    return rgb;
}
