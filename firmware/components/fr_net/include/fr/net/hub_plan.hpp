// A board's hub list and which of its hubs to try now (design multi-hub-m1, spec 05 §5.12.5). IDF-free and
// header-only, so the ESP32 link (fr_net/src/esp/hub_link.cpp), the POSIX runtime (fr_posix) and the host suite's
// node run the same rules:
//   - the list: up to four hubs in priority order, the first the board's default; a rev that only grows, so a
//     stale push never wins; a list stored under an earlier provisioning is dropped;
//   - failover: a hub that gives no session (no WELCOME) for kGiveUpUs and at least kGiveUpAttempts attempts is
//     left for the next: after a lost session the hub the board was on, then the others in order, then (outside a
//     trial) one lookup of any hub's advert, then the list from its top again;
//   - failback: with a session on a hub that is not the first, the hubs above it are probed (a TCP connect) every
//     probe period; one that answers twice, kProbeConfirmUs apart, is returned to. A return that gets no session
//     doubles the period (up to kProbePeriodMaxUs) until one does;
//   - the trial: a pushed list that does not name the hub the board is on is dropped for the list it had unless
//     one of its hubs WELCOMEs the board within kTrialUs.
// HubPlan keeps no addresses and opens no sockets: the link tells it what happened and asks what to do next.
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string_view>

#include "fr/base.hpp"

