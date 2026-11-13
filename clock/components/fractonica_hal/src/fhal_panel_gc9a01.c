/*
 * fhal_panel_gc9a01.c - GC9A01 240 x 240 round panel behind esp_lcd's panel
 * interface (see fhal_panel_gc9a01.h for why it is ours).
 *
 * SOURCES
 *   [DS]  Galaxycore GC9A01A datasheet, "6. Command": the MIPI DCS commands
 *         (01h SWRESET, 10h/11h sleep in / out, 20h/21h inversion, 28h/29h
 *         display off / on, 2Ah/2Bh/2Ch window and memory write, 36h memory
 *         access control, 3Ah pixel format) and the extended ones it
 *         documents: FEh / EFh inter-register enable 1 / 2, B6h display
 *         function control, C3h / C4h / C9h power control 2 / 3 / 4,
 *         E8h frame rate, F0h..F3h gamma 1..4.
 *   [REF] The power-on sequence that makers of the 1.28" round modules
 *         publish with the glass. Besides the commands above it writes
 *         registers the public datasheet does not describe (84h..8Fh, 60h..67h,
 *         70h, 74h, 98h ...: gate and source timing of that glass). They are
 *         kept apart below as VENDOR_INIT and sent only with
 *         CONFIG_FRACTONICA_GC9A01_VENDOR_INIT; the values are the widely
 *         published ones and have NOT been checked against a panel here.
 *
 * TIMING [DS]: 120 ms after a reset before commands, 120 ms after sleep-out
 * before display-on. vTaskDelay, not a busy wait.
 *
 * Not verified on hardware (none was attached when this was written).
 */
#include "fhal_panel_gc9a01.h"

#include "driver/gpio.h"
#include "esp_check.h"
#include "esp_lcd_panel_commands.h"
#include "esp_lcd_panel_interface.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

static const char *TAG = "gc9a01";

typedef struct gc9a01 {
    esp_lcd_panel_t           base;
    esp_lcd_panel_io_handle_t io;
    int                       reset_gpio;
    int                       x_gap, y_gap;
    uint8_t                   madctl; /* the 36h value now in force */
} gc9a01_t;

static gc9a01_t s_panel;

/* One command: its code, how many parameter bytes follow in the table. */
typedef struct init_command {
    uint8_t command;
    uint8_t length;
    uint8_t data[12];
} init_command_t;

/* [DS] documented commands: power, frame rate, gamma. */
static const init_command_t DOCUMENTED_INIT[] = {
    { 0xB6, 2, { 0x00, 0x00 } },                               /* display function control: scan directions */
    { 0xC3, 1, { 0x13 } },                                     /* power control 2: VREG1A                  */
    { 0xC4, 1, { 0x13 } },                                     /* power control 3: VREG1B                  */
    { 0xC9, 1, { 0x22 } },                                     /* power control 4: VREG2A                  */
    { 0xF0, 6, { 0x45, 0x09, 0x08, 0x08, 0x26, 0x2A } },       /* gamma 1                                  */
    { 0xF1, 6, { 0x43, 0x70, 0x72, 0x36, 0x37, 0x6F } },       /* gamma 2                                  */
    { 0xF2, 6, { 0x45, 0x09, 0x08, 0x08, 0x26, 0x2A } },       /* gamma 3                                  */
    { 0xF3, 6, { 0x43, 0x70, 0x72, 0x36, 0x37, 0x6F } },       /* gamma 4                                  */
    { 0xE8, 1, { 0x34 } },                                     /* frame rate: 4-dot inversion              */
};

