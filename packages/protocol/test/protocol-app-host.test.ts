// UNOQ-2 (design uno-q-services): the app_* ops, their CLI paths, the manifest, and the registry hash they move.
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { APP_HOST_OPS, AppManifestSchema, findOp, JOB_KINDS, OPS, REGISTRY_HASH } from '../src/index.ts';

const hashOf = (ops: readonly { name: string; input: z.ZodType }[]) =>
  createHash('sha256')
    .update(JSON.stringify(ops.map((o) => [o.name, z.toJSONSchema(o.name === 'hub_doctor' && !ops.some((x) => x.name === 'hub_doctor_fix') ? z.object({}) : o.name === 'device_provision' && !ops.some((x) => x.name === 'device_enroll') ? (o.input as z.ZodObject).omit({ for_hub: true }) : o.input) /* hub_doctor had no input before the dashboard's health; device_provision no for_hub before device_enroll (protocol-for-hub.test.ts) */])))
    .digest('hex')
    .slice(0, 12);
/** The port policy ops came after (protocol-ports.test.ts). */
const beforePorts = OPS.filter((o) => !/^port_(lend|ignore|claim)$|^time_|^hub_doctor_fix$|^device_enroll$|^device_(hubs_set|hubs_get|share)$|^network_join$|^network_admit$|^hub_(name_set|peers)$|^haptic_tap$/.test(o.name));

describe('app ops (design uno-q-services)', () => {
  it('adds ten ops at the end (nine app_ and device_adopt), on their CLI paths, and moves REGISTRY_HASH', () => {
    expect(beforePorts).toHaveLength(115);
    expect(OPS.filter((o) => !/^device_(hubs_set|hubs_get|share)$|^network_join$|^network_admit$|^hub_(name_set|peers)$|^haptic_tap$/.test(o.name)).slice(-14, -4).map((o) => o.name)).toEqual(APP_HOST_OPS.map((o) => o.name)); // the four time ops follow, then the multi-hub ones (protocol-multi-hub.test.ts)
    const want: Record<string, [string[], string, string]> = {
      app_upload: [['app', 'upload'], 'command', 'mutate'],
      app_deploy: [['app', 'install'], 'job', 'mutate'],
      app_list: [['app', 'ls'], 'query', 'read'],
      app_logs: [['app', 'logs'], 'query', 'read'],
      app_env: [['app', 'env'], 'command', 'mutate'],
      app_restart: [['app', 'restart'], 'command', 'mutate'],
      app_stop: [['app', 'stop'], 'command', 'mutate'],
      app_start: [['app', 'start'], 'command', 'mutate'],
      app_remove: [['app', 'rm'], 'command', 'mutate'],
      device_adopt: [['devices', 'adopt'], 'command', 'mutate'],
    };
    for (const [name, [path, kind, tier]] of Object.entries(want)) {
      expect(findOp(name), name).toMatchObject({ kind, tier, cli: { path } });
      expect(findOp(name)!.summary.length, name).toBeLessThan(1000);
    }
    expect(JOB_KINDS).toContain('app');
    expect(hashOf(beforePorts)).toBe('c930b40dea94');
    expect(REGISTRY_HASH).not.toBe('9e6905ab39fd'); // LCD-1's
  });

  it('checks a manifest: name, kind, start, web port, env names', () => {
    expect(AppManifestSchema.safeParse({ name: 'tg-bot', kind: 'worker', start: 'node bot.js', env: ['BOT_TOKEN'] }).success).toBe(true);
    expect(AppManifestSchema.safeParse({ name: 'site', kind: 'web', start: 'node server.js', port: 8080 }).success).toBe(true);
    for (const bad of [
      { name: 'Bot', kind: 'worker', start: 'x' },
      { name: 'b', kind: 'worker', start: 'x' },
      { name: 'bot-', kind: 'worker', start: 'x' },
      { name: 'bot', kind: 'daemon', start: 'x' },
      { name: 'bot', kind: 'worker', start: '' },
      { name: 'bot', kind: 'web', start: 'x', port: 80 },
      { name: 'bot', kind: 'worker', start: 'x', env: ['1BAD'] },
    ]) {
      expect(AppManifestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
