/*
 * fhal_board.h - the board pin map: the ONE place that turns the Kconfig
 * choices (main/Kconfig.projbuild, CONFIG_FRACTONICA_*) into the constants
 * the drivers use. No other file of the HAL names a CONFIG_FRACTONICA_PIN_*.
 *
 * A board is therefore a set of Kconfig values: the defaults in
 * Kconfig.projbuild are the development kit of each chip (docs/GUIDE.md,
 * "Wiring"), and a different board is a defaults file passed to the build
 * (configs/, AGENTS.md "Add a board").
 */
#ifndef FHAL_BOARD_H
#define FHAL_BOARD_H

#include "sdkconfig.h"

/* --- display ----------------------------------------------------------- */

#if CONFIG_FRACTONICA_DISPLAY_GC9A01
#  define FHAL_DISPLAY_NAME   "gc9a01"
#  define FHAL_DISPLAY_WIDTH  240
#  define FHAL_DISPLAY_HEIGHT 240
#  define FHAL_DISPLAY_ROUND  1
#elif CONFIG_FRACTONICA_DISPLAY_ST7789_240X240
#  define FHAL_DISPLAY_NAME   "st7789"
#  define FHAL_DISPLAY_WIDTH  240
#  define FHAL_DISPLAY_HEIGHT 240
#  define FHAL_DISPLAY_ROUND  0
#elif CONFIG_FRACTONICA_DISPLAY_ST7789_240X320
#  define FHAL_DISPLAY_NAME   "st7789"
#  define FHAL_DISPLAY_WIDTH  240
#  define FHAL_DISPLAY_HEIGHT 320
#  define FHAL_DISPLAY_ROUND  0
#elif CONFIG_FRACTONICA_DISPLAY_SSD1306
#  define FHAL_DISPLAY_NAME   "ssd1306"
#  define FHAL_DISPLAY_WIDTH  128
#  define FHAL_DISPLAY_HEIGHT 64
#  define FHAL_DISPLAY_ROUND  0
#else
#  error "No display selected: menuconfig -> Fractonica clock -> Display"
#endif

/* Quarter turns clockwise, 0..3. */
#define FHAL_DISPLAY_ROTATION CONFIG_FRACTONICA_DISPLAY_ROTATION

#ifdef CONFIG_FRACTONICA_DISPLAY_MIRROR_X
#  define FHAL_DISPLAY_MIRROR_X 1
#else
#  define FHAL_DISPLAY_MIRROR_X 0
#endif
#ifdef CONFIG_FRACTONICA_DISPLAY_MIRROR_Y
#  define FHAL_DISPLAY_MIRROR_Y 1
#else
#  define FHAL_DISPLAY_MIRROR_Y 0
#endif

#if CONFIG_FRACTONICA_DISPLAY_SPI
/* spi_host_device_t counts from SPI1_HOST = 0; Kconfig says 2 or 3. */
#  define FHAL_SPI_HOST   (CONFIG_FRACTONICA_SPI_HOST - 1)
#  define FHAL_SPI_HZ     CONFIG_FRACTONICA_SPI_HZ
#  define FHAL_PIN_SCLK   CONFIG_FRACTONICA_PIN_SCLK
#  define FHAL_PIN_MOSI   CONFIG_FRACTONICA_PIN_MOSI
#  define FHAL_PIN_CS     CONFIG_FRACTONICA_PIN_CS
#  define FHAL_PIN_DC     CONFIG_FRACTONICA_PIN_DC
#  define FHAL_PIN_RST    CONFIG_FRACTONICA_PIN_RST
#  define FHAL_PIN_BL     CONFIG_FRACTONICA_PIN_BL
#  define FHAL_GAP_X      CONFIG_FRACTONICA_DISPLAY_GAP_X
#  define FHAL_GAP_Y      CONFIG_FRACTONICA_DISPLAY_GAP_Y
#  ifdef CONFIG_FRACTONICA_BL_ACTIVE_HIGH
#    define FHAL_BL_ACTIVE_HIGH 1
#  else
#    define FHAL_BL_ACTIVE_HIGH 0
#  endif
#  ifdef CONFIG_FRACTONICA_BL_PWM
#    define FHAL_BL_PWM 1
#  else
#    define FHAL_BL_PWM 0
#  endif
#  ifdef CONFIG_FRACTONICA_DISPLAY_INVERT
#    define FHAL_DISPLAY_INVERT 1
#  else
#    define FHAL_DISPLAY_INVERT 0
#  endif
#  ifdef CONFIG_FRACTONICA_DISPLAY_BGR
#    define FHAL_DISPLAY_BGR 1
#  else
#    define FHAL_DISPLAY_BGR 0
#  endif
#endif

