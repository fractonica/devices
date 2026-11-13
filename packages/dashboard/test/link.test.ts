// The live link to the hub as the pages read it (src/shell/link.ts): down once `/ws` has not been open for a moment, or
// the hub did not answer its status; never on the first connect; up again as soon as it is back.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LINK_GRACE_MS, linkDown, linkRestDown, linkStatus } from '../src/shell/link.ts';

describe('the live link', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    linkStatus({ status: 'open' });
    linkRestDown(false);
  });
  afterEach(() => vi.useRealTimers());

  it('is down after a reconnect that takes longer than the grace, through connecting and closed alike', () => {
    linkStatus({ status: 'connecting' });
    vi.advanceTimersByTime(LINK_GRACE_MS / 2);
    linkStatus({ status: 'closed' });
    linkStatus({ status: 'connecting' });
    expect(linkDown()).toBe(false);
    vi.advanceTimersByTime(LINK_GRACE_MS / 2 + 1);
    expect(linkDown()).toBe(true);
    linkStatus({ status: 'open' });
    expect(linkDown()).toBe(false);
  });

  it('is not down on a short reconnect, nor before the first connect', () => {
    linkStatus({ status: 'idle' });
    linkStatus({ status: 'connecting' });
    vi.advanceTimersByTime(LINK_GRACE_MS - 10);
    linkStatus({ status: 'open' });
    vi.advanceTimersByTime(LINK_GRACE_MS);
    expect(linkDown()).toBe(false);
  });

  it('is down while the hub does not answer its status, even with the socket open', () => {
    linkRestDown(true);
    expect(linkDown()).toBe(true);
    linkRestDown(false);
    expect(linkDown()).toBe(false);
  });
});
