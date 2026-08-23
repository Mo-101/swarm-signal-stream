// Paper trading engine — simulates realistic Bybit USDT-perp execution:
// latency, spread crossing, depth-aware sizing, orderbook-walked fills,
// exchange lot/tick/notional filters, funding, isolated margin and
// mark-price liquidation.

import type { TradeProposal } from "@/lib/swarm";
import {
  maxExecutableQty,
  modelledFillPrice,
  roundPrice,
  roundQty,
  slippageBps,
  walkBook,
  type BookSnapshot,
  type InstrumentFilter,
} from "@/lib/microstructure";
import {
  FUNDING_INTERVAL_MS as PERP_FUNDING_INTERVAL_MS,
  bankruptcyPrice,
  fundingPayment,
  grossPnl as grossPnlOf,
  lastFundingBoundary as lastFundingBoundaryOf,
  liquidationPrice,
  marginRatio as marginRatioOf,
  netPnl as netPnlOf,
  roePct,
  roiPct,
  stopPrice,
  takerFee,
  targetPrice,
} from "@/lib/math/perp";
import { UsdLedger, round } from "@/lib/math/rounding";

// ── risk overrides ──
// This module is imported by the dashboard bundle as well as the runner, so
// `process` may not exist. Read defensively and never let a bad value through:
// a typo in .env must not silently arm 100x leverage.
function envNum(name: string, fallback: number, min: number, max: number): number {
  const raw =
    typeof process !== "undefined" && process.env ? process.env[name] : undefined;
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    if (typeof console !== "undefined") {
      console.warn(
        `[paper-broker] ignoring ${name}="${raw}" (must be a number in [${min}, ${max}]); using ${fallback}`,
      );
    }
    return fallback;
  }
  return n;
}

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
  /** Leverage applied to this position (isolated margin). */
  leverage: number;
  /** Initial margin locked for this position: notional / leverage. */
  initialMargin: number;
  /** Maintenance margin rate from the Bybit risk-limit tier for this notional. */
  maintenanceMarginRate: number;
  /** Maintenance margin requirement at entry notional. */
  maintenanceMargin: number;
  /** Price at which the MARK crosses isolated-margin exhaustion. */
  liquidationPrice: number;
  /** Bankruptcy price — where equity of the position hits zero. */
  bankruptcyPrice: number;

  // ── execution quality ──
  /** Price the signal was generated at, before latency and spread. */
  signalPrice: number;
  /** Entry slippage vs the signal price, in bps (positive = worse). */
  entrySlipBps: number;
  /** Book spread at the moment of the entry fill, in bps. */
  spreadAtEntryBps: number;
  /** Size the sizer asked for before depth capping / lot rounding. */
  requestedSize: number;
  /** Simulated order latency applied before the fill, in ms. */
  latencyMs: number;
  /** Book levels consumed by the entry order. */
  entryLevels: number;
  /** True when the entry was priced off a real L2 book rather than the model. */
  bookPriced: boolean;

  // ── trade management ──
  /** Distance from entry to the ORIGINAL stop, in price. This is 1R. */
  riskDistance: number;
  /** Best price reached in our favour since entry (for the trailing stop). */
  bestPrice: number;
  /** True once the stop has been pulled to breakeven or trailed. */
  stopMoved: boolean;
  /** Realized volatility of the symbol at signal time, in bps. */
  volBps: number;
}

export type ExitReason =
  | "TP"
  | "SL"
  | "MANUAL"
  | "LIQ"
  /** Trailing / breakeven stop was hit (the stop had been moved from entry). */
  | "TRAIL"
  /** Max holding time elapsed without resolving. */
  | "TIME"
  /** Funding carry ate too much of the remaining expected reward. */
  | "CARRY";

export interface ClosedTrade {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  /** Net return on ENTRY NOTIONAL, in percent (leverage-independent ROI). */
  pnlPct: number;
  /** Net return on POSTED MARGIN, in percent (ROE). */
  roePct?: number;
  reason: ExitReason;
  /** Gross price PnL before costs. */
  grossPnl: number;
  /** Entry + exit taker fees. */
  fees: number;
  /** Net funding paid over the holding period. */
  funding: number;
  /** Initial margin that was locked for the position. */
  initialMargin: number;
  leverage: number;
  liquidationPrice: number;
  openedAt: number;
  closedAt: number;
  confidence: number;
  regime: string;
  agents: Record<string, { direction: string; confidence: number }>;
  // ── execution quality ──
  signalPrice: number;
  entrySlipBps: number;
  /** Exit slippage vs the trigger price, in bps (positive = worse). */
  exitSlipBps: number;
  /** Price the SL/TP/liq actually triggered at, before exit slippage. */
  triggerPrice: number;
  spreadAtEntryBps: number;
  spreadAtExitBps: number;
  latencyMs: number;
  /** Total USD lost to spread + market impact on both legs. */
  slipCostUsd: number;
  bookPriced: boolean;
}

export type RejectReason =
  | "no-book"
  | "stale-book"
  | "thin-book"
  | "min-qty"
  | "min-notional"
  | "margin"
  | "slippage"
  | "signal-stale"
  | "duplicate"
  | "halted"
  | "max-positions"
  | "confidence"
  | "no-filter"
  /** Symbol is cooling off after a recent stop-out. */
  | "cooldown"
  /** Too many concurrent positions already facing the same way. */
  | "side-cap";

/** Reject reasons that are portfolio-risk limits rather than market mechanics. */
export const RISK_LIMIT_REASONS: RejectReason[] = ["max-positions", "side-cap", "cooldown", "halted"];

export interface RiskAlert {
  id: string;
  at: number;
  symbol: string;
  side: "BUY" | "SELL";
  /** Which portfolio limit blocked the trade. */
  limit: Extract<RejectReason, "max-positions" | "side-cap" | "cooldown" | "halted">;
  detail: string;
  /** Book state at the moment the limit fired, for the alert feed. */
  openPositions: number;
  sameSide: number;
}

/** One settled 8h funding boundary for one position. */
export interface FundingEvent {
  at: number;
  symbol: string;
  side: "BUY" | "SELL";
  /** Funding rate per interval used for the charge. */
  rate: number;
  /** Number of 8h boundaries settled in this accrual. */
  intervals: number;
  /** Notional the charge was applied to. */
  notional: number;
  /** USD paid (positive) or received (negative). */
  amount: number;
  /** Position's cumulative funding after this accrual. */
  cumulative: number;
  /** Whether the live exchange rate was used, or the configured default. */
  liveRate: boolean;
}

