#include "fr/posix/links.hpp"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <thread>

#include "protocol.hpp"  // generated fr::proto constants (kMtuBulk)

namespace fr::posix {

bool resolve_ipv4(const std::string &host, uint16_t port, sockaddr_in &out)
{
    addrinfo hints{};
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    addrinfo *res = nullptr;
    if (::getaddrinfo(host.c_str(), nullptr, &hints, &res) != 0 || res == nullptr) {
        return false;
    }
    std::memcpy(&out, res->ai_addr, sizeof(out));
    out.sin_port = htons(port);
    ::freeaddrinfo(res);
    return true;
}

namespace {

void set_nonblocking(int fd)
{
    ::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
    ::fcntl(fd, F_SETFD, FD_CLOEXEC);
}

/** Whether `host:port` accepts a TCP connection within `timeout_us` (a failback probe; its own thread). */
bool probe_connect(const std::string &host, uint16_t port, TimeUs timeout_us)
{
    sockaddr_in to{};
    if (!resolve_ipv4(host, port, to)) {
        return false;
    }
    const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        return false;
    }
    set_nonblocking(fd);
    bool ok = ::connect(fd, reinterpret_cast<const sockaddr *>(&to), sizeof(to)) == 0;
    if (!ok && errno == EINPROGRESS) {
        pollfd p{fd, POLLOUT, 0};
        if (::poll(&p, 1, static_cast<int>(timeout_us / 1000)) == 1) {
            int err = 0;
            socklen_t len = sizeof(err);
            ok = ::getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) == 0 && err == 0;
        }
    }
    ::close(fd);  // a connect is the whole probe: the hub sees a connection that says nothing
    return ok;
}

}  // namespace

TcpLink::TcpLink(PosixCore &core, std::string host, uint16_t port, Timing timing)
    : core_(core), host_(std::move(host)), port_(port), timing_(timing), backoff_us_(timing.backoff_min_us)
{
    tx_.reserve(kTxBytes);
    plan_.set_timing(timing_.hubs);
    plan_.reset(0);
}

TcpLink::~TcpLink()
{
    if (fd_ >= 0) {
        ::close(fd_);
    }
}

// ---- the hub list (design multi-hub-m1) ----

void TcpLink::set_hubs(const net::HubList &list)
{
    list_ = net::hub_list_valid(list, true) ? list : net::HubList{};
    prev_ = list_;
    plan_.reset(list_.count);
}

Status TcpLink::push_hubs(const net::HubList &list)
{
    switch (net::hub_push_check(list_, list, true)) {
    case net::HubPush::invalid:
        return std::unexpected(Err::invalid_args);
    case net::HubPush::stale:
        return std::unexpected(Err::expired);
    case net::HubPush::same:
        return {};
    case net::HubPush::apply:
        break;
    }
    if (next_list_at_ != kNever) {
        return std::unexpected(Err::busy);
    }
    next_list_ = list;
    next_list_at_ = core_.now() + 300'000;
    return {};
}

void TcpLink::hubs_now(net::HubList &list, uint8_t &on, bool &trial) const
{
    list = list_;
    on = session_ && plan_.on() < list_.count ? plan_.on() : 0xFF;
    trial = plan_.trial();
}

void TcpLink::split(const char *entry, std::string &host, uint16_t &port) const
{
    host = entry;
    port = port_;
    const size_t colon = host.rfind(':');
    if (colon != std::string::npos) {
        port = static_cast<uint16_t>(std::strtoul(host.c_str() + colon + 1, nullptr, 10));
        host.resize(colon);
    }
}

bool TcpLink::target(std::string &host, uint16_t &port) const
{
    if (plan_.count() == 0) {
        host = host_;
        port = port_;
        return true;
    }
    const uint8_t t = plan_.target();
    if (t >= list_.count) {
        return false;  // the advert step: a POSIX node has no such lookup
    }
    split(list_.hubs[t].host, host, port);
    return true;
}