namespace fr::net {

inline constexpr size_t kHubsMax = 4;
inline constexpr size_t kHubHostMax = 63;
inline constexpr size_t kHubIpMax = 15;

/** One hub: its host name and a dotted IPv4 to fall back to (empty: none). NUL-terminated. */
struct HubEntry {
    char host[kHubHostMax + 1] = {};
    char ip[kHubIpMax + 1] = {};
};

/** The list as fr.node.hubs_set carries it. count 0 with a rev: no list, and a later push must still exceed the rev. */
struct HubList {
    uint32_t rev = 0;
    uint8_t count = 0;
    HubEntry hubs[kHubsMax]{};
};

/** Host names compare without case (DNS and mDNS do). */
inline bool hub_host_eq(std::string_view a, std::string_view b)
{
    if (a.size() != b.size()) {
        return false;
    }
    for (size_t i = 0; i < a.size(); ++i) {
        const char x = a[i] >= 'A' && a[i] <= 'Z' ? static_cast<char>(a[i] - 'A' + 'a') : a[i];
        const char y = b[i] >= 'A' && b[i] <= 'Z' ? static_cast<char>(b[i] - 'A' + 'a') : b[i];
        if (x != y) {
            return false;
        }
    }
    return true;
}

/**
 * A host a board can look up: 1-63 of letters, digits, '.', '-' and '_', not starting with '.' or '-'. With
 * `allow_port` (the POSIX runtime, whose identity file already names its hub as host[:port]) a `:<port>` may follow.
 */
inline bool hub_host_valid(std::string_view s, bool allow_port = false)
{
    if (allow_port) {
        const size_t colon = s.rfind(':');
        if (colon != std::string_view::npos) {
            const std::string_view port = s.substr(colon + 1);
            if (port.empty() || port.size() > 5) {
                return false;
            }
            unsigned v = 0;
            for (const char c : port) {
                if (c < '0' || c > '9') {
                    return false;
                }
                v = v * 10 + static_cast<unsigned>(c - '0');
            }
            if (v == 0 || v > 65535) {
                return false;
            }
            s = s.substr(0, colon);
        }
    }
    if (s.empty() || s.size() > kHubHostMax || s.front() == '.' || s.front() == '-') {
        return false;
    }
    for (const char c : s) {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '_';
        if (!ok) {
            return false;
        }
    }
    return true;
}

/** Empty (no fallback) or a dotted IPv4 that is not 0.0.0.0. */
inline bool hub_ip_valid(std::string_view s)
{
    if (s.empty()) {
        return true;
    }
    if (s.size() > kHubIpMax) {
        return false;
    }
    unsigned parts = 0;
    unsigned sum = 0;
    size_t at = 0;
    while (at <= s.size()) {
        unsigned v = 0;
        size_t digits = 0;
        while (at < s.size() && s[at] >= '0' && s[at] <= '9' && digits < 3) {
            v = v * 10 + static_cast<unsigned>(s[at++] - '0');
            ++digits;
        }
        if (digits == 0 || v > 255) {
            return false;
        }
        sum += v;
        ++parts;
        if (at == s.size()) {
            break;
        }
        if (s[at++] != '.') {
            return false;
        }
    }
    return parts == 4 && sum != 0;
}

/** Every entry a host (and an ip or none), no host twice. */
inline bool hub_list_valid(const HubList &l, bool allow_port = false)
{
    if (l.count > kHubsMax) {
        return false;
    }
    for (size_t i = 0; i < l.count; ++i) {
        if (!hub_host_valid(l.hubs[i].host, allow_port) || !hub_ip_valid(l.hubs[i].ip)) {
            return false;
        }
        for (size_t k = 0; k < i; ++k) {
            if (hub_host_eq(l.hubs[k].host, l.hubs[i].host)) {
                return false;
            }
        }
    }
    return true;
}

inline bool hub_list_same(const HubList &a, const HubList &b)
{
    if (a.rev != b.rev || a.count != b.count) {
        return false;
    }
    for (size_t i = 0; i < a.count; ++i) {
        if (std::strcmp(a.hubs[i].host, b.hubs[i].host) != 0 || std::strcmp(a.hubs[i].ip, b.hubs[i].ip) != 0) {
            return false;
        }
    }
    return true;
}

/** What fr.node.hubs_set does with a pushed list, given the one held. */
enum class HubPush : uint8_t {
    apply,    // a higher rev: taken (on trial, or at once when it names the hub the board is on)
    same,     // the list and rev held already: OK, nothing to do
    stale,    // a rev at or below the one held, with other content: EXPIRED
    invalid,  // not a list: INVALID_ARGS
};

inline HubPush hub_push_check(const HubList &held, const HubList &pushed, bool allow_port = false)
{
    if (!hub_list_valid(pushed, allow_port)) {
        return HubPush::invalid;
    }
    if (pushed.rev > held.rev) {
        return HubPush::apply;
    }
    return hub_list_same(held, pushed) ? HubPush::same : HubPush::stale;
}

/**
 * Whether a stored list is void: it was pushed under another provisioning (06 §6.3, as nvs:fr_net2). A reflash
 * writes fr_ident (a new prov_ts) and leaves the RW partition alone, and the hub it names must win.
 */
constexpr bool hub_list_superseded(uint32_t base_prov_ts, uint32_t prov_ts)
{
    return base_prov_ts != prov_ts;
}

/** The index of `host` in the list, or -1. */
inline int hub_index_of(const HubList &l, std::string_view host)
{
    for (size_t i = 0; i < l.count; ++i) {
        if (hub_host_eq(l.hubs[i].host, host)) {
            return static_cast<int>(i);
        }
    }
    return -1;
}

struct HubTiming {
    TimeUs giveup_us = 10'000'000;            // a hub with no session this long ...
    uint8_t giveup_attempts = 3;              // ... and after this many attempts is left for the next
    TimeUs welcome_wait_us = 4'000'000;       // a connection with no WELCOME this long is a failed attempt
    TimeUs probe_period_us = 60'000'000;      // failback: how often the hubs above the current one are probed
    TimeUs probe_confirm_us = 10'000'000;     // ... and how long after its first answer a hub must answer again
    TimeUs probe_period_max_us = 480'000'000; // the period after returns that got no session
    TimeUs trial_us = 60'000'000;             // a pushed list without a WELCOME this long is reverted
};

class HubPlan
{
public:
    static constexpr uint8_t kNone = 0xFF;
    /** Not a hub of the list: whichever hub answers the `_fractonica._tcp` lookup. */
    static constexpr uint8_t kAdvert = 0xFE;
    static constexpr TimeUs kNever = INT64_MAX;

