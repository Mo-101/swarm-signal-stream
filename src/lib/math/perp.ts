// Canonical USDT-M perpetual formulas (Bybit isolated margin, one-way mode).
//
// Every fee, funding, margin, liquidation and PnL number in the engine comes
// from this module. No other file may re-derive these.

import { BPS_PER_UNIT, bps, relBps, type Bps } from "./units";
import { round } from "./rounding";

export type Side = "BUY" | "SELL";

/** +1 for a long, -1 for a short. The only place direction becomes a number. */
export const sideSign = (side: Side): 1 | -1 => (side === "BUY" ? 1 : -1);

/** Position value at a given price. */
export function notionalOf(price: number, size: number): number {
  return price * size;
}

/** Initial margin for an isolated position. */
export function initialMarginOf(notional: number, leverage: number): number {
  if (!(leverage > 0)) return notional;
  return notional / leverage;
}

/** Maintenance margin at a maintenance-margin rate (tiered by notional). */
export function maintenanceMarginOf(notional: number, mmr: number): number {
  return notional * mmr;
}

/** Taker fee charged on one leg. Always >= 0. */
export function takerFee(notional: number, takerFeeRate: number): number {
  return Math.abs(notional) * takerFeeRate;
}

/** Round-trip taker fee expressed in bps of notional. */
export function roundTripFeeBps(takerFeeRate: number): Bps {
  return bps(takerFeeRate * 2 * BPS_PER_UNIT);
}

/**
 * Funding payment for one 8h settlement.
 * Positive = the position PAYS. Longs pay a positive funding rate; shorts
 * receive it (and vice versa).
 */
export function fundingPayment(
  positionValue: number,
  fundingRate: number,
  side: Side,
): number {
  return positionValue * fundingRate * sideSign(side);
}

/** Bybit settles funding at 00:00 / 08:00 / 16:00 UTC. */
export const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

export function lastFundingBoundary(t: number): number {
  return Math.floor(t / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS;
}

/** Number of funding boundaries strictly after `from` and at/before `to`. */
export function fundingIntervalsBetween(from: number, to: number): number {
  if (!(to > from)) return 0;
  return Math.floor(to / FUNDING_INTERVAL_MS) - Math.floor(from / FUNDING_INTERVAL_MS);
}

/** Price PnL before any cost. Exactly antisymmetric between long and short. */
export function grossPnl(
  entryPrice: number,
  exitPrice: number,
  size: number,
  side: Side,
): number {
  return (exitPrice - entryPrice) * size * sideSign(side);
}

export interface NetPnlInput {
  entryPrice: number;
  exitPrice: number;
  size: number;
  side: Side;
  entryFee: number;
  exitFee: number;
  /** Funding already paid (positive) or received (negative). */
  funding: number;
}

/** Net realized PnL = gross − both fees − funding paid. */
export function netPnl(i: NetPnlInput): number {
  return (
    grossPnl(i.entryPrice, i.exitPrice, i.size, i.side) - i.entryFee - i.exitFee - i.funding
  );
}

/** Return on margin posted (ROE). This is what a trader calls "% gain". */
export function roePct(netPnlUsd: number, initialMargin: number): number {
  if (!(initialMargin > 0)) return 0;
  return (netPnlUsd / initialMargin) * 100;
}

/** Return on notional (ROI) — leverage-independent, used for edge stats. */
export function roiPct(netPnlUsd: number, entryNotional: number): number {
  if (!(entryNotional > 0)) return 0;
  return (netPnlUsd / entryNotional) * 100;
}

/** Net return in bps of entry notional. The canonical edge unit. */
export function netBpsOf(netPnlUsd: number, entryNotional: number): Bps {
  if (!(entryNotional > 0)) return bps(0);
  return bps((netPnlUsd / entryNotional) * BPS_PER_UNIT);
}

/** Favourable price move in bps, signed by side (positive = in our favour). */
export function moveBps(entryPrice: number, price: number, side: Side): Bps {
  return bps(relBps(price, entryPrice) * sideSign(side));
}

/**
 * Isolated-margin liquidation price (mark price basis).
 *   Long:  entry * (1 − IMR + MMR + taker)
 *   Short: entry * (1 + IMR − MMR − taker)
 * The taker term reserves the closing fee.
 */
export function liquidationPrice(
  entryPrice: number,
  side: Side,
  leverage: number,
  mmr: number,
  takerFeeRate: number,
): number {
  if (!(leverage > 0) || !(entryPrice > 0)) return 0;
  const imr = 1 / leverage;
  const buffer = imr - mmr - takerFeeRate;
  return Math.max(entryPrice * (1 - buffer * sideSign(side)), 0);
}

/** Price at which equity reaches zero, ignoring closing fees. */
export function bankruptcyPrice(entryPrice: number, side: Side, leverage: number): number {
  if (!(leverage > 0) || !(entryPrice > 0)) return 0;
  return Math.max(entryPrice * (1 - (1 / leverage) * sideSign(side)), 0);
}

/** Margin ratio = maintenance margin / equity. 1 = liquidation. */
export function marginRatio(maintenanceMargin: number, equity: number): number {
  if (!(equity > 0)) return maintenanceMargin > 0 ? 1 : 0;
  return maintenanceMargin / equity;
}

/** Stop-loss / take-profit price from a fraction of the fill price. */
export function stopPrice(fillPrice: number, side: Side, slFraction: number): number {
  return fillPrice * (1 - slFraction * sideSign(side));
}

export function targetPrice(fillPrice: number, side: Side, tpFraction: number): number {
  return fillPrice * (1 + tpFraction * sideSign(side));
}

export interface CostHurdle {
  /** Round-trip taker fee, bps of notional. */
  feeBps: Bps;
  /** Expected entry slippage, bps. */
  entrySlipBps: Bps;
  /** Expected exit slippage, bps. */
  exitSlipBps: Bps;
  /** Expected funding carry over the hold, bps (positive = a cost). */
  fundingBps: Bps;
  /** Sum of all cost components, bps. */
  totalCostBps: Bps;
  /** totalCost × safety margin — the edge a signal must beat. */
  requiredEdgeBps: Bps;
}

/**
 * The exact break-even arithmetic a proposal must clear before it can trade.
 * One definition, shared by the broker gate, the shadow book and the UI.
 */
export function costHurdle(input: {
  takerFeeRate: number;
  entrySlipBps: number;
  exitSlipBps: number;
  fundingRatePer8h?: number;
  expectedHoldMs?: number;
  side?: Side;
  safetyMargin?: number;
}): CostHurdle {
  const feeBps = roundTripFeeBps(input.takerFeeRate);
  const entrySlipBps = bps(Math.max(0, input.entrySlipBps));
  const exitSlipBps = bps(Math.max(0, input.exitSlipBps));
  const intervals = Math.max(0, (input.expectedHoldMs ?? 0) / FUNDING_INTERVAL_MS);
  const rate = input.fundingRatePer8h ?? 0;
  const fundingBps = bps(rate * intervals * sideSign(input.side ?? "BUY") * BPS_PER_UNIT);
  const totalCostBps = bps(feeBps + entrySlipBps + exitSlipBps + Math.max(0, fundingBps));
  const safety = input.safetyMargin ?? 1.5;
  return {
    feeBps,
    entrySlipBps,
    exitSlipBps,
    fundingBps,
    totalCostBps,
    requiredEdgeBps: bps(round(totalCostBps * safety, 6)),
  };
}
