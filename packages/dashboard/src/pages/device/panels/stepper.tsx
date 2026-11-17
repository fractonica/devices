// The fr.stepper panel (design stepper-s1 D15): the generic readings and settings, with a Motor block over them.
// - Headline: the position and the motion word ("as last seen" while the device is away: the LED panel's pattern).
// - Quick: STOP, only while a motion runs.
// - Lens: the Motor block over GenericBody: the shaft dial (the position's mark on one turn, the target's, the motion
//   word under it), the nudges (move_by a turn or a full step either way), GO TO (move_to), SPIN back and forward at
//   half the top speed (jog), STOP, HALT, HOLD and LET GO; the fault line while motion is fault; and, while the position
//   is not known, the way to set it here (zero). The settings stay in the generic Actions (configure).
// The arithmetic is state/stepper.ts. No button here says "Send".

import './stepper.css';

import { useState } from 'react';

import { useAct, useLive } from '../../../hooks.ts';
import { commandDoes, enumWords, memberValueText } from '../../../state/cap-words.ts';
import { dialFraction, faultMessage, isRunning, lastFault, type Motion, motionOf, nudges, parsePosition, spinSpeed, stepsPerTurn } from '../../../state/stepper.ts';
import { Button, ButtonRow, engrave, ErrorLine, Reading, Row, Section, TextField, useFractonica } from '../../../ui/index.ts';
import type { CapPanel, CapPanelProps } from '../panels.ts';
import { GenericBody, isAway } from './generic.tsx';

const CAP = 'fr.stepper';
/** The commands the Motor block runs; Engineering says "the <instance> page does this" for them. */
const COVERS = ['move_to', 'move_by', 'jog', 'stop', 'halt', 'hold', 'release'] as const;
/** The dial draws a tick per full step up to this many in a turn; more would be a grey band. */
const MAX_TICKS = 72;

/** A number the motor reports as its count (positions and steps have no unit): grouped as the core groups counts. */
function useCount(): (n: number) => string {
  const core = useFractonica();
  return (n) => memberValueText(core, CAP, { name: 'position' }, n).text;
}

/** command_send on this motor; an answer other than OK is a toast (the LED panel's way). */
function useMotorAct(inst: string) {
  return useAct('command_send', {
    done: (r) => (r.results[0]?.status === 'ok' ? undefined : { tone: 'warn', title: `${inst}: ${r.results[0]?.status.replace(/_/g, ' ') ?? 'no answer'}`, ...(r.results[0]?.error ? { body: r.results[0].error } : {}) }),
  });
}

function motionWord(m: Motion): string {
  return enumWords(CAP, 'Motion', m);
}

function StepperHeadline({ detail, mirror }: CapPanelProps) {
  const count = useCount();
  const position = mirror.position;
  const motion = motionOf(mirror.motion);
  if (typeof position !== 'number') {
    return <span className="ash">not reported yet</span>;
  }
  // while the device is away the mirror holds what it last said, not where the shaft is now
  const away = isAway(detail.presence);
  return (
    <span className={away ? 'dev-headline ash' : 'dev-headline'} data-stale={away ? 'true' : undefined} data-motion={motion ?? undefined}>
      <Reading text={count(position)} />
      {motion ? <span className={motion === 'fault' ? 'stepper-fault-word' : 'ash'}>{motionWord(motion)}</span> : null}
      {away ? <span className="dev-headline-note">as last seen</span> : null}
    </span>
  );
}

/** The Overview row's one control: STOP, while a motion runs. */
function StepperQuick({ detail, inst, mirror }: CapPanelProps) {
  const act = useMotorAct(inst.name);
  if (!isRunning(motionOf(mirror.motion))) {
    return null;
  }
  return (
    <Button variant="quiet" busy={act.isPending} disabled={isAway(detail.presence)} aria-label={`Stop ${inst.name}`} data-stepper="quick-stop" onClick={() => act.mutate({ selector: `id:${detail.device_id}`, command: `${inst.name}.stop`, args: {} })}>
      stop
    </Button>
  );
}

const pt = (r: number, f: number) => {
  const a = -Math.PI / 2 + f * Math.PI * 2;
  return [r * Math.cos(a), r * Math.sin(a)] as const;
};
const f2 = (n: number) => n.toFixed(2);

