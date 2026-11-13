// A device's capabilities (spec 08 §8.9 "capabilities rendered from catalog.json"; HARDWARE-REVIEW §4 "Screens" 3):
// each instance a block of rows, generated from the catalog.
// - Properties are rows with their live value (the router's mirror, then `part:'state'` events) and, when numeric, a
//   lumen sparkline of their recent values. A property a command sets (state/device-controls.ts propertyLink) is its
//   own control: a toggle, a slider, a colour well, a select, sending that command at once.
// - The other commands: those without fields are buttons on one row; those with fields fold out into a form of typed
//   controls (no JSON), sent with SEND, and their answer said on one line.
// - Test commands (inject) only on a node whose HELLO says inject_enabled: fr.button's gestures and fr.analog_in's
//   value through input_simulate, as before; any other inject is a generated form.
// - The events the instance can raise, and its last one as a Fractonica time; its row lights on an input.
// - fr.display keeps its snapshot, tap and layout preview (display.tsx).

import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { CATALOG, type CatalogCapability, type CatalogCommand, type CatalogProperty } from '@fractonica/protocol/gen';

import { opMissing } from '../../api/rest.ts';
import type { CommandOutcome, DeviceDetail } from '../../api/types.ts';
import { useAct, useLive, useOp } from '../../hooks.ts';
import { joinCatalog, type InstanceView, visibleMembers } from '../../state/caps.ts';
import {
  argValue,
  buildArgs,
  controlFor,
  type ControlSpec,
  coveredCommands,
  initialValue,
  linkArgs,
  numericOf,
  type PropertyLink,
  propertyLink,
} from '../../state/device-controls.ts';
import { lastInstanceEvent } from '../../state/device-link.ts';
import { fieldWords, fractionOf, impliedUnit, spanText, unitInfo, unitOf } from '../../state/device-units.ts';
import { pureSafe } from '../../state/pure-text.ts';
import { Bead, Button, ButtonRow, Caps, Disclosure, EmptyState, ErrorLine, FTime, Row, Section, Sparkline, engrave, useFractonica, useMode } from '../../ui/index.ts';
import { OnOff, Meter, UnitValue, useFlash } from './bits.tsx';
import { ColourValue, FieldControl, InlineSlider, PropSwitch } from './controls.tsx';
import { ColourWell } from './bits.tsx';
import { DisplayBlock, SNAPSHOT_COMMANDS, touchOf } from './display.tsx';

const GESTURES = ['press', 'release', 'click', 'double_click', 'long_press'] as const;
/** fr.analog_in's value range (07 §7.3): 0..65535 over the instance's min_mv..max_mv. */
const ANALOG_MAX = 65535;

/** A catalog text: shown in pure mode only when it names no Earth unit; Earth mode shows every one. */
function DocText({ text, className }: { text: string; className: string }) {
  const { earth } = useMode();
  if (!earth && !pureSafe(text)) {
    return null;
  }
  return <p className={className}>{text}</p>;
}

/** A command's answer on one line: a bead, the status, how long the round trip took (a span), the fields it returned. */
export function Outcome({ res, error }: { res?: CommandOutcome; error?: unknown }) {
  const core = useFractonica();
  if (error) {
    return <ErrorLine error={error} />;
  }
  if (!res) {
    return null;
  }
  const ok = res.status === 'ok' || res.status === 'sent';
  return (
    <div className="dev-outcome" role="status" data-result={res.status}>
      <Bead state={ok ? 'online' : 'fault'} label={res.status} />
      <Caps tone={ok ? 'bone' : 'ash'}>{res.status.replace(/_/g, ' ')}</Caps>
      {res.rtt_ms !== undefined && core ? <span className="ash">answered in {spanText(core, res.rtt_ms * 1000)}</span> : null}
      {res.fields && Object.keys(res.fields).length ? (
        <span className="dev-outcome-fields">
          {Object.entries(res.fields).map(([k, v]) => (
            <span key={k}>
              <span className="ash">{fieldWords(k)}</span> {typeof v === 'number' && impliedUnit(k) ? <UnitValue value={v} unit={impliedUnit(k)} /> : typeof v === 'object' ? JSON.stringify(v) : String(v)}
            </span>
          ))}
        </span>
      ) : null}
      {res.error ? <span className="dev-outcome-error">{res.error}</span> : null}
    </div>
  );
}

