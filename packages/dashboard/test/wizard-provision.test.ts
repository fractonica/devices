// The provision wizard's stage 4 additions (state/wizard.ts): several stored networks and the one picked (sent as
// device_provision `network`, and accepted by its schema), the chip the registry knows, "Build and provision" (the
// build job in front, then the provision once it is built), going back to a step with "Change", and resuming a job the
// hub runs from its URL.

import { describe, expect, it } from 'vitest';

import { OPS } from '@fractonica/protocol/browser';

import {
  buildReady,
  canSubmit,
  chosenNetwork,
  jobRunning,
  provisionInput,
  WIZARD_CLOSED,
  wizardReducer,
  type WizardAction,
  type WizardState,
} from '../src/state/wizard.ts';

const PORT = { path: '/dev/cu.usbmodem1101', usb_serial: '02:F2:00:00:00:07', device_id: '02f200000007', state: 'unwatched' };
const NETS = [
  { name: 'default', ssid: 'workshop', band: 'auto', password_set: true, devices: 6 },
  { name: 'lab-5g', ssid: 'workshop-5g', band: '5g', password_set: false, devices: 0 },
];

function run(...actions: WizardAction[]): WizardState {
  return actions.reduce(wizardReducer, WIZARD_CLOSED);
}

const accepts = (input: unknown) => OPS.find((o) => o.name === 'device_provision')!.input.safeParse(input);

