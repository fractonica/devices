// The fr.haptic panel (design haptic-h1 D11): a Solenoid or a Vibration motor block over the generic readings and actions.
// - Headline: tapping, buzzing or still ("as last seen" while the device is away: the LED panel's pattern).
// - Quick: TAP (a solenoid) or BUZZ (a motor) while still, STOP while it runs.
// - Lens, a solenoid (or a haptic whose build the hub does not know, with the solenoid's limits): what it does now, how
//   its last program ended, its supply; taps at a rate, a strength and a tap length, once, a few times or until stopped,
//   START and STOP, and while a train runs every change goes to the board at most five times a second and keeps the beat;
//   a length the board would refuse at the rate is held back with the longest that fits; the owner's named patterns
//   (double, triple, heartbeat, knock-knock, a roll of ten), greyed with why when the board would refuse them; and the
//   metronome (a tempo, the beats in a bar, the first beat's strength) on the same taps.
// - Lens, a vibration motor: its strength and length, BUZZ, its patterns (short, double, long, heartbeat) and STOP.
// The arithmetic and the words are state/haptic.ts. Lengths and rates are Fractonica spans, their Earth values on the
// Earth line. No button says "Send".

import './haptic.css';

import { useEffect, useRef, useState } from 'react';

import { useAct, useLive } from '../../../hooks.ts';
import type { InstanceView } from '../../../state/caps.ts';
import { commandDoes, memberValueText } from '../../../state/cap-words.ts';
import {
  activeOf,
  BEATS_MAX,
  busyWords,
  COUNTS,
  fastestTempo,
  hapticDoneWords,
  type HapticLimits,
  hapticLimits,
  type HapticSend,
  lastEvent,
  lengthMax,
  LiveSender,
  METRONOME_DEFAULTS,
  metronomeArgs,
  motorPatterns,
  type PatternButton,
  RATE_MAX_HZ,
  RATE_MIN_HZ,
  RATE_STEP_HZ,
  runningWord,
  solenoidPatterns,
  supplyRefuses,
  type SupplyView,
  supplyView,
  TAP_DEFAULTS,
  tapArgs,
  type TapArgs,
  tapCheck,
  tapCheckWords,
  TEMPO_MAX_BPM,
  TEMPO_MIN_BPM,
} from '../../../state/haptic.ts';
import { Button, ButtonRow, Earth, engrave, Reading, Section, Select, Slider, useFractonica } from '../../../ui/index.ts';
import type { CapPanel, CapPanelProps } from '../panels.ts';
import { GenericBody, isAway, MemberValue } from './generic.tsx';

const CAP = 'fr.haptic';
/** The commands this page runs (the block, and the generic forms under it); Engineering says so for them. */
const COVERS = ['pulse', 'play', 'tap', 'stop'] as const;
/** What the block runs itself and the generic Actions leave out: STOP (a button with no fields). */
const SKIP = ['stop'] as const;
/** The Overview's one tap and one buzz. */
const QUICK_TAP = { ms: TAP_DEFAULTS.ms, level: TAP_DEFAULTS.level } as const;
const QUICK_BUZZ = { ms: 300, level: 100 } as const;

/** The device's properties by `<instance>.<member>`: the live store's over the router's mirror. */
function useDeviceProps(detail: CapPanelProps['detail']): Record<string, unknown> {
  const live = useLive((s) => s.properties[detail.device_id]);
  const out: Record<string, unknown> = { ...((detail.router?.properties ?? {}) as Record<string, unknown>) };
  for (const [k, v] of Object.entries(live ?? {})) {
    out[k] = (v as { value?: unknown } | undefined)?.value;
  }
  return out;
}

/** The instance's limits and its supply's reading. */
function useHaptic(props: CapPanelProps): { limits: HapticLimits; supply: SupplyView | null } {
  const limits = hapticLimits(props.inst.config);
  const all = useDeviceProps(props.detail);
  const supplyInst: InstanceView | undefined = limits.supply ? props.instances.find((i) => i.name === limits.supply) : undefined;
  return { limits, supply: supplyView(limits.supply, all, supplyInst?.config) };
}

