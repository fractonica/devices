// ssd1683_spi (design epaper-e1 D5; spec 07 §7.8): hal::Epaper on an SSD1683 black-and-white e-paper controller over
// 4-line SPI, wired to free pins (bind: { sclk, mosi, cs, dc, rst, busy }). First on the Waveshare 4.2inch e-Paper
// Module V2 (400 x 300; its BS resistor at 0). Drawn by fr_core's EpaperBackend (driver.yaml traits epaper).
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <span>

#include "fr/core/core.hpp"
#include "fr/hal/epaper.hpp"

struct spi_device_t;

namespace fr::drv {

/**
 * The SSD1683's commands as this driver sends them: pure, so the host suite checks them against the design's §0
 * (Waveshare's EPD_4in2_V2 code with its X-cursor bug fixed, the datasheet, GxEPD2's GDEY042T81 driver).
 */
namespace ssd1683 {

inline constexpr uint8_t kDeepSleep = 0x10;   // A: 0x01 deep sleep 1 (RAM kept)
inline constexpr uint8_t kDataEntry = 0x11;   // A: 0x03 X then Y increasing, the counter moving along X
inline constexpr uint8_t kSwReset = 0x12;     // BUSY high until done
inline constexpr uint8_t kTempWrite = 0x1A;   // the temperature register, °C (two's complement)
inline constexpr uint8_t kActivate = 0x20;    // run the 0x22 sequence; BUSY high until done
inline constexpr uint8_t kUpdate1 = 0x21;     // RAM options: A[7:4] red (prev), A[3:0] black/white (next)
inline constexpr uint8_t kUpdate2 = 0x22;     // the update sequence 0x20 runs
inline constexpr uint8_t kWriteNext = 0x24;   // write RAM: the picture to show (black/white RAM)
inline constexpr uint8_t kWritePrev = 0x26;   // write RAM: the picture shown (red RAM, the old image in B/W mode)
inline constexpr uint8_t kBorder = 0x3C;      // border waveform
inline constexpr uint8_t kRamX = 0x44;        // X start, end, in bytes (8 pixels)
inline constexpr uint8_t kRamY = 0x45;        // Y start, end: low, high, low, high
inline constexpr uint8_t kCursorX = 0x4E;     // in bytes
inline constexpr uint8_t kCursorY = 0x4F;     // low, high

/** 0x22 values (the datasheet's table; bits: 7 clock on, 6 analog on, 5 load temperature, 4 load waveform, 3 B/W
 *  mode 2, 2 display, 1 analog off, 0 clock off). */
inline constexpr uint8_t kSeqFull = 0xF7;         // temperature, waveform, display (mode 1), all off after
inline constexpr uint8_t kSeqFast = 0xD7;         // waveform for the written temperature, display, all off after
inline constexpr uint8_t kSeqPartial = 0xFF;      // temperature, waveform, display (mode 2: compares the RAMs), off after
inline constexpr uint8_t kSeqPartialHold = 0xFC;  // the same, the clock and the high voltage left on (GxEPD2)
inline constexpr uint8_t kSeqPowerOff = 0x83;     // analog and clock off (GxEPD2)

/** The temperatures the fast waveform is picked for: 1.5 s and 1 s (Waveshare's Init_Fast). */
inline constexpr uint8_t kFastTemp1500 = 0x6E;  // 110 °C
inline constexpr uint8_t kFastTemp1000 = 0x5A;  // 90 °C

/** One command and its parameters. */
struct Cmd {
    uint8_t cmd = 0;
    uint8_t n = 0;
    uint8_t p[4] = {};
};

/** The commands that run `op`: the last is kActivate, or kSwReset for Op::soft_reset. At most 5. */
size_t sequence(hal::Epaper::Op op, uint16_t fast_ms, std::span<Cmd, 5> out);
/** The window and cursor for (x, y, w, h), x and w multiples of 8: kRamX, kRamY, kCursorX, kCursorY. */
std::array<Cmd, 4> window(uint16_t x, uint16_t y, uint16_t w, uint16_t h);
/** The set-up after a software reset (Waveshare's Init): RAM options, border, data entry; then the whole window. */
std::array<Cmd, 3> setup();

}  // namespace ssd1683

/**
 * The controller on SPI2 (mode 0, cfg.spi_mhz, MOSI only: the module has no MISO), DC on its own pin (low a command,
 * high its data), RST and BUSY on theirs. Every command and every data chunk is one CS frame, as Waveshare's code does.
 *
 * init touches no controller: it sets the pins (RST high, BUSY an input with the pull-down, so an unplugged panel
 * reads idle and never answers), the shared bus and the BUSY interrupt (any edge, into a core input slot). The
 * backend resets and configures the controller right after, asynchronously (hold_reset, Op::soft_reset, configure).
 *
 * BUSY: each edge goes through the input slot to the core task; a fall reports to the backend's IdleSink. answered()
 * is true once BUSY rose after the last start() and fell again (coalesced edges count: a low sample after two edges).
 *
 * The window's X is in bytes in both 0x44 and the 0x4E cursor (Waveshare's C partial sets the cursor in pixels, a bug
 * its Arduino code fixes). Data goes out of a driver-owned, word-aligned buffer, at most kChunk per transaction, so
 * IDF never bounces it through the heap.
 */
class Ssd1683Spi final : public hal::Epaper
{
public:
    // Field order and defaults follow driver.yaml `config:`; the generated fr_board fills it from the profile's bind.
    struct Config {
        uint8_t sclk = 0;
        uint8_t mosi = 0;
        uint8_t cs = 0;
        uint8_t dc = 0;
        uint8_t rst = 0;
        uint8_t busy = 0;
        uint16_t width = 400;
        uint16_t height = 300;
        uint8_t spi_mhz = 10;
        uint16_t fast_ms = 1500;
    };

