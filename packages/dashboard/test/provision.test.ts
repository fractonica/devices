// The Provision page's logic (state/provision.ts): its six steps, the profiles for the board's chip (the ports are
// test/ports.test.ts), the dial of a job (sub-stages of the sidecar count
// as their hub stage, only measured stages light a fraction), an update's rings, the deploy targets and a preview's
// plan, the "Build and provision" chain in the URL, and the hub's texts made free of Earth units for pure mode.

import { describe, expect, it } from 'vitest';

import {
  aliasTaken,
  BUILD_STAGES,
  chainSearch,
  chainState,
  chipFromError,
  defaultAlias,
  deployTargets,
  errorFixKind,
  firmwareJobs,
  jobBead,
  jobDial,
  jobPosition,
  otaDial,
  otaFleetDial,
  OTA_STAGES,
  pageSteps,
  planDevices,
  planLine,
  planUpdates,
  profileChoices,
  provisionDial,
  readChain,
  stageIndex,
  stageWord,
} from '../src/state/provision.ts';
import { earthless } from '../src/state/pure-text.ts';
import { PROVISION_STAGES, WIZARD_CLOSED, wizardReducer, type WizardJob, type WizardState } from '../src/state/wizard.ts';

const job = (j: Partial<WizardJob>): WizardJob => ({ job_id: 'j_1', status: 'working', stages: [], detail: false, ...j });

describe('the six steps', () => {
  it('follow the wizard: done before, current (board and name together), to do after; a failed flash in fault', () => {
    const st = (s: Partial<WizardState>) => pageSteps({ ...WIZARD_CLOSED, ...s }).map((x) => x.status);
    expect(st({ step: 'detect' })).toEqual(['current', 'todo', 'todo', 'todo', 'todo', 'todo']);
    expect(st({ step: 'network' })).toEqual(['done', 'current', 'todo', 'todo', 'todo', 'todo']);
    expect(st({ step: 'profile' })).toEqual(['done', 'done', 'current', 'current', 'todo', 'todo']);
    expect(st({ step: 'flash' })).toEqual(['done', 'done', 'done', 'done', 'current', 'todo']);
    expect(st({ step: 'flash', error: { code: 'TIMEOUT', message: 'x', human: [], candidates: [] } })[4]).toBe('failed');
    expect(st({ step: 'done' })).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
  });
});

describe('board and name', () => {
  it('read the chip a probe named in the hub error', () => {
    expect(chipFromError({ code: 'NOT_FOUND', message: 'no debug artifact is built for an esp32c6 board' })).toBe('esp32c6');
    expect(chipFromError({ code: 'INVALID_ARGS', message: 'artifacts for several esp32c3 profiles exist (c3o-pad, c3o-analog)' })).toBe('esp32c3');
    expect(chipFromError({ code: 'TARGET_MISMATCH', message: 'b is for esp32c3, but the board on /dev/x is an esp32s3' })).toBe('esp32s3');
    expect(chipFromError({ code: 'PORT_BUSY_EXTERNAL', message: 'an esp32c6 is held' })).toBeNull();
    // a network's refusal names the chip that would fit; the board's chip is the one it says the board is
    expect(
      chipFromError({ code: 'INCOMPATIBLE_PROFILE', message: 'network lab-5g is 5 GHz only (band 5g), but porch-light is an esp32c6, which has no 5 GHz radio (only esp32c5 has)' }),
    ).toBe('esp32c6');
    expect(chipFromError({ code: 'INCOMPATIBLE_PROFILE', message: 'network lab-5g is 5g only; only esp32c5 has the radio' })).toBeNull();
    expect(chipFromError({ code: 'INVALID_ARGS', message: 'x', details: { chip: 'ESP32C6' } })).toBe('esp32c6');
  });

  it('put the profiles for the chip first, built before unbuilt', () => {
    const list = profileChoices(
      [
        { profile: 'c3o-pad', chip: 'esp32c3', built: true },
        { profile: 'c6-pad-mono', chip: 'esp32c6', built: false },
        { profile: 'c6-pad', chip: 'esp32c6', built: true },
      ],
      'esp32c6',
    );
    expect(list.map((p) => [p.profile, p.matches])).toEqual([
      ['c6-pad', true],
      ['c6-pad-mono', true],
      ['c3o-pad', false],
    ]);
    expect(profileChoices([{ profile: 'b', built: false }, { profile: 'a', built: true }], null).map((p) => p.profile)).toEqual(['a', 'b']);
  });

  it("know the hub's default alias and an alias another device has", () => {
    const s = { known: null, port: { path: '/dev/x', usb_serial: '02:F2:00:00:00:07', state: 'open' }, profile: 'c6-pad' };
    expect(defaultAlias(s)).toBe('c6-pad-000007');
    expect(defaultAlias({ ...s, profile: '' })).toBeNull();
    expect(defaultAlias({ ...s, known: { device_id: '02f200000007', alias: 'porch-lamp', profile: null } })).toBe('porch-lamp');
    const devices = [{ alias: 'desk-pad', device_id: '02f200000001' }];
    expect(aliasTaken('Desk-Pad', devices, '02f200000007')).toMatch(/taken/);
    expect(aliasTaken('desk-pad', devices, '02f200000001')).toBeNull();
    expect(aliasTaken('', devices, undefined)).toBeNull();
  });
});

