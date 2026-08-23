// ─── Counterfactual Shadow Book ───────────────────────────────────────────
// Every proposal the swarm REFUSED to trade (below the confidence gate, a
// suppressed symbol, no free slot, book too thin, risk halt…) is opened here
// as a zero-risk virtual position on a fixed notional and marked against the
// same live ticks the real broker sees. SL/TP mirror the paper config, and
// both legs are charged the Bybit taker fee plus an approximate funding
// accrual, so a shadow result is comparable to a real paper result.
//
// The payoff: after enough samples the engine can prove — rather than assume —
// whether its own gate is protecting capital or leaving money on the table,
// and recommend the confidence threshold that maximises net expectancy.
//
// Nothing here can move real or paper money. It only observes.

import type { TradeProposal } from "@/lib/swarm";
import { stopPrice, targetPrice } from "@/lib/math/perp";

export type ShadowReason = "confidence" | "suppressed" | "blocked" | "observer";

export type ShadowExitReason = "TP" | "SL" | "TIME";
export type RecommendationMetric = "expectancyBps" | "netUsd";

export const SHADOW_REASON_LABELS: Record<ShadowReason, string> = {
  confidence: "Below confidence gate",
  suppressed: "Symbol suppressed",
  blocked: "Broker blocked",
  observer: "Observer mode",
};

export interface ShadowTrade {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  reason: ShadowReason;
  confidence: number;
  regime: string;

  /** Fixed USD notional this trade was opened under. */
  notional: number;

  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: number;

  /** Last observed executable market price while the trade was open. */
  lastPrice: number;
  lastMarkedAt: number;

  /** Excursion in bps from entry, direction-adjusted. */
  maxFavourableBps: number;
  maxAdverseBps: number;

  exitPrice: number | null;
  closedAt: number | null;
  exitReason: ShadowExitReason | null;

  /** Net return after modeled entry/exit fees, slippage and funding carry. */
  netBps: number | null;
  /** Net USD on the fixed shadow notional. */
  netUsd: number | null;

  /** Gross return in bps before fees and funding, for cost attribution. */
  grossBps: number | null;
  /** Modeled round-trip taker fee in USD. Always a cost, so always >= 0. */
  feeUsd: number | null;
  /**
   * Modeled funding carry in USD over the hold.
   * Positive = the position paid funding; negative = it received funding.
   */
  fundingUsd: number | null;
}

/**
 * Side effects for the owner process — the hook the book fires when a trade
 * closes is how a caller durably records the result. Storage stays outside
 * this class; the book only reports what happened.
 */
export interface ShadowHooks {
  onOpen?: (trade: ShadowTrade) => void;
  onClose?: (trade: ShadowTrade) => void;
}

export interface ShadowBucket {
  key: string;
  open: number;
  closed: number;
  wins: number;
  winRate: number;
  expectancyBps: number;
  netUsd: number;
}

export interface ThresholdRow {
  threshold: number;
  trades: number;
  wins: number;
  winRate: number;
  expectancyBps: number;
  netUsd: number;
}

export interface ShadowStats {
  notional: number;
  openCount: number;
  closedCount: number;

  /** P&L of every closed shadow trade, regardless of rejection reason. */
  totalNetUsd: number;
  expectancyBps: number;
  winRate: number;

  byReason: ShadowBucket[];
  byConfidence: ShadowBucket[];

  /**
   * Counterfactual confidence sweep.
   * Includes real trades + shadow trades rejected specifically by confidence.
   * Other rejection reasons are deliberately excluded.
   */
  sweep: ThresholdRow[];
  recommendationMetric: RecommendationMetric;
  recommendationSampleCount: number;
  recommendedThreshold: number | null;

  /**
   * P&L of confidence-rejected shadow trades only.
   * Positive = the confidence gate skipped profitable trades.
   * Negative = the confidence gate avoided losses.
   */
  opportunityUsd: number;

  samplesToTrust: number;
}

