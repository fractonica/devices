// ssd1683_spi against the host SPI and GPIO shim (design epaper-e1 D5): the pins it sets up, the bytes of each step
// (design §0), BUSY through the interrupt and the input slot, the selftest, and the whole stack (DisplayService,
// EpaperBackend, the driver) from boot to a refresh and its `refreshed` event.
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "esp_sim.hpp"
#include "fr/display/epaper_backend.hpp"
#include "fr/drv/ssd1683_spi.hpp"
#include "fr/services/display_service.hpp"
#include "fr/wire.hpp"
#include "panel_sim.hpp"
#include "tests/fake_core.hpp"
#include "tests/test.hpp"

namespace {

using frt::FakeCore;
using fr::drv::Ssd1683Spi;
using Op = fr::hal::Epaper::Op;
namespace ssd = fr::drv::ssd1683;

/** Every shim back to power-on, on this test's clock. */
class SpiScope
{
public:
    explicit SpiScope(fr::Core &core)
    {
        clear();
        esp_sim::attach(core);
    }
    ~SpiScope() { clear(); }
    SpiScope(const SpiScope &) = delete;
    SpiScope &operator=(const SpiScope &) = delete;

    static void clear()
    {
        esp_sim::reset();
        esp_sim::spi_reset();
        esp_sim::task_delay_reset();
    }
};

/** The SPI log as "c12 c21 d4000 ..." (c: DC low, d: DC high); runs over 16 bytes as d[n]. */
std::string trace(size_t from = 0, size_t to = SIZE_MAX)
{
    std::string out;
    const auto &log = esp_sim::spi_log();
    char buf[16];
    for (size_t i = from; i < log.size() && i < to; ++i) {
        const auto &t = log[i];
        if (!out.empty()) {
            out += ' ';
        }
        if (t.bytes.size() > 16) {
            std::snprintf(buf, sizeof(buf), "%c[%zu]", t.dc ? 'd' : 'c', t.bytes.size());
            out += buf;
            continue;
        }
        out += t.dc ? 'd' : 'c';
        for (uint8_t b : t.bytes) {
            std::snprintf(buf, sizeof(buf), "%02x", b);
            out += buf;
        }
    }
    return out;
}

std::string seq(Op op, uint16_t fast_ms = 1500)
{
    ssd::Cmd c[5];
    const size_t n = ssd::sequence(op, fast_ms, c);
    std::string out;
    char buf[8];
    for (size_t i = 0; i < n; ++i) {
        if (!out.empty()) {
            out += ' ';
        }
        std::snprintf(buf, sizeof(buf), "%02x", c[i].cmd);
        out += buf;
        for (uint8_t k = 0; k < c[i].n; ++k) {
            std::snprintf(buf, sizeof(buf), ":%02x", c[i].p[k]);
            out += buf;
        }
    }
    return out;
}

/** paper-c6 as wired (design epaper-e1 D7). */
constexpr Ssd1683Spi::Config kPaper{.sclk = 19, .mosi = 18, .cs = 14, .dc = 3, .rst = 2, .busy = 1};

}  // namespace

