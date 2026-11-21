// Hub ops (design c6 §3.2 and D14, spec 09 §9.4 Hub; stream S2): hub_doctor, and the output of
// hub_status (which stays in ops.ts with the C1 ops). Spread into OPS (packages/protocol/src/ops.ts);
// the hub_doctor handler is S2's, in packages/hub/src/doctor/ops.ts.

import { z } from 'zod';

import { PromptSchema } from '../events.ts';
import { cursor, op } from './common.ts';
import { HubIdentitySchema } from './peers.ts';
import { GatewayInfoSchema } from './registry.ts';

/** One doctor check (packages/host doctor.ts Check): `fix` says what to do, `fixed` that --fix did it. */
export const CheckSchema = z.looseObject({
  id: z.string(),
  level: z.enum(['ok', 'warn', 'error']),
  detail: z.string(),
  fix: z.string().optional(),
  fixed: z.boolean().optional(),
});
export type Check = z.infer<typeof CheckSchema>;

/** The Local Network permission self-test (design c6 §5, lan/lnp.ts): a UDP connect to the LAN router. */
export const LNP_STATES = ['allowed', 'denied', 'unknown'] as const;
export type LnpState = (typeof LNP_STATES)[number];

/** The `_fractonica._tcp` advert (design c6 §5, lan/advert.ts); `off` for test hubs and --no-advert. */
export const ADVERT_STATES = ['registered', 'retrying', 'off'] as const;

/**
 * hub_status `data`. The C6 additions are optional until the stream that fills each lands: prompts
 * (S5), lnp, lnp_checked_at, launched_by, advert, dashboard (S2), sleep_guard and router.counters.
 */
export const HubStatusSchema = z.looseObject({
  version: z.string(),
  registry_hash: z.string(),
  pid: z.number().int(),
  run: z.number().int(),
  /** The `epoch` of this hub run's frames (05 §5.8); absent from a hub older than design multi-hub-m1. */
  hub_epoch: z.number().int().optional(),
  /**
   * This hub in its network (design multi-hub-m2 §2, §9): its id (made once per FR_HOME), its name, and its epoch slot
   * (null until a hub joined it or it joined one). Absent from a hub older than the hubs' link.
   */
  hub: HubIdentitySchema.optional(),
  uptime_s: z.number(),
  node: z.looseObject({ version: z.string(), path: z.string() }),
  source_dir: z.string(),
  /** ESP-IDF pin check, null when not checked yet. */
  idf: z.looseObject({ ok: z.boolean() }).nullable(),
  /** The pytools sidecar, null when not checked yet. */
  pytools: z.looseObject({ ok: z.boolean() }).nullable(),
  ports: z.looseObject({ total: z.number().int(), open: z.number().int() }),
  devices: z.looseObject({ registered: z.number().int(), online: z.number().int() }),
  /**
   * Node links (C3): the listeners' counters plus sessions per link; since M2-C4 (design m2-c4-gateway D15, D17)
   * gateway sessions and `gateways`, per gateway port key: alias, up, rtt_us, last_pong_ms_ago, status (its last
   * GwStatus), the node sessions through it and its counters.
   */
  links: z
    .looseObject({
      sessions: z.looseObject({ tcp: z.number().int(), serial: z.number().int(), gateway: z.number().int().optional() }),
      gateways: z.record(z.string(), GatewayInfoSchema).optional(),
    })
    .optional(),
  ota: z.looseObject({ http_port: z.number().int().nullable(), listen_error: z.string().nullable(), active: z.boolean() }).optional(),
  /** Job counts by status (queued, working). */
  jobs: z.record(z.string(), z.number()),
  head: cursor,
  warnings: z.array(z.string()),
  prompts: z.array(PromptSchema).optional(),
  lnp: z.enum(LNP_STATES).optional(),
  lnp_checked_at: z.string().nullable().optional(),
  /** The app that started the hub (macOS attributes Local Network access to it). */
  launched_by: z.string().optional(),
  advert: z.looseObject({ state: z.enum(ADVERT_STATES), name: z.string().optional(), error: z.string().optional() }).optional(),
  dashboard: z.looseObject({ url: z.string(), built: z.boolean(), stale: z.boolean() }).optional(),
  sleep_guard: z.looseObject({ active: z.boolean() }).optional(),
  /**
   * The router's counters; since M2-C3 `reorder` (design m2-c3-inputs D9): ordered-port events held, released in
   * order, released without their predecessor (timeout, cap, reset), holds ended by the 8 cap, the longest hold in
   * µs, and the events held now.
   */
  /** The event store (design m2-c3-inputs D6): streaming STATEs replaced before being written, since the hub started. */
  events: z.looseObject({ state_thinned: z.number().int() }).optional(),
  router: z
    .looseObject({
      counters: z.record(z.string(), z.number()),
      reorder: z
        .looseObject({
          held: z.number().int(),
          released_in_order: z.number().int(),
          released_timeout: z.number().int(),
          overflows: z.number().int(),
          hold_us_max: z.number(),
          holding: z.number().int(),
        })
        .optional(),
    })
    .optional(),
});
export type HubStatus = z.infer<typeof HubStatusSchema>;

export const HUB_OPS = [
  op({
    name: 'hub_doctor',
    target: 'hub',
    kind: 'query',
    tier: 'read',
    summary:
      "The hub's health checks, run in the hub process: fr doctor's (IDF pin, pytools, Node, firewall, LAN route, serial ports) plus its Local Network permission self-test and the _fractonica._tcp advert. Each check is ok, warn or error with a fix. The checks take a while (the IDF environment is read): max_age_s answers with the hub's last result when it is at most that old (checked_at says when it ran), so a page can show it at once. `fr doctor` runs the host checks without a hub.",
    input: z.object({
      max_age_s: z.number().int().min(0).max(86_400).optional().describe("answer with the last result when it is at most this old; 0 or absent runs the checks now"),
    }),
    output: z.looseObject({ checks: z.array(CheckSchema), checked_at: z.string().optional() }),
    cli: { path: ['hub', 'doctor'] },
  }),
  op({
    name: 'hub_doctor_fix',
    target: 'hub',
    kind: 'command',
    tier: 'mutate',
    summary:
      "Runs the fixes `fr doctor --fix` runs, in the hub process, then the checks again: installs or repairs the esptool sidecar (check pytools), refreshes the IDF environment cache (idf_env), rewrites the fr shim (shim), rebuilds the dashboard or a web app when it is older than its source (dashboard, web_<name>). `ids` names the checks whose fixes run; without it every fix runs. A hub with its own FR_HOME never rewrites the fr shim (it is the user's, outside FR_HOME). A check whose fix is a step for a person (System Settings, a brew install) stays as it was. Answers the checks after the fixes (a check fixed has fixed: true).",
    input: z.object({
      ids: z.array(z.string().min(1).max(64)).min(1).max(64).optional().describe('the checks whose fixes run (pytools, idf_env, shim, dashboard, web_<name>); absent runs every fix'),
    }),
    output: z.looseObject({ checks: z.array(CheckSchema), checked_at: z.string().optional() }),
    cli: { path: ['hub', 'doctor-fix'] },
  }),
] as const;

export type HubOpName = (typeof HUB_OPS)[number]['name'];
