/*
 * sim_frame.h - host-side plumbing shared by the simulator and its tests:
 * a frame buffer for any face, scripted input, pixels out as RGB, a hash.
 * Host only: this may use the C library (the UI library does not).
 */
#ifndef SIM_FRAME_H
#define SIM_FRAME_H

#include "fui_ui.h"

/* The vector every shot and golden image is taken at: SPEC S12, vector A. */
#define SIM_VECTOR_A_S 1791460800LL

typedef struct sim_frame {
    fui_face_t   face;
    fui_canvas_t canvas;
} sim_frame_t;

/** A whole-face canvas over a static buffer (RGB565 or SSD1306 pages), cleared.
 *  (Pages for the 400 x 300 face too: the pixels, and so the hash, are those
 *  of any format; test_ui checks MONO_ROW against it.) */
void sim_frame_init(sim_frame_t *frame, fui_face_t face);

/** "round240" ... / "now" ... / "pure" | "earth". -1 when unknown. */
int sim_parse_face(const char *name);
int sim_parse_screen(const char *name);
int sim_parse_mode(const char *name);
/** "none" 0, "helion" 6, "theta" 7, "preon" 8, "kappa" 9, "flavon" 10, or the
 *  level's number; -1 for anything fui_ui_set_step refuses. */
int sim_parse_step(const char *name);

/**
 * sim_goto_screen puts `ui` on the first page of `screen` (SCALES: by a step
 * and back, so the name shows). sim_script feeds a script: N (next), P (prev),
 * S (select), L (long), W<ms> (let time pass). The UI is updated after every
 * item, as the firmware's loop does. Spaces are ignored. `*t` (the clock) and
 * `*ms` (the monotonic clock) are both advanced by the waits.
 * @return 0, or -1 on an unknown letter.
 */
int sim_script(fui_ui_t *ui, const char *script, frc_time_t *t, uint32_t *ms);
void sim_goto_screen(fui_ui_t *ui, fui_screen_t screen, uint32_t ms);

/** Update at `t` and draw the dirty rectangle. `band` > 0 renders through a
 *  canvas only that many rows tall, as banded firmware would. Returns the frame. */
const fui_frame_t *sim_render(fui_ui_t *ui, sim_frame_t *frame, frc_time_t t, uint32_t ms, int band);

/** 64-bit FNV-1a of the face's pixels, the same for every canvas format. */
uint64_t sim_frame_hash(const sim_frame_t *frame);

/**
 * The frame as RGB bytes (malloc'ed, w * h * 3), each pixel `scale` wide.
 * The round face is masked to its circle; the 128 x 64 face scaled 3 or more
 * shows a grid so single pixels can be counted. A set bit is white.
 */
uint8_t *sim_frame_rgb(const sim_frame_t *frame, int scale, int *w, int *h);

#endif /* SIM_FRAME_H */
