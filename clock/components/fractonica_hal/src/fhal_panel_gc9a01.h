/*
 * fhal_panel_gc9a01.h - our own minimal GC9A01 panel driver.
 *
 * ESP-IDF 5.5 ships panel drivers for the ST7789 and the SSD1306 but not for
 * the GC9A01 (Espressif's is a separately downloaded component, and this
 * project downloads nothing). This one implements esp_lcd's panel interface,
 * so the rest of the HAL drives both colour panels through the same
 * esp_lcd_panel_* calls.
 */
#ifndef FHAL_PANEL_GC9A01_H
#define FHAL_PANEL_GC9A01_H

#include "esp_err.h"
#include "esp_lcd_panel_dev.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_types.h"

/**
 * The one GC9A01 of the clock (a static object: no heap, call once).
 * Uses reset_gpio_num (-1: software reset), rgb_ele_order and
 * bits_per_pixel (16 only) of `config`.
 */
esp_err_t fhal_new_panel_gc9a01(esp_lcd_panel_io_handle_t io, const esp_lcd_panel_dev_config_t *config,
                                esp_lcd_panel_handle_t *panel);

#endif /* FHAL_PANEL_GC9A01_H */