export interface FundingStats {
  /** Net USD paid to (or received from) the funding mechanism. */
  totalFunding: number;
  paid: number;
  received: number;
  accruals: number;
  /** Symbols with a live funding rate loaded from the exchange. */
  liveRates: number;
  /** Mean live rate across currently open positions, per 8h interval. */
  avgOpenRate: number;
  /** Projected funding cost of the open book over the next 8h boundary. */
  projectedNext8hUsd: number;
  /** Funding already accrued by positions still open. */
  openCarryUsd: number;
  /** Positions closed by the funding-aware CARRY rule. */
  carryExits: number;
  /** Positions closed by the max-hold rule. */
  timeExits: number;
  /** Funding those CARRY exits avoided, assuming they ran to max hold. */
  carrySavedUsd: number;
  /** Funding drag as a share of gross PnL, in percent. */
  dragPctOfGross: number;
  recent: FundingEvent[];
}

export interface PendingOrder {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  signalPrice: number;
  confidence: number;
  regime: string;
  agents: Record<string, { direction: string; confidence: number }>;
  createdAt: number;
  /** Wall-clock time the order reaches the matching engine. */
  readyAt: number;
  /** Realized volatility of the symbol at signal time, in bps. */
  volBps: number;
}

export interface RejectRecord {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  reason: RejectReason;
  detail: string;
  at: number;
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
  /** Isolated-margin leverage used for every paper position. */
  leverage: number;
  /** Maximum fraction of equity that may be locked as initial margin. */
  maxMarginUsage: number;

  // ── execution realism ──
  /** Simulated signal→fill round trip (order submit + match + ack). */
  latencyMs: number;
  /** Jitter applied to latency, in ms (uniform ±). */
  latencyJitterMs: number;
  /** Max average price impact tolerated when sizing against the book, in bps. */
  maxImpactBps: number;
  /** Never take more than this fraction of the visible depth on one side. */
  maxDepthFraction: number;
  /** Cancel the order if the market moved this far against us during latency. */
  maxAdverseMoveBps: number;
  /** Reject entries whose modelled/actual entry slippage exceeds this, in bps. */
  maxEntrySlipBps: number;
  /** Reject entries on books wider than this, in bps. */
  maxSpreadBps: number;
  /** Require a live L2 book to enter (no book → reject instead of modelling). */
  requireBook: boolean;
  /** Spread assumed when a book is unavailable (exits only), in bps. */
  fallbackSpreadBps: number;
  /** Allow the book to fill less than the requested size. */
  allowPartialFills: boolean;

  // ── trade management ──
  /** Bybit USDT perp maker fee rate, used when a TP rests as a limit order. */
  makerFeeRate: number;
  /** Post the take-profit as a reduce-only limit at the touch instead of crossing. */
  takeProfitAsLimit: boolean;
  /** Scale stops off realized vol instead of a flat percentage. */
  volScaledBrackets: boolean;
  /** Stop distance = volBps × this multiple. */
  volStopMult: number;
  /** Floor / ceiling for the vol-scaled stop, in bps. */
  minStopBps: number;
  maxStopBps: number;
  /** Take-profit distance as a multiple of the stop distance (reward:risk). */
  rewardRiskRatio: number;
  /** Pull the stop to breakeven once the trade is this many R in profit. */
  breakevenAtR: number;
  /** Start trailing once the trade is this many R in profit. */
  trailStartR: number;
  /** Trail this many R behind the best price reached. */
  trailDistanceR: number;
  /** Close a position that has not resolved within this many ms. */
  maxHoldMs: number;
  /** Close when cumulative funding paid exceeds this share of the TP reward. */
  maxFundingShareOfReward: number;
  /** Max concurrent positions facing the same direction. */
  maxSameSide: number;
  /** Block new entries on a symbol for this long after it stops us out. */
  cooldownAfterStopMs: number;
}

/** Bybit settles funding at 00:00, 08:00 and 16:00 UTC. (canonical: math/perp) */
export const FUNDING_INTERVAL_MS = PERP_FUNDING_INTERVAL_MS;
export const lastFundingBoundary = lastFundingBoundaryOf;

export const DEFAULT_PAPER_CONFIG: PaperConfig = {
  startingBalance: envNum("STARTING_BALANCE", 10_000, 1, 10_000_000),
  maxPositions: envNum("MAX_POSITIONS", 5, 1, 50),
  riskPerTrade: envNum("RISK_PER_TRADE", 0.005, 0.0001, 0.1),
  slPct: envNum("SL_PCT", 0.02, 0.001, 0.2),
  tpPct: 0.04,
  // Confidence is now normalized to 0.5–1.0 (see swarm.combine): 0.62 here is
  // roughly the old "net vote > 0.9" gate, and the edge model raises it from
  // measured bucket expectancy once the new epoch has enough closed trades.
  minConfidence: 0.62,
  maxDailyDrawdown: 0.05,
  // https://www.bybit.com/en/help-center/article/Futures-Contracts-Fees-Explained
  takerFeeRate: 0.00055,
  // Interest rate component: 0.03%/day = 0.01% per 8h interval.
  defaultFundingRate: 0.0001,
  leverage: envNum("LEVERAGE", 5, 1, 100),
  maxMarginUsage: envNum("MAX_MARGIN_USAGE", 0.8, 0.01, 1),

  latencyMs: 250,
  latencyJitterMs: 120,
  maxImpactBps: 12,
  maxDepthFraction: 0.2,
  maxAdverseMoveBps: 25,
  maxEntrySlipBps: 30,
  maxSpreadBps: 25,
  requireBook: true,
  fallbackSpreadBps: 8,
  allowPartialFills: true,

  makerFeeRate: 0.0002,
  takeProfitAsLimit: true,
  volScaledBrackets: true,
  volStopMult: 2.5,
  minStopBps: 60,
  maxStopBps: 320,
  rewardRiskRatio: 2,
  breakevenAtR: 1,
  trailStartR: 1.5,
  trailDistanceR: 0.75,
  maxHoldMs: envNum("MAX_HOLD_HOURS", 8, 0.25, 240) * 3_600_000,
  maxFundingShareOfReward: 0.35,
  maxSameSide: envNum("MAX_SAME_SIDE", 3, 1, 50),
  cooldownAfterStopMs: envNum("COOLDOWN_MINUTES", 45, 0, 1440) * 60_000,
};

/**
 * Simplified Bybit USDT-perp risk-limit ladder: maintenance margin rate steps
 * up with position notional, which also caps effective leverage.
 */
export const RISK_LIMIT_TIERS: Array<{ maxNotional: number; mmr: number; maxLeverage: number }> = [
  { maxNotional: 50_000, mmr: 0.005, maxLeverage: 100 },
  { maxNotional: 250_000, mmr: 0.01, maxLeverage: 50 },
  { maxNotional: 1_000_000, mmr: 0.025, maxLeverage: 20 },
  { maxNotional: 5_000_000, mmr: 0.05, maxLeverage: 10 },
  { maxNotional: Number.POSITIVE_INFINITY, mmr: 0.1, maxLeverage: 5 },
];

export function riskLimitTier(notional: number) {
  return RISK_LIMIT_TIERS.find((t) => notional <= t.maxNotional) ?? RISK_LIMIT_TIERS[RISK_LIMIT_TIERS.length - 1];
}

