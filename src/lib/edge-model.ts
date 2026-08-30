import { winRateStats } from "./math/stats";
import { STRATEGY_EPOCH } from "./strategy-epoch";
// Edge model — pure, client-safe helpers for bucketing outcomes and turning
// stored trade history into live agent/symbol/regime/confidence weights.

export interface EdgeRow {
  name: string;
  trades: number;
  wins: number;
  pnl: number;
  expectancy: number;
  /** Expectancy before fees, funding and slippage — the "paper" edge. */
  gross_expectancy?: number;
  /** Average round-trip slippage paid on this bucket, in bps. */
  avg_slip_bps?: number;
  avg_spread_bps?: number;
  avg_confidence?: number;
}

export interface ExecutionSummary {
  trades: number;
  gross_pnl: number;
  net_pnl: number;
  fees: number;
  funding: number;
  /** Fill-vs-signal drift. Attribution only — already inside gross_pnl. */
  slip_cost: number;
  /** net - (gross - fees - funding). ~0 outside liquidations. */
  residual?: number;
  /** Trades that individually fail the net identity. */
  unreconciled?: number;
  avg_entry_slip_bps: number;
  avg_exit_slip_bps: number;
  avg_spread_bps: number;
  avg_latency_ms: number;
  book_priced: number;
  liquidations: number;
}

/** A bucket row scoped to the strategy epoch that produced it. */
export interface EpochEdgeRow extends EdgeRow {
  epoch: string;
}

export interface EdgeReport {
  totals: { trades: number; wins: number; pnl: number; expectancy: number };
  execution?: ExecutionSummary;
  agents: EdgeRow[];
  symbols: EdgeRow[];
  regimes: EdgeRow[];
  hours: EdgeRow[];
  /** Confidence buckets pooled across every learning epoch. Display only. */
  confidence: EdgeRow[];
  /**
   * Confidence buckets split by epoch — the only sound basis for calibrating
   * an entry threshold, because the confidence SCALE is not comparable across
   * epochs (see deriveEdge). Absent on reports produced before this existed,
   * in which case calibration falls back to the pooled rows.
   */
  confidence_by_epoch?: EpochEdgeRow[];
}

export const EMPTY_EXECUTION: ExecutionSummary = {
  trades: 0,
  gross_pnl: 0,
  net_pnl: 0,
  fees: 0,
  funding: 0,
  slip_cost: 0,
  residual: 0,
  unreconciled: 0,
  avg_entry_slip_bps: 0,
  avg_exit_slip_bps: 0,
  avg_spread_bps: 0,
  avg_latency_ms: 0,
  book_priced: 0,
  liquidations: 0,
};

export const EMPTY_EDGE_REPORT: EdgeReport = {
  totals: { trades: 0, wins: 0, pnl: 0, expectancy: 0 },
  execution: EMPTY_EXECUTION,
  agents: [],
  symbols: [],
  regimes: [],
  hours: [],
  confidence: [],
};

export function confBucket(confidence: number): string {
  const c = Math.max(0, Math.min(1, confidence));
  if (c < 0.6) return "0.5-0.6";
  if (c < 0.7) return "0.6-0.7";
  if (c < 0.8) return "0.7-0.8";
  if (c < 0.9) return "0.8-0.9";
  return "0.9-1.0";
}

/** Volatility regime from recent percentage move of the symbol. */
export function regimeOf(changePct: number): string {
  const v = Math.abs(changePct);
  if (v < 0.05) return "vol:calm";
  if (v < 0.2) return "vol:normal";
  if (v < 0.8) return "vol:active";
  return "vol:violent";
}

export function winRate(row: { trades: number; wins: number }): number {
  return row.trades > 0 ? row.wins / row.trades : 0;
}

/**
 * Minimum closed trades in a bucket before its realized outcome is allowed to
 * move anything. Below this the bucket is statistically noise and the base
 * weight / threshold is kept unchanged.
 */
