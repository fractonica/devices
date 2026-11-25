// FaceService (design face-f1 D2-D19) against FakeCore, the real EpaperBackend on FakeEpaper behind DisplayService,
// the real ButtonService on FakeButton, the real RtcService on a fake DS3231 with an alarm pin, a fake clock face and
// a fake hal::Sleep: waiting for the time, the steps, yielding the screen and taking it back, the button's gestures,
// settings across a reboot, and power save (entering, a wake with the glass kept, the alarm, the key's window, leaving);
// three keys (D18) and the sounds (D19: the real BuzzerService on a recording tone output; clicks, chimes, power save
// waiting for a sound).
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "fr/display/epaper_backend.hpp"
#include "fr/services/button_service.hpp"
#include "fr/services/buzzer_service.hpp"
#include "fr/services/display_service.hpp"
#include "fr/services/face_service.hpp"
#include "fr/services/rtc_service.hpp"
#include "fr/wall_clock.hpp"
#include "tests/display_fakes.hpp"
#include "tests/fake_core.hpp"
#include "tests/fixture_link.hpp"
#include "tests/scale_fakes.hpp"
#include "tests/test.hpp"

namespace {

using fr::TimeUs;
using fr::display::EpaperBackend;
using frt::FakeButton;
using frt::FakeCore;
using frt::FakeEpaper;
using frt::FakeSettings;
using frt::RecordingSink;

constexpr int64_t kUnix0 = 1'800'000'000LL;  // whole seconds
constexpr int64_t kStepS = 10;               // the fake face's step
constexpr int64_t kThetaS = 40;              // the fake face's periods for the chime: a boundary of 40 s is a theta,
constexpr int64_t kHelionS = 120;            // of 120 s a Helion (kUnix0 is one), any other step's the step's level

/** A face whose picture is the step's index in the top-left bytes, "no time" a fixed pattern, labels a mark. */
class FakeFace final : public fr::hal::Face
{
public:
    fr::Status init(uint16_t w, uint16_t h, uint8_t m, uint8_t f, uint8_t step, int16_t utc) override
    {
        if (w != 400 || h != 300) {
            return std::unexpected(fr::Err::unsupported);
        }
        mode_ = m;
        focus_ = f;
        step_level = step;
        utc_min = utc;
        return {};
    }
    fr::hal::FaceFrame update(std::optional<int64_t> unix_us, uint32_t now_ms) override
    {
        ++updates;
        fr::hal::FaceFrame f;
        int64_t key = -1;
        f.sleep_us = -1;
        if (unix_us) {
            const int64_t s = *unix_us / 1'000'000;
            key = s / kStepS;
            f.sleep_us = ((key + 1) * kStepS * 1'000'000) - *unix_us;
        }
        if (label_until_ms != 0 && now_ms >= label_until_ms) {
            label_until_ms = 0;
            label = false;
            changed = true;
        }
        if (label_until_ms != 0) {
            const int64_t left = static_cast<int64_t>(label_until_ms - now_ms) * 1000;
            f.sleep_us = f.sleep_us < 0 ? left : std::min(f.sleep_us, left);
        }
        if (key != shown_key || changed) {
            shown_key = key;
            changed = false;
            f.redraw = true;
            f.x0 = 0;
            f.y0 = 0;
            f.x1 = 399;
            f.y1 = 299;
        }
        last_unix = unix_us;
        return f;
    }
    void draw(std::span<uint8_t> frame, uint16_t w, uint16_t h, int x0, int y0, int x1, int y1) override
    {
        ++draws;
        CHECK_EQ(w, 400);
        CHECK_EQ(h, 300);
        CHECK(x0 == 0 && y0 == 0 && x1 == 399 && y1 == 299);
        std::fill(frame.begin(), frame.end(), uint8_t{0xFF});
        const uint8_t v = shown_key < 0 ? 0x5A : static_cast<uint8_t>(shown_key);
        frame[0] = static_cast<uint8_t>(~v);
        frame[1] = static_cast<uint8_t>(mode_ * 16 + focus_);
        frame[2] = label ? 0x00 : 0xFF;
        frame[3] = static_cast<uint8_t>(screen_);
    }
    bool input(Input in, uint32_t now_ms) override
    {
        inputs.push_back(in);
        if (in == Input::next) {
            focus_ = static_cast<uint8_t>((focus_ + 1) % 14);
        } else if (in == Input::select) {
            screen_ = static_cast<uint8_t>((screen_ + 1) % 5);
        } else if (in == Input::long_) {
            mode_ ^= 1;
            label = true;
            label_until_ms = now_ms + 1500;
        }
        changed = true;
        return true;
    }
    void invalidate() override
    {
        ++invalidations;
        changed = true;
    }
    uint8_t rollover(int64_t from_us, int64_t to_us, uint8_t step) override
    {
        const int64_t a = from_us / 1'000'000 / kStepS;
        const int64_t b = to_us / 1'000'000 / kStepS;
        if (to_us <= from_us || b != a + 1) {
            return kNoLevel;
        }
        const int64_t at = b * kStepS;
        return at % kHelionS == 0 ? 6 : at % kThetaS == 0 ? 7 : step;
    }
    void set_mode(uint8_t m) override { mode_ = m, changed = true; }
    void set_focus(uint8_t f) override { focus_ = f, changed = true; }
    void set_screen(uint8_t s) override { screen_ = s, changed = true; }
    void set_step(uint8_t l) override { step_level = l, changed = true; }
    void set_utc_offset_min(int16_t m) override { utc_min = m, changed = true; }
    uint8_t mode() const override { return mode_; }
    uint8_t focus() const override { return focus_; }
    uint8_t screen() const override { return screen_; }

