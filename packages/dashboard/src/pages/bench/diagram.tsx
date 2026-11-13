// A wiring diagram, inlined: the hub serves the guide's SVG (/wiring/<guide>/<file>, refused if it carries scripts or
// external references), the page fetches it, sanitises it (state/bench-view.ts sanitizeSvg: no script, handler or
// javascript: URL survives, and the drawing's own colours are dropped) and draws it in the hub's engraving
// (bench.css maps the chat-diagram vocabulary onto the tokens). Pressing it opens it wide and back.

import { useEffect, useState } from 'react';

import { sanitizeSvg } from '../../state/bench-view.ts';
import { engrave } from '../../ui/index.ts';

const cache = new Map<string, Promise<string>>();

function load(url: string): Promise<string> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url).then(async (r) => {
      if (!r.ok) {
        throw new Error(`the hub answered ${r.status}`);
      }
      return sanitizeSvg(await r.text());
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

/** Forget the fetched drawings (after "Read the files again"). */
export function clearDiagrams(): void {
  cache.clear();
}

export function Diagram({ title, url }: { title: string; url: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    let live = true;
    setError(null);
    load(url).then(
      (s) => live && setSvg(s),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [url]);
  return (
    <figure className="bench-figure" data-wide={wide ? '' : undefined}>
      <button type="button" className="bench-diagram-button" aria-expanded={wide} aria-label={`${title}: ${wide ? 'smaller' : 'larger'}`} onClick={() => setWide((w) => !w)}>
        {svg ? (
          <div className="bench-diagram" dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          <div className="bench-diagram bench-diagram-empty">{error ? `The drawing did not load: ${error}` : ''}</div>
        )}
      </button>
      <figcaption className="caps">{engrave(title)}</figcaption>
    </figure>
  );
}