describe('dashboard provision wizard, stage 4', () => {
  it('lists several networks, takes default unless another is picked, and sends the one picked', () => {
    let s = run({ type: 'networks', networks: NETS }, { type: 'open', port: PORT, known: null });
    expect(s.network).toEqual({ state: 'set', ssid: 'workshop' });
    expect(chosenNetwork(s)?.name).toBe('default');
    s = wizardReducer(s, { type: 'next' });
    expect(s.step).toBe('profile'); // a stored network skips the step
    expect(provisionInput(s)).toEqual({ port: '02:F2:00:00:00:07', wait_s: 0 });
    s = wizardReducer(s, { type: 'useNetwork', name: 'lab-5g' });
    expect(s.network).toEqual({ state: 'set', ssid: 'workshop-5g' });
    expect(provisionInput(s)).toEqual({ port: '02:F2:00:00:00:07', network: 'lab-5g', wait_s: 0 });
    expect(accepts(provisionInput(s)).success).toBe(true);
    expect(wizardReducer(s, { type: 'useNetwork', name: 'nope' })).toBe(s);
    // none stored: the network step asks for one
    const empty = run({ type: 'networks', networks: [] }, { type: 'open', port: PORT, known: null }, { type: 'next' });
    expect([empty.network.state, empty.step]).toEqual(['missing', 'network']);
    // several and none called default: one must be picked
    expect(run({ type: 'networks', networks: [NETS[1]!, { ...NETS[1]!, name: 'x' }] }).network.state).toBe('missing');
    expect(run({ type: 'networks', networks: [NETS[1]!] }).network).toEqual({ state: 'set', ssid: 'workshop-5g' });
  });

  it('keeps what the page loaded across a new port, and takes the chip the registry knows', () => {
    let s = run({ type: 'networks', networks: NETS }, { type: 'profiles', profiles: [{ profile: 'c6-pad', built: true }] });
    s = wizardReducer(s, { type: 'open', port: PORT, known: { device_id: '02f200000007', alias: 'porch-lamp', profile: 'c6-pad', chip: 'esp32c6' } });
    expect(s).toMatchObject({ chip: 'esp32c6', alias: 'porch-lamp', profile: 'c6-pad', profiles: [{ profile: 'c6-pad' }], networks: NETS });
    s = wizardReducer(s, { type: 'chip', chip: 'esp32c3' });
    expect(s.chip).toBe('esp32c3');
  });

  it('builds first for "Build and provision", then provisions with the same state', () => {
    let s = run({ type: 'networks', networks: NETS }, { type: 'open', port: PORT, known: null }, { type: 'next' }, { type: 'profile', profile: 'c6-pad-mono' });
    s = wizardReducer(s, { type: 'buildSubmitted' });
    expect(s.step).toBe('flash');
    s = wizardReducer(s, { type: 'build', job: { job_id: 'j_b', status: 'working', stage: 'generate' }, full: true });
    s = wizardReducer(s, { type: 'build', job: { job_id: 'j_b', status: 'working', stage: 'compile', progress: { pct: 30 } } });
    s = wizardReducer(s, { type: 'build', job: { job_id: 'j_other', status: 'failed' } }); // another job
    expect(s.build).toMatchObject({ stage: 'compile', stages: ['generate', 'compile'], status: 'working' });
    expect(jobRunning(s)).toBe(true);
    expect(canSubmit(s)).toBe(false);
    expect(wizardReducer(s, { type: 'back' })).toBe(s); // nothing goes back while it builds
    expect(buildReady(s)).toBe(false);
    s = wizardReducer(s, { type: 'build', job: { job_id: 'j_b', status: 'completed', stage: 'ingest' } });
    expect(buildReady(s)).toBe(true);
    // the page now starts device_provision: the build stays in front of the job
    s = wizardReducer(s, { type: 'submitted' });
    s = wizardReducer(s, { type: 'job', job: { job_id: 'j_p', status: 'working', stage: 'lease' }, full: true });
    expect(s.build?.status).toBe('completed');
    expect(buildReady(s)).toBe(false);
    expect(wizardReducer(s, { type: 'build', job: { job_id: 'j_b', status: 'completed' }, full: true })).toBe(s);
  });

  it("stops at a failed build with the hub's error", () => {
    let s = run({ type: 'networks', networks: NETS }, { type: 'open', port: PORT, known: null }, { type: 'next' }, { type: 'buildSubmitted' });
    s = wizardReducer(s, { type: 'build', job: { job_id: 'j_b', status: 'working', stage: 'compile' } });
    s = wizardReducer(s, {
      type: 'build',
      job: { job_id: 'j_b', status: 'failed', stage: 'compile', error: { code: 'BUILD_FAILED', message: 'idf.py build failed (exit 2)', retryable: false, hint: 'a missing header' } },
      full: true,
    });
    expect(s.error).toMatchObject({ code: 'BUILD_FAILED', human: ['a missing header'] });
    expect(buildReady(s)).toBe(false);
    expect(jobRunning(s)).toBe(false);
    expect(wizardReducer(s, { type: 'back' })).toMatchObject({ step: 'profile', build: null, error: null });
  });

  it('goes back to an earlier step with "Change", never while a job runs or forward', () => {
    let s = run({ type: 'networks', networks: NETS }, { type: 'open', port: PORT, known: null }, { type: 'next' });
    expect(wizardReducer(s, { type: 'goto', step: 'network' }).step).toBe('network');
    expect(wizardReducer(s, { type: 'goto', step: 'detect' }).step).toBe('detect');
    expect(wizardReducer(s, { type: 'goto', step: 'profile' })).toBe(s);
    s = wizardReducer(s, { type: 'submitted' });
    s = wizardReducer(s, { type: 'job', job: { job_id: 'j_p', status: 'working', stage: 'flash' } });
    expect(wizardReducer(s, { type: 'goto', step: 'detect' })).toBe(s);
    s = wizardReducer(s, { type: 'job', job: { job_id: 'j_p', status: 'failed', error: { code: 'TIMEOUT', message: 'no HELLO', retryable: true } } });
    expect(wizardReducer(s, { type: 'goto', step: 'detect' })).toMatchObject({ step: 'detect', job: null, error: null });
    expect(wizardReducer(WIZARD_CLOSED, { type: 'goto', step: 'detect' })).toBe(WIZARD_CLOSED);
  });

  it('resumes a job the hub runs from its URL: its stage, its port, its end', () => {
    let s = wizardReducer(WIZARD_CLOSED, { type: 'resume', job: { job_id: 'j_p', status: 'working', stage: 'write', progress: { pct: 40 }, targets: ['02f200000007'] } });
    expect(s).toMatchObject({ step: 'flash', port: { path: '02f200000007' }, job: { job_id: 'j_p', stage: 'write', stages: ['write'] } });
    s = wizardReducer(s, { type: 'job', job: { job_id: 'j_p', status: 'completed', result: { device_id: '02f200000007', alias: 'porch-lamp', profile: 'c6-pad', build_id: 'b', fw_id: 'f', wifi: 'joined' } }, full: true });
    expect(s).toMatchObject({ step: 'done', online: true, result: { alias: 'porch-lamp' } });
    const ended = wizardReducer(WIZARD_CLOSED, { type: 'resume', job: { job_id: 'j_x', status: 'failed', error: { code: 'TIMEOUT', message: 'm', retryable: true } } });
    expect(ended.error?.code).toBe('TIMEOUT');
  });
});