    uint8_t mode_ = 0, focus_ = 6, screen_ = 0, step_level = 0;
    int16_t utc_min = 0;
    int64_t shown_key = -2;
    bool changed = false, label = false;
    uint32_t label_until_ms = 0;
    int updates = 0, draws = 0, invalidations = 0;
    std::optional<int64_t> last_unix;
    std::vector<Input> inputs;
};

/** A passive buzzer that records each pitch it starts (a silence, or the same pitch again, is not a new note). */
class RecordingTone final : public fr::hal::ToneOutput
{
public:
    fr::Status init(fr::Core &) override { return {}; }
    fr::Status play(uint16_t hz, uint16_t duty) override
    {
        if (duty > 0 && !(sounding && hz == hz_)) {
            notes.push_back(hz);
        }
        sounding = duty > 0;
        hz_ = hz;
        return {};
    }
    fr::Status silence() override
    {
        sounding = false;
        return {};
    }
    bool pitched() const override { return true; }
    bool volume() const override { return true; }
    uint16_t min_hz() const override { return 100; }
    uint16_t max_hz() const override { return 20000; }
    fr::hal::Selftest selftest() override { return {true, "fake"}; }

    std::vector<uint16_t> notes;
    bool sounding = false;
    uint16_t hz_ = 0;
};

/** A DS3231 with an alarm pin, counting from its base. */
class FakeRtc final : public fr::hal::Rtc
{
public:
    explicit FakeRtc(FakeCore &core) : core_(core) {}
    fr::Status init(fr::Core &) override { return {}; }
    uint32_t now_unix() const { return base + static_cast<uint32_t>((core_.now() - epoch) / 1'000'000); }
    std::expected<fr::hal::RtcTime, fr::Err> now() override
    {
        if (dead) {
            return std::unexpected(fr::Err::failed);
        }
        return fr::hal::RtcTime{.unix = now_unix(), .osf = osf};
    }
    std::expected<uint8_t, fr::Err> seconds() override
    {
        if (dead) {
            return std::unexpected(fr::Err::failed);
        }
        return static_cast<uint8_t>(now_unix() % 60);
    }
    fr::Status set(uint32_t unix) override
    {
        base = unix;
        epoch = core_.now();
        osf = false;
        ++sets;
        return {};
    }
    std::expected<int16_t, fr::Err> temp_c10() override { return 250; }
    std::expected<int8_t, fr::Err> aging() override { return 0; }
    fr::Status set_aging(int8_t) override { return {}; }
    fr::Status set_alarm(uint32_t unix) override
    {
        alarm = unix;
        return {};
    }
    fr::Status clear_alarm() override
    {
        alarm = 0;
        return {};
    }
    int alarm_pin() const override { return 5; }
    fr::hal::Selftest selftest() override { return {true, "fake"}; }

    FakeCore &core_;
    uint32_t base = static_cast<uint32_t>(kUnix0);
    TimeUs epoch = 0;
    bool osf = false;
    bool dead = false;  // not wired: nothing answers
    uint32_t alarm = 0;
    int sets = 0;
};

/** hal::Sleep whose state outlives a boot (the offline flag in NVS, the wake cause). */
struct SleepState {
    bool offline = false;
    fr::hal::WakeCause cause = fr::hal::WakeCause::power_on;
    uint64_t pins = 0;
    std::vector<std::string> log;
    uint64_t after = 0, wake_low = 0, hold = 0;
};

class FakeSleep final : public fr::hal::Sleep
{
public:
    explicit FakeSleep(SleepState &s) : s_(s) {}
    fr::hal::WakeCause wake_cause() const override { return s_.cause; }
    uint64_t wake_pins() const override { return s_.pins; }
    bool offline() const override { return offline_at_boot_; }
    fr::Status set_offline(bool on) override
    {
        s_.offline = on;
        s_.log.push_back(on ? "offline on" : "offline off");
        return {};
    }
    void restart(bool sleeping) override { s_.log.push_back(sleeping ? "restart sleep" : "restart"); }
    void deep_sleep(uint64_t after, uint64_t wake_low, uint64_t hold) override
    {
        s_.after = after;
        s_.wake_low = wake_low;
        s_.hold = hold;
        s_.log.push_back("deep_sleep");
    }
    bool pin_low(int) const override { return false; }

