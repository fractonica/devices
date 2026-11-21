// A board's hub list (design multi-hub-m1, spec 05 §5.12.5; fr/net/hub_plan.hpp), which hub_link.cpp, fr_posix and
// fr_net_node follow: what a list may hold, the rev rule and the reprovision rule of its storage, the order hubs are
// tried in, failover after a bounded time, failback with its hysteresis, and a pushed list's trial.
#include <cstdio>

#include "fr/net/hub_plan.hpp"
#include "tests/test.hpp"

namespace {

using fr::TimeUs;
using fr::net::HubList;
using fr::net::HubPlan;
using fr::net::HubPush;
using fr::net::HubTiming;

constexpr TimeUs kS = 1'000'000;
constexpr uint8_t kNone = HubPlan::kNone;
constexpr uint8_t kAdvert = HubPlan::kAdvert;

HubList list_of(uint32_t rev, std::initializer_list<const char *> hosts)
{
    HubList l;
    l.rev = rev;
    for (const char *h : hosts) {
        std::snprintf(l.hubs[l.count].host, sizeof(l.hubs[l.count].host), "%s", h);
        ++l.count;
    }
    return l;
}

/** Attempts at the plan's target that all fail, 250 ms apart from `now`, until it moves on; the time it did. */
TimeUs fail_until_moved(HubPlan &p, TimeUs now, int *attempts = nullptr)
{
    for (int n = 1;; ++n) {
        p.attempt(now);
        if (p.failed(now)) {
            if (attempts != nullptr) {
                *attempts = n;
            }
            return now;
        }
        now += 250'000;
    }
}

}  // namespace

TEST(hub_list_hosts_and_addresses)
{
    using fr::net::hub_host_valid;
    using fr::net::hub_ip_valid;
    CHECK(hub_host_valid("lab-hub.local"));
    CHECK(hub_host_valid("192.168.1.20"));
    CHECK(hub_host_valid("hub_2.example.org"));
    CHECK(!hub_host_valid(""));
    CHECK(!hub_host_valid(".local"));
    CHECK(!hub_host_valid("-hub"));
    CHECK(!hub_host_valid("lab hub.local"));
    CHECK(!hub_host_valid("lab-hub.local:7421"));  // a port is the POSIX runtime's alone
    CHECK(hub_host_valid("lab-hub.local:7421", true));
    CHECK(!hub_host_valid("lab-hub.local:0", true));
    CHECK(!hub_host_valid("lab-hub.local:port", true));
    CHECK(!hub_host_valid(std::string(64, 'a')));
    CHECK(hub_host_valid(std::string(63, 'a')));
    CHECK(hub_ip_valid(""));
    CHECK(hub_ip_valid("10.0.0.7"));
    CHECK(!hub_ip_valid("0.0.0.0"));
    CHECK(!hub_ip_valid("10.0.0"));
    CHECK(!hub_ip_valid("10.0.0.256"));
    CHECK(!hub_ip_valid("10.0.0.7."));
    CHECK(!hub_ip_valid("lab-hub.local"));
    // A list: every entry a host, no host twice (names compare without case).
    CHECK(fr::net::hub_list_valid(list_of(1, {"lab-hub.local", "home-hub.local"})));
    CHECK(fr::net::hub_list_valid(list_of(1, {})));
    CHECK(!fr::net::hub_list_valid(list_of(1, {"lab-hub.local", "LAB-HUB.local"})));
    CHECK(!fr::net::hub_list_valid(list_of(1, {"lab-hub.local", ""})));
    HubList bad_ip = list_of(1, {"lab-hub.local"});
    std::snprintf(bad_ip.hubs[0].ip, sizeof(bad_ip.hubs[0].ip), "%s", "10.0.0");
    CHECK(!fr::net::hub_list_valid(bad_ip));
    CHECK_EQ(fr::net::hub_index_of(list_of(1, {"lab-hub.local", "home-hub.local"}), "HOME-hub.local"), 1);
    CHECK_EQ(fr::net::hub_index_of(list_of(1, {"lab-hub.local"}), "home-hub.local"), -1);
}

