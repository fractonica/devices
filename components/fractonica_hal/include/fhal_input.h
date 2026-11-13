/*
 * fhal_input.h - buttons or a rotary encoder, as four events.
 *
 * The input kind is a build-time choice (Kconfig, "Input"):
 *
 *   encoder     turn = NEXT / PREV          push: click = SELECT, hold = LONG
 *   3 buttons   C = PREV   A = SELECT (hold = LONG)   B = NEXT
 *   2 buttons   A: click = NEXT, hold = PREV          B: click = SELECT, hold = LONG
 *   1 button    click = NEXT, double click = SELECT, hold = LONG
 *
 * Nothing here polls. A button is a GPIO interrupt that (re)starts a
 * FreeRTOS timer; when the pin has been quiet for the debounce time the
 * timer reads the level and steps the state machine of fhal_button.h. The
 * encoder is the pulse counter (PCNT) with a glitch filter where the chip
 * has one, a GPIO interrupt with a transition table where it has not
 * (ESP32-C3).
 *
 * Events are delivered by calling the sink - from the timer task or from an
 * interrupt, so the sink must only do what both allow (send to a queue).
 */
#ifndef FHAL_INPUT_H
#define FHAL_INPUT_H

#include "esp_err.h"
#include "freertos/FreeRTOS.h"

#ifdef __cplusplus
extern "C" {
#endif

/* The same numbers as fui_event_t (main/app_main.c asserts it). */
typedef enum fhal_input_event {
    FHAL_INPUT_NONE   = 0,
    FHAL_INPUT_NEXT   = 1,
    FHAL_INPUT_PREV   = 2,
    FHAL_INPUT_SELECT = 3,
    FHAL_INPUT_LONG   = 4
} fhal_input_event_t;

/**
 * Receives one event. `woken` is NULL when called from a task; from an
 * interrupt it is the flag the xQueueSendFromISR family wants.
 */
typedef void (*fhal_input_sink_t)(fhal_input_event_t event, void *ctx, BaseType_t *woken);

/** Configure the pins and start listening. Call once. */
esp_err_t fhal_input_init(fhal_input_sink_t sink, void *ctx);

/** "encoder", "3 buttons" ... for `info`. */
const char *fhal_input_name(void);

#ifdef __cplusplus
}
#endif

#endif /* FHAL_INPUT_H */
