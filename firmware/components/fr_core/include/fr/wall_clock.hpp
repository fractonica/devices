// The node's wall clock (design face-f1 D1): Unix time as an offset from the core's monotonic clock, set by whichever
// source is best. The hub's time comes with no protocol change: fr_net hands over the hub's Unix µs from WELCOME and
// BEACON (`hub_time_us`) and from every TIME.SYNC_REQ (`t1`) with the node time the frame reached its link. The
// one-way delay only makes a sample late, so the least-delayed sample wins: a sample is taken when it implies a time
// no earlier than the best so far, less what the two crystals may drift apart since (kDriftPpm). An RTC (fr.rtc's
// DS3231) seeds it at boot and at each rollover it sees; it gives way to the hub. The ESP runtime installs a hook that
// sets the system clock (settimeofday) and a marker in RTC no-init memory, and at boot after a software reset or a
// deep-sleep wake carries the system time over as `carried`. IDF-free; every call is for the core task.
#pragma once

#include <cstdint>
#include <optional>

#include "fr/base.hpp"

namespace fr {

/** Where the wall clock's time came from, ranked: a source gives way only to one of the same rank or higher. */
enum class TimeSource : uint8_t { none = 0, carried = 1, rtc = 2, hub = 3 };

const char *time_source_name(TimeSource s);

class WallClock
{
public:
    /** Called with each time taken (Unix µs at node time `at`) and its source: the ESP runtime's settimeofday. */
    using Hook = Callback<void(TimeUs at, int64_t unix_us, TimeSource src), 16>;
    /** Called after each time taken (the face redraws when the time first arrives or steps). */
    using Listener = Callback<void(), 16>;

    /** A source older than this gives way to any other (a hub gone for an hour: the RTC is the better clock). */
    static constexpr TimeUs kStaleUs = 3600LL * 1'000'000;
    /** How far apart two crystals may drift (ppm): the allowance a later hub sample gets against the best one. */
    static constexpr int64_t kDriftPpm = 100;
    /** A hub sample that is never good enough for this long is taken anyway (the hub's own clock stepped back). */
    static constexpr TimeUs kHubResetUs = 10LL * 60 * 1'000'000;
    /** A change smaller than this from the same source is kept without calling the hook. */
    static constexpr int64_t kQuietUs = 1000;

    void set_hook(Hook h) { hook_ = h; }
    void set_listener(Listener l) { listener_ = l; }

    bool valid() const { return src_ != TimeSource::none; }
    TimeSource source() const { return src_; }
    /** Node time of the last time taken. */
    TimeUs set_at() const { return set_at_; }
    /** Unix µs at node time `now`; nullopt while no source has set it. */
    std::optional<int64_t> unix_at(TimeUs now) const
    {
        if (!valid()) {
            return std::nullopt;
        }
        return now + offset_;
    }

    /**
     * A source's reading: Unix µs `unix_us` at node time `at`. Taken when the clock is unset, the source ranks at least
     * as high as the current one, or the current one is older than kStaleUs. Returns true when taken.
     */
    bool set(TimeUs at, int64_t unix_us, TimeSource src);

    /** One hub sample: the hub's Unix µs `hub_us` when it sent a frame that reached the node at `rx_at`. */
    bool hub_sample(TimeUs rx_at, int64_t hub_us);

    /** Times taken so far (each a call of the hook). */
    uint32_t taken() const { return taken_; }

    /** Back to unset (host tests; a node never forgets its time). */
    void reset() { *this = WallClock{}; }

private:
    bool take(TimeUs at, int64_t offset, TimeSource src);

    int64_t offset_ = 0;  // Unix µs - node µs
    TimeSource src_ = TimeSource::none;
    TimeUs set_at_ = 0;
    int64_t hub_best_ = 0;  // the hub sample's offset taken last
    TimeUs hub_best_at_ = 0;
    uint32_t taken_ = 0;
    Hook hook_;
    Listener listener_;
};

/** The node's one wall clock. */
WallClock &wall_clock();

}  // namespace fr
