// Maker-entry replay: the execution hypothesis.
//
// The ≥0.80 swarm signals made +14.4 bps gross against 15 bps of taker costs.
// This asks whether resting orders instead of crossing the spread saves more
// than the gap, AFTER the fills a resting order would not have got.
//
// Conservative by construction, fixed before any result is seen:
//   - Entry: post-only limit at the signal price, live for `fillWindowMs`.
//     It fills only if a later 1m candle trades THROUGH the limit
//     (BUY: low < limit; SELL: high > limit) by at least `throughBps`.
//     Touching is not enough: at the touch, or one tick through, our order may
//     still be behind the queue. Unfilled = no trade.
//   - Fill price is the limit. The stop is checked on the fill candle itself
//     (a fill caused by a move that continues through the stop is the classic
//     adverse selection); the target is not.
//   - Take-profit rests as a reduce-only limit: it counts only if price trades
//     through the target, and pays the maker fee with no slippage.
//   - Stop and time exits cross the book: taker fee + slippage.
//   - No rebates. Funding not modelled (same as the taker replay).
//   - The mirrored trade (opposite side, same limit price) goes through the
//     same fill rule from its own side, so the direction test stays exact.
//
// Pure: no I/O.
import type { CourtTrade } from "./court";
import type { Candle, ReplaySignal } from "./replay";

export interface MakerOptions {
  makerFee: number;
  takerFee: number;
  slipPerSide: number;
  fillWindowMs: number;
  /** Price must trade this far past a resting limit to count as filled (queue position). */
  throughBps: number;
  stopPct: number;
  targetPct: number;
  maxHoldMs: number;
  notional: number;
}

export const DEFAULT_MAKER: MakerOptions = {
  makerFee: 0.0002, // Bybit linear maker, no rebate
  takerFee: 0.00055,
  slipPerSide: 0.0002,
  fillWindowMs: 5 * 60_000,
  throughBps: 1,
  stopPct: 0.02,
  targetPct: 0.04,
  maxHoldMs: 48 * 3600_000,
  notional: 1000,
};

export interface MakerLeg {
  filled: boolean;
  exit?: "target" | "stop" | "time";
  grossRet?: number;
  /** Fees + slippage as a fraction of notional. */
  cost?: number;
  feeCost?: number;
  slipCost?: number;
  openedAt?: number;
  closedAt?: number;
}

/** One maker leg: resting entry at `limit`, then brackets from the fill. */
export function makerLeg(
  dir: 1 | -1,
  limit: number,
  placedAt: number,
  candles: Candle[],
  o: MakerOptions,
): MakerLeg | null {
  const start = candles.findIndex((k) => k.t >= placedAt);
  if (start < 0) return null; // no data after the signal yet
  const windowEnd = placedAt + o.fillWindowMs;

  // 1. Fill: a candle inside the window must trade through the limit by throughBps.
  const pad = o.throughBps / 1e4;
  let fillIdx = -1;
  for (let i = start; i < candles.length && candles[i].t < windowEnd; i++) {
    const k = candles[i];
    if (dir > 0 ? k.l < limit * (1 - pad) : k.h > limit * (1 + pad)) {
      fillIdx = i;
      break;
    }
  }
  const lastInWindow = candles.length && candles[candles.length - 1].t >= windowEnd - 60_000;
  if (fillIdx < 0) return lastInWindow ? { filled: false } : null; // null: window not fully observed

  const stop = limit * (1 - dir * o.stopPct);
  const target = limit * (1 + dir * o.targetPct);
  const deadline = candles[fillIdx].t + o.maxHoldMs;
  const takerExit = o.takerFee + o.slipPerSide;
  const close = (exit: MakerLeg["exit"], grossRet: number, i: number): MakerLeg => {
    const exitFee = exit === "target" ? o.makerFee : o.takerFee;
    const exitSlip = exit === "target" ? 0 : o.slipPerSide;
    return {
      filled: true,
      exit,
      grossRet,
      feeCost: o.makerFee + exitFee,
      slipCost: exitSlip,
      cost: o.makerFee + (exit === "target" ? o.makerFee : takerExit),
      openedAt: candles[fillIdx].t,
      closedAt: candles[i].t + 60_000,
    };
  };

  // 2. Stop on the fill candle itself (adverse selection), target not.
  const f = candles[fillIdx];
  if (dir > 0 ? f.l <= stop : f.h >= stop) return close("stop", -o.stopPct, fillIdx);

  // 3. Walk forward: stop-first on ambiguous candles; target needs a trade-through.
  for (let i = fillIdx + 1; i < candles.length; i++) {
    const k = candles[i];
    if (k.t >= deadline) {
      const prev = candles[i - 1];
      return close("time", dir * (prev.c / limit - 1), i - 1);
    }
    if (dir > 0 ? k.l <= stop : k.h >= stop) return close("stop", -o.stopPct, i);
    if (dir > 0 ? k.h > target * (1 + pad) : k.l < target * (1 - pad))
      return close("target", o.targetPct, i);
  }
  return null; // not resolved yet
}

export type MakerResult =
  | {
      ok: true;
      trade: CourtTrade;
      exit: NonNullable<MakerLeg["exit"]>;
      feeBps: number;
      slipBps: number;
    }
  | { ok: false; why: "unfilled" | "unresolved" | "no price" };

/** Replay one signal as a maker entry, with its exact mirrored twin. */
export function replayMaker(
  sig: ReplaySignal,
  candles: Candle[],
  o: MakerOptions = DEFAULT_MAKER,
): MakerResult {
  const limit = sig.entry;
  if (!limit || !(limit > 0)) return { ok: false, why: "no price" };
  const dir: 1 | -1 = sig.side === "BUY" ? 1 : -1;
  const real = makerLeg(dir, limit, sig.firstSeenAt, candles, o);
  if (!real) return { ok: false, why: "unresolved" };
  if (!real.filled) return { ok: false, why: "unfilled" };
  const mirror = makerLeg(-dir as 1 | -1, limit, sig.firstSeenAt, candles, o);
  if (!mirror) return { ok: false, why: "unresolved" };
  // An unfilled mirror would have made no trade: its outcome is zero, not a cost.
  const mirrorNet = mirror.filled ? (mirror.grossRet! - mirror.cost!) * o.notional : 0;
  return {
    ok: true,
    exit: real.exit!,
    feeBps: real.feeCost! * 1e4,
    slipBps: real.slipCost! * 1e4,
    trade: {
      id: `maker-${sig.signalId}`,
      symbol: sig.symbol,
      side: sig.side,
      epoch: "signals-maker",
      sources: (sig.sources ?? []).map((s) => `maker:${s}`),
      openedAt: real.openedAt!,
      closedAt: real.closedAt!,
      notional: o.notional,
      grossUsd: real.grossRet! * o.notional,
      netUsd: (real.grossRet! - real.cost!) * o.notional,
      flippedNetUsd: mirrorNet,
    },
  };
}
