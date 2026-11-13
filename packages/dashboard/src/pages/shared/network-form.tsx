// A Wi-Fi network for the nodes, added or changed (network_set), the same form in Settings › Networks and on
// Provision's Network step. The password is write-only: typed into a hidden field, sent once, cleared after each save
// and never filled from the hub. The bands are said by their names (2g, 5g); the frequencies are Earth units, so only
// Earth mode adds them, after ⊕.

import { useState } from 'react';

import type { Network } from '@fractonica/protocol/client';

import { useAct } from '../../hooks.ts';
import { type NetworkDraft, networkErrors, networkSetInput } from '../../state/settings-view.ts';
import { Button, ButtonRow, Disclosure, ErrorLine, Select, TextField, Toggle, useMode } from '../../ui/index.ts';
import { useInPlace } from '../../ui/in-place.ts';

function bands(earth: boolean) {
  return [
    { value: 'auto', label: 'auto: the chip picks' },
    { value: '2g', label: `2g only${earth ? ' ⊕ 2.4 GHz' : ''}` },
    { value: '5g', label: `5g only, for the ESP32-C5${earth ? ' ⊕ 5 GHz' : ''}` },
  ];
}

/** A network name from an SSID: lower case, letters, digits and hyphens, 31 at most ("Lab 5G" → "lab-5g"). */
function slug(ssid: string): string {
  return ssid
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 31);
}

export const BAND_WORD: Record<string, string> = { auto: 'auto band', '2g': '2g band', '5g': '5g band' };

function draftOf(n: Network | null, firstEver: boolean): NetworkDraft {
  return {
    name: n?.name ?? (firstEver ? 'default' : ''),
    ssid: n?.ssid ?? '',
    password: '',
    open: false,
    band: (n?.band as NetworkDraft['band']) ?? 'auto',
    country: n?.country ?? '',
    bssid: n?.bssid ?? '',
  };
}

/** Add or change a network. The password field is cleared after each save and never filled from the hub. */
export function NetworkForm({ current, firstEver, onDone, primary = true }: { current: Network | null; firstEver: boolean; onDone: (saved?: string) => void; primary?: boolean }) {
  const [d, setD] = useState<NetworkDraft>(() => draftOf(current, firstEver));
  const [tried, setTried] = useState(false);
  const save = useAct('network_set', { done: () => `network ${d.name} saved`, refresh: ['network_list', 'network_get'] });
  const errors = networkErrors(d);
  const show = (k: keyof NetworkDraft) => (tried || (k !== 'name' && k !== 'ssid') ? errors[k] : undefined);
  const set = <K extends keyof NetworkDraft>(k: K, v: NetworkDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const editing = current !== null;
  const { earth } = useMode();
  const box = useInPlace<HTMLFormElement>(`network:${current?.name ?? '+'}`, () => onDone());
  return (
    <form
      ref={box}
      className="ui-form"
      data-form="network"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (Object.keys(errors).length) {
          return;
        }
        save.mutate(networkSetInput(d), {
          onSuccess: () => {
            setD((x) => ({ ...x, password: '' }));
            onDone(d.name);
          },
        });
      }}
    >
      <TextField label="Name" value={d.name} onChange={(v) => set('name', v.toLowerCase())} maxLength={31} disabled={editing} error={show('name')} note={editing ? 'a network keeps its name' : 'how devices refer to it; the first is default'} mono />
      <TextField label="SSID" value={d.ssid} onChange={(v) => setD((x) => ({ ...x, ssid: v, ...(!editing && !firstEver && x.name === slug(x.ssid) ? { name: slug(v) } : {}) }))} maxLength={32} error={show('ssid')} note="the network name the router broadcasts" />
      <Toggle label="Open network" checked={d.open} onChange={(v) => set('open', v)} states={['no', 'yes']} />
      {!d.open ? (
        <TextField
          label="Password"
          type="password"
          value={d.password}
          onChange={(v) => set('password', v)}
          maxLength={64}
          autoComplete="new-password"
          error={show('password')}
          note={editing && current?.password_set ? 'stored on this Mac and never shown; leave empty to keep it' : 'stored on this Mac only, never shown again'}
        />
      ) : null}
      <Select label="Band" value={d.band} onChange={(v) => set('band', v as NetworkDraft['band'])} options={bands(earth)} note="5g suits only the ESP32-C5; every other chip needs auto or 2g" />
      <Disclosure title="Router and country" defaultOpen={Boolean(d.country || d.bssid)}>
        <div className="ui-form-more">
          <TextField label="Country" value={d.country} onChange={(v) => set('country', v.toUpperCase())} maxLength={2} error={show('country')} note="2 letters; sets the allowed channels" />
          <TextField label="BSSID" value={d.bssid} onChange={(v) => set('bssid', v)} maxLength={17} error={show('bssid')} note="one router's MAC, to stay on it among several" mono />
        </div>
      </Disclosure>
      <ErrorLine error={save.error} what="Save" />
      <ButtonRow>
        <Button type="submit" variant={primary ? 'primary' : 'default'} busy={save.isPending} data-action="save-network">
          {editing ? 'Save changes' : 'Add network'}
        </Button>
        <Button variant="quiet" onClick={() => onDone()}>
          Cancel
        </Button>
      </ButtonRow>
    </form>
  );
}