/**
 * The shaft on one turn: a ring with a tick per full step, the position's mark (lumen; hollow while the position is
 * not known), the target's bead while a move runs elsewhere, the position in the middle and the motion word under it.
 */
export function ShaftDial({ inst, position, target, perTurn, stepsPerRev, motion, known, size = 184 }: { inst: string; position: number | null; target: number | null; perTurn: number | null; stepsPerRev: number | null; motion: Motion | null; known: boolean; size?: number }) {
  const count = useCount();
  const r = size / 2 - 10;
  const at = position !== null && perTurn !== null ? dialFraction(position, perTurn) : null;
  const goal = target !== null && perTurn !== null && target !== position ? dialFraction(target, perTurn) : null;
  const ticks = stepsPerRev !== null && stepsPerRev <= MAX_TICKS ? stepsPerRev : 0;
  const word = motion ? motionWord(motion) : 'not reported yet';
  const label = `${inst} shaft: ${position === null ? 'position not reported yet' : `position ${count(position)}${known ? '' : ', not known'}`}${goal !== null && target !== null ? `, going to ${count(target)}` : ''}, ${word}`;
  return (
    <figure className="stepper-dial" data-motion={motion ?? undefined} data-known={known ? 'true' : 'false'} data-turn={at === null ? undefined : at.toFixed(4)}>
      <svg width={size} height={size} viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} role="img" aria-label={label}>
        <circle className="stepper-dial-ring" r={f2(r)} />
        {Array.from({ length: ticks }, (_, i) => {
          const [x0, y0] = pt(r - 4, i / ticks);
          const [x1, y1] = pt(r, i / ticks);
          return <line key={i} className={i === 0 ? 'stepper-dial-tick zero' : 'stepper-dial-tick'} x1={f2(x0)} y1={f2(y0)} x2={f2(x1)} y2={f2(y1)} />;
        })}
        {goal !== null ? <circle className="stepper-dial-target" data-mark="target" cx={f2(pt(r, goal)[0])} cy={f2(pt(r, goal)[1])} r={3.4} /> : null}
        {at !== null ? (
          <g className="stepper-dial-mark" data-mark="position">
            <line x1={f2(pt(r * 0.62, at)[0])} y1={f2(pt(r * 0.62, at)[1])} x2={f2(pt(r + 6, at)[0])} y2={f2(pt(r + 6, at)[1])} />
            <circle cx={f2(pt(r, at)[0])} cy={f2(pt(r, at)[1])} r={3} />
          </g>
        ) : null}
        <text className="stepper-dial-reading" y={-2}>
          {position === null ? '—' : count(position)}
        </text>
        <text className="stepper-dial-sub" y={16}>
          {engrave(known ? 'steps' : 'not known')}
        </text>
      </svg>
      <figcaption className="stepper-dial-word caps">{engrave(word)}</figcaption>
    </figure>
  );
}