/** A command with fields: a fold with its typed form. */
function CommandForm({ deviceId, inst, cap, cmd, mirror }: { deviceId: string; inst: string; cap: CatalogCapability; cmd: CatalogCommand; mirror: Record<string, unknown> }) {
  const specs = useMemo(() => cmd.fields.map((f) => controlFor(f, cap)), [cmd, cap]);
  const example = cmd.examples?.[0] ?? {};
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(specs.map((s) => [s.name, example[s.name] ?? initialValue(s, cap.properties.some((p) => p.name === s.name && p.type === s.type) ? mirror[s.name] : undefined)])),
  );
  const [touched, setTouched] = useState<Set<string>>(() => new Set(Object.keys(example)));
  const [tried, setTried] = useState(false);
  const act = useAct('command_send');
  const built = buildArgs(specs, values, touched);
  const set = (name: string, v: unknown) => {
    setValues((o) => ({ ...o, [name]: v }));
    setTouched((t) => new Set(t).add(name));
  };
  return (
    <Disclosure title={fieldWords(cmd.name)} aside={cmd.visibility === 'test' ? <Caps>test</Caps> : undefined}>
      <form
        className="dev-command"
        data-command={`${inst}.${cmd.name}`}
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (built.ok) {
            act.mutate({ selector: `id:${deviceId}`, command: `${inst}.${cmd.name}`, args: built.args });
          }
        }}
      >
        {cmd.doc ? <DocText className="dev-doc" text={cmd.doc.trim()} /> : null}
        <div className="dev-fields">
          {specs.map((s) => (
            <FieldControl key={s.name} spec={s} value={values[s.name]} onChange={(v) => set(s.name, v)} error={tried && !built.ok ? built.errors[s.name] : undefined} />
          ))}
        </div>
        <ButtonRow>
          <Button type="submit" busy={act.isPending} aria-label={`Send ${fieldWords(cmd.name)} to ${inst}`}>
            Send
          </Button>
        </ButtonRow>
        <Outcome res={act.data?.results[0]} />
      </form>
    </Disclosure>
  );
}

