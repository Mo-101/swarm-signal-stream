// Edge model — pure, client-safe helpers for bucketing outcomes and turning
// stored trade history into live agent/symbol/regime/confidence weights.

export interface EdgeRow {
  name: string;
  trades: number;
  wins: number;
  pnl: number;
  expectancy: number;
  avg_confidence?: number;
}

export interface EdgeReport {
  totals: { trades: number; wins: number; pnl: number; expectancy: number };
  agents: EdgeRow[];
  symbols: EdgeRow[];
  regimes: EdgeRow[];
  hours: EdgeRow[];
  confidence: EdgeRow[];
}

export const EMPTY_EDGE_REPORT: EdgeReport = {
  totals: { trades: 0, wins: 0, pnl: 0, expectancy: 0 },
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
 */
export interface LearnedEdge {
  agentWeights: Record<string, number>;
  suppressedSymbols: string[];
  minConfidence: number;
  sample: number;
}

export const BASE_AGENT_WEIGHTS: Record<string, number> = {
  Trend: 1.0,
  MeanRev: 0.8,
  Breakout: 0.9,
  Meme: 1.1,
};

export function deriveEdge(report: EdgeReport, baseMinConfidence = 0.6): LearnedEdge {
  const agentWeights: Record<string, number> = { ...BASE_AGENT_WEIGHTS };

  const scale = (row: EdgeRow, base: number) => {
    if (row.trades < MIN_SAMPLE) return base;
    const wr = winRate(row);
    // 0.5 win rate → unchanged, 0.75 → +50%, 0.25 → −50%, clamped.
    const factor = Math.max(0.2, Math.min(2, 1 + (wr - 0.5) * 2));
    return Number((base * factor).toFixed(3));
  };

  for (const row of report.agents) {
    agentWeights[row.name] = scale(row, BASE_AGENT_WEIGHTS[row.name] ?? 1);
  }

  const suppressedSymbols = report.symbols
    .filter((s) => s.trades >= 4 && s.pnl < 0 && winRate(s) < 0.4)
    .map((s) => s.name);

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

  return {
    agentWeights,
    suppressedSymbols,
    minConfidence,
    sample: report.totals.trades,
  };
}
