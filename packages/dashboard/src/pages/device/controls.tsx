// The typed controls a capability's catalog fields become (state/device-controls.ts decides which): a toggle, a
// slider lit to its value, a number, a colour well, a select, text, hex bytes, a list of numbers; a JSON message only
// behind a fold. Values in a time or rate unit are written as spans and per-Blink rates (state/device-units.ts), a
// share is light only; Earth mode adds the ⊕ translation.

import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

import { type ControlSpec, colourHex } from '../../state/device-controls.ts';
import { fractionOf, unitInfo, valueText } from '../../state/device-units.ts';
import { Disclosure, Earth, engrave, Reading, Select, TextField, Toggle, useFractonica } from '../../ui/index.ts';
import { ColourWell } from './bits.tsx';

/** A number's text beside a slider: the span, rate or count in pure mode; nothing for a share (the line is lit). */
export function SliderValue({ value, unit }: { value: number; unit?: string }) {
  const core = useFractonica();
  const v = valueText(core, value, unit);
  return (
    <span className="dev-slider-value">
      {v.text ? <Reading text={v.text} /> : null}
      {v.earth ? <Earth className={v.text ? 'dev-earth-inline' : ''}>{v.earth}</Earth> : null}
    </span>
  );
}

/** A compact slider for a row: the hairline lit to the value, its text beside it. Commits once the hand rests. */
export function InlineSlider({
  value,
  min,
  max,
  unit,
  label,
  onCommit,
  disabled,
}: {
  value: number;
  min: number;
  max: number;
  unit?: string;
  label: string;
  onCommit: (v: number) => void;
  disabled?: boolean;
}) {
  const core = useFractonica();
  const [local, setLocal] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const shown = local ?? value;
  const fill = fractionOf(shown, min, max) * 100;
  const change = (v: number) => {
    setLocal(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      onCommit(v);
      // the mirror takes over once the device reports the new value
      timer.current = setTimeout(() => setLocal(null), 1500);
    }, 220);
  };
  return (
    <span className="dev-inline-slider">
      <input
        type="range"
        className="ui-slider"
        min={min}
        max={max}
        value={shown}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={valueText(core, shown, unit).text || undefined}
        style={{ ['--fill' as string]: `${fill}%` }}
        onChange={(e) => change(Number(e.target.value))}
      />
      <SliderValue value={shown} unit={unit} />
    </span>
  );
}

/** A property's on/off switch for a row (the row's label names it): the toggle's ring and the state word. */
export function PropSwitch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="ui-toggle" disabled={disabled} onClick={() => onChange(!checked)}>
      <svg width="24" height="14" viewBox="-12 -7 24 14" aria-hidden="true">
        <rect className="ring" x="-11.5" y="-6.5" width="23" height="13" rx="6.5" strokeWidth="1" />
        <circle className="knob" cx="-5" cy="0" r="3.5" />
      </svg>
      <span className="caps">{engrave(checked ? 'on' : 'off')}</span>
    </button>
  );
}

/** One field of a command form, by its control kind. */
export function FieldControl({ spec, value, onChange, error }: { spec: ControlSpec; value: unknown; onChange: (v: unknown) => void; error?: string }) {
  const id = useId();
  const note = spec.optional ? 'optional' : undefined;
  switch (spec.kind) {
    case 'toggle':
      return (
        <div className="dev-field dev-field-inline">
          <Toggle label={spec.label} checked={value === true} onChange={onChange} states={['off', 'on']} />
        </div>
      );
    case 'slider': {
      const n = Number(value);
      return (
        <div className="dev-field">
          <label className="caps ui-field-label" htmlFor={id}>
            {engrave(spec.label)}
            {spec.optional ? <span className="dev-optional">{engrave(' · optional')}</span> : null}
          </label>
          <span className="dev-inline-slider dev-inline-slider-wide">
            <input
              id={id}
              type="range"
              className="ui-slider"
              min={spec.min}
              max={spec.max}
              value={Number.isFinite(n) ? n : 0}
              style={{ ['--fill' as string]: `${fractionOf(n, spec.min ?? 0, spec.max ?? 1) * 100}%` }}
              onChange={(e) => onChange(Number(e.target.value))}
            />
            <SliderValue value={Number.isFinite(n) ? n : 0} unit={spec.unit} />
          </span>
          {error ? <span className="ui-field-error">{error}</span> : null}
        </div>
      );
    }
    case 'number':
      return (
        <div className="dev-field">
          <TextField label={spec.label} value={String(value ?? '')} onChange={onChange} inputMode="numeric" error={error} note={note} mono />
          {String(value ?? '').trim() !== '' && Number.isFinite(Number(value)) ? (
            ['time', 'rate'].includes(unitInfo(spec.unit).cls) ? (
              <SliderValue value={Number(value)} unit={spec.unit} />
            ) : unitInfo(spec.unit).cls === 'earth' ? (
              <Earth className="dev-field-earth">{valueText(null, Number(value), spec.unit).earth}</Earth>
            ) : null
          ) : null}
        </div>
      );
    case 'colour':
      return (
        <div className="dev-field">
          <span className="caps ui-field-label">
            {engrave(spec.label)}
            {spec.optional ? <span className="dev-optional">{engrave(' · optional')}</span> : null}
          </span>
          <ColourWell value={typeof value === 'number' ? value : 0xffffff} onChange={onChange} label={spec.label} />
          {error ? <span className="ui-field-error">{error}</span> : null}
        </div>
      );
    case 'select':
      return (
        <div className="dev-field">
          <Select label={spec.label} value={String(value)} onChange={(v) => onChange(Number(v))} options={(spec.options ?? []).map((o) => ({ value: String(o.value), label: o.label }))} note={note} error={error} />
        </div>
      );
    case 'bytes':
      return (
        <div className="dev-field">
          <TextField label={spec.label} value={String(value ?? '')} onChange={onChange} mono placeholder="hex, two digits a byte" error={error} note={note} />
        </div>
      );
    case 'list':
      return (
        <div className="dev-field">
          <TextField label={spec.label} value={String(value ?? '')} onChange={onChange} mono placeholder="numbers, separated by commas" error={error} note={note} />
        </div>
      );
    case 'message':
      return (
        <div className="dev-field dev-field-wide">
          <Disclosure title={`${spec.label} · ${spec.type}`}>
            <textarea className="dev-json mono" rows={8} spellCheck={false} aria-label={`${spec.label} (${spec.type})`} value={typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2)} onChange={(e) => onChange(e.target.value)} />
            {error ? <span className="ui-field-error">{error}</span> : null}
          </Disclosure>
        </div>
      );
    default:
      return (
        <div className="dev-field">
          <TextField label={spec.label} value={String(value ?? '')} onChange={onChange} maxLength={spec.maxLength} error={error} note={note} />
        </div>
      );
  }
}

/** A colour value for a row: its disc and hex. */
export function ColourValue({ value }: { value: number }): ReactNode {
  return (
    <span className="dev-colour-value">
      <span className="dev-colour-disc" style={{ width: 12, height: 12, backgroundColor: colourHex(value) }} aria-hidden="true" />
      <span className="mono">{colourHex(value).slice(1).toUpperCase()}</span>
    </span>
  );
}
