/*
 * fhal_display_spi.c - the colour panels: GC9A01 (240 x 240 round) and
 * ST7789 (240 x 240, 240 x 320) on SPI. Implements fhal_display.h.
 *
 * WHO DOES WHAT
 *   esp_lcd's SPI panel IO      the bus transfers and the D/C line
 *   esp_lcd's ST7789 driver     that panel's commands (shipped with ESP-IDF)
 *   fhal_panel_gc9a01.c         the GC9A01's commands (ours: ESP-IDF has none)
 *   this file                   wiring, rotation, backlight, and the flush
 *
 * THE FLUSH
 *   esp_lcd queues the pixel transfer on the SPI driver (DMA, interrupt
 *   driven) and returns at once. The UI reuses its buffer for the next band,
 *   so fhal_display_flush waits for the "colour transfer done" callback on a
 *   binary semaphore: the task sleeps while the DMA works. The pixels must
 *   lie in internal, word-aligned RAM (the SPI driver would otherwise copy
 *   them through a buffer it allocates per transfer); main/app_main.c keeps
 *   its frame buffer static and aligned for that reason.
 *
 * Not verified on hardware.
 */
#include "fhal_display.h"

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_attr.h"
#include "esp_check.h"
#include "esp_lcd_io_spi.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_st7789.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "fhal_board.h"
#include "fhal_panel_gc9a01.h"
#include "fhal_power.h"

#if FHAL_BL_PWM
#  include "driver/ledc.h"
#endif

#if CONFIG_FRACTONICA_DISPLAY_ST7789_240X320 && (FHAL_DISPLAY_ROTATION & 1)
#  error "The 240 x 320 face is upright: rotation 0 or 180 only"
#endif

static const char *TAG = "fhal_display";

/* The largest single SPI transfer. A 240 x 240 frame goes out in four. */
#define SPI_TRANSFER_BYTES 32768
/* How long one window may take before the flush gives up (a 240 x 320 frame
 * at 1 MHz would need 1.3 s; at the default 40 MHz it needs 31 ms). */
#define FLUSH_TIMEOUT_MS 2000

static const fhal_display_info_t INFO = {
    .name = FHAL_DISPLAY_NAME,
    .width = FHAL_DISPLAY_WIDTH,
    .height = FHAL_DISPLAY_HEIGHT,
    .format = FHAL_PIXELS_RGB565_BE,
    .round = FHAL_DISPLAY_ROUND,
};

static esp_lcd_panel_handle_t s_panel;
static SemaphoreHandle_t s_done;
static StaticSemaphore_t s_done_memory;
static uint8_t s_brightness = 100;
static bool s_lit; /* false until the first frame is in the panel's memory */

const fhal_display_info_t *fhal_display_info(void)
{
    return &INFO;
}

/* ------------------------------------------------------------- backlight */

static esp_err_t backlight_init(void)
{
#if FHAL_PIN_BL >= 0
#  if FHAL_BL_PWM
    ledc_timer_config_t timer = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_10_BIT,
        .timer_num = LEDC_TIMER_0,
        .freq_hz = 5000, /* above flicker, below the audible whine of some LED drivers' coils */
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ledc_channel_config_t channel = {
        .gpio_num = FHAL_PIN_BL,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LEDC_CHANNEL_0,
        .timer_sel = LEDC_TIMER_0,
        .duty = 0,
        .flags.output_invert = !FHAL_BL_ACTIVE_HIGH,
    };

    ESP_RETURN_ON_ERROR(ledc_timer_config(&timer), TAG, "backlight timer");
    return ledc_channel_config(&channel);
#  else
    gpio_config_t pin = { .pin_bit_mask = 1ULL << FHAL_PIN_BL, .mode = GPIO_MODE_OUTPUT };

    ESP_RETURN_ON_ERROR(gpio_config(&pin), TAG, "backlight pin");
    return gpio_set_level((gpio_num_t)FHAL_PIN_BL, !FHAL_BL_ACTIVE_HIGH);
#  endif
#else
    return ESP_OK;
#endif
}

/* 0..100; the duty is squared so the steps look even to the eye. Any
 * percentage above 0 gives at least the smallest duty: squaring alone turns
 * 1..3 % into 0, i.e. "off", which is what 0 says. */
static esp_err_t backlight_set(uint8_t percent)
{
#if FHAL_PIN_BL >= 0
#  if FHAL_BL_PWM
    uint32_t duty = (uint32_t)percent * percent * 1023u / 10000u;

    if (percent > 0 && duty == 0) {
        duty = 1;
    }

    ESP_RETURN_ON_ERROR(ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, duty), TAG, "backlight duty");
    return ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
#  else
    return gpio_set_level((gpio_num_t)FHAL_PIN_BL, percent ? FHAL_BL_ACTIVE_HIGH : !FHAL_BL_ACTIVE_HIGH);
#  endif
#else
    (void)percent;
    return ESP_OK;
#endif
}

/* ----------------------------------------------------------------- panel */

/* SPI interrupt: the last chunk of a colour transfer has left. */
static IRAM_ATTR bool on_color_done(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *event, void *ctx)
{
    BaseType_t woken = pdFALSE;

    (void)io;
    (void)event;
    (void)ctx;
    xSemaphoreGiveFromISR(s_done, &woken);
    return woken == pdTRUE;
}

