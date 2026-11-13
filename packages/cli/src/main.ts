#!/usr/bin/env node
// `fr`: the Fractonica CLI. `fr time …` takes a fast path (time.ts): it needs no hub and none of the operation registry,
// so it starts without importing the registry, commander's full program or zod. Every other command loads the full
// program (program.ts), whose op commands are generated from the registry.

import { isTimeCommand, runTimeFast } from './time.ts';

const argv = process.argv.slice(2);
if (isTimeCommand(argv)) {
  await runTimeFast(process.argv);
} else {
  await import('./program.ts');
}
