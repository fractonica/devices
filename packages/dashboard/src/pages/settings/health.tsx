// Settings › Health: the hub's checks (hub_doctor, run in the hub: toolchain, ESP-IDF, the sidecar, firewall, LAN,
// serial ports, Local Network, the advert, the event loop), each a bead with its fix; the hub's warnings
// (hub_status); and the hub itself (version, started, jobs, the sleep guard). The hub runs no fix itself: a command fix
// is copied to run in Terminal, a port fix opens Ports, a System Settings fix is said as steps. In pure mode the
// hub's texts are said with useHubText (state/pure-text.ts): durations as spans, other Earth measures left out.

import { Link } from '@tanstack/react-router';

import { useOp } from '../../hooks.ts';
import { checkBead, checkFix, checkName, healthLine, sortChecks } from '../../state/checks.ts';
import { Bead, Button, Caps, Code, CopyButton, ErrorLine, FTime, Line, Pending, Row, Section, useHubText, useMode, useSpanOf } from '../../ui/index.ts';

function Checks() {
  const q = useOp('hub_doctor', {});
  const say = useHubText();
  const checks = q.data ? sortChecks(q.data.checks) : [];
  const line = q.data ? healthLine(checks) : null;
  const aside = (
    <>
      {line ? <Bead state={line.bead} label={line.word} /> : null}
      <Caps tone={line?.bead === 'online' ? 'lumen' : 'ash'}>{line ? line.word : q.isFetching ? 'checking' : ''}</Caps>
      <Button variant="quiet" busy={q.isFetching} onClick={() => void q.refetch()} data-action="recheck">
        Check again
      </Button>
    </>
  );
  return (
    <Section title="Checks" aside={aside} id="checks">
      {q.error ? <ErrorLine error={q.error} what="Checks" fix={{ label: 'Try again', onClick: () => void q.refetch() }} /> : null}
      {!q.data && !q.error ? <Pending word="running" what="the checks" /> : null}
      {checks.map((c) => {
        const fix = c.level === 'ok' ? null : checkFix(c);
        return (
          <Line
            key={c.id}
            id={`check-${c.id}`}
            bead={checkBead(c.level)}
            beadLabel={c.level === 'ok' ? 'passes' : c.level === 'warn' ? 'warning' : 'error'}
            label={checkName(c.id)}
            value={c.level === 'ok' ? <span className="set-detail-ok">{say(c.detail)}</span> : undefined}
            detail={c.level === 'ok' ? undefined : say(c.detail)}
            actions={
              fix ? (
                <>
                  <span className="set-fix">
                    <Caps>fix</Caps> {fix.kind === 'command' ? <Code>{fix.command}</Code> : say(fix.text)}
                  </span>
                  {fix.kind === 'command' ? <CopyButton text={fix.command} label="Copy command" what={checkName(c.id)} /> : null}
                  {fix.kind === 'page' ? (
                    <Link to={fix.to as never} params={fix.params as never} className="ui-button" data-variant="default">
                      <span className="ui-button-text">{fix.label.toUpperCase()}</span>
                    </Link>
                  ) : null}
                </>
              ) : undefined
            }
          />
        );
      })}
      {checks.some((c) => checkFix(c)?.kind === 'command' && c.level !== 'ok') ? (
        <p className="set-note">The hub runs no fix by itself: copy a command and run it in Terminal on this Mac, then check again.</p>
      ) : null}
    </Section>
  );
}

function Warnings() {
  const status = useOp('hub_status', {}, { refetchInterval: 5000 });
  const say = useHubText();
  const warnings = status.data?.warnings ?? [];
  if (!warnings.length) {
    return null;
  }
  return (
    <Section title="Warnings" aside={<Caps>{warnings.length === 1 ? 'one' : `${warnings.length}`}</Caps>} id="warnings">
      {warnings.map((w) => {
        const cmd = /`([^`]+)`/.exec(w)?.[1];
        return (
          <Line key={w} bead="waiting" beadLabel="warning" name={<span className="set-warning">{say(w)}</span>} actions={cmd ? <CopyButton text={cmd} label="Copy command" /> : undefined} />
        );
      })}
    </Section>
  );
}

function Hub() {
  const status = useOp('hub_status', {}, { refetchInterval: 5000 });
  const s = status.data;
  if (status.error) {
    return <ErrorLine error={status.error} what="Hub status" />;
  }
  const started = s ? Date.now() * 1000 - s.uptime_s * 1_000_000 : null;
  const jobs = s ? Object.entries(s.jobs).filter(([, n]) => n > 0) : [];
  return (
    <Section title="The hub" id="hub">
      <Row label="Version" value={s ? `${s.version} · run ${s.run}` : '—'} />
      <Row label="Started" value={started ? <FTime at={started} form="relative" /> : '—'} />
      <Row label="Devices" value={s ? `${s.devices.online} of ${s.devices.registered} online` : '—'} />
      <Row label="Jobs" value={s ? (jobs.length ? jobs.map(([k, n]) => `${n} ${k}`).join(' · ') : 'none running') : '—'} />
      <Row label="Dashboard" value={s?.dashboard ? (s.dashboard.stale ? 'older than its sources' : s.dashboard.built ? 'built from the current sources' : 'not built') : '—'} extra={s?.dashboard?.stale ? <>rebuild it with <Code>fr doctor --fix</Code></> : undefined} />
      {s?.sleep_guard ? (
        <Row label="Sleep" value={s.sleep_guard.active ? 'kept awake while the hub works' : 'free to sleep'} extra={s.sleep_guard.active ? 'closing the lid still sleeps this Mac, and the hub with it' : undefined} />
      ) : null}
    </Section>
  );
}

export function HealthSection() {
  return (
    <>
      <Checks />
      <Warnings />
      <Hub />
    </>
  );
}
