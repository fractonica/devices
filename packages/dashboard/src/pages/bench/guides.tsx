// Bench › Guides: every wiring guide (wiring_list) as a row with its steps as light, its title and summary, how far it
// is, and whether its pin table agrees with its firmware profile; the files the hub refused, with why.

import { useOp } from '../../hooks.ts';
import { stepsText } from '../../state/bench-view.ts';
import type { WiringLoadError } from '@fractonica/protocol/client';
import { Bead, Caps, Code, EmptyState, ErrorLine, Pending, Row, Section } from '../../ui/index.ts';
import { BenchLink } from './link.tsx';
import { Said } from './said.tsx';
import { StepRing } from './step-ring.tsx';

export function Refused({ refused }: { refused: readonly WiringLoadError[] }) {
  if (!refused.length) {
    return null;
  }
  return (
    <Section title="Files the hub refused" aside={<Bead state="fault" label="refused" />}>
      {refused.map((r) => (
        <Row key={r.file} bead="fault" name={<Code>{r.file}</Code>} extra={r.errors.join(' · ')} />
      ))}
    </Section>
  );
}

export function GuidesView() {
  const q = useOp('wiring_list', {});
  const guides = q.data?.guides ?? [];
  return (
    <>
      <Section title="Wiring guides" aside={<Caps>{q.data ? `${guides.length}` : ''}</Caps>}>
        {q.error ? <ErrorLine error={q.error} what="Guides" fix={{ label: 'Try again', onClick: () => void q.refetch() }} /> : null}
        {!q.data && !q.error ? <Pending what="the guides" /> : null}
        {q.data && !guides.length ? (
          <EmptyState title="No wiring guides yet">
            A guide lives in <Code>hardware/wiring/&lt;id&gt;/guide.yaml</Code> with its drawings beside it; the wiring skill writes one with every hardware change.
          </EmptyState>
        ) : null}
        {guides.map((g) => {
          const steps = Array.from({ length: g.steps }, (_, i) => i < g.done);
          return (
            <BenchLink key={g.id} to={{ view: 'guide', id: g.id }} className="bench-guide-row">
              <span className="bench-guide-ring">
                <StepRing steps={steps} size={30} failed={g.check === 'failed'} label={g.title} />
              </span>
              <span className="bench-guide-text">
                <span className="bench-guide-title">{g.title}</span>
                <span className="bench-guide-summary">
                  <Said text={g.summary} />
                </span>
              </span>
              <span className="bench-guide-facts">
                <span>{stepsText(g.done, g.steps)}</span>
                <span className="bench-guide-check">
                  <Bead state={g.check === 'failed' ? 'fault' : g.check === 'ok' ? (g.warnings.length ? 'waiting' : 'online') : 'idle'} size={6} />
                  {g.check === 'failed' ? 'pin table disagrees' : g.check === 'ok' ? (g.warnings.length ? `checked, ${g.warnings.length} to look at` : 'checked against its profile') : 'no profile to check'}
                </span>
                {g.device ? <span className="ash">for {g.device}</span> : null}
              </span>
            </BenchLink>
          );
        })}
      </Section>
      <Refused refused={q.data?.refused ?? []} />
    </>
  );
}