TEST(hub_list_rev_a_stale_push_never_wins)
{
    using fr::net::hub_push_check;
    const HubList none{};
    const HubList held = list_of(4, {"lab-hub.local", "home-hub.local"});
    // The first list a board gets needs rev 1 or more; then only a higher rev is taken.
    CHECK(hub_push_check(none, list_of(1, {"lab-hub.local"})) == HubPush::apply);
    CHECK(hub_push_check(none, list_of(0, {"lab-hub.local"})) == HubPush::stale);
    CHECK(hub_push_check(held, list_of(5, {"home-hub.local"})) == HubPush::apply);
    CHECK(hub_push_check(held, list_of(4, {"home-hub.local"})) == HubPush::stale);
    CHECK(hub_push_check(held, list_of(3, {"lab-hub.local", "home-hub.local"})) == HubPush::stale);
    // The same list and rev again (a repeated command) is no error and no change.
    CHECK(hub_push_check(held, list_of(4, {"lab-hub.local", "home-hub.local"})) == HubPush::same);
    // An empty list with a higher rev takes the list away; the rev stays, so an older list cannot come back.
    CHECK(hub_push_check(held, list_of(5, {})) == HubPush::apply);
    CHECK(hub_push_check(list_of(5, {}), list_of(4, {"lab-hub.local", "home-hub.local"})) == HubPush::stale);
    // Whatever its rev, a list that is not one is refused as such.
    CHECK(hub_push_check(held, list_of(9, {"lab-hub.local", "lab-hub.local"})) == HubPush::invalid);
    CHECK(hub_push_check(held, list_of(9, {"lab hub"})) == HubPush::invalid);
}

TEST(hub_list_a_reprovision_supersedes_it)
{
    // nvs:fr_hubs keeps fr_ident's prov_ts of the push (as nvs:fr_net2): a reflash writes another, and the hub
    // fr_ident names wins over a list left in the RW partition.
    CHECK(!fr::net::hub_list_superseded(1763600000u, 1763600000u));
    CHECK(fr::net::hub_list_superseded(1763600000u, 1763686400u));
    CHECK(!fr::net::hub_list_superseded(0u, 0u));  // an UNASSIGNED node on the dev fallback has no prov_ts
    CHECK(fr::net::hub_list_superseded(0u, 1763600000u));
}

TEST(hub_plan_without_a_list_is_the_one_hub)
{
    // No list: the link keeps to the hub it was provisioned with, for ever, by the old chain. The plan never moves,
    // never probes, and only tracks the session.
    HubPlan p;
    p.reset(0);
    CHECK_EQ(p.count(), 0);
    CHECK_EQ(p.target(), 0);
    TimeUs now = 0;
    for (int i = 0; i < 200; ++i) {
        p.attempt(now);
        CHECK(!p.failed(now));
        now += 5 * kS;
    }
    CHECK_EQ(p.target(), 0);
    p.session(now);
    CHECK_EQ(p.on(), 0);
    CHECK(p.probe_at() == HubPlan::kNever);
    CHECK_EQ(p.probe(now + 3600 * kS, false), kNone);
    p.lost(now);
    CHECK_EQ(p.on(), kNone);
    CHECK_EQ(p.target(), 0);
}

TEST(hub_plan_tries_the_list_in_order_then_the_advert)
{
    HubPlan p;
    p.reset(3);
    CHECK_EQ(p.target(), 0);
    CHECK_EQ(p.on(), kNone);
    TimeUs now = 100 * kS;
    now = fail_until_moved(p, now);
    CHECK_EQ(p.target(), 1);
    now = fail_until_moved(p, now);
    CHECK_EQ(p.target(), 2);
    now = fail_until_moved(p, now);
    // A full round with no hub: one lookup of any hub's advert, not a hub to wait ten seconds for.
    CHECK_EQ(p.target(), kAdvert);
    p.attempt(now);
    CHECK(p.failed(now));
    CHECK_EQ(p.target(), 0);
    now = fail_until_moved(p, now);
    CHECK_EQ(p.target(), 1);
}

