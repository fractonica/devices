// BuzzerService against FakeCore and a fake hal::ToneOutput (design buzzer-b1 D5, D6, §9): the volume curve; a tone's
// start and end; a beep's edges to the microsecond and its last pause trimmed; a melody's schedule with no drift, after
// a late fire too; the gap rule; repeat and count 0; replacement and stop with their done reasons; set_volume mid-sound;
// volume 0; the arguments; hub silence and a new hub run; a driver error; an unpitched buzzer; the reports.
#include <cstdint>
#include <utility>
#include <vector>

#include "fr/services/buzzer_service.hpp"
#include "tests/fake_core.hpp"
#include "tests/fixture_link.hpp"
#include "tests/test.hpp"

namespace {

using fr::BuzzerService;
using fr::TimeUs;
using fr::cap::Buzzer;
using fr::cap::BuzzerBeepArgs;
using fr::cap::BuzzerConfig;
using fr::cap::BuzzerDone;
using fr::cap::BuzzerDoneReason;
using fr::cap::BuzzerMelodyArgs;
using fr::cap::BuzzerSetVolumeArgs;
using fr::cap::BuzzerSound;
using fr::cap::BuzzerToneArgs;
using frt::FakeCore;
using frt::RecordingSink;

constexpr uint8_t kPort = 4;

/** What the driver was told, when: hz 0 is silence. */
struct Write {
    TimeUs at;
    uint16_t hz;
    uint16_t duty;
    bool operator==(const Write &) const = default;
};

class FakeTone final : public fr::hal::ToneOutput
{
public:
    explicit FakeTone(const FakeCore &core, bool pitched = true, bool volume = true)
        : core_(core), pitched_(pitched), volume_(volume)
    {
    }

    fr::Status init(fr::Core &) override
    {
        ++inits;
        sounding = false;
        return {};
    }
    fr::Status play(uint16_t freq_hz, uint16_t duty_permille) override
    {
        if (fail_play) {
            return std::unexpected(fr::Err::failed);
        }
        if (pitched_ && (freq_hz < min_hz() || freq_hz > max_hz())) {
            return std::unexpected(fr::Err::invalid_args);
        }
        writes.push_back({core_.now(), freq_hz, duty_permille});
        hz = freq_hz;
        duty = duty_permille;
        sounding = duty_permille > 0;
        return {};
    }
    fr::Status silence() override
    {
        writes.push_back({core_.now(), 0, 0});
        sounding = false;
        duty = 0;
        return {};
    }
    bool pitched() const override { return pitched_; }
    bool volume() const override { return volume_; }
    uint16_t min_hz() const override { return pitched_ ? 100 : 0; }
    uint16_t max_hz() const override { return pitched_ ? 20000 : 0; }
    fr::hal::Selftest selftest() override { return {true, "fake"}; }

    std::vector<Write> writes;
    int inits = 0;
    bool sounding = false;
    uint16_t hz = 0;
    uint16_t duty = 0;
    bool fail_play = false;

private:
    const FakeCore &core_;
    bool pitched_;
    bool volume_;
};

struct Rig {
    explicit Rig(BuzzerConfig cfg = {}, bool pitched = true, bool volume = true)
        : drv(core, pitched, volume), sink(core), svc(drv, cfg)
    {
        svc.attach(kPort, "buzzer", sink);
        // A live hub on this rig's clock, with a session (the hub-silence rule reads it).
        frt::fixture_link() = {};
        frt::fixture_link().core = &core;
    }
    bool start()
    {
        if (!svc.init(core)) {
            return false;
        }
        core.run_ready();
        return true;
    }

    std::vector<BuzzerDone> dones() const
    {
        std::vector<BuzzerDone> out;
        for (const auto &e : sink.events()) {
            if (e.id == Buzzer::kEventDone) {
                out.push_back(*fr::cap::decode_buzzer_done(e.bytes));
            }
        }
        return out;
    }
    std::vector<TimeUs> done_times() const
    {
        std::vector<TimeUs> out;
        for (const auto &e : sink.events()) {
            if (e.id == Buzzer::kEventDone) {
                out.push_back(e.emitted);
            }
        }
        return out;
    }
    std::vector<std::pair<TimeUs, bool>> playing_reports() const
    {
        std::vector<std::pair<TimeUs, bool>> out;
        for (const auto &e : sink.properties()) {
            if (e.id == Buzzer::kPropPlaying) {
                out.emplace_back(e.emitted, *fr::cap::decode_buzzer_playing_state(e.bytes));
            }
        }
        return out;
    }
    std::vector<uint8_t> volume_reports() const
    {
        std::vector<uint8_t> out;
        for (const auto &e : sink.properties()) {
            if (e.id == Buzzer::kPropVolume) {
                out.push_back(*fr::cap::decode_buzzer_volume_state(e.bytes));
            }
        }
        return out;
    }

