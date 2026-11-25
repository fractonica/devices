// FaceService (fr/services/face_service.hpp, design face-f1 D2-D19). IDF-free.
#include "fr/services/face_service.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdio>
#include <cstring>

#include "fr/display/backend.hpp"
#include "fr/wall_clock.hpp"

namespace fr {
namespace {

constexpr TimeUs kNever = INT64_MAX;
constexpr uint8_t kStepBase = 6;  // fr.face Step: the level is 6 + the value

uint8_t level_of(cap::FaceStep s)
{
    return static_cast<uint8_t>(kStepBase + static_cast<uint8_t>(s));
}

uint32_t header_crc(const FaceService::KeepHeader &h)
{
    return display::crc32({reinterpret_cast<const uint8_t *>(&h), offsetof(FaceService::KeepHeader, hcrc)});
}

constexpr uint8_t kChimeBase = 5;  // fr.face Chime: the level is 5 + the value (off excepted)

/** D19: the sounds, as notes (a pitch in Hz and a length in ms). A piezo or magnetic buzzer is loudest near 2-4 kHz. */
struct Note {
    uint16_t hz;
    uint16_t ms;
};
struct Tune {
    const Note *notes;
    uint8_t n;
};
constexpr uint16_t kC7 = 2093, kE7 = 2637, kG7 = 3136, kC8 = 4186;
constexpr Note kClickLeft[] = {{2400, 20}};
constexpr Note kClickCentre[] = {{2700, 20}};
constexpr Note kClickRight[] = {{3000, 20}};
constexpr Note kLong[] = {{1800, 60}};
constexpr Note kSaveOn[] = {{2700, 90}, {1800, 140}};
constexpr Note kSaveOff[] = {{1800, 90}, {2700, 140}};
constexpr Note kRefused[] = {{1200, 90}, {1200, 90}};
constexpr Note kPreon[] = {{kG7, 90}};
constexpr Note kTheta[] = {{kE7, 90}, {kG7, 110}};
constexpr Note kHelion[] = {{kC7, 110}, {kE7, 110}, {kG7, 180}};
constexpr Note kLonger[] = {{kC7, 110}, {kE7, 110}, {kG7, 110}, {kC8, 280}};

template <size_t N>
constexpr Tune tune(const Note (&n)[N])
{
    return {n, static_cast<uint8_t>(N)};
}

Tune tune_of(FaceService::Sound s)
{
    switch (s) {
    case FaceService::Sound::click_left:
        return tune(kClickLeft);
    case FaceService::Sound::click_centre:
        return tune(kClickCentre);
    case FaceService::Sound::click_right:
        return tune(kClickRight);
    case FaceService::Sound::long_:
        return tune(kLong);
    case FaceService::Sound::save_on:
        return tune(kSaveOn);
    case FaceService::Sound::save_off:
        return tune(kSaveOff);
    case FaceService::Sound::refused:
        return tune(kRefused);
    }
    return {nullptr, 0};
}

/** The chime for a period that began at `level`: the Preon one note, theta two, the Helion three, longer four. */
Tune chime_of(uint8_t level)
{
    if (level >= 8) {
        return tune(kPreon);
    }
    if (level == 7) {
        return tune(kTheta);
    }
    if (level == 6) {
        return tune(kHelion);
    }
    return tune(kLonger);
}

void play_tune(BuzzerService &b, const Tune &t)
{
    if (t.n == 0) {
        return;
    }
    if (t.n == 1) {
        cap::BuzzerToneArgs a{};
        a.freq_hz = t.notes[0].hz;
        a.ms = t.notes[0].ms;
        (void)b.tone_local(a);
        return;
    }
    cap::BuzzerMelodyArgs a{};
    for (uint8_t i = 0; i < t.n; ++i) {
        a.freq_hz.push_back(t.notes[i].hz);
        a.ms.push_back(t.notes[i].ms);
    }
    a.gap_ms = 20;
    a.repeat = 1;
    (void)b.melody_local(a);
}

}  // namespace

FaceService::FaceService(hal::Face &face, hal::Settings &settings, const cap::FaceConfig &cfg)
    : face_(face), cfg_(cfg), settings_(settings), step_(cfg.step), utc_(cfg.utc_offset_min), chime_(cfg.chime),
      clicks_(cfg.clicks)
{
}

FaceService::~FaceService()
{
    if (timer_ != nullptr) {
        wall_clock().set_listener({});
    }
}

const char *FaceService::key(char which)
{
    std::snprintf(key_, sizeof(key_), "f%u%c", static_cast<unsigned>(port()), which);
    return key_;
}

void FaceService::load_settings()
{
    uint8_t mode = static_cast<uint8_t>(cfg_.mode);
    uint8_t focus = cfg_.focus;
    if (auto v = settings_.get_i32(key('m')); v && (*v == 0 || *v == 1)) {
        mode = static_cast<uint8_t>(*v);
    }
    if (auto v = settings_.get_i32(key('f')); v && *v >= 0 && *v <= 13) {
        focus = static_cast<uint8_t>(*v);
    }
    if (auto v = settings_.get_i32(key('s')); v && cap::is_known(static_cast<cap::FaceStep>(*v)) && *v >= 0 && *v <= 4) {
        step_ = static_cast<cap::FaceStep>(*v);
    }
    if (auto v = settings_.get_i32(key('u')); v && *v >= -720 && *v <= 840) {
        utc_ = static_cast<int16_t>(*v);
    }
    if (auto v = settings_.get_i32(key('c')); v && *v >= 0 && *v <= 3) {
        chime_ = static_cast<cap::FaceChime>(*v);
    }
    if (auto v = settings_.get_i32(key('k')); v && (*v == 0 || *v == 1)) {
        clicks_ = *v == 1;
    }
    face_.set_mode(mode);
    face_.set_focus(focus);
}

void FaceService::save_settings()
{
    save_due_ = kNever;
    (void)settings_.set_i32(key('m'), face_.mode());
    (void)settings_.set_i32(key('f'), face_.focus());
    (void)settings_.set_i32(key('s'), static_cast<int32_t>(step_));
    (void)settings_.set_i32(key('u'), utc_);
    (void)settings_.set_i32(key('c'), static_cast<int32_t>(chime_));
    (void)settings_.set_i32(key('k'), clicks_ ? 1 : 0);
}

void FaceService::settings_changed(TimeUs now)
{
    save_due_ = now + kSaveDelayUs;
}

Status FaceService::init(Core &core)
{
    if (display_ == nullptr || !display_->ready()) {
        return std::unexpected(Err::invalid_args);
    }
    core_ = &core;
    timer_ = core.timer([this] { tick(); });
    if (timer_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const uint16_t w = display_->width();
    const uint16_t h = display_->height();
    if (auto st = face_.init(w, h, static_cast<uint8_t>(cfg_.mode), cfg_.focus, level_of(cfg_.step), cfg_.utc_offset_min);
        !st) {
        return st;
    }
    load_settings();
    face_.set_step(level_of(step_));
    face_.set_utc_offset_min(utc_);
    boot_at_ = core.now();
    save_due_ = kNever;
    next_due_ = boot_at_;

    display::EpaperBackend *paper = display_->epaper_backend();
    const size_t frame_bytes = static_cast<size_t>((w + 7) / 8) * h;
    traits_ = {.width = w,
               .height = h,
               .can_sleep = button_ != nullptr && rtc_ != nullptr && rtc_->alarm_pin() >= 0 && sleep_ != nullptr &&
                            paper != nullptr && keep_.size() >= sizeof(KeepHeader) + frame_bytes};
    display_->set_screen_listener(this);
    if (button_ != nullptr) {
        button_->set_listener(this);
    }
    if (left_ != nullptr) {
        left_->set_listener(&left_key_);
    }
    if (right_ != nullptr) {
        right_->set_listener(&right_key_);
    }
    wall_clock().set_listener([this] {
        if (timer_ != nullptr) {
            next_due_ = 0;  // a time that arrived or stepped: the face looks again, on the core task
            timer_->start(0);
        }
    });

    power_save_ = traits_.can_sleep && sleep_->offline();
    if (power_save_) {
        // D15: a deep-sleep wake keeps its glass in LP memory; anything else (power-on, a reset) starts over.
        const hal::WakeCause why = sleep_->wake_cause();
        const auto *hdr = reinterpret_cast<const KeepHeader *>(keep_.data());
        keep_valid_ = (why == hal::WakeCause::timer || why == hal::WakeCause::pin) && hdr->magic == kKeepMagic &&
                      hdr->size == frame_bytes && hdr->hcrc == header_crc(*hdr) &&
                      hdr->crc == display::crc32(keep_.subspan(sizeof(KeepHeader), frame_bytes));
        if (keep_valid_ && hdr->slept_unix_us > 0) {
            last_unix_ = hdr->slept_unix_us;  // D19: the step it slept in, so a wake at the next one chimes
        }
        paper->set_sleep_soon(true);
        paper->set_asleep_hook([this] { on_panel_asleep(); });
        if (why == hal::WakeCause::pin && (sleep_->wake_pins() & pins_.keys) != 0) {
            awake_until_ = boot_at_ + static_cast<TimeUs>(cfg_.awake_s) * 1'000'000;
        }
        if (why == hal::WakeCause::power_on || why == hal::WakeCause::reset) {
            awake_until_ = boot_at_ + static_cast<TimeUs>(cfg_.awake_s) * 1'000'000;  // a hand is near: a window
        }
        if (button_ != nullptr && button_->pressed()) {
            // Held through the wake: its 5 s count from the boot (the press itself was before the node was up).
            pressed_ = true;
            consumed_ = true;
            down_at_ = boot_at_;
        }
    }
    adopted_ = !keep_valid_;
    ready_ = true;
    report_changes(boot_at_);
    timer_->start(0);
    return {};
}

hal::Selftest FaceService::selftest()
{
    std::snprintf(detail_, sizeof(detail_), "face %ux%u, %s, time %s%s%s%s%s", static_cast<unsigned>(traits_.width),
                  static_cast<unsigned>(traits_.height), shown_ ? "shown" : "yielded",
                  time_source_name(wall_clock().source()), three_keys() ? ", 3 keys" : "",
                  buzzer_ != nullptr ? ", sound" : "", traits_.can_sleep ? ", can sleep" : "",
                  power_save_ ? ", power save" : "");
    return {ready_, detail_};
}

bool FaceService::time_valid() const
{
    return wall_clock().valid();
}

cap::FaceTimeSource FaceService::time_source() const
{
    return static_cast<cap::FaceTimeSource>(wall_clock().source());
}

// ---- Commands -------------------------------------------------------------------------------------------------------

Status FaceService::show()
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    if (!shown_) {
        shown_ = true;
        face_.invalidate();
        next_due_ = 0;
    }
    report_changes(core_->now());
    timer_->start(0);
    return {};
}

Status FaceService::input(const cap::FaceInputArgs &args)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    if (!shown_) {
        (void)show();
    }
    apply_input(static_cast<hal::Face::Input>(static_cast<uint8_t>(args.event) + 1));
    return {};
}