/**
 * Isolated-margin liquidation price (Bybit USDT perp, one-way mode).
 * Long:  entry * (1 - IMR + MMR + taker)
 * Short: entry * (1 + IMR - MMR - taker)
 * where IMR = 1 / leverage. The taker term reserves the closing fee.
 * Bybit evaluates this against MARK price, not last traded price.
 */
export function liquidationPriceFor(
  entryPrice: number,
  side: "BUY" | "SELL",
  leverage: number,
  mmr: number,
  takerFeeRate: number,
): number {
  return liquidationPrice(entryPrice, side, leverage, mmr, takerFeeRate);
}

export function bankruptcyPriceFor(
  entryPrice: number,
  side: "BUY" | "SELL",
  leverage: number,
): number {
  return bankruptcyPrice(entryPrice, side, leverage);
}

export interface MarginSummary {
  /** Sum of initial margin locked across open positions. */
  usedMargin: number;
  /** Sum of maintenance margin requirements at current marks. */
  maintenanceMargin: number;
  /** Wallet balance available for new positions. */
  availableMargin: number;
  /** Account equity including unrealized PnL. */
  equity: number;
  /** maintenanceMargin / equity — liquidation risk approaches 1. */
  marginRatio: number;
  /** Number of positions currently within 2% of their liquidation price. */
  atRisk: number;
}

export interface ExecutionStats {
  submitted: number;
  filled: number;
  partialFills: number;
  rejected: number;
  pending: number;
  rejectsByReason: Record<string, number>;
  avgEntrySlipBps: number;
  avgExitSlipBps: number;
  worstSlipBps: number;
  avgSpreadBps: number;
  avgFillLatencyMs: number;
  avgFillRatio: number;
  /** Total USD given up to spread + market impact across all legs. */
  slipCostUsd: number;
  bookPricedFills: number;
  modelPricedFills: number;
}

/** Live market data the broker needs to price executions. */
export interface MarketAccess {
  /** Fresh L2 book, or null when unavailable/stale. */
  book(symbol: string): BookSnapshot | null;
  /** Bybit mark price — used for liquidation, falls back to last. */
  mark(symbol: string): number | null;
  /** Exchange lot/tick/notional filters. */
  filter(symbol: string): InstrumentFilter | null;
}

const NO_MARKET: MarketAccess = {
  book: () => null,
  mark: () => null,
  filter: () => null,
};

export interface PaperEvents {
  onOpen?: (p: Position) => void;
  onClose?: (t: ClosedTrade) => void;
  onHalt?: (reason: string) => void;
  onLiquidate?: (t: ClosedTrade) => void;
  onReject?: (r: RejectRecord) => void;
  /** A portfolio risk limit blocked a trade (slot cap, side cap, cooldown). */
  onRiskAlert?: (a: RiskAlert) => void;
  /** A funding boundary was settled against an open position. */
  onFunding?: (e: FundingEvent) => void;
}

export class PaperBroker {
  private positions = new Map<string, Position>();
  private closed: ClosedTrade[] = [];
  /** Drift-free accumulator: realized PnL never accrues binary float error. */
  private pnlLedger = new UsdLedger(0);
  private get realizedPnl(): number {
    return this.pnlLedger.value;
  }
  private set realizedPnl(v: number) {
    this.pnlLedger.set(v);
  }
  private halted = false;
  /** Live funding rate per symbol (per interval), when the feed provides one. */
  private fundingRates = new Map<string, number>();
  private totalFees = 0;
  private totalFunding = 0;
  private liquidations = 0;
  // ── funding telemetry ──
  private fundingEvents: FundingEvent[] = [];
  private fundingAccruals = 0;
  private fundingPaidUsd = 0;
  private fundingReceivedUsd = 0;
  private carryExits = 0;
  private timeExits = 0;
  private carrySavedUsd = 0;
  // ── risk-limit telemetry ──
  private riskAlerts: RiskAlert[] = [];

  private market: MarketAccess = NO_MARKET;
  private pending = new Map<string, PendingOrder>();
  /** symbol → timestamp until which new entries are blocked after a stop-out. */
  private cooldowns = new Map<string, number>();
  private rejects: RejectRecord[] = [];
  private lastMark = new Map<string, number>();

  // execution accounting
  private submitted = 0;
  private fills = 0;
  private partialFills = 0;
  private rejected = 0;
  private rejectsByReason: Record<string, number> = {};
  private entrySlipSum = 0;
  private exitSlipSum = 0;
  private exitSlipCount = 0;
  private worstSlipBps = 0;
  private spreadSum = 0;
  private spreadCount = 0;
  private latencySum = 0;
  private fillRatioSum = 0;
  private slipCostUsd = 0;
  private bookPricedFills = 0;
  private modelPricedFills = 0;

  constructor(
    private cfg: PaperConfig = DEFAULT_PAPER_CONFIG,
    private events: PaperEvents = {},
  ) {}

