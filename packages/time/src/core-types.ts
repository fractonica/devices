// What a loaded core is, without loading one: the shape every reader takes and the core's error class. No Node and
// no browser API here, so the readers (read.ts, instant.ts, earth.ts) serve the CLI and hub (core.ts reads the module
// from disk) and the dashboard (browser.ts fetches it) alike.

import { type Catalogue, type Fractonica, FractonicaError } from '../vendor/lib/fractonica.js';

export { FractonicaError as CoreError };

/** The loaded core and the catalogue every reading uses (Saros 141, design ruling 8). */
export interface Core {
  frc: Fractonica;
  cat: Catalogue;
}