#if CONFIG_FRACTONICA_GC9A01_VENDOR_INIT
/* [REF] registers outside the public datasheet, as the module makers send them. */
static const init_command_t VENDOR_INIT[] = {
    { 0xEB, 1, { 0x14 } },
    { 0x84, 1, { 0x40 } },
    { 0x85, 1, { 0xFF } },
    { 0x86, 1, { 0xFF } },
    { 0x87, 1, { 0xFF } },
    { 0x88, 1, { 0x0A } },
    { 0x89, 1, { 0x21 } },
    { 0x8A, 1, { 0x00 } },
    { 0x8B, 1, { 0x80 } },
    { 0x8C, 1, { 0x01 } },
    { 0x8D, 1, { 0x01 } },
    { 0x8E, 1, { 0xFF } },
    { 0x8F, 1, { 0xFF } },
    { 0x90, 4, { 0x08, 0x08, 0x08, 0x08 } },
    { 0xBD, 1, { 0x06 } },
    { 0xBC, 1, { 0x00 } },
    { 0xFF, 3, { 0x60, 0x01, 0x04 } },
    { 0xBE, 1, { 0x11 } },
    { 0xE1, 2, { 0x10, 0x0E } },
    { 0xDF, 3, { 0x21, 0x0C, 0x02 } },
    { 0xED, 2, { 0x1B, 0x0B } },
    { 0xAE, 1, { 0x77 } },
    { 0xCD, 1, { 0x63 } },
    { 0x70, 9, { 0x07, 0x07, 0x04, 0x0E, 0x0F, 0x09, 0x07, 0x08, 0x03 } },
    { 0x62, 12, { 0x18, 0x0D, 0x71, 0xED, 0x70, 0x70, 0x18, 0x0F, 0x71, 0xEF, 0x70, 0x70 } },
    { 0x63, 12, { 0x18, 0x11, 0x71, 0xF1, 0x70, 0x70, 0x18, 0x13, 0x71, 0xF3, 0x70, 0x70 } },
    { 0x64, 7, { 0x28, 0x29, 0xF1, 0x01, 0xF1, 0x00, 0x07 } },
    { 0x66, 10, { 0x3C, 0x00, 0xCD, 0x67, 0x45, 0x45, 0x10, 0x00, 0x00, 0x00 } },
    { 0x67, 10, { 0x00, 0x3C, 0x00, 0x00, 0x00, 0x01, 0x54, 0x10, 0x32, 0x98 } },
    { 0x74, 7, { 0x10, 0x85, 0x80, 0x00, 0x00, 0x4E, 0x00 } },
    { 0x98, 2, { 0x3E, 0x07 } },
};
#endif

static esp_err_t send_table(esp_lcd_panel_io_handle_t io, const init_command_t *table, size_t count)
{
    size_t i;

    for (i = 0; i < count; i++) {
        ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, table[i].command, table[i].data, table[i].length), TAG,
                            "init command %02x", table[i].command);
    }
    return ESP_OK;
}

static esp_err_t gc9a01_reset(esp_lcd_panel_t *panel)
{
    gc9a01_t *p = __containerof(panel, gc9a01_t, base);

    if (p->reset_gpio >= 0) {
        gpio_set_level((gpio_num_t)p->reset_gpio, 0);
        vTaskDelay(pdMS_TO_TICKS(10));
        gpio_set_level((gpio_num_t)p->reset_gpio, 1);
    } else {
        ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(p->io, LCD_CMD_SWRESET, NULL, 0), TAG, "software reset");
    }
    vTaskDelay(pdMS_TO_TICKS(120));
    return ESP_OK;
}

static esp_err_t gc9a01_init(esp_lcd_panel_t *panel)
{
    gc9a01_t *p = __containerof(panel, gc9a01_t, base);
    esp_lcd_panel_io_handle_t io = p->io;

    /* [DS] FEh then EFh unlock the extended registers. */
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, 0xFE, NULL, 0), TAG, "inter register enable 1");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, 0xEF, NULL, 0), TAG, "inter register enable 2");
#if CONFIG_FRACTONICA_GC9A01_VENDOR_INIT
    ESP_RETURN_ON_ERROR(send_table(io, VENDOR_INIT, sizeof VENDOR_INIT / sizeof VENDOR_INIT[0]), TAG, "vendor init");
#endif
    ESP_RETURN_ON_ERROR(send_table(io, DOCUMENTED_INIT, sizeof DOCUMENTED_INIT / sizeof DOCUMENTED_INIT[0]), TAG,
                        "init");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, LCD_CMD_MADCTL, &p->madctl, 1), TAG, "memory access control");
    /* [DS] 3Ah: 05h = 16 bits per pixel on the serial interface. */
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, LCD_CMD_COLMOD, (uint8_t[]){ 0x05 }, 1), TAG, "pixel format");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, LCD_CMD_SLPOUT, NULL, 0), TAG, "sleep out");
    vTaskDelay(pdMS_TO_TICKS(120));
    return ESP_OK;
}

static esp_err_t gc9a01_draw_bitmap(esp_lcd_panel_t *panel, int x0, int y0, int x1, int y1, const void *pixels)
{
    gc9a01_t *p = __containerof(panel, gc9a01_t, base);
    esp_lcd_panel_io_handle_t io = p->io;
    size_t bytes = (size_t)(x1 - x0) * (size_t)(y1 - y0) * 2u;

    x0 += p->x_gap;
    x1 += p->x_gap;
    y0 += p->y_gap;
    y1 += p->y_gap;
    /* [DS] 2Ah / 2Bh: first and LAST column / row, high byte first. */
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, LCD_CMD_CASET,
                                                  (uint8_t[]){ (uint8_t)(x0 >> 8), (uint8_t)x0, (uint8_t)((x1 - 1) >> 8),
                                                               (uint8_t)(x1 - 1) }, 4), TAG, "column window");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(io, LCD_CMD_RASET,
                                                  (uint8_t[]){ (uint8_t)(y0 >> 8), (uint8_t)y0, (uint8_t)((y1 - 1) >> 8),
                                                               (uint8_t)(y1 - 1) }, 4), TAG, "row window");
    return esp_lcd_panel_io_tx_color(io, LCD_CMD_RAMWR, pixels, bytes);
}

