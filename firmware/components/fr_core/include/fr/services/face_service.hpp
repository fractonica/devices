// FaceService: fr.face (design face-f1 D2-D17). The Fractonica clock face, drawn on the node by a hal::Face (the
// fractonica_face driver: the clock library over the core) into a bound fr.display panel's 1-bit frame. IDF-free.
#pragma once

#include <cstdint>
#include <optional>
#include <span>

#include "face.hpp"  // generated fr::cap::Face
#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/face.hpp"
#include "fr/hal/selftest.hpp"
#include "fr/hal/settings.hpp"
#include "fr/hal/sleep.hpp"
#include "fr/services/button_service.hpp"
#include "fr/services/buzzer_service.hpp"
#include "fr/services/display_service.hpp"
#include "fr/services/rtc_service.hpp"

namespace fr {

/**
 * The loop (D6): one core timer, never polling. Each firing asks the face for the wall clock's instant (fr/wall_clock);
 * a redraw is painted into the panel's frame (DisplayService::paint), whose own settle timer then sends one partial
 * refresh of the changed bytes. The face moves on `step` (D4: the library shows the start of the step level's running
 * cycle and wakes at its end); the timer fires kWakeMarginUs after that end. Until the wall clock is set the face
 * waits wait_time_s after boot, then says the time is not set; the wall clock's listener redraws when it comes.
 *
 * The screen (D6): the face has it at boot. A hub client's drawing command (DisplayService's ScreenListener) takes
 * it: `shown` false, nothing painted. `show`, `input`, or a press of the face's button gives it back (that press is
 * not a clock input).
 *
 * The button (D6): click next, double click select, a release after 0.6-5 s long; held 5 s, power save on or off
 * (acted on at 5 s, while still held). The button's own long_press_ms should stay at its 600 ms default.
 *
 * Three keys (D18): with a left or a right key bound, left is prev and right next, each at its press (no wait for a
 * second click), and the centre button turns the screen: a release before 0.6 s select, 0.6-5 s long, held 5 s power
 * save as above (its clicks are not used). Any key takes the screen back from a hub client (no clock input) and, in
 * power save, keeps the node awake awake_s; only the centre one wakes it.
 *
 * Sounds (D19, with a buzzer bound): every key's press clicks (each key its own pitch), a long press and power save
 * on and off have their own sounds, all while `clicks`; and when the face moves onto the next cycle of its step and that
 * cycle begins a period of `chime` or longer (hal::Face::rollover), it chimes: one note for a Preon, two for a theta,
 * three for a Helion, four for anything longer. The face chimes only while it has the screen and knows the time, at
 * the steps it moves on (a step coarser than the chime's period chimes at the step's boundaries). Power save keeps the
 * node awake until a sound has ended, and the instant it went to sleep (KeepHeader) is the step it chimes from.
 *
 * Settings (D6): mode, focus, step and the UTC offset in NVS (keys f<port>m, f<port>f, f<port>s, f<port>u), written
 * once they have held for kSaveDelayUs.
 *
 * Power save (D13-D15; trait can_sleep: a key on a wake pin, the centre button, an RTC whose alarm pin wakes the chip, the
 * platform's hal::Sleep,
 * and LP memory for the glass): entering sets the RTC from the wall clock when the hub's time is there, then saves
 * the offline flag and restarts (BYE `sleep`). An offline boot draws, lets the panel refresh and go to sleep, keeps
 * the glass and the ghost budget in LP memory (a CRC over both), sets the RTC's alarm at the next step boundary
 * (rounded up to the second) and deep-sleeps until it, or a key on a wake pin (any of the face's: D18), or a backstop
 * kBackstopUs later. A boot from a key stays awake awake_s after the last press; the centre button held 5 s through or
 * after the wake leaves power save (offline flag cleared, restart). The waking press itself is no input (a button
 * held through boot never becomes a click or a press).
 */
class FaceService final : public cap::Face, private ScreenListener, private ButtonListener
{
public:
    /** What the generated glue knows of the pins (design face-f1 D16). */
    struct SleepPins {
        uint64_t wake_low = 0;  // the keys' wake pins and the RTC's alarm pin
        uint64_t hold = 0;      // the panel's lines to keep while asleep (RST, CS, DC)
        uint64_t keys = 0;      // the keys' pins that wake the chip (a wake by one opens the awake window; D18)
    };

