// EpaperBackend (design epaper-e1 D3, D6) against FakeCore and a fake controller whose glass changes as a real one's
// does: the boot reset, the first refresh full, partial windows in whole bytes, the old-image RAM kept right (the glass
// always ends equal to the frame), settle, hold, one waiting refresh with the strongest mode, the ghost budget, the
// 24 h clean, the burst and the power-off, deep sleep and the wake, failures, rotation, and snapshots.
#include <cstdint>
#include <string>
#include <vector>

#include "fr/display/epaper_backend.hpp"
#include "tests/display_fakes.hpp"
#include "tests/fake_core.hpp"
#include "tests/test.hpp"

namespace {

using frt::FakeCore;
using frt::FakeEpaper;
using fr::display::EpaperBackend;
using Mode = fr::cap::DisplayRefreshMode;
using Op = fr::hal::Epaper::Op;
using Phase = EpaperBackend::Phase;

fr::cap::DisplayConfig defaults()
{
    return fr::cap::DisplayConfig{};
}

struct Rig {
    explicit Rig(fr::cap::DisplayConfig c = defaults(), fr::hal::Rotation rot = fr::hal::Rotation::r0, bool frozen = true)
        // 15,200: a rotated frame's 300-pixel rows round up to 38 bytes.
        : panel(400, 300), cfg(c), rotation(rot), frame_buf(15200), shown_buf(15200), frozen_buf(frozen ? 15200 : 0),
          be(panel, {frame_buf, shown_buf, frozen_buf})
    {
    }

    bool init()
    {
        if (!panel.init(core, rotation)) {
            return false;
        }
        be.set_refresh_sink([this](const fr::cap::DisplayRefreshed &e) { events.push_back(e); });
        return static_cast<bool>(be.init(panel, cfg, core, {}));
    }

    /** init(), then the boot reset: 2 ms low, 10 ms, the software reset, BUSY falling 3 ms later. */
    void boot()
    {
        REQUIRE(init());
        core.advance_us(EpaperBackend::kResetLowUs);
        core.advance_us(EpaperBackend::kResetWaitUs);
        REQUIRE(panel.busy());
        core.advance_ms(3);
        panel.finish(core.now());
        core.run_ready();
        REQUIRE_EQ(be.counters().wakes, 1u);
    }

