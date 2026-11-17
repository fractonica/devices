// The fr.stepper panel's arithmetic (design stepper-s1 D15): the shaft dial's angle, the nudges' sizes and the spin
// speed, from the mirror's `step_mode`, `steps_per_rev` and `max_speed_hz`. A step is a full step divided by the step
// mode's microsteps (micro8: an eighth), so one turn is steps_per_rev × 2^step_mode steps. DOM-free, tested in node.

/** The capability's StepMode members in wire order: the index is log2 of the microsteps. */
export const STEP_MODES = ['full', 'half', 'micro4', 'micro8', 'micro16', 'micro32'] as const;
/** The capability's Motion members in wire order. */
export const MOTIONS = ['released', 'holding', 'moving', 'stopping', 'fault'] as const;
export type Motion = (typeof MOTIONS)[number];
/** The capability's FaultCause members in wire order. */
export const FAULT_CAUSES = ['driver', 'injected'] as const;

/** The widest position the capability takes (D2: every step quantity is within ±10⁹). */
export const POSITION_MAX = 1_000_000_000;

/** An enum value as the mirror holds it (its name, or its number) as its name; null when it names no member. */
function memberOf<T extends string>(members: readonly T[], v: unknown): T | null {
  if (typeof v === 'number') {
    return members[v] ?? null;
  }
  return typeof v === 'string' && (members as readonly string[]).includes(v) ? (v as T) : null;
}

/** The motion now, by name; null while it is not reported. */
export function motionOf(v: unknown): Motion | null {
  return memberOf(MOTIONS, v);
}

/** True while a motion runs (a move, a jog, or its deceleration): what Stop has to act on. */
export function isRunning(motion: Motion | null): boolean {
  return motion === 'moving' || motion === 'stopping';
}

/** Steps in one full step: 2^step_mode (micro8: 8); null while the step mode is not reported. */
export function microsteps(stepMode: unknown): number | null {
  const name = memberOf(STEP_MODES, stepMode);
  return name === null ? null : 2 ** STEP_MODES.indexOf(name);
}

/** Steps in one turn of the shaft: steps_per_rev × microsteps; null while either is not reported. */
export function stepsPerTurn(stepsPerRev: unknown, stepMode: unknown): number | null {
  const m = microsteps(stepMode);
  return m !== null && typeof stepsPerRev === 'number' && stepsPerRev > 0 ? stepsPerRev * m : null;
}

/** Where `position` puts the shaft's mark, 0..1 of a turn clockwise from the top; negative positions wrap like positive ones. */
export function dialFraction(position: number, perTurn: number): number {
  if (!(perTurn > 0) || !Number.isFinite(position)) {
    return 0;
  }
  // the second remainder wraps a negative position and makes −0 a plain 0
  return (((position % perTurn) + perTurn) % perTurn) / perTurn;
}

export interface Nudge {
  /** The button's words ("−1 turn"). */
  label: string;
  /** move_by's steps. */
  steps: number;
}

/**
 * move_by's nudges: −1 turn, −1 full step, +1 full step, +1 turn. The full steps need the step mode; the turns also
 * steps_per_rev. A nudge whose size is not known yet is left out.
 */
export function nudges(stepsPerRev: unknown, stepMode: unknown): Nudge[] {
  const step = microsteps(stepMode);
  if (step === null) {
    return [];
  }
  const turn = stepsPerTurn(stepsPerRev, stepMode);
  return [
    ...(turn !== null ? [{ label: '−1 turn', steps: -turn }] : []),
    { label: '−1 full step', steps: -step },
    { label: '+1 full step', steps: step },
    ...(turn !== null ? [{ label: '+1 turn', steps: turn }] : []),
  ];
}

/** Spin's speed: half the top speed, at least one step a second; null while max_speed_hz is not reported. */
export function spinSpeed(maxSpeedHz: unknown): number | null {
  return typeof maxSpeedHz === 'number' && maxSpeedHz > 0 ? Math.max(1, Math.floor(maxSpeedHz / 2)) : null;
}

/** A typed position for move_to: an integer within the capability's range, or why not. */
export function parsePosition(text: string): { ok: true; value: number } | { ok: false; error: string } {
  const t = text.trim().replace(/[\s ]/g, '').replace(/^−/, '-');
  if (!/^[-+]?\d+$/.test(t)) {
    return { ok: false, error: 'a whole number of steps' };
  }
  const v = Number(t);
  return Math.abs(v) > POSITION_MAX ? { ok: false, error: 'within a thousand million steps either way' } : { ok: true, value: v };
}

/** What the fault line says (a `fault` event's cause and recent, when one came): the cause, the coils off, HOLD clears it. */
export function faultMessage(cause: unknown, recent: unknown): string {
  const name = memberOf(FAULT_CAUSES, cause);
  const what = name === 'injected' ? 'A fault was injected' : name === 'driver' ? 'The driver reported a fault' : 'The motor is in fault';
  // D2: at 3 faults in the last minute the node refuses to energise for a minute
  const many = typeof recent === 'number' && recent >= 3 ? ` ${recent} faults lately: it refuses to turn for a while.` : '';
  return `${what}; the coils are off. Hold clears it.${many}`;
}

/** The last `fault` event of a device's instance in a ring of events (newest last): its cause and how many lately. */
export function lastFault<E extends { device?: string; type: string; part?: string }>(ring: readonly E[], deviceId: string, instance: string): E | undefined {
  for (let i = ring.length - 1; i >= 0; i--) {
    const e = ring[i]!;
    if (e.device === deviceId && e.part === 'event' && e.type === `${instance}.fault`) {
      return e;
    }
  }
  return undefined;
}