TEST(hub_plan_gives_a_hub_up_after_a_bounded_time)
{
    HubPlan p;
    p.reset(2);
    const TimeUs t0 = 50 * kS;
    // Fast failures (the hub's machine is up, its port refuses): not before 10 s, however many attempts.
    int attempts = 0;
    const TimeUs moved = fail_until_moved(p, t0, &attempts);
    CHECK_EQ(moved - t0, 10 * kS);
    CHECK_EQ(attempts, 41);
    CHECK_EQ(p.target(), 1);
    // Slow failures (the machine is away: each connect takes its 3 s timeout, then the backoff): not before three
    // attempts, so one long timeout does not skip a hub.
    p.reset(2);
    TimeUs now = t0;
    p.attempt(now);
    now += 9 * kS;
    CHECK(!p.failed(now));
    p.attempt(now);
    now += 9 * kS;
    CHECK(!p.failed(now));  // 18 s, two attempts
    p.attempt(now);
    now += 3 * kS;
    CHECK(p.failed(now));
    CHECK_EQ(p.target(), 1);
    // The time counts from the first attempt at a hub, not from when it became the target (Wi-Fi may be away).
    p.reset(2);
    p.attempt(1000 * kS);
    CHECK(!p.failed(1000 * kS));
    p.pause();  // no network: its bounded time starts over
    p.attempt(2000 * kS);
    CHECK(!p.failed(2000 * kS));
    CHECK_EQ(p.target(), 0);
}

TEST(hub_plan_after_a_lost_session_tries_that_hub_first)
{
    HubPlan p;
    p.reset(3);
    TimeUs now = 10 * kS;
    now = fail_until_moved(p, now);
    CHECK_EQ(p.target(), 1);
    p.attempt(now);
    p.session(now);
    CHECK_EQ(p.on(), 1);
    // The hub restarts: the board stays with it for its bounded time (a restart takes seconds), then walks the
    // others in order, the advert, and the list from its top.
    now += 500 * kS;
    p.lost(now);
    CHECK_EQ(p.on(), kNone);
    CHECK_EQ(p.target(), 1);
    now = fail_until_moved(p, now);
    CHECK_EQ(p.target(), 0);
    now = fail_until_moved(p, now);
    CHECK_EQ(p.target(), 2);
    now = fail_until_moved(p, now);
    CHECK_EQ(p.target(), kAdvert);
    p.attempt(now);
    CHECK(p.failed(now));
    CHECK_EQ(p.target(), 0);
    // A session's attempts start from nothing: one that came back at once is not charged the failures before it.
    p.attempt(now);
    p.session(now);
    p.lost(now + kS);
    p.attempt(now + kS);
    CHECK(!p.failed(now + kS));
    CHECK_EQ(p.target(), 0);
}

TEST(hub_plan_returns_to_a_hub_above_when_it_answers_twice)
{
    HubPlan p;
    p.reset(2);
    TimeUs now = fail_until_moved(p, 0);
    p.attempt(now);
    p.session(now);
    const TimeUs t0 = now;
    CHECK_EQ(p.on(), 1);
    // About once a minute, the hubs above the one the board is on.
    CHECK_EQ(p.probe_at(), t0 + 60 * kS);
    CHECK_EQ(p.probe(t0 + 59 * kS, false), kNone);
    CHECK_EQ(p.probe(t0 + 60 * kS, false), 0);
    CHECK_EQ(p.probe(t0 + 60 * kS, false), kNone);  // one probe at a time
    CHECK(!p.probed(t0 + 61 * kS, false));
    CHECK_EQ(p.probe_at(), t0 + 121 * kS);
    // It answers: not yet a reason to leave a working hub. It must answer again 10 s later.
    CHECK_EQ(p.probe(t0 + 121 * kS, false), 0);
    CHECK(!p.probed(t0 + 121 * kS, true));
    CHECK_EQ(p.on(), 1);
    CHECK_EQ(p.target(), 1);
    CHECK_EQ(p.probe_at(), t0 + 131 * kS);
    CHECK_EQ(p.probe(t0 + 131 * kS, false), 0);
    CHECK(p.probed(t0 + 131 * kS, true));
    // The board goes back: the link closes the session it has; that end is not a lost session of the plan's.
    CHECK_EQ(p.target(), 0);
    CHECK_EQ(p.on(), kNone);
    p.lost(t0 + 131 * kS);
    CHECK_EQ(p.target(), 0);
    p.attempt(t0 + 131 * kS);
    p.session(t0 + 132 * kS);
    CHECK_EQ(p.on(), 0);
    // On its first hub there is nothing above to look for.
    CHECK(p.probe_at() == HubPlan::kNever);
    CHECK_EQ(p.probe(t0 + 9999 * kS, false), kNone);
}

