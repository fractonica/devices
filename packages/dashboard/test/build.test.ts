// The dashboard build (design c6 §5): `vite build` with the package's own config succeeds, emits one
// index.html whose scripts are external files (the hub's CSP allows no inline script), keeps no Node
// builtin import in any chunk, embeds the op registry hash and stamps dist/.source-hash as `fr doctor
// --fix` does (design c6 D10); an entry that imports a Node builtin fails the build. Stage 4: the core's
// wasm is an asset, and neither Zod nor Tailwind is in the output.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';

import { REGISTRY_HASH } from '@fractonica/protocol';

import { SOURCE_HASH_FILE, sourceHash } from '../../host/src/web.ts';

const PKG = resolve(import.meta.dirname, '..');
const REPO = resolve(PKG, '../..');
const CONFIG = join(PKG, 'vite.config.ts');
const temps: string[] = [];

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

afterAll(() => {
  for (const d of temps) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe('dashboard build', () => {
  it('builds the SPA with no Node builtin, no inline script, the registry hash and the source hash', { timeout: 120_000 }, async () => {
    const out = temp('fr-dash-');
    await build({ configFile: CONFIG, root: PKG, logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).toMatch(/<script type="module" crossorigin src="\/assets\/index-[\w-]+\.js"><\/script>/);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/); // no inline script
    const assets = readdirSync(join(out, 'assets'));
    const js = assets.filter((f) => f.endsWith('.js'));
    expect(js.some((f) => f.startsWith('xterm-'))).toBe(true); // xterm loads on demand
    const all = js.map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');
    expect(all).not.toMatch(/\bfrom\s*["']node:|\bimport\(\s*["']node:|\brequire\(\s*["']node:/);
    expect(all).not.toContain('__vite-browser-external');
    expect(all).toContain(REGISTRY_HASH);
    // The temporal core is one of the build's own assets (the hub serves it as application/wasm), referenced by name.
    const wasm = assets.filter((f) => /^fractonica-[\w-]+\.wasm$/.test(f));
    expect(wasm).toHaveLength(1);
    expect(all).toContain(`/assets/${wasm[0]}`);
    // Frames are checked by shape: no Zod in any chunk (it came in through @fractonica/protocol/browser before).
    expect(all).not.toMatch(/ZodError|\$ZodType|zod\/v4/);
    // No Tailwind: the stylesheet is the tokens' (no utility layer, no colour literal in it; test/design-rules).
    const css = assets.filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');
    expect(css).not.toMatch(/tailwindcss|--tw-/);
    // The hub calls a dist without it stale (hub_status.dashboard.stale): a plain `vite build` stamps it.
    expect(readFileSync(join(out, SOURCE_HASH_FILE), 'utf8')).toBe(`${await sourceHash(REPO, PKG)}\n`);
  });

  it('fails on an entry that imports a Node builtin', { timeout: 120_000 }, async () => {
    for (const spec of ['node:crypto', 'events']) {
      const root = temp('fr-dash-probe-');
      writeFileSync(join(root, 'index.html'), '<!doctype html><script type="module" src="/main.ts"></script>');
      writeFileSync(join(root, 'main.ts'), `import * as m from '${spec}';\nconsole.log(m);\n`);
      const err = await build({ configFile: CONFIG, root, logLevel: 'silent', build: { outDir: join(root, 'dist') } }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message, spec).toMatch(/is a Node builtin; the dashboard bundle must stay browser-safe/);
    }
  });
});
