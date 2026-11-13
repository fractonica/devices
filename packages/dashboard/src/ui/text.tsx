// Type helpers: engraved caps, a Fractonica reading (numerals bone, unit letters ash), and the Earth line that only
// Earth mode shows.

import type { ReactNode } from 'react';

import { EARTH_SIGN } from '@fractonica/time/browser';

import { useMode } from '../shell/mode.ts';

/** Capitals with the Greek letters left as the symbols they are (the site's engraved(): only a-z is raised). */
export function engrave(words: string): string {
  return words.replace(/[a-z]+/g, (run) => run.toUpperCase());
}

/** Engraved words: Futura caps, tracked. `tone` ash for a label (the default), bone for a name. */
export function Caps({ children, tone = 'ash', className = '' }: { children: string; tone?: 'ash' | 'bone' | 'lumen'; className?: string }) {
  return (
    <span className={`caps ${className}`.trim()} data-tone={tone}>
      {engrave(children)}
    </span>
  );
}

/** A reading in the core's text: numerals in the element's colour, unit letters and # in ash (`.u`). */
export function Reading({ text, className = '' }: { text: string; className?: string }) {
  const runs = text.match(/[α-ω#]+|[^α-ω#]+/g) ?? [];
  return (
    <span className={className}>
      {runs.map((run, i) =>
        /[α-ω#]/.test(run) ? (
          <span key={i} className="u">
            {run}
          </span>
        ) : (
          run
        ),
      )}
    </span>
  );
}

/**
 * An Earth translation: rendered only in Earth mode, in ash, led by ⊕ (`sign={false}` for a column already headed by
 * one). In pure mode it renders nothing at all, so no Earth unit, date or clock time reaches the page.
 */
export function Earth({ children, sign = true, block = false, className = '' }: { children: ReactNode; sign?: boolean; block?: boolean; className?: string }) {
  const { earth } = useMode();
  if (!earth) {
    return null;
  }
  const Tag = block ? 'div' : 'span';
  return (
    <Tag className={`earth ${className}`}>
      {sign ? <span className="sign">{EARTH_SIGN}</span> : null}
      {children}
    </Tag>
  );
}
