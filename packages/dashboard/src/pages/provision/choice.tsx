// A row one picks from a list (a port, a network, a profile): the LENS row on its hairline, whose lead is a radio (a
// small engraved ring, lit lumen when chosen) and whose right side may carry its own quiet actions. The list is a
// radiogroup; arrow keys move the choice, as a radio group does.

import type { KeyboardEvent, ReactNode } from 'react';

import { Bead, type BeadState } from '../../ui/index.ts';

export interface ChoiceRowProps {
  chosen: boolean;
  onChoose: () => void;
  /** The thing's name in bone. */
  name: ReactNode;
  /** A smaller ash line under the name. */
  extra?: ReactNode;
  bead?: BeadState;
  beadLabel?: string;
  /** Right-aligned value. */
  value?: ReactNode;
  /** A line under the value (ash). */
  valueExtra?: ReactNode;
  /** Its own actions, at the end of the row. */
  actions?: ReactNode;
  /** Shown but quieter (a profile for another chip). */
  muted?: boolean;
  /** Lights the hairline (a board just plugged in), fading out over 600 ms. */
  flash?: boolean;
  disabled?: boolean;
  /** Reachable with Tab although not chosen (the first row of a group with no choice yet). */
  tabbable?: boolean;
  id?: string;
}

/** Arrow keys move the choice to the next or previous radio in the group. */
function moveFocus(e: KeyboardEvent<HTMLButtonElement>) {
  const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
  if (!dir) {
    return;
  }
  const group = e.currentTarget.closest('[role="radiogroup"]');
  const radios = group ? [...group.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)')] : [];
  const i = radios.indexOf(e.currentTarget);
  const next = radios[(i + dir + radios.length) % radios.length];
  if (next) {
    e.preventDefault();
    next.focus();
    next.click();
  }
}

export function ChoiceRow({ chosen, onChoose, name, extra, bead, beadLabel, value, valueExtra, actions, muted, flash, disabled, tabbable, id }: ChoiceRowProps) {
  return (
    <div className="ui-row prov-choice" data-chosen={chosen ? '' : undefined} data-muted={muted ? '' : undefined} data-flash={flash ? '' : undefined} data-row={id}>
      <button type="button" role="radio" aria-checked={chosen} tabIndex={chosen || tabbable ? 0 : -1} className="prov-choice-lead" onClick={onChoose} onKeyDown={moveFocus} disabled={disabled}>
        <svg className="prov-choice-mark" width="13" height="13" viewBox="-6.5 -6.5 13 13" aria-hidden="true">
          <circle className="ring" r="5.5" />
          <circle className="dot" r="2.6" />
        </svg>
        {bead ? (
          <span className="prov-choice-bead">
            <Bead state={bead} label={beadLabel} />
          </span>
        ) : null}
        <span className="prov-choice-text">
          <span className="ui-row-name">{name}</span>
          {extra ? <span className="prov-choice-extra">{extra}</span> : null}
        </span>
      </button>
      {value !== undefined || valueExtra ? (
        <span className="ui-row-values">
          {value !== undefined ? <span className="ui-row-value">{value}</span> : null}
          {valueExtra ? <span className="ui-row-extra">{valueExtra}</span> : null}
        </span>
      ) : null}
      {actions ? <span className="prov-choice-actions">{actions}</span> : null}
    </div>
  );
}

/** A radiogroup of ChoiceRows (give the first row `tabbable` when none is chosen). */
export function Choices({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label} className="prov-choices">
      {children}
    </div>
  );
}
