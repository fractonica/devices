// A device command the hub runs (DEVICE-SPEC §2.4, §3.10, rule G3): drawn in place of a form wherever a command has a
// hub-issued field (state/hub-issued.ts). Builder CAMERA owns this file; builder PAGE renders it from the generic
// panel (for a hub-issued command no purpose-built panel covers: fr.csi, fr.audio_*) and from Engineering › Commands
// (for every one). Its props are frozen at {detail, inst, cmd}.
// - The command's words, and under them, left-aligned, "the hub runs this: <how>" (for a panel capability, "its page
//   does this (WATCH, RECORD…, PLAY)", the link beside it carrying the action).
// - A capability with a panel of its own (fr.camera): a link to that instrument's page, where WATCH, RECORD… and PLAY
//   run it. Otherwise the `fr` command line to copy.
// - fr.camera stream_stop while camera_status says a stream runs: STOP STREAM <id>, asked in place, which cancels the
//   stream's job (or, without one, sends stream_stop with the hub's own id). Never a typed id.

import { Link } from '@tanstack/react-router';

import type { CatalogCommand } from '@fractonica/protocol/gen';

import type { DeviceDetail } from '../../../api/types.ts';
import { useAct, useOp } from '../../../hooks.ts';
import type { InstanceView } from '../../../state/caps.ts';
import { commandWords } from '../../../state/cap-words.ts';
import { hubWay } from '../../../state/hub-issued.ts';
import { Button, Code, CopyButton, engrave, Row } from '../../../ui/index.ts';

export interface HubRunsProps {
  detail: DeviceDetail;
  inst: InstanceView;
  cmd: CatalogCommand;
}

/** The running camera stream's STOP (fr.camera stream_stop only). */
function StopRunning({ detail, inst }: { detail: DeviceDetail; inst: InstanceView }) {
  const status = useOp('camera_status', { device: `id:${detail.device_id}`, instance: inst.name });
  const cancel = useAct('job_cancel', { refresh: ['camera_status'] });
  const send = useAct('command_send', { refresh: ['camera_status'] });
  const s = status.data?.stream;
  if (!s) {
    return null;
  }
  return (
    <Button
      busy={cancel.isPending || send.isPending}
      disabled={detail.presence === 'offline'}
      confirm={`Stop stream ${s.stream_id}? What came so far is kept.`}
      confirmLabel="Stop"
      cancelLabel="Keep it going"
      data-action="stop-stream"
      onClick={() =>
        s.job_id
          ? cancel.mutate({ job_id: s.job_id })
          : send.mutate({ selector: `id:${detail.device_id}`, instance: inst.name, command: 'stream_stop', args: { stream_id: s.stream_id }, ack: 'result' } as Parameters<typeof send.mutate>[0])
      }
    >
      {`Stop stream ${s.stream_id}`}
    </Button>
  );
}

export function HubRuns({ detail, inst, cmd }: HubRunsProps) {
  const way = hubWay(inst.cap);
  const cli = way && !way.panel ? way.cli(detail.alias, inst.name) : null;
  const stop = inst.cap === 'fr.camera' && cmd.name === 'stream_stop';
  const verb = commandWords(inst.cap, cmd.name).verb;
  return (
    <Row
      label={verb}
      id={`${inst.name}.${cmd.name}`}
      sub={<span className="ash">{way?.panel ? way.words : `the hub runs this: ${way?.words ?? 'not from this page'}`}</span>}
      extra={cli ? <Code>{cli}</Code> : undefined}
      actions={
        <>
          {way?.panel ? (
            <Link to="/devices/$id/$instance" params={{ id: detail.alias, instance: inst.name }} className="ui-button" data-variant="quiet" data-hub-runs-link="">
              <span className="ui-button-text">{engrave(`on the ${inst.name} page ›`)}</span>
            </Link>
          ) : null}
          {cli ? <CopyButton text={cli} what={`the fr command to ${verb}`} /> : null}
          {stop ? <StopRunning detail={detail} inst={inst} /> : null}
        </>
      }
    />
  );
}