/** command_send on this haptic; BUSY is said in words (its supply, or its budget), any other refusal as the LED panel's. */
function useHapticAct(inst: string, limits: HapticLimits, supply: SupplyView | null) {
  return useAct('command_send', {
    done: (r) => {
      const res = r.results[0];
      if (res?.status === 'ok') {
        return undefined;
      }
      if (res?.status === 'busy') {
        return { tone: 'warn', title: `${inst}: not now`, body: busyWords(limits.kind, supply) };
      }
      return { tone: 'warn', title: `${inst}: ${res?.status.replace(/_/g, ' ') ?? 'no answer'}`, ...(res?.error ? { body: res.error } : {}) };
    },
  });
}

/** A length in ms as the core's span, its Earth value on the Earth line. */
function Length({ ms }: { ms: number }) {
  return <MemberValue cap={CAP} member={{ name: 'ms', unit: 'ms' }} value={ms} />;
}

/** A rate (taps a second) as the core's rate, its Earth value on the Earth line. */
function Rate({ hz }: { hz: number }) {
  const core = useFractonica();
  const v = memberValueText(core, CAP, { name: 'rate', unit: 'Hz' }, hz);
  return (
    <span className="dev-unit-value">
      {v.text ? <Reading text={v.text} /> : null}
      <Earth className="dev-earth-inline">{`${hz} ${hz === 1 ? 'tap' : 'taps'} a second`}</Earth>
    </span>
  );
}

/** A tempo as the span of one beat, its beats a minute on the Earth line. */
function Tempo({ bpm }: { bpm: number }) {
  const core = useFractonica();
  const v = memberValueText(core, CAP, { name: 'ms', unit: 'ms' }, Math.round(60_000 / bpm));
  return (
    <span className="dev-unit-value">
      <span className="ash">a beat every</span> {v.text ? <Reading text={v.text} /> : null}
      <Earth className="dev-earth-inline">{`${bpm} beats a minute`}</Earth>
    </span>
  );
}

function HapticHeadline({ detail, inst, mirror }: CapPanelProps) {
  const active = activeOf(mirror.active);
  if (active === null) {
    return <span className="ash">not reported yet</span>;
  }
  const away = isAway(detail.presence);
  const kind = hapticLimits(inst.config).kind;
  return (
    <span className={away ? 'dev-headline ash' : 'dev-headline'} data-stale={away ? 'true' : undefined} data-active={active ? 'true' : 'false'}>
      <span className={active && !away ? 'haptic-running-word' : 'ash'}>{active ? runningWord(kind) : 'still'}</span>
      {away ? <span className="dev-headline-note">as last seen</span> : null}
    </span>
  );
}

/** The Overview row's one control: TAP (a solenoid) or BUZZ (a motor) while still, STOP while it runs. */
function HapticQuick(props: CapPanelProps) {
  const { detail, inst, mirror } = props;
  const { limits, supply } = useHaptic(props);
  const act = useHapticAct(inst.name, limits, supply);
  const running = activeOf(mirror.active) === true;
  const erm = limits.kind === 'erm';
  const word = running ? 'stop' : erm ? 'buzz' : 'tap';
  const args = running ? {} : erm ? QUICK_BUZZ : QUICK_TAP;
  return (
    <Button
      variant="quiet"
      busy={act.isPending}
      disabled={isAway(detail.presence)}
      aria-label={`${running ? 'Stop' : erm ? 'Buzz' : 'Tap'} ${inst.name}`}
      data-haptic={`quick-${word}`}
      onClick={() => act.mutate({ selector: `id:${detail.device_id}`, command: `${inst.name}.${running ? 'stop' : 'pulse'}`, args })}
    >
      {word}
    </Button>
  );
}

