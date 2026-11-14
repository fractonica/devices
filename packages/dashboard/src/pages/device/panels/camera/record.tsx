// RECORD… (DEVICE-SPEC §3.5): the in-place form under the transport. Where (hub, card, both), how long (presets the core
// writes as spans), the pace, whether to show it here; under MORE SETTINGS a frame cap and this recording's own frame
// and detail. START RECORDING runs camera_stream; its does line is written from the choices.

import { type KeyboardEvent, type ReactNode, useRef, useState } from 'react';

import type { Core } from '@fractonica/time/browser';

import { earthDuration } from '../../../../state/device-units.ts';
import {
  aboutFrames,
  detailOf,
  detailValueText,
  FRAME_SIZES,
  PACES_S,
  qualityOf,
  RECORD_LENGTHS_S,
  type RecordChoice,
  recordDoes,
  type RecordTarget,
  sizeAllowed,
  sizeWords,
  TARGET_WORDS,
} from '../../../../state/camera.ts';
import { Button, ButtonRow, Disclosure, engrave, Select, Slider, spanText, TextField, Toggle, useFractonica, useInPlace, useMode } from './ui.ts';

/**
 * Engraved words that pick one: a radio group on the chip's look (a word can be disabled with a reason). One tab stop,
 * the chosen word; the arrow keys move to the next word that is not disabled and choose it.
 */
export function Words<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; disabled?: boolean; why?: string }[];
  onChange: (v: T) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const key = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) {
      return;
    }
    e.preventDefault();
    for (let k = 1; k <= options.length; k++) {
      const j = (i + step * k + options.length * k) % options.length;
      const o = options[j]!;
      if (!o.disabled) {
        onChange(o.value);
        refs.current[j]?.focus();
        return;
      }
    }
  };
  return (
    <div className="cam-words" role="radiogroup" aria-label={label}>
      <span className="cam-words-label caps" aria-hidden="true">
        {engrave(label)}
      </span>
      <span className="ui-chips">
        {options.map((o, i) => (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            className="ui-chip"
            aria-checked={value === o.value}
            tabIndex={value === o.value ? 0 : -1}
            disabled={o.disabled}
            title={o.disabled ? o.why : undefined}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => key(e, i)}
          >
            <span className="ui-chip-word">{engrave(o.label)}</span>
          </button>
        ))}
      </span>
    </div>
  );
}

/** A length in seconds as the core's span ("3λ 18ν"); "—" while the core loads. */
export function spanOfSeconds(core: Core | null, s: number): string {
  return core ? spanText(core, s * 1e6, 2) : '—';
}

function lengthLabel(core: Core | null, s: number, earth: boolean): string {
  if (s === 0) {
    return 'until stopped';
  }
  const span = spanOfSeconds(core, s);
  return earth && core ? `${span} ⊕ ${earthDuration(core, s * 1e6)}` : span;
}

export interface RecordFormProps {
  /** The form's element id (RECORD…'s aria-controls). */
  id?: string;
  /** The card is mounted (CARD and HUB AND CARD need it). */
  cardIn: boolean;
  /** The board's largest frame size. */
  maxFrameSize: string | null;
  busy: boolean;
  disabled: boolean;
  /** Why START RECORDING is disabled, in words. */
  why?: string | null;
  onStart(choice: RecordChoice, extra: { frame_size?: string; quality?: number }): void;
  onCancel(): void;
  error?: ReactNode;
}