export interface ShadowConfig {
  /** Fixed USD notional per shadow trade. */
  notional: number;
  slPct: number;
  tpPct: number;

  /** Modeled taker fee per fill. 0.00055 = 0.055%. */
  takerFeeRate: number;

  /**
   * Approximate carry model only.
   * Real exchange funding settles at symbol-specific intervals and rates.
   */
  fundingRatePer8h: number;

  /** Optional adverse execution slippage applied to both entry and exit. */
  slippageBpsPerFill: number;

  /** Force-close a shadow trade that never hit SL/TP. */
  maxHoldMs: number;

  /** Memory guards. */
  maxOpen: number;
  maxClosed: number;

  /** Evidence threshold before a confidence recommendation can be emitted. */
  minSamplesForRecommendation: number;

  /** Each candidate threshold must itself have at least this many samples. */
  minTradesPerThreshold: number;

  /** Objective used to select the recommended threshold. */
  recommendationMetric: RecommendationMetric;
}

export const DEFAULT_SHADOW_CONFIG: ShadowConfig = {
  notional: 1_000,
  slPct: 0.02,
  tpPct: 0.04,
  takerFeeRate: 0.00055,
  fundingRatePer8h: 0.0001,
  slippageBpsPerFill: 0,
  maxHoldMs: 2 * 60 * 60 * 1000,
  maxOpen: 400,
  maxClosed: 4_000,
  minSamplesForRecommendation: 50,
  minTradesPerThreshold: 20,
  recommendationMetric: "expectancyBps",
};

/**
 * Merge a partial config over the defaults and validate it, without building a
 * book. Lets a caller derive the exact economics and memory limits a book will
 * run with — needed to load a persisted snapshot that will actually restore.
 */
export function resolveShadowConfig(cfg: Partial<ShadowConfig> = {}): ShadowConfig {
  const merged = { ...DEFAULT_SHADOW_CONFIG, ...cfg };
  validateConfig(merged);
  return merged;
}

/** The subset of a config that a snapshot must agree on to be restorable. */
export function shadowEconomicsOf(cfg: ShadowConfig): ShadowBookSnapshot["economics"] {
  return economicsOf(cfg);
}

const CONF_BANDS: ReadonlyArray<readonly [string, number, number]> = [
  ["<0.60", 0, 0.6],
  ["0.60–0.70", 0.6, 0.7],
  ["0.70–0.80", 0.7, 0.8],
  ["0.80–0.90", 0.8, 0.9],
  ["0.90–1.00", 0.9, 1.0000000001],
];

const SWEEP_THRESHOLDS = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9] as const;

export const EMPTY_SHADOW_STATS: ShadowStats = {
  notional: DEFAULT_SHADOW_CONFIG.notional,
  openCount: 0,
  closedCount: 0,
  totalNetUsd: 0,
  expectancyBps: 0,
  winRate: 0,
  byReason: [],
  byConfidence: [],
  sweep: SWEEP_THRESHOLDS.map((threshold) => ({
    threshold,
    trades: 0,
    wins: 0,
    winRate: 0,
    expectancyBps: 0,
    netUsd: 0,
  })),
  recommendationMetric: DEFAULT_SHADOW_CONFIG.recommendationMetric,
  recommendationSampleCount: 0,
  recommendedThreshold: null,
  opportunityUsd: 0,
  samplesToTrust: DEFAULT_SHADOW_CONFIG.minSamplesForRecommendation,
};

export interface RealSample {
  confidence: number;
  /** Net return in bps. This is the canonical field for counterfactual sweeps. */
  netBps: number;
  /**
   * Optional original P&L for display/audit only.
   * Sweep P&L is normalized from netBps onto the shadow notional so real and
   * shadow samples remain comparable even when real position sizes differ.
   */
  netUsd?: number;
}

