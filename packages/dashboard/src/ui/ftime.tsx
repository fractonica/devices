// An instant in Fractonica notation, as the core writes it, and in Earth mode its civil translation in ash led by ⊕.
// Pure mode shows no clock time, date, zone or second anywhere (design ruling 11), not even in an attribute.
//
//   <FTime at={event.t_hub_us} />                       29ι 21λ 3ν            ⊕ 14:05:40.123
//   <FTime at={job.created_at} form="relative" />        3λ 2ν ago             ⊕ 4 min 1 s ago
//   <FTime at={lease.expires_at} form="relative" />      in 6ι 43λ             ⊕ in 56 min 12 s
//   <FTime at={build.built_at} form="stamp" stack />     α#6 β#4 … 21λ 3ν      ⊕ THU 8 OCT 2026 · 12:00:00 CEST
//
// A relative time redraws when its text next changes (the core's spanNextChange), never on a fixed poll.

import { type Core, dateLine, DateForm, EARTH_SIGN, isoLocal, outOfCatalogueText, Unit } from '@fractonica/time/browser';

import { useMode } from '../shell/mode.ts';
import { useFractonica, useNowFor } from '../time/hooks.ts';
import { type InstantLike, instantOf } from '../time/instant.ts';
import { Reading } from './text.tsx';

export type FTimeForm = 'terms' | 'short' | 'stamp' | 'relative';
export type FTimeEarth = 'clock' | 'date-time' | 'duration' | 'none';

export interface FTimeProps {
  /** Unix µs (an event's t_hub_us), BigInt Unix µs, an ISO time (an op's created_at), or a Date. */
  at: InstantLike | null | undefined;
  /**
   * terms (default): the terms from `from` to `finest`, "29ι 21λ 3ν"; short: the core's short letters,
   * "δ#3 ε#5 34η 29ι 21λ 3ν"; stamp: the whole date, "α#6 β#4 γ#9 δ#3 ε#5 34η 29ι 21λ 3ν"; relative: the span to or
   * from now, "3λ 2ν ago", "in 6ι 43λ".
   */
  form?: FTimeForm;
  /** The coarsest term of `terms` (default the Preon, ι). */
  from?: number;
  /** The finest term (default the Blink, ν). */
  finest?: number;
  /** Parts of a relative span (default 2). */
  parts?: number;
  /** The Earth translation in Earth mode: clock (HH:MM:SS.mmm; terms' and short's default), date-time (stamp's), duration (relative's), none. */
  earth?: FTimeEarth;
  /** The Earth line under the notation instead of beside it. */
  stack?: boolean;
}

/** The core's local ISO time ("2026-10-08T14:00:00.000+02:00") cut to its clock part, "14:00:00.000". */
function clockOf(core: Core, t: bigint): string {
  const iso = isoLocal(core, t);
  const m = /T([0-9:.]+)/.exec(iso);
  return m ? m[1]! : iso;
}

function fractonica(core: Core, t: bigint, now: bigint | null, form: FTimeForm, from: number, finest: number, parts: number): string {
  const { frc, cat } = core;
  if (!cat.contains(t)) {
    return outOfCatalogueText(core);
  }
  if (form === 'relative') {
    if (now === null) {
      return '';
    }
    if (t > now) {
      return `in ${frc.formatSpan(cat.spanBetween(now, t), parts)}`;
    }
    return `${frc.formatSpan(cat.spanBetween(t, now), parts)} ago`;
  }
  const date = cat.dateAt(t);
  if (form === 'stamp') {
    return frc.formatDate(date, DateForm.LETTERS, finest as Unit);
  }
  if (form === 'short') {
    return frc.formatDate(date, DateForm.SHORT_LETTERS, finest as Unit);
  }
  const units = Object.values(Unit).filter((u) => u >= from && u <= finest);
  return units.map((u) => frc.formatDateTerm(date, u)).join(' ');
}

function earthText(core: Core, t: bigint, now: bigint | null, kind: FTimeEarth): string | null {
  if (kind === 'none') {
    return null;
  }
  if (kind === 'clock') {
    return clockOf(core, t);
  }
  if (kind === 'date-time') {
    return dateLine(core, t);
  }
  if (now === null) {
    return null;
  }
  return t > now ? `in ${core.frc.formatDuration(t - now, 2)}` : `${core.frc.formatDuration(now - t, 2)} ago`;
}

/**
 * The texts FTime shows, for code that needs them as strings (a tooltip in pure mode, a copy button): the notation,
 * and the Earth translation when `earthMode` (null in pure mode, always).
 */
export function fTimeText(
  core: Core,
  t: bigint,
  now: bigint | null,
  opts: { form?: FTimeForm; from?: number; finest?: number; parts?: number; earth?: FTimeEarth; earthMode: boolean },
): { text: string; civil: string | null } {
  const form = opts.form ?? 'terms';
  const text = fractonica(core, t, now, form, opts.from ?? Unit.PREON, opts.finest ?? Unit.BLINK, opts.parts ?? 2);
  const kind: FTimeEarth = opts.earth ?? (form === 'stamp' ? 'date-time' : form === 'relative' ? 'duration' : 'clock');
  const civil = opts.earthMode && core.cat.contains(t) ? earthText(core, t, now, kind) : null;
  return { text, civil };
}

export function FTime({ at, form = 'terms', from = Unit.PREON, finest = Unit.BLINK, parts = 2, earth, stack = false }: FTimeProps) {
  const core = useFractonica();
  const { earth: earthMode } = useMode();
  const t = instantOf(at);
  const now = useNowFor(form === 'relative' ? core : null, t, parts);
  if (!core || t === null) {
    return (
      <span className="ui-ftime" aria-busy={!core || undefined}>
        —
      </span>
    );
  }
  const { text, civil } = fTimeText(core, t, now, { form, from, finest, parts, earth, earthMode });
  return (
    <span className={`ui-ftime${stack ? ' ui-ftime-stack' : ''}`}>
      <Reading text={text} />
      {civil ? (
        <span className="earth">
          <span className="sign">{EARTH_SIGN}</span>
          {civil}
        </span>
      ) : null}
    </span>
  );
}