TEST(hub_plan_one_answer_is_not_enough)
{
    HubPlan p;
    p.reset(2);
    TimeUs now = fail_until_moved(p, 0);
    p.attempt(now);
    p.session(now);
    // A hub that answers once and is gone again 10 s later (it is still starting, or flapping) is not returned to.
    CHECK_EQ(p.probe(now + 60 * kS, false), 0);
    CHECK(!p.probed(now + 60 * kS, true));
    CHECK_EQ(p.probe(now + 70 * kS, false), 0);
    CHECK(!p.probed(now + 70 * kS, false));
    CHECK_EQ(p.on(), 1);
    CHECK_EQ(p.probe_at(), now + 130 * kS);
    // ... and its next first answer counts as a first one again.
    CHECK_EQ(p.probe(now + 130 * kS, false), 0);
    CHECK(!p.probed(now + 130 * kS, true));
    CHECK_EQ(p.probe_at(), now + 140 * kS);
}

TEST(hub_plan_a_return_without_a_session_backs_the_probes_off)
{
    HubPlan p;
    p.reset(2);
    TimeUs now = fail_until_moved(p, 0);
    TimeUs period = 60 * kS;
    // The first hub accepts connections but never WELCOMEs: every return costs the board some seconds without a
    // hub, so each one that fails doubles the wait for the next, up to eight minutes.
    for (int round = 0; round < 5; ++round) {
        p.attempt(now);
        p.session(now);
        CHECK_EQ(p.on(), 1);
        CHECK_EQ(p.probe_period(), period);
        CHECK_EQ(p.probe_at(), now + period);
        now += period;
        CHECK_EQ(p.probe(now, false), 0);
        CHECK(!p.probed(now, true));
        now += 10 * kS;
        CHECK_EQ(p.probe(now, false), 0);
        CHECK(p.probed(now, true));
        CHECK_EQ(p.target(), 0);
        now = fail_until_moved(p, now);  // no WELCOME there
        CHECK_EQ(p.target(), 1);         // back to the hub it came from
        period = period * 2 < 480 * kS ? period * 2 : 480 * kS;
    }
    CHECK_EQ(period, 480 * kS);
    // A return that works puts the period back.
    p.attempt(now);
    p.session(now);
    now += 480 * kS;
    CHECK_EQ(p.probe(now, false), 0);
    CHECK(!p.probed(now, true));
    now += 10 * kS;
    CHECK_EQ(p.probe(now, false), 0);
    CHECK(p.probed(now, true));
    p.attempt(now);
    p.session(now);
    CHECK_EQ(p.on(), 0);
    CHECK_EQ(p.probe_period(), 60 * kS);
}

TEST(hub_plan_probes_every_hub_above_and_none_while_busy)
{
    HubPlan p;
    p.reset(4);
    TimeUs now = 0;
    for (int i = 0; i < 3; ++i) {
        now = fail_until_moved(p, now);
    }
    CHECK_EQ(p.target(), 3);
    p.attempt(now);
    p.session(now);
    // Hubs 0, 1 and 2 in one go, the best first; the first that answers is the one confirmed.
    now += 60 * kS;
    CHECK_EQ(p.probe(now, false), 0);
    CHECK(!p.probed(now, false));
    CHECK_EQ(p.probe(now, false), 1);
    CHECK(!p.probed(now + kS, false));
    CHECK_EQ(p.probe(now + kS, false), 2);
    CHECK(!p.probed(now + 2 * kS, true));
    CHECK_EQ(p.probe(now + 12 * kS, false), 2);
    CHECK(p.probed(now + 12 * kS, true));
    CHECK_EQ(p.target(), 2);
    p.attempt(now + 12 * kS);
    p.session(now + 12 * kS);
    CHECK_EQ(p.on(), 2);
    // An OTA over the hub the board is on (busy): no probe, so no return, and a first answer is forgotten.
    now += 12 * kS + 60 * kS;
    CHECK_EQ(p.probe(now, false), 0);
    CHECK(!p.probed(now, true));
    CHECK_EQ(p.probe(now + 10 * kS, true), kNone);
    CHECK_EQ(p.probe(now + 15 * kS, true), kNone);
    CHECK_EQ(p.probe(now + 20 * kS, false), 0);
    CHECK(!p.probed(now + 20 * kS, true));  // a first answer again
    CHECK_EQ(p.on(), 2);
    // The session ends while a probe is out: its answer changes nothing.
    CHECK_EQ(p.probe(now + 30 * kS, false), 0);
    p.lost(now + 31 * kS);
    CHECK(!p.probed(now + 32 * kS, true));
    CHECK_EQ(p.target(), 2);
}

