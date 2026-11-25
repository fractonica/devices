#include "fr/drv/ssd1683_spi.hpp"

#include <algorithm>
#include <cinttypes>
#include <cstdio>
#include <cstring>

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "fr/platform/gpio_isr.hpp"
#include "fr/platform/spi_bus.hpp"
#include "hal/gpio_ll.h"
#include "soc/gpio_struct.h"

namespace fr::drv {
namespace {

constexpr const char *TAG = "ssd1683";

constexpr spi_host_device_t kHost = SPI2_HOST;

constexpr ssd1683::Cmd cmd0(uint8_t c)
{
    return {c, 0, {}};
}
constexpr ssd1683::Cmd cmd1(uint8_t c, uint8_t a)
{
    return {c, 1, {a}};
}
constexpr ssd1683::Cmd cmd2(uint8_t c, uint8_t a, uint8_t b)
{
    return {c, 2, {a, b}};
}

const char *op_name(hal::Epaper::Op op)
{
    switch (op) {
    case hal::Epaper::Op::full:
        return "full";
    case hal::Epaper::Op::fast:
        return "fast";
    case hal::Epaper::Op::partial:
        return "partial";
    case hal::Epaper::Op::partial_hold:
        return "partial (held)";
    case hal::Epaper::Op::power_off:
        return "power off";
    case hal::Epaper::Op::soft_reset:
        return "reset";
    }
    return "?";
}

}  // namespace

// ---- The command bytes ---------------------------------------------------------------------------------------------

size_t ssd1683::sequence(hal::Epaper::Op op, uint16_t fast_ms, std::span<Cmd, 5> out)
{
    using Op = hal::Epaper::Op;
    size_t n = 0;
    switch (op) {
    case Op::full:
        // Mode 1 with the red RAM read as 0: the whole picture from the black/white RAM (Waveshare's Init + Display).
        out[n++] = cmd2(kUpdate1, 0x40, 0x00);
        out[n++] = cmd1(kBorder, 0x05);
        out[n++] = cmd1(kUpdate2, kSeqFull);
        break;
    case Op::fast:
        // The waveform the controller keeps for 110 °C (1.5 s) or 90 °C (1 s), loaded for that temperature and shown
        // in one step (GxEPD2's 0xD7; Waveshare loads it with 0x91, then shows it with 0xC7).
        out[n++] = cmd2(kUpdate1, 0x40, 0x00);
        out[n++] = cmd1(kBorder, 0x05);
        out[n++] = cmd1(kTempWrite, fast_ms < 1250 ? kFastTemp1000 : kFastTemp1500);
        out[n++] = cmd1(kUpdate2, kSeqFast);
        break;
    case Op::partial:
    case Op::partial_hold:
        // Mode 2, both RAMs read as they are: only pixels where next differs from prev move; the border is left alone
        // (Waveshare's PartialDisplay: 0x3C 0x80, 0x21 0x00 0x00).
        out[n++] = cmd2(kUpdate1, 0x00, 0x00);
        out[n++] = cmd1(kBorder, 0x80);
        out[n++] = cmd1(kUpdate2, op == Op::partial ? kSeqPartial : kSeqPartialHold);
        break;
    case Op::power_off:
        out[n++] = cmd1(kUpdate2, kSeqPowerOff);
        break;
    case Op::soft_reset:
        out[n++] = cmd0(kSwReset);
        return n;
    }
    out[n++] = cmd0(kActivate);
    return n;
}

std::array<ssd1683::Cmd, 4> ssd1683::window(uint16_t x, uint16_t y, uint16_t w, uint16_t h)
{
    const auto xs = static_cast<uint8_t>(x / 8);
    const auto xe = static_cast<uint8_t>((x + w - 1) / 8);
    const auto ye = static_cast<uint16_t>(y + h - 1);
    Cmd ry{kRamY, 4, {static_cast<uint8_t>(y & 0xFF), static_cast<uint8_t>(y >> 8), static_cast<uint8_t>(ye & 0xFF),
                      static_cast<uint8_t>(ye >> 8)}};
    return {cmd2(kRamX, xs, xe), ry, cmd1(kCursorX, xs), cmd2(kCursorY, static_cast<uint8_t>(y & 0xFF),
                                                             static_cast<uint8_t>(y >> 8))};
}

std::array<ssd1683::Cmd, 3> ssd1683::setup()
{
    return {cmd2(kUpdate1, 0x40, 0x00), cmd1(kBorder, 0x05), cmd1(kDataEntry, 0x03)};
}

// ---- The driver -----------------------------------------------------------------------------------------------------

Status Ssd1683Spi::init(Core &core, hal::Rotation rotation)
{
    if (cfg_.width == 0 || cfg_.height == 0 || cfg_.width > kRamWidth || cfg_.height > kRamHeight ||
        cfg_.width % 8 != 0 || cfg_.spi_mhz == 0 || cfg_.spi_mhz > 20) {
        return std::unexpected(Err::invalid_args);
    }
    for (int pin : {int{cfg_.sclk}, int{cfg_.mosi}, int{cfg_.cs}, int{cfg_.dc}, int{cfg_.rst}}) {
        if (!GPIO_IS_VALID_OUTPUT_GPIO(pin)) {
            return std::unexpected(Err::invalid_args);
        }
    }
    if (!GPIO_IS_VALID_GPIO(cfg_.busy)) {
        return std::unexpected(Err::invalid_args);
    }
    rotation_ = rotation;  // the backend rotates in software; the RAM stays native

    // The slot must exist before the interrupt is enabled: the ISR uses it unchecked.
    slot_ = core.input_slot([this](const InputSample &s) { on_busy(s); });
    if (slot_ == nullptr) {
        return std::unexpected(Err::failed);
    }

    gpio_config_t out = {};
    out.pin_bit_mask = (1ULL << cfg_.dc) | (1ULL << cfg_.rst);
    out.mode = GPIO_MODE_OUTPUT;
    out.pull_up_en = GPIO_PULLUP_DISABLE;
    out.pull_down_en = GPIO_PULLDOWN_DISABLE;
    out.intr_type = GPIO_INTR_DISABLE;
    if (gpio_config(&out) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    // RST high: the controller runs (on Waveshare's module RST low also cuts the panel's power).
    gpio_set_level(static_cast<gpio_num_t>(cfg_.rst), 1);
    gpio_set_level(static_cast<gpio_num_t>(cfg_.dc), 1);

    // BUSY: high while the controller works. The module drives it through its level shifter; the pull-down makes an
    // unplugged panel read idle, so it never "answers" (design epaper-e1 §0: no pull on the module).
    gpio_config_t in = {};
    in.pin_bit_mask = 1ULL << cfg_.busy;
    in.mode = GPIO_MODE_INPUT;
    in.pull_up_en = GPIO_PULLUP_DISABLE;
    in.pull_down_en = GPIO_PULLDOWN_ENABLE;
    in.intr_type = GPIO_INTR_DISABLE;  // enabled below, once the handler is in place
    if (gpio_config(&in) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    if (!platform::gpio_isr_service(0)) {
        return std::unexpected(Err::failed);
    }
    const auto busy_pin = static_cast<gpio_num_t>(cfg_.busy);
    if (gpio_isr_handler_add(busy_pin, &Ssd1683Spi::isr, this) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    if (gpio_set_intr_type(busy_pin, GPIO_INTR_ANYEDGE) != ESP_OK || gpio_intr_enable(busy_pin) != ESP_OK) {
        gpio_isr_handler_remove(busy_pin);
        return std::unexpected(Err::failed);
    }

    // The shared bus (design lcd-clock-c1 D3): another device may sit on the same host with its own CS.
    if (const Status bus = platform::spi_bus(kHost, {cfg_.sclk, cfg_.mosi, -1}, static_cast<int>(kChunk)); !bus) {
        ESP_LOGE(TAG, "the SPI bus is not available");
        return bus;
    }
    spi_device_interface_config_t dev = {};
    dev.mode = 0;
    dev.clock_speed_hz = static_cast<int>(cfg_.spi_mhz) * 1'000'000;
    dev.spics_io_num = cfg_.cs;
    dev.queue_size = 1;
    const esp_err_t err = spi_bus_add_device(kHost, &dev, &dev_);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "spi_bus_add_device: %s", esp_err_to_name(err));
        return std::unexpected(Err::failed);
    }
    ready_ = true;
    ESP_LOGI(TAG, "%ux%u at %u MHz, rotation %u, cs %u, dc %u, rst %u, busy %u", unsigned{cfg_.width},
             unsigned{cfg_.height}, unsigned{cfg_.spi_mhz}, static_cast<unsigned>(rotation), unsigned{cfg_.cs},
             unsigned{cfg_.dc}, unsigned{cfg_.rst}, unsigned{cfg_.busy});
    return {};
}

void IRAM_ATTR Ssd1683Spi::isr(void *arg)
{
    auto *self = static_cast<Ssd1683Spi *>(arg);
    // gpio_ll is inlined into this IRAM function (gpio_get_level is in flash unless CONFIG_GPIO_CTRL_FUNC_IN_IRAM).
    const bool level = gpio_ll_get_level(&GPIO, self->cfg_.busy) != 0;
    self->isr_count_ = self->isr_count_ + 1;
    self->slot_->update_from_isr(level, esp_timer_get_time());
}

void Ssd1683Spi::on_busy(const InputSample &s)
{
    if (s.level) {
        rose_ = true;
        return;
    }
    // Low: a fall, or a rise and a fall coalesced into one sample.
    if (started_ && (rose_ || s.edges >= 2)) {
        rose_ = true;
        answered_ = true;
    }
    if (idle_) {
        idle_(s.at);
    }
}

bool Ssd1683Spi::busy() const
{
    return ready_ && gpio_get_level(static_cast<gpio_num_t>(cfg_.busy)) != 0;
}

Status Ssd1683Spi::hold_reset(bool asserted)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    gpio_set_level(static_cast<gpio_num_t>(cfg_.rst), asserted ? 0 : 1);
    return {};
}

Status Ssd1683Spi::send(const ssd1683::Cmd &c)
{
    spi_transaction_t t = {};
    t.flags = SPI_TRANS_USE_TXDATA;
    t.length = 8;
    t.tx_data[0] = c.cmd;
    gpio_set_level(static_cast<gpio_num_t>(cfg_.dc), 0);
    if (spi_device_polling_transmit(dev_, &t) != ESP_OK) {
        ++spi_errors_;
        return std::unexpected(Err::failed);
    }
    gpio_set_level(static_cast<gpio_num_t>(cfg_.dc), 1);
    if (c.n == 0) {
        return {};
    }
    spi_transaction_t p = {};
    p.flags = SPI_TRANS_USE_TXDATA;
    p.length = 8u * c.n;
    std::memcpy(p.tx_data, c.p, c.n);
    if (spi_device_polling_transmit(dev_, &p) != ESP_OK) {
        ++spi_errors_;
        return std::unexpected(Err::failed);
    }
    return {};
}

Status Ssd1683Spi::data(std::span<const uint8_t> bytes)
{
    gpio_set_level(static_cast<gpio_num_t>(cfg_.dc), 1);
    for (size_t off = 0; off < bytes.size(); off += kChunk) {
        const size_t len = std::min(kChunk, bytes.size() - off);
        std::memcpy(buf_, bytes.data() + off, len);
        spi_transaction_t t = {};
        t.length = 8 * len;
        t.tx_buffer = buf_;
        if (spi_device_polling_transmit(dev_, &t) != ESP_OK) {
            ++spi_errors_;
            return std::unexpected(Err::failed);
        }
    }
    return {};
}

Status Ssd1683Spi::configure()
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    for (const ssd1683::Cmd &c : ssd1683::setup()) {
        if (Status st = send(c); !st) {
            return st;
        }
    }
    for (const ssd1683::Cmd &c : ssd1683::window(0, 0, cfg_.width, cfg_.height)) {
        if (Status st = send(c); !st) {
            return st;
        }
    }
    return {};
}

