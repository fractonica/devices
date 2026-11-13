/*
 * fhal_net.c - Wi-Fi + SNTP as a small state machine (see fhal_net.h).
 *
 *            timer                 GOT_IP                 SNTP answered
 *   WAITING -------> JOINING -----------------> ASKING ------------------> WAITING
 *      ^                |  disconnected / 30 s     |  30 s                (radio off,
 *      |                v                          v                       next interval)
 *      +------------ radio off, back-off <---------+
 *
 * Every transition happens in the default event loop task: Wi-Fi and IP
 * events arrive there, and the two things that happen elsewhere (the timer
 * expiring in the esp_timer task, the SNTP answer in the TCP/IP task) only
 * post an event to it. So the state needs no lock.
 */
#include "fhal_net.h"

#include <string.h>

#include "esp_check.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_sntp.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "fhal_time.h"
#include "sdkconfig.h"

static const char *TAG = "fhal_net";

#define ATTEMPT_TIMEOUT_US (30 * 1000000LL)
#define BACKOFF_FIRST_US   (15 * 1000000LL)
#define BACKOFF_MAX_US     (15 * 60 * 1000000LL)
#define INTERVAL_US        ((int64_t)CONFIG_FRACTONICA_SNTP_INTERVAL_MIN * 60 * 1000000LL)

ESP_EVENT_DEFINE_BASE(FHAL_NET_EVENT);
enum { NET_TIMER = 0, NET_SYNCED = 1 };

typedef enum { STATE_OFF, STATE_WAITING, STATE_JOINING, STATE_ASKING } net_state_t;

static net_state_t s_state;
static esp_timer_handle_t s_timer;
static unsigned s_synced, s_failed, s_failures_in_a_row;
static fhal_net_synced_t s_on_synced;
static void *s_on_synced_ctx;

static void arm_timer(int64_t delay_us)
{
    esp_timer_stop(s_timer); /* an error only says it was not running */
    esp_timer_start_once(s_timer, (uint64_t)delay_us);
}

static void attempt_begin(void)
{
    s_state = STATE_JOINING;
    arm_timer(ATTEMPT_TIMEOUT_US);
    if (esp_wifi_start() != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_start failed"); /* the timeout will retry */
    }
}

/* Radio off; the timer says when the next attempt starts. */
static void attempt_end(int ok)
{
    int64_t delay = INTERVAL_US;

    esp_sntp_stop();
    esp_wifi_stop();
    s_state = STATE_WAITING;
    if (ok) {
        s_synced++;
        s_failures_in_a_row = 0;
    } else {
        unsigned doubling = s_failures_in_a_row < 6 ? s_failures_in_a_row : 6;

        s_failed++;
        s_failures_in_a_row++;
        delay = BACKOFF_FIRST_US << doubling;
        if (delay > BACKOFF_MAX_US) {
            delay = BACKOFF_MAX_US;
        }
        if (delay > INTERVAL_US) {
            delay = INTERVAL_US;
        }
        ESP_LOGW(TAG, "no time from the network; next try in %d s", (int)(delay / 1000000));
    }
    arm_timer(delay);
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)data;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        if (s_state == STATE_JOINING) {
            esp_wifi_connect();
        }
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        /* Also posted by our own esp_wifi_stop: only an attempt cares. */
        if (s_state != STATE_WAITING) {
            attempt_end(0);
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        if (s_state == STATE_JOINING) {
            s_state = STATE_ASKING;
            esp_netif_sntp_start();
        }
    } else if (base == FHAL_NET_EVENT && id == NET_SYNCED) {
        if (s_state == STATE_ASKING) {
            /* lwIP has called settimeofday already. */
            fhal_time_mark(FHAL_TIME_SNTP);
            ESP_LOGI(TAG, "time set from %s", CONFIG_FRACTONICA_SNTP_SERVER);
            attempt_end(1);
            if (s_on_synced) {
                s_on_synced(s_on_synced_ctx);
            }
        }
    } else if (base == FHAL_NET_EVENT && id == NET_TIMER) {
        if (s_state == STATE_WAITING) {
            attempt_begin();
        } else {
            attempt_end(0); /* joining or asking took too long */
        }
    }
}