export interface ShadowBookSnapshot {
  version: 1;
  seq: number;
  /** Economics used to create/open these trades. */
  economics: Pick<
    ShadowConfig,
    | "notional"
    | "slPct"
    | "tpPct"
    | "takerFeeRate"
    | "fundingRatePer8h"
    | "slippageBpsPerFill"
    | "maxHoldMs"
  >;
  open: ShadowTrade[];
  closed: ShadowTrade[];
}

type BucketAccumulator = {
  b: ShadowBucket;
  bpsSum: number;
};

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

function emptyBucket(key: string): ShadowBucket {
  return {
    key,
    open: 0,
    closed: 0,
    wins: 0,
    winRate: 0,
    expectancyBps: 0,
    netUsd: 0,
  };
}

function finaliseBucket(entry: BucketAccumulator): ShadowBucket {
  const { b, bpsSum } = entry;
  return {
    ...b,
    winRate: b.closed ? (b.wins / b.closed) * 100 : 0,
    expectancyBps: b.closed ? bpsSum / b.closed : 0,
  };
}

function isFinitePositive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

function isConfidence(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 1;
}

function cloneTrade(t: ShadowTrade): ShadowTrade {
  return { ...t };
}

function bandOf(confidence: number): string {
  return (
    CONF_BANDS.find(([, lo, hi]) => confidence >= lo && confidence < hi)?.[0] ?? "out-of-range"
  );
}

function validateConfig(cfg: ShadowConfig): void {
  const positive: Array<[keyof ShadowConfig, number]> = [
    ["notional", cfg.notional],
    ["slPct", cfg.slPct],
    ["tpPct", cfg.tpPct],
    ["maxHoldMs", cfg.maxHoldMs],
    ["maxOpen", cfg.maxOpen],
    ["maxClosed", cfg.maxClosed],
    ["minSamplesForRecommendation", cfg.minSamplesForRecommendation],
    ["minTradesPerThreshold", cfg.minTradesPerThreshold],
  ];

  for (const [name, value] of positive) {
    if (!isFinitePositive(value)) {
      throw new RangeError(`${String(name)} must be a finite positive number`);
    }
  }

  if (!Number.isInteger(cfg.maxOpen) || !Number.isInteger(cfg.maxClosed)) {
    throw new RangeError("maxOpen and maxClosed must be integers");
  }

  if (
    !Number.isInteger(cfg.minSamplesForRecommendation) ||
    !Number.isInteger(cfg.minTradesPerThreshold)
  ) {
    throw new RangeError("minSamplesForRecommendation and minTradesPerThreshold must be integers");
  }

  if (!Number.isFinite(cfg.takerFeeRate) || cfg.takerFeeRate < 0) {
    throw new RangeError("takerFeeRate must be finite and >= 0");
  }

  if (!Number.isFinite(cfg.fundingRatePer8h)) {
    throw new RangeError("fundingRatePer8h must be finite");
  }

  if (!Number.isFinite(cfg.slippageBpsPerFill) || cfg.slippageBpsPerFill < 0) {
    throw new RangeError("slippageBpsPerFill must be finite and >= 0");
  }
}

/**
 * Apply adverse slippage to a synthetic fill.
 *
 * BUY entry  -> higher price
 * SELL entry -> lower price
 * BUY exit   -> lower price
 * SELL exit  -> higher price
 */
function slippedFill(
  price: number,
  side: "BUY" | "SELL",
  phase: "ENTRY" | "EXIT",
  slippageBps: number,
): number {
  if (slippageBps === 0) return price;

  const dir = side === "BUY" ? 1 : -1;
  const phaseSign = phase === "ENTRY" ? 1 : -1;
  return price * (1 + (dir * phaseSign * slippageBps) / 10_000);
}

function isValidRealSample(sample: RealSample): boolean {
  return isConfidence(sample.confidence) && Number.isFinite(sample.netBps);
}