Status Ssd1683Spi::write_begin(Plane plane, uint16_t x, uint16_t y, uint16_t w, uint16_t h)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    if (w == 0 || h == 0 || x % 8 != 0 || w % 8 != 0 || x + w > cfg_.width || y + h > cfg_.height) {
        return std::unexpected(Err::invalid_args);
    }
    for (const ssd1683::Cmd &c : ssd1683::window(x, y, w, h)) {
        if (Status st = send(c); !st) {
            return st;
        }
    }
    return send({plane == Plane::next ? ssd1683::kWriteNext : ssd1683::kWritePrev, 0, {}});
}

Status Ssd1683Spi::write(std::span<const uint8_t> bytes)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    return data(bytes);
}

Status Ssd1683Spi::start(Op op)
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    ssd1683::Cmd seq[5];
    const size_t n = ssd1683::sequence(op, cfg_.fast_ms, seq);
    started_ = true;
    rose_ = false;
    answered_ = false;
    last_op_ = op;
    ++starts_[static_cast<size_t>(op)];
    for (size_t i = 0; i < n; ++i) {
        if (Status st = send(seq[i]); !st) {
            return st;
        }
    }
    return {};
}

Status Ssd1683Spi::sleep()
{
    if (!ready_) {
        return std::unexpected(Err::failed);
    }
    return send(cmd1(ssd1683::kDeepSleep, 0x01));
}