void TcpLink::attempt_failed()
{
    const TimeUs now = core_.now();
    const uint8_t gave_up = plan_.target();
    if (plan_.failed(now)) {
        if (gave_up < list_.count && plan_.target() < list_.count) {
            say(std::string("hub: no session with ") + list_.hubs[gave_up].host + "; trying " + list_.hubs[plan_.target()].host);
        }
        backoff_us_ = timing_.backoff_min_us;
        retry_at_ = now;
    }
}

void TcpLink::welcomed()
{
    const bool trial = plan_.trial();
    session_ = true;
    plan_.session(core_.now());
    if (plan_.on() < list_.count) {
        say(std::string("hub: session with ") + list_.hubs[plan_.on()].host + " (hub " + std::to_string(plan_.on() + 1) + " of " +
            std::to_string(list_.count) + ")");
    }
    if (trial) {
        say("hub: list rev " + std::to_string(list_.rev) + " confirmed");
        prev_ = list_;
        if (store_hubs) {
            store_hubs(list_);
        }
    }
}

void TcpLink::take_list()
{
    const TimeUs now = core_.now();
    // The hub the session is with, under the name the node has for it.
    const std::string cur = !session_ ? "" : plan_.count() == 0 ? host_ : plan_.on() < list_.count ? list_.hubs[plan_.on()].host : "";
    if (!plan_.trial()) {
        prev_ = list_;
    }
    list_ = next_list_;
    // No list (count 0) is the node's own `hub` again.
    const int keep = cur.empty() ? -1 : list_.count == 0 ? (net::hub_host_eq(cur, host_) ? 0 : -1) : net::hub_index_of(list_, cur);
    if (keep >= 0) {
        plan_.adopt(list_.count, static_cast<uint8_t>(keep), now);
        say("hub: list rev " + std::to_string(list_.rev) + " taken; it names " + cur + ", where the node is");
        prev_ = list_;
        if (store_hubs) {
            store_hubs(list_);
        }
        return;
    }
    say("hub: list rev " + std::to_string(list_.rev) + " on trial (reverted unless one of its hubs answers in " +
        std::to_string(timing_.hubs.trial_us / 1'000'000) + " s)");
    close("going to another hub of the list", End::moving);
    plan_.reset(list_.count);
    plan_.begin_trial(now);
    backoff_us_ = timing_.backoff_min_us;
    retry_at_ = now;
}

void TcpLink::upkeep(TimeUs now)
{
    if (next_list_at_ != kNever && now >= next_list_at_) {
        next_list_at_ = kNever;
        take_list();
    }
    if (plan_.trial_expired(now)) {
        say("hub: no hub of list rev " + std::to_string(list_.rev) + " answered; back to rev " + std::to_string(prev_.rev));
        close("going to another hub of the list", End::moving);
        list_ = prev_;
        plan_.reset(list_.count);
        backoff_us_ = timing_.backoff_min_us;
        retry_at_ = now;
    }
    if (state_ == State::up && !session_ && plan_.count() != 0 && now - up_since_ >= timing_.hubs.welcome_wait_us) {
        close("no WELCOME from this hub");
    }
    // Failback: one probe at a time, on its own thread (a name that does not answer must not hold this one).
    if (probe_) {
        const int result = probe_->result.load();
        if (result != 0) {
            probe_.reset();
            if (plan_.probed(now, result == 1)) {
                say(std::string("hub: ") + list_.hubs[plan_.target()].host + " answers again; returning to it");
                close("going to another hub of the list", End::moving);
                backoff_us_ = timing_.backoff_min_us;
                retry_at_ = now;
            }
        }
    } else if (state_ == State::up && session_) {
        const uint8_t i = plan_.probe(now, false);
        if (i < list_.count) {
            std::string host;
            uint16_t port = 0;
            split(list_.hubs[i].host, host, port);
            probe_ = std::make_shared<Probe>();
            std::thread([probe = probe_, host, port, timeout = timing_.connect_timeout_us] {
                probe->result.store(probe_connect(host, port, timeout) ? 1 : 2);
            }).detach();
        }
    }
}

