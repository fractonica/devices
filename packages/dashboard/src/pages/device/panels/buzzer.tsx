// The fr.buzzer panel (design buzzer-b1 D9): a Buzzer block over the generic readings and actions.
// - Headline: playing or quiet ("as last seen" while the device is away: the LED panel's pattern).
// - Quick: BEEP while quiet, STOP while it plays.
// - Lens: the Buzzer block over GenericBody: what it does now and how its last sound ended, the beeps (once, three,
//   until stopped), the tunes (state/buzzer.ts) and STOP. The volume is the generic Readings' slider (volume is linked to
//   set_volume), and a tone, a beep or a melody of one's own are the generic Actions' forms.
// Nothing here is a number: pitches and lengths are the tunes', never shown. No button says "Send".

import './buzzer.css';

import { useState } from 'react';

import { useAct, useLive } from '../../../hooks.ts';
import { commandDoes } from '../../../state/cap-words.ts';
import { BEEPS, doneWords, lastDone, playingOf, TUNES } from '../../../state/buzzer.ts';
import { Button, ButtonRow, engrave, Section } from '../../../ui/index.ts';
import type { CapPanel, CapPanelProps } from '../panels.ts';
import { GenericBody, isAway } from './generic.tsx';

const CAP = 'fr.buzzer';
/** The commands this page runs (the block, and the generic forms under it); Engineering says so for them. */
const COVERS = ['tone', 'beep', 'melody', 'stop', 'set_volume'] as const;
/** What the block runs itself and the generic Actions leave out: STOP (a button with no fields). */
const SKIP = ['stop'] as const;

/** command_send on this buzzer; an answer other than OK is a toast (the LED panel's way). */
function useBuzzerAct(inst: string) {
  return useAct('command_send', {
    done: (r) => (r.results[0]?.status === 'ok' ? undefined : { tone: 'warn', title: `${inst}: ${r.results[0]?.status.replace(/_/g, ' ') ?? 'no answer'}`, ...(r.results[0]?.error ? { body: r.results[0].error } : {}) }),
  });
}

function BuzzerHeadline({ detail, mirror }: CapPanelProps) {
  const playing = playingOf(mirror.playing);
  if (playing === null) {
    return <span className="ash">not reported yet</span>;
  }
  const away = isAway(detail.presence);
  return (
    <span className={away ? 'dev-headline ash' : 'dev-headline'} data-stale={away ? 'true' : undefined} data-playing={playing ? 'true' : 'false'}>
      <span className={playing && !away ? 'buzzer-playing-word' : 'ash'}>{playing ? 'playing' : 'quiet'}</span>
      {away ? <span className="dev-headline-note">as last seen</span> : null}
    </span>
  );
}

/** The Overview row's one control: BEEP while quiet, STOP while it plays. */
function BuzzerQuick({ detail, inst, mirror }: CapPanelProps) {
  const act = useBuzzerAct(inst.name);
  const playing = playingOf(mirror.playing) === true;
  const command = playing ? 'stop' : 'beep';
  return (
    <Button
      variant="quiet"
      busy={act.isPending}
      disabled={isAway(detail.presence)}
      aria-label={`${playing ? 'Stop' : 'Beep'} ${inst.name}`}
      data-buzzer={`quick-${command}`}
      onClick={() => act.mutate({ selector: `id:${detail.device_id}`, command: `${inst.name}.${command}`, args: {} })}
    >
      {command}
    </Button>
  );
}

function BuzzerBlock({ detail, inst, mirror }: CapPanelProps) {
  const deviceId = detail.device_id;
  const name = inst.name;
  const away = isAway(detail.presence);
  const act = useBuzzerAct(name);
  const [pressed, setPressed] = useState<string | null>(null);
  const done = useLive((s) => lastDone(s.events, deviceId, name));
  const playing = playingOf(mirror.playing);
  const ended = doneWords(done?.fields);

  const run = (key: string, command: string, args: Record<string, unknown> = {}) => {
    setPressed(key);
    act.mutate({ selector: `id:${deviceId}`, command: `${name}.${command}`, args });
  };
  const busy = (key: string) => act.isPending && pressed === key;

  return (
    <Section title="Buzzer">
      <div className="buzzer" data-buzzer-block={name}>
        <p className="buzzer-now" data-playing={playing === null ? undefined : String(playing)}>
          <span className={playing ? 'buzzer-playing-word' : 'ash'}>{playing === null ? 'not reported yet' : playing ? 'playing' : 'quiet'}</span>
          {ended ? <span className="ash" data-buzzer="last-done">{ended}</span> : null}
        </p>
        <div className="buzzer-group" data-buzzer-group="beep">
          <span className="buzzer-label caps">{engrave('beep')}</span>
          <ButtonRow>
            {BEEPS.map((b) => (
              <Button key={b.key} variant="quiet" busy={busy(b.key)} disabled={away} data-beep={b.key} title={commandDoes(CAP, 'beep', name) ?? undefined} aria-label={`${b.words}, ${name}`} onClick={() => run(b.key, 'beep', b.args)}>
                {b.words}
              </Button>
            ))}
          </ButtonRow>
        </div>
        <div className="buzzer-group" data-buzzer-group="tunes">
          <span className="buzzer-label caps">{engrave('tunes')}</span>
          <ButtonRow>
            {TUNES.map((t) => (
              <Button key={t.key} variant="quiet" busy={busy(t.key)} disabled={away} data-tune={t.key} title={commandDoes(CAP, 'melody', name) ?? undefined} aria-label={`Play the ${t.words} on ${name}`} onClick={() => run(t.key, 'melody', t.args)}>
                {t.words}
              </Button>
            ))}
          </ButtonRow>
        </div>
        <ButtonRow>
          <Button busy={busy('stop')} disabled={away} data-buzzer="stop" title={commandDoes(CAP, 'stop', name) ?? undefined} aria-label={`Stop ${name}`} onClick={() => run('stop', 'stop')}>
            stop
          </Button>
        </ButtonRow>
      </div>
    </Section>
  );
}

function BuzzerLens(props: CapPanelProps) {
  return (
    <div className="buzzer-lens">
      <BuzzerBlock {...props} />
      <GenericBody {...props} skip={SKIP} />
    </div>
  );
}

export const BUZZER_PANEL: CapPanel = { Lens: BuzzerLens, Headline: BuzzerHeadline, Quick: BuzzerQuick, covers: COVERS };
