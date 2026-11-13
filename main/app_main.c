/*
 * app_main.c - the ESP-IDF port of the application: start-up, the UI task,
 * and app_port_t (main/app.h) on top of fractonica_hal.
 *
 * TASKS AND WHO WAKES WHOM
 *   ui        runs app_step forever. It blocks in xQueueReceive until a
 *             message arrives or the UI's own deadline passes, and in the
 *             display driver's semaphore while pixels are on the wire.
 *   console   (fhal_console.c) blocks in the UART driver; posts each line
 *             and waits until the UI task has run it.
 *   timers    FreeRTOS's timer task runs the button debounce (fhal_input.c).
 *   events    ESP-IDF's event loop runs Wi-Fi / SNTP (fhal_net.c), if built.
 *   All of them put app_msg_t values into ONE queue; only the UI task
 *   touches the UI state, the frame buffer and the display.
 *
 * MEMORY
 *   Everything of ours is static: the frame buffer, the UI state, both task
 *   stacks, the queue, the semaphores, the timers. ESP-IDF's drivers allocate
 *   their own objects while app_main runs; after that nothing of ours calls
 *   the allocator (the Wi-Fi stack does, while its radio is on).
 *
 * WATCHDOG
 *   The task watchdog watches the idle tasks: a task that spins starves them
 *   and resets the chip. The UI task never spins - every wait is a blocking
 *   call - so it needs no feeding and is not subscribed (a subscribed task
 *   would have to wake every few seconds just to say it is alive).
 */
#include <stdio.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_idf_version.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include "app.h"
#include "fhal_board.h"
#include "fhal_console.h"
#include "fhal_display.h"
#include "fhal_input.h"
#include "fhal_net.h"
#include "fhal_power.h"
#include "fhal_settings.h"
#include "fhal_time.h"

static const char *TAG = "app";

/* A compile-time check in C99 (no _Static_assert, a C11 keyword): an array
 * of -1 elements does not compile. The type is never used. */
#define APP_CHECK(name, condition) typedef char app_check_##name[(condition) ? 1 : -1]

/* The HAL's events are passed to the UI as they are. */
APP_CHECK(events_agree, (int)FHAL_INPUT_NEXT == (int)FUI_EV_NEXT && (int)FHAL_INPUT_PREV == (int)FUI_EV_PREV
                            && (int)FHAL_INPUT_SELECT == (int)FUI_EV_SELECT && (int)FHAL_INPUT_LONG == (int)FUI_EV_LONG);
APP_CHECK(settings_record_size, sizeof(app_settings_t) == 8 && sizeof(app_settings_t) <= FHAL_SETTINGS_MAX);
APP_CHECK(no_time_values_agree, FHAL_TIME_UNSET == FRC_TIME_NONE);

/* ------------------------------------------------------------------------- */
/* The frame buffer                                                           */
/* ------------------------------------------------------------------------- */

/*
 * Static, in internal RAM, 4-byte aligned: the SPI driver sends from it by
 * DMA without copying. Its size is the drawing strategy (app_init):
 *   whole frame   240 x 240 x 2 = 115,200 bytes (153,600 at 240 x 320)
 *   a band        CONFIG_FRACTONICA_FB_BAND_ROWS x 480 bytes
 *   one-bit       128 x 64 / 8 = 1,024 bytes, always whole
 * docs/GUIDE.md, "Memory, size and wake-ups" has the measured totals per chip.
 */
#if CONFIG_FRACTONICA_DISPLAY_SSD1306
#  define FRAME_BYTES (FHAL_DISPLAY_WIDTH * FHAL_DISPLAY_HEIGHT / 8)
#elif CONFIG_FRACTONICA_FB_BAND_ROWS > 0 && CONFIG_FRACTONICA_FB_BAND_ROWS < FHAL_DISPLAY_HEIGHT
#  define FRAME_BYTES (FHAL_DISPLAY_WIDTH * CONFIG_FRACTONICA_FB_BAND_ROWS * 2)
#else
#  define FRAME_BYTES (FHAL_DISPLAY_WIDTH * FHAL_DISPLAY_HEIGHT * 2)
#endif
static uint8_t s_frame[FRAME_BYTES] __attribute__((aligned(4)));

