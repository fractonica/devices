// L1 e-paper panel contract (design epaper-e1 D5): what EpaperBackend (fr/display/epaper_backend.hpp) asks of an
// e-paper controller. The backend owns the policy (when, which mode, which area, the ghost budget, sleep); the
// driver turns each step into its controller's commands. Every step returns at once: the ones that keep BUSY high
// (start()) end with BUSY's fall, reported on the core task through on_idle(); the reset pulse is timed by the
// backend. An e-paper panel is a hal::Display (geometry, init, selftest, no backlight) whose flush() is not used.
#pragma once

#include <cstdint>
#include <span>

#include "fr/base.hpp"
#include "fr/hal/display.hpp"

namespace fr::hal {

class Epaper : public Display
{
public:
    /**
     * The controller's two image RAMs. `next`: the picture to show (the SSD1683's 0x24). `prev`: the picture the glass
     * shows now (0x26), which a partial refresh compares `next` with, driving only the pixels that differ.
     */
    enum class Plane : uint8_t { next = 0, prev = 1 };

    /** What start() runs; each keeps BUSY high until it is done. */
    enum class Op : uint8_t {
        full = 0,          // the whole screen, normal waveform (flashes; clears ghosts); high voltage off after
        fast = 1,          // the whole screen, the short hot-temperature waveform; high voltage off after
        partial = 2,       // only pixels where next differs from prev move; high voltage off after
        partial_hold = 3,  // the same, the high voltage left on, so a partial that follows starts sooner
        power_off = 4,     // the high voltage off (after partial_hold)
        soft_reset = 5,    // the controller's software reset, after the reset line; configure() follows
    };

    /** Where BUSY's fall is reported: on the core task, with the time of the edge. */
    using IdleSink = Callback<void(TimeUs at), 16>;

    /** Before init(): the backend's sink for BUSY's fall. */
    virtual void on_idle(IdleSink sink) = 0;
    /**
     * Whether the controller answered the last start() (at boot: init's software reset): BUSY rose after it and has
     * fallen since. False for a panel that is absent or not powered, whose BUSY never rises.
     */
    virtual bool answered() const = 0;
    /** The reset line: asserted (low) holds the controller in reset. The backend times the pulse. */
    virtual Status hold_reset(bool asserted) = 0;
    /** After a soft_reset's BUSY fall: the controller's set-up (data entry, border, the whole window). */
    virtual Status configure() = 0;
    /** The window (native pixels, x and w multiples of 8) where `plane` is written next, then that plane's write. */
    virtual Status write_begin(Plane plane, uint16_t x, uint16_t y, uint16_t w, uint16_t h) = 0;
    /** The next bytes of the window, row after row, MSB the leftmost pixel, 1 white (any split across calls). */
    virtual Status write(std::span<const uint8_t> bytes) = 0;
    /** Starts `op` and returns; BUSY's fall reports its end through on_idle. */
    virtual Status start(Op op) = 0;
    /** Deep sleep with the RAM kept: BUSY stays high and only a reset (hold_reset, soft_reset) wakes it. */
    virtual Status sleep() = 0;
    /** BUSY now. */
    virtual bool busy() const = 0;
    /** How long `op` may keep BUSY high before the backend gives up on it. */
    virtual uint32_t timeout_us(Op op) const
    {
        switch (op) {
        case Op::full:
            return 10'000'000;
        case Op::fast:
            return 4'000'000;
        case Op::partial:
        case Op::partial_hold:
            return 2'000'000;
        case Op::power_off:
            return 1'000'000;
        case Op::soft_reset:
            return 500'000;
        }
        return 10'000'000;
    }

    PixelFormat format() const override { return PixelFormat::mono1; }
    /** Not the e-paper path: EpaperBackend writes planes and starts refreshes instead. */
    Status flush(uint16_t x, uint16_t y, uint16_t w, uint16_t h, std::span<const uint8_t> pixels) override
    {
        static_cast<void>(x);
        static_cast<void>(y);
        static_cast<void>(w);
        static_cast<void>(h);
        static_cast<void>(pixels);
        return std::unexpected(Err::unsupported);
    }

protected:
    ~Epaper() = default;
};

}  // namespace fr::hal
