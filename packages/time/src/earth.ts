// EARTH mode: the Gregorian translation of an instant, in the core's own wording (frc_format_civil_text,
// frc_format_civil, frc_format_duration), at the machine's local zone. This file chooses forms, as the site's
// public/app/model/earth.js does; it composes no date, pads no number and rounds no duration. The zone's
// abbreviation ("CEST") is the platform's (Intl), as the core's header says a client appends its own.
//
// Nothing here may be called in PURE mode: every caller checks `earth` first, so a pure reading carries no Earth
// unit, date, zone or clock time (design ruling 11).

import { CivilForm } from '../vendor/lib/fractonica.js';
import type { CivilForm as CivilFormValue } from '../vendor/lib/fractonica.js';
import type { Core } from './core-types.ts';

/** The Earth sign that leads every translation shown beside Fractonica notation. */
export const EARTH_SIGN = '⊕';

/** An instant in one of the core's Earth forms, at the local zone's offset for that instant. */
export function civilText(core: Core, t: bigint, form: CivilFormValue): string {
  const { frc } = core;
  const offset = frc.utcOffsetSeconds(t);
  return frc.formatCivilText(frc.civilFromTime(t, offset), offset, form);
}

/** "2026-10-08T12:00:00.000Z": the instant in UTC (the core's ISO form). */
export function isoUtc(core: Core, t: bigint): string {
  return core.frc.formatCivil(core.frc.civilFromTime(t, 0), 0);
}

/** "2026-10-08T14:00:00.000+02:00": the instant at the local zone's offset. */
export function isoLocal(core: Core, t: bigint): string {
  const offset = core.frc.utcOffsetSeconds(t);
  return core.frc.formatCivil(core.frc.civilFromTime(t, offset), offset);
}

/** The zone's short name from the platform ("UTC", "CEST"), else the core's offset form ("UTC+5:30"). */
export function zoneName(core: Core, t: bigint): string {
  const date = core.frc.toDate(t);
  for (const locale of ['en-GB', 'en-US']) {
    try {
      const part = new Intl.DateTimeFormat(locale, { timeZoneName: 'short' }).formatToParts(date).find((p) => p.type === 'timeZoneName');
      if (part && /^[A-Z]{2,5}$/.test(part.value)) {
        return part.value;
      }
    } catch {
      // no time zone data: the offset below
    }
  }
  return core.frc.formatCivilText(null, core.frc.utcOffsetSeconds(t), CivilForm.OFFSET);
}

/** "THU 8 OCT 2026 · 12:00:00 UTC": the date line under the reading. */
export function dateLine(core: Core, t: bigint): string {
  return `${civilText(core, t, CivilForm.DATE_TIME)} ${zoneName(core, t)}`;
}

/** "12:56:12" */
export function clockTime(core: Core, t: bigint): string {
  return civilText(core, t, CivilForm.TIME);
}

/** "7 OCT 01:34:09" */
export function dayMonthSeconds(core: Core, t: bigint): string {
  return civilText(core, t, CivilForm.DAY_MONTH_SECONDS);
}

/** When something happens, as short as the distance allows: the clock time the same civil day, "9 OCT 01:34" within 300 days, else "8 OCT 2026". */
export function when(core: Core, t: bigint, now: bigint): string {
  if (civilText(core, t, CivilForm.ISO_DATE) === civilText(core, now, CivilForm.ISO_DATE)) {
    return clockTime(core, t);
  }
  const days = (t > now ? t - now : now - t) / core.frc.constants.US_PER_DAY;
  return civilText(core, t, days < 300n ? CivilForm.DAY_MONTH_TIME : CivilForm.DAY_MONTH_YEAR);
}

/** "56 min 12 s": the Earth duration between two instants, as the core words it (unsigned). */
export function duration(core: Core, from: bigint, to: bigint): string {
  return core.frc.formatDuration(to > from ? to - from : from - to);
}

/** "−13 h 28 min": a signed duration in microseconds, the core's words. */
export function signedDuration(core: Core, us: bigint): string {
  return core.frc.formatDuration(us);
}

/** When the local clock's second next changes (the core's microsecond field): an Earth line must be redrawn then. */
export function nextCivilSecond(core: Core, t: bigint): bigint {
  const { frc } = core;
  const micro = frc.civilFromTime(t, frc.utcOffsetSeconds(t)).microsecond;
  return t + BigInt(frc.constants.US_PER_SECOND - micro);
}
