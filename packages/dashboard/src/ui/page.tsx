// Page and Section: the frame of every page. A page title is engraved caps (the lens word), with an optional sub
// line, an optional Earth line (⊕, Earth mode only) and its actions on the right; the document title follows it.

import { type ReactNode, useEffect } from 'react';

import { Earth, engrave } from './text.tsx';

export interface PageProps {
  /** The page's name, engraved ("Devices"); also the document title "Fractonica hub · Devices". */
  title: string;
  /** A short caps line under the title (a count, a state). */
  sub?: ReactNode;
  /** An Earth translation under the title, shown only in Earth mode, led by ⊕. */
  earth?: ReactNode;
  /** Buttons on the right (one primary at most). */
  actions?: ReactNode;
  /** The document title after "Fractonica hub · " when it says more than the title ("cam-esp32 · cam"). */
  documentTitle?: string;
  children?: ReactNode;
}

export function Page({ title, sub, earth, actions, documentTitle, children }: PageProps) {
  useEffect(() => {
    document.title = `Fractonica hub · ${documentTitle ?? title}`;
  }, [title, documentTitle]);
  return (
    <div className="ui-page" data-page={title.toLowerCase()}>
      <header className="ui-page-head">
        <div className="ui-page-titles">
          <h1 className="ui-page-title" title={title}>
            {engrave(title)}
          </h1>
          {sub ? <div className="ui-page-sub caps">{typeof sub === 'string' ? engrave(sub) : sub}</div> : null}
          {earth ? <Earth block>{earth}</Earth> : null}
        </div>
        {actions ? <div className="ui-page-actions">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

export interface SectionProps {
  /** Engraved caps label over an etch2 rule ("Links"). */
  title?: string;
  /** Right of the title: a count, a quiet button, a bead. */
  aside?: ReactNode;
  /** Body spacing: 'rows' (default, rows sit on each other's hairlines) or 'loose' (forms, blocks). */
  body?: 'rows' | 'loose';
  id?: string;
  children?: ReactNode;
}

export function Section({ title, aside, body = 'rows', id, children }: SectionProps) {
  return (
    <section className="ui-section" id={id} aria-label={title}>
      {title || aside ? (
        <header className="ui-section-head">
          {title ? <h2 className="ui-section-title caps">{engrave(title)}</h2> : <span />}
          {aside ? <div className="ui-section-aside">{aside}</div> : null}
        </header>
      ) : null}
      <div className={`ui-section-body${body === 'loose' ? ' ui-section-loose' : ''}`}>{children}</div>
    </section>
  );
}
