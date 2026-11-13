// Whether a sideways scroller has more past its right edge: `data-more` on it while it does, so CSS fades the edge
// (ui.css). Read on scroll and on resize; nothing moves by itself.

import { type RefObject, useEffect } from 'react';

export function useMoreRight(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const read = () => {
      const more = el.scrollWidth - el.clientWidth - el.scrollLeft > 2;
      if (more) {
        el.setAttribute('data-more', '');
      } else {
        el.removeAttribute('data-more');
      }
    };
    read();
    el.addEventListener('scroll', read, { passive: true });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    for (const c of el.children) {
      ro.observe(c);
    }
    return () => {
      el.removeEventListener('scroll', read);
      ro.disconnect();
    };
  });
}
