// `fr time …`: Fractonica time from the temporal core (@fractonica/time), computed here, with no hub. The commands are
// the hub's time_* ops (time_now, time_convert, time_ladder, time_next) answered locally, plus `parse`, `span` and
// `sync`, which only the CLI has. Every number and word is the core's; this file reads arguments and lays out.
//
// The fast path: main.ts sends `fr time …` here before it imports the operation registry, commander's full program
// or zod, so the command starts in about the time Node and the core take. This module imports nothing heavy at the
// top: @fractonica/time is loaded inside the actions. program.ts adds the same commands to the full program, so
// `fr --help` lists them.
//
// Output: the Result envelope with --json ({ok, data, cursor: ""}), else the terminal layout (format.ts of
// @fractonica/time): PURE by default, --earth adds the civil translations marked ⊕. No colour.
// --watch redraws at the instant the core says the reading next changes (next_change_us), never on a fixed poll, and
// ends cleanly on Ctrl-C (exit 0). On a terminal it redraws in place; piped, it prints each reading (one envelope per
// line with --json).

import { Command, InvalidArgumentError } from 'commander';

/** What the commands need from their program: --json, and an exit that drains stdout first. */
export interface TimeIo {
  json(): boolean;
  exit(code: number, out?: string, err?: string): Promise<never>;
}

type TimeModule = typeof import('@fractonica/time');

/** Exit codes of the envelope's error codes (spec 09 §9.3) that these commands can answer. */
const EXIT: Record<string, number> = { INVALID_ARGS: 64, INTERNAL: 1 };

interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
  cursor: string;
}

function failure(e: unknown, t: TimeModule | null): Envelope {
  if (t && e instanceof t.TimeError) {
    return { ok: false, cursor: '', error: { code: e.code, message: e.message, retryable: false, details: { reason: e.reason, ...e.details } } };
  }
  return { ok: false, cursor: '', error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e), retryable: false } };
}

/** Prints one reading (or its error) and exits. */
async function answer<T>(io: TimeIo, read: (t: TimeModule) => T | Promise<T>, layout: (t: TimeModule, data: T) => string): Promise<never> {
  let t: TimeModule | null = null;
  let r: Envelope;
  let text = '';
  try {
    t = await import('@fractonica/time');
    const data = await read(t);
    r = { ok: true, data, cursor: '' };
    text = layout(t, data);
  } catch (e) {
    r = failure(e, t);
  }
  if (io.json()) {
    return io.exit(r.ok ? 0 : (EXIT[r.error!.code] ?? 1), JSON.stringify(r) + '\n');
  }
  return r.ok ? io.exit(0, text + '\n') : io.exit(EXIT[r.error!.code] ?? 1, '', `error ${r.error!.code}: ${r.error!.message}\n`);
}

/** A whole number option (`--count 3`). */
function integer(v: string): number {
  if (!/^\d+$/.test(v.trim())) {
    throw new InvalidArgumentError('not a whole number');
  }
  return Number(v);
}

/**
 * `fr time --watch`: the NOW reading, redrawn at each change the core reports. Ends on Ctrl-C (SIGINT) or SIGTERM
 * with exit 0, or on the first error (outside the catalogue, say).
 */
async function watchNow(io: TimeIo, opts: { at?: string; earth?: boolean }): Promise<void> {
  const t = await import('@fractonica/time');
  const core = await t.loadCore();
  const out = process.stdout;
  const tty = Boolean(out.isTTY) && !io.json();
  let shownRows = 0;
  let timer: NodeJS.Timeout | null = null;
  let done = false;
  // --at with --watch: the reading starts there and runs at real speed (the offset to the clock is kept). An --at the
  // core cannot read is refused as without --watch (INVALID_ARGS, exit 64), before anything is drawn.
  let offset = 0n;
  if (opts.at !== undefined) {
    try {
      offset = t.toInstant(core, opts.at).t - core.frc.now();
    } catch (e) {
      const r = failure(e, t);
      return void (await (io.json()
        ? io.exit(EXIT[r.error!.code] ?? 1, JSON.stringify(r) + '\n')
        : io.exit(EXIT[r.error!.code] ?? 1, '', `error ${r.error!.code}: ${r.error!.message}\n`)));
    }
  }
  const now = () => core.frc.now() + offset;
  const rows = (text: string) => {
    const cols = out.columns || 80;
    return text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil([...line].length / cols)), 0);
  };
  const end = (code: number) => {
    if (done) {
      return;
    }
    done = true;
    if (timer) {
      clearTimeout(timer);
    }
    if (tty) {
      out.write('\x1b[?25h'); // the cursor back
    }
    void io.exit(code);
  };
  process.on('SIGINT', () => end(0));
  process.on('SIGTERM', () => end(0));
  if (tty) {
    out.write('\x1b[?25l'); // no cursor blinking over the reading
  }
  const draw = () => {
    if (done) {
      return;
    }
    let reading: ReturnType<TimeModule['readNow']>;
    try {
      reading = t.readNow(core, { at: `${now()}us`, earth: opts.earth }, {});
    } catch (e) {
      const r = failure(e, t);
      if (io.json()) {
        out.write(JSON.stringify(r) + '\n');
      } else {
        process.stderr.write(`error ${r.error!.code}: ${r.error!.message}\n`);
      }
      return end(EXIT[r.error!.code] ?? 1);
    }
    if (io.json()) {
      out.write(JSON.stringify({ ok: true, data: reading, cursor: '' }) + '\n');
    } else {
      const text = t.formatNow(reading);
      // In place on a terminal: back to the first row of the last drawing, clear down, draw.
      out.write((tty && shownRows ? `\x1b[${shownRows}F\x1b[J` : !tty && shownRows ? '\n' : '') + text + '\n');
      shownRows = rows(text);
    }
    if (reading.next_change_us === null) {
      return end(0); // the catalogue's closing instant: nothing changes after it
    }
    // The core's instant of the next change, on the local clock: a timer for exactly then (rounded up to the ms).
    const waitUs = BigInt(reading.next_change_us) - now();
    timer = setTimeout(draw, Math.max(1, Number((waitUs + 999n) / 1000n)));
  };
  draw();
}

