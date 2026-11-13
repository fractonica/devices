// Settings › Networks: the Wi-Fi networks the nodes join (network_list; add or change one with network_set: the
// password is write-only, typed into a hidden field, sent once and never shown or echoed back), the hub on the LAN
// (Local Network permission, the advert, nodes whose UDP is blocked, sessions per link, gateways), latency per device
// and link (latency_stats: spans in pure mode, ⊕ ms in Earth mode), and the broadcast ping.
//
// Removing a network needs an op the hub does not have yet (network_remove): no button promises it.

import { useState } from 'react';

import type { Network } from '@fractonica/protocol/client';

import { useAct, useOp } from '../../hooks.ts';
import { type NetworkDraft, networkErrors, networkSetInput } from '../../state/settings-view.ts';
import { BROADCAST_PING } from '../../state/wizard.ts';
import { BAND_WORD, NetworkForm } from '../shared/network-form.tsx';
import { Button, ButtonRow, Code, Disclosure, EmptyState, ErrorLine, FTime, Line, presenceBead, Row, Section, Select, Span, TextField, Toggle, useHubText, useMode } from '../../ui/index.ts';

function Networks() {
  const q = useOp('network_list', {});
  const [editing, setEditing] = useState<string | null>(null); // a name, or '+' for a new one
  const nets = q.data?.networks ?? [];
  const add = (
    <Button variant="quiet" onClick={() => setEditing('+')} data-action="add-network" disabled={editing === '+'}>
      Add network
    </Button>
  );
  return (
    <Section title="Wi-Fi for the nodes" aside={nets.length ? add : undefined} id="wifi">
      {q.error ? <ErrorLine error={q.error} what="Networks" /> : null}
      {q.data && !nets.length && editing !== '+' ? (
        <EmptyState
          title="No network yet"
          action={
            <Button variant="primary" onClick={() => setEditing('+')} data-action="add-network">
              Add network
            </Button>
          }
        >
          Nodes join the Wi-Fi stored here. Add the network of the room the boards are in before provisioning one.
        </EmptyState>
      ) : null}
      {nets.map((n) =>
        editing === n.name ? (
          <div key={n.name} className="set-editing">
            <Line name={n.name} value={<span className="ash">changing</span>} />
            <NetworkForm current={n} firstEver={false} onDone={() => setEditing(null)} />
          </div>
        ) : (
          <Line
            key={n.name}
            id={`network-${n.name}`}
            bead={n.password_set ? 'online' : 'idle'}
            beadLabel={n.password_set ? 'password stored' : 'open network'}
            name={n.name}
            value={n.ssid}
            detail={[BAND_WORD[n.band] ?? n.band, n.password_set ? 'password stored' : 'open, no password', n.devices !== undefined ? `${n.devices} device${n.devices === 1 ? '' : 's'}` : null, n.country, n.bssid ? `router ${n.bssid}` : null]
              .filter(Boolean)
              .join(' · ')}
            actions={
              <Button variant="quiet" onClick={() => setEditing(n.name)} data-action="change-network">
                Change
              </Button>
            }
          />
        ),
      )}
      {editing === '+' ? <NetworkForm current={null} firstEver={!nets.length} onDone={() => setEditing(null)} /> : null}
    </Section>
  );
}

const LNP_BEAD = { allowed: 'online', denied: 'fault', unknown: 'idle' } as const;
const ADVERT_BEAD = { registered: 'online', retrying: 'waiting', off: 'idle' } as const;

