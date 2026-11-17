// fr:realtime
// The state a stepper driver's step ISR owns (design stepper-s1 D4-D6): the counted position, the speed, the goal, the
// rests, the slips and the fault latch, with the task side's request mailbox (submit) and a consistent snapshot. The
// driver calls every method under its own lock; on_alarm() and fault() run in its ISRs, so they and everything they
// reach are FR_MOTION_ISR and integer-only.
//
// Timing: each on_alarm() applies one step at once (its vector leads the rotor by that step) and returns the step's
// duration; the driver arms the next alarm that much later, at an absolute time (due + interval, or now + interval
// when that is already past: no catch-up bursts). The alarm at the end of a motion's last step rests it, so a rest
// comes when the rotor has arrived, and from rest the first alarm both decides and takes the first step.
#pragma once

#include <cstdint>

#include "fr/base.hpp"
#include "fr/motion/phase_table.hpp"
#include "fr/motion/step_planner.hpp"

namespace fr::motion {

struct Request {
    enum class Kind : uint8_t { move_to, jog, stop, halt };
    Kind kind = Kind::stop;
    int32_t target = 0;                  // move_to
    int32_t speed = 0;                   // jog: signed steps/s; stop: 0
    uint32_t vmax = 0, accel = 0;        // steps/s, steps/s^2; accel 0 keeps the running motion's
    int32_t lo = -1000000000, hi = 1000000000;   // the bounds (soft limits or +-1e9)
};

struct Snapshot {
    int32_t position = 0, target = 0;    // target: a move's; a jog's or a stop's is the position
    int32_t speed = 0;                   // signed steps/s at the last step boundary
    bool running = false;                // an alarm is pending
    uint32_t rests = 0;                  // counts every rest; the service compares it with the last it saw
    Rest last_rest = Rest::none;
    uint16_t slips = 0;                  // of the motion that rested last (or of the running one)
    bool faulted = false;
};

/** submit()'s answer: arm the first alarm `delay_us` from now (0: the first step is due at once, and the driver puts it
 *  after its wake), or the request rested at once (or did nothing). */
struct Start { bool arm = false; uint32_t delay_us = 0; bool rested_now = false; };
/** on_alarm()'s answer: a step was taken (drive `phase`), and the next alarm is `interval_us` after this one's due. */
struct Tick  { bool stepped = false; uint8_t phase = 0; bool again = false; uint32_t interval_us = 0; };

class StepEngine
{
public:
    /** At rest only (ignored while running): the step size as 1/2^microsteps_log2 of a full step (at most 5), and the
     *  direction positive steps turn. */
    void shape(uint8_t microsteps_log2, bool invert)
    {
        if (running_) {
            return;
        }
        microsteps_log2_ = microsteps_log2 < kMaxMicrostepsLog2 ? microsteps_log2 : kMaxMicrostepsLog2;
        invert_ = invert;
    }

    /**
     * Task side, under the driver's lock. While running, a move or jog replaces the goal for the next decision (no rest
     * for the replaced one) and a stop slows to rest; nothing to arm. From rest, a move or jog arms the first alarm, or
     * rests at once when there is nothing to do (a move to the position: reached; a jog into its bound: limit); a stop,
     * a jog at 0 or a halt does nothing. Halt rests a running motion at once (halted). Refused (nothing) while faulted.
     * Values are clamped to the engine's ranges (D6): speeds to 1..10,000 (a jog's to +-10,000), accel to 1..200,000,
     * the bounds to +-1e9 and a move's target into them.
     */
    Start submit(const Request &r)
    {
        if (faulted_) {
            return {};
        }
        if (r.kind == Request::Kind::halt) {
            if (!running_) {
                return {};
            }
            rest(Rest::halted);
            return Start{.rested_now = true};
        }
        Goal g = goal_;
        g.lo = clamp(r.lo < r.hi ? r.lo : r.hi, -kPositionLimit, kPositionLimit);
        g.hi = clamp(r.lo < r.hi ? r.hi : r.lo, -kPositionLimit, kPositionLimit);
        if (r.accel != 0) {
            g.two_a = 2 * clamp_u(r.accel, 1, kMaxAccel);
        }
        switch (r.kind) {
        case Request::Kind::move_to:
            g.velocity = false;
            g.target = clamp(r.target, g.lo, g.hi);
            g.speed = 0;
            g.cap = clamp_u(r.vmax, 1, kMaxSpeed);
            break;
        case Request::Kind::jog:
            g.velocity = true;
            g.speed = clamp(r.speed, -static_cast<int32_t>(kMaxSpeed), static_cast<int32_t>(kMaxSpeed));
            g.cap = g.speed < 0 ? static_cast<uint32_t>(-g.speed) : (g.speed > 0 ? static_cast<uint32_t>(g.speed) : 1u);
            break;
        default:  // stop
            g.velocity = true;
            g.speed = 0;
            g.cap = 1;
            break;
        }
        goal_ = g;
        if (running_) {
            return {};
        }
        const Plan p = decide(position_, dir_, 0, goal_);
        if (p.rest == Rest::stopped) {
            return {};
        }
        slips_ = 0;
        if (p.rest != Rest::none) {
            rest(p.rest);
            return Start{.rested_now = true};
        }
        running_ = true;
        return Start{.arm = true};
    }

