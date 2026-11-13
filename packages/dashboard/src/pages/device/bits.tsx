// Small pieces the Devices and Device pages share: the input flash, Identify, Rename, a value in both modes, the
// signal as beads, a meter (a lumen hairline lit to a share, as the LENS travel rows), and the colour well.
// LOCAL to these pages; candidates for src/ui once another page needs them (listed in the stage 4 report).

import { type ReactNode, useEffect, useId, useState } from 'react';

import type { DeviceView } from '@fractonica/protocol/client';

import { useAct, useLive, useOp } from '../../hooks.ts';
import { hubClock } from '../../runtime.ts';
import { colourHex, hexColour } from '../../state/device-controls.ts';
import { signalOf, valueText } from '../../state/device-units.ts';
import { aliasTaken } from '../../state/provision.ts';
import { aliasError } from '../../state/wizard.ts';
import { useInPlace } from '../../ui/in-place.ts';
import { Button, Earth, engrave, Reading, TextField, useFractonica } from '../../ui/index.ts';

/** Whether a device's row flashes now (an input came, live store `flashUntil`); re-renders when it ends. */
export function useFlash(deviceId: string): boolean {
  const until = useLive((s) => s.flashUntil[deviceId] ?? 0);
  const [, tick] = useState(0);
  const left = until - hubClock.hubNow();
  useEffect(() => {
    if (left > 0) {
      const t = setTimeout(() => tick((n) => n + 1), left + 5);
      return () => clearTimeout(t);
    }
  }, [until, left]);
  return left > 0;
}

/** Identify: the node lights its first LED for a while (fr.node.identify, which every node has). */
export function IdentifyButton({ device, variant = 'default' }: { device: Pick<DeviceView, 'device_id' | 'alias' | 'presence'>; variant?: 'default' | 'primary' | 'quiet' }) {
  const act = useAct('command_send', {
    done: (r) => {
      const res = r.results[0];
      return res?.status === 'ok'
        ? `${device.alias} is lighting its LED`
        : { tone: 'warn', title: `${device.alias}: identify ${res?.status ?? 'unanswered'}`, ...(res?.error ? { body: res.error } : {}) };
    },
  });
  const offline = device.presence === 'offline' || device.presence === 'unknown';
  return (
    <Button
      variant={variant}
      data-action="identify"
      busy={act.isPending}
      disabled={offline}
      aria-label={`Identify ${device.alias}: light its LED`}
      onClick={() => act.mutate({ selector: `id:${device.device_id}`, command: 'node.identify', args: { ms: 3000 } })}
    >
      Identify
    </Button>
  );
}

/** Rename in place: the alias checked as it is typed (the registry's rules, 31 characters). */
export function RenameForm({ device, onDone, onRenamed }: { device: Pick<DeviceView, 'device_id' | 'alias'>; onDone: () => void; onRenamed?: (alias: string) => void }) {
  const [alias, setAlias] = useState(device.alias);
  // a clash is said on the field, never as a toast: the registry as the page knows it, then the hub's own refusal
  const [refused, setRefused] = useState<{ alias: string; why: string } | null>(null);
  const act = useAct('device_update', { done: (d) => `renamed to ${d.alias}`, refresh: ['device_list', 'device_get'], quiet: (e) => e.code === 'INVALID_ARGS' && /\btaken\b/.test(e.message) });
  const devices = useOp('device_list', {});
  const box = useInPlace<HTMLFormElement>(`rename:${device.device_id}`, onDone);
  const next = alias.trim().toLowerCase();
  const taken = aliasTaken(next, devices.data?.devices ?? [], device.device_id);
  const problem = next === '' ? 'a name is needed' : (aliasError(alias) ?? taken ?? (refused?.alias === next ? refused.why : null));
  const same = next === device.alias;
  return (
    <form
      ref={box}
      className="dev-rename"
      data-form="rename"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem && !same) {
          act.mutate(
            { device: `id:${device.device_id}`, alias: next },
            {
              onSuccess: (d) => (onRenamed?.(d.alias), onDone()),
              onError: (e) => /\btaken\b/.test(e.message) && setRefused({ alias: next, why: `${next} is taken by another device` }),
            },
          );
        }
      }}
    >
      <TextField
        label="New name"
        value={alias}
        onChange={setAlias}
        maxLength={31}
        error={!same ? problem : null}
        note="Lowercase letters, digits and hyphens; 31 at most. The device learns it at once if it is online."
      />
      <div className="dev-rename-buttons">
        <Button type="submit" variant="primary" busy={act.isPending} disabled={!!problem || same}>
          Rename
        </Button>
        <Button variant="quiet" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** A number in a unit: the pure text, then in Earth mode its ⊕ translation in ash. */
