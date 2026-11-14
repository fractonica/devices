// A capture's path on the hub (DEVICE-SPEC §3.9): in pure mode from the captures folder, its date stamps held as ⊕;
// whole in Earth mode. The copy copies it whole.

import { heldPath } from '../../../../state/pure-text.ts';
import { CopyButton, useMode } from './ui.ts';

/** A path as shown: from the captures folder in pure mode (`captures/cam-esp32/⊕.jpg`), whole in Earth mode. */
export function shownPath(path: string, earth: boolean): string {
  if (earth) {
    return path;
  }
  const norm = path.replace(/\\/g, '/');
  const at = norm.lastIndexOf('/captures/');
  return heldPath(at >= 0 ? norm.slice(at + 1) : path);
}

/** A capture's path: ⊕ for its stamp and from the captures folder in pure mode, whole in Earth mode; the copy copies it whole. */
export function HeldPath({ path }: { path: string }) {
  const { earth } = useMode();
  const shown = shownPath(path, earth);
  return (
    <span className="cam-path">
      <span className="mono">
        {earth
          ? shown
          : shown.split(/(⊕)/).map((part, i) =>
              part === '⊕' ? (
                <span key={i} className="cam-held" aria-label="a time stamp, shown in Earth mode">
                  ⊕
                </span>
              ) : (
                part
              ),
            )}
      </span>
      <CopyButton text={path} label="Copy path" what="the path on the hub" />
    </span>
  );
}