describe('the dial', () => {
  it("counts the sidecar's own steps as their hub stage, and lights a fraction only where the hub measures one", () => {
    expect(stageIndex(PROVISION_STAGES, { stage: 'write', stages: ['lease', 'probe', 'connect', 'select', 'flash', 'write'] })).toBe(5);
    expect(stageIndex(PROVISION_STAGES, { stage: 'connect' })).toBe(1);
    expect(stageIndex(PROVISION_STAGES, { stage: 'mystery', stages: ['lease', 'registry'] })).toBe(3);
    expect(jobPosition(PROVISION_STAGES, job({ stage: 'write', progress: { pct: 40 } }))).toEqual({ current: 5, failed: false, fraction: 0.4 });
    // a stale pct of the flash says nothing about the join
    expect(jobPosition(PROVISION_STAGES, job({ stage: 'join', progress: { pct: 100 } }))).toEqual({ current: 8, failed: false });
    expect(jobPosition(PROVISION_STAGES, job({ status: 'completed', stage: 'join' })).current).toBe(9);
    // a cancel is a person's choice, not an error: the ring stops where it was, nothing in fault
    expect(jobPosition(PROVISION_STAGES, job({ status: 'cancelled', stage: 'flash' }))).toMatchObject({ current: 5, failed: false, stopped: true, word: 'stopped' });
    expect(jobPosition(PROVISION_STAGES, null)).toEqual({ current: 0, failed: false });
  });

  it('puts the build of "Build and provision" in front of the nine stages, one ring for both', () => {
    expect(provisionDial({ job: null, build: null, error: null })).toMatchObject({ stages: PROVISION_STAGES, current: 0, failed: false });
    const compiling = provisionDial({ job: null, build: job({ stage: 'compile', progress: { pct: 25 } }), error: null });
    expect(compiling).toMatchObject({ current: 2, fraction: 0.25, failed: false });
    expect(compiling.stages).toEqual([...BUILD_STAGES, ...PROVISION_STAGES]);
    expect(provisionDial({ job: null, build: job({ status: 'completed' }), error: null }).current).toBe(4);
    expect(provisionDial({ job: job({ stage: 'probe' }), build: job({ status: 'completed' }), error: null }).current).toBe(5);
    expect(provisionDial({ job: null, build: job({ status: 'failed', stage: 'idf_env' }), error: null })).toMatchObject({ current: 1, failed: true });
    // flashed but not on Wi-Fi: every arc lit but JOIN, which is in fault (light means done)
    const notJoined = provisionDial({ job: job({ status: 'completed' }), build: null, error: null, result: { wifi: 'not_joined' } as never });
    expect(notJoined).toMatchObject({ current: 8, failed: true, word: 'flashed' });
    expect(notJoined.arcs?.map((a) => a.status)).toEqual([...Array(8).fill('done'), 'failed']);
    expect(provisionDial({ job: job({ status: 'completed' }), build: null, error: null, result: { wifi: 'joined' } as never })).toMatchObject({ current: 9, failed: false });
    expect(provisionDial({ job: job({ status: 'completed' }), build: null, error: null, result: { wifi: 'joined' } as never }).arcs).toBeUndefined();
    // device_provision refused before a job existed
    expect(provisionDial({ job: null, build: null, error: { code: 'LOCKED', message: 'x', human: [], candidates: [] } }).failed).toBe(true);
    expect(stageWord('idf_env')).toBe('toolchain');
  });

  it("draws any job on its own stages, and an update's devices as rings", () => {
    expect(jobDial({ kind: 'build', status: 'working', stage: 'compile' })).toMatchObject({ stages: BUILD_STAGES, current: 2 });
    expect(jobDial({ kind: 'deploy', status: 'working', stage: 'update' }, ['build', 'update'])).toMatchObject({ stages: ['build', 'update'], current: 1 });
    expect(otaDial({ state: 'DOWNLOADING', bytes: 300, size: 1200 })).toMatchObject({ stages: OTA_STAGES, current: 2, fraction: 0.25, failed: false });
    expect(otaDial({ state: 'SUCCEEDED', bytes: 1200, size: 1200 })).toMatchObject({ current: 6, word: 'updated' });
    expect(otaDial({ state: 'ROLLED_BACK', bytes: 1200, size: 1200 })).toMatchObject({ current: 5, failed: true, word: 'rolled back' });
    expect(otaDial({ state: 'FAILED', bytes: 0, size: 1200 })).toMatchObject({ current: 1, failed: true });
    const fleet = otaFleetDial([
      { alias: 'a', state: 'SUCCEEDED', bytes: 1, size: 1 },
      { alias: 'b', state: 'DOWNLOADING', bytes: 1, size: 2 },
      { alias: 'c', state: 'QUEUED', bytes: 0, size: 2 },
    ]);
    expect(fleet).toMatchObject({ stages: ['a', 'b', 'c'], current: 1, failed: false, word: 'updating' });
    expect(fleet.arcs?.map((a) => a.status)).toEqual(['done', 'current', 'todo']);
    expect(fleet.arcs?.[1]?.fraction).toBeCloseTo(2.5 / 6);
    expect(otaFleetDial([{ alias: 'a', state: 'FAILED', bytes: 0, size: 1 }])).toMatchObject({ failed: true, word: 'ended' });
    expect([jobBead('completed'), jobBead('working'), jobBead('failed'), jobBead('cancelled'), jobBead('queued')]).toEqual(['online', 'waiting', 'fault', 'offline', 'idle']);
    expect(firmwareJobs([{ kind: 'build' }, { kind: 'msg' }, { kind: 'ota' }]).map((j) => j.kind)).toEqual(['build', 'ota']);
  });
});

