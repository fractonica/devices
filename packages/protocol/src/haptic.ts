// fr.haptic's numbers every side shares (design haptic-h1 D2, D10, D11): the tap's bounds, each kind's defaults when a
// build leaves them 0, and the cooldown-budget rule HapticService::train_fits applies to a tap train, so the hub, the
// dashboard and the fake refuse exactly what the node refuses. No dependency: `@fractonica/protocol/client` exports it.

/** fr.haptic tap's bounds (haptic.cap.yaml 1.1): the period, the count (0 = until stop), the accent. */
export const HAPTIC_TAP_MIN_PERIOD_MS = 20;
export const HAPTIC_TAP_MAX_PERIOD_MS = 60_000;
export const HAPTIC_TAP_MAX_COUNT = 10_000;
export const HAPTIC_TAP_MAX_ACCENT = 32;
/** The window the node's cooldown budget counts in (HapticService::kWindowUs). */
export const HAPTIC_WINDOW_MS = 10_000;

/** fr.haptic's kinds and their defaults when the build's config leaves them 0 (HapticService). */
export const HAPTIC_KINDS = ['erm', 'solenoid'] as const;
export type HapticKind = (typeof HAPTIC_KINDS)[number];
export const HAPTIC_KIND_DEFAULTS: Record<HapticKind, { max_on_ms: number; cooldown_pct: number }> = {
  erm: { max_on_ms: 10_000, cooldown_pct: 100 },
  solenoid: { max_on_ms: 1_000, cooldown_pct: 30 },
};

/**
 * Whether a tap train of `ms` every `period_ms` stays inside a cooldown budget of `cooldown_pct` % of 10 s in its worst
 * window: ceil(10,000 / period_ms) taps, each counted 1 ms long for the timer's lateness, strictly under the budget
 * (HapticService::train_fits; the node answers INVALID_ARGS otherwise).
 */
export function hapticTrainFits(periodMs: number, ms: number, cooldownPct: number): boolean {
  if (cooldownPct >= 100) {
    return true;
  }
  if (!(periodMs > 0)) {
    return false;
  }
  const taps = Math.ceil(HAPTIC_WINDOW_MS / periodMs);
  return taps * (ms + 1) < cooldownPct * (HAPTIC_WINDOW_MS / 100);
}

/** The longest tap (ms) a train every `period_ms` may have: below the period, at most max_on_ms, inside the budget; 0 when none fits. */
export function hapticLongestTap(periodMs: number, maxOnMs: number, cooldownPct: number): number {
  let ms = Math.min(periodMs - 1, maxOnMs);
  if (cooldownPct < 100) {
    const taps = Math.ceil(HAPTIC_WINDOW_MS / periodMs);
    // taps * (ms + 1) < budget  <=>  ms < budget / taps - 1
    const budget = cooldownPct * (HAPTIC_WINDOW_MS / 100);
    ms = Math.min(ms, Math.ceil(budget / taps) - 2);
  }
  return Math.max(0, ms);
}