export const MIN_BUCKET_SAMPLE = 20;
const MIN_SAMPLE = MIN_BUCKET_SAMPLE;
/** Do not let learned thresholds starve the agreed 100-trade review run. */
export const MIN_CONFIDENCE_CALIBRATION_SAMPLE = 100;

export type TrustLevel = "none" | "low" | "medium" | "high";

/** Confidence we place in a bucket's measured edge, purely from sample size. */
export function trustLevel(sample: number): TrustLevel {
  if (sample < MIN_BUCKET_SAMPLE) return "none";
  if (sample < MIN_BUCKET_SAMPLE * 2.5) return "low";
  if (sample < MIN_BUCKET_SAMPLE * 6) return "medium";
  return "high";
}

/**
 * Learned weights derived from realized outcomes. Agents that make money get
 * amplified, agents that lose get damped; symbols with proven negative
 * expectancy get suppressed; the entry threshold is recalibrated toward the
 * confidence bucket that actually pays.
 *
 * Everything here is measured NET of execution cost (fees, funding, spread and
 * slippage), so a setup that only looks good on mid-price paper fills is
 * demoted automatically.
 */
export interface LearnedEdge {
  agentWeights: Record<string, number>;
  suppressedSymbols: string[];
  /** Symbols with positive gross edge that execution cost turns negative. */
  costSuppressedSymbols: string[];
  /** Per-symbol round-trip cost estimate in bps, used to gate thin markets. */
  symbolCostBps: Record<string, number>;
  minConfidence: number;
  /** Extra edge (bps) a signal must clear beyond measured execution cost. */
  requiredEdgeBps: number;
  sample: number;
  /** Closed trades observed per agent, and whether that is enough to act on. */
  agentSamples: Record<string, number>;
  agentTrust: Record<string, TrustLevel>;
  /** Agents whose weight is currently locked to the base value (low sample). */
  pendingAgents: string[];
  /** Overall trust in the learned parameters, from total closed trades. */
  trust: TrustLevel;
  minBucketSample: number;
  /** The epoch new signals are being stamped with. */
  currentEpoch: string;
  /**
   * Closed trades from THAT epoch — the sample the confidence threshold is
   * actually calibrated on. It can be far smaller than `sample`, which pools
   * every learning epoch, and the gap is the honest measure of how much is
   * known about the rules currently running.
   */
  currentEpochSample: number;
}

export const BASE_AGENT_WEIGHTS: Record<string, number> = {
  Trend: 1.0,
  MeanRev: 0.8,
  Breakout: 0.9,
  Meme: 1.1,
};

/** Round-trip taker fee in bps (Bybit USDT perp: 0.055% each leg). */
export const ROUND_TRIP_FEE_BPS = 11;

