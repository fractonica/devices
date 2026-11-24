// haptic_sdm (design haptic-h1 D4; spec 07 §7.8): hal::HapticOutput on one GPIO through a sigma-delta modulator
// channel: a pulse-density stream (256 levels) at rate_hz (312.5 kHz) that a vibration motor averages like PWM. Off is
// not a density: at 0 the pad goes back to the GPIO output register, driven low. The pad is latched low before the
// channel exists, so the motor never starts at boot. HapticService writes the duty from the core task; the driver has
// no task or timer.
#pragma once

#include <cstdint>

#include "fr/core/core.hpp"
#include "fr/hal/power_cell.hpp"

namespace fr::drv {

class HapticSdm final : public hal::HapticOutput
{
public:
    // Field order and defaults follow driver.yaml `config:`.
    struct Config {
        uint8_t out = 0;
        uint32_t rate_hz = 312500;
    };

    explicit HapticSdm(const Config &cfg) : cfg_(cfg) {}

    Status init(Core &core) override;
    bool pwm() const override { return true; }
    Status write(uint16_t duty_permille) override;
    hal::Selftest selftest() override;

    /** A duty (permille, 1..1000) as the modulator's density (-128..127): (density + 128) / 256 of the time high. */
    static constexpr int8_t density_of(uint16_t permille)
    {
        const uint32_t p = permille > 1000 ? 1000 : permille;
        return static_cast<int8_t>(static_cast<int32_t>(p * 255 / 1000) - 128);
    }

private:
    Config cfg_;
    bool ready_ = false;
    void *chan_ = nullptr;     // sdm_channel_handle_t
    uint32_t signal_ = 0;      // the modulator's GPIO-matrix output signal, read back once the channel exists
    uint16_t duty_ = 0;        // permille
    char detail_[96] = {};
};

static_assert(HapticSdm::density_of(1) == -128);
static_assert(HapticSdm::density_of(500) == -1);
static_assert(HapticSdm::density_of(1000) == 127);  // 255/256: never quite full on, which a motor does not notice
static_assert(HapticSdm::density_of(2000) == 127);

}  // namespace fr::drv
