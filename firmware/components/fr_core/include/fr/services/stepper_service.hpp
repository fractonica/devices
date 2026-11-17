// L2 stepper service (spec 07 §7.3, §7.7-7.8; design stepper-s1 D10-D12): fr.stepper over any hal::Stepper, its
// settings kept through a hal::Settings. The service decides what the motor does; the driver's step ISR runs the
// fr::motion engine. Host-buildable.
#pragma once

#include <array>
#include <cstdint>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/settings.hpp"
#include "fr/hal/stepper.hpp"
#include "stepper.hpp"  // generated fr::cap::Stepper

namespace fr {

/**
 * Everything on the core task. One timer: the kPollUs poll while moving or stopping (the engine's rests become `done`,
 * position and speed are reported at most report_hz a second, the hub-silence rule and a jog's `seconds` are judged),
 * the settle's end (run power kSettleUs after a rest, then hold power) and the idle release (release_ms after a rest).
 *
 * Motion: released -> moving (a move or jog: the driver wakes at run power) -> holding (the engine rested: reached or
 * limit; settle, then hold power, then released after release_ms) or stopping (stop, a jog's seconds, the hub's
 * silence: a decelerated stop whose rest is done {stopped | elapsed | hub_lost}). halt and release end a running motion
 * at once with their own done. hold energises at hold power until release or a motion (no idle release). A driver fault
 * (on_fault, after the driver cut the coils) is motion `fault` in any state, with `fault` and, when a motion ran,
 * done {fault}; hold or a move clears it after the back-off (kBackoffUs; kLongBackoffUs once kLongBackoffFaults fall
 * within kFaultWindowUs), release clears it without energising.
 *
 * target is the running move's, else the position: a jog's or a stop's follows the position with each report.
 * move_by counts from the running move's target, or from the position when none runs. A move to where it rests is
 * done {reached} at once and touches nothing. Before a command changes the motion, a rest the poll has not seen yet
 * is taken first, so a replaced motion never loses or borrows a done; so is one the step ISR makes just before a halt,
 * a release or a fault, which then end nothing. position_known is set only by zero, and falls
 * when a halt, a release or a fault ends a motion above start_hz (a fault's speed is bounded from the last poll's,
 * since the engine has already rested: |v| + accel x the time since).
 *
 * Power: run_permille = min(1000, run_ma x coil_ohm x 1000 / supply_mv), at least 1; hold_permille = run_permille x
 * hold_pct / 100, at least 1; run_duty_pct = ceil(run_permille / 10).
 *
 * Settings (NVS namespace fr_stepper): keys p<port><k>, k in a, v, p, r, lo, hi, m (layout 1 | step_mode << 8 |
 * invert << 11 | limits << 12 | hold_pct << 16; the other packs in kKeys' comments). m is the commit mark: configure
 * validates and applies, then, when keys other than m change, writes m as kUnmarked, the keys that differ from what is
 * kept (all of them while nothing is) and the new m last, so a refused write or a reboot mid-way boots the build's
 * configuration, never a mix. A refused write answers FAILED and the values stay applied for this boot. At init the
 * keys load only when m says layout 1; a value out of range is ignored (settings_ignored() counts them: an IDF-free
 * service has no log). reset_settings erases m alone.
 * A step_mode change (released only) rescales the position, the limits and the speeds not given in the same call by
 * 2^(new - old), rounded, clamped to their ranges.
 *
 * The hub (D12): a move or jog started while a hub session existed stops, decelerated, with done {hub_lost} when it
 * is still moving kHubSilentUs after that hub's newest frame (fr::core::link_info().hub_heard_at) or at a WELCOME of
 * another hub run. One started without a hub session (a local app) is not tied to one.
 */
class StepperService final : public cap::Stepper
{
public:
    StepperService(hal::Stepper &drv, hal::Settings &settings, const cap::StepperConfig &cfg);

    /** The driver first (its coils off before anything can fail), then Err::invalid_args for a config codegen should
     *  have refused (limit_min >= limit_max, a step_mode beyond the driver, a zero rate or power), Err::failed when the
     *  core's timer pool is out. */
    Status init(Core &core);
    hal::Selftest selftest();

