// fr::WallClock (fr/wall_clock.hpp, design face-f1 D1). IDF-free.
#include "fr/wall_clock.hpp"

namespace fr {

const char *time_source_name(TimeSource s)
{
    switch (s) {
    case TimeSource::carried: return "carried";
    case TimeSource::rtc: return "rtc";
    case TimeSource::hub: return "hub";
    case TimeSource::none: break;
    }
    return "none";
}

bool WallClock::take(TimeUs at, int64_t offset, TimeSource src)
{
    const bool quiet = src == src_ && offset - offset_ < kQuietUs && offset_ - offset < kQuietUs;
    offset_ = offset;
    src_ = src;
    set_at_ = at;
    if (quiet) {
        return true;
    }
    ++taken_;
    hook_(at, at + offset, src);
    listener_();
    return true;
}

bool WallClock::set(TimeUs at, int64_t unix_us, TimeSource src)
{
    if (src == TimeSource::none) {
        return false;
    }
    const bool stale = at - set_at_ > kStaleUs;
    if (src_ != TimeSource::none && src < src_ && !stale) {
        return false;
    }
    return take(at, unix_us - at, src);
}

bool WallClock::hub_sample(TimeUs rx_at, int64_t hub_us)
{
    if (hub_us <= 0) {
        return false;  // a hub that sent no time (0)
    }
    const int64_t offset = hub_us - rx_at;  // the true offset is this plus the frame's one-way delay
    if (src_ == TimeSource::hub) {
        const TimeUs since = rx_at - hub_best_at_;
        const int64_t floor = hub_best_ - since * kDriftPpm / 1'000'000;
        if (offset < floor && since < kHubResetUs) {
            return false;  // a later sample that waited longer on the way
        }
    }
    hub_best_ = offset;
    hub_best_at_ = rx_at;
    return take(rx_at, offset, TimeSource::hub);
}

WallClock &wall_clock()
{
    static WallClock clock;
    return clock;
}

}  // namespace fr
