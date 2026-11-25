// An e-paper panel's block on its instrument page (design epaper-e1 D10), under the display block: what is known of the
// glass and the ghost budget (state/epaper.ts), the last refresh and how long it took (a Fractonica span), the three
// refreshes (display_refresh), and two ways to put something on it: a picture (display_image, the file sent inline) and
// a line of text drawn by the hub's Chrome (display_text). The picture the hub sent comes back inline and is shown.
// No button says "Send"; nothing here is a bar or a percentage.

import { useState } from 'react';

import { useAct } from '../../hooks.ts';
import { budgetOf, budgetWords, DITHER_CHOICES, fileBase64, glassWords, MAX_PICTURE_BYTES, REFRESH_ACTIONS, TEXT_SIZES } from '../../state/epaper.ts';
import { spanText } from '../../state/device-units.ts';
import { Button, ButtonRow, engrave, ErrorLine, Row, Select, TextField, useFractonica } from '../../ui/index.ts';

export function EpaperBlock({ deviceId, inst, config, mirror }: { deviceId: string; inst: string; config: Record<string, unknown> | undefined; mirror: Readonly<Record<string, unknown>> }) {
  const core = useFractonica();
  const device = `id:${deviceId}`;
  const budget = budgetOf(config);
  const refresh = useAct('display_refresh', {
    done: (r) => (r.ok === false ? { tone: 'warn', title: `${inst}: the refresh did not finish`, body: 'the next refresh is full' } : undefined),
  });
  const image = useAct('display_image');
  const text = useAct('display_text');
  const [dither, setDither] = useState<'none' | 'ordered' | 'diffusion'>('none');
  const [words, setWords] = useState('');
  const [size, setSize] = useState(String(TEXT_SIZES[1]!.px));
  const [pickError, setPickError] = useState<string | null>(null);
  const ms = typeof mirror.refresh_ms === 'number' && mirror.refresh_ms > 0 ? mirror.refresh_ms : null;
  const budgetLine = budgetWords(mirror.partials, budget);
  const shown = image.data ?? text.data;

  const pick = async (file: File | undefined) => {
    setPickError(null);
    if (!file) {
      return;
    }
    if (file.size > MAX_PICTURE_BYTES) {
      setPickError('that picture is too large for the panel block: pick a smaller one');
      return;
    }
    image.mutate({ device, instance: inst, png_base64: await fileBase64(file), fit: 'contain', dither, threshold: 128, invert: false, mode: 'auto', timeout_s: 30, inline: true });
  };

  return (
    <div className="dev-epaper" data-epaper={inst}>
      <Row label="Glass">
        <span className="ash" data-glass>
          {glassWords(mirror.shown_crc)}
        </span>
      </Row>
      {budgetLine ? (
        <Row label="Ghosts">
          <span className="ash" data-budget>
            {budgetLine}
          </span>
        </Row>
      ) : null}
      {ms !== null && core ? (
        <Row label="Last refresh">
          <span className="ash" data-refresh-ms>
            took {spanText(core, ms * 1000)}
          </span>
        </Row>
      ) : null}
      <Row label="Refresh">
        <ButtonRow>
          {REFRESH_ACTIONS.map((a) => (
            <Button
              key={a.mode}
              variant="quiet"
              busy={refresh.isPending && refresh.variables?.mode === a.mode}
              onClick={() => refresh.mutate({ device, instance: inst, mode: a.mode, timeout_s: 15 })}
              data-action={`refresh-${a.mode}`}
              aria-label={`${a.label}: ${a.doc}`}
              title={a.doc}
            >
              {a.label}
            </Button>
          ))}
        </ButtonRow>
      </Row>
      {refresh.error ? <ErrorLine error={refresh.error} what="Refresh" /> : null}
      <Row label="Picture">
        <div className="dev-epaper-pick">
          <Select label="Kind" value={dither} onChange={(v) => setDither(v as typeof dither)} options={DITHER_CHOICES.map((d) => ({ value: d.value, label: d.label }))} />
          <label className="ui-button" data-variant="quiet" data-action="picture" aria-busy={image.isPending || undefined}>
            <span className="ui-button-text">{engrave('Show a picture')}</span>
            <input type="file" accept="image/*" hidden onChange={(e) => void pick(e.target.files?.[0])} />
          </label>
        </div>
      </Row>
      {pickError ? <p className="dev-outcome-error">{pickError}</p> : null}
      {image.error ? <ErrorLine error={image.error} what="Picture" /> : null}
      <form
        className="dev-command"
        data-text={inst}
        onSubmit={(e) => {
          e.preventDefault();
          if (words.trim()) {
            text.mutate({ device, instance: inst, text: words, size_px: Number(size), font: 'Georgia, serif', align: 'center', fit: 'contain', dither: 'none', threshold: 128, invert: false, mode: 'auto', timeout_s: 30, inline: true, wait_ms: 200 });
          }
        }}
      >
        <TextField label="Text" value={words} onChange={setWords} placeholder="Words for the panel" />
        <Select label="Size" value={size} onChange={setSize} options={TEXT_SIZES.map((t) => ({ value: String(t.px), label: t.label }))} />
        <ButtonRow>
          <Button type="submit" busy={text.isPending} disabled={!words.trim()} data-action="text">
            Show the text
          </Button>
        </ButtonRow>
        {text.error ? <ErrorLine error={text.error} what="Text" /> : null}
      </form>
      {shown?.png_base64 ? (
        <div className="dev-display-shot" data-shown>
          <img className="dev-panel" src={`data:image/png;base64,${shown.png_base64}`} alt={`what the hub sent to ${inst}`} width={shown.width} height={shown.height} />
          <span className="ash">
            {shown.sent === 'none' ? 'nothing changed' : shown.sent === 'diff' ? `${shown.regions} changed areas sent` : 'the whole picture sent'}
            {shown.ok === false ? ' · the refresh did not finish' : ''}
            {core && shown.ms !== undefined ? ` · refreshed in ${spanText(core, shown.ms * 1000)}` : ''}
          </span>
        </div>
      ) : null}
    </div>
  );
}
