/*
 * fhal_settings.c - the settings record in NVS (see fhal_settings.h).
 */
#include "fhal_settings.h"

#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

static const char *TAG = "fhal_settings";

#define NAMESPACE "fractonica"
#define KEY       "settings"

/* What flash holds, so an unchanged save costs a memcmp and no write. */
static unsigned char s_shadow[FHAL_SETTINGS_MAX];
static size_t s_shadow_size;
static unsigned s_writes;

esp_err_t fhal_settings_init(void)
{
    esp_err_t err = nvs_flash_init();

    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "erasing NVS (%s)", esp_err_to_name(err));
        ESP_RETURN_ON_ERROR(nvs_flash_erase(), TAG, "erase");
        err = nvs_flash_init();
    }
    return err;
}

esp_err_t fhal_settings_load(void *data, size_t size)
{
    nvs_handle_t handle;
    size_t stored = FHAL_SETTINGS_MAX;
    esp_err_t err;

    if (size == 0 || size > FHAL_SETTINGS_MAX) {
        return ESP_ERR_INVALID_SIZE;
    }
    err = nvs_open(NAMESPACE, NVS_READONLY, &handle);
    if (err != ESP_OK) {
        return ESP_ERR_NOT_FOUND; /* the namespace does not exist yet */
    }
    err = nvs_get_blob(handle, KEY, s_shadow, &stored);
    nvs_close(handle);
    if (err != ESP_OK || stored != size) {
        s_shadow_size = 0;
        return ESP_ERR_NOT_FOUND;
    }
    s_shadow_size = stored;
    memcpy(data, s_shadow, size);
    return ESP_OK;
}

esp_err_t fhal_settings_save(const void *data, size_t size)
{
    nvs_handle_t handle;
    esp_err_t err;

    if (size == 0 || size > FHAL_SETTINGS_MAX) {
        return ESP_ERR_INVALID_SIZE;
    }
    if (size == s_shadow_size && memcmp(data, s_shadow, size) == 0) {
        return ESP_OK; /* flash already says so */
    }
    ESP_RETURN_ON_ERROR(nvs_open(NAMESPACE, NVS_READWRITE, &handle), TAG, "open");
    err = nvs_set_blob(handle, KEY, data, size);
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    if (err == ESP_OK) {
        memcpy(s_shadow, data, size);
        s_shadow_size = size;
        s_writes++;
    } else {
        ESP_LOGE(TAG, "save failed: %s", esp_err_to_name(err));
    }
    return err;
}

unsigned fhal_settings_writes(void)
{
    return s_writes;
}