/** What it does now, how its last program ended, and its supply. */
function Now({ deviceId, name, limits, supply, active }: { deviceId: string; name: string; limits: HapticLimits; supply: SupplyView | null; active: boolean | null }) {
  const done = useLive((s) => lastEvent(s.events, deviceId, name, 'done'));
  const cut = useLive((s) => lastEvent(s.events, deviceId, name, 'cut'));
  const ended = hapticDoneWords(done?.fields, cut?.fields);
  const refuses = supplyRefuses(limits.kind, supply);
  return (
    <div className="haptic-now">
      <p className="haptic-now-line" data-active={active === null ? undefined : String(active)}>
        <span className={active ? 'haptic-running-word' : 'ash'}>{active === null ? 'not reported yet' : active ? runningWord(limits.kind) : 'still'}</span>
        {ended ? (
          <span className="ash" data-haptic="last-done">
            {ended}
          </span>
        ) : null}
      </p>
      {supply ? (
        <p className="haptic-now-line" data-haptic="supply" data-level={supply.level ?? undefined}>
          <span className="haptic-label caps">{engrave(supply.name)}</span>
          {supply.mv !== null ? <MemberValue cap={CAP} member={{ name: 'supply_mv', unit: 'mV' }} value={supply.mv} /> : <span className="ash">not reported yet</span>}
          {supply.level ? <span className={supply.level === 'ok' ? 'ash' : 'haptic-warn'}>{supply.level}</span> : null}
        </p>
      ) : null}
      {refuses ? (
        <p className="haptic-warn" data-haptic="refuses">
          {refuses === 'low' ? `${supply!.name} is too low: nothing starts until it has charged.` : `${supply!.name} is too low for the solenoid to start: it starts again once it has charged a little.`}
        </p>
      ) : null}
    </div>
  );
}

/** The named patterns as buttons; one the board would refuse is greyed, and why is said under them. */
function Patterns({ list, run, busy, away, name }: { list: readonly PatternButton[]; run: (key: string, s: HapticSend) => void; busy: (key: string) => boolean; away: boolean; name: string }) {
  const why = list.find((p) => p.send === null)?.why;
  return (
    <div className="haptic-group" data-haptic-group="patterns">
      <span className="haptic-label caps">{engrave('patterns')}</span>
      <ButtonRow>
        {list.map((p) => (
          <Button key={p.key} variant="quiet" busy={busy(p.key)} disabled={away || p.send === null} data-pattern={p.key} data-why={p.why} title={p.why ?? commandDoes(CAP, p.send!.command, name) ?? undefined} aria-label={`${p.words}, ${name}`} onClick={() => p.send && run(p.key, p.send)}>
            {p.words}
          </Button>
        ))}
      </ButtonRow>
      {why ? (
        <p className="ash haptic-why" data-haptic="pattern-why">
          {why}
        </p>
      ) : null}
    </div>
  );
}