#if CONFIG_FRACTONICA_DISPLAY_SSD1306
#  define FHAL_I2C_PORT     CONFIG_FRACTONICA_I2C_PORT
#  define FHAL_I2C_ADDR     CONFIG_FRACTONICA_I2C_ADDR
#  define FHAL_I2C_HZ       CONFIG_FRACTONICA_I2C_HZ
#  define FHAL_PIN_SDA      CONFIG_FRACTONICA_PIN_SDA
#  define FHAL_PIN_SCL      CONFIG_FRACTONICA_PIN_SCL
#  define FHAL_PIN_OLED_RST CONFIG_FRACTONICA_PIN_OLED_RST
#  ifdef CONFIG_FRACTONICA_I2C_PULLUPS
#    define FHAL_I2C_PULLUPS 1
#  else
#    define FHAL_I2C_PULLUPS 0
#  endif
#endif

/* --- input ------------------------------------------------------------- */

#if CONFIG_FRACTONICA_INPUT_ENCODER
#  define FHAL_INPUT_NAME    "encoder"
#  define FHAL_BUTTON_COUNT  1 /* the push */
#  define FHAL_PIN_ENC_A     CONFIG_FRACTONICA_PIN_ENC_A
#  define FHAL_PIN_ENC_B     CONFIG_FRACTONICA_PIN_ENC_B
#  define FHAL_ENC_COUNTS    CONFIG_FRACTONICA_ENC_COUNTS
#  ifdef CONFIG_FRACTONICA_ENC_REVERSE
#    define FHAL_ENC_REVERSE 1
#  else
#    define FHAL_ENC_REVERSE 0
#  endif
#elif CONFIG_FRACTONICA_INPUT_BUTTONS_3
#  define FHAL_INPUT_NAME    "3 buttons"
#  define FHAL_BUTTON_COUNT  3
#elif CONFIG_FRACTONICA_INPUT_BUTTONS_2
#  define FHAL_INPUT_NAME    "2 buttons"
#  define FHAL_BUTTON_COUNT  2
#elif CONFIG_FRACTONICA_INPUT_BUTTON_1
#  define FHAL_INPUT_NAME    "1 button"
#  define FHAL_BUTTON_COUNT  1
#else
#  define FHAL_INPUT_NAME    "none"
#  define FHAL_BUTTON_COUNT  0
#endif

#if FHAL_BUTTON_COUNT > 0
#  define FHAL_PIN_BTN_A     CONFIG_FRACTONICA_PIN_BTN_A
#  define FHAL_DEBOUNCE_MS   CONFIG_FRACTONICA_DEBOUNCE_MS
#  define FHAL_LONG_MS       CONFIG_FRACTONICA_LONG_MS
#  define FHAL_DOUBLE_MS     CONFIG_FRACTONICA_DOUBLE_MS
#  ifdef CONFIG_FRACTONICA_BTN_ACTIVE_LOW
#    define FHAL_BTN_ACTIVE_LOW 1
#  else
#    define FHAL_BTN_ACTIVE_LOW 0
#  endif
#endif
#if FHAL_BUTTON_COUNT > 1
#  define FHAL_PIN_BTN_B     CONFIG_FRACTONICA_PIN_BTN_B
#endif
#if FHAL_BUTTON_COUNT > 2
#  define FHAL_PIN_BTN_C     CONFIG_FRACTONICA_PIN_BTN_C
#endif

#endif /* FHAL_BOARD_H */