export function RecordForm({ id, cardIn, maxFrameSize, busy, disabled, why, onStart, onCancel, error }: RecordFormProps) {
  const core = useFractonica();
  const { earth } = useMode();
  const [to, setTo] = useState<RecordTarget>('hub');
  const [seconds, setSeconds] = useState(60);
  const [paced, setPaced] = useState(false);
  const [paceS, setPaceS] = useState(5);
  const [live, setLive] = useState(true);
  const [maxFrames, setMaxFrames] = useState('');
  const [frame, setFrame] = useState('');
  const [detail, setDetail] = useState<number | null>(null);
  const ref = useInPlace<HTMLDivElement>('record', onCancel);
  const where = cardIn ? to : 'hub';
  const mf = /^\d+$/.test(maxFrames.trim()) ? Number(maxFrames.trim()) : 0;
  const mfBad = maxFrames.trim() !== '' && !/^\d+$/.test(maxFrames.trim());
  const choice: RecordChoice = { to: where, seconds, intervalMs: paced ? paceS * 1000 : 0, live, maxFrames: mf };
  const about = aboutFrames(seconds, choice.intervalMs);
  const span = (s: number) => spanOfSeconds(core, s);
  /** MORE SETTINGS that were changed (the title counts its fields, as a command's form does). */
  const setCount = [maxFrames.trim() !== '', frame !== '', detail !== null].filter(Boolean).length;
  return (
    <div className="cam-record" ref={ref} data-record-form="" {...(id ? { id } : {})}>
      <Words
        label="where"
        value={where}
        onChange={setTo}
        options={(['hub', 'sd', 'both'] as const).map((t) => ({ value: t, label: TARGET_WORDS[t], disabled: t !== 'hub' && !cardIn, why: 'no card in the board' }))}
      />
      {!cardIn ? <p className="cam-note">The card choices need a card in the board.</p> : null}
      <Select
        label="how long"
        value={String(seconds)}
        onChange={(v) => setSeconds(Number(v))}
        options={RECORD_LENGTHS_S.map((s) => ({ value: String(s), label: lengthLabel(core, s, earth) }))}
      />
      <Words
        label="pace"
        value={paced ? 'every' : 'fast'}
        onChange={(v) => setPaced(v === 'every')}
        options={[
          { value: 'fast', label: 'as fast as it can' },
          { value: 'every', label: 'one frame every' },
        ]}
      />
      {paced ? (
        <Select
          label="one frame every"
          value={String(paceS)}
          onChange={(v) => setPaceS(Number(v))}
          options={PACES_S.map((s) => ({ value: String(s), label: lengthLabel(core, s, earth) }))}
          note={about !== null ? `about ${about} frames` : 'until you stop it'}
        />
      ) : null}
      {where !== 'sd' ? <Toggle label="show it here while it records" checked={live} onChange={setLive} states={['no', 'yes']} /> : null}
      <Disclosure title="more settings · 3" aside={setCount > 0 ? <span className="caps">{engrave(`${setCount} set`)}</span> : undefined}>
        <div className="cam-record-more">
          <TextField label="stop after this many frames" value={maxFrames} onChange={setMaxFrames} inputMode="numeric" note="empty: no limit" error={mfBad ? 'a whole count, like 600' : null} />
          <Select
            label="frame for this recording"
            value={frame}
            onChange={setFrame}
            options={[{ value: '', label: 'as the camera is set' }, ...FRAME_SIZES.map((f) => ({ value: f, label: `${f} · ${sizeWords(f)}`, disabled: !sizeAllowed(f, maxFrameSize) }))]}
          />
          <DetailSlider value={detail === null ? null : detail} onChange={setDetail} label="detail for this recording" />
        </div>
      </Disclosure>
      <p className="cam-does">{recordDoes(choice, span)}</p>
      <ButtonRow>
        <Button
          busy={busy}
          disabled={disabled || mfBad}
          data-action="start-recording"
          onClick={() => onStart(choice, { ...(frame ? { frame_size: frame } : {}), ...(detail !== null ? { quality: qualityOf(detail) } : {}) })}
        >
          Start recording
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </ButtonRow>
      {why ? <p className="cam-note">{why}</p> : null}
      {error}
    </div>
  );
}

/** Detail: quality 4..63 inverted (right is finer), its ends engraved, no number. `value` null: as the camera is set. */
export function DetailSlider({ value, onChange, label = 'detail', disabled }: { value: number | null; onChange: (detail: number) => void; label?: string; disabled?: boolean }) {
  return (
    <div className="cam-slider">
      <Slider
        label={label}
        value={value ?? detailOf(12)}
        min={0}
        max={59}
        onChange={onChange}
        format={() => (value === null ? engrave('as set') : '')}
        valueText={(d) => (value === null ? detailValueText(null) : detailValueText(d))}
        disabled={disabled}
        note={<Ends lo="coarse" hi="fine" />}
      />
    </div>
  );
}

export function Ends({ lo, hi }: { lo: string; hi: string }) {
  return (
    <span className="cam-ends" aria-hidden="true">
      <span className="caps">{engrave(lo)}</span>
      <span className="caps">{engrave(hi)}</span>
    </span>
  );
}
