/*
 * fhal_net.h - the time from a server: Wi-Fi station + SNTP.
 *
 * Built only with CONFIG_FRACTONICA_WIFI_SNTP; without it fhal_net_start
 * reports ESP_ERR_NOT_SUPPORTED and the Wi-Fi stack is not linked at all.
 *
 * ONE SYNCHRONISATION
 *   radio on -> join the network -> ask the SNTP server -> the system time
 *   is set -> radio off -> sleep for CONFIG_FRACTONICA_SNTP_INTERVAL_MIN.
 *   A failed attempt (no network, no answer within 30 s) turns the radio
 *   off and retries after 15 s, 30 s, 1 min ... doubling up to 15 minutes.
 *   The radio is on for a few seconds per interval, which is what makes
 *   light sleep and a small supply possible.
 *
 * Event-driven: everything runs in ESP-IDF's default event loop task, driven
 * by Wi-Fi / IP events and one esp_timer. No task of its own, no polling.
 * (The Wi-Fi stack allocates from the heap while the radio is on; that is
 * ESP-IDF's, not ours, and it is returned when the radio stops.)
 */
#ifndef FHAL_NET_H
#define FHAL_NET_H

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Called in the event loop task each time the server has set the time. */
typedef void (*fhal_net_synced_t)(void *ctx);

/** Start the first synchronisation. NVS must be initialised (fhal_settings_init).
 *  @return ESP_ERR_INVALID_STATE (logged, nothing started) when no network
 *          name is configured; ESP_ERR_NOT_SUPPORTED in a build without Wi-Fi. */
esp_err_t fhal_net_start(fhal_net_synced_t on_synced, void *ctx);

/** "off" (not built), "not configured", "waiting", "joining", "asking" - and
 *  how often it worked / failed. */
const char *fhal_net_state(unsigned *synced, unsigned *failed);

#ifdef __cplusplus
}
#endif

#endif /* FHAL_NET_H */