describe('over the air', () => {
  it('names every device, each profile, each tag and each device, never the fixture', () => {
    const t = deployTargets([
      { alias: 'b-pad', profile: 'c6-pad', tags: ['hall'], role: 'node' },
      { alias: 'a-pad', profile: 'c6-pad', tags: [], role: 'node' },
      { alias: 'fix', profile: 's3k-fixture', tags: [], role: 'fixture' },
    ]);
    expect(t.map((x) => [x.value, x.count])).toEqual([
      ['all', 2],
      ['profile:c6-pad', 2],
      ['tag:hall', 1],
      ['a-pad', 1],
      ['b-pad', 1],
    ]);
    expect(deployTargets([])).toEqual([]);
  });

  it("reads a dry run's plan and says what each device would do", () => {
    const plan = planDevices({
      dry_run: true,
      devices: [
        { device_id: '1', alias: 'a', action: 'ota', via: 'wifi', build_id: 'b' },
        { device_id: '2', alias: 'b', action: 'ota', via: 'serial', warnings: ['b is offline'] },
        { device_id: '3', alias: 'c', action: 'already_current' },
        { device_id: '4', alias: 'd', action: 'skip', code: 'no_artifact', message: 'no build' },
        { nonsense: true },
      ],
    });
    expect(plan.map((d) => planLine(d))).toEqual([
      { bead: 'online', text: 'update over Wi-Fi' },
      { bead: 'waiting', text: 'update over USB' },
      { bead: 'idle', text: 'already current' },
      { bead: 'offline', text: 'skipped: no artifact' },
    ]);
    expect(planUpdates(plan)).toBe(2);
    expect(planDevices(null)).toEqual([]);
  });
});