hal::Selftest Ssd1683Spi::selftest()
{
    if (!ready_) {
        return {false, "not initialized (pins or SPI bus)"};
    }
    using Op = hal::Epaper::Op;
    const unsigned full = starts_[static_cast<size_t>(Op::full)];
    const unsigned fast = starts_[static_cast<size_t>(Op::fast)];
    const unsigned partial =
        starts_[static_cast<size_t>(Op::partial)] + starts_[static_cast<size_t>(Op::partial_hold)];
    if (!started_) {
        return {false, "not reset yet (the e-paper backend resets it at boot)"};
    }
    if (!answered_ && busy()) {
        snprintf(detail_, sizeof(detail_), "stuck busy after %s: BUSY never fell (wiring, or the BS resistor at 1?)",
                 op_name(last_op_));
        return {false, detail_};
    }
    if (!answered_) {
        snprintf(detail_, sizeof(detail_), "absent: BUSY never rose after %s (panel unplugged or not powered?)",
                 op_name(last_op_));
        return {false, detail_};
    }
    snprintf(detail_, sizeof(detail_),
             "answered %s, %ux%u at %u MHz; started %u full, %u fast, %u partial; %" PRIu32 " SPI errors",
             op_name(last_op_), unsigned{cfg_.width}, unsigned{cfg_.height}, unsigned{cfg_.spi_mhz}, full, fast,
             partial, spi_errors_);
    return {true, detail_};
}

}  // namespace fr::drv
