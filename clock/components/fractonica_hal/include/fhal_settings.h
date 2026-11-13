/*
 * fhal_settings.h - one small record kept in flash (NVS).
 *
 * The HAL does not know what is in the record: main/ packs the user's mode,
 * focus, screen, UTC offset and brightness into a few bytes (app_settings in
 * main/app.h) and checks them when they come back.
 *
 * WEAR
 *   - main/ calls fhal_settings_save only after the state has been left alone
 *     for a few seconds (turning the encoder through ten levels is one
 *     write), and
 *   - a save of bytes equal to the last ones written or read does not touch
 *     the flash at all.
 *   NVS itself appends: one 32-byte entry per write in a 24 kB partition that
 *   it garbage-collects, about 750 writes per erase cycle of each sector.
 */
#ifndef FHAL_SETTINGS_H
#define FHAL_SETTINGS_H

#include <stddef.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** The largest record. */
#define FHAL_SETTINGS_MAX 16

/** Initialise NVS (erasing it if its layout is from another version). */
esp_err_t fhal_settings_init(void);

/**
 * Read the record into `data`. ESP_ERR_NOT_FOUND when none of exactly
 * `size` bytes was saved (a fresh chip, or a record of another version).
 */
esp_err_t fhal_settings_load(void *data, size_t size);

/** Write the record unless it equals what flash already holds. */
esp_err_t fhal_settings_save(const void *data, size_t size);

/** How many times this boot really wrote to flash (for `info`). */
unsigned fhal_settings_writes(void);

#ifdef __cplusplus
}
#endif

#endif /* FHAL_SETTINGS_H */
