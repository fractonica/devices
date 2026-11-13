// LEGACY: an old page mounted inside a new page stub (stage 4 foundation), so nothing it did is lost while the page
// builders replace it. Delete the mount, and the old page under src/legacy, once its new page covers it.

import type { ReactNode } from 'react';

import './legacy.css';

export function LegacyMount({ children }: { children: ReactNode }) {
  return (
    <div className="legacy" data-legacy="">
      {children}
    </div>
  );
}
