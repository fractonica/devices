// The fr_net task and the TCP/UDP links (design c3 §3 "Links", spec 05 §5.10-5.12). The task owns Wi-Fi
// control (WifiSta), hub_host resolution and the TCP socket; it sleeps in select() on the TCP socket and an
// eventfd that Wi-Fi events, TX frames and drop requests poke. The core task's side never blocks: a TCP
// frame is appended to a lock-free FIFO, a UDP datagram is one non-blocking sendto() on a socket that
// lives for the whole run, so only one task ever writes to each socket. The address chain, with the hub's
// `_fractonica._tcp` advert as its last step (design c6 D26), is hub_resolve.hpp's.
//
// Design multi-hub-m1: with a hub list (fr.node.hubs_set, nvs:fr_hubs) the task also chooses the hub. HubPlan
// (fr/net/hub_plan.hpp) says which hub of the list to try, when to give one up, when to probe a hub above the
// current one and when a pushed list's trial is over; this file resolves, connects and probes as it says. What
// addresses "the hub" (TCP, UDP, and through status() the OTA download and the HTTP streams) reads hub_ip_ and
// hub_port_, which only ever name the hub of the current connection attempt: a probe has its own socket and
// address. With no list nothing here differs from before: one hub, the old chain, no WELCOME timeout, no probes.
//
// M2-C4 (design m2-c4-gateway D8): a gateway (CONFIG_FR_ROLE 1) never resolves the hub nor opens TCP or UDP (its hub
// link is USB), while its STA joins as any node's does. Spike S2's `air txpower` and `wifi proto` hooks (D19) end here.
#include <fcntl.h>
#include <sys/select.h>
#include <sys/time.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cinttypes>
#include <cstdio>
#include <cstring>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_vfs_eventfd.h"
#include "esp_wifi.h"
#include "fr/net/esp.hpp"
#include "fr/net/hub_plan.hpp"
#include "fr/net/limits.hpp"
#include "fr/net/tx_fifo.hpp"
#include "fr/wire.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "lwip/inet.h"
#include "lwip/netdb.h"
#include "lwip/sockets.h"
#include "mdns.h"
#include "sdkconfig.h"
#include "band_rules.hpp"
#include "hub_resolve.hpp"
#include "protocol.hpp"  // generated fr::proto::kMtuBulk
#include "wifi_sta.hpp"

namespace fr::net::esp {
namespace {

using detail::Event;
using detail::WifiSta;

constexpr const char *TAG = "fr_net";
// Design m2-c4-gateway D8: no hub IP links on a gateway (Role gateway = 1, schema/protocol.yaml).
constexpr bool kHubIp = CONFIG_FR_ROLE != 1;
// Above fr_core (10): a frame the core queues for TCP goes out as soon as the core yields the CPU it was
// queued on. Below lwIP (18), the event loop (20) and Wi-Fi (23), as every fr task (spec 03 §3.4).
constexpr UBaseType_t kTaskPrio = 11;
constexpr uint32_t kTaskStack = 4096;
constexpr size_t kEventQueue = 16;
// A few bulk RESULTs, or a get_state burst before udp_ok (8 KB, or the memory class's).
constexpr size_t kTxBytes = limits::kTcpTxBytes;
static_assert((kTxBytes & (kTxBytes - 1)) == 0, "FR_NET_TCP_TX_BYTES must be a power of two");
constexpr size_t kMaxFrame = fr::proto::kMtuBulk;
constexpr TimeUs kBackoffMinUs = 250'000;  // 05 §5.11: reconnect backoff 0.25 -> 5 s
constexpr TimeUs kBackoffMaxUs = 5'000'000;
constexpr TimeUs kStableUs = 10'000'000;  // a connection that lasted this long starts the backoff over
constexpr TimeUs kConnectTimeoutUs = 3'000'000;
constexpr TimeUs kIdleWaitUs = 1'000'000;  // longest select() wait, so deadlines are never far off
constexpr uint32_t kMdnsTimeoutMs = 1000;
// A failback probe's lookup (design multi-hub-m1): the task is in it instead of in select(), so the session's frames
// wait behind it; a hub that is back answers within tens of ms.
constexpr uint32_t kProbeMdnsTimeoutMs = 300;
constexpr TimeUs kListApplyDelayUs = 300'000;  // hubs_set: let its RESULT leave first (as net_set)
// The hub's advert (05 §5.12.5 step 4, 08 §8.10): SRV port 7421, TXT http=7422 api=7420.
constexpr const char *kAdvertService = "_fractonica";
constexpr const char *kAdvertProto = "_tcp";
// 05 §5.11: SO_KEEPALIVE idle 5 s, interval 1 s, count 3 on both ends.
constexpr int kKeepIdleS = 5;
constexpr int kKeepIntvlS = 1;
constexpr int kKeepCnt = 3;

TimeUs now_us()
{
    return esp_timer_get_time();
}

/**
 * Why a TCP connection ended, or why an attempt never connected: the one log line of each close and, for an
 * established connection, its diag `stats` counter (tcp_close_*; bad frames are tcp_rx_bad).
 */
enum class Close : uint8_t {
    none,       // no address or no socket: nothing was open, nothing to say
    connect,    // the attempt failed (errno) or timed out (0)
    peer,       // the hub closed it (its offline timeout, a newer HELLO of this device, a restart)
    keepalive,  // lwIP gave up on the hub: keepalive (idle 5 s + 3 x 1 s) or retransmission timeout
    error,      // receive or send failed with another errno (a reset, say)
    bad_frame,  // a length of 0 or above the bulk MTU from the hub
    session,    // Net lost the session (Link::drop) and asked for a fresh connection
    wifi,       // Wi-Fi association or address lost
    // Design multi-hub-m1, with a hub list only; logged, not in a diag counter of their own (closes_ counts them).
    no_welcome,  // connected, but no WELCOME within HubTiming::welcome_wait_us: this hub does not take the board
    hubs,        // the board goes to another hub: a hub above this one answers again, or the list changed
};
constexpr size_t kCloseKinds = static_cast<size_t>(Close::hubs) + 1;

const char *drop_text(DropReason why)
{
    switch (why) {
    case DropReason::hub_silent:
        return "no hub frame for 3.5 heartbeat intervals";
    case DropReason::hub_bye:
        return "the hub said BYE";
    case DropReason::hub_restarted:
        return "a new hub run WELCOMEd the other link";
    }
    return "?";
}

/** hub_resolve.hpp's lookups on lwIP and espressif/mdns, each bounded by kMdnsTimeoutMs. fr_net task. */
class EspResolver final : public detail::Resolver
{
public:
    /** How long an mDNS A query waits (a probe's is shorter). */
    uint32_t timeout_ms = kMdnsTimeoutMs;

    uint32_t mdns_a(const char *name) override
    {
        esp_ip4_addr_t a{};
        esp_err_t err = mdns_query_a(name, timeout_ms, &a);
        if (err != ESP_OK || a.addr == 0) {
            ESP_LOGD(TAG, "hub: mDNS %s.local: %s", name, esp_err_to_name(err));
            return 0;
        }
        return a.addr;
    }

    uint32_t dns(const char *host) override
    {
        addrinfo hints{};
        hints.ai_family = AF_INET;
        hints.ai_socktype = SOCK_STREAM;
        addrinfo *res = nullptr;
        uint32_t ip = 0;
        if (getaddrinfo(host, nullptr, &hints, &res) == 0 && res != nullptr) {
            ip = reinterpret_cast<const sockaddr_in *>(res->ai_addr)->sin_addr.s_addr;
        }
        if (res != nullptr) {
            freeaddrinfo(res);
        }
        return ip;
    }

