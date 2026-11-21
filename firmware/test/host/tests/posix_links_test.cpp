// The POSIX runtime's hub list (design multi-hub-m1; fr_posix/src/links.cpp, store.cpp): the real TcpLink and
// UdpLink on PosixCore, with the real Net behind them, against two small hubs on loopback that WELCOME a HELLO and
// keep the session alive. What a Linux node (qonu-node) runs: the list in order, a hub left after its bounded time,
// the return to a hub above when it answers again, a list that names the current hub kept at once, a list on trial
// reverted, a stale rev refused, and the identity file's three keys. The timings are shortened; the rules are
// fr/net/hub_plan.hpp's (hub_plan_test.cpp), here with sockets and the wall clock.
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

#include "fr/posix/core.hpp"
#include "fr/posix/links.hpp"
#include "fr/posix/store.hpp"
#include "tests/net_fakes.hpp"

namespace {

using fr::TimeUs;
using fr::net::HubList;
using fr::net::LinkKind;
namespace wire = fr::wire;
namespace proto = fr::proto;

/** A hub as far as a node's TCP link needs one: it accepts, WELCOMEs each HELLO and sends a HEARTBEAT every 200 ms. */
class MiniHub
{
public:
    MiniHub(uint16_t node_addr, uint16_t net, uint16_t epoch) : sim_(node_addr, net) { sim_.epoch = epoch; }
    ~MiniHub() { stop(); }

    bool start(uint16_t port = 0)
    {
        lfd_ = ::socket(AF_INET, SOCK_STREAM, 0);
        const int one = 1;
        ::setsockopt(lfd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        a.sin_port = htons(port);
        if (::bind(lfd_, reinterpret_cast<sockaddr *>(&a), sizeof(a)) != 0 || ::listen(lfd_, 8) != 0) {
            ::close(lfd_);
            lfd_ = -1;
            return false;
        }
        socklen_t len = sizeof(a);
        ::getsockname(lfd_, reinterpret_cast<sockaddr *>(&a), &len);
        port_ = ntohs(a.sin_port);
        ::fcntl(lfd_, F_SETFL, ::fcntl(lfd_, F_GETFL, 0) | O_NONBLOCK);
        return true;
    }
    /** The hub goes away: its listener and every connection close. */
    void stop()
    {
        for (const int fd : conns_) {
            ::close(fd);
        }
        conns_.clear();
        if (lfd_ >= 0) {
            ::close(lfd_);
            lfd_ = -1;
        }
    }
    uint16_t port() const { return port_; }
    std::string name() const { return "127.0.0.1:" + std::to_string(port_); }
    /** Connections accepted so far, and HELLOs answered. */
    int accepted = 0;
    int welcomed = 0;
    /** false: it accepts connections and says nothing (a hub that does not take the board). */
    bool welcomes = true;

    void poll(TimeUs now)
    {
        if (lfd_ < 0) {
            return;
        }
        for (;;) {
            const int fd = ::accept(lfd_, nullptr, nullptr);
            if (fd < 0) {
                break;
            }
            ::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
            conns_.push_back(fd);
            ++accepted;
        }
        for (size_t i = 0; i < conns_.size();) {
            uint8_t buf[2048];
            const ssize_t n = ::recv(conns_[i], buf, sizeof(buf), 0);
            if (n == 0) {
                ::close(conns_[i]);
                conns_.erase(conns_.begin() + static_cast<long>(i));
                continue;
            }
            // One frame per read is enough here: the node's HELLO, then its heartbeats and events, which get no answer.
            if (n > 2 && welcomes) {
                const size_t len = buf[0] | static_cast<size_t>(buf[1]) << 8;
                const auto h = wire::unpack_header({buf + 2, std::min<size_t>(len, static_cast<size_t>(n) - 2)});
                if (h && h->cls == wire::kClsPresence && h->kind == proto::kKindPresenceHello) {
                    send(conns_[i], sim_.welcome());
                    ++welcomed;
                }
            }
            ++i;
        }
        if (welcomes && now - beat_at_ >= 200'000) {
            beat_at_ = now;
            for (const int fd : conns_) {
                send(fd, sim_.heartbeat());
            }
        }
    }

private:
    static void send(int fd, const std::vector<uint8_t> &env)
    {
        std::vector<uint8_t> frame{static_cast<uint8_t>(env.size()), static_cast<uint8_t>(env.size() >> 8)};
        frame.insert(frame.end(), env.begin(), env.end());
#ifdef MSG_NOSIGNAL
        const int flags = MSG_NOSIGNAL;
#else
        const int flags = 0;
#endif
        static_cast<void>(::send(fd, frame.data(), frame.size(), flags));
    }

    frt::HubSim sim_;
    int lfd_ = -1;
    uint16_t port_ = 0;
    std::vector<int> conns_;
    TimeUs beat_at_ = 0;
};

HubList list_of(uint32_t rev, std::initializer_list<std::string> hosts)
{
    HubList l;
    l.rev = rev;
    for (const std::string &h : hosts) {
        std::snprintf(l.hubs[l.count].host, sizeof(l.hubs[l.count].host), "%s", h.c_str());
        ++l.count;
    }
    return l;
}

/** A node's links on PosixCore with the real Net, and the two hubs it may use. */
struct Rig {
    Rig() : a(0x0005, 0x00AB, 7), b(0x0005, 0x00AB, 7), net(core, host, frt::test_config())
    {
        signal(SIGPIPE, SIG_IGN);
        a.start();
        b.start();
        fr::posix::TcpLink::Timing t;
        t.backoff_min_us = 40'000;
        t.backoff_max_us = 80'000;
        t.stable_us = 200'000;
        t.connect_timeout_us = 300'000;
        t.hubs.giveup_us = 400'000;
        t.hubs.welcome_wait_us = 250'000;
        t.hubs.probe_period_us = 400'000;
        t.hubs.probe_confirm_us = 150'000;
        t.hubs.probe_period_max_us = 800'000;
        t.hubs.trial_us = 1'200'000;
        tcp = std::make_unique<fr::posix::TcpLink>(core, "127.0.0.1", a.port(), t);
        tcp->bind(net, &udp);
        tcp->rx = [this](std::span<const uint8_t> env) { net.receive(LinkKind::tcp, env); };
        tcp->log = [this](const std::string &line) { log.push_back(line); };
        tcp->store_hubs = [this](const HubList &l) { stored.push_back(l); };
        net.attach(*tcp);
        net.attach(udp);
    }