    void set_timing(const HubTiming &t)
    {
        t_ = t;
        period_ = t.probe_period_us;
    }
    const HubTiming &timing() const { return t_; }

    /**
     * A list of `count` hubs, starting with `first`. count 0: no list, the link keeps to the one hub it was
     * provisioned with (target() is 0 and never moves; the plan only tracks the session and a trial).
     */
    void reset(uint8_t count, uint8_t first = 0)
    {
        count_ = count <= kHubsMax ? count : static_cast<uint8_t>(kHubsMax);
        start_ = count_ != 0 && first < count_ ? first : 0;
        pos_ = 0;
        cur_ = start_;
        on_ = kNone;
        attempts_ = 0;
        since_ = kNever;
        trial_ = false;
        trial_deadline_ = kNever;
        returning_ = false;
        period_ = t_.probe_period_us;
        stop_probes();
    }

    /** A list that names the hub the session is with, at `on`: the session stays, and a hub above it is probed at once. */
    void adopt(uint8_t count, uint8_t on, TimeUs now)
    {
        reset(count, on);
        on_ = cur_;
        if (has_higher()) {
            probe_at_ = now;
        }
    }

    uint8_t count() const { return count_; }
    /** The hub to try now: an index, or kAdvert. */
    uint8_t target() const { return cur_; }
    /** The hub of the session: an index, kAdvert, or kNone without one. */
    uint8_t on() const { return on_; }

    /** An attempt at target() starts: its bounded time counts from the first one. */
    void attempt(TimeUs now)
    {
        if (since_ == kNever) {
            since_ = now;
        }
    }

    /**
     * An attempt ended without a session (no address, no connection, or a connection without a WELCOME). True when
     * target() moved on: the link then tries it at once, its reconnect backoff started over.
     */
    bool failed(TimeUs now)
    {
        if (count_ == 0) {
            return false;
        }
        if (since_ == kNever) {
            since_ = now;
        }
        if (attempts_ < 0xFF) {
            ++attempts_;
        }
        // The advert is one lookup, not a hub to wait for.
        if (cur_ == kAdvert || (attempts_ >= t_.giveup_attempts && now - since_ >= t_.giveup_us)) {
            advance();
            return true;
        }
        return false;
    }

    /** A WELCOME on the connection to target(). Ends a trial (the caller stores the list). */
    void session(TimeUs now)
    {
        on_ = cur_;
        attempts_ = 0;
        since_ = kNever;
        trial_ = false;
        trial_deadline_ = kNever;
        if (returning_) {
            returning_ = false;
            period_ = t_.probe_period_us;
        }
        stop_probes();
        if (has_higher()) {
            probe_at_ = now + period_;
        }
    }

    /** The session ended: the hub the board was on is tried first, then the others in order. */
    void lost(TimeUs)
    {
        if (on_ == kNone) {
            return;  // none, or left on purpose (probed() returned true)
        }
        start_ = on_ < count_ ? on_ : 0;
        on_ = kNone;
        pos_ = 0;
        cur_ = start_;
        attempts_ = 0;
        since_ = kNever;
        stop_probes();
    }

    /** No network to try over (Wi-Fi away, the link held): the bounded time of target() starts over. */
    void pause()
    {
        attempts_ = 0;
        since_ = kNever;
    }

    // ---- failback ----

    /** When probe() next has a hub to probe; kNever with none. */
    TimeUs probe_at() const { return on_ != kNone && !probing_ ? probe_at_ : kNever; }

    /**
     * The hub to probe now, or kNone. `busy` (an OTA or a stream runs over this hub) puts the look off by
     * kProbeConfirmUs and forgets a first answer. The link runs one probe and answers with probed().
     */
    uint8_t probe(TimeUs now, bool busy)
    {
        if (on_ == kNone || probing_ || probe_at_ == kNever || now < probe_at_) {
            return kNone;
        }
        if (busy) {
            confirm_ = false;
            probe_i_ = 0;
            probe_at_ = now + t_.probe_confirm_us;
            return kNone;
        }
        probing_ = true;
        return probe_i_;
    }

