/*
 * sim_main.c - the host simulator: any face / screen / mode / instant to PNG.
 *
 *   fractonica-sim --face round240|rect240|rect240x320|mono
 *                  --screen now|scales|lens|sun|stamp
 *                  --mode pure|earth
 *                  --t <unix seconds> | none        default: SPEC vector A
 *                  --focus <level 0..13>            default: 6 (the Helion)
 *                  --events "<N P S L W500 ...>"    after reaching --screen
 *                  --page <n>                       then show page n of the card (from 1;
 *                                                   past the last: the last)
 *                  --utc-offset <seconds>           EARTH mode's fixed offset
 *                  --scale <n>                      default 2 (colour), 4 (one-bit)
 *                  --band <rows>                    render through a band canvas
 *                  --lines                          also print the text lines of the page
 *                  --out file.png
 *   fractonica-sim --info                           sizes of the UI state
 *   fractonica-sim --bench                          time and arc count per face
 *
 * It links the same fractonica_ui sources the firmware builds, and the core
 * from the core. Prints the stamp (and the state reached) so a shot can be
 * checked against SPEC S12 without opening the picture.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "sim_frame.h"
#include "sim_png.h"

static int usage(void)
{
    fprintf(stderr,
            "usage: fractonica-sim [--face round240|rect240|rect240x320|mono] [--screen now|scales|lens|sun|stamp]\n"
            "                      [--mode pure|earth] [--t <unix seconds>|none] [--focus 0..13]\n"
            "                      [--events \"N P S L W<ms>\"] [--page n] [--utc-offset <s>] [--scale n] [--band rows]\n"
            "                      [--lines] --out file.png\n"
            "       fractonica-sim --info | --bench\n");
    return 2;
}

static void print_info(void)
{
    int face;

    printf("sizeof(fui_ui_t)      %zu bytes (this host; see `make sizes` for the 32-bit targets)\n", sizeof(fui_ui_t));
    printf("  fui_reading_t       %zu\n", sizeof(fui_reading_t));
    printf("  fui_ring_t          %zu  (%d arcs of %zu bytes)\n", sizeof(fui_ring_t),
           FUI_RING_CHILDREN + FUI_RING_GRAND, sizeof(fui_arc16_t));
    printf("sizeof(fui_canvas_t)  %zu\n", sizeof(fui_canvas_t));
    for (face = 0; face < FUI_FACE_COUNT; face++) {
        const fui_face_info_t *info = fui_face_info((fui_face_t)face);
        fui_format_t format = info->mono ? FUI_FMT_MONO_PAGE : FUI_FMT_RGB565;

        printf("frame buffer %-12s %3d x %3d  %6zu bytes   (a 40-row band: %zu)\n", fui_face_name((fui_face_t)face),
               info->width, info->height, fui_canvas_bytes(format, info->width, info->height),
               fui_canvas_bytes(format, info->width, info->mono ? info->height : 40));
    }
}

/* Full redraws per second on this host, for each face on NOW at vector A. */
static void bench(void)
{
    int face;

    for (face = 0; face < FUI_FACE_COUNT; face++) {
        fui_config_t config;
        fui_ui_t ui;
        sim_frame_t frame;
        clock_t start;
        int i, rounds = 300;
        frc_time_t t = FRC_TIME_FROM_S(SIM_VECTOR_A_S);

        memset(&config, 0, sizeof config);
        config.face = (fui_face_t)face;
        config.focus = FUI_FOCUS_DEFAULT;
        fui_ui_init(&ui, &config);
        sim_frame_init(&frame, (fui_face_t)face);
        start = clock();
        for (i = 0; i < rounds; i++) {
            fui_ui_invalidate(&ui);
            sim_render(&ui, &frame, t, 0, 0);
        }
        printf("%-12s NOW, full redraw: %7.1f us   arcs in the focused ring: %d + %d\n",
               fui_face_name((fui_face_t)face),
               (double)(clock() - start) * 1e6 / CLOCKS_PER_SEC / rounds, ui.ring.children,
               ui.ring.children * ui.ring.per_child);
    }
}

/* --lines: what the page says, as written (capitals are folded when drawn). */
static void print_line(void *ctx, const char *text, size_t bytes, int x, int y, const fui_text_style_t *style)
{
    (void)ctx;
    printf("  (%3d, %3d) %3d wide, %d px/dot, %s  %.*s\n", x, y, fui_text_width(style, text, bytes), style->scale,
           (style->flags & FUI_TEXT_CAPS) ? "CAPS" : "as is", (int)bytes, text);
}

