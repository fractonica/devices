// Regression tests from the adversarial review of fr.stepper on the real target (design stepper-s1 D10-D11): the kept
// settings across a refused write and a reboot; a fault, halt or release that lands between the engine's rest and the
// service's look at it; the target a jog reports.
#include <cstdint>
#include <cstring>
#include <span>
#include <utility>
#include <vector>

#include "fr/services/stepper_service.hpp"
#include "tests/fake_core.hpp"
#include "tests/fake_stepper.hpp"
#include "tests/fixture_link.hpp"
#include "tests/scale_fakes.hpp"
#include "tests/test.hpp"

namespace {

using fr::StepperService;
using fr::cap::Stepper;
using fr::cap::StepperConfig;
using fr::cap::StepperDone;
using fr::cap::StepperDoneReason;
using fr::cap::StepperMotion;
using frt::FakeCore;
using frt::FakeSettings;
using frt::FakeStepper;
using frt::RecordingSink;

constexpr uint8_t kPort = 3;

/** FakeSettings whose fr_worker queue takes `room` more writes, then answers BUSY (a full queue). */
class FillingSettings final : public fr::hal::Settings
{
public:
    explicit FillingSettings(FakeSettings &store) : store_(store) {}
    std::expected<int32_t, fr::Err> get_i32(const char *key) override { return store_.get_i32(key); }
    fr::Status set_i32(const char *key, int32_t value) override
    {
        if (room == 0) {
            return std::unexpected(fr::Err::busy);
        }
        --room;
        return store_.set_i32(key, value);
    }
    fr::Status erase(std::span<const char *const> keys) override { return store_.erase(keys); }