    /**
     * The probe's result. True: the hub answered twice, return to it now (target() is it; the link closes the
     * session it has and connects there).
     */
    bool probed(TimeUs now, bool ok)
    {
        if (!probing_) {
            return false;
        }
        probing_ = false;
        if (on_ == kNone) {
            return false;  // the session went while the probe ran
        }
        if (ok && confirm_) {
            const uint8_t to = probe_i_;
            stop_probes();
            on_ = kNone;
            start_ = to;
            pos_ = 0;
            cur_ = to;
            attempts_ = 0;
            since_ = kNever;
            returning_ = true;
            return true;
        }
        if (ok) {
            confirm_ = true;
            probe_at_ = now + t_.probe_confirm_us;
            return false;
        }
        confirm_ = false;
        ++probe_i_;
        if (probe_i_ < higher()) {
            probe_at_ = now;  // the next hub above the current one
        } else {
            probe_i_ = 0;
            probe_at_ = now + period_;
        }
        return false;
    }

    /** The probe period in force (longer after returns that got no session). */
    TimeUs probe_period() const { return period_; }

    // ---- the trial of a pushed list ----

    void begin_trial(TimeUs now)
    {
        trial_ = true;
        trial_deadline_ = now + t_.trial_us;
    }
    bool trial() const { return trial_; }
    TimeUs trial_deadline() const { return trial_ ? trial_deadline_ : kNever; }
    bool trial_expired(TimeUs now) const { return trial_ && now >= trial_deadline_; }

private:
    /** How many hubs rank above the session's: all of them for a hub found by its advert. */
    uint8_t higher() const { return on_ == kAdvert ? count_ : on_ < count_ ? on_ : 0; }
    bool has_higher() const { return higher() > 0; }

    void stop_probes()
    {
        probe_at_ = kNever;
        probe_i_ = 0;
        confirm_ = false;
        probing_ = false;
    }

    /** The pos-th hub of a round: `start_`, then the others in list order. */
    uint8_t nth(uint8_t pos) const
    {
        if (pos == 0) {
            return start_;
        }
        const uint8_t k = static_cast<uint8_t>(pos - 1);
        return k < start_ ? k : static_cast<uint8_t>(k + 1);
    }

    void advance()
    {
        if (returning_) {
            // The hub that answered the probes gave no session: look less often until a return works.
            returning_ = false;
            period_ = period_ * 2 < t_.probe_period_max_us ? period_ * 2 : t_.probe_period_max_us;
        }
        attempts_ = 0;
        since_ = kNever;
        if (cur_ == kAdvert) {
            start_ = 0;
            pos_ = 0;
            cur_ = 0;
            return;
        }
        ++pos_;
        if (pos_ < count_) {
            cur_ = nth(pos_);
        } else if (!trial_) {
            cur_ = kAdvert;  // a full round with no hub: any hub that advertises itself (05 §5.12.5 step 4)
        } else {
            start_ = 0;
            pos_ = 0;
            cur_ = 0;  // a trial is confirmed by a hub of the list only
        }
    }

    HubTiming t_{};
    uint8_t count_ = 0;
    uint8_t start_ = 0;   // the first hub of this round
    uint8_t pos_ = 0;     // how far the round got
    uint8_t cur_ = 0;     // target()
    uint8_t on_ = kNone;  // the session's hub
    uint8_t attempts_ = 0;
    TimeUs since_ = kNever;  // the first attempt at cur_ since it became the target
    bool trial_ = false;
    TimeUs trial_deadline_ = kNever;
    // Failback.
    TimeUs probe_at_ = kNever;
    uint8_t probe_i_ = 0;
    bool confirm_ = false;   // probe_i_ answered once
    bool probing_ = false;   // a probe is out
    bool returning_ = false; // target() is a hub the probes chose; no session with it yet
    TimeUs period_ = HubTiming{}.probe_period_us;
};

}  // namespace fr::net