export function deriveEdge(report: EdgeReport, baseMinConfidence = 0.6): LearnedEdge {
  const agentWeights: Record<string, number> = { ...BASE_AGENT_WEIGHTS };

  const scale = (row: EdgeRow, base: number) => {
    if (row.trades < MIN_SAMPLE) return base;
    const wr = winRate(row);
    // 0.5 win rate → unchanged, 0.75 → +50%, 0.25 → −50%, clamped.
    let factor = Math.max(0.2, Math.min(2, 1 + (wr - 0.5) * 2));
    // Cost-aware correction: an agent whose gross edge is positive but whose
    // net edge is negative is paying more in execution than it earns.
    const gross = row.gross_expectancy ?? row.expectancy;
    if (gross > 0 && row.expectancy <= 0) factor *= 0.5;
    if (row.expectancy > 0) factor *= 1.1;
    // Evidence shrinkage: a bucket only moves its weight as far as its
    // statistical confidence allows. With a win-rate CI that straddles 50%,
    // the deviation from the base weight is pulled back toward 1.
    const ev = winRateStats(row.wins, row.trades);
    const proven = ev.provenEdge || ev.ci95.high < 0.5;
    const shrink = proven ? 1 : Math.min(1, row.trades / (MIN_BUCKET_SAMPLE * 2));
    factor = 1 + (factor - 1) * shrink;
    return Number((base * Math.max(0.15, Math.min(2, factor))).toFixed(3));
  };

  const agentSamples: Record<string, number> = {};
  const agentTrust: Record<string, TrustLevel> = {};
  const pendingAgents: string[] = [];
  for (const name of Object.keys(BASE_AGENT_WEIGHTS)) {
    agentSamples[name] = 0;
    agentTrust[name] = "none";
  }
  for (const row of report.agents) {
    agentSamples[row.name] = row.trades;
    agentTrust[row.name] = trustLevel(row.trades);
    agentWeights[row.name] = scale(row, BASE_AGENT_WEIGHTS[row.name] ?? 1);
  }
  for (const [name, n] of Object.entries(agentSamples)) {
    if (n < MIN_BUCKET_SAMPLE) pendingAgents.push(name);
  }

  const suppressedSymbols = report.symbols
    .filter((s) => s.trades >= 4 && s.pnl < 0 && winRate(s) < 0.4)
    .map((s) => s.name);

  // Markets where the gross signal works but the book eats it: too thin/wide
  // to trade at this size, regardless of how good the setup looks.
  const costSuppressedSymbols = report.symbols
    .filter(
      (s) =>
        s.trades >= 4 &&
        (s.gross_expectancy ?? 0) > 0 &&
        s.expectancy <= 0 &&
        !suppressedSymbols.includes(s.name),
    )
    .map((s) => s.name);

  const symbolCostBps: Record<string, number> = {};
  for (const s of report.symbols) {
    if (s.trades < 3) continue;
    symbolCostBps[s.name] = Number(((s.avg_slip_bps ?? 0) + ROUND_TRIP_FEE_BPS).toFixed(2));
  }

  // Confidence calibration: raise the bar to the lowest bucket that is
  // profitable once we have enough closed trades to trust it.
  //
  // SCALE SAFETY — calibrate from the CURRENT epoch only.
  //
  // Confidence is not comparable across epochs: v1 saturated on |net|, while
  // v2 onward normalize to 0.5-1.0 by total agent weight. Measured on real
  // history, v1 trades occupy 0.7-1.0 and v3 trades occupy 0.6-0.8 with almost
  // no overlap, so the pooled bucket table describes two different scales at
  // once. Calibrating on the pool picks a floor from whichever epoch happens
  // to look best — and if that is the retired scale, the floor can sit ABOVE
  // anything the running strategy ever emits. That does not make the engine
  // selective; it silently stops it trading altogether.
  //
  // Scoping to the running epoch also makes starvation structurally
  // impossible: the chosen floor always comes from a bucket holding at least
  // MIN_SAMPLE trades from the epoch now in force, so signals do reach it.
  //
  // Other calibrations (agents, symbols, regimes, cost) are unaffected by the
  // scale change and keep using the full learning pool.
  let minConfidence = baseMinConfidence;
  const epochRows = report.confidence_by_epoch;
  const scoped = (epochRows ?? []).filter((b) => b.epoch === STRATEGY_EPOCH);
  // A report that predates confidence_by_epoch keeps the old pooled behaviour;
  // once the field exists, the pool is never used for this again.
  const calibrationRows: EdgeRow[] = epochRows ? scoped : report.confidence;
  const calibrationSample = epochRows
    ? scoped.reduce((n, b) => n + b.trades, 0)
    : report.totals.trades;
  const buckets = [...calibrationRows]
    .filter((b) => b.trades >= MIN_SAMPLE)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (calibrationSample >= MIN_CONFIDENCE_CALIBRATION_SAMPLE) {
    const firstGood = buckets.find((b) => b.expectancy > 0);
    if (firstGood) {
      const floor = Number(firstGood.name.split("-")[0]);
      if (Number.isFinite(floor)) {
        minConfidence = Math.max(baseMinConfidence, Math.min(0.9, floor));
      }
    }
  }

  const exec = report.execution;
  const measuredCostBps =
    exec && exec.trades >= 3
      ? exec.avg_entry_slip_bps + exec.avg_exit_slip_bps + ROUND_TRIP_FEE_BPS
      : ROUND_TRIP_FEE_BPS;
  // Demand a real margin over the measured cost of doing business.
  const requiredEdgeBps = Number((measuredCostBps * 1.5).toFixed(2));

  return {
    agentWeights,
    suppressedSymbols,
    costSuppressedSymbols,
    symbolCostBps,
    minConfidence,
    requiredEdgeBps,
    sample: report.totals.trades,
    agentSamples,
    agentTrust,
    pendingAgents,
    trust: trustLevel(report.totals.trades),
    minBucketSample: MIN_BUCKET_SAMPLE,
    currentEpoch: STRATEGY_EPOCH,
    currentEpochSample: calibrationSample,
  };
}

