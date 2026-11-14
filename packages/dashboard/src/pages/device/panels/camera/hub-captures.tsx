// ON THE HUB: the camera's recent photos and recordings that came to the hub, so a recording to the hub can be looked
// at after the page that made it was left. Read from job_list (the hub keeps each camera job's answer: its path, its
// frames and, for a recording, its first and last frame's index), when the fold opens; the files are served read-only
// from /captures. Live views keep no files and are not listed.

import { useState } from 'react';

import type { Job } from '../../../../api/types.ts';
import { useOp } from '../../../../hooks.ts';
import { capturesUrl, frameUrl } from '../../../../state/camera.ts';
import { countText } from '../../../../state/device-units.ts';
import { HeldPath } from './path.tsx';
import { Disclosure, EmptyState, ErrorLine, FTime, Pending, useFractonica } from './ui.ts';

/** The camera jobs read (the newest of every kind). */
const JOBS_READ = 100;
/** Captures shown. */
const SHOWN = 8;

export interface HubCapture {
  job: string;
  kind: 'photo' | 'recording';
  path: string;
  frames: number;
  /** The photo, or the recording's last frame (null when its index is not known). */
  image: string | null;
  first: string | null;
  endedAt: string | null;
}

/** The instance's captures on the hub from job_list's jobs, newest first. */
export function hubCaptures(jobs: readonly Job[], deviceId: string, instance: string): HubCapture[] {
  const out: HubCapture[] = [];
  for (const j of jobs) {
    if (j.kind !== 'camera' || !j.targets.includes(deviceId) || (j.status !== 'completed' && j.status !== 'cancelled')) {
      continue;
    }
    const r = (j.result ?? {}) as { instance?: string; path?: string; frames?: number; first_index?: number; last_index?: number };
    if (r.instance !== instance || typeof r.path !== 'string' || capturesUrl(r.path) === null) {
      continue;
    }
    const photo = /\.jpe?g$/i.test(r.path);
    if (!photo && !(typeof r.frames === 'number' && r.frames > 0)) {
      continue;
    }
    out.push({
      job: j.job_id,
      kind: photo ? 'photo' : 'recording',
      path: r.path,
      frames: photo ? 1 : (r.frames ?? 0),
      image: photo ? capturesUrl(r.path) : typeof r.last_index === 'number' ? frameUrl(r.path, r.last_index) : null,
      first: !photo && typeof r.first_index === 'number' ? frameUrl(r.path, r.first_index) : null,
      endedAt: j.ended_at ?? null,
    });
  }
  return out;
}

export function HubCaptures({ deviceId, instance }: { deviceId: string; instance: string }) {
  const core = useFractonica();
  const [open, setOpen] = useState(false);
  const list = useOp('job_list', { limit: JOBS_READ }, { enabled: open });
  const all = list.data ? hubCaptures((list.data as { jobs: Job[] }).jobs, deviceId, instance) : [];
  const shown = all.slice(0, SHOWN);
  let body;
  if (list.error) {
    body = <ErrorLine error={list.error} what="The hub’s captures" />;
  } else if (!list.data) {
    body = <Pending what="the hub’s captures" />;
  } else if (!shown.length) {
    body = <EmptyState title="Nothing on the hub yet">PHOTO and RECORD… → HUB keep their frames here.</EmptyState>;
  } else {
    body = shown.map((c) => (
      <figure key={c.job} className="cam-capture" data-capture={c.kind}>
        {c.image ? (
          <a href={c.image} target="_blank" rel="noreferrer">
            <img src={c.image} alt={c.kind === 'photo' ? 'a photo' : 'the last frame of a recording'} loading="lazy" />
          </a>
        ) : null}
        <figcaption>
          <span>
            {c.kind === 'photo' ? 'a photo' : `a recording · ${countText(core, c.frames)} frame${c.frames === 1 ? '' : 's'}`}
            {c.endedAt ? (
              <>
                {' · '}
                <FTime at={new Date(c.endedAt)} form="relative" />
              </>
            ) : null}
          </span>
          <span className="cam-thumb-links">
            {c.first ? (
              <a className="ui-button" data-variant="quiet" href={c.first} target="_blank" rel="noreferrer">
                <span className="ui-button-text">FIRST FRAME</span>
              </a>
            ) : null}
            {c.image ? (
              <a className="ui-button" data-variant="quiet" href={c.image} {...(c.kind === 'photo' ? { download: true } : { target: '_blank', rel: 'noreferrer' })}>
                <span className="ui-button-text">{c.kind === 'photo' ? 'SAVE' : 'LAST FRAME'}</span>
              </a>
            ) : null}
          </span>
          <HeldPath path={c.path} />
        </figcaption>
      </figure>
    ));
  }
  return (
    <div data-hub-captures="">
      <Disclosure title={`on the hub${list.data ? ` · ${all.length}` : ''}`} open={open} onOpenChange={setOpen}>
        <div className="cam-captures">{body}</div>
      </Disclosure>
    </div>
  );
}
