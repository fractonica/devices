// A text of the catalogue's or a guide's on the Bench, in the mode's units (ui/kit.tsx useHubText, state/pure-text.ts):
// in pure mode a rating or a measure (4.2 V, 100 Ω, 25 mm, 50 %) is left out, and a small engraved word says the
// values are shown in Earth mode, so a person wiring a board knows where to find them; Earth mode shows them, each led
// by ⊕ (design README ruling 11 and "Hub" 10).

import { pureSafe } from '../../state/pure-text.ts';
import { engrave, useHubText, useMode } from '../../ui/index.ts';

/** `hint`: say where the values went, on this line (a guide's step, which someone wires from); elsewhere the page says it once. */
export function Said({ text, hint = false }: { text: string | null | undefined; hint?: boolean }) {
  const say = useHubText();
  const { earth } = useMode();
  if (!text) {
    return null;
  }
  const t = say(text);
  const held = !earth && !pureSafe(text);
  const t2 = t || (held ? '—' : '');
  return (
    <>
      {t2}
      {held && hint ? (
        <span className="bench-earth-hint caps" title="its values are shown in Earth mode">
          {engrave('values in earth')}
        </span>
      ) : null}
    </>
  );
}
