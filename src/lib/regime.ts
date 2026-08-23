// Per-symbol market-regime detection.
//
// The swarm used to vote with fixed agent weights, which meant the Trend agent
// kept voting in a chopping market and MeanRev kept fading a clean impulse. The
// detector below classifies the *style* of the market from the same price ring
// the agents see, and the combiner then gates or down-weights each agent for
// that symbol. Style is orthogonal to the existing volatility bucket
// (`edge-model.regimeOf`) — both are recorded, so the edge model can learn
// "MeanRev in trend/vol:violent" separately from "MeanRev in range/vol:calm".

export type RegimeStyle = "trend" | "meanRevert" | "breakout" | "chop";

export interface RegimeRead {
  style: RegimeStyle;
  /** 0..1 — how cleanly the series matches the style. */
  strength: number;
  /** Kaufman efficiency ratio: |net move| / total path travelled. */
  efficiency: number;
  /** Lag-1 autocorrelation of returns. Negative ⇒ mean-reverting. */
  autocorr: number;
  /** Current range vs the prior range. > 1 ⇒ expansion. */
  rangeExpansion: number;
  /** Distance of the last price from the recent range edge, in bps. */
  breakoutBps: number;
  /** Realized volatility of the window, in bps of last price. */
  volBps: number;
  /** Samples the read was computed from. */
  samples: number;
}

export const UNKNOWN_REGIME: RegimeRead = {
  style: "chop",
  strength: 0,
  efficiency: 0,
  autocorr: 0,
  rangeExpansion: 1,
  breakoutBps: 0,
  volBps: 0,
  samples: 0,
};

/** Minimum prices needed before a read means anything. */
export const MIN_REGIME_SAMPLES = 24;

function stddev(v: number[]): number {
  if (v.length < 2) return 0;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length);
}

/**
 * Classify the recent price path.
 *
 * - efficiency high + returns positively autocorrelated ⇒ trend
 * - price outside the prior range with the range expanding ⇒ breakout
 * - returns negatively autocorrelated inside a stable range ⇒ mean-revert
 * - everything else is chop, where the correct action is usually none
 */
export function detectRegime(prices: number[]): RegimeRead {
  const n = prices.length;
  if (n < MIN_REGIME_SAMPLES) return { ...UNKNOWN_REGIME, samples: n };

  const w = prices.slice(-Math.min(n, 60));
  const last = w[w.length - 1];
  if (!(last > 0)) return { ...UNKNOWN_REGIME, samples: n };

  // Efficiency ratio — 1 is a straight line, ~0 is a random walk.
  let path = 0;
  const rets: number[] = [];
  for (let i = 1; i < w.length; i++) {
    path += Math.abs(w[i] - w[i - 1]);
    if (w[i - 1] > 0) rets.push((w[i] - w[i - 1]) / w[i - 1]);
  }
  const net = w[w.length - 1] - w[0];
  const efficiency = path > 0 ? Math.abs(net) / path : 0;

  // Lag-1 autocorrelation of returns.
  let autocorr = 0;
  if (rets.length >= 8) {
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < rets.length; i++) {
      const d = rets[i] - m;
      den += d * d;
      if (i > 0) num += d * (rets[i - 1] - m);
    }
    autocorr = den > 0 ? num / den : 0;
  }

  // Range expansion: newest third of the window vs the two before it.
  const third = Math.max(4, Math.floor(w.length / 3));
  const recent = w.slice(-third);
  const prior = w.slice(0, w.length - third);
  const span = (a: number[]) => (a.length ? Math.max(...a) - Math.min(...a) : 0);
  const priorSpan = span(prior);
  const rangeExpansion = priorSpan > 0 ? span(recent) / priorSpan : 1;

  // How far outside the prior range we are, in bps.
  const priorHi = prior.length ? Math.max(...prior) : last;
  const priorLo = prior.length ? Math.min(...prior) : last;
  const outside = last > priorHi ? last - priorHi : last < priorLo ? priorLo - last : 0;
  const breakoutBps = (outside / last) * 10_000;

  const volBps = (stddev(w) / last) * 10_000;

  // ── classification ──────────────────────────────────────────────────────
  // Scores are deliberately simple and monotone so the read is explainable in
  // the UI; the largest score wins and doubles as the strength.
  const trendScore = clamp01((efficiency - 0.3) / 0.4) * clamp01(0.5 + autocorr * 4);
  const breakoutScore =
    clamp01(breakoutBps / Math.max(volBps, 1)) * clamp01((rangeExpansion - 0.9) / 0.6);
  const revertScore =
    clamp01(-autocorr / 0.35) * clamp01((0.35 - efficiency) / 0.3) * clamp01(volBps / 8);

  const ranked: Array<[RegimeStyle, number]> = [
    ["trend", trendScore],
    ["breakout", breakoutScore],
    ["meanRevert", revertScore],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  const [style, strength] = ranked[0];

  return {
    style: strength >= 0.25 ? style : "chop",
    strength: Number(strength.toFixed(4)),
    efficiency: Number(efficiency.toFixed(4)),
    autocorr: Number(autocorr.toFixed(4)),
    rangeExpansion: Number(rangeExpansion.toFixed(3)),
    breakoutBps: Number(breakoutBps.toFixed(2)),
    volBps: Number(volBps.toFixed(2)),
    samples: n,
  };
}

function clamp01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

/**
 * Agent multipliers per regime. 0 gates the agent out entirely; values below 1
 * keep it in the vote but demoted. These are priors, not learned weights — the
 * edge model still scales `AGENT_WEIGHTS` on top of this.
 */
export const REGIME_AGENT_GATES: Record<RegimeStyle, Record<string, number>> = {
  // A clean impulse: follow it, never fade it.
  trend: { Trend: 1.3, MeanRev: 0, Breakout: 1.0, Meme: 1.0 },
  // Range with negative autocorrelation: fading works, following does not.
  meanRevert: { Trend: 0.2, MeanRev: 1.3, Breakout: 0.3, Meme: 0.6 },
  // Range expansion through an edge: breakout and momentum lead.
  breakout: { Trend: 1.0, MeanRev: 0, Breakout: 1.4, Meme: 1.2 },
  // No structure: only the volume-shock agent is allowed a (small) voice.
  chop: { Trend: 0.3, MeanRev: 0.4, Breakout: 0.3, Meme: 0.5 },
};

/** Multiplier for one agent under a regime read, blended by read strength. */
export function agentGate(style: RegimeStyle, agent: string, strength: number): number {
  const target = REGIME_AGENT_GATES[style]?.[agent];
  if (target === undefined) return 1;
  // A weak read should not fully re-weight the panel: blend toward 1.
  const blend = clamp01(0.35 + strength);
  return 1 + (target - 1) * blend;
}

const STYLE_LABELS: Record<RegimeStyle, string> = {
  trend: "Trending",
  meanRevert: "Mean-reverting",
  breakout: "Breaking out",
  chop: "Choppy",
};

export function regimeLabel(style: RegimeStyle): string {
  return STYLE_LABELS[style] ?? style;
}
