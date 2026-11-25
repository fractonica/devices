// fr:realtime
#include "fr/display/mono_canvas.hpp"

#include <algorithm>

namespace fr::display {

void Box::add(const Box &b)
{
    if (b.empty()) {
        return;
    }
    if (empty()) {
        *this = b;
        return;
    }
    x0 = std::min(x0, b.x0);
    y0 = std::min(y0, b.y0);
    x1 = std::max(x1, b.x1);
    y1 = std::max(y1, b.y1);
}

void MonoCanvas::attach(std::span<uint8_t> buf, uint16_t w, uint16_t h)
{
    buf_ = buf.size() >= stride_of(w) * h ? buf.data() : nullptr;
    w_ = buf_ != nullptr ? w : 0;
    h_ = buf_ != nullptr ? h : 0;
}

bool MonoCanvas::pixel(int x, int y) const
{
    if (x < 0 || y < 0 || x >= w_ || y >= h_) {
        return false;
    }
    return ((buf_[static_cast<size_t>(y) * stride() + static_cast<size_t>(x) / 8] >> (7 - x % 8)) & 1u) != 0;
}

Box MonoCanvas::fill(int x, int y, int w, int h, bool on)
{
    const int x0 = std::max(x, 0);
    const int y0 = std::max(y, 0);
    const int x1 = std::min(x + w, static_cast<int>(w_)) - 1;
    const int y1 = std::min(y + h, static_cast<int>(h_)) - 1;
    if (x0 > x1 || y0 > y1) {
        return {};
    }
    for (int yy = y0; yy <= y1; ++yy) {
        for (int xx = x0; xx <= x1; ++xx) {
            set(xx, yy, on);
        }
    }
    return {x0, y0, x1, y1};
}

Box MonoCanvas::text(const cap::DisplayTextArgs &a)
{
    const int s = std::clamp<int>(a.size, 1, 4);
    const bool fg = mono_lit(a.color);
    const bool bg = mono_lit(a.bg);
    Box touched;
    int cx = a.x;
    for (char ch : a.text) {
        if (cx >= w_) {
            break;  // the rest is off the right edge
        }
        const auto u = static_cast<uint8_t>(ch);
        if (u >= 0x80 && u <= 0xBF) {
            continue;  // a UTF-8 continuation byte: its lead byte drew the '?'
        }
        const auto g = glyph(u >= 0x80 ? '?' : ch);
        touched.add(fill(cx, a.y, kCellW * s, kCellH * s, bg));
        if (fg != bg) {
            for (int col = 0; col < kGlyphW; ++col) {
                for (int row = 0; row < kGlyphH; ++row) {
                    if (((g[col] >> row) & 1u) != 0) {
                        fill(cx + col * s, a.y + row * s, s, s, fg);
                    }
                }
            }
        }
        cx += kCellW * s;
    }
    return touched;
}

std::expected<Box, Err> MonoCanvas::bitmap(const cap::DisplayBitmapArgs &a)
{
    const size_t in_stride = stride_of(a.w);
    if (a.data.size() != in_stride * a.h) {
        return std::unexpected(Err::invalid_args);
    }
    const bool one = mono_lit(a.color);
    const bool zero = mono_lit(a.bg);
    const int x0 = std::max<int>(a.x, 0);
    const int y0 = std::max<int>(a.y, 0);
    const int x1 = std::min<int>(a.x + a.w, w_) - 1;
    const int y1 = std::min<int>(a.y + a.h, h_) - 1;
    if (x0 > x1 || y0 > y1) {
        return Box{};
    }
    for (int yy = y0; yy <= y1; ++yy) {
        const uint8_t *row = a.data.data() + static_cast<size_t>(yy - a.y) * in_stride;
        for (int xx = x0; xx <= x1; ++xx) {
            const int c = xx - a.x;
            const bool bit = ((row[c / 8] >> (7 - c % 8)) & 1u) != 0;
            set(xx, yy, bit ? one : zero);
        }
    }
    return Box{x0, y0, x1, y1};
}

}  // namespace fr::display