function SolenoidControls({ deviceId, name, limits, active, away, act }: { deviceId: string; name: string; limits: HapticLimits; active: boolean; away: boolean; act: ReturnType<typeof useHapticAct> }) {
  const [hz, setHz] = useState<number>(TAP_DEFAULTS.hz);
  const [level, setLevel] = useState<number>(TAP_DEFAULTS.level);
  const [ms, setMs] = useState<number>(Math.min(TAP_DEFAULTS.ms, lengthMax(limits)));
  const [count, setCount] = useState<number>(TAP_DEFAULTS.count);
  const [bpm, setBpm] = useState<number>(METRONOME_DEFAULTS.bpm);
  const [beats, setBeats] = useState<number>(METRONOME_DEFAULTS.beats);
  const [accentLevel, setAccentLevel] = useState<number>(METRONOME_DEFAULTS.accentLevel);
  /** What this page started and still runs: a train, the metronome, or nothing. */
  const [mode, setMode] = useState<'train' | 'metronome' | null>(null);
  const [pressed, setPressed] = useState<string | null>(null);

  const send = (s: HapticSend) => act.mutate({ selector: `id:${deviceId}`, command: `${name}.${s.command}`, args: s.args });
  const live = useRef<LiveSender<TapArgs> | null>(null);
  if (live.current === null) {
    live.current = new LiveSender<TapArgs>((args) => send({ command: 'tap', args: { ...args } }));
  }
  // The board says when it stops: a train or the metronome ends with it.
  useEffect(() => {
    if (!active) {
      setMode(null);
      live.current?.cancel();
    }
  }, [active]);

  const train = tapArgs({ hz, ms, level, count });
  const trainCheck = tapCheck(train.period_ms, ms, limits);
  const metro = metronomeArgs({ bpm, beats, ms, level, accentLevel });
  const metroCheck = tapCheck(metro.period_ms, ms, limits);
  const fastest = fastestTempo(ms, limits);

  // While a train or the metronome runs, its new settings go to the board (at most five a second), keeping the beat.
  useEffect(() => {
    if (mode === 'train' && active && trainCheck.ok) {
      live.current?.push(train);
    } else if (mode === 'metronome' && active && metroCheck.ok) {
      live.current?.push(metro);
    }
  }, [hz, ms, level, count, bpm, beats, accentLevel]);

  const run = (key: string, s: HapticSend, m: 'train' | 'metronome' | null = null) => {
    setPressed(key);
    live.current?.cancel();
    setMode(m);
    send(s);
  };
  const busy = (key: string) => act.isPending && pressed === key;
  const stop = () => run('stop', { command: 'stop', args: {} });

  return (
    <>
      <div className="haptic-group" data-haptic-group="taps">
        <span className="haptic-label caps">{engrave('taps')}</span>
        <Slider label="Rate" value={hz} min={RATE_MIN_HZ} max={RATE_MAX_HZ} step={RATE_STEP_HZ} onChange={setHz} format={(v) => <Rate hz={v} />} disabled={away} id={`${name}-rate`} />
        <Slider label="Strength" value={level} min={1} max={100} onChange={setLevel} disabled={away} id={`${name}-strength`} />
        <Slider label="Tap length" value={ms} min={1} max={lengthMax(limits)} onChange={setMs} format={(v) => <Length ms={v} />} disabled={away} id={`${name}-length`} note={ms > limits.kick_ms ? 'past the kick it holds at less: a longer tap ends in a firmer knock' : undefined} />
        <Select label="Times" value={String(count)} onChange={(v) => setCount(Number(v))} options={COUNTS.map((c) => ({ value: String(c.value), label: c.words }))} disabled={away} id={`${name}-count`} />
        {!trainCheck.ok ? (
          <p className="haptic-warn" data-haptic="tap-hint">
            {tapCheckWords(trainCheck)} {trainCheck.longest > 0 ? <Length ms={trainCheck.longest} /> : 'none: slow down'}
          </p>
        ) : null}
        <ButtonRow>
          <Button variant="quiet" busy={busy('tap')} disabled={away || ms > limits.max_on_ms} data-haptic="tap" title={commandDoes(CAP, 'pulse', name) ?? undefined} aria-label={`Tap ${name} once`} onClick={() => run('tap', { command: 'pulse', args: { ms, level } })}>
            tap
          </Button>
          <Button busy={busy('start')} disabled={away || !trainCheck.ok} data-haptic="start" data-running={mode === 'train' && active ? 'true' : undefined} title={commandDoes(CAP, 'tap', name) ?? undefined} aria-label={`Start tapping ${name}`} onClick={() => run('start', { command: 'tap', args: { ...train } }, 'train')}>
            start
          </Button>
          <Button busy={busy('stop')} disabled={away} data-haptic="stop" title={commandDoes(CAP, 'stop', name) ?? undefined} aria-label={`Stop ${name}`} onClick={stop}>
            stop
          </Button>
        </ButtonRow>
      </div>
      <Patterns list={solenoidPatterns(ms, level, limits)} run={(k, s) => run(k, s)} busy={busy} away={away} name={name} />
      <div className="haptic-group" data-haptic-group="metronome">
        <span className="haptic-label caps">{engrave('metronome')}</span>
        <Slider label="Tempo" value={bpm} min={TEMPO_MIN_BPM} max={TEMPO_MAX_BPM} onChange={setBpm} format={(v) => <Tempo bpm={v} />} disabled={away} id={`${name}-tempo`} />
        <Select
          label="Beats in a bar"
          value={String(beats)}
          onChange={(v) => setBeats(Number(v))}
          options={Array.from({ length: BEATS_MAX }, (_, i) => ({ value: String(i + 1), label: i === 0 ? 'one: no accent' : String(i + 1) }))}
          disabled={away}
          id={`${name}-beats`}
        />
        <Slider label="First beat" value={accentLevel} min={1} max={100} onChange={setAccentLevel} disabled={away || beats < 2} id={`${name}-accent`} />
        {!metroCheck.ok ? (
          <p className="haptic-warn" data-haptic="tempo-hint">
            {fastest !== null ? (
              <>
                at this tap length the fastest tempo is <Tempo bpm={fastest} />
              </>
            ) : (
              'this tap length is too long for any tempo: shorten the taps'
            )}
          </p>
        ) : null}
        <ButtonRow>
          <Button busy={busy('metronome')} disabled={away || !metroCheck.ok} data-haptic="metronome" data-running={mode === 'metronome' && active ? 'true' : undefined} aria-label={`Start the metronome on ${name}`} onClick={() => run('metronome', { command: 'tap', args: { ...metro } }, 'metronome')}>
            start
          </Button>
          <Button busy={busy('stop-metronome')} disabled={away} data-haptic="stop-metronome" aria-label={`Stop the metronome on ${name}`} onClick={() => run('stop-metronome', { command: 'stop', args: {} })}>
            stop
          </Button>
        </ButtonRow>
      </div>
    </>
  );
}

