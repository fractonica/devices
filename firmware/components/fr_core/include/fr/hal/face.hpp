// hal::Face (design face-f1 D5): the clock face the fractonica_face driver draws with the clock library
// (clock/components/fractonica_ui over the core). FaceService drives it: update() with the wall clock's time says
// whether to redraw, what changed and how long to sleep; draw() paints that into a panel's 1-bit frame. IDF-free;
// the host suite fakes it. Every call is for the core task.
#pragma once

#include <cstdint>
#include <optional>
#include <span>

#include "fr/base.hpp"

namespace fr::hal {

/** What the face says after an update. */
struct FaceFrame {
    bool redraw = false;
    /** The rectangle that changed (inclusive corners), when `redraw`. */
    int x0 = 0, y0 = 0, x1 = -1, y1 = -1;
    /** Sleep this long unless an event arrives; -1: until an event (no time, no label showing). */
    int64_t sleep_us = -1;
};

class Face
{
public:
    /** The clock's four inputs (fr.face Input + 1: the library's values). */
    enum class Input : uint8_t { next = 1, prev = 2, select = 3, long_ = 4 };

    /**
     * Once, before anything else: a face for a `width` x `height` one-bit panel (Err::unsupported when the library
     * has none of that size), in `mode` (0 pure, 1 earth) with `focus`, moving on level `step_level` (6..10).
     */
    virtual Status init(uint16_t width, uint16_t height, uint8_t mode, uint8_t focus, uint8_t step_level,
                        int16_t utc_offset_min) = 0;
    /** Advances to `unix_us` (nullopt: the time is not known), `now_ms` timing the brief labels. */
    virtual FaceFrame update(std::optional<int64_t> unix_us, uint32_t now_ms) = 0;
    /**
     * Paints the last update's frame within the inclusive box (x0, y0)-(x1, y1) into `frame`: rows of
     * ceil(width / 8) bytes, MSB the leftmost pixel, a set bit white (the paper), the box cleared to white first.
     */
    virtual void draw(std::span<uint8_t> frame, uint16_t width, uint16_t height, int x0, int y0, int x1, int y1) = 0;
    /** One input; true when it changed the state (update at once). */
    virtual bool input(Input in, uint32_t now_ms) = 0;
    /** The next update redraws everything. */
    virtual void invalidate() = 0;
    /** What rollover() answers when no period began (the same cycle, a jump, no time). */
    static constexpr uint8_t kNoLevel = 0xFF;
    /**
     * Design face-f1 D19 (the chime): when the cycle of `step_level` running at `to_us` is the one right after the cycle
     * running at `from_us` (Unix microseconds: the face moved one step, it did not jump), the coarsest level
     * (0..step_level) whose cycle changed between the two; kNoLevel otherwise.
     */
    virtual uint8_t rollover(int64_t from_us, int64_t to_us, uint8_t step_level) = 0;

    virtual void set_mode(uint8_t mode) = 0;
    virtual void set_focus(uint8_t focus) = 0;
    virtual void set_screen(uint8_t screen) = 0;
    virtual void set_step(uint8_t level) = 0;
    virtual void set_utc_offset_min(int16_t minutes) = 0;

    virtual uint8_t mode() const = 0;
    virtual uint8_t focus() const = 0;
    /** 0 now, 1 scales, 2 lens, 3 sun, 4 stamp. */
    virtual uint8_t screen() const = 0;

protected:
    ~Face() = default;
};

}  // namespace fr::hal
