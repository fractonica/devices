// The fr.camera panel (DEVICE-SPEC §3): live view over /app/stream, photo, recording, sensor settings, card
// recordings. Builder CAMERA owns panels/camera/*. Registered in ../../panels.ts as CAMERA_PANEL (the export name and
// the CapPanel shape are the seam).
// - Lens: the instrument page (lens.tsx).
// - Headline: the Overview row's reading: "idle · card in", "live · <per Blink>", "recording to the card",
//   "recording · 2ι left", "playing recording 7".
// - Quick: a quiet WATCH link to the camera's page with ?watch=1, which starts the view once.

import './camera.css';

import { Link } from '@tanstack/react-router';

import { useOp } from '../../../../hooks.ts';
import { rateText, spanText } from '../../../../state/device-units.ts';
import type { CapPanel, CapPanelProps } from '../../panels.ts';
import { isAway } from '../generic.tsx';
import { CameraLens } from './lens.tsx';
import { engrave, useFractonica } from './ui.ts';

function CameraHeadline({ detail, inst, mirror }: CapPanelProps) {
  const core = useFractonica();
  const status = useOp('camera_status', { device: `id:${detail.device_id}`, instance: inst.name });
  const s = status.data?.stream ?? null;
  const sd = status.data?.sd ?? (typeof mirror.sd === 'string' ? mirror.sd : null);
  const fps = typeof mirror.fps_x10 === 'number' ? mirror.fps_x10 / 10 : (status.data?.fps_x10 ?? 0) / 10;
  if (isAway(detail.presence)) {
    return <span className="ash">{detail.presence === 'unknown' ? 'not heard yet' : 'offline'}</span>;
  }
  if (s && s.to === 'sd') {
    return <span>recording to the card</span>;
  }
  if (s?.use === 'play') {
    return <span>{s.recording !== undefined ? `playing recording ${s.recording}` : 'playing a recording'}</span>;
  }
  if (s && s.seconds === 0 && s.use === 'record') {
    return <span>recording</span>;
  }
  if (s && s.seconds > 0) {
    const started = s.started_at ? Date.parse(s.started_at) : NaN;
    const left = Number.isFinite(started) ? s.seconds * 1e6 - (Date.now() - started) * 1000 : NaN;
    return <span>{core && Number.isFinite(left) ? `recording · ${spanText(core, Math.max(0, left))} left` : 'recording'}</span>;
  }
  if (s || mirror.streaming === true) {
    return <span>{fps > 0 && core ? `live · ${rateText(core, fps)}` : 'live'}</span>;
  }
  return <span>{sd === 'mounted' ? 'idle · card in' : 'idle'}</span>;
}

function CameraQuick({ detail, inst }: CapPanelProps) {
  if (isAway(detail.presence)) {
    return (
      <span className="ui-button" data-variant="quiet" aria-disabled="true" data-quick="watch">
        <span className="ui-button-text">{engrave('watch')}</span>
      </span>
    );
  }
  return (
    <Link to="/devices/$id/$instance" params={{ id: detail.alias, instance: inst.name }} search={{ watch: 1 } as never} className="ui-button" data-variant="quiet" data-quick="watch">
      <span className="ui-button-text">{engrave('watch')}</span>
    </Link>
  );
}

export const CAMERA_PANEL: CapPanel = {
  Lens: CameraLens,
  Headline: CameraHeadline,
  Quick: CameraQuick,
  // the device commands this panel runs itself, through the hub's camera ops (§3)
  covers: ['stream_start', 'stream_stop', 'set', 'sd_list', 'sd_fetch', 'sd_delete'],
  // the view says the board is offline in its own words
  saysPresence: true,
};