    static constexpr TimeUs kWakeMarginUs = 50'000;
    static constexpr uint32_t kLongMs = 600;
    static constexpr uint32_t kHoldPowerMs = 5'000;
    static constexpr TimeUs kSaveDelayUs = 5'000'000;
    /** Power save: the timer wake after the RTC's alarm should have come (a loose wire). */
    static constexpr uint64_t kBackstopUs = 120'000'000;
    /** Power save with no time at all: the next look. */
    static constexpr uint64_t kNoTimeSleepUs = 600'000'000;
    /** Power save: how long entering waits for the RTC's set to land before the restart. */
    static constexpr TimeUs kEnterWaitUs = 3'000'000;
    static constexpr uint32_t kKeepMagic = 0x46414345;  // "FACE"
    /** LP memory the glue gives power save: this header, then the frame. */
    struct KeepHeader {
        uint32_t magic;
        uint32_t size;  // frame bytes that follow
        uint32_t crc;   // of the frame bytes
        uint32_t clean_age_s;
        int64_t slept_unix_us;  // the wall clock when it went to sleep (0: unknown)
        uint8_t partials;
        uint8_t pad[3];
        uint32_t hcrc;  // of the header up to here
    };

    FaceService(hal::Face &face, hal::Settings &settings, const cap::FaceConfig &cfg);
    /** The wall clock's listener goes with it (a node's face lives for good; a host test's does not). */
    ~FaceService();
    FaceService(const FaceService &) = delete;
    FaceService &operator=(const FaceService &) = delete;

    // Before init (the generated glue).
    void bind_display(DisplayService &display) { display_ = &display; }
    void bind_button(ButtonService &button) { button_ = &button; }
    void bind_left(ButtonService &button) { left_ = &button; }
    void bind_right(ButtonService &button) { right_ = &button; }
    void bind_buzzer(BuzzerService &buzzer) { buzzer_ = &buzzer; }
    void bind_rtc(RtcService &rtc) { rtc_ = &rtc; }
    void bind_sleep(hal::Sleep &sleep, const SleepPins &pins)
    {
        sleep_ = &sleep;
        pins_ = pins;
    }
    void bind_keep(std::span<uint8_t> keep) { keep_ = keep; }

    /** Err::invalid_args with no display bound or a panel the face has no layout for. */
    Status init(Core &core);
    hal::Selftest selftest();

    Status show() override;
    Status input(const cap::FaceInputArgs &args) override;
    Status set(const cap::FaceSetArgs &args) override;

    cap::FaceMode mode() const override { return static_cast<cap::FaceMode>(face_.mode()); }
    cap::FaceScreen screen() const override { return static_cast<cap::FaceScreen>(face_.screen()); }
    uint8_t focus() const override { return face_.focus(); }
    cap::FaceStep step() const override { return step_; }
    int16_t utc_offset_min() const override { return utc_; }
    bool shown() const override { return shown_; }
    bool time_valid() const override;
    cap::FaceTimeSource time_source() const override;
    bool power_save() const override { return power_save_ || entering_; }
    cap::FaceChime chime() const override { return chime_; }
    bool clicks() const override { return clicks_; }
    cap::FaceTraits traits() const override { return traits_; }

    // For tests.
    bool can_sleep() const { return traits_.can_sleep; }
    bool entering() const { return entering_; }
    TimeUs awake_until() const { return awake_until_; }
    /** The last deep sleep asked: the timer, and the alarm's whole second (0: none). */
    uint64_t slept_after_us() const { return slept_after_us_; }
    uint32_t alarm_unix() const { return alarm_unix_; }
    /** The level of the last chime (hal::Face::kNoLevel: none yet) and how many there were. */
    uint8_t last_chime() const { return last_chime_; }
    uint32_t chimes() const { return chimes_; }

    /** The face's sounds (D19). */
    enum class Sound : uint8_t { click_left, click_centre, click_right, long_, save_on, save_off, refused };
    /** How long the face waits for a sound to end before a restart into or out of power save. */
    static constexpr TimeUs kSoundWaitUs = 1'000'000;

private:
    /** A left or right key (D18): ButtonService has one listener, so each side key has its own. */
    class SideKey final : public ButtonListener
    {
    public:
        SideKey(FaceService &face, bool right) : face_(face), right_(right) {}
        void on_button_down(TimeUs at) override { face_.side_down(right_, at); }
        void on_button_up(uint32_t held_ms, TimeUs at) override { face_.side_up(at, held_ms); }
        void on_button_click(uint8_t count, TimeUs at) override
        {
            static_cast<void>(count);
            static_cast<void>(at);
        }

