// Errors of @fractonica/sdk: connect() and the socket's own failures (HubError), and a command or MSG
// the device or hub answered with anything but ok (CommandError, carrying the `result` frame).

import type { CommandStatus, ResultFrame } from './wire.ts';

/**
 * Why the SDK could not do something itself:
 * - HUB_UNREACHABLE: no welcome within connectTimeoutMs (no hub, wrong url, no WebSocket in this runtime);
 * - UNAUTHORIZED: the hub closed with 4401 (a missing or wrong token: `fr codegen client`, or the page's injection);
 * - VERSION_MISMATCH: the hub closed with 4409 (another fr-app major);
 * - PROTOCOL: the hub closed with 4400, or sent a frame this SDK cannot read;
 * - CLOSED: hub.close() was called, or the hub sent an `error` frame for a request.
 */
export type HubErrorCode = 'HUB_UNREACHABLE' | 'UNAUTHORIZED' | 'VERSION_MISMATCH' | 'PROTOCOL' | 'CLOSED';

/**
 * The SDK could not reach or keep the hub. It was called FractonicaError, a name the temporal core's binding
 * (fractonica.js) also uses for its own errors.
 */
export class HubError extends Error {
  readonly code: HubErrorCode | (string & {});

  constructor(code: HubErrorCode | (string & {}), message: string) {
    super(message);
    this.name = 'HubError';
    this.code = code;
  }
}

/** @deprecated The former name of HubError (the same class): use HubError. */
export const FractonicaError = HubError;
/** @deprecated The former name of HubError: use HubError. */
export type FractonicaError = HubError;
/** @deprecated The former name of HubErrorCode: use HubErrorCode. */
export type FractonicaErrorCode = HubErrorCode;

/**
 * A command or MSG that did not succeed: `status` is the RESULT's (busy, invalid_args, failed, ...) or the
 * hub's own (offline, timeout, not_found, injection_disabled). While disconnected, reliable commands reject
 * with `offline` at once.
 */
export class CommandError extends Error {
  readonly status: CommandStatus | (string & {});
  /** The hub's `result` frame; absent when the SDK answered itself (disconnected, timed out locally). */
  readonly result?: ResultFrame;

  constructor(status: CommandStatus | (string & {}), message: string, result?: ResultFrame) {
    super(message);
    this.name = 'CommandError';
    this.status = status;
    if (result) {
      this.result = result;
    }
  }
}
