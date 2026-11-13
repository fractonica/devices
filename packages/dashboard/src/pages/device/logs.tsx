// A device's log, on demand (spec 08 §8.1 "logs bypass React state"): closed until asked, then a Term with its newest
// 200 lines (logs_read) followed live by the `/ws` log frames after that cursor. Device output is untrusted: the Term
// lets only colour sequences through. The hub reads logs from a USB port it holds; a node on Wi-Fi alone sends none.

import { useState } from 'react';

import type { LogLine } from '@fractonica/protocol/client';

import { OpError } from '../../api/rest.ts';
import { live, rest } from '../../runtime.ts';
import { Button, Row, Section, Term, type TermHandle, termLevel } from '../../ui/index.ts';

function writeLine(t: TermHandle, l: LogLine): void {
  t.line(l.text, l.level ? termLevel(l.level) : l.kind === 'frame' || l.kind === 'diag' ? 'debug' : 'info');
}

let subSeq = 0;

/** Opens the log of `deviceId`: its tail, then live; returns the cleanup. */
export function followLog(t: TermHandle, deviceId: string): () => void {
  const selector = `id:${deviceId}`;
  const id = `logs:${selector}:${++subSeq}`;
  let ready = false;
  let cancelled = false;
  const early: LogLine[] = [];
  // frames carry no sub id: keep only this device's lines
  const off = live.listen({
    logs: (all) => {
      const lines = all.filter((l) => l.device === deviceId);
      if (ready) {
        lines.forEach((l) => writeLine(t, l));
      } else {
        early.push(...lines);
      }
    },
  });
  void (async () => {
    try {
      const page = await rest.op('logs_read', { selector, max_lines: 200 });
      if (cancelled) {
        return;
      }
      if (!page.lines.length) {
        t.line('no lines yet: the hub reads logs from a USB port it holds open', 'debug');
      }
      page.lines.forEach((l) => writeLine(t, l));
      live.subscribe(id, { logs: { selector, since: page.next_cursor } });
    } catch (err) {
      if (cancelled) {
        return;
      }
      t.line(err instanceof OpError ? `${err.code}: ${err.message}` : String(err), 'error');
      live.subscribe(id, { logs: { selector } });
    }
    ready = true;
    early.splice(0).forEach((l) => writeLine(t, l));
  })();
  return () => {
    cancelled = true;
    off();
    live.unsubscribe(id);
  };
}

export function DeviceLog({ deviceId, alias, usb }: { deviceId: string; alias: string; usb: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Section
      title="Log"
      id="log"
      aside={
        <Button variant="quiet" onClick={() => setOpen(!open)} aria-expanded={open} data-action="log">
          {open ? 'Close' : 'Open log'}
        </Button>
      }
    >
      {open ? (
        <Term key={deviceId} label={`${alias} log`} height="300px" onOpen={(t) => followLog(t, deviceId)} />
      ) : (
        <Row
          label="Source"
          value={usb ? 'its USB port, which the hub holds' : <span className="ash">a device on Wi-Fi alone sends no log; plug it in with USB</span>}
        />
      )}
    </Section>
  );
}