    Status move_to(const cap::StepperMoveToArgs &args) override;
    Status move_by(const cap::StepperMoveByArgs &args) override;
    Status jog(const cap::StepperJogArgs &args) override;
    Status stop() override;
    Status halt() override;
    Status hold() override;
    Status release() override;
    Status zero(const cap::StepperZeroArgs &args) override;
    Status configure(const cap::StepperConfigureArgs &args) override;
    Status reset_settings() override;
#if FR_TEST_HOOKS
    Status inject_fault() override;
#endif

    int32_t position() const override { return drv_.snapshot().position; }
    int32_t target() const override { return target_; }
    int32_t speed_hz() const override { return drv_.snapshot().speed; }
    cap::StepperMotion motion() const override { return motion_; }
    bool position_known() const override { return known_; }
    cap::StepperStepMode step_mode() const override { return set_.step_mode; }
    uint16_t max_speed_hz() const override { return set_.max_speed_hz; }
    uint32_t accel() const override { return set_.accel; }
    uint16_t start_hz() const override { return set_.start_hz; }
    uint16_t coil_ohm() const override { return set_.coil_ohm; }
    uint16_t run_ma() const override { return set_.run_ma; }
    uint8_t hold_pct() const override { return set_.hold_pct; }
    uint16_t release_ms() const override { return set_.release_ms; }
    uint16_t supply_mv() const override { return set_.supply_mv; }
    bool invert() const override { return set_.invert; }
    bool limits() const override { return set_.limits; }
    int32_t limit_min() const override { return set_.limit_min; }
    int32_t limit_max() const override { return set_.limit_max; }
    uint8_t run_duty_pct() const override { return static_cast<uint8_t>((run_permille_ + 9) / 10); }
    uint16_t steps_per_rev() const override { return cfg_.steps_per_rev; }
    cap::StepperTraits traits() const override { return traits_; }

    uint16_t run_permille() const { return run_permille_; }
    uint16_t hold_permille() const { return hold_permille_; }
    /** The settings key of this port for kKeys[i] (valid after init). */
    const char *key(size_t i) const { return keys_[i].data(); }
    /** Kept values ignored at init for being out of range. */
    uint32_t settings_ignored() const { return settings_ignored_; }

    static constexpr uint32_t kPollUs = 20'000;
    static constexpr TimeUs kSettleUs = 100'000;
    static constexpr TimeUs kHubSilentUs = 10'000'000;
    static constexpr TimeUs kBackoffUs = 1'000'000;
    static constexpr TimeUs kLongBackoffUs = 60'000'000;
    static constexpr TimeUs kFaultWindowUs = 60'000'000;
    static constexpr uint8_t kLongBackoffFaults = 3;
    /** m's low byte: the layout of the kept values. */
    static constexpr int32_t kLayout = 1;
    /** m while configure writes the other keys: no layout, so none of them loads. */
    static constexpr int32_t kUnmarked = 0;
    /** The key suffixes, in write order (m last): a accel; v max_speed_hz | start_hz << 16; p coil_ohm | run_ma << 16;
     *  r release_ms | supply_mv << 16; lo limit_min; hi limit_max; m the layout, step mode, flags and hold_pct. */
    static constexpr std::array<const char *, 7> kKeys{"a", "v", "p", "r", "lo", "hi", "m"};

    /** min(1000, run_ma x coil_ohm x 1000 / supply_mv), at least 1. */
    static uint16_t run_permille_of(uint16_t run_ma, uint16_t coil_ohm, uint16_t supply_mv);
    /** round(v x 2^shift) (halves away from zero), clamped to +-1e9. */
    static int32_t rescale(int32_t v, int shift);

private:
    enum class Kind : uint8_t { move, jog };

