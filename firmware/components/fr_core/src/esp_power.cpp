// Power save's platform on ESP-IDF (design face-f1 D1, D13-D15): hal::Sleep (fr::core::sleep()), the offline flag in
// NVS (namespace fr_core, key offline) read once at boot, and the wall clock's system-time hook with its marker in RTC
// no-init memory, which carries the time across a software reset or a deep-sleep wake.
#include <sys/time.h>

#include <cinttypes>
#include <cstdint>

#include "driver/gpio.h"
#include "driver/rtc_io.h"
#include "esp_log.h"
#include "esp_attr.h"
#include "esp_sleep.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "fr/core.hpp"
#include "fr/hal/sleep.hpp"
#include "fr/wall_clock.hpp"
#include "nvs.h"
#include "soc/soc_caps.h"

namespace fr::core {
namespace {

constexpr const char *TAG = "fr_power";
constexpr const char *kNs = "fr_core";
constexpr const char *kKeyOffline = "offline";
constexpr uint32_t kTimeMagic = 0x54494D45;  // "TIME"

/** The wall clock's source as of the last time taken: a software reset or a deep-sleep wake carries the time. */
struct TimeMarker {
    uint32_t magic;
    uint8_t source;
};
RTC_NOINIT_ATTR TimeMarker s_marker;

bool s_offline = false;
bool s_offline_read = false;

bool read_offline()
{
    nvs_handle_t h;
    uint8_t v = 0;
    if (nvs_open(kNs, NVS_READONLY, &h) == ESP_OK) {
        (void)nvs_get_u8(h, kKeyOffline, &v);
        nvs_close(h);
    }
    return v != 0;
}

bool cold_boot()
{
    const esp_reset_reason_t r = esp_reset_reason();
    return r == ESP_RST_POWERON || r == ESP_RST_BROWNOUT || r == ESP_RST_UNKNOWN;
}

class EspSleep final : public hal::Sleep
{
public:
    hal::WakeCause wake_cause() const override
    {
        if (esp_reset_reason() == ESP_RST_DEEPSLEEP) {
            const uint32_t causes = esp_sleep_get_wakeup_causes();
            if ((causes & (1u << ESP_SLEEP_WAKEUP_EXT1)) != 0) {
                return hal::WakeCause::pin;
            }
            return hal::WakeCause::timer;
        }
        return cold_boot() ? hal::WakeCause::power_on : hal::WakeCause::reset;
    }
    uint64_t wake_pins() const override
    {
        return esp_reset_reason() == ESP_RST_DEEPSLEEP ? esp_sleep_get_ext1_wakeup_status() : 0;
    }
    bool offline() const override { return fr::core::offline(); }
    Status set_offline(bool on) override
    {
        // Once, right before a restart: a direct write on the core task (not fr_worker) so it lands before it.
        nvs_handle_t h;
        if (nvs_open(kNs, NVS_READWRITE, &h) != ESP_OK) {
            return std::unexpected(Err::failed);
        }
        esp_err_t err = nvs_set_u8(h, kKeyOffline, on ? 1 : 0);
        if (err == ESP_OK) {
            err = nvs_commit(h);
        }
        nvs_close(h);
        ESP_LOGI(TAG, "power save %s from the next boot", on ? "on (offline)" : "off");
        return err == ESP_OK ? Status{} : std::unexpected(Err::failed);
    }
    void restart(bool sleeping) override { restart_soon(sleeping); }
    void deep_sleep(uint64_t after_us, uint64_t wake_low, uint64_t hold) override
    {
        for (int pin = 0; pin < 64; ++pin) {
            if ((hold >> pin & 1u) != 0) {
                (void)gpio_hold_en(static_cast<gpio_num_t>(pin));
            }
            if ((wake_low >> pin & 1u) != 0) {
                // A button to GND needs its pull-up while asleep (the DS3231's SQW has the module's own).
                (void)rtc_gpio_pullup_en(static_cast<gpio_num_t>(pin));
                (void)rtc_gpio_pulldown_dis(static_cast<gpio_num_t>(pin));
            }
        }
        if (wake_low != 0) {
            (void)esp_sleep_enable_ext1_wakeup_io(wake_low, ESP_EXT1_WAKEUP_ANY_LOW);
        }
        if (after_us != 0) {
            (void)esp_sleep_enable_timer_wakeup(after_us);
        }
        ESP_LOGI(TAG, "deep sleep: timer %" PRIu64 " ms, wake pins 0x%" PRIx64 ", held 0x%" PRIx64, after_us / 1000,
                 wake_low, hold);
        esp_deep_sleep_start();
    }
    bool pin_low(int gpio) const override { return gpio_get_level(static_cast<gpio_num_t>(gpio)) == 0; }
};

EspSleep s_sleep;

}  // namespace

hal::Sleep &sleep()
{
    return s_sleep;
}

bool offline()
{
    if (!s_offline_read) {
        s_offline = read_offline();
        s_offline_read = true;
    }
    return s_offline;
}

void power_boot()
{
    if (esp_reset_reason() == ESP_RST_DEEPSLEEP) {
        // The pins power save held (the panel's lines) are released before any driver sets them up.
        for (int pin = 0; pin < SOC_GPIO_PIN_COUNT; ++pin) {
            if (GPIO_IS_VALID_OUTPUT_GPIO(pin)) {
                (void)gpio_hold_dis(static_cast<gpio_num_t>(pin));
            }
        }
    }
    if (offline()) {
        ESP_LOGI(TAG, "power save: an offline boot (no Wi-Fi, ESP-NOW or hub link)");
    }
    // D1: the wall clock sets the system clock; a time taken survives a software reset or a deep sleep (not a power cut).
    wall_clock().set_hook([](TimeUs at, int64_t unix_us, TimeSource src) {
        const int64_t now_us = unix_us + (esp_timer_get_time() - at);
        timeval tv{};
        tv.tv_sec = static_cast<time_t>(now_us / 1'000'000);
        tv.tv_usec = static_cast<suseconds_t>(now_us % 1'000'000);
        settimeofday(&tv, nullptr);
        const bool changed = s_marker.magic != kTimeMagic || s_marker.source != static_cast<uint8_t>(src);
        s_marker = {kTimeMagic, static_cast<uint8_t>(src)};
        if (changed) {
            ESP_LOGI(TAG, "time from %s: %" PRId64, time_source_name(src), now_us / 1'000'000);
        }
    });
    if (!cold_boot() && s_marker.magic == kTimeMagic && s_marker.source >= static_cast<uint8_t>(TimeSource::rtc)) {
        timeval tv{};
        gettimeofday(&tv, nullptr);
        const int64_t unix_us = static_cast<int64_t>(tv.tv_sec) * 1'000'000 + tv.tv_usec;
        wall_clock().set(esp_timer_get_time(), unix_us, TimeSource::carried);
    } else if (cold_boot()) {
        s_marker.magic = 0;
    }
}

}  // namespace fr::core
