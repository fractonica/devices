// The device page's "Engineering" fold (HARDWARE-REVIEW §4 "Screens" 3): what an engineer reads and a first-time user
// never needs: the node's own diagnostics (fr_diag info and stats, over USB or its hub link), its bindings (the
// node-to-node rules the hub pushes), its OTA history (bytes as light, never a percentage), and the raw JSON the hub
// answered for it. Each part asks the hub only once the fold is open.

import { useState } from 'react';

import type { BindingRow, DeviceDetail, OtaRow } from '../../api/types.ts';
import { useAct, useOp } from '../../hooks.ts';
import { parseArgs } from '../../state/caps.ts';
import { flattenJson, pureJson, shortId } from '../../state/device-link.ts';
import { fractionOf, impliedUnit } from '../../state/device-units.ts';
import { Bead, type BeadState, Button, ButtonRow, Caps, Disclosure, ErrorLine, FTime, fTimeText, instantOf, Row, Section, TextField, Toggle, useFractonica, useMode } from '../../ui/index.ts';
import { Meter, UnitValue } from './bits.tsx';

/**
 * JSON as the hub answered it. Pure mode writes its ISO times in Fractonica notation (no Gregorian date on the page);
 * Earth mode shows it untouched.
 */
export function RawJson({ value, id }: { value: unknown; id?: string }) {
  const core = useFractonica();
  const { earth } = useMode();
  const shown = earth || !core ? value : pureJson(value, (iso) => fTimeText(core, instantOf(iso)!, null, { form: 'stamp', earthMode: false }).text);
  return (
    <pre className="dev-raw mono" data-raw={id}>
      {JSON.stringify(shown, null, 2)}
    </pre>
  );
}

/** The fr_diag lines that only read. */
const DIAG_LINES = ['info', 'stats'] as const;

/** A JSON answer as rows on hairlines, nested objects flattened ("links · tcp · up"); ISO times as in RawJson. */
function JsonRows({ value }: { value: unknown }) {
  const core = useFractonica();
  const { earth } = useMode();
  const shown = earth || !core ? value : pureJson(value, (iso) => fTimeText(core, instantOf(iso)!, null, { form: 'stamp', earthMode: false }).text);
  return (
    <>
      {flattenJson(shown).map(([label, text, key, n]) => (
        <Row key={label} label={label} value={n !== null && impliedUnit(key) ? <UnitValue value={n} unit={impliedUnit(key)} /> : <span className="mono dev-wrap dev-json-value">{text}</span>} />
      ))}
    </>
  );
}

function Diagnostics({ deviceId, reachable }: { deviceId: string; reachable: boolean }) {
  const [line, setLine] = useState<string | null>(null);
  const act = useAct('diag_exec');
  return (
    <Section
      title="Diagnostics"
      aside={
        <ButtonRow>
          {DIAG_LINES.map((l) => (
            <Button
              key={l}
              variant="quiet"
              disabled={act.isPending || !reachable}
              data-action={`diag-${l}`}
              onClick={() => {
                setLine(l);
                act.mutate({ port: deviceId, line: l });
              }}
            >
              {l}
            </Button>
          ))}
        </ButtonRow>
      }
    >
      {act.isPending ? <Row label={line ?? ''} value={<span className="ash">asking the node</span>} /> : null}
      {act.error ? <ErrorLine error={act.error} what={`Diagnostics ${line ?? ''}`} /> : null}
      {act.data && !act.isPending ? (
        <div data-diag={line ?? ''}>
          <Row label="Read" value={`${line} via ${act.data.via}`} />
          <JsonRows value={act.data.response} />
        </div>
      ) : null}
      {!act.data && !act.error && !act.isPending ? (
        <p className="dev-quiet ash">{reachable ? 'The node’s own counters and build facts, read over USB or its hub link.' : 'The node must be online or on USB to answer.'}</p>
      ) : null}
    </Section>
  );
}

function BindingLine({ b, deviceId }: { b: BindingRow; deviceId: string }) {
  const clear = useAct('binding_clear', { done: () => 'binding removed', refresh: ['binding_list'] });
  return (
    <div className="dev-binding" data-binding={b.slot}>
      <Bead state={b.pushed ? 'online' : 'waiting'} label={b.pushed ? 'on the node' : 'waiting to be pushed'} />
      <span className="mono dev-wrap">
        {b.from} <span className="ash">→</span> {b.to}
        {b.args !== undefined && b.args !== null ? <span className="ash"> {JSON.stringify(b.args)}</span> : null}
      </span>
      <Caps>{`slot ${b.slot}`}</Caps>
      <Button variant="destructive" confirm={`Remove slot ${b.slot}?`} confirmLabel="Remove" busy={clear.isPending} onClick={() => clear.mutate({ device: `id:${deviceId}`, slot: b.slot })}>
        Remove
      </Button>
    </div>
  );
}