    /** The controller's RAM: 400 sources by 300 gates. */
    static constexpr uint16_t kRamWidth = 400;
    static constexpr uint16_t kRamHeight = 300;
    /** Bytes per data transaction (the backend's chunk). */
    static constexpr size_t kChunk = 1024;

    // Only stores the configuration: hardware is touched in init() (spec 03 §3.4).
    explicit Ssd1683Spi(const Config &cfg) : cfg_(cfg) {}

    Status init(Core &core, hal::Rotation rotation) override;
    uint16_t native_width() const override { return cfg_.width; }
    uint16_t native_height() const override { return cfg_.height; }
    hal::Rotation rotation() const override { return rotation_; }
    hal::Selftest selftest() override;

    void on_idle(IdleSink sink) override { idle_ = sink; }
    bool answered() const override { return answered_; }
    Status hold_reset(bool asserted) override;
    Status configure() override;
    Status write_begin(Plane plane, uint16_t x, uint16_t y, uint16_t w, uint16_t h) override;
    Status write(std::span<const uint8_t> bytes) override;
    Status start(Op op) override;
    Status sleep() override;
    bool busy() const override;

private:
    static void isr(void *arg);
    void on_busy(const InputSample &s);
    Status send(const ssd1683::Cmd &c);
    Status data(std::span<const uint8_t> bytes);

    Config cfg_;
    spi_device_t *dev_ = nullptr;
    InputSlot *slot_ = nullptr;
    IdleSink idle_;
    hal::Rotation rotation_ = hal::Rotation::r0;
    bool ready_ = false;     // the pins and the bus are up
    bool started_ = false;   // a start() was sent since boot
    bool rose_ = false;      // BUSY rose since the last start()
    bool answered_ = false;  // ... and fell again
    hal::Epaper::Op last_op_ = hal::Epaper::Op::soft_reset;
    volatile uint32_t isr_count_ = 0;
    uint32_t starts_[6] = {};  // per Op
    uint32_t spi_errors_ = 0;
    char detail_[160] = {};
    // DMA-capable: the driver object is static (fr_board), so in internal .bss.
    alignas(4) uint8_t buf_[kChunk] = {};
};

}  // namespace fr::drv
