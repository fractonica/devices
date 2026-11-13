// An fr.display instance on the device page (design m2-c5-display D10), redrawn in the hub's language: the panel's last
// snapshot (display_snapshot: a debug build's framebuffer read back as a PNG), a click on it a tap on the panel
// (input_simulate {x, y} on the fr.touch instance bound to it, scaled to panel pixels, then a fresh snapshot), and for
// a ui panel a layout preview (display_render of a ui_load on the desktop renderer, no board needed), its UiLayout
// JSON behind a fold. Images arrive inline (base64): the dashboard cannot read the hub's files.

import { type MouseEvent, useState } from 'react';

import { useAct } from '../../hooks.ts';
import type { InstanceView } from '../../state/caps.ts';
import { spanText } from '../../state/device-units.ts';
import { Bead, Button, ButtonRow, Caps, Disclosure, ErrorLine, Row, useFractonica } from '../../ui/index.ts';

/** fr.display's read-back commands, which this block runs (display_snapshot) instead of a command form. */
export const SNAPSHOT_COMMANDS = ['snapshot', 'snapshot_read'];

/** The fr.touch instance bound to a panel (its trait display is the panel's port); with traits unknown, the only one. */
export function touchOf(panel: InstanceView, instances: readonly InstanceView[]): string | null {
  if (panel.cap !== 'fr.display') {
    return null;
  }
  const touches = instances.filter((i) => i.cap === 'fr.touch');
  const bound = touches.find((t) => t.traits?.display === panel.port);
  return bound?.name ?? (touches.length === 1 && touches[0]!.traits === null ? touches[0]!.name : null);
}

/** A starter layout for the preview (D2: UiLayout JSON, as command_send's ui_load takes it). Colours are 0xRRGGBB. */
const SAMPLE_LAYOUT = {
  bg: 0x101820,
  widgets: [
    { id: 'title', kind: 'label', x: 10, y: 10, text: 'Fractonica', font: 1 },
    { id: 'level', kind: 'bar', x: 10, y: 50, w: 150, h: 14, value: 60 },
    { id: 'ok', kind: 'button', x: 10, y: 80, w: 90, h: 40, text: 'OK', bg: 0x2060c0, align: 'center' },
  ],
};

/** The panel drawn at a whole-pixel scale near 240 px wide (the 72x40 OLED at 3x). */
function scaleOf(width: number): number {
  return width > 0 ? Math.max(1, Math.floor(240 / width)) : 1;
}

function PanelImage({ png, width, height, label, onPoint }: { png: string; width: number; height: number; label: string; onPoint?: (x: number, y: number) => void }) {
  const scale = scaleOf(width);
  const click = (e: MouseEvent<HTMLImageElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.min(width - 1, Math.max(0, Math.floor(((e.clientX - r.left) * width) / r.width)));
    const y = Math.min(height - 1, Math.max(0, Math.floor(((e.clientY - r.top) * height) / r.height)));
    onPoint?.(x, y);
  };
  return (
    <img
      className="dev-panel"
      src={`data:image/png;base64,${png}`}
      alt={label}
      width={width * scale}
      height={height * scale}
      onClick={onPoint ? click : undefined}
      data-tappable={onPoint ? '' : undefined}
    />
  );
}

