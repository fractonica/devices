// Engineering › Commands (DEVICE-SPEC §2.4): the expert console. One fold per instance, the node's own (fr.node,
// fr.diag, fr.ota) included: every command the instance shows (its test commands too when HELLO says inject is on), as
// the same typed forms the instrument pages use (enums by name, no example as a value, spans, optional fields folded,
// the verb on the button), each with a SEND AS JSON fold for what a form cannot say. A command a panel runs itself
// says so ("the cam page does this") and stays usable. A command with a field only the hub can issue is never a form:
// the hub's way is said instead (HubRuns). Builder PAGE owns it.

import { useEffect, useRef } from 'react';

import { CATALOG, type CatalogCapability } from '@fractonica/protocol/gen';

import type { DeviceDetail } from '../../api/types.ts';
import type { InstanceView } from '../../state/caps.ts';
import { coveredCommands, type PropertyLink, propertyLink } from '../../state/device-controls.ts';
import { isHubIssued } from '../../state/hub-issued.ts';
import { capWord } from '../../state/instruments.ts';
import { Caps, Disclosure, Pending, Section } from '../../ui/index.ts';
import { CommandForm, PlainAction } from './command-form.tsx';
import { usePanelProps } from './page-lens.tsx';
import { panelFor } from './panels.ts';
import { isAway } from './panels/generic.tsx';
import { HubRuns } from './panels/hub-runs.tsx';
import { NOT_INSTRUMENTS, useInstrumentRows } from './use-instruments.ts';

/** The node's own instances every node has even when its instance list leaves them out (the hub answers to them). */
const IMPLICIT: readonly { name: string; cap: string }[] = [
  { name: 'node', cap: 'fr.node' },
  { name: 'diag', cap: 'fr.diag' },
];

function InstanceCommands({ detail, inst, cap, instances, open }: { detail: DeviceDetail; inst: InstanceView; cap: CatalogCapability; instances: readonly InstanceView[]; open: boolean }) {
  const props = usePanelProps(detail, inst, cap, instances);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) {
      box.current?.scrollIntoView({ block: 'start' });
    }
  }, [open]);
  const own = NOT_INSTRUMENTS.includes(cap.name);
  const links = props.members.properties.map((p) => propertyLink(cap, props.members.commands, p)).filter((l): l is PropertyLink => l !== null);
  const byRows = coveredCommands(props.members.commands, links);
  const covers = new Set([...(panelFor(cap.name).covers ?? []), ...byRows]);
  const away = isAway(detail.presence);
  const page = own ? null : `the ${inst.name} page does this`;
  const commands = props.members.commands;
  return (
    <div ref={box} className="dev-console-inst" data-console={inst.name}>
      <Disclosure title={inst.name} aside={<Caps>{`${capWord(cap.name)} · ${commands.length} ${commands.length === 1 ? 'command' : 'commands'}`}</Caps>} defaultOpen={open}>
        <div className="dev-console-body">
          {!commands.length ? <p className="dev-quiet ash">It takes no command.</p> : null}
          {commands.map((c) => {
            const aside = [c.visibility === 'test' ? 'test' : '', covers.has(c.name) && page ? page : ''].filter(Boolean).join(' · ') || undefined;
            if (isHubIssued(cap.name, c)) {
              return <HubRuns key={c.name} detail={detail} inst={inst} cmd={c} />;
            }
            return c.fields.length ? (
              <CommandForm key={c.name} deviceId={detail.device_id} inst={inst.name} cap={cap} cmd={c} mirror={props.mirror} disabled={away} json {...(aside ? { aside } : {})} />
            ) : (
              <PlainAction key={c.name} deviceId={detail.device_id} inst={inst.name} cap={cap.name} cmd={c} disabled={away} json {...(aside ? { aside } : {})} />
            );
          })}
        </div>
      </Disclosure>
    </div>
  );
}

export function EngineeringCommands({ detail, open }: { detail: DeviceDetail; open: string | null }) {
  const { instances, rows, pending } = useInstrumentRows(detail);
  const known = rows.filter((r) => r.cap);
  const extra = IMPLICIT.filter((i) => !rows.some((r) => r.inst.name === i.name || r.inst.cap === i.cap))
    .map((i) => ({ inst: { name: i.name, port: 0, cap: i.cap, cap_id: 0, v: '', traits: null } as InstanceView, cap: CATALOG.capabilities.find((c) => c.name === i.cap) }))
    .filter((r) => r.cap);
  const instruments = known.filter((r) => !NOT_INSTRUMENTS.includes(r.inst.cap));
  const own = [...known.filter((r) => NOT_INSTRUMENTS.includes(r.inst.cap)), ...extra];
  return (
    <Section title="Commands" aside={<Caps>every command, for experts</Caps>} id="commands">
      <p className="dev-doc dev-console-note">Each instrument’s page has the everyday ones in words. Here is every command the device takes, as its catalog names it.</p>
      {pending ? <Pending what="its instances" /> : null}
      {[...instruments, ...own].map((r) => (
        <InstanceCommands key={r.inst.name} detail={detail} inst={r.inst} cap={r.cap!} instances={instances} open={open === r.inst.name} />
      ))}
    </Section>
  );
}
