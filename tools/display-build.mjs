#!/usr/bin/env node
// Builds the desktop renderer (design m2-c5-display D6): configures tools/display into build/host-display and builds
// fr_display_render there; the first configure fetches LVGL (tools/display/CMakeLists.txt pins the release and its
// SHA256) into build/_deps. `fr display render` and the hub's display_render run this when the binary is missing or
// older than its sources. With --test it also builds fr_display_tests and runs it (extra args are a test-name filter).
//   node tools/display-build.mjs
//   node tools/display-build.mjs --test [filter]
// The build directory is build/host-display, or FR_DISPLAY_BUILD_DIR (relative to the checkout, or absolute).
// FR_DISPLAY_LV_MEM_SIZE=32768 (with its own FR_DISPLAY_BUILD_DIR) builds the tests with a board's 32 KB LVGL pool.
// Runs are serialised per checkout (build/.display-build.lock): every build directory shares the one LVGL download in
// build/_deps, and two first builds at once (two test files, the CLI and the hub) would fetch it into the same place.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'tools', 'display');
const build = resolve(root, process.env.FR_DISPLAY_BUILD_DIR || join('build', 'host-display'));

function pick(envName, candidates) {
  if (process.env[envName]) {
    return process.env[envName];
  }
  return candidates.find((c) => (c.includes('/') ? existsSync(c) : true));
}

const cmake = pick('CMAKE', ['/opt/homebrew/bin/cmake', 'cmake']);
const cxx = pick('FR_HOST_CXX', ['/opt/homebrew/opt/llvm/bin/clang++', 'clang++']);
const cc = pick('FR_HOST_CC', ['/opt/homebrew/opt/llvm/bin/clang', 'clang']);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) {
    console.error(`display-build: cannot run ${cmd}: ${r.error.message}`);
    process.exit(127);
  }
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

// One run at a time per checkout: a lock directory holding the owner's pid. A lock whose owner is gone (killed, the
// machine restarted) is taken over; a live one is waited for, up to FR_DISPLAY_LOCK_WAIT_S (default 30 minutes).
const lockDir = join(root, 'build', '.display-build.lock');
let locked = false;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock() {
  const waitS = Number(process.env.FR_DISPLAY_LOCK_WAIT_S ?? 1800);
  const deadline = Date.now() + waitS * 1000;
  let told = false;
  mkdirSync(dirname(lockDir), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'pid'), String(process.pid));
      locked = true;
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') {
        throw e;
      }
    }
    let owner = NaN;
    try {
      owner = Number(readFileSync(join(lockDir, 'pid'), 'utf8'));
    } catch {
      // Just created and its pid not written yet, or just released: look again.
    }
    if (Number.isInteger(owner) && owner > 0 && !alive(owner)) {
      // Stale: move it aside (only one taker's rename succeeds), then try again.
      const aside = `${lockDir}.stale-${process.pid}`;
      try {
        renameSync(lockDir, aside);
        rmSync(aside, { recursive: true, force: true });
      } catch {
        // Someone else took it over first.
      }
      continue;
    }
    if (Date.now() > deadline) {
      console.error(`display-build: another build (pid ${owner}) has held ${lockDir} for over ${waitS} s; giving up`);
      process.exit(75);
    }
    if (!told) {
      console.error(`display-build: waiting for another build (pid ${owner}) to finish`);
      told = true;
    }
    sleepMs(500);
  }
}

function releaseLock() {
  if (locked) {
    locked = false;
    rmSync(lockDir, { recursive: true, force: true });
  }
}

process.on('exit', releaseLock);
for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) {
  process.on(sig, () => process.exit(128 + n));
}

const args = process.argv.slice(2);
const testAt = args.indexOf('--test');
const test = testAt >= 0;
if (test) {
  args.splice(testAt, 1);
} else if (args.length > 0) {
  console.error('usage: node tools/display-build.mjs [--test [filter]]');
  process.exit(64);
}

// Configuring every time is cheap and lets CONFIGURE_DEPENDS globs pick up new sources. stdout carries the build's
// progress; callers that parse output read the renderer's own, never this script's.
// FR_DISPLAY_LV_MEM_SIZE (bytes) builds with a board's LVGL pool instead of the Mac's (use its own build directory).
acquireLock();
const pool = `-DFR_LV_MEM_SIZE=${process.env.FR_DISPLAY_LV_MEM_SIZE ?? ''}`;
run(cmake, ['-S', source, '-B', build, '-G', 'Ninja', `-DCMAKE_CXX_COMPILER=${cxx}`, `-DCMAKE_C_COMPILER=${cc}`, '-DCMAKE_BUILD_TYPE=Debug', pool, '--log-level=WARNING']);
run(cmake, ['--build', build, '--target', 'fr_display_render', ...(test ? ['fr_display_tests'] : [])]);
// The binary is current as of now even when ninja had nothing to relink (a newer source it does not depend on, say a
// test or an IDF-only file), so the callers' staleness rule (a source newer than the binary) settles.
const now = new Date();
utimesSync(join(build, 'fr_display_render'), now, now);
console.log(`display-build: built ${join(build, 'fr_display_render')}`);
if (test) {
  const asan = process.platform === 'darwin' ? 'detect_leaks=0:abort_on_error=1' : 'abort_on_error=1';
  const env = { ...process.env, ASAN_OPTIONS: process.env.ASAN_OPTIONS ?? asan, UBSAN_OPTIONS: process.env.UBSAN_OPTIONS ?? 'print_stacktrace=1' };
  run(join(build, 'fr_display_tests'), args, { env });
}