function MotorControls({ deviceId, name, limits, away, act }: { deviceId: string; name: string; limits: HapticLimits; away: boolean; act: ReturnType<typeof useHapticAct> }) {
  const [level, setLevel] = useState(100);
  const [ms, setMs] = useState(300);
  const [pressed, setPressed] = useState<string | null>(null);
  const run = (key: string, s: HapticSend) => {
    setPressed(key);
    act.mutate({ selector: `id:${deviceId}`, command: `${name}.${s.command}`, args: s.args });
  };
  const busy = (key: string) => act.isPending && pressed === key;
  return (
    <>
      <div className="haptic-group" data-haptic-group="buzz">
        <span className="haptic-label caps">{engrave('buzz')}</span>
        <Slider label="Strength" value={level} min={1} max={100} onChange={setLevel} disabled={away} id={`${name}-strength`} />
        <Slider label="Length" value={ms} min={20} max={Math.min(3000, limits.max_on_ms)} step={10} onChange={setMs} format={(v) => <Length ms={v} />} disabled={away} id={`${name}-length`} />
        <ButtonRow>
          <Button busy={busy('buzz')} disabled={away} data-haptic="buzz" title={commandDoes(CAP, 'pulse', name) ?? undefined} aria-label={`Buzz ${name}`} onClick={() => run('buzz', { command: 'pulse', args: { ms, level } })}>
            buzz
          </Button>
          <Button busy={busy('stop')} disabled={away} data-haptic="stop" title={commandDoes(CAP, 'stop', name) ?? undefined} aria-label={`Stop ${name}`} onClick={() => run('stop', { command: 'stop', args: {} })}>
            stop
          </Button>
        </ButtonRow>
      </div>
      <Patterns list={motorPatterns(level, limits)} run={run} busy={busy} away={away} name={name} />
    </>
  );
}

function HapticBlock(props: CapPanelProps) {
  const { detail, inst, mirror } = props;
  const { limits, supply } = useHaptic(props);
  const act = useHapticAct(inst.name, limits, supply);
  const away = isAway(detail.presence);
  const active = activeOf(mirror.active);
  const title = limits.kind === 'erm' ? 'Vibration motor' : limits.kind === 'solenoid' ? 'Solenoid' : 'Haptic';
  return (
    <Section title={title}>
      <div className="haptic" data-haptic-block={inst.name} data-kind={limits.kind ?? 'unknown'}>
        <Now deviceId={detail.device_id} name={inst.name} limits={limits} supply={supply} active={active} />
        {limits.kind === 'erm' ? (
          <MotorControls deviceId={detail.device_id} name={inst.name} limits={limits} away={away} act={act} />
        ) : (
          <SolenoidControls deviceId={detail.device_id} name={inst.name} limits={limits} active={active === true} away={away} act={act} />
        )}
      </div>
    </Section>
  );
}

function HapticLens(props: CapPanelProps) {
  return (
    <div className="haptic-lens">
      <HapticBlock {...props} />
      <GenericBody {...props} skip={SKIP} />
    </div>
  );
}

export const HAPTIC_PANEL: CapPanel = { Lens: HapticLens, Headline: HapticHeadline, Quick: HapticQuick, covers: COVERS };
