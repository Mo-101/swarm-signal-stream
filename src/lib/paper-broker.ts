// Paper trading engine — simulates fills, SL/TP, PnL against live prices.

import type { TradeProposal } from "@/lib/swarm";

export interface Position {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  entryPrice: number;
  size: number; // in base units
  notional: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: number;
  confidence: number;
  regime: string;
  agents: Record<string, { direction: string; confidence: number }>;
  /** Taker fee already paid on entry (Bybit USDT perp taker rate). */
  entryFee: number;
  /** Funding paid (+) or received (-) so far while holding. */
  fundingPaid: number;
  /** Last 8h funding boundary already settled for this position. */
  lastFundingAt: number;
}

export interface ClosedTrade {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  pnlPct: number;
  reason: "TP" | "SL" | "MANUAL";
  /** Gross price PnL before costs. */
  grossPnl: number;
  /** Entry + exit taker fees. */
  fees: number;
  /** Net funding paid over the holding period. */
  funding: number;
  openedAt: number;
  closedAt: number;
  confidence: number;
  regime: string;
  agents: Record<string, { direction: string; confidence: number }>;
}

export interface PaperConfig {
  startingBalance: number;
  maxPositions: number;
  riskPerTrade: number; // fraction of equity risked per trade
  slPct: number;
  tpPct: number;
  minConfidence: number;
  maxDailyDrawdown: number; // fraction of starting balance
  /** Bybit USDT perp taker fee rate, charged on entry and exit notional. */
  takerFeeRate: number;
  /** Assumed funding rate per 8h interval when the live rate is unknown. */
  defaultFundingRate: number;
}

/** Bybit settles funding at 00:00, 08:00 and 16:00 UTC. */
export const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;

