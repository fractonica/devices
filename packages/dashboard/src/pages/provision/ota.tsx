// Over the air (`/provision?view=ota`, HARDWARE-REVIEW §4 "Screens" 5): preview, then deploy. The person names the
// devices (every device, a profile, a tag, one device), the firmware (each device's own profile's newest build, or
// one profile's) and the way (auto, Wi-Fi, USB); Preview runs ota_deploy as a dry run and lists what would happen to
// each device; Deploy sends exactly what was previewed, and opens the job's page with a ring per device. Under it,
// the recent updates per device as rows, each led by its small ring.

import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';

import { useAct, useOp } from '../../hooks.ts';
import type { OtaRow } from '../../api/types.ts';
import { deployTargets, otaDial, otaEnded, planDevices, planLine, planNote, planUpdates, stageWord } from '../../state/provision.ts';
import { Bead, Button, ButtonRow, EmptyState, ErrorLine, FTime, Row, Section, Select, useHubText } from '../../ui/index.ts';
import { Dial } from './dial.tsx';

const VIA = [
  { value: 'auto', label: 'Auto: USB when attached, else Wi-Fi' },
  { value: 'wifi', label: 'Wi-Fi' },
  { value: 'serial', label: 'USB' },
];

/** One device's update: its small ring, its state in words, when it last changed. */
export function OtaLine({ row }: { row: OtaRow }) {
  const say = useHubText();
  const v = otaDial(row);
  const said = row.message ?? row.reason ?? (row.code ? row.code.replace(/_/g, ' ') : '');
  const note = said ? say(said) : '';
  const word = v.word ?? stageWord(row.state);
  return (
    <Row
      id={row.alias}
      lead={<Dial view={v} bare size={22} label={`${row.alias} update`} />}
      name={row.alias}
      sub={
        <>
          <span className="mono">{row.build_id}</span> · {row.via === 'serial' ? 'USB' : 'Wi-Fi'}
          {row.attempt > 1 ? ` · attempt ${row.attempt}` : ''}
        </>
      }
      value={<span className={v.failed ? 'prov-fault' : otaEnded(row.state) ? '' : 'prov-lit'}>{word}</span>}
      extra={
        <>
          {note}
          {note ? ' · ' : ''}
          <FTime at={row.updated_at} form="relative" />
        </>
      }
    />
  );
}

function Deploy() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const devices = useOp('device_list', {});
  const profiles = useOp('profile_list', {});
  const targets = deployTargets(devices.data?.devices ?? []);
  const initialProfile = typeof search.profile === 'string' ? search.profile : '';
  const [f, setF] = useState({ selector: initialProfile ? `profile:${initialProfile}` : '', profile: '', via: 'auto' });
  const selector = f.selector || targets[0]?.value || '';
  const input = { selector, ...(f.profile ? { profile: f.profile } : {}), via: f.via as 'auto' | 'serial' | 'wifi' };
  const key = JSON.stringify(input);
  const [preview, setPreview] = useState<{ key: string; plan: unknown } | null>(null);
  const dry = useAct('ota_deploy');
  const go = useAct('ota_deploy', { done: () => 'Update started', refresh: ['job_list', 'ota_status'] });
  const plan = preview ? planDevices(preview.plan) : [];
  const current = preview?.key === key;
  const n = planUpdates(plan);
  const built = (profiles.data?.profiles ?? []).filter((p) => p.newest_debug);
  const say = useHubText();
  const pure = (t: string | undefined) => (t === undefined ? undefined : say(t));
  return (
    <Section title="Update" body="loose">
      <p className="prov-lede">Choose the devices and the firmware, preview what each device would do, then deploy. Nothing is sent before you deploy.</p>
      {devices.data && !targets.length ? (
        <EmptyState title="No devices yet">Provision a board first; then it updates over the air from here.</EmptyState>
      ) : (
        <>
          <div className="prov-form-grid">
            <Select label="Devices" value={selector} onChange={(v) => setF({ ...f, selector: v })} options={targets.map((t) => ({ value: t.value, label: t.label }))} disabled={!targets.length} />
            <Select
              label="Firmware"
              value={f.profile}
              onChange={(v) => setF({ ...f, profile: v })}
              options={[{ value: '', label: "Each device's own profile, newest build" }, ...built.map((p) => ({ value: p.profile, label: `Newest build of ${p.profile}` }))]}
            />
            <Select label="Way" value={f.via} onChange={(v) => setF({ ...f, via: v })} options={VIA} />
          </div>
          <ButtonRow>
            <Button disabled={!selector} busy={dry.isPending} onClick={() => dry.mutate({ ...input, dry_run: true }, { onSuccess: (r) => setPreview({ key, plan: r }) })} data-action="preview">
              Preview
            </Button>
            <Button
              variant="primary"
              disabled={!current || n === 0}
              busy={go.isPending}
              onClick={() =>
                go.mutate(
                  { ...input, dry_run: false },
                  {
                    onSuccess: (r) => {
                      setPreview(null);
                      const id = (r as { job_id?: string }).job_id;
                      if (id) {
                        void navigate({ to: '/provision/$job', params: { job: id } });
                      }
                    },
                  },
                )
              }
              data-action="deploy"
            >
              {current && n ? `Deploy to ${n} ${n === 1 ? 'device' : 'devices'}` : 'Deploy'}
            </Button>
          </ButtonRow>
          <ErrorLine error={dry.error} what="Preview" />
          <ErrorLine error={go.error} what="Deploy" />
        </>
      )}
      {preview ? (
        <div className="prov-plan" data-current={current ? '' : undefined}>
          <p className="prov-note">{current ? 'The plan; nothing is sent yet.' : 'The plan for the previous choices. Preview again to deploy these.'}</p>
          {plan.map((d) => {
            const l = planLine(d);
            return (
              <Row
                key={d.device_id}
                id={d.alias}
                bead={l.bead}
                beadLabel={l.text}
                name={d.alias}
                value={l.text}
                extra={
                  d.action === 'skip' ? (
                    pure(d.message && planNote(d.message))
                  ) : (
                    <>
                      <span className="mono">{d.build_id}</span>
                      {d.warnings?.length ? ` · ${d.warnings.map((w) => pure(planNote(w))).join(' · ')}` : ''}
                    </>
                  )
                }
              />
            );
          })}
        </div>
      ) : null}
    </Section>
  );
}

function Recent() {
  const q = useOp('ota_status', {});
  const rows = q.data?.devices ?? [];
  return (
    <Section title="Recent updates" aside={q.data?.active ? <Bead state="waiting" label={`${q.data.active} running`} showLabel /> : undefined}>
      <ErrorLine error={q.error} what="Updates" fix={{ label: 'Try again', onClick: () => void q.refetch() }} />
      {q.data && !rows.length ? <EmptyState title="No updates yet">Each device's update shows here with its ring: offered, downloading, staged, rebooting, verifying.</EmptyState> : null}
      {rows.map((r) => (
        <OtaLine key={r.job} row={r} />
      ))}
    </Section>
  );
}

export function OverTheAir() {
  return (
    <div className="prov-views">
      <Deploy />
      <Recent />
    </div>
  );
}
