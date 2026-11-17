// The stepper's motion core (design stepper-s1 D4-D6, §10.2): StepEngine driven in simulated time, the alarms at the
// intervals it returns and armed as the driver arms them (due + interval, or now + interval when that is past), and
// checked against double-precision references: the ideal continuous trapezoid for moves from rest, and an independent
// piecewise integration of one step's ideal profile for step_us() over the planner's every branch. Then the cases of
// §10.2, exhaustive small moves, randomised retarget/reverse/stop sequences and the range limits.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <random>
#include <string>
#include <type_traits>
#include <vector>

#include "fr/hal/stepper.hpp"
#include "fr/motion/step_engine.hpp"
#include "fr/motion/step_planner.hpp"
#include "tests/test.hpp"

namespace m = fr::motion;
using Kind = m::Request::Kind;

// The L1 contract (D3) builds on the host as it is, as the driver and the service tests' fake implement it.
static_assert(std::is_abstract_v<fr::hal::Stepper>);

namespace {

// ---- Requests ----

m::Request move_to(int32_t target, uint32_t vmax, uint32_t accel)
{
    m::Request r;
    r.kind = Kind::move_to;
    r.target = target;
    r.vmax = vmax;
    r.accel = accel;
    return r;
}

m::Request jog(int32_t speed, uint32_t accel = 0, int32_t lo = -m::kPositionLimit, int32_t hi = m::kPositionLimit)
{
    m::Request r;
    r.kind = Kind::jog;
    r.speed = speed;
    r.accel = accel;
    r.lo = lo;
    r.hi = hi;
    return r;
}

m::Request stop()
{
    return m::Request{};
}

m::Request halt()
{
    m::Request r;
    r.kind = Kind::halt;
    return r;
}

uint64_t ceil_div(uint64_t n, uint64_t d)
{
    return (n + d - 1) / d;
}

// ---- The simulated driver ----

struct StepRec {
    int64_t at;         // the alarm's time: the step's vector is applied then
    int32_t pos;        // after the step
    int8_t dir;
    uint32_t interval;  // the step's duration
    uint32_t vsq0;      // v^2 the step started from (0 after a slip)
    uint32_t vsq;       // v^2 at its end
};

/**
 * One engine and the driver's alarm discipline in simulated µs. Every step is checked against the invariants that hold
 * for any request sequence: one step of +-1 at a time, the direction turning only at zero speed, |dv^2| <= 2a, v^2 rising
 * only up to the goal's cap, and every interval within [100 µs, 2 s].
 */
class Sim
{
public:
    m::StepEngine e;
    int64_t now = 0;
    int64_t due = 0;
    bool armed = false;
    std::vector<StepRec> steps;
    uint32_t two_a = 2;  // what the engine runs with, tracked from the requests
    uint32_t cap = 1;
    bool record = true;
    uint32_t violations = 0;
    uint32_t rests_seen = 0;  // rests the driver saw: rested_now, an alarm that rested, a fault while running
    int64_t moved = 0;        // the signed sum of the steps

    m::Start submit(const m::Request &r)
    {
        if (r.kind != Kind::halt) {
            if (r.accel != 0) {
                two_a = 2 * std::clamp<uint32_t>(r.accel, 1, m::kMaxAccel);
            }
            if (r.kind == Kind::move_to) {
                cap = std::clamp<uint32_t>(r.vmax, 1, m::kMaxSpeed);
            } else if (r.kind == Kind::jog && r.speed != 0) {
                cap = std::min<uint32_t>(static_cast<uint32_t>(std::abs(r.speed)), m::kMaxSpeed);
            }
        }
        const m::Start s = e.submit(r);
        if (s.arm) {
            CHECK(!armed);
            CHECK(!s.rested_now);
            armed = true;
            due = now + s.delay_us;
        }
        if (s.rested_now) {
            armed = false;  // the driver disables the alarm
            ++rests_seen;
        }
        return s;
    }

    /** One alarm, `late` µs after its due time; false when nothing is armed. */
    bool alarm(uint32_t late = 0)
    {
        if (!armed) {
            return false;
        }
        now = due + late;
        const m::Snapshot before = e.snapshot();
        const uint32_t vsq_before = e.speed_sq();
        const m::Tick t = e.on_alarm(late);
        const m::Snapshot after = e.snapshot();
        if (t.stepped) {
            const int32_t d = after.position - before.position;
            const bool slipped = after.slips != before.slips;
            const uint32_t vsq0 = slipped ? 0 : vsq_before;
            const uint32_t vsq = e.speed_sq();
            const int8_t dir = static_cast<int8_t>(d);
            expect(d == 1 || d == -1, "one step of +-1");
            expect(t.again && t.interval_us >= 100 && t.interval_us <= 2'000'000, "an interval within [100 us, 2 s]");
            expect(t.phase == e.phase(), "the tick's phase is the new position's");
            expect(vsq0 == 0 || taken_ == 0 || dir == last_dir_, "the direction turns only at zero speed");
            expect((vsq > vsq0 ? vsq - vsq0 : vsq0 - vsq) <= two_a, "|dv^2| <= 2a");
            expect(vsq <= vsq0 || vsq <= cap * cap, "v^2 rises only up to the cap");
            last_dir_ = dir;
            moved += d;
            if (record) {
                steps.push_back({now, after.position, dir, t.interval_us, vsq0, vsq});
            }
            ++taken_;
        } else {
            expect(!t.again && !after.running, "an alarm without a step rests");
            expect(after.position == before.position, "a rest does not move");
            ++rests_seen;
        }
        if (t.again) {
            int64_t next = due + t.interval_us;
            if (next <= now) {
                next = now + t.interval_us;
            }
            due = next;
        } else {
            armed = false;
        }
        return true;
    }

    /** Alarms until rest or `max_steps` more steps; the steps taken. */
    uint64_t run(uint64_t max_steps = std::numeric_limits<uint64_t>::max())
    {
        const uint64_t start = taken_;
        while (taken_ - start < max_steps && alarm()) {
        }
        return taken_ - start;
    }

    void fault()
    {
        rests_seen += e.snapshot().running ? 1 : 0;
        e.fault();
        armed = false;
    }

