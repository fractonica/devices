// The face block at the top of a device's Overview (HARDWARE-REVIEW §4 "Screens" 3; design face-f1 D10): for each
// fr.face instance, what the face is doing in words (on the screen or yielded to a picture, where its time comes from,
// what it moves on, its sounds when the device has a buzzer (D19), power save) and five presses (show, back, next,
// select, a long press) through command_send. Its mode, focus, step, offset, chime and clicks are set on its
// instrument page (the generic panel draws them from the catalog). A drawn mirror (the face rendered here from the
// reported state) needs the clock library in WebAssembly: a follow-up.

import type { DeviceDetail } from '../../api/types.ts';
import { useAct, useLive } from '../../hooks.ts';
import type { InstanceView } from '../../state/caps.ts';
import { enumWords } from '../../state/cap-words.ts';
import { Button, ButtonRow, Row, Section } from '../../ui/index.ts';

/** The capability name the face block answers to (design decision D4: `fr.face`). */
export const FACE_CAP = 'fr.face';

export function faceInstances(instances: readonly InstanceView[]): InstanceView[] {
  return instances.filter((i) => i.cap === FACE_CAP);
}

/** The face's properties: the live store's over the router's mirror. */
function useFaceState(deviceId: string, name: string, router: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const live = useLive((s) => s.properties[deviceId]);
  const out: Record<string, unknown> = {};
  for (const p of ['mode', 'screen', 'focus', 'step', 'shown', 'time_valid', 'time_source', 'power_save', 'chime', 'clicks']) {
    const key = `${name}.${p}`;
    out[p] = live?.[key]?.value ?? router[key];
  }
  return out;
}

/** What the face is doing, in words safe for pure mode; `sound` only for a device with a buzzer (D19). */
export function faceWords(
  s: Readonly<Record<string, unknown>>,
  buzzer = false,
): { screen: string; time: string; moves: string | null; sound: string | null; save: string | null } {
  const step = typeof s.step === 'string' ? enumWords('fr.face', 'Step', s.step) : null;
  const source = typeof s.time_source === 'string' ? enumWords('fr.face', 'TimeSource', s.time_source) : null;
  const chime = typeof s.chime === 'string' ? enumWords('fr.face', 'Chime', s.chime) : null;
  const sound = [chime ? `chimes ${chime}` : null, s.clicks === true ? 'keys click' : s.clicks === false ? 'keys silent' : null].filter((x) => x !== null);
  return {
    screen: s.shown === false ? 'yielded: a picture from the hub is on the panel' : s.shown === true ? 'on the panel' : 'not heard yet',
    time: s.time_valid === true ? `knows the time, from ${source ?? 'somewhere'}` : s.time_valid === false ? 'does not know the time yet' : 'not heard yet',
    moves: step ? `every ${step}` : null,
    sound: buzzer && sound.length ? sound.join('; ') : null,
    save: s.power_save === true ? 'on: the device is off the network; hold its key down to bring it back' : null,
  };
}

function FaceRow({ deviceId, inst, away, router, buzzer }: { deviceId: string; inst: InstanceView; away: boolean; router: Readonly<Record<string, unknown>>; buzzer: boolean }) {
  const s = useFaceState(deviceId, inst.name, router);
  const w = faceWords(s, buzzer);
  const act = useAct('command_send');
  const send = (command: string, args: Record<string, unknown> = {}) => act.mutate({ selector: `id:${deviceId}`, command: `${inst.name}.${command}`, args });
  return (
    <div data-face-inst={inst.name}>
      <Row label="Face">
        <span className="ash" data-face-screen>
          {w.screen}
        </span>
      </Row>
      <Row label="Time">
        <span className="ash" data-face-time>
          {w.time}
        </span>
      </Row>
      {w.moves ? (
        <Row label="Moves">
          <span className="ash" data-face-step>
            {w.moves}
          </span>
        </Row>
      ) : null}
      {w.sound ? (
        <Row label="Sound">
          <span className="ash" data-face-sound>
            {w.sound}
          </span>
        </Row>
      ) : null}
      {w.save ? (
        <Row label="Power save">
          <span className="ash" data-face-save>
            {w.save}
          </span>
        </Row>
      ) : null}
      <ButtonRow>
        <Button data-action="face-show" disabled={away} busy={act.isPending} onClick={() => send('show')}>
          Show the face
        </Button>
        <Button data-action="face-prev" disabled={away} onClick={() => send('input', { event: 'prev' })}>
          Back
        </Button>
        <Button data-action="face-next" disabled={away} onClick={() => send('input', { event: 'next' })}>
          Next
        </Button>
        <Button data-action="face-select" disabled={away} onClick={() => send('input', { event: 'select' })}>
          Select
        </Button>
        <Button data-action="face-long" disabled={away} onClick={() => send('input', { event: 'long' })}>
          Long press
        </Button>
      </ButtonRow>
    </div>
  );
}

export function FaceMirror({ instances, deviceId, detail }: { instances: readonly InstanceView[]; deviceId: string; detail?: Pick<DeviceDetail, 'presence' | 'router'> }) {
  const faces = faceInstances(instances);
  if (!faces.length) {
    return null;
  }
  const away = detail ? detail.presence === 'offline' || detail.presence === 'unknown' : false;
  const router = (detail?.router?.properties ?? {}) as Record<string, unknown>;
  const buzzer = instances.some((i) => i.cap === 'fr.buzzer');
  return (
    <div className="dev-face" data-face={deviceId}>
      <Section title="Face" id="face">
        {faces.map((f) => (
          <FaceRow key={f.name} deviceId={deviceId} inst={f} away={away} router={router} buzzer={buzzer} />
        ))}
      </Section>
    </div>
  );
}
