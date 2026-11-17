// L1 stepper contract (design stepper-s1 D3): a two-coil stepper whose driver runs fr::motion::StepEngine in its
// own step ISR. Every method is called on the core task and returns in microseconds.
#pragma once

#include <cstdint>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/selftest.hpp"
#include "fr/motion/step_engine.hpp"

namespace fr::hal {

struct StepperShape {
    uint8_t microsteps_log2 = 3;   // 0 full .. 5 (32 microsteps)
    bool invert = false;
    uint16_t run_permille = 200;   // the coils' peak PWM duty while stepping, after the service's power cap
};

class Stepper
{
public:
    /** Every pad to coast (all inputs low), the bridge asleep, the step timer and the fault input armed. on_fault runs
     *  on the core task after the driver's ISR has already cut the coils. */
    virtual Status init(Core &core, Callback<void(), 24> on_fault) = 0;
    /** The finest step mode the driver can drive: 5 (micro32) for drv8833_stepper, 1 (half) for a GPIO-only one. */
    virtual uint8_t max_microsteps_log2() const = 0;
    /** At rest only (Err::busy otherwise). Applies from the next energise or step. */
    virtual Status shape(const StepperShape &s) = 0;
    /** Wakes the bridge if asleep and drives the counted position's vector at `permille` of full duty (run or hold
     *  power). Err::busy while a fault is latched or nFAULT is low. */
    virtual Status energise(uint16_t permille) = 0;
    /** Ends any motion at once (the engine records Rest::released), coils to coast, bridge asleep. Never fails. */
    virtual void release() = 0;
    /** Hands the step ISR a request; energises at run power first (the first step at least 1 ms after a wake).
     *  Err::busy while a fault is latched. */
    virtual Status command(const motion::Request &r) = 0;
    /** A consistent copy of the ISR's state, taken under the driver's lock. */
    virtual motion::Snapshot snapshot() const = 0;
    /** At rest only (Err::busy otherwise). */
    virtual Status set_position(int32_t position) = 0;
    /** nFAULT is low now (false without a fault pin). */
    virtual bool fault_asserted() const = 0;
    /** Unlatches a fault: Err::busy while nFAULT is still low. The bridge stays asleep. */
    virtual Status clear_fault() = 0;
    /** FR_TEST_HOOKS: the fault ISR's cut path, as if nFAULT fell. */
    virtual void inject_fault() = 0;
    /** Never energises a coil. */
    virtual Selftest selftest() = 0;

protected:
    ~Stepper() = default;
};

}  // namespace fr::hal