Status FaceService::set(const cap::FaceSetArgs &a)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    if ((a.has_focus && a.focus > 13) || (a.has_utc_offset_min && (a.utc_offset_min < -720 || a.utc_offset_min > 840)) ||
        (a.has_step && !cap::is_known(a.step)) || (a.has_mode && !cap::is_known(a.mode)) ||
        (a.has_screen && !cap::is_known(a.screen)) || (a.has_chime && !cap::is_known(a.chime)) ||
        (a.has_power_save && a.power_save && !traits_.can_sleep)) {
        return std::unexpected(Err::invalid_args);
    }
    if (a.has_power_save && a.power_save && !power_save_ && !entering_ && !rtc_answers()) {
        return std::unexpected(Err::failed);  // the RTC is not there, or neither clock knows the time
    }
    const TimeUs now = core_->now();
    bool saved = false;
    if (a.has_mode) {
        face_.set_mode(static_cast<uint8_t>(a.mode));
        saved = true;
    }
    if (a.has_focus) {
        face_.set_focus(a.focus);
        saved = true;
    }
    if (a.has_screen) {
        face_.set_screen(static_cast<uint8_t>(a.screen));
    }
    if (a.has_step) {
        step_ = a.step;
        face_.set_step(level_of(step_));
        saved = true;
    }
    if (a.has_utc_offset_min) {
        utc_ = a.utc_offset_min;
        face_.set_utc_offset_min(utc_);
        saved = true;
    }
    const bool redraw = saved || a.has_screen;
    if (a.has_chime) {
        chime_ = a.chime;
        saved = true;
    }
    if (a.has_clicks) {
        clicks_ = a.clicks;
        saved = true;
    }
    if (saved) {
        settings_changed(now);
    }
    if (redraw) {
        next_due_ = 0;  // the face looks again now, not at the wake the old settings asked for
    }
    if (a.has_power_save) {
        if (a.power_save && !power_save_ && !entering_) {
            if (auto st = enter_power_save(); !st) {
                return st;
            }
        } else if (!a.power_save && power_save_) {
            leave_power_save();
        }
    }
    report_changes(now);
    timer_->start(0);
    return {};
}

