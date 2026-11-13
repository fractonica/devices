// What this package throws. Callers (the CLI, the hub, fr mcp) turn it into the Result envelope's error: `code` is one
// of the envelope's error codes, so it passes through as it is.

/** Why a time argument was refused. */
export type TimeErrorReason =
  /** Not an instant, a stamp, a level or a quarter this package reads. */
  | 'parse'
  /** Before the catalogue's first eclipse or after its last: the core has no reading there (design ruling 7). */
  | 'out_of_catalogue'
  /** A value the core refused (a level past the deepest one, a stamp that names no Blink). */
  | 'range'
  /**
   * Inside the catalogue, but in its first or last solar sync, which the catalogue holds only in part: the core has
   * no sync reading there (`fr time sync`); every other reading exists.
   */
  | 'partial_sync';

export class TimeError extends Error {
  readonly code = 'INVALID_ARGS' as const;
  readonly reason: TimeErrorReason;
  readonly details?: Record<string, unknown>;

  constructor(reason: TimeErrorReason, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TimeError';
    this.reason = reason;
    this.details = details;
  }
}
