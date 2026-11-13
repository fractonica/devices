// The lease commands the docs teach must work when pasted into a shell. `fr serial lease <dev> -- idf.py -p "$FR_PORT"`
// does not: the shell replaces "$FR_PORT" (double quotes, or none) with an empty string before fr runs, so the command
// gets `-p ""`. fr replaces only a literal '$FR_PORT' (single quotes). Every Markdown file, the plugin's skills and the
// CLI and op texts are checked.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A $FR_PORT, ${FR_PORT}, $FR_LEASE or $FR_DEVICE not written inside single quotes, on a line that runs fr serial lease. */
export function unquotedLeaseVars(line: string): string[] {
  if (!/fr serial lease\b/.test(line)) {
    return [];
  }
  const bad: string[] = [];
  for (const m of line.matchAll(/\$\{?FR_(PORT|LEASE|DEVICE)\}?/g)) {
    const before = line[m.index - 1];
    const after = line[m.index + m[0].length];
    if (!(before === "'" && after === "'")) {
      bad.push(m[0]);
    }
  }
  return bad;
}

describe('lease commands in the docs', () => {
  it('flags the double-quoted and the bare forms, not the single-quoted one', () => {
    expect(unquotedLeaseVars('fr serial lease pad -- idf.py -p "$FR_PORT" monitor')).toEqual(['$FR_PORT']);
    expect(unquotedLeaseVars('fr serial lease pad -- esptool --port $FR_PORT chip-id')).toEqual(['$FR_PORT']);
    expect(unquotedLeaseVars("fr serial lease pad -- idf.py -p '$FR_PORT' monitor")).toEqual([]);
    expect(unquotedLeaseVars('it sets `FR_PORT` and releases on exit')).toEqual([]);
  });

  it('every tracked text file teaches the single-quoted form', () => {
    const files = execFileSync('git', ['ls-files', '*.md', '*.ts', '*.tsx', '*.sh', '*.yaml'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f && !f.startsWith('clock/') && f !== 'packages/cli/test/docs-commands.test.ts');
    const found: string[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(join(ROOT, f), 'utf8');
      } catch {
        continue; // deleted in the working tree
      }
      text.split('\n').forEach((line, i) => {
        if (unquotedLeaseVars(line).length) {
          found.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(found).toEqual([]);
  });
});
