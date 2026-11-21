// Firmware across hubs (design multi-hub-m2 §7.3): the hub that holds a board serves its update from its own node
// HTTP port, from its own artifact store. When the build is only at the hub that passed the op on (the Mac builds, the
// home hub cannot), the holder fetches it first: the manifest and the store's row by build id (the link service
// `artifact_get`), then every blob the manifest names over a data channel, each checked against the SHA-256 it is
// named by; then the manifest is written and the artifact registered as this hub's own. A blob already in the store
// is not fetched again; a fetch cut half-way leaves no artifact (the row is written last) and no blob under its hash
// (channels.ts renames a whole, checked file).

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { paths } from '@fractonica/host';
import { type ArtifactManifest, ArtifactManifestSchema, FrError } from '@fractonica/protocol';

import { blobPath } from '../artifacts.ts';
import type { HubContext } from '../context.ts';
import type { PeerHub } from './index.ts';

const BLOB_REF = /^sha256:([0-9a-f]{64})$/;
/** A build id is `<app>/<profile>/<variant>/<fw>`: path segments of the store, nothing that climbs. */
const BUILD_ID = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+){1,5}$/;
/** An app image is 1.3 to 1.6 MB; a merged bootloader, table and app stay far under this. */
const BLOB_MAX = 64 << 20;

/** The store's row of an artifact, as `artifact_get` answers it beside the manifest. */
export interface ArtifactRow {
  build_id: string;
  source_dir: string;
  profile: string;
  build_type: string;
  fw_id: string;
  built_at: string;
  fault: string | null;
}

function checkBuildId(buildId: unknown): string {
  if (typeof buildId !== 'string' || !BUILD_ID.test(buildId) || buildId.split('/').some((s) => s === '.' || s === '..')) {
    throw new FrError('INVALID_ARGS', `${JSON.stringify(buildId)} is not a build id`);
  }
  return buildId;
}

/** Every blob a manifest names, by hash. */
function blobsOf(manifest: ArtifactManifest): string[] {
  const found = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      const m = BLOB_REF.exec(v);
      if (m) {
        found.add(m[1]);
      }
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  };
  walk(manifest);
  return [...found];
}

/** Whether this hub's store has the artifact whole: its row, its manifest and every blob. */
export function hasArtifact(hub: Pick<HubContext, 'db'>, buildId: string): boolean {
  const row = hub.db.prepare('SELECT manifest_path FROM artifacts WHERE build_id = ?').get(buildId) as { manifest_path: string } | undefined;
  if (!row || !existsSync(row.manifest_path)) {
    return false;
  }
  try {
    const manifest = ArtifactManifestSchema.parse(JSON.parse(readFileSync(row.manifest_path, 'utf8')));
    return blobsOf(manifest).every((h) => existsSync(blobPath(h)));
  } catch {
    return false;
  }
}

/** `artifact_get` (a link service): the manifest and the row of a build this hub has. NOT_FOUND otherwise. */
export function artifactGet(hub: Pick<HubContext, 'db'>, input: Record<string, unknown>): { manifest: ArtifactManifest; row: ArtifactRow } {
  const buildId = checkBuildId(input.build_id);
  const row = hub.db.prepare('SELECT build_id, source_dir, profile, build_type, fw_id, built_at, fault, manifest_path FROM artifacts WHERE build_id = ?').get(buildId) as (ArtifactRow & { manifest_path: string }) | undefined;
  if (!row || !existsSync(row.manifest_path)) {
    throw new FrError('NOT_FOUND', `no artifact ${buildId}`);
  }
  const { manifest_path, ...rest } = row;
  return { manifest: ArtifactManifestSchema.parse(JSON.parse(readFileSync(manifest_path, 'utf8'))), row: rest };
}

