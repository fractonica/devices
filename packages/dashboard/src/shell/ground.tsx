// The plate (the site's app/drawing/ground.js): void, a radial vignette from plate to void over 0.7 x the longer side,
// and the machining marks, concentric 0.5 px etch-1 circles at 19 / 26 / 33 px, all on one fixed canvas behind the
// page. The marks centre on the page's anchor (useGroundAnchor: a page's instrument), else on the main column at 38 %
// of the height. Colours and spacings are the tokens'.

import { type RefObject, useEffect, useRef } from 'react';

import { theme, withAlpha } from '../design/hub-tokens.ts';

let anchor: HTMLElement | null = null;
const listeners = new Set<() => void>();

/** Centres the marks on `ref`'s element while the calling component is mounted. */
export function useGroundAnchor(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    anchor = ref.current;
    listeners.forEach((l) => l());
    return () => {
      if (anchor === ref.current) {
        anchor = null;
        listeners.forEach((l) => l());
      }
    };
  }, [ref]);
}

function centre(width: number, height: number): { cx: number; cy: number; r0: number } {
  if (anchor?.isConnected) {
    const r = anchor.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, r0: Math.max(19, Math.min(r.width, r.height) / 2 + 12) };
  }
  const main = document.querySelector('.shell-main');
  const m = main?.getBoundingClientRect();
  return { cx: m ? m.left + m.width / 2 : width / 2, cy: height * 0.38, r0: 19 };
}

export function Ground() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current!;
    let frame = 0;
    const draw = () => {
      frame = 0;
      const width = window.innerWidth;
      const height = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      el.width = Math.round(width * dpr);
      el.height = Math.round(height * dpr);
      const ctx = el.getContext('2d');
      if (!ctx) {
        return;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const { color, line, ground } = theme();
      const { cx, cy, r0 } = centre(width, height);
      ctx.fillStyle = color.void;
      ctx.fillRect(0, 0, width, height);
      const reach = Math.max(width, height) * ground.vignette;
      const vignette = ctx.createRadialGradient(cx, cy, 0, cx, cy, reach);
      vignette.addColorStop(0, color.plate);
      vignette.addColorStop(0.45, withAlpha(color.plate, 0.55));
      vignette.addColorStop(1, withAlpha(color.void, 0));
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, width, height);
      const far = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy));
      const spacing = ground.markSpacing;
      ctx.lineWidth = line.hair ?? 0.5;
      for (let radius = r0, i = 0; radius < far; radius += spacing[i % spacing.length]!, i++) {
        ctx.strokeStyle = withAlpha(color.etch1, 0.9 - Math.min(0.6, i * 0.03));
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();
      }
    };
    const soon = () => {
      frame ||= requestAnimationFrame(draw);
    };
    draw();
    listeners.add(soon);
    window.addEventListener('resize', soon);
    return () => {
      listeners.delete(soon);
      window.removeEventListener('resize', soon);
      cancelAnimationFrame(frame);
    };
  }, []);
  return <canvas ref={canvas} className="ground" aria-hidden="true" />;
}
