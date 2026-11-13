// Step 1, Plug in: the USB serial ports the hub sees (port_list, read again every 2 s: a program opening a port has no
// event), each with what it is to the hub (state/ports.ts: watched / lent / ignored / held by <program> / not watched)
// and the port policy's actions inline (pages/shared/port-actions.tsx, as in Settings › Ports). A board plugged in while the page is open is
// lit and chosen. What would stop provisioning (another program holds the port, it is lent, ignored) is said before
// anything starts, with the fix the page can run. The dashboard never opens a port itself; the hub does.

import type { PortInfo } from '@fractonica/protocol/client';

import { useAct } from '../../hooks.ts';
import { portBlock, portView, sortPorts } from '../../state/ports.ts';
import { Bead, Button, ButtonRow, ErrorLine, FTime } from '../../ui/index.ts';
import { PortActions } from '../shared/port-actions.tsx';
import { ChoiceRow, Choices } from './choice.tsx';

export interface PortsStepProps {
  ports: PortInfo[] | undefined;
  error: unknown;
  loading: boolean;
  /** Registered boards by device id: the alias the row shows. */
  known: (p: PortInfo) => { alias: string } | null;
  chosen: string | null;
  /** Ports plugged in since the page opened (lit). */
  fresh: ReadonlySet<string>;
  onChoose: (p: PortInfo) => void;
  onContinue: () => void;
  onRecheck: () => void;
  continueDisabled: boolean;
  /** A line about the chosen board (what the registry knows of it). */
  note?: string;
}

export function PortsStep({ ports, error, loading, known, chosen, fresh, onChoose, onContinue, onRecheck, continueDisabled, note }: PortsStepProps) {
  const list = sortPorts(ports ?? [], (p) => known(p) !== null);
  const current = list.find((p) => p.path === chosen) ?? null;
  const block = current ? portBlock(current) : null;
  const unignore = useAct('port_ignore', { done: () => 'port no longer ignored', refresh: ['port_list'] });
  const release = useAct('serial_release', { done: () => 'port released', refresh: ['port_list'] });
  const fix = (): { label: string; onClick: () => void; busy?: boolean } | undefined => {
    if (!current || !block?.fix) {
      return undefined;
    }
    if (block.fix === 'release' && current.lease) {
      const id = current.lease.lease_id;
      return { label: block.fixLabel ?? 'Release', onClick: () => release.mutate({ lease_id: id }), busy: release.isPending };
    }
    if (block.fix === 'unignore') {
      return { label: block.fixLabel ?? 'Stop ignoring', onClick: () => unignore.mutate({ port: current.path, remove: true }), busy: unignore.isPending };
    }
    return { label: block.fixLabel ?? 'Check again', onClick: onRecheck };
  };

  return (
    <div className="prov-step-body">
      <ErrorLine error={error} what="Ports" fix={{ label: 'Try again', onClick: onRecheck }} />
      {!error && !loading && !list.length ? (
        <div className="prov-listening" data-empty="ports">
          <Bead state="waiting" label="listening" showLabel />
          <p>Plug a board in with a USB cable. It shows here as soon as this computer sees it; nothing to press.</p>
          <p className="prov-note">A cable that only charges shows nothing: use one that carries data.</p>
        </div>
      ) : null}
      {list.length ? (
        <Choices label="USB ports">
          {list.map((p, i) => {
            const k = known(p);
            const v = portView(p, k !== null);
            return (
              <ChoiceRow
                key={p.path}
                id={p.path}
                chosen={p.path === chosen}
                tabbable={!chosen && i === 0}
                onChoose={() => onChoose(p)}
                flash={fresh.has(p.path)}
                name={k?.alias ?? p.alias ?? (v.isNew ? 'New board' : 'Board')}
                extra={
                  <>
                    <span className="mono">{v.name}</span>
                    {p.bridge ? <span> · {p.bridge} bridge</span> : null}
                  </>
                }
                value={
                  <span className="prov-port-state">
                    <Bead state={v.bead} label={v.word} showLabel={false} /> {v.word}
                  </span>
                }
                valueExtra={p.lease ? <FTime at={p.lease.expires_at} form="relative" /> : undefined}
                actions={<PortActions port={p} />}
              />
            );
          })}
        </Choices>
      ) : null}
      {list.length ? (
        <div className="prov-listening prov-listening-line">
          <Bead state="waiting" label="listening for boards" showLabel />
          <span className="prov-note">Another board plugged in shows here too.</span>
        </div>
      ) : null}
      {block ? <ErrorLine code={block.code} message={block.message} fix={fix()} /> : null}
      {note ? <p className="prov-note">{note}</p> : null}
      <ButtonRow>
        <Button variant="primary" onClick={onContinue} disabled={!current || block !== null || continueDisabled} data-action="continue">
          Continue
        </Button>
      </ButtonRow>
    </div>
  );
}
