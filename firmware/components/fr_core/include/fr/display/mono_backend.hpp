// The C3 OLED's renderer (design m2-c5-display D3): a 1-bit framebuffer at the panel's size, the built-in 5x7 font and
// a flush of the dirty area from a core timer. IDF-free: the host suite and the desktop renderer (tools/display) build
// the same file, so a mono profile's render is this code's output, byte for byte.
#pragma once

#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

#include "fr/display/backend.hpp"
#include "fr/display/mono_canvas.hpp"

namespace fr::display {

/**
 * fr.display primitives on a mono1 panel of at most kMaxWidth x kMaxHeight (the SSD1306's GDDRAM).
 *
 * Drawing (core task, inside dispatch) only touches the RAM framebuffer, in the snapshot layout of
 * fr/display/backend.hpp, and grows a dirty rectangle. The flush timer (the one timer codegen budgets for
 * fr.display) starts on the first change after a flush, at most flush_ms after the previous flush began, and writes
 * one 8-row page of the dirty rectangle per firing (re-arming at once for the next), so the core task handles its
 * inputs between pages (an SSD1306 page at 400 kHz is about 2 ms of I2C).
 *
 * The drawing is MonoCanvas's (text, rectangles, bitmaps; fr/display/mono_canvas.hpp), clipped to the screen, colours
 * through mono_lit().
 */
class MonoBackend final : public Backend
{
public:
    static constexpr uint16_t kMaxWidth = 128;
    static constexpr uint16_t kMaxHeight = 64;
    static constexpr size_t kMaxBytes = kMaxWidth / 8 * kMaxHeight;

    Status init(hal::Display &panel, const cap::DisplayConfig &cfg, Core &core, UiEventSink sink) override;
    Status clear(uint32_t rgb) override;
    Status text(const cap::DisplayTextArgs &a) override;
    Status fill_rect(const cap::DisplayFillRectArgs &a) override;
    Status bitmap(const cap::DisplayBitmapArgs &a) override;
    std::expected<Snapshot, Err> snapshot() override;
    std::expected<size_t, Err> snapshot_read(uint32_t offset, std::span<uint8_t> out) override;

    /** The framebuffer as drawn (snapshot layout), for tests and the desktop renderer. */
    std::span<const uint8_t> framebuffer() const { return canvas_.pixels(); }
    bool pixel(int x, int y) const { return canvas_.pixel(x, y); }
    uint16_t width() const { return w_; }
    uint16_t height() const { return h_; }
    /** Whether a part of the framebuffer still waits for its flush. */
    bool dirty() const { return !dirty_.empty(); }
    /** panel.flush() calls that failed (the area is dropped, not retried). */
    uint32_t flush_errors() const { return flush_errors_; }

private:
    size_t bytes() const { return canvas_.bytes(); }
    void mark(const Box &b);
    void schedule();
    void flush_page();

    MonoCanvas canvas_;
    hal::Display *panel_ = nullptr;
    Core *core_ = nullptr;
    Timer *timer_ = nullptr;
    uint16_t w_ = 0;
    uint16_t h_ = 0;
    uint32_t flush_us_ = 0;
    TimeUs last_flush_ = 0;
    bool flushed_once_ = false;
    bool flushing_ = false;  // a flush has sent some pages of the dirty rectangle, not all
    Box dirty_;
    uint32_t flush_errors_ = 0;
    uint8_t fb_[kMaxBytes] = {};
    uint8_t frozen_[kMaxBytes] = {};  // the frame the last snapshot() froze
    uint32_t frozen_bytes_ = 0;
    bool has_frozen_ = false;
};

}  // namespace fr::display
