// A device command as a person runs it (DEVICE-SPEC §2.2 G2–G8), shared by the generic panel's Actions and the
// Engineering console:
// - a command without fields is one button that says what it does to what ("TOGGLE STATUS");
// - a command with fields is a fold titled with its verb: its required fields, the optional ones under MORE SETTINGS
//   (sent only once touched), and a button that repeats the verb and the instance; while a required field is empty
//   the button waits and says which ("Fill in recording first");
// - a field starts from the property it shadows, then its default, then empty: an example is only a hint ("e.g. 3");
// - every action has a line that says what a press does, always visible;
// - the answer is said in words (state/words.ts outcomeWords), never as JSON.
// No button here says "Send".

import { useMemo, useState } from 'react';

import type { CatalogCapability, CatalogCommand } from '@fractonica/protocol/gen';

import type { CommandOutcome } from '../../api/types.ts';
import { useAct } from '../../hooks.ts';
import { parseArgs } from '../../state/caps.ts';
import { commandDoes, commandWords, enumWords, firstSentence, isDestructive } from '../../state/cap-words.ts';
import { buildArgs, controlFor, type ControlSpec, missingFields, seedValues, wordList } from '../../state/device-controls.ts';
import { fieldWords, impliedUnit, spanText, unitInfo, valueText } from '../../state/device-units.ts';
import { pureSafe } from '../../state/pure-text.ts';
import { outcomeWords } from '../../state/words.ts';
import { Bead, Button, ButtonRow, Caps, Disclosure, ErrorLine, useFractonica, useHubText, useMode } from '../../ui/index.ts';
import { UnitValue } from './bits.tsx';
import { FieldControl } from './controls.tsx';

/** A command's answer on one line: a bead, the status in words, how long the round trip took (a span), its fields. */
export function Outcome({ res, error }: { res?: CommandOutcome | undefined; error?: unknown }) {
  const core = useFractonica();
  const said = useHubText();
  if (error) {
    return <ErrorLine error={error} />;
  }
  if (!res) {
    return null;
  }
  const ok = res.status === 'ok' || res.status === 'sent';
  return (
    <div className="dev-outcome" role="status" data-result={res.status}>
      <Bead state={ok ? 'online' : 'fault'} label={res.status.replace(/_/g, ' ')} />
      <span className={ok ? 'dev-outcome-words' : 'dev-outcome-error'}>{outcomeWords(res.status, res.status === 'invalid_args' && res.error ? said(res.error) : null)}</span>
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
      {res.error && res.status !== 'invalid_args' ? <span className="dev-outcome-error">{said(res.error)}</span> : null}
    </div>
  );
}