function isRestorableTrade(t: ShadowTrade): boolean {
  return (
    !!t &&
    typeof t.id === "string" &&
    typeof t.symbol === "string" &&
    t.symbol.length > 0 &&
    typeof t.regime === "string" &&
    (t.side === "BUY" || t.side === "SELL") &&
    (t.reason === "confidence" ||
      t.reason === "suppressed" ||
      t.reason === "blocked" ||
      t.reason === "observer") &&
    isConfidence(t.confidence) &&
    isFinitePositive(t.notional) &&
    isFinitePositive(t.entryPrice) &&
    isFinitePositive(t.stopLoss) &&
    isFinitePositive(t.takeProfit) &&
    isFinitePositive(t.lastPrice) &&
    Number.isFinite(t.openedAt) &&
    Number.isFinite(t.lastMarkedAt) &&
    Number.isFinite(t.maxFavourableBps) &&
    Number.isFinite(t.maxAdverseBps)
  );
}

function economicsOf(cfg: ShadowConfig): ShadowBookSnapshot["economics"] {
  return {
    notional: cfg.notional,
    slPct: cfg.slPct,
    tpPct: cfg.tpPct,
    takerFeeRate: cfg.takerFeeRate,
    fundingRatePer8h: cfg.fundingRatePer8h,
    slippageBpsPerFill: cfg.slippageBpsPerFill,
    maxHoldMs: cfg.maxHoldMs,
  };
}

function sameEconomics(
  a: ShadowBookSnapshot["economics"],
  b: ShadowBookSnapshot["economics"],
): boolean {
  return (
    a.notional === b.notional &&
    a.slPct === b.slPct &&
    a.tpPct === b.tpPct &&
    a.takerFeeRate === b.takerFeeRate &&
    a.fundingRatePer8h === b.fundingRatePer8h &&
    a.slippageBpsPerFill === b.slippageBpsPerFill &&
    a.maxHoldMs === b.maxHoldMs
  );
}

export class ShadowBook {
  private readonly cfg: ShadowConfig;
  private readonly hooks: ShadowHooks;
  private readonly open = new Map<string, ShadowTrade>();
  private closed: ShadowTrade[] = [];
  private seq = 0;

  constructor(cfg: Partial<ShadowConfig> = {}, hooks: ShadowHooks = {}) {
    this.cfg = { ...DEFAULT_SHADOW_CONFIG, ...cfg };
    this.hooks = hooks;
    validateConfig(this.cfg);
  }

  getConfig(): Readonly<ShadowConfig> {
    return { ...this.cfg };
  }

  /** Defensive snapshots: callers cannot mutate internal book state. */
  getOpen(): ShadowTrade[] {
    return [...this.open.values()].map(cloneTrade);
  }

  getClosed(): ShadowTrade[] {
    return this.closed.map(cloneTrade);
  }

  /**
   * Record a proposal the real engine declined.
   * No-op if one shadow trade for the symbol is already open.
   */
  record(p: TradeProposal, reason: ShadowReason, regime: string): boolean {
    const symbol = p.symbol?.trim();

    if (!symbol) return false;
    if (this.open.has(symbol)) return false;
    if (this.open.size >= this.cfg.maxOpen) return false;
    if (!isFinitePositive(p.price)) return false;
    if (!isConfidence(p.confidence)) return false;
    if (!Number.isFinite(p.time)) return false;
    if (p.direction !== "BUY" && p.direction !== "SELL") return false;

    const entryPrice = slippedFill(p.price, p.direction, "ENTRY", this.cfg.slippageBpsPerFill);

    const trade: ShadowTrade = {
      id: `shadow-${p.time}-${++this.seq}`,
      symbol,
      side: p.direction,
      reason,
      confidence: p.confidence,
      regime,
      notional: this.cfg.notional,
      entryPrice,
      stopLoss: stopPrice(entryPrice, p.direction, this.cfg.slPct),
      takeProfit: targetPrice(entryPrice, p.direction, this.cfg.tpPct),
      openedAt: p.time,
      lastPrice: entryPrice,
      lastMarkedAt: p.time,
      maxFavourableBps: 0,
      maxAdverseBps: 0,
      exitPrice: null,
      closedAt: null,
      exitReason: null,
      netBps: null,
      netUsd: null,
      grossBps: null,
      feeUsd: null,
      fundingUsd: null,
    };

