// fr:realtime
// ledc_buzzer (design buzzer-b1 D4): see include/fr/drv/ledc_buzzer.hpp.
#include "fr/drv/ledc_buzzer.hpp"

#include <algorithm>
#include <cstdio>

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "fr/platform/safe_off.hpp"
#include "hal/gpio_ll.h"
#include "soc/gpio_sig_map.h"

namespace fr::drv {
namespace {

constexpr const char *TAG = "ledc_buzzer";
// LEDC low-speed timer 2 and the channel one below the top (driver.yaml: clear of drv8833_stepper, dvp_camera,
// st7789_spi, fixture_gpio and one haptic_ledc frequency). Codegen counts both against the board's LEDC budget.
constexpr ledc_mode_t kMode = LEDC_LOW_SPEED_MODE;
constexpr ledc_timer_t kTimer = LEDC_TIMER_2;
constexpr ledc_channel_t kChannel = static_cast<ledc_channel_t>(LEDC_CHANNEL_MAX - 2);
constexpr uint32_t kFull = 1U << LedcBuzzer::kBits;
static_assert(LEDC_CHANNEL_MAX >= 6, "one channel below the top, clear of the stepper's 0-3");

// The pad and its idle level for the restart and panic hooks (a CPU reset keeps LEDC running and the GPIO matrix
// routing it, so the tone would last through the panic handler, the coredump and the boot until init).
// Constant-initialized; -1 = none. One instance per firmware.
int8_t s_pin = -1;
bool s_idle_high = false;
bool s_taken = false;

/** The pad back on the GPIO output register at its idle level, off the LEDC signal: register writes only, IRAM. */
IRAM_ATTR void pad_idle()
{
    const int8_t pin = s_pin;
    if (pin < 0) {
        return;
    }
    gpio_ll_set_level(&GPIO, pin, s_idle_high ? 1 : 0);
    gpio_ll_output_enable(&GPIO, pin);
    gpio_ll_set_output_enable_ctrl(&GPIO, pin, false, false);
    gpio_ll_set_output_signal_matrix_source(&GPIO, pin, SIG_GPIO_OUT_IDX, false);
}

/** Duty steps for permille, capped at a 50 % square. */
uint32_t steps_of(uint16_t permille)
{
    return (static_cast<uint32_t>(std::min<uint16_t>(permille, 500)) * kFull + 500) / 1000;
}

}  // namespace

Status LedcBuzzer::init(Core &)
{
    if (s_taken) {
        ESP_LOGE(TAG, "a second ledc_buzzer: one per firmware (LEDC timer 2)");
        return std::unexpected(Err::busy);
    }
    if (!GPIO_IS_VALID_OUTPUT_GPIO(cfg_.out)) {
        return std::unexpected(Err::invalid_args);
    }
    const auto pin = static_cast<gpio_num_t>(cfg_.out);
    // The idle level on the pad before LEDC takes it: silent from here on.
    gpio_set_level(pin, cfg_.active_low ? 1 : 0);
    gpio_config_t io = {};
    io.pin_bit_mask = 1ULL << cfg_.out;
    io.mode = GPIO_MODE_OUTPUT;
    io.pull_up_en = GPIO_PULLUP_DISABLE;
    io.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io.intr_type = GPIO_INTR_DISABLE;
    if (gpio_config(&io) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    s_taken = true;
    s_pin = static_cast<int8_t>(cfg_.out);
    s_idle_high = cfg_.active_low;
    // The hooks before LEDC can ever drive the pad: none left means this buzzer stays silent.
    if (!platform::register_safe_off(&pad_idle, &pad_idle)) {
        ESP_LOGE(TAG, "GPIO%u: no restart hook slot left; the buzzer stays silent", unsigned{cfg_.out});
        return std::unexpected(Err::failed);
    }
    ledc_timer_config_t t = {};
    t.speed_mode = kMode;
    t.duty_resolution = static_cast<ledc_timer_bit_t>(kBits);
    t.timer_num = kTimer;
    t.freq_hz = kInitHz;
    t.clk_cfg = LEDC_AUTO_CLK;  // the 80 MHz source, first in the list: a divider of 78 for 1 kHz x 2^10
    if (ledc_timer_config(&t) != ESP_OK) {
        ESP_LOGE(TAG, "LEDC timer 2: %u Hz at %u bits refused", unsigned{kInitHz}, unsigned{kBits});
        return std::unexpected(Err::failed);
    }
    ledc_channel_config_t c = {};
    c.gpio_num = cfg_.out;
    c.speed_mode = kMode;
    c.channel = kChannel;
    c.timer_sel = kTimer;
    c.duty = 0;
    c.hpoint = 0;
    c.flags.output_invert = cfg_.active_low ? 1 : 0;  // duty 0 then rests high: the PNP module's idle
    if (ledc_channel_config(&c) != ESP_OK) {
        ESP_LOGE(TAG, "GPIO%u: LEDC channel %d refused", unsigned{cfg_.out}, int{kChannel});
        return std::unexpected(Err::failed);
    }
    // The pad's input too, so selftest reads it back.
    gpio_input_enable(pin);
    hz_ = kInitHz;
    duty_ = 0;
    ready_ = true;
    ESP_LOGI(TAG, "GPIO%u on LEDC channel %d (timer 2), %u bits, %s", unsigned{cfg_.out}, int{kChannel},
             unsigned{kBits}, cfg_.active_low ? "active low" : "active high");
    return {};
}

Status LedcBuzzer::play(uint16_t freq_hz, uint16_t duty_permille)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    if (freq_hz < kMinHz || freq_hz > kMaxHz) {
        return std::unexpected(Err::invalid_args);
    }
    if (freq_hz != hz_) {
        // The divider only: the source and the resolution stay, so the duty in steps keeps its share of the period.
        if (ledc_set_freq(kMode, kTimer, freq_hz) != ESP_OK) {
            return std::unexpected(Err::failed);
        }
        hz_ = freq_hz;
    }
    if (ledc_set_duty(kMode, kChannel, steps_of(duty_permille)) != ESP_OK || ledc_update_duty(kMode, kChannel) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    duty_ = std::min<uint16_t>(duty_permille, 500);
    return {};
}

Status LedcBuzzer::silence()
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    if (ledc_set_duty(kMode, kChannel, 0) != ESP_OK || ledc_update_duty(kMode, kChannel) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    duty_ = 0;
    return {};
}

hal::Selftest LedcBuzzer::selftest()
{
    if (!ready_) {
        return {false, "not initialized"};
    }
    if (duty_ == 0) {
        const int want = cfg_.active_low ? 1 : 0;
        const bool idle = gpio_get_level(static_cast<gpio_num_t>(cfg_.out)) == want;
        std::snprintf(detail_, sizeof(detail_), "LEDC channel %d silent, pad reads %s", int{kChannel},
                      idle ? "idle" : "NOT IDLE");
        return {idle, detail_};
    }
    std::snprintf(detail_, sizeof(detail_), "LEDC channel %d playing %u Hz at %u permille", int{kChannel},
                  unsigned{hz_}, unsigned{duty_});
    return {true, detail_};
}

}  // namespace fr::drv
