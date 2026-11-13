// The hub's extension of the token table (design README "Hub" ruling 5): one colour the site does not have, `fault`,
// for errors only. Everything else is the vendored tokens.js (never edited here). This file and tokens.js are the only
// places in the dashboard where a colour is written.

import { applyTheme, theme, type Theme, type ThemeColor } from './tokens.js';

export const HUB_COLOR = Object.freeze({
  /** Errors only: a fault bead, an error line's sign, a destructive button's hairline, error lines in a log. */
  fault: '#e3677a',
});

export type HubColor = ThemeColor & typeof HUB_COLOR;

/**
 * Applies the astrolabe theme to `root` (the site's custom properties: --c-*, --font-*, --w-*, --track-*) and adds
 * the hub's own: --c-fault. Called once at startup, before the first render.
 */
export function applyHubTheme(root: HTMLElement = document.documentElement): Theme {
  const t = applyTheme(root, 'astrolabe');
  root.style.setProperty('--c-fault', HUB_COLOR.fault);
  return t;
}

/** Every colour in force, for code that cannot use CSS (canvas, xterm): the theme's and the hub's. */
export function hubColors(): HubColor {
  return { ...theme().color, ...HUB_COLOR };
}

export { theme, withAlpha } from './tokens.js';

/** The tab's icon, drawn from the tokens as the site's main.js does: the hub's sigil (a ring and its planet) in lumen on the plate. */
export function setHubIcon(doc: Document = document): void {
  const c = hubColors();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-16 -16 32 32"><rect x="-16" y="-16" width="32" height="32" rx="7" fill="${c.plate}"/><circle r="9" fill="none" stroke="${c.lumen}" stroke-width="1.6"/><circle cx="5.79" cy="-6.89" r="2.6" fill="${c.lumen}"/></svg>`;
  let link = doc.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = doc.createElement('link');
    link.rel = 'icon';
    doc.head.append(link);
  }
  link.type = 'image/svg+xml';
  link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
