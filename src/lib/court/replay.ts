// Candle replay: turns a logged signal into a judged outcome without anyone
// taking the trade.
//
// Rules, fixed before any signal is replayed:
//   - Entry at the OPEN of the first 1-minute candle starting at or after the
//     moment we first saw the signal. Never at the signal's quoted price, and
//     never earlier than we could have acted.
//   - Brackets keep the signal's own geometry as percentages from its quoted
//     entry, applied to our fill. A signal missing a stop or target gets the
//     v1r defaults (2% / 4%) and is flagged.
//   - Stop and target are checked on each candle's high/low. If one candle
//     touches both, the stop is assumed to have filled first (conservative).
//   - Unresolved at `maxHoldMs`: exit at that candle's close. Not resolved
//     yet because the candles run out: not judged.
//   - Costs: taker fee + slippage on both legs. Funding is not modelled.
//   - The opposite-direction trade (mirrored brackets, same entry candle) is
//     replayed too, so the direction placebo is exact rather than approximate.
import type { CourtTrade } from "./court";

export interface Candle {
  /** Open time, ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface ReplaySignal {
  signalId: string;
  symbol: string;
  side: "BUY" | "SELL";
  score: number | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  firstSeenAt: number;
  admitted: boolean;
  /** Docket tags for the replayed trade. Default: SigmaLui admitted/not-admitted. */
  sources?: string[];
  /** Epoch tag for the replayed trade. Default "replay". */
  epoch?: string;
}

export interface ReplayOptions {
  feePerSide: number;
  slipPerSide: number;
  maxHoldMs: number;
  defaultStopPct: number;
  defaultTargetPct: number;
  notional: number;
}

export const DEFAULT_REPLAY: ReplayOptions = {
  feePerSide: 0.00055, // Bybit linear taker
  slipPerSide: 0.0002,
  maxHoldMs: 48 * 3600_000,
  defaultStopPct: 0.02,
  defaultTargetPct: 0.04,
  notional: 1000,
};

export interface Outcome {
  exitTime: number;
  exitPrice: number;
  reason: "target" | "stop" | "time";
  grossRet: number;
}

/** Walk candles from the entry candle until a bracket or the time limit is hit.
 *  Returns null when the candles end before the trade resolves. */
export function walk(
  dir: 1 | -1,
  entryIdx: number,
  candles: Candle[],
  stopPct: number,
  targetPct: number,
  maxHoldMs: number,
): Outcome | null {
  const e = candles[entryIdx].o;
  const stop = e * (1 - dir * stopPct);
  const target = e * (1 + dir * targetPct);
  const deadline = candles[entryIdx].t + maxHoldMs;
  for (let i = entryIdx; i < candles.length; i++) {
    const k = candles[i];
    if (k.t >= deadline) {
      const prev = candles[i - 1];
      return {
        exitTime: prev.t + 60_000,
        exitPrice: prev.c,
        reason: "time",
        grossRet: dir * (prev.c / e - 1),
      };
    }
    const hitStop = dir > 0 ? k.l <= stop : k.h >= stop;
    const hitTarget = dir > 0 ? k.h >= target : k.l <= target;
    if (hitStop)
      return { exitTime: k.t + 60_000, exitPrice: stop, reason: "stop", grossRet: -stopPct };
    if (hitTarget)
      return { exitTime: k.t + 60_000, exitPrice: target, reason: "target", grossRet: targetPct };
  }
  return null;
}

export type ReplayResult =
  | { ok: true; trade: CourtTrade; reason: Outcome["reason"]; defaultBrackets: boolean }
  | { ok: false; why: "no candles after signal" | "unresolved" | "invalid brackets" };

export function replaySignal(
  sig: ReplaySignal,
  candles: Candle[],
  opt: ReplayOptions = DEFAULT_REPLAY,
): ReplayResult {
  const entryIdx = candles.findIndex((k) => k.t >= sig.firstSeenAt);
  if (entryIdx < 0) return { ok: false, why: "no candles after signal" };

  let stopPct = opt.defaultStopPct;
  let targetPct = opt.defaultTargetPct;
  let defaultBrackets = true;
  if (sig.entry && sig.stopLoss && sig.takeProfit) {
    stopPct = Math.abs(sig.entry - sig.stopLoss) / sig.entry;
    targetPct = Math.abs(sig.takeProfit - sig.entry) / sig.entry;
    defaultBrackets = false;
  }
  if (!(stopPct > 0 && targetPct > 0 && stopPct < 0.5))
    return { ok: false, why: "invalid brackets" };

  const dir: 1 | -1 = sig.side === "BUY" ? 1 : -1;
  const real = walk(dir, entryIdx, candles, stopPct, targetPct, opt.maxHoldMs);
  const mirror = walk(-dir as 1 | -1, entryIdx, candles, stopPct, targetPct, opt.maxHoldMs);
  if (!real || !mirror) return { ok: false, why: "unresolved" };

  const cost = 2 * (opt.feePerSide + opt.slipPerSide);
  return {
    ok: true,
    reason: real.reason,
    defaultBrackets,
    trade: {
      id: sig.signalId,
      symbol: sig.symbol,
      side: sig.side,
      epoch: sig.epoch ?? "replay",
      sources: sig.sources ?? ["sigmalui", sig.admitted ? "admitted" : "not-admitted"],
      openedAt: candles[entryIdx].t,
      closedAt: real.exitTime,
      notional: opt.notional,
      grossUsd: real.grossRet * opt.notional,
      netUsd: (real.grossRet - cost) * opt.notional,
      flippedNetUsd: (mirror.grossRet - cost) * opt.notional,
    },
  };
}
