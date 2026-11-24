// fr:realtime
#include "fr/services/haptic_service.hpp"

#include <algorithm>

// fr::core::link_info(): the hub's newest frame and run, for the hub-silence rule (as FixtureService's D11 rule).
#include "fr/core/node_net.hpp"

namespace fr {
namespace {

constexpr uint16_t kErmMaxOnMs = 10000;
constexpr uint16_t kSolenoidMaxOnMs = 1000;
constexpr uint8_t kErmCooldownPct = 100;
constexpr uint8_t kSolenoidCooldownPct = 30;
constexpr size_t kBuckets = HapticService::kWindowUs / HapticService::kBucketUs;

}  // namespace

HapticService::HapticService(hal::HapticOutput &out, const cap::HapticConfig &cfg) : out_(out), cfg_(cfg)
{
    traits_.pwm = out_.pwm();
    const bool solenoid = cfg_.kind == cap::HapticKind::solenoid;
    max_on_ms_ = cfg_.max_on_ms != 0 ? cfg_.max_on_ms : (solenoid ? kSolenoidMaxOnMs : kErmMaxOnMs);
    cooldown_pct_ = cfg_.cooldown_pct != 0 ? cfg_.cooldown_pct : (solenoid ? kSolenoidCooldownPct : kErmCooldownPct);
}

uint16_t HapticService::compensate(uint8_t level_pct, uint16_t rated_mv, uint16_t supply_mv)
{
    const uint32_t base = static_cast<uint32_t>(std::min<uint8_t>(level_pct, 100)) * 10;
    if (supply_mv == 0) {
        return static_cast<uint16_t>(base);
    }
    const uint32_t d = (base * rated_mv + supply_mv / 2) / supply_mv;
    return static_cast<uint16_t>(std::min<uint32_t>(d, 1000));
}

Status HapticService::init(Core &core)
{
    // The output first (review B1): driven off before anything here can fail, so a refused config or a missing timer
    // never leaves the pad as a CPU reset left it (LEDC keeps running through one).
    if (auto st = out_.init(core); !st) {
        return st;
    }
    if (cfg_.rated_mv == 0 || cfg_.hold_pct < 1 || cfg_.hold_pct > 100 || cfg_.cooldown_pct > 100 ||
        !cap::is_known(cfg_.kind) || cfg_.kick_ms > max_on_ms_) {
        return std::unexpected(Err::invalid_args);
    }
    core_ = &core;
    tick_ = core.timer([this] { on_tick(); });
    if (tick_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const TimeUs now = core.now();
    bucket_start_ = now;
    accounted_to_ = now;
    return {};
}

hal::Selftest HapticService::selftest()
{
    return out_.selftest();
}

uint32_t HapticService::spent_ms() const
{
    uint64_t sum = 0;
    for (uint32_t b : buckets_) {
        sum += b;
    }
    return static_cast<uint32_t>(sum / 1000);
}

void HapticService::account(TimeUs now)
{
    // Roll the window to `now`, crediting the on-time to the bucket it fell in, piece by piece.
    TimeUs from = accounted_to_;
    if (now - bucket_start_ >= kWindowUs + kBucketUs) {
        // Long idle: everything in the window is old.
        if (!on_) {
            buckets_.fill(0);
            bucket_ = 0;
            bucket_start_ = now;
            accounted_to_ = now;
            return;
        }
    }
    while (true) {
        const TimeUs bucket_end = bucket_start_ + kBucketUs;
        const TimeUs upto = std::min(now, bucket_end);
        if (on_ && upto > from) {
            // In microseconds (review m4): no remainder lost per tick.
            const uint64_t add = static_cast<uint64_t>(upto - from);
            buckets_[bucket_] = static_cast<uint32_t>(std::min<uint64_t>(buckets_[bucket_] + add, kBucketUs));
        }
        from = std::max(from, upto);
        if (now < bucket_end) {
            break;
        }
        bucket_ = (bucket_ + 1) % kBuckets;
        buckets_[bucket_] = 0;
        bucket_start_ = bucket_end;
    }
    accounted_to_ = now;
}

bool HapticService::supply_refuses() const
{
    if (supply_ == nullptr) {
        return false;
    }
    if (!supply_->reading_ok() || supply_->level() >= cap::BatteryCellLevel::critical) {
        return true;
    }
    // A solenoid's kick sags the terminal by I x ESR: start only well above critical (review M5).
    return cfg_.kind == cap::HapticKind::solenoid && supply_->mv() < supply_->critical_mv() + kSolenoidMarginMv;
}

void HapticService::write(uint16_t duty)
{
    const bool on = duty > 0;
    if (on != on_ && core_ != nullptr) {
        account(core_->now());
        if (on) {
            on_since_ = core_->now();
        }
    }
    on_ = on;
    if (duty != duty_ || duty == 0) {
        (void)out_.write(duty);
    }
    duty_ = duty;
}

void HapticService::report_supply(TimeUs now, bool force)
{
    if (supply_ == nullptr) {
        return;
    }
    const uint16_t mv = supply_->mv();
    const uint16_t moved = mv > last_supply_ ? mv - last_supply_ : last_supply_ - mv;
    if (force || (moved >= kSupplyBandMv && now - last_supply_at_ >= kSupplyReportUs)) {
        last_supply_ = mv;
        last_supply_at_ = now;
        report_supply_mv(mv, now);
    }
}

Status HapticService::pulse(const cap::HapticPulseArgs &args)
{
    if (args.ms == 0 || args.ms > max_on_ms_) {
        return std::unexpected(Err::invalid_args);
    }
    const uint16_t steps[] = {args.ms};
    return start(cap::HapticProgram::pulse, steps, 1, args.level, 1);
}

Status HapticService::play(const cap::HapticPlayArgs &args)
{
    const size_t n = args.steps.size();
    if (n == 0 || n > kMaxSteps) {
        return std::unexpected(Err::invalid_args);
    }
    bool any_on = false;
    for (size_t i = 0; i < n; i += 2) {
        if (args.steps[i] > max_on_ms_) {
            return std::unexpected(Err::invalid_args);
        }
        any_on = any_on || args.steps[i] > 0;
    }
    if (!any_on) {
        return std::unexpected(Err::invalid_args);
    }
    if (cfg_.kind == cap::HapticKind::solenoid) {
        // Every on-step is followed by a real break (review B2): no zero off-step, and a repeat ends on an off-step.
        for (size_t i = 1; i < n; i += 2) {
            if (args.steps[i] == 0) {
                return std::unexpected(Err::invalid_args);
            }
        }
        if (n % 2 == 1 && args.repeat > 1) {
            return std::unexpected(Err::invalid_args);
        }
    }
    std::array<uint16_t, kMaxSteps> copy{};
    for (size_t i = 0; i < n; ++i) {
        copy[i] = args.steps[i];
    }
    return start(cap::HapticProgram::play, copy.data(), n, args.level, args.repeat);
}

bool HapticService::train_fits(uint16_t period_ms, uint16_t ms, uint8_t cooldown_pct)
{
    if (cooldown_pct >= 100) {
        return true;
    }
    if (period_ms == 0) {
        return false;
    }
    const uint32_t window_ms = static_cast<uint32_t>(kWindowUs / 1000);
    const uint32_t taps = (window_ms + period_ms - 1) / period_ms;
    const uint32_t budget_ms = static_cast<uint32_t>(cooldown_pct) * window_ms / 100;
    // Strictly under: the service cuts at budget_ms.
    return taps * (static_cast<uint32_t>(ms) + 1) < budget_ms;
}

Status HapticService::admit(TimeUs now)
{
    if (supply_refuses()) {
        return std::unexpected(Err::busy);
    }
    account(now);
    const uint32_t budget_ms = static_cast<uint32_t>(cooldown_pct_) * (kWindowUs / 1000) / 100;
    // The running program's own on-time counts too: a replacement starts from what was spent.
    if (cooldown_pct_ < 100 && spent_ms() >= budget_ms) {
        return std::unexpected(Err::busy);
    }
    return {};
}

void HapticService::begin(cap::HapticProgram program, TimeUs now)
{
    if (active_) {
        emit_done({program_, cap::HapticDoneReason::replaced}, now);
    }
    program_ = program;
    const net::LinkInfo li = core::link_info();
    hub_ = li.hub_session;
    hub_epoch_ = li.hub_epoch;
    if (!active_) {
        active_ = true;
        report_active(true, now);
    }
    report_supply(now, true);
}

Status HapticService::start(cap::HapticProgram program, const uint16_t *steps, size_t n, uint8_t level, uint8_t repeat)
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const TimeUs now = core_->now();
    if (auto st = admit(now); !st) {
        return st;
    }
    for (size_t i = 0; i < n; ++i) {
        steps_[i] = steps[i];
    }
    n_steps_ = n;
    level_ = std::clamp<uint8_t>(level, 1, 100);
    repeats_left_ = std::max<uint8_t>(repeat, 1);
    step_ = 0;
    step_start_ = now;
    begin(program, now);
    run(now);
    return {};
}

Status HapticService::tap(const cap::HapticTapArgs &args)
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (args.period_ms < 20 || args.ms == 0 || args.ms >= args.period_ms || args.ms > max_on_ms_ ||
        !train_fits(args.period_ms, args.ms, cooldown_pct_)) {
        return std::unexpected(Err::invalid_args);
    }
    const TimeUs now = core_->now();
    const bool change = active_ && program_ == cap::HapticProgram::tap;
    if (!change) {
        if (auto st = admit(now); !st) {
            return st;
        }
    }
    // Whether the tap that started last is still on, by the settings it started with.
    const bool was_on = change && now < tap_start_ + static_cast<TimeUs>(tap_ms_) * 1000;
    period_us_ = static_cast<TimeUs>(args.period_ms) * 1000;
    tap_ms_ = args.ms;
    level_ = std::clamp<uint8_t>(args.level, 1, 100);
    accent_ = args.accent;
    accent_level_ = std::clamp<uint8_t>(args.accent_level, 1, 100);
    forever_ = args.count == 0;
    if (change) {
        // In place (D2): the beat is kept, the count starts again, the accent counts on; the hub that asked now owns it.
        const net::LinkInfo li = core::link_info();
        hub_ = li.hub_session;
        hub_epoch_ = li.hub_epoch;
        if (was_on) {
            taps_left_ = args.count;  // the tap that is on is the first
        } else if (tap_start_ + period_us_ <= now) {
            tap_start_ = now;  // overdue at the new rate: now
            ++tap_no_;
            taps_left_ = args.count;
        } else {
            taps_left_ = static_cast<uint32_t>(args.count) + 1;  // the tap that ended, then count more
        }
    } else {
        tap_start_ = now;
        tap_no_ = 0;
        taps_left_ = args.count;
        begin(cap::HapticProgram::tap, now);
    }
    run(now);
    return {};
}