    bool browse(detail::Advert &out) override
    {
        mdns_result_t *res = nullptr;
        esp_err_t err = mdns_query_ptr(kAdvertService, kAdvertProto, kMdnsTimeoutMs, 1, &res);
        if (err != ESP_OK || res == nullptr) {
            ESP_LOGD(TAG, "hub: mDNS %s.%s.local: %s", kAdvertService, kAdvertProto,
                     err != ESP_OK ? esp_err_to_name(err) : "no answer");
            return false;
        }
        fill(out, *res);
        mdns_query_results_free(res);
        return out.instance[0] != '\0';
    }

    bool srv(detail::Advert &out) override
    {
        mdns_result_t *res = nullptr;
        esp_err_t err = mdns_query_srv(out.instance, kAdvertService, kAdvertProto, kMdnsTimeoutMs, &res);
        if (err != ESP_OK || res == nullptr) {
            return false;
        }
        fill(out, *res);
        mdns_query_results_free(res);
        return out.port != 0;
    }

private:
    /** What one answer gave: the PTR instance, the SRV target and port, the target's first IPv4. */
    static void fill(detail::Advert &out, const mdns_result_t &r)
    {
        if (r.instance_name != nullptr) {
            std::snprintf(out.instance, sizeof(out.instance), "%s", r.instance_name);
        }
        if (r.hostname != nullptr) {
            std::snprintf(out.host, sizeof(out.host), "%s", r.hostname);
        }
        if (r.port != 0) {
            out.port = r.port;
        }
        for (const mdns_ip_addr_t *a = r.addr; a != nullptr && out.ip == 0; a = a->next) {
            if (a->addr.type == ESP_IPADDR_TYPE_V4) {
                out.ip = a->addr.u_addr.ip4.addr;
            }
        }
    }
};

/** The hub address, the TCP connection and the UDP socket. Methods run on the fr_net task unless noted. */
class Hub
{
public:
    void configure(const Settings &s);

    bool open_udp()
    {
        udp_fd_ = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
        if (udp_fd_ < 0) {
            ESP_LOGE(TAG, "hub: no UDP socket (errno %d)", errno);
            return false;
        }
        set_nonblocking(udp_fd_);
        return true;
    }

    void poll(TimeUs now, const WifiSta &wifi);
    /** Waits in select() until a socket, the eventfd or `deadline` (0: none) needs the task. */
    void wait(TimeUs now, TimeUs deadline, int efd);
    /** Hands link changes to the core, retrying the ones it could not take. */
    void notify(const Hooks &hooks);

    // Core task.
    bool tcp_up() const { return tcp_up_.load(std::memory_order_acquire); }
    bool udp_up() const { return udp_up_.load(std::memory_order_acquire); }
    fr::Status tcp_send(std::span<const uint8_t> env);
    fr::Status udp_send(std::span<const uint8_t> env);
    /** The TX FIFO's fill: bytes not yet handed to lwIP (Link::queued; design m2-c2 D20, LOG waits for 0). */
    size_t tcp_queued() const { return tx_.fill(); }
    void request_drop(DropReason why)
    {
        drop_why_.store(static_cast<uint8_t>(why), std::memory_order_relaxed);
        drop_req_.store(true, std::memory_order_release);
        detail::wake();
    }
    void request_hold(bool on)
    {
        hold_.store(on, std::memory_order_release);
        detail::wake();
    }

    void fill(Status &s) const;

    // Design multi-hub-m1. Core task unless noted.
    fr::Status request_hubs(const HubList &list);
    HubsNow hubs_now() const;
    /** Any task. */
    void set_busy(bool on) { busy_.store(on, std::memory_order_relaxed); }
    uint32_t far_end() const { return far_.load(std::memory_order_acquire); }

private:
    enum class Phase : uint8_t { idle, waiting, connecting, connected };

    static void set_nonblocking(int fd)
    {
        int flags = fcntl(fd, F_GETFL, 0);
        fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    }

    void resolve(const WifiSta &wifi);
    void start_connect(TimeUs now);
    void on_connected(TimeUs now);
    void finish_connect(TimeUs now);
    /** Closes the TCP socket (if open) and schedules the next attempt. `why` and `detail` (an errno, 0 for
     * none; for Close::wifi the Wi-Fi disconnect reason) say what happened: one log line when a socket was
     * open, and the counter of its kind when it was connected. */
    void close_tcp(TimeUs now, Close why, int detail = 0);
    /** Closes on a failed recv()/send(): lwIP aborting the connection is the keepalive's verdict. */
    void close_on_errno(TimeUs now, int err);
    void receive(TimeUs now);
    void flush(TimeUs now);
    void set_tcp_up(bool v);
    void set_udp_up(bool v);
    // Design multi-hub-m1 (fr_net task).
    /** The hub of the list the plan names, for a log line. */
    const char *hub_name(uint8_t i) const;
    /** A WELCOME on the current connection: the session is with this hub; a list on trial is kept. */
    void on_welcome(TimeUs now);
    /** A pushed list whose time has come: kept at once when it names the hub of the session, else tried. */
    void take_list(TimeUs now, const WifiSta &wifi);
    void revert_list(TimeUs now);
    void store_list();
    /** What hubs_get reads: the list, the session's hub and the trial. */
    void publish();
    void probe_poll(TimeUs now);
    void probe_done(TimeUs now, bool ok);

    uint16_t default_port_ = 7421;  // CONFIG_FR_HUB_PORT
    detail::HubAddress address_;     // the chain: hub_host, its last address, hub_ip, the advert
    EspResolver resolver_;
    bool unresolved_said_ = false;  // "does not resolve" logged since the last address
    std::atomic<uint32_t> hub_ip_{0};  // what TCP connects to and UDP sends to (network order)
    std::atomic<uint16_t> hub_port_{7421};  // ... at this port: the configured one, or the advert's SRV port
    char resolved_host_[FR_ID_HOST_MAX + 1] = {};  // hub_host behind hub_ip_, for diag (under host_mux_)
    mutable portMUX_TYPE host_mux_ = portMUX_INITIALIZER_UNLOCKED;

    Phase phase_ = Phase::idle;
    int fd_ = -1;
    int udp_fd_ = -1;
    TimeUs next_at_ = 0;
    TimeUs deadline_ = 0;
    TimeUs connected_at_ = 0;
    TimeUs backoff_ = kBackoffMinUs;
    uint32_t fail_streak_ = 0;  // attempts in a row that never connected: only the first is logged loudly

    TxFifo<kTxBytes> tx_;
    uint8_t rx_[2 + kMaxFrame];
    size_t rx_fill_ = 0;

    std::atomic<bool> tcp_up_{false};
    std::atomic<bool> udp_up_{false};
    std::atomic<bool> drop_req_{false};
    std::atomic<uint8_t> drop_why_{0};  // DropReason of the pending drop_req_
    std::atomic<bool> hold_{false};     // drop_hub_link: no reconnect (core task writes)
    bool held_ = false;                 // hold_ as poll() last saw it
    uint8_t pending_ = 0;  // LinkKind bits whose change the core has not taken yet

