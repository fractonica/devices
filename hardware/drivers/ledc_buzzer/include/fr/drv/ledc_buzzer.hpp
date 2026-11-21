// ledc_buzzer (design buzzer-b1 D4; spec 07 §7.8): hal::ToneOutput on one GPIO, LEDC low-speed timer 2 and channel
// LEDC_CHANNEL_MAX - 2, a square wave at the note's pitch with a 10-bit duty. The pad is latched at its idle level
// before LEDC takes it, and restart and panic hooks put it back there (a CPU reset keeps LEDC running). BuzzerService
// writes from the core task; the driver has no task, timer or ISR.
#pragma once

#include <cstdint>

#include "fr/core/core.hpp"
#include "fr/hal/tone.hpp"

namespace fr::drv {

class LedcBuzzer final : public hal::ToneOutput
{
public:
    // Field order and defaults follow driver.yaml `config:`.
    struct Config {
        uint8_t out = 0;
        bool active_low = false;
    };

    explicit LedcBuzzer(const Config &cfg) : cfg_(cfg) {}

    Status init(Core &core) override;
    Status play(uint16_t freq_hz, uint16_t duty_permille) override;
    Status silence() override;
    bool pitched() const override { return true; }
    bool volume() const override { return true; }
    uint16_t min_hz() const override { return kMinHz; }
    uint16_t max_hz() const override { return kMaxHz; }
    hal::Selftest selftest() override;

    static constexpr uint8_t kBits = 10;
    static constexpr uint16_t kMinHz = 100;
    static constexpr uint16_t kMaxHz = 20000;
    /** The timer's frequency at init, before the first note (any pitch in range; duty 0 keeps it silent). */
    static constexpr uint16_t kInitHz = 1000;

private:
    Config cfg_;
    bool ready_ = false;
    uint16_t hz_ = 0;    // the timer's frequency
    uint16_t duty_ = 0;  // permille; 0 = silent
    char detail_[96] = {};
};

}  // namespace fr::drv
