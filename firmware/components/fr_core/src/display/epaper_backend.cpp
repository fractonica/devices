// fr:realtime
#include "fr/display/epaper_backend.hpp"

#include <algorithm>
#include <cstring>
#include <limits>

namespace fr::display {
namespace {

using Op = hal::Epaper::Op;
using Plane = hal::Epaper::Plane;
using Mode = cap::DisplayRefreshMode;

constexpr TimeUs kNever = std::numeric_limits<TimeUs>::max();

constexpr TimeUs ms_us(uint32_t ms)
{
    return static_cast<TimeUs>(ms) * 1000;
}

}  // namespace

EpaperBackend::Rank EpaperBackend::rank_of(Mode m)
{
    switch (m) {
    case Mode::auto_:
        return Rank::auto_;
    case Mode::partial:
        return Rank::partial;
    case Mode::fast:
        return Rank::fast;
    case Mode::full:
        return Rank::full;
    }
    return Rank::auto_;
}

Mode EpaperBackend::clean_mode() const
{
    return cfg_.clean == Mode::fast ? Mode::fast : Mode::full;
}

Mode EpaperBackend::resolve(Rank r) const
{
    switch (r) {
    case Rank::full:
        return Mode::full;
    case Rank::fast:
        return Mode::fast;
    case Rank::partial:
        return glass_known_ ? Mode::partial : Mode::full;
    case Rank::auto_:
    case Rank::none:
        break;
    }
    if (!glass_known_) {
        return Mode::full;
    }
    if (cfg_.full_every > 0 && partials_ >= cfg_.full_every) {
        return clean_mode();
    }
    return Mode::partial;
}

Status EpaperBackend::init(hal::Display &panel, const cap::DisplayConfig &cfg, Core &core, UiEventSink sink)
{
    static_cast<void>(sink);  // no widgets, so no ui events
    if (&panel != static_cast<hal::Display *>(&panel_)) {
        return std::unexpected(Err::invalid_args);
    }
    const uint16_t w = panel_.width();
    const uint16_t h = panel_.height();
    const size_t need = MonoCanvas::stride_of(w) * h;
    if (w == 0 || h == 0 || buf_.frame.size() < need || buf_.shown.size() < need) {
        return std::unexpected(Err::invalid_args);
    }
    if (panel_.native_width() % 8 != 0) {
        return std::unexpected(Err::unsupported);  // the controller addresses its rows in whole bytes
    }
    timer_ = core.timer([this] { on_timer(); });
    if (timer_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    core_ = &core;
    cfg_ = cfg;
    rot_ = panel_.rotation();
    frame_.attach(buf_.frame, w, h);
    shown_.attach(buf_.shown, w, h);
    std::fill(buf_.frame.begin(), buf_.frame.begin() + static_cast<std::ptrdiff_t>(need), uint8_t{0});
    std::fill(buf_.shown.begin(), buf_.shown.begin() + static_cast<std::ptrdiff_t>(need), uint8_t{0});
    frame_.fill(0, 0, w, h, true);  // white paper; the padding bits stay 0
    shown_.fill(0, 0, w, h, true);
    panel_.on_idle([this](TimeUs at) { on_idle(at); });

    const TimeUs now = core.now();
    awake_ = panel_.answered();
    glass_known_ = false;  // the glass keeps its old picture (boot_clear false) or is about to be cleared
    ram_synced_ = false;
    last_active_ = now;
    last_clean_ = now;
    if (cfg_.boot_clear) {
        pending_ = Rank::full;
    }
    if (!awake_) {
        begin_wake();  // the controller's reset and set-up, right after boot (the driver's init touched no controller)
    } else {
        kick();
    }
    return {};
}

Status EpaperBackend::clear(uint32_t rgb)
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    drew(frame_.fill(0, 0, frame_.width(), frame_.height(), mono_lit(rgb)));
    return {};
}

Status EpaperBackend::text(const cap::DisplayTextArgs &a)
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    drew(frame_.text(a));
    return {};
}

Status EpaperBackend::fill_rect(const cap::DisplayFillRectArgs &a)
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    drew(frame_.fill(a.x, a.y, a.w, a.h, mono_lit(a.color)));
    return {};
}