function Lan() {
  const status = useOp('hub_status', {}, { refetchInterval: 5000 });
  const say = useHubText();
  const s = status.data;
  if (status.error) {
    return <ErrorLine error={status.error} what="Hub status" />;
  }
  const blocked = (s?.warnings ?? []).filter((w) => w.startsWith('udp_blocked:')).map((w) => w.split(':')[1]?.trim() ?? '?');
  const gateways = Object.entries(s?.links?.gateways ?? {});
  const lnp = s?.lnp ?? 'unknown';
  return (
    <Section title="The hub on the LAN" id="lan">
      <Row
        bead={LNP_BEAD[lnp]}
        label="Local Network"
        value={lnp === 'allowed' ? 'allowed' : lnp === 'denied' ? 'denied by macOS' : 'not checked yet'}
        extra={s?.lnp_checked_at ? <>checked <FTime at={s.lnp_checked_at} form="relative" earth="none" /></> : undefined}
      />
      {lnp === 'denied' ? (
        <Line bead="fault" label="To fix" detail={`System Settings › Privacy & Security › Local Network: allow ${s?.launched_by ?? 'the app that started the hub'}, or start the hub from Terminal (fr hub restart).`} />
      ) : null}
      <Row bead={ADVERT_BEAD[s?.advert?.state ?? 'off']} label="Advert" value={s?.advert?.state === 'registered' ? (s.advert.name ?? 'registered') : s?.advert?.state === 'retrying' ? 'retrying' : 'off'} extra={s?.advert?.error ? say(s.advert.error) : s?.advert?.state === 'off' ? 'nodes find the hub by the address they were given' : undefined} />
      <Row bead={blocked.length ? 'waiting' : s ? 'online' : 'idle'} label="UDP from nodes" value={blocked.length ? `blocked: ${blocked.join(', ')}` : s ? 'no link blocked' : '—'} />
      <Row
        label="Sessions"
        value={s?.links ? `${s.links.sessions.tcp} tcp · ${s.links.sessions.serial} serial · ${s.links.sessions.gateway ?? 0} gateway` : '—'}
      />
      {gateways.map(([k, g]) => (
        <Row key={k} bead={g.up ? 'online' : 'offline'} name={g.alias || k} value={g.up ? `${g.sessions} sessions` : 'down'} extra={g.up && g.rtt_us != null ? <>round trip <Span us={g.rtt_us} /></> : undefined} />
      ))}
    </Section>
  );
}

function Latency() {
  const q = useOp('latency_stats', { window_s: 60 }, { refetchInterval: 5000 });
  const d = q.data;
  const ms = (v: number | null | undefined) => (v === null || v === undefined ? null : v * 1000);
  return (
    <Section title="Latency" aside={<span className="ui-section-aside-text">the last <Span us={60_000_000} parts={1} /> · middle and slowest</span>} id="latency">
      {q.error ? <ErrorLine error={q.error} what="Latency" /> : null}
      {d?.event_loop ? (
        <Row
          bead={(d.event_loop.p99_ms ?? 0) > 5 ? 'waiting' : 'online'}
          label="Hub event loop"
          value={
            <>
              <Span us={ms(d.event_loop.p50_ms)} /> <span className="ash">·</span> <Span us={ms(d.event_loop.p99_ms)} />
            </>
          }
        />
      ) : null}
      {d && !d.devices.length ? <Row label="Devices" value="none yet" /> : null}
      {d?.devices.map((x) => {
        const links = Object.entries(x.ping).filter(([, p]) => p.n > 0);
        return (
          <Line
            key={x.device}
            id={`latency-${x.alias}`}
            bead={presenceBead(x.presence)}
            beadLabel={x.presence}
            name={x.alias}
            value={
              links.length ? (
                <span className="set-latency">
                  {links.map(([link, p]) => (
                    <span key={link} className="set-latency-link">
                      <span className="caps ash">{link.toUpperCase()}</span> <Span us={ms(p.p50_ms)} /> <span className="ash">·</span> <Span us={ms(p.p99_ms)} />
                    </span>
                  ))}
                </span>
              ) : (
                <span className="ash">no pings yet</span>
              )
            }
            detail={x.input.n > 0 ? <>input to hub <Span us={ms(x.input.p50_ms)} /> · <Span us={ms(x.input.p99_ms)} /></> : undefined}
          />
        );
      })}
    </Section>
  );
}

function Broadcast() {
  const [sent, setSent] = useState(false);
  const act = useAct('message_send', { done: () => 'ping sent to every node' });
  return (
    <Section title="Broadcast" id="broadcast">
      <Line
        label="Ping every node"
        detail={<>One message, topic <Code>ping</Code>, to every node: sent once by the hub and passed on over ESP-NOW, never acknowledged.</>}
        actions={
          <Button busy={act.isPending} data-action="broadcast-ping" onClick={() => act.mutate(BROADCAST_PING, { onSuccess: () => setSent(true) })}>
            {sent ? 'Ping again' : 'Ping'}
          </Button>
        }
      />
    </Section>
  );
}

export function NetworksSection() {
  return (
    <>
      <Networks />
      <Lan />
      <Latency />
      <Broadcast />
    </>
  );
}
