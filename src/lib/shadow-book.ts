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

export type ShadowReason =
  | "confidence" // below the (learned) minimum confidence gate
  | "suppressed" // symbol suppressed by the edge model / cost model
  | "blocked" // broker refused: no slot, thin book, margin, slippage, halt…
  | "observer"; // dashboard was in read-only mode (a runner owns the account)

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
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: number;
  /** Best/worst excursion in bps while open — how much room the trade had. */
  maxFavourableBps: number;
  maxAdverseBps: number;
  exitPrice: number | null;
  closedAt: number | null;
  exitReason: "TP" | "SL" | "TIME" | null;
  /** Net return in bps after both taker fees and approximate funding. */
  netBps: number | null;
  /** Net USD on the fixed shadow notional. */
  netUsd: number | null;
}

export interface ShadowBucket {
  key: string;
  open: number;
  closed: number;
  wins: number;
  winRate: number;
  /** Average net bps per closed shadow trade. */
  expectancyBps: number;
  netUsd: number;
}

export interface ThresholdRow {
  threshold: number;
  /** Trades (real + shadow) that would have been taken at this gate. */
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
  totalNetUsd: number;
  expectancyBps: number;
  winRate: number;
  byReason: ShadowBucket[];
  byConfidence: ShadowBucket[];
  sweep: ThresholdRow[];
  /** Threshold with the best net USD in the sweep, once samples allow. */
  recommendedThreshold: number | null;
  /** Net USD the current gate gave up (positive) or saved (negative). */
  opportunityUsd: number;
  /** Samples still needed before the recommendation is trusted. */
  samplesToTrust: number;
}

export interface ShadowConfig {
  /** Fixed USD notional per shadow trade — comparability over realism. */
  notional: number;
  slPct: number;
  tpPct: number;
  takerFeeRate: number;
  fundingRatePer8h: number;
  /** Force-close a shadow trade that never hit SL/TP, in ms. */
  maxHoldMs: number;
  /** Cap on concurrently open shadow trades (memory guard). */
  maxOpen: number;
  /** Cap on retained closed shadow trades. */
  maxClosed: number;
  /** One shadow trade per symbol at a time. */
  minSamplesForRecommendation: number;
}

export const DEFAULT_SHADOW_CONFIG: ShadowConfig = {
  notional: 1_000,
  slPct: 0.02,
  tpPct: 0.04,
  takerFeeRate: 0.00055,
  fundingRatePer8h: 0.0001,
  maxHoldMs: 2 * 60 * 60 * 1000,
  maxOpen: 400,
  maxClosed: 4_000,
  minSamplesForRecommendation: 50,
};

const CONF_BANDS: Array<[string, number, number]> = [
  ["0.60–0.70", 0.6, 0.7],
  ["0.70–0.80", 0.7, 0.8],
  ["0.80–0.90", 0.8, 0.9],
  ["0.90–1.00", 0.9, 1.01],
];

const SWEEP_THRESHOLDS = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];

/** A real closed paper trade, projected into shadow-comparable terms. */
export interface RealSample {
  confidence: number;
  /** Net return in bps of notional. */
  netBps: number;
  netUsd: number;
}

function emptyBucket(key: string): ShadowBucket {
  return { key, open: 0, closed: 0, wins: 0, winRate: 0, expectancyBps: 0, netUsd: 0 };
}

function finalise(b: ShadowBucket, bpsSum: number): ShadowBucket {
  b.winRate = b.closed ? (b.wins / b.closed) * 100 : 0;
  b.expectancyBps = b.closed ? bpsSum / b.closed : 0;
  return b;
}

export class ShadowBook {
  private cfg: ShadowConfig;
  private open = new Map<string, ShadowTrade>(); // keyed by symbol
  private closed: ShadowTrade[] = [];
  private seq = 0;

  constructor(cfg: Partial<ShadowConfig> = {}) {
    this.cfg = { ...DEFAULT_SHADOW_CONFIG, ...cfg };
  }

  getOpen(): ShadowTrade[] {
    return [...this.open.values()];
  }

  getClosed(): ShadowTrade[] {
    return this.closed;
  }

  /** Record a proposal the real engine declined. No-op if one is already live. */
  record(p: TradeProposal, reason: ShadowReason, regime: string): void {
    if (this.open.has(p.symbol)) return;
    if (this.open.size >= this.cfg.maxOpen) return;
    if (!Number.isFinite(p.price) || p.price <= 0) return;
    const dir = p.direction === "BUY" ? 1 : -1;
    this.open.set(p.symbol, {
      id: `shadow-${++this.seq}`,
      symbol: p.symbol,
      side: p.direction,
      reason,
      confidence: p.confidence,
      regime,
      entryPrice: p.price,
      stopLoss: p.price * (1 - dir * this.cfg.slPct),
      takeProfit: p.price * (1 + dir * this.cfg.tpPct),
      openedAt: p.time,
      maxFavourableBps: 0,
      maxAdverseBps: 0,
      exitPrice: null,
      closedAt: null,
      exitReason: null,
      netBps: null,
      netUsd: null,
    });
  }

  /** Mark open shadow trades against a live tick; closes on SL/TP/timeout. */
  mark(symbol: string, price: number, time: number): void {
    const t = this.open.get(symbol);
    if (!t || !Number.isFinite(price) || price <= 0) return;
    const dir = t.side === "BUY" ? 1 : -1;
    const moveBps = ((price - t.entryPrice) / t.entryPrice) * 10_000 * dir;
    if (moveBps > t.maxFavourableBps) t.maxFavourableBps = moveBps;
    if (moveBps < t.maxAdverseBps) t.maxAdverseBps = moveBps;

    const hitTp = dir === 1 ? price >= t.takeProfit : price <= t.takeProfit;
    const hitSl = dir === 1 ? price <= t.stopLoss : price >= t.stopLoss;
    if (hitTp) return this.close(t, t.takeProfit, time, "TP");
    if (hitSl) return this.close(t, t.stopLoss, time, "SL");
    if (time - t.openedAt >= this.cfg.maxHoldMs) this.close(t, price, time, "TIME");
  }

