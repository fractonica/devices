// SENSOR SETTINGS (DEVICE-SPEC §3.6): a fold, aside KEPT UNTIL IT RESTARTS. Frame (sizes past the board's buffers
// disabled), Detail (quality inverted: right is finer, no number), Flip, Mirror, Brightness, Contrast, Saturation.
// Each change sends camera_set with that one field once the hand rests; INVALID_ARGS puts the control back and says
// why on it. The values shown come from the current frame's head, then what this page set last (kept per device in
// this browser), then the build's defaults. After the board restarts, the fold says its picture is back to the
// build's settings and offers to apply what was set here again.

import { useEffect, useMemo, useRef, useState } from 'react';

import type { CatalogConfig } from '@fractonica/protocol/gen';

import { OpError } from '../../../../api/rest.ts';
import { useAct, useLive } from '../../../../hooks.ts';
import {
  cameraErrorLine,
  detailOf,
  FRAME_SIZES,
  levelValueText,
  qualityOf,
  type SensorSettings,
  type SettingKey,
  settingsDefaults,
  settingsShown,
  sizeAllowed,
  sizeWords,
} from '../../../../state/camera.ts';
import { DetailSlider, Ends } from './record.tsx';
import { Button, ButtonRow, Disclosure, engrave, ErrorLine, Select, Slider, Toggle } from './ui.ts';

const storeKey = (device: string, instance: string) => `fractonica.camera.${device}.${instance}`;

/** What this page set last for the camera (localStorage; nothing when the browser keeps none). */
export function readSetHere(device: string, instance: string): Partial<SensorSettings> | null {
  try {
    const raw = localStorage.getItem(storeKey(device, instance));
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Partial<SensorSettings>) : null;
  } catch {
    return null;
  }
}

function writeSetHere(device: string, instance: string, v: Partial<SensorSettings>): void {
  try {
    localStorage.setItem(storeKey(device, instance), JSON.stringify(v));
  } catch {
    // a private window or blocked storage: the values are only not remembered
  }
}

/** The newest node.boot of the device in the live store (its seq), or null. */
function useLastBoot(deviceId: string): number | null {
  return useLive((s) => {
    for (let i = s.events.length - 1; i >= 0; i--) {
      const e = s.events[i]!;
      if (e.type === 'node.boot' && e.device === deviceId) {
        return e.seq;
      }
    }
    return null;
  });
}

export interface SettingsProps {
  deviceId: string;
  alias: string;
  instance: string;
  config: readonly CatalogConfig[];
  maxFrameSize: string | null;
  /** The head of the frame on screen (its size and quality, and when a frame with it first came), while frames show. */
  head: { frameSize: string | null; quality: number; at?: number } | null;
  disabled: boolean;
  /** Frame or detail changed while watching: the view restarts with them. */
  onPicture(next: { frame_size: string; quality: number }): void;
}

