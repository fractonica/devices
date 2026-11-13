// Settings › About: what this hub and this dashboard are (HARDWARE-REVIEW §4 "Screens" 8): the hub's version and run,
// when it started, the op registry (the hub's REGISTRY_HASH and the one this dashboard was built for, which must
// match), the capability catalog's hash, the temporal core and the SPEC it implements, and the two files vendored from
// the web repository with their locks (the core's wasm and binding, time.lock; the site's token table, tokens.lock).

import { CATALOG_HASH } from '@fractonica/protocol/gen';

import tokensLockText from '../../design/tokens.lock?raw';
import timeLockText from '../../../../time/time.lock?raw';
import { useLive, useOp } from '../../hooks.ts';
import { Bead, FTime, Row, Section, useCoreError, useFractonica } from '../../ui/index.ts';

/** The dashboard's build-time op registry hash (vite.config.ts). */
declare const __FR_REGISTRY_HASH__: string | undefined;
const BUILT_FOR = typeof __FR_REGISTRY_HASH__ === 'string' ? __FR_REGISTRY_HASH__ : null;

interface Lock {
  core?: string;
  spec?: string;
  web?: { repository?: string; commit?: string };
  files?: Record<string, { from?: string; sha256?: string }>;
}

function parseLock(text: string): Lock | null {
  try {
    return JSON.parse(text) as Lock;
  } catch {
    return null;
  }
}

const TIME_LOCK = parseLock(timeLockText);
const TOKENS_LOCK = parseLock(tokensLockText);

const short = (s: string | undefined, n = 12) => (s ? s.slice(0, n) : '—');

export function AboutSection() {
  const status = useOp('hub_status', {});
  const conn = useLive((s) => s.conn);
  const core = useFractonica();
  const coreError = useCoreError();
  const s = status.data;
  const started = s ? Date.now() * 1000 - s.uptime_s * 1_000_000 : null;
  const hubHash = conn.hello?.registry_hash ?? s?.registry_hash;
  const same = !BUILT_FOR || !hubHash || BUILT_FOR === hubHash;
  const wasm = TIME_LOCK?.files?.['vendor/fractonica.wasm'];
  const tokens = TOKENS_LOCK?.files?.['tokens.js'];
  return (
    <>
      <Section title="The hub" id="hub">
        <Row label="Version" value={s ? s.version : '—'} extra={s ? `run ${s.run} of this hub's database` : undefined} />
        <Row label="Started" value={started ? <FTime at={started} form="relative" /> : '—'} />
        <Row label="Node.js" value={s ? s.node.version : '—'} />
      </Section>
      <Section title="Protocol" id="protocol">
        <Row bead={same ? 'online' : 'fault'} label="Op registry" value={<span className="mono">{hubHash ?? '—'}</span>} extra={BUILT_FOR ? (same ? 'this dashboard was built for the same registry' : <>this dashboard was built for <span className="mono">{BUILT_FOR}</span>: rebuild it with fr doctor --fix</>) : undefined} />
        <Row label="Capability catalog" value={<span className="mono">{CATALOG_HASH.toString(16).padStart(8, '0')}</span>} extra="catalog_hash, as firmware built from this checkout reports it" />
      </Section>
      <Section title="Fractonica time" id="time">
        <Row bead={core ? 'online' : coreError ? 'fault' : 'idle'} label="Temporal core" value={core ? core.frc.version : coreError ? 'did not load' : 'loading'} extra={coreError ? coreError.message : undefined} />
        <Row label="SPEC" value={core ? core.frc.specVersion : (TIME_LOCK?.spec ?? '—')} />
        <Row label="Core files" value={<span className="mono">{short(wasm?.sha256)}</span>} extra={TIME_LOCK ? <>fractonica.wasm from the web repository at <span className="mono">{short(TIME_LOCK.web?.commit, 7)}</span> (time.lock, core {TIME_LOCK.core})</> : 'time.lock unreadable'} />
      </Section>
      <Section title="Design" id="design">
        <Row label="Token table" value={<span className="mono">{short(tokens?.sha256)}</span>} extra={TOKENS_LOCK ? <>the site’s tokens.js at <span className="mono">{short(TOKENS_LOCK.web?.commit, 7)}</span> (tokens.lock); fr gen --check reports drift</> : 'tokens.lock unreadable'} />
        <Row label="Theme" value="Astrolabe" extra={<>dark only · one hub colour of its own, fault <Bead state="fault" label="the fault colour" size={6} /></>} />
      </Section>
    </>
  );
}
