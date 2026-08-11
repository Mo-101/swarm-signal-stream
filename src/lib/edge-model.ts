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
  slip_cost: number;
  avg_entry_slip_bps: number;
  avg_exit_slip_bps: number;
  avg_spread_bps: number;
  avg_latency_ms: number;
  book_priced: number;
  liquidations: number;
}

export interface EdgeReport {
  totals: { trades: number; wins: number; pnl: number; expectancy: number };
  execution?: ExecutionSummary;
  agents: EdgeRow[];
  symbols: EdgeRow[];
  regimes: EdgeRow[];
  hours: EdgeRow[];
  confidence: EdgeRow[];
}

export const EMPTY_EXECUTION: ExecutionSummary = {
  trades: 0,
  gross_pnl: 0,
  net_pnl: 0,
  fees: 0,
  funding: 0,
  slip_cost: 0,
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

const MIN_SAMPLE = 8;

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
}

export const BASE_AGENT_WEIGHTS: Record<string, number> = {
  Trend: 1.0,
  MeanRev: 0.8,
  Breakout: 0.9,
  Meme: 1.1,
};

/** Round-trip taker fee in bps (Bybit USDT perp: 0.055% each leg). */
const ROUND_TRIP_FEE_BPS = 11;

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
    return Number((base * Math.max(0.15, Math.min(2, factor))).toFixed(3));
  };

  for (const row of report.agents) {
    agentWeights[row.name] = scale(row, BASE_AGENT_WEIGHTS[row.name] ?? 1);
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
    symbolCostBps[s.name] = Number(
      ((s.avg_slip_bps ?? 0) + ROUND_TRIP_FEE_BPS).toFixed(2),
    );
  }

  // Confidence calibration: raise the bar to the lowest bucket that is
  // profitable once we have enough closed trades to trust it.
  let minConfidence = baseMinConfidence;
  const buckets = [...report.confidence]
    .filter((b) => b.trades >= MIN_SAMPLE)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (buckets.length > 0) {
    const firstGood = buckets.find((b) => b.expectancy > 0);
    const lowest = firstGood ?? buckets[buckets.length - 1];
    const floor = Number(lowest.name.split("-")[0]);
    if (Number.isFinite(floor)) {
      minConfidence = Math.max(baseMinConfidence, Math.min(0.9, floor));
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
  };
}

