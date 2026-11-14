// /devices/$id/$instance (DEVICE-SPEC §1.4): one instrument's page. The frame, the instrument strip (its siblings in
// port order, the current one in lumen; ←/→ move along it), a caption line (the capability's word · port · traits in
// words), the device's presence when it cannot take commands, then the registry's panel (panels.ts). Builder PAGE owns
// it. SEAM: usePanelProps is how every CapPanelProps is built (the Overview's rows use it too).
//
// An fr.node, fr.ota or fr.diag instance is not an instrument: its URL goes to Engineering › Commands at it. An
// instance the device does not have says so and names those it has.

import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { type KeyboardEvent, useEffect } from 'react';

import type { CatalogCapability } from '@fractonica/protocol/gen';

import type { DeviceDetail } from '../../api/types.ts';
import { useLive } from '../../hooks.ts';
import { usePresence } from '../../shell/link.ts';
import { type InstanceView, visibleMembers } from '../../state/caps.ts';
import { captionWords } from '../../state/instruments.ts';
import { Bead, EmptyState, engrave, Pending, SubNav } from '../../ui/index.ts';
import { DeviceFrame } from './frame.tsx';
import { type CapPanelProps, panelFor } from './panels.ts';
import { NOT_INSTRUMENTS, useInstrumentRows } from './use-instruments.ts';

export { NOT_INSTRUMENTS };

/** The device's instances (capability_list's, else the router's) joined to the catalog, in port order. */
export function useInstruments(detail: DeviceDetail): { instances: InstanceView[]; rows: { inst: InstanceView; cap: CatalogCapability | undefined }[] } {
  const { instances, rows } = useInstrumentRows(detail);
  return { instances, rows };
}

/** A live property mirror and the visible members of one instance: the props every panel component gets. */
export function usePanelProps(detail: DeviceDetail, inst: InstanceView, cap: CatalogCapability, instances: readonly InstanceView[]): CapPanelProps {
  const live = useLive((s) => s.properties[detail.device_id]);
  const routerProps = (detail.router?.properties ?? {}) as Record<string, unknown>;
  const members = visibleMembers(cap, inst.traits, detail.router?.hello_caps ?? null);
  const mirror: Record<string, unknown> = {};
  for (const p of members.properties) {
    const key = `${inst.name}.${p.name}`;
    mirror[p.name] = live?.[key]?.value ?? routerProps[key];
  }
  return { detail, inst, cap, members, mirror, instances };
}

/** One instrument's panel (the Overview of a one-instrument device draws it inline too). */
export function LensBody({ detail, inst, cap, instances }: { detail: DeviceDetail; inst: InstanceView; cap: CatalogCapability; instances: readonly InstanceView[] }) {
  const props = usePanelProps(detail, inst, cap, instances);
  const { Lens } = panelFor(cap.name);
  return (
    <div data-lens={inst.name} className="dev-lens-body">
      <Lens {...props} />
    </div>
  );
}

/** The catalog-missing line: this build of the dashboard does not know the capability. */
export function CatalogMissing({ cap }: { cap: string }) {
  return <p className="ash dev-quiet">This dashboard’s catalog does not know {cap}; rebuild it (fr doctor --fix).</p>;
}

/** Said on an instrument page while the device cannot take commands: its controls stay, disabled. */
export function PresenceLine({ detail }: { detail: DeviceDetail }) {
  const said = usePresence();
  const p = said(detail.presence);
  if (p === 'offline' || p === 'unknown') {
    return (
      <p className="dev-presence-line" role="status" data-presence-line="offline">
        <Bead state="offline" /> {detail.alias} is offline. Its controls come back when it greets the hub.
      </p>
    );
  }
  if (p === 'suspect') {
    return (
      <p className="dev-presence-line" role="status" data-presence-line="suspect">
        <Bead state="waiting" /> {detail.alias} has gone quiet; it may be restarting.
      </p>
    );
  }
  return null;
}

/** ←/→ move the focus along a strip of links while it is inside it (form fields keep their arrows). */
function arrows(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
    return;
  }
  const links = [...e.currentTarget.querySelectorAll<HTMLAnchorElement>('a')];
  const at = links.indexOf(document.activeElement as HTMLAnchorElement);
  if (at < 0) {
    return;
  }
  e.preventDefault();
  links[(at + (e.key === 'ArrowRight' ? 1 : links.length - 1)) % links.length]?.focus();
}

function Lens({ detail, name }: { detail: DeviceDetail; name: string }) {
  const navigate = useNavigate();
  const { instances, rows, instruments, pending } = useInstrumentRows(detail);
  const own = rows.find((r) => r.inst.name === name && NOT_INSTRUMENTS.includes(r.inst.cap));
  useEffect(() => {
    if (own) {
      void navigate({ to: '/devices/$id/engineering', params: { id: detail.alias }, search: { instrument: name } as never, replace: true });
    }
  }, [own, navigate, detail.alias, name]);
  if (own) {
    return <Pending what="its commands" word="opening" />;
  }
  const row = instruments.find((r) => r.inst.name === name);
  if (!row) {
    if (pending) {
      return <Pending what="its instruments" />;
    }
    return (
      <EmptyState
        title={`No instrument called ${name} on ${detail.alias}`}
        action={
          <Link to="/devices/$id" params={{ id: detail.alias }} className="ui-button" data-variant="default">
            <span className="ui-button-text">{engrave('All instruments')}</span>
          </Link>
        }
      >
        {instruments.length ? (
          <>
            Its instruments are{' '}
            {instruments.map((r, i) => (
              <span key={r.inst.name}>
                {i ? (i === instruments.length - 1 ? ' and ' : ', ') : ''}
                <Link to="/devices/$id/$instance" params={{ id: detail.alias, instance: r.inst.name }} className="dev-inline-link">
                  {r.inst.name}
                </Link>
              </span>
            ))}
            .
          </>
        ) : (
          'It has told the hub of no instrument yet.'
        )}
      </EmptyState>
    );
  }
  const strip = instruments.map((r) => ({ to: '/devices/$id/$instance', params: { id: detail.alias, instance: r.inst.name }, label: r.inst.name, current: r.inst.name === name }));
  return (
    <>
      {instruments.length > 1 ? (
        <div className="dev-strip" onKeyDown={arrows} data-strip="">
          <SubNav label={`${detail.alias} instruments`} items={strip} />
        </div>
      ) : null}
      <p className="dev-caption caps" data-caption="">
        {engrave(captionWords(row.inst))}
      </p>
      <PresenceLine detail={detail} />
      {row.cap ? <LensBody detail={detail} inst={row.inst} cap={row.cap} instances={instances} /> : <CatalogMissing cap={row.inst.cap} />}
    </>
  );
}

export function DeviceLensPage() {
  const { instance = '' } = useParams({ strict: false }) as { instance?: string };
  return (
    <DeviceFrame section="instruments" lens>
      {(d) => <Lens detail={d} name={instance} />}
    </DeviceFrame>
  );
}
