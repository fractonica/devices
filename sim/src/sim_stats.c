/*
 * sim_stats.c - what one redraw costs: how many primitives the faces ask the
 * rasteriser for, how many pixels they clear and ink, and how long it takes
 * on this host. Host only.
 *
 *   fractonica-stats            NOW at every focus level, the cards, and the
 *                               typical partial redraws, on every face
 *
 * How the calls are counted without touching the library: the Makefile builds
 * a second copy of the rasteriser and the text drawer in which the seven
 * drawing entry points are renamed fui_real_... (a -D per name); this file
 * supplies the functions the faces call, which count and pass on.
 * Pixels: fui_ui_draw clears the dirty rectangle to the ground and draws into
 * it, so "cleared" is the rectangle's area and "inked" is what is not ground
 * afterwards.
 */
#include <stdio.h>
#include <string.h>
#include <time.h>

#include "fui_font.h"
#include "fui_raster.h"
#include "sim_frame.h"

void fui_real_draw_line(fui_canvas_t *c, fui_fx_t x0, fui_fx_t y0, fui_fx_t x1, fui_fx_t y1, fui_fx_t width,
                        fui_color_t color);
void fui_real_draw_arc(fui_canvas_t *c, const fui_arc_t *arc, fui_fx_t width, fui_color_t color);
void fui_real_draw_arc_dotted(fui_canvas_t *c, const fui_arc_t *arc, fui_color_t color, uint8_t *phase);
void fui_real_fill_disc(fui_canvas_t *c, fui_fx_t cx, fui_fx_t cy, fui_fx_t r, fui_color_t color);
void fui_real_draw_ring(fui_canvas_t *c, fui_fx_t cx, fui_fx_t cy, fui_fx_t r, fui_fx_t width, fui_color_t color);
void fui_real_draw_segments(fui_canvas_t *c, const fui_seg_t *segs, int count, fui_fx_t width, fui_color_t color);
int fui_real_text_draw(fui_canvas_t *c, const fui_text_style_t *style, int x, int y, const char *text, size_t bytes);

static struct {
    unsigned arcs, lines, discs, rings, glyphs, texts;
} n;

void fui_draw_line(fui_canvas_t *c, fui_fx_t x0, fui_fx_t y0, fui_fx_t x1, fui_fx_t y1, fui_fx_t width,
                   fui_color_t color)
{
    n.lines++;
    fui_real_draw_line(c, x0, y0, x1, y1, width, color);
}

void fui_draw_arc(fui_canvas_t *c, const fui_arc_t *arc, fui_fx_t width, fui_color_t color)
{
    n.arcs++;
    fui_real_draw_arc(c, arc, width, color);
}

void fui_draw_arc_dotted(fui_canvas_t *c, const fui_arc_t *arc, fui_color_t color, uint8_t *phase)
{
    n.arcs++;
    fui_real_draw_arc_dotted(c, arc, color, phase);
}

void fui_fill_disc(fui_canvas_t *c, fui_fx_t cx, fui_fx_t cy, fui_fx_t r, fui_color_t color)
{
    n.discs++;
    fui_real_fill_disc(c, cx, cy, r, color);
}

void fui_draw_ring(fui_canvas_t *c, fui_fx_t cx, fui_fx_t cy, fui_fx_t r, fui_fx_t width, fui_color_t color)
{
    n.rings++;
    fui_real_draw_ring(c, cx, cy, r, width, color);
}

void fui_draw_segments(fui_canvas_t *c, const fui_seg_t *segs, int count, fui_fx_t width, fui_color_t color)
{
    n.glyphs++;
    fui_real_draw_segments(c, segs, count, width, color);
}

int fui_text_draw(fui_canvas_t *c, const fui_text_style_t *style, int x, int y, const char *text, size_t bytes)
{
    n.texts++;
    return fui_real_text_draw(c, style, x, y, text, bytes);
}

/* Pixels of the frame's dirty rectangle that are not the ground colour. */
static unsigned inked(const fui_ui_t *ui, const sim_frame_t *frame, const fui_rect_t *r)
{
    unsigned count = 0;
    int x, y;

    for (y = r->y0; y < r->y1; y++) {
        for (x = r->x0; x < r->x1; x++) {
            count += fui_canvas_get(&frame->canvas, x, y) != ui->theme->ground;
        }
    }
    return count;
}

