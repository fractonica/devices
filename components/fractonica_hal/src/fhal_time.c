/*
 * fhal_time.c - the system time and its validity (see fhal_time.h).
 */
#include "fhal_time.h"

#include <stdlib.h>
#include <sys/time.h>

#include "esp_attr.h"
#include "esp_log.h"
#include "sdkconfig.h"

static const char *TAG = "fhal_time";

/* Survives software resets, not power-on: RTC slow memory, never initialised
 * by the start-up code. The check word tells a kept value from noise. */
#define VALID_MAGIC 0x46524354u /* "FRCT" */
static RTC_NOINIT_ATTR uint32_t s_kept_magic;
static RTC_NOINIT_ATTR uint32_t s_kept_source;

static fhal_time_source_t s_source;

const char *fhal_time_source_name(fhal_time_source_t source)
{
    switch (source) {
    case FHAL_TIME_DEMO:    return "demo";
    case FHAL_TIME_CONSOLE: return "console";
    case FHAL_TIME_SNTP:    return "sntp";
    default:                return "not set";
    }
}

static void remember(fhal_time_source_t source)
{
    s_source = source;
    s_kept_source = (uint32_t)source;
    s_kept_magic = VALID_MAGIC ^ (uint32_t)source;
}

void fhal_time_init(void)
{
    const char *demo = CONFIG_FRACTONICA_DEMO_TIME;

    if (s_kept_source >= FHAL_TIME_DEMO && s_kept_source <= FHAL_TIME_SNTP
        && s_kept_magic == (VALID_MAGIC ^ s_kept_source)) {
        s_source = (fhal_time_source_t)s_kept_source;
        ESP_LOGI(TAG, "time kept across the reset (set by: %s)", fhal_time_source_name(s_source));
        return;
    }
    s_source = FHAL_TIME_NOT_SET;
    if (demo[0] != '\0') {
        char *end;
        long long seconds = strtoll(demo, &end, 10);

        if (end != demo && *end == '\0') {
            fhal_time_set_us((int64_t)seconds * 1000000, FHAL_TIME_DEMO);
            ESP_LOGW(TAG, "time not known: running from the demo instant %lld", seconds);
            return;
        }
        ESP_LOGE(TAG, "CONFIG_FRACTONICA_DEMO_TIME is not a number: \"%s\"", demo);
    }
    ESP_LOGW(TAG, "time not set");
}

int64_t fhal_time_now_us(void)
{
    struct timeval tv;

    if (s_source == FHAL_TIME_NOT_SET) {
        return FHAL_TIME_UNSET;
    }
    gettimeofday(&tv, NULL);
    /* Seconds whose microseconds int64 cannot count are not a time (the
     * console refuses to set them; this keeps a stray settimeofday from
     * overflowing here). */
    if (tv.tv_sec > (INT64_MAX / 1000000 - 1) || tv.tv_sec < -(INT64_MAX / 1000000 - 1)) {
        return FHAL_TIME_UNSET;
    }
    return (int64_t)tv.tv_sec * 1000000 + tv.tv_usec;
}

void fhal_time_set_us(int64_t unix_us, fhal_time_source_t source)
{
    struct timeval tv;
    int64_t seconds = unix_us / 1000000, micros = unix_us % 1000000;

    if (micros < 0) { /* before 1970: keep tv_usec in 0..999999 */
        micros += 1000000;
        seconds -= 1;
    }
    tv.tv_sec = (time_t)seconds;
    tv.tv_usec = (suseconds_t)micros;
    settimeofday(&tv, NULL);
    remember(source);
}

void fhal_time_mark(fhal_time_source_t source)
{
    remember(source);
}

fhal_time_source_t fhal_time_source(void)
{
    return s_source;
}
