// fr:realtime
// haptic_sdm (design haptic-h1 D4): see include/fr/drv/haptic_sdm.hpp.
#include "fr/drv/haptic_sdm.hpp"

#include <algorithm>
#include <cstdio>

#include "driver/gpio.h"
#include "driver/sdm.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "fr/platform/safe_off.hpp"
#include "hal/gpio_ll.h"
#include "soc/gpio_sig_map.h"

namespace fr::drv {
namespace {

constexpr const char *TAG = "haptic_sdm";

// Every instance's pad, for the restart and panic hooks (as haptic_ledc's, design power-p1 review B1): a CPU reset
// keeps the modulator running and the GPIO matrix routing it, so the motor would run through the panic handler and the
// boot until init. Constant-initialized; -1 = free.
constexpr int kMaxPins = 8;  // sigma-delta channels on any target (4 on the C3/C5/C6, 8 on the S3)
int8_t s_pins[kMaxPins] = {-1, -1, -1, -1, -1, -1, -1, -1};
bool s_hooked = false;

/** One pad on the GPIO output register, driven low, off the modulator: register writes only, no lock, IRAM. */
IRAM_ATTR void pad_low(int pin)
{
    gpio_ll_set_level(&GPIO, pin, 0);
    gpio_ll_output_enable(&GPIO, pin);
    gpio_ll_set_output_enable_ctrl(&GPIO, pin, false, false);
    gpio_ll_set_output_signal_matrix_source(&GPIO, pin, SIG_GPIO_OUT_IDX, false);
}

IRAM_ATTR void all_pads_low()
{
    for (int i = 0; i < kMaxPins; ++i) {
        if (s_pins[i] >= 0) {
            pad_low(s_pins[i]);
        }
    }
}

}  // namespace

Status HapticSdm::init(Core &)
{
    if (!GPIO_IS_VALID_OUTPUT_GPIO(cfg_.out)) {
        return std::unexpected(Err::invalid_args);
    }
    const auto pin = static_cast<gpio_num_t>(cfg_.out);
    // Low on the pad before the modulator takes it: the motor never runs at boot.
    gpio_set_level(pin, 0);
    gpio_config_t io = {};
    io.pin_bit_mask = 1ULL << cfg_.out;
    io.mode = GPIO_MODE_INPUT_OUTPUT;  // the input too, so selftest reads the pad back
    io.pull_up_en = GPIO_PULLUP_DISABLE;
    io.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io.intr_type = GPIO_INTR_DISABLE;
    if (gpio_config(&io) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    // The hooks before the modulator can ever drive the pad: none left means this motor never runs.
    if (!s_hooked) {
        if (!platform::register_safe_off(&all_pads_low, &all_pads_low)) {
            ESP_LOGE(TAG, "GPIO%u: no restart hook slot left; the output stays off", unsigned{cfg_.out});
            return std::unexpected(Err::failed);
        }
        s_hooked = true;
    }
    int slot = -1;
    for (int i = 0; i < kMaxPins && slot < 0; ++i) {
        if (s_pins[i] < 0) {
            slot = i;
        }
    }
    if (slot < 0) {
        return std::unexpected(Err::invalid_args);
    }
    sdm_config_t c = {};
    c.gpio_num = pin;
    c.clk_src = SDM_CLK_SRC_DEFAULT;
    c.sample_rate_hz = cfg_.rate_hz;
    sdm_channel_handle_t chan = nullptr;
    // From here the pad is the hooks' too: sdm_new_channel routes the modulator to it.
    s_pins[slot] = static_cast<int8_t>(cfg_.out);
    if (const esp_err_t e = sdm_new_channel(&c, &chan); e != ESP_OK) {
        pad_low(cfg_.out);
        s_pins[slot] = -1;
        ESP_LOGE(TAG, "GPIO%u: no sigma-delta channel at %lu Hz (%s)", unsigned{cfg_.out},
                 static_cast<unsigned long>(cfg_.rate_hz), esp_err_to_name(e));
        return std::unexpected(Err::failed);
    }
    // The channel's signal, read back from the matrix, then the pad straight back to low: the new channel's density is
    // 0 (half on) until set, and it must not reach the gate.
    gpio_io_config_t now = {};
    gpio_ll_get_io_config(&GPIO, cfg_.out, &now);
    signal_ = now.sig_out;
    pad_low(cfg_.out);
    if (sdm_channel_set_pulse_density(chan, -128) != ESP_OK || sdm_channel_enable(chan) != ESP_OK) {
        (void)sdm_del_channel(chan);
        pad_low(cfg_.out);
        s_pins[slot] = -1;
        return std::unexpected(Err::failed);
    }
    chan_ = chan;
    duty_ = 0;
    ready_ = true;
    ESP_LOGI(TAG, "GPIO%u on a sigma-delta channel (signal %lu), %lu Hz", unsigned{cfg_.out},
             static_cast<unsigned long>(signal_), static_cast<unsigned long>(cfg_.rate_hz));
    return {};
}

Status HapticSdm::write(uint16_t duty_permille)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    const uint16_t d = std::min<uint16_t>(duty_permille, 1000);
    if (d == 0) {
        pad_low(cfg_.out);  // off is the GPIO register, not a density
        duty_ = 0;
        return {};
    }
    if (sdm_channel_set_pulse_density(static_cast<sdm_channel_handle_t>(chan_), density_of(d)) != ESP_OK) {
        pad_low(cfg_.out);
        duty_ = 0;
        return std::unexpected(Err::failed);
    }
    if (duty_ == 0) {
        gpio_ll_set_output_signal_matrix_source(&GPIO, cfg_.out, signal_, false);
    }
    duty_ = d;
    return {};
}

hal::Selftest HapticSdm::selftest()
{
    if (!ready_) {
        return {false, "not initialized"};
    }
    // Never switched for a test: idle must read low.
    if (duty_ == 0) {
        const bool low = gpio_get_level(static_cast<gpio_num_t>(cfg_.out)) == 0;
        std::snprintf(detail_, sizeof(detail_), "sigma-delta idle, pad reads %s", low ? "low" : "HIGH");
        return {low, detail_};
    }
    std::snprintf(detail_, sizeof(detail_), "sigma-delta running at %u permille", unsigned{duty_});
    return {true, detail_};
}

}  // namespace fr::drv