  /** Timeout sweep for symbols that stopped ticking. */
  sweep(now: number): void {
    for (const t of [...this.open.values()]) {
      if (now - t.openedAt >= this.cfg.maxHoldMs) this.close(t, t.entryPrice, now, "TIME");
    }
  }

  private close(t: ShadowTrade, exitPrice: number, time: number, reason: "TP" | "SL" | "TIME") {
    const dir = t.side === "BUY" ? 1 : -1;
    const grossBps = ((exitPrice - t.entryPrice) / t.entryPrice) * 10_000 * dir;
    const feeBps = this.cfg.takerFeeRate * 2 * 10_000;
    const intervals = Math.max(0, (time - t.openedAt) / (8 * 60 * 60 * 1000));
    const fundingBps = this.cfg.fundingRatePer8h * intervals * 10_000 * dir;
    const netBps = grossBps - feeBps - fundingBps;
    t.exitPrice = exitPrice;
    t.closedAt = time;
    t.exitReason = reason;
    t.netBps = netBps;
    t.netUsd = (netBps / 10_000) * this.cfg.notional;
    this.open.delete(t.symbol);
    this.closed.push(t);
    if (this.closed.length > this.cfg.maxClosed) {
      this.closed.splice(0, this.closed.length - this.cfg.maxClosed);
    }
  }

  reset(): void {
    this.open.clear();
    this.closed = [];
  }

  /**
   * Combine shadow outcomes with the real closed trades to sweep the
   * confidence gate: at each candidate threshold, what would the book have
   * earned if every proposal at or above it had been taken?
   */
  getStats(real: RealSample[] = []): ShadowStats {
    const closed = this.closed;
    const reasonBuckets = new Map<string, { b: ShadowBucket; sum: number }>();
    const confBuckets = new Map<string, { b: ShadowBucket; sum: number }>();

    const bump = (
      map: Map<string, { b: ShadowBucket; sum: number }>,
      key: string,
      t: ShadowTrade | null,
    ) => {
      let e = map.get(key);
      if (!e) {
        e = { b: emptyBucket(key), sum: 0 };
        map.set(key, e);
      }
      if (!t) {
        e.b.open += 1;
        return;
      }
      e.b.closed += 1;
      e.b.netUsd += t.netUsd ?? 0;
      e.sum += t.netBps ?? 0;
      if ((t.netUsd ?? 0) > 0) e.b.wins += 1;
    };

    const bandOf = (c: number) =>
      CONF_BANDS.find(([, lo, hi]) => c >= lo && c < hi)?.[0] ?? "<0.60";

    for (const t of this.open.values()) {
      bump(reasonBuckets, SHADOW_REASON_LABELS[t.reason], null);
      bump(confBuckets, bandOf(t.confidence), null);
    }
    let netUsd = 0;
    let bpsSum = 0;
    let wins = 0;
    for (const t of closed) {
      netUsd += t.netUsd ?? 0;
      bpsSum += t.netBps ?? 0;
      if ((t.netUsd ?? 0) > 0) wins += 1;
      bump(reasonBuckets, SHADOW_REASON_LABELS[t.reason], t);
      bump(confBuckets, bandOf(t.confidence), t);
    }

    const pool: Array<{ confidence: number; netBps: number; netUsd: number }> = [
      ...real,
      ...closed
        .filter((t) => t.netBps !== null)
        .map((t) => ({
          confidence: t.confidence,
          netBps: t.netBps as number,
          netUsd: t.netUsd as number,
        })),
    ];

    const sweep: ThresholdRow[] = SWEEP_THRESHOLDS.map((threshold) => {
      const rows = pool.filter((r) => r.confidence >= threshold);
      const w = rows.filter((r) => r.netUsd > 0).length;
      const sum = rows.reduce((a, r) => a + r.netBps, 0);
      return {
        threshold,
        trades: rows.length,
        wins: w,
        winRate: rows.length ? (w / rows.length) * 100 : 0,
        expectancyBps: rows.length ? sum / rows.length : 0,
        netUsd: rows.reduce((a, r) => a + r.netUsd, 0),
      };
    });

    const enough = pool.length >= this.cfg.minSamplesForRecommendation;
    const best = sweep
      .filter((r) => r.trades >= 10)
      .reduce<ThresholdRow | null>((b, r) => (!b || r.netUsd > b.netUsd ? r : b), null);

    return {
      notional: this.cfg.notional,
      openCount: this.open.size,
      closedCount: closed.length,
      totalNetUsd: netUsd,
      expectancyBps: closed.length ? bpsSum / closed.length : 0,
      winRate: closed.length ? (wins / closed.length) * 100 : 0,
      byReason: [...reasonBuckets.values()]
        .map((e) => finalise(e.b, e.sum))
        .sort((a, b) => b.closed - a.closed),
      byConfidence: [...confBuckets.values()]
        .map((e) => finalise(e.b, e.sum))
        .sort((a, b) => a.key.localeCompare(b.key)),
      sweep,
      recommendedThreshold: enough && best ? best.threshold : null,
      // Money the gate refused: positive means the skipped trades were, on
      // net, profitable — the swarm was too shy.
      opportunityUsd: netUsd,
      samplesToTrust: Math.max(0, this.cfg.minSamplesForRecommendation - pool.length),
    };
  }
}