function MotorBlock({ detail, inst, mirror }: CapPanelProps) {
  const deviceId = detail.device_id;
  const name = inst.name;
  const away = isAway(detail.presence);
  const act = useMotorAct(name);
  const [pressed, setPressed] = useState<string | null>(null);
  const [goTo, setGoTo] = useState('');
  const [tried, setTried] = useState(false);
  const fault = useLive((s) => lastFault(s.events, deviceId, name));
  const count = useCount();

  const position = typeof mirror.position === 'number' ? mirror.position : null;
  const target = typeof mirror.target === 'number' ? mirror.target : null;
  const motion = motionOf(mirror.motion);
  const known = mirror.position_known === true;
  const stepsPerRev = typeof mirror.steps_per_rev === 'number' ? mirror.steps_per_rev : null;
  const perTurn = stepsPerTurn(mirror.steps_per_rev, mirror.step_mode);
  const steps = nudges(mirror.steps_per_rev, mirror.step_mode);
  const spin = spinSpeed(mirror.max_speed_hz);
  const parsed = parsePosition(goTo);

  const run = (key: string, command: string, args: Record<string, unknown> = {}) => {
    setPressed(key);
    act.mutate({ selector: `id:${deviceId}`, command: `${name}.${command}`, args });
  };
  const busy = (key: string) => act.isPending && pressed === key;
  const plain = (command: string, words: string) => (
    <Button key={command} busy={busy(command)} disabled={away} data-stepper={command} title={commandDoes(CAP, command, name) ?? undefined} aria-label={`${words} ${name}`} onClick={() => run(command, command)}>
      {words}
    </Button>
  );

  return (
    <Section title="Motor">
      <div className="stepper" data-stepper-block={name}>
        <ShaftDial inst={name} position={position} target={target} perTurn={perTurn} stepsPerRev={stepsPerRev} motion={motion} known={known} />
        <div className="stepper-controls">
          {motion === 'fault' ? <ErrorLine code="fault" message={faultMessage(fault?.fields?.cause, fault?.fields?.recent)} fix={{ label: 'hold', onClick: () => run('fault-hold', 'hold'), busy: busy('fault-hold') }} /> : null}
          {!known ? (
            <Row
              label="Position"
              id={`${name}.zero`}
              value={<span className="ash">not known</span>}
              actions={
                <Button variant="quiet" busy={busy('zero')} disabled={away || isRunning(motion)} data-stepper="zero" aria-label={`Set the position of ${name} here`} onClick={() => run('zero', 'zero')}>
                  set position here
                </Button>
              }
            />
          ) : null}
          <div className="stepper-group" data-stepper-group="nudge">
            <span className="stepper-label caps">{engrave('turn by')}</span>
            {steps.length ? (
              <ButtonRow>
                {steps.map((n) => (
                  <Button key={n.label} variant="quiet" busy={busy(n.label)} disabled={away} data-nudge={n.steps} aria-label={`Turn ${name} by ${n.label}`} onClick={() => run(n.label, 'move_by', { steps: n.steps })}>
                    {n.label}
                  </Button>
                ))}
              </ButtonRow>
            ) : (
              <span className="ash">the step mode is not reported yet</span>
            )}
          </div>
          <form
            className="stepper-goto"
            data-stepper-group="goto"
            onSubmit={(e) => {
              e.preventDefault();
              setTried(true);
              if (parsed.ok) {
                run('goto', 'move_to', { position: parsed.value });
              }
            }}
          >
            <TextField label="Go to" value={goTo} onChange={setGoTo} inputMode="numeric" placeholder={position === null ? 'a position' : count(position)} error={tried && goTo.trim() !== '' && !parsed.ok ? parsed.error : undefined} disabled={away} />
            <Button type="submit" busy={busy('goto')} disabled={away || goTo.trim() === ''} data-stepper="goto" aria-label={`Go to the position given, ${name}`}>
              go to
            </Button>
          </form>
          <div className="stepper-group" data-stepper-group="spin">
            <span className="stepper-label caps">{engrave('spin')}</span>
            <ButtonRow>
              <Button variant="quiet" busy={busy('spin-back')} disabled={away || spin === null} data-spin={spin === null ? undefined : -spin} aria-label={`Spin ${name} back`} onClick={() => spin !== null && run('spin-back', 'jog', { speed_hz: -spin })}>
                back
              </Button>
              <Button variant="quiet" busy={busy('spin-forward')} disabled={away || spin === null} data-spin={spin ?? undefined} aria-label={`Spin ${name} forward`} onClick={() => spin !== null && run('spin-forward', 'jog', { speed_hz: spin })}>
                forward
              </Button>
            </ButtonRow>
          </div>
          <ButtonRow>
            {plain('stop', 'stop')}
            {plain('halt', 'halt')}
            {plain('hold', 'hold')}
            {plain('release', 'let go')}
          </ButtonRow>
        </div>
      </div>
    </Section>
  );
}

// The Motor block leads, over the generic body rather than as its `extra`: GenericBody puts `extra` under the
// Readings, and a stepper's twenty readings would push the motor's controls below the fold.
function StepperLens(props: CapPanelProps) {
  return (
    <div className="stepper-lens">
      <MotorBlock {...props} />
      <GenericBody {...props} skip={COVERS} />
    </div>
  );
}

export const STEPPER_PANEL: CapPanel = { Lens: StepperLens, Headline: StepperHeadline, Quick: StepperQuick, covers: COVERS };