describe('the chain and the texts', () => {
  it('keeps "Build and provision" in the URL, so a reload during the build still provisions', () => {
    const c = { port: '02f200000007', profile: 'c6-pad-mono', alias: 'porch-lamp', network: 'lab' };
    expect(readChain(chainSearch(c))).toEqual(c);
    expect(readChain({ then: 'provision', port: 'p' })).toBeNull();
    expect(readChain({ view: 'ota' })).toBeNull();
    const s = chainState({ port: '02f200000007', profile: 'c6-pad-mono' }, WIZARD_CLOSED);
    expect(s).toMatchObject({ step: 'flash', profile: 'c6-pad-mono', alias: '', networkName: '', port: { path: '02f200000007' } });
    // the build's frames then go into it, and the provision input names the port and profile
    const built = wizardReducer(s, { type: 'build', job: { job_id: 'j_b', status: 'completed' }, full: true });
    expect(built.build?.status).toBe('completed');
  });

  it("takes the hub's Earth measures out of its texts for pure mode, keeping the sentence", () => {
    expect(earthless('attic-pad is unknown: the OFFER is retried after 5, 15 and 45 s')).toBe('attic-pad is unknown: the OFFER is retried');
    expect(earthless('porch-lamp was flashed and registered, but sent no HELLO on serial within 10 s')).toBe('porch-lamp was flashed and registered, but sent no HELLO on serial');
    expect(earthless('lab is 5 GHz only (band 5g), but it is an esp32c6')).toBe('lab is 5g only, but it is an esp32c6');
    expect(earthless('the image is 1.2 MB')).not.toMatch(/MB/);
    expect(earthless('plain words')).toBe('plain words');
  });

  it('picks the fix the page offers for a provisioning error', () => {
    expect(errorFixKind({ code: 'PORT_BUSY_EXTERNAL', message: '' })).toBe('port');
    // a name another device has: back to the name, not a retry of the same request
    expect(errorFixKind({ code: 'INVALID_ARGS', message: 'alias hall-pad is taken by device 02f200000002' })).toBe('name');
    expect(errorFixKind({ code: 'INCOMPATIBLE_PROFILE', message: 'network lab is 5 GHz only' })).toBe('network');
    expect(errorFixKind({ code: 'NOT_FOUND', message: 'no debug artifact is built for an esp32c6 board' })).toBe('profile');
    expect(errorFixKind({ code: 'INVALID_ARGS', message: 'several', candidates: ['a', 'b'] })).toBeNull();
    expect(errorFixKind({ code: 'TIMEOUT', message: 'no HELLO' })).toBe('retry');
  });
});

describe('an update skipped before it sent a byte', () => {
  it('stops at the offer, whatever the row says of its bytes', () => {
    expect(otaDial({ state: 'FAILED', bytes: undefined as unknown as number, size: undefined as unknown as number })).toMatchObject({ current: 1, failed: true });
  });
});

describe('a provisioning the hub refused before it started', () => {
  it('says refused on the first arc', () => {
    expect(provisionDial({ job: null, build: null, error: { code: 'INCOMPATIBLE_PROFILE', message: 'network lab-5g is 5 GHz only', human: [], candidates: [] } })).toMatchObject({ current: 0, failed: true, word: 'refused' });
  });
});
