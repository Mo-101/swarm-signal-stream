// Exchange-exact rounding + drift-free money accumulation.
//
// Canonical home for tick/lot rounding. `microstructure.ts` re-exports these
// so there is exactly one implementation in the codebase.

/** Number of decimals implied by a step like 0.001 or 5. */
export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 8;
  if (step >= 1) return 0;
  // Count decimals from the exact decimal string, avoiding exponent parsing bugs.
  const s = step.toFixed(12).replace(/0+$/, "");
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : Math.min(12, s.length - dot - 1);
}

/** Round a quantity DOWN to the instrument's lot step. */
export function roundQty(qty: number, step: number): number {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  if (!Number.isFinite(step) || step <= 0) return qty;
  const d = decimalsOf(step);
  // Work in integer step-units to avoid 0.1+0.2 style residue.
  const units = Math.floor(round(qty / step, 9));
  return round(units * step, d);
}

/** Round a price to the instrument's tick size (nearest tick). */
export function roundPrice(price: number, tick: number): number {
  if (!Number.isFinite(price) || price <= 0) return price;
  if (!Number.isFinite(tick) || tick <= 0) return price;
  const d = decimalsOf(tick);
  return round(Math.round(round(price / tick, 9)) * tick, d);
}

/** Deterministic decimal rounding (half away from zero), free of 1e-15 residue. */
export function round(n: number, decimals: number): number {
  if (!Number.isFinite(n)) return n;
  const f = Math.pow(10, Math.max(0, Math.min(12, decimals)));
  const scaled = n * f;
  // Nudge by one ULP-ish epsilon so 1.005 * 100 = 100.49999 rounds as intended.
  const eps = Math.abs(scaled) * Number.EPSILON * 4;
  return (scaled < 0 ? -Math.round(-scaled + eps) : Math.round(scaled + eps)) / f;
}

/** Round money to cents. All persisted USD figures pass through this. */
export const toCents = (usd: number): number => Math.round(round(usd, 6) * 100);
export const fromCents = (cents: number): number => round(cents / 100, 2);

/**
 * Drift-free USD accumulator: sums in integer micro-dollars so a long run of
 * fees/funding/PnL never accumulates binary float error.
 */
export class UsdLedger {
  private micros = 0;

  constructor(initial = 0) {
    this.micros = UsdLedger.toMicros(initial);
  }

  private static toMicros(usd: number): number {
    return Math.round(round(Number.isFinite(usd) ? usd : 0, 9) * 1e6);
  }

  add(usd: number): this {
    this.micros += UsdLedger.toMicros(usd);
    return this;
  }

  sub(usd: number): this {
    this.micros -= UsdLedger.toMicros(usd);
    return this;
  }

  set(usd: number): this {
    this.micros = UsdLedger.toMicros(usd);
    return this;
  }

  get value(): number {
    return round(this.micros / 1e6, 6);
  }
}