// ── Rolling-window edge stability ─────────────────────────────────────────

export interface RollingTrade {
  pnl: number;
  grossPnl: number;
  fees: number;
  funding: number;
  slipCostUsd: number;
  closedAt: number;
}

export interface RollingWindow {
  label: string;
  size: number;
  trades: number;
  wins: number;
  winRate: number;
  netPnl: number;
  grossPnl: number;
  fees: number;
  funding: number;
  slipCost: number;
  /** Share of gross PnL eaten by fees + funding + slippage. */
  costDrag: number;
  expectancy: number;
  /** Sharpe-like stability: mean / stdev of per-trade net PnL, scaled by √n. */
  stability: number;
  trust: TrustLevel;
}

const WINDOWS: Array<{ label: string; size: number }> = [
  { label: "Last 20", size: 20 },
  { label: "Last 50", size: 50 },
  { label: "Last 100", size: 100 },
  { label: "All time", size: Infinity },
];

function summarize(label: string, size: number, slice: RollingTrade[]): RollingWindow {
  const n = slice.length;
  const wins = slice.filter((t) => t.pnl > 0).length;
  const netPnl = slice.reduce((a, t) => a + t.pnl, 0);
  const grossPnl = slice.reduce((a, t) => a + t.grossPnl, 0);
  const fees = slice.reduce((a, t) => a + t.fees, 0);
  const funding = slice.reduce((a, t) => a + t.funding, 0);
  const slipCost = slice.reduce((a, t) => a + t.slipCostUsd, 0);
  const mean = n ? netPnl / n : 0;
  const variance = n > 1 ? slice.reduce((a, t) => a + (t.pnl - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const stability = n > 1 && sd > 0 ? (mean / sd) * Math.sqrt(n) : 0;
  return {
    label,
    size,
    trades: n,
    wins,
    winRate: n ? wins / n : 0,
    netPnl,
    grossPnl,
    fees,
    funding,
    slipCost,
    costDrag: grossPnl !== 0 ? (fees + funding + slipCost) / Math.abs(grossPnl) : 0,
    expectancy: mean,
    stability,
    trust: trustLevel(n),
  };
}

/**
 * Rolling-window performance over the most recent closed trades, so a decaying
 * edge shows up as a gap between the short and the long window.
 */
export function rollingEdge(trades: RollingTrade[]): RollingWindow[] {
  const ordered = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  return WINDOWS.map((w) =>
    summarize(w.label, w.size, w.size === Infinity ? ordered : ordered.slice(-w.size)),
  );
}

/** Recent-vs-prior expectancy drift on equal halves of the last 2N trades. */
export function edgeDrift(trades: RollingTrade[], n = 25) {
  const ordered = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  if (ordered.length < n * 2) return null;
  const recent = ordered.slice(-n);
  const prior = ordered.slice(-n * 2, -n);
  const exp = (xs: RollingTrade[]) => xs.reduce((a, t) => a + t.pnl, 0) / xs.length;
  const recentExp = exp(recent);
  const priorExp = exp(prior);
  return { recentExp, priorExp, delta: recentExp - priorExp, sample: n };
}
