// fr:realtime
// The DRV8833's inputs for a coil vector (design stepper-s1 D8): slow decay by PWM on all four inputs, so a coil's
// average voltage is c/full of VM and microsteps follow the sine evenly without current sensing. IDF-free and
// header-only: drv8833_stepper's step ISR maps every step through it, and the host suite tests it as it is.
//
//   amplitude c   xIN1 duty    xIN2 duty    the coil sees
//   c > 0         full         full - c     +VM for c/full of each period, shorted (brake) otherwise
//   c < 0         full - |c|   full         -VM for |c|/full, shorted otherwise
//   c = 0         full         full         shorted (brake): the drive stays continuous through zero
//   released      0            0            open (coast); the driver also puts the bridge to sleep
//
// Duty `full` (2^11) holds an input high for the whole period. The chip's own dead time means no input combination
// can short the supply, so a write that lands mid-period is harmless.
#pragma once

#include <cstdint>

#include "fr/motion/phase_table.hpp"

namespace fr::drv::drv8833 {

/** LEDC duty resolution: 11 bits, 2,048 counts at 25 kHz from an 80 MHz clock (a divider of 1.5625). */
inline constexpr uint8_t kPwmBits = 11;
/** Full duty: steady high. */
inline constexpr uint16_t kFull = uint16_t{1} << kPwmBits;

/** The four inputs' duties in LEDC counts, in channel order: AIN1, AIN2, BIN1, BIN2. */
struct Duties {
    uint16_t in[4] = {};

    friend constexpr bool operator==(const Duties &, const Duties &) = default;
};

/**
 * The peak amplitude in counts for `permille` of full duty (above 1,000 is 1,000). Rounded down: every error in the
 * power settings leans to less current (design stepper-s1 D10).
 */
FR_MOTION_ISR constexpr uint16_t peak(uint16_t permille)
{
    const uint32_t p = permille < 1000 ? permille : 1000;
    return static_cast<uint16_t>(p * kFull / 1000);
}

/**
 * A coil's signed amplitude in counts for its Q15 value `q` at `peak` counts: peak x |q| / 2^15, rounded to the
 * nearest. 2,048 x 32,767 + 2^14 fits a u32, and the largest result is 2,048 (full), never more.
 */
FR_MOTION_ISR constexpr int16_t amplitude(uint16_t peak, int16_t q)
{
    const uint32_t mag = q < 0 ? static_cast<uint32_t>(-int32_t{q}) : static_cast<uint32_t>(q);
    const auto c = static_cast<int16_t>((uint32_t{peak} * mag + (uint32_t{1} << 14)) >> 15);
    return q < 0 ? static_cast<int16_t>(-c) : c;
}

/** One coil's two inputs (xIN1, xIN2) for amplitude `c`, slow decay; |c| is at most kFull. */
FR_MOTION_ISR constexpr void coil(int16_t c, uint16_t &in1, uint16_t &in2)
{
    if (c >= 0) {
        in1 = kFull;
        in2 = static_cast<uint16_t>(kFull - c);
    } else {
        in1 = static_cast<uint16_t>(kFull + c);
        in2 = kFull;
    }
}

/** The four duties that drive vector `v` (coil A = v.a, coil B = v.b) at `peak` counts. */
FR_MOTION_ISR constexpr Duties drive(motion::Vector v, uint16_t peak)
{
    Duties d;
    coil(amplitude(peak, v.a), d.in[0], d.in[1]);
    coil(amplitude(peak, v.b), d.in[2], d.in[3]);
    return d;
}

/** Released: every input low, both coils open (coast). */
inline constexpr Duties kCoast{};

}  // namespace fr::drv::drv8833
