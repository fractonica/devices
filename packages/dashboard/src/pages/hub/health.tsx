// One line of hub health: the hub_doctor checks as beads (ok lumen, warning hollow bone, error fault), the line's
// word ("all well", "1 error · 1 warning"), and under it each check that needs something done with its fix (the
// fixes the hub can run itself behind one button); every line leads to Settings › Health. The hub's last result shows
// at once (hub_doctor max_age_s, pages/shared/doctor.ts) with when it was checked. Then, quietly, the latest thresholds the hub passed.

import { useLive, useOp } from '../../hooks.ts';
import { useDoctor } from '../shared/doctor.ts';
import { checkFix, checkName, healthLine } from '../../state/checks.ts';
import { latestThresholds } from '../../state/hub-home.ts';
import { Bead, Button, ButtonRow, Caps, Code, engrave, ErrorLine, FTime, Pending, Reading, Row, Section, useHubText } from '../../ui/index.ts';

/** Issues shown here; the rest are a link away (the page stays a summary). */
const MAX_ISSUES = 3;

const HEALTH = { to: '/settings/$section', params: { section: 'health' } } as const;

export function Health() {
  const d = useDoctor();
  const doctor = d.q;
  // pure mode says a detail's durations as spans and leaves out other Earth measures (state/pure-text.ts)
  const say = useHubText();
  const shown = (text: string | undefined) => (text ? say(text) || undefined : undefined);
  if (doctor.isPending) {
    return (
      <Section title="Hub health">
        <Pending word="running" what="the checks" />
      </Section>
    );
  }
  if (doctor.isError) {
    return (
      <Section title="Hub health">
        <ErrorLine error={doctor.error} what="Health checks" fix={{ label: 'Check again', onClick: d.checkAgain, busy: d.checking }} />
      </Section>
    );
  }
  const h = healthLine(doctor.data.checks);
  return (
    <Section title="Hub health" aside={<Caps tone={h.bead === 'online' ? 'lumen' : 'ash'}>{h.word}</Caps>}>
      <Row
        id="health"
        label="Checks"
        {...HEALTH}
        value={
          <span className="hub-checks" role="img" aria-label={`Hub health: ${h.word}. ${h.checks.map((c) => c.label).join(', ')}`}>
            {h.checks.map((c) => (
              <Bead key={c.id} state={c.bead} size={7} label={c.label} />
            ))}
          </span>
        }
        extra={
          doctor.data.checked_at ? (
            <>
              checked <FTime at={doctor.data.checked_at} form="relative" parts={1} />
            </>
          ) : undefined
        }
      />
      {h.issues.slice(0, MAX_ISSUES).map((c) => {
        const fix = checkFix(c);
        return (
          <Row
            key={c.id}
            id={`check-${c.id}`}
            bead={c.level === 'error' ? 'fault' : 'waiting'}
            beadLabel={c.level === 'error' ? 'error' : 'warning'}
            label={checkName(c.id)}
            {...HEALTH}
            value={shown(c.detail) ? <span className="hub-check-detail">{shown(c.detail)}</span> : <span className="caps ash">{engrave(c.level === 'error' ? 'error' : 'warning')}</span>}
            extra={
              fix?.kind === 'hub' ? (
                <span className="hub-fix">the hub can fix this</span>
              ) : fix?.kind === 'command' ? (
                <span className="hub-fix">
                  <Code>{fix.command}</Code>
                </span>
              ) : shown(c.fix) ? (
                <span className="hub-fix">{shown(c.fix)}</span>
              ) : undefined
            }
          />
        );
      })}
      {h.issues.length > MAX_ISSUES ? <Row label={`${h.issues.length - MAX_ISSUES} more in Settings › Health`} {...HEALTH} /> : null}
      {d.fixable.length ? (
        <ButtonRow>
          <Button busy={d.fixing} onClick={d.runFixes} data-action="run-fixes">
            {d.fixable.length === 1 ? 'Run the fix' : `Run ${d.fixable.length} fixes`}
          </Button>
        </ButtonRow>
      ) : null}
    </Section>
  );
}

/** The latest time.threshold events, stored and live, on one quiet line. Nothing when the hub has passed none yet. */
export function Thresholds() {
  const stored = useOp('events_read', { types: 'time.threshold', max_events: 3 });
  const live = useLive((s) => s.events);
  const lines = latestThresholds(stored.data?.events ?? [], live);
  if (!lines.length) {
    return null;
  }
  return (
    <div className="hub-thresholds" data-row="thresholds">
      <span className="caps ash">{engrave('thresholds')}</span>
      <span className="hub-threshold-list">
        {lines.map((l) => (
          <span key={l.key} className="hub-threshold">
            <Reading className="hub-threshold-words" text={l.words} /> <FTime at={l.at} form="relative" parts={1} />
          </span>
        ))}
      </span>
    </div>
  );
}
