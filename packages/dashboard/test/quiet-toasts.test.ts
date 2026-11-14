// The end of a live view this dashboard showed is the camera page's to say, not a toast's (src/state/quiet-toasts.ts):
// an app camera job on the device ends quietly while a view of it is open and for a while after it closed.

import { afterEach, describe, expect, it } from 'vitest';

import { quietToast, resetQuietViews, VIEW_QUIET_MS, viewClosed, viewOpened } from '../src/state/quiet-toasts.ts';

const viewJob = { kind: 'camera', origin: 'app', targets: ['d1'] };
const toast = { job_id: 'j1' };

describe('quiet toasts', () => {
  afterEach(() => resetQuietViews());

  it('keeps the end of an app camera job quiet while this dashboard shows the device, and for a while after', () => {
    expect(quietToast(toast, viewJob, 1000)).toBe(false); // no view here: another app's job toasts as ever
    viewOpened('d1');
    expect(quietToast(toast, viewJob, 1000)).toBe(true);
    viewClosed('d1', 2000);
    expect(quietToast(toast, viewJob, 2000 + VIEW_QUIET_MS - 1)).toBe(true); // left the page: the view's end follows
    expect(quietToast(toast, viewJob, 2000 + VIEW_QUIET_MS + 1)).toBe(false);
  });

  it('never a photo, a recording or PLAY this page started (origin dashboard), another device, or a toast of no job', () => {
    viewOpened('d1');
    expect(quietToast(toast, { ...viewJob, origin: 'dashboard' })).toBe(false);
    expect(quietToast(toast, { ...viewJob, targets: ['d2'] })).toBe(false);
    expect(quietToast(toast, { ...viewJob, kind: 'ota' })).toBe(false);
    expect(quietToast({}, viewJob)).toBe(false);
    expect(quietToast(toast, undefined)).toBe(false);
  });

  it('counts views: a second view of the device closing does not end the first one’s quiet', () => {
    viewOpened('d1');
    viewOpened('d1');
    viewClosed('d1', 0);
    expect(quietToast(toast, viewJob, VIEW_QUIET_MS * 10)).toBe(true);
    viewClosed('d1', 0);
    expect(quietToast(toast, viewJob, VIEW_QUIET_MS * 10)).toBe(false);
  });
});
