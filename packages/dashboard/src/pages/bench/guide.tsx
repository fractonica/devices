// Bench › a guide (wiring_show): what it is for and the board it wires, its steps as light, the next step, safety
// first, the check against the firmware profile, the parts with what is on hand, each section with its drawing beside
// its steps (a step is ticked at once: wiring_step / wiring_undo; the hub keeps the ticks), the pins as chips with the
// device's live values when it is online (the live store's property mirror, no polling), and the full pin table.
// "Start over" clears every tick, after asking in place.

import { useMemo } from 'react';

import type { WiringShow } from '@fractonica/protocol/client';

import { useAct, useLive, useOp } from '../../hooks.ts';
import { instanceLive, liveText, missingText, nextStep, pinInstances, stepsText } from '../../state/bench-view.ts';
import { Bead, type BeadState, Button, ButtonRow, Caps, Code, EmptyState, engrave, ErrorLine, Line, Pending, presenceBead, Row, Section, useFractonica, useHubText, useMode } from '../../ui/index.ts';
import { Diagram } from './diagram.tsx';
import { BenchLink } from './link.tsx';
import { Said } from './said.tsx';
import { StepRing } from './step-ring.tsx';

const REFRESH = ['wiring_show', 'wiring_list', 'wiring_shopping'] as const;
const CONN_BEAD: Record<string, BeadState> = { ok: 'online', warning: 'waiting', failed: 'fault', unchecked: 'idle' };

/** The page's text in the mode's units (said.tsx: a guide's prose may say "for 2 s" or "3.3 V"). */
function useSay(): (t: string) => string {
  return useHubText();
}

function Step({ g, step, pinInst, live, online }: { g: WiringShow; step: WiringShow['sections'][number]['steps'][number]; pinInst: Map<string, string>; live: (inst: string) => string[]; online: boolean }) {
  const say = useSay();
  const tick = useAct('wiring_step', { refresh: REFRESH });
  const untick = useAct('wiring_undo', { refresh: REFRESH });
  const busy = tick.isPending || untick.isPending;
  const diagrams = new Map(g.diagrams.map((d) => [d.id, d]));
  const d = step.diagram ? diagrams.get(step.diagram) : undefined;
  return (
    <li className="bench-step" id={`step-${step.id}`} data-done={step.done ? '' : undefined}>
      <button
        type="button"
        role="checkbox"
        aria-checked={step.done}
        className="bench-tick"
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={() => (step.done ? untick : tick).mutate({ guide: g.id, steps: [step.id] })}
      >
        <svg width="16" height="16" viewBox="-8 -8 16 16" aria-hidden="true">
          <circle r="6.5" className="ring" />
          <circle r="3.4" className="dot" />
        </svg>
        <span className="bench-step-text"><Said text={step.text} hint /></span>
      </button>
      {step.pins.length ? (
        <span className="bench-pins">
          {step.pins.map((p) => {
            const inst = pinInst.get(p);
            const values = inst ? live(inst) : [];
            return (
              <span key={p} className="bench-pin" data-live={online && values.length ? '' : undefined} title={inst ? `${inst}${values.length ? `: ${values.join(', ')}` : ''}` : undefined}>
                <span className="mono">{p}</span>
                {online && values.length ? <span className="bench-pin-live">{values.join(' · ')}</span> : null}
              </span>
            );
          })}
        </span>
      ) : null}
      {step.note ? <p className="bench-step-note"><Said text={step.note} hint /></p> : null}
      {step.check ? (
        <p className="bench-step-check">
          <Caps>check</Caps> <Said text={step.check} hint />
        </p>
      ) : null}
      {d ? <Diagram title={d.title} url={d.url} /> : null}
    </li>
  );
}