Status TcpLink::send(std::span<const uint8_t> envelope)
{
    if (state_ != State::up || envelope.empty() || envelope.size() > proto::kMtuBulk) {
        return std::unexpected(Err::busy);
    }
    if (tx_.size() + envelope.size() + 2 > kTxBytes) {
        return std::unexpected(Err::busy);  // tcp_tx_dropped on target
    }
    tx_.push_back(static_cast<uint8_t>(envelope.size()));
    tx_.push_back(static_cast<uint8_t>(envelope.size() >> 8));
    tx_.insert(tx_.end(), envelope.begin(), envelope.end());
    flush();
    return {};
}

void TcpLink::hold(bool on)
{
    if (held_ && !on) {
        retry_at_ = 0;
    }
    held_ = on;
    if (on) {
        close("held");
    }
}

short TcpLink::events() const
{
    switch (state_) {
    case State::connecting:
        return POLLOUT;
    case State::up:
        return static_cast<short>(POLLIN | (tx_.empty() ? 0 : POLLOUT));
    case State::idle:
        break;
    }
    return 0;
}

TimeUs TcpLink::next_deadline() const
{
    TimeUs at = std::min({next_list_at_, plan_.probe_at(), plan_.trial_deadline()});
    if (state_ == State::connecting) {
        return std::min(at, connect_deadline_);
    }
    if (state_ == State::idle && !held_) {
        return std::min(at, retry_at_);
    }
    if (state_ == State::up && !session_ && plan_.count() != 0) {
        at = std::min(at, up_since_ + timing_.hubs.welcome_wait_us);
    }
    return at;
}

void TcpLink::poll()
{
    const TimeUs now = core_.now();
    upkeep(now);
    if (state_ == State::connecting && now >= connect_deadline_) {
        close("connect timed out");
        return;
    }
    if (state_ == State::idle && !held_ && now >= retry_at_) {
        start_connect();
    }
}

void TcpLink::start_connect()
{
    // The hub the plan names (design multi-hub-m1): the node's own `hub` without a list.
    std::string host;
    uint16_t port = 0;
    const bool named = target(host, port);
    plan_.attempt(core_.now());
    sockaddr_in to{};
    if (!named || !resolve_ipv4(host, port, to)) {
        if (named) {
            say("hub: cannot resolve " + host);
        }
        retry_at_ = core_.now() + backoff_us_;
        backoff_us_ = std::min(backoff_us_ * 2, timing_.backoff_max_us);
        attempt_failed();
        return;
    }
    const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        retry_at_ = core_.now() + backoff_us_;
        return;
    }
    const std::string far = host + ":" + std::to_string(port);
    if (far != far_host_) {
        far_host_ = far;  // another hub than the last connection went to: Net's WELCOME is a new hub run
        ++far_;
    }
    connecting_to_ = host;
    set_nonblocking(fd);
    const int one = 1;
    ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    ::setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof(one));
    if (udp_ != nullptr) {
        udp_->set_target(to);  // UDP goes to the address TCP reaches (the hub binds both on one port)
    }
    fd_ = fd;
    const int r = ::connect(fd, reinterpret_cast<const sockaddr *>(&to), sizeof(to));
    if (r == 0) {
        connected();
    } else if (errno == EINPROGRESS) {
        state_ = State::connecting;
        connect_deadline_ = core_.now() + timing_.connect_timeout_us;
    } else {
        close("connect failed");
    }
}

void TcpLink::connected()
{
    state_ = State::up;
    session_ = false;
    up_since_ = core_.now();
    tx_.clear();
    rx_.clear();
    char ip[INET_ADDRSTRLEN] = "?";
    sockaddr_in peer{};
    socklen_t len = sizeof(peer);
    if (::getpeername(fd_, reinterpret_cast<sockaddr *>(&peer), &len) == 0) {
        ::inet_ntop(AF_INET, &peer.sin_addr, ip, sizeof(ip));
    }
    say("hub: TCP up to " + connecting_to_ + " (" + ip + ":" + std::to_string(ntohs(peer.sin_port)) + ")");
    notify();
}

