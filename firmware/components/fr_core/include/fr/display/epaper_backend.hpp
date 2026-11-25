// An e-paper panel's renderer (design epaper-e1 D3, D6): two 1-bit frames, what has been drawn (`frame`) and what the
// glass shows (`shown`), and the policy that turns the difference into refreshes. IDF-free: the host suite and the
// desktop renderer (tools/display) build the same file, with a fake hal::Epaper.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

#include "fr/display/backend.hpp"
#include "fr/display/mono_canvas.hpp"
#include "fr/hal/epaper.hpp"

namespace fr::display {

/**
 * fr.display on an e-paper panel (trait epaper).
 *
 * Drawing (clear, text, fill_rect, bitmap; MonoCanvas's) only touches `frame`. A refresh sends the rectangle where
 * `frame` differs from `shown`, widened to whole bytes of the panel's native rows, and copies each byte into `shown` as
 * it goes out, so `shown` is always what the controller holds even when a command lands between chunks.
 *
 * When: settle_ms after the last drawing command; at once on refresh(); never during a hold(); never while a refresh
 * runs, and at least flush_ms after the last one started. At most one refresh waits; it takes the strongest mode
 * asked (full > fast > partial > auto).
 *
 * Which mode (resolve()): auto is partial, or full while the glass is not known (after boot, after a failure), or the
 * `clean` mode (full or fast) once `partials` reached full_every. An explicit partial runs past the budget (but full
 * while the glass is not known). auto and partial with nothing changed do nothing; fast and full redraw the whole
 * screen. Every clean_hours a clean refresh of the same picture (once the glass is known).
 *
 * The controller's RAMs: before a partial both are written over the change and the last partial's change (stale_, or
 * everything after a reset), `prev` with the old picture and `next` with the new one: the SSD1683 on the Waveshare 4.2"
 * V2 trades its RAMs after a partial (design face-f1 D20), so either may hold the picture from before the last change
 * there. A fast or full refresh writes `next`, then `prev`, both whole. After a reset or a deep sleep both are rewritten
 * whole before the next partial.
 *
 * Power: after a partial the high voltage stays on for burst_ms (Op::partial_hold), then goes off (Op::power_off);
 * fast and full turn it off themselves. sleep_s without a refresh puts the controller to deep sleep; the next refresh
 * wakes it: the reset line low for 2 ms, 10 ms, the software reset, configure().
 *
 * A step whose BUSY does not fall within the panel's timeout_us fails: `refreshed {ok: false}`, the controller is reset
 * before the next step, and after a failed write or refresh the glass is not known (the next refresh is full). Nothing
 * retries by itself: the next drawing command or refresh() does.
 *
 * Everything runs on the core task: drawing in dispatch, the writes kChunk bytes per firing of the one timer codegen
 * budgets for fr.display, and BUSY's fall posted by the driver (hal::Epaper::on_idle).
 */
class EpaperBackend final : public Backend
{
public:
    /**
     * The frames, each at least MonoCanvas::stride_of(width) * height bytes in the rotated geometry (static in the
     * generated glue). `frozen` is the frame snapshot() freezes; empty where the build has no test hooks.
     */
    struct Buffers {
        std::span<uint8_t> frame;
        std::span<uint8_t> shown;
        std::span<uint8_t> frozen;
    };

    /** Panel bytes written per timer firing (0.8 ms at 10 MHz). */
    static constexpr size_t kChunk = 1024;
    /** The reset pulse and the wait after it. */
    static constexpr uint32_t kResetLowUs = 2'000;
    static constexpr uint32_t kResetWaitUs = 10'000;
    /** The longest the timer is armed for an idle deadline; it re-arms from there. */
    static constexpr uint32_t kMaxArmUs = 3'600'000'000u;

    enum class Phase : uint8_t { idle, asleep, reset_low, reset_high, soft_reset, writing, refreshing, powering_off };

    struct Counters {
        uint32_t full = 0, fast = 0, partial = 0;  // refreshes that ended
        uint32_t failed = 0;                       // steps that failed (BUSY timeouts, refused writes)
        uint32_t wakes = 0, sleeps = 0;
        uint32_t late_idle = 0;                    // BUSY's fall seen at the timeout, not by its edge
    };

    EpaperBackend(hal::Epaper &panel, Buffers buffers) : panel_(panel), buf_(buffers) {}

    /** `panel` is the hal::Epaper given to the constructor. The frame starts white; boot_clear asks a full refresh. */
    Status init(hal::Display &panel, const cap::DisplayConfig &cfg, Core &core, UiEventSink sink) override;
    Status clear(uint32_t rgb) override;
    Status text(const cap::DisplayTextArgs &a) override;
    Status fill_rect(const cap::DisplayFillRectArgs &a) override;
    Status bitmap(const cap::DisplayBitmapArgs &a) override;
    Status paint(const Box &box, PaintFn fn) override;
    bool epaper() const override { return true; }
    void set_refresh_sink(RefreshSink sink) override { sink_ = sink; }
    std::expected<cap::DisplayRefreshResult, Err> refresh(cap::DisplayRefreshMode mode) override;
    Status hold(uint16_t ms) override;
    uint8_t partials() const override { return partials_; }
    uint32_t shown_crc() const override { return glass_known_ ? shown_crc_ : 0; }
    uint16_t refresh_ms() const override { return refresh_ms_; }
    std::expected<Snapshot, Err> snapshot() override;
    std::expected<size_t, Err> snapshot_read(uint32_t offset, std::span<uint8_t> out) override;

