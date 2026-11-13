// SPECIMEN, route `/ui` (not on the rail): every primitive of src/ui in its states, for the page builders to look at
// and to check against the rulings at 1440 and 390 px (tools/dash-shoot.mjs /ui=specimen). Not a page of the hub.

import { useState } from 'react';

import {
  Bead,
  Button,
  ButtonRow,
  Caps,
  Disclosure,
  EmptyState,
  ErrorLine,
  FTime,
  Page,
  PROVISION_STAGES,
  Reading,
  Row,
  Section,
  Select,
  Slider,
  Sparkline,
  StageRing,
  Term,
  TextField,
  Toggle,
} from '../ui/index.ts';
import { OpError } from '../api/rest.ts';

const WAVE = Array.from({ length: 60 }, (_, i) => -60 + 8 * Math.sin(i / 5) + (i % 7));

export function SpecimenPage() {
  const [name, setName] = useState('desk-pad');
  const [net, setNet] = useState('home');
  const [led, setLed] = useState(true);
  const [level, setLevel] = useState(96);
  const now = Date.now() * 1000;
  return (
    <Page title="Specimen" sub="The primitives of src/ui" earth="an Earth line, led by the Earth sign" actions={<Button variant="primary">Primary</Button>}>
      <Section title="Rows and beads" aside={<Caps>4 of 5 online</Caps>}>
        <Row bead="online" name="desk-pad" value={<span className="ash">c6-pad</span>} extra="tcp · serial" to="/devices/$id" params={{ id: 'desk-pad' }} />
        <Row bead="waiting" name="hall-pad" value="suspect" />
        <Row bead="offline" name="attic-pad" value="offline" />
        <Row bead="fault" name="porch-analog" value="crashed" />
        <Row label="Last seen" value={<FTime at={now - 42_000_000} form="relative" />} />
        <Row label="Event at" value={<FTime at={now} />} />
        <Row label="Stamp" value={<FTime at={now} form="stamp" stack />} />
        <Row label="RSSI" value={<Sparkline values={WAVE} label="rssi" />} extra="the last 60 values" />
        <Row label="A flashing row" value="input" flash />
      </Section>
      <Section title="Beads with words">
        <ButtonRow>
          {(['online', 'waiting', 'offline', 'fault', 'idle'] as const).map((s) => (
            <Bead key={s} state={s} showLabel />
          ))}
        </ButtonRow>
      </Section>
      <Section title="Buttons" body="loose">
        <ButtonRow>
          <Button variant="primary">Provision</Button>
          <Button>Identify</Button>
          <Button variant="quiet">Copy cursor</Button>
          <Button variant="destructive" confirm="Forget desk-pad?" confirmLabel="Forget">
            Forget
          </Button>
          <Button disabled>Disabled</Button>
          <Button busy>Working</Button>
        </ButtonRow>
      </Section>
      <Section title="Fields" body="loose">
        <TextField label="Name" value={name} onChange={setName} maxLength={31} note="31 characters at most" />
        <TextField label="Name" value="Desk Pad!" onChange={() => {}} error="letters, digits and hyphens only" />
        <Select label="Network" value={net} onChange={setNet} options={[{ value: 'home', label: 'home' }, { value: 'lab', label: 'lab' }]} />
        <Toggle label="LED" checked={led} onChange={setLed} states={['off', 'on']} />
        <Slider label="Brightness" value={level} min={0} max={255} onChange={setLevel} />
      </Section>
      <Section title="Stage rings" body="loose">
        <ButtonRow>
          <StageRing stages={PROVISION_STAGES} current={5} fraction={0.4} label="flash at 40 of 100 blocks" />
          <StageRing stages={PROVISION_STAGES} current={2} size={120} />
          <StageRing stages={PROVISION_STAGES} current={7} failed size={120} />
          <StageRing stages={PROVISION_STAGES} current={9} size={120} />
        </ButtonRow>
      </Section>
      <Section title="Errors">
        <ErrorLine
          error={new OpError({ code: 'PORT_BUSY_EXTERNAL', message: 'the port is held by idf.py (pid 4242)', retryable: false, hint: 'lend it to that program, or close it' })}
          fix={{ label: 'Release', onClick: () => {} }}
        />
        <ErrorLine error={new OpError({ code: 'NOT_FOUND', message: 'unknown op hub_doctor', retryable: false })} what="Doctor" />
      </Section>
      <Section title="Folds and empties">
        <Disclosure title="Engineering" aside={<Caps>3</Caps>} defaultOpen>
          <Row label="Bindings" value="3" />
          <Row label="Reading" value={<Reading text="ε#5 34η 29ι 21λ 3ν" />} />
        </Disclosure>
        <EmptyState title="No devices yet" action={<Button variant="primary">Provision a board</Button>}>
          Plug a board in with a USB cable; it shows up here.
        </EmptyState>
      </Section>
      <Section title="Log">
        <Term
          height="160px"
          label="specimen log"
          onOpen={(t) => {
            t.line('I (312) fr_net: joined, rssi -61');
            t.line('W (318) fr_ota: no image yet', 'warn');
            t.line('E (402) fr_caps: led: bad value', 'error');
            t.line('D (403) fr_core: tick', 'debug');
            t.line('stage flash', 'event');
          }}
        />
      </Section>
    </Page>
  );
}
