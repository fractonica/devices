/*
 * fui_shim.c - STAND-INS for what the core does not offer yet (AGENTS.md
 * section 10, where each is requested with the exact signature wanted).
 * Every function here is to be deleted when the core answers, and its
 * callers pointed at the core's call.
 *
 * fui_shim_format_span_to: a countdown read at a step (fui_ui_set_step) must
 * not show a part finer than the step's unit ("6ι", not "6ι 43λ", at the
 * Preon), and frc_format_span limits only the NUMBER of parts. The stand-in
 * does no formatting of its own: it cuts the span toward zero to whole units
 * of `finest` (frc_unit_blinks) and lets the core write it; a span under one
 * such unit is written by frc_format_span_in_unit ("0ι"), since the cut span
 * would read "0ν", a unit the face does not show. Every unit of the ladder is
 * a whole number of the next finer one, so the parts of the cut span finer
 * than `finest` are zero and frc_format_span leaves them out.
 */
#include "fui_i.h"

int fui_shim_format_span_to(const frc_span_t *span, uint8_t max_parts, frc_unit_t finest, char *buf, size_t size)
{
    uint64_t unit = frc_unit_blinks(finest); /* 0 when `finest` is not a unit */
    frc_span_t cut;

    if (span == NULL || unit <= 1) {
        return frc_format_span(span, max_parts, buf, size); /* the Blink: no cut (decimals kept) */
    }
    cut.negative = span->negative;
    cut.blinks = span->blinks - span->blinks % unit;
    cut.frac = 0;
    if (cut.blinks == 0) {
        return frc_format_span_in_unit(span, finest, buf, size);
    }
    return frc_format_span(&cut, max_parts, buf, size);
}