esp_err_t fhal_display_init(void)
{
    spi_bus_config_t bus = {
        .sclk_io_num = FHAL_PIN_SCLK,
        .mosi_io_num = FHAL_PIN_MOSI,
        .miso_io_num = -1, /* the panels are write-only here */
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = SPI_TRANSFER_BYTES,
    };
    esp_lcd_panel_io_spi_config_t io_config = {
        .cs_gpio_num = FHAL_PIN_CS,
        .dc_gpio_num = FHAL_PIN_DC,
        .spi_mode = 0,
        .pclk_hz = FHAL_SPI_HZ,
        .trans_queue_depth = 8,
        .on_color_trans_done = on_color_done,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
    };
    esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = FHAL_PIN_RST,
        .rgb_ele_order = FHAL_DISPLAY_BGR ? LCD_RGB_ELEMENT_ORDER_BGR : LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = 16,
    };
    /* Quarter turns clockwise as (swap axes, mirror x, mirror y); the
     * Kconfig mirrors are applied on top. */
    static const uint8_t TURN[4][3] = { { 0, 0, 0 }, { 1, 1, 0 }, { 0, 1, 1 }, { 1, 0, 1 } };
    const uint8_t *turn = TURN[FHAL_DISPLAY_ROTATION & 3];
    esp_lcd_panel_io_handle_t io = NULL;
    int gap_x = FHAL_GAP_X, gap_y = FHAL_GAP_Y;

    s_done = xSemaphoreCreateBinaryStatic(&s_done_memory);
    ESP_RETURN_ON_ERROR(backlight_init(), TAG, "backlight");
    ESP_RETURN_ON_ERROR(spi_bus_initialize((spi_host_device_t)FHAL_SPI_HOST, &bus, SPI_DMA_CH_AUTO), TAG, "spi bus");
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)FHAL_SPI_HOST, &io_config, &io), TAG,
                        "panel io");
#if CONFIG_FRACTONICA_DISPLAY_GC9A01
    ESP_RETURN_ON_ERROR(fhal_new_panel_gc9a01(io, &panel_config, &s_panel), TAG, "gc9a01");
#else
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_st7789(io, &panel_config, &s_panel), TAG, "st7789");
#endif
    ESP_RETURN_ON_ERROR(esp_lcd_panel_reset(s_panel), TAG, "reset");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(s_panel), TAG, "init");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_invert_color(s_panel, FHAL_DISPLAY_INVERT), TAG, "invert");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_swap_xy(s_panel, turn[0]), TAG, "swap");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_mirror(s_panel, turn[1] ^ FHAL_DISPLAY_MIRROR_X, turn[2] ^ FHAL_DISPLAY_MIRROR_Y),
                        TAG, "mirror");
#if CONFIG_FRACTONICA_DISPLAY_ST7789_240X240
    /* The ST7789 addresses 240 x 320; a 240 x 240 glass shows its first 240
     * rows, so a picture scanned from the far end starts 80 rows in. */
    if (turn[2] ^ FHAL_DISPLAY_MIRROR_Y) {
        if (turn[0]) {
            gap_x += 80;
        } else {
            gap_y += 80;
        }
    }
#endif
    ESP_RETURN_ON_ERROR(esp_lcd_panel_set_gap(s_panel, gap_x, gap_y), TAG, "gap");
    /* Light sleep on the C3 / S3 would let every one of these float
     * (fhal_power.h, "PINS DURING SLEEP"): keep them driven. */
    fhal_power_keep_pin(FHAL_PIN_SCLK);
    fhal_power_keep_pin(FHAL_PIN_MOSI);
    fhal_power_keep_pin(FHAL_PIN_CS);
    fhal_power_keep_pin(FHAL_PIN_DC);
    fhal_power_keep_pin(FHAL_PIN_RST);
    fhal_power_keep_pin(FHAL_PIN_BL);
    ESP_LOGI(TAG, "%s %dx%d on SPI%d at %d Hz, rotation %d", INFO.name, INFO.width, INFO.height, FHAL_SPI_HOST + 1,
             FHAL_SPI_HZ, FHAL_DISPLAY_ROTATION * 90);
    return ESP_OK;
}

esp_err_t fhal_display_flush(int x0, int y0, int x1, int y1, const void *pixels)
{
    if (x0 < 0 || y0 < 0 || x1 > INFO.width || y1 > INFO.height || x0 >= x1 || y0 >= y1 || pixels == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    xSemaphoreTake(s_done, 0); /* forget a completion nobody waited for */
    ESP_RETURN_ON_ERROR(esp_lcd_panel_draw_bitmap(s_panel, x0, y0, x1, y1, pixels), TAG, "draw");
    if (xSemaphoreTake(s_done, pdMS_TO_TICKS(FLUSH_TIMEOUT_MS)) != pdTRUE) {
        ESP_LOGE(TAG, "flush timed out");
        return ESP_ERR_TIMEOUT;
    }
    if (!s_lit) {
        /* The first picture is in the panel's memory: show it. */
        s_lit = true;
        ESP_RETURN_ON_ERROR(esp_lcd_panel_disp_on_off(s_panel, true), TAG, "display on");
        return backlight_set(s_brightness);
    }
    return ESP_OK;
}

esp_err_t fhal_display_set_brightness(uint8_t percent)
{
    s_brightness = percent > 100 ? 100 : percent;
    return s_lit ? backlight_set(s_brightness) : ESP_OK;
}

esp_err_t fhal_display_sleep(bool sleep)
{
    if (sleep) {
        ESP_RETURN_ON_ERROR(backlight_set(0), TAG, "backlight off");
        ESP_RETURN_ON_ERROR(esp_lcd_panel_disp_on_off(s_panel, false), TAG, "display off");
        return esp_lcd_panel_disp_sleep(s_panel, true);
    }
    ESP_RETURN_ON_ERROR(esp_lcd_panel_disp_sleep(s_panel, false), TAG, "wake");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_disp_on_off(s_panel, true), TAG, "display on");
    return s_lit ? backlight_set(s_brightness) : ESP_OK;
}
