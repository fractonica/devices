// StepperService against FakeCore, a FakeStepper around the real StepEngine and in-memory settings (design stepper-s1
// D10-D12, §10 item 4): boot, moves and their done at the engine's time, run power then hold power then the idle
// release, retargets, stop, halt and release, jogs, faults and their back-off, the arguments, configure with its keys,
// a reboot, the step-mode rescale and reset, the power arithmetic, the hub-silence rule and the reports.
#include <cstdint>
#include <string>
#include <vector>

#include "fr/motion/step_engine.hpp"
#include "fr/services/stepper_service.hpp"
#include "tests/fake_core.hpp"
#include "tests/fake_stepper.hpp"
#include "tests/fixture_link.hpp"
#include "tests/scale_fakes.hpp"
#include "tests/test.hpp"

namespace {

using fr::StepperService;
using fr::TimeUs;
using fr::cap::Stepper;
using fr::cap::StepperConfig;
using fr::cap::StepperDone;
using fr::cap::StepperDoneReason;
using fr::cap::StepperFault;
using fr::cap::StepperFaultCause;
using fr::cap::StepperMotion;
using fr::cap::StepperStepMode;
using frt::FakeCore;
using frt::FakeSettings;
using frt::FakeStepper;
using frt::RecordingSink;

constexpr uint8_t kPort = 3;

struct Rig {
    explicit Rig(StepperConfig cfg = {}, FakeSettings *shared = nullptr, uint8_t max_log2 = 5)
        : settings(shared != nullptr ? *shared : own), drv(max_log2), sink(core), svc(drv, settings, cfg)
    {
        svc.attach(kPort, "motor", sink);
        // A live hub on this rig's clock, with a session (the hub-silence rule reads it).
        frt::fixture_link() = {};
        frt::fixture_link().core = &core;
    }
    bool start()
    {
        if (!svc.init(core)) {
            return false;
        }
        core.run_ready();
        return true;
    }

