// L1 tone contract (spec 07 §7.7; design buzzer-b1 D3): a driver makes a square wave at a pitch and a duty;
// BuzzerService owns everything else (the sounds, their timing, volume, hub silence, events).
//
// Threading: every method runs on the core task. play() and silence() return well under a millisecond (register
// writes, a divider change); the driver has no task, timer or ISR of its own.
#pragma once

#include <cstdint>

#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/hal/selftest.hpp"

namespace fr::hal {

/** A buzzer on one output: a passive one (ledc_buzzer: LEDC PWM at the note's pitch), later an active one. */
class ToneOutput
{
public:
    /** Claims the pin and drives it silent (its idle level) before anything else can fail. Board init. */
    virtual Status init(Core &core) = 0;
    /**
     * A square wave at `freq_hz` with `duty_permille` of each period at the active level (0-500; 0 is silent, 500 the
     * loudest). Err::invalid_args for a pitch outside min_hz()..max_hz() on a pitched driver (an unpitched one ignores
     * the pitch); Err::failed when the peripheral refuses. Writing the same pitch again changes only the duty.
     */
    virtual Status play(uint16_t freq_hz, uint16_t duty_permille) = 0;
    /** Silent now: the pad at its idle level. OK when already silent. */
    virtual Status silence() = 0;
    /** Plays the pitch asked (trait pitched); false: a fixed-pitch buzzer that sounds at its own pitch. */
    virtual bool pitched() const = 0;
    /** The duty sets the loudness (trait volume); false: any duty above 0 is full loudness. */
    virtual bool volume() const = 0;
    /** The pitches play() takes (traits min_hz, max_hz). */
    virtual uint16_t min_hz() const = 0;
    virtual uint16_t max_hz() const = 0;
    /** Pin and peripheral claimed; a silent pad reads its idle level. A playing pad is not checked. */
    virtual Selftest selftest() = 0;

protected:
    ~ToneOutput() = default;
};

}  // namespace fr::hal
