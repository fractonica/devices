// The camera's live view (DEVICE-SPEC §3.3, §3.4): the /app/stream socket as a hook, and the canvas it draws on.
// - One socket at a time; WATCH opens it with `start` (a live view the hub ends when its last starter leaves), a
//   recording or PLAY opens it without (it joins the running stream).
// - Leaving the page closes it (unmount). A hidden tab closes it and remembers how it was opened; it reopens when the
//   tab shows again, and the view says it was paused meanwhile.
// - The hub ending the stream the socket shows (this page's own view cancelled elsewhere, the board's end, a joined
//   recording's end) closes it: the panel goes idle and says how it ended. A final close (4400, 4401, 4409) is not retried when the tab shows again.
// - The canvas keeps the last frame after a session, dimmed, with when it came; a photo shows in its place.

import { type RefObject, useCallback, useEffect, useReducer, useRef, useState } from 'react';

import type { JpegBlock } from '@fractonica/sdk/camera';

import { appToken } from '../../../../api/app-token.ts';
import { StreamClient, type StreamSocketLike, type StreamStart, streamUrl } from '../../../../api/stream.ts';
import { FRAME_PIXELS, type FrameSize, headChanged, LIVE_OFF, type LiveAction, liveReducer, type LiveView } from '../../../../state/camera.ts';
import { FTime } from '../../../../ui/index.ts';

/** How the socket was opened: with `start` (WATCH), or joining (`start` undefined). */
interface Opened {
  start: StreamStart | undefined;
}

export interface LiveViewHandle {
  view: LiveView;
  canvas: RefObject<HTMLCanvasElement | null>;
  /**
   * The frame head on screen, for the Now rows and the sensor settings: set on the first frame and each time the frame
   * size or quality changes (`at`: when that frame came), not per frame.
   */
  last: { block: JpegBlock; at: number } | null;
  /** The frame on screen now (KEEP THIS FRAME). */
  lastFrame(): { block: JpegBlock; at: number } | null;
  /** Opens the socket (closing one that is open); `resumed` after a hidden tab. */
  open(start?: StreamStart, resumed?: boolean): void;
  /** Closes it (this page's own stop). */
  close(): void;
  /** Whether a socket is open or opening. */
  active: boolean;
  hasToken: boolean;
  /** Frames drawn since the socket opened (a ref read: no render per frame). */
  framesDrawn(): number;
}

/** createImageBitmap from the JPEG's bytes (the browser decodes off the main thread). */
function decode(jpeg: Uint8Array): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));
}