  setMarket(market: MarketAccess) {
    this.market = market;
  }
  getConfig(): PaperConfig {
    return this.cfg;
  }

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
    return { fees: this.totalFees, funding: this.totalFunding, slippage: this.slipCostUsd };
  }
  getLiquidations() {
    return this.liquidations;
  }
  getLeverage() {
    return this.cfg.leverage;
  }
  getPending(): PendingOrder[] {
    return Array.from(this.pending.values());
  }
  getRejects(): RejectRecord[] {
    return this.rejects;
  }
  getExecutionStats(): ExecutionStats {
    return {
      submitted: this.submitted,
      filled: this.fills,
      partialFills: this.partialFills,
      rejected: this.rejected,
      pending: this.pending.size,
      rejectsByReason: { ...this.rejectsByReason },
      avgEntrySlipBps: this.fills ? this.entrySlipSum / this.fills : 0,
      avgExitSlipBps: this.exitSlipCount ? this.exitSlipSum / this.exitSlipCount : 0,
      worstSlipBps: this.worstSlipBps,
      avgSpreadBps: this.spreadCount ? this.spreadSum / this.spreadCount : 0,
      avgFillLatencyMs: this.fills ? this.latencySum / this.fills : 0,
      avgFillRatio: this.fills ? this.fillRatioSum / this.fills : 0,
      slipCostUsd: this.slipCostUsd,
      bookPricedFills: this.bookPricedFills,
      modelPricedFills: this.modelPricedFills,
    };
  }

  /** Margin usage / liquidation-risk snapshot for the whole account. */
  getMarginSummary(marks: Map<string, number>): MarginSummary {
    let usedMargin = 0;
    let maintenanceMargin = 0;
    let atRisk = 0;
    for (const p of this.positions.values()) {
      const mark = this.markFor(p.symbol, marks) ?? p.entryPrice;
      usedMargin += p.initialMargin;
      maintenanceMargin += mark * p.size * p.maintenanceMarginRate;
      const distance = Math.abs(mark - p.liquidationPrice) / (mark || 1);
      if (distance <= 0.02) atRisk += 1;
    }
    const equity = this.getEquity(marks);
    const walletBalance = this.cfg.startingBalance + this.realizedPnl;
    return {
      usedMargin,
      maintenanceMargin,
      availableMargin: Math.max(walletBalance - usedMargin, 0),
      equity,
      marginRatio: marginRatioOf(maintenanceMargin, equity),
      atRisk,
    };
  }

  /** Feed in Bybit's live funding rate (per interval) for accurate carry. */
  setFundingRate(symbol: string, rate: number) {
    if (Number.isFinite(rate)) this.fundingRates.set(symbol, rate);
  }
  private rateFor(symbol: string) {
    return this.fundingRates.get(symbol) ?? this.cfg.defaultFundingRate;
  }

  /** Prefer the exchange mark price; fall back to the last trade. */
  private markFor(symbol: string, marks?: Map<string, number>): number | null {
    const m = this.market.mark(symbol);
    if (m && m > 0) return m;
    const cached = this.lastMark.get(symbol);
    if (cached && cached > 0) return cached;
    const last = marks?.get(symbol);
    return last && last > 0 ? last : null;
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
      const mark = this.markFor(p.symbol, marks) ?? p.entryPrice;
      const rate = this.rateFor(p.symbol);
      const notional = mark * p.size;
      const fee = fundingPayment(notional * intervals, rate, p.side);
      p.fundingPaid += fee;
      p.lastFundingAt = boundary;
      this.realizedPnl -= fee;
      this.totalFunding += fee;

      this.fundingAccruals += 1;
      if (fee >= 0) this.fundingPaidUsd += fee;
      else this.fundingReceivedUsd += -fee;
      const ev: FundingEvent = {
        at: boundary,
        symbol: p.symbol,
        side: p.side,
        rate,
        intervals,
        notional,
        amount: fee,
        cumulative: p.fundingPaid,
        liveRate: this.fundingRates.has(p.symbol),
      };
      this.fundingEvents = [ev, ...this.fundingEvents].slice(0, 200);
      this.events.onFunding?.(ev);
      console.info(
        `[funding] ${p.symbol} ${p.side} ${intervals}×8h rate=${(rate * 100).toFixed(4)}%` +
          ` notional=$${notional.toFixed(2)} → ${fee >= 0 ? "paid" : "received"} $${Math.abs(fee).toFixed(4)}` +
          ` (cum $${p.fundingPaid.toFixed(4)}, ${ev.liveRate ? "live" : "default"} rate)`,
      );
    }
  }

  /** Funding / carry telemetry, used to verify the CARRY exit reduces drag. */
  getFundingStats(marks?: Map<string, number>): FundingStats {
    let openCarry = 0;
    let projected = 0;
    let rateSum = 0;
    let rateCount = 0;
    for (const p of this.positions.values()) {
      openCarry += p.fundingPaid;
      const mark = this.markFor(p.symbol, marks) ?? p.entryPrice;
      const rate = this.rateFor(p.symbol);
      projected += fundingPayment(mark * p.size, rate, p.side);
      if (this.fundingRates.has(p.symbol)) {
        rateSum += rate;
        rateCount += 1;
      }
    }
    let grossSum = 0;
    for (const t of this.closed) grossSum += t.grossPnl;
    return {
      totalFunding: this.totalFunding,
      paid: this.fundingPaidUsd,
      received: this.fundingReceivedUsd,
      accruals: this.fundingAccruals,
      liveRates: this.fundingRates.size,
      avgOpenRate: rateCount ? rateSum / rateCount : 0,
      projectedNext8hUsd: projected,
      openCarryUsd: openCarry,
      carryExits: this.carryExits,
      timeExits: this.timeExits,
      carrySavedUsd: this.carrySavedUsd,
      dragPctOfGross: grossSum !== 0 ? (this.totalFunding / Math.abs(grossSum)) * 100 : 0,
      recent: this.fundingEvents.slice(0, 40),
    };
  }

  /** Most recent portfolio risk-limit blocks, newest first. */
  getRiskAlerts(): RiskAlert[] {
    return this.riskAlerts;
  }

  getUnrealizedPnl(marks: Map<string, number>): number {
    let u = 0;
    for (const p of this.positions.values()) {
      const m = this.markFor(p.symbol, marks);
      if (!m) continue;
      const gross = grossPnlOf(p.entryPrice, m, p.size, p.side);
      // Net of the taker fee and modelled exit slippage that closing would cost.
      const exitSpreadBps = this.market.book(p.symbol)?.spreadBps ?? this.cfg.fallbackSpreadBps;
      const exitSlipCost = ((m * p.size * exitSpreadBps) / 2) / 10_000;
      u += gross - takerFee(m * p.size, this.cfg.takerFeeRate) - exitSlipCost;
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
    positions: Array<
      Pick<
        Position,
        | "id"
        | "symbol"
        | "side"
        | "entryPrice"
        | "size"
        | "notional"
        | "stopLoss"
        | "takeProfit"
        | "openedAt"
        | "confidence"
        | "regime"
        | "agents"
      > &
        Partial<Position>
    >;
    closed: Array<
      Pick<
        ClosedTrade,
        | "id"
        | "symbol"
        | "side"
        | "entryPrice"
        | "exitPrice"
        | "size"
        | "pnl"
        | "pnlPct"
        | "reason"
        | "openedAt"
        | "closedAt"
        | "confidence"
        | "regime"
        | "agents"
      > &
        Partial<ClosedTrade>
    >;
    realizedPnl: number;
    halted: boolean;
  }) {
    this.positions.clear();
    for (const p of state.positions) {
      const leverage = p.leverage ?? this.cfg.leverage;
      const tier = riskLimitTier(p.notional);
      const mmr = p.maintenanceMarginRate ?? tier.mmr;
      this.positions.set(p.symbol, {
        ...p,
        entryFee: p.entryFee ?? p.notional * this.cfg.takerFeeRate,
        fundingPaid: p.fundingPaid ?? 0,
        lastFundingAt: p.lastFundingAt ?? lastFundingBoundary(p.openedAt),
        leverage,
        initialMargin: p.initialMargin ?? p.notional / leverage,
        maintenanceMarginRate: mmr,
        maintenanceMargin: p.maintenanceMargin ?? p.notional * mmr,
        liquidationPrice:
          p.liquidationPrice ??
          liquidationPriceFor(p.entryPrice, p.side, leverage, mmr, this.cfg.takerFeeRate),
        bankruptcyPrice: p.bankruptcyPrice ?? bankruptcyPriceFor(p.entryPrice, p.side, leverage),
        signalPrice: p.signalPrice ?? p.entryPrice,
        entrySlipBps: p.entrySlipBps ?? 0,
        spreadAtEntryBps: p.spreadAtEntryBps ?? 0,
        requestedSize: p.requestedSize ?? p.size,
        latencyMs: p.latencyMs ?? this.cfg.latencyMs,
        entryLevels: p.entryLevels ?? 0,
        bookPriced: p.bookPriced ?? false,
        riskDistance: p.riskDistance ?? Math.abs(p.entryPrice - p.stopLoss),
        bestPrice: p.bestPrice ?? p.entryPrice,
        stopMoved: p.stopMoved ?? false,
        volBps: p.volBps ?? 0,
      });
    }
    this.closed = state.closed.map((t) => ({
      ...t,
      grossPnl: t.grossPnl ?? t.pnl,
      fees: t.fees ?? 0,
      funding: t.funding ?? 0,
      initialMargin: t.initialMargin ?? (t.entryPrice * t.size) / this.cfg.leverage,
      leverage: t.leverage ?? this.cfg.leverage,
      liquidationPrice:
        t.liquidationPrice ??
        liquidationPriceFor(
          t.entryPrice,
          t.side,
          t.leverage ?? this.cfg.leverage,
          riskLimitTier(t.entryPrice * t.size).mmr,
          this.cfg.takerFeeRate,
        ),
      signalPrice: t.signalPrice ?? t.entryPrice,
      entrySlipBps: t.entrySlipBps ?? 0,
      exitSlipBps: t.exitSlipBps ?? 0,
      triggerPrice: t.triggerPrice ?? t.exitPrice,
      spreadAtEntryBps: t.spreadAtEntryBps ?? 0,
      spreadAtExitBps: t.spreadAtExitBps ?? 0,
      latencyMs: t.latencyMs ?? this.cfg.latencyMs,
      slipCostUsd: t.slipCostUsd ?? 0,
      bookPriced: t.bookPriced ?? false,
    }));
    this.realizedPnl = state.realizedPnl;
    this.halted = state.halted;

    // Execution counters are session-local by default; without this, "N filled"
    // resets to 0 on every reload even though the DB already has these trades.
    const historicalFills = this.positions.size + this.closed.length;
    this.fills = historicalFills;
    this.submitted = Math.max(this.submitted, historicalFills);
  }

  /** Confidence calibration learned from realized outcomes. */
  setMinConfidence(v: number) {
    this.cfg = { ...this.cfg, minConfidence: v };
  }
  getMinConfidence() {
    return this.cfg.minConfidence;
  }

  private reject(order: Pick<PendingOrder, "id" | "symbol" | "side">, reason: RejectReason, detail: string) {
    this.rejected += 1;
    this.rejectsByReason[reason] = (this.rejectsByReason[reason] ?? 0) + 1;
    const rec: RejectRecord = {
      id: `${order.id}-${reason}`,
      symbol: order.symbol,
      side: order.side,
      reason,
      detail,
      at: Date.now(),
    };
    this.rejects = [rec, ...this.rejects].slice(0, 60);
    this.events.onReject?.(rec);

    // Portfolio-risk blocks are operationally interesting in a way that a thin
    // book is not: they mean the swarm wanted exposure the mandate refused.
    if (RISK_LIMIT_REASONS.includes(reason)) {
      let sameSide = 0;
      for (const p of this.positions.values()) if (p.side === order.side) sameSide += 1;
      for (const o of this.pending.values()) if (o.side === order.side) sameSide += 1;
      const alert: RiskAlert = {
        id: rec.id,
        at: rec.at,
        symbol: order.symbol,
        side: order.side,
        limit: reason as RiskAlert["limit"],
        detail,
        openPositions: this.positions.size + this.pending.size,
        sameSide,
      };
      this.riskAlerts = [alert, ...this.riskAlerts].slice(0, 60);
      this.events.onRiskAlert?.(alert);
      console.warn(
        `[risk] ${reason} blocked ${order.side} ${order.symbol} — ${detail}` +
          ` (open ${alert.openPositions}/${this.cfg.maxPositions}, same-side ${sameSide}/${this.cfg.maxSameSide})`,
      );
    }
  }

  /**
   * A signal becomes a *pending* market order. It is not filled here: the
   * exchange sees it `latencyMs` later, at whatever price the book is then.
   */
  onProposal(proposal: TradeProposal, meta: { regime: string } = { regime: "unknown" }) {
    const base = { id: proposal.id, symbol: proposal.symbol, side: proposal.direction };
    if (this.halted) return this.reject(base, "halted", "Risk halt active");
    if (proposal.confidence < this.cfg.minConfidence)
      return this.reject(base, "confidence", `conf ${proposal.confidence.toFixed(2)} < ${this.cfg.minConfidence.toFixed(2)}`);
    if (this.positions.has(proposal.symbol)) return; // already exposed, silent
    if (this.pending.has(proposal.symbol)) return; // order already in flight
    if (this.positions.size + this.pending.size >= this.cfg.maxPositions)
      return this.reject(base, "max-positions", `${this.cfg.maxPositions} slots in use`);

    const now = Date.now();
    const coolUntil = this.cooldowns.get(proposal.symbol) ?? 0;
    if (now < coolUntil)
      return this.reject(
        base,
        "cooldown",
        `stopped out recently — ${Math.ceil((coolUntil - now) / 60_000)}m left`,
      );

    // Correlation cap: a swarm that is 5/5 long is one trade, not five.
    let sameSide = 0;
    for (const p of this.positions.values()) if (p.side === proposal.direction) sameSide += 1;
    for (const o of this.pending.values()) if (o.side === proposal.direction) sameSide += 1;
    if (sameSide >= this.cfg.maxSameSide)
      return this.reject(
        base,
        "side-cap",
        `${sameSide} positions already ${proposal.direction === "BUY" ? "long" : "short"}`,
      );

    const jitter = (Math.random() * 2 - 1) * this.cfg.latencyJitterMs;
    const latency = Math.max(20, this.cfg.latencyMs + jitter);
    this.submitted += 1;
    this.pending.set(proposal.symbol, {
      id: proposal.id,
      symbol: proposal.symbol,
      side: proposal.direction,
      signalPrice: proposal.price,
      confidence: proposal.confidence,
      regime: meta.regime,
      agents: proposal.contributions,
      createdAt: now,
      readyAt: now + latency,
      volBps: proposal.volBps ?? 0,
    });
  }

  /** Drive the matching engine: fill any pending orders whose latency elapsed. */
  processPending(now = Date.now()) {
    for (const order of Array.from(this.pending.values())) {
      if (now < order.readyAt) continue;
      this.pending.delete(order.symbol);
      this.tryFill(order, now);
    }
  }

  private tryFill(order: PendingOrder, now: number) {
    if (this.halted) return this.reject(order, "halted", "Risk halt active during flight");
    if (this.positions.has(order.symbol)) return;

    const filters = this.market.filter(order.symbol);
    if (!filters) return this.reject(order, "no-filter", "No instrument filters loaded");

    const book = this.market.book(order.symbol);
    if (!book && this.cfg.requireBook)
      return this.reject(order, "no-book", "No live L2 depth for this symbol");
    if (book && book.spreadBps > this.cfg.maxSpreadBps)
      return this.reject(order, "thin-book", `spread ${book.spreadBps.toFixed(1)}bps > ${this.cfg.maxSpreadBps}bps`);

    const touch = book ? (order.side === "BUY" ? book.ask : book.bid) : order.signalPrice;
    const reference = book ? book.mid : order.signalPrice;

    // The market moved while the order was in flight — a real desk cancels.
    const adverse = slippageBps(order.signalPrice, reference, order.side);
    if (adverse > this.cfg.maxAdverseMoveBps)
      return this.reject(order, "signal-stale", `moved ${adverse.toFixed(1)}bps against us in ${(now - order.createdAt).toFixed(0)}ms`);

    // ── Risk sizing ──
    // Brackets scale with the volatility the symbol actually prints: a flat 2%
    // stop is noise on a memecoin and a canyon on BTC. Reward:risk is held
    // constant so the required hit-rate does not drift between symbols.
    const equity = this.cfg.startingBalance + this.realizedPnl;
    const rawStopBps = order.volBps > 0 ? order.volBps * this.cfg.volStopMult : this.cfg.slPct * 10_000;
    const stopPct = this.cfg.volScaledBrackets
      ? Math.min(Math.max(rawStopBps, this.cfg.minStopBps), this.cfg.maxStopBps) / 10_000
      : this.cfg.slPct;
    const tpPct = this.cfg.volScaledBrackets ? stopPct * this.cfg.rewardRiskRatio : this.cfg.tpPct;
    // Confidence now spans 0.5–1.0, so conviction is the half above the coin flip.
    const conviction = Math.min(Math.max((order.confidence - 0.5) * 2, 0.2), 1);
    const riskAmount = equity * this.cfg.riskPerTrade * conviction;
    const stopDistance = touch * stopPct;
    if (!(stopDistance > 0)) return this.reject(order, "min-qty", "Invalid stop distance");

    let usedMargin = 0;
    for (const open of this.positions.values()) usedMargin += open.initialMargin;
    const marginBudget = Math.max(equity * this.cfg.maxMarginUsage - usedMargin, 0);
    if (marginBudget <= 0) return this.reject(order, "margin", "Margin budget exhausted");

    const perPositionNotional = (equity / this.cfg.maxPositions) * this.cfg.leverage;
    const marginNotional = marginBudget * this.cfg.leverage;
    const maxNotional = Math.min(perPositionNotional, marginNotional);
    let requested = Math.min(riskAmount / stopDistance, maxNotional / touch);

    // ── Depth-aware cap: never demand more than the book can absorb ──
    let depthCap = Number.POSITIVE_INFINITY;
    if (book) {
      depthCap = maxExecutableQty(book, order.side, this.cfg.maxImpactBps, this.cfg.maxDepthFraction);
      if (!(depthCap > 0))
        return this.reject(order, "thin-book", "No depth inside the impact limit");
    }
    const targetSize = Math.min(requested, depthCap, filters.maxOrderQty);

    // ── Exchange filters ──
    let size = roundQty(targetSize, filters.qtyStep);
    if (size < filters.minOrderQty)
      return this.reject(
        order,
        "min-qty",
        `size ${targetSize.toPrecision(3)} < min lot ${filters.minOrderQty}`,
      );
    if (size * touch < filters.minNotional)
      return this.reject(
        order,
        "min-notional",
        `$${(size * touch).toFixed(2)} < $${filters.minNotional} minimum`,
      );

    // ── Fill ──
    let fillPrice: number;
    let levelsUsed = 0;
    let bookPriced = false;
    if (book) {
      const walk = walkBook(book, order.side, size);
      if (walk.filled <= 0) return this.reject(order, "thin-book", "Book empty on the taking side");
      if (walk.exhausted) {
        if (!this.cfg.allowPartialFills)
          return this.reject(order, "thin-book", "Insufficient depth for full size");
        const partial = roundQty(walk.filled, filters.qtyStep);
        if (partial < filters.minOrderQty || partial * touch < filters.minNotional)
          return this.reject(order, "thin-book", "Partial fill below exchange minimums");
        size = partial;
        this.partialFills += 1;
      }
      fillPrice = walk.avgPrice;
      levelsUsed = walk.levels;
      bookPriced = true;
      this.bookPricedFills += 1;
    } else {
      fillPrice = modelledFillPrice(
        order.signalPrice,
        order.side,
        size * order.signalPrice,
        this.cfg.fallbackSpreadBps,
      );
      this.modelPricedFills += 1;
    }
    fillPrice = roundPrice(fillPrice, filters.tickSize);

    const entrySlip = slippageBps(order.signalPrice, fillPrice, order.side);
    if (entrySlip > this.cfg.maxEntrySlipBps)
      return this.reject(order, "slippage", `${entrySlip.toFixed(1)}bps > ${this.cfg.maxEntrySlipBps}bps cap`);

    const notional = fillPrice * size;
    const tier = riskLimitTier(notional);
    const leverage = Math.min(this.cfg.leverage, tier.maxLeverage, filters.maxLeverage);
    const initialMargin = notional / leverage;
    const entryFee = takerFee(notional, this.cfg.takerFeeRate);
    if (initialMargin + entryFee > marginBudget)
      return this.reject(order, "margin", `IM $${initialMargin.toFixed(2)} exceeds free margin`);

    const sl = roundPrice(stopPrice(fillPrice, order.side, stopPct), filters.tickSize);
    const tp = roundPrice(targetPrice(fillPrice, order.side, tpPct), filters.tickSize);

    // Slippage cost vs a frictionless fill at the signal price.
    const slipCost = Math.abs(fillPrice - order.signalPrice) * size;

    const pos: Position = {
      id: order.id,
      symbol: order.symbol,
      side: order.side,
      entryPrice: fillPrice,
      size,
      notional,
      stopLoss: sl,
      takeProfit: tp,
      openedAt: now,
      confidence: order.confidence,
      regime: order.regime,
      agents: order.agents,
      entryFee,
      fundingPaid: 0,
      lastFundingAt: lastFundingBoundary(now),
      leverage,
      initialMargin,
      maintenanceMarginRate: tier.mmr,
      maintenanceMargin: notional * tier.mmr,
      liquidationPrice: liquidationPriceFor(fillPrice, order.side, leverage, tier.mmr, this.cfg.takerFeeRate),
      bankruptcyPrice: bankruptcyPriceFor(fillPrice, order.side, leverage),
      riskDistance: Math.abs(fillPrice - sl),
      bestPrice: fillPrice,
      stopMoved: false,
      volBps: order.volBps,
      signalPrice: order.signalPrice,
      entrySlipBps: entrySlip,
      spreadAtEntryBps: book?.spreadBps ?? this.cfg.fallbackSpreadBps,
      requestedSize: requested,
      latencyMs: now - order.createdAt,
      entryLevels: levelsUsed,
      bookPriced,
    };

    this.fills += 1;
    this.entrySlipSum += entrySlip;
    if (entrySlip > this.worstSlipBps) this.worstSlipBps = entrySlip;
    this.spreadSum += pos.spreadAtEntryBps;
    this.spreadCount += 1;
    this.latencySum += pos.latencyMs;
    this.fillRatioSum += requested > 0 ? Math.min(size / requested, 1) : 1;
    this.slipCostUsd += slipCost;

    this.realizedPnl -= entryFee;
    this.totalFees += entryFee;
    this.positions.set(order.symbol, pos);
    this.events.onOpen?.(pos);
  }

  /**
   * Latest LAST-traded price for a symbol. Bybit triggers TP/SL on last price
   * by default, and liquidations on MARK price — both are checked here.
   */
  markPrice(symbol: string, price: number, time: number) {
    this.lastMark.set(symbol, price);
    const p = this.positions.get(symbol);
    if (!p) return;

    // 1. Liquidation, on MARK price, always evaluated first.
    const mark = this.market.mark(symbol) ?? price;
    if (
      (p.side === "BUY" && mark <= p.liquidationPrice) ||
      (p.side === "SELL" && mark >= p.liquidationPrice)
    ) {
      this.closePosition(p, p.liquidationPrice, time, "LIQ");
      return;
    }

    // 2. Trade management: ratchet the stop as the trade proves itself.
    this.manageStop(p, price);

    // 3. TP/SL, triggered on LAST price (Bybit default trigger source).
    let reason: ExitReason | null = null;
    let trigger = price;
    if (p.side === "BUY") {
      if (price <= p.stopLoss) {
        reason = "SL";
        trigger = p.stopLoss;
      } else if (price >= p.takeProfit) {
        reason = "TP";
        trigger = p.takeProfit;
      }
    } else {
      if (price >= p.stopLoss) {
        reason = "SL";
        trigger = p.stopLoss;
      } else if (price <= p.takeProfit) {
        reason = "TP";
        trigger = p.takeProfit;
      }
    }
    if (reason === "SL" && p.stopMoved) reason = "TRAIL";
    if (reason) this.closePosition(p, trigger, time, reason);
  }

  /**
   * Breakeven + trailing stop. Once a trade is `breakevenAtR` in profit the
   * stop moves to entry (plus the round-trip fee, so "breakeven" is actually
   * breakeven); past `trailStartR` it trails `trailDistanceR` behind the best
   * price seen. Stops only ever move in our favour.
   */
  private manageStop(p: Position, price: number) {
    if (!(p.riskDistance > 0)) return;
    const long = p.side === "BUY";
    p.bestPrice = long ? Math.max(p.bestPrice, price) : Math.min(p.bestPrice, price);

    const favourable = long ? p.bestPrice - p.entryPrice : p.entryPrice - p.bestPrice;
    const rMultiple = favourable / p.riskDistance;
    if (rMultiple < this.cfg.breakevenAtR) return;

    // Cover the round-trip taker fee so a "breakeven" exit is not a small loss.
    const feeCushion = p.entryPrice * this.cfg.takerFeeRate * 2;
    let candidate = long ? p.entryPrice + feeCushion : p.entryPrice - feeCushion;

    if (rMultiple >= this.cfg.trailStartR) {
      const trail = this.cfg.trailDistanceR * p.riskDistance;
      const trailed = long ? p.bestPrice - trail : p.bestPrice + trail;
      candidate = long ? Math.max(candidate, trailed) : Math.min(candidate, trailed);
    }

    const filters = this.market.filter(p.symbol);
    const next = filters ? roundPrice(candidate, filters.tickSize) : candidate;
    if (long ? next > p.stopLoss : next < p.stopLoss) {
      p.stopLoss = next;
      p.stopMoved = true;
    }
  }

  /**
   * Time- and carry-based exits, swept on the slow loop. A position that has
   * neither hit its target nor its stop within `maxHoldMs` is dead money paying
   * funding every 8h; the same is true once accrued funding has eaten a large
   * share of the reward the trade was opened for.
   */
  manageOpen(now: number, marks: Map<string, number>) {
    for (const p of Array.from(this.positions.values())) {
      const mark = this.markFor(p.symbol, marks);
      if (mark === null) continue;

      const heldMs = now - p.openedAt;
      if (heldMs >= this.cfg.maxHoldMs) {
        this.timeExits += 1;
        console.info(
          `[exit:TIME] ${p.symbol} ${p.side} held ${(heldMs / 3_600_000).toFixed(1)}h ` +
            `≥ ${(this.cfg.maxHoldMs / 3_600_000).toFixed(1)}h · funding paid $${p.fundingPaid.toFixed(4)}`,
        );
        this.closePosition(p, mark, now, "TIME");
        continue;
      }
      const reward = Math.abs(p.takeProfit - p.entryPrice) * p.size;
      const budget = this.cfg.maxFundingShareOfReward * reward;
      if (reward > 0 && p.fundingPaid >= budget) {
        this.carryExits += 1;
        // What staying to max hold would have cost on top, at the current rate.
        const remainingIntervals = Math.max(
          0,
          Math.floor((this.cfg.maxHoldMs - heldMs) / FUNDING_INTERVAL_MS),
        );
        const wouldPay = fundingPayment(
          mark * p.size * remainingIntervals,
          this.rateFor(p.symbol),
          p.side,
        );
        if (wouldPay > 0) this.carrySavedUsd += wouldPay;
        console.info(
          `[exit:CARRY] ${p.symbol} ${p.side} funding $${p.fundingPaid.toFixed(4)} ` +
            `≥ ${(this.cfg.maxFundingShareOfReward * 100).toFixed(0)}% of reward $${reward.toFixed(2)} ` +
            `(budget $${budget.toFixed(4)}) · avoided ~$${Math.max(wouldPay, 0).toFixed(4)} over ` +
            `${remainingIntervals} further interval(s)`,
        );
        this.closePosition(p, mark, now, "CARRY");
      }
    }
  }

  /**
   * Resolve the actual exit price for a triggered stop/target. Triggered
   * orders execute as market orders, so they cross the spread and walk the
   * book exactly like the entry did — stops in particular fill worse than
   * their trigger.
   */
  private resolveExitPrice(
    p: Position,
    triggerPrice: number,
  ): { price: number; slipBps: number; spreadBps: number; bookPriced: boolean } {
    const exitSide: "BUY" | "SELL" = p.side === "BUY" ? "SELL" : "BUY";
    const book = this.market.book(p.symbol);
    const filters = this.market.filter(p.symbol);
    if (book) {
      const walk = walkBook(book, exitSide, p.size);
      if (walk.filled > 0) {
        // The stop triggers at `triggerPrice`; the fill happens against the
        // book, but never better than the trigger for a stop-out.
        const raw = walk.avgPrice;
        const price = filters ? roundPrice(raw, filters.tickSize) : raw;
        return {
          price,
          slipBps: slippageBps(triggerPrice, price, exitSide),
          spreadBps: book.spreadBps,
          bookPriced: true,
        };
      }
    }
    const modelled = modelledFillPrice(
      triggerPrice,
      exitSide,
      p.size * triggerPrice,
      this.cfg.fallbackSpreadBps,
    );
    const price = filters ? roundPrice(modelled, filters.tickSize) : modelled;
    return {
      price,
      slipBps: slippageBps(triggerPrice, price, exitSide),
      spreadBps: this.cfg.fallbackSpreadBps,
      bookPriced: false,
    };
  }

  private closePosition(p: Position, triggerPrice: number, time: number, reason: ExitReason) {
    let exitPrice = triggerPrice;
    let exitSlipBps = 0;
    let spreadAtExitBps = 0;
    let exitBookPriced = false;

    // A take-profit does not need to cross the spread: it can rest as a
    // reduce-only limit at the target and earn the maker fee. Measured exit
    // slippage on market TPs was ~79bps — this removes that bleed entirely.
    const makerExit = reason === "TP" && this.cfg.takeProfitAsLimit;
    const feeRate = makerExit ? this.cfg.makerFeeRate : this.cfg.takerFeeRate;

    if (reason === "LIQ") {
      // Liquidation is executed by the exchange's liquidation engine at the
      // bankruptcy price; the trader's loss is the posted margin regardless.
      exitPrice = p.liquidationPrice;
    } else if (makerExit) {
      const filters = this.market.filter(p.symbol);
      exitPrice = filters ? roundPrice(p.takeProfit, filters.tickSize) : p.takeProfit;
      const book = this.market.book(p.symbol);
      spreadAtExitBps = book?.spreadBps ?? this.cfg.fallbackSpreadBps;
      exitBookPriced = Boolean(book);
      this.exitSlipCount += 1;
    } else {
      const res = this.resolveExitPrice(p, triggerPrice);
      exitPrice = res.price;
      exitSlipBps = res.slipBps;
      spreadAtExitBps = res.spreadBps;
      exitBookPriced = res.bookPriced;
      this.exitSlipSum += exitSlipBps;
      this.exitSlipCount += 1;
      if (exitSlipBps > this.worstSlipBps) this.worstSlipBps = exitSlipBps;
    }

    const grossPnl = grossPnlOf(p.entryPrice, exitPrice, p.size, p.side);
    const exitFee = takerFee(exitPrice * p.size, feeRate);
    const fees = p.entryFee + exitFee;
    let pnl = netPnlOf({
      entryPrice: p.entryPrice,
      exitPrice,
      size: p.size,
      side: p.side,
      entryFee: p.entryFee,
      exitFee,
      funding: p.fundingPaid,
    });
    // NOTE: trade-level PnL is now FULLY net (entry fee included). It used to
    // omit the entry fee, which understated cost in every edge statistic.
    if (reason === "LIQ") {
      pnl = -p.initialMargin;
      this.liquidations += 1;
    }
    // ROI on entry notional (leverage-independent). ROE is reported alongside.
    const pnlPct = roiPct(pnl, p.entryPrice * p.size);
    const pnlRoePct = roePct(pnl, p.initialMargin);

    const exitSlipCost = Math.abs(exitPrice - triggerPrice) * p.size;
    const entrySlipCost = Math.abs(p.entryPrice - p.signalPrice) * p.size;
    if (reason !== "LIQ") this.slipCostUsd += exitSlipCost;

    // entryFee and fundingPaid were already deducted from realizedPnl.
    this.realizedPnl +=
      reason === "LIQ" ? -p.initialMargin + p.entryFee + p.fundingPaid : grossPnl - exitFee;
    this.totalFees += exitFee;

    const trade: ClosedTrade = {
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      entryPrice: p.entryPrice,
      exitPrice,
      size: p.size,
      pnl: round(pnl, 8),
      pnlPct,
      roePct: pnlRoePct,
      reason,
      grossPnl,
      fees,
      funding: p.fundingPaid,
      initialMargin: p.initialMargin,
      leverage: p.leverage,
      liquidationPrice: p.liquidationPrice,
      openedAt: p.openedAt,
      closedAt: time,
      confidence: p.confidence,
      regime: p.regime,
      agents: p.agents,
      signalPrice: p.signalPrice,
      entrySlipBps: p.entrySlipBps,
      exitSlipBps,
      triggerPrice,
      spreadAtEntryBps: p.spreadAtEntryBps,
      spreadAtExitBps,
      latencyMs: p.latencyMs,
      slipCostUsd: entrySlipCost + (reason === "LIQ" ? 0 : exitSlipCost),
      bookPriced: p.bookPriced && exitBookPriced,
    };
    this.closed = [trade, ...this.closed].slice(0, 200);
    this.positions.delete(p.symbol);
    // Cool off a symbol that just took money off us: back-to-back re-entries
    // into the same failing move were the biggest source of paired losses.
    if ((reason === "SL" || reason === "LIQ" || (reason === "TRAIL" && pnl < 0)) && this.cfg.cooldownAfterStopMs > 0)
      this.cooldowns.set(p.symbol, time + this.cfg.cooldownAfterStopMs);
    this.events.onClose?.(trade);
    if (reason === "LIQ") this.events.onLiquidate?.(trade);

    const dd = this.realizedPnl / this.cfg.startingBalance;
    if (dd <= -this.cfg.maxDailyDrawdown && !this.halted) {
      this.halted = true;
      this.events.onHalt?.(`Daily drawdown limit hit (${(dd * 100).toFixed(2)}%). New entries paused.`);
    }
  }

  closeAll(marks: Map<string, number>, time: number) {
    for (const p of Array.from(this.positions.values())) {
      const exit = this.markFor(p.symbol, marks) ?? p.entryPrice;
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
    this.liquidations = 0;
    this.fundingEvents = [];
    this.fundingAccruals = 0;
    this.fundingPaidUsd = 0;
    this.fundingReceivedUsd = 0;
    this.carryExits = 0;
    this.timeExits = 0;
    this.carrySavedUsd = 0;
    this.riskAlerts = [];
    this.pending.clear();
    this.cooldowns.clear();
    this.rejects = [];
    this.submitted = 0;
    this.fills = 0;
    this.partialFills = 0;
    this.rejected = 0;
    this.rejectsByReason = {};
    this.entrySlipSum = 0;
    this.exitSlipSum = 0;
    this.exitSlipCount = 0;
    this.worstSlipBps = 0;
    this.spreadSum = 0;
    this.spreadCount = 0;
    this.latencySum = 0;
    this.fillRatioSum = 0;
    this.slipCostUsd = 0;
    this.bookPricedFills = 0;
    this.modelPricedFills = 0;
  }
}
