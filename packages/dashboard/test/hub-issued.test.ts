// Fields only the hub can issue (src/state/hub-issued.ts; DEVICE-SPEC rule G3): the table matches the catalog, so a
// capability that gains a hub-issued field cannot slip a form a person cannot fill onto the device page.

import { describe, expect, it } from 'vitest';

import { CATALOG } from '@fractonica/protocol/gen';

import { HUB_ISSUED, hubIssuedFields, hubWay, isHubIssued } from '../src/state/hub-issued.ts';

describe('hub-issued fields', () => {
  it('lists every catalog field whose doc says the hub issues it', () => {
    for (const cap of CATALOG.capabilities) {
      for (const cmd of cap.commands) {
        for (const f of cmd.fields) {
          if (/issued by the hub/i.test(f.doc ?? '')) {
            expect(hubIssuedFields(cap.name, cmd), `${cap.name} ${cmd.name}.${f.name}`).toContain(f.name);
          }
        }
      }
    }
  });

  it('names only real capabilities, commands and fields, each with a way the hub runs it', () => {
    for (const [capName, cmds] of Object.entries(HUB_ISSUED)) {
      const cap = CATALOG.capabilities.find((c) => c.name === capName);
      expect(cap, capName).toBeDefined();
      expect(hubWay(capName), capName).not.toBeNull();
      for (const [cmdName, fields] of Object.entries(cmds)) {
        const cmd = cap!.commands.find((c) => c.name === cmdName);
        expect(cmd, `${capName} ${cmdName}`).toBeDefined();
        for (const f of fields) {
          expect(cmd!.fields.some((x) => x.name === f), `${capName} ${cmdName}.${f}`).toBe(true);
        }
      }
    }
  });

  it('marks the camera stream commands and leaves set and sd_delete fillable', () => {
    expect(isHubIssued('fr.camera', 'stream_start')).toBe(true);
    expect(isHubIssued('fr.camera', 'sd_fetch')).toBe(true);
    expect(isHubIssued('fr.camera', 'stream_stop')).toBe(true);
    expect(isHubIssued('fr.camera', 'set')).toBe(false);
    expect(isHubIssued('fr.camera', 'sd_delete')).toBe(false);
    expect(isHubIssued('fr.led', 'set')).toBe(false);
  });
});