    m::Snapshot snap() const { return e.snapshot(); }
    uint64_t taken() const { return taken_; }

private:
    void expect(bool ok, const char *what)
    {
        if (!ok && violations++ < 5) {
            ::frt::fail(__FILE__, __LINE__,
                        std::string("invariant: ") + what + " (step " + std::to_string(taken_) + ", position " +
                            std::to_string(e.snapshot().position) + ")");
        }
    }

    int8_t last_dir_ = 1;
    uint64_t taken_ = 0;
};

// ---- The references ----

/** The time at which the ideal trapezoid from rest at 0 to rest at D (vmax, a) reaches x, in seconds. */
double ideal_time(double x, double D, double vmax, double a)
{
    const double xa = vmax * vmax / (2 * a);
    if (D >= 2 * xa) {
        if (x <= xa) {
            return std::sqrt(2 * x / a);
        }
        if (x <= D - xa) {
            return vmax / a + (x - xa) / vmax;
        }
        return D / vmax + vmax / a - std::sqrt(std::max(0.0, 2 * (D - x) / a));
    }
    if (x <= D / 2) {
        return std::sqrt(2 * x / a);
    }
    return 2 * std::sqrt(D / a) - std::sqrt(std::max(0.0, 2 * (D - x) / a));
}

/** The design's accuracy: within 1 µs + 0.5 % of the exact value. */
bool close_us(double got, double want, double rel = 0.005)
{
    return std::abs(got - want) <= 1.0 + rel * want;
}

/**
 * Checks the steps of a move from rest by |D| steps against the ideal trapezoid: interval k = tau(k) - tau(k-1).
 * Returns the worst error relative to the ideal interval.
 */
double check_ideal(const std::vector<StepRec> &steps, int64_t D, uint32_t vmax, uint32_t accel)
{
    const double n = static_cast<double>(std::llabs(D));
    if (!CHECK_EQ(steps.size(), static_cast<size_t>(n))) {
        return 1.0;
    }
    double worst = 0;
    int bad = 0;
    for (size_t k = 1; k <= steps.size(); ++k) {
        const double want = 1e6 * (ideal_time(static_cast<double>(k), n, vmax, accel) -
                                   ideal_time(static_cast<double>(k - 1), n, vmax, accel));
        const double got = steps[k - 1].interval;
        worst = std::max(worst, std::max(0.0, std::abs(got - want) - 1.0) / want);
        if (!close_us(got, want) && bad++ < 3) {
            CHECK(close_us(got, want));
            std::printf("    step %zu of %lld (vmax %u, a %u): %.1f us, ideal %.3f us\n", k, static_cast<long long>(D),
                        vmax, accel, got, want);
        }
    }
    return worst;
}

/**
 * One step's ideal duration in µs, integrated piecewise: v(x)^2 = min(v0^2 + 2a x, v1^2 + 2a (1 - x),
 * max(v0^2 - 2a x, c^2)) on [0, 1], c^2 never below v1^2. An independent derivation of step_us()'s profile: the pieces
 * are found by intersecting the four lines and testing each sub-interval's midpoint.
 */
double ref_step_us(double v0sq, double v1sq, double csq, double two_a)
{
    csq = std::max(csq, v1sq);
    struct Line {
        double alpha, beta;
        double at(double x) const { return alpha + beta * x; }
    };
    const Line up{v0sq, two_a}, down{v1sq + two_a, -two_a}, brake{v0sq, -two_a}, flat{csq, 0};
    const auto f = [&](double x) { return std::min({up.at(x), down.at(x), std::max(brake.at(x), flat.at(x))}); };
    const Line lines[4] = {up, down, brake, flat};
    std::vector<double> xs = {0.0, 1.0};
    for (int i = 0; i < 4; ++i) {
        for (int j = i + 1; j < 4; ++j) {
            if (lines[i].beta != lines[j].beta) {
                const double x = (lines[j].alpha - lines[i].alpha) / (lines[i].beta - lines[j].beta);
                if (x > 0 && x < 1) {
                    xs.push_back(x);
                }
            }
        }
    }
    std::sort(xs.begin(), xs.end());
    double t = 0;
    for (size_t i = 0; i + 1 < xs.size(); ++i) {
        const double x0 = xs[i], x1 = xs[i + 1];
        if (x1 - x0 < 1e-15) {
            continue;
        }
        const double xm = (x0 + x1) / 2;
        const double fm = f(xm);
        const Line *on = &lines[0];
        for (const Line &l : lines) {
            if (std::abs(l.at(xm) - fm) <= 1e-9 * std::max(1.0, fm)) {
                on = &l;
                break;
            }
        }
        if (on->beta == 0) {
            t += (x1 - x0) / std::sqrt(on->alpha);
        } else {
            t += 2 * (std::sqrt(std::max(0.0, on->at(x1))) - std::sqrt(std::max(0.0, on->at(x0)))) / on->beta;
        }
    }
    return t * 1e6;
}

/** Runs a move from rest at `from` by `D` steps and checks it against the ideal; the worst relative error. */
double ideal_move(int32_t from, int32_t D, uint32_t vmax, uint32_t accel)
{
    Sim s;
    if (!CHECK(s.e.set_position(from).has_value())) {
        return 1.0;
    }
    const m::Start st = s.submit(move_to(from + D, vmax, accel));
    if (D == 0) {
        CHECK(st.rested_now && !st.arm);
        CHECK_EQ(s.snap().last_rest, m::Rest::reached);
        return 0;
    }
    if (!CHECK(st.arm)) {
        return 1.0;
    }
    s.run();
    const m::Snapshot snap = s.snap();
    CHECK_EQ(s.violations, 0u);
    CHECK_EQ(snap.position, from + D);
    CHECK_EQ(snap.target, from + D);
    CHECK_EQ(snap.last_rest, m::Rest::reached);
    CHECK_EQ(snap.rests, 1u);
    CHECK_EQ(snap.speed, 0);
    CHECK(!snap.running);
    // From rest, every step goes toward the target: no overshoot.
    for (const StepRec &r : s.steps) {
        CHECK_EQ(r.dir, D > 0 ? 1 : -1);
    }
    return check_ideal(s.steps, D, vmax, accel);
}

double log_uniform(std::mt19937_64 &rng, double lo, double hi)
{
    std::uniform_real_distribution<double> u(std::log(lo), std::log(hi));
    return std::exp(u(rng));
}

}  // namespace