    int room = 1000;

private:
    FakeSettings &store_;
};

struct Rig {
    explicit Rig(fr::hal::Settings &settings, StepperConfig cfg = {}) : sink(core), svc(drv, settings, cfg)
    {
        svc.attach(kPort, "motor", sink);
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
    size_t faults() const
    {
        size_t n = 0;
        for (const auto &e : sink.events()) {
            n += e.id == Stepper::kEventFault ? 1 : 0;
        }
        return n;
    }
    std::vector<std::pair<fr::TimeUs, int32_t>> i32s(uint8_t id) const
    {
        std::vector<std::pair<fr::TimeUs, int32_t>> out;
        for (const auto &e : sink.properties()) {
            if (e.id == id) {
                out.emplace_back(e.emitted, *fr::cap::decode_stepper_position_state(e.bytes));
            }
        }
        return out;
    }
    void settle_motion()
    {
        for (int t = 0; t < 20'000 && (svc.motion() == StepperMotion::moving || svc.motion() == StepperMotion::stopping);
             t += 10) {
            core.advance_ms(10);
        }
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

    FakeCore core;
    FakeStepper drv;
    RecordingSink sink;
    StepperService svc;
};

}  // namespace

// D11: a reboot after a configure that did not finish never loads a mix of old and new keys. m is the commit mark: it
// is unmarked before the other keys change, so a configure whose second key is refused (fr_worker's queue full) leaves
// no valid m, and the next boot runs the build's configuration.
TEST(stepper_review_a_refused_configure_never_boots_a_mixed_power_setting)
{
    FakeSettings store;
    {
        FillingSettings s(store);
        Rig r(s);
        REQUIRE(r.start());
        // Kept: 100 mA x 10 ohm / 5,000 mV = 200 permille.
        REQUIRE(r.svc.configure({.has_coil_ohm = true, .coil_ohm = 10}).has_value());
        // A 10 V supply and a 20 ohm coil: still 200 permille. m (unmarked) and key p (coil_ohm) are queued, key r
        // (supply_mv) refused.
        s.room = 2;
        CHECK(r.svc.configure({.has_coil_ohm = true, .coil_ohm = 20, .has_supply_mv = true, .supply_mv = 10000})
                  .error() == fr::Err::failed);
        CHECK_EQ(store.kept["p3m"], StepperService::kUnmarked);
    }
    FillingSettings s(store);
    Rig again(s);
    REQUIRE(again.start());
    // The build's configuration (10 ohm, 5,000 mV: 200 permille), not 20 ohm with 5,000 mV (400: twice the duty on the
    // 10 V supply). An unmarked m is not counted as a value ignored.
    CHECK_EQ(again.svc.run_permille(), 200);
    CHECK_EQ(again.svc.coil_ohm(), 10);
    CHECK_EQ(again.svc.supply_mv(), 5000);
    CHECK_EQ(again.svc.settings_ignored(), 0u);
    // The next configure writes every key, m last, and the boot after it loads them.
    store.log.clear();
    REQUIRE(again.svc.configure({.has_coil_ohm = true, .coil_ohm = 20, .has_supply_mv = true, .supply_mv = 10000})
                .has_value());
    REQUIRE_EQ(store.log.size(), 7u);
    CHECK(store.log[6].rfind("set p3m=1", 0) == 0);
    FillingSettings s3(store);
    Rig third(s3);
    REQUIRE(third.start());
    CHECK_EQ(third.svc.coil_ohm(), 20);
    CHECK_EQ(third.svc.supply_mv(), 10000);
    CHECK_EQ(third.svc.run_permille(), 200);
}

// D10: done {fault} is for a motion that was running when the driver cut. A move whose engine has already rested (the
// poll has not seen it yet, up to kPollUs) and then faults while holding ended reached, at rest: its done is reached
// and the cut at rest cannot lose a step, so position_known stays true.
TEST(stepper_review_a_fault_after_the_rest_keeps_the_reached_done_and_the_position)
{
    FakeSettings store;
    Rig r(store);
    REQUIRE(r.start());
    REQUIRE(r.svc.zero({}).has_value());
    REQUIRE(r.svc.move_to({.position = 400}).has_value());
    // Step the clock until the engine rests while the service still says moving (its poll comes later).
    for (int i = 0; i < 2'000'000 && r.drv.engine.snapshot().running; ++i) {
        r.core.advance_us(50);
    }
    REQUIRE(!r.drv.engine.snapshot().running);
    REQUIRE(r.svc.motion() == StepperMotion::moving);
    CHECK(r.drv.engine.snapshot().last_rest == fr::motion::Rest::reached);
    r.drv.raise_fault();
    r.core.run_ready();
    const auto d = r.dones();
    REQUIRE_EQ(d.size(), 1u);
    CHECK(d[0].reason == StepperDoneReason::reached);
    CHECK_EQ(d[0].position, 400);
    CHECK(r.svc.position_known());  // not judged from the last poll's speed, bounded up: the cut came at rest
    CHECK(r.svc.motion() == StepperMotion::fault);
    CHECK_EQ(r.faults(), 1u);
}

// The same window for halt and release: the service looks (still moving), the step ISR rests the move on its target,
// then the driver runs the command, which finds nothing running. The move's done is reached, not halted or released.
TEST(stepper_review_a_halt_or_release_after_the_rest_keeps_the_reached_done)
{
    for (const bool halt : {true, false}) {
        FakeSettings store;
        Rig r(store);
        REQUIRE(r.start());
        REQUIRE(r.svc.zero({}).has_value());
        REQUIRE(r.svc.move_to({.position = 400}).has_value());
        // Until the last step is taken: the alarm at its end rests the move.
        for (int i = 0; i < 2'000'000 && r.drv.engine.snapshot().position != 400; ++i) {
            r.core.advance_us(50);
        }
        REQUIRE(r.drv.engine.snapshot().running);
        r.drv.alarm_before_command = true;
        REQUIRE((halt ? r.svc.halt() : r.svc.release()).has_value());
        CHECK(!r.drv.engine.snapshot().running);
        const auto d = r.dones();
        REQUIRE_EQ(d.size(), 1u);
        CHECK(d[0].reason == StepperDoneReason::reached);
        CHECK_EQ(d[0].target, 400);
        CHECK(r.svc.position_known());
        CHECK(r.svc.motion() == (halt ? StepperMotion::holding : StepperMotion::released));
        r.core.advance_ms(100);
        CHECK_EQ(r.dones().size(), 1u);
    }
}

// D2: target is where the running move ends. A jog or a stop plans no end, so the target follows the position in the
// reports (as the fake board does, and the panel's "going to" mark expects), while a stopped move's done still carries
// the target it had.
TEST(stepper_review_a_jog_reports_the_position_as_its_target)
{
    FakeSettings store;
    Rig r(store);
    REQUIRE(r.start());
    REQUIRE(r.svc.move_to({.position = 5000}).has_value());
    CHECK_EQ(r.svc.target(), 5000);
    r.core.advance_ms(100);
    // The jog replaces the move: the target is the position at once, and follows it.
    REQUIRE(r.svc.jog({.speed_hz = 400}).has_value());
    CHECK_EQ(r.svc.target(), r.svc.position());
    r.core.advance_ms(500);
    CHECK(r.svc.position() > 100);
    // With each (paced) position report.
    const auto t = r.i32s(Stepper::kPropTarget);
    const auto p = r.i32s(Stepper::kPropPosition);
    REQUIRE(t.size() >= 3u);
    CHECK_EQ(t.back().second, p.back().second);
    CHECK_EQ(t.back().first, p.back().first);
    CHECK_EQ(r.svc.target(), p.back().second);
    REQUIRE(r.svc.stop().has_value());
    r.settle_motion();
    CHECK_EQ(r.svc.target(), r.svc.position());
    REQUIRE_EQ(r.dones().size(), 1u);
    CHECK(r.dones()[0].reason == StepperDoneReason::stopped);
    CHECK_EQ(r.dones()[0].target, r.dones()[0].position);

    // A stopped move: the target follows the position while it stops; its done says the target it had.
    REQUIRE(r.svc.move_to({.position = 9000}).has_value());
    r.core.advance_ms(200);
    REQUIRE(r.svc.stop().has_value());
    CHECK_EQ(r.svc.target(), r.svc.position());
    r.settle_motion();
    REQUIRE_EQ(r.dones().size(), 2u);
    CHECK_EQ(r.dones()[1].target, 9000);
    CHECK_EQ(r.svc.target(), r.dones()[1].position);
}
