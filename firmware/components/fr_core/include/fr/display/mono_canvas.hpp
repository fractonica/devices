// The 1-bit drawing every mono panel shares (design m2-c5-display D3, epaper-e1 D6): MonoBackend (the C3 OLED) and
// EpaperBackend draw through it. It owns no memory: the caller hands it a buffer in the snapshot layout of
// fr/display/backend.hpp (rows of ceil(width / 8) bytes, MSB first, a lit pixel 1). IDF-free; the host suite and the
// desktop renderer build the same file.
#pragma once

#include <cstddef>
#include <cstdint>
#include <expected>
#include <span>

#include "display.hpp"  // generated fr::cap::Display* types
#include "fr/base.hpp"

namespace fr::display {

/** Whether a mono panel lights a pixel of colour `rgb` (0xRRGGBB): Rec. 601 luma at least 50 %. */
constexpr bool mono_lit(uint32_t rgb)
{
    const uint32_t r = (rgb >> 16) & 0xFF;
    const uint32_t g = (rgb >> 8) & 0xFF;
    const uint32_t b = rgb & 0xFF;
    return 299 * r + 587 * g + 114 * b >= 127'500;  // x1000: 0.5 * 255
}

/** The built-in font: 5x7 glyphs for 0x20..0x7E, one byte per column, bit 0 the top row. */
inline constexpr int kGlyphW = 5;
inline constexpr int kGlyphH = 7;
/** A character cell at size 1: the glyph plus one blank column and one blank row. */
inline constexpr int kCellW = 6;
inline constexpr int kCellH = 8;
/** The glyph for `c`; '?' for anything outside 0x20..0x7E. */
std::span<const uint8_t, kGlyphW> glyph(char c);

/** A rectangle of pixels, both corners included; empty while x0 > x1 or y0 > y1. */
struct Box {
    int x0 = 1, y0 = 1, x1 = 0, y1 = 0;

    bool empty() const { return x0 > x1 || y0 > y1; }
    int w() const { return empty() ? 0 : x1 - x0 + 1; }
    int h() const { return empty() ? 0 : y1 - y0 + 1; }
    /** Grows to cover `b` too. */
    void add(const Box &b);
    bool operator==(const Box &) const = default;
};

/**
 * fr.display's primitives on a 1-bit buffer. Every drawing call clips to the canvas and answers the box it touched
 * (empty when nothing was on the canvas), so a backend knows what to flush or refresh.
 *
 * Text: each character is a cell of 6 x 8 pixels times `size` (the 5x7 glyph, one blank column on the right, one
 * blank row at the bottom), left to right from (x, y) with no wrapping; glyph pixels take `color`, the rest of the cell
 * `bg`. Bytes outside 0x20..0x7E draw '?', except UTF-8 continuation bytes (0x80..0xBF), which draw nothing, so one
 * multi-byte character is one '?'. Colours go through mono_lit(). Padding bits past the last column stay as they are
 * (0 in a buffer that started cleared).
 */
class MonoCanvas
{
public:
    static constexpr size_t stride_of(uint16_t w) { return (static_cast<size_t>(w) + 7u) / 8u; }

    /** Draws into `buf` (at least stride_of(w) * h bytes), which it does not clear. */
    void attach(std::span<uint8_t> buf, uint16_t w, uint16_t h);

    uint16_t width() const { return w_; }
    uint16_t height() const { return h_; }
    size_t stride() const { return stride_of(w_); }
    size_t bytes() const { return stride() * h_; }
    std::span<const uint8_t> pixels() const { return {buf_, bytes()}; }
    std::span<uint8_t> pixels() { return {buf_, bytes()}; }

    /** False outside the canvas. */
    bool pixel(int x, int y) const;
    /** One pixel; (x, y) must be on the canvas. */
    void set(int x, int y, bool on)
    {
        uint8_t &b = buf_[static_cast<size_t>(y) * stride() + static_cast<size_t>(x) / 8];
        const auto bit = static_cast<uint8_t>(0x80u >> (x % 8));
        b = on ? static_cast<uint8_t>(b | bit) : static_cast<uint8_t>(b & ~bit);
    }

    /** The clipped rectangle (x, y, w, h) set to `on`. */
    Box fill(int x, int y, int w, int h, bool on);
    Box text(const cap::DisplayTextArgs &a);
    /** fr.display bitmap: Err::invalid_args when data is not exactly ceil(w / 8) * h bytes. */
    std::expected<Box, Err> bitmap(const cap::DisplayBitmapArgs &a);

private:
    uint8_t *buf_ = nullptr;
    uint16_t w_ = 0;
    uint16_t h_ = 0;
};

}  // namespace fr::display
