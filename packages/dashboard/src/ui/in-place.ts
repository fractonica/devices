// An in-place form or picker (Lend's spans, Add network, Rename): when it opens, focus moves to its first field or
// button; Escape inside it closes it; when it closes, focus goes back to the control that opened it, which carries
// `data-opens="<key>"` (the opener is not on the page while the form is, so it is found again by its key).

import { type RefObject, useEffect, useRef } from 'react';

const FOCUSABLE = 'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])';

export function useInPlace<T extends HTMLElement>(key: string, close: () => void): RefObject<T | null> {
  const box = useRef<T | null>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const el = box.current;
    if (!el) {
      return;
    }
    el.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        closeRef.current();
      }
    };
    el.addEventListener('keydown', esc);
    return () => {
      el.removeEventListener('keydown', esc);
      requestAnimationFrame(() => {
        const at = document.activeElement;
        if (!at || at === document.body) {
          document.querySelector<HTMLElement>(`[data-opens="${CSS.escape(key)}"]`)?.focus();
        }
      });
    };
  }, [key]);
  return box;
}
