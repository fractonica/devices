#!/usr/bin/env node
// `fr` from anywhere: runs this checkout's CLI from source (src/main.ts) in a Node started with the
// @fractonica/source export condition, which the workspace packages need (their dist/ is never built). The shim
// `fr doctor --fix` writes into ~/.local/bin execs this file with a pinned Node; `pnpm fr …` (the root script) runs it
// too, from the directory pnpm was called in (INIT_CWD), so relative paths mean what they say.
// The child gets stdin, stdout and stderr as they are (fr mcp speaks JSON-RPC over them; prompts read the TTY). Its
// exit code is this process's; a signal that ended it ends this process the same way. SIGTERM and SIGHUP are passed
// on; SIGINT only when no terminal sent it to the whole group already.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const main = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts');
const viaPnpm = process.env.npm_lifecycle_event === 'fr' && process.env.INIT_CWD;
const child = spawn(process.execPath, ['--conditions=@fractonica/source', ...process.execArgv, main, ...process.argv.slice(2)], {
  stdio: 'inherit',
  ...(viaPnpm ? { cwd: process.env.INIT_CWD } : {}),
});

const forward = (sig) => () => {
  if (child.exitCode === null && child.signalCode === null && (sig !== 'SIGINT' || !process.stdin.isTTY)) {
    child.kill(sig);
  }
};
const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((sig) => [sig, forward(sig)]);
for (const [sig, fn] of handlers) {
  process.on(sig, fn);
}

child.on('error', (err) => {
  process.stderr.write(`fr: cannot start node: ${err.message}\n`);
  process.exit(127);
});
child.on('exit', (code, signal) => {
  for (const [sig, fn] of handlers) {
    process.off(sig, fn);
  }
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