Status HapticService::stop()
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (active_) {
        finish(cap::HapticDoneReason::stopped, core_->now());
    }
    return {};
}

void HapticService::on_tick()
{
    if (!active_) {
        return;
    }
    const TimeUs now = core_->now();
    if (supply_ != nullptr) {
        // No 0 mV sentinel (review m2): a supply without a fresh reading cuts as a low one.
        const cap::BatteryCellLevel l = supply_->level();
        if (supply_->reading_ok() && l == cap::BatteryCellLevel::empty) {
            cut(cap::HapticCutReason::floor, now);
            return;
        }
        if (!supply_->reading_ok() || l >= cap::BatteryCellLevel::critical) {
            cut(cap::HapticCutReason::low_supply, now);
            return;
        }
    }
    if (hub_) {
        const net::LinkInfo li = core::link_info();
        if (li.hub_epoch != hub_epoch_ || now - li.hub_heard_at >= kHubSilentUs) {
            finish(cap::HapticDoneReason::hub_lost, now);  // the hub that asked is gone (1.1: said in a done)
            return;
        }
    }
    account(now);
    if (cooldown_pct_ < 100 && on_) {
        const uint32_t budget_ms = static_cast<uint32_t>(cooldown_pct_) * (kWindowUs / 1000) / 100;
        if (spent_ms() >= budget_ms) {
            cut(cap::HapticCutReason::max_on, now);
            return;
        }
    }
    report_supply(now, false);
    run(now);
    // Continuous on-time (review B2), after the steps moved on: an on-step that ends exactly at max_on_ms ends there
    // without a cut; one that runs on (a repeat's wrap, a zero off-step, a replacing pulse) is cut.
    if (active_ && on_ && now - on_since_ >= static_cast<TimeUs>(max_on_ms_) * 1000) {
        cut(cap::HapticCutReason::max_on, now);
    }
}

