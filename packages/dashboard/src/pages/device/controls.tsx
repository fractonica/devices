// The typed controls a capability's catalog fields become (state/device-controls.ts decides which): a toggle, a
// slider lit to its value, a number, a colour well, a select, text, hex bytes, a list of numbers; a JSON message only
// behind a fold. Values in a time or rate unit are written as spans and per-Blink rates (state/device-units.ts), a
// share is light only; Earth mode adds the ⊕ translation.

import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

import { type ControlSpec, colourHex, INT_RANGES } from '../../state/device-controls.ts';
import { fractionOf, SPAN_RUNGS, spanText, spanToField, spanToUs, unitInfo, usPerUnit, usToRung, valueText } from '../../state/device-units.ts';
import { Disclosure, Earth, engrave, Reading, Select, SpanField, type SpanRung, TextField, Toggle, useFractonica } from '../../ui/index.ts';
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
export function PropSwitch({ checked, onChange, label, disabled, bare = false }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; bare?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="ui-toggle" disabled={disabled} onClick={() => onChange(!checked)}>
      <svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true">
        <circle className="ring" r="7.5" strokeWidth="1" />
        <circle className="dot" r="3.6" />
      </svg>
      {bare ? null : <span className="caps">{engrave(checked ? 'on' : 'off')}</span>}
    </button>
  );
}

/** The rungs a span is typed in, with the core's symbols and words ("ν blinks"). */
function useRungs(): SpanRung[] {
  const core = useFractonica();
  return SPAN_RUNGS.map((u) => ({ value: String(u), label: core ? `${core.frc.formatUnitSymbol(u)} ${core.frc.formatUnitName(u, true).toLowerCase()}` : String(u) }));
}

const UNTIL_STOPPED = 'until-stopped';

