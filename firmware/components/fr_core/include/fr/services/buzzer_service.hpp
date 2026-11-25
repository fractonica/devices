// L2 buzzer service (spec 07 §7.3, §7.7-7.8; design buzzer-b1 D5, D6): fr.buzzer over any hal::ToneOutput.
// Host-buildable.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "buzzer.hpp"  // generated fr::cap::Buzzer
#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/tone.hpp"

namespace fr {

/**
 * Everything on the core task, with one fr_core timer. A sound is a list of steps (a pitch, 0 for silence, and a
 * length) played `repeat` times, or until stop:
 *
 *   tone:   one step of freq_hz for ms;
 *   beep:   on_ms at freq_hz (else config beep_hz), then off_ms of silence; `count` times (0: until stop), the last
 *           beep without its pause (done comes at the last beep's end);
 *   melody: each note's pitch for its length less the gap, then the gap (min(gap_ms, half the note)) of silence; a
 *           rest is one silent step; `repeat` times (0: until stop).
 *
 * Each step's end is reckoned from the sound's start (the sum of the lengths before it), never from the timer's late
 * fire, so a long melody does not drift: a late fire writes the step that is due and shortens it. The timer sleeps
 * until the next step's end, the hub-silence deadline or kWakeUs, whichever comes first.
 *
 * One sound at a time: a new one replaces the one playing (done replaced, at once; `playing` stays true), `stop` ends
 * it (done stopped). A command answers once the first step is written. The duty of a sounding step is
 * duty_for_volume(volume): the volume of the sound (its command's `volume`, else the current one), which set_volume
 * replaces at once. A driver without volume (traits.volume false) gets 500 permille for any volume above 0.
 *
 * Hub silence (as HapticService): a sound started while a hub session existed ends with done hub_lost kHubSilentUs
 * after that hub's newest frame (fr::core::link_info().hub_heard_at), or at a WELCOME of another hub run. A sound
 * started without a hub session (a local app) runs to its end.
 */
class BuzzerService final : public cap::Buzzer
{
public:
    BuzzerService(hal::ToneOutput &out, const cap::BuzzerConfig &cfg);

    /** The driver first (silent); then Err::invalid_args for a beep_hz outside a pitched driver's range or a volume
     *  above 100 (codegen refuses both), Err::failed with no timer. */
    Status init(Core &core);
    hal::Selftest selftest();

    Status tone(const cap::BuzzerToneArgs &args) override;
    Status beep(const cap::BuzzerBeepArgs &args) override;
    Status melody(const cap::BuzzerMelodyArgs &args) override;
    Status stop() override;
    Status set_volume(const cap::BuzzerSetVolumeArgs &args) override;
    /**
     * For a service on the node (design face-f1 D19: the face's clicks and chimes): tone and melody as above, but the
     * node's own sound, so the hub's silence never ends it (done comes as for any sound).
     */
    Status tone_local(const cap::BuzzerToneArgs &args);
    Status melody_local(const cap::BuzzerMelodyArgs &args);

    bool playing() const override { return playing_; }
    uint8_t volume() const override { return volume_; }
    cap::BuzzerTraits traits() const override { return traits_; }

    /** What plays (meaningful while playing()). */
    cap::BuzzerSound sound() const { return sound_; }
    /** The volume the playing sound sounds at. */
    uint8_t level() const { return level_; }
    /** The steps of the playing sound (a melody of 32 notes with gaps is 64). */
    size_t steps() const { return n_steps_; }

    /**
     * The duty (permille, 0-500) for a volume (percent): the fundamental of a square wave of duty d has an amplitude
     * proportional to sin(pi d), so d = asin(v / 100) / pi makes the volume linear in amplitude: 100 is 500, 50 is
     * 167 (-6 dB), 10 is 32, 1 is 3, 0 is 0.
     */
    static uint16_t duty_for_volume(uint8_t volume);

    static constexpr TimeUs kHubSilentUs = 10'000'000;
    /** The longest the timer sleeps: a new hub run (another epoch) is noticed within this. */
    static constexpr uint32_t kWakeUs = 1'000'000;
    static constexpr size_t kMaxNotes = 32;
    static constexpr size_t kMaxSteps = 2 * kMaxNotes;

private:
    struct Step {
        uint16_t hz;  // 0: silent
        uint32_t us;
    };

    /** Checks a pitch (0 allowed when `rest_ok`) against a pitched driver's range. */
    bool pitch_ok(uint16_t hz, bool rest_ok) const;
    /** Replaces what plays with the steps in steps_[0..n), from now; writes the first step. */
    Status start(cap::BuzzerSound sound, size_t n, uint16_t repeat, bool has_volume, uint8_t volume);
    void on_timer();
    /** Moves through the steps to `now`, writes the one due and arms the timer; ends the sound past its last. */
    void run(TimeUs now);
    /** The output for the current step; false when the driver refused (the sound then ends with error). */
    bool write_step();
    bool write(uint16_t hz, uint16_t duty);
    void finish(cap::BuzzerDoneReason why, TimeUs now);
    bool hub_gone(TimeUs now) const;

    hal::ToneOutput &out_;
    cap::BuzzerConfig cfg_;
    cap::BuzzerTraits traits_;
    Core *core_ = nullptr;
    Timer *timer_ = nullptr;
    uint8_t volume_ = 50;

    // the sound
    std::array<Step, kMaxSteps> steps_{};
    size_t n_steps_ = 0;
    size_t step_ = 0;
    TimeUs step_end_ = 0;
    uint16_t repeats_left_ = 0;  // passes after this one; ignored when forever_
    bool forever_ = false;
    bool trim_tail_ = false;  // the last pass ends before its last step (a beep's pause)
    bool playing_ = false;
    cap::BuzzerSound sound_ = cap::BuzzerSound::tone;
    uint8_t level_ = 50;
    bool hub_ = false;  // a hub session existed at the start: its silence ends the sound
    bool local_ = false;  // the sound being started is a service's own (tone_local, melody_local)
    uint16_t hub_epoch_ = 0;

    // what the driver was last told (hz 0 and duty 0: silent)
    uint16_t out_hz_ = 0;
    uint16_t out_duty_ = 0;
};

}  // namespace fr
