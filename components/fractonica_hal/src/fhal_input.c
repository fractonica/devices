/*
 * fhal_input.c - buttons and the rotary encoder (see fhal_input.h).
 *
 * BUTTONS
 *   interrupt (any edge)  ->  marks "the pin moved" and (re)starts the
 *                             button's one-shot FreeRTOS timer at the
 *                             debounce time
 *   timer callback        ->  the pin has been quiet that long: read it,
 *                             step fhal_button_update, emit the event, and
 *                             re-arm the timer if a long press or a
 *                             double-click gap is running
 *   So a bouncing contact costs interrupts but no event, and an idle button
 *   costs nothing at all. The callbacks run in the FreeRTOS timer task.
 *
 *   With light sleep the edge interrupt becomes a LEVEL interrupt that is
 *   also the wake-up source (an edge is not seen by a sleeping chip): the
 *   interrupt silences itself, and the timer callback re-arms it for the
 *   opposite level.
 *
 * ENCODER
 *   PCNT (ESP32, ESP32-S3): both channels count the quadrature signal x4
 *   behind a glitch filter; the unit's limits are +/- one detent, so the
 *   counter clears itself there and raises the event that becomes NEXT / PREV.
 *   GPIO (ESP32-C3, or PCNT turned off): an interrupt on both pins walks the
 *   quadrature transition table; contact bounce on one pin counts +1 -1.
 *
 * No heap: the timers are static (xTimerCreateStatic). PCNT allocates its
 * unit once, at start-up, inside the driver.
 */
#include "fhal_input.h"

#include "driver/gpio.h"
#include "esp_check.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/timers.h"
#include "fhal_board.h"
#include "fhal_button.h"

#if CONFIG_FRACTONICA_INPUT_ENCODER && CONFIG_FRACTONICA_ENC_PCNT
#  include "driver/pulse_cnt.h"
#endif
#if CONFIG_FRACTONICA_LIGHT_SLEEP
#  include "esp_sleep.h"
#endif

static const char *TAG = "fhal_input";

static fhal_input_sink_t s_sink;
static void *s_sink_ctx;

const char *fhal_input_name(void)
{
#if CONFIG_FRACTONICA_INPUT_ENCODER && CONFIG_FRACTONICA_ENC_PCNT
    return FHAL_INPUT_NAME " (PCNT)";
#elif CONFIG_FRACTONICA_INPUT_ENCODER
    return FHAL_INPUT_NAME " (GPIO)";
#else
    return FHAL_INPUT_NAME;
#endif
}

/* ------------------------------------------------------------------------ */
/* Buttons                                                                   */
/* ------------------------------------------------------------------------ */

#if FHAL_BUTTON_COUNT > 0

typedef struct button_slot {
    int8_t               pin;
    uint8_t              on_click;  /* fhal_input_event_t */
    uint8_t              on_double;
    uint8_t              on_long;
    fhal_button_config_t config;
    fhal_button_t        fsm;
    volatile uint8_t     moved;     /* set by the interrupt, cleared by the timer */
    TimerHandle_t        timer;
    StaticTimer_t        timer_memory;
} button_slot_t;

#define BUTTON(pin_, click_, double_, long_)                                                    \
    {                                                                                           \
        .pin = (pin_), .on_click = (click_), .on_double = (double_), .on_long = (long_),        \
        .config = { .long_ms = FHAL_LONG_MS, .double_ms = FHAL_DOUBLE_MS,                       \
                    .use_long = (long_) != FHAL_INPUT_NONE, .use_double = (double_) != FHAL_INPUT_NONE }, \
    }

/* The meaning of each button, per input kind (the table of fhal_input.h). */
static button_slot_t s_button[FHAL_BUTTON_COUNT] = {
#if CONFIG_FRACTONICA_INPUT_ENCODER
    BUTTON(FHAL_PIN_BTN_A, FHAL_INPUT_SELECT, FHAL_INPUT_NONE, FHAL_INPUT_LONG),
#elif CONFIG_FRACTONICA_INPUT_BUTTONS_3
    BUTTON(FHAL_PIN_BTN_A, FHAL_INPUT_SELECT, FHAL_INPUT_NONE, FHAL_INPUT_LONG),
    BUTTON(FHAL_PIN_BTN_B, FHAL_INPUT_NEXT, FHAL_INPUT_NONE, FHAL_INPUT_NONE),
    BUTTON(FHAL_PIN_BTN_C, FHAL_INPUT_PREV, FHAL_INPUT_NONE, FHAL_INPUT_NONE),
#elif CONFIG_FRACTONICA_INPUT_BUTTONS_2
    BUTTON(FHAL_PIN_BTN_A, FHAL_INPUT_NEXT, FHAL_INPUT_NONE, FHAL_INPUT_PREV),
    BUTTON(FHAL_PIN_BTN_B, FHAL_INPUT_SELECT, FHAL_INPUT_NONE, FHAL_INPUT_LONG),
#else /* one button */
    BUTTON(FHAL_PIN_BTN_A, FHAL_INPUT_NEXT, FHAL_INPUT_SELECT, FHAL_INPUT_LONG),
#endif
};

