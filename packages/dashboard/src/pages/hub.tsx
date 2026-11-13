// HUB (home), route `/` (HARDWARE-REVIEW §4 "Screens" 1). The present as a small instrument computed by the core,
// beside it the reading (⊕ line in Earth mode only), the fleet as beads on a carrier with each device's last word,
// one line of hub health (the hub_doctor checks as beads, each with its fix in Settings › Health), and the latest
// thresholds the hub passed; what waits on a person (agent prompts, lent ports, running jobs) as a banner on top.
//
// Parts in pages/hub/: instrument.tsx (SVG, redrawn at the core's next change), present.tsx (the reading, every
// Blink: kept small), fleet.tsx, health.tsx, banner.tsx. Their logic is state/hub-instrument.ts and state/hub-home.ts.

import './hub.css';

import { useRef } from 'react';

import { useGroundAnchor } from '../shell/ground.tsx';
import { ErrorLine, Page, useCoreError, useFractonica, useMode } from '../ui/index.ts';
import { Banner } from './hub/banner.tsx';
import { Fleet } from './hub/fleet.tsx';
import { Health, Thresholds } from './hub/health.tsx';
import { Instrument, InstrumentPlaceholder } from './hub/instrument.tsx';
import { Present } from './hub/present.tsx';

function TheInstrument() {
  const core = useFractonica();
  const error = useCoreError();
  const { earth } = useMode();
  const ref = useRef<HTMLDivElement>(null);
  useGroundAnchor(ref);
  return (
    <div className="hub-instrument" ref={ref}>
      {core ? <Instrument core={core} earth={earth} /> : <InstrumentPlaceholder label={error ? 'The present: the temporal core did not load' : undefined} />}
      {error ? <ErrorLine what="The temporal core" message={`it did not load (${error.message}); reload the page, or rebuild the dashboard if it stays`} /> : null}
    </div>
  );
}

export function HubPage() {
  return (
    <Page title="Hub">
      <Banner />
      {/* two columns on a wide screen (the instrument with the hub's own health under it; the reading and the fleet),
          one on a phone in reading order: instrument, reading, fleet, health (CSS display: contents and order) */}
      <div className="hub-grid">
        <div className="hub-col hub-col-left">
          <TheInstrument />
          <div className="hub-health">
            <Health />
            <Thresholds />
          </div>
        </div>
        <div className="hub-col hub-col-right">
          <Present />
          <Fleet />
        </div>
      </div>
    </Page>
  );
}