    SleepState &s_;
    bool offline_at_boot_ = s_.offline;
};

fr::cap::DisplayConfig paper_cfg()
{
    fr::cap::DisplayConfig c;
    c.full_every = 60;
    c.clean = fr::cap::DisplayRefreshMode::fast;
    c.burst_ms = 1000;
    return c;
}

fr::cap::FaceConfig face_cfg()
{
    fr::cap::FaceConfig c;
    c.display = "paper";
    c.button = "key";
    c.rtc = "rtc";
    c.wait_time_s = 30;
    c.awake_s = 30;
    return c;
}

/** One boot of the node: everything but the settings, the sleep state and the LP memory is new. */
struct Rig {
    Rig(FakeSettings &settings, SleepState &sleep_state, std::vector<uint8_t> &keep, bool with_sleep = true,
        fr::cap::FaceConfig fc = face_cfg())
        : frame(15000), shown(15000), be(panel, {frame, shown, {}}), display(panel, be, paper_cfg()), button(key, {}),
          rtc(core), rtcs(rtc, {}), sleep(sleep_state), svc(face, settings, fc), keep_(keep)
    {
        fr::wall_clock().reset();
        frt::fixture_link() = {};
        frt::fixture_link().core = &core;  // a live hub
        rtc.epoch = core.now();
        display.attach(3, "paper", sink);
        button.attach(4, "key", sink);
        rtcs.attach(5, "rtc", sink);
        svc.attach(6, "face", sink);
        svc.bind_display(display);
        svc.bind_button(button);
        svc.bind_rtc(rtcs);
        if (with_sleep) {
            svc.bind_sleep(sleep, {.wake_low = (1u << 4) | (1u << 5), .hold = (1u << 2) | (1u << 3) | (1u << 14), .keys = 1u << 4});
            svc.bind_keep(keep_);
        }
    }

    /** D18, D19: left and right keys and a buzzer (ports 7-9, after the face's, as on c6e-paper); before boot(). */
    void keys_and_buzzer()
    {
        lefts.attach(7, "left", sink);
        rights.attach(8, "right", sink);
        buzz.attach(9, "buzzer", sink);
        svc.bind_left(lefts);
        svc.bind_right(rights);
        svc.bind_buzzer(buzz);
        three = true;
    }

    /** Board init in port order, as the generated glue does. */
    void boot(bool rtc_valid = true)
    {
        rtc.osf = !rtc_valid;
        REQUIRE(panel.init(core, fr::hal::Rotation::r0));
        REQUIRE(display.init(core));
        REQUIRE(button.init(core));
        REQUIRE(rtcs.init(core));
        REQUIRE(svc.init(core));
        if (three) {
            REQUIRE(lefts.init(core));
            REQUIRE(rights.init(core));
            REQUIRE(buzz.init(core));
        }
    }

    /** Runs `ms` of node time, the panel's BUSY falling 1 ms after each step starts. */
    void run_ms(int64_t ms)
    {
        const TimeUs end = core.now() + ms * 1000;
        while (core.now() < end && !slept()) {
            if (panel.busy() && !panel.asleep) {
                core.advance_ms(1);
                panel.finish(core.now());
                core.run_ready();
                continue;
            }
            core.advance_ms(std::min<int64_t>(5, (end - core.now()) / 1000 + 1));
            core.run_ready();
        }
    }
    bool slept() const { return !sleep.s_.log.empty() && sleep.s_.log.back() == "deep_sleep"; }

    /** A press of the key held `ms` (then released), the core run in between. */
    void press(uint32_t ms) { press_on(key, ms); }
    void press_on(FakeButton &b, uint32_t ms)
    {
        b.edge(true, core.now());
        core.run_ready();
        run_ms(ms);
        b.edge(false, core.now());
        core.run_ready();
    }

    void hub_time(int64_t unix_s) { fr::wall_clock().hub_sample(core.now(), unix_s * 1'000'000); }
    int64_t wall_s() { return *fr::wall_clock().unix_at(core.now()) / 1'000'000; }