// ---- §10.2 1-2: the profile against the ideal trapezoid ----

TEST(stepper_engine_accel_and_decel_are_symmetric)
{
    Sim s;
    s.submit(move_to(1000, 1600, 8000));
    s.run();
    REQUIRE_EQ(s.steps.size(), 1000u);
    for (size_t i = 0; i < 500; ++i) {
        const int64_t a = s.steps[i].interval;
        const int64_t b = s.steps[999 - i].interval;
        CHECK(std::llabs(a - b) <= 1);
    }
}

TEST(stepper_engine_kinematics_match_the_trapezoid)
{
    // 0 -> 1,000 at a = 8,000, vmax = 1,600: vmax is reached at 160 steps after vmax / a = 0.2 s.
    Sim s;
    s.submit(move_to(1000, 1600, 8000));
    s.run();
    REQUIRE_EQ(s.steps.size(), 1000u);
    CHECK(std::abs(s.steps[0].interval - std::sqrt(2.0 / 8000) * 1e6) <= 0.01 * std::sqrt(2.0 / 8000) * 1e6);
    CHECK_EQ(s.steps[159].vsq, 1600u * 1600u);
    CHECK(s.steps[158].vsq < 1600u * 1600u);
    double to_vmax = 0;
    for (size_t k = 0; k < 160; ++k) {
        to_vmax += s.steps[k].interval;
    }
    CHECK(std::abs(to_vmax - 0.2e6) <= 0.01 * 0.2e6);
    // The whole move: D / vmax + vmax / a, from the first step's vector to the rest.
    const double total = static_cast<double>(s.now - s.steps[0].at);
    CHECK(std::abs(total - 0.825e6) <= 0.01 * 0.825e6);
    CHECK(std::abs(total - 0.825e6) <= 0.001 * 0.825e6);  // in fact much closer
    CHECK(check_ideal(s.steps, 1000, 1600, 8000) < 0.005);

    // A short move (d < vmax^2 / a = 320) is a triangle peaking at sqrt(a d).
    Sim t;
    t.submit(move_to(200, 1600, 8000));
    t.run();
    uint32_t peak = 0;
    for (const StepRec &r : t.steps) {
        peak = std::max(peak, r.vsq);
    }
    CHECK(std::abs(std::sqrt(static_cast<double>(peak)) - std::sqrt(8000.0 * 200)) <= 0.01 * std::sqrt(8000.0 * 200));
    CHECK(std::abs(static_cast<double>(t.now - t.steps[0].at) - 2e6 * std::sqrt(200 / 8000.0)) <=
          0.01 * 2e6 * std::sqrt(200 / 8000.0));
    check_ideal(t.steps, 200, 1600, 8000);

    // At the top of the range every interval is still >= 100 µs (10 kHz); cruising, exactly 100.
    Sim f;
    f.submit(move_to(5000, 10000, 200000));
    f.run();
    CHECK_EQ(f.violations, 0u);
    CHECK_EQ(f.steps[2500].interval, 100u);
    check_ideal(f.steps, 5000, 10000, 200000);
}

TEST(stepper_engine_one_step_moves_and_tiny_caps_are_exact)
{
    // A one-step move starts and ends at rest: it peaks at sqrt(a) mid-step and lasts 2 / sqrt(a), not forever.
    Sim s;
    s.submit(move_to(1, 1600, 8000));
    s.run();
    REQUIRE_EQ(s.steps.size(), 1u);
    CHECK(close_us(s.steps[0].interval, 2e6 / std::sqrt(8000.0)));
    CHECK_EQ(s.steps[0].vsq, 0u);
    // A cap below sqrt(2a) cruises from the first step on: 1 step/s takes a second a step, not two.
    Sim c;
    c.submit(move_to(-3, 1, 8000));
    c.run();
    REQUIRE_EQ(c.steps.size(), 3u);
    for (const StepRec &r : c.steps) {
        CHECK(close_us(r.interval, 1e6, 0.0001));
    }
}

TEST(stepper_engine_exhaustive_small_moves_are_exact)
{
    // Every distance up to 64 either way, over caps around sqrt(2a) and accelerations across the range (and below it):
    // the exact target, no overshoot, every interval within the design's accuracy of the ideal trapezoid.
    double worst = 0;
    for (uint32_t accel : {1u, 10u, 37u, 800u, 8000u, 65537u, 200000u}) {
        for (uint32_t vmax : {1u, 2u, 3u, 7u, 50u, 126u, 127u, 400u, 1000u, 4000u, 10000u}) {
            for (int32_t d = -64; d <= 64; ++d) {
                worst = std::max(worst, ideal_move(d * 7919, d, vmax, accel));
            }
        }
    }
    std::printf("    worst interval error, small moves: %.4f %%\n", worst * 100);
    CHECK(worst < 0.002);
}

// ---- §10.2 3: position exactness over random moves ----

TEST(stepper_engine_random_moves_land_exactly)
{
    std::mt19937_64 rng(0x5EED0001);
    std::uniform_int_distribution<int32_t> from(-m::kPositionLimit + 4000, m::kPositionLimit - 4000);
    std::uniform_int_distribution<int32_t> dist(-3000, 3000);
    double worst = 0;
    for (int i = 0; i < 1000; ++i) {
        const int32_t start = from(rng);
        const int32_t d = dist(rng);
        const auto vmax = static_cast<uint32_t>(log_uniform(rng, 1, 10000));
        const auto accel = static_cast<uint32_t>(log_uniform(rng, 10, 200000));
        worst = std::max(worst, ideal_move(start, d, vmax, accel));
    }
    std::printf("    worst interval error, random moves: %.4f %%\n", worst * 100);
    CHECK(worst < 0.002);
}

// ---- step_us() over every branch of the planner, against the independent integration ----