/**
 * A negative instant (`-6000000000`, `-6000000000000000us`: before 1970, and the catalogue starts in 1613) is an
 * argument, not an option: no option of the time commands is a dash and a digit. Commander takes a plain negative
 * number as an argument but not one with a unit suffix, so this command hides such a word from its option parser and
 * gives it back as it was. A word that is the value of the option before it (`--at -6000000000000000us`) is left
 * alone: commander gives an option its next word whatever it looks like.
 */
const NEGATIVE_INSTANT = /^-\d/;
const HIDDEN = '\u0000';

class TimeCommand extends Command {
  override createCommand(name?: string): Command {
    return new TimeCommand(name);
  }

  override parseOptions(args: string[]): { operands: string[]; unknown: string[] } {
    const takesValue = (word: string | undefined) => word !== undefined && this.options.some((o) => (o.long === word || o.short === word) && (o.required || o.optional));
    const hidden = args.map((a, i) => (NEGATIVE_INSTANT.test(a) && !takesValue(args[i - 1]) ? HIDDEN + a : a));
    const show = (a: string) => (a.startsWith(HIDDEN) ? a.slice(1) : a);
    const r = super.parseOptions(hidden);
    return { operands: r.operands.map(show), unknown: r.unknown.map(show) };
  }
}

/**
 * The `fr time` commands on `program` (the fast path's own small program, or the full one). `--at` and `--earth` are
 * options of `time` itself, which commander parses wherever they stand, so a subcommand reads them with
 * optsWithGlobals: `fr time ladder --at …` and `fr time --at … ladder` mean the same.
 */
