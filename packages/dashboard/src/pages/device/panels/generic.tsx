// The generic capability panel (DEVICE-SPEC §2.2): an instrument drawn from the catalog, in blocks.
// 1. Readings: one row per property, in words and its unit (state/cap-words.ts), a lumen sparkline when numeric; a
//    property a command sets is its own control (propertyLink), sending at once.
// 2. Actions: the everyday commands, each saying what it does (command-form.tsx): not those a property row covers, not
//    the hub-issued ones (G3), not the test ones.
// 3. Hub-run commands: a hub-issued command no purpose-built panel covers is said as the hub's way (HubRuns).
// 4. Simulate: fr.button's gestures and fr.analog_in's value, only on a node whose HELLO says inject is on.
// 5. Events: the last one, the kinds it tells of, and ALL ITS EVENTS › on Activity.
// 6. The foot: EXPERT · ITS OWN COMMANDS › to Engineering, where every raw command is.
// Builder PAGE owns this file; GENERIC_PANEL is the registry's fallback (panels.ts).

import { Link } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';

import type { CatalogCapability, CatalogCommand, CatalogProperty } from '@fractonica/protocol/gen';

import { useAct, useLive } from '../../../hooks.ts';
import { enumWords, memberValueText, memberWords } from '../../../state/cap-words.ts';
import { argValue, controlFor, type ControlSpec, coveredCommands, initialValue, linkArgs, numericOf, type PropertyLink, propertyLink } from '../../../state/device-controls.ts';
import { lastInstanceEvent } from '../../../state/device-link.ts';
import { fieldWords, fractionOf, unitInfo } from '../../../state/device-units.ts';
import { isHubIssued } from '../../../state/hub-issued.ts';
import { pureSafe } from '../../../state/pure-text.ts';
import { Button, ButtonRow, Caps, Disclosure, Earth, engrave, FTime, Reading, Row, Section, Sparkline, useFractonica, useMode } from '../../../ui/index.ts';
import { ColourWell, Meter, OnOff, useFlash } from '../bits.tsx';
import { CommandForm, PlainAction } from '../command-form.tsx';
import { ColourValue, InlineSlider, PropSwitch } from '../controls.tsx';
import type { CapPanel, CapPanelProps } from '../panels.ts';
import { HubRuns } from './hub-runs.tsx';

const GESTURES = ['press', 'release', 'click', 'double_click', 'long_press'] as const;
/** fr.analog_in's value range (07 §7.3): 0..65535 over the instance's min_mv..max_mv. */
const ANALOG_MAX = 65535;

/** True when the device cannot take a command now: its controls stay on the page, disabled. */
export function isAway(presence: string | undefined | null): boolean {
  return presence === 'offline' || presence === 'unknown';
}

/** A catalog text: shown in pure mode only when it names no Earth unit; Earth mode shows every one. */
export function DocText({ text, className }: { text: string; className: string }) {
  const { earth } = useMode();
  if (!earth && !pureSafe(text)) {
    return null;
  }
  return <p className={className}>{text}</p>;
}

/** A number in a member's unit and scale: the pure text, then in Earth mode its ⊕ translation. */
export function MemberValue({ cap, member, value }: { cap: string; member: { name: string; unit?: string }; value: number }) {
  const core = useFractonica();
  const v = memberValueText(core, cap, member, value);
  return (
    <span className="dev-unit-value">
      {v.text ? <Reading text={v.text} /> : null}
      {v.earth ? <Earth className="dev-earth-inline">{v.earth}</Earth> : null}
    </span>
  );
}