/** True when a field's doc says 0 means no limit ("0: until stream_stop", "0: no limit"). */
export function zeroIsNoLimit(spec: Pick<ControlSpec, 'doc' | 'min'>): boolean {
  return (spec.min ?? 0) <= 0 && /(^|[\s(;,])0:\s/.test(spec.doc ?? '');
}

/**
 * A field in a time unit, typed as a span (DEVICE-SPEC G7): a count and a rung, which the core turns into the field's
 * unit, rounded and clamped to its range; a clamp is said as a span ("at most 7ι"). Earth mode adds ⊕ the value.
 */
export function SpanControl({ spec, value, onChange, error, hint }: { spec: ControlSpec; value: unknown; onChange: (v: unknown) => void; error?: string; hint?: string }) {
  const core = useFractonica();
  const rungs = useRungs();
  const per = usPerUnit(spec.unit) ?? 1;
  const zero = zeroIsNoLimit(spec);
  const words = zero ? [{ value: UNTIL_STOPPED, label: 'until stopped' }] : [];
  const [typed, setTyped] = useState<{ count: string; rung: string } | null>(null);
  const [clamp, setClamp] = useState<'min' | 'max' | null>(null);
  const [bad, setBad] = useState(false);
  let shown = typed;
  if (!shown) {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    if (zero && n === 0) {
      shown = { count: '', rung: UNTIL_STOPPED };
    } else if (Number.isFinite(n) && core) {
      const r = usToRung(core, n * per);
      shown = { count: String(r.count), rung: String(r.rung) };
    } else {
      shown = { count: '', rung: String(SPAN_RUNGS[0]) };
    }
  }
  const change = (count: string, rung: string) => {
    setTyped({ count, rung });
    setBad(false);
    setClamp(null);
    if (rung === UNTIL_STOPPED) {
      onChange(0);
      return;
    }
    const n = Number(count.trim().replace(',', '.'));
    if (count.trim() === '' || !core) {
      onChange('');
      return;
    }
    if (!Number.isFinite(n) || n < 0) {
      setBad(true);
      onChange('');
      return;
    }
    const r = spanToField(spanToUs(core, n, Number(rung)), spec.unit, spec.min, spec.max);
    if (!r) {
      onChange('');
      return;
    }
    // a count above nothing never rounds down to 0, which a field may read as "no limit"
    if (n > 0 && r.value === 0) {
      onChange(Math.max(1, spec.min ?? 1));
      setClamp('min');
      return;
    }
    setClamp(r.clamped);
    onChange(r.value);
  };
  const span = (v: number | undefined) => (core && v !== undefined ? spanText(core, v * per, 2) : '');
  const ranged = spec.max !== undefined && spec.max < (INT_RANGES[spec.type]?.[1] ?? Infinity);
  const note = clamp === 'max' ? `at most ${span(spec.max)}` : clamp === 'min' ? `at least ${span(Math.max(spec.min ?? 0, 1))}` : [hint, ranged ? `up to ${span(spec.max)}` : ''].filter(Boolean).join(' · ') || undefined;
  const v = typeof value === 'number' ? value : null;
  const earth = v !== null && !(zero && v === 0) ? valueText(core, v, spec.unit).earth : null;
  return (
    <div className="dev-field">
      <SpanField
        label={spec.label}
        count={shown.count}
        rung={shown.rung}
        rungs={rungs}
        words={words}
        onChange={change}
        note={note}
        error={bad ? 'a count, like 3 or 0.5' : error}
        earth={earth ? <Earth className="dev-field-earth">{earth}</Earth> : undefined}
      />
    </div>
  );
}

/** One field of a command form, by its control kind; a field in a time unit is a span. `hint` is the example ("e.g. 3"). */
export function FieldControl({ spec, value, onChange, error, hint, disabled }: { spec: ControlSpec; value: unknown; onChange: (v: unknown) => void; error?: string; hint?: string; disabled?: boolean }) {
  const id = useId();
  const note = hint;
  if ((spec.kind === 'slider' || spec.kind === 'number') && unitInfo(spec.unit).cls === 'time') {
    return <SpanControl spec={spec} value={value} onChange={onChange} error={error} hint={hint} />;
  }
  switch (spec.kind) {
    case 'toggle':
      return (
        <div className="dev-field dev-field-inline">
          <Toggle label={spec.label} checked={value === true} onChange={onChange} states={['off', 'on']} disabled={disabled} />
        </div>
      );
    case 'slider': {
      const empty = value === '' || value === undefined || value === null;
      const n = empty ? (spec.min ?? 0) : Number(value);
      return (
        <div className="dev-field">
          <label className="caps ui-field-label" htmlFor={id}>
            {engrave(spec.label)}
          </label>
          <span className="dev-inline-slider dev-inline-slider-wide" data-empty={empty ? '' : undefined}>
            <input
              id={id}
              type="range"
              className="ui-slider"
              min={spec.min}
              max={spec.max}
              value={Number.isFinite(n) ? n : 0}
              disabled={disabled}
              style={{ ['--fill' as string]: `${empty ? 0 : fractionOf(n, spec.min ?? 0, spec.max ?? 1) * 100}%` }}
              onChange={(e) => onChange(Number(e.target.value))}
            />
            {empty ? <span className="dev-slider-value ash">not set</span> : <SliderValue value={Number.isFinite(n) ? n : 0} unit={spec.unit} />}
          </span>
          {error ? <span className="ui-field-error">{error}</span> : note ? <span className="ui-field-note">{note}</span> : null}
        </div>
      );
    }
    case 'number':
      return (
        <div className="dev-field">
          <TextField label={spec.label} value={String(value ?? '')} onChange={onChange} inputMode="numeric" error={error} note={note} disabled={disabled} />
          {String(value ?? '').trim() !== '' && Number.isFinite(Number(value)) ? (
            unitInfo(spec.unit).cls === 'rate' ? (
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
          <span className="caps ui-field-label">{engrave(spec.label)}</span>
          <ColourWell value={typeof value === 'number' ? value : 0xffffff} onChange={onChange} label={spec.label} disabled={disabled} />
          {error ? <span className="ui-field-error">{error}</span> : null}
        </div>
      );
    case 'select': {
      const options = (spec.options ?? []).map((o) => ({ value: o.value, label: o.label }));
      const v = typeof value === 'string' ? value : '';
      return (
        <div className="dev-field">
          <Select label={spec.label} value={v} onChange={onChange} options={v === '' ? [{ value: '', label: 'choose one', disabled: true }, ...options] : options} note={note} error={error} disabled={disabled} />
        </div>
      );
    }
    case 'bytes':
      return (
        <div className="dev-field">
          <TextField label={spec.label} value={String(value ?? '')} onChange={onChange} mono placeholder="hex, two digits a byte" error={error} note={note} disabled={disabled} />
        </div>
      );
    case 'list':
      return (
        <div className="dev-field">
          <TextField label={spec.label} value={String(value ?? '')} onChange={onChange} mono placeholder="numbers, separated by commas" error={error} note={note} disabled={disabled} />
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
          <TextField label={spec.label} value={String(value ?? '')} onChange={onChange} maxLength={spec.maxLength} error={error} note={note} disabled={disabled} />
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