TEST(stepper_engine_step_time_matches_the_exact_kinematics)
{
    std::mt19937_64 rng(0x5EED0002);
    std::uniform_int_distribution<int> coin(0, 1);
    std::uniform_int_distribution<int32_t> near(-40, 40);
    double worst = 0;
    int checked = 0;
    // How often each shape of step came up, so the sweep proves it reached them all.
    enum { pure, cruise, hill, triangle, valley, to_rest, rest_to_rest, dead_stop, cut, kShapes };
    int shapes[kShapes] = {};
    for (int i = 0; i < 400000; ++i) {
        m::Goal g;
        g.velocity = coin(rng) == 1;
        g.two_a = 2 * static_cast<uint32_t>(log_uniform(rng, 1, m::kMaxAccel));
        g.cap = static_cast<uint32_t>(log_uniform(rng, 1, m::kMaxSpeed));
        const int32_t position = near(rng) * 1000 + near(rng);
        if (i % 5 == 0) {  // bounds close by, sometimes on the wrong side of the position
            g.lo = position - std::abs(near(rng));
            g.hi = position + std::abs(near(rng)) - (coin(rng) ? 0 : 41);
            g.hi = std::max(g.hi, g.lo);
        }
        g.target = std::clamp(position + near(rng) * (coin(rng) ? 1 : 100), g.lo, g.hi);
        g.speed = (coin(rng) ? 1 : -1) * static_cast<int32_t>(g.cap) * coin(rng);
        if (g.velocity && g.speed == 0) {
            g.cap = 1;
        }
        // A speed anywhere the planner can be: below, at or above the cap, a whole number of 2a or not.
        uint32_t vsq = 0;
        switch (i % 4) {
        case 0:
            vsq = static_cast<uint32_t>(log_uniform(rng, 1, 1e8));
            break;
        case 1:
            vsq = std::min<uint32_t>(g.cap * g.cap, g.two_a * static_cast<uint32_t>(near(rng) + 41));
            break;
        case 2:
            vsq = g.cap * g.cap;
            break;
        default:
            vsq = static_cast<uint32_t>(std::uniform_int_distribution<uint32_t>(0, 2 * g.two_a)(rng));
            break;
        }
        const int8_t dir = coin(rng) ? 1 : -1;
        const m::Plan p = m::decide(position, dir, vsq, g);
        if (p.rest != m::Rest::none) {
            continue;
        }
        const uint32_t s0 = m::root_q8(p.vsq0);
        const uint32_t s1 = m::root_q8(p.vsq);
        const uint32_t cap_sq = p.cap_is_goal ? g.cap * g.cap : p.vsq0;
        const uint32_t cap_s = p.cap_is_goal ? g.cap << 8 : s0;
        const uint32_t got = m::step_us(p.vsq0, s0, p.vsq, s1, cap_sq, cap_s, g.two_a);
        CHECK(got >= 100);
        shapes[dead_stop] += p.vsq0 != vsq ? 1 : 0;
        shapes[to_rest] += p.cap_is_goal ? 0 : 1;
        shapes[rest_to_rest] += p.vsq0 == 0 && p.vsq == 0 ? 1 : 0;
        if (p.vsq + g.two_a < p.vsq0) {
            ++shapes[cut];
            continue;  // a cut at a bound that came too fast: no ideal profile to compare with
        }
        const uint32_t top_sq = std::max(cap_sq, p.vsq);
        if (p.vsq == p.vsq0 + g.two_a || p.vsq0 == p.vsq + g.two_a) {
            ++shapes[pure];
        } else if (p.vsq0 == p.vsq && p.vsq == top_sq) {
            ++shapes[cruise];
        } else if (p.vsq0 > top_sq) {
            ++shapes[valley];
        } else if (p.vsq0 + p.vsq + g.two_a < 2 * top_sq) {
            ++shapes[triangle];
        } else {
            ++shapes[hill];
        }
        const double want = ref_step_us(p.vsq0, p.vsq, cap_sq, g.two_a);
        worst = std::max(worst, std::max(0.0, std::abs(got - want) - 1.0) / want);
        ++checked;
        if (!close_us(got, want, 0.002)) {
            CHECK(close_us(got, want, 0.002));
            std::printf("    v0^2 %u v1^2 %u cap %u 2a %u: %u us, exact %.3f\n", p.vsq0, p.vsq, cap_sq, g.two_a, got, want);
            return;
        }
        // A pure ramp is the design's 2 / (v0 + v1) exactly as rounded.
        if (p.vsq == p.vsq0 + g.two_a || p.vsq0 == p.vsq + g.two_a) {
            CHECK_EQ(got, (512'000'000u + (s0 + s1) / 2) / (s0 + s1));
        }
    }
    std::printf("    %d steps checked; worst error beyond 1 us: %.4f %%\n", checked, worst * 100);
    CHECK(checked > 200000);
    for (int k = 0; k < kShapes; ++k) {
        if (!CHECK(shapes[k] >= 100)) {
            std::printf("    shape %d came up %d times\n", k, shapes[k]);
        }
    }
}

TEST(stepper_engine_isqrt_is_exact)
{
    CHECK_EQ(m::isqrt(0), 0u);
    CHECK_EQ(m::isqrt(1), 1u);
    CHECK_EQ(m::isqrt(3), 1u);
    CHECK_EQ(m::isqrt(4), 2u);
    static_assert(m::isqrt(uint64_t{100'000'000} << 16) == 2'560'000);
    static_assert(m::root_q8(2) == 362);  // 256 sqrt(2) = 362.04
    std::mt19937_64 rng(0x5EED0003);
    for (int i = 0; i < 200000; ++i) {
        const uint64_t n = rng() >> (rng() % 64);
        const unsigned __int128 r = m::isqrt(n);
        CHECK(r * r <= n);
        CHECK((r + 1) * (r + 1) > n);
        const uint64_t q = m::sqrt_round(n >> 2);  // keep q^2 + q in range
        CHECK(std::abs(static_cast<double>(q) - std::sqrt(static_cast<double>(n >> 2))) <= 0.5 + 1e-6);
    }
}

// ---- §10.2 4-6: retargets and reversals ----

namespace {

/** A move 0 -> 1000 at a = 8,000, vmax = 1,600, run `n` steps (cruise from 160 on). */
Sim cruising(uint64_t n)
{
    Sim s;
    s.submit(move_to(1000, 1600, 8000));
    s.run(n);
    return s;
}

}  // namespace

TEST(stepper_engine_retarget_farther_keeps_accelerating)
{
    Sim s = cruising(300);
    s.submit(move_to(2000, 1600, 8000));
    s.run();
    CHECK_EQ(s.violations, 0u);
    const m::Snapshot snap = s.snap();
    CHECK_EQ(snap.position, 2000);
    CHECK_EQ(snap.rests, 1u);  // no rest for the replaced move
    CHECK_EQ(snap.last_rest, m::Rest::reached);
    for (size_t i = 1; i < s.steps.size() && s.steps[i].pos <= 2000 - 160; ++i) {
        CHECK(s.steps[i].vsq >= s.steps[i - 1].vsq);
    }
}