TEST(ssd1683_sequences_are_the_design_bytes)
{
    // design epaper-e1 §0 and D5: Waveshare's full (0x21 0x40 0x00, 0x3C 0x05, 0x22 0xF7), GxEPD2's one-step fast
    // (0x1A 0x6E or 0x5A, then 0xD7), Waveshare's partial (0x21 0x00 0x00, 0x3C 0x80, 0x22 0xFF) and GxEPD2's held one
    // (0xFC) and power-off (0x83); each ends with 0x20. The software reset is 0x12 alone.
    CHECK_EQ(seq(Op::full), "21:40:00 3c:05 22:f7 20");
    CHECK_EQ(seq(Op::fast), "21:40:00 3c:05 1a:6e 22:d7 20");
    CHECK_EQ(seq(Op::fast, 1000), "21:40:00 3c:05 1a:5a 22:d7 20");
    CHECK_EQ(seq(Op::fast, 1249), "21:40:00 3c:05 1a:5a 22:d7 20");
    CHECK_EQ(seq(Op::partial), "21:00:00 3c:80 22:ff 20");
    CHECK_EQ(seq(Op::partial_hold), "21:00:00 3c:80 22:fc 20");
    CHECK_EQ(seq(Op::power_off), "22:83 20");
    CHECK_EQ(seq(Op::soft_reset), "12");
    // The window and cursor: X in bytes in both (Waveshare's C partial set the cursor in pixels), Y low then high.
    const auto w = ssd::window(8, 260, 24, 40);
    CHECK_EQ(w[0].cmd, 0x44);
    CHECK_EQ(w[0].p[0], 1);
    CHECK_EQ(w[0].p[1], 3);
    CHECK_EQ(w[1].cmd, 0x45);
    CHECK_EQ(w[1].n, 4);
    CHECK_EQ(w[1].p[0], 260 & 0xFF);
    CHECK_EQ(w[1].p[1], 1);
    CHECK_EQ(w[1].p[2], 299 & 0xFF);
    CHECK_EQ(w[1].p[3], 1);
    CHECK_EQ(w[2].cmd, 0x4E);
    CHECK_EQ(w[2].p[0], 1);
    CHECK_EQ(w[3].cmd, 0x4F);
    CHECK_EQ(w[3].p[0], 260 & 0xFF);
    CHECK_EQ(w[3].p[1], 1);
    const auto s = ssd::setup();
    CHECK_EQ(s[2].cmd, 0x11);
    CHECK_EQ(s[2].p[0], 0x03);
}

TEST(ssd1683_init_sets_pins_and_bus_and_touches_no_controller)
{
    FakeCore core;
    SpiScope scope(core);
    esp_sim::spi_watch_dc(kPaper.dc);
    Ssd1683Spi epd(kPaper);
    CHECK_EQ(epd.native_width(), 400);
    CHECK_EQ(epd.native_height(), 300);
    CHECK(epd.format() == fr::hal::PixelFormat::mono1);
    CHECK(!epd.has_backlight());
    REQUIRE(epd.init(core, fr::hal::Rotation::r90));
    CHECK(epd.rotation() == fr::hal::Rotation::r90);  // the backend rotates; the RAM stays native
    CHECK(esp_sim::spi_bus_up());
    CHECK_EQ(esp_sim::spi_mosi(), 18);
    CHECK_EQ(esp_sim::spi_sclk(), 19);
    CHECK_EQ(esp_sim::spi_cs(), 14);
    CHECK_EQ(esp_sim::spi_clock_hz(), 10'000'000);
    CHECK(esp_sim::spi_log().empty());
    CHECK(esp_sim::out(kPaper.rst));        // RST high: running
    CHECK(esp_sim::output_enabled(kPaper.rst));
    CHECK(esp_sim::pull_down(kPaper.busy));  // an unplugged panel reads idle
    CHECK(!esp_sim::output_enabled(kPaper.busy));
    CHECK(esp_sim::edge_irq(kPaper.busy));
    auto st = epd.selftest();
    CHECK(!st.ok);
    CHECK(std::string(st.detail).find("not reset yet") != std::string::npos);
    // flush is not the e-paper path.
    const uint8_t px[1] = {};
    CHECK_EQ(epd.flush(0, 0, 8, 1, px).error(), fr::Err::unsupported);
}

TEST(ssd1683_refuses_bad_config)
{
    FakeCore core;
    SpiScope scope(core);
    auto bad = kPaper;
    bad.width = 404;  // not whole bytes, and wider than the RAM
    Ssd1683Spi a(bad);
    CHECK_EQ(a.init(core, fr::hal::Rotation::r0).error(), fr::Err::invalid_args);
    bad = kPaper;
    bad.spi_mhz = 21;
    Ssd1683Spi b(bad);
    CHECK_EQ(b.init(core, fr::hal::Rotation::r0).error(), fr::Err::invalid_args);
}

