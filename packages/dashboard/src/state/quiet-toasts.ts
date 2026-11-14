// Job ends a page says itself, kept out of the toast stack (shell/notices.tsx Toasts). The hub runs a live view of the
// camera as an `app` camera job (/app/stream `start`); its end is the view closing, which the camera page says in its own
// words (or nothing, when the page was left: leaving is how a view stops). Its toast ("camera cam-esp32: done") would
// read as if some job had finished, on whichever page shows next. So while this dashboard shows a live view of a device,
// and for VIEW_QUIET_MS after it closed, the end of an app camera job on that device is not toasted. A failure stays
// quiet too: the camera page says why the view did not start (state/camera.ts boardBusyLine, failedViewJob).

/** How long after this dashboard's own view of a device closed its view job's end stays quiet. */
export const VIEW_QUIET_MS = 15_000;

/** Device id → Date.now() until which its app camera jobs end quietly (Infinity while a view is open). */
const views = new Map<string, number>();
const open = new Map<string, number>();

/** This dashboard opened a live view of the device. */
export function viewOpened(deviceId: string): void {
  open.set(deviceId, (open.get(deviceId) ?? 0) + 1);
  views.set(deviceId, Infinity);
}

/** That view closed (stopped, ended, or its page was left). */
export function viewClosed(deviceId: string, now = Date.now()): void {
  const n = Math.max(0, (open.get(deviceId) ?? 1) - 1);
  open.set(deviceId, n);
  if (n === 0) {
    views.set(deviceId, now + VIEW_QUIET_MS);
  }
}

/** Whether a toast is the end of a live-view job this dashboard showed, which the page says itself (or need not say). */
export function quietToast(t: { job_id?: string | undefined }, job: { kind: string; origin?: string | undefined; targets?: readonly string[] | undefined } | undefined, now = Date.now()): boolean {
  if (!t.job_id || !job || job.kind !== 'camera' || job.origin !== 'app') {
    return false;
  }
  return (job.targets ?? []).some((d) => (views.get(d) ?? -Infinity) >= now);
}

/** Forgets every view (tests). */
export function resetQuietViews(): void {
  views.clear();
  open.clear();
}
