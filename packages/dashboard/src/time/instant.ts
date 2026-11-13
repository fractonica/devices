// Instants as the hub gives them, made into the core's: Unix microseconds as a BigInt. An event's t_hub_us is a
// number of microseconds; an op's times are ISO strings on the hub's wall clock; the core counts BigInt microseconds.

/** Unix µs (a number or a BigInt), an ISO time, or a Date, as BigInt Unix microseconds; null when it is none. */
export type InstantLike = bigint | number | string | Date;

export function instantOf(value: InstantLike | null | undefined): bigint | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? BigInt(Math.round(value)) : null;
  }
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? BigInt(ms) * 1000n : null;
}
