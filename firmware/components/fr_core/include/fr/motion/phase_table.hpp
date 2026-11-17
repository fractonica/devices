// fr:realtime
// The microstep table of a two-coil stepper (design stepper-s1 D8): a quarter sine in Q15, 33 entries (0 to 90 degrees
// electrical in 32 steps), unfolded by symmetry to 128 indexes per electrical cycle (four full steps). Coil A takes the
// cosine and coil B the sine, so full steps (indexes 0, 32, 64, 96) are wave drive, one coil at a time, and every index
// has the same vector magnitude: torque and heat do not depend on the step mode or the position.
// IDF-free and header-only: the host suite builds it as it is, and drivers map its vectors to their outputs.
#pragma once

#include <cstdint>

// Every function the step ISR reaches is marked FR_MOTION_ISR (design stepper-s1 D4): in IRAM on target, whichever
// translation unit's copy of an inline function the linker keeps, so steps go on while flash is busy.
#ifdef ESP_PLATFORM
#include "esp_attr.h"
#define FR_MOTION_ISR IRAM_ATTR
#else
#define FR_MOTION_ISR
#endif

namespace fr::motion {

/** Electrical indexes per cycle (four full steps of 32 each). */
inline constexpr uint8_t kPhaseIndexes = 128;
/** Indexes per full step (90 degrees electrical): the finest mode, micro32, steps one index at a time. */
inline constexpr uint8_t kFullStepIndexes = 32;
/** The finest step mode as microsteps_log2 (micro32). */
inline constexpr uint8_t kMaxMicrostepsLog2 = 5;
/** Full scale of a coil amplitude in Q15. */
inline constexpr int16_t kQ15Full = 32767;

/** round(32767 * sin(k * pi / 64)), k = 0..32: the source the engine copies into DRAM. */
inline constexpr int16_t kQuarterSineQ15[kFullStepIndexes + 1] = {
    0,     1608,  3212,  4808,  6393,  7962,  9512,  11039, 12539, 14010, 15446, 16846, 18204, 19519, 20787, 22005, 23170,
    24279, 25329, 26319, 27245, 28105, 28898, 29621, 30273, 30852, 31356, 31785, 32137, 32412, 32609, 32728, 32767,
};

/** The coils' signed amplitudes in Q15 at one electrical index: A = cos, B = sin. */
struct Vector {
    int16_t a = 0;
    int16_t b = 0;

    friend constexpr bool operator==(const Vector &, const Vector &) = default;
};

/**
 * The electrical index of `position` in steps of 1/2^microsteps_log2 of a full step, `invert` turning the other way.
 * The product is taken modulo 2^32, which 128 divides, so it is exact for every i32 position, negative ones included:
 * e(-1) = 128 - 32 / 2^microsteps_log2.
 */
FR_MOTION_ISR constexpr uint8_t electrical_index(int32_t position, uint8_t microsteps_log2, bool invert)
{
    const uint32_t p = invert ? 0u - static_cast<uint32_t>(position) : static_cast<uint32_t>(position);
    return static_cast<uint8_t>((p * (uint32_t{kFullStepIndexes} >> microsteps_log2)) & (kPhaseIndexes - 1u));
}

/**
 * The 33 quarter-sine values as an object: StepEngine holds one as a non-const member, so on target the table its ISR
 * reads is in DRAM (the static driver object's), never in flash .rodata.
 */
class PhaseTable
{
public:
    constexpr PhaseTable()
    {
        for (uint8_t k = 0; k <= kFullStepIndexes; ++k) {
            q_[k] = kQuarterSineQ15[k];
        }
    }

    /** The vector at electrical index `e` (taken modulo 128). */
    FR_MOTION_ISR constexpr Vector at(uint8_t e) const { return Vector{sine(static_cast<uint8_t>(e + 32u)), sine(e)}; }

private:
    // Branches, not a switch: a jump table would be compiler data in flash .rodata, out of the ISR's reach.
    FR_MOTION_ISR constexpr int16_t sine(uint8_t e) const
    {
        const uint8_t k = e & (kFullStepIndexes - 1u);
        const int16_t q = (e & 32u) != 0 ? q_[kFullStepIndexes - k] : q_[k];  // the second quadrant mirrors the first
        return (e & 64u) != 0 ? static_cast<int16_t>(-q) : q;                 // the second half cycle negates
    }

    int16_t q_[kFullStepIndexes + 1] = {};
};

}  // namespace fr::motion
