// drv8833_stepper (design stepper-s1 D7-D9; spec 07 §7.8): hal::Stepper for a two-coil stepper on a DRV8833 dual
// H-bridge module. Microsteps by PWM on the four inputs (LEDC low-speed timer 0, channels 0-3, 11 bits, slow decay:
// fr/drv/drv8833_bridge.hpp), steps from a gptimer alarm ISR that runs fr::motion::StepEngine, nSLEEP on a bare output
// and nFAULT on a falling-edge ISR that cuts the coils at once. Both ISRs and everything they reach are in IRAM
// (linker.lf maps the object noflash; CONFIG_GPTIMER_ISR_CACHE_SAFE), so steps go on through flash writes.
// One instance per node: the LEDC timer and channels are fixed. The public header exposes fr_core types only.
#pragma once

#include <cstdint>

#include "fr/core/core.hpp"
#include "fr/hal/stepper.hpp"
#include "fr/motion/step_engine.hpp"

struct gptimer_t;  // gptimer_handle_t points at it; IDF headers stay out of this one

namespace fr::drv {

class Drv8833Stepper final : public hal::Stepper
{
public:
    // Field order and defaults follow driver.yaml `config:`; the generated fr_board fills it from the instance's
    // multi-pin bind (an absent optional pin is -1).
    struct Config {
        uint8_t ain1 = 0;
        uint8_t ain2 = 0;
        uint8_t bin1 = 0;
        uint8_t bin2 = 0;
        int8_t sleep = -1;
        int8_t fault = -1;
        bool fault_pullup = true;
        uint16_t pwm_hz = 25000;
    };

    /** The DRV8833's wake time (t_WAKE, about 1 ms): no step and no nFAULT edge counts before it has passed. */
    static constexpr uint32_t kWakeUs = 1'000;
    /** The nearest an alarm is set ahead of the counter: one set in the past fires at once anyway. */
    static constexpr uint32_t kLeadUs = 2;

    // Only stores the configuration: hardware is touched in init() (spec 03 §3.4).
    explicit Drv8833Stepper(const Config &cfg) : cfg_(cfg) {}

    Status init(Core &core, Callback<void(), 24> on_fault) override;
    uint8_t max_microsteps_log2() const override { return motion::kMaxMicrostepsLog2; }
    Status shape(const hal::StepperShape &s) override;
    Status energise(uint16_t permille) override;
    void release() override;
    Status command(const motion::Request &r) override;
    motion::Snapshot snapshot() const override;
    Status set_position(int32_t position) override;
    bool fault_asserted() const override;
    Status clear_fault() override;
    void inject_fault() override;
    hal::Selftest selftest() override;

private:
    struct Isr;  // the alarm and nFAULT ISRs and the safe-off hook (src/drv8833_stepper.cpp)

    enum class Power : uint8_t { off, waking, on };  // the bridge: asleep, inside t_WAKE, driving
    enum class Alarm : uint8_t { none, wake, step };  // what the pending gptimer alarm is for

    // Under the driver's lock (src/drv8833_stepper.cpp), from the task side or an ISR.
    /** The four duties for the counted position's vector at the present peak. */
    void drive_locked();
    /** Raises nSLEEP and arms the wake alarm, or drives at once without a sleep pin. */
    void wake_locked();
    /** Sets the gptimer alarm for counter value `at`, at least kLeadUs after `now`. */
    void arm_locked(uint64_t at, uint64_t now, Alarm kind);
    void disarm_locked();
    /** One step decision for the alarm due at `due`, run at `now`, and the next alarm. */
    void step_locked(uint64_t due, uint64_t now);
    /** An alarm at counter value `now`; true when it cut the coils (the wake check found nFAULT low). */
    bool alarm_locked(uint64_t now);
    /** The fault path: pads to GPIO low, the bridge asleep, the engine faulted, the alarm off. */
    void cut_locked();
    /** Wakes the core task, which runs on_fault (outside the lock). */
    void notify_fault();
    uint64_t now_locked() const;

    Config cfg_;
    motion::StepEngine engine_;
    gptimer_t *timer_ = nullptr;
    InputSlot *slot_ = nullptr;
    Callback<void(), 24> on_fault_;
    bool ready_ = false;

    // The ISRs' state, under the lock.
    Power power_ = Power::off;
    Alarm alarm_ = Alarm::none;
    uint64_t due_ = 0;          // the pending alarm's counter value (1 MHz)
    uint16_t peak_ = 0;         // the drive's peak amplitude in LEDC counts
    uint16_t run_permille_ = 200;
    bool cut_ = false;          // a fault is latched: the pads are off LEDC, driven low
    // Added to the engine's electrical index so that set_position() and shape() never move the vector the coils hold:
    // a `zero` re-labels where the shaft is, it does not turn it.
    uint8_t phase_offset_ = 0;
    char detail_[160] = {};
};

}  // namespace fr::drv