    this.open.set(symbol, trade);
    this.hooks.onOpen?.(cloneTrade(trade));

    return true;
  }

  /**
   * Mark one open shadow trade against a live tick.
   * Out-of-order ticks are ignored.
   */
  mark(symbol: string, price: number, time: number): boolean {
    const t = this.open.get(symbol);

    if (!t || !isFinitePositive(price) || !Number.isFinite(time)) return false;
    if (time < t.openedAt || time < t.lastMarkedAt) return false;

    const expiresAt = t.openedAt + this.cfg.maxHoldMs;
    const expired = time > expiresAt;

    /*
     * If the next observed tick arrives after expiry, that tick is too late to
     * prove an SL/TP hit inside the allowed window. Close at the last price
     * actually observed before expiry and cap elapsed-cost accounting at the
     * configured expiry time.
     */
    if (expired) {
      this.close(t, t.lastPrice, expiresAt, "TIME");
      return true;
    }

    t.lastPrice = price;
    t.lastMarkedAt = time;

    const dir = t.side === "BUY" ? 1 : -1;
    const moveBps = ((price - t.entryPrice) / t.entryPrice) * 10_000 * dir;

    t.maxFavourableBps = Math.max(t.maxFavourableBps, moveBps);
    t.maxAdverseBps = Math.min(t.maxAdverseBps, moveBps);

    const hitTp = dir === 1 ? price >= t.takeProfit : price <= t.takeProfit;
    const hitSl = dir === 1 ? price <= t.stopLoss : price >= t.stopLoss;

    if (hitTp) {
      this.close(t, t.takeProfit, time, "TP");
      return true;
    }

    if (hitSl) {
      this.close(t, t.stopLoss, time, "SL");
      return true;
    }

    if (time - t.openedAt >= this.cfg.maxHoldMs) {
      this.close(t, price, time, "TIME");
      return true;
    }

    return true;
  }

  /**
   * Timeout sweep for symbols that stopped ticking.
   * Uses the last observed price rather than fabricating a flat exit at entry.
   */
  sweep(now: number): number {
    if (!Number.isFinite(now)) return 0;

    let closedCount = 0;

    for (const t of [...this.open.values()]) {
      const expiresAt = t.openedAt + this.cfg.maxHoldMs;
      if (now >= expiresAt) {
        this.close(t, t.lastPrice, expiresAt, "TIME");
        closedCount += 1;
      }
    }

    return closedCount;
  }

  private close(
    t: ShadowTrade,
    rawExitPrice: number,
    time: number,
    reason: ShadowExitReason,
  ): void {
    if (!this.open.has(t.symbol)) return;

    const exitPrice = slippedFill(rawExitPrice, t.side, "EXIT", this.cfg.slippageBpsPerFill);

    const dir = t.side === "BUY" ? 1 : -1;
    const grossBps = ((exitPrice - t.entryPrice) / t.entryPrice) * 10_000 * dir;

    const feeBps = this.cfg.takerFeeRate * 2 * 10_000;

    /*
     * Approximate carry, not exchange-settlement accounting.
     * Positive rates debit longs and credit shorts; negative rates reverse it.
     */
    const elapsed = Math.max(0, time - t.openedAt);
    const fundingIntervals = elapsed / EIGHT_HOURS_MS;
    const fundingBps = this.cfg.fundingRatePer8h * fundingIntervals * 10_000 * dir;

    const netBps = grossBps - feeBps - fundingBps;

    t.exitPrice = exitPrice;
    t.closedAt = time;
    t.exitReason = reason;
    t.netBps = netBps;
    // Sized off the trade's own notional, not the live config, so a restored
    // trade is always settled on the terms it was opened under.
    t.netUsd = (netBps / 10_000) * t.notional;
    t.grossBps = grossBps;
    t.feeUsd = (feeBps / 10_000) * t.notional;
    t.fundingUsd = (fundingBps / 10_000) * t.notional;
    t.lastPrice = rawExitPrice;
    t.lastMarkedAt = Math.max(t.lastMarkedAt, time);

    this.open.delete(t.symbol);
    this.closed.push(t);

    if (this.closed.length > this.cfg.maxClosed) {
      this.closed.splice(0, this.closed.length - this.cfg.maxClosed);
    }

    // Fired after the book is consistent, so a handler that reads back the
    // book during the callback sees the trade already moved to `closed`.
    this.hooks.onClose?.(cloneTrade(t));
  }

