// fr:realtime
// BuzzerService (design buzzer-b1 D5, D6): see fr/services/buzzer_service.hpp.
#include "fr/services/buzzer_service.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>

// fr::core::link_info(): the hub's newest frame and run, for the hub-silence rule (as HapticService's).
#include "fr/core/node_net.hpp"

namespace fr {
namespace {

constexpr uint16_t kFullDuty = 500;  // permille: a 50 % square, the loudest

}  // namespace

BuzzerService::BuzzerService(hal::ToneOutput &out, const cap::BuzzerConfig &cfg)
    : out_(out), cfg_(cfg), volume_(std::min<uint8_t>(cfg.volume, 100)), level_(volume_)
{
    traits_.pitched = out_.pitched();
    traits_.volume = out_.volume();
    traits_.min_hz = out_.min_hz();
    traits_.max_hz = out_.max_hz();
}

uint16_t BuzzerService::duty_for_volume(uint8_t volume)
{
    if (volume == 0) {
        return 0;
    }
    if (volume >= 100) {
        return kFullDuty;
    }
    const double d = std::asin(static_cast<double>(volume) / 100.0) / std::numbers::pi;
    return static_cast<uint16_t>(std::lround(d * 1000.0));
}

Status BuzzerService::init(Core &core)
{
    // The output first: silent before anything here can fail, so a refused config or a missing timer never leaves the
    // pad as a CPU reset left it (LEDC keeps running through one).
    if (auto st = out_.init(core); !st) {
        return st;
    }
    if (cfg_.volume > 100 || (traits_.pitched && !pitch_ok(cfg_.beep_hz, false))) {
        return std::unexpected(Err::invalid_args);
    }
    core_ = &core;
    timer_ = core.timer([this] { on_timer(); });
    if (timer_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    return {};
}

hal::Selftest BuzzerService::selftest()
{
    return out_.selftest();
}

bool BuzzerService::pitch_ok(uint16_t hz, bool rest_ok) const
{
    if (hz == 0) {
        return rest_ok;
    }
    return !traits_.pitched || (hz >= traits_.min_hz && hz <= traits_.max_hz);
}

Status BuzzerService::tone(const cap::BuzzerToneArgs &args)
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (args.ms == 0 || !pitch_ok(args.freq_hz, false) || (args.has_volume && args.volume > 100)) {
        return std::unexpected(Err::invalid_args);
    }
    steps_[0] = {args.freq_hz, static_cast<uint32_t>(args.ms) * 1000};
    return start(cap::BuzzerSound::tone, 1, 1, args.has_volume, args.volume);
}

Status BuzzerService::beep(const cap::BuzzerBeepArgs &args)
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const uint16_t hz = args.has_freq_hz ? args.freq_hz : cfg_.beep_hz;
    if (args.on_ms == 0 || args.off_ms == 0 || !pitch_ok(hz, false) || (args.has_volume && args.volume > 100)) {
        return std::unexpected(Err::invalid_args);
    }
    steps_[0] = {hz, static_cast<uint32_t>(args.on_ms) * 1000};
    steps_[1] = {0, static_cast<uint32_t>(args.off_ms) * 1000};
    // `count` passes of beep and pause (0: forever); the last pass ends with its beep (run's trim_tail_).
    return start(cap::BuzzerSound::beep, 2, args.count, args.has_volume, args.volume);
}

Status BuzzerService::tone_local(const cap::BuzzerToneArgs &args)
{
    local_ = true;
    auto st = tone(args);
    local_ = false;
    return st;
}

Status BuzzerService::melody_local(const cap::BuzzerMelodyArgs &args)
{
    local_ = true;
    auto st = melody(args);
    local_ = false;
    return st;
}

Status BuzzerService::melody(const cap::BuzzerMelodyArgs &args)
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const size_t n = args.freq_hz.size();
    if (n == 0 || n > kMaxNotes || args.ms.size() != n || (args.has_volume && args.volume > 100)) {
        return std::unexpected(Err::invalid_args);
    }
    for (size_t i = 0; i < n; ++i) {
        if (args.ms[i] == 0 || !pitch_ok(args.freq_hz[i], true)) {
            return std::unexpected(Err::invalid_args);
        }
    }
    size_t k = 0;
    for (size_t i = 0; i < n; ++i) {
        const uint16_t hz = args.freq_hz[i];
        const uint32_t note_us = static_cast<uint32_t>(args.ms[i]) * 1000;
        if (hz == 0) {
            steps_[k++] = {0, note_us};
            continue;
        }
        // The gap is inside the note, at most half of it: two equal notes in a row sound as two.
        const uint32_t gap_us = std::min<uint32_t>(static_cast<uint32_t>(args.gap_ms) * 1000, note_us / 2);
        steps_[k++] = {hz, note_us - gap_us};
        if (gap_us > 0) {
            steps_[k++] = {0, gap_us};
        }
    }
    return start(cap::BuzzerSound::melody, k, args.repeat, args.has_volume, args.volume);
}

