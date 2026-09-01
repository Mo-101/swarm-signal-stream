// Canonical unit system.
//
// Every quantity in the engine has exactly one representation:
//   Ratio  — dimensionless fraction (0.00055 = 0.055%)
//   Bps    — basis points (5.5 = 0.055%)
//   Pct    — percent (0.055 = 0.055%)
//   Price / Qty / Usd — market and money scalars
//
// The branded types make a bps value unassignable to a ratio parameter, so a
// missing /10_000 becomes a compile error instead of a silent 100x bug.

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]?: B };

export type Ratio = Brand<number, "Ratio">;
export type Bps = Brand<number, "Bps">;
export type Pct = Brand<number, "Pct">;
export type Price = Brand<number, "Price">;
export type Qty = Brand<number, "Qty">;
export type Usd = Brand<number, "Usd">;

/** Basis points per unit ratio. 1 = 10_000 bps. */
export const BPS_PER_UNIT = 10_000;
/** Percent per unit ratio. 1 = 100%. */
export const PCT_PER_UNIT = 100;

export const bps = (n: number): Bps => n as Bps;
export const ratio = (n: number): Ratio => n as Ratio;
export const pct = (n: number): Pct => n as Pct;
export const price = (n: number): Price => n as Price;
export const qty = (n: number): Qty => n as Qty;
export const usd = (n: number): Usd => n as Usd;

export const bpsToRatio = (b: Bps): Ratio => (b / BPS_PER_UNIT) as Ratio;
export const ratioToBps = (r: Ratio): Bps => (r * BPS_PER_UNIT) as Bps;
export const pctToRatio = (p: Pct): Ratio => (p / PCT_PER_UNIT) as Ratio;
export const ratioToPct = (r: Ratio): Pct => (r * PCT_PER_UNIT) as Pct;
export const bpsToPct = (b: Bps): Pct => ratioToPct(bpsToRatio(b));
export const pctToBps = (p: Pct): Bps => ratioToBps(pctToRatio(p));

/** Finite guard: returns `fallback` for NaN/Infinity instead of poisoning math. */
export function finite(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback;
}

/** Clamp helper used by every gate that must not accept out-of-range config. */
export function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

/**
 * Relative difference of `value` vs `reference`, in bps. Sign is preserved.
 * The single definition used everywhere a "move" or "return" is expressed.
 */
export function relBps(value: number, reference: number): Bps {
  if (!(reference > 0) || !Number.isFinite(value)) return bps(0);
  return bps(((value - reference) / reference) * BPS_PER_UNIT);
}
