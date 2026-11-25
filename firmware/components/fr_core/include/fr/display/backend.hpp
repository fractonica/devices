// The renderer behind fr.display (design m2-c5-display D3): DisplayService (fr/services/display_service.hpp) decodes
// and answers the commands, a Backend draws them. Two exist, chosen by codegen from the driver's `traits: ui`:
// fr::display::MonoBackend (fr_core, the C3 OLED's 1-bit renderer) and fr::ui::LvglBackend (fr_ui, LVGL on its own
// task). Both compile on the Mac unchanged, and for the same command sequence their framebuffers are byte-identical to
// the desktop renderer's (T-DISPLAY compares the CRCs).
//
// Threading. Every method except touch() and the UiEventSink is called on the core task, inside fr.display dispatch,
// and must not draw on the panel there (the row rule): MonoBackend draws into its RAM framebuffer at once and flushes
// from a core timer; LvglBackend copies the command into its queue and returns. touch() may come from any task (today
// the core task: TouchService). The UiEventSink may be called from any task: DisplayService copies the event and posts
// it to the core task before it reaches emit_ui.
//
// Lifetimes. Every string_view in the command arguments (text, layout ids and texts, ui_set id and text) points into
// the request frame, which is gone when the call returns: a backend that keeps or queues them copies them first.
//
// The framebuffer as snapshot() hashes it and snapshot_read() returns it (the desktop renderer writes the same bytes):
//   mono1:  row-major from the top-left pixel, 1 bit per pixel, MSB first (bit 7 of byte 0 is pixel (0, 0)); each row
//           starts on a byte boundary (ceil(width / 8) bytes per row, padding bits 0); a lit pixel is 1.
//           bytes = ceil(width / 8) * height.
//   rgb565: row-major from the top-left pixel, 2 bytes per pixel, the u16 0bRRRRRGGGGGGBBBBB little-endian (low byte
//           first). bytes = width * height * 2.
// Both in the panel's geometry after rotation (width x height as the fr.display traits report it). crc is CRC-32/
// ISO-HDLC (zlib's crc32: polynomial 0x04C11DB7 reflected, init and xorout 0xFFFFFFFF) over those `bytes` bytes.
#pragma once

#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

#include "display.hpp"  // generated fr::cap::Display* types
#include "fr/base.hpp"
#include "fr/core/core.hpp"
#include "fr/display/mono_canvas.hpp"
#include "fr/hal/display.hpp"

namespace fr::display {

/** What snapshot() reports: the framebuffer's CRC-32 and size, in the layout above. */
struct Snapshot {
    uint32_t crc;
    uint16_t width, height;
    cap::DisplayColorFormat format;
    uint32_t bytes;
};

/**
 * Where a backend delivers fr.display `ui` events (an LVGL widget clicked, a slider moved). fr::Callback, not
 * std::function: no heap in fr_core; DisplayService's is a single `this` capture. Any task; the event (its id
 * included) is only borrowed for the call.
 */
using UiEventSink = Callback<void(const cap::DisplayUi &), 16>;

/**
 * Where an e-paper backend reports each refresh as it ends (design epaper-e1 D2): DisplayService emits `refreshed` and
 * reports the properties that changed. Core task.
 */
using RefreshSink = Callback<void(const cap::DisplayRefreshed &), 16>;
/** Draws into a 1-bit frame within `box` (design face-f1 D7: the clock face); the canvas is only borrowed. */
using PaintFn = Callback<void(MonoCanvas &canvas, const Box &box), 16>;

class Backend
{
public:
    virtual ~Backend() = default;

    /**
     * Once, on the core task, after the panel's init(): geometry and format come from `panel` (width() and height()
     * after rotation, format()); `cfg` gives flush_ms (and the rotation the panel already applied). The backend
     * takes what it needs from `core` here (MonoBackend: its flush timer, the one codegen budgets for fr.display).
     * Starts with a black screen, flushed to the panel.
     */
    virtual Status init(hal::Display &panel, const cap::DisplayConfig &cfg, Core &core, UiEventSink sink) = 0;
    /** Whether ui_load and ui_set work (fr.display trait ui): LvglBackend true. Valid before init(). */
    virtual bool ui() const { return false; }