export function useLiveView(device: string, instance: string, onEvent?: (a: LiveAction) => void): LiveViewHandle {
  const [view, dispatch] = useReducer(liveReducer, LIVE_OFF);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const client = useRef<StreamClient<ImageBitmap> | null>(null);
  const opened = useRef<Opened | null>(null);
  const drawn = useRef(0);
  const [last, setLast] = useState<{ block: JpegBlock; at: number } | null>(null);
  const lastRef = useRef<{ block: JpegBlock; at: number } | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const token = appToken();

  const act = useCallback((a: LiveAction) => {
    dispatch(a);
    onEventRef.current?.(a);
  }, []);

  const shut = useCallback(() => {
    const c = client.current;
    client.current = null;
    if (c) {
      c.stop();
    }
    if (lastRef.current) {
      setLast(lastRef.current);
    }
  }, []);

  const open = useCallback(
    (start?: StreamStart, resumed = false) => {
      shut();
      if (!token || typeof WebSocket === 'undefined') {
        return;
      }
      opened.current = { start };
      drawn.current = 0;
      act({ t: 'open', own: start !== undefined, at: Date.now(), resumed });
      const c: StreamClient<ImageBitmap> = new StreamClient<ImageBitmap>({
        url: streamUrl(location),
        token,
        device,
        instance,
        ...(start ? { start } : {}),
        connect: (url) => new WebSocket(url) as unknown as StreamSocketLike,
        decode,
        onFrame: ({ image, block }) => {
          if (client.current !== c) {
            image.close();
            return;
          }
          const el = canvas.current;
          if (el) {
            if (el.width !== image.width || el.height !== image.height) {
              el.width = image.width;
              el.height = image.height;
            }
            el.getContext('2d')?.drawImage(image, 0, 0);
          }
          image.close();
          const first = drawn.current === 0;
          drawn.current++;
          const prev = lastRef.current;
          lastRef.current = { block, at: Date.now() };
          if (first || headChanged(prev?.block ?? null, block)) {
            setLast(lastRef.current); // a render only when the head changes, not per frame
          }
          if (first) {
            act({ t: 'frame' });
          }
        },
        dispose: (image) => image.close(),
        onEvent: (e) => {
          if (client.current !== c) {
            return;
          }
          switch (e.type) {
            case 'welcome':
              act({ t: 'welcome', stream: e.stream });
              break;
            case 'started':
              drawn.current = 0;
              act({ t: 'started', stream: e.stream });
              break;
            case 'ended':
              setLast(lastRef.current);
              act({ t: 'ended', frame: e.frame });
              if (opened.current) {
                // the stream this socket showed is over (this page's own view, a recording or PLAY it joined): the hub
                // starts no other on it, so it closes and the panel says how it ended
                opened.current = null;
                shut();
                act({ t: 'stop' });
              }
              break;
            case 'skipped':
              act({ t: 'skipped', frames: e.frames });
              break;
            case 'error':
              act({ t: 'error', code: e.code, message: e.message });
              break;
            case 'closed':
              if (!e.final || e.code !== 1000) {
                act({ t: 'closed', code: e.code, final: e.final });
              }
              if (e.final) {
                client.current = null;
                opened.current = null; // refused (4400/4401/4409): showing the tab again does not ask again
              }
              break;
            default:
              break;
          }
        },
      });
      client.current = c;
      c.start();
    },
    [act, device, instance, shut, token],
  );

  const close = useCallback(() => {
    opened.current = null;
    shut();
    act({ t: 'stop' });
  }, [act, shut]);

  // A hidden tab closes the socket and reopens it, as it was opened, when the tab shows again.
  useEffect(() => {
    const vis = () => {
      if (document.visibilityState === 'hidden') {
        if (client.current && opened.current) {
          shut();
          act({ t: 'pause' });
        }
      } else if (opened.current && !client.current) {
        open(opened.current.start, true);
      }
    };
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, [act, open, shut]);

  // Leaving the page closes it.
  useEffect(() => () => shut(), [shut]);

  return {
    view,
    canvas,
    last,
    open,
    close,
    lastFrame: () => lastRef.current,
    active: view.phase === 'connecting' || view.phase === 'open' || view.phase === 'reconnecting',
    hasToken: token !== null,
    framesDrawn: () => drawn.current,
  };
}

export interface ViewProps {
  handle: LiveViewHandle;
  instance: string;
  /** Frames show now (watching, joined, recording). */
  live: boolean;
  /** The frame size the outline is drawn at before any frame. */
  frameSize: FrameSize;
  /** The line the state says over the view (null: the frames say it). */
  line: string | null;
  /** The view's caption (from the card, recording 7). */
  caption?: string | null;
  /** A photo to show in the view while no frames show (its /captures URL), with its SAVE link under it. */
  still?: { url: string; alt: string } | null;
}

/** The canvas at the frame's aspect: an outline before any frame, the last frame dimmed after a session. */
export function LiveCanvas({ handle, instance, live, frameSize, line, caption, still }: ViewProps) {
  const px = FRAME_PIXELS[frameSize] ?? FRAME_PIXELS.svga;
  const had = handle.last !== null;
  const photo = !live && still ? still : null;
  // the view's height follows what is left of the window (the transport stays in sight), its width the frame's aspect
  const style = { aspectRatio: `${px[0]} / ${px[1]}`, ['--cam-ar' as string]: String(px[0] / px[1]) };
  return (
    <figure className="cam-view" data-live={live ? '' : undefined} data-had={had ? '' : undefined} data-still={photo ? '' : undefined}>
      <div className="cam-frame" style={style}>
        <canvas ref={handle.canvas} className="cam-canvas" aria-label={`live view of ${instance}`} role="img" width={px[0]} height={px[1]} />
        {photo ? <img className="cam-still-in" src={photo.url} alt={photo.alt} /> : null}
        <p className="cam-line" role="status">
          {photo ? null : line}
        </p>
      </div>
      <figcaption className="cam-caption">
        {caption ? <span>{caption}</span> : null}
        {photo ? (
          <span className="cam-still-caption">
            <span>the photo</span>
            <a className="ui-button" data-variant="quiet" href={photo.url} download data-action="save-photo">
              <span className="ui-button-text">SAVE</span>
            </a>
          </span>
        ) : !live && had ? (
          <span>
            the last frame · <FTime at={new Date((handle.lastFrame() ?? handle.last!).at)} form="relative" />
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

/** KEEP THIS FRAME: the JPEG on screen as a browser download. */
export function downloadFrame(block: JpegBlock, name: string): void {
  const url = URL.createObjectURL(new Blob([block.jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