/* The timer period that lets `ms` pass for certain: a period of n ticks ends
 * between n - 1 and n tick lengths from now. */
static TickType_t ticks_after(uint32_t ms)
{
    return pdMS_TO_TICKS(ms) + 1;
}

static int button_pressed(const button_slot_t *slot)
{
    return gpio_get_level((gpio_num_t)slot->pin) == (FHAL_BTN_ACTIVE_LOW ? 0 : 1);
}

#if CONFIG_FRACTONICA_LIGHT_SLEEP
/* Listen (and wake) for the level the pin does NOT have now. */
static void button_arm_level(const button_slot_t *slot, int pressed)
{
    int active_level = FHAL_BTN_ACTIVE_LOW ? 0 : 1;
    int wanted = pressed ? !active_level : active_level;

    gpio_wakeup_enable((gpio_num_t)slot->pin, wanted ? GPIO_INTR_HIGH_LEVEL : GPIO_INTR_LOW_LEVEL);
    gpio_intr_enable((gpio_num_t)slot->pin);
}
#endif

static void button_isr(void *arg)
{
    button_slot_t *slot = arg;
    BaseType_t woken = pdFALSE;

    slot->moved = 1;
#if CONFIG_FRACTONICA_LIGHT_SLEEP
    /* A level interrupt repeats for as long as the level holds. */
    gpio_intr_disable((gpio_num_t)slot->pin);
#endif
    xTimerChangePeriodFromISR(slot->timer, ticks_after(FHAL_DEBOUNCE_MS), &woken);
    if (woken == pdTRUE) {
        portYIELD_FROM_ISR();
    }
}

static void button_timer(TimerHandle_t timer)
{
    button_slot_t *slot = pvTimerGetTimerID(timer);
    fhal_button_action_t action;
    uint32_t next_ms;
    int level = -1;

    if (slot->moved) {
        slot->moved = 0;
        level = button_pressed(slot);
#if CONFIG_FRACTONICA_LIGHT_SLEEP
        button_arm_level(slot, level);
#endif
    }
    next_ms = fhal_button_update(&slot->fsm, &slot->config, (uint32_t)(esp_timer_get_time() / 1000), level,
                                 &action);
    switch (action) {
    case FHAL_BUTTON_CLICK:  s_sink((fhal_input_event_t)slot->on_click, s_sink_ctx, NULL);  break;
    case FHAL_BUTTON_DOUBLE: s_sink((fhal_input_event_t)slot->on_double, s_sink_ctx, NULL); break;
    case FHAL_BUTTON_LONG:   s_sink((fhal_input_event_t)slot->on_long, s_sink_ctx, NULL);   break;
    default: break;
    }
    /* Block time 0: a timer callback must never wait on its own queue. */
    if (next_ms != 0) {
        xTimerChangePeriod(timer, ticks_after(next_ms), 0);
    }
    /* An edge that arrived while we worked wins over the line above: either
     * its own restart is queued after ours, or we queue it here. */
    if (slot->moved) {
        xTimerChangePeriod(timer, ticks_after(FHAL_DEBOUNCE_MS), 0);
    }
}

static esp_err_t buttons_init(void)
{
    int i;

    for (i = 0; i < FHAL_BUTTON_COUNT; i++) {
        button_slot_t *slot = &s_button[i];
        gpio_config_t pin = {
            .pin_bit_mask = 1ULL << slot->pin,
            .mode = GPIO_MODE_INPUT,
            .pull_up_en = FHAL_BTN_ACTIVE_LOW ? GPIO_PULLUP_ENABLE : GPIO_PULLUP_DISABLE,
            .pull_down_en = FHAL_BTN_ACTIVE_LOW ? GPIO_PULLDOWN_DISABLE : GPIO_PULLDOWN_ENABLE,
            .intr_type = GPIO_INTR_ANYEDGE,
        };

        ESP_RETURN_ON_ERROR(gpio_config(&pin), TAG, "button pin %d", slot->pin);
        fhal_button_reset(&slot->fsm);
        /* A button held during start-up (the BOOT button) is not a press. */
        if (button_pressed(slot)) {
            fhal_button_action_t ignored;

            (void)fhal_button_update(&slot->fsm, &(fhal_button_config_t){ 0 }, 0, 1, &ignored);
        }
        slot->timer = xTimerCreateStatic("button", ticks_after(FHAL_DEBOUNCE_MS), pdFALSE, slot, button_timer,
                                         &slot->timer_memory);
        ESP_RETURN_ON_ERROR(gpio_isr_handler_add((gpio_num_t)slot->pin, button_isr, slot), TAG, "button isr");
#if CONFIG_FRACTONICA_LIGHT_SLEEP
        button_arm_level(slot, slot->fsm.pressed);
#endif
    }
#if CONFIG_FRACTONICA_LIGHT_SLEEP
    ESP_RETURN_ON_ERROR(esp_sleep_enable_gpio_wakeup(), TAG, "gpio wake-up");
#endif
    return ESP_OK;
}

