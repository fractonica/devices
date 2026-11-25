// fr::WallClock (design face-f1 D1): ranking of sources, the hub samples' least-delay filter, the hook and listener.
#include <cstdint>
#include <string>
#include <vector>

#include "fr/wall_clock.hpp"
#include "tests/test.hpp"

using fr::TimeSource;
using fr::TimeUs;
using fr::WallClock;

namespace {

constexpr int64_t kUnix = 1'800'000'000LL * 1'000'000;  // 2027-01-15, in µs
constexpr TimeUs kS = 1'000'000;

}  // namespace

TEST(wall_clock_unset_until_a_source_sets_it)
{
    WallClock w;
    CHECK(!w.valid());
    CHECK(!w.unix_at(5 * kS).has_value());
    CHECK(!w.set(5 * kS, kUnix, TimeSource::none));
    REQUIRE(w.set(5 * kS, kUnix, TimeSource::rtc));
    CHECK(w.source() == TimeSource::rtc);
    CHECK_EQ(*w.unix_at(7 * kS), kUnix + 2 * kS);
    CHECK_EQ(std::string(fr::time_source_name(w.source())), std::string("rtc"));
}

TEST(wall_clock_an_rtc_gives_way_to_the_hub_and_takes_over_when_the_hub_is_stale)
{
    WallClock w;
    REQUIRE(w.hub_sample(10 * kS, kUnix));
    CHECK(w.source() == TimeSource::hub);
    // An RTC reading 3 s off, an hour less a second later: refused; the hub's time stands.
    CHECK(!w.set(10 * kS + WallClock::kStaleUs - kS, kUnix + 3 * kS, TimeSource::rtc));
    CHECK(w.source() == TimeSource::hub);
    // Past kStaleUs with no hub sample: the RTC is the better clock.
    CHECK(w.set(10 * kS + WallClock::kStaleUs + kS, kUnix + WallClock::kStaleUs + 4 * kS, TimeSource::rtc));
    CHECK(w.source() == TimeSource::rtc);
    // Carried time never beats the RTC; the hub always does.
    CHECK(!w.set(10 * kS + WallClock::kStaleUs + 2 * kS, kUnix, TimeSource::carried));
    CHECK(w.hub_sample(10 * kS + WallClock::kStaleUs + 3 * kS, kUnix + WallClock::kStaleUs + 3 * kS));
    CHECK(w.source() == TimeSource::hub);
}

TEST(wall_clock_keeps_the_least_delayed_hub_sample)
{
    WallClock w;
    // Sent at kUnix, arrived 4 ms later on the node's clock at 100 s: offset kUnix - 100 s (4 ms short).
    REQUIRE(w.hub_sample(100 * kS + 4'000, kUnix));
    const int64_t first = *w.unix_at(200 * kS);
    // A sample 1 ms in flight a moment later is better: the clock moves forward by 3 ms.
    REQUIRE(w.hub_sample(100 * kS + 51'000, kUnix + 50'000));
    CHECK_EQ(*w.unix_at(200 * kS) - first, int64_t{3'000});
    // One that waited 20 ms on the way implies an earlier time: ignored.
    CHECK(!w.hub_sample(100 * kS + 120'000, kUnix + 100'000));
    CHECK_EQ(*w.unix_at(200 * kS) - first, int64_t{3'000});
    // A minute later the crystals may have drifted 6 ms (100 ppm): a sample 2 ms earlier than the best is taken.
    REQUIRE(w.hub_sample(160 * kS + 51'000 + 2'000, kUnix + 60 * kS + 50'000));
    CHECK_EQ(*w.unix_at(200 * kS) - first, int64_t{1'000});
    // The hub's own clock steps back 2 s: refused for kHubResetUs, then taken.
    CHECK(!w.hub_sample(170 * kS, kUnix + 70 * kS - 2 * kS));
    CHECK(w.hub_sample(160 * kS + WallClock::kHubResetUs + kS, kUnix + 60 * kS + WallClock::kHubResetUs - kS));
    CHECK(!w.hub_sample(300 * kS, 0));  // a hub that sent no time
}

TEST(wall_clock_calls_the_hook_and_listener_on_each_change_but_not_on_a_quiet_one)
{
    WallClock w;
    std::vector<int64_t> set;
    int heard = 0;
    w.set_hook([&](TimeUs at, int64_t unix_us, TimeSource) { set.push_back(unix_us - at); });
    w.set_listener([&] { ++heard; });
    REQUIRE(w.set(kS, kUnix, TimeSource::rtc));
    REQUIRE(w.set(2 * kS, kUnix + kS + 500, TimeSource::rtc));  // 0.5 ms: quiet
    CHECK_EQ(set.size(), size_t{1});
    CHECK_EQ(heard, 1);
    REQUIRE(w.set(3 * kS, kUnix + 2 * kS + 5'000, TimeSource::rtc));
    CHECK_EQ(set.size(), size_t{2});
    CHECK_EQ(set.back(), kUnix - kS + 5'000);
    CHECK_EQ(heard, 2);
    REQUIRE(w.hub_sample(4 * kS, kUnix + 3 * kS + 5'200));  // a new source: never quiet
    CHECK_EQ(set.size(), size_t{3});
    CHECK_EQ(w.taken(), 3u);
}