    std::atomic<uint32_t> connects_{0};
    std::atomic<uint32_t> closes_{0};
    std::atomic<uint32_t> close_by_[kCloseKinds]{};  // closes_ by Close kind
    std::atomic<int> last_errno_{0};                    // of the last keepalive or error close
    std::atomic<uint32_t> tx_dropped_{0};
    std::atomic<uint32_t> rx_bad_{0};
    std::atomic<uint32_t> udp_fail_{0};

    // Design multi-hub-m1 (fr_net task unless noted).
    HubPlan plan_;
    HubList list_{};  // the list in force, a list on trial included; count 0: none, the provisioned hub
    HubList prev_{};  // what a failed trial returns to
    uint32_t prov_ts_ = 0;        // fr_ident's, stored with a list (a later provisioning supersedes it)
    bool conn_session_ = false;   // the current connection got a WELCOME
    int probe_fd_ = -1;           // a failback probe's connect, -1: none out
    TimeUs probe_deadline_ = 0;
    uint32_t far_ip_ = 0;         // where the last connection went ...
    uint16_t far_port_ = 0;
    std::atomic<uint32_t> far_{0};     // ... counted up when the next one goes elsewhere (Link::far_end)
    std::atomic<bool> busy_{false};    // an OTA runs over this hub: no failback
    fr_hub_list_t stored_{};           // scratch for nvs:fr_hubs, off the task's stack
    // The handover from the core task (hubs_set) and what hubs_get reads, under list_mux_.
    mutable portMUX_TYPE list_mux_ = portMUX_INITIALIZER_UNLOCKED;
    HubList next_list_{};
    bool next_list_set_ = false;
    TimeUs next_list_at_ = 0;
    HubsNow pub_{};
};

WifiSta s_wifi;
Hub s_hub;
Hooks s_hooks{};
QueueHandle_t s_events = nullptr;
int s_efd = -1;
bool s_started = false;
std::atomic<uint32_t> s_events_lost{0};
int8_t s_profile_qdbm = 0;  // the TX power in force once start() applied the board cap (`air txpower profile`)

// ---- Hub ----

void Hub::configure(const Settings &s)
{
    default_port_ = s.hub_port;
    hub_port_.store(s.hub_port, std::memory_order_relaxed);
    address_.configure(s.hub_port, detail::parse_ipv4(s.hub_ip));
    prov_ts_ = s.prov_ts;
    if (kHubIp && fr_id_load_hubs(&stored_) == ESP_OK) {
        if (hub_list_superseded(stored_.base_prov_ts, prov_ts_)) {
            // fr_ident was written again since (a reprovision): the hub it names wins (as nvs:fr_net2).
            ESP_LOGI(TAG, "hub: dropping a hub list from an earlier provisioning");
            fr_id_clear_hubs();
        } else {
            list_.rev = stored_.rev;
            list_.count = stored_.count;
            for (size_t i = 0; i < stored_.count; ++i) {
                std::snprintf(list_.hubs[i].host, sizeof(list_.hubs[i].host), "%s", stored_.hubs[i].host);
                std::snprintf(list_.hubs[i].ip, sizeof(list_.hubs[i].ip), "%s", stored_.hubs[i].ip);
            }
            if (list_.count != 0) {
                ESP_LOGI(TAG, "hub: list rev %" PRIu32 ": %u hub(s), first %s", list_.rev, static_cast<unsigned>(list_.count),
                         list_.hubs[0].host);
            }
        }
    }
    prev_ = list_;
    plan_.reset(list_.count);
    publish();
}

const char *Hub::hub_name(uint8_t i) const
{
    if (i == HubPlan::kAdvert) {
        return "any hub that advertises itself";
    }
    return i < list_.count ? list_.hubs[i].host : "(the provisioned hub)";
}

void Hub::publish()
{
    const uint8_t on = plan_.on();
    portENTER_CRITICAL(&list_mux_);
    pub_.list = list_;
    pub_.on = conn_session_ && on < list_.count ? on : 0xFF;
    pub_.trial = plan_.trial();
    portEXIT_CRITICAL(&list_mux_);
}

HubsNow Hub::hubs_now() const
{
    portENTER_CRITICAL(&list_mux_);
    HubsNow now = pub_;
    portEXIT_CRITICAL(&list_mux_);
    return now;
}

fr::Status Hub::request_hubs(const HubList &list)
{
    if constexpr (!kHubIp) {
        return std::unexpected(Err::unsupported);  // a gateway's hub link is USB: no hub to choose
    }
    fr::Status st{};
    portENTER_CRITICAL(&list_mux_);
    switch (hub_push_check(pub_.list, list)) {
    case HubPush::invalid:
        st = std::unexpected(Err::invalid_args);
        break;
    case HubPush::stale:
        st = std::unexpected(Err::expired);
        break;
    case HubPush::same:
        break;
    case HubPush::apply:
        if (next_list_set_) {
            st = std::unexpected(Err::busy);
            break;
        }
        next_list_ = list;
        next_list_set_ = true;
        next_list_at_ = now_us() + kListApplyDelayUs;
        break;
    }
    portEXIT_CRITICAL(&list_mux_);
    detail::wake();
    return st;
}

void Hub::store_list()
{
    stored_ = {};
    stored_.count = list_.count;
    stored_.rev = list_.rev;
    stored_.base_prov_ts = prov_ts_;
    for (size_t i = 0; i < list_.count; ++i) {
        std::snprintf(stored_.hubs[i].host, sizeof(stored_.hubs[i].host), "%s", list_.hubs[i].host);
        std::snprintf(stored_.hubs[i].ip, sizeof(stored_.hubs[i].ip), "%s", list_.hubs[i].ip);
    }
    esp_err_t err = fr_id_save_hubs(&stored_);
    if (err != ESP_OK) {
        // It is in force all the same; a reboot then returns to the list stored before it.
        ESP_LOGW(TAG, "hub: list rev %" PRIu32 " not stored (%s)", list_.rev, esp_err_to_name(err));
    }
    prev_ = list_;
}

void Hub::take_list(TimeUs now, const WifiSta &wifi)
{
    portENTER_CRITICAL(&list_mux_);
    const bool due = next_list_set_ && now >= next_list_at_;
    portEXIT_CRITICAL(&list_mux_);
    if (!due) {
        return;
    }
    // The hub the session is with, under the name the board has for it (none for a hub found by its advert).
    char cur[FR_ID_HOST_MAX + 1] = {};
    if (conn_session_) {
        const uint8_t on = plan_.on();
        std::snprintf(cur, sizeof(cur), "%s", plan_.count() == 0 ? wifi.hub_host() : on < list_.count ? list_.hubs[on].host : "");
    }
    if (!plan_.trial()) {
        prev_ = list_;  // a list pushed over one still on trial falls back to the last one that worked
    }
    portENTER_CRITICAL(&list_mux_);
    list_ = next_list_;
    next_list_set_ = false;
    portEXIT_CRITICAL(&list_mux_);
    address_.forget_entries();
    if (probe_fd_ >= 0) {
        close(probe_fd_);
        probe_fd_ = -1;
    }
    // No list (count 0) is the provisioned hub again: hub_host as the override or fr_ident give it.
    const int keep = cur[0] == '\0' ? -1 : list_.count == 0 ? (hub_host_eq(cur, wifi.hub_host()) ? 0 : -1) : hub_index_of(list_, cur);
    if (keep >= 0) {
        plan_.adopt(list_.count, static_cast<uint8_t>(keep), now);
        ESP_LOGI(TAG, "hub: list rev %" PRIu32 " (%u hub(s)) taken; it names %s, where the board is", list_.rev,
                 static_cast<unsigned>(list_.count), cur);
        store_list();
    } else {
        ESP_LOGI(TAG, "hub: list rev %" PRIu32 " (%u hub(s)) on trial: trying %s (reverted unless one of them answers in 60 s)",
                 list_.rev, static_cast<unsigned>(list_.count), list_.count != 0 ? list_.hubs[0].host : wifi.hub_host());
        if (fd_ >= 0) {
            close_tcp(now, Close::hubs);
        }
        plan_.reset(list_.count);
        plan_.begin_trial(now);
        backoff_ = kBackoffMinUs;
        next_at_ = now;
        fail_streak_ = 0;
    }
    publish();
}

void Hub::revert_list(TimeUs now)
{
    ESP_LOGW(TAG, "hub: no hub of list rev %" PRIu32 " answered in 60 s; back to rev %" PRIu32 " (%u hub(s))", list_.rev,
             prev_.rev, static_cast<unsigned>(prev_.count));
    if (fd_ >= 0) {
        close_tcp(now, Close::hubs);
    }
    list_ = prev_;
    address_.forget_entries();
    plan_.reset(list_.count);
    backoff_ = kBackoffMinUs;
    next_at_ = now;
    fail_streak_ = 0;
    publish();
}

void Hub::on_welcome(TimeUs now)
{
    if (conn_session_) {
        return;  // a second WELCOME on this connection (a HELLO that was repeated)
    }
    const bool trial = plan_.trial();
    conn_session_ = true;
    plan_.session(now);
    if (plan_.count() != 0) {
        const uint8_t on = plan_.on();
        ESP_LOGI(TAG, "hub: session with %s (%s%u of %u)", hub_name(on), on < list_.count ? "hub " : "outside the list of ",
                 on < list_.count ? static_cast<unsigned>(on + 1) : static_cast<unsigned>(list_.count),
                 static_cast<unsigned>(list_.count));
    }
    if (trial) {
        ESP_LOGI(TAG, "hub: list rev %" PRIu32 " confirmed", list_.rev);
        store_list();
    }
    publish();
}

void Hub::probe_poll(TimeUs now)
{
    if (probe_fd_ >= 0) {
        if (now >= probe_deadline_) {
            probe_done(now, false);
        }
        return;
    }
    if (phase_ != Phase::connected || !conn_session_) {
        return;
    }
    const uint8_t i = plan_.probe(now, busy_.load(std::memory_order_relaxed));
    if (i == HubPlan::kNone || i >= list_.count) {
        return;
    }
    // The probe has its own address and socket: hub_ip_ and hub_port_ stay the session's.
    resolver_.timeout_ms = kProbeMdnsTimeoutMs;
    const detail::Resolved r = address_.resolve_entry(i, list_.hubs[i].host, detail::parse_ipv4(list_.hubs[i].ip), resolver_);
    resolver_.timeout_ms = kMdnsTimeoutMs;
    now = now_us();
    if (r.ip == 0) {
        probe_done(now, false);
        return;
    }
    probe_fd_ = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (probe_fd_ < 0) {
        probe_done(now, false);
        return;
    }
    set_nonblocking(probe_fd_);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons(r.port);
    a.sin_addr.s_addr = r.ip;
    if (connect(probe_fd_, reinterpret_cast<const sockaddr *>(&a), sizeof(a)) == 0) {
        probe_done(now, true);
    } else if (errno != EINPROGRESS) {
        probe_done(now, false);
    } else {
        probe_deadline_ = now + kConnectTimeoutUs;
    }
}

void Hub::probe_done(TimeUs now, bool ok)
{
    if (probe_fd_ >= 0) {
        close(probe_fd_);  // a connect is the whole probe: the hub sees a connection that says nothing
        probe_fd_ = -1;
    }
    if (!plan_.probed(now, ok)) {
        return;
    }
    // It answered twice: the board returns to the hub that ranks above the one it is on.
    ESP_LOGI(TAG, "hub: %s answers again; returning to it", hub_name(plan_.target()));
    close_tcp(now, Close::hubs);
    backoff_ = kBackoffMinUs;
    next_at_ = now;
    fail_streak_ = 0;
    publish();
}

void Hub::set_tcp_up(bool v)
{
    if (tcp_up_.exchange(v, std::memory_order_acq_rel) != v) {
        pending_ |= 1u << index_of(LinkKind::tcp);
    }
}

void Hub::set_udp_up(bool v)
{
    if (udp_up_.exchange(v, std::memory_order_acq_rel) != v) {
        pending_ |= 1u << index_of(LinkKind::udp);
    }
}

void Hub::notify(const Hooks &hooks)
{
    for (LinkKind k : {LinkKind::tcp, LinkKind::udp}) {
        uint8_t bit = static_cast<uint8_t>(1u << index_of(k));
        if ((pending_ & bit) != 0 && hooks.link_changed != nullptr && hooks.link_changed(k)) {
            pending_ &= static_cast<uint8_t>(~bit);
        }
    }
}

void Hub::resolve(const WifiSta &wifi)
{
    // 05 §5.12.5: hub_host by mDNS on every attempt (macOS answers for <LocalHostName>.local whatever
    // Local Network Privacy says), then the address it last had, then fr_ident's hub_ip, then the hub's
    // _fractonica._tcp advert (design c6 D26; a C6 node with no hub_host finds the hub by itself).
    // With a hub list (design multi-hub-m1) the plan names the hub: one of the list by its own host, last address
    // and ip, or, after a round of them all, whichever hub the advert finds.
    const uint8_t target = plan_.target();
    const bool listed = plan_.count() != 0;
    const char *host = !listed ? wifi.hub_host() : target < list_.count ? list_.hubs[target].host : "";
    plan_.attempt(now_us());
    const detail::Resolved r =
        !listed ? address_.resolve(host, resolver_)
        : target < list_.count ? address_.resolve_entry(target, host, detail::parse_ipv4(list_.hubs[target].ip), resolver_)
                               : address_.any_hub(resolver_);
    const char *shown = host[0] != '\0' ? host : listed ? "(any hub)" : "(no hub_host)";
    if (r.ip == 0) {
        if (listed) {
            ESP_LOGD(TAG, "hub: %s does not resolve", shown);
        } else if (!unresolved_said_) {
            ESP_LOGW(TAG, "hub: %s does not resolve, there is no fallback address and no %s.%s advert answers",
                     shown, kAdvertService, kAdvertProto);
            unresolved_said_ = true;
        }
    } else {
        unresolved_said_ = false;
        if (r.ip != hub_ip_.load(std::memory_order_relaxed) || r.port != hub_port_.load(std::memory_order_relaxed)) {
            const uint8_t *b = reinterpret_cast<const uint8_t *>(&r.ip);
            if (r.port == default_port_) {
                ESP_LOGI(TAG, "hub: %s is %u.%u.%u.%u (%s)", shown, b[0], b[1], b[2], b[3], detail::how_name(r.how));
            } else {
                ESP_LOGI(TAG, "hub: %s is %u.%u.%u.%u port %u (%s)", shown, b[0], b[1], b[2], b[3], r.port,
                         detail::how_name(r.how));
            }
        }
        hub_port_.store(r.port, std::memory_order_relaxed);  // published by hub_ip_'s release below
    }
    portENTER_CRITICAL(&host_mux_);
    std::snprintf(resolved_host_, sizeof(resolved_host_), "%s", host);
    portEXIT_CRITICAL(&host_mux_);
    hub_ip_.store(r.ip, std::memory_order_release);
    set_udp_up(r.ip != 0);
}

void Hub::start_connect(TimeUs now)
{
    uint32_t ip = hub_ip_.load(std::memory_order_relaxed);
    if (ip == 0) {
        close_tcp(now, Close::none);
        return;
    }
    fd_ = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (fd_ < 0) {
        ESP_LOGW(TAG, "hub: no TCP socket (errno %d)", errno);
        close_tcp(now, Close::none);
        return;
    }
    set_nonblocking(fd_);
    int one = 1;
    int idle = kKeepIdleS;
    int intvl = kKeepIntvlS;
    int cnt = kKeepCnt;
    // 05 §5.12.1: no Nagle (frames are latency-bound); keepalive finds a dead peer behind a silent NAT.
    setsockopt(fd_, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    setsockopt(fd_, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof(one));
    setsockopt(fd_, IPPROTO_TCP, TCP_KEEPIDLE, &idle, sizeof(idle));
    setsockopt(fd_, IPPROTO_TCP, TCP_KEEPINTVL, &intvl, sizeof(intvl));
    setsockopt(fd_, IPPROTO_TCP, TCP_KEEPCNT, &cnt, sizeof(cnt));
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons(hub_port_.load(std::memory_order_relaxed));
    a.sin_addr.s_addr = ip;
    if (connect(fd_, reinterpret_cast<const sockaddr *>(&a), sizeof(a)) == 0) {
        on_connected(now);
        return;
    }
    if (errno != EINPROGRESS) {
        close_tcp(now, Close::connect, errno);
        return;
    }
    phase_ = Phase::connecting;
    deadline_ = now + kConnectTimeoutUs;
}

void Hub::finish_connect(TimeUs now)
{
    int err = 0;
    socklen_t len = sizeof(err);
    if (getsockopt(fd_, SOL_SOCKET, SO_ERROR, &err, &len) != 0 || err != 0) {
        close_tcp(now, Close::connect, err != 0 ? err : errno);
        return;
    }
    on_connected(now);
}

void Hub::on_connected(TimeUs now)
{
    // A new stream starts on a frame boundary: nothing queued for an earlier connection may lead it.
    tx_dropped_.fetch_add(tx_.discard(), std::memory_order_relaxed);
    rx_fill_ = 0;
    phase_ = Phase::connected;
    connected_at_ = now;
    fail_streak_ = 0;
    connects_.fetch_add(1, std::memory_order_relaxed);
    uint32_t ip = hub_ip_.load(std::memory_order_relaxed);
    const uint8_t *q = reinterpret_cast<const uint8_t *>(&ip);
    const unsigned port = hub_port_.load(std::memory_order_relaxed);
    ESP_LOGI(TAG, "hub: connected to %u.%u.%u.%u:%u", q[0], q[1], q[2], q[3], port);
    conn_session_ = false;
    if (ip != far_ip_ || port != far_port_) {
        // Another hub than the last connection reached (or the first one): Net takes its WELCOME for a new hub run.
        far_ip_ = ip;
        far_port_ = static_cast<uint16_t>(port);
        far_.fetch_add(1, std::memory_order_release);
    }
    set_tcp_up(true);
}

void Hub::close_tcp(TimeUs now, Close why, int detail)
{
    bool was_connected = phase_ == Phase::connected;
    if (fd_ >= 0 && why != Close::none) {
        char text[96];
        switch (why) {
        case Close::connect:
            if (detail != 0) {
                std::snprintf(text, sizeof(text), "connect failed (errno %d, %s)", detail, std::strerror(detail));
            } else {
                std::snprintf(text, sizeof(text), "connect timed out");
            }
            break;
        case Close::peer:
            std::snprintf(text, sizeof(text), "the hub closed it");
            break;
        case Close::keepalive:
            std::snprintf(text, sizeof(text), "keepalive or retransmit timeout (errno %d, %s)", detail,
                          std::strerror(detail));
            break;
        case Close::error:
            std::snprintf(text, sizeof(text), "socket error (errno %d, %s)", detail, std::strerror(detail));
            break;
        case Close::bad_frame:
            std::snprintf(text, sizeof(text), "bad frame length from the hub");
            break;
        case Close::session:
            std::snprintf(text, sizeof(text), "session lost: %s",
                          drop_text(static_cast<DropReason>(drop_why_.load(std::memory_order_relaxed))));
            break;
        case Close::wifi:
            if (detail != 0) {
                std::snprintf(text, sizeof(text), "Wi-Fi lost (disconnect reason %d)", detail);
            } else {
                std::snprintf(text, sizeof(text), "Wi-Fi lost (address lost)");
            }
            break;
        case Close::no_welcome:
            std::snprintf(text, sizeof(text), "no WELCOME from this hub");
            break;
        case Close::hubs:
            std::snprintf(text, sizeof(text), "going to another hub of the list");
            break;
        case Close::none:
            break;
        }
        if (was_connected) {
            // One line per close, so a reconnect seen on the bench says why (diag stats counts them).
            ESP_LOGW(TAG, "hub: TCP closed after %" PRId64 " ms: %s", (now - connected_at_) / 1000, text);
        } else {
            // While the hub is away every attempt fails the same way; the first one says so.
            esp_log_level_t level = fail_streak_ > 0 ? ESP_LOG_DEBUG : ESP_LOG_WARN;
            ESP_LOG_LEVEL_LOCAL(level, TAG, "hub: no connection: %s", text);
        }
    }
    if (!was_connected) {
        ++fail_streak_;
    }
    if (fd_ >= 0) {
        close(fd_);
        fd_ = -1;
    }
    if (was_connected) {
        set_tcp_up(false);
        closes_.fetch_add(1, std::memory_order_relaxed);
        close_by_[static_cast<size_t>(why)].fetch_add(1, std::memory_order_relaxed);
        if (why == Close::keepalive || why == Close::error) {
            last_errno_.store(detail, std::memory_order_relaxed);
        }
        tx_dropped_.fetch_add(tx_.discard(), std::memory_order_relaxed);
        if (now - connected_at_ >= kStableUs) {
            backoff_ = kBackoffMinUs;
        }
    }
    rx_fill_ = 0;
    phase_ = Phase::waiting;
    next_at_ = now + backoff_;
    backoff_ = std::min(backoff_ * 2, kBackoffMaxUs);
    // Design multi-hub-m1: what this end means for the choice of hub. A session that ended is tried again where it
    // was; an attempt that got none counts against its hub, and when the plan gives that hub up the next one is tried
    // at once. Wi-Fi going away says nothing about a hub (poll() pauses the plan); Close::hubs is the caller's move.
    const bool had_session = conn_session_;
    conn_session_ = false;
    if (why == Close::hubs || why == Close::wifi) {
        return;
    }
    if (had_session) {
        plan_.lost(now);
        publish();
        return;
    }
    const uint8_t gave_up = plan_.target();
    if (plan_.failed(now)) {
        if (gave_up != HubPlan::kAdvert) {
            ESP_LOGW(TAG, "hub: no session with %s; trying %s", hub_name(gave_up), hub_name(plan_.target()));
        }
        backoff_ = kBackoffMinUs;
        next_at_ = now;
        fail_streak_ = 0;
    }
}

void Hub::poll(TimeUs now, const WifiSta &wifi)
{
    if constexpr (!kHubIp) {
        return;  // a gateway: tcp_link() and udp_link() stay down, Net HELLOs over serial only (design m2-c4 D8)
    }
    // `net drop_hub_link` (09 §9.7): no resolve and no reconnect while it lasts; at its end, at once.
    bool hold = hold_.load(std::memory_order_acquire);
    if (held_ && !hold) {
        backoff_ = kBackoffMinUs;
        next_at_ = now;
    }
    held_ = hold;
    if (!wifi.ip_up()) {
        if (fd_ >= 0) {
            const bool had_session = conn_session_;
            close_tcp(now, Close::wifi, wifi.disconnect_reason());
            if (had_session) {
                plan_.lost(now);
                publish();
            }
        }
        if (probe_fd_ >= 0) {
            probe_done(now, false);
        }
        // No network: no hub is at fault, and a list on trial gets its 60 s from when the network is back (as a
        // net_set trial gets them after a `wifi_down` hold).
        plan_.pause();
        if (plan_.trial()) {
            plan_.begin_trial(now);
        }
        set_udp_up(false);
        phase_ = Phase::idle;
        backoff_ = kBackoffMinUs;
        drop_req_.store(false, std::memory_order_relaxed);
        return;
    }
    if (drop_req_.exchange(false, std::memory_order_acq_rel) && fd_ >= 0) {
        // Net lost the session (05 §5.11): a fresh connection and a fresh HELLO.
        close_tcp(now, Close::session);
    }
    // Design multi-hub-m1: a pushed list whose RESULT has left, and a trial that ran out.
    take_list(now, wifi);
    if (plan_.trial_expired(now)) {
        revert_list(now);
    }
    switch (phase_) {
    case Phase::idle:
        phase_ = Phase::waiting;
        next_at_ = now;
        [[fallthrough]];
    case Phase::waiting:
        if (!held_ && now >= next_at_) {
            resolve(wifi);
            start_connect(now_us());  // resolution may have taken its timeout
        }
        break;
    case Phase::connecting:
        if (now >= deadline_) {
            close_tcp(now, Close::connect);
        }
        break;
    case Phase::connected:
        // With a hub list a hub that connects but never WELCOMEs (another network's, found by its advert; a hub
        // without this board's row answers all the same) is a failed attempt. With none the board waits, as before.
        if (plan_.count() != 0 && !conn_session_ && now - connected_at_ >= plan_.timing().welcome_wait_us) {
            close_tcp(now, Close::no_welcome);
        }
        break;
    }
    probe_poll(now_us());
}

void Hub::receive(TimeUs now)
{
    ssize_t n = recv(fd_, rx_ + rx_fill_, sizeof(rx_) - rx_fill_, MSG_DONTWAIT);
    if (n == 0) {
        close_tcp(now, Close::peer);
        return;
    }
    if (n < 0) {
        if (errno != EAGAIN && errno != EWOULDBLOCK) {
            close_on_errno(now, errno);
        }
        return;
    }
    rx_fill_ += static_cast<size_t>(n);
    size_t off = 0;
    while (rx_fill_ - off >= 2) {
        size_t len = rx_[off] | static_cast<size_t>(rx_[off + 1]) << 8;
        if (len == 0 || len > kMaxFrame) {
            // Not our framing (or a desynchronised stream): nothing after it can be trusted.
            rx_bad_.fetch_add(1, std::memory_order_relaxed);
            close_tcp(now, Close::bad_frame);
            return;
        }
        if (rx_fill_ - off - 2 < len) {
            break;
        }
        const std::span<const uint8_t> env{rx_ + off + 2, len};
        if (!conn_session_) {
            // The session's first frame (design multi-hub-m1): the plan follows the WELCOME on this connection.
            if (const auto h = wire::unpack_header(env); h && h->cls == wire::kClsNet && h->kind == fr::proto::kKindNetWelcome) {
                on_welcome(now);
            }
        }
        if (s_hooks.deliver != nullptr) {
            s_hooks.deliver(LinkKind::tcp, env);  // it counts what it could not take
        }
        off += 2 + len;
    }
    // At most one partial frame remains, and a whole frame always fits the buffer.
    std::memmove(rx_, rx_ + off, rx_fill_ - off);
    rx_fill_ -= off;
}

void Hub::flush(TimeUs now)
{
    for (;;) {
        std::span<const uint8_t> chunk = tx_.peek();
        if (chunk.empty()) {
            return;
        }
        ssize_t n = send(fd_, chunk.data(), chunk.size(), MSG_DONTWAIT);
        if (n > 0) {
            tx_.consume(static_cast<size_t>(n));
            continue;
        }
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            return;  // select() reports when there is room again
        }
        close_on_errno(now, n < 0 ? errno : 0);
        return;
    }
}

void Hub::close_on_errno(TimeUs now, int err)
{
    // lwIP reports its own abort of a connection (keepalive probes unanswered, retransmissions exhausted)
    // as ECONNABORTED; ETIMEDOUT where a stack says so directly.
    close_tcp(now, err == ECONNABORTED || err == ETIMEDOUT ? Close::keepalive : Close::error, err);
}

void Hub::wait(TimeUs now, TimeUs deadline, int efd)
{
    auto consider = [&deadline](TimeUs d) {
        if (d != 0 && (deadline == 0 || d < deadline)) {
            deadline = d;
        }
    };
    if (phase_ == Phase::waiting && !held_) {
        consider(next_at_);
    } else if (phase_ == Phase::connecting) {
        consider(deadline_);
    }
    if (probe_fd_ >= 0) {
        consider(probe_deadline_);
    } else if (const TimeUs at = plan_.probe_at(); at != HubPlan::kNever) {
        consider(at);
    }
    TimeUs wait_us = kIdleWaitUs;
    if (deadline != 0) {
        wait_us = std::clamp(deadline - now, TimeUs{0}, kIdleWaitUs);
    }
    if (pending_ != 0) {
        wait_us = std::min(wait_us, TimeUs{20'000});  // the core queue was full: offer again soon
    }

    fd_set rd;
    fd_set wr;
    FD_ZERO(&rd);
    FD_ZERO(&wr);
    FD_SET(efd, &rd);
    int maxfd = efd;
    if (fd_ >= 0) {
        if (phase_ == Phase::connecting) {
            FD_SET(fd_, &wr);
        } else {
            FD_SET(fd_, &rd);
            if (!tx_.empty()) {
                FD_SET(fd_, &wr);
            }
        }
        maxfd = std::max(maxfd, fd_);
    }
    if (probe_fd_ >= 0) {
        FD_SET(probe_fd_, &wr);
        maxfd = std::max(maxfd, probe_fd_);
    }
    timeval tv{};
    tv.tv_sec = static_cast<time_t>(wait_us / 1'000'000);
    tv.tv_usec = static_cast<suseconds_t>(wait_us % 1'000'000);
    int n = select(maxfd + 1, &rd, &wr, nullptr, &tv);
    if (n < 0) {
        ESP_LOGW(TAG, "select failed (errno %d)", errno);
        vTaskDelay(pdMS_TO_TICKS(50));  // never spin
        return;
    }
    if (FD_ISSET(efd, &rd)) {
        uint64_t v = 0;
        read(efd, &v, sizeof(v));  // reset the counter; the loop looks at everything anyway
    }
    TimeUs t = now_us();
    if (probe_fd_ >= 0 && FD_ISSET(probe_fd_, &wr)) {
        int err = 0;
        socklen_t len = sizeof(err);
        probe_done(t, getsockopt(probe_fd_, SOL_SOCKET, SO_ERROR, &err, &len) == 0 && err == 0);
    }
    if (fd_ >= 0 && phase_ == Phase::connecting && FD_ISSET(fd_, &wr)) {
        finish_connect(t);
    }
    if (fd_ >= 0 && phase_ == Phase::connected && FD_ISSET(fd_, &rd)) {
        receive(t);
    }
    if (fd_ >= 0 && phase_ == Phase::connected) {
        flush(t);  // also what an eventfd poke from tcp_send() is for
    }
}

fr::Status Hub::tcp_send(std::span<const uint8_t> env)
{
    if (env.empty() || env.size() > kMaxFrame) {
        return std::unexpected(Err::invalid_args);
    }
    if (!tcp_up()) {
        return std::unexpected(Err::busy);
    }
    if (!tx_.push(env)) {
        tx_dropped_.fetch_add(1, std::memory_order_relaxed);
        return std::unexpected(Err::busy);
    }
    detail::wake();
    return {};
}

fr::Status Hub::udp_send(std::span<const uint8_t> env)
{
    if (!udp_up() || udp_fd_ < 0) {
        return std::unexpected(Err::busy);
    }
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = hub_ip_.load(std::memory_order_acquire);
    a.sin_port = htons(hub_port_.load(std::memory_order_relaxed));  // after the address: its acquire covers it
    // Non-blocking: when the driver has no TX buffer (ENOMEM) the datagram is lost; Net retries Q1.
    if (sendto(udp_fd_, env.data(), env.size(), MSG_DONTWAIT, reinterpret_cast<const sockaddr *>(&a), sizeof(a)) < 0) {
        udp_fail_.fetch_add(1, std::memory_order_relaxed);
        return std::unexpected(Err::busy);
    }
    return {};
}

void Hub::fill(Status &s) const
{
    uint32_t ip = hub_ip_.load(std::memory_order_acquire);
    std::memcpy(s.hub_ip, &ip, sizeof(s.hub_ip));
    portENTER_CRITICAL(&host_mux_);
    std::memcpy(s.hub_host, resolved_host_, sizeof(s.hub_host));
    portEXIT_CRITICAL(&host_mux_);
    s.tcp_up = tcp_up();
    s.udp_up = udp_up();
    s.tcp_connects = connects_.load(std::memory_order_relaxed);
    s.tcp_closes = closes_.load(std::memory_order_relaxed);
    auto by = [this](Close c) { return close_by_[static_cast<size_t>(c)].load(std::memory_order_relaxed); };
    s.tcp_close_peer = by(Close::peer);
    s.tcp_close_keepalive = by(Close::keepalive);
    s.tcp_close_error = by(Close::error);
    s.tcp_close_session = by(Close::session);
    s.tcp_close_wifi = by(Close::wifi);
    s.tcp_last_errno = last_errno_.load(std::memory_order_relaxed);
    s.tcp_tx_dropped = tx_dropped_.load(std::memory_order_relaxed);
    s.tcp_rx_bad = rx_bad_.load(std::memory_order_relaxed);
    s.udp_tx_fail = udp_fail_.load(std::memory_order_relaxed);
}

// ---- links ----

class TcpLink final : public Link
{
public:
    LinkKind kind() const override { return LinkKind::tcp; }
    bool up() const override { return s_hub.tcp_up(); }
    fr::Status send(std::span<const uint8_t> envelope) override { return s_hub.tcp_send(envelope); }
    void drop(DropReason why) override { s_hub.request_drop(why); }
    void hold(bool on) override { s_hub.request_hold(on); }
    size_t queued() const override { return s_hub.tcp_queued(); }
    uint32_t far_end() const override { return s_hub.far_end(); }
};

class UdpLink final : public Link
{
public:
    LinkKind kind() const override { return LinkKind::udp; }
    bool up() const override { return s_hub.udp_up(); }
    fr::Status send(std::span<const uint8_t> envelope) override { return s_hub.udp_send(envelope); }
};

TcpLink s_tcp;
UdpLink s_udp;

// ---- task and events ----

/** Default event loop task: copy the event for the fr_net task, which runs the state machine. */
void on_event(void *, esp_event_base_t base, int32_t id, void *data)
{
    Event e;
    std::memset(&e, 0, sizeof(e));
    e.base = base;
    e.id = id;
    size_t size = 0;
    if (base == WIFI_EVENT) {
        switch (id) {
        case WIFI_EVENT_STA_START:
        case WIFI_EVENT_STA_STOP:
        case WIFI_EVENT_SCAN_DONE:
            break;
        case WIFI_EVENT_STA_CONNECTED:
            size = sizeof(e.data.connected);
            break;
        case WIFI_EVENT_STA_DISCONNECTED:
            size = sizeof(e.data.disconnected);
            break;
        case WIFI_EVENT_HOME_CHANNEL_CHANGE:
            size = sizeof(e.data.channel);
            break;
        default:
            return;
        }
    } else if (base == IP_EVENT) {
        if (id == IP_EVENT_STA_GOT_IP) {
            size = sizeof(e.data.got_ip);
        } else if (id != IP_EVENT_STA_LOST_IP) {
            return;
        }
    } else {
        return;
    }
    if (data != nullptr && size > 0) {
        std::memcpy(&e.data, data, size);
    }
    if (xQueueSend(s_events, &e, 0) != pdTRUE) {
        // The state machine's own deadlines recover from a lost event.
        s_events_lost.fetch_add(1, std::memory_order_relaxed);
    }
    detail::wake();
}

void task_main(void *)
{
    for (;;) {
        TimeUs now = now_us();
        Event e;
        while (xQueueReceive(s_events, &e, 0) == pdTRUE) {
            s_wifi.on_event(e, now);
        }
        s_wifi.poll(now);
        s_hub.poll(now, s_wifi);
        s_hub.notify(s_hooks);
        s_hub.wait(now_us(), s_wifi.next_deadline(), s_efd);
    }
}

bool check(esp_err_t err, const char *what)
{
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "%s: %s", what, esp_err_to_name(err));
        return false;
    }
    return true;
}

}  // namespace

namespace detail {

void wake()
{
    if (s_efd >= 0) {
        uint64_t one = 1;
        write(s_efd, &one, sizeof(one));
    }
}

}  // namespace detail

namespace {

static_assert(WIFI_PROTOCOL_11B == detail::kProto11b && WIFI_PROTOCOL_11G == detail::kProto11g &&
              WIFI_PROTOCOL_11N == detail::kProto11n && WIFI_PROTOCOL_11A == detail::kProto11a &&
              WIFI_PROTOCOL_11AC == detail::kProto11ac && WIFI_PROTOCOL_11AX == detail::kProto11ax);

}  // namespace

bool start(const Settings &settings, const Hooks &hooks)
{
    if (s_started) {
        return true;
    }
    s_hooks = hooks;
    s_hub.configure(settings);
    s_wifi.configure(settings, now_us());

    if (!check(esp_netif_init(), "esp_netif_init")) {
        return false;
    }
    esp_err_t err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {  // INVALID_STATE: someone created it already
        return check(err, "esp_event_loop_create_default");
    }
    esp_netif_t *netif = esp_netif_create_default_wifi_sta();
    if (netif == nullptr) {
        ESP_LOGE(TAG, "no Wi-Fi STA netif");
        return false;
    }
    if (settings.hostname[0] != '\0') {
        esp_netif_set_hostname(netif, settings.hostname);  // before DHCP starts: the router lists the alias
    }
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    if (!check(esp_wifi_init(&cfg), "esp_wifi_init")) {
        return false;
    }
    // The credentials live in fr_ident / fr_net2 only; the driver must not copy them into its NVS.
    check(esp_wifi_set_storage(WIFI_STORAGE_RAM), "esp_wifi_set_storage");
    if (!check(esp_wifi_set_mode(WIFI_MODE_STA), "esp_wifi_set_mode")) {
        return false;
    }
    if (settings.country[0] != '\0') {
        // Manual policy (802.11d off): the legal channel set is the provisioned country's (05 §5.3).
        check(esp_wifi_set_country_code(settings.country, false), "esp_wifi_set_country_code");
    } else {
        ESP_LOGW(TAG, "wifi: no country in fr_ident; using the driver default");
    }
    // Before Wi-Fi starts, so mDNS sees the STA interface come up.
    if (!check(mdns_init(), "mdns_init")) {
        ESP_LOGW(TAG, "hub: no mDNS; hub_host falls back to the provisioned hub_ip");
    }

    esp_vfs_eventfd_config_t efd_cfg{};
    efd_cfg.max_fds = 4;
    err = esp_vfs_eventfd_register(&efd_cfg);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {  // INVALID_STATE: already registered
        return check(err, "esp_vfs_eventfd_register");
    }
    s_efd = eventfd(0, 0);
    s_events = xQueueCreate(kEventQueue, sizeof(Event));
    if (s_efd < 0 || s_events == nullptr) {
        ESP_LOGE(TAG, "no eventfd or event queue");
        return false;
    }
    s_hub.open_udp();
    if (!check(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, nullptr, nullptr),
               "wifi event handler") ||
        !check(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, nullptr, nullptr),
               "ip event handler") ||
        !check(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_LOST_IP, on_event, nullptr, nullptr),
               "ip event handler")) {
        return false;
    }