Status BuzzerService::start(cap::BuzzerSound sound, size_t n, uint16_t repeat, bool has_volume, uint8_t volume)
{
    const TimeUs now = core_->now();
    timer_->stop();
    if (playing_) {
        emit_done({sound_, cap::BuzzerDoneReason::replaced}, now);
    }
    n_steps_ = n;
    step_ = 0;
    step_end_ = now + steps_[0].us;
    forever_ = repeat == 0;
    repeats_left_ = forever_ ? 0 : static_cast<uint16_t>(repeat - 1);
    trim_tail_ = sound == cap::BuzzerSound::beep;
    sound_ = sound;
    level_ = has_volume ? volume : volume_;
    const net::LinkInfo li = core::link_info();
    hub_ = li.hub_session && !local_;  // a service's own sound (face-f1 D19) is not the hub's: its silence leaves it be
    local_ = false;
    hub_epoch_ = li.hub_epoch;
    if (!write_step()) {
        // The sound never started: the reply says so; nothing plays.
        (void)write(0, 0);
        if (playing_) {
            playing_ = false;
            report_playing(false, now);
        }
        return std::unexpected(Err::failed);
    }
    if (!playing_) {
        playing_ = true;
        report_playing(true, now);
    }
    run(now);
    return {};
}

Status BuzzerService::stop()
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (playing_) {
        finish(cap::BuzzerDoneReason::stopped, core_->now());
    }
    return {};
}

Status BuzzerService::set_volume(const cap::BuzzerSetVolumeArgs &args)
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    if (args.volume > 100) {
        return std::unexpected(Err::invalid_args);
    }
    const bool changed = args.volume != volume_;
    volume_ = args.volume;
    if (playing_) {
        level_ = volume_;
        if (!write_step()) {
            finish(cap::BuzzerDoneReason::error, core_->now());
        }
    }
    if (changed) {
        report_volume(volume_);
    }
    return {};
}

void BuzzerService::on_timer()
{
    if (playing_) {
        run(core_->now());
    }
}

bool BuzzerService::hub_gone(TimeUs now) const
{
    if (!hub_) {
        return false;
    }
    const net::LinkInfo li = core::link_info();
    return li.hub_epoch != hub_epoch_ || now - li.hub_heard_at >= kHubSilentUs;
}

void BuzzerService::run(TimeUs now)
{
    if (hub_gone(now)) {
        finish(cap::BuzzerDoneReason::hub_lost, now);
        return;
    }
    bool moved = false;
    while (now >= step_end_) {
        ++step_;
        const bool last_pass = !forever_ && repeats_left_ == 0;
        // A beep's pause is between beeps: the last pass ends with its beep, not after the pause.
        if (last_pass && trim_tail_ && step_ == n_steps_ - 1) {
            finish(cap::BuzzerDoneReason::done, now);
            return;
        }
        if (step_ == n_steps_) {
            if (last_pass) {
                finish(cap::BuzzerDoneReason::done, now);
                return;
            }
            if (!forever_) {
                --repeats_left_;
            }
            step_ = 0;
        }
        step_end_ += steps_[step_].us;
        moved = true;
    }
    if (moved && !write_step()) {
        finish(cap::BuzzerDoneReason::error, now);
        return;
    }
    TimeUs wake = step_end_;
    if (hub_) {
        wake = std::min(wake, core::link_info().hub_heard_at + kHubSilentUs);
    }
    wake = std::min(wake, now + kWakeUs);
    timer_->start(static_cast<uint32_t>(wake > now ? wake - now : 1));
}

bool BuzzerService::write_step()
{
    const Step &s = steps_[step_];
    uint16_t duty = 0;
    if (s.hz != 0 && level_ > 0) {
        duty = traits_.volume ? duty_for_volume(level_) : kFullDuty;
    }
    return write(s.hz, duty);
}

bool BuzzerService::write(uint16_t hz, uint16_t duty)
{
    if (hz == 0 || duty == 0) {
        if (out_duty_ == 0) {
            return true;  // already silent
        }
        if (!out_.silence()) {
            return false;
        }
        out_duty_ = 0;
        return true;
    }
    if (hz == out_hz_ && duty == out_duty_) {
        return true;
    }
    if (!out_.play(hz, duty)) {
        return false;
    }
    out_hz_ = hz;
    out_duty_ = duty;
    return true;
}

void BuzzerService::finish(cap::BuzzerDoneReason why, TimeUs now)
{
    timer_->stop();
    if (!write(0, 0)) {
        // A driver that refuses to go silent: nothing more to try from here; the reason stays the cause that ended it.
        out_duty_ = 0;
    }
    playing_ = false;
    emit_done({sound_, why}, now);
    report_playing(false, now);
}

}  // namespace fr