TEST(stepper_engine_retarget_nearer_lands_without_overshoot)
{
    Sim s = cruising(300);
    const uint32_t vsq = s.e.speed_sq();
    CHECK(vsq <= s.two_a * (600 - 300));  // beyond the stopping distance
    s.submit(move_to(600, 1600, 8000));
    s.run();
    CHECK_EQ(s.violations, 0u);
    CHECK_EQ(s.snap().position, 600);
    CHECK_EQ(s.snap().rests, 1u);
    for (const StepRec &r : s.steps) {
        CHECK(r.pos <= 600);
        CHECK_EQ(r.dir, 1);
    }
}

TEST(stepper_engine_retarget_inside_the_stopping_distance_overshoots_by_it)
{
    Sim s = cruising(300);
    const uint32_t vsq = s.e.speed_sq();
    const int64_t stopping = static_cast<int64_t>(ceil_div(vsq, s.two_a));
    CHECK_EQ(stopping, 160);
    const size_t from = s.steps.size();
    s.submit(move_to(350, 1600, 8000));
    s.run();
    CHECK_EQ(s.violations, 0u);
    int32_t furthest = 0;
    size_t turn = 0;
    for (size_t i = from; i < s.steps.size(); ++i) {
        if (s.steps[i].pos > furthest) {
            furthest = s.steps[i].pos;
            turn = i;
        }
    }
    CHECK_EQ(furthest, 300 + stopping);       // exactly, in fact
    CHECK_EQ(s.steps[turn].vsq, 0u);          // it turns at zero speed
    CHECK_EQ(s.steps[turn + 1].dir, -1);
    CHECK_EQ(s.snap().position, 350);
    CHECK_EQ(s.snap().last_rest, m::Rest::reached);
    CHECK_EQ(s.snap().rests, 1u);
}

TEST(stepper_engine_slower_speed_mid_cruise_brakes_at_a)
{
    Sim s = cruising(300);
    const size_t from = s.steps.size();
    s.submit(move_to(1000, 800, 8000));
    s.run();
    CHECK_EQ(s.violations, 0u);
    CHECK_EQ(s.snap().position, 1000);
    // From 1,600^2 down to 800^2: (2,560,000 - 640,000) / 16,000 = 120 steps of exactly 2a, then a cruise at 800.
    for (size_t i = from; i < from + 120; ++i) {
        CHECK_EQ(s.steps[i - 1].vsq - s.steps[i].vsq, 16000u);
    }
    CHECK_EQ(s.steps[from + 119].vsq, 800u * 800u);
    CHECK_EQ(s.steps[from + 120].vsq, 800u * 800u);
    CHECK(close_us(s.steps[from + 150].interval, 1250));
    // The step that lands on the lower cap cruises the rest of it: the exact time of a brake then a cruise.
    Sim t = cruising(300);
    t.submit(move_to(1000, 790, 8000));  // 790^2 is no whole number of 2a below 1,600^2
    t.run();
    CHECK_EQ(t.violations, 0u);
    CHECK_EQ(t.snap().position, 1000);
    for (const StepRec &r : t.steps) {
        if (r.vsq0 > 790u * 790u && r.vsq == 790u * 790u && r.vsq0 - r.vsq < t.two_a) {
            CHECK(close_us(r.interval, ref_step_us(r.vsq0, r.vsq, 790.0 * 790, t.two_a), 0.002));
        }
    }
}

TEST(stepper_engine_reverses_through_zero_speed)
{
    // A target behind at cruise: v^2 falls by 2a a step, crosses zero once, comes back and lands.
    Sim s = cruising(300);
    const size_t from = s.steps.size();
    s.submit(move_to(-200, 1600, 8000));
    s.run();
    CHECK_EQ(s.violations, 0u);
    CHECK_EQ(s.snap().position, -200);
    CHECK_EQ(s.snap().rests, 1u);
    int zeros = 0;
    size_t i = from;
    for (; s.steps[i].vsq != 0; ++i) {
        CHECK_EQ(s.steps[i].dir, 1);
        CHECK_EQ(s.steps[i].vsq0 - s.steps[i].vsq, 16000u);
    }
    CHECK_EQ(s.steps[i].pos, 300 + 160);
    for (; i < s.steps.size(); ++i) {
        zeros += s.steps[i].vsq == 0 ? 1 : 0;
        if (i > from && s.steps[i].dir != s.steps[i - 1].dir) {
            CHECK_EQ(s.steps[i].vsq0, 0u);
        }
    }
    CHECK_EQ(zeros, 2);  // the turn and the arrival

    // Jog +1,600 -> -1,600: the same through zero, then up to 1,600 the other way.
    Sim j;
    j.submit(jog(1600, 8000));
    j.run(400);
    CHECK_EQ(j.e.speed_sq(), 1600u * 1600u);
    const size_t at = j.steps.size();
    j.submit(jog(-1600));
    j.run(400);
    CHECK_EQ(j.violations, 0u);
    int crossings = 0;
    for (size_t k = at; k < at + 320; ++k) {
        crossings += j.steps[k].vsq == 0 ? 1 : 0;
        CHECK_EQ(j.steps[k].vsq0 > j.steps[k].vsq ? j.steps[k].vsq0 - j.steps[k].vsq : j.steps[k].vsq - j.steps[k].vsq0,
                 16000u);
    }
    CHECK_EQ(crossings, 1);
    CHECK_EQ(j.steps[at + 159].vsq, 0u);
    CHECK_EQ(j.steps[at + 160].dir, -1);
    CHECK_EQ(j.e.speed_sq(), 1600u * 1600u);
    CHECK_EQ(j.snap().speed, -1600);
    CHECK_EQ(j.snap().position, j.steps[at - 1].pos + 160 - 240);
}

// ---- §10.2 7-9: stop, halt, jog ----

