// The stepper's microstep table and electrical index (design stepper-s1 D8, §10.1): the quarter sine against std::sin,
// the unfolded cycle's symmetry and constant magnitude, each step mode's indexes, invert and negative positions.
#include <cmath>
#include <cstdint>
#include <numbers>
#include <set>

#include "fr/motion/phase_table.hpp"
#include "fr/motion/step_engine.hpp"
#include "tests/test.hpp"

namespace m = fr::motion;

namespace {

constexpr m::PhaseTable kTable;

int32_t ideal_q15(double radians)
{
    return static_cast<int32_t>(std::lround(32767.0 * std::sin(radians)));
}

}  // namespace

TEST(stepper_phase_quarter_sine_matches_std_sin)
{
    // The design's pinned list, and each value within 1 LSB of round(32767 sin(k pi / 64)).
    const int16_t pinned[33] = {0,     1608,  3212,  4808,  6393,  7962,  9512,  11039, 12539, 14010, 15446,
                                16846, 18204, 19519, 20787, 22005, 23170, 24279, 25329, 26319, 27245, 28105,
                                28898, 29621, 30273, 30852, 31356, 31785, 32137, 32412, 32609, 32728, 32767};
    for (int k = 0; k <= 32; ++k) {
        CHECK_EQ(m::kQuarterSineQ15[k], pinned[k]);
        CHECK(std::abs(m::kQuarterSineQ15[k] - ideal_q15(k * std::numbers::pi / 64.0)) <= 1);
    }
    static_assert(m::kQuarterSineQ15[32] == m::kQ15Full);
    static_assert(kTable.at(0) == m::Vector{32767, 0});
}

TEST(stepper_phase_cycle_is_the_sine_by_symmetry)
{
    for (int e = 0; e < 128; ++e) {
        const m::Vector v = kTable.at(static_cast<uint8_t>(e));
        const double th = e * std::numbers::pi / 64.0;
        CHECK(std::abs(v.a - ideal_q15(th + std::numbers::pi / 2)) <= 1);
        CHECK(std::abs(v.b - ideal_q15(th)) <= 1);
        // cos(e) = sin(e + 32); half a cycle on is the negation; the index is taken modulo 128.
        CHECK_EQ(v.a, kTable.at(static_cast<uint8_t>(e + 32)).b);
        CHECK_EQ(kTable.at(static_cast<uint8_t>(e + 64)).a, -v.a);
        CHECK_EQ(kTable.at(static_cast<uint8_t>(e + 64)).b, -v.b);
        CHECK(kTable.at(static_cast<uint8_t>(e + 128)) == v);
        // Quadrant signs: the sine is >= 0 in the first half cycle and <= 0 in the second.
        CHECK(e < 64 ? v.b >= 0 : v.b <= 0);
        CHECK((e < 32 || e > 96) ? v.a >= 0 : v.a <= 0);
        // The vector's magnitude is constant within 0.1 %.
        const double mag = std::hypot(static_cast<double>(v.a), static_cast<double>(v.b));
        CHECK(std::abs(mag - 32767.0) <= 32767.0 * 0.001);
    }
    // The engine reads its own DRAM copy of the same table.
    const m::StepEngine engine;
    for (int e = 0; e < 128; ++e) {
        CHECK(engine.vector(static_cast<uint8_t>(e)) == kTable.at(static_cast<uint8_t>(e)));
    }
}

TEST(stepper_phase_step_modes_take_their_indexes)
{
    // Full steps are wave drive: one coil at a time, at full amplitude.
    std::set<int> full;
    for (int32_t p = -8; p < 8; ++p) {
        const uint8_t e = m::electrical_index(p, 0, false);
        full.insert(e);
        const m::Vector v = kTable.at(e);
        CHECK((v.a == 0) != (v.b == 0));
        CHECK_EQ(std::abs(v.a) + std::abs(v.b), 32767);
    }
    CHECK(full == std::set<int>({0, 32, 64, 96}));
    CHECK_EQ(m::electrical_index(1, 0, false), 32);
    CHECK_EQ(m::electrical_index(2, 0, false), 64);
    CHECK_EQ(m::electrical_index(3, 0, false), 96);
    // Half steps alternate one coil and both at 0.707.
    for (int32_t p = 0; p < 16; ++p) {
        const m::Vector v = kTable.at(m::electrical_index(p, 1, false));
        if (p % 2 == 0) {
            CHECK((v.a == 0) != (v.b == 0));
        } else {
            CHECK_EQ(std::abs(v.a), 23170);
            CHECK_EQ(std::abs(v.b), 23170);
        }
    }
    // Every mode: consecutive positions are 32 / m indexes apart, 4 m steps make one electrical cycle, and full steps
    // are a subset of every finer mode (position p in full steps is position p m in microsteps).
    for (uint8_t log2 = 0; log2 <= m::kMaxMicrostepsLog2; ++log2) {
        const int32_t per_full = 1 << log2;
        const int32_t stride = 32 >> log2;
        std::set<int> seen;
        for (int32_t p = 0; p < 4 * per_full; ++p) {
            const uint8_t e = m::electrical_index(p, log2, false);
            CHECK_EQ(e, (p * stride) % 128);
            seen.insert(e);
        }
        CHECK_EQ(seen.size(), static_cast<size_t>(4 * per_full));
        CHECK_EQ(m::electrical_index(4 * per_full, log2, false), 0);
        for (int32_t f = -5; f <= 5; ++f) {
            CHECK_EQ(m::electrical_index(f * per_full, log2, false), m::electrical_index(f, 0, false));
        }
    }
}

TEST(stepper_phase_invert_and_negative_positions)
{
    for (uint8_t log2 = 0; log2 <= m::kMaxMicrostepsLog2; ++log2) {
        const int stride = 32 >> log2;
        // e(-1) = 128 - 32 / m: negatives wrap like positives.
        CHECK_EQ(m::electrical_index(-1, log2, false), 128 - stride);
        for (int32_t p = -300; p <= 300; ++p) {
            const uint8_t e = m::electrical_index(p, log2, false);
            CHECK_EQ(e, static_cast<int>(((static_cast<int64_t>(p) * stride) % 128 + 128) % 128));
            // invert mirrors the sequence: position p turns as -p would.
            CHECK_EQ(m::electrical_index(p, log2, true), m::electrical_index(-p, log2, false));
            CHECK_EQ((m::electrical_index(p, log2, true) + e) % 128, 0);
        }
        // The range's ends (D6): exact, with no signed overflow (UBSan) in the product or the negation.
        for (int32_t p : {-1'000'000'000, -999'999'999, 999'999'999, 1'000'000'000, INT32_MIN, INT32_MAX}) {
            const int64_t want = ((static_cast<int64_t>(p) * stride) % 128 + 128) % 128;
            CHECK_EQ(m::electrical_index(p, log2, false), want);
            CHECK_EQ(m::electrical_index(p, log2, true), (128 - want) % 128);
        }
    }
}
