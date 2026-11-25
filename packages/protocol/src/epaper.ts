// fr.display's e-paper numbers every side shares (design epaper-e1 D2-D4, D9-D11): the bitmap and hold bounds, the
// refresh modes, and the vendor's refresh times the fake plays and the dashboard words, so the hub, the dashboard and
// the fake split and time things as the node does. No dependency: `@fractonica/protocol/client` exports it.

/** fr.display bitmap's largest `data` (display.cap.yaml 1.3): 400 pixels by 24 rows. */
export const EPAPER_BITMAP_MAX_BYTES = 1200;
/** fr.display hold's longest hold, ms. */
export const EPAPER_HOLD_MAX_MS = 10_000;
/** fr.display's RefreshMode, by wire value. */
export const EPAPER_REFRESH_MODES = ['auto', 'partial', 'fast', 'full'] as const;
export type EpaperRefreshMode = (typeof EPAPER_REFRESH_MODES)[number];

/**
 * The refresh times the vendor states for the Waveshare 4.2inch V2 (design epaper-e1 §0): a partial 0.42 s, fast 1.5 s,
 * full 3 s. The fake plays them; the bench measures the real ones (`refreshed.ms`).
 */
export const EPAPER_VENDOR_MS: Record<Exclude<EpaperRefreshMode, 'auto'>, number> = { partial: 420, fast: 1500, full: 3000 };

/** How long a refresh may take before the node gives it up (hal::Epaper::timeout_us), ms. */
export const EPAPER_TIMEOUT_MS: Record<Exclude<EpaperRefreshMode, 'auto'>, number> = { partial: 2000, fast: 4000, full: 10_000 };

/** The defaults of fr.display's e-paper config (display.cap.yaml 1.3). */
export const EPAPER_CONFIG_DEFAULTS = { settle_ms: 60, full_every: 5, clean: 'full', clean_hours: 24, burst_ms: 1000, sleep_s: 10, boot_clear: false } as const;

/** Bytes of a 1-bit frame `width` x `height` (rows of whole bytes, the snapshot layout). */
export function monoFrameBytes(width: number, height: number): number {
  return Math.ceil(width / 8) * height;
}
