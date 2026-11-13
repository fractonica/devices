// Crash handling (src/crash.ts): guarded timer callbacks, the process handlers (in a child process, so this worker's
// own handlers are untouched), the stop backstop's non-zero exit, and SerialPortManager.poll() surviving a failing
// SerialPort.list().

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { EXIT_CRASH, EXIT_FORCED_STOP, guarded, stopBackstop } from '../src/crash.ts';
import { openDb } from '../src/db.ts';
import type { SerialBinding } from '../src/links/serial-bridge.ts';
import { LogStore } from '../src/logstore.ts';
import { SerialPortManager } from '../src/serial.ts';

const CRASH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'crash.ts');
const dir = mkdtempSync(join(tmpdir(), 'fr-crash-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('guarded', () => {
  it('logs a synchronous throw with the loop name and does not rethrow', () => {
    const lines: Record<string, unknown>[] = [];
    const fn = guarded('t.sync', () => {
      throw new Error('boom');
    }, (l) => lines.push(l));
    expect(() => fn()).not.toThrow();
    expect(lines).toEqual([expect.objectContaining({ event: 'timer_failed', timer: 't.sync', message: 'boom' })]);
  });

  it('logs a rejected promise and keeps the interval running', async () => {
    const lines: Record<string, unknown>[] = [];
    let calls = 0;
    const t = setInterval(
      guarded('t.async', async () => {
        calls++;
        throw new Error(`fail ${calls}`);
      }, (l) => lines.push(l)),
      5,
    );
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3));
    clearInterval(t);
    await new Promise((r) => setTimeout(r, 10));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0]).toMatchObject({ event: 'timer_failed', timer: 't.async', message: 'fail 1' });
  });
});

describe('process handlers (child process)', () => {
  const runChild = (body: string) => {
    const script = join(dir, `child-${Math.random().toString(36).slice(2)}.ts`);
    writeFileSync(
      script,
      `import { installCrashHandlers } from ${JSON.stringify(CRASH)};\n` +
        `installCrashHandlers({ flush: () => process.stderr.write('FLUSHED\\n') });\n${body}\n`,
    );
    return spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30_000 });
  };

  it('logs an unhandled rejection and keeps running', () => {
    const r = runChild(`Promise.reject(new Error('nobody awaited me'));\nsetTimeout(() => { process.stdout.write('ALIVE'); }, 50);`);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('ALIVE');
    const line = JSON.parse(r.stderr.split('\n').find((l) => l.includes('unhandled_rejection'))!);
    expect(line).toMatchObject({ event: 'unhandled_rejection', message: 'nobody awaited me' });
    expect(line.stack).toContain('nobody awaited me');
  });

  it('logs an uncaught exception, flushes, and exits 70', () => {
    const r = runChild(`setTimeout(() => { throw new Error('broken state'); }, 10);\nsetTimeout(() => {}, 5000);`);
    expect(r.status).toBe(EXIT_CRASH);
    expect(r.stderr).toContain('"event":"uncaught_exception"');
    expect(r.stderr).toContain('broken state');
    expect(r.stderr.indexOf('FLUSHED')).toBeGreaterThan(r.stderr.indexOf('uncaught_exception'));
    expect(r.stderr).toContain('"event":"exiting","code":70');
  });
});

describe('stopBackstop', () => {
  it('exits non-zero and says so when a stop hangs', async () => {
    const lines: Record<string, unknown>[] = [];
    const codes: number[] = [];
    stopBackstop(10, { log: (l) => lines.push(l), exit: (c) => codes.push(c) });
    await vi.waitFor(() => expect(codes).toEqual([EXIT_FORCED_STOP]));
    expect(EXIT_FORCED_STOP).not.toBe(0);
    expect(lines).toEqual([expect.objectContaining({ event: 'stop_forced', after_ms: 10 })]);
  });
});

describe('SerialPortManager.poll', () => {
  it('survives SerialPort.list() failing: logged, counted, and the next poll lists again', async () => {
    const db = openDb(join(dir, 'poll.db'));
    const logs = new LogStore(db, 1, { retention: false });
    let fail = true;
    const binding: SerialBinding = {
      list: async () => {
        if (fail) {
          throw new Error('IOKit went away');
        }
        return [{ path: '/dev/cu.usbmodem9101', vendorId: '303a', productId: '1001', serialNumber: '1C:DB:D4:00:01:34', manufacturer: undefined, pnpId: undefined, locationId: undefined }];
      },
      open: () => new Promise(() => undefined), // never opens: this test is about listing
    };
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m: string) => void errors.push(m));
    try {
      const mgr = new SerialPortManager(logs, db, { binding });
      await expect(mgr.poll()).resolves.toBeUndefined();
      await expect(mgr.poll()).resolves.toBeUndefined();
      expect(mgr.pollFailures).toBe(2);
      expect(errors.some((e) => e.includes('serial_poll_failed') && e.includes('IOKit went away'))).toBe(true);
      fail = false;
      await mgr.poll();
      expect(mgr.list().map((p) => p.device_id)).toEqual(['1cdbd4000134']);
    } finally {
      spy.mockRestore();
      logs.close();
      db.close();
    }
  });
});
