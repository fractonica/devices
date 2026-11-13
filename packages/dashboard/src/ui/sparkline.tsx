// A property's recent values as one lumen hairline (no fill, no axis), ending in a small lumen bead at the latest
// value, over an etch-1 base line. The values' own scale: min to max of what is shown.

export interface SparklineProps {
  values: readonly number[];
  width?: number;
  height?: number;
  /** What it shows, for assistive technology ("rssi, last 120 values"). */
  label?: string;
}

export function Sparkline({ values, width = 120, height = 24, label }: SparklineProps) {
  const pts = values.filter((v) => Number.isFinite(v));
  const pad = 2;
  if (pts.length < 2) {
    return (
      <svg className="ui-sparkline" width={width} height={height} role="img" aria-label={label ?? 'no values yet'}>
        <line className="base" x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} />
      </svg>
    );
  }
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (pts.length - 1)) * (width - 2 * pad);
  const y = (v: number) => (max === min ? height / 2 : pad + (1 - (v - min) / span) * (height - 2 * pad));
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
  const last = pts.length - 1;
  return (
    <svg className="ui-sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? `${pts.length} values`}>
      <line className="base" x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} />
      <path className="line" d={d} />
      <circle className="end" cx={x(last)} cy={y(pts[last]!)} r={1.8} />
    </svg>
  );
}