#if CONFIG_FREERTOS_NUMBER_OF_CORES > 1
    // S3: on core 0 with Wi-Fi and lwIP. Unpinned, this task (priority 11) could preempt the core task (10), which owns
    // core 1 (spec 03 §3.4): M2-C5 bench, pad-s3's T-HIL LED rule saw a ~5.5 ms gap between an LED write and its STATE.
    if (xTaskCreatePinnedToCore(task_main, "fr_net", kTaskStack, nullptr, kTaskPrio, nullptr, 0) != pdPASS) {
#else
    if (xTaskCreate(task_main, "fr_net", kTaskStack, nullptr, kTaskPrio, nullptr) != pdPASS) {
#endif
        ESP_LOGE(TAG, "cannot create the fr_net task");
        return false;
    }
    // The band mode (design csi-c1 D6) is set on the fr_net task at STA_START, before its first scan (WifiSta).
    if (!check(esp_wifi_start(), "esp_wifi_start")) {
        return false;
    }
    // 05 §5.3: modem sleep would delay every frame to the next DTIM (mains-powered nodes).
    check(esp_wifi_set_ps(WIFI_PS_NONE), "esp_wifi_set_ps");
#if CONFIG_FR_WIFI_MAX_TX_POWER_QDBM > 0
    // Board manifest rf.max_tx_power_qdbm: valid only after esp_wifi_start().
    if (check(esp_wifi_set_max_tx_power(CONFIG_FR_WIFI_MAX_TX_POWER_QDBM), "esp_wifi_set_max_tx_power")) {
        ESP_LOGI(TAG, "wifi: TX power capped at %d.%02d dBm", CONFIG_FR_WIFI_MAX_TX_POWER_QDBM / 4,
                 CONFIG_FR_WIFI_MAX_TX_POWER_QDBM % 4 * 25);
    }
    s_profile_qdbm = CONFIG_FR_WIFI_MAX_TX_POWER_QDBM;
#else
    // No board cap: the driver's default, read back now, is what `air txpower profile` restores.
    if (int8_t q = 0; esp_wifi_get_max_tx_power(&q) == ESP_OK) {
        s_profile_qdbm = q;
    }
#endif

    uint8_t sta[6];
    if (esp_wifi_get_mac(WIFI_IF_STA, sta) == ESP_OK && std::memcmp(sta, settings.mac, sizeof(sta)) != 0) {
        // 06 §6.3: device_id is the STA MAC; the hub keys TCP/serial sessions and the directory by it.
        ESP_LOGE(TAG, "STA MAC %02x%02x%02x%02x%02x%02x is not the device id", sta[0], sta[1], sta[2], sta[3], sta[4],
                 sta[5]);
    }
    if (settings.creds.ssid[0] == '\0') {
        ESP_LOGW(TAG, "wifi: no network provisioned; not joining");
    }
    s_started = true;
    return true;
}