    /** Drops every primitive and any layout, then fills the screen with `rgb` (0xRRGGBB). */
    virtual Status clear(uint32_t rgb) = 0;
    /** A text primitive, clipped to the screen (args as the fr.display text command, already valid()). */
    virtual Status text(const cap::DisplayTextArgs &a) = 0;
    /** A filled rectangle, clipped to the screen. */
    virtual Status fill_rect(const cap::DisplayFillRectArgs &a) = 0;
    /** Replaces the screen with the layout; answers the widgets created. Only LVGL backends (trait ui). */
    virtual std::expected<uint8_t, Err> ui_load(const cap::DisplayUiLayout &l)
    {
        static_cast<void>(l);
        return std::unexpected(Err::unsupported);
    }
    /** Updates one widget; Err::not_found for an unknown id. Only LVGL backends (trait ui). */
    virtual Status ui_set(const cap::DisplayUiSetArgs &a)
    {
        static_cast<void>(a);
        return std::unexpected(Err::unsupported);
    }
    /** fr.display bitmap (args valid()): mono backends draw it; LVGL answers UNSUPPORTED (design epaper-e1 D2). */
    virtual Status bitmap(const cap::DisplayBitmapArgs &a)
    {
        static_cast<void>(a);
        return std::unexpected(Err::unsupported);
    }

    /**
     * Design face-f1 D7: a drawer on the node (the clock face) paints into the 1-bit frame within `box` (clipped to
     * the screen), which the backend then treats as drawn. Backends with a 1-bit frame; others answer UNSUPPORTED.
     */
    virtual Status paint(const Box &box, PaintFn fn)
    {
        static_cast<void>(box);
        static_cast<void>(fn);
        return std::unexpected(Err::unsupported);
    }

    // E-paper (fr.display trait epaper; design epaper-e1 D2-D3). Other backends answer UNSUPPORTED and report 0.
    /** Whether this is an e-paper backend (fr.display trait epaper). Valid before init(). */
    virtual bool epaper() const { return false; }
    /** Before init(): where each refresh is reported. */
    virtual void set_refresh_sink(RefreshSink sink) { static_cast<void>(sink); }
    /** fr.display refresh: the mode that will run and whether the frame differs from the glass. */
    virtual std::expected<cap::DisplayRefreshResult, Err> refresh(cap::DisplayRefreshMode mode)
    {
        static_cast<void>(mode);
        return std::unexpected(Err::unsupported);
    }
    /** fr.display hold: no automatic refresh for `ms` (0 releases). */
    virtual Status hold(uint16_t ms)
    {
        static_cast<void>(ms);
        return std::unexpected(Err::unsupported);
    }
    /** The e-paper properties: partials since the last clean, CRC of the glass (0 unknown), the last refresh's ms. */
    virtual uint8_t partials() const { return 0; }
    virtual uint32_t shown_crc() const { return 0; }
    virtual uint16_t refresh_ms() const { return 0; }

    /**
     * A touch at (x, y) in the panel's coordinates (after rotation), from TouchService through DisplayService, any
     * task: the backend queues it (LVGL: its pointer input). pressed false is the release at the last position.
     */
    virtual void touch(uint16_t x, uint16_t y, bool pressed)
    {
        static_cast<void>(x);
        static_cast<void>(y);
        static_cast<void>(pressed);
    }

    /**
     * The framebuffer as drawn, after every command accepted so far has been rendered (an LVGL backend waits for its
     * queue to drain): CRC and size, in the layout above. It also freezes that frame for snapshot_read, so the chunks
     * an agent reads next all come from one frame even while drawing goes on.
     */
    virtual std::expected<Snapshot, Err> snapshot() = 0;
    /**
     * Copies up to out.size() bytes of the frame the last snapshot() froze, from `offset`; answers how many (0 at the
     * end). Err::invalid_args past the end; Err::failed (or the backend's choice) before any snapshot().
     */
    virtual std::expected<size_t, Err> snapshot_read(uint32_t offset, std::span<uint8_t> out) = 0;
};

/** CRC-32/ISO-HDLC (zlib crc32), continued from `crc` (0 to start): the snapshot CRC. */
uint32_t crc32(std::span<const uint8_t> data, uint32_t crc = 0);

}  // namespace fr::display
