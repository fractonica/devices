// The design rules a page can break by accident (design README "Hub"; stage 4), checked over the dashboard's sources:
// - no colour literal anywhere but the vendored token table (src/design/tokens.js) and the hub's one extension
//   (src/design/hub-tokens.ts): every colour is a --c-* custom property or a token read in code;
// - no font family but the tokens' (var(--font-reading), var(--font-caps)) and the one monospace stack, --mono in
//   styles/base.css (the tokens have no monospace face; ids, paths and logs need one);
// - no bold or semibold weight;
// - nothing that pulses or blinks: the only keyframes are the Earth annotations' 200 ms cross-fade;
// - no Tailwind left: no @import 'tailwindcss', no @tailwind / @apply;
// - the vendored token file is byte for byte the one tokens.lock names.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');
const TOKEN_FILES = new Set(['design/tokens.js', 'design/hub-tokens.ts']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(css|tsx?|js)$/.test(name) ? [path] : [];
  });
}

const sources = files(SRC).map((path) => ({ rel: relative(SRC, path), text: readFileSync(path, 'utf8') }));
const css = sources.filter((f) => f.rel.endsWith('.css'));
const code = sources.filter((f) => /\.tsx?$/.test(f.rel) && !f.rel.endsWith('.d.ts'));

/** Lines of `text` matching `re`, as "file:line: text", comments dropped. */
function hits(file: { rel: string; text: string }, re: RegExp): string[] {
  const out: string[] = [];
  const noComments = file.text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  noComments.split('\n').forEach((line, i) => {
    const bare = line.replace(/(^|\s)\/\/.*$/, '');
    if (re.test(bare)) {
      out.push(`${file.rel}:${i + 1}: ${line.trim()}`);
    }
  });
  return out;
}

const NAMED = 'white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|cyan|magenta|teal|navy|maroon|olive|lime|aqua|fuchsia';

describe('the dashboard sources follow the design rules', () => {
  it('write no colour literal outside the token files', () => {
    const bad: string[] = [];
    for (const f of css) {
      bad.push(...hits(f, new RegExp(`#[0-9a-fA-F]{3,8}\\b|\\b(rgba?|hsla?|oklch|oklab|lab|lch|hwb)\\(|:\\s*(${NAMED})\\b|\\s(${NAMED})\\s*[;,)]`)));
    }
    for (const f of code.filter((f) => !TOKEN_FILES.has(f.rel))) {
      bad.push(...hits(f, new RegExp(`['"\`]#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?['"\`]|\\b(rgba?|hsla?)\\(|(color|background|fill|stroke)\\s*[:=]\\s*['"](${NAMED})['"]`)));
    }
    expect(bad).toEqual([]);
  });

  it('name no font family but the tokens’ and the one monospace stack', () => {
    const bad: string[] = [];
    for (const f of css) {
      for (const line of hits(f, /font-family\s*:/)) {
        if (!/font-family:\s*var\(--(font-reading|font-caps|mono)\)/.test(line)) {
          bad.push(line);
        }
      }
      bad.push(...hits(f, /--mono\s*:/).filter((l) => !l.startsWith('styles/base.css')));
    }
    for (const f of code) {
      bad.push(...hits(f, /fontFamily\s*[:=]/).filter((l) => !l.startsWith('ui/term.tsx')));
    }
    expect(bad).toEqual([]);
  });

  it('set nothing bold, and nothing that pulses or blinks', () => {
    const bad: string[] = [];
    for (const f of css) {
      bad.push(...hits(f, /font-weight\s*:\s*(bold|bolder|[5-9]00)\b/));
      bad.push(...hits(f, /@keyframes\s+(?!earth-in\b)/));
      bad.push(...hits(f, /(^|[^-])animation\s*:(?!\s*(none|earth-in\b))/));
      bad.push(...hits(f, /animation-iteration-count\s*:\s*infinite|text-decoration[^;]*blink/));
    }
    for (const f of code) {
      bad.push(...hits(f, /cursorBlink\s*:\s*true|fontWeight\s*[:=]\s*['"]?(bold|[6-9]00)/));
    }
    expect(bad).toEqual([]);
  });

  it('carry no Tailwind', () => {
    const bad = css.flatMap((f) => hits(f, /@import\s+['"]tailwindcss|@tailwind\b|@apply\b|@theme\b/));
    expect(bad).toEqual([]);
  });

  it('show no milestone code (LCD-1, CLOCK-1, M2-C5) in the texts the hub serves to the Bench', () => {
    const WIRING = join(import.meta.dirname, '..', '..', '..', 'hardware', 'wiring');
    const bad: string[] = [];
    for (const dir of readdirSync(WIRING)) {
      const file = join(WIRING, dir, 'guide.yaml');
      if (!statSync(join(WIRING, dir)).isDirectory()) {
        continue;
      }
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/\((?:[^)]*\b)?(?:LCD|CLOCK|POWER|SCALE|CAM|CSI|WIRING|AUDIO)-\d\b(?!\.)|\bM\d-C\d\b/.test(line.replace(/^\s*#.*$/, ''))) {
          bad.push(`${dir}/guide.yaml:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it('vendor the site’s token table byte for byte, as tokens.lock says', () => {
    const lock = JSON.parse(readFileSync(join(SRC, 'design', 'tokens.lock'), 'utf8')) as { files: Record<string, { sha256: string }> };
    const sha = createHash('sha256').update(readFileSync(join(SRC, 'design', 'tokens.js'))).digest('hex');
    expect(sha).toBe(lock.files['tokens.js']!.sha256);
  });
});
