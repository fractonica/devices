// The look switcher pinned to the window's corner while design proposals are compared (shell/look.ts). Temporary.

import { type Look, LOOKS, useLook } from './look.ts';

const WORD: Record<Look, string> = { now: 'NOW', a: 'A', b: 'B', c: 'C' };

export function LookPicker() {
  const { look, setLook } = useLook();
  return (
    <div className="look-picker" role="radiogroup" aria-label="Design proposal">
      <span className="caps look-picker-label">LOOK</span>
      {LOOKS.map((l) => (
        <button key={l} type="button" role="radio" aria-checked={look === l} className="look-picker-choice" onClick={() => setLook(l)} data-look-choice={l}>
          <span className="caps">{WORD[l]}</span>
        </button>
      ))}
    </div>
  );
}