/* ------------------------------------------------------------------------- */
/* Tasks, queue                                                               */
/* ------------------------------------------------------------------------- */

#define QUEUE_LENGTH 16 /* a fast turn of the encoder is a handful of events */

static app_t s_app;

static QueueHandle_t s_queue;
static StaticQueue_t s_queue_memory;
static uint8_t s_queue_storage[QUEUE_LENGTH * sizeof(app_msg_t)];

static SemaphoreHandle_t s_line_done;
static StaticSemaphore_t s_line_done_memory;

static TaskHandle_t s_ui_task;
static StaticTask_t s_ui_task_memory;
static StackType_t s_ui_stack[CONFIG_FRACTONICA_UI_STACK / sizeof(StackType_t)];

static bool s_display_ok;

/* ------------------------------------------------------------------------- */
/* app_port_t                                                                 */
/* ------------------------------------------------------------------------- */

static frc_time_t port_now_us(void *ctx)
{
    (void)ctx;
    return fhal_time_now_us();
}

static uint32_t port_uptime_ms(void *ctx)
{
    (void)ctx;
    return (uint32_t)(esp_timer_get_time() / 1000);
}

/*
 * The one place the UI task sleeps. A FreeRTOS timeout of n ticks ends
 * between n - 1 and n tick periods from now, so "at least timeout_us" is the
 * rounded-up tick count plus one. Waking a tick late is harmless; waking
 * early would make the UI find nothing due and go back to sleep for its
 * minimum frame time.
 */
static int port_wait(void *ctx, int64_t timeout_us, app_msg_t *msg)
{
    const int64_t tick_us = 1000000 / configTICK_RATE_HZ;
    const int64_t longest_us = 12LL * 3600 * 1000000; /* keeps the tick count far from its 32-bit end */
    TickType_t ticks = portMAX_DELAY;

    (void)ctx;
    if (timeout_us >= 0) {
        if (timeout_us > longest_us) {
            timeout_us = longest_us; /* an early wake, twice a day at most, at the coarsest scales */
        }
        ticks = (TickType_t)((timeout_us + tick_us - 1) / tick_us) + 1;
    }
    return xQueueReceive(s_queue, msg, ticks) == pdTRUE;
}

static void port_flush(void *ctx, int x0, int y0, int x1, int y1, const void *pixels)
{
    static bool complained;

    (void)ctx;
    if (!s_display_ok) {
        return;
    }
    if (fhal_display_flush(x0, y0, x1, y1, pixels) != ESP_OK && !complained) {
        complained = true; /* once: a missing panel must not flood the console */
        ESP_LOGE(TAG, "the display does not take pixels (check the wiring)");
    }
}

static void port_write(void *ctx, const char *text, size_t bytes)
{
    (void)ctx;
    fwrite(text, 1, bytes, stdout);
    fflush(stdout);
}

static void port_line_done(void *ctx)
{
    (void)ctx;
    xSemaphoreGive(s_line_done);
}

static void port_set_time(void *ctx, frc_time_t unix_us)
{
    (void)ctx;
    fhal_time_set_us(unix_us, FHAL_TIME_CONSOLE);
}

static void port_save(void *ctx, const app_settings_t *settings)
{
    (void)ctx;
    fhal_settings_save(settings, sizeof *settings);
}

static void port_brightness(void *ctx, uint8_t percent)
{
    (void)ctx;
    if (s_display_ok) {
        fhal_display_set_brightness(percent);
    }
}

static const char *reset_reason(void)
{
    switch (esp_reset_reason()) {
    case ESP_RST_POWERON:  return "power on";
    case ESP_RST_SW:       return "software";
    case ESP_RST_PANIC:    return "panic";
    case ESP_RST_INT_WDT:  return "interrupt watchdog";
    case ESP_RST_TASK_WDT: return "task watchdog";
    case ESP_RST_WDT:      return "watchdog";
    case ESP_RST_BROWNOUT: return "brown-out";
    case ESP_RST_EXT:      return "reset pin";
    default:               return "other";
    }
}