    FakeCore core;
    FakeTone drv;
    RecordingSink sink;
    BuzzerService svc;
};

BuzzerToneArgs tone(uint16_t hz, uint16_t ms)
{
    BuzzerToneArgs a;
    a.freq_hz = hz;
    a.ms = ms;
    return a;
}

BuzzerMelodyArgs melody(std::initializer_list<uint16_t> hz, std::initializer_list<uint16_t> ms, uint8_t gap = 0,
                        uint8_t repeat = 1)
{
    BuzzerMelodyArgs a;
    for (uint16_t h : hz) {
        a.freq_hz.push_back(h);
    }
    for (uint16_t m : ms) {
        a.ms.push_back(m);
    }
    a.gap_ms = gap;
    a.repeat = repeat;
    return a;
}

TEST(buzzer_volume_curve)
{
    CHECK_EQ(BuzzerService::duty_for_volume(0), 0);
    CHECK_EQ(BuzzerService::duty_for_volume(1), 3);
    CHECK_EQ(BuzzerService::duty_for_volume(10), 32);
    CHECK_EQ(BuzzerService::duty_for_volume(50), 167);
    CHECK_EQ(BuzzerService::duty_for_volume(100), 500);
    CHECK_EQ(BuzzerService::duty_for_volume(200), 500);
    // Monotonic, never above a 50 % square.
    uint16_t prev = 0;
    for (int v = 1; v <= 100; ++v) {
        const uint16_t d = BuzzerService::duty_for_volume(static_cast<uint8_t>(v));
        CHECK(d >= prev);
        CHECK(d <= 500);
        prev = d;
    }
}

TEST(buzzer_boot_is_silent_with_the_driver_traits)
{
    Rig r;
    REQUIRE(r.start());
    CHECK_EQ(r.drv.inits, 1);
    CHECK(!r.svc.playing());
    CHECK_EQ(r.svc.volume(), 50);
    CHECK(r.drv.writes.empty());
    const auto t = r.svc.traits();
    CHECK(t.pitched);
    CHECK(t.volume);
    CHECK_EQ(t.min_hz, 100);
    CHECK_EQ(t.max_hz, 20000);
    CHECK_EQ(r.core.timers_running(), 0u);
}

TEST(buzzer_init_refuses_a_beep_pitch_the_driver_cannot_play)
{
    BuzzerConfig cfg;
    cfg.beep_hz = 50;
    Rig r(cfg);
    CHECK(!r.svc.init(r.core));
    CHECK_EQ(r.drv.inits, 1);  // the pad went silent first
    BuzzerConfig unp;
    unp.beep_hz = 50;
    Rig u(unp, /*pitched=*/false);
    CHECK(u.svc.init(u.core).has_value());  // an unpitched buzzer ignores the pitch
}

TEST(buzzer_tone_starts_at_once_and_ends_on_time)
{
    Rig r;
    REQUIRE(r.start());
    r.core.advance_ms(7);
    const TimeUs t0 = r.core.now();
    REQUIRE(r.svc.tone(tone(2000, 250)).has_value());
    CHECK(r.svc.playing());
    CHECK(r.svc.sound() == BuzzerSound::tone);
    REQUIRE_EQ(r.drv.writes.size(), 1u);
    CHECK(r.drv.writes[0] == (Write{t0, 2000, 167}));
    r.core.advance_ms(249);
    CHECK(r.svc.playing());
    CHECK(r.dones().empty());
    r.core.advance_ms(1);
    CHECK(!r.svc.playing());
    REQUIRE_EQ(r.dones().size(), 1u);
    CHECK(r.dones()[0].sound == BuzzerSound::tone);
    CHECK(r.dones()[0].reason == BuzzerDoneReason::done);
    CHECK_EQ(r.done_times()[0], t0 + 250'000);
    CHECK(r.drv.writes.back() == (Write{t0 + 250'000, 0, 0}));
    const auto p = r.playing_reports();
    REQUIRE_EQ(p.size(), 2u);
    CHECK(p[0] == std::make_pair(t0, true));
    CHECK(p[1] == std::make_pair(t0 + 250'000, false));
    CHECK_EQ(r.core.timers_running(), 0u);
}

TEST(buzzer_beep_edges_and_the_last_pause_trimmed)
{
    Rig r;
    REQUIRE(r.start());
    const TimeUs t0 = r.core.now();
    BuzzerBeepArgs b;
    b.count = 3;
    b.on_ms = 80;
    b.off_ms = 40;
    REQUIRE(r.svc.beep(b).has_value());
    r.core.advance_ms(1000);
    // on at 0, 120, 240; off at 80, 200, 320 (the beep's default pitch, config beep_hz).
    const std::vector<Write> want = {
        {t0, 2000, 167},           {t0 + 80'000, 0, 0},  {t0 + 120'000, 2000, 167}, {t0 + 200'000, 0, 0},
        {t0 + 240'000, 2000, 167}, {t0 + 320'000, 0, 0},
    };
    CHECK(r.drv.writes == want);
    REQUIRE_EQ(r.dones().size(), 1u);
    CHECK(r.dones()[0].sound == BuzzerSound::beep);
    CHECK_EQ(r.done_times()[0], t0 + 320'000);  // done with the last beep, not after its pause
}

TEST(buzzer_beep_takes_its_own_pitch_and_volume)
{
    Rig r;
    REQUIRE(r.start());
    BuzzerBeepArgs b;
    b.has_freq_hz = true;
    b.freq_hz = 2700;
    b.has_volume = true;
    b.volume = 100;
    REQUIRE(r.svc.beep(b).has_value());
    CHECK_EQ(r.drv.hz, 2700);
    CHECK_EQ(r.drv.duty, 500);
    CHECK_EQ(r.svc.volume(), 50);  // the command's volume is for this sound only
    r.core.advance_ms(200);
    CHECK(!r.svc.playing());
    REQUIRE(r.svc.beep({}).has_value());
    CHECK_EQ(r.drv.duty, 167);
}

TEST(buzzer_beep_count_zero_runs_until_stop)
{
    Rig r;
    REQUIRE(r.start());
    BuzzerBeepArgs b;
    b.count = 0;
    b.on_ms = 10;
    b.off_ms = 10;
    REQUIRE(r.svc.beep(b).has_value());
    r.core.advance_ms(9'000);  // the hub stays live (fixture_link's hub_live)
    CHECK(r.svc.playing());
    CHECK_EQ(r.drv.writes.size(), 901u);  // every 10 ms from 0 to 9,000 inclusive
    REQUIRE(r.svc.stop().has_value());
    CHECK(!r.svc.playing());
    REQUIRE_EQ(r.dones().size(), 1u);
    CHECK(r.dones()[0].reason == BuzzerDoneReason::stopped);
    CHECK(!r.drv.sounding);
    CHECK_EQ(r.core.timers_running(), 0u);
    REQUIRE(r.svc.stop().has_value());  // idempotent
    CHECK_EQ(r.dones().size(), 1u);
}

TEST(buzzer_melody_schedule_with_the_gap_rule)
{
    Rig r;
    REQUIRE(r.start());
    const TimeUs t0 = r.core.now();
    // gap 20 ms: a 150 ms note sounds 130 then 20 silent; a 30 ms note gets 15 (half); a rest stays one silent step.
    REQUIRE(r.svc.melody(melody({523, 523, 0, 784}, {150, 30, 100, 400}, 20)).has_value());
    CHECK_EQ(r.svc.steps(), 7u);
    r.core.advance_ms(2000);
    const std::vector<Write> want = {
        {t0, 523, 167},           {t0 + 130'000, 0, 0},     {t0 + 150'000, 523, 167}, {t0 + 165'000, 0, 0},
        {t0 + 280'000, 784, 167}, {t0 + 660'000, 0, 0},
    };
    CHECK(r.drv.writes == want);
    REQUIRE_EQ(r.dones().size(), 1u);
    CHECK(r.dones()[0].sound == BuzzerSound::melody);
    CHECK_EQ(r.done_times()[0], t0 + 680'000);  // the sum of the lengths: the last gap is inside the last note
}

TEST(buzzer_melody_of_32_notes_does_not_drift_after_a_late_fire)
{
    Rig r;
    REQUIRE(r.start());
    BuzzerMelodyArgs m;
    for (int i = 0; i < 32; ++i) {
        m.freq_hz.push_back(static_cast<uint16_t>(400 + 50 * i));
        m.ms.push_back(static_cast<uint16_t>(37 + i));
    }
    m.gap_ms = 5;
    const TimeUs t0 = r.core.now();
    REQUIRE(r.svc.melody(m).has_value());
    CHECK_EQ(r.svc.steps(), 64u);
    // The core is busy for 3.5 ms in the middle of note 4: that fire is late, the next ones are not.
    TimeUs note4 = t0;
    for (int i = 0; i < 4; ++i) {
        note4 += static_cast<TimeUs>(37 + i) * 1000;
    }
    r.core.advance_to(note4 + 1000);
    r.core.stall_to(note4 + (37 + 4 - 5) * 1000 + 3500);
    r.core.advance_ms(3000);
    TimeUs want_end = t0;
    for (int i = 0; i < 32; ++i) {
        want_end += static_cast<TimeUs>(37 + i) * 1000;
    }
    REQUIRE_EQ(r.dones().size(), 1u);
    CHECK_EQ(r.done_times()[0], want_end);
    // Every note after the late one starts on its own schedule.
    TimeUs at = t0;
    size_t notes_on_time = 0;
    for (int i = 0; i < 32; ++i) {
        for (const Write &w : r.drv.writes) {
            if (w.hz == 400 + 50 * i && w.at == at) {
                ++notes_on_time;
            }
        }
        at += static_cast<TimeUs>(37 + i) * 1000;
    }
    CHECK_EQ(notes_on_time, 32u);
    // The late write: note 4's gap went silent 3.5 ms late, and note 5 started on time.
    bool late_gap = false;
    for (const Write &w : r.drv.writes) {
        late_gap = late_gap || (w.hz == 0 && w.at == note4 + 36'000 + 3500);
    }
    CHECK(late_gap);
}

TEST(buzzer_melody_repeat_and_repeat_zero)
{
    Rig r;
    REQUIRE(r.start());
    const TimeUs t0 = r.core.now();
    REQUIRE(r.svc.melody(melody({1000, 0}, {50, 50}, 0, 3)).has_value());
    r.core.advance_ms(1000);
    REQUIRE_EQ(r.dones().size(), 1u);
    CHECK_EQ(r.done_times()[0], t0 + 300'000);
    size_t ons = 0;
    for (const Write &w : r.drv.writes) {
        ons += w.hz == 1000 ? 1 : 0;
    }
    CHECK_EQ(ons, 3u);

    REQUIRE(r.svc.melody(melody({1000, 0}, {50, 50}, 0, 0)).has_value());
    r.core.advance_ms(5000);
    CHECK(r.svc.playing());
    REQUIRE(r.svc.stop().has_value());
    CHECK(r.dones().back().reason == BuzzerDoneReason::stopped);
}

TEST(buzzer_a_new_sound_replaces_the_playing_one)
{
    Rig r;
    REQUIRE(r.start());
    const TimeUs t0 = r.core.now();
    REQUIRE(r.svc.melody(melody({523, 659}, {500, 500})).has_value());
    r.core.advance_ms(100);
    REQUIRE(r.svc.tone(tone(3000, 50)).has_value());
    REQUIRE_EQ(r.dones().size(), 1u);
    CHECK(r.dones()[0].sound == BuzzerSound::melody);
    CHECK(r.dones()[0].reason == BuzzerDoneReason::replaced);
    CHECK_EQ(r.done_times()[0], t0 + 100'000);
    CHECK_EQ(r.drv.hz, 3000);
    r.core.advance_ms(50);
    REQUIRE_EQ(r.dones().size(), 2u);
    CHECK(r.dones()[1].sound == BuzzerSound::tone);
    CHECK(r.dones()[1].reason == BuzzerDoneReason::done);
    // playing stayed true across the replacement: one true, one false.
    const auto p = r.playing_reports();
    REQUIRE_EQ(p.size(), 2u);
    CHECK(p[0].second);
    CHECK(!p[1].second);
    r.core.advance_ms(2000);
    CHECK_EQ(r.dones().size(), 2u);  // the replaced melody's timer never fires again
}

TEST(buzzer_set_volume_changes_what_plays_and_what_follows)
{
    Rig r;
    REQUIRE(r.start());
    BuzzerToneArgs a = tone(1500, 1000);
    a.has_volume = true;
    a.volume = 10;
    REQUIRE(r.svc.tone(a).has_value());
    CHECK_EQ(r.drv.duty, 32);
    r.core.advance_ms(100);
    REQUIRE(r.svc.set_volume(BuzzerSetVolumeArgs{100}).has_value());
    CHECK_EQ(r.drv.duty, 500);
    CHECK_EQ(r.drv.hz, 1500);
    CHECK_EQ(r.svc.volume(), 100);
    REQUIRE(r.svc.set_volume(BuzzerSetVolumeArgs{100}).has_value());  // unchanged: no report
    CHECK(r.volume_reports() == std::vector<uint8_t>{100});
    r.core.advance_ms(1000);
    REQUIRE(r.svc.tone(tone(1500, 100)).has_value());
    CHECK_EQ(r.drv.duty, 500);
    CHECK(!r.svc.set_volume(BuzzerSetVolumeArgs{101}).has_value());
}

TEST(buzzer_volume_zero_is_silent_but_timed)
{
    BuzzerConfig cfg;
    cfg.volume = 0;
    Rig r(cfg);
    REQUIRE(r.start());
    const TimeUs t0 = r.core.now();
    REQUIRE(r.svc.tone(tone(2000, 300)).has_value());
    CHECK(r.svc.playing());
    CHECK(!r.drv.sounding);
    CHECK(r.drv.writes.empty());  // already silent: nothing to write
    r.core.advance_ms(300);
    REQUIRE_EQ(r.dones().size(), 1u);
    CHECK(r.dones()[0].reason == BuzzerDoneReason::done);
    CHECK_EQ(r.done_times()[0], t0 + 300'000);
}

TEST(buzzer_refuses_bad_arguments)
{
    Rig r;
    REQUIRE(r.start());
    CHECK(r.svc.tone(tone(99, 100)).error() == fr::Err::invalid_args);
    CHECK(r.svc.tone(tone(20001, 100)).error() == fr::Err::invalid_args);
    CHECK(r.svc.tone(tone(1000, 0)).error() == fr::Err::invalid_args);
    BuzzerBeepArgs b;
    b.has_freq_hz = true;
    b.freq_hz = 50;
    CHECK(r.svc.beep(b).error() == fr::Err::invalid_args);
    CHECK(r.svc.melody({}).error() == fr::Err::invalid_args);
    CHECK(r.svc.melody(melody({1000, 2000}, {100})).error() == fr::Err::invalid_args);
    CHECK(r.svc.melody(melody({1000}, {0})).error() == fr::Err::invalid_args);
    CHECK(r.svc.melody(melody({1000, 50}, {100, 100})).error() == fr::Err::invalid_args);
    CHECK(r.svc.melody(melody({0, 0}, {100, 100})).has_value());  // all rests: timed silence
    REQUIRE(r.svc.stop().has_value());
    // A refused command leaves what plays alone.
    REQUIRE(r.svc.tone(tone(1000, 500)).has_value());
    const size_t dones = r.dones().size();
    CHECK(!r.svc.tone(tone(30000, 10)).has_value());
    CHECK(r.svc.playing());
    CHECK_EQ(r.dones().size(), dones);
}

TEST(buzzer_ends_when_the_hub_falls_silent)
{
    Rig r;
    REQUIRE(r.start());
    BuzzerBeepArgs b;
    b.count = 0;
    REQUIRE(r.svc.beep(b).has_value());
    r.core.advance_ms(2000);
    frt::fixture_link().hub_stops();
    const TimeUs quiet = r.core.now();
    r.core.advance_ms(9'999);
    CHECK(r.svc.playing());
    r.core.advance_ms(1);
    CHECK(!r.svc.playing());
    REQUIRE_EQ(r.dones().size(), 1u);
    CHECK(r.dones()[0].reason == BuzzerDoneReason::hub_lost);
    CHECK_EQ(r.done_times()[0], quiet + BuzzerService::kHubSilentUs);
    CHECK(!r.drv.sounding);
}

TEST(buzzer_hub_silence_during_one_long_note)
{
    Rig r;
    REQUIRE(r.start());
    REQUIRE(r.svc.tone(tone(2000, 60000)).has_value());
    r.core.advance_ms(5000);
    frt::fixture_link().hub_stops();
    const TimeUs quiet = r.core.now();
    r.core.advance_ms(20'000);
    REQUIRE_EQ(r.dones().size(), 1u);
    CHECK(r.dones()[0].reason == BuzzerDoneReason::hub_lost);
    CHECK_EQ(r.done_times()[0], quiet + BuzzerService::kHubSilentUs);
}

TEST(buzzer_ends_at_another_hub_run)
{
    Rig r;
    REQUIRE(r.start());
    REQUIRE(r.svc.tone(tone(2000, 60000)).has_value());
    r.core.advance_ms(3000);
    frt::fixture_link().epoch = 42;  // a WELCOME of another hub run
    r.core.advance_ms(BuzzerService::kWakeUs / 1000);
    REQUIRE_EQ(r.dones().size(), 1u);
    CHECK(r.dones()[0].reason == BuzzerDoneReason::hub_lost);
}

TEST(buzzer_without_a_hub_session_plays_to_its_end)
{
    Rig r;
    REQUIRE(r.start());
    frt::fixture_link().session = false;
    frt::fixture_link().hub_stops();
    REQUIRE(r.svc.tone(tone(2000, 30000)).has_value());
    r.core.advance_ms(29'999);
    CHECK(r.svc.playing());
    r.core.advance_ms(1);
    REQUIRE_EQ(r.dones().size(), 1u);
    CHECK(r.dones()[0].reason == BuzzerDoneReason::done);
}

TEST(buzzer_driver_error_mid_sound_and_at_start)
{
    Rig r;
    REQUIRE(r.start());
    REQUIRE(r.svc.melody(melody({1000, 2000}, {100, 100})).has_value());
    r.drv.fail_play = true;
    r.core.advance_ms(150);
    CHECK(!r.svc.playing());
    REQUIRE_EQ(r.dones().size(), 1u);
    CHECK(r.dones()[0].reason == BuzzerDoneReason::error);
    CHECK(!r.drv.sounding);
    // At the start: the reply says FAILED, nothing plays, no done for a sound that never started.
    CHECK(r.svc.tone(tone(1000, 100)).error() == fr::Err::failed);
    CHECK(!r.svc.playing());
    CHECK_EQ(r.dones().size(), 1u);
}

TEST(buzzer_unpitched_sounds_every_note_at_full_loudness)
{
    Rig r({}, /*pitched=*/false, /*volume=*/false);
    REQUIRE(r.start());
    const auto t = r.svc.traits();
    CHECK(!t.pitched);
    CHECK(!t.volume);
    REQUIRE(r.svc.tone(tone(30, 100)).has_value());  // the schema's range; the driver plays its own pitch
    CHECK_EQ(r.drv.duty, 500);
    r.core.advance_ms(100);
    BuzzerConfig quiet;
    quiet.volume = 0;
    Rig q(quiet, false, false);
    REQUIRE(q.start());
    REQUIRE(q.svc.tone(tone(2000, 100)).has_value());
    CHECK(!q.drv.sounding);  // volume 0 is silence on any buzzer
}

TEST(buzzer_report_all_says_playing_and_volume)
{
    Rig r;
    REQUIRE(r.start());
    r.svc.report_all();
    const auto props = r.sink.properties();
    bool playing = false;
    bool volume = false;
    for (const auto &e : props) {
        playing = playing || e.id == Buzzer::kPropPlaying;
        volume = volume || e.id == Buzzer::kPropVolume;
    }
    CHECK(playing);
    CHECK(volume);
}

}  // namespace
