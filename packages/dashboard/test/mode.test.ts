// PURE / EARTH (shell/mode.ts), as the site keeps it: PURE by default, remembered under fractonica.mode, `?mode=` wins,
// written to <html data-mode>; a storage that throws (a private window) changes nothing but the memory.

import { afterEach, describe, expect, it, vi } from 'vitest';

type ModeModule = typeof import('../src/shell/mode.ts');

function fakeStorage(initial: Record<string, string> = {}, broken = false) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => {
      if (broken) {
        throw new Error('denied');
      }
      return data.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (broken) {
        throw new Error('denied');
      }
      data.set(k, v);
    },
  };
}

async function load(opts: { search?: string; stored?: Record<string, string>; broken?: boolean } = {}): Promise<{ mode: ModeModule; storage: ReturnType<typeof fakeStorage>; html: { dataset: Record<string, string> } }> {
  vi.resetModules();
  const storage = fakeStorage(opts.stored, opts.broken);
  const html = { dataset: {} as Record<string, string>, classList: { add() {}, remove() {} } };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('location', { search: opts.search ?? '' });
  vi.stubGlobal('document', { documentElement: html });
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('addEventListener', () => {});
  vi.stubGlobal('removeEventListener', () => {});
  return { mode: await import('../src/shell/mode.ts'), storage, html };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the PURE / EARTH mode', () => {
  it('is PURE by default, and says so on <html>', async () => {
    const { mode, html } = await load();
    expect(mode.getMode()).toBe('pure');
    expect(html.dataset.mode).toBe('pure');
  });

  it('is remembered under the site’s key, and read back', async () => {
    const first = await load();
    first.mode.setMode('earth');
    expect(first.storage.data.get('fractonica.mode')).toBe('earth');
    expect(first.html.dataset.mode).toBe('earth');
    const again = await load({ stored: { 'fractonica.mode': 'earth' } });
    expect(again.mode.getMode()).toBe('earth');
    again.mode.toggleMode();
    expect(again.mode.getMode()).toBe('pure');
  });

  it('takes ?mode= over what is remembered, and ignores anything else', async () => {
    expect((await load({ search: '?mode=pure', stored: { 'fractonica.mode': 'earth' } })).mode.getMode()).toBe('pure');
    expect((await load({ search: '?mode=gregorian' })).mode.getMode()).toBe('pure');
    expect((await load({ stored: { 'fractonica.mode': 'nonsense' } })).mode.getMode()).toBe('pure');
  });

  it('works without storage', async () => {
    const { mode } = await load({ broken: true });
    expect(mode.getMode()).toBe('pure');
    mode.setMode('earth');
    expect(mode.getMode()).toBe('earth');
  });
});
