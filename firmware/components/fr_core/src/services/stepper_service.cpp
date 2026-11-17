// fr:realtime
#include "fr/services/stepper_service.hpp"

#include <algorithm>
#include <limits>

// fr::core::link_info(): the hub's newest frame and run, for the hub-silence rule (D12, as HapticService's).
#include "fr/core/node_net.hpp"

namespace fr {
namespace {

using cap::StepperDoneReason;
using cap::StepperMotion;

constexpr int32_t kBound = motion::kPositionLimit;
constexpr uint32_t kMinSpeed = 1;
constexpr uint32_t kMaxSpeed = motion::kMaxSpeed;
constexpr uint32_t kMinAccel = 10;
constexpr uint32_t kMaxAccel = motion::kMaxAccel;

enum KeyIx : size_t { kA, kV, kP, kR, kLo, kHi, kM };

/** v x 2^shift rounded (halves up), clamped to [lo, hi]: v <= 200,000 and |shift| <= 5, so it fits a u64 easily. */
uint32_t scale_u(uint32_t v, int shift, uint32_t lo, uint32_t hi)
{
    const uint64_t r = shift >= 0 ? uint64_t{v} << shift : (uint64_t{v} + (uint64_t{1} << (-shift - 1))) >> -shift;
    return static_cast<uint32_t>(std::clamp<uint64_t>(r, lo, hi));
}

uint32_t magnitude(int32_t v)
{
    return v < 0 ? static_cast<uint32_t>(-static_cast<int64_t>(v)) : static_cast<uint32_t>(v);
}

bool within(int64_t v, int64_t lo, int64_t hi)
{
    return v >= lo && v <= hi;
}

StepperDoneReason reason_of(motion::Rest r, StepperDoneReason stopped_as)
{
    switch (r) {
    case motion::Rest::stopped:
        return stopped_as;
    case motion::Rest::halted:
        return StepperDoneReason::halted;
    case motion::Rest::released:
        return StepperDoneReason::released;
    case motion::Rest::limit:
        return StepperDoneReason::limit;
    case motion::Rest::fault:
        return StepperDoneReason::fault;
    default:
        return StepperDoneReason::reached;
    }
}

}  // namespace

StepperService::StepperService(hal::Stepper &drv, hal::Settings &settings, const cap::StepperConfig &cfg)
    : drv_(drv), settings_(settings), cfg_(cfg), set_(cfg)
{
    // A constant of the driver, so the traits are valid before init (the descriptor is built from them). The step
    // mode's value is its microsteps_log2: micro4 is the first PWM-only one.
    traits_.microstep = drv_.max_microsteps_log2() >= static_cast<uint8_t>(cap::StepperStepMode::micro4);
    run_permille_ = run_permille_of(set_.run_ma, set_.coil_ohm, set_.supply_mv);
    hold_permille_ = static_cast<uint16_t>(std::max<uint32_t>(1, uint32_t{run_permille_} * set_.hold_pct / 100));
}

uint16_t StepperService::run_permille_of(uint16_t run_ma, uint16_t coil_ohm, uint16_t supply_mv)
{
    if (supply_mv == 0) {
        return 1;
    }
    // At most 1,500 x 1,000 x 1,000 < 2^32.
    const uint32_t p = uint32_t{run_ma} * coil_ohm * 1000 / supply_mv;
    return static_cast<uint16_t>(std::clamp<uint32_t>(p, 1, 1000));
}

int32_t StepperService::rescale(int32_t v, int shift)
{
    int64_t r = v;
    if (shift >= 0) {
        r *= int64_t{1} << shift;
    } else {
        const int64_t d = int64_t{1} << -shift;
        r = r >= 0 ? (r + d / 2) / d : -((-r + d / 2) / d);
    }
    return static_cast<int32_t>(std::clamp<int64_t>(r, -kBound, kBound));
}

Status StepperService::init(Core &core)
{
    // The driver first (review B1's rule, as HapticService): the coils are off before anything here can fail.
    if (auto st = drv_.init(core, [this] { on_fault(); }); !st) {
        return st;
    }
    if (cfg_.limit_min >= cfg_.limit_max || !cap::is_known(cfg_.step_mode) ||
        static_cast<uint8_t>(cfg_.step_mode) > drv_.max_microsteps_log2() || cfg_.report_hz == 0 ||
        cfg_.steps_per_rev == 0 || cfg_.max_speed_hz == 0 || cfg_.accel == 0 || cfg_.start_hz == 0 ||
        cfg_.coil_ohm == 0 || cfg_.run_ma == 0 || cfg_.hold_pct == 0 || cfg_.hold_pct > 100 || cfg_.supply_mv == 0) {
        return std::unexpected(Err::invalid_args);
    }
    core_ = &core;
    // Keys of this port (attach ran first): the slots.lock freezes it, and two motors on one node keep apart.
    for (size_t i = 0; i < kKeys.size(); ++i) {
        std::array<char, hal::Settings::kKeyMax + 1> &k = keys_[i];
        size_t n = 0;
        k[n++] = 'p';
        const unsigned port = port_;
        if (port >= 100) {
            k[n++] = static_cast<char>('0' + port / 100);
        }
        if (port >= 10) {
            k[n++] = static_cast<char>('0' + port / 10 % 10);
        }
        k[n++] = static_cast<char>('0' + port % 10);
        for (const char *c = kKeys[i]; *c != '\0'; ++c) {
            k[n++] = *c;
        }
        k[n] = '\0';
    }
    load_settings();
    run_permille_ = run_permille_of(set_.run_ma, set_.coil_ohm, set_.supply_mv);
    hold_permille_ = static_cast<uint16_t>(std::max<uint32_t>(1, uint32_t{run_permille_} * set_.hold_pct / 100));
    if (auto st = drv_.shape(shape_of(set_)); !st) {
        return st;
    }
    tick_ = core.timer([this] { on_timer(); });
    if (tick_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    return {};
}

hal::Selftest StepperService::selftest()
{
    return drv_.selftest();
}

void StepperService::load_settings()
{
    const auto m = settings_.get_i32(key(kM));
    if (!m) {
        return;  // nothing kept (or the store cannot be read): the build's configuration
    }
    if (*m == kUnmarked) {
        return;  // a configure that did not finish: the build's configuration, as with nothing kept
    }
    const uint32_t mv = static_cast<uint32_t>(*m);
    if ((mv & 0xFF) != static_cast<uint32_t>(kLayout)) {
        ++settings_ignored_;
        return;
    }
    kept_ = true;
    stored_[kM] = *m;
    stored_mask_ |= 1u << kM;
    const auto mode = static_cast<cap::StepperStepMode>((mv >> 8) & 7);
    if (cap::is_known(mode) && static_cast<uint8_t>(mode) <= drv_.max_microsteps_log2()) {
        set_.step_mode = mode;
    } else {
        ++settings_ignored_;
    }
    set_.invert = ((mv >> 11) & 1) != 0;
    set_.limits = ((mv >> 12) & 1) != 0;
    const uint32_t hold = (mv >> 16) & 0xFF;
    if (within(hold, 1, 100)) {
        set_.hold_pct = static_cast<uint8_t>(hold);
    } else {
        ++settings_ignored_;
    }

    // Each kept value is range-checked on its own; one that is not ours is ignored (the build's value stays).
    const auto take = [this](size_t i, auto &&use) {
        const auto v = settings_.get_i32(key(i));
        if (!v) {
            return;
        }
        stored_[i] = *v;
        stored_mask_ |= 1u << i;
        use(*v);
    };
    const auto lo16 = [](int32_t v) { return static_cast<uint32_t>(v) & 0xFFFF; };
    const auto hi16 = [](int32_t v) { return static_cast<uint32_t>(v) >> 16; };
    const auto check = [this](bool ok) {
        settings_ignored_ += ok ? 0 : 1;
        return ok;
    };
    take(kA, [&](int32_t v) {
        if (check(within(v, kMinAccel, kMaxAccel))) {
            set_.accel = static_cast<uint32_t>(v);
        }
    });
    take(kV, [&](int32_t v) {
        if (check(within(lo16(v), kMinSpeed, kMaxSpeed))) {
            set_.max_speed_hz = static_cast<uint16_t>(lo16(v));
        }
        if (check(within(hi16(v), kMinSpeed, kMaxSpeed))) {
            set_.start_hz = static_cast<uint16_t>(hi16(v));
        }
    });
    take(kP, [&](int32_t v) {
        if (check(within(lo16(v), 1, 1000))) {
            set_.coil_ohm = static_cast<uint16_t>(lo16(v));
        }
        if (check(within(hi16(v), 1, 1500))) {
            set_.run_ma = static_cast<uint16_t>(hi16(v));
        }
    });
    take(kR, [&](int32_t v) {
        set_.release_ms = static_cast<uint16_t>(lo16(v));
        if (check(within(hi16(v), 2700, 10800))) {
            set_.supply_mv = static_cast<uint16_t>(hi16(v));
        }
    });
    int32_t lo = set_.limit_min;
    int32_t hi = set_.limit_max;
    take(kLo, [&](int32_t v) {
        if (check(within(v, -kBound, kBound))) {
            lo = v;
        }
    });
    take(kHi, [&](int32_t v) {
        if (check(within(v, -kBound, kBound))) {
            hi = v;
        }
    });
    // The pair must stay a range: a kept one that crosses the other is ignored with it.
    if (check(lo < hi)) {
        set_.limit_min = lo;
        set_.limit_max = hi;
    }
}

std::array<int32_t, StepperService::kKeys.size()> StepperService::pack(const cap::StepperConfig &c) const
{
    // Every pack stays below 2^31: the high halves are at most 10,800.
    const auto pair = [](uint32_t low, uint32_t high) { return static_cast<int32_t>(low | high << 16); };
    return {
        static_cast<int32_t>(c.accel),
        pair(c.max_speed_hz, c.start_hz),
        pair(c.coil_ohm, c.run_ma),
        pair(c.release_ms, c.supply_mv),
        c.limit_min,
        c.limit_max,
        static_cast<int32_t>(static_cast<uint32_t>(kLayout) | uint32_t{static_cast<uint8_t>(c.step_mode)} << 8 |
                             uint32_t{c.invert} << 11 | uint32_t{c.limits} << 12 | uint32_t{c.hold_pct} << 16),
    };
}

Status StepperService::write_settings()
{
    // m is the commit mark: the other keys load only under an m that says layout 1. So the keys that differ from what
    // the store holds (all of them while m is not kept: an erased or unmarked m may have left older keys behind) are
    // written under an m of 0 (kUnmarked), and the new m last. Writes land in order, so a refused write or a reboot
    // anywhere in between boots the build's configuration, never the old keys mixed with new ones. m alone (a flag or
    // hold_pct) is one write.
    const auto v = pack(set_);
    uint8_t changed = 0;
    for (size_t i = 0; i < kM; ++i) {
        if (!kept_ || (stored_mask_ & (1u << i)) == 0 || stored_[i] != v[i]) {
            changed |= 1u << i;
        }
    }
    if (kept_ && changed != 0) {
        if (!settings_.set_i32(key(kM), kUnmarked)) {
            return std::unexpected(Err::failed);  // nothing written: the store still holds the old set
        }
        kept_ = false;
        stored_[kM] = kUnmarked;
    }
    for (size_t i = 0; i < kKeys.size(); ++i) {
        if (i != kM && (changed & (1u << i)) == 0) {
            continue;
        }
        if (!settings_.set_i32(key(i), v[i])) {
            return std::unexpected(Err::failed);
        }
        stored_[i] = v[i];
        stored_mask_ |= 1u << i;
    }
    kept_ = true;
    return {};
}

hal::StepperShape StepperService::shape_of(const cap::StepperConfig &c) const
{
    return {static_cast<uint8_t>(c.step_mode), c.invert, run_permille_of(c.run_ma, c.coil_ohm, c.supply_mv)};
}

motion::Request StepperService::bounds(motion::Request r) const
{
    r.lo = set_.limits ? set_.limit_min : -kBound;
    r.hi = set_.limits ? set_.limit_max : kBound;
    return r;
}

void StepperService::set_motion(StepperMotion m)
{
    motion_ = m;
    if (m != reported_motion_) {
        reported_motion_ = m;
        report_motion(m);
    }
}

void StepperService::set_known(bool k)
{
    if (k != known_) {
        known_ = k;
        report_position_known(k);
    }
}

void StepperService::set_target(int32_t t)
{
    if (t != target_) {
        target_ = t;
        report_target(t);
    }
}

void StepperService::report_motion_values(const motion::Snapshot &s)
{
    reported_position_ = s.position;
    reported_speed_ = s.speed;
    report_position(s.position);
    report_speed_hz(s.speed);
}

uint32_t StepperService::speed_bound(TimeUs now) const
{
    const uint64_t dt = now > last_speed_at_ ? static_cast<uint64_t>(now - last_speed_at_) : 0;
    const uint64_t b = last_speed_ + uint64_t{accel_} * dt / 1'000'000;
    return static_cast<uint32_t>(std::min<uint64_t>(b, std::max(cap_, last_speed_)));
}

void StepperService::emit_rest(StepperDoneReason why, const motion::Snapshot &s)
{
    // A move's done carries the target it had (a stopped one's too); a jog has none but where it came to rest.
    emit_done({why, s.position, kind_ == Kind::move ? move_target_ : s.position, s.slips});
}

bool StepperService::take_rest(TimeUs now, motion::Rest command_rest)
{
    const motion::Snapshot s = drv_.snapshot();
    // A fault's rest is on_fault's; the command's own is the caller's.
    if (!running() || s.rests == seen_rests_ || s.last_rest == command_rest || s.last_rest == motion::Rest::fault) {
        return false;
    }
    seen_rests_ = s.rests;
    emit_rest(reason_of(s.last_rest, stop_reason_), s);
    rested(now);
    return true;
}

void StepperService::observe(TimeUs now, bool force_report)
{
    const motion::Snapshot s = drv_.snapshot();
    // A fault's rest is on_fault's (the driver's ISR has cut and its input slot follows).
    if (s.rests != seen_rests_ && s.last_rest != motion::Rest::fault) {
        seen_rests_ = s.rests;
        if (running()) {
            emit_rest(reason_of(s.last_rest, stop_reason_), s);
            if (!s.running) {
                rested(now);
                return;
            }
        }
    }
    if (!running()) {
        return;
    }
    last_speed_ = magnitude(s.speed);
    last_speed_at_ = now;
    if (force_report || now >= next_report_) {
        if (s.position != reported_position_ || s.speed != reported_speed_) {
            report_motion_values(s);
            set_target(s.target);  // a jog or a stop plans no end: its target follows the position
            next_report_ = now + 1'000'000 / cfg_.report_hz;
        }
    }
}

void StepperService::rested(TimeUs now)
{
    const motion::Snapshot s = drv_.snapshot();
    set_target(s.position);
    set_motion(StepperMotion::holding);
    report_motion_values(s);  // the exact rest, whatever the rate limit held back
    // The driver still drives the last vector at run power: it settles there, then drops to hold power.
    settle_until_ = now + kSettleUs;
    release_at_ = set_.release_ms != 0 ? now + static_cast<TimeUs>(set_.release_ms) * 1000 : 0;
    jog_until_ = 0;
    hub_ = false;
    stop_reason_ = StepperDoneReason::stopped;
    last_speed_ = 0;
}

void StepperService::schedule(TimeUs now)
{
    TimeUs next = std::numeric_limits<TimeUs>::max();
    if (running()) {
        next = now + kPollUs;
    }
    if (settle_until_ != 0) {
        next = std::min(next, settle_until_);
    }
    if (release_at_ != 0) {
        next = std::min(next, release_at_);
    }
    if (next == std::numeric_limits<TimeUs>::max()) {
        tick_->stop();
        return;
    }
    tick_->start(static_cast<uint32_t>(std::max<TimeUs>(next - now, 0)));
}

void StepperService::on_timer()
{
    const TimeUs now = core_->now();
    if (running()) {
        observe(now, false);
    }
    if (motion_ == StepperMotion::moving) {
        if (jog_until_ != 0 && now >= jog_until_) {
            (void)begin_stop(StepperDoneReason::elapsed);
        } else if (hub_) {
            const net::LinkInfo li = core::link_info();
            if (li.hub_epoch != hub_epoch_ || now - li.hub_heard_at >= kHubSilentUs) {
                (void)begin_stop(StepperDoneReason::hub_lost);  // decelerated: no steps lost
            }
        }
    }
    if (settle_until_ != 0 && now >= settle_until_) {
        settle_until_ = 0;
        if (motion_ == StepperMotion::holding) {
            (void)drv_.energise(hold_permille_);  // refused only by a fault, which on_fault takes
        }
    }
    if (release_at_ != 0 && now >= release_at_) {
        release_at_ = 0;
        settle_until_ = 0;
        drv_.release();
        set_motion(StepperMotion::released);
    }
    schedule(now);
}

void StepperService::on_fault()
{
    if (tick_ == nullptr) {
        return;  // init refused the config after the driver's: its cut is all there is
    }
    const TimeUs now = core_->now();
    // The engine rested by itself before the cut (the poll had not seen it yet; a fault at rest adds no rest): that
    // motion ended with its own done, and a cut at rest loses no step.
    (void)take_rest(now, motion::Rest::fault);
    const motion::Snapshot s = drv_.snapshot();
    const bool was_running = running();
    // The faults of the last minute, newest first, this one included.
    uint8_t n = 0;
    while (n < n_faults_ && now - faults_[n] < kFaultWindowUs) {
        ++n;
    }
    n = std::min(n, static_cast<uint8_t>(faults_.size() - 1));
    for (uint8_t i = n; i > 0; --i) {
        faults_[i] = faults_[i - 1];
    }
    faults_[0] = now;
    n_faults_ = n + 1;
    backoff_until_ = now + (n_faults_ >= kLongBackoffFaults ? kLongBackoffUs : kBackoffUs);
    if (was_running && speed_bound(now) > set_.start_hz) {
        set_known(false);
    }
    const auto cause = injected_ ? cap::StepperFaultCause::injected : cap::StepperFaultCause::driver;
    injected_ = false;
    emit_fault({cause, s.position, n_faults_});
    seen_rests_ = s.rests;
    if (was_running) {
        emit_rest(StepperDoneReason::fault, s);
    }
    settle_until_ = 0;
    release_at_ = 0;
    jog_until_ = 0;
    hub_ = false;
    set_target(s.position);
    set_motion(StepperMotion::fault);
    report_motion_values(s);
    schedule(now);
}

Status StepperService::ready_to_energise(TimeUs now)
{
    if (now < backoff_until_) {
        return std::unexpected(Err::busy);
    }
    if (drv_.snapshot().faulted) {
        // A latch on_fault has not taken yet (its input slot is pending) is not cleared behind its back.
        if (motion_ != StepperMotion::fault && motion_ != StepperMotion::released) {
            return std::unexpected(Err::busy);
        }
        if (auto st = drv_.clear_fault(); !st) {
            return st;  // nFAULT still low
        }
        motion_ = StepperMotion::released;  // reported with the motion that follows
    } else if (motion_ == StepperMotion::fault) {
        motion_ = StepperMotion::released;
    }
    return {};
}

Status StepperService::start(const motion::Request &r, Kind kind, TimeUs now)
{
    const bool from_rest = !running();
    if (auto st = drv_.command(r); !st) {
        set_motion(motion_);
        return st;
    }
    kind_ = kind;
    if (kind == Kind::move) {
        move_target_ = r.target;
    }
    accel_ = r.accel;
    cap_ = kind == Kind::move ? r.vmax : magnitude(r.speed);
    if (from_rest) {
        last_speed_ = 0;
        last_speed_at_ = now;
        next_report_ = now;
    }
    const net::LinkInfo li = core::link_info();
    hub_ = li.hub_session;
    hub_epoch_ = li.hub_epoch;
    settle_until_ = 0;
    release_at_ = 0;
    jog_until_ = 0;
    stop_reason_ = StepperDoneReason::stopped;
    set_target(drv_.snapshot().target);  // a move's; a jog's follows the position
    set_motion(StepperMotion::moving);
    schedule(now);
    return {};
}

Status StepperService::move(int64_t target, bool has_speed, uint16_t speed, bool has_accel, uint32_t accel)
{
    if (tick_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if ((has_speed && speed > set_.max_speed_hz) || (has_accel && accel > set_.accel) ||
        !within(target, -kBound, kBound) || (set_.limits && !within(target, set_.limit_min, set_.limit_max))) {
        return std::unexpected(Err::invalid_args);
    }
    const TimeUs now = core_->now();
    if (running()) {
        observe(now, false);
    }
    if (set_.limits && !known_) {
        return std::unexpected(Err::busy);  // zero it first
    }
    if (auto st = ready_to_energise(now); !st) {
        return st;
    }
    const motion::Snapshot s = drv_.snapshot();
    if (!s.running && target == s.position) {
        // Already there: done at once, nothing driven.
        set_motion(motion_);
        emit_done({StepperDoneReason::reached, s.position, s.position, 0});
        return {};
    }
    motion::Request r;
    r.kind = motion::Request::Kind::move_to;
    r.target = static_cast<int32_t>(target);
    r.vmax = has_speed ? speed : set_.max_speed_hz;
    r.accel = has_accel ? accel : set_.accel;
    return start(bounds(r), Kind::move, now);
}

Status StepperService::move_to(const cap::StepperMoveToArgs &args)
{
    return move(args.position, args.has_speed_hz, args.speed_hz, args.has_accel, args.accel);
}

Status StepperService::move_by(const cap::StepperMoveByArgs &args)
{
    if (tick_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (running()) {
        observe(core_->now(), false);
    }
    // From the running move's target (two quick move_by 10 make 20), else from the position (a jog's too: the
    // snapshot's target of a jog or a stop is its position).
    const motion::Snapshot s = drv_.snapshot();
    const int64_t base = s.running ? s.target : s.position;
    return move(base + args.steps, args.has_speed_hz, args.speed_hz, args.has_accel, args.accel);
}

Status StepperService::jog(const cap::StepperJogArgs &args)
{
    if (tick_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const uint32_t speed = magnitude(args.speed_hz);
    if (speed > set_.max_speed_hz || (args.has_accel && args.accel > set_.accel)) {
        return std::unexpected(Err::invalid_args);
    }
    if (args.speed_hz == 0) {
        return stop();
    }
    const TimeUs now = core_->now();
    if (running()) {
        observe(now, false);
    }
    if (set_.limits && !known_) {
        return std::unexpected(Err::busy);
    }
    if (auto st = ready_to_energise(now); !st) {
        return st;
    }
    motion::Request r;
    r.kind = motion::Request::Kind::jog;
    r.speed = args.speed_hz;
    r.vmax = speed;
    r.accel = args.has_accel ? args.accel : set_.accel;
    r = bounds(r);
    const motion::Snapshot s = drv_.snapshot();
    if (!s.running && (args.speed_hz > 0 ? s.position >= r.hi : s.position <= r.lo)) {
        // Already at the bound it turns toward: done at once, nothing driven.
        set_motion(motion_);
        emit_done({StepperDoneReason::limit, s.position, s.position, 0});
        return {};
    }
    if (auto st = start(r, Kind::jog, now); !st) {
        return st;
    }
    if (args.seconds != 0) {
        jog_until_ = now + static_cast<TimeUs>(args.seconds) * 1'000'000;
    }
    return {};
}

Status StepperService::begin_stop(StepperDoneReason why)
{
    motion::Request r;
    r.kind = motion::Request::Kind::stop;  // accel 0: the running motion's
    if (auto st = drv_.command(bounds(r)); !st) {
        return st;  // a latched fault: on_fault ends it
    }
    stop_reason_ = why;
    jog_until_ = 0;
    set_target(drv_.snapshot().target);  // a stop plans no end: the target follows the position
    set_motion(StepperMotion::stopping);
    return {};
}

Status StepperService::stop()
{
    if (tick_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const TimeUs now = core_->now();
    if (running()) {
        observe(now, false);
    }
    if (motion_ != StepperMotion::moving) {
        return {};  // at rest, or stopping already
    }
    auto st = begin_stop(StepperDoneReason::stopped);
    schedule(now);
    return st;
}

void StepperService::end_now(StepperDoneReason why, int32_t speed, TimeUs now)
{
    // The driver ended it at once: the engine's rest is taken here, not by the poll.
    const motion::Snapshot s = drv_.snapshot();
    seen_rests_ = s.rests;
    if (magnitude(speed) > set_.start_hz) {
        set_known(false);
    }
    emit_rest(why, s);
    jog_until_ = 0;
    hub_ = false;
    last_speed_ = 0;
    last_speed_at_ = now;
}

Status StepperService::halt()
{
    if (tick_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const TimeUs now = core_->now();
    if (running()) {
        observe(now, false);
    }
    if (!running()) {
        return {};
    }
    const int32_t speed = drv_.snapshot().speed;
    motion::Request r;
    r.kind = motion::Request::Kind::halt;
    if (auto st = drv_.command(r); !st) {
        return st;
    }
    // The step ISR may have rested the motion between the look above and the driver's lock: then that rest is its end.
    if (!take_rest(now, motion::Rest::halted)) {
        end_now(StepperDoneReason::halted, speed, now);
        rested(now);
    }
    schedule(now);
    return {};
}

Status StepperService::hold()
{
    if (tick_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const TimeUs now = core_->now();
    if (running()) {
        observe(now, false);
    }
    if (running()) {
        return std::unexpected(Err::busy);
    }
    if (motion_ == StepperMotion::holding && settle_until_ == 0 && release_at_ == 0) {
        return {};  // held already, with no release coming
    }
    if (auto st = ready_to_energise(now); !st) {
        return st;
    }
    if (auto st = drv_.energise(hold_permille_); !st) {
        set_motion(motion_);
        return st;
    }
    // Indefinite: no idle release until a motion ends.
    settle_until_ = 0;
    release_at_ = 0;
    set_motion(StepperMotion::holding);
    schedule(now);
    return {};
}

Status StepperService::release()
{
    if (tick_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const TimeUs now = core_->now();
    if (running()) {
        observe(now, false);
    }
    const bool faulted = motion_ == StepperMotion::fault || drv_.snapshot().faulted;
    if (motion_ == StepperMotion::released && !faulted) {
        return {};
    }
    const bool was_running = running();
    const int32_t speed = drv_.snapshot().speed;
    drv_.release();
    // A rest the step ISR made between the look above and the driver's lock is that motion's own end.
    if (was_running && !take_rest(now, motion::Rest::released)) {
        end_now(StepperDoneReason::released, speed, now);
    }
    if (faulted) {
        (void)drv_.clear_fault();  // no energise; a fault still asserted stays latched, and a later move retries
    }
    settle_until_ = 0;
    release_at_ = 0;
    set_motion(StepperMotion::released);
    if (was_running) {
        const motion::Snapshot s = drv_.snapshot();
        set_target(s.position);
        report_motion_values(s);
    }
    schedule(now);
    return {};
}

Status StepperService::zero(const cap::StepperZeroArgs &args)
{
    if (tick_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (running()) {
        observe(core_->now(), false);
    }
    if (running()) {
        return std::unexpected(Err::busy);
    }
    if (auto st = drv_.set_position(args.position); !st) {
        return st;
    }
    set_known(true);
    set_target(args.position);
    report_motion_values(drv_.snapshot());
    return {};
}

void StepperService::apply(const cap::StepperConfig &old)
{
    const uint16_t old_run = run_permille_;
    const uint16_t old_hold = hold_permille_;
    run_permille_ = run_permille_of(set_.run_ma, set_.coil_ohm, set_.supply_mv);
    hold_permille_ = static_cast<uint16_t>(std::max<uint32_t>(1, uint32_t{run_permille_} * set_.hold_pct / 100));
    const cap::StepperConfig &n = set_;
    if (n.step_mode != old.step_mode) {
        report_step_mode(n.step_mode);
    }
    if (n.max_speed_hz != old.max_speed_hz) {
        report_max_speed_hz(n.max_speed_hz);
    }
    if (n.accel != old.accel) {
        report_accel(n.accel);
    }
    if (n.start_hz != old.start_hz) {
        report_start_hz(n.start_hz);
    }
    if (n.coil_ohm != old.coil_ohm) {
        report_coil_ohm(n.coil_ohm);
    }
    if (n.run_ma != old.run_ma) {
        report_run_ma(n.run_ma);
    }
    if (n.hold_pct != old.hold_pct) {
        report_hold_pct(n.hold_pct);
    }
    if (n.release_ms != old.release_ms) {
        report_release_ms(n.release_ms);
    }
    if (n.supply_mv != old.supply_mv) {
        report_supply_mv(n.supply_mv);
    }
    if (n.invert != old.invert) {
        report_invert(n.invert);
    }
    if (n.limits != old.limits) {
        report_limits(n.limits);
    }
    if (n.limit_min != old.limit_min) {
        report_limit_min(n.limit_min);
    }
    if (n.limit_max != old.limit_max) {
        report_limit_max(n.limit_max);
    }
    if ((run_permille_ + 9) / 10 != (old_run + 9) / 10) {
        report_run_duty_pct(run_duty_pct());
    }
    // Holding: the new power at once (the shape applies from the next energise).
    if (motion_ == StepperMotion::holding && (run_permille_ != old_run || hold_permille_ != old_hold)) {
        (void)drv_.energise(settle_until_ != 0 ? run_permille_ : hold_permille_);
    }
}

Status StepperService::configure(const cap::StepperConfigureArgs &a)
{
    if (tick_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (running()) {
        observe(core_->now(), false);
    }
    if (running()) {
        return std::unexpected(Err::busy);
    }
    cap::StepperConfig n = set_;
    int shift = 0;
    if (a.has_step_mode && a.step_mode != set_.step_mode) {
        if (static_cast<uint8_t>(a.step_mode) > drv_.max_microsteps_log2()) {
            return std::unexpected(Err::invalid_args);
        }
        if (motion_ != StepperMotion::released) {
            return std::unexpected(Err::busy);
        }
        // The motor's physical behaviour stays put: every stored step quantity follows the step size.
        shift = static_cast<int>(a.step_mode) - static_cast<int>(set_.step_mode);
        n.step_mode = a.step_mode;
        n.max_speed_hz = static_cast<uint16_t>(scale_u(set_.max_speed_hz, shift, kMinSpeed, kMaxSpeed));
        n.accel = scale_u(set_.accel, shift, kMinAccel, kMaxAccel);
        n.start_hz = static_cast<uint16_t>(scale_u(set_.start_hz, shift, kMinSpeed, kMaxSpeed));
        n.limit_min = rescale(set_.limit_min, shift);
        n.limit_max = rescale(set_.limit_max, shift);
    }
    if (a.has_max_speed_hz) {
        n.max_speed_hz = a.max_speed_hz;
    }
    if (a.has_accel) {
        n.accel = a.accel;
    }
    if (a.has_start_hz) {
        n.start_hz = a.start_hz;
    }
    if (a.has_coil_ohm) {
        n.coil_ohm = a.coil_ohm;
    }
    if (a.has_run_ma) {
        n.run_ma = a.run_ma;
    }
    if (a.has_hold_pct) {
        n.hold_pct = a.hold_pct;
    }
    if (a.has_release_ms) {
        n.release_ms = a.release_ms;
    }
    if (a.has_supply_mv) {
        n.supply_mv = a.supply_mv;
    }
    if (a.has_invert) {
        n.invert = a.invert;
    }
    if (a.has_limits) {
        n.limits = a.limits;
    }
    if (a.has_limit_min) {
        n.limit_min = a.limit_min;
    }
    if (a.has_limit_max) {
        n.limit_max = a.limit_max;
    }
    if (n.limit_min >= n.limit_max) {
        return std::unexpected(Err::invalid_args);
    }
    if (auto st = drv_.shape(shape_of(n)); !st) {
        return st;
    }
    if (shift != 0) {
        const int32_t p = rescale(drv_.snapshot().position, shift);
        if (auto st = drv_.set_position(p); !st) {
            return st;
        }
        set_target(p);
    }
    const cap::StepperConfig old = set_;
    set_ = n;
    apply(old);
    if (shift != 0) {
        report_motion_values(drv_.snapshot());
    }
    return write_settings();
}

Status StepperService::reset_settings()
{
    if (tick_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (running()) {
        observe(core_->now(), false);
    }
    if (motion_ != StepperMotion::released) {
        return std::unexpected(Err::busy);
    }
    // m alone (one key): the others stay behind and are ignored, and the next configure rewrites them all.
    const std::array<const char *, 1> keys{key(kM)};
    if (auto st = settings_.erase(keys); !st) {
        return st;  // nothing changed
    }
    kept_ = false;
    stored_mask_ = 0;
    const int shift = static_cast<int>(cfg_.step_mode) - static_cast<int>(set_.step_mode);
    if (auto st = drv_.shape(shape_of(cfg_)); !st) {
        return st;
    }
    if (shift != 0) {
        const int32_t p = rescale(drv_.snapshot().position, shift);
        if (auto st = drv_.set_position(p); !st) {
            return st;
        }
        set_target(p);
    }
    const cap::StepperConfig old = set_;
    set_ = cfg_;
    apply(old);
    if (shift != 0) {
        report_motion_values(drv_.snapshot());
    }
    return {};
}

#if FR_TEST_HOOKS
Status StepperService::inject_fault()
{
    if (tick_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    // The driver runs its fault ISR's path; on_fault follows on the core task and names the cause.
    injected_ = true;
    drv_.inject_fault();
    return {};
}
#endif

}  // namespace fr
