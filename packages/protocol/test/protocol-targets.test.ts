// Where an op runs among the hubs of a network (design multi-hub-m2 §7.1, step 2.2): every op of the registry declares
// its `target`, a selector op its `across`, and the fields that name its boards and its files are fields of its input.
// The lists below are the whole registry by target: a new op must be put in one, on purpose.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { OP_ACROSS, OP_TARGETS, opBoardFields, type OpDef, opRepeatable, OPS, REGISTRY_HASH, REGISTRY_INPUTS_HASH, registryHashOf, registryInputsHashOf } from '../src/index.ts';

const ops = OPS as unknown as readonly OpDef[];
const names = (pick: (o: OpDef) => boolean) => ops.filter(pick).map((o) => o.name).sort();
const words = (text: string) => text.split(/\s+/).filter(Boolean).sort();

describe('where an op runs (target)', () => {
  it('every op declares a target; an op without one is a failure', () => {
    for (const o of ops) {
      expect(OP_TARGETS, `${o.name} has no target: say what it acts on (device, selector, fleet, port or hub)`).toContain(o.target);
    }
    expect(ops.map((o) => o.name).filter((n, i, all) => all.indexOf(n) !== i)).toEqual([]);
  });

  it('the registry by target', () => {
    expect(names((o) => o.target === 'fleet')).toEqual(['device_list', 'job_list']);
    expect(names((o) => o.target === 'port')).toEqual(
      words('device_provision device_reset diag_exec flash_start port_claim port_ignore port_lend port_list serial_lease serial_lease_renew serial_release'),
    );
    expect(names((o) => o.target === 'selector')).toEqual(
      words('command_send deploy display_snapshot events_read input_simulate latency_stats logs_assert logs_read message_send ota_deploy wait_for_device wait_for_event wait_for_log'),
    );
    expect(names((o) => o.target === 'device')).toEqual(
      words(`audio_level audio_monitor audio_play audio_record battery_calibrate battery_load battery_reset_calibration battery_status binding_clear binding_set
        camera_sd_delete camera_sd_fetch camera_sd_list camera_set camera_snap camera_status camera_stream capability_list clock_aging clock_drift clock_read clock_set
        clock_sync csi_status csi_stream device_adopt device_get device_hubs_get device_hubs_set device_update haptic_play haptic_pulse haptic_stop latency_probe
        scale_calibrate scale_read scale_reset_calibration scale_status scale_tare scale_watch storage_bench storage_get storage_info storage_ls storage_mkdir
        storage_put storage_rm`),
    );
    // Everything else acts on the hub that is asked.
    expect(names((o) => o.target === 'hub')).toHaveLength(ops.length - 2 - 11 - 13 - 47);
    for (const name of ['hub_status', 'build_start', 'artifact_list', 'network_join', 'hub_peers', 'job_get', 'job_wait', 'job_logs', 'job_cancel', 'ota_status', 'binding_list', 'time_now', 'cell_test', 'app_deploy']) {
      expect(ops.find((o) => o.name === name)!.target, name).toBe('hub');
    }
  });

  it('a selector op says what happens across hubs, and no other op does', () => {
    for (const o of ops) {
      if (o.target === 'selector') {
        expect(OP_ACROSS, `${o.name} is a selector op: it needs across`).toContain(o.across);
      } else {
        expect(o.across, o.name).toBeUndefined();
      }
    }
    expect(names((o) => o.across === 'split')).toEqual(['command_send', 'input_simulate']);
    expect(names((o) => o.across === 'one')).toEqual(['display_snapshot', 'events_read', 'latency_stats', 'logs_read', 'message_send', 'ota_deploy']);
    expect(names((o) => o.across === 'live')).toEqual(['logs_assert', 'wait_for_device', 'wait_for_event', 'wait_for_log']);
    expect(names((o) => o.across === 'here')).toEqual(['deploy']);
  });

  it('the fields that name boards and files are string fields of the op\'s input', () => {
    const isText = (o: OpDef, field: string) => {
      let s = (o.input.shape as Record<string, z.ZodType | undefined>)[field];
      while (s instanceof z.ZodOptional || s instanceof z.ZodDefault) {
        s = s.unwrap() as z.ZodType;
      }
      return s instanceof z.ZodString;
    };
    for (const o of ops) {
      const boards = opBoardFields(o);
      if (o.target === 'device' || o.target === 'selector') {
        expect(boards.length, `${o.name} names no board`).toBeGreaterThan(0);
      } else {
        expect(o.boards, o.name).toBeUndefined();
        expect(boards).toEqual([]);
      }
      for (const b of boards) {
        expect(isText(o, b.field), `${o.name}.${b.field} is not a text field of its input`).toBe(true);
      }
      for (const f of [...(o.files?.out ?? []), ...(o.files?.in ?? [])]) {
        expect(isText(o, f), `${o.name}.${f} is not a text field of its input`).toBe(true);
      }
      // Every op with an `out` path says so, or its file would stay at the hub that ran it.
      if ('out' in o.input.shape && o.target !== 'hub') {
        expect(o.files?.out, `${o.name} has an out field`).toContain('out');
      }
    }
    expect(opBoardFields(ops.find((o) => o.name === 'binding_set')!)).toEqual([{ field: 'from', dotted: true }, { field: 'to', dotted: true }]);
    expect(opBoardFields(ops.find((o) => o.name === 'latency_probe')!)).toEqual([{ field: 'from', dotted: false }, { field: 'to', dotted: false }]);
    expect(opBoardFields(ops.find((o) => o.name === 'message_send')!)).toEqual([{ field: 'to', dotted: false }]);
    expect(opBoardFields(ops.find((o) => o.name === 'device_get')!)).toEqual([{ field: 'device', dotted: false }]);
    expect(names((o) => !!o.files?.out)).toEqual(words('audio_record camera_sd_fetch camera_snap camera_stream csi_stream display_snapshot scale_watch storage_get'));
    expect(names((o) => !!o.files?.in)).toEqual(['audio_play', 'storage_put']);
  });

  it('what may be tried again after a lost link: the read ops and the ops marked idempotent', () => {
    expect(ops.filter((o) => o.tier === 'read').every(opRepeatable)).toBe(true);
    expect(names((o) => o.tier === 'mutate' && opRepeatable(o))).toEqual(
      words('camera_sd_delete clock_set device_hubs_set device_share device_update haptic_stop hub_name_set network_admit network_set port_claim port_ignore wiring_reset'),
    );
  });

  it('REGISTRY_HASH covers where an op runs; the hash of names and inputs alone does not', () => {
    expect(registryHashOf(ops)).toBe(REGISTRY_HASH);
    expect(registryInputsHashOf(ops)).toBe(REGISTRY_INPUTS_HASH);
    expect(REGISTRY_HASH).not.toBe(REGISTRY_INPUTS_HASH);
    const moved = (change: (o: OpDef) => OpDef) => ops.map((o) => (o.name === 'audio_record' ? change(o) : o));
    for (const other of [moved((o) => ({ ...o, target: 'hub' })), moved((o) => ({ ...o, files: undefined })), moved((o) => ({ ...o, boards: ['instance'] })), moved((o) => ({ ...o, target: 'selector', across: 'one' }))]) {
      expect(registryHashOf(other)).not.toBe(REGISTRY_HASH);
      expect(registryInputsHashOf(other)).toBe(REGISTRY_INPUTS_HASH);
    }
    // Neither covers tier, mcp, summary or output.
    expect(registryHashOf(ops.map((o) => ({ ...o, tier: 'read' as const, mcp: undefined, output: undefined, summary: '' })))).toBe(REGISTRY_HASH);
  });
});
