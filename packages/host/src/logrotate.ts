// hub.log rotation by size, keeping `keep` old files (hub.log.1 newest … hub.log.<keep> oldest).
//   - 'rename' (fr hub start, before the hub opens the file): hub.log becomes hub.log.1.
//   - 'copytruncate' (the running hub, whose stdout and stderr are hub.log opened O_APPEND by fr hub start): the file is
//     copied to hub.log.1 and truncated in place, so the hub keeps writing to the same file from its start. A line
//     written between the copy and the truncate is lost; the hub writes a few lines a minute, so that is rare.

import { copyFileSync, existsSync, renameSync, rmSync, statSync, truncateSync } from 'node:fs';

export interface RotateOptions {
  maxBytes: number;
  keep: number;
  how: 'rename' | 'copytruncate';
}

/** Rotates `file` when it is larger than maxBytes; returns whether it did. */
export function rotateLog(file: string, opts: RotateOptions): boolean {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return false;
  }
  if (size <= opts.maxBytes) {
    return false;
  }
  const keep = Math.max(1, Math.floor(opts.keep));
  rmSync(`${file}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i--) {
    if (existsSync(`${file}.${i}`)) {
      renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
  }
  if (opts.how === 'rename') {
    renameSync(file, `${file}.1`);
  } else {
    copyFileSync(file, `${file}.1`);
    truncateSync(file, 0);
  }
  return true;
}
