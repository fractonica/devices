// Crash handling for the hub daemon. Three parts:
//   - guarded(name, fn): a timer callback that cannot throw. A synchronous throw, or a rejection of the promise it
//     returns, is logged as one `timer_failed` line naming the loop; the loop keeps running. Every setInterval and
//     recurring setTimeout of the daemon goes through it, so one failed SQLite insert or SerialPort.list() never
//     reaches Node's uncaught-exception path.
//   - installCrashHandlers(): process-level `unhandledRejection` (logged, the hub keeps running) and
//     `uncaughtException` (logged, then `flush` runs, bounded by a timeout, then the process exits with 70, EX_SOFTWARE).
//   - stopBackstop(): the timer that ends a stop which hangs; it exits non-zero, so a supervisor or a person sees it.
// Fatal lines go out with writeSync on stderr (the hub's log file when started by `fr hub start`), so they are on disk
// before the process exits.

import { writeSync } from 'node:fs';

export type CrashLog = (line: Record<string, unknown>) => void;

/** One JSON line on stderr, written synchronously. */
export const stderrLog: CrashLog = (line) => {
  try {
    writeSync(2, JSON.stringify({ ts: new Date().toISOString(), ...line }) + '\n');
  } catch {
    // stderr gone (a closed pipe): nothing left to tell
  }
};

/** The fields of an error worth a log line: name, message, code, stack. */
export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return { error: err.name, message: err.message, ...(code ? { code } : {}), ...(err.stack ? { stack: err.stack } : {}) };
  }
  return { message: String(err) };
}

/** Exit status after an uncaught exception (sysexits EX_SOFTWARE), and after a stop that had to be forced. */
export const EXIT_CRASH = 70;
export const EXIT_FORCED_STOP = 1;

/**
 * `fn` as a timer callback that never throws: a throw or a rejected promise is logged as `timer_failed` with `name`,
 * and the next tick runs as usual.
 */
export function guarded<A extends unknown[]>(name: string, fn: (...args: A) => unknown, log: CrashLog = stderrLog): (...args: A) => void {
  const failed = (err: unknown) => log({ event: 'timer_failed', timer: name, ...errorFields(err) });
  return (...args: A) => {
    try {
      const r = fn(...args);
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        (r as Promise<unknown>).then(undefined, failed);
      }
    } catch (err) {
      failed(err);
    }
  };
}

export interface CrashHandlerOptions {
  log?: CrashLog;
  /** Writes what can still be written (queued events, the db) before the exit; bounded by flushTimeoutMs. */
  flush?: () => unknown;
  flushTimeoutMs?: number;
  exit?: (code: number) => void;
}

/**
 * Installs the process handlers; returns their uninstall. An unhandled rejection is logged with its stack and the hub
 * keeps running (it was a promise nobody awaited, not a broken state). An uncaught exception is logged, `flush` runs
 * once (at most flushTimeoutMs), and the process exits with EXIT_CRASH.
 */
export function installCrashHandlers(opts: CrashHandlerOptions = {}): () => void {
  const log = opts.log ?? stderrLog;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let dying = false;
  const onRejection = (reason: unknown) => {
    log({ event: 'unhandled_rejection', ...errorFields(reason) });
  };
  const onException = (err: unknown, origin: string) => {
    log({ event: 'uncaught_exception', origin, ...errorFields(err) });
    if (dying) {
      return;
    }
    dying = true;
    const done = () => {
      log({ event: 'exiting', code: EXIT_CRASH, reason: 'uncaught_exception' });
      exit(EXIT_CRASH);
    };
    let flushed: unknown;
    try {
      flushed = opts.flush?.();
    } catch (e) {
      log({ event: 'crash_flush_failed', ...errorFields(e) });
    }
    if (flushed && typeof (flushed as Promise<unknown>).then === 'function') {
      const timer = setTimeout(done, opts.flushTimeoutMs ?? 2000);
      (flushed as Promise<unknown>).then(
        () => {
          clearTimeout(timer);
          done();
        },
        (e) => {
          log({ event: 'crash_flush_failed', ...errorFields(e) });
          clearTimeout(timer);
          done();
        },
      );
    } else {
      done();
    }
  };
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  return () => {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
  };
}

/**
 * The stop's backstop: when a graceful stop has not exited within `ms`, logs `stop_forced` and exits with
 * EXIT_FORCED_STOP. Unref'd: it never keeps the process alive by itself.
 */
export function stopBackstop(ms: number, opts: { log?: CrashLog; exit?: (code: number) => void } = {}): NodeJS.Timeout {
  const log = opts.log ?? stderrLog;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  return setTimeout(() => {
    log({ event: 'stop_forced', after_ms: ms, code: EXIT_FORCED_STOP });
    exit(EXIT_FORCED_STOP);
  }, ms).unref();
}
