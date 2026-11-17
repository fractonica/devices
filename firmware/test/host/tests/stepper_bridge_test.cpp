// drv8833_stepper's duty mapping (design stepper-s1 D8, §10.3): the slow-decay table for positive, negative and zero
// amplitudes and release, the peak from permille, the amplitude's rounding, no duty above full, and the pin duties of
// full-step (wave) and half-step vectors.
#include <cmath>
#include <cstdint>
#include <cstdlib>

#include "fr/drv/drv8833_bridge.hpp"
#include "fr/motion/phase_table.hpp"
#include "tests/test.hpp"

namespace br = fr::drv::drv8833;
namespace m = fr::motion;

namespace {

constexpr uint16_t kFull = br::kFull;
constexpr m::PhaseTable kTable;

br::Duties duties(uint16_t a1, uint16_t a2, uint16_t b1, uint16_t b2)
{
    br::Duties d;
    d.in[0] = a1;
    d.in[1] = a2;
    d.in[2] = b1;
    d.in[3] = b2;
    return d;
}

}  // namespace

TEST(stepper_bridge_slow_decay_table)
{
    static_assert(kFull == 2048);
    // c > 0: xIN1 steady high, xIN2 low for c of each period (+VM for c/full, braked otherwise).
    CHECK(br::drive(m::Vector{32767, 0}, kFull) == duties(kFull, 0, kFull, kFull));
    CHECK(br::drive(m::Vector{32767, 0}, 409) == duties(kFull, kFull - 409, kFull, kFull));
    // c < 0: the mirror, xIN2 steady high.
    CHECK(br::drive(m::Vector{-32767, 0}, 409) == duties(kFull - 409, kFull, kFull, kFull));
    CHECK(br::drive(m::Vector{0, -32767}, kFull) == duties(kFull, kFull, 0, kFull));
    // c = 0: both high, the coil shorted (brake), never open.
    CHECK(br::drive(m::Vector{0, 0}, 1000) == duties(kFull, kFull, kFull, kFull));
    CHECK(br::drive(m::Vector{32767, 32767}, 0) == duties(kFull, kFull, kFull, kFull));
    // Released: every input low (coast).
    CHECK(br::kCoast == duties(0, 0, 0, 0));
    static_assert(br::drive(m::Vector{32767, -32767}, kFull) == br::Duties{{kFull, 0, 0, kFull}});
}

TEST(stepper_bridge_peak_from_permille)
{
    CHECK_EQ(br::peak(0), 0);
    CHECK_EQ(br::peak(1), 2);       // 2.048, rounded down
    CHECK_EQ(br::peak(200), 409);   // 409.6: the defaults' 20 %, rounded down (less current is the safe side)
    CHECK_EQ(br::peak(1000), kFull);
    CHECK_EQ(br::peak(1001), kFull);  // never above full
    CHECK_EQ(br::peak(UINT16_MAX), kFull);
    for (uint32_t p = 0; p <= 1000; ++p) {
        const double exact = p * 2048.0 / 1000.0;
        const uint16_t got = br::peak(static_cast<uint16_t>(p));
        CHECK(got <= exact && exact - got < 1.0);
    }
}

TEST(stepper_bridge_amplitude_rounds_within_one_lsb)
{
    for (uint32_t peak = 0; peak <= kFull; peak += (peak < 64 ? 1 : 37)) {
        for (int32_t q = -32767; q <= 32767; q += 97) {
            const int16_t c = br::amplitude(static_cast<uint16_t>(peak), static_cast<int16_t>(q));
            // The nearest of peak x q / 2^15 (ties away from zero), so within 1 LSB of peak x q / 32767 as well.
            const double q15 = static_cast<double>(peak) * q / 32768.0;
            CHECK(std::abs(c - q15) <= 0.5);
            CHECK(std::abs(c - static_cast<double>(peak) * q / 32767.0) <= 1.0);
            CHECK_EQ(br::amplitude(static_cast<uint16_t>(peak), static_cast<int16_t>(-q)), -c);  // odd symmetry
        }
    }
    CHECK_EQ(br::amplitude(kFull, 32767), kFull);  // full scale is full duty, not one step short
    CHECK_EQ(br::amplitude(kFull, -32767), -kFull);
    CHECK_EQ(br::amplitude(1, 16384), 1);  // 0.5 rounds away from zero
    CHECK_EQ(br::amplitude(1, 16383), 0);
}

TEST(stepper_bridge_no_duty_above_full_and_net_drive_is_the_amplitude)
{
    for (uint32_t permille = 0; permille <= 1000; permille += 7) {
        const uint16_t peak = br::peak(static_cast<uint16_t>(permille));
        for (int e = 0; e < m::kPhaseIndexes; ++e) {
            const m::Vector v = kTable.at(static_cast<uint8_t>(e));
            const br::Duties d = br::drive(v, peak);
            for (const uint16_t in : d.in) {
                CHECK(in <= kFull);
            }
            // Slow decay: one input of each coil is always steady high, and the other's shortfall is the amplitude,
            // so the coil's average voltage is (xIN1 - xIN2) / full of VM.
            CHECK(d.in[0] == kFull || d.in[1] == kFull);
            CHECK(d.in[2] == kFull || d.in[3] == kFull);
            CHECK_EQ(d.in[0] - d.in[1], br::amplitude(peak, v.a));
            CHECK_EQ(d.in[2] - d.in[3], br::amplitude(peak, v.b));
        }
    }
}

TEST(stepper_bridge_full_and_half_step_vectors)
{
    const uint16_t peak = br::peak(200);  // 409
    const auto low = static_cast<uint16_t>(kFull - peak);
    // Full steps are wave drive, one coil at a time at the peak: A+, B+, A-, B- for positions 0..3 (and on round).
    const br::Duties wave[4] = {
        duties(kFull, low, kFull, kFull),
        duties(kFull, kFull, kFull, low),
        duties(low, kFull, kFull, kFull),
        duties(kFull, kFull, low, kFull),
    };
    for (int32_t p = -8; p <= 8; ++p) {
        const uint8_t e = m::electrical_index(p, 0, false);
        CHECK(br::drive(kTable.at(e), peak) == wave[((p % 4) + 4) % 4]);
    }
    // Half steps alternate one coil at the peak and both at 0.707 of it.
    const auto diag = static_cast<uint16_t>(std::lround(peak * 23170.0 / 32768.0));
    CHECK_EQ(diag, 289);
    const br::Duties half[8] = {
        wave[0],
        duties(kFull, kFull - diag, kFull, kFull - diag),
        wave[1],
        duties(kFull - diag, kFull, kFull, kFull - diag),
        wave[2],
        duties(kFull - diag, kFull, kFull - diag, kFull),
        wave[3],
        duties(kFull, kFull - diag, kFull - diag, kFull),
    };
    for (int32_t p = -16; p <= 16; ++p) {
        const uint8_t e = m::electrical_index(p, 1, false);
        CHECK(br::drive(kTable.at(e), peak) == half[((p % 8) + 8) % 8]);
    }
    // invert runs the same sequence the other way.
    for (int32_t p = 0; p < 8; ++p) {
        const uint8_t e = m::electrical_index(p, 1, true);
        CHECK(br::drive(kTable.at(e), peak) == half[(8 - p) % 8]);
    }
}
