/*
 * fhal_button.c - the button state machine of fhal_button.h. Portable C99.
 */
#include "fhal_button.h"

enum {
    PHASE_IDLE = 0, /* released                                             */
    PHASE_HELD = 1, /* pressed; a release is a click, the deadline a long   */
    PHASE_DONE = 2, /* pressed, its meaning already reported                */
    PHASE_GAP  = 3  /* released after a first click; waiting for a second   */
};

static int has_deadline(const fhal_button_t *b, const fhal_button_config_t *c)
{
    return (b->phase == PHASE_HELD && c->use_long) || b->phase == PHASE_GAP;
}

/* Wrap-safe "now is at or past the deadline". */
static int due(const fhal_button_t *b, uint32_t now_ms)
{
    return (int32_t)(now_ms - b->deadline) >= 0;
}

void fhal_button_reset(fhal_button_t *button)
{
    button->pressed = 0;
    button->phase = PHASE_IDLE;
    button->deadline = 0;
}

uint32_t fhal_button_update(fhal_button_t *b, const fhal_button_config_t *c, uint32_t now_ms, int level,
                            fhal_button_action_t *action)
{
    *action = FHAL_BUTTON_NONE;

    if (level >= 0 && (uint8_t)(level != 0) != b->pressed) {
        b->pressed = (uint8_t)(level != 0);
        if (b->pressed) {
            if (b->phase == PHASE_GAP) {
                *action = FHAL_BUTTON_DOUBLE;
                b->phase = PHASE_DONE;
            } else if (!c->use_long && !c->use_double) {
                *action = FHAL_BUTTON_CLICK; /* nothing to wait for */
                b->phase = PHASE_DONE;
            } else {
                b->phase = PHASE_HELD;
                b->deadline = now_ms + c->long_ms;
            }
        } else if (b->phase == PHASE_HELD) {
            if (c->use_long && due(b, now_ms)) {
                /* The timer was late: the hold was long all the same. */
                *action = FHAL_BUTTON_LONG;
                b->phase = PHASE_IDLE;
            } else if (c->use_double) {
                b->phase = PHASE_GAP;
                b->deadline = now_ms + c->double_ms;
            } else {
                *action = FHAL_BUTTON_CLICK;
                b->phase = PHASE_IDLE;
            }
        } else {
            b->phase = PHASE_IDLE;
        }
    } else if (has_deadline(b, c) && due(b, now_ms)) {
        if (b->phase == PHASE_HELD) {
            *action = FHAL_BUTTON_LONG;
            b->phase = PHASE_DONE;
        } else {
            *action = FHAL_BUTTON_CLICK; /* no second click came */
            b->phase = PHASE_IDLE;
        }
    }

    if (!has_deadline(b, c)) {
        return 0;
    }
    return due(b, now_ms) ? 1u : (uint32_t)(b->deadline - now_ms);
}