/* One redraw of whatever is due at `t`: print a row. Returns the next wake. */
static frc_time_t row(const char *what, fui_ui_t *ui, sim_frame_t *frame, frc_time_t t)
{
    const fui_frame_t *f;
    clock_t start;
    double us;
    int i, rounds = 200;

    memset(&n, 0, sizeof n);
    f = sim_render(ui, frame, t, 0, 0);
    if (!f->redraw) {
        printf("  %-34s nothing to redraw\n", what);
        return f->next_wake;
    }
    printf("  %-34s %3d x %3d = %6d cleared, %5u inked | arcs %3u lines %3u discs %2u rings %2u glyphs %u texts %2u",
           what, f->dirty.x1 - f->dirty.x0, f->dirty.y1 - f->dirty.y0,
           (f->dirty.x1 - f->dirty.x0) * (f->dirty.y1 - f->dirty.y0), inked(ui, frame, &f->dirty), n.arcs, n.lines,
           n.discs, n.rings, n.glyphs, n.texts);
    /* the same draw again and again, for the time (the state does not move) */
    start = clock();
    for (i = 0; i < rounds; i++) {
        fui_ui_draw(ui, &frame->canvas);
    }
    us = (double)(clock() - start) * 1e6 / CLOCKS_PER_SEC / rounds;
    printf(" | %6.1f us\n", us);
    return f->next_wake;
}

int main(void)
{
    static const char *const screens[] = { "now", "scales", "lens", "sun", "stamp" };
    frc_time_t t0 = FRC_TIME_FROM_S(SIM_VECTOR_A_S), wake;
    int face, focus, screen, mode;
    char what[64];

    printf("One redraw at SPEC vector A. cleared = the dirty rectangle, inked = its pixels that are not ground;\n"
           "the time is this host's (fui_ui_draw alone), useful only to compare rows.\n");
    for (face = 0; face < FUI_FACE_COUNT; face++) {
        fui_config_t config;
        sim_frame_t frame;
        fui_ui_t ui;

        printf("\n%s\n", fui_face_name((fui_face_t)face));
        for (focus = 0; focus <= FUI_FOCUS_MAX; focus++) {
            memset(&config, 0, sizeof config);
            config.face = (fui_face_t)face;
            config.focus = (uint8_t)focus;
            fui_ui_init(&ui, &config);
            sim_frame_init(&frame, (fui_face_t)face);
            snprintf(what, sizeof what, "NOW focus %2d, full", focus);
            wake = row(what, &ui, &frame, t0);
            if (focus == 6 || focus == 10) {
                /* the next thing the clock itself changes: the typical partial redraw */
                snprintf(what, sizeof what, "NOW focus %2d, next change", focus);
                if (wake != FRC_TIME_NONE) {
                    wake = row(what, &ui, &frame, wake);
                }
                if (wake != FRC_TIME_NONE) {
                    row(what, &ui, &frame, wake);
                }
            }
        }
        for (screen = FUI_SCREEN_LENS; screen <= FUI_SCREEN_STAMP; screen++) {
            for (mode = FUI_MODE_PURE; mode <= FUI_MODE_EARTH; mode++) {
                memset(&config, 0, sizeof config);
                config.face = (fui_face_t)face;
                config.focus = FUI_FOCUS_DEFAULT;
                config.mode = (fui_mode_t)mode;
                config.utc_offset_s = 7200;
                fui_ui_init(&ui, &config);
                fui_ui_set_screen(&ui, (fui_screen_t)screen);
                sim_frame_init(&frame, (fui_face_t)face);
                snprintf(what, sizeof what, "%s %s, full", screens[screen], fui_mode_name((fui_mode_t)mode));
                wake = row(what, &ui, &frame, t0);
                snprintf(what, sizeof what, "%s %s, next change", screens[screen], fui_mode_name((fui_mode_t)mode));
                if (wake != FRC_TIME_NONE) {
                    wake = row(what, &ui, &frame, wake);
                    if (wake != FRC_TIME_NONE) { /* a look that found nothing is followed by one that does */
                        row(what, &ui, &frame, wake);
                    }
                }
            }
        }
    }
    return 0;
}
