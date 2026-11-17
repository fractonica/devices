// fr:realtime
// A trapezoid speed profile planned one step at a time on v^2 (design stepper-s1 D5, D6). At each step boundary the
// planner decides the speed at the end of the coming step from the speed now, the distance left and the limits: one
// step at constant acceleration a changes v^2 by exactly 2a, so the profile is exact in integers, and retargeting,
// reversal and stops all fall out of the same few lines. step_us() then gives the coming step's duration as the exact
// time of the ideal motion over that one step.
// Pure, integer, heap-free: 32-bit add, multiply and divide, u32 x u32 -> u64 multiplies, 64-bit shifts and compares
// (all inline on RV32IMC), and no 64-bit division, which would be a libgcc call that may sit in flash.
#pragma once

#include <cstdint>

#include "fr/motion/phase_table.hpp"

namespace fr::motion {

/** Positions, targets and bounds stay within +-1e9 (D6), so every distance fits an i64 and every product a u64. */
inline constexpr int32_t kPositionLimit = 1'000'000'000;
/** Steps a second: v^2 <= 1e8, and with 2a <= 400,000, v^2 + 2a < 2^32. */
inline constexpr uint32_t kMaxSpeed = 10'000;
inline constexpr uint32_t kMaxAccel = 200'000;
/** A step alarm later than this: the rotor has stood at its last vector, so the ramp restarts from rest (a slip). */
inline constexpr uint32_t kSlipLateUs = 2'000;

/** Why a motion came to rest (Snapshot::last_rest). */
enum class Rest : uint8_t { none, reached, stopped, halted, released, limit, fault };

/** What the planner steers toward; StepEngine builds it from a Request. */
struct Goal {
    bool velocity = false;  // a jog or stop: `speed`; else a move to `target`
    int32_t target = 0;
    int32_t speed = 0;      // signed steps/s; 0 stops
    uint32_t cap = 1;       // the speed limit in steps/s: the move's vmax, or |speed|
    uint32_t two_a = 2;     // 2 x the acceleration
    int32_t lo = -kPositionLimit;
    int32_t hi = kPositionLimit;
};

/** The decision at a step boundary: rest, or one step in `dir` from v^2 = vsq0 to v^2 = vsq. */
struct Plan {
    Rest rest = Rest::none;
    int8_t dir = 1;
    uint32_t vsq0 = 0;       // the speed^2 the step starts from (0 after a dead stop at a bound)
    uint32_t vsq = 0;        // the speed^2 at its end
    bool cap_is_goal = true; // the step's speed limit is the goal's cap; else it is v0 (a deceleration to rest)
};

/** floor(sqrt(n)), bit by bit: shifts, adds and compares only. */
FR_MOTION_ISR constexpr uint32_t isqrt(uint64_t n)
{
    uint64_t rem = n;
    uint64_t root = 0;
    uint64_t bit = uint64_t{1} << 62;
    while (bit > n) {
        bit >>= 2;
    }
    while (bit != 0) {
        if (rem >= root + bit) {
            rem -= root + bit;
            root = (root >> 1) + bit;
        } else {
            root >>= 1;
        }
        bit >>= 2;
    }
    return static_cast<uint32_t>(root);
}

/** sqrt(n) rounded to the nearest integer. */
FR_MOTION_ISR constexpr uint32_t sqrt_round(uint64_t n)
{
    const uint32_t r = isqrt(n);
    return n - uint64_t{r} * r > r ? r + 1 : r;
}

/**
 * A speed in Q8 (256 x steps/s) from its square: Q8 keeps a step's time within 0.2 % of exact down to 1 step a second,
 * and the largest, 256 x 10,000, still sums in a u32.
 */
FR_MOTION_ISR constexpr uint32_t root_q8(uint32_t vsq)
{
    return sqrt_round(uint64_t{vsq} << 16);
}

/** 2a x n saturated to a u32: the most v^2 that still stops within n steps. */
FR_MOTION_ISR constexpr uint32_t stop_bound(uint32_t two_a, int64_t n)
{
    if (n <= 0) {
        return 0;
    }
    const uint64_t m = uint64_t{two_a} * static_cast<uint32_t>(n);  // n < 2^32: positions are within +-1e9
    return m > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(m);
}

/** Room for steps from `position` toward `dir` before the goal's bound. */
FR_MOTION_ISR constexpr int64_t room(int32_t position, int8_t dir, const Goal &g)
{
    return dir > 0 ? int64_t{g.hi} - position : int64_t{position} - g.lo;
}

/**
 * The step after a decision to slow to rest: v^2 falls to the multiple of 2a just below it, so the steps to rest are
 * ceil(v^2 / 2a), the remainder goes in the first of them and every later one is a whole 2a, ending at sqrt(2a) -> 0.
 */
FR_MOTION_ISR constexpr uint32_t toward_rest(uint32_t vsq, uint32_t two_a)
{
    return vsq == 0 ? 0 : (vsq - 1) / two_a * two_a;
}

/**
 * The decision at a step boundary at `position`, last moving in `dir`, with v^2 = `vsq` there (design D5):
 *
 *   position mode, d = (target - position) * dir:
 *     at rest:   d == 0 rests (reached); d < 0 turns round
 *     d <= 0:    the target is behind or under it while moving: slow toward rest, pass it, come back
 *     d > 0:     v^2' = max(min(v^2 + 2a, vmax^2, 2a(d - 1)), v^2 - 2a): accelerate, cruise or brake for the target;
 *                when it cannot stop in time it brakes at a and overshoots (the only overshoot there is)
 *   velocity mode (jog at speed s; stop is s = 0):
 *     at rest:   s == 0 rests (stopped); else dir = sign(s)
 *     opposite:  slow toward rest, then turn round from rest
 *     same:      v^2 moves toward s^2 by at most 2a
 *
 * and in both modes the step never passes the goal's bound: v^2' <= 2a x (room - 1), resting there (limit) once it is
 * at the bound at rest; too fast for that at this a, it brakes evenly onto the bound (v^2' = v^2 (room - 1) / room,
 * rounded down). Moving at speed with no room at all (bounds set against the motion) stops dead.
 */
FR_MOTION_ISR constexpr Plan decide(int32_t position, int8_t dir, uint32_t vsq, const Goal &g)
{
    // Built from values, not default-initialised: GCC copies an all-constant initial Plan from a template in the TU's
    // .rodata, which is flash even when this function's copy is in IRAM.
    Plan p{Rest::none, dir, vsq != 0 && room(position, dir, g) <= 0 ? 0 : vsq, 0, true};
    const uint32_t v0sq = p.vsq0;
    const uint32_t cap_sq = g.cap * g.cap;
    if (!g.velocity) {
        int64_t d = (int64_t{g.target} - position) * dir;
        if (v0sq == 0) {
            if (d == 0) {
                p.rest = Rest::reached;
                return p;
            }
            if (d < 0) {
                p.dir = static_cast<int8_t>(-dir);
                d = -d;
            }
        }
        if (d <= 0) {
            p.vsq = toward_rest(v0sq, g.two_a);
            p.cap_is_goal = cap_sq < v0sq;
        } else {
            uint32_t hi = v0sq + g.two_a;
            hi = hi < cap_sq ? hi : cap_sq;
            const uint32_t stop = stop_bound(g.two_a, d - 1);
            hi = hi < stop ? hi : stop;
            const uint32_t lo = v0sq > g.two_a ? v0sq - g.two_a : 0;
            p.vsq = hi > lo ? hi : lo;
        }
    } else {
        if (v0sq == 0) {
            if (g.speed == 0) {
                p.rest = Rest::stopped;
                return p;
            }
            p.dir = g.speed > 0 ? 1 : -1;
        }
        if (g.speed == 0 || (g.speed > 0) != (p.dir > 0)) {
            p.vsq = toward_rest(v0sq, g.two_a);
            p.cap_is_goal = false;
        } else if (v0sq < cap_sq) {
            const uint32_t up = v0sq + g.two_a;
            p.vsq = up < cap_sq ? up : cap_sq;
        } else {
            const uint32_t down = v0sq > g.two_a ? v0sq - g.two_a : 0;
            p.vsq = down > cap_sq ? down : cap_sq;
        }
    }
    const int64_t left = room(position, p.dir, g);
    if (left <= 0) {
        p.rest = Rest::limit;
        return p;
    }
    // Moving too fast to stop on the bound at this goal's a (a lower accel, or a bound set, while it runs): brake
    // evenly onto it, v^2 falling by ceil(v^2 / room) a step, rather than cutting v^2 to a's stopping curve in one step.
    // The motion arrived within its earlier accel's stopping curve (v^2 <= 2a_old x room), so this is never harder.
    const uint32_t stop = v0sq > stop_bound(g.two_a, left)
                              ? v0sq - ((v0sq - 1) / static_cast<uint32_t>(left) + 1)  // left < v^2 / 2a < 2^32
                              : stop_bound(g.two_a, left - 1);
    p.vsq = p.vsq < stop ? p.vsq : stop;
    return p;
}

namespace detail {

/** 2 / (va + vb) seconds per step in us, rounded, for speeds in Q8: the time over a length-1 ramp from va to vb. */
FR_MOTION_ISR constexpr uint32_t ramp_us(uint32_t sa, uint32_t sb)
{
    const uint32_t sum = sa + sb;
    return (512'000'000u + sum / 2) / sum;
}

/**
 * d / (2 x two_a) in Q23, for d < 2 x two_a <= 800,000: d x 2^22 / two_a needs 42 bits, so it is two u32 divisions of
 * 11 bits each, the second on the first's remainder, instead of one u64 division.
 */
FR_MOTION_ISR constexpr uint32_t length_q23(uint32_t d, uint32_t two_a)
{
    const uint32_t n = d << 11;  // < 2^31
    return (n / two_a) << 11 | ((n % two_a) << 11) / two_a;
}

}  // namespace detail

/**
 * The duration in us of one step from v^2 = vsq0 to v^2 = vsq1 (s0, s1: the same speeds in Q8) under acceleration
 * two_a / 2 and the speed limit cap (cap_s in Q8): the time of the ideal motion over the step, whose speed profile is
 *
 *   v(x)^2 = min(vsq0 + 2a x, vsq1 + 2a (1 - x), max(vsq0 - 2a x, cap^2)),  0 <= x <= 1
 *
 * accelerating as early and braking for the end speed as late as a allows, and slowing from above the cap as early as it
 * allows. Each piece of it is a ramp or a cruise, and a ramp over length L from va to vb lasts L x 2 / (va + vb), so the
 * time is the weighted sum of at most three such terms: up or down to the step's top speed, a cruise there, down to v1.
 * A pure ramp (v^2 changing by exactly 2a) is the design's 2 / (v0 + v1); a cruise is 1 / v; and a step that starts
 * and ends at rest (a one-step move) takes 2 / sqrt(a), peaking at sqrt(a) in its middle.
 * Within +-1 us + 0.2 % of the exact value: the Q8 roots, and the pieces' lengths in Q23 (a slow piece can be most of
 * the time on a sliver of the length, so they need the bits). The cap is at least 1 step/s.
 */
FR_MOTION_ISR constexpr uint32_t step_us(uint32_t vsq0, uint32_t s0, uint32_t vsq1, uint32_t s1, uint32_t cap_sq,
                                         uint32_t cap_s, uint32_t two_a)
{
    // A pure ramp or a cruise at the cap. A change beyond 2a only follows a bound the motion cannot stop on at this a
    // (an even brake onto it, or a dead stop when there is no room); it is timed as a ramp too.
    if (vsq1 >= vsq0 + two_a || vsq0 >= vsq1 + two_a) {
        return detail::ramp_us(s0, s1);
    }
    if (vsq0 == vsq1 && vsq0 == cap_sq) {
        return detail::ramp_us(s0, s1);
    }
    // The planner never ends a step above its cap; slowing from above it toward a lower v1 (a deceleration to rest
    // with the cap below v0) brakes to v1 and cruises there.
    if (cap_sq < vsq1) {
        cap_sq = vsq1;
        cap_s = s1;
    }
    // top2 = 2 x the top speed^2: the cap, or the peak where the two ramps meet below it.
    uint32_t top2 = 2 * cap_sq;
    uint32_t top_s = cap_s;
    if (vsq0 <= cap_sq) {
        const uint32_t peak2 = vsq0 + vsq1 + two_a;
        if (peak2 < top2) {
            top2 = peak2;
            top_s = sqrt_round(uint64_t{peak2} << 15);
        }
    }
    // The pieces' lengths in Q23 of the step: |top^2 - v^2| / 2a each, from doubled values. Their exact sum is at most
    // the whole step, so the floors' sum is too.
    const uint32_t d0 = top2 > 2 * vsq0 ? top2 - 2 * vsq0 : 2 * vsq0 - top2;
    const uint32_t d1 = top2 - 2 * vsq1;
    const uint32_t w0 = detail::length_q23(d0, two_a);
    const uint32_t w1 = detail::length_q23(d1, two_a);
    const uint32_t wm = (uint32_t{1} << 23) - w0 - w1;
    uint64_t sum = 0;
    if (w0 != 0) {
        sum += uint64_t{w0} * detail::ramp_us(s0, top_s);
    }
    if (wm != 0) {
        sum += uint64_t{wm} * detail::ramp_us(top_s, top_s);
    }
    if (w1 != 0) {
        sum += uint64_t{w1} * detail::ramp_us(top_s, s1);
    }
    return static_cast<uint32_t>((sum + (uint64_t{1} << 22)) >> 23);
}

}  // namespace fr::motion