/** What a press of a command does, one sentence (G5): the words table's, the catalog's first (pure-safe) sentence, else plain. */
export function useDoes(cap: string, cmd: Pick<CatalogCommand, 'name' | 'doc'>, inst: string): string {
  const { earth } = useMode();
  const mine = commandDoes(cap, cmd.name, inst);
  if (mine) {
    return mine;
  }
  if (cmd.doc?.trim()) {
    if (earth) {
      return cmd.doc.trim().replace(/\s+/g, ' ').replace(/`/g, '');
    }
    const first = firstSentence(cmd.doc);
    if (pureSafe(first)) {
      return first;
    }
  }
  return `Sends ${commandWords(cap, cmd.name).verb} to ${inst}.`;
}

/** The verb and the instance a command's button reads ("blink status", "delete a recording cam"). */
export function actionLabel(cap: string, cmd: string, inst: string): string {
  return `${commandWords(cap, cmd).verb} ${inst}`;
}

/** An example value as a hint under its field, in the field's words and units ("e.g. card", "e.g. 3.2ν"). */
function useHint(cap: CatalogCapability, cmd: CatalogCommand, spec: ControlSpec): string | undefined {
  const core = useFractonica();
  const ex = (cmd.examples?.[0] as Record<string, unknown> | undefined)?.[spec.name];
  if (ex === undefined || ex === null || typeof ex === 'object') {
    return undefined;
  }
  if (spec.kind === 'select' && typeof ex === 'string') {
    return `e.g. ${enumWords(cap.name, spec.type, ex)}`;
  }
  if (typeof ex === 'number' && spec.unit) {
    const cls = unitInfo(spec.unit).cls;
    if (cls === 'share') {
      return undefined;
    }
    const t = valueText(core, ex, spec.unit).text;
    return t && t !== '—' ? `e.g. ${t}` : undefined;
  }
  return typeof ex === 'boolean' ? undefined : `e.g. ${String(ex)}`;
}

function Field({ cap, cmd, spec, value, error, onChange, disabled }: { cap: CatalogCapability; cmd: CatalogCommand; spec: ControlSpec; value: unknown; error: string | undefined; onChange: (v: unknown) => void; disabled: boolean }) {
  const hint = useHint(cap, cmd, spec);
  return <FieldControl spec={spec} value={value} onChange={onChange} error={error} {...(hint ? { hint } : {})} disabled={disabled} />;
}

export interface CommandFormProps {
  deviceId: string;
  inst: string;
  cap: CatalogCapability;
  cmd: CatalogCommand;
  mirror: Readonly<Record<string, unknown>>;
  /** The device cannot take it now (offline): the controls stay, disabled. */
  disabled?: boolean;
  /** An aside on the fold's title (Engineering: "the cam page does this"; a test command: "test"). */
  aside?: string;
  /** Engineering: a SEND AS JSON fold under the form. */
  json?: boolean;
  defaultOpen?: boolean;
}

/** A command with fields: a fold titled with its verb, its "does" line under the title, the form inside. */
export function CommandForm({ deviceId, inst, cap, cmd, mirror, disabled = false, aside, json = false, defaultOpen = false }: CommandFormProps) {
  const specs = useMemo(() => cmd.fields.map((f) => controlFor(f, cap)), [cmd, cap]);
  const [values, setValues] = useState<Record<string, unknown>>(() => seedValues(specs, cap.properties, mirror));
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [tried, setTried] = useState(false);
  const act = useAct('command_send');
  const built = buildArgs(specs, values, touched);
  const missing = missingFields(specs, values);
  const does = useDoes(cap.name, cmd, inst);
  const words = commandWords(cap.name, cmd.name);
  const label = actionLabel(cap.name, cmd.name, inst);
  const destructive = isDestructive(cmd.name);
  const set = (name: string, v: unknown) => {
    setValues((o) => ({ ...o, [name]: v }));
    setTouched((t) => new Set(t).add(name));
  };
  const required = specs.filter((s) => !s.optional);
  const optional = specs.filter((s) => s.optional);
  const run = () => {
    setTried(true);
    if (built.ok && !missing.length) {
      act.mutate({ selector: `id:${deviceId}`, command: `${inst}.${cmd.name}`, args: built.args });
    }
  };
  const field = (s: ControlSpec) => (
    <Field key={s.name} cap={cap} cmd={cmd} spec={s} value={values[s.name]} error={tried && !built.ok ? built.errors[s.name] : undefined} onChange={(v) => set(s.name, v)} disabled={disabled} />
  );
  return (
    <div className="dev-action" data-action-of={`${inst}.${cmd.name}`}>
      <Disclosure title={words.verb} sub={does} aside={aside ? <Caps>{aside}</Caps> : undefined} defaultOpen={defaultOpen}>
        <form
          className="dev-command"
          data-command={`${inst}.${cmd.name}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (!destructive) {
              run();
            }
          }}
        >
          {required.length ? <div className="dev-fields">{required.map(field)}</div> : null}
          {optional.length ? (
            <Disclosure title={`more settings · ${optional.length}`}>
              <div className="dev-fields">{optional.map(field)}</div>
              <p className="dev-doc">A setting here is sent only once you change it.</p>
            </Disclosure>
          ) : null}
          <ButtonRow>
            <Button
              type={destructive ? 'button' : 'submit'}
              variant={destructive ? 'destructive' : 'default'}
              busy={act.isPending}
              disabled={disabled || missing.length > 0}
              data-run={`${inst}.${cmd.name}`}
              {...(destructive ? { confirm: `${words.verb.charAt(0).toUpperCase()}${words.verb.slice(1)} on ${inst}? It cannot be undone.`, confirmLabel: 'Yes', cancelLabel: 'Keep it', onClick: run } : {})}
            >
              {label}
            </Button>
          </ButtonRow>
          {missing.length ? <p className="dev-missing caps">{`fill in ${wordList(missing)} first`}</p> : null}
          <Outcome res={act.data?.results[0]} error={act.error} />
        </form>
        {json ? <JsonForm deviceId={deviceId} inst={inst} cmd={cmd} disabled={disabled} /> : null}
      </Disclosure>
    </div>
  );
}

