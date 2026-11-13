// A text of the catalogue's or a guide's on the Bench, in the mode's units (ui/kit.tsx useHeldText, state/pure-text.ts
// heldText): in pure mode each rating or measure (4.2 V, 100 Ω, 25 mm, 50 %) is replaced in place by ⊕, the mark for
// "a value shown in Earth mode", so a sentence someone wires from keeps its shape and a safety limit is never silently
// gone; a guide's step also says "values in earth" at its end. Earth mode shows every value, each led by ⊕ (design
// README ruling 11 and "Hub" 10).

import { Fragment } from 'react';

import { HELD, pureSafe } from '../../state/pure-text.ts';
import { engrave, useHeldText, useMode } from '../../ui/index.ts';

/** The words for the ⊕ a held-back value leaves (its accessible name and its tooltip). */
const HELD_WORDS = 'a value shown in Earth mode';

/** A text with each ⊕ heldText left drawn as the held mark (pure mode only: in Earth mode ⊕ leads a value). */
export function HeldMarks({ text }: { text: string }) {
  const parts = text.split(HELD);
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 ? (
            <span className="bench-held" role="img" aria-label={HELD_WORDS} title={HELD_WORDS}>
              {HELD}
            </span>
          ) : null}
          {p}
        </Fragment>
      ))}
    </>
  );
}

/** `hint`: say where the values went, on this line (a guide's step or safety line, which someone acts on). */
export function Said({ text, hint = false }: { text: string | null | undefined; hint?: boolean }) {
  const say = useHeldText();
  const { earth } = useMode();
  if (!text) {
    return null;
  }
  const t = say(text);
  const held = !earth && !pureSafe(text) && t.includes(HELD);
  return (
    <>
      {earth ? t : <HeldMarks text={t || '—'} />}
      {held && hint ? (
        <span className="bench-earth-hint caps" title="its values are shown in Earth mode">
          {engrave('values in earth')}
        </span>
      ) : null}
    </>
  );
}