    std::vector<StepperDone> dones() const
    {
        std::vector<StepperDone> out;
        for (const auto &e : sink.events()) {
            if (e.id == Stepper::kEventDone) {
                out.push_back(*fr::cap::decode_stepper_done(e.bytes));
            }
        }
        return out;
    }
    std::vector<TimeUs> done_times() const
    {
        std::vector<TimeUs> out;
        for (const auto &e : sink.events()) {
            if (e.id == Stepper::kEventDone) {
                out.push_back(e.emitted);
            }
        }
        return out;
    }
    std::vector<StepperFault> faults() const
    {
        std::vector<StepperFault> out;
        for (const auto &e : sink.events()) {
            if (e.id == Stepper::kEventFault) {
                out.push_back(*fr::cap::decode_stepper_fault(e.bytes));
            }
        }
        return out;
    }
    /** The reports of an i32 property (position, target, speed_hz, limit_min, limit_max), with their times. */
    std::vector<std::pair<TimeUs, int32_t>> i32s(uint8_t id) const
    {
        std::vector<std::pair<TimeUs, int32_t>> out;
        for (const auto &e : sink.properties()) {
            if (e.id == id) {
                out.emplace_back(e.emitted, *fr::cap::decode_stepper_position_state(e.bytes));
            }
        }
        return out;
    }
    std::vector<uint64_t> uints(uint8_t id) const
    {
        std::vector<uint64_t> out;
        for (const auto &e : sink.properties()) {
            if (e.id == id) {
                out.push_back(frt::field_u(e.bytes, 1));
            }
        }
        return out;
    }
    StepperMotion reported_motion() const
    {
        const auto m = uints(Stepper::kPropMotion);
        return m.empty() ? StepperMotion::released : static_cast<StepperMotion>(m.back());
    }
    /** Runs until the motion is at rest (or `ms` pass). */
    void settle_motion(uint32_t ms = 20'000)
    {
        const auto running = [this] {
            return svc.motion() == StepperMotion::moving || svc.motion() == StepperMotion::stopping;
        };
        for (uint32_t t = 0; t < ms && running(); t += 10) {
            core.advance_ms(10);
        }
    }

    FakeCore core;
    FakeSettings own;
    FakeSettings &settings;
    FakeStepper drv;
    RecordingSink sink;
    StepperService svc;
};

/** The engine's own time for a move from rest (the sum of its step intervals), at micro8 by default. */
TimeUs engine_time(int32_t from, int32_t to, uint32_t vmax, uint32_t accel, uint8_t log2 = 3)
{
    fr::motion::StepEngine e;
    e.shape(log2, false);
    (void)e.set_position(from);
    fr::motion::Request r;
    r.kind = fr::motion::Request::Kind::move_to;
    r.target = to;
    r.vmax = vmax;
    r.accel = accel;
    (void)e.submit(r);
    TimeUs t = 0;
    for (;;) {
        const fr::motion::Tick k = e.on_alarm(0);
        if (!k.again) {
            return t;
        }
        t += k.interval_us;
    }
}

TEST(stepper_boot_is_released_and_unknown)
{
    Rig r;
    REQUIRE(r.start());
    CHECK(r.svc.motion() == StepperMotion::released);
    CHECK_EQ(r.svc.position(), 0);
    CHECK_EQ(r.svc.target(), 0);
    CHECK(!r.svc.position_known());
    CHECK(r.drv.energised.empty());
    CHECK(!r.drv.awake);
    CHECK_EQ(r.drv.inits, 1);
    CHECK_EQ(r.core.timers_used(), 2u);  // the fake's step alarm and the service's one timer
    REQUIRE_EQ(r.drv.shapes.size(), 1u);
    CHECK_EQ(r.drv.shapes[0].microsteps_log2, 3);
    CHECK_EQ(r.drv.shapes[0].run_permille, 200);
    CHECK(r.sink.log.empty());
    CHECK(r.svc.traits().microstep);
    Rig half({}, nullptr, 1);
    CHECK(!half.svc.traits().microstep);
}

TEST(stepper_init_refuses_a_bad_config)
{
    StepperConfig crossed{};
    crossed.limit_min = 10;
    crossed.limit_max = 10;
    Rig a(crossed);
    CHECK(a.svc.init(a.core).error() == fr::Err::invalid_args);
    CHECK_EQ(a.drv.inits, 1);  // the driver first: its coils are off whatever follows
    a.drv.inject_fault();       // its fault path still runs; the refused service ignores it
    a.core.run_ready();
    CHECK(a.sink.log.empty());
    Rig b({}, nullptr, 1);     // micro8 on a half-step driver
    CHECK(b.svc.init(b.core).error() == fr::Err::invalid_args);
}

TEST(stepper_move_to_runs_then_holds_then_releases)
{
    Rig r;
    REQUIRE(r.start());
    const TimeUs t0 = r.core.now();
    CHECK(r.svc.move_to({.position = 160}).has_value());
    CHECK(r.svc.motion() == StepperMotion::moving);
    CHECK(r.reported_motion() == StepperMotion::moving);
    CHECK_EQ(r.svc.target(), 160);
    REQUIRE(!r.drv.energised.empty());
    CHECK_EQ(r.drv.energised[0], 200);  // run power, from the driver's command
    r.settle_motion();
    const auto d = r.dones();
    REQUIRE_EQ(d.size(), 1u);
    CHECK(d[0].reason == StepperDoneReason::reached);
    CHECK_EQ(d[0].position, 160);
    CHECK_EQ(d[0].target, 160);
    CHECK_EQ(d[0].slips, 0);
    // At the engine's time: its rest, seen by the next poll.
    const TimeUs rest = t0 + FakeStepper::kWakeUs + engine_time(0, 160, 1600, 8000);
    const TimeUs at = r.done_times()[0];
    CHECK(at >= rest);
    CHECK(at <= rest + StepperService::kPollUs);
    CHECK_EQ(r.i32s(Stepper::kPropPosition).back().second, 160);
    CHECK_EQ(r.i32s(Stepper::kPropSpeedHz).back().second, 0);
    CHECK(r.svc.motion() == StepperMotion::holding);
    CHECK_EQ(r.drv.steps, 160u);

    r.core.advance_to(at + StepperService::kSettleUs - 1000);
    CHECK_EQ(r.drv.permille, 200);  // settling at run power
    r.core.advance_to(at + StepperService::kSettleUs + 1000);
    CHECK_EQ(r.drv.permille, 60);  // hold power: 30 % of run
    r.core.advance_to(at + 999'000);
    CHECK(r.drv.awake);
    r.core.advance_to(at + 1'001'000);
    CHECK(!r.drv.awake);
    CHECK(r.svc.motion() == StepperMotion::released);
    CHECK(r.reported_motion() == StepperMotion::released);
    CHECK_EQ(r.dones().size(), 1u);
}

TEST(stepper_release_ms_zero_never_releases_and_hold_is_indefinite)
{
    StepperConfig cfg{};
    cfg.release_ms = 0;
    Rig r(cfg);
    REQUIRE(r.start());
    CHECK(r.svc.move_by({.steps = 40}).has_value());
    r.settle_motion();
    r.core.advance_ms(30'000);
    CHECK(r.svc.motion() == StepperMotion::holding);
    CHECK_EQ(r.drv.permille, 60);

    Rig h;
    REQUIRE(h.start());
    CHECK(h.svc.hold().has_value());
    CHECK(h.svc.motion() == StepperMotion::holding);
    CHECK_EQ(h.drv.permille, 60);
    h.core.advance_ms(30'000);
    CHECK(h.svc.motion() == StepperMotion::holding);
    CHECK(h.drv.awake);
    CHECK(h.svc.hold().has_value());  // held already: nothing to do
    CHECK(h.sink.events().empty());
    // A hold during a motion's release countdown holds on.
    CHECK(h.svc.move_by({.steps = 8}).has_value());
    h.settle_motion();
    CHECK(h.svc.hold().has_value());
    h.core.advance_ms(5000);
    CHECK(h.svc.motion() == StepperMotion::holding);
}

TEST(stepper_retarget_gives_one_done_and_move_by_adds_to_the_target)
{
    Rig r;
    REQUIRE(r.start());
    CHECK(r.svc.move_to({.position = 1000}).has_value());
    r.core.advance_ms(50);
    CHECK(r.svc.move_to({.position = 400}).has_value());
    r.settle_motion();
    auto d = r.dones();
    REQUIRE_EQ(d.size(), 1u);
    CHECK(d[0].reason == StepperDoneReason::reached);
    CHECK_EQ(d[0].position, 400);
    CHECK_EQ(d[0].target, 400);

    Rig b;
    REQUIRE(b.start());
    CHECK(b.svc.move_by({.steps = 100}).has_value());
    b.core.advance_ms(5);
    CHECK(b.svc.move_by({.steps = 100}).has_value());
    CHECK_EQ(b.svc.target(), 200);
    b.settle_motion();
    d = b.dones();
    REQUIRE_EQ(d.size(), 1u);
    CHECK_EQ(d[0].position, 200);
    // At rest, from the position.
    CHECK(b.svc.move_by({.steps = -50}).has_value());
    b.settle_motion();
    CHECK_EQ(b.dones().back().position, 150);
}

TEST(stepper_stop_halt_release_while_moving)
{
    Rig s;
    REQUIRE(s.start());
    CHECK(s.svc.move_to({.position = 5000}).has_value());
    s.core.advance_ms(200);
    CHECK(s.svc.stop().has_value());
    CHECK(s.svc.motion() == StepperMotion::stopping);
    s.settle_motion();
    auto d = s.dones();
    REQUIRE_EQ(d.size(), 1u);
    CHECK(d[0].reason == StepperDoneReason::stopped);
    CHECK(d[0].position < 5000);
    CHECK_EQ(d[0].target, 5000);  // the target it had
    CHECK_EQ(s.svc.target(), d[0].position);
    CHECK(s.svc.motion() == StepperMotion::holding);

    Rig h;
    REQUIRE(h.start());
    CHECK(h.svc.zero({}).has_value());
    CHECK(h.svc.move_to({.position = 5000}).has_value());
    h.core.advance_ms(100);
    CHECK(h.svc.speed_hz() > 80);
    CHECK(h.svc.halt().has_value());
    d = h.dones();
    REQUIRE_EQ(d.size(), 1u);  // at once
    CHECK(d[0].reason == StepperDoneReason::halted);
    CHECK(!h.svc.position_known());  // above start_hz
    const uint64_t steps = h.drv.steps;
    h.core.advance_ms(500);
    CHECK_EQ(h.drv.steps, steps);
    CHECK(h.svc.motion() == StepperMotion::holding);
    CHECK_EQ(h.dones().size(), 1u);

    Rig slow;
    REQUIRE(slow.start());
    CHECK(slow.svc.zero({}).has_value());
    CHECK(slow.svc.move_to({.position = 5000, .has_speed_hz = true, .speed_hz = 50}).has_value());
    slow.core.advance_ms(500);
    CHECK(slow.svc.halt().has_value());
    CHECK(slow.svc.position_known());  // at or below start_hz: no step lost

    Rig rel;
    REQUIRE(rel.start());
    CHECK(rel.svc.zero({}).has_value());
    CHECK(rel.svc.move_to({.position = 5000}).has_value());
    rel.core.advance_ms(100);
    CHECK(rel.svc.release().has_value());
    d = rel.dones();
    REQUIRE_EQ(d.size(), 1u);
    CHECK(d[0].reason == StepperDoneReason::released);
    CHECK(!rel.svc.position_known());
    CHECK(rel.svc.motion() == StepperMotion::released);
    CHECK(!rel.drv.awake);
    rel.core.advance_ms(500);
    CHECK_EQ(rel.dones().size(), 1u);

    // At rest: OK, nothing to do, no event.
    Rig idle;
    REQUIRE(idle.start());
    CHECK(idle.svc.stop().has_value());
    CHECK(idle.svc.halt().has_value());
    CHECK(idle.svc.release().has_value());
    CHECK(idle.sink.log.empty());
}

TEST(stepper_jog_seconds_ends_elapsed_and_jog_zero_stops)
{
    Rig r;
    REQUIRE(r.start());
    const TimeUs t0 = r.core.now();
    CHECK(r.svc.jog({.speed_hz = 400, .seconds = 1}).has_value());
    r.core.advance_ms(900);
    CHECK(r.svc.motion() == StepperMotion::moving);
    CHECK_EQ(r.svc.speed_hz(), 400);
    r.core.advance_ms(120);
    CHECK(r.svc.motion() == StepperMotion::stopping);
    r.settle_motion();
    auto d = r.dones();
    REQUIRE_EQ(d.size(), 1u);
    CHECK(d[0].reason == StepperDoneReason::elapsed);
    CHECK_EQ(d[0].target, d[0].position);
    CHECK(r.done_times()[0] >= t0 + 1'000'000);

    Rig z;
    REQUIRE(z.start());
    CHECK(z.svc.jog({.speed_hz = -400}).has_value());
    z.core.advance_ms(300);
    CHECK(z.svc.jog({.speed_hz = 0}).has_value());
    CHECK(z.svc.motion() == StepperMotion::stopping);
    z.settle_motion();
    d = z.dones();
    REQUIRE_EQ(d.size(), 1u);
    CHECK(d[0].reason == StepperDoneReason::stopped);
    CHECK(d[0].position < 0);
}

TEST(stepper_fault_mid_move_and_its_back_off)
{
    Rig r;
    REQUIRE(r.start());
    CHECK(r.svc.zero({}).has_value());
    CHECK(r.svc.move_to({.position = 5000}).has_value());
    r.core.advance_ms(150);
    r.drv.raise_fault();
    r.core.run_ready();
    const auto f = r.faults();
    REQUIRE_EQ(f.size(), 1u);
    CHECK(f[0].cause == StepperFaultCause::driver);
    CHECK_EQ(f[0].recent, 1);
    CHECK_EQ(f[0].position, r.svc.position());
    const auto d = r.dones();
    REQUIRE_EQ(d.size(), 1u);
    CHECK(d[0].reason == StepperDoneReason::fault);
    CHECK(r.svc.motion() == StepperMotion::fault);
    CHECK(r.reported_motion() == StepperMotion::fault);
    CHECK(!r.svc.position_known());
    CHECK(!r.drv.awake);

    r.drv.clear_line();
    r.core.advance_ms(500);
    CHECK(r.svc.hold().error() == fr::Err::busy);  // within 1 s
    CHECK(r.svc.move_by({.steps = 10}).error() == fr::Err::busy);
    r.core.advance_ms(600);
    CHECK(r.svc.hold().has_value());
    CHECK(r.svc.motion() == StepperMotion::holding);
    CHECK_EQ(r.drv.clears, 1);
    CHECK_EQ(r.drv.permille, 60);
}

TEST(stepper_clear_fault_busy_while_the_line_is_low)
{
    Rig r;
    REQUIRE(r.start());
    CHECK(r.svc.hold().has_value());
    r.core.advance_ms(5);  // past the wake, when nFAULT edges count
    r.drv.raise_fault();
    r.core.run_ready();
    CHECK(r.svc.motion() == StepperMotion::fault);
    CHECK(r.dones().empty());  // nothing was moving
    r.core.advance_ms(1500);
    CHECK(r.svc.hold().error() == fr::Err::busy);  // nFAULT still low
    CHECK(r.svc.move_to({.position = 10}).error() == fr::Err::busy);
    r.drv.clear_line();
    CHECK(r.svc.hold().has_value());
    // release clears a fault without energising.
    r.core.advance_ms(5);
    r.drv.raise_fault();
    r.core.run_ready();
    r.drv.clear_line();
    CHECK(r.svc.release().has_value());
    CHECK(r.svc.motion() == StepperMotion::released);
    CHECK(!r.drv.awake);
    CHECK(!r.drv.snapshot().faulted);
}

TEST(stepper_three_faults_in_a_minute_back_off_for_a_minute)
{
    Rig r;
    REQUIRE(r.start());
    for (int i = 0; i < 3; ++i) {
        CHECK(r.svc.hold().has_value());
        r.core.advance_ms(5);
        r.drv.raise_fault();
        r.core.run_ready();
        r.drv.clear_line();
        r.core.advance_ms(1100);
    }
    const auto f = r.faults();
    REQUIRE_EQ(f.size(), 3u);
    CHECK_EQ(f[2].recent, 3);
    CHECK(r.svc.hold().error() == fr::Err::busy);
    r.core.advance_ms(57'000);
    CHECK(r.svc.hold().error() == fr::Err::busy);
    r.core.advance_ms(2'000);
    CHECK(r.svc.hold().has_value());
    // The window slides: a fault more than a minute after the others counts alone.
    r.core.advance_ms(61'000);
    r.drv.raise_fault();
    r.core.run_ready();
    CHECK_EQ(r.faults().back().recent, 1);
}

TEST(stepper_a_fault_still_there_at_the_wake_faults_again)
{
    Rig r;
    REQUIRE(r.start());
    CHECK(r.svc.move_to({.position = 100}).has_value());
    r.core.advance_ms(100);
    r.drv.raise_fault();
    r.core.run_ready();
    r.drv.clear_line();
    r.core.advance_ms(1100);
    CHECK(r.svc.move_to({.position = 50}).has_value());  // clears, then wakes
    r.drv.line_low = true;                                // back during the wake: the wake alarm reads it
    r.core.advance_ms(5);
    CHECK_EQ(r.faults().size(), 2u);
    CHECK(r.svc.motion() == StepperMotion::fault);
}

#if FR_TEST_HOOKS
TEST(stepper_inject_fault_runs_the_fault_path)
{
    Rig r;
    REQUIRE(r.start());
    CHECK(r.svc.inject_fault().has_value());
    r.core.run_ready();
    const auto f = r.faults();
    REQUIRE_EQ(f.size(), 1u);
    CHECK(f[0].cause == StepperFaultCause::injected);
    CHECK(r.svc.motion() == StepperMotion::fault);
    CHECK(r.svc.hold().error() == fr::Err::busy);
    r.core.advance_ms(1100);
    CHECK(r.svc.hold().has_value());
    // Through the generated dispatch too.
    fr::cap::StaticReply<> reply;
    CHECK(r.svc.dispatch(Stepper::kCmdInjectFault, {}, reply).has_value());
    r.core.run_ready();
    CHECK_EQ(r.faults().size(), 2u);
}
#endif

TEST(stepper_arguments)
{
    Rig r;
    REQUIRE(r.start());
    CHECK(r.svc.move_to({.position = 10, .has_speed_hz = true, .speed_hz = 1601}).error() == fr::Err::invalid_args);
    CHECK(r.svc.move_to({.position = 10, .has_accel = true, .accel = 8001}).error() == fr::Err::invalid_args);
    CHECK(r.svc.zero({.position = 5}).has_value());
    CHECK(r.svc.move_by({.steps = 1'000'000'000}).error() == fr::Err::invalid_args);  // beyond 1e9
    CHECK(r.svc.jog({.speed_hz = -1601}).error() == fr::Err::invalid_args);

    Rig l;
    REQUIRE(l.start());
    CHECK(l.svc.configure({.has_limits = true, .limits = true, .has_limit_min = true, .limit_min = -100,
                           .has_limit_max = true, .limit_max = 100})
              .has_value());
    CHECK(l.svc.move_to({.position = 200}).error() == fr::Err::invalid_args);
    CHECK(l.svc.move_to({.position = 50}).error() == fr::Err::busy);  // the position is not known
    CHECK(l.svc.jog({.speed_hz = 100}).error() == fr::Err::busy);
    CHECK(l.svc.zero({}).has_value());
    CHECK(l.svc.position_known());
    CHECK(l.svc.move_to({.position = 50}).has_value());
    l.settle_motion();
    CHECK_EQ(l.dones().back().position, 50);
    // A jog stops exactly on the limit.
    CHECK(l.svc.jog({.speed_hz = 400}).has_value());
    l.settle_motion();
    CHECK(l.dones().back().reason == StepperDoneReason::limit);
    CHECK_EQ(l.dones().back().position, 100);
    // At the limit already: done limit at once.
    const size_t n = l.dones().size();
    CHECK(l.svc.jog({.speed_hz = 400}).has_value());
    REQUIRE_EQ(l.dones().size(), n + 1);
    CHECK(l.dones().back().reason == StepperDoneReason::limit);

    // A move to where it rests: done reached at once, nothing driven.
    Rig s;
    REQUIRE(s.start());
    CHECK(s.svc.move_to({.position = 0}).has_value());
    REQUIRE_EQ(s.dones().size(), 1u);
    CHECK(s.dones()[0].reason == StepperDoneReason::reached);
    CHECK(s.drv.energised.empty());
    CHECK(s.svc.motion() == StepperMotion::released);
    CHECK(s.svc.move_by({.steps = 0}).has_value());
    CHECK_EQ(s.dones().size(), 2u);
}

TEST(stepper_zero_and_configure_busy_while_moving)
{
    Rig r;
    REQUIRE(r.start());
    CHECK(r.svc.move_to({.position = 1000}).has_value());
    r.core.advance_ms(50);
    CHECK(r.svc.zero({}).error() == fr::Err::busy);
    CHECK(r.svc.configure({.has_run_ma = true, .run_ma = 50}).error() == fr::Err::busy);
    CHECK(r.svc.reset_settings().error() == fr::Err::busy);
    r.settle_motion();
    // Holding: step_mode and reset_settings are BUSY unless released; the rest is fine.
    CHECK(r.svc.configure({.has_step_mode = true, .step_mode = StepperStepMode::micro16}).error() == fr::Err::busy);
    CHECK(r.svc.reset_settings().error() == fr::Err::busy);
    CHECK(r.svc.configure({.has_run_ma = true, .run_ma = 50}).has_value());
    CHECK(r.svc.zero({.position = 100}).has_value());
    CHECK_EQ(r.svc.position(), 100);
    CHECK_EQ(r.svc.target(), 100);
}

TEST(stepper_configure_writes_its_keys_m_last_and_a_reboot_loads_them)
{
    FakeSettings kept;
    Rig r({}, &kept);
    REQUIRE(r.start());
    CHECK(r.svc.configure({.has_coil_ohm = true, .coil_ohm = 20, .has_run_ma = true, .run_ma = 90}).has_value());
    // Nothing was kept: every key, m last.
    REQUIRE_EQ(kept.log.size(), 7u);
    CHECK(kept.log[0].rfind("set p3a=", 0) == 0);
    CHECK(kept.log[4].rfind("set p3lo=", 0) == 0);
    CHECK(kept.log[6].rfind("set p3m=", 0) == 0);
    CHECK_EQ(kept.kept["p3p"], 20 | 90 << 16);
    CHECK_EQ(kept.kept["p3m"], 1 | 3 << 8 | 30 << 16);
    CHECK_EQ(r.svc.coil_ohm(), 20);
    CHECK_EQ(r.uints(Stepper::kPropCoilOhm).back(), 20u);
    CHECK_EQ(r.uints(Stepper::kPropRunDutyPct).back(), 36u);  // 90 x 20 / 5000
    // Then only what changed, under an unmarked m, and m.
    kept.log.clear();
    CHECK(r.svc.configure({.has_accel = true, .accel = 4000, .has_invert = true, .invert = true}).has_value());
    REQUIRE_EQ(kept.log.size(), 3u);
    CHECK_EQ(kept.log[0], std::string("set p3m=0"));
    CHECK_EQ(kept.log[1], std::string("set p3a=4000"));
    CHECK(kept.log[2].rfind("set p3m=", 0) == 0);
    // m alone is one write.
    kept.log.clear();
    CHECK(r.svc.configure({.has_hold_pct = true, .hold_pct = 40}).has_value());
    REQUIRE_EQ(kept.log.size(), 1u);
    CHECK_EQ(kept.log[0], std::string("set p3m=") + std::to_string(1 | 3 << 8 | 1 << 11 | 40 << 16));

    Rig again({}, &kept);
    REQUIRE(again.start());
    CHECK_EQ(again.svc.coil_ohm(), 20);
    CHECK_EQ(again.svc.run_ma(), 90);
    CHECK_EQ(again.svc.accel(), 4000u);
    CHECK(again.svc.invert());
    CHECK_EQ(again.svc.run_permille(), 360);
    CHECK(again.drv.last_shape.invert);
    CHECK_EQ(again.drv.last_shape.run_permille, 360);

    // A refused write answers FAILED; the values stay for this boot.
    kept.refuse = fr::Err::busy;
    CHECK(again.svc.configure({.has_run_ma = true, .run_ma = 80}).error() == fr::Err::failed);
    CHECK_EQ(again.svc.run_ma(), 80);
}

TEST(stepper_corrupt_and_foreign_kept_values_are_ignored)
{
    FakeSettings kept;
    kept.kept["p3m"] = 1 | 3 << 8 | 30 << 16;
    kept.kept["p3a"] = 5;                 // below the range
    kept.kept["p3v"] = 800 | 20000 << 16;  // start_hz beyond it
    kept.kept["p3lo"] = 100;
    kept.kept["p3hi"] = 50;  // crosses lo: both ignored
    Rig r({}, &kept);
    REQUIRE(r.start());
    CHECK_EQ(r.svc.accel(), 8000u);
    CHECK_EQ(r.svc.max_speed_hz(), 800);
    CHECK_EQ(r.svc.start_hz(), 80);
    CHECK_EQ(r.svc.limit_min(), -1'000'000'000);
    CHECK_EQ(r.svc.limit_max(), 1'000'000'000);
    CHECK_EQ(r.svc.settings_ignored(), 3u);

    FakeSettings other;
    other.kept["p3m"] = 2 | 3 << 8;  // another layout: nothing loads
    other.kept["p3a"] = 1000;
    Rig o({}, &other);
    REQUIRE(o.start());
    CHECK_EQ(o.svc.accel(), 8000u);
}

TEST(stepper_step_mode_change_rescales)
{
    Rig r;
    REQUIRE(r.start());
    CHECK(r.svc.configure({.has_limit_min = true, .limit_min = -1000, .has_limit_max = true, .limit_max = 1000})
              .has_value());
    CHECK(r.svc.zero({.position = 101}).has_value());
    CHECK(r.svc.configure({.has_step_mode = true, .step_mode = StepperStepMode::micro16, .has_start_hz = true,
                           .start_hz = 100})
              .has_value());
    CHECK(r.svc.step_mode() == StepperStepMode::micro16);
    CHECK_EQ(r.svc.position(), 202);
    CHECK_EQ(r.svc.target(), 202);
    CHECK_EQ(r.svc.limit_min(), -2000);
    CHECK_EQ(r.svc.limit_max(), 2000);
    CHECK_EQ(r.svc.max_speed_hz(), 3200);
    CHECK_EQ(r.svc.accel(), 16000u);
    CHECK_EQ(r.svc.start_hz(), 100);  // given in the same call
    CHECK(r.svc.position_known());
    CHECK_EQ(r.drv.last_shape.microsteps_log2, 4);
    CHECK_EQ(r.i32s(Stepper::kPropPosition).back().second, 202);
    // And back down, rounding half away from zero.
    CHECK(r.svc.zero({.position = -3}).has_value());
    CHECK(r.svc.configure({.has_step_mode = true, .step_mode = StepperStepMode::half}).has_value());
    CHECK_EQ(r.svc.position(), 0);  // -3 / 8 = -0.375
    CHECK_EQ(r.svc.max_speed_hz(), 400);
    CHECK_EQ(StepperService::rescale(-12, -3), -2);  // -1.5
    CHECK_EQ(StepperService::rescale(12, -3), 2);
    CHECK_EQ(StepperService::rescale(600'000'000, 1), 1'000'000'000);  // clamped

    Rig coarse({.step_mode = StepperStepMode::half}, nullptr, 1);
    REQUIRE(coarse.start());
    CHECK(coarse.svc.configure({.has_step_mode = true, .step_mode = StepperStepMode::micro32}).error() ==
          fr::Err::invalid_args);
    CHECK(coarse.svc.configure({.has_step_mode = true, .step_mode = StepperStepMode::full}).has_value());

    CHECK(r.svc.configure({.has_limit_min = true, .limit_min = 5, .has_limit_max = true, .limit_max = 5}).error() ==
          fr::Err::invalid_args);
    CHECK(r.svc.configure({.has_limit_min = true, .limit_min = 1'000'000'000}).error() == fr::Err::invalid_args);
}

TEST(stepper_reset_settings_erases_m_and_applies_the_build)
{
    FakeSettings kept;
    Rig r({}, &kept);
    REQUIRE(r.start());
    CHECK(r.svc.configure({.has_step_mode = true, .step_mode = StepperStepMode::micro16, .has_run_ma = true,
                           .run_ma = 50})
              .has_value());
    CHECK(r.svc.zero({.position = 64}).has_value());
    kept.log.clear();
    CHECK(r.svc.reset_settings().has_value());
    REQUIRE_EQ(kept.log.size(), 1u);
    CHECK_EQ(kept.log[0], std::string("erase p3m"));
    CHECK(r.svc.step_mode() == StepperStepMode::micro8);
    CHECK_EQ(r.svc.run_ma(), 100);
    CHECK_EQ(r.svc.max_speed_hz(), 1600);
    CHECK_EQ(r.svc.position(), 32);  // the same shaft angle in eighth steps
    Rig again({}, &kept);
    REQUIRE(again.start());
    CHECK(again.svc.step_mode() == StepperStepMode::micro8);
    CHECK_EQ(again.svc.run_ma(), 100);
    // The keys left behind are rewritten by the next configure, not trusted.
    kept.log.clear();
    CHECK(again.svc.configure({.has_hold_pct = true, .hold_pct = 40}).has_value());
    CHECK_EQ(kept.log.size(), 7u);
    CHECK_EQ(kept.kept["p3v"], 1600 | 80 << 16);
}

TEST(stepper_power_arithmetic)
{
    CHECK_EQ(StepperService::run_permille_of(100, 10, 5000), 200);
    CHECK_EQ(StepperService::run_permille_of(200, 40, 5000), 1000);  // 1600, capped
    CHECK_EQ(StepperService::run_permille_of(1, 1, 10800), 1);      // never 0
    Rig d;
    REQUIRE(d.start());
    CHECK_EQ(d.svc.run_duty_pct(), 20);
    CHECK_EQ(d.svc.hold_permille(), 60);

    StepperConfig big{};
    big.coil_ohm = 40;
    big.run_ma = 200;
    big.hold_pct = 50;
    Rig b(big);
    REQUIRE(b.start());
    CHECK_EQ(b.svc.run_duty_pct(), 100);
    CHECK_EQ(b.svc.hold_permille(), 500);
    CHECK(b.svc.move_by({.steps = 20}).has_value());
    b.settle_motion();
    b.core.advance_ms(200);
    REQUIRE(b.drv.energised.size() >= 2);
    CHECK_EQ(b.drv.energised[0], 1000);
    CHECK_EQ(b.drv.energised.back(), 500);
    // A new power while holding applies at once.
    CHECK(b.svc.configure({.has_hold_pct = true, .hold_pct = 20}).has_value());
    CHECK_EQ(b.drv.permille, 200);
    CHECK_EQ(StepperService::run_permille_of(90, 20, 5000), 360);
    StepperConfig odd{};
    odd.coil_ohm = 7;
    odd.run_ma = 91;
    Rig o(odd);
    CHECK_EQ(o.svc.run_permille(), 127);
    CHECK_EQ(o.svc.run_duty_pct(), 13);  // rounded up
}

TEST(stepper_hub_silence_stops_a_hub_motion)
{
    Rig r;
    REQUIRE(r.start());
    // A slow ramp (2 s from 400 to rest), so the stop is seen decelerating.
    CHECK(r.svc.jog({.speed_hz = 400, .has_accel = true, .accel = 200}).has_value());
    r.core.advance_ms(3000);
    frt::fixture_link().hub_stops();
    r.core.advance_ms(9'900);
    CHECK(r.svc.motion() == StepperMotion::moving);
    r.core.advance_ms(200);
    CHECK(r.svc.motion() == StepperMotion::stopping);  // decelerated, not halted
    r.settle_motion();
    auto d = r.dones();
    REQUIRE_EQ(d.size(), 1u);
    CHECK(d[0].reason == StepperDoneReason::hub_lost);
    r.core.advance_ms(1100);
    CHECK(r.svc.motion() == StepperMotion::released);  // the idle release follows

    Rig w;
    REQUIRE(w.start());
    CHECK(w.svc.jog({.speed_hz = -400}).has_value());
    w.core.advance_ms(500);
    frt::fixture_link().epoch = 42;  // a WELCOME of another hub run
    w.core.advance_ms(40);
    CHECK(w.svc.motion() == StepperMotion::stopping);
    w.settle_motion();
    REQUIRE_EQ(w.dones().size(), 1u);
    CHECK(w.dones()[0].reason == StepperDoneReason::hub_lost);

    // Without a hub session at the start (a local app), the hub's silence does not end it.
    Rig l;
    REQUIRE(l.start());
    frt::fixture_link().session = false;
    frt::fixture_link().hub_stops();
    CHECK(l.svc.jog({.speed_hz = 400}).has_value());
    l.core.advance_ms(30'000);
    CHECK(l.svc.motion() == StepperMotion::moving);
    CHECK(l.dones().empty());
}

TEST(stepper_reports_are_paced_while_moving_and_exact_at_rest)
{
    Rig r;
    REQUIRE(r.start());
    CHECK(r.svc.jog({.speed_hz = 1000}).has_value());
    r.core.advance_ms(500);
    r.sink.clear();
    r.core.advance_ms(2000);
    const auto pos = r.i32s(Stepper::kPropPosition);
    CHECK(pos.size() >= 19u);
    CHECK(pos.size() <= 21u);  // report_hz 10
    for (size_t i = 1; i < pos.size(); ++i) {
        CHECK(pos[i].first - pos[i - 1].first >= 100'000);
    }
    CHECK(r.svc.stop().has_value());
    r.settle_motion();
    const auto end = r.i32s(Stepper::kPropPosition);
    CHECK_EQ(end.back().second, r.svc.position());
    CHECK_EQ(end.back().second, r.dones().back().position);
    CHECK_EQ(r.i32s(Stepper::kPropSpeedHz).back().second, 0);
    CHECK_EQ(r.svc.speed_hz(), 0);
}

}  // namespace