/* The platform's part of `info`. Runs in the UI task. */
static void port_info(void *ctx, app_t *app)
{
    unsigned synced = 0, failed = 0;
    const char *net = fhal_net_state(&synced, &failed);

    (void)ctx;
    app_printf(app, "chip     %s, ESP-IDF %s, reset by: %s, up %lld s, power: %s\n", CONFIG_IDF_TARGET,
               esp_get_idf_version(), reset_reason(), (long long)(esp_timer_get_time() / 1000000),
               fhal_power_mode());
    app_printf(app, "time     set by: %s; network time: %s (%u ok, %u failed)\n",
               fhal_time_source_name(fhal_time_source()), net, synced, failed);
    app_printf(app, "input    %s; settings written %u time(s) this boot\n", fhal_input_name(),
               fhal_settings_writes());
    app_printf(app, "heap     free %u, lowest ever %u, largest block %u bytes\n",
               (unsigned)heap_caps_get_free_size(MALLOC_CAP_DEFAULT),
               (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_DEFAULT),
               (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_DEFAULT));
    /* High-water marks: the fewest bytes that were ever free on each stack. */
    app_printf(app, "stack    ui %u free of %u, console %u free of %u bytes\n",
               (unsigned)(uxTaskGetStackHighWaterMark(s_ui_task) * sizeof(StackType_t)),
               (unsigned)sizeof s_ui_stack, fhal_console_stack_free(), (unsigned)CONFIG_FRACTONICA_CONSOLE_STACK);
}

static void port_restart(void *ctx)
{
    (void)ctx;
    esp_restart();
}

/* ------------------------------------------------------------------------- */
/* Other tasks -> the queue                                                   */
/* ------------------------------------------------------------------------- */

/* Timer task (buttons) or an interrupt (encoder). Never blocks: when the
 * queue is full the event is dropped, which is what a user turning the knob
 * faster than the display redraws expects. */
static void on_input(fhal_input_event_t event, void *ctx, BaseType_t *woken)
{
    app_msg_t msg = { .kind = APP_MSG_INPUT, .event = (uint8_t)event };

    (void)ctx;
    if (woken != NULL) {
        xQueueSendFromISR(s_queue, &msg, woken);
    } else {
        xQueueSend(s_queue, &msg, 0);
    }
}

/* Console task: hand the line over and wait until the UI task has run it,
 * so the reader's buffer stays valid and the output stays in order. */
static void on_console_line(const char *line, void *ctx)
{
    app_msg_t msg = { .kind = APP_MSG_LINE, .line = line };

    (void)ctx;
    xQueueSend(s_queue, &msg, portMAX_DELAY);
    xSemaphoreTake(s_line_done, portMAX_DELAY);
}

/* Event loop task: the server has set the time. */
static void on_time_synced(void *ctx)
{
    app_msg_t msg = { .kind = APP_MSG_TIME };

    (void)ctx;
    xQueueSend(s_queue, &msg, 0);
}

static void ui_task(void *arg)
{
    (void)arg;
    for (;;) {
        app_step(&s_app);
    }
}

/* ------------------------------------------------------------------------- */
/* Start-up                                                                   */
/* ------------------------------------------------------------------------- */

/* The state of a clock that was never used: the build's choices. */
static void default_settings(app_settings_t *settings)
{
    memset(settings, 0, sizeof *settings);
    settings->version = APP_SETTINGS_VERSION;
#if CONFIG_FRACTONICA_DEFAULT_MODE_EARTH
    settings->mode = FUI_MODE_EARTH;
#else
    settings->mode = FUI_MODE_PURE;
#endif
    settings->focus = CONFIG_FRACTONICA_DEFAULT_FOCUS;
    settings->screen = FUI_SCREEN_NOW;
    settings->utc_offset_min = CONFIG_FRACTONICA_UTC_OFFSET_MIN;
    settings->brightness = CONFIG_FRACTONICA_BRIGHTNESS;
}