export function GuideView({ id }: { id: string }) {
  const q = useOp('wiring_show', { guide: id });
  const devices = useOp('device_list', { selector: 'all' });
  const reset = useAct('wiring_reset', { done: () => 'every step cleared', refresh: REFRESH });
  const say = useSay();
  const g = q.data;
  const device = g?.device ? devices.data?.devices.find((d) => d.alias === g.device || d.device_id === g.device) : undefined;
  const props = useLive((s) => (device ? s.properties[device.device_id] : undefined));
  const pinInst = useMemo(() => pinInstances(g?.connections ?? []), [g]);
  const online = device?.presence === 'online';
  const core = useFractonica();
  const { earth } = useMode();
  const live = (inst: string) => instanceLive(props as Record<string, unknown> | undefined, inst, 3, (m, v) => liveText(core, m, v, earth));

  if (q.error) {
    return (
      <>
        <BenchLink to={{ view: 'guides' }} className="bench-back caps">
          {engrave('← all guides')}
        </BenchLink>
        <ErrorLine error={q.error} what={`Guide ${id}`} fix={{ label: 'Try again', onClick: () => void q.refetch() }} />
      </>
    );
  }
  if (!g) {
    return <Pending what="the guide" />;
  }
  const next = nextStep(g);
  const steps = g.sections.flatMap((s) => s.steps.map((st) => st.done));
  const short = missingText(g.bom);
  const diagrams = new Map(g.diagrams.map((d) => [d.id, d]));
  return (
    <>
      <BenchLink to={{ view: 'guides' }} className="bench-back caps">
        {engrave('← all guides')}
      </BenchLink>
      <header className="bench-guide-head">
        <StepRing steps={steps} size={132} showCount failed={g.check === 'failed'} label={g.title} />
        <div className="bench-guide-intro">
          <h2 className="bench-guide-name">{g.title}</h2>
          <p className="bench-guide-about"><Said text={g.summary} /></p>
          <p className="bench-guide-progress">
            {stepsText(g.done, g.steps)}
            {next ? (
              <>
                {' · '}
                <a
                  href={`#step-${next.step}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(`step-${next.step}`)?.scrollIntoView({ block: 'center' });
                    (document.querySelector(`#step-${next.step} .bench-tick`) as HTMLElement | null)?.focus({ preventScroll: true });
                  }}
                >
                  go to the next step
                </a>
              </>
            ) : null}
          </p>
        </div>
      </header>

      <Section title="The board">
        {g.board ? <Row label="Board" value={g.board} /> : null}
        {g.profile ? <Row label="Firmware profile" value={<Code>{g.profile}</Code>} /> : null}
        {g.device ? (
          <Row
            bead={device ? presenceBead(device.presence) : 'idle'}
            beadLabel={device?.presence ?? 'not registered'}
            label="Device"
            value={device ? g.device : `${g.device} (not registered yet)`}
            extra={online ? 'its live values show beside the pins' : device ? 'offline: the pins show no live values' : undefined}
          />
        ) : null}
        {g.design ? <Row label="Design" value={<Code>{g.design}</Code>} /> : null}
      </Section>

      {g.check === 'failed' || g.warnings.length ? (
        <Section title={g.check === 'failed' ? 'The guide disagrees with its profile' : 'Look at these first'} aside={<Bead state={g.check === 'failed' ? 'fault' : 'waiting'} />}>
          {g.check === 'failed' ? <p className="bench-say">Fix the guide or the profile before wiring.</p> : null}
          {g.errors.map((e) => (
            <Line key={e} bead="fault" beadLabel="error" name={<span className="bench-line-text"><Said text={e} /></span>} />
          ))}
          {g.warnings.map((w) => (
            <Line key={w} bead="waiting" beadLabel="warning" name={<span className="bench-line-text"><Said text={w} /></span>} />
          ))}
        </Section>
      ) : null}

      {g.safety.length ? (
        <Section title="Safety first">
          {g.safety.map((s) => (
            <Line key={s} bead="waiting" beadLabel="safety" name={<span className="bench-line-text"><Said text={s} /></span>} />
          ))}
        </Section>
      ) : null}

      {g.bom.length ? (
        <Section title="Parts" aside={<Caps>{short.length ? `${short.length} short` : 'all on hand, as recorded'}</Caps>}>
          {g.bom.map((b) => (
            <BenchLink key={`${b.part}:${b.value ?? ''}`} to={{ view: 'part', id: b.part }} className="bench-rowlink">
              <Line
                bead={b.missing > 0 ? 'waiting' : 'online'}
                beadLabel={b.missing > 0 ? `${b.missing} short` : 'on hand'}
                name={`${b.name}${b.value ? ` ${b.value}` : ''}`}
                value={b.missing > 0 ? `${b.missing} short` : `${b.qty} needed`}
                detail={[`needs ${b.qty}`, `${b.have} on hand`, b.note ? say(b.note) : null].filter(Boolean).join(' · ')}
              />
            </BenchLink>
          ))}
        </Section>
      ) : null}

      {g.sections.map((s) => {
        const done = s.steps.filter((x) => x.done).length;
        const d = s.diagram ? diagrams.get(s.diagram) : undefined;
        return (
          <Section key={s.id} id={`sec-${s.id}`} title={s.title} aside={<Caps>{done === s.steps.length ? 'done' : `${done} of ${s.steps.length}`}</Caps>}>
            <div className={`bench-section${d ? ' bench-section-drawn' : ''}`}>
              {d ? <Diagram title={d.title} url={d.url} /> : null}
              <div className="bench-section-steps">
                {s.intro ? <p className="bench-say"><Said text={s.intro} /></p> : null}
                <ol className="bench-steps">
                  {s.steps.map((st) => (
                    <Step key={st.id} g={g} step={st} pinInst={pinInst} live={live} online={online} />
                  ))}
                </ol>
              </div>
            </div>
          </Section>
        );
      })}

      {g.connections.length ? (
        <Section title="Pin table" aside={<Caps>{g.profile ? `checked against ${g.profile}` : 'no profile to check against'}</Caps>}>
          {g.connections.map((c) => (
            <Line
              key={`${c.pin}:${c.to}`}
              bead={CONN_BEAD[c.check] ?? 'idle'}
              beadLabel={c.check}
              name={<Code>{c.pin}</Code>}
              value={
                <>
                  {c.to}
                  {c.via ? <span className="ash"> via {c.via}</span> : null}
                </>
              }
              detail={[c.instance ? `${c.instance}${c.bind ? `.${c.bind}` : ''}` : null, c.message ? say(c.message) : null].filter(Boolean).join(' · ') || undefined}
            />
          ))}
        </Section>
      ) : null}

      {!g.sections.length && !g.connections.length ? <EmptyState title="Nothing to wire">This guide has no steps yet.</EmptyState> : null}

      <ButtonRow>
        <Button variant="destructive" confirm={`Clear every step of ${g.title}?`} confirmLabel="Clear" busy={reset.isPending} onClick={() => reset.mutate({ guide: g.id })} data-action="start-over" disabled={g.done === 0}>
          Start over
        </Button>
      </ButtonRow>
    </>
  );
}