/** The `blob` data channel: a blob of this hub's store by its hash. */
export function blobFile(ref: Record<string, unknown>): { path: string } {
  const h = typeof ref.sha256 === 'string' ? ref.sha256.toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(h)) {
    throw new FrError('INVALID_ARGS', 'not a blob hash');
  }
  const path = blobPath(h);
  if (!existsSync(path)) {
    throw new FrError('NOT_FOUND', `no blob ${h.slice(0, 12)}… in the store`);
  }
  return { path };
}

const fetching = new Map<string, Promise<boolean>>();

/**
 * Makes build `buildId` this hub's own when it is not: fetched from hub `from`, which named it in an op it passed on.
 * True when it was fetched, false when this hub had it or `from` does not have it either (the op then says what it
 * says without it). Throws when the fetch started and failed: the op must not run on half an artifact.
 */
export function ensureArtifact(hub: HubContext, from: PeerHub, buildId: string): Promise<boolean> {
  let id: string;
  try {
    id = checkBuildId(buildId);
  } catch {
    return Promise.resolve(false);
  }
  if (hasArtifact(hub, id)) {
    return Promise.resolve(false);
  }
  const key = `${paths.artifacts()}\0${id}`;
  let p = fetching.get(key);
  if (!p) {
    p = fetchArtifact(hub, from, id).finally(() => fetching.delete(key));
    fetching.set(key, p);
  }
  return p;
}

async function fetchArtifact(hub: HubContext, from: PeerHub, buildId: string): Promise<boolean> {
  const peers = hub.peers!;
  const got = await peers.call(from.id, 'artifact_get', { build_id: buildId }, { mode: 'sys', timeoutMs: 15_000, repeatable: true });
  if (!got.result.ok) {
    if (got.result.error?.code === 'NOT_FOUND') {
      return false;
    }
    throw new FrError(got.result.error?.code ?? 'INTERNAL', `fetching artifact ${buildId} from hub ${from.name}: ${got.result.error?.message ?? 'no answer'}`);
  }
  const data = got.result.data as { manifest?: unknown; row?: Partial<ArtifactRow> };
  const parsed = ArtifactManifestSchema.safeParse(data?.manifest);
  if (!parsed.success || parsed.data.build_id !== buildId || !data.row || data.row.fw_id !== parsed.data.fw_id) {
    throw new FrError('DELIVERY_FAILED', `hub ${from.name} answered artifact ${buildId} with a manifest that is not its own`);
  }
  const manifest = parsed.data;
  const t0 = Date.now();
  let bytes = 0;
  for (const h of blobsOf(manifest)) {
    const dest = blobPath(h);
    if (existsSync(dest)) {
      continue;
    }
    // Written under a temporary name, checked against the hash it is named by, then renamed: never a short blob.
    const pulled = await peers.pull(from.id, 'blob', { sha256: h }, dest, { sha256: h, maxBytes: BLOB_MAX });
    bytes += pulled.bytes;
  }
  const app = manifest.flash.files.find((f) => f.role === 'app');
  if (app && statSync(blobPath(app.blob)).size !== app.size) {
    throw new FrError('DELIVERY_FAILED', `the app image of ${buildId} from hub ${from.name} is not the size its manifest says`);
  }
  const manifestPath = join(paths.artifacts(), 'builds', buildId, 'manifest.json');
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const row = data.row;
  hub.db
    .prepare(
      'INSERT INTO artifacts (build_id, source_dir, profile, build_type, fw_id, built_at, manifest_path, fault) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(build_id) DO UPDATE SET source_dir = excluded.source_dir, built_at = excluded.built_at, manifest_path = excluded.manifest_path, fault = excluded.fault',
    )
    .run(buildId, manifest.source_dir, manifest.profile, manifest.build_type, manifest.fw_id, typeof row.built_at === 'string' ? row.built_at : manifest.built_at, manifestPath, manifest.fault ?? (typeof row.fault === 'string' ? row.fault : null));
  console.log(JSON.stringify({ event: 'peer_artifact_fetched', build_id: buildId, fw_id: manifest.fw_id.slice(0, 16), from: from.name, bytes, ms: Date.now() - t0 }));
  return true;
}
