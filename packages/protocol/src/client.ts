// `@fractonica/protocol/client`: the browser entry without Zod, for the dashboard's bundle. Its values come only from
// modules with no dependency (cursors, alias rules, the type glob, header and path constants); every type of the
// browser entry (ops and their inputs and outputs, events, frames, results) is re-exported as a type, erased at build.
// The dashboard checks `/ws` frames by shape (its api/ws.ts), so it needs no schema at run time. A test keeps this
// module's imports free of zod and of Node builtins.

export * from './constants.ts';
export * from './cursor.ts';
export * from './glob.ts';
export * from './haptic.ts';
export * from './names.ts';
export type * from './browser.ts';
