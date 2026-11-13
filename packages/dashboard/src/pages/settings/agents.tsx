// Settings › Agents: what agents are doing on the bench (design c6 D3, D4, D18). The prompt_human requests waiting for
// a person (the live store's prompts, reconciled with hub_status by the shell), the serial leases with their holder and
// end (port_list) and Take back, and the jobs agents started through `fr mcp` (job_list origin mcp). Times are the
// core's spans ("ends in 6ι 43λ"), ⊕ the civil ones in Earth mode.

import { useLive, useNow, useOp } from '../../hooks.ts';
import { pendingPrompts } from '../../state/live.ts';
import type { BeadState } from '../../ui/index.ts';
import { Button, Caps, Code, EmptyState, ErrorLine, FTime, Line, Section } from '../../ui/index.ts';
import { useAct } from '../../hooks.ts';

const JOB_BEAD: Record<string, BeadState> = { queued: 'waiting', working: 'waiting', completed: 'online', failed: 'fault', cancelled: 'offline' };

function TakeBack({ leaseId, path }: { leaseId: string; path: string }) {
  const act = useAct('serial_release', { done: () => `${path} back with the hub`, refresh: ['port_list'] });
  return (
    <Button busy={act.isPending} data-action="release" onClick={() => act.mutate({ lease_id: leaseId })}>
      Take back
    </Button>
  );
}

export function AgentsSection() {
  const now = useNow(5000);
  const prompts = pendingPrompts({ prompts: useLive((s) => s.prompts) }, now);
  const ports = useOp('port_list', {}, { refetchInterval: 2000 });
  const jobs = useOp('job_list', { origin: 'mcp', limit: 30 }, { refetchInterval: 10_000 });
  const leased = (ports.data?.ports ?? []).filter((p) => p.lease);
  return (
    <>
      <Section title="Waiting for a person" aside={<Caps>{prompts.length ? `${prompts.length}` : 'none'}</Caps>} id="prompts">
        {prompts.length ? (
          prompts.map((p) => (
            <Line
              key={p.prompt_id}
              id={`prompt-${p.prompt_id}`}
              bead="waiting"
              beadLabel="waiting for you"
              name={p.text}
              value={
                <>
                  ends <FTime at={p.expires_at} form="relative" />
                </>
              }
              detail={
                <>
                  waits for <Code>{p.types.join(', ')}</Code>
                  {p.selector ? (
                    <>
                      {' '}
                      on <Code>{p.selector}</Code>
                    </>
                  ) : null}
                </>
              }
            />
          ))
        ) : (
          <p className="set-note">No agent is waiting for you. When one asks you to press a button or plug a board, it shows here and in a notice on every page.</p>
        )}
      </Section>

      <Section title="Serial leases" aside={<Caps>{ports.data ? (leased.length ? `${leased.length}` : 'none') : ''}</Caps>} id="leases">
        {ports.error ? <ErrorLine error={ports.error} what="Ports" /> : null}
        {leased.length ? (
          leased.map((p) => (
            <Line
              key={p.lease!.lease_id}
              id={`lease-${p.lease!.lease_id}`}
              bead="waiting"
              beadLabel="lent"
              name={<Code>{p.path}</Code>}
              value={
                <>
                  ends <FTime at={p.lease!.expires_at} form="relative" />
                </>
              }
              detail={`${p.lease!.holder_pid !== undefined ? `held by pid ${p.lease!.holder_pid}` : 'lent by hand, no holder process'}${p.alias ? ` · ${p.alias}` : ''}`}
              actions={<TakeBack leaseId={p.lease!.lease_id} path={p.path} />}
            />
          ))
        ) : ports.data ? (
          <p className="set-note">No port is lent out. A lease lends a port to idf.py, esptool or a browser and gives it back after.</p>
        ) : null}
      </Section>

      <Section title="Jobs agents started" id="jobs">
        {jobs.error ? <ErrorLine error={jobs.error} what="Jobs" /> : null}
        {jobs.data && !jobs.data.jobs.length ? <EmptyState title="No agent jobs yet">Builds, flashes and updates an agent starts through fr mcp are listed here.</EmptyState> : null}
        {(jobs.data?.jobs ?? []).map((j) => (
          <Line
            key={j.job_id}
            id={`job-${j.job_id}`}
            bead={JOB_BEAD[j.status] ?? 'idle'}
            beadLabel={j.status}
            name={`${j.kind}${j.targets.length ? ` · ${j.targets.join(', ')}` : ''}`}
            value={<FTime at={j.created_at} form="relative" />}
            detail={
              <>
                {j.status}
                {j.stage ? ` · ${j.stage}` : ''} · <Code>{j.job_id}</Code>
              </>
            }
          />
        ))}
      </Section>
    </>
  );
}