void HapticService::run(TimeUs now)
{
    bool on = false;
    uint8_t level = level_;
    TimeUs on_start = 0;  // the on-step's start (the solenoid's kick counts from it)
    TimeUs next = 0;      // the step's end
    if (program_ == cap::HapticProgram::tap) {
        const TimeUs ms_us = static_cast<TimeUs>(tap_ms_) * 1000;
        while (true) {
            if (now < tap_start_ + ms_us) {
                break;  // on
            }
            if (!forever_ && taps_left_ <= 1) {
                finish(cap::HapticDoneReason::done, now);  // the last tap's on-time is over
                return;
            }
            const TimeUs next_tap = tap_start_ + period_us_;
            if (now < next_tap) {
                break;  // between taps
            }
            tap_start_ = next_tap;
            ++tap_no_;
            if (!forever_) {
                --taps_left_;
            }
        }
        on = now < tap_start_ + ms_us;
        on_start = tap_start_;
        next = on ? tap_start_ + ms_us : tap_start_ + period_us_;
        if (accent_ != 0 && tap_no_ % accent_ == 0) {
            level = accent_level_;
        }
    } else {
        while (true) {
            const TimeUs end = step_start_ + static_cast<TimeUs>(steps_[step_]) * 1000;
            if (now < end) {
                break;
            }
            step_start_ = end;
            ++step_;
            if (step_ == n_steps_) {
                if (--repeats_left_ == 0) {
                    finish(cap::HapticDoneReason::done, now);
                    return;
                }
                step_ = 0;
            }
        }
        on = step_ % 2 == 0;
        on_start = step_start_;
        next = step_start_ + static_cast<TimeUs>(steps_[step_]) * 1000;
    }
    const uint16_t supply = supply_ != nullptr ? supply_->mv() : 0;
    const bool solenoid = cfg_.kind == cap::HapticKind::solenoid;
    const TimeUs kick_end = on_start + static_cast<TimeUs>(cfg_.kick_ms) * 1000;
    uint16_t duty = 0;
    if (on) {
        if (solenoid && now >= kick_end) {
            duty = compensate(std::min(cfg_.hold_pct, level), cfg_.rated_mv, supply);  // never holds harder than it kicked
        } else {
            duty = compensate(level, cfg_.rated_mv, supply);  // an ERM, or a solenoid's kick (1.1: at its level)
        }
        if (!traits_.pwm && duty > 0) {
            duty = 1000;
        }
    }
    write(duty);
    // The next look: the step's end or the next tick, whichever comes first; the solenoid's kick end too.
    if (on && solenoid && kick_end > now) {
        next = std::min(next, kick_end);
    }
    if (on_) {
        next = std::min(next, on_since_ + static_cast<TimeUs>(max_on_ms_) * 1000);  // the max_on cut lands on time
    }
    next = std::min<TimeUs>(next, now + kTickUs);
    tick_->start(static_cast<uint32_t>(std::max<TimeUs>(next - now, 0)));
}

void HapticService::finish(cap::HapticDoneReason why, TimeUs now)
{
    write(0);
    account(now);
    tick_->stop();
    active_ = false;
    emit_done({program_, why}, now);
    report_active(false, now);
    report_supply(now, true);
}

void HapticService::cut(cap::HapticCutReason why, TimeUs now)
{
    const uint16_t mv = supply_ != nullptr ? supply_->mv() : 0;
    write(0);
    emit_cut({why, mv}, now);
    finish(cap::HapticDoneReason::cut, now);
}

}  // namespace fr