TEST(stepper_engine_stop_takes_the_stopping_distance)
{
    // From cruise, mid-acceleration and during deceleration: ceil(v^2 / 2a) steps, exactly, and `stopped`.
    for (uint64_t n : {300u, 50u, 900u, 1u}) {
        Sim s = cruising(n);
        const uint32_t vsq = s.e.speed_sq();
        const int32_t at = s.snap().position;
        s.submit(stop());
        s.run();
        CHECK_EQ(s.violations, 0u);
        CHECK_EQ(s.snap().position - at, static_cast<int64_t>(ceil_div(vsq, s.two_a)));
        CHECK_EQ(s.snap().last_rest, m::Rest::stopped);
        CHECK_EQ(s.snap().rests, 1u);
        CHECK_EQ(s.snap().target, s.snap().position);
    }
    // A speed that is no whole number of 2a (1,000^2 / 16,000 = 62.5): 63 steps, the remainder in the first, and the
    // last from sqrt(2a) to rest.
    Sim j;
    j.submit(jog(1000, 8000));
    j.run(500);
    REQUIRE_EQ(j.e.speed_sq(), 1'000'000u);
    const size_t from = j.steps.size();
    j.submit(stop());
    j.run();
    REQUIRE_EQ(j.steps.size() - from, 63u);
    CHECK_EQ(j.steps[from].vsq0 - j.steps[from].vsq, 8000u);
    CHECK_EQ(j.steps.back().vsq0, 16000u);
    CHECK_EQ(j.steps.back().vsq, 0u);
    // A slow jog stops in one step that cruises then brakes: not a long creep at a remainder speed.
    Sim slow;
    slow.submit(jog(10, 8000));
    slow.run(5);
    slow.submit(stop());
    CHECK_EQ(slow.run(), 1u);
    CHECK(close_us(slow.steps.back().interval, 1e6 * (1.0 / 10 + 10.0 / 16000), 0.002));
    // A stop at rest: nothing to do.
    Sim r;
    const m::Start st = r.submit(stop());
    CHECK(!st.arm && !st.rested_now);
    CHECK_EQ(r.snap().rests, 0u);
    CHECK(!r.submit(jog(0)).arm);
    CHECK(!r.submit(halt()).rested_now);
    CHECK_EQ(r.snap().rests, 0u);
}

TEST(stepper_engine_halt_and_release_end_at_once)
{
    Sim s = cruising(300);
    const m::Start st = s.submit(halt());
    CHECK(st.rested_now && !st.arm);
    m::Snapshot snap = s.snap();
    CHECK_EQ(snap.last_rest, m::Rest::halted);
    CHECK_EQ(snap.speed, 0);
    CHECK_EQ(snap.position, 300);
    CHECK_EQ(snap.target, 1000);  // the target it had
    CHECK(!snap.running);
    // An alarm that raced the halt takes no step.
    const m::Tick t = s.e.on_alarm(0);
    CHECK(!t.stepped && !t.again);
    CHECK_EQ(s.snap().position, 300);
    // It starts again from rest.
    CHECK(s.submit(move_to(310, 1600, 8000)).arm);
    s.run();
    CHECK_EQ(s.snap().position, 310);
    CHECK_EQ(s.snap().rests, 2u);

    Sim r = cruising(200);
    r.e.release();
    CHECK_EQ(r.snap().last_rest, m::Rest::released);
    CHECK_EQ(r.snap().speed, 0);
    CHECK(!r.snap().running);
    r.e.release();  // at rest: nothing more
    CHECK_EQ(r.snap().rests, 1u);
}

TEST(stepper_engine_jog_holds_changes_and_stops)
{
    Sim s;
    s.submit(jog(1200, 8000));
    s.run(300);
    CHECK_EQ(s.e.speed_sq(), 1200u * 1200u);
    CHECK_EQ(s.snap().speed, 1200);
    CHECK(close_us(s.steps.back().interval, 1e6 / 1200));
    // Up and down at a.
    s.submit(jog(2000));
    s.run(400);
    CHECK_EQ(s.e.speed_sq(), 2000u * 2000u);
    s.submit(jog(500));
    s.run(400);
    CHECK_EQ(s.e.speed_sq(), 500u * 500u);
    CHECK_EQ(s.violations, 0u);
    // s = 0 slows to rest: stopped.
    s.submit(jog(0));
    s.run();
    CHECK_EQ(s.snap().last_rest, m::Rest::stopped);
    CHECK_EQ(s.snap().rests, 1u);
}

TEST(stepper_engine_jog_rests_exactly_on_its_bound)
{
    Sim s;
    s.submit(jog(3000, 8000, -100, 500));
    s.run();
    CHECK_EQ(s.violations, 0u);
    CHECK_EQ(s.snap().position, 500);
    CHECK_EQ(s.snap().last_rest, m::Rest::limit);
    CHECK_EQ(s.steps.back().vsq, 0u);
    // Into the bound from rest: limit at once. Away from it: it moves.
    const m::Start st = s.submit(jog(100, 8000, -100, 500));
    CHECK(st.rested_now && !st.arm);
    CHECK_EQ(s.snap().last_rest, m::Rest::limit);
    CHECK(s.submit(jog(-3000, 8000, -100, 500)).arm);
    s.run();
    CHECK_EQ(s.snap().position, -100);
    CHECK_EQ(s.snap().last_rest, m::Rest::limit);
    // A move's target is held inside its bounds.
    m::Request r = move_to(9000, 1600, 8000);
    r.hi = 50;
    CHECK(s.submit(r).arm);
    s.run();
    CHECK_EQ(s.snap().position, 50);
    CHECK_EQ(s.snap().last_rest, m::Rest::reached);
}

// ---- §10.2 10: the range's ends ----

