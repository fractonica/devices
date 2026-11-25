// One render (design m2-c5-display D6): a panel of the given geometry with the firmware's own display stack on the Mac
// (DisplayService and TouchService from fr_core, LvglBackend from fr_ui or MonoBackend from fr_core, the generated
// dispatch), driven by script lines on a virtual clock. fr_display_render and fr_display_tests both run it.
#pragma once

#include <cstddef>
#include <cstdint>
#include <expected>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "display.hpp"
#include "fr/cap/capability.hpp"
#include "fr/display/backend.hpp"
#include "fr/hal/display.hpp"
#include "fr/hal/epaper.hpp"
#include "fr/hal/touch.hpp"
#include "fr/services/display_service.hpp"
#include "fr/services/touch_service.hpp"
#include "host_core.hpp"

namespace fr::ui {
class LvglBackend;
}

namespace frd {

/** The panel as the profile's kPanels entry (board.hpp) describes it. */
struct Geometry {
    uint16_t width = 0;   // after rotation
    uint16_t height = 0;  // after rotation
    fr::hal::PixelFormat format = fr::hal::PixelFormat::rgb565;
    fr::hal::Rotation rotation = fr::hal::Rotation::r0;
    bool ui = false;  // LVGL (fr_ui); false: MonoBackend
    // Trait round (design scale-round-c1 D5): the glass shows only the inscribed circle. The framebuffer and its CRC
    // are the whole rectangle, as on the board; only the PNG and the window grey the corners.
    bool round = false;
    // Trait epaper (design epaper-e1 D12): fr_core's EpaperBackend over an instant host controller; the frame (what the
    // board's snapshot reads) is the one drawn.
    bool epaper = false;
};

/**
 * An e-paper controller for the desktop (design epaper-e1 D12): it takes every write and finishes every step 1 ms later
 * on the virtual clock, so EpaperBackend's refreshes run their course; the picture is the backend's frame.
 */
class HostEpaper final : public fr::hal::Epaper
{
public:
    HostEpaper(uint16_t native_w, uint16_t native_h) : native_w_(native_w), native_h_(native_h) {}

    fr::Status init(fr::Core &core, fr::hal::Rotation rotation) override;
    uint16_t native_width() const override { return native_w_; }
    uint16_t native_height() const override { return native_h_; }
    fr::hal::Rotation rotation() const override { return rotation_; }
    fr::hal::Selftest selftest() override { return {true, "desktop e-paper"}; }
    void on_idle(IdleSink sink) override { idle_ = sink; }
    bool answered() const override { return answered_; }
    fr::Status hold_reset(bool) override { return {}; }
    fr::Status configure() override { return {}; }
    fr::Status write_begin(Plane, uint16_t, uint16_t, uint16_t, uint16_t) override { return {}; }
    fr::Status write(std::span<const uint8_t>) override { return {}; }
    fr::Status start(Op op) override;
    fr::Status sleep() override { return {}; }
    bool busy() const override { return busy_; }

private:
    uint16_t native_w_;
    uint16_t native_h_;
    fr::hal::Rotation rotation_ = fr::hal::Rotation::r0;
    fr::Core *core_ = nullptr;
    fr::Timer *timer_ = nullptr;
    IdleSink idle_;
    bool busy_ = false;
    bool answered_ = false;
};

/** A hal::Display that keeps what it is sent: the glass, in the snapshot layout of fr/display/backend.hpp. */
class HostPanel final : public fr::hal::Display
{
public:
    HostPanel(uint16_t native_w, uint16_t native_h, fr::hal::PixelFormat format);

    fr::Status init(fr::Core &core, fr::hal::Rotation rotation) override;
    uint16_t native_width() const override { return native_w_; }
    uint16_t native_height() const override { return native_h_; }
    fr::hal::PixelFormat format() const override { return format_; }
    fr::hal::Rotation rotation() const override { return rotation_; }
    fr::Status flush(uint16_t x, uint16_t y, uint16_t w, uint16_t h, std::span<const uint8_t> pixels) override;
    bool has_backlight() const override { return true; }
    fr::Status set_backlight(uint8_t level) override
    {
        backlight_ = level;
        return {};
    }
    fr::hal::Selftest selftest() override;