    private:
        FaceService &face_;
        bool right_;
    };

    void on_client_drew() override;
    void on_button_down(TimeUs at) override;
    void on_button_up(uint32_t held_ms, TimeUs at) override;
    void on_button_click(uint8_t count, TimeUs at) override;
    void side_down(bool right, TimeUs at);
    void side_up(TimeUs at, uint32_t held_ms);
    bool three_keys() const { return left_ != nullptr || right_ != nullptr; }
    /** Power save: any key keeps the node awake awake_s from `at`. */
    void stay_awake(TimeUs at);

    void play(Sound s);
    void chime(uint8_t level);
    void chime_check(int64_t unix_us);
    bool sounding() const { return buzzer_ != nullptr && buzzer_->playing(); }

    void tick();
    void arm(TimeUs now);
    void draw(const hal::FaceFrame &f);
    void apply_input(hal::Face::Input in);
    void report_changes(TimeUs at);
    void settings_changed(TimeUs now);
    void save_settings();
    void load_settings();
    const char *key(char which);

    void toggle_power_save();
    Status enter_power_save();
    void leave_power_save();
    /** Power save may begin: the RTC has answered, and the hub's clock or the RTC's knows the time. */
    bool rtc_answers() const;
    void adopt_glass(TimeUs now);
    void on_panel_asleep();
    void sleep_now();
    uint32_t ms(TimeUs t) const { return static_cast<uint32_t>(t / 1000); }

    hal::Face &face_;
    cap::FaceConfig cfg_;
    hal::Settings &settings_;
    DisplayService *display_ = nullptr;
    ButtonService *button_ = nullptr;
    ButtonService *left_ = nullptr;
    ButtonService *right_ = nullptr;
    BuzzerService *buzzer_ = nullptr;
    SideKey left_key_{*this, false};
    SideKey right_key_{*this, true};
    RtcService *rtc_ = nullptr;
    hal::Sleep *sleep_ = nullptr;
    SleepPins pins_{};
    std::span<uint8_t> keep_;
    Core *core_ = nullptr;
    Timer *timer_ = nullptr;
    cap::FaceTraits traits_{};

    cap::FaceStep step_ = cap::FaceStep::preon;
    int16_t utc_ = 0;
    cap::FaceChime chime_ = cap::FaceChime::preon;
    bool clicks_ = true;
    std::optional<int64_t> last_unix_;  // the wall clock at the last update (D19: the chime's "from")
    uint8_t last_chime_ = 0xFF;
    uint32_t chimes_ = 0;
    bool shown_ = true;
    bool ready_ = false;
    TimeUs boot_at_ = 0;
    TimeUs next_due_ = 0;     // the face's next update; kNever: none
    TimeUs save_due_ = 0;     // kNever: nothing to save

    // The button.
    bool pressed_ = false;
    bool consumed_ = false;   // this press took the screen back: no clock input from it
    bool skip_click_ = false; // its click, which ButtonService decides after the release
    bool hold_fired_ = false;
    TimeUs down_at_ = 0;

    // Power save.
    bool power_save_ = false;  // this boot is offline
    bool entering_ = false;    // power save asked: waiting for the RTC's set, then the restart
    bool leaving_ = false;     // power save left by the key: waiting for its sound, then the restart
    TimeUs enter_since_ = 0;
    bool adopted_ = false;     // the kept glass was given to the panel (or there was none)
    bool keep_valid_ = false;
    TimeUs awake_until_ = 0;   // power save: stay awake until (a button wake)
    bool slept_ = false;
    uint64_t slept_after_us_ = 0;
    uint32_t alarm_unix_ = 0;

    // Reported.
    struct Reported {
        uint8_t mode = 0xFF, screen = 0xFF, focus = 0xFF, step = 0xFF, source = 0xFF, chime = 0xFF;
        int16_t utc = 0;
        bool utc_set = false;
        int8_t shown = -1, valid = -1, save = -1, clicks = -1;
    } rep_;

    char key_[hal::Settings::kKeyMax + 1] = {};
    char detail_[96] = {};
};

}  // namespace fr