/** fr.button's gestures through input_simulate (a debug build's inject). */
function Gestures({ deviceId, inst }: { deviceId: string; inst: string }) {
  const act = useAct('input_simulate', { done: (r) => (r.results[0]?.status === 'ok' ? undefined : { tone: 'warn', title: `${inst}: ${r.results[0]?.status ?? 'no answer'}` }) });
  return (
    <Row label="Simulate" id={`${inst}.simulate`}>
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
function AnalogInject({ deviceId, inst }: { deviceId: string; inst: string }) {
  const [value, setValue] = useState(32768);
  const act = useAct('input_simulate', { done: (r) => (r.results[0]?.status === 'ok' ? undefined : { tone: 'warn', title: `${inst}: ${r.results[0]?.status ?? 'no answer'}` }) });
  return (
    <Row label="Simulate" id={`${inst}.simulate`}>
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

/** A property's value when nothing sets it: by its type. */
function PropertyValue({ cap, prop, value }: { cap: CatalogCapability; prop: CatalogProperty; value: unknown }) {
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
  if (options && typeof value === 'number') {
    const word = Object.entries(options).find(([, v]) => v === value)?.[0];
    return <span>{word ? word.replace(/_/g, ' ') : value}</span>;
  }
  if (typeof value === 'number') {
    const unit = unitOf(prop);
    const u = unitInfo(unit);
    if (u.cls === 'share') {
      return (
        <span className="dev-share">
          <Meter fraction={fractionOf(value, prop.range?.[0] ?? 0, prop.range?.[1] ?? 100)} label={fieldWords(prop.name)} />
          <UnitValue value={value} unit={unit} />
        </span>
      );
    }
    if (prop.name === 'unix' && prop.unit === 's') {
      return value > 0 ? <FTime at={value * 1_000_000} form="short" /> : <span className="ash">not set</span>;
    }
    return <UnitValue value={value} unit={unit} />;
  }
  return <span>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>;
}

/** A property that a command sets: its control, sending that command as it changes. */
function PropertyControl({ deviceId, inst, cap, prop, link, value, mirror }: { deviceId: string; inst: string; cap: CatalogCapability; prop: CatalogProperty; link: PropertyLink; value: unknown; mirror: Record<string, unknown> }) {
  const act = useAct('command_send', {
    done: (r) => (r.results[0]?.status === 'ok' ? undefined : { tone: 'warn', title: `${inst}.${link.command}: ${r.results[0]?.status ?? 'no answer'}`, ...(r.results[0]?.error ? { body: r.results[0].error } : {}) }),
  });
  const spec: ControlSpec = controlFor(cap.commands.find((c) => c.name === link.command)!.fields.find((f) => f.name === link.field)!, cap);
  const send = (v: unknown) => {
    const r = argValue(spec, v);
    if (r.ok) {
      act.mutate({ selector: `id:${deviceId}`, command: `${inst}.${link.command}`, args: linkArgs(link, r.value, mirror) });
    }
  };
  const label = `${inst} ${fieldWords(prop.name)}`;
  const current = value ?? initialValue(spec);
  switch (spec.kind) {
    case 'toggle':
      return <PropSwitch label={label} checked={current === true} onChange={send} disabled={act.isPending} />;
    case 'slider':
      return <InlineSlider label={label} value={Number(current)} min={spec.min ?? 0} max={spec.max ?? 255} unit={unitOf(prop) ?? spec.unit} onCommit={send} />;
    case 'colour':
      return <ColourWell label={label} value={typeof current === 'number' ? current : 0xffffff} onChange={send} />;
    case 'select':
      return (
        <select className="ui-select dev-inline-select" aria-label={label} value={String(current)} onChange={(e) => send(Number(e.target.value))}>
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

function PropertyRow({ deviceId, inst, cap, prop, link, mirror }: { deviceId: string; inst: string; cap: CatalogCapability; prop: CatalogProperty; link: PropertyLink | null; mirror: Record<string, unknown> }) {
  const key = `${inst}.${prop.name}`;
  const history = useLive((s) => s.history[deviceId]?.[key]);
  const value = mirror[prop.name];
  const nums = (history ?? []).map((p) => numericOf(p.value)).filter((v): v is number => v !== null);
  const numeric = prop.type !== 'bool' && prop.type !== 'rgb' && !cap.types[prop.type] && typeof value === 'number';
  return (
    <div className="dev-prop" data-property={key}>
      <span className="dev-prop-label caps">{engrave(fieldWords(prop.name))}</span>
      <span className="dev-prop-spark">{numeric && nums.length > 1 ? <Sparkline values={nums} width={96} height={18} label={`${fieldWords(prop.name)}, the last ${nums.length} values`} /> : null}</span>
      <span className="dev-prop-value">{link ? <PropertyControl deviceId={deviceId} inst={inst} cap={cap} prop={prop} link={link} value={value} mirror={mirror} /> : <PropertyValue cap={cap} prop={prop} value={value} />}</span>
    </div>
  );
}

function EventsRow({ deviceId, inst, names }: { deviceId: string; inst: string; names: string[] }) {
  const last = useLive((s) => lastInstanceEvent(s.events, deviceId, inst));
  const flashing = useFlash(deviceId);
  const lastNow = useLive((s) => s.lastByDevice[deviceId]);
  return (
    <Row
      label="Events"
      id={`${inst}.events`}
      flash={flashing && !!lastNow && lastNow.type.startsWith(`${inst}.`)}
      value={last ? <span className="dev-last-event"><span>{last.member ?? last.type.slice(inst.length + 1)}</span> <FTime at={last.t_hub_us} form="relative" /></span> : <span className="ash">none yet</span>}
      extra={names.map((n) => fieldWords(n)).join(' · ')}
    />
  );
}

function InstanceBlock({ detail, inst, cap, instances }: { detail: DeviceDetail; inst: InstanceView; cap: CatalogCapability | undefined; instances: readonly InstanceView[] }) {
  const deviceId = detail.device_id;
  const live = useLive((s) => s.properties[deviceId]);
  const routerProps = (detail.router?.properties ?? {}) as Record<string, unknown>;
  const m = cap ? visibleMembers(cap, inst.traits, detail.router?.hello_caps ?? null) : null;
  // the property mirror of this instance, by property name: live values over the router's
  const mirror: Record<string, unknown> = {};
  for (const p of m?.properties ?? []) {
    const key = `${inst.name}.${p.name}`;
    mirror[p.name] = live?.[key]?.value ?? routerProps[key];
  }
  const aside = (
    <span className="dev-inst-aside">
      <span className="mono">{`${inst.cap}${inst.v ? ` ${inst.v}` : ''}`}</span>
      <Caps>{`port ${inst.port}`}</Caps>
    </span>
  );
  if (!cap || !m) {
    return (
      <Section title={inst.name} aside={aside} id={`inst-${inst.name}`}>
        <Row label="Catalog" value={<span className="ash">this dashboard’s catalog does not know {inst.cap}; rebuild it</span>} />
      </Section>
    );
  }
  const links = m.properties.map((p) => propertyLink(cap, m.commands, p));
  const covered = coveredCommands(m.commands, links.filter((l): l is PropertyLink => l !== null));
  const hasInject = m.commands.some((c) => c.name === 'inject');
  const button = hasInject && inst.cap === 'fr.button';
  const analog = hasInject && inst.cap === 'fr.analog_in';
  const display = inst.cap === 'fr.display';
  const rest = m.commands.filter((c) => !covered.has(c.name) && !(c.name === 'inject' && (button || analog)) && !(display && SNAPSHOT_COMMANDS.includes(c.name)));
  const plain = rest.filter((c) => c.fields.length === 0);
  const forms = rest.filter((c) => c.fields.length > 0);
  return (
    <Section title={inst.name} aside={aside} id={`inst-${inst.name}`}>
      <DocText className="dev-summary" text={cap.summary} />
      {m.properties.map((p, i) => (
        <PropertyRow key={p.name} deviceId={deviceId} inst={inst.name} cap={cap} prop={p} link={links[i] ?? null} mirror={mirror} />
      ))}
      {plain.length ? <PlainCommands deviceId={deviceId} inst={inst.name} commands={plain} /> : null}
      {forms.map((c) => (
        <CommandForm key={c.name} deviceId={deviceId} inst={inst.name} cap={cap} cmd={c} mirror={mirror} />
      ))}
      {button ? <Gestures deviceId={deviceId} inst={inst.name} /> : null}
      {analog ? <AnalogInject deviceId={deviceId} inst={inst.name} /> : null}
      {display ? <DisplayBlock deviceId={deviceId} inst={inst.name} traits={inst.traits} touch={touchOf(inst, instances)} profile={detail.profile ?? null} /> : null}
      {m.events.length ? <EventsRow deviceId={deviceId} inst={inst.name} names={m.events.map((e) => e.name)} /> : null}
    </Section>
  );
}

/** The commands without fields: one row of buttons, the answer of the last one under them. */
function PlainCommands({ deviceId, inst, commands }: { deviceId: string; inst: string; commands: CatalogCommand[] }) {
  const act = useAct('command_send');
  const [last, setLast] = useState<string | null>(null);
  return (
    <div className="dev-plain">
      <Row label="Do">
        <ButtonRow>
          {commands.map((c) => (
            <Button
              key={c.name}
              variant="quiet"
              disabled={act.isPending}
              data-command={`${inst}.${c.name}`}
              aria-label={`${fieldWords(c.name)} ${inst}`}
              onClick={() => {
                setLast(c.name);
                act.mutate({ selector: `id:${deviceId}`, command: `${inst}.${c.name}`, args: {} });
              }}
            >
              {fieldWords(c.name)}
            </Button>
          ))}
        </ButtonRow>
      </Row>
      {last && (act.data || act.error) ? (
        <div className="dev-plain-outcome">
          <Caps>{fieldWords(last)}</Caps>
          <Outcome res={act.data?.results[0]} />
        </div>
      ) : null}
    </div>
  );
}

export function Capabilities({ detail }: { detail: DeviceDetail }) {
  const id = detail.device_id;
  const q = useOp('capability_list', { device: `id:${id}` });
  // capability_list (D14) first; without it, the router's instances from device_get and the catalog this build has
  const listed = q.data?.device?.instances;
  const instances: InstanceView[] = listed?.length
    ? listed
    : (detail.router?.instances?.map((i) => ({ name: i.name, port: i.port, cap: i.cap, cap_id: i.cap_id, v: '', traits: null })) ?? []);
  const caps = (q.data?.caps as unknown as CatalogCapability[] | undefined) ?? CATALOG.capabilities;
  // fr.node, fr.ota and fr.diag are the node's own (Identify, Engineering): not instruments
  const rows = joinCatalog(instances, caps).filter(({ inst }) => !['fr.node', 'fr.ota', 'fr.diag'].includes(inst.cap));
  if (q.isPending && !detail.router?.instances?.length) {
    return (
      <Section title="Capabilities">
        <Row label="Capabilities" value={<span className="ash">asking the hub</span>} />
      </Section>
    );
  }
  return (
    <div className="dev-caps" data-caps={rows.length}>
      {q.error && !opMissing(q.error) ? <ErrorLine error={q.error} what="The capability list" /> : null}
      {!rows.length ? (
        <Section title="Capabilities">
          {detail.provision && detail.presence !== 'online' && !detail.last_seen ? (
            <EmptyState
              title="Provisioned, not on Wi-Fi yet"
              action={
                <Link to="/provision" className="ui-button" data-variant="default">
                  <span className="ui-button-text">{engrave('Provision it again')}</span>
                </Link>
              }
            >
              It answered over USB when it was flashed but has not greeted the hub over Wi-Fi. Check its network in Settings › Networks (the name and the password), or provision it again.
            </EmptyState>
          ) : (
            <EmptyState title="No capabilities known yet">
              The device says what it has when it greets the hub. {detail.presence === 'online' ? 'It has not said yet this run.' : 'Once it is powered and on the network, it will.'}
            </EmptyState>
          )}
        </Section>
      ) : null}
      {rows.map(({ inst, cap }) => (
        <InstanceBlock key={inst.name} detail={detail} inst={inst} cap={cap} instances={instances} />
      ))}
    </div>
  );
}
