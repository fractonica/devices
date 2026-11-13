/*
 * fhal_display_ssd1306.c - the one-bit panel: SSD1306 128 x 64 on I2C.
 * Implements fhal_display.h with ESP-IDF's own pieces: the new I2C master
 * driver (driver/i2c_master.h), esp_lcd's I2C panel IO and its SSD1306 panel
 * driver.
 *
 * THE FLUSH
 *   The UI's one-bit canvas is laid out as the SSD1306's own pages
 *   (FUI_FMT_MONO_PAGE), so a flush sends the buffer as it is: whole pages
 *   of whole rows. The I2C transfer is blocking inside the driver (the task
 *   sleeps on the driver's own semaphore); a full frame is 1,024 bytes,
 *   about 25 ms at 400 kHz.
 *
 * Brightness is the controller's contrast register (81h, SSD1306 datasheet
 * "Set Contrast Control"); sleep is display off (AEh), which also stops the
 * charge pump's load.
 *
 * Not verified on hardware.
 */
#include "fhal_display.h"

#include "driver/i2c_master.h"
#include "esp_check.h"
#include "esp_lcd_io_i2c.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_ssd1306.h"
#include "esp_log.h"
#include "fhal_board.h"
#include "fhal_power.h"

#if FHAL_DISPLAY_ROTATION & 1
#  error "The 128 x 64 face is upright: rotation 0 or 180 only"
#endif

static const char *TAG = "fhal_display";

#define SSD1306_SET_CONTRAST 0x81

static const fhal_display_info_t INFO = {
    .name = FHAL_DISPLAY_NAME,
    .width = FHAL_DISPLAY_WIDTH,
    .height = FHAL_DISPLAY_HEIGHT,
    .format = FHAL_PIXELS_MONO_PAGE,
    .round = 0,
};

static esp_lcd_panel_io_handle_t s_io;
static esp_lcd_panel_handle_t s_panel;
static bool s_lit;

const fhal_display_info_t *fhal_display_info(void)
{
    return &INFO;
}

esp_err_t fhal_display_init(void)
{
    i2c_master_bus_config_t bus_config = {
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .i2c_port = FHAL_I2C_PORT,
        .sda_io_num = FHAL_PIN_SDA,
        .scl_io_num = FHAL_PIN_SCL,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = FHAL_I2C_PULLUPS,
    };
    esp_lcd_panel_io_i2c_config_t io_config = {
        .dev_addr = FHAL_I2C_ADDR,
        .scl_speed_hz = FHAL_I2C_HZ,
        .control_phase_bytes = 1, /* SSD1306: one control byte before commands and data */
        .dc_bit_offset = 6,       /* ... whose bit 6 says which of the two follows       */
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
    };
    esp_lcd_panel_ssd1306_config_t vendor = { .height = FHAL_DISPLAY_HEIGHT };
    esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = FHAL_PIN_OLED_RST,
        .bits_per_pixel = 1,
        .vendor_config = &vendor,
    };
    i2c_master_bus_handle_t bus = NULL;
    bool turned = (FHAL_DISPLAY_ROTATION & 2) != 0;

    ESP_RETURN_ON_ERROR(i2c_new_master_bus(&bus_config, &bus), TAG, "i2c bus");
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_i2c(bus, &io_config, &s_io), TAG, "panel io");
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_ssd1306(s_io, &panel_config, &s_panel), TAG, "ssd1306");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_reset(s_panel), TAG, "reset");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(s_panel), TAG, "init");
    /* A half turn mirrors both axes. */
    ESP_RETURN_ON_ERROR(esp_lcd_panel_mirror(s_panel, turned ^ FHAL_DISPLAY_MIRROR_X, turned ^ FHAL_DISPLAY_MIRROR_Y),
                        TAG, "mirror");
    /* Light sleep on the C3 / S3 would let the bus and the reset pin float
     * (fhal_power.h, "PINS DURING SLEEP"): keep them as the drivers set them. */
    fhal_power_keep_pin(FHAL_PIN_SDA);
    fhal_power_keep_pin(FHAL_PIN_SCL);
    fhal_power_keep_pin(FHAL_PIN_OLED_RST);
    ESP_LOGI(TAG, "%s %dx%d on I2C%d address 0x%02x at %d Hz", INFO.name, INFO.width, INFO.height, FHAL_I2C_PORT,
             FHAL_I2C_ADDR, FHAL_I2C_HZ);
    return ESP_OK;
}

esp_err_t fhal_display_flush(int x0, int y0, int x1, int y1, const void *pixels)
{
    if (x0 != 0 || x1 != INFO.width || y0 < 0 || y1 > INFO.height || y0 >= y1 || (y0 & 7) || (y1 & 7)
        || pixels == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    ESP_RETURN_ON_ERROR(esp_lcd_panel_draw_bitmap(s_panel, x0, y0, x1, y1, pixels), TAG, "draw");
    if (!s_lit) {
        s_lit = true; /* the first picture is in the controller's memory */
        return esp_lcd_panel_disp_on_off(s_panel, true);
    }
    return ESP_OK;
}

esp_err_t fhal_display_set_brightness(uint8_t percent)
{
    uint8_t contrast = (uint8_t)((percent > 100 ? 100u : percent) * 255u / 100u);

    return esp_lcd_panel_io_tx_param(s_io, SSD1306_SET_CONTRAST, &contrast, 1);
}

esp_err_t fhal_display_sleep(bool sleep)
{
    return esp_lcd_panel_disp_on_off(s_panel, !sleep);
}