    std::span<const uint8_t> glass() const { return fb_; }
    size_t flushes() const { return flushes_; }
    uint8_t backlight() const { return backlight_; }

private:
    uint16_t native_w_;
    uint16_t native_h_;
    fr::hal::PixelFormat format_;
    fr::hal::Rotation rotation_ = fr::hal::Rotation::r0;
    std::vector<uint8_t> fb_;
    size_t flushes_ = 0;
    uint8_t backlight_ = 0;
};

/** No controller: touches come from the script (inject, or raw points straight into the backend). */
class HostTouch final : public fr::hal::TouchSource
{
public:
    fr::Status init(fr::Core &core, fr::hal::TouchSink &sink) override;
    fr::Status poll() override { return {}; }
    fr::hal::Selftest selftest() override;
};

/** A ui event as the renderer prints it. */
struct UiEvent {
    std::string id;
    fr::cap::DisplayUiEventKind kind;
    int32_t value;
};

/** A command the device would have refused (busy, not_found, unsupported...): the render goes on. */
struct LineError {
    size_t line;
    std::string cmd;
    std::string error;
};

class Session final : private fr::cap::Sink
{
public:
    static constexpr uint8_t kDisplayPort = 1;
    static constexpr uint8_t kTouchPort = 2;
    /** The virtual clock's step: LVGL's timers and the core's run in lockstep at this grain. */
    static constexpr uint32_t kStepMs = 5;

    explicit Session(const Geometry &g);
    ~Session();
    Session(const Session &) = delete;
    Session &operator=(const Session &) = delete;

    /** Brings the panel, its backend and both services up (DisplayService::init: a black first frame). */
    std::expected<void, std::string> start();

    /**
     * One script line, `{"cmd": ..., "args": {...}}` (README.md): fr.display commands through the generated JSON codec
     * and dispatch, as the board takes them; touch {x, y, pressed} straight into the backend's pointer, or touch
     * {x, y[, gesture]} as fr.touch inject. A line that is not such a command is the unexpected; what the device
     * would refuse is recorded in errors() and the script goes on. Then lets the clock run until nothing is pending.
     */
    std::expected<void, std::string> run_line(std::string_view json, size_t line);

    /** A raw pointer point (panel coordinates): what TouchService hands DisplayService. */
    void touch(uint16_t x, uint16_t y, bool pressed);
    /** Moves both clocks by `ms`, in kStepMs steps. */
    void advance(uint32_t ms);
    /** Runs the clock until no core timer is pending (an injected touch, a mono flush), at most `max_ms`. */
    void settle(uint32_t max_ms = 5000);

    /** The backend's snapshot (every command rendered), which also freezes the frame frame() reads. */
    std::expected<fr::display::Snapshot, fr::Err> snapshot();
    /** The frozen frame, read through snapshot_read in chunks as an agent would. */
    std::vector<uint8_t> frame();

    const std::vector<UiEvent> &events() const { return events_; }
    const std::vector<LineError> &errors() const { return errors_; }
    const Geometry &geometry() const { return geo_; }
    HostPanel &panel() { return panel_; }
    fr::display::Backend &backend() { return *backend_; }
    /** The LVGL backend, or nullptr on a mono panel. */
    fr::ui::LvglBackend *lvgl() { return lvgl_; }

private:
    void event(uint8_t port, uint8_t event_id, fr::cap::Priority prio, std::span<const uint8_t> fields, fr::TimeUs at,
               bool ordered) override;
    void property(uint8_t port, uint8_t prop_id, std::span<const uint8_t> value, fr::TimeUs at) override;

    Geometry geo_;
    HostCore core_;
    HostPanel panel_;
    std::unique_ptr<HostEpaper> epd_;  // an e-paper panel (geo_.epaper): the service's panel instead of panel_
    std::vector<uint8_t> frame_buf_, shown_buf_, frozen_buf_;
    HostTouch touch_src_;
    std::unique_ptr<fr::display::Backend> backend_;
    fr::ui::LvglBackend *lvgl_ = nullptr;
    std::unique_ptr<fr::DisplayService> display_;
    std::unique_ptr<fr::TouchService> touch_;
    std::vector<UiEvent> events_;
    std::vector<LineError> errors_;
};

/** fr.display's ui event kind as the schema names it. */
const char *kind_name(fr::cap::DisplayUiEventKind k);

}  // namespace frd