int main(int argc, char **argv)
{
    fui_config_t config;
    fui_ui_t ui;
    sim_frame_t frame;
    const char *out = NULL, *events = "";
    int screen = FUI_SCREEN_NOW, scale = 0, band = 0, lines = 0, page = 0, i, w, h;
    frc_time_t t = FRC_TIME_FROM_S(SIM_VECTOR_A_S);
    uint32_t ms = 0;
    const fui_frame_t *f;
    uint8_t *rgb;
    char text[176];
    frc_date_t date;

    memset(&config, 0, sizeof config);
    config.face = FUI_FACE_ROUND240;
    config.focus = FUI_FOCUS_DEFAULT;
    for (i = 1; i < argc; i++) {
        const char *arg = argv[i], *value = i + 1 < argc ? argv[i + 1] : NULL;

        if (strcmp(arg, "--info") == 0) {
            print_info();
            return 0;
        }
        if (strcmp(arg, "--bench") == 0) {
            bench();
            return 0;
        }
        if (strcmp(arg, "--lines") == 0) {
            lines = 1;
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
        } else if (strcmp(arg, "--screen") == 0) {
            if ((screen = sim_parse_screen(value)) < 0) return usage();
        } else if (strcmp(arg, "--mode") == 0) {
            int mode = sim_parse_mode(value);

            if (mode < 0) return usage();
            config.mode = (fui_mode_t)mode;
        } else if (strcmp(arg, "--t") == 0) {
            t = strcmp(value, "none") == 0 ? FRC_TIME_NONE : frc_time_from_s(strtoll(value, NULL, 10));
        } else if (strcmp(arg, "--focus") == 0) {
            config.focus = (uint8_t)atoi(value);
        } else if (strcmp(arg, "--events") == 0) {
            events = value;
        } else if (strcmp(arg, "--page") == 0) {
            page = atoi(value);
        } else if (strcmp(arg, "--utc-offset") == 0) {
            config.utc_offset_s = atoi(value);
        } else if (strcmp(arg, "--scale") == 0) {
            scale = atoi(value);
        } else if (strcmp(arg, "--band") == 0) {
            band = atoi(value);
        } else if (strcmp(arg, "--out") == 0) {
            out = value;
        } else {
            return usage();
        }
    }
    if (!out) {
        return usage();
    }
    if (scale <= 0) {
        scale = fui_face_info(config.face)->mono ? 4 : 2;
    }

    fui_ui_init(&ui, &config);
    sim_frame_init(&frame, config.face);
    fui_ui_update(&ui, t, ms); /* the clock is read before the first event, as on the device */
    sim_goto_screen(&ui, (fui_screen_t)screen, ms);
    if (sim_script(&ui, events, &t, &ms) != 0) {
        fprintf(stderr, "bad --events: use N P S L and W<ms>\n");
        return 2;
    }
    if (page > 0) {
        ui.page = (uint8_t)(page - 1);
    }
    fui_ui_invalidate(&ui);
    f = sim_render(&ui, &frame, t, ms, band);

    rgb = sim_frame_rgb(&frame, scale, &w, &h);
    if (!rgb || sim_png_write(out, rgb, w, h) != 0) {
        fprintf(stderr, "cannot write %s\n", out);
        return 1;
    }
    free(rgb);

    /* The console always says the stamp: it is how a shot is told apart. */
    text[0] = '\0';
    if (t != FRC_TIME_NONE && frc_date_at(&FRC_SAROS_141, t, &date) == FRC_OK) {
        frc_format_date(&date, FRC_DATE_LETTERS, FRC_UNIT_BLINK, text, sizeof text);
    }
    printf("%s: %s %s %s focus %d lens %d page %d/%d | %s | sleep %lld us | hash %016llx\n", out,
           fui_face_name(config.face), fui_screen_name((fui_screen_t)ui.screen), fui_mode_name((fui_mode_t)ui.mode),
           ui.focus, ui.lens_level, ui.page + 1, fui_ui_pages(&ui),
           text[0] ? text : (t == FRC_TIME_NONE ? "time not set" : "out of catalogue"),
           (long long)f->sleep_us, (unsigned long long)sim_frame_hash(&frame));
    if (lines) {
        fui_ui_lines(&ui, print_line, NULL);
    }
    return 0;
}