Link &tcp_link()
{
    return s_tcp;
}

Link &udp_link()
{
    return s_udp;
}

LinkInfo link_info()
{
    return s_wifi.link_info();
}

Status status()
{
    Status s;
    s.started = s_started;
    s_wifi.fill(s);
    s_hub.fill(s);
    return s;
}

fr::Status net_set(const fr_net_creds_t &creds)
{
    if (!s_started) {
        return std::unexpected(Err::failed);
    }
    if (!s_wifi.request_override(creds, now_us())) {
        return std::unexpected(Err::busy);
    }
    return {};
}

fr::Status hubs_set(const HubList &list)
{
    if (!s_started) {
        return std::unexpected(Err::failed);
    }
    return s_hub.request_hubs(list);
}

HubsNow hubs_now()
{
    return s_hub.hubs_now();
}

void hub_busy(bool on)
{
    s_hub.set_busy(on);
}

fr::Status wifi_down(uint32_t seconds)
{
    if (!s_started) {
        return std::unexpected(Err::failed);
    }
    s_wifi.request_down(seconds, now_us());
    return {};
}

std::expected<TxPower, Err> set_tx_power(std::optional<int8_t> qdbm)
{
    if (!s_started) {
        return std::unexpected(Err::failed);
    }
    const int8_t want = qdbm.value_or(s_profile_qdbm);
    if (want <= 0 || esp_wifi_set_max_tx_power(want) != ESP_OK) {
        return std::unexpected(Err::invalid_args);
    }
    int8_t now = 0;
    if (esp_wifi_get_max_tx_power(&now) != ESP_OK) {
        return std::unexpected(Err::failed);
    }
    if (qdbm) {
        ESP_LOGW(TAG, "wifi: TX power %d qdBm asked, %d qdBm in force (debug hook; profile %d)", want, now,
                 s_profile_qdbm);
    } else {
        ESP_LOGI(TAG, "wifi: TX power back to the profile's %d qdBm (%d in force)", want, now);
    }
    return TxPower{.qdbm = now, .profile_qdbm = s_profile_qdbm};
}

fr::Status wifi_proto(bool ax)
{
#if CONFIG_SOC_WIFI_HE_SUPPORT
    if (!s_started) {
        return std::unexpected(Err::failed);
    }
    s_wifi.request_protocol(ax, now_us());
    return {};
#else
    static_cast<void>(ax);
    return std::unexpected(Err::unsupported);  // design m2-c4-gateway D19 (e): 11ax is the HE chips' (C6, C5) alone
#endif
}

}  // namespace fr::net::esp
