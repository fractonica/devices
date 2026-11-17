// A hal::Stepper for StepperService's tests (design stepper-s1 §10 item 4): the real fr::motion::StepEngine, whose step
// "ISR" is a FakeCore timer armed as drv8833_stepper arms its gptimer (absolute due times, no catch-up bursts, a wake of
// kWakeUs before the first step from asleep, nFAULT read at the wake) and whose fault "ISR" cuts and updates an input
// slot, so the service's on_fault runs on the core task. It records energise permilles, releases, shapes, wakes and
// steps, and the test raises or lowers the nFAULT line. Everything on the test's one thread (no lock).
#pragma once

#include <cstdint>
#include <vector>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/stepper.hpp"
#include "fr/motion/step_engine.hpp"
#include "tests/fake_core.hpp"

namespace frt {

class FakeStepper final : public fr::hal::Stepper
{
public:
    static constexpr uint32_t kWakeUs = 1000;

    explicit FakeStepper(uint8_t max_log2 = 5) : max_log2_(max_log2) {}

    fr::Status init(fr::Core &core, fr::Callback<void(), 24> on_fault) override
    {
        ++inits;
        core_ = &core;
        on_fault_ = on_fault;
        alarm_ = core.timer([this] { on_alarm(); });
        slot_ = core.input_slot([this](const fr::InputSample &) { on_fault_(); });
        awake = false;
        permille = 0;
        return {};
    }
    uint8_t max_microsteps_log2() const override { return max_log2_; }
    fr::Status shape(const fr::hal::StepperShape &s) override
    {
        if (engine.snapshot().running) {
            return std::unexpected(fr::Err::busy);
        }
        engine.shape(s.microsteps_log2, s.invert);
        shapes.push_back(s);
        last_shape = s;
        return {};
    }
    fr::Status energise(uint16_t p) override
    {
        if (engine.snapshot().faulted || line_low) {
            return std::unexpected(fr::Err::busy);
        }
        wake();
        drive(p);
        return {};
    }
    void release() override
    {
        isr_first();
        engine.release();
        alarm_->stop();
        waking_ = false;
        awake = false;
        permille = 0;
        ++releases;
    }
    fr::Status command(const fr::motion::Request &r) override
    {
        isr_first();
        if (engine.snapshot().faulted) {
            return std::unexpected(fr::Err::busy);
        }
        requests.push_back(r);
        const fr::motion::Start st = engine.submit(r);
        if (st.rested_now) {
            alarm_->stop();
        }
        if (!st.arm) {
            return {};
        }
        drive(last_shape.run_permille);
        start_delay_ = st.delay_us;
        if (!awake) {
            wake();
            return {};  // the wake alarm starts stepping
        }
        arm(core_->now() + st.delay_us);
        return {};
    }
    fr::motion::Snapshot snapshot() const override { return engine.snapshot(); }
    fr::Status set_position(int32_t p) override { return engine.set_position(p); }
    bool fault_asserted() const override { return line_low; }
    fr::Status clear_fault() override
    {
        if (line_low) {
            return std::unexpected(fr::Err::busy);
        }
        engine.clear_fault();
        ++clears;
        return {};
    }
    void inject_fault() override { cut(); }
    fr::hal::Selftest selftest() override { return {true, "fake"}; }

    /** nFAULT falls: the fault ISR cuts at once while the bridge is awake (edges are ignored while it sleeps or wakes;
     *  the wake alarm reads the line instead). */
    void raise_fault()
    {
        line_low = true;
        if (awake && !waking_) {
            cut();
        }
    }
    /** nFAULT back high. */
    void clear_line() { line_low = false; }

    /** The next command() or release() first takes the pending step alarm as if it were due: the step ISR that runs
     *  between the service's look at the engine and the driver's lock (on the target it preempts the task). */
    bool alarm_before_command = false;

    fr::motion::StepEngine engine;
    fr::hal::StepperShape last_shape{};
    std::vector<fr::hal::StepperShape> shapes;
    std::vector<uint16_t> energised;  // every drive level, run power from command and energise's
    std::vector<fr::motion::Request> requests;
    uint16_t permille = 0;  // 0: coasting
    bool awake = false;
    bool line_low = false;
    int inits = 0;
    int releases = 0;
    int wakes = 0;
    int cuts = 0;
    int clears = 0;
    uint64_t steps = 0;

private:
    void wake()
    {
        if (awake) {
            return;
        }
        awake = true;
        waking_ = true;
        ++wakes;
        alarm_->start(kWakeUs);
    }
    void drive(uint16_t p)
    {
        if (p != permille) {
            energised.push_back(p);
        }
        permille = p;
    }
    void arm(fr::TimeUs due)
    {
        due_ = due;
        const fr::TimeUs now = core_->now();
        alarm_->start(static_cast<uint32_t>(due > now ? due - now : 0));
    }
    void isr_first()
    {
        if (!alarm_before_command) {
            return;
        }
        alarm_before_command = false;
        if (waking_ || !engine.snapshot().running) {
            return;
        }
        alarm_->stop();
        step(core_->now(), 0);
    }
    void on_alarm()
    {
        const fr::TimeUs now = core_->now();
        if (waking_) {
            waking_ = false;
            if (line_low) {
                cut();
                return;
            }
            if (engine.snapshot().running) {
                arm(now + start_delay_);
            }
            return;
        }
        step(now, static_cast<uint32_t>(now - due_));
    }
    void step(fr::TimeUs now, uint32_t late_us)
    {
        const fr::motion::Tick t = engine.on_alarm(late_us);
        if (t.stepped) {
            ++steps;
        }
        if (t.again) {
            // The next due is absolute; one already past is taken from now (no catch-up burst).
            fr::TimeUs next = due_ + t.interval_us;
            if (next <= now) {
                next = now + t.interval_us;
            }
            arm(next);
        }
    }
    void cut()
    {
        ++cuts;
        permille = 0;
        awake = false;
        waking_ = false;
        engine.fault();
        alarm_->stop();
        slot_->update_from_isr(false, core_->now());
    }

    uint8_t max_log2_;
    fr::Core *core_ = nullptr;
    fr::Callback<void(), 24> on_fault_;
    fr::Timer *alarm_ = nullptr;
    fr::InputSlot *slot_ = nullptr;
    bool waking_ = false;
    fr::TimeUs due_ = 0;
    uint32_t start_delay_ = 0;
};

}  // namespace frt