    FakeCore core;
    RecordingSink sink{core};
    FakeEpaper panel{400, 300};
    std::vector<uint8_t> frame, shown;
    EpaperBackend be;
    fr::DisplayService display;
    FakeButton key;
    fr::ButtonService button;
    FakeRtc rtc;
    fr::RtcService rtcs;
    FakeSleep sleep;
    FakeFace face;
    fr::FaceService svc;
    std::vector<uint8_t> &keep_;
    FakeButton left, right;
    fr::ButtonService lefts{left, {}}, rights{right, {}};
    RecordingTone tone;
    fr::BuzzerService buzz{tone, {}};
    bool three = false;
};

struct World {
    FakeSettings settings;
    SleepState sleep;
    std::vector<uint8_t> keep = std::vector<uint8_t>(sizeof(fr::FaceService::KeepHeader) + 15000);
};

}  // namespace

TEST(face_waits_for_the_time_then_says_it_is_not_set_and_draws_when_it_comes)
{
    World w;
    Rig r(w.settings, w.sleep, w.keep, false);
    r.boot(false);  // the RTC lost power: no time
    CHECK(!r.svc.time_valid());
    r.run_ms(20'000);
    CHECK_EQ(r.face.draws, 0);  // within wait_time_s: the glass keeps its picture
    r.run_ms(11'000);
    CHECK_EQ(r.face.draws, 1);  // "time not set"
    CHECK(!r.face.last_unix.has_value());
    r.hub_time(kUnix0 + 3);
    r.run_ms(100);
    CHECK_EQ(r.face.draws, 2);
    CHECK(r.svc.time_valid());
    CHECK(r.svc.time_source() == fr::cap::FaceTimeSource::hub);
}

TEST(face_moves_on_each_step_boundary_with_one_partial_each)
{
    World w;
    Rig r(w.settings, w.sleep, w.keep, false);
    r.boot();
    r.hub_time(kUnix0 + 1);  // 9 s to the next 10-s step
    r.run_ms(2'000);
    CHECK_EQ(r.face.draws, 1);
    const uint32_t partials0 = r.be.counters().partial;
    r.run_ms(8'000);
    CHECK_EQ(r.face.draws, 2);  // at kUnix0 + 10, plus the margin
    r.run_ms(10'000);
    CHECK_EQ(r.face.draws, 3);
    CHECK_EQ(r.be.counters().partial, partials0 + 2u);
    // Each update lands just after the boundary: the instant handed over is within the margin.
    CHECK_EQ(*r.face.last_unix / 1'000'000 % kStepS, int64_t{0});
}

TEST(face_yields_the_screen_to_a_hub_client_and_takes_it_back)
{
    World w;
    Rig r(w.settings, w.sleep, w.keep, false);
    r.boot();
    r.hub_time(kUnix0 + 1);
    r.run_ms(2'000);
    REQUIRE(r.svc.shown());
    fr::cap::DisplayFillRectArgs fill{};
    fill.w = 10;
    fill.h = 10;
    REQUIRE(r.display.fill_rect(fill));
    CHECK(!r.svc.shown());
    const int draws = r.face.draws;
    r.run_ms(25'000);
    CHECK_EQ(r.face.draws, draws);  // two steps passed: nothing painted over the client's picture
    // A press of the face's button takes it back, and is no clock input.
    r.press(50);
    r.run_ms(500);
    CHECK(r.svc.shown());
    CHECK(r.face.inputs.empty());
    CHECK_EQ(r.face.draws, draws + 1);
    // show() after another client drawing.
    REQUIRE(r.display.fill_rect(fill));
    REQUIRE(r.svc.show());
    r.run_ms(100);
    CHECK(r.svc.shown());
    CHECK_EQ(r.face.draws, draws + 2);
}

TEST(face_button_click_next_double_select_hold_long)
{
    World w;
    Rig r(w.settings, w.sleep, w.keep, false);
    r.boot();
    r.hub_time(kUnix0 + 1);
    r.run_ms(1'000);
    r.press(50);
    r.run_ms(400);  // past the multi-press gap
    REQUIRE_EQ(r.face.inputs.size(), size_t{1});
    CHECK(r.face.inputs[0] == fr::hal::Face::Input::next);
    r.press(50);
    r.run_ms(80);
    r.press(50);
    r.run_ms(400);
    REQUIRE_EQ(r.face.inputs.size(), size_t{2});
    CHECK(r.face.inputs[1] == fr::hal::Face::Input::select);
    r.press(1'200);
    r.run_ms(100);
    REQUIRE_EQ(r.face.inputs.size(), size_t{3});
    CHECK(r.face.inputs[2] == fr::hal::Face::Input::long_);
    // A 5 s hold without power save possible does nothing more (and is no `long`).
    r.press(5'500);
    r.run_ms(100);
    CHECK_EQ(r.face.inputs.size(), size_t{3});
    CHECK(w.sleep.log.empty());
}

TEST(face_settings_are_kept_across_a_reboot)
{
    World w;
    {
        Rig r(w.settings, w.sleep, w.keep, false);
        r.boot();
        fr::cap::FaceSetArgs a{};
        a.has_mode = true;
        a.mode = fr::cap::FaceMode::earth;
        a.has_focus = true;
        a.focus = 8;
        a.has_step = true;
        a.step = fr::cap::FaceStep::flavon;
        a.has_utc_offset_min = true;
        a.utc_offset_min = 180;
        REQUIRE(r.svc.set(a));
        CHECK(w.settings.kept.empty());  // written once they have held for 5 s
        r.run_ms(5'200);
        CHECK_EQ(w.settings.kept.at("f6m"), 1);
        CHECK_EQ(w.settings.kept.at("f6s"), 4);
    }
    Rig r(w.settings, w.sleep, w.keep, false);
    r.boot();
    CHECK(r.svc.mode() == fr::cap::FaceMode::earth);
    CHECK_EQ(r.svc.focus(), 8);
    CHECK(r.svc.step() == fr::cap::FaceStep::flavon);
    CHECK_EQ(r.face.step_level, 10);
    CHECK_EQ(r.svc.utc_offset_min(), 180);
    CHECK_EQ(r.face.utc_min, 180);
}

TEST(face_refuses_bad_settings_and_power_save_it_cannot_do)
{
    World w;
    Rig r(w.settings, w.sleep, w.keep, false);  // no hal::Sleep: no power save
    r.boot();
    CHECK(!r.svc.can_sleep());
    fr::cap::FaceSetArgs a{};
    a.has_power_save = true;
    a.power_save = true;
    CHECK(r.svc.set(a).error() == fr::Err::invalid_args);
    fr::cap::FaceSetArgs f{};
    f.has_focus = true;
    f.focus = 14;
    CHECK(r.svc.set(f).error() == fr::Err::invalid_args);
    fr::cap::FaceSetArgs u{};
    u.has_utc_offset_min = true;
    u.utc_offset_min = 900;
    CHECK(r.svc.set(u).error() == fr::Err::invalid_args);
}

TEST(face_power_save_entered_from_the_hub_sets_the_rtc_then_goes_offline)
{
    World w;
    Rig r(w.settings, w.sleep, w.keep);
    r.boot();
    REQUIRE(r.svc.can_sleep());
    r.rtc.base = static_cast<uint32_t>(kUnix0 - 7);  // the RTC 7 s slow
    r.hub_time(kUnix0 + 1);
    r.run_ms(500);
    fr::cap::FaceSetArgs a{};
    a.has_power_save = true;
    a.power_save = true;
    REQUIRE(r.svc.set(a));
    CHECK(r.svc.power_save());
    CHECK(r.svc.entering());
    r.run_ms(3'000);
    // The RTC was set from the hub's time first, then the flag and the restart (with BYE sleep).
    CHECK_EQ(r.rtc.sets, 1);
    CHECK_EQ(static_cast<int64_t>(r.rtc.now_unix()), r.wall_s());
    REQUIRE_EQ(w.sleep.log.size(), size_t{2});
    CHECK_EQ(w.sleep.log[0], std::string("offline on"));
    CHECK_EQ(w.sleep.log[1], std::string("restart sleep"));
    CHECK(w.sleep.offline);
}

TEST(face_power_save_boot_draws_sleeps_on_the_alarm_and_keeps_the_glass)
{
    World w;
    w.sleep.offline = true;
    w.sleep.cause = fr::hal::WakeCause::reset;  // the restart into power save
    uint32_t alarm = 0;
    {
        Rig r(w.settings, w.sleep, w.keep);
        r.rtc.base = static_cast<uint32_t>(kUnix0 + 3);
        r.boot();
        CHECK(r.svc.power_save());
        CHECK(r.svc.time_source() == fr::cap::FaceTimeSource::rtc);
        // A reset opens the awake window (30 s): the face draws (a full refresh: the glass is not known) and stays up.
        r.run_ms(2'000);
        CHECK_EQ(r.face.draws, 1);
        CHECK_EQ(r.be.counters().full, 1u);
        CHECK(!r.slept());
        r.run_ms(40'000);
        REQUIRE(r.slept());
        // Asleep until the next 10-s boundary, rounded up to the second, with the timer two minutes behind it.
        alarm = r.svc.alarm_unix();
        CHECK_EQ(alarm % kStepS, 0u);
        CHECK_EQ(r.rtc.alarm, alarm);
        CHECK(w.sleep.after > fr::FaceService::kBackstopUs && w.sleep.after <= fr::FaceService::kBackstopUs + 10'000'000u);
        CHECK_EQ(w.sleep.wake_low, uint64_t{(1u << 4) | (1u << 5)});
        CHECK_EQ(w.sleep.hold, uint64_t{(1u << 2) | (1u << 3) | (1u << 14)});
        CHECK(r.panel.asleep);
    }
    // The alarm's wake: a fresh boot; the RTC at the alarm's second.
    w.sleep.cause = fr::hal::WakeCause::pin;
    w.sleep.pins = 1u << 5;
    w.sleep.log.clear();
    {
        Rig r(w.settings, w.sleep, w.keep);
        r.rtc.base = alarm;
        r.boot();
        r.run_ms(3'000);
        REQUIRE(r.slept());  // no window: drew, refreshed, asleep
        CHECK_EQ(r.face.draws, 1);
        CHECK_EQ(r.be.counters().full, 0u);  // the kept glass: a partial, not a full refresh
        CHECK_EQ(r.be.counters().partial, 1u);
        CHECK_EQ(r.svc.alarm_unix(), alarm + kStepS);
    }
    // LP memory lost (a power cut, or a CRC that does not match): a full refresh again.
    w.keep[sizeof(fr::FaceService::KeepHeader) + 7] ^= 0x01;
    w.sleep.cause = fr::hal::WakeCause::timer;
    w.sleep.log.clear();
    {
        Rig r(w.settings, w.sleep, w.keep);
        r.rtc.base = alarm + kStepS;
        r.boot();
        r.run_ms(5'000);
        REQUIRE(r.slept());
        CHECK_EQ(r.be.counters().full, 1u);
    }
}

TEST(face_power_save_key_wake_opens_a_window_and_a_5s_hold_leaves)
{
    World w;
    w.sleep.offline = true;
    w.sleep.cause = fr::hal::WakeCause::pin;
    w.sleep.pins = 1u << 4;  // the key
    Rig r(w.settings, w.sleep, w.keep);
    r.rtc.base = static_cast<uint32_t>(kUnix0 + 3);
    r.boot();
    CHECK(r.svc.awake_until() > r.core.now());
    r.run_ms(20'000);
    CHECK(!r.slept());
    r.press(50);  // works as usual in the window, and extends it
    r.run_ms(400);
    CHECK_EQ(r.face.inputs.size(), size_t{1});
    r.run_ms(25'000);
    CHECK(!r.slept());
    // Held 5 s: power save off (the flag cleared, a restart).
    r.press(5'200);
    r.run_ms(100);
    REQUIRE(!w.sleep.log.empty());
    CHECK_EQ(w.sleep.log.front(), std::string("offline off"));
    CHECK_EQ(w.sleep.log.back(), std::string("restart"));
    CHECK(!w.sleep.offline);
}

TEST(face_power_save_key_held_through_the_wake_leaves_after_5s)
{
    World w;
    w.sleep.offline = true;
    w.sleep.cause = fr::hal::WakeCause::pin;
    w.sleep.pins = 1u << 4;
    Rig r(w.settings, w.sleep, w.keep);
    r.key.level = true;  // still held as the node comes up
    r.rtc.base = static_cast<uint32_t>(kUnix0 + 3);
    r.boot();
    r.run_ms(5'200);
    REQUIRE(!w.sleep.log.empty());
    CHECK_EQ(w.sleep.log.front(), std::string("offline off"));
}

TEST(face_power_save_refused_while_the_rtc_does_not_answer)
{
    World w;
    Rig r(w.settings, w.sleep, w.keep);
    r.rtc.dead = true;  // the DS3231 not wired yet
    r.boot();
    REQUIRE(r.svc.can_sleep());  // the profile has the pins; the chip is not there
    r.hub_time(kUnix0 + 1);
    r.run_ms(500);
    fr::cap::FaceSetArgs a{};
    a.has_power_save = true;
    a.power_save = true;
    CHECK(r.svc.set(a).error() == fr::Err::failed);
    // Nor by the key's 5 s hold.
    r.press(5'200);
    r.run_ms(3'000);
    CHECK(w.sleep.log.empty());
    CHECK(!r.svc.power_save());
}

TEST(face_set_redraws_at_once_and_a_finer_step_moves_at_its_own_boundaries)
{
    World w;
    Rig r(w.settings, w.sleep, w.keep, false);
    r.boot();
    r.hub_time(kUnix0 + 1);
    r.run_ms(1'000);
    const int draws = r.face.draws;
    fr::cap::FaceSetArgs a{};
    a.has_step = true;
    a.step = fr::cap::FaceStep::flavon;
    REQUIRE(r.svc.set(a));
    r.run_ms(200);
    CHECK_EQ(r.face.draws, draws + 1);  // not at the 10-s boundary the old step asked for
    CHECK_EQ(r.face.step_level, 10);
}

TEST(face_three_keys_left_prev_right_next_at_the_press_centre_select_at_the_release)
{
    World w;
    Rig r(w.settings, w.sleep, w.keep, false);
    r.keys_and_buzzer();
    r.boot();
    r.hub_time(kUnix0 + 1);
    r.run_ms(1'000);
    using In = fr::hal::Face::Input;
    // Left and right act at the press, with no wait for a second click.
    r.left.edge(true, r.core.now());
    r.core.run_ready();
    r.run_ms(5);
    REQUIRE_EQ(r.face.inputs.size(), size_t{1});
    CHECK(r.face.inputs[0] == In::prev);
    r.left.edge(false, r.core.now());
    r.core.run_ready();
    r.press_on(r.right, 50);
    REQUIRE_EQ(r.face.inputs.size(), size_t{2});
    CHECK(r.face.inputs[1] == In::next);
    // The centre: select at its release; two quick presses are two selects, not a double click.
    r.press(50);
    r.run_ms(5);
    REQUIRE_EQ(r.face.inputs.size(), size_t{3});
    CHECK(r.face.inputs[2] == In::select);
    r.press(50);
    r.run_ms(80);
    r.press(50);
    r.run_ms(400);
    REQUIRE_EQ(r.face.inputs.size(), size_t{5});
    CHECK(r.face.inputs[3] == In::select && r.face.inputs[4] == In::select);
    // Held 0.6-5 s: long, as before.
    r.press(1'200);
    r.run_ms(100);
    REQUIRE_EQ(r.face.inputs.size(), size_t{6});
    CHECK(r.face.inputs[5] == In::long_);
    // A side key takes the screen back from a hub client, and is no clock input.
    fr::cap::DisplayFillRectArgs fill{};
    fill.w = 10;
    fill.h = 10;
    REQUIRE(r.display.fill_rect(fill));
    CHECK(!r.svc.shown());
    r.press_on(r.right, 50);
    r.run_ms(100);
    CHECK(r.svc.shown());
    CHECK_EQ(r.face.inputs.size(), size_t{6});
}

TEST(face_keys_click_and_the_face_chimes_on_periods_of_chime_or_longer)
{
    World w;
    {
        Rig r(w.settings, w.sleep, w.keep, false);
        r.keys_and_buzzer();
        r.boot();
        r.hub_time(kUnix0 + 1);
        r.run_ms(1'000);
        CHECK(r.tone.notes.empty());  // no chime at the first update: nothing was shown before
        // Each key its own click; a long press its own sound at the release.
        r.press_on(r.left, 50);
        r.press_on(r.right, 50);
        r.press(50);
        r.run_ms(100);
        CHECK(r.tone.notes == std::vector<uint16_t>({2400, 3000, 2700}));
        r.press(1'200);
        r.run_ms(200);
        CHECK(r.tone.notes == std::vector<uint16_t>({2400, 3000, 2700, 2700, 1800}));
        // The chime (default preon): at kUnix0 + 10 one note, + 40 a theta's two, + 120 a Helion's three.
        r.tone.notes.clear();
        r.run_ms(10'000 - 2'700);  // to kUnix0 + 10, plus the margin
        CHECK_EQ(r.svc.chimes(), 1u);
        CHECK_EQ(r.svc.last_chime(), 8);
        r.run_ms(30'000);  // + 40
        CHECK_EQ(r.svc.chimes(), 4u);
        CHECK_EQ(r.svc.last_chime(), 7);
        r.run_ms(80'000);  // + 120
        CHECK_EQ(r.svc.chimes(), 12u);
        CHECK_EQ(r.svc.last_chime(), 6);
        r.run_ms(500);
        CHECK(r.tone.notes.size() >= 3u);
        CHECK(std::vector<uint16_t>(r.tone.notes.end() - 3, r.tone.notes.end()) == std::vector<uint16_t>({2093, 2637, 3136}));
        // chime helion: the Preons and thetas are quiet; clicks off: the keys are too.
        fr::cap::FaceSetArgs a{};
        a.has_chime = true;
        a.chime = fr::cap::FaceChime::helion;
        a.has_clicks = true;
        a.clicks = false;
        REQUIRE(r.svc.set(a));
        const size_t notes = r.tone.notes.size();
        r.press_on(r.left, 50);
        r.run_ms(110'000);  // to + 230: Preons and two thetas
        CHECK_EQ(r.svc.chimes(), 12u);
        CHECK_EQ(r.tone.notes.size(), notes);
        r.run_ms(10'000);  // + 240: a Helion
        CHECK_EQ(r.svc.chimes(), 13u);
        CHECK_EQ(w.settings.kept.at("f6c"), 1);
        CHECK_EQ(w.settings.kept.at("f6k"), 0);
        // A time that jumps chimes nothing, even across a Helion.
        r.hub_time(r.wall_s() + 1'000);
        r.run_ms(1'000);
        CHECK_EQ(r.svc.chimes(), 13u);
    }
    // Kept across a reboot.
    Rig r(w.settings, w.sleep, w.keep, false);
    r.boot();
    CHECK(r.svc.chime() == fr::cap::FaceChime::helion);
    CHECK(!r.svc.clicks());
}

TEST(face_power_save_wake_on_the_alarm_chimes_and_sleeps_after_the_sound)
{
    World w;
    w.sleep.offline = true;
    w.sleep.cause = fr::hal::WakeCause::reset;
    uint32_t alarm = 0;
    {
        Rig r(w.settings, w.sleep, w.keep);
        r.keys_and_buzzer();
        r.rtc.base = static_cast<uint32_t>(kUnix0 + 3);
        r.boot();
        r.run_ms(42'000);
        REQUIRE(r.slept());
        alarm = r.svc.alarm_unix();
    }
    w.sleep.cause = fr::hal::WakeCause::pin;
    w.sleep.pins = 1u << 5;
    w.sleep.log.clear();
    Rig r(w.settings, w.sleep, w.keep);
    r.keys_and_buzzer();
    r.rtc.base = alarm;
    r.boot();
    r.run_ms(3'000);
    REQUIRE(r.slept());
    CHECK_EQ(r.svc.chimes(), 1u);  // from the step it slept in to the alarm's: the next one
    CHECK(!r.tone.notes.empty());
    CHECK(!r.buzz.playing());  // the panel slept long before; the node waited for the chime's end
}

TEST(face_power_save_left_by_the_key_restarts_after_its_sound)
{
    World w;
    w.sleep.offline = true;
    w.sleep.cause = fr::hal::WakeCause::pin;
    w.sleep.pins = 1u << 4;
    Rig r(w.settings, w.sleep, w.keep);
    r.keys_and_buzzer();
    r.rtc.base = static_cast<uint32_t>(kUnix0 + 3);
    r.boot();
    r.run_ms(1'000);
    r.press_on(r.right, 50);  // a side key works in the window, and extends it
    CHECK_EQ(r.face.inputs.size(), size_t{1});
    r.run_ms(25'000);
    CHECK(!r.slept());
    r.key.edge(true, r.core.now());
    r.core.run_ready();
    r.run_ms(5'010);
    CHECK(w.sleep.log.empty());  // the sound plays first
    r.run_ms(500);
    REQUIRE_EQ(w.sleep.log.size(), size_t{2});
    CHECK_EQ(w.sleep.log.back(), std::string("restart"));
    CHECK(std::vector<uint16_t>(r.tone.notes.end() - 2, r.tone.notes.end()) == std::vector<uint16_t>({1800, 2700}));
}

TEST(face_sounds_are_the_nodes_own_a_hub_gone_quiet_does_not_cut_them)
{
    World w;
    Rig r(w.settings, w.sleep, w.keep, false);
    r.keys_and_buzzer();
    r.boot();
    r.hub_time(kUnix0 + 1);
    r.run_ms(1'000);
    frt::fixture_link().hub_stops();  // the session stays, the hub falls silent (the buzzer's hub_lost rule for hub sounds)
    r.run_ms(39'000 + 100);           // to kUnix0 + 40, a theta: two notes
    CHECK_EQ(r.svc.last_chime(), 7);
    r.run_ms(500);
    REQUIRE(r.tone.notes.size() >= 2u);
    CHECK(std::vector<uint16_t>(r.tone.notes.end() - 2, r.tone.notes.end()) == std::vector<uint16_t>({2637, 3136}));
}

TEST(face_power_save_woken_by_a_side_key_opens_the_window_and_its_press_is_no_input)
{
    // D18: c6e-paper's right key is its wake key (GPIO4); the centre one (GPIO22) cannot wake the chip.
    World w;
    w.sleep.offline = true;
    w.sleep.cause = fr::hal::WakeCause::pin;
    w.sleep.pins = 1u << 4;  // the key mask the glue gave (here the fake's key pin)
    Rig r(w.settings, w.sleep, w.keep);
    r.keys_and_buzzer();
    r.right.level = true;  // still held as the node comes up
    r.rtc.base = static_cast<uint32_t>(kUnix0 + 3);
    r.boot();
    CHECK(r.svc.awake_until() > r.core.now());
    r.run_ms(300);
    r.right.edge(false, r.core.now());  // the waking press ends: no `next`
    r.core.run_ready();
    r.run_ms(500);
    CHECK(r.face.inputs.empty());
    r.press_on(r.right, 50);  // then it works as usual, and keeps the node awake
    CHECK_EQ(r.face.inputs.size(), size_t{1});
    r.run_ms(25'000);
    CHECK(!r.slept());
    r.run_ms(10'000);
    CHECK(r.slept());
}