#endif /* FHAL_BUTTON_COUNT > 0 */

/* ------------------------------------------------------------------------ */
/* Rotary encoder                                                            */
/* ------------------------------------------------------------------------ */

#if CONFIG_FRACTONICA_INPUT_ENCODER

#define ENCODER_UP   (FHAL_ENC_REVERSE ? FHAL_INPUT_PREV : FHAL_INPUT_NEXT)
#define ENCODER_DOWN (FHAL_ENC_REVERSE ? FHAL_INPUT_NEXT : FHAL_INPUT_PREV)

#if CONFIG_FRACTONICA_ENC_PCNT

/* Runs in the PCNT interrupt when the count reaches +/- one detent (the
 * unit has cleared itself by then). */
static bool encoder_on_reach(pcnt_unit_handle_t unit, const pcnt_watch_event_data_t *event, void *ctx)
{
    BaseType_t woken = pdFALSE;

    (void)unit;
    (void)ctx;
    s_sink(event->watch_point_value > 0 ? ENCODER_UP : ENCODER_DOWN, s_sink_ctx, &woken);
    return woken == pdTRUE;
}

static esp_err_t encoder_init(void)
{
    pcnt_unit_config_t unit_config = { .high_limit = FHAL_ENC_COUNTS, .low_limit = -FHAL_ENC_COUNTS };
    /* The filter swallows pulses shorter than this. The ESP32's filter
     * counts APB cycles in 10 bits: 12.7 us is its longest. */
    pcnt_glitch_filter_config_t filter = { .max_glitch_ns = 10000 };
    pcnt_chan_config_t a_config = { .edge_gpio_num = FHAL_PIN_ENC_A, .level_gpio_num = FHAL_PIN_ENC_B };
    pcnt_chan_config_t b_config = { .edge_gpio_num = FHAL_PIN_ENC_B, .level_gpio_num = FHAL_PIN_ENC_A };
    pcnt_event_callbacks_t callbacks = { .on_reach = encoder_on_reach };
    pcnt_unit_handle_t unit = NULL;
    pcnt_channel_handle_t a = NULL, b = NULL;

    ESP_RETURN_ON_ERROR(pcnt_new_unit(&unit_config, &unit), TAG, "pcnt unit");
    ESP_RETURN_ON_ERROR(pcnt_unit_set_glitch_filter(unit, &filter), TAG, "pcnt filter");
    ESP_RETURN_ON_ERROR(pcnt_new_channel(unit, &a_config, &a), TAG, "pcnt channel A");
    ESP_RETURN_ON_ERROR(pcnt_new_channel(unit, &b_config, &b), TAG, "pcnt channel B");
    /* Quadrature x4: every edge of either pin counts, the other pin's level
     * gives the direction. */
    ESP_RETURN_ON_ERROR(pcnt_channel_set_edge_action(a, PCNT_CHANNEL_EDGE_ACTION_DECREASE,
                                                     PCNT_CHANNEL_EDGE_ACTION_INCREASE), TAG, "pcnt A edge");
    ESP_RETURN_ON_ERROR(pcnt_channel_set_level_action(a, PCNT_CHANNEL_LEVEL_ACTION_KEEP,
                                                      PCNT_CHANNEL_LEVEL_ACTION_INVERSE), TAG, "pcnt A level");
    ESP_RETURN_ON_ERROR(pcnt_channel_set_edge_action(b, PCNT_CHANNEL_EDGE_ACTION_INCREASE,
                                                     PCNT_CHANNEL_EDGE_ACTION_DECREASE), TAG, "pcnt B edge");
    ESP_RETURN_ON_ERROR(pcnt_channel_set_level_action(b, PCNT_CHANNEL_LEVEL_ACTION_KEEP,
                                                      PCNT_CHANNEL_LEVEL_ACTION_INVERSE), TAG, "pcnt B level");
    /* Encoders switch to ground; modules without resistors need these. */
    gpio_pullup_en((gpio_num_t)FHAL_PIN_ENC_A);
    gpio_pullup_en((gpio_num_t)FHAL_PIN_ENC_B);
    ESP_RETURN_ON_ERROR(pcnt_unit_add_watch_point(unit, FHAL_ENC_COUNTS), TAG, "pcnt watch +");
    ESP_RETURN_ON_ERROR(pcnt_unit_add_watch_point(unit, -FHAL_ENC_COUNTS), TAG, "pcnt watch -");
    ESP_RETURN_ON_ERROR(pcnt_unit_register_event_callbacks(unit, &callbacks, NULL), TAG, "pcnt callbacks");
    ESP_RETURN_ON_ERROR(pcnt_unit_enable(unit), TAG, "pcnt enable");
    ESP_RETURN_ON_ERROR(pcnt_unit_clear_count(unit), TAG, "pcnt clear");
    return pcnt_unit_start(unit);
}

