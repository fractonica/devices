// Regression tests from the adversarial review of the stepper's motion core (design stepper-s1 D4-D6): StepEngine under
// the driver's alarm discipline (drv8833_stepper.cpp step_locked: next = due + interval, or now + interval when that
// has passed).
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <vector>

#include "fr/motion/step_engine.hpp"
#include "tests/test.hpp"

namespace m = fr::motion;
using Kind = m::Request::Kind;

namespace {

m::Request rv_move(int32_t target, uint32_t vmax, uint32_t accel, int32_t lo = -m::kPositionLimit,
                   int32_t hi = m::kPositionLimit)
{
    m::Request r;
    r.kind = Kind::move_to;
    r.target = target;
    r.vmax = vmax;
    r.accel = accel;
    r.lo = lo;
    r.hi = hi;
    return r;
}

m::Request rv_jog(int32_t speed, uint32_t accel, int32_t lo = -m::kPositionLimit, int32_t hi = m::kPositionLimit)
{
    m::Request r;
    r.kind = Kind::jog;
    r.speed = speed;
    r.accel = accel;
    r.lo = lo;
    r.hi = hi;
    return r;
}

/** The driver's alarm discipline in simulated µs. */
struct RvSim {
    m::StepEngine e;
    int64_t now = 0;
    int64_t due = 0;
    bool armed = false;
    uint32_t worst_drop = 0;  // the largest one-step fall of v^2 seen
    int64_t last_alarm = 0;

    void submit(const m::Request &r)
    {
        const m::Start s = e.submit(r);
        if (s.arm) {
            armed = true;
            due = now + s.delay_us;
        }
        if (s.rested_now) {
            armed = false;
        }
    }

    bool alarm(uint32_t late = 0)
    {
        if (!armed) {
            return false;
        }
        now = due + late;
        last_alarm = now;
        const uint32_t before = e.speed_sq();
        const m::Tick t = e.on_alarm(late);
        if (t.stepped && e.speed_sq() < before) {
            worst_drop = std::max(worst_drop, before - e.speed_sq());
        }
        if (!t.again) {
            armed = false;
            return true;
        }
        int64_t next = due + t.interval_us;
        if (next <= now) {
            next = now + t.interval_us;
        }
        due = next;
        return true;
    }

    void run_to(int32_t position)
    {
        while (armed && e.snapshot().position != position) {
            alarm();
        }
    }

    void run()
    {
        while (alarm()) {
        }
    }
};

}  // namespace

// A slip restarts the ramp from rest at the late alarm, so the re-ramp's first step lasts the from-rest time sqrt(2/a)
// from that alarm, although the driver counts the interval from the missed due time (the interval carries late_us).
TEST(review_motion_slip_restart_keeps_the_from_rest_step_time)
{
    struct Case {
        uint32_t vmax, accel, late;
    } cases[] = {{1600, 8000, 5000}, {10000, 200000, 2500}, {2000, 20000, 9000}};
    for (const Case &c : cases) {
        RvSim s;
        s.submit(rv_move(100000, c.vmax, c.accel));
        for (int i = 0; i < 2000; ++i) {
            s.alarm();
        }
        CHECK(s.e.speed_sq() == c.vmax * c.vmax);
        s.alarm(c.late);
        CHECK_EQ(s.e.snapshot().slips, 1u);
        const int64_t slip_at = s.now;
        s.alarm();
        const double from_rest_us = 1e6 * std::sqrt(2.0 / c.accel);
        const double got = static_cast<double>(s.now - slip_at);
        if (!CHECK(got >= 0.99 * from_rest_us)) {
            std::printf("    vmax %u a %u, %u us late: first re-ramp step %.0f us, from rest it takes %.0f us"
                        " (%.1fx the acceleration)\n",
                        c.vmax, c.accel, c.late, got, from_rest_us, (from_rest_us * from_rest_us) / (got * got));
        }
    }
}

// A jog toward its bound, replaced near it by the same jog at a lower accel (a new jog with its accel field), cannot
// stop on the bound at the new accel: it brakes evenly onto it (v^2 / room a step, within the accel it arrived with)
// instead of cutting v^2 in one step to the lower accel's stopping curve.
TEST(review_motion_lower_accel_near_a_bound_brakes_evenly_onto_it)
{
    RvSim s;
    s.submit(rv_jog(2000, 200000, -m::kPositionLimit, 1000));
    s.run_to(900);
    CHECK_EQ(s.e.speed_sq(), 4'000'000u);
    s.worst_drop = 0;
    s.submit(rv_jog(2000, 1000, -m::kPositionLimit, 1000));
    s.run();
    CHECK_EQ(s.e.snapshot().position, 1000);
    CHECK_EQ(s.e.snapshot().last_rest, m::Rest::limit);
    // v^2 / room = 4e6 / 100 = 40,000 per step brakes onto the bound; the old 2a is 400,000.
    if (!CHECK(s.worst_drop <= 400'000u)) {
        std::printf("    jog: v^2 fell by %u in one step (2a was 400,000, now 2,000): %u -> %u steps/s\n",
                    s.worst_drop, 2000u, static_cast<uint32_t>(std::sqrt(4'000'000.0 - s.worst_drop)));
    }

    // The same through a move to the bound retargeted with a lower accel: the overshoot it would plan meets the bound.
    RvSim t;
    t.submit(rv_move(1000, 2000, 200000, -m::kPositionLimit, 1000));
    t.run_to(500);
    CHECK_EQ(t.e.speed_sq(), 4'000'000u);
    t.worst_drop = 0;
    t.submit(rv_move(1000, 2000, 1000, -m::kPositionLimit, 1000));
    t.run();
    CHECK_EQ(t.e.snapshot().position, 1000);
    if (!CHECK(t.worst_drop <= 400'000u)) {
        std::printf("    move: v^2 fell by %u in one step (2a was 400,000, now 2,000)\n", t.worst_drop);
    }
}
