/*
 * fhal_console.c - the line reader (see fhal_console.h).
 *
 * The task blocks in the driver's read with no timeout: it uses no CPU until
 * a byte arrives. With light sleep it also holds the "stay awake" lock while
 * somebody is typing and for a minute after (a sleeping UART loses bytes).
 */
#include "fhal_console.h"

#include <stdio.h>

#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
#  include "driver/usb_serial_jtag.h"
#  include "driver/usb_serial_jtag_vfs.h"
#elif CONFIG_ESP_CONSOLE_UART
#  include "driver/uart.h"
#  include "driver/uart_vfs.h"
#endif
#if CONFIG_FRACTONICA_LIGHT_SLEEP
#  include "esp_pm.h"
#  include "esp_sleep.h"
#endif

#define HAS_CONSOLE (CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG || CONFIG_ESP_CONSOLE_UART)
/* Light sleep: how long the chip stays awake after the last byte. */
#define AWAKE_AFTER_INPUT_MS 60000

#if HAS_CONSOLE

static const char *TAG = "fhal_console";

static fhal_console_line_t s_on_line;
static void *s_on_line_ctx;
static TaskHandle_t s_task;
static StaticTask_t s_task_memory;
static StackType_t s_stack[CONFIG_FRACTONICA_CONSOLE_STACK / sizeof(StackType_t)];
static char s_line[FHAL_CONSOLE_LINE_MAX];

/* One byte, or -1 when `wait` ticks passed without one. */
static int read_byte(TickType_t wait)
{
    uint8_t byte;

#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
    return usb_serial_jtag_read_bytes(&byte, 1, wait) == 1 ? byte : -1;
#else
    return uart_read_bytes((uart_port_t)CONFIG_ESP_CONSOLE_UART_NUM, &byte, 1, wait) == 1 ? byte : -1;
#endif
}

static void prompt(void)
{
    fputs("fractonica> ", stdout);
    fflush(stdout);
}

static void console_task(void *arg)
{
    size_t length = 0;
    TickType_t wait = portMAX_DELAY;
#if CONFIG_FRACTONICA_LIGHT_SLEEP
    esp_pm_lock_handle_t awake = NULL;
    bool held = false;

    /* Awake from the start: somebody may be about to set the time. */
    if (esp_pm_lock_create(ESP_PM_NO_LIGHT_SLEEP, 0, "console", &awake) == ESP_OK) {
        esp_pm_lock_acquire(awake);
        held = true;
        wait = pdMS_TO_TICKS(AWAKE_AFTER_INPUT_MS);
    }
#endif

    (void)arg;
    prompt();
    for (;;) {
        int c = read_byte(wait);

#if CONFIG_FRACTONICA_LIGHT_SLEEP
        if (awake != NULL) {
            if (c < 0) { /* a quiet minute: let the chip sleep, wait for a byte to wake it */
                if (held) {
                    esp_pm_lock_release(awake);
                    held = false;
                }
                wait = portMAX_DELAY;
                continue;
            }
            if (!held) {
                esp_pm_lock_acquire(awake);
                held = true;
            }
            wait = pdMS_TO_TICKS(AWAKE_AFTER_INPUT_MS);
        }
#endif
        if (c < 0) {
            continue;
        }
        if (c == '\r' || c == '\n') {
            if (length == 0) {
                continue; /* the second half of CR LF, or an empty line */
            }
            fputs("\n", stdout);
            s_line[length] = '\0';
            length = 0;
            s_on_line(s_line, s_on_line_ctx);
            prompt();
        } else if (c == 0x08 || c == 0x7F) { /* backspace, delete */
            if (length > 0) {
                length--;
                fputs("\b \b", stdout);
                fflush(stdout);
            }
        } else if (c >= 0x20 && c < 0x7F && length < sizeof s_line - 1) {
            s_line[length++] = (char)c;
            fputc(c, stdout);
            fflush(stdout);
        }
    }
}

#endif /* HAS_CONSOLE */

esp_err_t fhal_console_start(fhal_console_line_t on_line, void *ctx)
{
#if HAS_CONSOLE
    s_on_line = on_line;
    s_on_line_ctx = ctx;
#  if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
    {
        usb_serial_jtag_driver_config_t config = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();

        ESP_RETURN_ON_ERROR(usb_serial_jtag_driver_install(&config), TAG, "usb serial driver");
        usb_serial_jtag_vfs_use_driver(); /* stdout through the driver too */
    }
#  else
    /* Receive through the interrupt-driven driver (the default console only
     * polls). 256 bytes: more than the hardware FIFO, enough for a pasted line. */
    ESP_RETURN_ON_ERROR(uart_driver_install((uart_port_t)CONFIG_ESP_CONSOLE_UART_NUM, 256, 0, 0, NULL, 0), TAG,
                        "uart driver");
    uart_vfs_dev_use_driver(CONFIG_ESP_CONSOLE_UART_NUM);
#    if CONFIG_FRACTONICA_LIGHT_SLEEP
    /* Three edges on RX (any character) wake the chip; that character is lost. */
    uart_set_wakeup_threshold((uart_port_t)CONFIG_ESP_CONSOLE_UART_NUM, 3);
    esp_sleep_enable_uart_wakeup(CONFIG_ESP_CONSOLE_UART_NUM);
#    endif
#  endif
    s_task = xTaskCreateStatic(console_task, "console", sizeof s_stack / sizeof s_stack[0], NULL, 2, s_stack,
                               &s_task_memory);
    return s_task ? ESP_OK : ESP_FAIL;
#else
    (void)on_line;
    (void)ctx;
    return ESP_ERR_NOT_SUPPORTED;
#endif
}

unsigned fhal_console_stack_free(void)
{
#if HAS_CONSOLE
    return s_task ? (unsigned)uxTaskGetStackHighWaterMark(s_task) * sizeof(StackType_t) : 0;
#else
    return 0;
#endif
}