/** Engineering: the command's args as JSON, for what the typed form cannot say (parseArgs). */
function JsonForm({ deviceId, inst, cmd, disabled }: { deviceId: string; inst: string; cmd: CatalogCommand; disabled: boolean }) {
  const [text, setText] = useState('{}');
  const act = useAct('command_send');
  const parsed = parseArgs(text);
  return (
    <Disclosure title="send as json">
      <form
        className="dev-command"
        data-json={`${inst}.${cmd.name}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (parsed.ok) {
            act.mutate({ selector: `id:${deviceId}`, command: `${inst}.${cmd.name}`, args: parsed.args });
          }
        }}
      >
        <textarea className="dev-json mono" rows={4} spellCheck={false} aria-label={`${inst} ${cmd.name} args as JSON`} value={text} onChange={(e) => setText(e.target.value)} />
        {!parsed.ok ? <span className="ui-field-error">{parsed.error}</span> : null}
        <ButtonRow>
          <Button type="submit" variant="quiet" busy={act.isPending} disabled={disabled || !parsed.ok}>
            Run with this JSON
          </Button>
        </ButtonRow>
        <Outcome res={act.data?.results[0]} error={act.error} />
      </form>
    </Disclosure>
  );
}

/** A command without fields: one button with the verb and the instance, what it does beside it, its answer under. */
export function PlainAction({ deviceId, inst, cap, cmd, disabled = false, aside, json = false }: { deviceId: string; inst: string; cap: string; cmd: CatalogCommand; disabled?: boolean; aside?: string; json?: boolean }) {
  const act = useAct('command_send');
  const does = useDoes(cap, cmd, inst);
  const words = commandWords(cap, cmd.name);
  const destructive = isDestructive(cmd.name);
  const run = () => act.mutate({ selector: `id:${deviceId}`, command: `${inst}.${cmd.name}`, args: {} });
  return (
    <div className="dev-action dev-action-plain" data-action-of={`${inst}.${cmd.name}`}>
      <div className="dev-action-line">
        <Button
          variant={destructive ? 'destructive' : 'quiet'}
          busy={act.isPending}
          disabled={disabled}
          data-command={`${inst}.${cmd.name}`}
          onClick={run}
          {...(destructive ? { confirm: `${words.verb.charAt(0).toUpperCase()}${words.verb.slice(1)} on ${inst}? It cannot be undone.`, confirmLabel: 'Yes', cancelLabel: 'Keep it' } : {})}
        >
          {actionLabel(cap, cmd.name, inst)}
        </Button>
        <span className="dev-does">{does}</span>
        {aside ? <Caps>{aside}</Caps> : null}
      </div>
      <Outcome res={act.data?.results[0]} error={act.error} />
      {json ? <JsonForm deviceId={deviceId} inst={inst} cmd={cmd} disabled={disabled} /> : null}
    </div>
  );
}
