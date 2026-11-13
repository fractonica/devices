/*
 * fhal_power.c - automatic light sleep (see fhal_power.h). Not verified on
 * hardware.
 */
#include "fhal_power.h"

#include "sdkconfig.h"

#if CONFIG_FRACTONICA_LIGHT_SLEEP
#  include "esp_pm.h"
#endif
/* The two options under which ESP-IDF isolates every pin in light sleep
 * (esp_hw_support/sleep_gpio.c, esp_sleep_startup_init). */
#define PINS_ISOLATED_IN_SLEEP (CONFIG_ESP_SLEEP_GPIO_RESET_WORKAROUND || CONFIG_PM_SLP_DISABLE_GPIO)
#if PINS_ISOLATED_IN_SLEEP
#  include "driver/gpio.h"
#endif

esp_err_t fhal_power_init(void)
{
#if CONFIG_FRACTONICA_LIGHT_SLEEP
    /* One CPU frequency: scaling it would change nothing we need and would
     * make every peripheral clock a thing to check. */
    esp_pm_config_t config = {
        .max_freq_mhz = CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ,
        .min_freq_mhz = CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ,
        .light_sleep_enable = true,
    };

    return esp_pm_configure(&config);
#else
    return ESP_OK;
#endif
}

void fhal_power_keep_pin(int gpio)
{
#if PINS_ISOLATED_IN_SLEEP
    if (gpio >= 0) {
        gpio_sleep_sel_dis((gpio_num_t)gpio);
    }
#else
    (void)gpio;
#endif
}

const char *fhal_power_mode(void)
{
#if CONFIG_FRACTONICA_LIGHT_SLEEP
    return "light sleep";
#else
    return "always on";
#endif
}