    /**
     * ISR side, at a step alarm `late_us` after its due time. More than kSlipLateUs late at speed, the rotor has stood
     * at its last vector: the ramp restarts from rest (a slip; the position stays exact). Then one decision: a step
     * (stepped, again, its duration), or the motion rests (neither). After a slip the duration also carries late_us:
     * the driver counts it from the missed due time, and the rotor that stood needs the whole from-rest time from now.
     */
    FR_MOTION_ISR Tick on_alarm(uint32_t late_us)
    {
        if (!running_) {
            return {};
        }
        uint32_t restart_us = 0;
        if (late_us > kSlipLateUs && vsq_ != 0) {
            vsq_ = 0;
            root_ = 0;
            restart_us = late_us;
            if (slips_ != UINT16_MAX) {
                ++slips_;
            }
        }
        const Plan p = decide(position_, dir_, vsq_, goal_);
        if (p.rest != Rest::none) {
            rest(p.rest);
            return Tick{.phase = phase()};
        }
        const uint32_t s0 = p.vsq0 == vsq_ ? root_ : 0;
        uint32_t cap_sq = p.vsq0;
        uint32_t cap_s = s0;
        if (p.cap_is_goal) {
            cap_sq = goal_.cap * goal_.cap;
            cap_s = goal_.cap << 8;
        }
        uint32_t s1 = s0;
        if (p.vsq == cap_sq) {
            s1 = cap_s;
        } else if (p.vsq != p.vsq0) {
            s1 = root_q8(p.vsq);
        }
        uint32_t interval = step_us(p.vsq0, s0, p.vsq, s1, cap_sq, cap_s, goal_.two_a);
        interval = interval > UINT32_MAX - restart_us ? UINT32_MAX : interval + restart_us;
        dir_ = p.dir;
        position_ += dir_;
        vsq_ = p.vsq;
        root_ = s1;
        return Tick{.stepped = true, .phase = phase(), .again = true, .interval_us = interval};
    }

    /** Either side: stops counting at once and latches; a running motion rests (fault). */
    FR_MOTION_ISR void fault()
    {
        faulted_ = true;
        stop_now(Rest::fault);
    }

    /** Task side: stops at once; a running motion rests (released). The driver cuts the coils. */
    void release() { stop_now(Rest::released); }

    void clear_fault() { faulted_ = false; }

    /** At rest only (Err::busy while running); within +-1e9 (Err::invalid_args). */
    Status set_position(int32_t p)
    {
        if (running_) {
            return std::unexpected(Err::busy);
        }
        if (p < -kPositionLimit || p > kPositionLimit) {
            return std::unexpected(Err::invalid_args);
        }
        position_ = p;
        goal_.target = p;
        return {};
    }

    /** The electrical index 0..127 of the counted position. */
    FR_MOTION_ISR uint8_t phase() const { return electrical_index(position_, microsteps_log2_, invert_); }

    /** The coils' vector at electrical index `e`, from the engine's DRAM copy of the table. */
    FR_MOTION_ISR Vector vector(uint8_t e) const { return table_.at(e); }

    Snapshot snapshot() const
    {
        Snapshot s;
        s.position = position_;
        s.target = goal_.velocity ? position_ : goal_.target;
        const int32_t v = static_cast<int32_t>((root_ + 128) >> 8);
        s.speed = dir_ > 0 ? v : -v;
        s.running = running_;
        s.rests = rests_;
        s.last_rest = last_rest_;
        s.slips = slips_;
        s.faulted = faulted_;
        return s;
    }

    /** v^2 at the counted position, exact (steps^2/s^2): for tests and diagnostics. */
    uint32_t speed_sq() const { return vsq_; }

private:
    static constexpr int32_t clamp(int32_t v, int32_t lo, int32_t hi) { return v < lo ? lo : (v > hi ? hi : v); }
    static constexpr uint32_t clamp_u(uint32_t v, uint32_t lo, uint32_t hi) { return v < lo ? lo : (v > hi ? hi : v); }

    FR_MOTION_ISR void rest(Rest why)
    {
        running_ = false;
        vsq_ = 0;
        root_ = 0;
        last_rest_ = why;
        ++rests_;
    }

    FR_MOTION_ISR void stop_now(Rest why)
    {
        vsq_ = 0;
        root_ = 0;
        if (running_) {
            rest(why);
        }
    }

    Goal goal_;
    int32_t position_ = 0;
    int8_t dir_ = 1;
    uint32_t vsq_ = 0;   // v^2 at the counted position
    uint32_t root_ = 0;  // v in Q8
    bool running_ = false;
    bool faulted_ = false;
    uint8_t microsteps_log2_ = 3;
    bool invert_ = false;
    Rest last_rest_ = Rest::none;
    uint16_t slips_ = 0;
    uint32_t rests_ = 0;
    PhaseTable table_;
};

}  // namespace fr::motion
