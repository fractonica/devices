// A port's policy actions, the same on Provision's Plug in step and in Settings › Ports (state/ports.ts): Lend for a
// span of time (port_lend; the lease cap is 30 minutes, so the choices are 30λ and whole Preons, ⊕ the minutes in Earth
// mode), Release (serial_release), Ignore and Stop ignoring (port_ignore), Claim and Unclaim (port_claim). Quiet words
// on the row; Lend asks for the span in place. The dashboard never opens a port itself: the hub does.

import { useState } from 'react';

import type { PortInfo } from '@fractonica/protocol/client';

import { useAct } from '../../hooks.ts';
import { lendChoices, PORT_ACTION_LABEL, type PortAction, portView } from '../../state/ports.ts';
import { Button, ErrorLine, useFractonica, useMode } from '../../ui/index.ts';
import { useInPlace } from '../../ui/in-place.ts';

/** The lend choices, from the core (null while it loads). */
function useLendChoices() {
  const core = useFractonica();
  if (!core) {
    return null;
  }
  const { frc, cat } = core;
  return lendChoices(frc as never, cat.intervalAt(frc.now()));
}

function LendChoice({ port, onDone }: { port: PortInfo; onDone: () => void }) {
  const choices = useLendChoices();
  const core = useFractonica();
  const { earth } = useMode();
  const name = portView(port).name;
  const box = useInPlace<HTMLSpanElement>(`lend:${port.path}`, onDone);
  const lend = useAct('port_lend', { done: () => `${name} lent`, refresh: ['port_list'] });
  return (
    <span className="ui-lend" role="group" aria-label={`Lend ${name} for`} ref={box}>
      <span className="ui-lend-why">The hub lets go of the port so another program (a serial monitor, a browser) can open it, and takes it back after.</span>
      <span className="ui-lend-q">Lend for</span>
      {(choices ?? []).map((c) => (
        <Button key={c.ttl_s} busy={lend.isPending} data-action="lend" data-ttl={c.ttl_s} onClick={() => lend.mutate({ port: port.path, ttl_s: c.ttl_s }, { onSuccess: onDone })}>
          {earth && core ? `${c.label} ⊕ ${core.frc.formatDuration(BigInt(c.ttl_s) * 1_000_000n, 2)}` : c.label}
        </Button>
      ))}
      <Button variant="quiet" onClick={onDone}>
        Cancel
      </Button>
      {lend.error ? <ErrorLine error={lend.error} what="Lend" /> : null}
    </span>
  );
}

/** The actions `portView` allows on a port, as quiet words (Release, which hands a port back, drawn as a button). */
export function PortActions({ port, only }: { port: PortInfo; only?: readonly PortAction[] }) {
  const v = portView(port);
  const [lending, setLending] = useState(false);
  const ignore = useAct('port_ignore', { done: (_r, i) => `${v.name} ${i.remove ? 'no longer ignored' : 'ignored'}`, refresh: ['port_list'] });
  const claim = useAct('port_claim', { done: (_r, i) => `${v.name} ${i.remove ? 'no longer claimed' : 'watched by the hub'}`, refresh: ['port_list'] });
  const release = useAct('serial_release', { done: () => `${v.name} back with the hub`, refresh: ['port_list'] });
  if (lending) {
    return <LendChoice port={port} onDone={() => setLending(false)} />;
  }
  const busy = ignore.isPending || claim.isPending || release.isPending;
  const run: Record<PortAction, () => void> = {
    lend: () => setLending(true),
    release: () => port.lease && release.mutate({ lease_id: port.lease.lease_id }),
    ignore: () => ignore.mutate({ port: port.path, remove: false }),
    unignore: () => ignore.mutate({ port: port.path, remove: true }),
    claim: () => claim.mutate({ port: port.path, remove: false }),
    unclaim: () => claim.mutate({ port: port.path, remove: true }),
  };
  const error = ignore.error ?? claim.error ?? release.error;
  return (
    <>
      {v.actions
        .filter((a) => !only || only.includes(a))
        .map((a) => (
          <Button
            key={a}
            variant={a === 'release' ? 'default' : 'quiet'}
            busy={busy}
            onClick={run[a]}
            data-action={a}
            data-opens={a === 'lend' ? `lend:${port.path}` : undefined}
            aria-label={`${PORT_ACTION_LABEL[a]} ${v.name}`}
            {...(a === 'release' ? { confirm: `Take ${v.name} back${port.lease?.holder_pid ? ` from process ${port.lease.holder_pid}` : ''}? Its program loses the port.`, confirmLabel: 'Release' } : {})}
          >
            {PORT_ACTION_LABEL[a]}
          </Button>
        ))}
      {error ? <ErrorLine error={error} what="Port" /> : null}
    </>
  );
}
