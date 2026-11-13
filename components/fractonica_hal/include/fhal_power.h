/*
 * fhal_power.h - light sleep between redraws (optional, experimental).
 *
 * With CONFIG_FRACTONICA_LIGHT_SLEEP the chip enters light sleep whenever
 * every task is blocked, which for this firmware is nearly always: the UI
 * task waits for the next visible change, everything else waits for an
 * interrupt. FreeRTOS's tickless idle does the sleeping; this module only
 * turns it on. What the option costs is listed with it in Kconfig.projbuild.
 * Without the option the functions do nothing.
 *
 * PINS DURING SLEEP. On the ESP32-C3 and ESP32-S3, ESP-IDF isolates EVERY
 * GPIO while the chip is in automatic light sleep (CONFIG_PM_SLP_DISABLE_GPIO,
 * selected by its light-sleep GPIO reset workaround): output off, pulls off,
 * the pin floats. Only pins a driver exempts keep their state. For the panel
 * that would mean a floating RST (the controller may reset and nothing would
 * initialise it again), a floating CS with noise on SCLK (garbage clocked in),
 * and a backlight out of our hands, for 20 s and more at a time. So every
 * display back end hands each pin it owns to fhal_power_keep_pin, which
 * exempts it: the pin then keeps the level and direction the driver gave it
 * (SPI idles with CS high and SCLK low, I2C idles high on its pull-ups). The
 * buttons are exempt already (gpio_wakeup_enable does it), and so are the
 * console's UART pins (ESP-IDF does it).
 */
#ifndef FHAL_POWER_H
#define FHAL_POWER_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Turn automatic light sleep on (if configured). Call after the drivers
 *  are up: they register their own wake-up sources and locks. */
esp_err_t fhal_power_init(void);

/** Keep `gpio` as its driver configured it while the chip sleeps (see PINS
 *  DURING SLEEP above). Does nothing for a negative pin, or when ESP-IDF does
 *  not isolate pins in sleep (the classic ESP32, or no light sleep: then the
 *  chip never sleeps). Call after the driver has configured the pin. */
void fhal_power_keep_pin(int gpio);

/** "light sleep" or "always on". */
const char *fhal_power_mode(void);

#ifdef __cplusplus
}
#endif

#endif /* FHAL_POWER_H */
