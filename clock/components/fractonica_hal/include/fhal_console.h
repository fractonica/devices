/*
 * fhal_console.h - a tiny line reader on the serial console.
 *
 * Not esp_console: its line editor allocates for every line, and the clock
 * allocates nothing after start-up. This is one small static task that
 * blocks in the UART (or USB-Serial-JTAG) driver until a byte arrives,
 * echoes it, and hands each finished line to a callback. What a line MEANS
 * is not decided here: main/app_console.c interprets the commands.
 *
 * The console is whichever ESP-IDF's own log output uses
 * (menuconfig -> Component config -> ESP System Settings -> Channel for
 * console output): UART0 by default on all three chips, USB-Serial-JTAG if
 * chosen there on the ESP32-S3 / ESP32-C3.
 */
#ifndef FHAL_CONSOLE_H
#define FHAL_CONSOLE_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define FHAL_CONSOLE_LINE_MAX 96

/**
 * Called in the console task with one line (no line ending, NUL-terminated,
 * never empty). The line is valid until the callback returns; the reader
 * prints its prompt after that, so a callback that waits for the command to
 * finish keeps the output in order.
 */
typedef void (*fhal_console_line_t)(const char *line, void *ctx);

/** Install the driver and start the reader task. ESP_ERR_NOT_SUPPORTED when
 *  ESP-IDF's console is turned off. */
esp_err_t fhal_console_start(fhal_console_line_t on_line, void *ctx);

/** Bytes of the console task's stack that were never used (for `info`). */
unsigned fhal_console_stack_free(void);

#ifdef __cplusplus
}
#endif

#endif /* FHAL_CONSOLE_H */
