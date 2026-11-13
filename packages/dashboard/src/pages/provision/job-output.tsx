// A job's output (job_logs, paged by line) in the themed terminal, folded under the ring: the hub's stage lines in
// lumen, errors in fault. It reads every page there is, then again each second while the job runs.

import { OpError } from '../../api/rest.ts';
import { TERMINAL_JOB_STATUSES } from '../../api/types.ts';
import { rest } from '../../runtime.ts';
import { Disclosure, Term, termLevel } from '../../ui/index.ts';

export function JobOutput({ jobId, defaultOpen = false, title = 'Output' }: { jobId: string; defaultOpen?: boolean; title?: string }) {
  return (
    <Disclosure title={title} defaultOpen={defaultOpen}>
      <Term
        key={jobId}
        height="300px"
        label={`Output of job ${jobId}`}
        onOpen={(t) => {
          let after = 0;
          let stopped = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const poll = async () => {
            try {
              for (;;) {
                const page = await rest.op('job_logs', { job_id: jobId, after_line: after, max_lines: 500 });
                if (stopped) {
                  return;
                }
                for (const l of page.lines) {
                  t.line(l.text, termLevel(null, l.stream));
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
                t.line(err instanceof OpError ? `${err.code}: ${err.message}` : String(err), 'error');
              }
            }
          };
          void poll();
          return () => {
            stopped = true;
            clearTimeout(timer);
          };
        }}
      />
    </Disclosure>
  );
}
