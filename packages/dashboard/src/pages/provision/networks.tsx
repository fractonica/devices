// Step 2, Network: the Wi-Fi networks the hub keeps (network_list: several, each with its band; a password is never
// returned, only whether one is stored), one picked for this board, and "Add a network" inline: the same form as in
// Settings › Networks (pages/shared/network-form.tsx), whose password is write-only.

import { useState } from 'react';

import { chosenNetwork, type NetworkOption, type WizardState } from '../../state/wizard.ts';
import { Button, ButtonRow, Disclosure, ErrorLine } from '../../ui/index.ts';
import { NetworkForm } from '../shared/network-form.tsx';
import { ChoiceRow, Choices } from './choice.tsx';

export interface NetworkStepProps {
  s: WizardState;
  error: unknown;
  onChoose: (name: string) => void;
  onContinue: () => void;
  onRecheck: () => void;
}

/** The band in words: what the board joins on. */
function bandWords(n: NetworkOption): string {
  return n.band === '5g' ? '5g band' : n.band === '2g' ? '2g band' : 'any band';
}

export function NetworkStep({ s, error, onChoose, onContinue, onRecheck }: NetworkStepProps) {
  const list = s.networks ?? [];
  const chosen = chosenNetwork(s);
  const [adding, setAdding] = useState<boolean | null>(null);
  const open = adding ?? list.length === 0;
  return (
    <div className="prov-step-body">
      <ErrorLine error={error} what="Networks" fix={{ label: 'Try again', onClick: onRecheck }} />
      {list.length ? (
        <Choices label="Wi-Fi networks">
          {list.map((n, i) => (
            <ChoiceRow
              key={n.name}
              id={n.name}
              chosen={chosen?.name === n.name}
              tabbable={!chosen && i === 0}
              onChoose={() => onChoose(n.name)}
              name={n.ssid}
              extra={
                <>
                  <span className="mono">{n.name}</span> · {bandWords(n)} · {n.password_set ? 'password stored' : 'open network'}
                </>
              }
              value={n.devices ? `${n.devices} ${n.devices === 1 ? 'device' : 'devices'}` : 'no devices yet'}
            />
          ))}
        </Choices>
      ) : s.networks !== null ? (
        <p className="prov-lede">The hub keeps no Wi-Fi network yet. Store the one your boards should join; every board you provision joins it.</p>
      ) : null}
      <Disclosure title={list.length ? 'Add a network' : 'The network'} open={open} onOpenChange={setAdding}>
        <NetworkForm
          current={null}
          firstEver={!list.length}
          primary={false}
          onDone={(name) => {
            setAdding(false);
            if (name) {
              onChoose(name);
            }
          }}
        />
      </Disclosure>
      <ButtonRow>
        <Button variant="primary" onClick={onContinue} disabled={!chosen} data-action="continue">
          Continue
        </Button>
      </ButtonRow>
    </div>
  );
}