TEST(stepper_engine_overflow_corners_are_exact)
{
    // -1e9 -> +1e9 at a = 200,000, vmax = 10,000: the far distance saturates 2a x r, and every step is exact. The whole
    // 2e9 steps would take minutes under the sanitizers, so the start and the end run in full and the middle is the
    // planner at the extremes.
    {
        m::StepEngine e;
        REQUIRE(e.set_position(-m::kPositionLimit).has_value());
        REQUIRE(e.submit(move_to(m::kPositionLimit, 10000, 200000)).arm);
        uint64_t cruise = 0;
        for (int i = 0; i < 1'000'000; ++i) {
            const m::Tick t = e.on_alarm(0);
            REQUIRE(t.stepped);
            cruise += t.interval_us == 100 ? 1 : 0;
        }
        CHECK_EQ(e.snapshot().position, -m::kPositionLimit + 1'000'000);
        CHECK_EQ(e.speed_sq(), 100'000'000u);
        CHECK(cruise > 999'000);
    }
    m::Goal g;
    g.target = m::kPositionLimit;
    g.cap = m::kMaxSpeed;
    g.two_a = 2 * m::kMaxAccel;
    m::Plan p = m::decide(-m::kPositionLimit, 1, 100'000'000, g);
    CHECK_EQ(p.vsq, 100'000'000u);
    p = m::decide(m::kPositionLimit - 250, 1, 100'000'000, g);
    CHECK_EQ(p.vsq, 100'000'000u - 400'000u);  // the decel point: 250 steps from the end
    g.target = -m::kPositionLimit;
    p = m::decide(m::kPositionLimit, 1, 100'000'000, g);  // at the bound at full speed outward (bounds set against it)
    CHECK_EQ(p.vsq0, 0u);                                 // no room past it: a dead stop, the only way to keep it,
    CHECK_EQ(p.dir, -1);                                  // then back from rest toward the target
    CHECK_EQ(p.vsq, 400'000u);
    for (int32_t end : {m::kPositionLimit, -m::kPositionLimit}) {
        Sim s;
        s.record = false;
        REQUIRE(s.e.set_position(end - (end > 0 ? 1'000'000 : -1'000'000)).has_value());
        s.submit(move_to(end, 10000, 200000));
        s.run();
        CHECK_EQ(s.violations, 0u);
        CHECK_EQ(s.snap().position, end);
        CHECK_EQ(s.snap().last_rest, m::Rest::reached);
    }
    // The slowest corner, a = 10 and vmax = 10 over 10,000 steps, to the end.
    CHECK(ideal_move(0, 10000, 10, 10) < 0.002);
    // A jog near +-1e9 rests exactly on the implicit bound; requests beyond the range are clamped into it.
    for (int32_t sign : {1, -1}) {
        Sim s;
        s.record = false;
        REQUIRE(s.e.set_position(sign * (m::kPositionLimit - 5000)).has_value());
        s.submit(jog(sign * 10000, 200000, INT32_MIN, INT32_MAX));
        s.run();
        CHECK_EQ(s.violations, 0u);
        CHECK_EQ(s.snap().position, sign * m::kPositionLimit);
        CHECK_EQ(s.snap().last_rest, m::Rest::limit);
    }
    Sim c;
    m::Request r = move_to(INT32_MAX, UINT32_MAX, UINT32_MAX);
    c.submit(r);
    c.run(100);
    CHECK_EQ(c.snap().target, m::kPositionLimit);
    CHECK_EQ(c.violations, 0u);
}

// ---- §10.2 11-13: slips, faults, set_position ----

TEST(stepper_engine_late_alarms_slip_only_beyond_2ms)
{
    // 1.5 ms late at cruise (625 µs steps): no slip and no burst, the next step a whole interval after the late one.
    Sim s = cruising(300);
    const uint32_t vsq = s.e.speed_sq();
    s.alarm(1500);
    const int64_t late_at = s.now;
    s.alarm();
    CHECK(s.now - late_at >= 625);
    CHECK_EQ(s.snap().slips, 0u);
    CHECK_EQ(s.e.speed_sq(), vsq);
    // 5 ms late: one slip, the ramp restarts from rest toward the same target, which it reaches exactly.
    s.alarm(5000);
    CHECK_EQ(s.snap().slips, 1u);
    CHECK_EQ(s.steps.back().vsq0, 0u);
    CHECK_EQ(s.e.speed_sq(), 16000u);
    s.run();
    CHECK_EQ(s.violations, 0u);
    CHECK_EQ(s.snap().position, 1000);
    CHECK_EQ(s.snap().last_rest, m::Rest::reached);
    CHECK_EQ(s.snap().slips, 1u);  // of the motion that rested last
    // A late alarm at zero speed is no slip; a new motion starts with none.
    s.submit(move_to(990, 1600, 8000));
    CHECK_EQ(s.snap().slips, 0u);
    s.alarm(10'000);
    CHECK_EQ(s.snap().slips, 0u);
    s.run();
    CHECK_EQ(s.snap().position, 990);
}

TEST(stepper_engine_random_lateness_keeps_the_position)
{
    std::mt19937_64 rng(0x5EED0004);
    std::uniform_int_distribution<uint32_t> late(0, 6000);
    std::uniform_int_distribution<int> pct(0, 99);
    for (int i = 0; i < 50; ++i) {
        Sim s;
        s.submit(move_to(-3000 + i * 97, 2000 + i * 100, 4000 + i * 1000));
        uint32_t expected = 0;
        while (s.armed) {
            const uint32_t l = pct(rng) < 2 ? late(rng) : 0;
            expected += l > m::kSlipLateUs && s.e.speed_sq() != 0 ? 1 : 0;
            s.alarm(l);
        }
        CHECK_EQ(s.violations, 0u);
        CHECK_EQ(s.snap().position, -3000 + i * 97);
        CHECK_EQ(s.moved, -3000 + i * 97);
        CHECK_EQ(s.snap().last_rest, m::Rest::reached);
        CHECK_EQ(s.snap().slips, expected);
    }
}

TEST(stepper_engine_fault_rests_and_latches)
{
    Sim s = cruising(300);
    s.fault();
    m::Snapshot snap = s.snap();
    CHECK_EQ(snap.last_rest, m::Rest::fault);
    CHECK(snap.faulted);
    CHECK(!snap.running);
    CHECK_EQ(snap.speed, 0);
    CHECK_EQ(snap.position, 300);
    CHECK(!s.e.on_alarm(0).stepped);
    // Refused until cleared: nothing arms, nothing rests.
    for (const m::Request &r : {move_to(0, 1600, 8000), jog(100), stop(), halt()}) {
        const m::Start st = s.submit(r);
        CHECK(!st.arm && !st.rested_now);
    }
    CHECK_EQ(s.snap().rests, 1u);
    s.e.clear_fault();
    CHECK(!s.snap().faulted);
    CHECK(s.submit(move_to(0, 1600, 8000)).arm);
    s.run();
    CHECK_EQ(s.snap().position, 0);
    // A fault at rest latches without a rest.
    s.fault();
    CHECK(s.snap().faulted);
    CHECK_EQ(s.snap().rests, 2u);
    CHECK_EQ(s.snap().last_rest, m::Rest::reached);
}

TEST(stepper_engine_set_position_and_shape_only_at_rest)
{
    Sim s = cruising(10);
    CHECK(s.e.set_position(5) == fr::Status(std::unexpected(fr::Err::busy)));
    const uint8_t phase = s.e.phase();
    s.e.shape(0, true);  // ignored while running
    CHECK_EQ(s.e.phase(), phase);
    s.run();
    CHECK(s.e.set_position(m::kPositionLimit + 1) == fr::Status(std::unexpected(fr::Err::invalid_args)));
    CHECK(s.e.set_position(-7).has_value());
    CHECK_EQ(s.snap().position, -7);
    CHECK_EQ(s.snap().target, -7);
    // The phase follows the counted position and the shape (micro8 by default).
    CHECK_EQ(s.e.phase(), m::electrical_index(-7, 3, false));
    s.e.shape(1, true);
    CHECK_EQ(s.e.phase(), m::electrical_index(-7, 1, true));
    s.e.shape(9, false);  // beyond micro32: micro32
    CHECK_EQ(s.e.phase(), m::electrical_index(-7, 5, false));
    // Each step's tick carries the new position's phase.
    s.submit(move_to(20, 1600, 8000));
    while (s.armed) {
        const m::Tick t = s.e.on_alarm(0);
        if (!t.again) {
            break;
        }
        CHECK_EQ(t.phase, m::electrical_index(s.snap().position, 5, false));
    }
    CHECK_EQ(s.snap().position, 20);
}

// ---- Randomised sequences: retargets, reversals, jogs, stops and accel changes mid-motion ----

TEST(stepper_engine_random_single_retargets_are_exact)
{
    // From a random point of a random move, a random new target: beyond the stopping distance it lands with no
    // overshoot; inside it, it overshoots by exactly the stopping distance, turns at zero speed and lands.
    std::mt19937_64 rng(0x5EED0005);
    std::uniform_int_distribution<int32_t> dist(-4000, 4000);
    for (int i = 0; i < 2000; ++i) {
        const auto vmax = static_cast<uint32_t>(log_uniform(rng, 5, 10000));
        const auto accel = static_cast<uint32_t>(log_uniform(rng, 10, 200000));
        Sim s;
        s.submit(move_to(dist(rng), vmax, accel));
        s.run(std::uniform_int_distribution<uint64_t>(1, 3000)(rng));
        if (!s.armed) {
            continue;
        }
        const int32_t at = s.snap().position;
        const uint32_t vsq = s.e.speed_sq();
        const int8_t dir = s.steps.back().dir;
        const int32_t target = dist(rng);
        const auto vmax2 = static_cast<uint32_t>(log_uniform(rng, 5, 10000));
        const size_t from = s.steps.size();
        s.submit(move_to(target, vmax2, 0));
        s.run();
        REQUIRE_EQ(s.violations, 0u);
        CHECK_EQ(s.snap().position, target);
        CHECK_EQ(s.snap().rests, 1u);
        const int64_t ahead = (int64_t{target} - at) * dir;
        int64_t furthest = 0;
        for (size_t k = from; k < s.steps.size(); ++k) {
            furthest = std::max(furthest, (int64_t{s.steps[k].pos} - at) * dir);
        }
        if (uint64_t{vsq} <= uint64_t{s.two_a} * static_cast<uint64_t>(std::max<int64_t>(ahead, 0)) && ahead > 0) {
            CHECK(furthest <= ahead);
        } else if (vsq != 0) {
            CHECK_EQ(furthest, static_cast<int64_t>(ceil_div(vsq, s.two_a)));
        }
    }
}

TEST(stepper_engine_random_sequences_keep_every_invariant)
{
    // Moves, jogs both ways, stops and halts at random moments, with accel and vmax changes mid-motion and (one sequence
    // in three) alarms 2.5 ms late now and then: every step keeps Sim's invariants, nothing steps after a rest until a
    // request arms it, each rest is counted once, and a final move lands exactly where the signed steps say.
    std::mt19937_64 rng(0x5EED0006);
    std::uniform_int_distribution<int> pick(0, 99);
    std::uniform_int_distribution<int32_t> target(-5000, 5000);
    std::uniform_int_distribution<int32_t> speed(-6000, 6000);
    std::uniform_int_distribution<uint64_t> gap(0, 400);
    uint64_t total = 0;
    for (int seq = 0; seq < 300; ++seq) {
        Sim s;
        s.record = false;
        const bool lateness = seq % 3 == 0;
        for (int req = 0; req < 30; ++req) {
            const int k = pick(rng);
            // accel 0 keeps the running motion's; from rest the first one is the test's.
            uint32_t accel = pick(rng) < 30 ? static_cast<uint32_t>(log_uniform(rng, 10, 200000)) : 0u;
            if (accel == 0 && req == 0) {
                accel = 8000;
            }
            m::Request r;
            if (k < 40) {
                r = move_to(target(rng), static_cast<uint32_t>(log_uniform(rng, 2, 10000)), accel);
            } else if (k < 75) {
                r = jog(speed(rng), accel);
            } else if (k < 90) {
                r = stop();
            } else {
                r = halt();
            }
            s.submit(r);
            const uint64_t n = gap(rng);
            for (uint64_t i = 0; i < n && s.armed; ++i) {
                s.alarm(lateness && pick(rng) == 0 ? 2500 : 0);
            }
            if (!s.armed) {
                CHECK(!s.e.on_alarm(0).stepped);
                CHECK(!s.snap().running);
                CHECK_EQ(s.snap().speed, 0);
            }
        }
        const int32_t final_target = target(rng);
        s.submit(move_to(final_target, 3000, 0));
        s.run();
        CHECK_EQ(s.violations, 0u);
        CHECK_EQ(s.snap().position, final_target);
        CHECK_EQ(s.moved, static_cast<int64_t>(final_target));
        CHECK_EQ(s.snap().last_rest, m::Rest::reached);
        CHECK_EQ(s.snap().rests, s.rests_seen);
        total += s.taken();
    }
    std::printf("    %llu steps over 300 sequences\n", static_cast<unsigned long long>(total));
}
