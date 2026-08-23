// Statistical validity helpers for the edge layer.
//
// A win rate or expectancy without an interval is a story, not evidence.
// Every bucket metric surfaced to the UI or fed into weights goes through here.

export interface Interval {
  low: number;
  high: number;
}

/**
 * Wilson score interval for a binomial proportion — correct at small n where
 * the normal approximation collapses.
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): Interval {
  if (!(n > 0)) return { low: 0, high: 1 };
  const p = Math.min(Math.max(successes / n, 0), 1);
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    low: Math.max(0, (centre - margin) / denom),
    high: Math.min(1, (centre + margin) / denom),
  };
}

export interface SampleStats {
  n: number;
  mean: number;
  /** Sample standard deviation (n−1 denominator). */
  sd: number;
  /** Standard error of the mean. */
  stderr: number;
  /** mean / stderr — |t| >= 2 is the usual "probably real" bar. */
  tStat: number;
  /** 95% confidence interval for the mean. */
  ci95: Interval;
  /** True when the whole CI sits on one side of zero. */
  significant: boolean;
}

/** Welford-accumulated mean/variance — numerically stable over long runs. */
export function sampleStats(values: number[]): SampleStats {
  const clean = values.filter((v) => Number.isFinite(v));
  const n = clean.length;
  if (n === 0)
    return { n: 0, mean: 0, sd: 0, stderr: 0, tStat: 0, ci95: { low: 0, high: 0 }, significant: false };

  let mean = 0;
  let m2 = 0;
  let k = 0;
  for (const v of clean) {
    k += 1;
    const delta = v - mean;
    mean += delta / k;
    m2 += delta * (v - mean);
  }
  const sd = n > 1 ? Math.sqrt(m2 / (n - 1)) : 0;
  const stderr = n > 0 ? sd / Math.sqrt(n) : 0;
  const tStat = stderr > 0 ? mean / stderr : 0;
  const half = 1.96 * stderr;
  const ci95 = { low: mean - half, high: mean + half };
  return {
    n,
    mean,
    sd,
    stderr,
    tStat,
    ci95,
    significant: n > 1 && (ci95.low > 0 || ci95.high < 0),
  };
}

/**
 * Trade-level expectancy in bps with its interval. `netBps` is per-trade net
 * return on notional, so this is directly comparable across symbols.
 */
export function expectancyStats(netBpsSamples: number[]): SampleStats {
  return sampleStats(netBpsSamples);
}

/** Win-rate with a Wilson interval and a "beats coin-flip" verdict. */
export function winRateStats(wins: number, n: number) {
  const ci = wilsonInterval(wins, n);
  return {
    n,
    wins,
    rate: n > 0 ? wins / n : 0,
    ci95: ci,
    /** Lower bound above 50% — the only case where a win-rate edge is proven. */
    provenEdge: n > 0 && ci.low > 0.5,
  };
}

/**
 * Should a bucket be allowed to move agent weights?
 * Requires both a minimum sample and an expectancy CI clear of zero.
 */
export function bucketIsActionable(
  netBpsSamples: number[],
  minSample: number,
): { actionable: boolean; stats: SampleStats } {
  const stats = expectancyStats(netBpsSamples);
  return { actionable: stats.n >= minSample && stats.ci95.low > 0, stats };
}
