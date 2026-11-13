/*
 * fhal_button.h - what a push button MEANS: click, double click, long press.
 *
 * Pure logic, no ESP-IDF include, no clock of its own: the caller hands in
 * the time and the debounced level and is told what happened and when to
 * call again. fhal_input.c feeds it from a GPIO interrupt and one timer per
 * button; sim/tests/test_firmware.c feeds it from a script, which is how
 * the timing rules below are tested without hardware.
 *
 * THE RULES (one button)
 *   press                       nothing yet (unless neither a long press nor
 *                               a double click is wanted: then CLICK at once,
 *                               so NEXT / PREV buttons feel immediate)
 *   release before long_ms      CLICK - or, when a double click is wanted,
 *                               wait double_ms for a second press:
 *                                 second press in time   DOUBLE
 *                                 none                   CLICK
 *   still held after long_ms    LONG, once; the release that follows is silent
 */
#ifndef FHAL_BUTTON_H
#define FHAL_BUTTON_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum fhal_button_action {
    FHAL_BUTTON_NONE   = 0,
    FHAL_BUTTON_CLICK  = 1,
    FHAL_BUTTON_DOUBLE = 2,
    FHAL_BUTTON_LONG   = 3
} fhal_button_action_t;

typedef struct fhal_button_config {
    uint16_t long_ms;    /* hold time of a long press                     */
    uint16_t double_ms;  /* longest gap between the clicks of a double    */
    uint8_t  use_long;   /* 1: this button has a long-press meaning       */
    uint8_t  use_double; /* 1: this button has a double-click meaning     */
} fhal_button_config_t;

typedef struct fhal_button {
    uint8_t  pressed;  /* the debounced level                             */
    uint8_t  phase;    /* private                                         */
    uint32_t deadline; /* private: when the long press / the gap ends     */
} fhal_button_t;

/** Released, nothing pending. */
void fhal_button_reset(fhal_button_t *button);

/**
 * Advance one button.
 * @param now_ms  any millisecond counter; it may wrap
 * @param level   the DEBOUNCED level, 1 pressed / 0 released, or -1 when the
 *                call is only a timer expiry
 * @param action  what happened (at most one thing per call)
 * @return milliseconds until the next call is due (a long press or a
 *         double-click gap is running), or 0: nothing is pending, wait for
 *         the next edge
 */
uint32_t fhal_button_update(fhal_button_t *button, const fhal_button_config_t *config, uint32_t now_ms,
                            int level, fhal_button_action_t *action);

#ifdef __cplusplus
}
#endif

#endif /* FHAL_BUTTON_H */