TEST(hub_plan_a_hub_found_by_its_advert_ranks_below_the_list)
{
    HubPlan p;
    p.reset(1);
    TimeUs now = fail_until_moved(p, 0);
    CHECK_EQ(p.target(), kAdvert);
    p.attempt(now);
    p.session(now);
    CHECK_EQ(p.on(), kAdvert);
    // Every hub of the list is above it.
    CHECK_EQ(p.probe(now + 60 * kS, false), 0);
    CHECK(!p.probed(now + 60 * kS, true));
    CHECK_EQ(p.probe(now + 70 * kS, false), 0);
    CHECK(p.probed(now + 70 * kS, true));
    CHECK_EQ(p.target(), 0);
    // When it is lost instead, the list starts from its top.
    p.reset(2);
    now = fail_until_moved(p, 0);
    now = fail_until_moved(p, now);
    p.attempt(now);
    p.session(now);
    p.lost(now + kS);
    CHECK_EQ(p.target(), 0);
}

TEST(hub_plan_trial_of_a_pushed_list)
{
    HubPlan p;
    p.reset(2);
    const TimeUs t0 = 1000 * kS;
    p.begin_trial(t0);
    CHECK(p.trial());
    CHECK_EQ(p.trial_deadline(), t0 + 60 * kS);
    CHECK(!p.trial_expired(t0 + 59 * kS));
    // The round of a list on trial has no advert step: only a hub of the list can confirm it.
    TimeUs now = fail_until_moved(p, t0);
    CHECK_EQ(p.target(), 1);
    now = fail_until_moved(p, now);
    CHECK_EQ(p.target(), 0);
    now = fail_until_moved(p, now);
    CHECK_EQ(p.target(), 1);
    // No WELCOME within 60 s: the link goes back to the list it had.
    CHECK(p.trial_expired(t0 + 60 * kS));
    // A WELCOME from any hub of it ends the trial (the link then stores the list).
    p.reset(2);
    p.begin_trial(t0);
    now = fail_until_moved(p, t0);
    p.attempt(now);
    p.session(now);
    CHECK(!p.trial());
    CHECK(p.trial_deadline() == HubPlan::kNever);
    CHECK(!p.trial_expired(t0 + 3600 * kS));
    CHECK_EQ(p.on(), 1);
    CHECK_EQ(p.probe_at(), now + 60 * kS);  // on its second hub: the first is probed from here
    // No list on trial (the provisioned hub again) works the same: its WELCOME ends the trial.
    p.reset(0);
    p.begin_trial(t0);
    CHECK(p.trial());
    p.session(t0 + kS);
    CHECK(!p.trial());
}

TEST(hub_plan_a_list_that_names_the_current_hub_keeps_the_session)
{
    // hubs_set on a board whose session is with a hub the new list names: no trial, no reconnect. At index 0 there
    // is nothing more to do; at a lower place the hubs above are probed at once, so a new default hub is reached
    // about ten seconds later (its two answers), not a minute.
    HubPlan p;
    const TimeUs t0 = 77 * kS;
    p.adopt(2, 0, t0);
    CHECK_EQ(p.on(), 0);
    CHECK_EQ(p.target(), 0);
    CHECK(!p.trial());
    CHECK(p.probe_at() == HubPlan::kNever);
    p.adopt(2, 1, t0);
    CHECK_EQ(p.on(), 1);
    CHECK_EQ(p.probe_at(), t0);
    CHECK_EQ(p.probe(t0, false), 0);
    CHECK(!p.probed(t0, true));
    CHECK_EQ(p.probe(t0 + 10 * kS, false), 0);
    CHECK(p.probed(t0 + 10 * kS, true));
    CHECK_EQ(p.target(), 0);
}

TEST(hub_plan_timing_can_be_shortened)
{
    HubPlan p;
    HubTiming t;
    t.giveup_us = 400'000;
    t.giveup_attempts = 2;
    t.probe_period_us = 500'000;
    t.probe_confirm_us = 100'000;
    t.probe_period_max_us = 1'000'000;
    t.trial_us = 2 * kS;
    p.set_timing(t);
    p.reset(2);
    p.attempt(0);
    CHECK(!p.failed(0));
    p.attempt(250'000);
    CHECK(!p.failed(250'000));
    p.attempt(500'000);
    CHECK(p.failed(500'000));
    p.attempt(500'000);
    p.session(500'000);
    CHECK_EQ(p.probe_at(), 1'000'000);
    p.begin_trial(0);
    CHECK(p.trial_expired(2 * kS));
}