export function addTimeCommands(program: Command, io: TimeIo): void {
  type Opts = { at?: string; earth?: boolean; watch?: boolean; context?: string; to?: string; quarter?: string; count?: number; parts?: number };
  const opts = (cmd: Command) => cmd.optsWithGlobals() as Opts;
  const time = new TimeCommand('time');
  time.copyInheritedSettings(program);
  program.addCommand(time);
  time
    .description('Fractonica time now, from the temporal core: the stamp, Pentad, majors, countdowns, Sun, next thresholds (no hub needed)')
    .option('--at <instant>', 'read at this instant: now, Unix seconds (or 1791460800000ms, …us; negative before 1970), a stamp, or an ISO date')
    .option('--earth', 'add the Earth translation (civil date and time, durations), marked ⊕')
    .option('--watch', 'redraw at each change the core reports, until Ctrl-C')
    .action(async (_o: unknown, cmd: Command) => {
      const o = opts(cmd);
      if (o.watch) {
        return watchNow(io, o);
      }
      return answer(
        io,
        async (t) => t.readNow(await t.loadCore(), { at: o.at, earth: o.earth }),
        (t, d) => t.formatNow(d),
      );
    });

  time
    .command('stamp')
    .description('The stamp of an instant (ISO date, Unix time or now), and the date in words')
    .argument('<instant>', 'now, Unix seconds (or …ms, …us; negative before 1970), or an ISO date')
    .action(async (at: string) =>
      answer(
        io,
        async (t) => t.convert(await t.loadCore(), { at }),
        (t, d) => t.formatStamp(d),
      ),
    );

  time
    .command('parse')
    .description('The instant a stamp names (its first microsecond), in Unix µs and ISO, and its finest unit')
    .argument('<stamp>', 'a stamp: α#6 β#4 γ#9 δ#3 ε#5 34η 29ι 21λ 3ν, ASCII a#6 b#4 …, or partial (ε#5 34η)')
    .option('--context <instant>', 'the instant whose date completes a partial stamp (default now)')
    .action(async (stamp: string, _o: unknown, cmd: Command) =>
      answer(
        io,
        async (t) => t.convert(await t.loadCore(), { at: stamp, context: opts(cmd).context }),
        (t, d) => t.formatParse(d),
      ),
    );

  time
    .command('ladder')
    .description('Every level from α down: its cycle, the quarter it is in, and the span to the end of that quarter')
    .option('--to <level>', 'the deepest level shown: a symbol (ν), word (Blink) or depth (13); default ν, at most χ')
    .action(async (_o: unknown, cmd: Command) => {
      const o = opts(cmd);
      return answer(
        io,
        async (t) => t.readLadder(await t.loadCore(), { at: o.at, to: o.to, earth: o.earth }),
        (t, d) => t.formatLadder(d),
      );
    });

  time
    .command('next')
    .description('The next thresholds (quarter boundaries) of one level, each with its stamp and the span to it')
    .argument('<level>', 'a symbol (η), word (Eta, Helion) or depth (7)')
    .option('--quarter <quarter>', 'only one kind: peak, node, valley or end')
    .option('--count <n>', 'how many (1 to 100; default 5)', integer)
    .action(async (level: string, _o: unknown, cmd: Command) => {
      const o = opts(cmd);
      return answer(
        io,
        async (t) => t.readNext(await t.loadCore(), { level, quarter: o.quarter, count: o.count, at: o.at, earth: o.earth }),
        (t, d) => t.formatNext(d),
      );
    });

  time
    .command('span')
    .description('The span from one instant to another, in Fractonica units, signed')
    .argument('<from>', 'an instant (now, Unix seconds, negative before 1970, a stamp, an ISO date)')
    .argument('<to>', 'an instant')
    .option('--parts <n>', "at most this many units (default: the core's precision, two)", integer)
    .action(async (from: string, to: string, _o: unknown, cmd: Command) => {
      const o = opts(cmd);
      return answer(
        io,
        async (t) => t.readSpan(await t.loadCore(), { from, to, parts: o.parts, earth: o.earth }),
        (t, d) => t.formatSpanReading(d),
      );
    });

  time
    .command('sync')
    .description('The solar sync: its number, Pentad, quarter, drift and next quarter')
    .action(async (_o: unknown, cmd: Command) => {
      const o = opts(cmd);
      return answer(
        io,
        async (t) => t.readSync(await t.loadCore(), { at: o.at, earth: o.earth }),
        (t, d) => t.formatSync(d),
      );
    });
}

/** Whether argv (after node and the script) is a `fr time …` command: its first word that is not an option. */
export function isTimeCommand(argv: readonly string[]): boolean {
  const first = argv.find((a) => !a.startsWith('-'));
  return first === 'time';
}

/** Exits once stdout and stderr have drained (process.exit drops what a pipe has not taken yet). */
async function drainExit(code: number, out = '', err = ''): Promise<never> {
  process.exitCode = code;
  await new Promise((res) => process.stderr.write(err, res));
  await new Promise((res) => process.stdout.write(out, res));
  process.exit(code);
}

/**
 * The fast path (main.ts): `fr time …` on a program of its own that knows only --json and the time commands, with
 * the full program's rules for usage errors (an INVALID_ARGS Result, exit 64) and help (exit 0).
 */
export async function runTimeFast(argv: readonly string[]): Promise<void> {
  const { Command, CommanderError } = await import('commander');
  const program = new Command('fr')
    .description('Fractonica: build, flash, monitor and drive ESP32 device networks')
    .option('--json', 'print one JSON Result envelope on stdout')
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({ outputError: () => {} });
  const io: TimeIo = { json: () => Boolean(program.opts().json), exit: drainExit };
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (e: NodeJS.ErrnoException) => process.exit(e.code === 'EPIPE' ? (process.exitCode ?? 0) : 1));
  }
  addTimeCommands(program, io);
  try {
    await program.parseAsync([...argv]);
  } catch (e) {
    if (e instanceof CommanderError && e.exitCode === 0 && ['commander.helpDisplayed', 'commander.help', 'commander.version'].includes(e.code)) {
      return void (await drainExit(0));
    }
    const message = e instanceof CommanderError ? (e.code === 'commander.help' ? 'missing subcommand' : e.message.replace(/^error: /, '')) : e instanceof Error ? e.message : String(e);
    const code = e instanceof CommanderError ? 'INVALID_ARGS' : 'INTERNAL';
    const r = { ok: false, cursor: '', error: { code, message, retryable: false } };
    await (io.json() ? drainExit(EXIT[code], JSON.stringify(r) + '\n') : drainExit(EXIT[code], '', `error ${code}: ${message}\n`));
  }
}
