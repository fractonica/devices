// Settings › Ports: the port policy's UI (HARDWARE-REVIEW §4 "Screens" 4; stage 2's policy, config.json ports). Every
// USB serial port the hub sees, said in words (state/ports.ts: watched by the hub / lent to pid … until … / ignored /
// held by <app> / not watched) with a bead, why (the policy), and the actions it allows (pages/shared/port-actions.tsx,
// the same as on Provision's Plug in step). Each action's undo is offered on the row once it is done. port_list is
// refetched on port.* events and every 2 s: a holder change seen by lsof has no event.

import type { PortInfo } from '@fractonica/protocol/client';

import { useOp } from '../../hooks.ts';
import { modeWords, portView } from '../../state/ports.ts';
import { Caps, Code, EmptyState, ErrorLine, FTime, Line, Pending, Row, Section } from '../../ui/index.ts';
import { PortActions } from '../shared/port-actions.tsx';

function PortRow({ port, alias }: { port: PortInfo; alias?: string }) {
  const v = portView(port, Boolean(alias));
  const word = port.lease ? (
    <>
      {v.word} · ends <FTime at={port.lease.expires_at} form="relative" />
    </>
  ) : (
    v.word
  );
  const who = alias ?? port.alias;
  const ids = [port.usb_serial ? `usb ${port.usb_serial}` : null, port.vid && port.pid ? `${port.vid}:${port.pid}` : null, port.bridge ? `${port.bridge} bridge` : null].filter(Boolean).join(' · ');
  return (
    <Line
      id={`port-${port.path}`}
      bead={v.bead}
      beadLabel={v.word}
      name={
        <span className="set-port-name">
          <Code>{port.path}</Code>
          {who ? <span className="set-port-alias">{who}</span> : <span className="set-port-alias ash">no board known</span>}
        </span>
      }
      value={<span data-port-state={port.state}>{word}</span>}
      detail={
        <>
          {v.detail ? <span>{v.detail}</span> : null}
          {ids ? <span className="set-port-ids">{ids}</span> : null}
        </>
      }
      actions={<PortActions port={port} />}
    />
  );
}

export function PortsSection() {
  const ports = useOp('port_list', {}, { refetchInterval: 2000 });
  const status = useOp('hub_status', {}, { refetchInterval: 5000 });
  const devices = useOp('device_list', { selector: 'all' });
  const byId = new Map((devices.data?.devices ?? []).map((d) => [d.device_id, d.alias]));
  const rows = ports.data?.ports ?? [];
  const mode = modeWords((status.data?.ports as { mode?: string } | undefined)?.mode);
  return (
    <>
      <Section title="Policy" id="policy">
        <Row label="Mode" value={mode.word} extra={mode.detail} />
        <Row label="To change it" value={<>set <Code>ports.mode</Code> in the hub’s config.json</>} extra="adopted or all; the hub reads the file again by itself, no restart" />
        <Row label="Another program" value={<>lend a port, or <Code>{"fr serial lease <device> -- <command>"}</Code></>} extra="the dashboard never opens a port itself" />
      </Section>
      <Section title="Ports" aside={<Caps>{ports.data ? `${rows.length} seen` : ''}</Caps>} id="ports">
        {ports.error ? <ErrorLine error={ports.error} what="Ports" fix={{ label: 'Try again', onClick: () => void ports.refetch() }} /> : null}
        {!ports.data && !ports.error ? <Pending what="the ports" /> : null}
        {ports.data && !rows.length ? (
          <EmptyState title="No USB serial port">Plug a board in with a USB cable that carries data; it shows here within a moment.</EmptyState>
        ) : null}
        {rows.map((p) => (
          <PortRow key={p.path} port={p} alias={p.device_id ? byId.get(p.device_id) : undefined} />
        ))}
      </Section>
    </>
  );
}