TEST(ssd1683_busy_edges_answer_and_report_idle)
{
    FakeCore core;
    SpiScope scope(core);
    esp_sim::spi_watch_dc(kPaper.dc);
    Ssd1683Spi epd(kPaper);
    REQUIRE(epd.init(core, fr::hal::Rotation::r0));
    std::vector<fr::TimeUs> idles;
    epd.on_idle([&](fr::TimeUs at) { idles.push_back(at); });

    REQUIRE(epd.hold_reset(true));
    CHECK(!esp_sim::out(kPaper.rst));
    REQUIRE(epd.hold_reset(false));
    CHECK(esp_sim::out(kPaper.rst));
    REQUIRE(epd.start(Op::soft_reset));
    CHECK_EQ(trace(), "c12");
    CHECK(!epd.answered());
    esp_sim::set_drive(kPaper.busy, esp_sim::Drive::high);
    core.run_ready();
    CHECK(epd.busy());
    core.advance_ms(3);
    esp_sim::set_drive(kPaper.busy, esp_sim::Drive::low);
    core.run_ready();
    CHECK(!epd.busy());
    CHECK(epd.answered());
    REQUIRE_EQ(idles.size(), 1u);
    CHECK_EQ(idles[0], core.now());
    CHECK(epd.selftest().ok);

    // A step whose BUSY never rises (an unplugged panel, pulled down): not answered, selftest "absent".
    REQUIRE(epd.start(Op::power_off));
    core.advance_ms(1000);
    CHECK(!epd.answered());
    auto st = epd.selftest();
    CHECK(!st.ok);
    CHECK(std::string(st.detail).find("absent") != std::string::npos);
    // One that never falls: "stuck busy".
    REQUIRE(epd.start(Op::full));
    esp_sim::set_drive(kPaper.busy, esp_sim::Drive::high);
    core.advance_ms(20'000);
    st = epd.selftest();
    CHECK(!st.ok);
    CHECK(std::string(st.detail).find("stuck busy") != std::string::npos);
}

TEST(ssd1683_writes_windows_and_planes)
{
    FakeCore core;
    SpiScope scope(core);
    esp_sim::spi_watch_dc(kPaper.dc);
    Ssd1683Spi epd(kPaper);
    REQUIRE(epd.init(core, fr::hal::Rotation::r0));
    REQUIRE(epd.configure());
    // Waveshare's Init after the reset: RAM options, border, data entry; then the whole 400 x 300 window, cursor 0, 0.
    CHECK_EQ(trace(), "c21 d4000 c3c d05 c11 d03 c44 d0031 c45 d00002b01 c4e d00 c4f d0000");
    const size_t from = esp_sim::spi_log().size();
    REQUIRE(epd.write_begin(fr::hal::Epaper::Plane::prev, 16, 2, 16, 3));
    std::vector<uint8_t> bytes(6, 0xA5);
    REQUIRE(epd.write(bytes));
    REQUIRE(epd.write_begin(fr::hal::Epaper::Plane::next, 16, 2, 16, 3));
    std::vector<uint8_t> big(2000, 0x0F);  // more than one data transaction
    REQUIRE(epd.write(big));
    CHECK_EQ(trace(from), "c44 d0203 c45 d02000400 c4e d02 c4f d0200 c26 da5a5a5a5a5a5 c44 d0203 c45 d02000400 c4e d02 c4f d0200 c24 d[1024] d[976]");
    // A window off byte boundaries or off the RAM is refused.
    CHECK_EQ(epd.write_begin(fr::hal::Epaper::Plane::next, 4, 0, 8, 1).error(), fr::Err::invalid_args);
    CHECK_EQ(epd.write_begin(fr::hal::Epaper::Plane::next, 0, 0, 12, 1).error(), fr::Err::invalid_args);
    CHECK_EQ(epd.write_begin(fr::hal::Epaper::Plane::next, 392, 0, 16, 1).error(), fr::Err::invalid_args);
    CHECK_EQ(epd.write_begin(fr::hal::Epaper::Plane::next, 0, 299, 8, 2).error(), fr::Err::invalid_args);
    // Deep sleep.
    const size_t s = esp_sim::spi_log().size();
    REQUIRE(epd.sleep());
    CHECK_EQ(trace(s), "c10 d01");
}

TEST(ssd1683_whole_stack_boots_draws_and_refreshes)
{
    FakeCore core;
    SpiScope scope(core);
    esp_sim::spi_watch_dc(kPaper.dc);
    Ssd1683Spi epd(kPaper);
    std::vector<uint8_t> frame(15000), shown(15000), frozen(15000);
    fr::display::EpaperBackend backend(epd, {frame, shown, frozen});
    fr::cap::DisplayConfig cfg;
    fr::DisplayService svc(epd, backend, cfg);
    frt::RecordingSink sink(core);
    svc.attach(3, "paper", sink);
    REQUIRE(svc.init(core));
    CHECK(svc.traits().epaper);
    CHECK(svc.traits().color == fr::cap::DisplayColorFormat::mono1);
    CHECK_EQ(svc.traits().width, 400);

    // The boot reset: RST low 2 ms, high, 10 ms, 0x12; BUSY up and down; the set-up.
    CHECK(!esp_sim::out(kPaper.rst));
    core.advance_us(2000);
    CHECK(esp_sim::out(kPaper.rst));
    core.advance_us(10'000);
    CHECK_EQ(trace(), "c12");
    esp_sim::set_drive(kPaper.busy, esp_sim::Drive::high);
    core.advance_ms(2);
    esp_sim::set_drive(kPaper.busy, esp_sim::Drive::low);
    core.run_ready();
    CHECK_EQ(trace(1, 4), "c21 d4000 c3c");
    CHECK(svc.selftest().ok);

    // A line of text: settle_ms later the first refresh, full (the glass was not known): next, then prev, then 0xF7.
    fr::cap::DisplayTextArgs t;
    t.x = 4;
    t.y = 4;
    t.text = "paper-c6";
    t.size = 2;
    t.color = 0x000000;
    t.bg = 0xFFFFFF;
    REQUIRE(svc.text(t));
    const size_t from = esp_sim::spi_log().size();
    core.advance_ms(60);
    const std::string out = trace(from);
    // Whole rows per chunk: 20 rows of 50 bytes.
    CHECK(out.find("c24 d[1000]") != std::string::npos);
    CHECK(out.find("c26 d[1000]") != std::string::npos);
    CHECK(out.find("c24") < out.find("c26"));
    CHECK(out.rfind("c22 df7 c20") == out.size() - std::string("c22 df7 c20").size());
    esp_sim::set_drive(kPaper.busy, esp_sim::Drive::high);
    core.advance_ms(2900);
    sink.clear();
    esp_sim::set_drive(kPaper.busy, esp_sim::Drive::low);
    core.run_ready();
    // refreshed {mode full, ok, 2900 ms, ...} and the three properties.
    const auto ev = sink.events();
    REQUIRE_EQ(ev.size(), 1u);
    CHECK_EQ(ev[0].id, fr::cap::Display::kEventRefreshed);
    auto e = fr::cap::decode_display_refreshed(ev[0].bytes);
    REQUIRE(e);
    CHECK(e->mode == fr::cap::DisplayRefreshMode::full);
    CHECK(e->ok);
    CHECK_EQ(e->ms, 2900);
    CHECK_EQ(e->w, 400);
    CHECK(e->crc != 0u);
    CHECK_EQ(svc.shown_crc(), e->crc);
    CHECK_EQ(svc.refresh_ms(), 2900);
    const auto props = sink.properties();
    CHECK_EQ(props.size(), 2u);  // shown_crc and refresh_ms (partials stays 0)

    // refresh and hold through dispatch; a partial uses the held sequence (burst_ms 1000).
    fr::cap::StaticReply<fr::cap::Reply::kBulkCapacity> reply;
    fr::cap::DisplayFillRectArgs f;
    f.x = 200;
    f.y = 150;
    f.w = 10;
    f.h = 10;
    f.color = 0;
    REQUIRE(svc.fill_rect(f));
    uint8_t buf[16];
    fr::wire::Writer w(buf, sizeof(buf));
    encode(fr::cap::DisplayRefreshArgs{.mode = fr::cap::DisplayRefreshMode::auto_}, w);
    const size_t p0 = esp_sim::spi_log().size();
    REQUIRE(svc.dispatch(fr::cap::Display::kCmdRefresh, w.bytes(), reply));
    core.run_ready();
    const std::string part = trace(p0);
    CHECK(part.find("c26") < part.find("c24"));  // prev first for a partial
    CHECK(part.rfind("c22 dfc c20") == part.size() - std::string("c22 dfc c20").size());
}