#else /* GPIO decoding */

static uint8_t s_encoder_state; /* (A << 1) | B at the last interrupt */
static int8_t s_encoder_count;  /* quadrature counts since the last event */

static void encoder_isr(void *arg)
{
    /* [previous state << 2 | new state] -> -1, 0, +1. A jump of two states
     * (a missed edge) and "no change" (bounce already over) count 0. */
    static const int8_t STEP[16] = { 0, -1, 1, 0, 1, 0, 0, -1, -1, 0, 0, 1, 0, 1, -1, 0 };
    uint8_t state = (uint8_t)((gpio_get_level((gpio_num_t)FHAL_PIN_ENC_A) << 1)
                              | gpio_get_level((gpio_num_t)FHAL_PIN_ENC_B));
    /* Both contacts open: the encoder rests in a detent (4 counts a detent).
     * Deciding there forgives one missed edge and stops drift. */
    int rest = FHAL_ENC_COUNTS == 4 && state == 3;
    int count = s_encoder_count + STEP[(s_encoder_state << 2) | state];
    fhal_input_event_t event = FHAL_INPUT_NONE;
    BaseType_t woken = pdFALSE;

    (void)arg;
    s_encoder_state = state;
    if (count >= FHAL_ENC_COUNTS || (rest && count >= 2)) {
        event = ENCODER_UP;
    } else if (count <= -FHAL_ENC_COUNTS || (rest && count <= -2)) {
        event = ENCODER_DOWN;
    }
    if (event != FHAL_INPUT_NONE || rest) {
        count = 0;
    }
    s_encoder_count = (int8_t)count;
    if (event != FHAL_INPUT_NONE) {
        s_sink(event, s_sink_ctx, &woken);
        if (woken == pdTRUE) {
            portYIELD_FROM_ISR();
        }
    }
}

static esp_err_t encoder_init(void)
{
    gpio_config_t pins = {
        .pin_bit_mask = (1ULL << FHAL_PIN_ENC_A) | (1ULL << FHAL_PIN_ENC_B),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .intr_type = GPIO_INTR_ANYEDGE,
    };

    ESP_RETURN_ON_ERROR(gpio_config(&pins), TAG, "encoder pins");
    s_encoder_state = (uint8_t)((gpio_get_level((gpio_num_t)FHAL_PIN_ENC_A) << 1)
                                | gpio_get_level((gpio_num_t)FHAL_PIN_ENC_B));
    ESP_RETURN_ON_ERROR(gpio_isr_handler_add((gpio_num_t)FHAL_PIN_ENC_A, encoder_isr, NULL), TAG, "encoder isr A");
    return gpio_isr_handler_add((gpio_num_t)FHAL_PIN_ENC_B, encoder_isr, NULL);
}

#endif /* PCNT or GPIO */
#endif /* encoder */

/* ------------------------------------------------------------------------ */

esp_err_t fhal_input_init(fhal_input_sink_t sink, void *ctx)
{
    s_sink = sink;
    s_sink_ctx = ctx;
#if FHAL_BUTTON_COUNT > 0 || CONFIG_FRACTONICA_INPUT_ENCODER
    {
        /* One shared GPIO interrupt service for every pin. Somebody may have
         * installed it already: that is fine. */
        esp_err_t err = gpio_install_isr_service(0);

        if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
            return err;
        }
    }
#endif
#if FHAL_BUTTON_COUNT > 0
    ESP_RETURN_ON_ERROR(buttons_init(), TAG, "buttons");
#endif
#if CONFIG_FRACTONICA_INPUT_ENCODER
    ESP_RETURN_ON_ERROR(encoder_init(), TAG, "encoder");
#endif
    ESP_LOGI(TAG, "input: %s", fhal_input_name());
    return ESP_OK;
}
