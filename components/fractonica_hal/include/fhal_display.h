/*
 * fhal_display.h - the one small interface every display back end implements.
 *
 * One display is chosen at build time (Kconfig, "Fractonica clock" ->
 * "Display") and exactly one back end is compiled, so these are plain
 * functions, not a table of pointers: no indirection and no dead driver in
 * flash.
 *
 *   fhal_display_spi.c       GC9A01 and ST7789 colour panels on SPI
 *   fhal_display_ssd1306.c   SSD1306 one-bit panel on I2C
 *
 * THE CONTRACT
 *   - The UI draws into memory it owns and hands the driver a WINDOW of the
 *     screen: the rectangle [x0, x1) x [y0, y1) and exactly that rectangle's
 *     pixels, row after row, in the panel's own byte layout (`format` below).
 *     The driver never converts pixels and never keeps the pointer.
 *   - fhal_display_flush returns when the pixels are on the wire: the caller
 *     may reuse the memory at once (band rendering depends on it). It BLOCKS
 *     on a semaphore meanwhile; it does not spin.
 *   - The first flush lights the panel (backlight / display on), so the
 *     controller's power-on noise is never shown.
 *   - All functions are called from the UI task only.
 */
#ifndef FHAL_DISPLAY_H
#define FHAL_DISPLAY_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum fhal_pixel_format {
    /* 16 bits a pixel, RGB565, HIGH byte first in memory: what the SPI
     * panels take, so a flush is a plain transfer (fui: FUI_FMT_RGB565_BE). */
    FHAL_PIXELS_RGB565_BE = 0,
    /* The SSD1306's pages: one byte = 8 pixels stacked vertically, bit 0 on
     * top, `width` bytes per page (fui: FUI_FMT_MONO_PAGE). */
    FHAL_PIXELS_MONO_PAGE = 1
} fhal_pixel_format_t;

typedef struct fhal_display_info {
    const char *name;   /* "gc9a01", "st7789", "ssd1306"                     */
    uint16_t    width;  /* as seen by the UI, after rotation                 */
    uint16_t    height;
    uint8_t     format; /* fhal_pixel_format_t                               */
    uint8_t     round;  /* 1: only the inscribed circle is visible           */
} fhal_display_info_t;

/** What was built in. Valid before fhal_display_init. */
const fhal_display_info_t *fhal_display_info(void);

/** Bring up the bus and the panel; the glass stays dark until the first flush. */
esp_err_t fhal_display_init(void);

/**
 * Send one window of pixels (see THE CONTRACT).
 * Colour panels: any window. SSD1306: whole pages of whole rows only, that
 * is x0 == 0, x1 == width, y0 and y1 multiples of 8 (ESP_ERR_INVALID_ARG
 * otherwise).
 */
esp_err_t fhal_display_flush(int x0, int y0, int x1, int y1, const void *pixels);

/** 0..100. Backlight duty on the colour panels, contrast on the SSD1306. */
esp_err_t fhal_display_set_brightness(uint8_t percent);

/** true: panel and backlight off (the picture is kept by the controller's
 *  memory on the colour panels); false: on again. */
esp_err_t fhal_display_sleep(bool sleep);

#ifdef __cplusplus
}
#endif

#endif /* FHAL_DISPLAY_H */