  reset(): void {
    this.open.clear();
    this.closed = [];
  }

  /**
   * Export state so the owner process can persist it.
   * Persistence transport/storage is intentionally left outside this class.
   */
  snapshot(): ShadowBookSnapshot {
    return {
      version: 1,
      seq: this.seq,
      economics: economicsOf(this.cfg),
      open: this.getOpen(),
      closed: this.getClosed(),
    };
  }

  /**
   * Restore a trusted snapshot defensively.
   * Invalid rows are skipped; configured memory limits still apply.
   */
  restore(snapshot: ShadowBookSnapshot): void {
    if (!snapshot || snapshot.version !== 1) {
      throw new Error("Unsupported ShadowBook snapshot");
    }

    if (!snapshot.economics || !sameEconomics(snapshot.economics, economicsOf(this.cfg))) {
      throw new Error("ShadowBook snapshot economics do not match the active configuration");
    }

    this.open.clear();

    const openRows = snapshot.open
      .filter(isRestorableTrade)
      .filter((t) => t.closedAt === null && t.exitReason === null)
      .slice(-this.cfg.maxOpen);

    for (const t of openRows) {
      if (!this.open.has(t.symbol)) {
        this.open.set(t.symbol, cloneTrade(t));
      }
    }

    this.closed = snapshot.closed
      .filter(isRestorableTrade)
      .filter(
        (t) =>
          t.closedAt !== null &&
          t.exitReason !== null &&
          Number.isFinite(t.netBps) &&
          Number.isFinite(t.netUsd),
      )
      .slice(-this.cfg.maxClosed)
      .map(cloneTrade);

    this.seq = Number.isSafeInteger(snapshot.seq) ? Math.max(this.seq, snapshot.seq) : this.seq;
  }