Status EpaperBackend::bitmap(const cap::DisplayBitmapArgs &a)
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const auto box = frame_.bitmap(a);
    if (!box) {
        return std::unexpected(box.error());
    }
    drew(*box);
    return {};
}

Status EpaperBackend::paint(const Box &box, PaintFn fn)
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    Box b{std::max(box.x0, 0), std::max(box.y0, 0), std::min(box.x1, frame_.width() - 1),
          std::min(box.y1, frame_.height() - 1)};
    if (b.empty()) {
        return {};
    }
    fn(frame_, b);
    drew(b);
    return {};
}

EpaperBackend::Carry EpaperBackend::carry() const
{
    const TimeUs now = core_ != nullptr ? core_->now() : 0;
    return {.partials = partials_, .clean_age_s = static_cast<uint32_t>(std::max<TimeUs>(0, now - last_clean_) / 1'000'000)};
}

Status EpaperBackend::adopt_glass(std::span<const uint8_t> glass, const Carry &c)
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const size_t n = frame_.bytes();
    if (glass.size() != n) {
        return std::unexpected(Err::invalid_args);
    }
    std::copy(glass.begin(), glass.end(), frame_.pixels().begin());
    std::copy(glass.begin(), glass.end(), shown_.pixels().begin());
    glass_known_ = true;
    ram_synced_ = false;
    shown_crc_ = crc32(shown_.pixels());
    partials_ = c.partials;
    last_clean_ = core_->now() - static_cast<TimeUs>(c.clean_age_s) * 1'000'000;
    kick();
    return {};
}

void EpaperBackend::set_sleep_soon(bool on)
{
    sleep_soon_ = on;
    kick();
}

std::expected<cap::DisplayRefreshResult, Err> EpaperBackend::refresh(Mode mode)
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const Rank r = std::max(pending_, rank_of(mode));
    const bool changed = !diff().empty();
    hold_until_ = 0;  // a refresh ends a hold
    dirty_ = false;   // what was drawn is covered by this request
    // auto and partial with nothing to show do nothing (begin_refresh would drop them too); fast and full always run.
    pending_ = (r <= Rank::partial && !changed && pending_ == Rank::none) ? Rank::none : r;
    const cap::DisplayRefreshResult res{.mode = resolve(r), .changed = changed};
    kick();
    return res;
}

Status EpaperBackend::hold(uint16_t ms)
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    hold_until_ = ms == 0 ? 0 : core_->now() + ms_us(ms);
    kick();
    return {};
}

bool EpaperBackend::settled() const
{
    return (phase_ == Phase::idle || phase_ == Phase::asleep) && pending_ == Rank::none && !dirty_;
}

void EpaperBackend::drew(const Box &b)
{
    if (b.empty()) {
        return;
    }
    dirty_ = true;
    last_draw_ = core_->now();
    kick();
}

// ---- The scheduler ----------------------------------------------------------------------------------------------

void EpaperBackend::kick()
{
    if (core_ == nullptr || (phase_ != Phase::idle && phase_ != Phase::asleep)) {
        return;  // a step is in flight; its end calls kick() again
    }
    const TimeUs now = core_->now();
    const bool held = now < hold_until_;
    if (dirty_ && !held && now >= last_draw_ + ms_us(cfg_.settle_ms)) {
        pending_ = std::max(pending_, Rank::auto_);
        dirty_ = false;
    }
    if (glass_known_ && cfg_.clean_hours > 0 &&
        now >= last_clean_ + static_cast<TimeUs>(cfg_.clean_hours) * 3'600'000'000LL) {
        pending_ = std::max(pending_, rank_of(clean_mode()));
    }
    if (pending_ != Rank::none && (!started_once_ || now >= last_start_ + ms_us(cfg_.flush_ms))) {
        if (!awake_) {
            begin_wake();
            return;
        }
        if (begin_refresh()) {
            return;
        }
    }
    // The high voltage goes off, and the controller to sleep, only when nothing is about to be shown.
    const bool quiet = pending_ == Rank::none && !dirty_;
    const TimeUs burst_us = sleep_soon_ ? 0 : ms_us(cfg_.burst_ms);
    if (quiet && phase_ == Phase::idle && awake_ && hv_on_ && now >= last_end_ + burst_us) {
        start_op(Op::power_off, Phase::powering_off);
        return;
    }
    if (quiet && phase_ == Phase::idle && awake_ && !hv_on_ && (cfg_.sleep_s > 0 || sleep_soon_) &&
        now >= last_active_ + (sleep_soon_ ? 0 : static_cast<TimeUs>(cfg_.sleep_s) * 1'000'000)) {
        if (panel_.sleep()) {
            ++counters_.sleeps;
        }
        // Either way the controller is reset before its next step.
        awake_ = false;
        ram_synced_ = false;
        phase_ = Phase::asleep;
        asleep_hook_();
    }
    arm(now);
}

