// Form fields from the tokens: a caps label over a hairline (no box), the value in bone, a note or an error (fault)
// under it. TextField, Select, Toggle (the mode toggle's ring, lit when on) and Slider (a hairline lit to the value:
// light, not a bar).

import { type InputHTMLAttributes, type ReactNode, useId } from 'react';

import { engrave } from './text.tsx';

interface FieldFrame {
  /** Engraved caps label. */
  label: string;
  /** A line under the field in ash (what it is for, its limit). */
  note?: ReactNode;
  /** An error under the field in fault; it also marks the field invalid. */
  error?: string | null;
}

function Frame({ id, label, note, error, children }: FieldFrame & { id: string; children: ReactNode }) {
  return (
    <div className="ui-field" data-invalid={error ? '' : undefined}>
      <label className="ui-field-label caps" htmlFor={id}>
        {engrave(label)}
      </label>
      {children}
      {error ? (
        <span className="ui-field-error" id={`${id}-msg`} role="alert">
          {error}
        </span>
      ) : note ? (
        <span className="ui-field-note" id={`${id}-msg`}>
          {note}
        </span>
      ) : null}
    </div>
  );
}

export interface TextFieldProps extends FieldFrame, Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  value: string;
  onChange: (value: string) => void;
  /** Set in the monospace face (ids, paths, commands). */
  mono?: boolean;
}

export function TextField({ label, note, error, value, onChange, mono = false, id, ...rest }: TextFieldProps) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Frame id={fid} label={label} note={note} error={error}>
      <input
        {...rest}
        id={fid}
        className={`ui-input${mono ? ' mono' : ''}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || note ? `${fid}-msg` : undefined}
        spellCheck={rest.spellCheck ?? false}
        autoComplete={rest.autoComplete ?? 'off'}
      />
    </Frame>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends FieldFrame {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  disabled?: boolean;
  id?: string;
}

export function Select({ label, note, error, value, onChange, options, disabled, id }: SelectProps) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Frame id={fid} label={label} note={note} error={error}>
      <span className="ui-select-wrap">
        <select id={fid} className="ui-select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined}>
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
        <svg className="ui-select-mark" width="9" height="6" viewBox="0 0 9 6" aria-hidden="true">
          <path d="M0.5 0.5 4.5 4.5 8.5 0.5" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </Frame>
  );
}

export interface ToggleProps {
  /** Engraved beside the mark. */
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Words for the two states, engraved after the label (default none). */
  states?: [off: string, on: string];
}

export function Toggle({ label, checked, onChange, disabled, states }: ToggleProps) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="ui-toggle" disabled={disabled} onClick={() => onChange(!checked)}>
      <svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true">
        <circle className="ring" r="7.5" strokeWidth="1" />
        <circle className="dot" r="3.6" />
      </svg>
      <span className="caps">{engrave(states ? `${label} · ${checked ? states[1] : states[0]}` : label)}</span>
    </button>
  );
}

export interface SliderProps extends FieldFrame {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  /** How the value is written beside the line (never a percentage). Default: the number. */
  format?: (value: number) => ReactNode;
  /** The value read aloud (aria-valuetext) when the number means nothing to a person (an inverted scale, a level). */
  valueText?: (value: number) => string;
  disabled?: boolean;
  id?: string;
}

export function Slider({ label, note, error, value, min, max, step = 1, onChange, format, valueText, disabled, id }: SliderProps) {
  const auto = useId();
  const fid = id ?? auto;
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <Frame id={fid} label={label} note={note} error={error}>
      <span className="ui-slider-line">
        <input
          id={fid}
          type="range"
          className="ui-slider"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-valuetext={valueText ? valueText(value) : undefined}
          style={{ ['--fill' as string]: `${fill}%` }}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <output className="ui-slider-value" htmlFor={fid}>
          {format ? format(value) : value}
        </output>
      </span>
    </Frame>
  );
}

/** One rung a SpanField offers (ν, λ, ι with their words), or a word that takes no count ("until stopped"). */
export interface SpanRung {
  value: string;
  label: string;
}

export interface SpanFieldProps extends FieldFrame {
  /** The count as typed ("3", "0.5"). */
  count: string;
  /** The chosen rung's value, or a word's. */
  rung: string;
  /** The rungs a count is typed in, largest last (the caller has them from the core). */
  rungs: readonly SpanRung[];
  /** Words that stand for a span without a count; choosing one hides the count. */
  words?: readonly SpanRung[];
  onChange: (count: string, rung: string) => void;
  /** Under the field: what the span is in Earth mode (an <Earth>), or nothing. */
  earth?: ReactNode;
  disabled?: boolean;
  id?: string;
}

/**
 * A span typed as a count and a rung of the core (DEVICE-SPEC G7): "3 ν", "1.5 λ", or a word ("until stopped"). The
 * caller turns it into its unit through the core (state/device-units.ts spanToUs) and states a clamp in the note.
 */
export function SpanField({ label, note, error, count, rung, rungs, words = [], onChange, earth, disabled, id }: SpanFieldProps) {
  const auto = useId();
  const fid = id ?? auto;
  const word = words.some((w) => w.value === rung);
  return (
    <Frame id={fid} label={label} note={note} error={error}>
      <span className="ui-span-field" data-word={word ? '' : undefined}>
        {word ? null : (
          <input
            id={fid}
            className="ui-input ui-span-count"
            inputMode="decimal"
            value={count}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value, rung)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error || note ? `${fid}-msg` : undefined}
            spellCheck={false}
            autoComplete="off"
          />
        )}
        <span className="ui-select-wrap ui-span-rung">
          <select
            id={word ? fid : undefined}
            className="ui-select"
            value={rung}
            disabled={disabled}
            aria-label={`${label}: unit`}
            onChange={(e) => onChange(count, e.target.value)}
          >
            {[...rungs, ...words].map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <svg className="ui-select-mark" width="9" height="6" viewBox="0 0 9 6" aria-hidden="true">
            <path d="M0.5 0.5 4.5 4.5 8.5 0.5" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </span>
      {earth ?? null}
    </Frame>
  );
}