    /** The node's loop (fr_posix Runner's) and the hubs', until `done` or `ms` are over; whether `done` came. */
    template <class Done>
    bool run(int ms, Done done)
    {
        const TimeUs until = core.now() + TimeUs{ms} * 1000;
        while (core.now() < until) {
            tcp->poll();
            core.run_ready();
            pollfd p{tcp->fd(), tcp->events(), 0};
            if (::poll(&p, 1, 2) > 0 && p.fd >= 0 && p.revents != 0) {
                tcp->on_events(p.revents);
                core.run_ready();
            }
            a.poll(core.now());
            b.poll(core.now());
            if (done()) {
                return true;
            }
        }
        return done();
    }
    void run(int ms)
    {
        run(ms, [] { return false; });
    }

    bool session() const { return net.state().link(LinkKind::tcp).session; }
    /** The index of the hub the session is with (255: none of the list). */
    uint8_t on() const
    {
        HubList l;
        uint8_t i = 0xFF;
        bool trial = false;
        tcp->hubs_now(l, i, trial);
        return i;
    }
    HubList held() const
    {
        HubList l;
        uint8_t i = 0xFF;
        bool trial = false;
        tcp->hubs_now(l, i, trial);
        return l;
    }
    bool said(const std::string &part) const
    {
        for (const std::string &line : log) {
            if (line.find(part) != std::string::npos) {
                return true;
            }
        }
        return false;
    }

