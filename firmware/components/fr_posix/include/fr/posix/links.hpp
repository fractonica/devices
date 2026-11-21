// The hub links of a POSIX node (spec 05 §5.12.1-2, design uno-q-host §2.5 step 2): TCP `len u16 LE | envelope`,
// node-initiated, and one UDP datagram per envelope to the same host and port. The hub's name is resolved with
// getaddrinfo (on the UNO Q systemd-resolved answers `<mac>.local` names over mDNS), at every connect attempt, so a
// hub that moved is found again. Connects are non-blocking with hub_link.cpp's timing: a 3 s connect timeout, a
// backoff from 0.25 s doubling to 5 s, back to 0.25 s after a connection that lasted 10 s. Sends never block the core:
// what the socket does not take waits in an 8 KB buffer (hub_link.cpp's TX ring) and goes when it is writable; a frame
// that does not fit is dropped (busy), as on target.
//
// Design multi-hub-m1: with a hub list (fr.node.hubs_set, the identity file's `hubs`) the link also chooses the hub,
// by the same rules as hub_link.cpp (fr/net/hub_plan.hpp): the list in order, a hub left after about 10 s without a
// WELCOME, the hubs above the current one probed once a minute and returned to when one answers twice, a pushed list
// on trial for 60 s. A list entry is `host` or `host:port` (the port of the node's own `hub` otherwise). There is no
// advert lookup here: that step of a round finds nothing. A probe resolves and connects on a thread of its own, so a
// name that does not answer never holds the node's one thread. Without a list nothing differs from before.
#pragma once

#include <netinet/in.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <span>
#include <string>
#include <vector>

#include "fr/net/hub_plan.hpp"
#include "fr/net/link.hpp"
#include "fr/net/net.hpp"
#include "fr/posix/core.hpp"

namespace fr::posix {

class UdpLink;

class TcpLink final : public net::Link
{
public:
    struct Timing {
        TimeUs backoff_min_us = 250'000;
        TimeUs backoff_max_us = 5'000'000;
        TimeUs stable_us = 10'000'000;
        TimeUs connect_timeout_us = 3'000'000;
        /** The hub list's timing (failover, failback, trial). */
        net::HubTiming hubs{};
    };
    static constexpr size_t kTxBytes = 8192;

    TcpLink(PosixCore &core, std::string host, uint16_t port, Timing timing);
    TcpLink(PosixCore &core, std::string host, uint16_t port) : TcpLink(core, std::move(host), port, Timing{}) {}
    ~TcpLink();
    TcpLink(const TcpLink &) = delete;
    TcpLink &operator=(const TcpLink &) = delete;

    net::LinkKind kind() const override { return net::LinkKind::tcp; }
    bool up() const override { return state_ == State::up; }
    Status send(std::span<const uint8_t> envelope) override;
    void drop(net::DropReason) override { close("dropped by Net"); }
    void hold(bool on) override;
    size_t queued() const override { return tx_.size(); }
    uint32_t far_end() const override { return far_; }

    // ---- the hub list (design multi-hub-m1) ----

    /** The stored list, at start (before the first poll()): in force as it is, no trial. */
    void set_hubs(const net::HubList &list);
    /** fr.node.hubs_set: taken about 300 ms later, so the RESULT leaves on this connection first. EXPIRED, INVALID_ARGS
     * and BUSY as on an ESP32 (fr/net/esp.hpp hubs_set). */
    Status push_hubs(const net::HubList &list);
    /** fr.node.hubs_get: the list in force, the index of the session's hub (255: none of them), the trial. */
    void hubs_now(net::HubList &list, uint8_t &on, bool &trial) const;
    /** A list to keep (kept at once, or confirmed by a WELCOME): the identity file's, through Device. */
    std::function<void(const net::HubList &)> store_hubs;

