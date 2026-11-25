// fr:realtime
#include "fr/display/mono_backend.hpp"

#include <algorithm>
#include <cstring>

namespace fr::display {

Status MonoBackend::init(hal::Display &panel, const cap::DisplayConfig &cfg, Core &core, UiEventSink sink)
{
    static_cast<void>(sink);  // no widgets, so no ui events
    if (panel.format() != hal::PixelFormat::mono1) {
        return std::unexpected(Err::invalid_args);
    }
    const uint16_t w = panel.width();
    const uint16_t h = panel.height();
    if (w == 0 || h == 0 || w > kMaxWidth || h > kMaxHeight) {
        return std::unexpected(Err::unsupported);
    }
    timer_ = core.timer([this] { flush_page(); });
    if (timer_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    panel_ = &panel;
    core_ = &core;
    w_ = w;
    h_ = h;
    flush_us_ = static_cast<uint32_t>(cfg.flush_ms) * 1000u;
    std::memset(fb_, 0, sizeof(fb_));
    canvas_.attach(fb_, w_, h_);
    // The panel came up black; flushing the whole screen once makes sure of it.
    mark({0, 0, w_ - 1, h_ - 1});
    return {};
}

Status MonoBackend::clear(uint32_t rgb)
{
    if (panel_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    mark(canvas_.fill(0, 0, w_, h_, mono_lit(rgb)));
    return {};
}

Status MonoBackend::fill_rect(const cap::DisplayFillRectArgs &a)
{
    if (panel_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    mark(canvas_.fill(a.x, a.y, a.w, a.h, mono_lit(a.color)));
    return {};
}

Status MonoBackend::bitmap(const cap::DisplayBitmapArgs &a)
{
    if (panel_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const auto box = canvas_.bitmap(a);
    if (!box) {
        return std::unexpected(box.error());
    }
    mark(*box);
    return {};
}

Status MonoBackend::text(const cap::DisplayTextArgs &a)
{
    if (panel_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    mark(canvas_.text(a));
    return {};
}

std::expected<Snapshot, Err> MonoBackend::snapshot()
{
    if (panel_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const size_t n = bytes();
    std::memcpy(frozen_, fb_, n);
    frozen_bytes_ = static_cast<uint32_t>(n);
    has_frozen_ = true;
    return Snapshot{.crc = crc32({frozen_, n}),
                    .width = w_,
                    .height = h_,
                    .format = cap::DisplayColorFormat::mono1,
                    .bytes = frozen_bytes_};
}

std::expected<size_t, Err> MonoBackend::snapshot_read(uint32_t offset, std::span<uint8_t> out)
{
    if (!has_frozen_) {
        return std::unexpected(Err::failed);
    }
    if (offset > frozen_bytes_) {
        return std::unexpected(Err::invalid_args);
    }
    const size_t n = std::min<size_t>(out.size(), frozen_bytes_ - offset);
    std::memcpy(out.data(), frozen_ + offset, n);
    return n;
}

void MonoBackend::mark(const Box &b)
{
    if (b.empty()) {
        return;
    }
    dirty_.add(b);
    schedule();
}

void MonoBackend::schedule()
{
    if (timer_ == nullptr || timer_->running() || !dirty()) {
        return;
    }
    const TimeUs now = core_->now();
    const TimeUs due = flushed_once_ ? last_flush_ + flush_us_ : now;
    timer_->start(due > now ? static_cast<uint32_t>(due - now) : 0);
}

void MonoBackend::flush_page()
{
    if (!dirty()) {
        return;
    }
    // A flush begins with the first page of a dirty rectangle; the coalescing period counts from there.
    if (!flushing_) {
        flushing_ = true;
        flushed_once_ = true;
        last_flush_ = core_->now();
    }
    const int r0 = dirty_.y0 / 8 * 8;
    const int r1 = std::min(r0 + 8, static_cast<int>(h_)) - 1;
    const int x0 = dirty_.x0;
    const int x1 = dirty_.x1;
    const int w = x1 - x0 + 1;
    const int rows = r1 - r0 + 1;
    const size_t out_stride = (static_cast<size_t>(w) + 7u) / 8u;
    uint8_t area[kMaxWidth / 8 * 8] = {};
    for (int r = 0; r < rows; ++r) {
        for (int c = 0; c < w; ++c) {
            if (pixel(x0 + c, r0 + r)) {
                area[static_cast<size_t>(r) * out_stride + static_cast<size_t>(c) / 8] |=
                    static_cast<uint8_t>(0x80u >> (c % 8));
            }
        }
    }
    if (!panel_->flush(static_cast<uint16_t>(x0), static_cast<uint16_t>(r0), static_cast<uint16_t>(w),
                       static_cast<uint16_t>(rows), {area, out_stride * static_cast<size_t>(rows)})) {
        ++flush_errors_;  // dropped: the next change of this area sends it again
    }
    if (r1 >= dirty_.y1) {
        dirty_ = {};
        flushing_ = false;
        return;
    }
    dirty_.y0 = r1 + 1;
    timer_->start(0);  // the next page after the core task's other work
}

}  // namespace fr::display