void app_main(void)
{
    static const app_port_t port = {
        .now_us = port_now_us,
        .uptime_ms = port_uptime_ms,
        .wait = port_wait,
        .flush = port_flush,
        .write = port_write,
        .line_done = port_line_done,
        .set_time = port_set_time,
        .save = port_save,
        .brightness = port_brightness,
        .info = port_info,
        .restart = port_restart,
    };
    const fhal_display_info_t *display = fhal_display_info();
    app_config_t config = {
        .buffer = s_frame,
        .buffer_bytes = sizeof s_frame,
        .display_name = display->name,
    };
    esp_err_t err;

#if CONFIG_FRACTONICA_DISPLAY_GC9A01
    config.face = FUI_FACE_ROUND240;
#elif CONFIG_FRACTONICA_DISPLAY_ST7789_240X240
    config.face = FUI_FACE_RECT240;
#elif CONFIG_FRACTONICA_DISPLAY_ST7789_240X320
    config.face = FUI_FACE_RECT240X320;
#else
    config.face = FUI_FACE_MONO128;
#endif
    config.format = display->format == FHAL_PIXELS_MONO_PAGE ? FUI_FMT_MONO_PAGE : FUI_FMT_RGB565_BE;
    config.min_frame_ms = CONFIG_FRACTONICA_MIN_FRAME_MS;

    ESP_LOGI(TAG, "Fractonica clock %s, core %s, SPEC %s", APP_VERSION, FRC_VERSION, FRC_SPEC_VERSION);

    /* Settings: what flash holds if it is a record we understand. */
    err = fhal_settings_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "NVS: %s (settings will not be kept)", esp_err_to_name(err));
    }
    if (fhal_settings_load(&config.settings, sizeof config.settings) != ESP_OK
        || !app_settings_valid(&config.settings)) {
        default_settings(&config.settings);
    }

    fhal_time_init();

    err = fhal_display_init();
    s_display_ok = err == ESP_OK;
    if (!s_display_ok) {
        /* Keep going: the console still tells what is wrong. */
        ESP_LOGE(TAG, "display: %s", esp_err_to_name(err));
    }

    s_queue = xQueueCreateStatic(QUEUE_LENGTH, sizeof(app_msg_t), s_queue_storage, &s_queue_memory);
    s_line_done = xSemaphoreCreateBinaryStatic(&s_line_done_memory);

    if (app_init(&s_app, &config, &port) != 0) {
        ESP_LOGE(TAG, "the frame buffer (%u bytes) does not fit the display", (unsigned)sizeof s_frame);
        return;
    }
    ESP_LOGI(TAG, "display %s %dx%d, frame buffer %u bytes static (%s), UI state %u bytes", display->name,
             display->width, display->height, (unsigned)sizeof s_frame, s_app.banded ? "bands" : "whole frame",
             (unsigned)sizeof s_app.ui);

    err = fhal_input_init(on_input, NULL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "input: %s", esp_err_to_name(err));
    }
    err = fhal_console_start(on_console_line, NULL);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "console: %s", esp_err_to_name(err));
    }
    err = fhal_net_start(on_time_synced, NULL);
    if (err != ESP_OK && err != ESP_ERR_NOT_SUPPORTED && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "network time: %s", esp_err_to_name(err));
    }
    err = fhal_power_init();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "light sleep: %s", esp_err_to_name(err));
    }

    /* Priority above the console (2): a redraw that is due goes before a
     * command's output. Any core: the task blocks most of the time. */
    s_ui_task = xTaskCreateStaticPinnedToCore(ui_task, "ui", sizeof s_ui_stack / sizeof s_ui_stack[0], NULL, 5,
                                              s_ui_stack, &s_ui_task_memory, tskNO_AFFINITY);
    ESP_LOGI(TAG, "heap after start-up: %u bytes free", (unsigned)heap_caps_get_free_size(MALLOC_CAP_DEFAULT));
}
