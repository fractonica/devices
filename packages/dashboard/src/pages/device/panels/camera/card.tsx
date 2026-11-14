// CARD RECORDINGS (DEVICE-SPEC §3.8): a fold over the board's micro-SD card. camera_sd_list runs when it opens and after
// each recording, play or delete (stream.started / stream.ended invalidate it), never on a poll. One row per
// recording, newest first: PLAY brings it to the hub and shows it here; DELETE (a quiet word in fault: the loud one is
// PLAY) asks in place. While a stream runs both wait, and the fold says so once (its aside: STREAMING).

import { useState } from 'react';

import { OpError } from '../../../../api/rest.ts';
import { useAct, useOp } from '../../../../hooks.ts';
import { newestFirst } from '../../../../state/camera.ts';
import { countText } from '../../../../state/device-units.ts';
import { CamError } from './errors.tsx';
import { Button, Disclosure, EmptyState, engrave, ErrorLine, FTime, Pending, Row, StageRing, useFractonica } from './ui.ts';

/** Rows shown before SHOW ALL. */
const FIRST_ROWS = 20;

export interface Playing {
  recording: number;
  received: number;
  frames: number;
}

export interface CardProps {
  deviceId: string;
  alias: string;
  instance: string;
  /** camera_status.sd. */
  sd: 'none' | 'mounted' | 'error' | null;
  /** A stream runs on the camera: PLAY and DELETE wait. */
  streaming: boolean;
  offline: boolean;
  /** Recordings made from this page (id → Date.now() when it ended). */
  madeHere: Readonly<Record<number, number>>;
  playing: Playing | null;
  /** Busy starting PLAY of this recording. */
  starting: number | null;
  onPlay(recording: number, frames: number): void;
  /** The fold is opened from outside (IN CARD RECORDINGS ›). */
  open: boolean;
  onOpenChange(open: boolean): void;
}

export function CardRecordings({ deviceId, alias, instance, sd, streaming, offline, madeHere, playing, starting, onPlay, open, onOpenChange }: CardProps) {
  const core = useFractonica();
  const [all, setAll] = useState(false);
  const [gone, setGone] = useState<{ recording: number; error: OpError } | null>(null);
  const list = useOp('camera_sd_list', { device: `id:${deviceId}`, instance }, { enabled: open && sd === 'mounted' });
  const del = useAct('camera_sd_delete', { quiet: () => true, refresh: ['camera_sd_list', 'camera_status'] });
  const recs = newestFirst(list.data?.recordings ?? []);
  const shown = all ? recs : recs.slice(0, FIRST_ROWS);
  const count = list.data ? ` · ${recs.length}` : '';
  const unsupported = list.error?.code === 'CAPABILITY_UNSUPPORTED';
  const aside = sd === 'none' ? 'no card' : sd === 'error' ? 'failed' : sd === null ? 'not known yet' : streaming ? 'streaming' : null;

  const remove = (id: number) => {
    setGone(null);
    del.mutate(
      { device: `id:${deviceId}`, instance, recording: id },
      { onError: (err) => setGone({ recording: id, error: err instanceof OpError ? err : new OpError({ code: 'INTERNAL', message: String(err), retryable: false }) }) },
    );
  };

  let body;
  if (sd === 'none') {
    body = <p className="cam-note">No card in the slot. Recording to the hub works without one.</p>;
  } else if (sd === 'error') {
    body = (
      <ErrorLine
        code="CARD_FAILED"
        message="The card failed to mount, or a write failed. Take it out, check it on a computer, put it back and restart the board."
      />
    );
  } else if (sd === null) {
    body = <p className="cam-note">The camera has not said whether it has a card yet.</p>;
  } else if (unsupported) {
    body = <p className="cam-note">This build does not use the card.</p>;
  } else if (list.error) {
    body = <ErrorLine error={list.error} what="The card’s recordings" />;
  } else if (!list.data) {
    body = <Pending what="the card" />;
  } else if (recs.length === 0) {
    body = <EmptyState title="No recordings yet">The card holds no recordings yet. RECORD… → CARD makes one.</EmptyState>;
  } else {
    body = (
      <>
        {streaming ? <p className="cam-note">the camera is streaming: stop it to play or delete</p> : null}
        {shown.map((r) => {
          const isPlaying = playing?.recording === r.id;
          const made = madeHere[r.id];
          return (
            <Row
              key={r.id}
              id={`recording-${r.id}`}
              name={`recording ${r.id}`}
              lead={isPlaying ? <StageRing bare size={22} stages={['play']} current={0} fraction={playing.frames > 0 ? Math.min(1, playing.received / playing.frames) : undefined} label={`playing recording ${r.id}`} /> : undefined}
              sub={made !== undefined ? (
                <span>
                  made here <FTime at={new Date(made)} form="relative" />
                </span>
              ) : undefined}
              value={`${countText(core, r.frames)} frame${r.frames === 1 ? '' : 's'}`}
              extra={`${countText(core, r.bytes)} B`}
              earth={`${(r.bytes / 1e6).toFixed(1)} MB`}
              actions={
                <>
                  <Button disabled={streaming || offline} busy={starting === r.id} onClick={() => onPlay(r.id, r.frames)} data-action="play" aria-label={`Play recording ${r.id}`}>
                    Play
                  </Button>
                  <Button
                    variant="quiet"
                    data-tone="fault"
                    disabled={streaming || offline}
                    busy={del.isPending && del.variables?.recording === r.id}
                    confirm={`Delete recording ${r.id} from the card? It cannot be undone. Copies on the hub stay.`}
                    confirmLabel="Delete"
                    cancelLabel="Keep it"
                    onClick={() => remove(r.id)}
                    data-action="delete"
                  >
                    Delete
                  </Button>
                </>
              }
            />
          );
        })}
        {gone ? <CamError error={gone.error} ctx={{ alias, instance, recording: gone.recording }} /> : null}
        {!all && recs.length > FIRST_ROWS ? (
          <Button variant="quiet" onClick={() => setAll(true)}>
            {`Show all ${recs.length}`}
          </Button>
        ) : null}
        {sd === 'mounted' ? (
          <Button variant="quiet" onClick={() => void list.refetch()} busy={list.isFetching}>
            Read the card again
          </Button>
        ) : null}
      </>
    );
  }
  return (
    <div id={`card-${instance}`} data-card-fold="">
      <Disclosure title={`card recordings${count}`} aside={aside ? <span className="caps">{engrave(aside)}</span> : undefined} open={open} onOpenChange={onOpenChange}>
        <div className="cam-card">{body}</div>
      </Disclosure>
    </div>
  );
}