/* esp_timer task. */
static void on_timer(void *arg)
{
    (void)arg;
    esp_event_post(FHAL_NET_EVENT, NET_TIMER, NULL, 0, pdMS_TO_TICKS(1000));
}

/* TCP/IP task, after the system time was set. */
static void on_sntp(struct timeval *tv)
{
    (void)tv;
    esp_event_post(FHAL_NET_EVENT, NET_SYNCED, NULL, 0, pdMS_TO_TICKS(1000));
}

esp_err_t fhal_net_start(fhal_net_synced_t on_synced, void *ctx)
{
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    wifi_config_t wifi = { 0 };
    esp_sntp_config_t sntp = ESP_NETIF_SNTP_DEFAULT_CONFIG(CONFIG_FRACTONICA_SNTP_SERVER);
    const esp_timer_create_args_t timer = { .callback = on_timer, .name = "fhal_net" };

    s_on_synced = on_synced;
    s_on_synced_ctx = ctx;

    /* No network configured: say so once, and do not start the stack (an
     * empty name would otherwise be retried forever, every 15 minutes). */
    if (CONFIG_FRACTONICA_WIFI_SSID[0] == '\0') {
        s_state = STATE_OFF;
        ESP_LOGW(TAG, "network time: no Wi-Fi network configured (menuconfig -> Fractonica clock)");
        return ESP_ERR_INVALID_STATE;
    }
    ESP_RETURN_ON_ERROR(esp_netif_init(), TAG, "netif");
    ESP_RETURN_ON_ERROR(esp_event_loop_create_default(), TAG, "event loop");
    esp_netif_create_default_wifi_sta();
    ESP_RETURN_ON_ERROR(esp_wifi_init(&init), TAG, "wifi init");
    /* The credentials come from the build: nothing to write to flash. */
    ESP_RETURN_ON_ERROR(esp_wifi_set_storage(WIFI_STORAGE_RAM), TAG, "wifi storage");
    ESP_RETURN_ON_ERROR(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL, NULL), TAG,
                        "wifi events");
    ESP_RETURN_ON_ERROR(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL, NULL), TAG,
                        "ip events");
    ESP_RETURN_ON_ERROR(esp_event_handler_instance_register(FHAL_NET_EVENT, ESP_EVENT_ANY_ID, on_event, NULL, NULL),
                        TAG, "own events");

    strlcpy((char *)wifi.sta.ssid, CONFIG_FRACTONICA_WIFI_SSID, sizeof wifi.sta.ssid);
    strlcpy((char *)wifi.sta.password, CONFIG_FRACTONICA_WIFI_PASSWORD, sizeof wifi.sta.password);
    /* With a password, refuse anything weaker than WPA2-PSK: an open or WEP
     * network of the same name would otherwise be joined, and it would choose
     * the DNS and so the time server, i.e. the time the clock shows. Without
     * one, the network is open by configuration. */
    wifi.sta.threshold.authmode = CONFIG_FRACTONICA_WIFI_PASSWORD[0] != '\0' ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_STA), TAG, "wifi mode");
    ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_STA, &wifi), TAG, "wifi config");

    sntp.start = false;         /* started when the network is up            */
    sntp.wait_for_sync = false; /* nobody blocks on it: we take the callback */
    sntp.sync_cb = on_sntp;
    ESP_RETURN_ON_ERROR(esp_netif_sntp_init(&sntp), TAG, "sntp");

    ESP_RETURN_ON_ERROR(esp_timer_create(&timer, &s_timer), TAG, "timer");
    ESP_LOGI(TAG, "network time: \"%s\", server %s, every %d min", CONFIG_FRACTONICA_WIFI_SSID,
             CONFIG_FRACTONICA_SNTP_SERVER, CONFIG_FRACTONICA_SNTP_INTERVAL_MIN);
    /* The first attempt goes through the event loop like every other. */
    s_state = STATE_WAITING;
    arm_timer(1000);
    return ESP_OK;
}

const char *fhal_net_state(unsigned *synced, unsigned *failed)
{
    if (synced) {
        *synced = s_synced;
    }
    if (failed) {
        *failed = s_failed;
    }
    switch (s_state) {
    case STATE_OFF:     return "not configured";
    case STATE_JOINING: return "joining";
    case STATE_ASKING:  return "asking";
    default:            return "waiting";
    }
}
