// What waits on a person, at the top of the Hub page: an agent's prompts (a real action at the bench, with the time
// left), ports lent away from the hub (with Release, which asks in place; never for a port a job holds) and running
// jobs (a provisioning opens its page). Nothing at all when nothing waits.

import { useLive, useAct, useOp } from '../../hooks.ts';
import { bannerItems, type BannerJob } from '../../state/hub-home.ts';
import { Button, Caps, engrave, FTime, Row, Section } from '../../ui/index.ts';

export function Banner() {
  const prompts = useLive((s) => s.prompts);
  const jobs = useLive((s) => s.jobs);
  const ports = useOp('port_list', {});
  const release = useAct('serial_release', { done: (d) => `${d.port} is the hub's again`, refresh: ['port_list'] });
  const items = bannerItems(Object.values(prompts), ports.data?.ports ?? [], Object.values(jobs) as BannerJob[]);
  if (!items.length) {
    return null;
  }
  return (
    <div className="hub-banner">
      <Section title="Waiting on you" aside={<Caps>{String(items.length)}</Caps>}>
        {items.map((item) => {
          if (item.kind === 'prompt') {
            return (
              <Row
                key={item.key}
                id={`prompt-${item.key}`}
                bead="waiting"
                beadLabel="an agent asks"
                name={<span className="hub-ask">{item.text}</span>}
                value={
                  <span className="hub-until">
                    <span className="caps ash">{engrave('agent asks')}</span> <FTime at={item.until} form="relative" parts={1} earth="none" />
                  </span>
                }
                extra={item.who || undefined}
              />
            );
          }
          if (item.kind === 'lease') {
            return (
              <Row
                key={item.key}
                id={`lease-${item.key}`}
                bead="waiting"
                beadLabel="port lent"
                name={<span className="hub-ask">{`${item.port} lent to ${item.who}`}</span>}
                value={
                  <span className="hub-until">
                    <span className="caps ash">{engrave('ends')}</span> <FTime at={item.until} form="relative" parts={1} earth="none" />
                    {item.byJob ? null : (
                      <Button variant="quiet" confirm={`Give ${item.port} back to the hub?`} confirmLabel="Release" busy={release.isPending} onClick={() => release.mutate({ lease_id: item.lease_id })}>
                        Release
                      </Button>
                    )}
                  </span>
                }
              />
            );
          }
          return (
            <Row
              key={item.key}
              id={`job-${item.key}`}
              bead="waiting"
              beadLabel="running"
              name={<span className="hub-ask">{item.title}</span>}
              {...(item.provision ? { to: '/provision/$job', params: { job: item.job_id } } : {})}
              value={<span className="caps lumen-word">{engrave(item.stage)}</span>}
            />
          );
        })}
      </Section>
    </div>
  );
}