export function lastFundingBoundary(t: number): number {
  return Math.floor(t / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS;
}

export const DEFAULT_PAPER_CONFIG: PaperConfig = {
  startingBalance: 10_000,
  maxPositions: 5,
  riskPerTrade: 0.01,
  slPct: 0.02,
  tpPct: 0.04,
  minConfidence: 0.7,
  maxDailyDrawdown: 0.05,
  // https://www.bybit.com/en/help-center/article/Futures-Contracts-Fees-Explained
  takerFeeRate: 0.00055,
  // Interest rate component: 0.03%/day = 0.01% per 8h interval.
  defaultFundingRate: 0.0001,
};

export interface PaperEvents {
  onOpen?: (p: Position) => void;
  onClose?: (t: ClosedTrade) => void;
  onHalt?: (reason: string) => void;
}

export class PaperBroker {
  private positions = new Map<string, Position>();
  private closed: ClosedTrade[] = [];
  private realizedPnl = 0;
  private halted = false;
  /** Live funding rate per symbol (per interval), when the feed provides one. */
  private fundingRates = new Map<string, number>();
  private totalFees = 0;
  private totalFunding = 0;

  constructor(
    private cfg: PaperConfig = DEFAULT_PAPER_CONFIG,
    private events: PaperEvents = {},
  ) {}

  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }
  getClosed(): ClosedTrade[] {
    return this.closed;
  }
  getRealizedPnl(): number {
    return this.realizedPnl;
  }
  getCosts() {
    return { fees: this.totalFees, funding: this.totalFunding };
  }
  /** Feed in Bybit's live funding rate (per interval) for accurate carry. */
  setFundingRate(symbol: string, rate: number) {
    if (Number.isFinite(rate)) this.fundingRates.set(symbol, rate);
  }
  private rateFor(symbol: string) {
    return this.fundingRates.get(symbol) ?? this.cfg.defaultFundingRate;
  }

  /**
   * Settle any 8h funding boundaries crossed since the last check.
   * Positive rate: longs pay shorts. Negative: shorts pay longs.
   * Charged on position value at the mark, per Bybit's funding mechanism.
   */
  accrueFunding(now: number, marks: Map<string, number>) {
    for (const p of this.positions.values()) {
      const boundary = lastFundingBoundary(now);
      if (boundary <= p.lastFundingAt) continue;
      const intervals = Math.round((boundary - p.lastFundingAt) / FUNDING_INTERVAL_MS);
      const mark = marks.get(p.symbol) ?? p.entryPrice;
      const rate = this.rateFor(p.symbol);
      const fee = mark * p.size * rate * intervals * (p.side === "BUY" ? 1 : -1);
      p.fundingPaid += fee;
      p.lastFundingAt = boundary;
      this.realizedPnl -= fee;
      this.totalFunding += fee;
    }
  }
  getUnrealizedPnl(marks: Map<string, number>): number {
    let u = 0;
    for (const p of this.positions.values()) {
      const m = marks.get(p.symbol);
      if (!m) continue;
      const gross = p.side === "BUY" ? (m - p.entryPrice) * p.size : (p.entryPrice - m) * p.size;
      // Net of the taker fee that closing would cost.
      u += gross - m * p.size * this.cfg.takerFeeRate;
    }
    return u;
  }
  getEquity(marks: Map<string, number>): number {
    return this.cfg.startingBalance + this.realizedPnl + this.getUnrealizedPnl(marks);
  }
  isHalted() {
    return this.halted;
  }

  /** Restore a persisted account so the engine survives reloads. */
  hydrate(state: {
    positions: Position[];
    closed: ClosedTrade[];
    realizedPnl: number;
    halted: boolean;
  }) {
    this.positions.clear();
    for (const p of state.positions) {
      this.positions.set(p.symbol, {
        ...p,
        entryFee: p.entryFee ?? p.notional * this.cfg.takerFeeRate,
        fundingPaid: p.fundingPaid ?? 0,
        lastFundingAt: p.lastFundingAt ?? lastFundingBoundary(p.openedAt),
      });
    }
    this.closed = state.closed;
    this.realizedPnl = state.realizedPnl;
    this.halted = state.halted;
  }

  /** Confidence calibration learned from realized outcomes. */
  setMinConfidence(v: number) {
    this.cfg = { ...this.cfg, minConfidence: v };
  }
  getMinConfidence() {
    return this.cfg.minConfidence;
  }

  onProposal(proposal: TradeProposal, meta: { regime: string } = { regime: "unknown" }) {
    if (this.halted) return;
    if (proposal.confidence < this.cfg.minConfidence) return;
    if (this.positions.has(proposal.symbol)) return;
    if (this.positions.size >= this.cfg.maxPositions) return;

    const equity = this.cfg.startingBalance + this.realizedPnl;
    const riskAmount = equity * this.cfg.riskPerTrade * proposal.confidence;
    const stopDistance = proposal.price * this.cfg.slPct;
    if (stopDistance <= 0) return;
    // Cap notional per position so total exposure stays within the account.
    const maxNotional = equity / this.cfg.maxPositions;
    const size = Math.min(riskAmount / stopDistance, maxNotional / proposal.price);
    if (!Number.isFinite(size) || size <= 0) return;

    const sl =
      proposal.direction === "BUY"
        ? proposal.price * (1 - this.cfg.slPct)
        : proposal.price * (1 + this.cfg.slPct);
    const tp =
      proposal.direction === "BUY"
        ? proposal.price * (1 + this.cfg.tpPct)
        : proposal.price * (1 - this.cfg.tpPct);

    const pos: Position = {
      id: `${proposal.symbol}-${proposal.time}`,
      symbol: proposal.symbol,
      side: proposal.direction,
      entryPrice: proposal.price,
      size,
      notional: proposal.price * size,
      stopLoss: sl,
      takeProfit: tp,
      openedAt: proposal.time,
      confidence: proposal.confidence,
      regime: meta.regime,
      agents: proposal.contributions,
      entryFee: proposal.price * size * this.cfg.takerFeeRate,
      fundingPaid: 0,
      lastFundingAt: lastFundingBoundary(proposal.time),
    };
    this.realizedPnl -= pos.entryFee;
    this.totalFees += pos.entryFee;
    this.positions.set(proposal.symbol, pos);
    this.events.onOpen?.(pos);
  }

  // Called with the latest mark for a symbol; may close position on SL/TP.
  markPrice(symbol: string, price: number, time: number) {
    const p = this.positions.get(symbol);
    if (!p) return;
    let reason: "TP" | "SL" | null = null;
    let exit = price;
    if (p.side === "BUY") {
      if (price <= p.stopLoss) {
        reason = "SL";
        exit = p.stopLoss;
      } else if (price >= p.takeProfit) {
        reason = "TP";
        exit = p.takeProfit;
      }
    } else {
      if (price >= p.stopLoss) {
        reason = "SL";
        exit = p.stopLoss;
      } else if (price <= p.takeProfit) {
        reason = "TP";
        exit = p.takeProfit;
      }
    }
    if (reason) this.closePosition(p, exit, time, reason);
  }

  private closePosition(
    p: Position,
    exitPrice: number,
    time: number,
    reason: "TP" | "SL" | "MANUAL",
  ) {
    const grossPnl =
      p.side === "BUY"
        ? (exitPrice - p.entryPrice) * p.size
        : (p.entryPrice - exitPrice) * p.size;
    // Taker fee on the way out, same rate as entry.
    const exitFee = exitPrice * p.size * this.cfg.takerFeeRate;
    const fees = p.entryFee + exitFee;
    const pnl = grossPnl - exitFee - p.fundingPaid;
    const pnlPct = (pnl / (p.entryPrice * p.size)) * 100;
    // entryFee and fundingPaid were already deducted from realizedPnl.
    this.realizedPnl += grossPnl - exitFee;
    this.totalFees += exitFee;
    const trade: ClosedTrade = {
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      entryPrice: p.entryPrice,
      exitPrice,
      size: p.size,
      pnl,
      pnlPct,
      reason,
      grossPnl,
      fees,
      funding: p.fundingPaid,
      openedAt: p.openedAt,
      closedAt: time,
      confidence: p.confidence,
      regime: p.regime,
      agents: p.agents,
    };
    this.closed = [trade, ...this.closed].slice(0, 200);
    this.positions.delete(p.symbol);
    this.events.onClose?.(trade);

    const dd = this.realizedPnl / this.cfg.startingBalance;
    if (dd <= -this.cfg.maxDailyDrawdown && !this.halted) {
      this.halted = true;
      this.events.onHalt?.(
        `Daily drawdown limit hit (${(dd * 100).toFixed(2)}%). New entries paused.`,
      );
    }
  }

  closeAll(marks: Map<string, number>, time: number) {
    for (const p of Array.from(this.positions.values())) {
      const exit = marks.get(p.symbol) ?? p.entryPrice;
      this.closePosition(p, exit, time, "MANUAL");
    }
  }

  reset() {
    this.positions.clear();
    this.closed = [];
    this.realizedPnl = 0;
    this.halted = false;
    this.totalFees = 0;
    this.totalFunding = 0;
  }
}
