// @fractonica/time: the Fractonica temporal core for the CLI and the hub (its WebAssembly build, vendored from the web
// repository and pinned by time.lock), the readings `fr time …` prints and the time_* ops answer, and their terminal
// layouts. Every Fractonica number and word comes from the core; this package parses arguments and lays text out.

export { type Core, CoreError, loadCore, WASM_URL } from './core.ts';
export { EARTH_SIGN } from './earth.ts';
/** The core's enumerations (fractonica.h), for callers that ask the core directly. */
export { DateForm, Quarter, Unit } from '../vendor/lib/fractonica.js';
export { isTimeOp, runTimeOp, TIME_OP_NAMES, type TimeOp } from './ops.ts';
export { TimeError, type TimeErrorReason } from './errors.ts';
export { engrave, formatLadder, formatNext, formatNow, formatParse, formatSpanReading, formatStamp, formatSync, table } from './format.ts';
export {
  type Clock,
  clockLevels,
  inCatalogue,
  INSTANT_FORMS,
  type InstantForm,
  outOfCatalogueText,
  type ParsedInstant,
  parseLevel,
  parseQuarter,
  toInstant,
} from './instant.ts';
export {
  type Conversion,
  convert,
  isCoreError,
  type LadderReading,
  NEXT_MAX,
  type NextReading,
  type NowReading,
  readLadder,
  readNext,
  readNow,
  readSpan,
  readSync,
  resolveAt,
  type Rung,
  type SpanReading,
  type SyncReading,
  type ThresholdView,
} from './read.ts';
