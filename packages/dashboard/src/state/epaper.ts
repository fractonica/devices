// The e-paper block's logic (design epaper-e1 D10), DOM-free and tested in node: what the panel knows of an instance's
// build (the ghost budget from capability_list's config, else the capability's default), the words for the glass's
// state and the budget, the dither choices with plain names, and a picked file as base64 for display_image. Every
// sentence here is pure-safe: durations are put on the page by the block, as Fractonica spans.

import { EPAPER_CONFIG_DEFAULTS, type EpaperRefreshMode } from '@fractonica/protocol/client';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Whether an fr.display instance is an e-paper panel (trait epaper). */
export function isEpaper(traits: Record<string, unknown> | null | undefined): boolean {
  return traits?.epaper === true;
}

/** The build's ghost budget: automatic partials before a clean refresh (0: never), and which refresh cleans. */
export function budgetOf(config: Record<string, unknown> | undefined): { fullEvery: number; clean: 'full' | 'fast' } {
  const n = num(config?.full_every);
  return { fullEvery: n !== null && n >= 0 ? n : EPAPER_CONFIG_DEFAULTS.full_every, clean: config?.clean === 'fast' ? 'fast' : 'full' };
}

/** "3 partial refreshes since the last clean; the next change after 5 cleans (full)", or null before any report. */
export function budgetWords(partials: unknown, budget: { fullEvery: number; clean: 'full' | 'fast' }): string | null {
  const p = num(partials);
  if (p === null) {
    return null;
  }
  const since = p === 0 ? 'no partial refresh since the last clean' : p === 1 ? '1 partial refresh since the last clean' : `${p} partial refreshes since the last clean`;
  if (budget.fullEvery === 0) {
    return `${since}; no automatic clean`;
  }
  return p >= budget.fullEvery ? `${since}; the next change cleans (${budget.clean})` : `${since}; a clean (${budget.clean}) after ${budget.fullEvery}`;
}

/** What is known of the glass: shown_crc 0 means not since the board started (its old picture may still be there). */
export function glassWords(shownCrc: unknown): string {
  const c = num(shownCrc);
  if (c === null) {
    return 'not reported yet';
  }
  return c === 0 ? 'not known since the board started: the next refresh is full' : 'known: only what changes is refreshed';
}

/** The refresh buttons: what each runs, in the panel's words. */
export const REFRESH_ACTIONS: readonly { mode: EpaperRefreshMode; label: string; doc: string }[] = [
  { mode: 'auto', label: 'Refresh', doc: 'what changed, without a flash (or a clean one when due)' },
  { mode: 'fast', label: 'Clean', doc: 'the whole screen, a short flash; clears ghosts' },
  { mode: 'full', label: 'Full', doc: 'the whole screen, a long flash; clears every ghost' },
];

/** How a picture becomes 1 bit, in plain names. */
export const DITHER_CHOICES: readonly { value: 'none' | 'ordered' | 'diffusion'; label: string }[] = [
  { value: 'none', label: 'Line art' },
  { value: 'diffusion', label: 'Photo' },
  { value: 'ordered', label: 'Pattern' },
];

/** The text sizes offered for display_text, in panel pixels (the block shows them as words). */
export const TEXT_SIZES: readonly { px: number; label: string }[] = [
  { px: 32, label: 'Small' },
  { px: 56, label: 'Medium' },
  { px: 96, label: 'Large' },
];

/** A picked file's bytes as base64 (display_image's png_base64). */
export async function fileBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** The largest picture the block sends (display_image takes more; a phone's photo is plenty under this). */
export const MAX_PICTURE_BYTES = 8 * 1024 * 1024;