    /** Net and the UDP link that shares the hub's address. */
    void bind(net::Net &net, UdpLink *udp)
    {
        net_ = &net;
        udp_ = udp;
    }
    /** Where whole envelopes from the hub go (normally Net::receive). */
    std::function<void(std::span<const uint8_t>)> rx;
    /** A line for the log (connects, closes and why). */
    std::function<void(const std::string &)> log;

    /** Starts a connect when it is time (Runner loop). */
    void poll();
    /** The descriptor to wait on and the events wanted (-1 when none). */
    int fd() const { return fd_; }
    short events() const;
    void on_events(short revents);
    /** When poll() next has something to do (a retry or a connect timeout). */
    TimeUs next_deadline() const;

private:
    enum class State : uint8_t { idle, connecting, up };
    /** Why a connection ends, for the plan: the hub's doing, or the node's own move to another hub. */
    enum class End : uint8_t { hub, moving };
    /** A probe's thread and this link share it: the thread only writes `result`. */
    struct Probe {
        std::atomic<int> result{0};  // 0: running, 1: the hub accepted a connection, 2: it did not
    };

    void start_connect();
    void connected();
    void close(const char *why, End end = End::hub);
    /** An attempt at the plan's target got no session; true when the plan moved on (the next hub is tried at once). */
    void attempt_failed();
    /** The host and port of the hub the plan names; false for the advert step (no lookup here). */
    bool target(std::string &host, uint16_t &port) const;
    void split(const char *entry, std::string &host, uint16_t &port) const;
    void welcomed();
    void take_list();
    void upkeep(TimeUs now);
    void flush();
    void read();
    /** Logs a line unless it repeats the previous one: a hub that is away is reported once, not every retry. */
    void say(const std::string &line)
    {
        if (log && line != last_said_) {
            log(line);
        }
        last_said_ = line;
    }
    void notify();

    PosixCore &core_;
    std::string host_;
    uint16_t port_;
    Timing timing_;
    net::Net *net_ = nullptr;
    UdpLink *udp_ = nullptr;
    State state_ = State::idle;
    int fd_ = -1;
    bool held_ = false;
    TimeUs retry_at_ = 0;
    TimeUs backoff_us_;
    TimeUs connect_deadline_ = kNever;
    TimeUs up_since_ = 0;
    std::vector<uint8_t> tx_;
    std::vector<uint8_t> rx_;
    std::string last_said_;
    // Design multi-hub-m1.
    net::HubPlan plan_;
    net::HubList list_{};       // in force, a list on trial included
    net::HubList prev_{};       // what a failed trial returns to
    net::HubList next_list_{};  // a pushed list waiting for its RESULT to leave
    TimeUs next_list_at_ = kNever;
    bool session_ = false;      // this connection got a WELCOME
    std::string connecting_to_; // the host of the connection (attempt), for the log
    std::string far_host_;      // where the last connection went ...
    uint32_t far_ = 0;          // ... counted up when the next one goes elsewhere
    std::shared_ptr<Probe> probe_;
};

/** One datagram per envelope to the hub's address (the TCP link's last resolution); the node never listens on UDP. */
class UdpLink final : public net::Link
{
public:
    UdpLink();
    ~UdpLink();
    UdpLink(const UdpLink &) = delete;
    UdpLink &operator=(const UdpLink &) = delete;

    net::LinkKind kind() const override { return net::LinkKind::udp; }
    bool up() const override { return fd_ >= 0 && have_target_; }
    Status send(std::span<const uint8_t> envelope) override;

    void set_target(const sockaddr_in &to)
    {
        to_ = to;
        have_target_ = true;
    }

private:
    int fd_ = -1;
    bool have_target_ = false;
    sockaddr_in to_{};
};

/** `host` resolved to IPv4 (getaddrinfo, which may wait on mDNS): false when it does not resolve. */
bool resolve_ipv4(const std::string &host, uint16_t port, sockaddr_in &out);

}  // namespace fr::posix
