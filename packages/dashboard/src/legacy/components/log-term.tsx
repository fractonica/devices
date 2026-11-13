// Logs in xterm.js (spec 08 §8.1 "logs bypass React state", design c6 §5). A device's: its tail from
// logs_read, then the `/ws` log frames after that cursor, written straight into the terminal. A job's:
// job_logs, paged by line while the job runs. Device output is untrusted: only colour sequences pass.

import { useEffect, useRef } from 'react';

import type { LogLine } from '@fractonica/protocol/client';

import { OpError } from '../../api/rest.ts';
import { TERMINAL_JOB_STATUSES } from '../../api/types.ts';
import { live, rest } from '../../runtime.ts';
import { openTerminal, termLevel } from '../../ui/term.tsx';

type Term = Awaited<ReturnType<typeof openTerminal>>;

function writeLine(t: Term, l: LogLine): void {
  t.line(l.text, l.level ? termLevel(l.level) : l.kind === 'frame' || l.kind === 'diag' ? 'debug' : 'info');
}

let subSeq = 0;

/** A device's log: the newest 200 lines, then live. `device`: keep only its lines (a device id). */
export function LogTerm({ selector, device }: { selector: string; device?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = `logs:${selector}:${++subSeq}`;
    let t: Term | null = null;
    let ready = false;
    let cancelled = false;
    const early: LogLine[] = [];
    // Frames carry no sub id: the device page has one log sub, but frames of the sub it replaced may still
    // be on their way.
    const off = live.listen({
      logs: (all) => {
        const lines = device ? all.filter((l) => l.device === device) : all;
        const cur = ready ? t : null;
        if (cur) {
          lines.forEach((l) => writeLine(cur, l));
        } else {
          early.push(...lines);
        }
      },
    });
    void (async () => {
      const term = await openTerminal(host.current!);
      if (cancelled) {
        term.dispose();
        return;
      }
      t = term;
      try {
        const page = await rest.op('logs_read', { selector, max_lines: 200 });
        if (cancelled) {
          return;
        }
        page.lines.forEach((l) => writeLine(term, l));
        live.subscribe(id, { logs: { selector, since: page.next_cursor } });
      } catch (err) {
        if (cancelled) {
          return;
        }
        term.line(err instanceof OpError ? `${err.code}: ${err.message}` : String(err), 'error');
        live.subscribe(id, { logs: { selector } });
      }
      ready = true;
      early.splice(0).forEach((l) => writeLine(term, l));
    })();
    return () => {
      cancelled = true;
      off();
      live.unsubscribe(id);
      t?.dispose();
    };
  }, [selector, device]);
  return <div ref={host} className="ui-term" data-logs={selector} />;
}

/** A job's output, followed while it runs. */
export function JobLogTerm({ jobId }: { jobId: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let t: Term | null = null;
    let after = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!t) {
        const opened = await openTerminal(host.current!);
        if (stopped) {
          opened.dispose();
          return;
        }
        t = opened;
      }
      const term = t;
      try {
        for (;;) {
          const page = await rest.op('job_logs', { job_id: jobId, after_line: after, max_lines: 500 });
          if (stopped) {
            return;
          }
          for (const l of page.lines) {
            // JobCtx streams: out, err, and the runner's own `event` lines (stages).
            term.line(l.text, termLevel(null, l.stream));
          }
          after = page.next_line;
          if (!page.truncated) {
            break;
          }
        }
        const job = await rest.op('job_get', { job_id: jobId });
        if (!stopped && !TERMINAL_JOB_STATUSES.has(job.status)) {
          timer = setTimeout(() => void poll(), 1000);
        }
      } catch (err) {
        if (!stopped) {
          term.line(err instanceof OpError ? `${err.code}: ${err.message}` : String(err), 'error');
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      t?.dispose();
    };
  }, [jobId]);
  return <div ref={host} className="ui-term" data-job-logs={jobId} />;
}
