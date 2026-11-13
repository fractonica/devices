// The rail's marks (design README "Hub" 8), drawn in the site's hand (app/drawing/marks.js): 24 x 24 around the
// centre, 1 px strokes in currentColor with round caps, no fill but beads, no background, bar or badge.
//   Hub       ring with a planet (the present: the instrument lives here)
//   Devices   three beads on a carrier arc (the fleet)
//   Provision the stage ring: four arcs with gaps, one lit
//   Live      a wave ending in the point of now
//   Bench     two rails with three rungs (a breadboard)
//   Settings  a bezel: a ring with six ticks outside it
// and the PURE / EARTH mark: an empty ring, which gains its cross (the Earth sign) in Earth mode.

export type SigilName = 'hub' | 'devices' | 'provision' | 'live' | 'bench' | 'settings';

const ink = { fill: 'none', stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const dot = { fill: 'currentColor', stroke: 'none' } as const;
const f = (n: number) => +n.toFixed(2);
const polar = (r: number, turn: number) => [f(r * Math.cos(turn * 2 * Math.PI - Math.PI / 2)), f(r * Math.sin(turn * 2 * Math.PI - Math.PI / 2))] as const;

function arc(r: number, t0: number, t1: number): string {
  const [x0, y0] = polar(r, t0);
  const [x1, y1] = polar(r, t1);
  return `M${x0} ${y0}A${r} ${r} 0 ${t1 - t0 > 0.5 ? 1 : 0} 1 ${x1} ${y1}`;
}

export function Sigil({ name }: { name: SigilName }) {
  let body;
  switch (name) {
    case 'hub': {
      const [px, py] = polar(7, 40 / 360);
      body = (
        <>
          <circle r={7} {...ink} />
          <circle cx={px} cy={py} r={1.9} {...dot} />
        </>
      );
      break;
    }
    case 'devices':
      body = (
        <>
          <path d="M-9 3A10 10 0 0 1 9 3" {...ink} />
          {[-0.18, 0, 0.18].map((t) => {
            const [x, y] = polar(10, t);
            return <circle key={t} cx={x} cy={f(y + 8.2)} r={1.7} {...dot} />;
          })}
        </>
      );
      break;
    case 'provision':
      body = (
        <>
          {[0, 1, 2, 3].map((k) => (
            <path key={k} d={arc(7.5, k / 4 + 0.03, (k + 1) / 4 - 0.03)} {...ink} strokeWidth={k === 0 ? 1.6 : 1} />
          ))}
          <circle r={1.2} {...dot} />
        </>
      );
      break;
    case 'live':
      body = (
        <>
          <path d="M-10 0A4.2 4.2 0 0 1 -1.6 0A4.2 4.2 0 0 0 6.8 0" {...ink} />
          <circle cx={6.8} cy={0} r={1.9} {...dot} />
        </>
      );
      break;
    case 'bench':
      body = (
        <>
          <path d="M-6 -8V8M6 -8V8" {...ink} />
          <path d="M-6 -4H6M-6 0H6M-6 4H6" {...ink} opacity={0.7} />
        </>
      );
      break;
    case 'settings':
      body = (
        <>
          <circle r={4.5} {...ink} />
          {[0, 1, 2, 3, 4, 5].map((k) => {
            const [x0, y0] = polar(6.8, k / 6);
            const [x1, y1] = polar(9, k / 6);
            return <path key={k} d={`M${x0} ${y0}L${x1} ${y1}`} {...ink} />;
          })}
        </>
      );
      break;
  }
  return (
    <svg width={24} height={24} viewBox="-12 -12 24 24" aria-hidden="true">
      {body}
    </svg>
  );
}

/** The mode mark: an empty ring; the cross is always drawn and shown by CSS in Earth mode (one cross-fade). */
export function ModeRing() {
  return (
    <svg width={18} height={18} viewBox="-9 -9 18 18" aria-hidden="true">
      <circle r={7.5} {...ink} />
      <path className="cross" d="M-7.5 0H7.5M0 -7.5V7.5" {...ink} />
    </svg>
  );
}