export function SensorSettingsFold({ deviceId, alias, instance, config, maxFrameSize, head, disabled, onPicture }: SettingsProps) {
  const defaults = useMemo(() => settingsDefaults(config), [config]);
  const [setHere, setSetHere] = useState<Partial<SensorSettings> | null>(() => readSetHere(deviceId, instance));
  const [draft, setDraft] = useState<Partial<SensorSettings>>({});
  const [failed, setFailed] = useState<{ key: SettingKey; error: OpError; line: string | null } | null>(null);
  const timers = useRef(new Map<SettingKey, ReturnType<typeof setTimeout>>());
  const boot = useLastBoot(deviceId);
  const bootAtMount = useRef(boot);
  const rebooted = boot !== null && boot !== bootAtMount.current && setHere !== null && Object.keys(setHere).length > 0;
  const [applied, setApplied] = useState<number | null>(null);
  /** When each setting was last accepted here: a frame from before that does not override it (the view restarts). */
  const [setAt, setSetAt] = useState<Partial<Record<SettingKey, number>>>({});
  const set = useAct('camera_set', { quiet: () => true, refresh: ['camera_status'] });
  const shown = settingsShown(head, setHere, defaults, setAt);
  const values = { ...shown.values, ...draft };

  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);

  const send = (key: SettingKey, value: SensorSettings[SettingKey]) => {
    setFailed(null);
    set.mutate({ device: `id:${deviceId}`, instance, [key]: value } as Parameters<typeof set.mutate>[0], {
      onSuccess: () => {
        const next = { ...(setHere ?? {}), [key]: value };
        setSetHere(next);
        setSetAt((m) => ({ ...m, [key]: Date.now() }));
        writeSetHere(deviceId, instance, next);
        setDraft((d) => {
          const { [key]: _drop, ...rest } = d;
          return rest;
        });
        if (key === 'frame_size' || key === 'quality') {
          onPicture({ frame_size: key === 'frame_size' ? String(value) : values.frame_size, quality: key === 'quality' ? Number(value) : values.quality });
        }
      },
      onError: (err) => {
        // put the control back, and say why on it
        setDraft((d) => {
          const { [key]: _drop, ...rest } = d;
          return rest;
        });
        const e = err instanceof OpError ? err : new OpError({ code: 'INTERNAL', message: String(err), retryable: false });
        setFailed({ key, error: e, line: cameraErrorLine(e.code, e.message, { alias, instance, maxFrameSize, frameSize: key === 'frame_size' ? String(value) : null }) });
      },
    });
  };

  /** A change: shown at once, sent once the hand rests (a slider), or now (a choice, a switch). */
  const change = <K extends SettingKey>(key: K, value: SensorSettings[K], restMs = 0) => {
    setDraft((d) => ({ ...d, [key]: value }));
    const old = timers.current.get(key);
    if (old) {
      clearTimeout(old);
    }
    if (restMs === 0) {
      send(key, value);
      return;
    }
    timers.current.set(
      key,
      setTimeout(() => {
        timers.current.delete(key);
        send(key, value);
      }, restMs),
    );
  };

  const errorOn = (key: SettingKey) => (failed?.key === key ? failed.line ? <ErrorLine message={failed.line} code={failed.error.code} /> : <ErrorLine error={failed.error} /> : null);
  const fromWord = (key: SettingKey) => (draft[key] !== undefined ? null : shown.from[key] === 'set-here' ? 'as last set here' : shown.from[key] === 'start' ? 'as it starts' : null);

  const applyAgain = () => {
    if (!setHere) {
      return;
    }
    setApplied(boot);
    set.mutate({ device: `id:${deviceId}`, instance, ...setHere } as Parameters<typeof set.mutate>[0], {
      onError: (err) => setFailed({ key: 'frame_size', error: err instanceof OpError ? err : new OpError({ code: 'INTERNAL', message: String(err), retryable: false }), line: null }),
    });
  };

  return (
    <Disclosure title="sensor settings" aside={<span className="caps">{engrave('kept until it restarts')}</span>}>
      <div className="cam-settings" data-camera-settings="">
        {rebooted && applied !== boot ? (
          <div className="cam-rebooted">
            <p>The board restarted: its picture is back to the build’s settings.</p>
            <ButtonRow>
              <Button onClick={applyAgain} busy={set.isPending} disabled={disabled}>
                Apply again
              </Button>
            </ButtonRow>
          </div>
        ) : null}
        <Select
          label="frame"
          value={values.frame_size}
          disabled={disabled}
          onChange={(v) => change('frame_size', v as SensorSettings['frame_size'])}
          options={FRAME_SIZES.map((f) => ({ value: f, label: `${f} · ${sizeWords(f)}`, disabled: !sizeAllowed(f, maxFrameSize) }))}
          note={maxFrameSize && maxFrameSize !== 'uxga' ? `the board’s frame buffers were made for up to ${maxFrameSize}` : (fromWord('frame_size') ?? undefined)}
        />
        {errorOn('frame_size')}
        <DetailSlider value={detailOf(values.quality)} onChange={(d) => change('quality', qualityOf(d), 400)} disabled={disabled} />
        {fromWord('quality') ? <p className="cam-note">{fromWord('quality')}</p> : null}
        {errorOn('quality')}
        <Toggle label="flip" checked={values.vflip} onChange={(v) => change('vflip', v)} disabled={disabled} states={['off', 'on']} />
        {errorOn('vflip')}
        <Toggle label="mirror" checked={values.hmirror} onChange={(v) => change('hmirror', v)} disabled={disabled} states={['off', 'on']} />
        {errorOn('hmirror')}
        {(['brightness', 'contrast', 'saturation'] as const).map((k) => (
          <div key={k} className="cam-slider">
            <Slider label={k} value={values[k]} min={-2} max={2} onChange={(v) => change(k, v, 400)} format={() => ''} valueText={levelValueText} disabled={disabled} note={<Ends lo="less" hi="more" />} />
            {fromWord(k) ? <p className="cam-note">{fromWord(k)}</p> : null}
            {errorOn(k)}
          </div>
        ))}
      </div>
    </Disclosure>
  );
}
