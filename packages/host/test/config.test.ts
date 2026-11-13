// liveConfig (config.ts): the hub's reader of config.json. A section the file stops giving keeps its last good value
// (`held`); one never read cleanly since the start is `unset`; the problem list is told when it changes.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { liveConfig, readConfig } from '../src/config.ts';

const dir = mkdtempSync(join(tmpdir(), 'fr-config-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('readConfig', () => {
  it('names the part with a problem', () => {
    const file = join(dir, 'parts.json');
    writeFileSync(file, JSON.stringify({ ports: { ignore: 'x' }, retention: { jobs_days: 90 } }));
    expect(readConfig(file).bad).toEqual(['ports']);
    writeFileSync(file, '{');
    expect(readConfig(file).bad).toEqual(['file']);
    writeFileSync(file, '{}');
    expect(readConfig(file).bad).toEqual([]);
  });
});

describe('liveConfig', () => {
  it('holds the last good sections through a broken edit, and tells each change of the problems', () => {
    const file = join(dir, 'live.json');
    writeFileSync(file, JSON.stringify({ ports: { ignore: ['aabbcc000001'] }, retention: { jobs_days: 90 } }));
    const told: string[][] = [];
    const cfg = liveConfig(file, { onProblems: (p) => told.push(p) });
    expect(cfg.read()).toMatchObject({ held: [], unset: [], problems: [] });
    writeFileSync(file, '{"ports":{"ignore":["aabbcc000001"],}}');
    const broken = cfg.refresh();
    expect(broken.config.ports.ignore).toEqual(['aabbcc000001']);
    expect(broken.config.retention.jobs_days).toBe(90);
    expect(broken.held).toEqual(['ports', 'retention', 'log', 'mcp']);
    expect(broken.problems.join('\n')).toMatch(/not valid JSON/);
    // Only the retention section wrong: the rest is read, retention held.
    writeFileSync(file, JSON.stringify({ ports: { ignore: [] }, retention: { jobs_days: -1 } }));
    const partial = cfg.refresh();
    expect(partial.config.ports.ignore).toEqual([]);
    expect(partial.config.retention.jobs_days).toBe(90);
    expect(partial.held).toEqual(['retention']);
    writeFileSync(file, JSON.stringify({ ports: { ignore: [] } }));
    expect(cfg.refresh()).toMatchObject({ held: [], problems: [] });
    // First read, broken, fixed: told three distinct lists, then the empty one.
    expect(told.length).toBe(4);
    expect(told[0]).toEqual([]);
    expect(told.at(-1)).toEqual([]);
  });

  it('has no value for a section never read cleanly since the start', () => {
    const file = join(dir, 'never.json');
    writeFileSync(file, '{ "ports": ');
    const r = liveConfig(file).read();
    expect(r.unset).toEqual(['ports', 'retention', 'log', 'mcp']);
    expect(r.problems.join('\n')).toMatch(/opens no port until the file is fixed/);
    // An absent file is the defaults, read cleanly.
    expect(liveConfig(join(dir, 'absent.json')).read()).toMatchObject({ unset: [], held: [], problems: [] });
  });
});