export function DisplayBlock({ deviceId, inst, traits, touch, profile }: { deviceId: string; inst: string; traits: Record<string, unknown> | null; touch: string | null; profile: string | null }) {
  const core = useFractonica();
  const selector = `id:${deviceId}`;
  const ui = traits?.ui === true;
  const snap = useAct('display_snapshot');
  const tap = useAct('input_simulate', { done: (r) => (r.results[0]?.status === 'ok' ? undefined : { tone: 'warn', title: `${touch ?? 'touch'}: ${r.results[0]?.status ?? 'no answer'}` }) });
  const render = useAct('display_render');
  const [text, setText] = useState(() => JSON.stringify(SAMPLE_LAYOUT, null, 2));
  const [last, setLast] = useState<{ x: number; y: number } | null>(null);
  const row = snap.data?.results[0];
  const shoot = () => snap.mutate({ selector, instance: inst, inline: true });
  const onPoint =
    touch && row?.status === 'ok'
      ? (x: number, y: number) => {
          setLast({ x, y });
          // the panel redraws on its flush period after the touch; then the next snapshot shows it
          tap.mutate({ selector, instance: touch, x, y, gesture: 'tap' }, { onSuccess: () => setTimeout(shoot, 250) });
        }
      : undefined;
  let layout: unknown = null;
  let parseError: string | null = null;
  try {
    layout = JSON.parse(text);
  } catch (e) {
    parseError = (e as Error).message;
  }
  const preview = render.data;
  return (
    <div className="dev-display" data-display={inst}>
      <Row label="Panel">
        <ButtonRow>
          <Button variant="quiet" busy={snap.isPending} onClick={shoot} data-action="snapshot" aria-label={`Read ${inst}'s picture back`}>
            Snapshot
          </Button>
        </ButtonRow>
      </Row>
      {snap.error ? <ErrorLine error={snap.error} what="Snapshot" /> : null}
      {row ? (
        <div className="dev-display-shot" data-snapshot={row.status}>
          {row.status === 'ok' && row.png_base64 && row.width && row.height ? (
            <PanelImage png={row.png_base64} width={row.width} height={row.height} label={`${inst} as it shows now`} onPoint={onPoint} />
          ) : null}
          <div className="dev-outcome">
            <Bead state={row.status === 'ok' ? 'online' : 'fault'} label={row.status} />
            <Caps tone="bone">{row.status}</Caps>
            {row.status === 'ok' ? (
              <span className="ash">
                {row.width} × {row.height} pixels · {row.format}
                {core && row.ms !== undefined ? ` · read in ${spanText(core, row.ms * 1000)}` : ''}
                {row.link ? ` · ${row.link}` : ''}
              </span>
            ) : (
              <span className="dev-outcome-error">{row.error}</span>
            )}
          </div>
          {onPoint ? <p className="dev-doc">Click the picture to tap {touch} there{last ? ` (last ${last.x}, ${last.y})` : ''}.</p> : null}
        </div>
      ) : null}
      {ui && profile ? (
        <Disclosure title="Layout preview">
          <form
            className="dev-command"
            data-preview={inst}
            onSubmit={(e) => {
              e.preventDefault();
              if (!parseError) {
                render.mutate({ profile, instance: inst, commands: [{ cmd: 'ui_load', args: { layout: layout as Record<string, unknown> } }], inline: true });
              }
            }}
          >
            <p className="dev-doc">A UiLayout drawn by the desktop renderer for {profile}; no board is needed.</p>
            <textarea className="dev-json mono" value={text} onChange={(e) => setText(e.target.value)} rows={10} spellCheck={false} aria-label={`${inst} layout (UiLayout JSON)`} />
            {parseError ? <span className="ui-field-error">{parseError}</span> : null}
            <ButtonRow>
              <Button type="submit" busy={render.isPending} disabled={Boolean(parseError)} data-action="preview">
                Preview
              </Button>
            </ButtonRow>
            {render.error ? <ErrorLine error={render.error} what="Preview" /> : null}
            {preview && !render.isPending ? (
              <div className="dev-display-shot">
                {preview.png_base64 ? <PanelImage png={preview.png_base64} width={preview.width} height={preview.height} label={`${inst} layout preview`} /> : null}
                <span className="ash">
                  {preview.width} × {preview.height} pixels · {preview.format}
                  {preview.events.length ? ` · ${preview.events.length} ui events` : ''}
                </span>
              </div>
            ) : null}
          </form>
        </Disclosure>
      ) : null}
    </div>
  );
}
