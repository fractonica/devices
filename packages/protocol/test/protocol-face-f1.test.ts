// FACE-1 (design face-f1 D2, D11, D18, D19): fr.face 1.0 (0x0014) in the catalog with its keys and sounds, its set
// args on the wire, fr.clock renamed fr.rtc (same id, ops rtc_* on `fr rtc …`), and the registry and catalog hashes
// the rename moves (no new op: the face's commands travel by command_send).

import { describe, expect, it } from 'vitest';

import { CATALOG, CATALOG_HASH, encodeMember } from '@fractonica/protocol/gen';

import { findOp, OPS, REGISTRY_HASH, REGISTRY_INPUTS_HASH } from '../src/index.ts';

describe('fr.face 1.0 (design face-f1 D2)', () => {
  const cap = () => CATALOG.capabilities.find((c) => c.name === 'fr.face')!;

  it('is 0x0014 with its config, properties and three commands', () => {
    expect(cap()).toMatchObject({ id: 0x0014 });
    expect(cap().config.map((c) => c.name)).toEqual([
      'display',
      'button',
      'rtc',
      'left',
      'right',
      'buzzer',
      'mode',
      'focus',
      'step',
      'utc_offset_min',
      'wait_time_s',
      'awake_s',
      'chime',
      'clicks',
    ]);
    expect(Object.fromEntries(cap().config.filter((c) => c.default !== undefined).map((c) => [c.name, c.default]))).toMatchObject({
      mode: 'pure',
      focus: 6,
      step: 'preon',
      utc_offset_min: 0,
      wait_time_s: 30,
      awake_s: 30,
      chime: 'preon',
      clicks: true,
    });
    expect(cap().properties.map((p) => [p.name, p.id])).toEqual([
      ['mode', 1],
      ['screen', 2],
      ['focus', 3],
      ['step', 4],
      ['utc_offset_min', 5],
      ['shown', 6],
      ['time_valid', 7],
      ['time_source', 8],
      ['power_save', 9],
      ['chime', 10],
      ['clicks', 11],
    ]);
    expect(cap().commands.map((c) => [c.name, c.id])).toEqual([
      ['show', 1],
      ['input', 2],
      ['set', 3],
    ]);
    expect(cap().events).toEqual([]);
    expect(cap().traits.map((t) => t.name)).toEqual(['width', 'height', 'can_sleep']);
  });

  it('encodes set with only the fields given, and refuses a focus past 13', () => {
    const one = encodeMember('fr.face', 'args', 'set', { step: 'flavon' });
    const two = encodeMember('fr.face', 'args', 'set', { step: 'flavon', mode: 'earth', power_save: true });
    expect(one.ok && two.ok).toBe(true);
    expect(one.ok && two.ok ? one.value.length < two.value.length : false).toBe(true);
    expect(encodeMember('fr.face', 'args', 'set', { focus: 14 }).ok).toBe(false);
    expect(encodeMember('fr.face', 'args', 'input', { event: 'select' }).ok).toBe(true);
    expect(encodeMember('fr.face', 'args', 'set', { chime: 'helion', clicks: false }).ok).toBe(true);
    expect(encodeMember('fr.face', 'args', 'set', { chime: 'flavon' }).ok).toBe(false);
  });

  it('needs no op of its own: command_send carries its commands', () => {
    expect(OPS.filter((o) => o.name.startsWith('face_'))).toEqual([]);
    expect(findOp('command_send')).toBeDefined();
  });
});

describe('fr.clock renamed fr.rtc (design face-f1 D11)', () => {
  it('keeps the id, renames the capability and its ops, on `fr rtc …`', () => {
    expect(CATALOG.capabilities.find((c) => c.name === 'fr.rtc')).toMatchObject({ id: 0x0010 });
    expect(CATALOG.capabilities.find((c) => c.name === 'fr.clock')).toBeUndefined();
    expect(OPS.filter((o) => o.name.startsWith('clock_'))).toEqual([]);
    for (const verb of ['read', 'sync', 'set', 'aging', 'drift']) {
      expect(findOp(`rtc_${verb}`)?.cli.path, verb).toEqual(['rtc', verb]);
    }
  });

  it('moves the registry and the catalog', () => {
    expect(REGISTRY_INPUTS_HASH).toBe('5447150e8a9b');
    expect(REGISTRY_HASH).toBe('e50fc03cf302');
    expect(CATALOG_HASH).toBe(0x4ba4b62a);  // FACE-1 first 0xd7e86b68; the keys and sounds (D18, D19) 0xc76ae4a2; then this
  });
});
