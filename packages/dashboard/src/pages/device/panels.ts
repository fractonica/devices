// The capability-panel registry (DEVICE-SPEC §2.1): which component draws an instrument's page
// (/devices/$id/$instance), its rung on the device's Overview (the headline and at most one quick control), and which
// of its device commands it runs itself. A capability without a purpose-built panel gets the generic one
// (panels/generic.tsx), drawn from the catalog.
//
// SEAM between the two builders: builder PAGE owns this file (and adds fr.led and fr.display here); builder CAMERA
// owns panels/camera/* and registers nothing else. CapPanelProps and CapPanel do not change without both agreeing.

import type { ComponentType } from 'react';

import type { CatalogCapability } from '@fractonica/protocol/gen';

import type { DeviceDetail } from '../../api/types.ts';
import type { InstanceView, MembersView } from '../../state/caps.ts';
import { CAMERA_PANEL } from './panels/camera/index.tsx';
import { DISPLAY_PANEL } from './panels/display.tsx';
import { GENERIC_PANEL } from './panels/generic.tsx';
import { LED_PANEL } from './panels/led.tsx';

/** What every panel component (Lens, Headline, Quick) is given. Built once by the page (page-lens.tsx panelProps). */
export interface CapPanelProps {
  /** device_get's answer (refetched every 10 s by the frame); presence, alias, router, profile. */
  detail: DeviceDetail;
  /** This instrument: capability_list's instance when it answered (traits, v, driver), else the router's. */
  inst: InstanceView;
  /** Its capability in the catalog. A panel is only drawn when the catalog knows the capability. */
  cap: CatalogCapability;
  /** The members this instance shows: trait-gated, test commands only when HELLO says inject is on. */
  members: MembersView;
  /** Live property values by property name: the store's over the router's mirror. */
  mirror: Readonly<Record<string, unknown>>;
  /** Every instance on the device, in port order (siblings: the camera finds its `flash` fr.led here). */
  instances: readonly InstanceView[];
}

export interface CapPanel {
  /** The instrument's page body (under the device header, the device sub-nav and the instrument strip). */
  Lens: ComponentType<CapPanelProps>;
  /** The Overview rung's value: one short reading, pure-safe (Earth only through <Earth>/FTime/Span). */
  Headline: ComponentType<CapPanelProps>;
  /** At most one control on the Overview rung, never lumen (an LED's on/off ring; the camera's WATCH link). */
  Quick?: ComponentType<CapPanelProps>;
  /** Device commands the panel runs itself; Engineering › Commands marks them "the <instance> page does this". */
  covers?: readonly string[];
  /** The panel says itself that the device is offline (the camera's view): the page's own presence line is left out. */
  saysPresence?: boolean;
}

/** The purpose-built panels, by capability name. */
export const PANELS: Readonly<Record<string, CapPanel>> = {
  'fr.camera': CAMERA_PANEL,
  'fr.led': LED_PANEL,
  'fr.display': DISPLAY_PANEL,
};

/**
 * The panels whose instrument page has its own lumen action (the camera's WATCH): there Identify steps down to
 * `default`. Every other instrument page keeps Identify as its one primary.
 */
export const LUMEN_PANELS: ReadonlySet<string> = new Set(['fr.camera']);

/** The capability's panel, else the generic one. */
export function panelFor(cap: string): CapPanel {
  return PANELS[cap] ?? GENERIC_PANEL;
}