void TcpLink::on_events(short revents)
{
    if (state_ == State::connecting) {
        if ((revents & (POLLOUT | POLLERR | POLLHUP)) == 0) {
            return;
        }
        int err = 0;
        socklen_t len = sizeof(err);
        ::getsockopt(fd_, SOL_SOCKET, SO_ERROR, &err, &len);
        if (err != 0) {
            close(std::strerror(err));
            return;
        }
        connected();
        return;
    }
    if (state_ != State::up) {
        return;
    }
    if ((revents & (POLLIN | POLLHUP | POLLERR)) != 0) {
        read();
    }
    if (state_ == State::up && (revents & POLLOUT) != 0) {
        flush();
    }
}

void TcpLink::flush()
{
    while (state_ == State::up && !tx_.empty()) {
        const ssize_t n = ::send(fd_, tx_.data(), tx_.size(), MSG_NOSIGNAL);
        if (n > 0) {
            tx_.erase(tx_.begin(), tx_.begin() + n);
            continue;
        }
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) {
            return;  // POLLOUT brings us back
        }
        close("send failed");
        return;
    }
}

void TcpLink::read()
{
    uint8_t buf[4096];
    const ssize_t n = ::recv(fd_, buf, sizeof(buf), 0);
    if (n == 0) {
        close("closed by the hub");
        return;
    }
    if (n < 0) {
        if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
            close("recv failed");
        }
        return;
    }
    rx_.insert(rx_.end(), buf, buf + n);
    size_t at = 0;
    while (rx_.size() - at >= 2) {
        const size_t len = rx_[at] | static_cast<size_t>(rx_[at + 1]) << 8;
        if (len == 0 || len > proto::kMtuBulk) {
            close("bad frame length");
            return;
        }
        if (rx_.size() - at - 2 < len) {
            break;
        }
        const std::vector<uint8_t> env(rx_.begin() + static_cast<long>(at + 2),
                                       rx_.begin() + static_cast<long>(at + 2 + len));
        at += 2 + len;
        if (rx) {
            rx(env);
        }
        if (state_ != State::up) {
            return;  // Net dropped the link while handling it
        }
        if (!session_ && net_ != nullptr && net_->state().link(net::LinkKind::tcp).session) {
            welcomed();  // the plan follows the WELCOME on this connection
        }
    }
    rx_.erase(rx_.begin(), rx_.begin() + static_cast<long>(at));
}

void TcpLink::close(const char *why, End end)
{
    if (fd_ < 0) {
        return;
    }
    const bool was_up = state_ == State::up;
    const bool had_session = session_;
    session_ = false;
    ::close(fd_);
    fd_ = -1;
    state_ = State::idle;
    connect_deadline_ = kNever;
    tx_.clear();
    rx_.clear();
    const TimeUs now = core_.now();
    if (was_up && now - up_since_ >= timing_.stable_us) {
        backoff_us_ = timing_.backoff_min_us;
    }
    retry_at_ = now + backoff_us_;
    backoff_us_ = std::min(backoff_us_ * 2, timing_.backoff_max_us);
    say(std::string("hub: TCP closed: ") + why);
    if (was_up) {
        notify();
    }
    // What this end means for the choice of hub: a session that ended is tried again where it was; an attempt that
    // got none counts against its hub. A move to another hub is the caller's.
    if (end == End::moving) {
        return;
    }
    if (had_session) {
        plan_.lost(now);
    } else if (!held_) {
        attempt_failed();
    }
}

void TcpLink::notify()
{
    // As on target, the link change reaches Net through the core queue, never re-entrantly.
    net::Net *net = net_;
    if (net != nullptr) {
        core_.post([net] { net->link_changed(net::LinkKind::tcp); });
    }
}

UdpLink::UdpLink()
{
    fd_ = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (fd_ >= 0) {
        set_nonblocking(fd_);
    }
}

UdpLink::~UdpLink()
{
    if (fd_ >= 0) {
        ::close(fd_);
    }
}

Status UdpLink::send(std::span<const uint8_t> envelope)
{
    if (!up()) {
        return std::unexpected(Err::busy);
    }
    const ssize_t n =
        ::sendto(fd_, envelope.data(), envelope.size(), 0, reinterpret_cast<const sockaddr *>(&to_), sizeof(to_));
    if (n != static_cast<ssize_t>(envelope.size())) {
        return std::unexpected(Err::busy);
    }
    return {};
}

}  // namespace fr::posix