function Bindings({ deviceId, alias }: { deviceId: string; alias: string }) {
  const [nodeTable, setNodeTable] = useState(false);
  const q = useOp('binding_list', { selector: `id:${deviceId}`, live: nodeTable });
  const [form, setForm] = useState({ from: `${alias}.`, to: '', args: '' });
  const set = useAct('binding_set', { done: (b) => `bound in slot ${b.slot}`, refresh: ['binding_list'] });
  const rows = q.data?.bindings ?? [];
  const args = form.args.trim() ? parseArgs(form.args) : null;
  return (
    <Section title="Bindings" aside={<Toggle label="The node’s own table" checked={nodeTable} onChange={setNodeTable} />}>
      {q.error ? <ErrorLine error={q.error} what="Bindings" /> : null}
      {nodeTable && q.data?.devices ? (
        <RawJson value={q.data.devices} />
      ) : rows.length ? (
        rows.map((b) => <BindingLine key={b.slot} b={b} deviceId={deviceId} />)
      ) : q.data ? (
        <p className="dev-quiet ash">No bindings: an event of one device can run a command on another without the hub.</p>
      ) : null}
      <form
        className="dev-bind-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (args && !args.ok) {
            return;
          }
          set.mutate({ from: form.from.trim(), to: form.to.trim(), ...(args?.ok ? { args: args.args } : {}) });
        }}
      >
        <TextField label="When" value={form.from} onChange={(v) => setForm({ ...form, from: v })} mono placeholder={`${alias}.boot.down`} />
        <TextField label="Run" value={form.to} onChange={(v) => setForm({ ...form, to: v })} mono placeholder="hall-pad.status.blink" />
        <TextField label="With" value={form.args} onChange={(v) => setForm({ ...form, args: v })} mono placeholder='{"count":1}' error={args && !args.ok ? args.error : null} note="optional args, JSON" />
        <ButtonRow>
          <Button type="submit" busy={set.isPending} disabled={!form.from.trim() || !form.to.trim()}>
            Bind
          </Button>
        </ButtonRow>
      </form>
    </Section>
  );
}

function otaBead(state: string): BeadState {
  return state === 'SUCCEEDED' ? 'online' : ['FAILED', 'ROLLED_BACK', 'TIMED_OUT'].includes(state) ? 'fault' : 'waiting';
}

function OtaLine({ r }: { r: OtaRow }) {
  return (
    <Row
      bead={otaBead(r.state)}
      beadLabel={r.state.toLowerCase().replace(/_/g, ' ')}
      name={<span className="mono">{shortId(r.fw_id)}</span>}
      value={
        <span className="dev-ota">
          <Caps tone="bone">{r.state.toLowerCase().replace(/_/g, ' ')}</Caps>
          <Meter fraction={fractionOf(r.bytes, 0, r.size || 1)} label="bytes sent" width={72} />
          <FTime at={r.updated_at} form="relative" />
        </span>
      }
      extra={[r.via, r.message ?? r.reason ?? r.code].filter(Boolean).join(' · ') || undefined}
    />
  );
}

function OtaHistory({ deviceId }: { deviceId: string }) {
  const q = useOp('ota_status', { selector: `id:${deviceId}` });
  // a device that never had an update is one row with job and state null
  const rows = (q.data?.devices ?? []).filter((r) => r.job && typeof r.state === 'string');
  return (
    <Section title="Updates over the air">
      {q.error ? <ErrorLine error={q.error} what="Update history" /> : null}
      {rows.length ? rows.map((r) => <OtaLine key={r.job} r={r} />) : q.data ? <p className="dev-quiet ash">No update has been sent to it.</p> : null}
    </Section>
  );
}

export function Engineering({ detail }: { detail: DeviceDetail }) {
  const reachable = !!detail.port || detail.presence === 'online' || detail.presence === 'suspect';
  return (
    <section className="dev-engineering" aria-label="Engineering">
      <Disclosure title="Engineering" aside={<Caps>diagnostics · bindings · updates · raw</Caps>}>
        <div className="dev-engineering-body">
          <Diagnostics deviceId={detail.device_id} reachable={reachable} />
          <Bindings deviceId={detail.device_id} alias={detail.alias} />
          <OtaHistory deviceId={detail.device_id} />
          <Section title="Raw">
            <RawJson value={detail} id="device_get" />
          </Section>
        </div>
      </Disclosure>
    </section>
  );
}