    MiniHub a;
    MiniHub b;
    fr::posix::PosixCore core;
    frt::FakeHost host;
    fr::net::Net net;
    fr::posix::UdpLink udp;
    std::unique_ptr<fr::posix::TcpLink> tcp;
    std::vector<std::string> log;
    std::vector<HubList> stored;
};

}  // namespace

TEST(posix_links_without_a_list_keep_to_the_one_hub)
{
    Rig r;
    REQUIRE(r.run(2000, [&r] { return r.session(); }));
    CHECK_EQ(r.a.accepted, 1);
    CHECK_EQ(r.b.accepted, 0);
    CHECK_EQ(r.on(), 0xFF);  // no list: none of its hubs
    CHECK_EQ(r.held().count, 0);
    // The hub goes away: the node keeps trying it and no other, as before there were lists.
    r.a.stop();
    r.run(1200);
    CHECK(!r.session());
    CHECK_EQ(r.b.accepted, 0);
    REQUIRE(r.a.start(r.a.port()));
    REQUIRE(r.run(2000, [&r] { return r.session(); }));
    CHECK_EQ(r.b.accepted, 0);
}

TEST(posix_links_fail_over_down_the_list_and_return)
{
    Rig r;
    r.tcp->set_hubs(list_of(1, {r.a.name(), r.b.name()}));
    REQUIRE(r.run(2000, [&r] { return r.session(); }));
    CHECK_EQ(r.on(), 0);
    CHECK_EQ(r.b.accepted, 0);
    const uint32_t far_a = r.tcp->far_end();
    CHECK(far_a != 0);

    // Its first hub goes away: the node stays with it for its bounded time, then is on the second.
    r.a.stop();
    const TimeUs t0 = r.core.now();
    REQUIRE(r.run(4000, [&r] { return r.session() && r.on() == 1; }));
    const TimeUs took = r.core.now() - t0;
    CHECK(took >= 400'000);  // not before the 0.4 s a hub is given
    CHECK_EQ(r.b.welcomed, 1);
    CHECK(r.said("no session with " + r.a.name() + "; trying " + r.b.name()));
    CHECK(r.tcp->far_end() != far_a);  // Net is told the far end is another hub
    // UDP follows the hub the session is with.
    CHECK(r.udp.up());

    // The first hub is back: a probe finds it, a second one confirms, and the node returns by itself.
    const int probes_before = r.a.accepted;
    REQUIRE(r.a.start(r.a.port()));
    REQUIRE(r.run(5000, [&r] { return r.session() && r.on() == 0; }));
    CHECK(r.said(r.a.name() + " answers again; returning to it"));
    CHECK(r.a.accepted >= probes_before + 3);  // two probes and the session's connection
    // On its first hub it looks no further: the second hub hears nothing more.
    const int b_conns = r.b.accepted;
    r.run(1200);
    CHECK_EQ(r.b.accepted, b_conns);
    CHECK_EQ(r.on(), 0);
}

TEST(posix_links_a_hub_that_never_welcomes_is_left)
{
    Rig r;
    r.a.welcomes = false;  // it accepts the connection and says nothing: another network's hub
    r.tcp->set_hubs(list_of(1, {r.a.name(), r.b.name()}));
    REQUIRE(r.run(4000, [&r] { return r.session() && r.on() == 1; }));
    CHECK(r.a.accepted >= 1);
    CHECK(r.said("no WELCOME from this hub"));
    // Its probes of the first hub are answered (it listens), so the node returns, gets no WELCOME again and comes
    // back to the second: each such round doubles the wait for the next.
    const int a_before = r.a.accepted;
    r.run(2500);
    CHECK(r.a.accepted > a_before);
    REQUIRE(r.run(4000, [&r] { return r.session() && r.on() == 1; }));
}

TEST(posix_links_a_pushed_list_is_kept_tried_or_refused)
{
    Rig r;
    REQUIRE(r.run(2000, [&r] { return r.session(); }));
    // The node's own hub is 127.0.0.1 at hub A's port; a list that names it under that name is kept at once.
    // (hub_host on a board is a name; here the entry carries the port, the POSIX runtime's own form.)
    HubList first = list_of(1, {"127.0.0.1", r.b.name()});
    CHECK(r.tcp->push_hubs(first).has_value());
    CHECK(!r.tcp->push_hubs(list_of(2, {r.b.name()})).has_value());  // BUSY while the first waits to apply
    r.run(500);
    CHECK(r.session());
    CHECK_EQ(r.on(), 0);
    CHECK_EQ(r.a.accepted, 1);  // the session stayed
    REQUIRE_EQ(r.stored.size(), 1u);
    CHECK_EQ(r.stored[0].rev, 1u);
    // The same list and rev again: nothing to do. An older rev, or a list that is not one: refused.
    CHECK(r.tcp->push_hubs(first).has_value());
    auto stale = r.tcp->push_hubs(list_of(1, {r.b.name()}));
    CHECK(!stale.has_value() && stale.error() == fr::Err::expired);
    auto twice = r.tcp->push_hubs(list_of(5, {r.b.name(), r.b.name()}));
    CHECK(!twice.has_value() && twice.error() == fr::Err::invalid_args);
    r.run(400);
    CHECK_EQ(r.stored.size(), 1u);

    // A new default: hub B first. The list names the hub the node is on (now second), so no trial; B is probed at
    // once and the node moves there.
    CHECK(r.tcp->push_hubs(list_of(2, {r.b.name(), "127.0.0.1"})).has_value());
    REQUIRE(r.run(4000, [&r] { return r.session() && r.on() == 0 && r.held().rev == 2; }));
    CHECK_EQ(r.b.welcomed, 1);
    REQUIRE_EQ(r.stored.size(), 2u);
    CHECK_EQ(r.stored[1].rev, 2u);

    // A list none of whose hubs answers (a port nobody listens on): tried, then dropped for the list the node had.
    CHECK(r.tcp->push_hubs(list_of(3, {"127.0.0.1:1"})).has_value());
    REQUIRE(r.run(1500, [&r] { return !r.session() && r.held().rev == 3; }));
    REQUIRE(r.run(5000, [&r] { return r.session() && r.held().rev == 2; }));
    CHECK_EQ(r.on(), 0);
    CHECK(r.said("no hub of list rev 3 answered; back to rev 2"));
    CHECK_EQ(r.stored.size(), 2u);  // a list on trial is never stored

    // A list that does not name the current hub but works: on trial until its hub WELCOMEs, then stored.
    CHECK(r.tcp->push_hubs(list_of(4, {r.a.name()})).has_value());
    REQUIRE(r.run(4000, [&r] { return r.session() && r.held().rev == 4 && r.on() == 0; }));
    REQUIRE_EQ(r.stored.size(), 3u);
    CHECK_EQ(r.stored[2].rev, 4u);
    CHECK(r.said("list rev 4 confirmed"));
}

TEST(posix_identity_file_keeps_the_hub_list_until_the_hub_changes)
{
    char dir[] = "/tmp/fr-posix-ident-XXXXXX";
    REQUIRE(::mkdtemp(dir) != nullptr);
    const std::string path = std::string(dir) + "/identity";
    {
        fr::posix::IdentityFile id(path);
        REQUIRE(id.load());
        id.addr = 7;
        id.net = 0x00AB;
        id.alias = "home-node";
        id.hub = "lab-hub.local";
        HubList l = list_of(3, {"lab-hub.local", "home-hub.local:7521"});
        std::snprintf(l.hubs[1].ip, sizeof(l.hubs[1].ip), "%s", "192.168.1.30");
        id.set_hubs(l);
        REQUIRE(id.save());
    }
    {
        fr::posix::IdentityFile id(path);
        REQUIRE(id.load());
        CHECK_EQ(id.hub, "lab-hub.local");
        CHECK_EQ(id.hubs.rev, 3u);
        REQUIRE_EQ(id.hubs.count, 2);
        CHECK_EQ(std::string(id.hubs.hubs[0].host), "lab-hub.local");
        CHECK_EQ(std::string(id.hubs.hubs[0].ip), "");
        CHECK_EQ(std::string(id.hubs.hubs[1].host), "home-hub.local:7521");
        CHECK_EQ(std::string(id.hubs.hubs[1].ip), "192.168.1.30");
        // A list taken away keeps its rev: an older list cannot come back.
        id.set_hubs(list_of(4, {}));
        REQUIRE(id.save());
    }
    {
        fr::posix::IdentityFile id(path);
        REQUIRE(id.load());
        CHECK_EQ(id.hubs.rev, 4u);
        CHECK_EQ(id.hubs.count, 0);
        id.set_hubs(list_of(5, {"home-hub.local"}));
        // set-hub (as a reprovision on an ESP32): the hub named by hand supersedes the list.
        id.hub = "attic-hub.local";
        REQUIRE(id.save());
    }
    {
        fr::posix::IdentityFile id(path);
        REQUIRE(id.load());
        CHECK_EQ(id.hub, "attic-hub.local");
        CHECK_EQ(id.hubs.rev, 0u);
        CHECK_EQ(id.hubs.count, 0);
        CHECK_EQ(id.addr, 7);
        CHECK_EQ(id.alias, "home-node");
    }
    ::unlink(path.c_str());
    ::rmdir(dir);
}