static esp_err_t gc9a01_invert_color(esp_lcd_panel_t *panel, bool invert)
{
    gc9a01_t *p = __containerof(panel, gc9a01_t, base);

    return esp_lcd_panel_io_tx_param(p->io, invert ? LCD_CMD_INVON : LCD_CMD_INVOFF, NULL, 0);
}

static esp_err_t gc9a01_set_madctl(gc9a01_t *p, uint8_t mask, bool on)
{
    p->madctl = (uint8_t)(on ? (p->madctl | mask) : (p->madctl & (uint8_t)~mask));
    return esp_lcd_panel_io_tx_param(p->io, LCD_CMD_MADCTL, &p->madctl, 1);
}

static esp_err_t gc9a01_mirror(esp_lcd_panel_t *panel, bool mirror_x, bool mirror_y)
{
    gc9a01_t *p = __containerof(panel, gc9a01_t, base);

    p->madctl = (uint8_t)(mirror_x ? (p->madctl | LCD_CMD_MX_BIT) : (p->madctl & (uint8_t)~LCD_CMD_MX_BIT));
    return gc9a01_set_madctl(p, LCD_CMD_MY_BIT, mirror_y);
}

static esp_err_t gc9a01_swap_xy(esp_lcd_panel_t *panel, bool swap)
{
    return gc9a01_set_madctl(__containerof(panel, gc9a01_t, base), LCD_CMD_MV_BIT, swap);
}

static esp_err_t gc9a01_set_gap(esp_lcd_panel_t *panel, int x_gap, int y_gap)
{
    gc9a01_t *p = __containerof(panel, gc9a01_t, base);

    p->x_gap = x_gap;
    p->y_gap = y_gap;
    return ESP_OK;
}

static esp_err_t gc9a01_disp_on_off(esp_lcd_panel_t *panel, bool on)
{
    gc9a01_t *p = __containerof(panel, gc9a01_t, base);

    return esp_lcd_panel_io_tx_param(p->io, on ? LCD_CMD_DISPON : LCD_CMD_DISPOFF, NULL, 0);
}

static esp_err_t gc9a01_disp_sleep(esp_lcd_panel_t *panel, bool sleep)
{
    gc9a01_t *p = __containerof(panel, gc9a01_t, base);

    ESP_RETURN_ON_ERROR(esp_lcd_panel_io_tx_param(p->io, sleep ? LCD_CMD_SLPIN : LCD_CMD_SLPOUT, NULL, 0), TAG,
                        "sleep");
    vTaskDelay(pdMS_TO_TICKS(120)); /* [DS] before the next command */
    return ESP_OK;
}

static esp_err_t gc9a01_del(esp_lcd_panel_t *panel)
{
    (void)panel; /* static: nothing to free */
    return ESP_OK;
}

esp_err_t fhal_new_panel_gc9a01(esp_lcd_panel_io_handle_t io, const esp_lcd_panel_dev_config_t *config,
                                esp_lcd_panel_handle_t *panel)
{
    gc9a01_t *p = &s_panel;

    ESP_RETURN_ON_FALSE(io && config && panel, ESP_ERR_INVALID_ARG, TAG, "invalid argument");
    ESP_RETURN_ON_FALSE(config->bits_per_pixel == 16, ESP_ERR_NOT_SUPPORTED, TAG, "16 bits per pixel only");

    p->io = io;
    p->reset_gpio = config->reset_gpio_num;
    p->x_gap = 0;
    p->y_gap = 0;
    p->madctl = config->rgb_ele_order == LCD_RGB_ELEMENT_ORDER_BGR ? LCD_CMD_BGR_BIT : 0;
    if (p->reset_gpio >= 0) {
        gpio_config_t pin = { .pin_bit_mask = 1ULL << p->reset_gpio, .mode = GPIO_MODE_OUTPUT };

        ESP_RETURN_ON_ERROR(gpio_config(&pin), TAG, "reset pin");
        gpio_set_level((gpio_num_t)p->reset_gpio, 1);
    }
    p->base.reset = gc9a01_reset;
    p->base.init = gc9a01_init;
    p->base.del = gc9a01_del;
    p->base.draw_bitmap = gc9a01_draw_bitmap;
    p->base.invert_color = gc9a01_invert_color;
    p->base.mirror = gc9a01_mirror;
    p->base.swap_xy = gc9a01_swap_xy;
    p->base.set_gap = gc9a01_set_gap;
    p->base.disp_on_off = gc9a01_disp_on_off;
    p->base.disp_sleep = gc9a01_disp_sleep;
    *panel = &p->base;
    return ESP_OK;
}
