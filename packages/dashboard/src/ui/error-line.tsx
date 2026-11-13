// An error as one line on a hairline: a fault bead, the code in caps, the message, what to do (the hub's hint and
// remediation), and an inline fix button when the page knows one ("Release port", "Run fr doctor --fix"). An op this
// hub does not have yet reads as a notice, not an error.

import type { ReactNode } from 'react';

import { OpError, opMissing, remedies } from '../api/rest.ts';
import { Bead } from './bead.tsx';
import { Button } from './button.tsx';
import { engrave } from './text.tsx';

export interface ErrorFix {
  label: string;
  onClick: () => void;
  busy?: boolean;
}

export interface ErrorLineProps {
  /** An OpError (code, message, remediation), any thrown value, or null (renders nothing). */
  error?: unknown;
  /** Or a message of the page's own. */
  message?: ReactNode;
  /** What failed, before the message ("Rename"). */
  what?: string;
  /** The fix, as a button at the end of the line. */
  fix?: ErrorFix;
}

export function ErrorLine({ error, message, what, fix }: ErrorLineProps) {
  if (!error && !message) {
    return null;
  }
  let code = 'error';
  let text: ReactNode = message;
  let steps: string[] = [];
  let notice = false;
  if (error) {
    const e = error instanceof OpError ? error : new OpError({ code: 'INTERNAL', message: error instanceof Error ? error.message : String(error), retryable: false });
    if (opMissing(e)) {
      notice = true;
      code = 'not available';
      text = `${what ?? 'This'} is not available on this hub yet.`;
    } else {
      code = e.code;
      text = `${what ? `${what}: ` : ''}${e.message}`;
      steps = remedies(e);
    }
  }
  return (
    <div className="ui-error" role={notice ? 'status' : 'alert'} data-error={code} data-tone={notice ? 'notice' : 'error'}>
      <span className="ui-error-sign">
        <Bead state={notice ? 'idle' : 'fault'} label={notice ? 'notice' : 'error'} />
      </span>
      <span className="ui-error-code caps">{engrave(code.toLowerCase().replace(/_/g, ' '))}</span>
      <span className="ui-error-text">{text}</span>
      {fix ? (
        <Button variant="default" onClick={fix.onClick} busy={fix.busy}>
          {fix.label}
        </Button>
      ) : null}
      {steps.length ? (
        <ul className="ui-error-steps">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