void EpaperBackend::arm(TimeUs now)
{
    TimeUs next = kNever;
    if (dirty_) {
        next = std::min(next, now < hold_until_ ? hold_until_ : last_draw_ + ms_us(cfg_.settle_ms));
    }
    if (pending_ != Rank::none) {
        next = std::min(next, last_start_ + ms_us(cfg_.flush_ms));
    }
    // As kick(): the burst's end and the sleep only count when nothing is about to be shown (no timer spins on a
    // deadline kick() would skip).
    const bool quiet = pending_ == Rank::none && !dirty_;
    if (quiet && phase_ == Phase::idle && awake_ && hv_on_) {
        next = std::min(next, last_end_ + (sleep_soon_ ? 0 : ms_us(cfg_.burst_ms)));
    } else if (quiet && phase_ == Phase::idle && awake_ && (cfg_.sleep_s > 0 || sleep_soon_)) {
        next = std::min(next, last_active_ + (sleep_soon_ ? 0 : static_cast<TimeUs>(cfg_.sleep_s) * 1'000'000));
    }
    if (glass_known_ && cfg_.clean_hours > 0) {
        next = std::min(next, last_clean_ + static_cast<TimeUs>(cfg_.clean_hours) * 3'600'000'000LL);
    }
    if (next == kNever) {
        timer_->stop();
        return;
    }
    const TimeUs wait = std::clamp<TimeUs>(next - now, 0, kMaxArmUs);
    timer_->start(static_cast<uint32_t>(wait));
}

void EpaperBackend::on_timer()
{
    switch (phase_) {
    case Phase::idle:
    case Phase::asleep:
        kick();
        return;
    case Phase::reset_low:
        if (!panel_.hold_reset(false)) {
            fail();
            return;
        }
        phase_ = Phase::reset_high;
        timer_->start(kResetWaitUs);
        return;
    case Phase::reset_high:
        start_op(Op::soft_reset, Phase::soft_reset);
        return;
    case Phase::writing:
        write_chunk();
        return;
    case Phase::soft_reset:
    case Phase::refreshing:
    case Phase::powering_off:
        // The step's timeout. A panel that answered and is no longer busy only had its edge missed.
        if (panel_.answered() && !panel_.busy()) {
            ++counters_.late_idle;
            on_idle(core_->now());
        } else {
            fail();
        }
        return;
    }
}

void EpaperBackend::on_idle(TimeUs at)
{
    if (at < op_started_) {
        return;  // an edge from before this step
    }
    switch (phase_) {
    case Phase::soft_reset:
        timer_->stop();
        if (!panel_.configure()) {
            fail();
            return;
        }
        ++counters_.wakes;
        awake_ = true;
        hv_on_ = false;
        ram_synced_ = false;
        last_active_ = at;
        phase_ = Phase::idle;
        kick();
        return;
    case Phase::refreshing:
        timer_->stop();
        finish_refresh(at);
        return;
    case Phase::powering_off:
        timer_->stop();
        hv_on_ = false;
        last_active_ = at;
        phase_ = Phase::idle;
        kick();
        return;
    default:
        return;
    }
}

void EpaperBackend::begin_wake()
{
    wake_for_refresh_ = pending_ != Rank::none;
    mode_ = resolve(pending_);
    phase_ = Phase::reset_low;
    hv_on_ = false;
    if (!panel_.hold_reset(true)) {
        fail();
        return;
    }
    timer_->start(kResetLowUs);
}

bool EpaperBackend::begin_refresh()
{
    const Rank r = pending_;
    const Mode mode = resolve(r);
    const Box d = diff();
    if (r <= Rank::partial && d.empty()) {
        pending_ = Rank::none;  // auto or partial with nothing to show
        return false;
    }
    pending_ = Rank::none;
    mode_ = mode;
    const Box all = native_all();
    if (mode == Mode::partial) {
        changed_ = to_native(d);
        // Both RAMs over the change and the last partial's change (stale_): whichever RAM the controller reads as the
        // old picture or the new one, both then hold `shown` everywhere but in the change, where `next` holds the frame.
        // Writing only the change into `next` brought back, on the real panel, a picture from two refreshes before
        // around a small change (its RAMs trade places after a partial; design face-f1 §17).
        Box win = ram_synced_ ? stale_ : all;
        win.add(changed_);
        // prev first: it reads `shown` before the next plane's write copies the new pixels into it.
        jobs_[0] = {Plane::prev, win, false};
        jobs_[1] = {Plane::next, win, true};
        moved_ = {};
    } else {
        changed_ = all;
        jobs_[0] = {Plane::next, all, true};
        jobs_[1] = {Plane::prev, all, false};  // from shown, which now holds exactly what went to `next`
    }
    njobs_ = 2;
    job_ = 0;
    last_start_ = core_->now();
    started_once_ = true;
    phase_ = Phase::writing;
    begin_job();
    return true;
}

void EpaperBackend::begin_job()
{
    const Job &j = jobs_[job_];
    if (!panel_.write_begin(j.plane, static_cast<uint16_t>(j.win.x0), static_cast<uint16_t>(j.win.y0),
                            static_cast<uint16_t>(j.win.w()), static_cast<uint16_t>(j.win.h()))) {
        fail();
        return;
    }
    row_ = j.win.y0;
    timer_->start(0);
}

void EpaperBackend::write_chunk()
{
    const Job &j = jobs_[job_];
    const int w8 = j.win.w() / 8;
    const int rows = std::max(1, static_cast<int>(kChunk) / w8);
    const int end = std::min(j.win.y1 + 1, row_ + rows);
    const MonoCanvas &src = j.from_frame ? frame_ : shown_;
    size_t n = 0;
    for (int ny = row_; ny < end; ++ny) {
        if (rot_ == hal::Rotation::r0) {
            // The frame's rows are the panel's: whole bytes at once.
            const size_t off = static_cast<size_t>(ny) * src.stride() + static_cast<size_t>(j.win.x0 / 8);
            std::memcpy(chunk_ + n, src.pixels().data() + off, static_cast<size_t>(w8));
            if (j.from_frame) {
                uint8_t *old = shown_.pixels().data() + off;
                for (int b = 0; b < w8; ++b) {
                    if (old[b] != chunk_[n + static_cast<size_t>(b)]) {
                        int e = w8 - 1;
                        while (old[e] == chunk_[n + static_cast<size_t>(e)]) {
                            --e;
                        }
                        moved_.add({j.win.x0 + b * 8, ny, j.win.x0 + e * 8 + 7, ny});
                        break;
                    }
                }
                std::memcpy(old, chunk_ + n, static_cast<size_t>(w8));
            }
            n += static_cast<size_t>(w8);
            continue;
        }
        for (int b = 0; b < w8; ++b) {
            uint8_t byte = 0;
            for (int bit = 0; bit < 8; ++bit) {
                int lx = 0;
                int ly = 0;
                logical_of(j.win.x0 + b * 8 + bit, ny, lx, ly);
                const bool on = src.pixel(lx, ly);
                if (j.from_frame && lx >= 0 && ly >= 0 && lx < shown_.width() && ly < shown_.height()) {
                    if (shown_.pixel(lx, ly) != on) {
                        moved_.add({j.win.x0 + b * 8 + bit, ny, j.win.x0 + b * 8 + bit, ny});
                    }
                    shown_.set(lx, ly, on);
                }
                if (on) {
                    byte = static_cast<uint8_t>(byte | (0x80u >> bit));
                }
            }
            chunk_[n++] = byte;
        }
    }
    if (!panel_.write({chunk_, n})) {
        fail();
        return;
    }
    row_ = end;
    if (row_ <= j.win.y1) {
        timer_->start(0);  // the next chunk after the core task's other work
        return;
    }
    if (++job_ < njobs_) {
        begin_job();
        return;
    }
    switch (mode_) {
    case Mode::full:
        start_op(Op::full, Phase::refreshing);
        return;
    case Mode::fast:
        start_op(Op::fast, Phase::refreshing);
        return;
    default:
        start_op(cfg_.burst_ms > 0 ? Op::partial_hold : Op::partial, Phase::refreshing);
        return;
    }
}

void EpaperBackend::start_op(Op op, Phase phase)
{
    op_ = op;
    op_started_ = core_->now();
    phase_ = phase;
    if (!panel_.start(op)) {
        fail();
        return;
    }
    timer_->start(panel_.timeout_us(op));
}

void EpaperBackend::finish_refresh(TimeUs at)
{
    const TimeUs took = (at - op_started_ + 500) / 1000;
    const auto ms = static_cast<uint16_t>(std::clamp<TimeUs>(took, 0, 65535));
    refresh_ms_ = ms;
    if (mode_ == Mode::partial) {
        partials_ = static_cast<uint8_t>(std::min(255, partials_ + 1));
        stale_ = moved_;  // one RAM holds the picture from before this change there (whole bytes)
        hv_on_ = op_ == Op::partial_hold;
        ++counters_.partial;
    } else {
        partials_ = 0;
        stale_ = {};
        hv_on_ = false;
        last_clean_ = at;
        ++(mode_ == Mode::full ? counters_.full : counters_.fast);
    }
    ram_synced_ = true;
    glass_known_ = true;
    shown_crc_ = crc32(shown_.pixels());
    last_end_ = at;
    last_active_ = at;
    phase_ = Phase::idle;
    report(true, ms);
    kick();
}

void EpaperBackend::fail()
{
    const Phase was = phase_;
    if (timer_ != nullptr) {
        timer_->stop();
    }
    ++counters_.failed;
    awake_ = false;  // reset before the next step
    hv_on_ = false;
    ram_synced_ = false;
    if (was == Phase::writing || was == Phase::refreshing) {
        glass_known_ = false;  // the glass may show anything now: the next refresh is full
    }
    // A refresh was asked (or running): it ends with refreshed {ok: false}. A reset at boot or after a sleep with
    // nothing to show, or a power-off, fails quietly (the selftest says why).
    const bool waking = was == Phase::reset_low || was == Phase::reset_high || was == Phase::soft_reset;
    const bool refreshing = was == Phase::writing || was == Phase::refreshing || (waking && wake_for_refresh_);
    const TimeUs now = core_->now();
    const TimeUs took = (now - op_started_ + 500) / 1000;
    pending_ = Rank::none;  // nothing retries by itself
    last_active_ = now;
    last_clean_ = now;  // nor does the 24 h clean, which would otherwise be due again at once
    phase_ = Phase::idle;
    if (refreshing) {
        if (was != Phase::writing && was != Phase::refreshing) {
            changed_ = {};  // a wake that failed: nothing was written
        }
        report(false, was == Phase::refreshing ? static_cast<uint16_t>(std::clamp<TimeUs>(took, 0, 65535)) : 0);
    }
    arm(now);
}

void EpaperBackend::report(bool ok, uint16_t ms)
{
    const Box l = changed_.empty() ? Box{} : to_logical(changed_);
    const cap::DisplayRefreshed e{.mode = mode_,
                                  .ok = ok,
                                  .ms = ms,
                                  .partials = partials_,
                                  .x = static_cast<uint16_t>(l.empty() ? 0 : l.x0),
                                  .y = static_cast<uint16_t>(l.empty() ? 0 : l.y0),
                                  .w = static_cast<uint16_t>(l.w()),
                                  .h = static_cast<uint16_t>(l.h()),
                                  .crc = shown_crc()};
    if (sink_) {
        sink_(e);
    }
}

// ---- Geometry -----------------------------------------------------------------------------------------------------

Box EpaperBackend::diff() const
{
    Box d;
    const size_t stride = frame_.stride();
    const uint8_t *a = frame_.pixels().data();
    const uint8_t *b = shown_.pixels().data();
    for (int y = 0; y < frame_.height(); ++y) {
        const uint8_t *ra = a + static_cast<size_t>(y) * stride;
        const uint8_t *rb = b + static_cast<size_t>(y) * stride;
        if (std::memcmp(ra, rb, stride) == 0) {
            continue;
        }
        int first = 0;
        while (ra[first] == rb[first]) {
            ++first;
        }
        int last = static_cast<int>(stride) - 1;
        while (ra[last] == rb[last]) {
            --last;
        }
        d.add({first * 8, y, std::min(last * 8 + 7, frame_.width() - 1), y});
    }
    return d;
}

void EpaperBackend::native_of(int lx, int ly, int &nx, int &ny) const
{
    const int nw = panel_.native_width();
    const int nh = panel_.native_height();
    switch (rot_) {
    case hal::Rotation::r0:
        nx = lx;
        ny = ly;
        return;
    case hal::Rotation::r90:
        nx = nw - 1 - ly;
        ny = lx;
        return;
    case hal::Rotation::r180:
        nx = nw - 1 - lx;
        ny = nh - 1 - ly;
        return;
    case hal::Rotation::r270:
        nx = ly;
        ny = nh - 1 - lx;
        return;
    }
}

void EpaperBackend::logical_of(int nx, int ny, int &lx, int &ly) const
{
    const int nw = panel_.native_width();
    const int nh = panel_.native_height();
    switch (rot_) {
    case hal::Rotation::r0:
        lx = nx;
        ly = ny;
        return;
    case hal::Rotation::r90:
        lx = ny;
        ly = nw - 1 - nx;
        return;
    case hal::Rotation::r180:
        lx = nw - 1 - nx;
        ly = nh - 1 - ny;
        return;
    case hal::Rotation::r270:
        lx = nh - 1 - ny;
        ly = nx;
        return;
    }
}

Box EpaperBackend::to_native(const Box &b) const
{
    if (b.empty()) {
        return {};
    }
    int ax = 0;
    int ay = 0;
    int bx = 0;
    int by = 0;
    native_of(b.x0, b.y0, ax, ay);
    native_of(b.x1, b.y1, bx, by);
    const int nw = panel_.native_width();
    Box n{std::min(ax, bx), std::min(ay, by), std::max(ax, bx), std::max(ay, by)};
    n.x0 = n.x0 / 8 * 8;
    n.x1 = std::min(n.x1 / 8 * 8 + 7, nw - 1);
    return n;
}

Box EpaperBackend::to_logical(const Box &n) const
{
    int ax = 0;
    int ay = 0;
    int bx = 0;
    int by = 0;
    logical_of(n.x0, n.y0, ax, ay);
    logical_of(n.x1, n.y1, bx, by);
    Box l{std::max(0, std::min(ax, bx)), std::max(0, std::min(ay, by)), std::min(frame_.width() - 1, std::max(ax, bx)),
          std::min(frame_.height() - 1, std::max(ay, by))};
    return l;
}

// ---- Snapshot ------------------------------------------------------------------------------------------------------

std::expected<Snapshot, Err> EpaperBackend::snapshot()
{
    if (core_ == nullptr) {
        return std::unexpected(Err::failed);
    }
    const size_t n = frame_.bytes();
    if (buf_.frozen.size() < n) {
        return std::unexpected(Err::unsupported);
    }
    std::memcpy(buf_.frozen.data(), frame_.pixels().data(), n);
    frozen_bytes_ = static_cast<uint32_t>(n);
    has_frozen_ = true;
    return Snapshot{.crc = crc32({buf_.frozen.data(), n}),
                    .width = frame_.width(),
                    .height = frame_.height(),
                    .format = cap::DisplayColorFormat::mono1,
                    .bytes = frozen_bytes_};
}

std::expected<size_t, Err> EpaperBackend::snapshot_read(uint32_t offset, std::span<uint8_t> out)
{
    if (!has_frozen_) {
        return std::unexpected(Err::failed);
    }
    if (offset > frozen_bytes_) {
        return std::unexpected(Err::invalid_args);
    }
    const size_t n = std::min<size_t>(out.size(), frozen_bytes_ - offset);
    std::memcpy(out.data(), buf_.frozen.data() + offset, n);
    return n;
}

}  // namespace fr::display
