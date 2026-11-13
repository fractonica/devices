// Buttons (design README "Hub" 7): hairline-outlined caps words, no fill. `primary` is the page's one lumen action;
// `destructive` is drawn in fault and, with `confirm`, asks in place before it acts (a second press confirms; Escape,
// a click elsewhere or CANCEL disarms); `quiet` is an underlined word for secondary actions in rows.

import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef, useState } from 'react';

import { engrave } from './text.tsx';

export type ButtonVariant = 'default' | 'primary' | 'destructive' | 'quiet';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  /** The word(s) on the button; engraved. A ReactNode is shown as given. */
  children: ReactNode;
  /** Asks this in place before onClick runs ("Forget desk-pad?"); the confirming button says `confirmLabel`. */
  confirm?: string;
  confirmLabel?: string;
  /** Running: disabled, with aria-busy (no spinner: nothing spins). */
  busy?: boolean;
}

export function Button({ variant = 'default', children, confirm, confirmLabel = 'Confirm', busy = false, onClick, disabled, type = 'button', ...rest }: ButtonProps) {
  const [armed, setArmed] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!armed) {
      return;
    }
    const away = (e: Event) => {
      if (box.current && !box.current.contains(e.target as Node)) {
        setArmed(false);
      }
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setArmed(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [armed]);
  const text = typeof children === 'string' ? <span className="ui-button-text">{engrave(children)}</span> : children;
  const common = { ...rest, type, disabled: disabled || busy, 'aria-busy': busy || undefined, 'data-busy': busy ? '' : undefined };
  if (confirm && armed) {
    return (
      <span className="ui-confirm" ref={box} role="group" aria-label={confirm}>
        <span className="ui-confirm-question">{confirm}</span>
        <button
          {...common}
          className="ui-button"
          data-variant={variant}
          data-armed=""
          autoFocus
          onClick={(e) => {
            setArmed(false);
            onClick?.(e);
          }}
        >
          <span className="ui-button-text">{engrave(confirmLabel)}</span>
        </button>
        <button type="button" className="ui-button" data-variant="quiet" onClick={() => setArmed(false)}>
          <span className="ui-button-text">{engrave('Cancel')}</span>
        </button>
      </span>
    );
  }
  return (
    <button {...common} className="ui-button" data-variant={variant} onClick={confirm ? () => setArmed(true) : onClick}>
      {text}
    </button>
  );
}

/** A line of buttons that wraps at phone width. */
export function ButtonRow({ children }: { children: ReactNode }) {
  return <div className="ui-button-row">{children}</div>;
}