// ---- The loop -------------------------------------------------------------------------------------------------------

void FaceService::tick()
{
    if (!ready_ || slept_) {
        return;
    }
    const TimeUs now = core_->now();
    if (save_due_ != kNever && now >= save_due_) {
        save_settings();
    }
    if (pressed_ && !hold_fired_ && now >= down_at_ + static_cast<TimeUs>(kHoldPowerMs) * 1000) {
        hold_fired_ = true;
        toggle_power_save();
    }
    if (entering_) {
        // D13: the RTC's set from the wall clock lands within about a second; then offline and the restart (D19: after
        // the key's sound).
        if (((rtc_ != nullptr && rtc_->set_pending()) || sounding()) && now < enter_since_ + kEnterWaitUs) {
            timer_->start(sounding() ? 20'000 : 100'000);
            return;
        }
        entering_ = false;
        (void)sleep_->set_offline(true);
        sleep_->restart(true);
        return;
    }
    if (leaving_) {
        if (sounding() && now < enter_since_ + kSoundWaitUs) {
            timer_->start(20'000);
            return;
        }
        leaving_ = false;
        (void)sleep_->set_offline(false);
        sleep_->restart(false);
        return;
    }
    const auto unix_us = wall_clock().unix_at(now);
    const bool waiting = !unix_us && now < boot_at_ + static_cast<TimeUs>(cfg_.wait_time_s) * 1'000'000 && !power_save_;
    if (shown_ && !waiting && now >= next_due_) {
        if (!adopted_) {
            adopt_glass(now);
        }
        const hal::FaceFrame f = face_.update(unix_us, ms(now));
        if (unix_us) {
            chime_check(*unix_us);
        }
        if (f.redraw) {
            draw(f);
        }
        next_due_ = f.sleep_us < 0 ? kNever : now + f.sleep_us + (f.sleep_us > 0 ? kWakeMarginUs : 0);
    } else if (waiting) {
        next_due_ = boot_at_ + static_cast<TimeUs>(cfg_.wait_time_s) * 1'000'000;
    }
    report_changes(now);
    arm(now);
}

void FaceService::arm(TimeUs now)
{
    TimeUs next = shown_ ? next_due_ : kNever;
    next = std::min(next, save_due_);
    if (pressed_ && !hold_fired_) {
        next = std::min(next, down_at_ + static_cast<TimeUs>(kHoldPowerMs) * 1000);
    }
    if (power_save_ && awake_until_ > now) {
        next = std::min(next, awake_until_);
    }
    const bool sound = sounding();
    if (power_save_ && sound) {
        next = std::min(next, now + 20'000);  // D19: no sleep until the sound has ended
    }
    if (next == kNever) {
        timer_->stop();
    } else {
        timer_->start(static_cast<uint32_t>(std::clamp<TimeUs>(next - now, 0, 3'600'000'000LL)));
    }
    // Power save: the panel's sleep calls on_panel_asleep(); a window that just ended with the panel asleep sleeps.
    const display::EpaperBackend *paper = display_->epaper_backend();
    if (power_save_ && paper != nullptr && paper->phase() == display::EpaperBackend::Phase::asleep && now >= awake_until_ &&
        !pressed_ && !entering_ && !leaving_ && !sound) {
        sleep_now();
    }
}

void FaceService::draw(const hal::FaceFrame &f)
{
    const display::Box box{f.x0, f.y0, f.x1, f.y1};
    (void)display_->paint(box, [this](display::MonoCanvas &c, const display::Box &b) {
        face_.draw(c.pixels(), c.width(), c.height(), b.x0, b.y0, b.x1, b.y1);
    });
}

void FaceService::apply_input(hal::Face::Input in)
{
    const TimeUs now = core_->now();
    const uint8_t mode = face_.mode();
    const uint8_t focus = face_.focus();
    if (face_.input(in, ms(now))) {
        next_due_ = now;
        if (face_.mode() != mode || face_.focus() != focus) {
            settings_changed(now);
        }
    }
    report_changes(now);
    timer_->start(0);
}

void FaceService::report_changes(TimeUs at)
{
    const auto m = face_.mode();
    if (m != rep_.mode) {
        rep_.mode = m;
        report_mode(static_cast<cap::FaceMode>(m), at);
    }
    const auto s = face_.screen();
    if (s != rep_.screen) {
        rep_.screen = s;
        report_screen(static_cast<cap::FaceScreen>(s), at);
    }
    const auto f = face_.focus();
    if (f != rep_.focus) {
        rep_.focus = f;
        report_focus(f, at);
    }
    if (static_cast<uint8_t>(step_) != rep_.step) {
        rep_.step = static_cast<uint8_t>(step_);
        report_step(step_, at);
    }
    if (!rep_.utc_set || utc_ != rep_.utc) {
        rep_.utc_set = true;
        rep_.utc = utc_;
        report_utc_offset_min(utc_, at);
    }
    if (static_cast<int8_t>(shown_) != rep_.shown) {
        rep_.shown = static_cast<int8_t>(shown_);
        report_shown(shown_, at);
    }
    const bool valid = time_valid();
    if (static_cast<int8_t>(valid) != rep_.valid) {
        rep_.valid = static_cast<int8_t>(valid);
        report_time_valid(valid, at);
    }
    const auto src = static_cast<uint8_t>(time_source());
    if (src != rep_.source) {
        rep_.source = src;
        report_time_source(time_source(), at);
    }
    const bool ps = power_save();
    if (static_cast<int8_t>(ps) != rep_.save) {
        rep_.save = static_cast<int8_t>(ps);
        report_power_save(ps, at);
    }
    if (static_cast<uint8_t>(chime_) != rep_.chime) {
        rep_.chime = static_cast<uint8_t>(chime_);
        report_chime(chime_, at);
    }
    if (static_cast<int8_t>(clicks_) != rep_.clicks) {
        rep_.clicks = static_cast<int8_t>(clicks_);
        report_clicks(clicks_, at);
    }
}

// ---- The screen and the button --------------------------------------------------------------------------------------

void FaceService::on_client_drew()
{
    if (shown_) {
        shown_ = false;
        report_changes(core_->now());
        arm(core_->now());
    }
}

void FaceService::stay_awake(TimeUs at)
{
    if (power_save_) {
        awake_until_ = std::max(awake_until_, at + static_cast<TimeUs>(cfg_.awake_s) * 1'000'000);
    }
}

void FaceService::on_button_down(TimeUs at)
{
    pressed_ = true;
    hold_fired_ = false;
    down_at_ = at;
    consumed_ = false;
    play(Sound::click_centre);
    if (!shown_) {
        consumed_ = true;  // this press takes the screen back and is no clock input: neither its click nor a long
        skip_click_ = true;
        (void)show();
    }
    stay_awake(at);
    arm(core_->now());
}

void FaceService::on_button_up(uint32_t held_ms, TimeUs at)
{
    pressed_ = false;
    stay_awake(at);
    if (held_ms >= kLongMs) {
        skip_click_ = false;  // a long press brings no click
    }
    if (hold_fired_ || consumed_) {
        hold_fired_ = false;
        consumed_ = false;
        arm(core_->now());
        return;
    }
    if (held_ms >= kLongMs) {
        play(Sound::long_);
        apply_input(hal::Face::Input::long_);
    } else if (three_keys()) {
        apply_input(hal::Face::Input::select);  // D18: the centre key turns the screen at its release
    } else {
        arm(core_->now());
    }
}

void FaceService::on_button_click(uint8_t count, TimeUs at)
{
    static_cast<void>(at);
    if (skip_click_ || three_keys()) {
        skip_click_ = false;  // D18: with three keys the centre's release already acted
        return;
    }
    apply_input(count >= 2 ? hal::Face::Input::select : hal::Face::Input::next);
}

void FaceService::side_down(bool right, TimeUs at)
{
    play(right ? Sound::click_right : Sound::click_left);
    stay_awake(at);
    if (!shown_) {
        (void)show();  // takes the screen back: no clock input
        arm(core_->now());
        return;
    }
    apply_input(right ? hal::Face::Input::next : hal::Face::Input::prev);
}

void FaceService::side_up(TimeUs at, uint32_t held_ms)
{
    static_cast<void>(held_ms);
    stay_awake(at);
    arm(core_->now());
}

// ---- Sounds ---------------------------------------------------------------------------------------------------------

void FaceService::play(Sound s)
{
    if (buzzer_ != nullptr && clicks_) {
        play_tune(*buzzer_, tune_of(s));
    }
}

void FaceService::chime(uint8_t level)
{
    last_chime_ = level;
    ++chimes_;
    if (buzzer_ != nullptr) {
        play_tune(*buzzer_, chime_of(level));
    }
}

void FaceService::chime_check(int64_t unix_us)
{
    // D19: the face moved onto the next cycle of its step, and a period of `chime` or longer began there.
    if (last_unix_ && buzzer_ != nullptr && chime_ != cap::FaceChime::off) {
        const uint8_t level = face_.rollover(*last_unix_, unix_us, level_of(step_));
        if (level != hal::Face::kNoLevel && level <= kChimeBase + static_cast<uint8_t>(chime_)) {
            chime(level);
        }
    }
    last_unix_ = unix_us;
}

// ---- Power save -----------------------------------------------------------------------------------------------------

void FaceService::toggle_power_save()
{
    if (power_save_) {
        play(Sound::save_off);
        leave_power_save();
    } else if (traits_.can_sleep) {
        if (enter_power_save()) {
            play(Sound::save_on);
        } else {
            play(Sound::refused);
        }
    }
    report_changes(core_->now());
}

Status FaceService::enter_power_save()
{
    if (!traits_.can_sleep) {
        return std::unexpected(Err::invalid_args);
    }
    if (!rtc_answers()) {
        return std::unexpected(Err::failed);
    }
    if (save_due_ != kNever) {
        save_settings();
    }
    // D13: the RTC from the hub's time, so the clock starts right; an RTC already ahead of the hub keeps its own.
    if (wall_clock().source() == TimeSource::hub) {
        (void)rtc_->set_from_wall();
    }
    entering_ = true;
    enter_since_ = core_->now();
    return {};
}

bool FaceService::rtc_answers() const
{
    // Power save keeps time by the RTC alone: a chip that never answered (unwired, dead) would leave a node that does not
    // know the time off the network. And some clock must know the time now: the hub's, or the RTC's own.
    return rtc_ != nullptr && rtc_->unix() != 0 && (wall_clock().valid() || rtc_->valid());
}

void FaceService::leave_power_save()
{
    if (save_due_ != kNever) {
        save_settings();
    }
    if (sounding()) {
        // D19: the key's sound first; tick() restarts once it has ended.
        leaving_ = true;
        enter_since_ = core_->now();
        timer_->start(20'000);
        return;
    }
    (void)sleep_->set_offline(false);
    sleep_->restart(false);
}

void FaceService::adopt_glass(TimeUs now)
{
    adopted_ = true;
    display::EpaperBackend *paper = display_->epaper_backend();
    if (paper == nullptr || !keep_valid_) {
        return;
    }
    const auto *hdr = reinterpret_cast<const KeepHeader *>(keep_.data());
    uint32_t age = hdr->clean_age_s;
    if (const auto u = wall_clock().unix_at(now); u && hdr->slept_unix_us > 0 && *u > hdr->slept_unix_us) {
        age += static_cast<uint32_t>((*u - hdr->slept_unix_us) / 1'000'000);
    }
    (void)paper->adopt_glass(keep_.subspan(sizeof(KeepHeader), hdr->size), {.partials = hdr->partials, .clean_age_s = age});
}

void FaceService::on_panel_asleep()
{
    arm(core_->now());
}

void FaceService::sleep_now()
{
    display::EpaperBackend *paper = display_->epaper_backend();
    if (paper == nullptr || !paper->settled() || slept_) {
        return;
    }
    const TimeUs now = core_->now();
    if (save_due_ != kNever) {
        save_settings();
    }
    // D15: the glass and the ghost budget into LP memory.
    const auto glass = paper->shown().pixels();
    const auto c = paper->carry();
    KeepHeader h{};
    h.magic = kKeepMagic;
    h.size = static_cast<uint32_t>(glass.size());
    h.crc = display::crc32(glass);
    h.clean_age_s = c.clean_age_s;
    h.partials = c.partials;
    const auto unix_us = wall_clock().unix_at(now);
    h.slept_unix_us = unix_us.value_or(0);
    h.hcrc = header_crc(h);
    std::memcpy(keep_.data() + sizeof(KeepHeader), glass.data(), glass.size());
    std::memcpy(keep_.data(), &h, sizeof(h));
    // D14: the RTC's alarm at the next step boundary, rounded up to its whole second; a timer behind it.
    uint64_t after = kNoTimeSleepUs;
    alarm_unix_ = 0;
    if (unix_us && next_due_ != kNever) {
        const int64_t wake_us = *unix_us + (next_due_ - kWakeMarginUs - now);  // the boundary itself
        alarm_unix_ = static_cast<uint32_t>((wake_us + 999'999) / 1'000'000);
        if (rtc_->set_alarm(alarm_unix_)) {
            after = static_cast<uint64_t>(std::max<int64_t>(0, wake_us - *unix_us)) + kBackstopUs;
        } else {
            alarm_unix_ = 0;
            after = static_cast<uint64_t>(std::max<int64_t>(0, wake_us - *unix_us)) + kWakeMarginUs;
        }
    }
    slept_ = true;
    slept_after_us_ = after;
    timer_->stop();
    sleep_->deep_sleep(after, pins_.wake_low, pins_.hold);
}

}  // namespace fr