    /**
     * Runs the clock until nothing waits to be shown and no step is running, ending each BUSY step `busy_ms` after it
     * started. A partial's burst may still be on (power_off comes burst_ms later).
     */
    void run(uint32_t busy_ms = 400, uint32_t limit_ms = 120'000)
    {
        for (uint32_t t = 0; t < limit_ms; ++t) {
            if (panel.busy() && !panel.asleep) {
                core.advance_ms(busy_ms);
                panel.finish(core.now());
                core.run_ready();
                continue;
            }
            if (be.settled()) {
                return;
            }
            core.advance_ms(1);
        }
        CHECK(false);  // never settled
    }

    void fill(int16_t x, int16_t y, uint16_t w, uint16_t h, uint32_t color)
    {
        fr::cap::DisplayFillRectArgs a;
        a.x = x;
        a.y = y;
        a.w = w;
        a.h = h;
        a.color = color;
        CHECK(be.fill_rect(a));
    }

    void text(int16_t x, int16_t y, std::string_view s, uint8_t size = 2)
    {
        fr::cap::DisplayTextArgs a;
        a.x = x;
        a.y = y;
        a.text = s;
        a.size = size;
        a.color = 0x000000;  // ink on paper
        a.bg = 0xFFFFFF;
        CHECK(be.text(a));
    }

    /** The native pixel a logical one lands on (quarter turns clockwise, as hal::Rotation). */
    void native(int lx, int ly, int &nx, int &ny) const
    {
        switch (rotation) {
        case fr::hal::Rotation::r0:
            nx = lx, ny = ly;
            return;
        case fr::hal::Rotation::r90:
            nx = 399 - ly, ny = lx;
            return;
        case fr::hal::Rotation::r180:
            nx = 399 - lx, ny = 299 - ly;
            return;
        case fr::hal::Rotation::r270:
            nx = ly, ny = 299 - lx;
            return;
        }
    }

    /** The glass shows exactly the frame. */
    bool glass_is_frame() const
    {
        for (int y = 0; y < be.frame().height(); ++y) {
            for (int x = 0; x < be.frame().width(); ++x) {
                int nx = 0;
                int ny = 0;
                native(x, y, nx, ny);
                if (panel.glass_pixel(nx, ny) != be.frame().pixel(x, y)) {
                    return false;
                }
            }
        }
        return true;
    }

    std::vector<Op> ops_since(size_t from) const { return {panel.ops.begin() + static_cast<std::ptrdiff_t>(from), panel.ops.end()}; }

    FakeCore core;
    FakeEpaper panel;
    fr::cap::DisplayConfig cfg;
    fr::hal::Rotation rotation;
    std::vector<uint8_t> frame_buf, shown_buf, frozen_buf;
    EpaperBackend be;
    std::vector<fr::cap::DisplayRefreshed> events;
    fr::TimeUs panel_busy_since = 0;  // the random test's BUSY clock
};

}  // namespace

TEST(epaper_boot_resets_the_controller_and_leaves_the_glass)
{
    Rig r;
    REQUIRE(r.init());
    CHECK(r.be.epaper());
    CHECK_EQ(r.be.frame().width(), 400);
    CHECK_EQ(r.be.frame().pixel(0, 0), true);      // white paper
    CHECK_EQ(r.be.frame().pixel(399, 299), true);
    CHECK_EQ(r.be.phase(), Phase::reset_low);
    CHECK_EQ(r.panel.log.size(), 1u);
    CHECK_EQ(r.panel.log[0], std::string("rst low"));
    r.core.advance_us(EpaperBackend::kResetLowUs - 1);
    CHECK_EQ(r.panel.log.size(), 1u);              // the pulse lasts 2 ms
    r.core.advance_us(1);
    CHECK_EQ(r.panel.log.back(), std::string("rst high"));
    r.core.advance_us(EpaperBackend::kResetWaitUs);
    CHECK_EQ(r.panel.log.back(), std::string("start soft_reset"));
    r.core.advance_ms(3);
    r.panel.finish(r.core.now());
    r.core.run_ready();
    CHECK_EQ(r.panel.log.back(), std::string("configure"));
    CHECK_EQ(r.be.phase(), Phase::idle);
    CHECK_EQ(r.be.counters().wakes, 1u);
    // Nothing was drawn: no refresh, the glass keeps its old picture, and what it shows is not known.
    r.core.advance_ms(1000);
    CHECK(r.events.empty());
    CHECK_EQ(r.be.shown_crc(), 0u);
    CHECK(!r.be.glass_known());
}

TEST(epaper_first_refresh_is_full_then_partials_move_only_the_change)
{
    Rig r;
    r.boot();
    r.text(10, 10, "Fractonica");
    r.core.advance_ms(59);
    CHECK_EQ(r.panel.ops.size(), 1u);              // settle_ms: nothing yet
    r.run();
    REQUIRE_EQ(r.events.size(), 1u);
    CHECK_EQ(r.events[0].mode, Mode::full);         // the glass was not known
    CHECK(r.events[0].ok);
    CHECK_EQ(r.events[0].ms, 400);
    CHECK_EQ(r.events[0].w, 400);
    CHECK_EQ(r.events[0].h, 300);
    CHECK(r.glass_is_frame());
    CHECK(r.be.glass_known());
    CHECK(r.be.shown_crc() != 0u);
    CHECK_EQ(r.events[0].crc, r.be.shown_crc());
    CHECK_EQ(r.be.shown_crc(), fr::display::crc32(r.be.frame().pixels()));

    // A small change: one partial, its window widened to whole bytes; prev first, then next.
    const size_t w0 = r.panel.writes.size();
    r.fill(13, 20, 3, 2, 0x000000);
    r.run();
    REQUIRE_EQ(r.events.size(), 2u);
    CHECK_EQ(r.events[1].mode, Mode::partial);
    CHECK_EQ(r.events[1].x, 8);
    CHECK_EQ(r.events[1].y, 20);
    CHECK_EQ(r.events[1].w, 8);
    CHECK_EQ(r.events[1].h, 2);
    CHECK_EQ(r.events[1].partials, 1);
    REQUIRE_EQ(r.panel.writes.size(), w0 + 2);
    CHECK(r.panel.writes[w0].plane == FakeEpaper::Plane::prev);
    CHECK(r.panel.writes[w0 + 1].plane == FakeEpaper::Plane::next);
    CHECK_EQ(r.panel.writes[w0 + 1].bytes, 2u);    // one byte by two rows
    CHECK_EQ(r.panel.ops.back(), Op::partial_hold);  // burst_ms 1000 keeps the high voltage on
    CHECK(r.glass_is_frame());
    CHECK_EQ(r.panel.bad_windows, 0);
}

TEST(epaper_partials_keep_the_old_image_ram_right)
{
    // Many partials in different places: if prev were left stale, a partial would re-drive or skip pixels and the
    // fake's glass would drift from the frame.
    Rig r;
    r.cfg.full_every = 0;  // no clean refresh in between
    r.boot();
    r.fill(0, 0, 400, 300, 0xFFFFFF);
    r.text(0, 0, "x");
    r.run();
    uint32_t seed = 7;
    for (int i = 0; i < 40; ++i) {
        seed = seed * 1103515245u + 12345u;
        const auto x = static_cast<int16_t>((seed >> 8) % 380);
        const auto y = static_cast<int16_t>((seed >> 16) % 280);
        r.fill(x, y, static_cast<uint16_t>(1 + (seed % 20)), static_cast<uint16_t>(1 + ((seed >> 4) % 20)),
               (i % 3) == 0 ? 0xFFFFFF : 0x000000);
        r.run();
        REQUIRE(r.glass_is_frame());
    }
    // Every fill that changed a pixel was one partial (a white one on white changes nothing).
    CHECK(r.be.partials() >= 20);
    CHECK_EQ(r.be.counters().partial, r.events.size() - 1);
    CHECK_EQ(r.be.counters().full, 1u);
}

TEST(epaper_ghost_budget_cleans_on_the_next_change)
{
    Rig r;  // full_every 5, clean full
    r.boot();
    r.text(0, 0, "a");
    r.run();  // the first: full
    for (int i = 1; i <= 5; ++i) {
        r.fill(static_cast<int16_t>(i * 20), 100, 5, 5, 0x000000);
        r.run();
        CHECK_EQ(r.events.back().mode, Mode::partial);
        CHECK_EQ(r.be.partials(), i);
    }
    // Spent: nothing happens until something changes, then a clean refresh.
    r.core.advance_ms(5000);
    const size_t n = r.events.size();
    CHECK_EQ(n, 6u);
    r.fill(200, 200, 4, 4, 0x000000);
    r.run();
    REQUIRE_EQ(r.events.size(), 7u);
    CHECK_EQ(r.events.back().mode, Mode::full);
    CHECK_EQ(r.be.partials(), 0);
    CHECK(r.glass_is_frame());

    // An explicit partial runs past the budget.
    for (int i = 0; i < 7; ++i) {
        r.fill(static_cast<int16_t>(i * 10), 250, 3, 3, 0x000000);
        auto res = r.be.refresh(Mode::partial);
        REQUIRE(res);
        CHECK_EQ(res->mode, Mode::partial);
        CHECK(res->changed);
        r.run();
        CHECK_EQ(r.events.back().mode, Mode::partial);
    }
    CHECK_EQ(r.be.partials(), 7);
    CHECK(r.glass_is_frame());
}

TEST(epaper_fast_clean_and_explicit_modes)
{
    Rig r;
    r.cfg.clean = Mode::fast;
    r.cfg.full_every = 1;
    r.boot();
    r.text(0, 0, "a");
    r.run();
    r.fill(50, 50, 8, 8, 0x000000);
    r.run();
    CHECK_EQ(r.events.back().mode, Mode::partial);
    r.fill(60, 50, 8, 8, 0x000000);
    r.run();
    CHECK_EQ(r.events.back().mode, Mode::fast);  // the budget's clean
    CHECK_EQ(r.panel.ops.back(), Op::fast);

    // Nothing changed: auto and partial do nothing, full redraws.
    const size_t n = r.events.size();
    auto a = r.be.refresh(Mode::auto_);
    REQUIRE(a);
    CHECK(!a->changed);
    r.run();
    CHECK_EQ(r.events.size(), n);
    auto f = r.be.refresh(Mode::full);
    REQUIRE(f);
    CHECK_EQ(f->mode, Mode::full);
    CHECK(!f->changed);
    r.run();
    REQUIRE_EQ(r.events.size(), n + 1);
    CHECK_EQ(r.events.back().mode, Mode::full);
    CHECK(r.glass_is_frame());
}

TEST(epaper_hold_waits_for_refresh_or_its_end)
{
    Rig r;
    r.boot();
    r.text(0, 0, "a");
    r.run();
    const size_t n = r.events.size();
    CHECK(r.be.hold(5000));
    for (int i = 0; i < 10; ++i) {
        r.fill(static_cast<int16_t>(i * 30), 40, 10, 10, 0x000000);
        r.core.advance_ms(100);
    }
    CHECK_EQ(r.events.size(), n);  // held
    auto res = r.be.refresh(Mode::auto_);
    REQUIRE(res);
    CHECK(res->changed);
    r.run();
    CHECK_EQ(r.events.size(), n + 1);  // one refresh for all ten
    CHECK(r.glass_is_frame());

    // A hold that runs out shows what arrived.
    CHECK(r.be.hold(2000));
    r.fill(0, 200, 16, 16, 0x000000);
    r.core.advance_ms(1999);
    CHECK_EQ(r.events.size(), n + 1);
    r.core.advance_ms(2);
    r.run();
    CHECK_EQ(r.events.size(), n + 2);
    CHECK(r.glass_is_frame());
    // hold(0) releases at once: settle_ms later.
    CHECK(r.be.hold(5000));
    r.fill(100, 200, 16, 16, 0x000000);
    CHECK(r.be.hold(0));
    r.run();
    CHECK_EQ(r.events.size(), n + 3);
}

TEST(epaper_one_refresh_waits_with_the_strongest_mode)
{
    Rig r;
    r.boot();
    r.text(0, 0, "a");
    r.run();
    r.fill(10, 10, 8, 8, 0x000000);
    r.core.advance_ms(60);
    REQUIRE(r.panel.busy());  // a partial is running
    const size_t ops = r.panel.ops.size();
    r.fill(30, 10, 8, 8, 0x000000);
    CHECK(r.be.refresh(Mode::fast));
    CHECK(r.be.refresh(Mode::partial));  // weaker: the fast stays
    r.core.advance_ms(100);
    CHECK_EQ(r.panel.ops.size(), ops);  // nothing starts while one runs
    r.run();
    const auto after = r.ops_since(ops);
    REQUIRE(!after.empty());
    CHECK_EQ(after.front(), Op::fast);
    CHECK(r.glass_is_frame());
}

TEST(epaper_burst_then_power_off_then_sleep_then_wake)
{
    Rig r;
    r.boot();
    r.text(0, 0, "a");
    r.run();
    r.fill(10, 10, 8, 8, 0x000000);
    r.run();
    CHECK(r.be.high_voltage());
    // A partial inside the burst keeps it on.
    r.core.advance_ms(500);
    r.fill(40, 10, 8, 8, 0x000000);
    r.run();
    CHECK_EQ(r.panel.ops.back(), Op::partial_hold);
    const size_t ops = r.panel.ops.size();
    r.core.advance_ms(999);
    CHECK_EQ(r.panel.ops.size(), ops);
    r.core.advance_ms(2);
    REQUIRE_EQ(r.panel.ops.size(), ops + 1);
    CHECK_EQ(r.panel.ops.back(), Op::power_off);
    r.core.advance_ms(100);
    r.panel.finish(r.core.now());
    r.core.run_ready();
    CHECK(!r.be.high_voltage());
    // sleep_s 10 after the last step.
    r.core.advance_ms(9'000);
    CHECK(!r.panel.asleep);
    r.core.advance_ms(1'200);
    CHECK(r.panel.asleep);
    CHECK_EQ(r.be.phase(), Phase::asleep);
    CHECK_EQ(r.be.counters().sleeps, 1u);
    // The next change wakes it: a reset (the fake's RAMs become junk), then both RAMs rewritten whole, a partial.
    const size_t w0 = r.panel.writes.size();
    r.fill(100, 100, 20, 20, 0x000000);
    r.core.advance_ms(60);
    CHECK_EQ(r.be.phase(), Phase::reset_low);
    r.core.advance_us(EpaperBackend::kResetLowUs);
    r.core.advance_us(EpaperBackend::kResetWaitUs);
    r.core.advance_ms(3);
    r.panel.finish(r.core.now());
    r.run();
    CHECK_EQ(r.events.back().mode, Mode::partial);
    REQUIRE(r.panel.writes.size() >= w0 + 2);
    CHECK_EQ(r.panel.writes[w0].w, 400);
    CHECK_EQ(r.panel.writes[w0].h, 300);
    CHECK_EQ(r.panel.writes[w0 + 1].w, 400);
    CHECK(r.glass_is_frame());
    // And the partial after that writes both RAMs over the last change (the box at 100,100: bytes 12..14, x 96..119)
    // and this one, nothing more (design face-f1 §17: one RAM holds the old picture there, whichever it is).
    r.fill(304, 250, 8, 8, 0x000000);
    const size_t w1 = r.panel.writes.size();
    r.run();
    REQUIRE_EQ(r.panel.writes.size(), w1 + 2);
    CHECK_EQ(r.panel.writes[w1].x, 96);
    CHECK_EQ(r.panel.writes[w1].w, 216);  // x 96..311
    CHECK_EQ(r.panel.writes[w1 + 1].w, 216);
    r.fill(304, 260, 8, 8, 0x000000);
    const size_t w2 = r.panel.writes.size();
    r.run();
    CHECK_EQ(r.panel.writes[w2].w, 8);
    CHECK_EQ(r.panel.writes[w2].h, 18);  // rows 250..267: the last change and this one
    CHECK_EQ(r.panel.writes[w2 + 1].h, 18);
    CHECK(r.glass_is_frame());
}

TEST(epaper_no_burst_powers_down_after_each_partial)
{
    Rig r;
    r.cfg.burst_ms = 0;
    r.boot();
    r.text(0, 0, "a");
    r.run();
    r.fill(10, 10, 8, 8, 0x000000);
    r.run();
    CHECK_EQ(r.panel.ops.back(), Op::partial);
    CHECK(!r.be.high_voltage());
}

TEST(epaper_clean_every_24_hours)
{
    Rig r;
    r.cfg.sleep_s = 0;
    r.boot();
    r.text(0, 0, "a");
    r.run();
    r.fill(10, 10, 8, 8, 0x000000);
    r.run();
    r.core.advance_ms(1100);  // the burst ends: power off
    REQUIRE_EQ(r.panel.ops.back(), Op::power_off);
    r.panel.finish(r.core.now());
    r.core.run_ready();
    const size_t n = r.events.size();
    r.core.advance_to(r.core.now() + 23LL * 3'600'000'000LL);
    CHECK_EQ(r.events.size(), n);
    r.core.advance_to(r.core.now() + 3'600'000'000LL);
    r.run();
    REQUIRE_EQ(r.events.size(), n + 1);
    CHECK_EQ(r.events.back().mode, Mode::full);
    CHECK(r.glass_is_frame());
}

TEST(epaper_busy_timeout_fails_then_resets_and_refreshes_full)
{
    Rig r;
    r.boot();
    r.text(0, 0, "a");
    r.run();
    r.fill(10, 10, 8, 8, 0x000000);
    r.core.advance_ms(60);
    REQUIRE(r.panel.busy());
    r.core.advance_ms(2001);  // the partial's 2 s
    REQUIRE_EQ(r.events.size(), 2u);
    CHECK(!r.events.back().ok);
    CHECK_EQ(r.events.back().mode, Mode::partial);
    CHECK_EQ(r.events.back().crc, 0u);
    CHECK(!r.be.glass_known());
    CHECK_EQ(r.be.counters().failed, 1u);
    // Nothing retries by itself.
    r.panel.finish(r.core.now());  // the stuck panel lets go
    r.core.advance_ms(5000);
    CHECK_EQ(r.events.size(), 2u);
    // The next change resets first, then a full refresh.
    r.fill(20, 10, 8, 8, 0x000000);
    r.core.advance_ms(60);
    CHECK_EQ(r.be.phase(), Phase::reset_low);
    r.core.advance_us(EpaperBackend::kResetLowUs + EpaperBackend::kResetWaitUs);
    r.core.advance_ms(3);
    r.panel.finish(r.core.now());
    r.run();
    CHECK_EQ(r.events.back().mode, Mode::full);
    CHECK(r.events.back().ok);
    CHECK(r.glass_is_frame());
}

TEST(epaper_a_lost_busy_edge_is_found_at_the_timeout)
{
    Rig r;
    r.boot();
    r.text(0, 0, "a");
    r.core.advance_ms(60);
    REQUIRE(r.panel.busy());
    r.core.advance_ms(500);
    r.panel.finish_silently();
    r.core.advance_ms(10'000);  // the full's timeout
    REQUIRE_EQ(r.events.size(), 1u);
    CHECK(r.events[0].ok);
    CHECK_EQ(r.be.counters().late_idle, 1u);
    CHECK(r.glass_is_frame());
}

TEST(epaper_absent_panel_fails_quietly_and_reports_a_refresh)
{
    Rig r;
    r.panel.absent = true;
    REQUIRE(r.init());
    r.core.advance_ms(1000);  // the boot reset times out: no refresh was asked, so no event
    CHECK(r.events.empty());
    CHECK_EQ(r.be.counters().failed, 1u);
    r.text(0, 0, "a");  // drawing still works, in memory
    r.core.advance_ms(60);
    r.core.advance_ms(1000);
    REQUIRE_EQ(r.events.size(), 1u);
    CHECK(!r.events[0].ok);
    CHECK_EQ(r.events[0].w, 0);
    CHECK_EQ(r.be.counters().failed, 2u);
    // Plugged in later: the next refresh works.
    r.panel.absent = false;
    CHECK(r.be.refresh(Mode::auto_));
    r.core.advance_us(EpaperBackend::kResetLowUs + EpaperBackend::kResetWaitUs);
    r.core.advance_ms(3);
    r.panel.finish(r.core.now());
    r.run();
    CHECK(r.events.back().ok);
    CHECK(r.glass_is_frame());
}

TEST(epaper_boot_clear_shows_white)
{
    Rig r;
    r.cfg.boot_clear = true;
    r.boot();
    r.run();
    REQUIRE_EQ(r.events.size(), 1u);
    CHECK_EQ(r.events[0].mode, Mode::full);
    CHECK(r.glass_is_frame());
    CHECK(r.panel.glass_pixel(0, 0));
}

TEST(epaper_rotations_land_on_the_glass)
{
    for (auto rot : {fr::hal::Rotation::r0, fr::hal::Rotation::r90, fr::hal::Rotation::r180, fr::hal::Rotation::r270}) {
        Rig r(defaults(), rot);
        r.boot();
        const bool quarter = rot == fr::hal::Rotation::r90 || rot == fr::hal::Rotation::r270;
        CHECK_EQ(r.be.frame().width(), quarter ? 300 : 400);
        r.text(3, 5, "R");        // not symmetric
        r.fill(0, 0, 1, 1, 0);    // the top-left corner
        r.run();
        CHECK(r.glass_is_frame());
        r.fill(17, 33, 5, 9, 0x000000);
        r.run();
        CHECK_EQ(r.events.back().mode, Mode::partial);
        CHECK(r.glass_is_frame());
        // The reported area covers the change (in the rotated frame).
        const auto &e = r.events.back();
        CHECK(e.x <= 17 && e.y <= 33 && e.x + e.w >= 22 && e.y + e.h >= 42);
        CHECK_EQ(r.panel.bad_windows, 0);
    }
}

TEST(epaper_drawing_between_chunks_lands_in_the_next_refresh)
{
    Rig r;
    r.boot();
    r.text(0, 0, "a");
    r.run();
    // A change over the whole height: many chunks. Half-way through the next plane's, a command draws on rows already
    // sent and on rows not sent yet.
    const int chunks = r.panel.chunks;
    bool drew = false;
    r.panel.on_write = [&](int n) {
        if (!drew && n == chunks + 20 && r.be.phase() == Phase::writing) {
            drew = true;
            r.fill(0, 0, 400, 2, 0xFFFFFF);
            r.fill(0, 298, 400, 2, 0xFFFFFF);
        }
    };
    r.fill(0, 0, 400, 300, 0x000000);
    r.run();
    REQUIRE(drew);
    r.panel.on_write = nullptr;
    CHECK(r.glass_is_frame());  // the second refresh brought the rows written too early
    CHECK_EQ(r.be.shown_crc(), fr::display::crc32(r.be.frame().pixels()));
}

TEST(epaper_bitmap_clips_and_maps_colours)
{
    Rig r;
    r.boot();
    // 10 x 2, rows of 2 bytes: 0b1010'1010 0b11xx'xxxx / 0x00 0x00.
    const uint8_t data[] = {0xAA, 0xC0, 0x00, 0x00};
    fr::cap::DisplayBitmapArgs a;
    a.x = 396;
    a.y = 299;
    a.w = 10;
    a.h = 2;
    a.data = data;
    a.color = 0xFFFFFF;
    a.bg = 0x000000;
    CHECK(r.be.bitmap(a));
    CHECK_EQ(r.be.frame().pixel(396, 299), true);
    CHECK_EQ(r.be.frame().pixel(397, 299), false);
    CHECK_EQ(r.be.frame().pixel(398, 299), true);
    a.x = 0;
    a.y = 0;
    a.color = 0x000000;  // inverted: a 1 is ink
    a.bg = 0xFFFFFF;
    CHECK(r.be.bitmap(a));
    CHECK_EQ(r.be.frame().pixel(0, 0), false);
    CHECK_EQ(r.be.frame().pixel(1, 0), true);
    CHECK_EQ(r.be.frame().pixel(8, 0), false);
    CHECK_EQ(r.be.frame().pixel(0, 1), true);
    const uint8_t short_data[] = {0xFF};
    a.data = short_data;
    CHECK_EQ(r.be.bitmap(a).error(), fr::Err::invalid_args);
    r.run();
    CHECK(r.glass_is_frame());
}

TEST(epaper_snapshot_freezes_the_frame)
{
    Rig r;
    r.boot();
    r.text(0, 0, "snap");
    auto s = r.be.snapshot();
    REQUIRE(s);
    CHECK_EQ(s->width, 400);
    CHECK_EQ(s->height, 300);
    CHECK_EQ(s->bytes, 15000u);
    CHECK(s->format == fr::cap::DisplayColorFormat::mono1);
    CHECK_EQ(s->crc, fr::display::crc32(r.be.frame().pixels()));
    r.fill(0, 0, 400, 300, 0x000000);
    uint8_t buf[16];
    auto n = r.be.snapshot_read(0, buf);
    REQUIRE(n);
    CHECK_EQ(*n, 16u);
    CHECK(buf[15] == 0xFF);  // the frozen frame: white where the text is not
    CHECK_EQ(r.be.snapshot_read(15001, buf).error(), fr::Err::invalid_args);

    Rig no(defaults(), fr::hal::Rotation::r0, false);  // a release build: no frozen frame
    no.boot();
    CHECK_EQ(no.be.snapshot().error(), fr::Err::unsupported);
}

TEST(epaper_backend_refuses_a_bad_setup)
{
    Rig r;
    REQUIRE(r.panel.init(r.core, fr::hal::Rotation::r0));
    FakeEpaper other;
    CHECK_EQ(r.be.init(other, r.cfg, r.core, {}).error(), fr::Err::invalid_args);  // not its panel
    std::vector<uint8_t> small(100);
    EpaperBackend tiny(r.panel, {small, small, {}});
    CHECK_EQ(tiny.init(r.panel, r.cfg, r.core, {}).error(), fr::Err::invalid_args);  // frames too small
    // Before init, drawing fails.
    EpaperBackend idle(r.panel, {r.frame_buf, r.shown_buf, {}});
    CHECK_EQ(idle.clear(0xFFFFFF).error(), fr::Err::failed);
    CHECK_EQ(idle.refresh(Mode::auto_).error(), fr::Err::failed);
}


TEST(epaper_a_big_change_then_small_ones_leaves_no_old_picture)
{
    // The bench's case (design face-f1 §17): a card over the whole face, the face back, then three changes in the
    // wave's box. With RAMs that trade places after each partial, writing only the change would bring the card back
    // around the box from the RAM that held it two refreshes before.
    Rig r;
    r.boot();
    r.fill(0, 0, 400, 300, 0xFFFFFF);
    r.fill(10, 10, 40, 20, 0x000000);  // a corner value
    r.run();
    r.fill(0, 0, 400, 300, 0xFFFFFF);
    r.fill(100, 12, 200, 10, 0x000000);  // the card's header
    r.run();
    r.fill(0, 0, 400, 300, 0xFFFFFF);
    r.fill(10, 10, 40, 20, 0x000000);  // the face again
    r.run();
    REQUIRE(r.glass_is_frame());
    for (int i = 0; i < 3; ++i) {
        r.fill(150, 120, 100, 60, i % 2 == 0 ? 0x000000 : 0xFFFFFF);  // the wave's box only
        r.run();
        CHECK(r.glass_is_frame());
    }
}

/**
 * A face's way of drawing (design face-f1 §17 bench): whole-screen changes and box-sized ones, at any moment of a
 * refresh (between chunks, while BUSY, in the burst), with c6e-paper's settings; whenever nothing waits, the glass is
 * the frame. On a controller whose RAMs trade places after a partial (the real one) and on one that keeps them.
 */
static void random_draws(bool ping_pong)
{
    fr::cap::DisplayConfig c = defaults();
    c.full_every = 60;
    c.clean = Mode::fast;
    c.burst_ms = 1000;
    Rig r(c);
    r.panel.ping_pong = ping_pong;
    r.boot();
    uint32_t seed = 12345;
    auto rnd = [&](uint32_t n) {
        seed = seed * 1664525u + 1013904223u;
        return (seed >> 8) % n;
    };
    auto draw = [&] {
        if (rnd(3) == 0) {
            r.fill(0, 0, 400, 300, 0xFFFFFF);  // a new screen
            for (int i = 0; i < 6; ++i) {
                r.fill(static_cast<int16_t>(8 + rnd(300)), static_cast<int16_t>(8 + rnd(260)), static_cast<uint16_t>(8 + rnd(80)),
                       static_cast<uint16_t>(4 + rnd(20)), 0x000000);
            }
        } else {
            r.fill(72, 28, 256, 244, 0xFFFFFF);  // the wave's box redrawn
            r.fill(static_cast<int16_t>(80 + rnd(200)), static_cast<int16_t>(30 + rnd(200)), static_cast<uint16_t>(8 + rnd(40)),
                   static_cast<uint16_t>(8 + rnd(40)), 0x000000);
        }
    };
    int mid_write = 0;
    r.panel.on_write = [&](int) {
        if (r.be.phase() == Phase::writing && rnd(40) == 0) {
            ++mid_write;
            draw();
        }
    };
    int bad = 0;
    for (int round = 0; round < 300; ++round) {
        draw();
        // Run a random while, BUSY steps ending 362 ms after they start, drawing again now and then (also while BUSY).
        const uint32_t ms = rnd(900);
        for (uint32_t t = 0; t < ms; ++t) {
            if (r.panel.busy() && !r.panel.asleep && r.core.now() >= r.panel_busy_since + 362'000) {
                r.panel.finish(r.core.now());
            }
            if (!r.panel.busy() || r.panel.asleep) {
                r.panel_busy_since = r.core.now();
            }
            r.core.advance_ms(1);
            r.core.run_ready();
            if (rnd(500) == 0) {
                draw();
            }
        }
        if (rnd(4) == 0) {
            r.run(362);
            if (!r.glass_is_frame()) {
                ++bad;
            }
        }
    }
    r.run(362);
    CHECK(r.glass_is_frame());
    CHECK_EQ(bad, 0);
    CHECK(mid_write > 0);
}

TEST(epaper_random_draws_at_any_moment_always_end_on_the_glass)
{
    random_draws(true);
}

TEST(epaper_random_draws_end_on_the_glass_of_a_controller_that_keeps_its_rams)
{
    random_draws(false);
}