  /**
   * Build dashboard statistics and a confidence-gate counterfactual.
   *
   * Important:
   *   - All shadow reasons contribute to overall shadow performance.
   *   - Only `confidence` shadow rejections contribute to the threshold sweep.
   *     A confidence threshold cannot make a halt, suppression rule, margin
   *     refusal or observer-mode trade executable.
   */
  getStats(real: RealSample[] = []): ShadowStats {
    const reasonBuckets = new Map<string, BucketAccumulator>();
    const confBuckets = new Map<string, BucketAccumulator>();

    const bump = (
      map: Map<string, BucketAccumulator>,
      key: string,
      trade: ShadowTrade | null,
    ): void => {
      let entry = map.get(key);

      if (!entry) {
        entry = { b: emptyBucket(key), bpsSum: 0 };
        map.set(key, entry);
      }

      if (!trade) {
        entry.b.open += 1;
        return;
      }

      entry.b.closed += 1;
      entry.b.netUsd += trade.netUsd ?? 0;
      entry.bpsSum += trade.netBps ?? 0;

      if ((trade.netUsd ?? 0) > 0) {
        entry.b.wins += 1;
      }
    };

    for (const t of this.open.values()) {
      bump(reasonBuckets, SHADOW_REASON_LABELS[t.reason], null);
      bump(confBuckets, bandOf(t.confidence), null);
    }

    let totalNetUsd = 0;
    let totalBps = 0;
    let wins = 0;
    let opportunityUsd = 0;

    for (const t of this.closed) {
      const netUsd = t.netUsd ?? 0;
      const netBps = t.netBps ?? 0;

      totalNetUsd += netUsd;
      totalBps += netBps;
      if (netUsd > 0) wins += 1;
      if (t.reason === "confidence") opportunityUsd += netUsd;

      bump(reasonBuckets, SHADOW_REASON_LABELS[t.reason], t);
      bump(confBuckets, bandOf(t.confidence), t);
    }

    const validReal = real.filter(isValidRealSample).map((sample) => ({
      confidence: sample.confidence,
      netBps: sample.netBps,
      netUsd: (sample.netBps / 10_000) * this.cfg.notional,
    }));

    const confidenceShadowSamples = this.closed
      .filter(
        (t) =>
          t.reason === "confidence" &&
          t.netBps !== null &&
          t.netUsd !== null &&
          isConfidence(t.confidence),
      )
      .map((t) => ({
        confidence: t.confidence,
        netBps: t.netBps as number,
        netUsd: t.netUsd as number,
      }));

    const recommendationPool = [...validReal, ...confidenceShadowSamples];

    const sweep: ThresholdRow[] = SWEEP_THRESHOLDS.map((threshold) => {
      const rows = recommendationPool.filter((sample) => sample.confidence >= threshold);

      const winsAtThreshold = rows.reduce((count, row) => count + (row.netUsd > 0 ? 1 : 0), 0);

      const bpsSum = rows.reduce((sum, row) => sum + row.netBps, 0);
      const usdSum = rows.reduce((sum, row) => sum + row.netUsd, 0);

      return {
        threshold,
        trades: rows.length,
        wins: winsAtThreshold,
        winRate: rows.length ? (winsAtThreshold / rows.length) * 100 : 0,
        expectancyBps: rows.length ? bpsSum / rows.length : 0,
        netUsd: usdSum,
      };
    });

    const enoughOverall = recommendationPool.length >= this.cfg.minSamplesForRecommendation;

    const candidates = enoughOverall
      ? sweep.filter((row) => row.trades >= this.cfg.minTradesPerThreshold)
      : [];

    const metric = this.cfg.recommendationMetric;

    const best = candidates.reduce<ThresholdRow | null>((current, row) => {
      if (!current) return row;

      const rowScore = metric === "expectancyBps" ? row.expectancyBps : row.netUsd;
      const currentScore = metric === "expectancyBps" ? current.expectancyBps : current.netUsd;

      if (rowScore > currentScore) return row;
      if (rowScore < currentScore) return current;

      /*
       * Tie-break toward more evidence, then toward the stricter threshold.
       */
      if (row.trades > current.trades) return row;
      if (row.trades < current.trades) return current;
      return row.threshold > current.threshold ? row : current;
    }, null);

    const confidenceOrder = new Map(CONF_BANDS.map(([key], index) => [key, index]));

    return {
      notional: this.cfg.notional,
      openCount: this.open.size,
      closedCount: this.closed.length,
      totalNetUsd,
      expectancyBps: this.closed.length ? totalBps / this.closed.length : 0,
      winRate: this.closed.length ? (wins / this.closed.length) * 100 : 0,

      byReason: [...reasonBuckets.values()].map(finaliseBucket).sort((a, b) => b.closed - a.closed),

      byConfidence: [...confBuckets.values()]
        .map(finaliseBucket)
        .sort(
          (a, b) =>
            (confidenceOrder.get(a.key) ?? Number.MAX_SAFE_INTEGER) -
            (confidenceOrder.get(b.key) ?? Number.MAX_SAFE_INTEGER),
        ),

      sweep,
      recommendationMetric: metric,
      recommendationSampleCount: recommendationPool.length,
      recommendedThreshold: best?.threshold ?? null,
      opportunityUsd,
      samplesToTrust: Math.max(0, this.cfg.minSamplesForRecommendation - recommendationPool.length),
    };
  }
}
