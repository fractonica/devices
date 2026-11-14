// A camera op's failure on its line: the panel's own words when it has them (state/camera.ts cameraErrorLine), else the
// hub's message and remedies (ErrorLine says those in the mode's units).

import { OpError } from '../../../../api/rest.ts';
import { cameraErrorLine, type ErrorContext } from '../../../../state/camera.ts';
import { ErrorLine } from './ui.ts';

/** Anything thrown as an OpError. */
export function asOpError(err: unknown): OpError {
  return err instanceof OpError ? err : new OpError({ code: 'INTERNAL', message: err instanceof Error ? err.message : String(err), retryable: false });
}

export function CamError({ error, ctx, what }: { error: unknown; ctx: ErrorContext; what?: string }) {
  if (!error) {
    return null;
  }
  const e = asOpError(error);
  const line = cameraErrorLine(e.code, e.message, ctx);
  return line ? <ErrorLine message={line} code={e.code} /> : <ErrorLine error={e} {...(what ? { what } : {})} />;
}
