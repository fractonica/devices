/*
 * fhal_net_off.c - fhal_net.h for a build without CONFIG_FRACTONICA_WIFI_SNTP:
 * nothing to start, and no reference that would link the Wi-Fi stack.
 */
#include "fhal_net.h"

#include <stddef.h>

esp_err_t fhal_net_start(fhal_net_synced_t on_synced, void *ctx)
{
    (void)on_synced;
    (void)ctx;
    return ESP_ERR_NOT_SUPPORTED;
}

const char *fhal_net_state(unsigned *synced, unsigned *failed)
{
    if (synced) {
        *synced = 0;
    }
    if (failed) {
        *failed = 0;
    }
    return "off";
}