/** A property's value when nothing sets it: by its type, in words. */
export function PropertyValue({ cap, prop, value }: { cap: CatalogCapability; prop: CatalogProperty; value: unknown }) {
  if (value === undefined || value === null) {
    return <span className="ash">not reported yet</span>;
  }
  if (prop.type === 'bool') {
    return <OnOff value={value === true} words={['no', 'yes']} />;
  }
  if (prop.type === 'rgb' && typeof value === 'number') {
    return <ColourValue value={value} />;
  }
  const options = cap.types[prop.type];
  if (options && (typeof value === 'number' || typeof value === 'string')) {
    const name = typeof value === 'number' ? Object.entries(options).find(([, v]) => v === value)?.[0] : value;
    return <span>{name ? enumWords(cap.name, prop.type, name) : String(value)}</span>;
  }
  if (typeof value === 'number') {
    const w = memberWords(cap.name, prop);
    if (unitInfo(w.unit).cls === 'share') {
      return (
        <span className="dev-share">
          <Meter fraction={fractionOf(value, prop.range?.[0] ?? 0, prop.range?.[1] ?? 100)} label={w.words} />
          <MemberValue cap={cap.name} member={prop} value={value} />
        </span>
      );
    }
    if (prop.name === 'unix' && prop.unit === 's') {
      return value > 0 ? <FTime at={value * 1_000_000} form="short" /> : <span className="ash">not set</span>;
    }
    return <MemberValue cap={cap.name} member={prop} value={value} />;
  }
  return <span>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>;
}