export function UnitValue({ value, unit, children }: { value: number; unit?: string | null; children?: ReactNode }) {
  const core = useFractonica();
  const v = valueText(core, value, unit);
  return (
    <span className="dev-unit-value">
      {children}
      {v.text ? <Reading text={v.text} /> : null}
      {v.earth ? (
        <Earth className="dev-earth-inline">{v.earth}</Earth>
      ) : null}
    </span>
  );
}

/** The signal as five beads lit to its level, and its word; ⊕ the RSSI in Earth mode. */
export function Signal({ rssi }: { rssi: number | null | undefined }) {
  const s = signalOf(rssi);
  if (!s) {
    return <span className="ash">not on Wi-Fi</span>;
  }
  return (
    <span className="dev-signal" data-signal={s.level}>
      <svg width="34" height="6" viewBox="0 0 34 6" role="img" aria-label={`signal ${s.word}`}>
        {[0, 1, 2, 3, 4].map((i) => (
          <circle key={i} cx={3 + i * 7} cy={3} r={2.2} className={i <= s.level ? 'lit' : ''} />
        ))}
      </svg>
      <span>{s.word}</span>
      <Earth className="dev-earth-inline">{`${rssi} dBm`}</Earth>
    </span>
  );
}

/** A share as light: an etch hairline lit in lumen to `fraction`, ending in a bead (the LENS travel rows). */
export function Meter({ fraction, label, width = 96 }: { fraction: number; label: string; width?: number }) {
  const x = 1.5 + Math.min(1, Math.max(0, fraction)) * (width - 3);
  return (
    <svg className="dev-meter" width={width} height="6" viewBox={`0 0 ${width} 6`} role="img" aria-label={label}>
      <line className="base" x1="0" x2={width} y1="3" y2="3" />
      <line className="lit" x1="0" x2={x} y1="3" y2="3" />
      <circle className="end" cx={x} cy="3" r="1.8" />
    </svg>
  );
}

/** A colour as the device shows it: a small disc of that colour in an etch ring (data, not palette). */
export function ColourDisc({ value, size = 12 }: { value: number; size?: number }) {
  return <span className="dev-colour-disc" style={{ width: size, height: size, backgroundColor: colourHex(value) }} aria-hidden="true" />;
}

/** The colour well: the platform's colour picker behind a disc of the colour, the hex beside it. */
export function ColourWell({ value, onChange, label, disabled }: { value: number; onChange: (v: number) => void; label: string; disabled?: boolean }) {
  const id = useId();
  const hex = colourHex(value);
  return (
    <label className="dev-colour-well" htmlFor={id} data-disabled={disabled ? '' : undefined}>
      <ColourDisc value={value} size={16} />
      <input
        id={id}
        type="color"
        value={hex}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => {
          const n = hexColour(e.target.value);
          if (n !== null) {
            onChange(n);
          }
        }}
      />
      <span className="mono">{hex.slice(1).toUpperCase()}</span>
    </label>
  );
}

/** A bool property as a bead and its word: on (lit) or off (engraved). */
export function OnOff({ value, words = ['off', 'on'] }: { value: boolean; words?: [string, string] }) {
  return (
    <span className="dev-onoff" data-on={value ? '' : undefined}>
      <svg width="7" height="7" viewBox="-3.5 -3.5 7 7" aria-hidden="true">
        <circle r="3" />
      </svg>
      <span className="caps">{engrave(value ? words[1] : words[0])}</span>
    </span>
  );
}
