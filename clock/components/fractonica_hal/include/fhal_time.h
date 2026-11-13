/*
 * fhal_time.h - what time it is, and whether the clock may be believed.
 *
 * THE SOURCES, best last
 *   demo      the compile-time instant CONFIG_FRACTONICA_DEMO_TIME: the clock
 *             runs from it when nothing better is known (showcases)
 *   console   `time <unix seconds>` on the serial console
 *   sntp      a time server over Wi-Fi (fhal_net.h)
 *
 * KEEPING IT
 *   The system time itself is ESP-IDF's (gettimeofday): the high-resolution
 *   timer while the chip runs, the RTC timer across a software reset, a
 *   panic, a watchdog reset and light sleep. What ESP-IDF does not keep is
 *   whether that time was ever SET, so this module keeps the source in RTC
 *   memory (RTC_NOINIT_ATTR) with a check word: it survives exactly the
 *   resets the RTC timer survives and is garbage, hence "not set", after a
 *   power-on or a brown-out - when the time is gone too.
 *
 * Until a source has set it, fhal_time_now_us returns FHAL_TIME_UNSET and the
 * display says so instead of showing a wrong reading.
 */
#ifndef FHAL_TIME_H
#define FHAL_TIME_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum fhal_time_source {
    FHAL_TIME_NOT_SET = 0,
    FHAL_TIME_DEMO    = 1,
    FHAL_TIME_CONSOLE = 2,
    FHAL_TIME_SNTP    = 3
} fhal_time_source_t;

/* The same value as the core's FRC_TIME_NONE, so the UI takes it as it is. */
#define FHAL_TIME_UNSET INT64_MIN

/** Recover the source kept across the reset, or start the demo instant. */
void fhal_time_init(void);

/** Unix time in microseconds (UTC), or FHAL_TIME_UNSET. */
int64_t fhal_time_now_us(void);

/** Set the system time and remember who set it. */
void fhal_time_set_us(int64_t unix_us, fhal_time_source_t source);

/** The system time was set by somebody else (SNTP sets it itself): remember
 *  the source only. */
void fhal_time_mark(fhal_time_source_t source);

fhal_time_source_t fhal_time_source(void);

/** "not set", "demo", "console", "sntp". */
const char *fhal_time_source_name(fhal_time_source_t source);

#ifdef __cplusplus
}
#endif

#endif /* FHAL_TIME_H */
