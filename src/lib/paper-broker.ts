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
  openedAt: number;
  closedAt: number;
}

export interface PaperConfig {
  startingBalance: number;
  maxPositions: number;
  riskPerTrade: number; // fraction of equity risked per trade
  slPct: number;
  tpPct: number;
  minConfidence: number;
  maxDailyDrawdown: number; // fraction of starting balance
}

export const DEFAULT_PAPER_CONFIG: PaperConfig = {
  startingBalance: 10_000,
  maxPositions: 5,
  riskPerTrade: 0.01,
  slPct: 0.02,
  tpPct: 0.04,
  minConfidence: 0.7,
  maxDailyDrawdown: 0.05,
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
  getUnrealizedPnl(marks: Map<string, number>): number {
    let u = 0;
    for (const p of this.positions.values()) {
      const m = marks.get(p.symbol);
      if (!m) continue;
      u += p.side === "BUY" ? (m - p.entryPrice) * p.size : (p.entryPrice - m) * p.size;
    }
    return u;
  }
  getEquity(marks: Map<string, number>): number {
    return this.cfg.startingBalance + this.realizedPnl + this.getUnrealizedPnl(marks);
  }
  isHalted() {
    return this.halted;
  }

  onProposal(proposal: TradeProposal) {
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
    };
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
    const pnl =
      p.side === "BUY"
        ? (exitPrice - p.entryPrice) * p.size
        : (p.entryPrice - exitPrice) * p.size;
    const pnlPct = (pnl / (p.entryPrice * p.size)) * 100;
    this.realizedPnl += pnl;
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
      openedAt: p.openedAt,
      closedAt: time,
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
  }
}