    // For tests, the desktop renderer and the driver's selftest detail.
    const MonoCanvas &frame() const { return frame_; }
    const MonoCanvas &shown() const { return shown_; }
    Phase phase() const { return phase_; }
    bool glass_known() const { return glass_known_; }
    bool high_voltage() const { return hv_on_; }
    const Counters &counters() const { return counters_; }
    /** Nothing waits to be shown: no refresh running or asked, no drawing waiting for one. */
    bool settled() const;

    // Power save (design face-f1 D15): the face deep-sleeps the chip between redraws.
    /** What crosses a deep sleep besides the glass: the ghost budget. */
    struct Carry {
        uint8_t partials = 0;
        uint32_t clean_age_s = 0;  // since the last clean refresh
    };
    Carry carry() const;
    /**
     * After a deep-sleep wake, before anything is drawn: `glass` (what the glass shows, kept by the caller across the
     * sleep) becomes the frame and `shown`; the glass is known again, the controller's RAM is not (its reset lost it),
     * so the next partial writes both planes. Err::invalid_args for a size that is not the frame's.
     */
    Status adopt_glass(std::span<const uint8_t> glass, const Carry &c);
    /** The high voltage off and the controller asleep as soon as nothing waits (no burst, no sleep_s). */
    void set_sleep_soon(bool on);
    /** Called each time the controller goes to sleep (Phase::asleep). */
    void set_asleep_hook(Callback<void(), 16> hook) { asleep_hook_ = hook; }

private:
    enum class Rank : uint8_t { none = 0, auto_ = 1, partial = 2, fast = 3, full = 4 };
    struct Job {
        hal::Epaper::Plane plane = hal::Epaper::Plane::next;
        Box win;  // native pixels, whole bytes
        bool from_frame = false;  // else from shown; from_frame copies into shown as it goes
    };

    static Rank rank_of(cap::DisplayRefreshMode m);
    cap::DisplayRefreshMode resolve(Rank r) const;
    cap::DisplayRefreshMode clean_mode() const;

    void drew(const Box &b);
    void kick();
    void arm(TimeUs now);
    void on_timer();
    void on_idle(TimeUs at);
    void begin_wake();
    bool begin_refresh();
    void begin_job();
    void write_chunk();
    void start_op(hal::Epaper::Op op, Phase phase);
    void finish_refresh(TimeUs at);
    void fail();
    void report(bool ok, uint16_t ms);

    /** Where `frame` differs from `shown`, in the rotated geometry. */
    Box diff() const;
    /** A rotated box as the panel's native box, widened to whole bytes. */
    Box to_native(const Box &b) const;
    Box to_logical(const Box &n) const;
    void native_of(int lx, int ly, int &nx, int &ny) const;
    void logical_of(int nx, int ny, int &lx, int &ly) const;
    Box native_all() const { return {0, 0, panel_.native_width() - 1, panel_.native_height() - 1}; }

    hal::Epaper &panel_;
    Buffers buf_;
    MonoCanvas frame_;
    MonoCanvas shown_;
    cap::DisplayConfig cfg_{};
    Core *core_ = nullptr;
    Timer *timer_ = nullptr;
    RefreshSink sink_;
    Callback<void(), 16> asleep_hook_;
    bool sleep_soon_ = false;
    hal::Rotation rot_ = hal::Rotation::r0;

    Phase phase_ = Phase::idle;
    bool awake_ = false;        // the controller answered its last reset and is not asleep
    bool hv_on_ = false;        // the high voltage is on (after a partial_hold)
    bool glass_known_ = false;  // `shown` is what the glass shows
    bool ram_synced_ = false;   // both RAMs hold `shown`, except inside stale_ (one of them, either)
    bool dirty_ = false;        // drawn since the last refresh was asked or began
    bool started_once_ = false;
    bool wake_for_refresh_ = false;  // the reset running was started for a refresh (its failure is reported)
    Rank pending_ = Rank::none;
    cap::DisplayRefreshMode mode_ = cap::DisplayRefreshMode::full;  // the refresh running (or failing)
    hal::Epaper::Op op_ = hal::Epaper::Op::full;
    // native: the last partial's change. One RAM still holds the picture from before it there: `prev` on a controller
    // that keeps its RAMs, the next refresh's `next` on one whose RAMs trade places after a partial (the SSD1683 on
    // the Waveshare 4.2" V2, design face-f1 §17). Both planes are written over it and the new change.
    Box stale_;
    Box changed_;     // native: the area the refresh running changes
    Box moved_;       // native: where the `next` plane written differs from `shown` before it (a drawing between chunks
                      // can move pixels outside changed_); the refresh's stale_ once it ends

    std::array<Job, 2> jobs_{};
    uint8_t njobs_ = 0;
    uint8_t job_ = 0;
    int row_ = 0;

    TimeUs last_draw_ = 0;
    TimeUs hold_until_ = 0;
    TimeUs last_start_ = 0;
    TimeUs last_end_ = 0;     // the last refresh's end
    TimeUs last_active_ = 0;  // the controller's last step (for sleep_s)
    TimeUs last_clean_ = 0;   // the last fast or full refresh, or boot
    TimeUs op_started_ = 0;

    uint8_t partials_ = 0;
    uint16_t refresh_ms_ = 0;
    uint32_t shown_crc_ = 0;
    Counters counters_;
    uint32_t frozen_bytes_ = 0;
    bool has_frozen_ = false;
    uint8_t chunk_[kChunk] = {};
};

}  // namespace fr::display