/** A property that a command sets: its control, sending that command as it changes (an enum by its name, G2). */
function PropertyControl({ deviceId, inst, cap, prop, link, value, mirror, disabled }: { deviceId: string; inst: string; cap: CatalogCapability; prop: CatalogProperty; link: PropertyLink; value: unknown; mirror: Readonly<Record<string, unknown>>; disabled: boolean }) {
  const act = useAct('command_send', {
    done: (r) => (r.results[0]?.status === 'ok' ? undefined : { tone: 'warn', title: `${inst}: ${r.results[0]?.status.replace(/_/g, ' ') ?? 'no answer'}`, ...(r.results[0]?.error ? { body: r.results[0].error } : {}) }),
  });
  const spec: ControlSpec = controlFor(cap.commands.find((c) => c.name === link.command)!.fields.find((f) => f.name === link.field)!, cap);
  const send = (v: unknown) => {
    const r = argValue(spec, v);
    if (r.ok) {
      act.mutate({ selector: `id:${deviceId}`, command: `${inst}.${link.command}`, args: linkArgs(link, r.value, mirror) });
    }
  };
  const words = memberWords(cap.name, prop).words;
  const label = `${inst} ${words}`;
  const current = initialValue(spec, value);
  switch (spec.kind) {
    case 'toggle':
      return <PropSwitch label={label} checked={typeof value === 'boolean' ? value : undefined} onChange={send} disabled={disabled || act.isPending} />;
    case 'slider':
      return <InlineSlider label={label} value={current === '' ? (spec.min ?? 0) : Number(current)} min={spec.min ?? 0} max={spec.max ?? 255} unit={memberWords(cap.name, prop).unit ?? spec.unit} onCommit={send} disabled={disabled} />;
    case 'colour':
      return <ColourWell label={label} value={typeof current === 'number' ? current : 0xffffff} onChange={send} disabled={disabled} />;
    case 'select':
      return (
        <select className="ui-select dev-inline-select" aria-label={label} value={String(current)} disabled={disabled} onChange={(e) => send(e.target.value)}>
          {current === '' ? <option value="" disabled>{'not reported yet'}</option> : null}
          {(spec.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    default:
      return <PropertyValue cap={cap} prop={prop} value={value} />;
  }
}

function PropertyRow({ deviceId, inst, cap, prop, link, mirror, disabled }: { deviceId: string; inst: string; cap: CatalogCapability; prop: CatalogProperty; link: PropertyLink | null; mirror: Readonly<Record<string, unknown>>; disabled: boolean }) {
  const key = `${inst}.${prop.name}`;
  const history = useLive((s) => s.history[deviceId]?.[key]);
  const value = mirror[prop.name];
  const nums = (history ?? []).map((p) => numericOf(p.value)).filter((v): v is number => v !== null);
  const numeric = prop.type !== 'bool' && prop.type !== 'rgb' && !cap.types[prop.type] && typeof value === 'number';
  const words = memberWords(cap.name, prop).words;
  return (
    <div className="dev-prop" data-property={key}>
      <span className="dev-prop-label caps">{engrave(words)}</span>
      <span className="dev-prop-spark">{numeric && nums.length > 1 ? <Sparkline values={nums} width={96} height={18} label={`${words}, the last ${nums.length} values`} /> : null}</span>
      <span className="dev-prop-value">
        {link ? <PropertyControl deviceId={deviceId} inst={inst} cap={cap} prop={prop} link={link} value={value} mirror={mirror} disabled={disabled} /> : <PropertyValue cap={cap} prop={prop} value={value} />}
      </span>
    </div>
  );
}

/** fr.button's gestures through input_simulate (a debug build's inject). */
export function Gestures({ deviceId, inst }: { deviceId: string; inst: string }) {
  const act = useAct('input_simulate', { done: (r) => (r.results[0]?.status === 'ok' ? undefined : { tone: 'warn', title: `${inst}: ${r.results[0]?.status ?? 'no answer'}` }) });
  return (
    <Row label="Gesture" id={`${inst}.simulate`}>
      <ButtonRow>
        {GESTURES.map((g) => (
          <Button key={g} variant="quiet" disabled={act.isPending} data-gesture={g} aria-label={`Simulate ${fieldWords(g)} on ${inst}`} onClick={() => act.mutate({ selector: `id:${deviceId}`, instance: inst, gesture: g })}>
            {fieldWords(g)}
          </Button>
        ))}
      </ButtonRow>
    </Row>
  );
}

/** fr.analog_in's value through input_simulate {value} (layer inject): a slider and INJECT. */
export function AnalogInject({ deviceId, inst }: { deviceId: string; inst: string }) {
  const [value, setValue] = useState(32768);
  const act = useAct('input_simulate', { done: (r) => (r.results[0]?.status === 'ok' ? undefined : { tone: 'warn', title: `${inst}: ${r.results[0]?.status ?? 'no answer'}` }) });
  return (
    <Row label="Value" id={`${inst}.simulate`}>
      <span className="dev-analog" data-analog={inst}>
        <input
          type="range"
          className="ui-slider"
          min={0}
          max={ANALOG_MAX}
          value={value}
          aria-label={`${inst} value to inject`}
          style={{ ['--fill' as string]: `${fractionOf(value, 0, ANALOG_MAX) * 100}%` }}
          onChange={(e) => setValue(Number(e.target.value))}
        />
        <span className="dev-slider-value">{value}</span>
        <Button variant="quiet" busy={act.isPending} onClick={() => act.mutate({ selector: `id:${deviceId}`, instance: inst, value, layer: 'inject' })}>
          Inject
        </Button>
      </span>
    </Row>
  );
}

function EventsBlock({ deviceId, alias, inst, names }: { deviceId: string; alias: string; inst: string; names: string[] }) {
  const last = useLive((s) => lastInstanceEvent(s.events, deviceId, inst));
  const flashing = useFlash(deviceId);
  const lastNow = useLive((s) => s.lastByDevice[deviceId]);
  return (
    <Section
      title="Events"
      aside={
        <Link to="/devices/$id/activity" params={{ id: alias }} search={{ instrument: inst } as never} className="dev-more caps" data-link="instrument-events">
          {engrave('all its events ›')}
        </Link>
      }
    >
      <Row
        label="Last"
        id={`${inst}.events`}
        flash={flashing && !!lastNow && lastNow.type.startsWith(`${inst}.`)}
        value={
          last ? (
            <span className="dev-last-event">
              <span>{fieldWords(last.member ?? last.type.slice(inst.length + 1))}</span> <FTime at={last.t_hub_us} form="relative" />
            </span>
          ) : (
            <span className="ash">none has come yet</span>
          )
        }
      />
      <Row label={names.length === 1 ? 'Kind' : 'Kinds'} value={names.map((n) => fieldWords(n)).join(' · ')} id={`${inst}.event-kinds`} />
    </Section>
  );
}

/** Which of a capability's commands the generic Actions show, and which go to the hub-run block. */
export function actionCommands(cap: CatalogCapability, commands: readonly CatalogCommand[], links: readonly PropertyLink[], skip: readonly string[] = []): { plain: CatalogCommand[]; forms: CatalogCommand[]; hubRun: CatalogCommand[] } {
  const covered = coveredCommands(commands, links);
  const everyday = commands.filter((c) => c.visibility !== 'test' && !covered.has(c.name) && !skip.includes(c.name));
  const hubRun = everyday.filter((c) => isHubIssued(cap.name, c));
  const rest = everyday.filter((c) => !isHubIssued(cap.name, c));
  return { plain: rest.filter((c) => c.fields.length === 0), forms: rest.filter((c) => c.fields.length > 0), hubRun };
}

/** The generic Lens with an optional block under the readings (fr.display's panel picture) and commands to leave out. */
export function GenericBody({ detail, inst, cap, members, mirror, extra, skip = [] }: CapPanelProps & { extra?: ReactNode; skip?: readonly string[] }) {
  const deviceId = detail.device_id;
  const away = isAway(detail.presence);
  const links = members.properties.map((p) => propertyLink(cap, members.commands, p));
  const { plain, forms, hubRun } = actionCommands(
    cap,
    members.commands,
    links.filter((l): l is PropertyLink => l !== null),
    skip,
  );
  const inject = members.commands.some((c) => c.name === 'inject');
  const button = inject && cap.name === 'fr.button';
  const analog = inject && cap.name === 'fr.analog_in';
  return (
    <div className="dev-lens" data-generic={cap.name}>
      <div className="dev-lens-main">
        {members.properties.length ? (
          <Section title="Readings">
            {members.properties.map((p, i) => (
              <PropertyRow key={p.name} deviceId={deviceId} inst={inst.name} cap={cap} prop={p} link={links[i] ?? null} mirror={mirror} disabled={away} />
            ))}
          </Section>
        ) : null}
        {extra}
        {plain.length || forms.length ? (
          <Section title="Actions">
            {plain.map((c) => (
              <PlainAction key={c.name} deviceId={deviceId} inst={inst.name} cap={cap.name} cmd={c} disabled={away} />
            ))}
            {forms.map((c) => (
              <CommandForm key={c.name} deviceId={deviceId} inst={inst.name} cap={cap} cmd={c} mirror={mirror} disabled={away} />
            ))}
          </Section>
        ) : null}
        {hubRun.length ? (
          <Section title="The hub runs these">
            {hubRun.map((c) => (
              <HubRuns key={c.name} detail={detail} inst={inst} cmd={c} />
            ))}
          </Section>
        ) : null}
        {button || analog ? (
          <Disclosure title="Simulate" aside={<Caps>test build</Caps>}>
            {button ? <Gestures deviceId={deviceId} inst={inst.name} /> : null}
            {analog ? <AnalogInject deviceId={deviceId} inst={inst.name} /> : null}
          </Disclosure>
        ) : null}
      </div>
      <div className="dev-lens-side">
        <DocText className="dev-summary" text={cap.summary} />
        {members.events.length ? <EventsBlock deviceId={deviceId} alias={detail.alias} inst={inst.name} names={members.events.map((e) => e.name)} /> : null}
        <LensFoot alias={detail.alias} inst={inst.name} />
      </div>
    </div>
  );
}

/** The foot of every instrument page: the way to its raw commands (Engineering › Commands). */
export function LensFoot({ alias, inst }: { alias: string; inst: string }) {
  return (
    <p className="dev-foot">
      <Link to="/devices/$id/engineering" params={{ id: alias }} search={{ instrument: inst } as never} className="dev-more caps" data-link="expert">
        {engrave('expert · its own commands ›')}
      </Link>
    </p>
  );
}

function GenericLens(props: CapPanelProps) {
  return <GenericBody {...props} />;
}

/** The Overview row's reading: the first property with a value, in words and its unit. */
function GenericHeadline({ cap, mirror }: CapPanelProps) {
  const first = cap.properties.find((p) => mirror[p.name] !== undefined && mirror[p.name] !== null);
  if (!first) {
    return <span className="ash">—</span>;
  }
  return (
    <span className="dev-headline">
      <span className="ash">{memberWords(cap.name, first).words}</span> <PropertyValue cap={cap} prop={first} value={mirror[first.name]} />
    </span>
  );
}

export const GENERIC_PANEL: CapPanel = { Lens: GenericLens, Headline: GenericHeadline };
