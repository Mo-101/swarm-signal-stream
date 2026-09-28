// Exact direction test for shadow-book trades.
//
// A shadow trade opened at a live price with the paper brackets and a time
// exit. Its mirror is the same trade in the opposite direction: same entry
// price and moment, stop and target at the same distances on the other side,
// same time limit. Replaying that mirror against candles gives the exact
// outcome the direction placebo needs, instead of assuming the reversed trade
// would have earned the negated gross.
//
// The walk starts at the first full minute after the fill (the partial minute
// containing the fill has unknown intra-minute order). Pure: no I/O.
import { type Candle, walk } from "./replay";

export interface ShadowForMirror {
  shadowId: string;
  symbol: string;
  side: string;
  entry: number;
  stop: number;
  target: number;
  openedAt: number;
}

/** Gross bps of the mirrored trade, or null when the candles don't cover it. */
export function mirrorGrossBps(
  t: ShadowForMirror,
  candles: Candle[],
  maxHoldMs: number,
): number | null {
  if (!(t.entry > 0 && t.stop > 0 && t.target > 0)) return null;
  const stopPct = Math.abs(t.entry - t.stop) / t.entry;
  const targetPct = Math.abs(t.target - t.entry) / t.entry;
  if (!(stopPct > 0 && targetPct > 0 && stopPct < 0.5)) return null;
  const startIdx = candles.findIndex((k) => k.t >= t.openedAt);
  if (startIdx < 0) return null;
  const dir: 1 | -1 = t.side === "BUY" ? -1 : 1; // the opposite of the real trade
  const out = walk(dir, startIdx, candles, stopPct, targetPct, maxHoldMs, t.entry, t.openedAt);
  return out ? out.grossRet * 1e4 : null;
}