    bool running() const { return motion_ == cap::StepperMotion::moving || motion_ == cap::StepperMotion::stopping; }
    void on_timer();
    void on_fault();
    /** Takes a rest the engine made since the last look (done, holding, the settle); reports position and speed at
     *  most report_hz a second while running (`force`: now). */
    void observe(TimeUs now, bool force_report);
    void schedule(TimeUs now);
    /** BUSY in the back-off, or while a latched fault will not clear; otherwise the fault is cleared (released). */
    Status ready_to_energise(TimeUs now);
    Status move(int64_t target, bool has_speed, uint16_t speed, bool has_accel, uint32_t accel);
    /** Starts or replaces a motion through the driver; the motion is moving. */
    Status start(const motion::Request &r, Kind kind, TimeUs now);
    /** Ends a running motion through the driver at once (halt or release): done `why`, position_known by `speed`. */
    void end_now(cap::StepperDoneReason why, int32_t speed, TimeUs now);
    /** A decelerated stop of the running motion, whose rest is done `why`. */
    Status begin_stop(cap::StepperDoneReason why);
    /** A motion came to rest: holding at run power for the settle, then the idle release. */
    void rested(TimeUs now);
    /** While running: a rest the engine made by itself that is not yet seen (not `command_rest`, the one the caller's
     *  command makes, nor a fault's, on_fault's) is taken as observe() takes it. True when one was. */
    bool take_rest(TimeUs now, motion::Rest command_rest);
    void emit_rest(cap::StepperDoneReason why, const motion::Snapshot &s);
    motion::Request bounds(motion::Request r) const;
    void set_motion(cap::StepperMotion m);
    void set_known(bool k);
    void set_target(int32_t t);
    void report_motion_values(const motion::Snapshot &s);
    /** Power, shape and reports after the settings changed from `old`. */
    void apply(const cap::StepperConfig &old);
    hal::StepperShape shape_of(const cap::StepperConfig &c) const;
    void load_settings();
    Status write_settings();
    std::array<int32_t, kKeys.size()> pack(const cap::StepperConfig &c) const;
    /** An upper bound of |speed| now, from the last look's speed and the running motion's accel. */
    uint32_t speed_bound(TimeUs now) const;

    hal::Stepper &drv_;
    hal::Settings &settings_;
    cap::StepperConfig cfg_;  // the build's configuration
    cap::StepperConfig set_;  // the settings in use
    cap::StepperTraits traits_;
    Core *core_ = nullptr;
    Timer *tick_ = nullptr;
    std::array<std::array<char, hal::Settings::kKeyMax + 1>, kKeys.size()> keys_{};

    uint16_t run_permille_ = 0;
    uint16_t hold_permille_ = 0;

    cap::StepperMotion motion_ = cap::StepperMotion::released;
    cap::StepperMotion reported_motion_ = cap::StepperMotion::released;
    bool known_ = false;
    int32_t target_ = 0;   // reported: a move's target, else the position
    int32_t move_target_ = 0;  // the last move's, for its done
    Kind kind_ = Kind::move;
    uint32_t seen_rests_ = 0;
    cap::StepperDoneReason stop_reason_ = cap::StepperDoneReason::stopped;
    uint32_t accel_ = 0;  // the running motion's
    uint32_t cap_ = 0;    // the running motion's speed limit
    uint32_t last_speed_ = 0;  // |speed| at the last look
    TimeUs last_speed_at_ = 0;

    TimeUs settle_until_ = 0;  // 0: none
    TimeUs release_at_ = 0;    // 0: none
    TimeUs jog_until_ = 0;     // 0: none
    TimeUs next_report_ = 0;
    int32_t reported_position_ = 0;
    int32_t reported_speed_ = 0;
    bool hub_ = false;  // the running motion was started under a hub session
    uint16_t hub_epoch_ = 0;

    TimeUs backoff_until_ = 0;
    std::array<TimeUs, 8> faults_{};  // the newest at faults_[0]
    uint8_t n_faults_ = 0;
    bool injected_ = false;

    bool kept_ = false;  // m is kept: the keys below say what the store holds
    std::array<int32_t, kKeys.size()> stored_{};
    uint8_t stored_mask_ = 0;
    uint32_t settings_ignored_ = 0;
};

}  // namespace fr
