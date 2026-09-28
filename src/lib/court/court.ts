// Signal Court: trade-level judgement of whether a strategy or signal source
// has an edge.
//
// A hypothesis ("epoch v1r trades pay", "SigmaLui trades pay") is presumed to
// have NO edge until it answers every charge:
//
//   1. evidence     enough closed trades to judge at all
//   2. profitable   net expectancy > 0 AFTER fees and funding, with the
//                   episode-clustered 95% lower bound above zero
//   3. direction    beats a sign-flip placebo: the same trades, with direction
//                   randomised per market episode, costs unchanged. If direction
//                   doesn't matter, the signal has no skill; it just paid or
//                   lost with the market.
//   4. deflation    still significant after counting every hypothesis on the
//                   docket (deflated Sharpe, in t units)
//   5. holdout      the chronologically last 40% passes the placebo test again
//   6. stability    net positive in at least 4 of 5 chronological folds
//   7. breadth      survives dropping the best 5% of trades
//   8. gate         profit factor >= 1.30 (the standing live-execution gate)
//
// A hypothesis that fails any charge is NOT PROVEN, never "no edge". The report
// states the smallest effect the sample could have detected, so an underpowered
// acquittal can't be mistaken for a clean one.
//
// Trades are clustered into market episodes (entries in the same time block)
// for every resampling step. Ten positions opened into the same move are one
// bet on that move, not ten independent bets.
//
// Pure: no I/O, deterministic for a given seed.

export interface CourtTrade {
  id: string;
  symbol: string;
  side: string;
  epoch: string;
  /** Agents that contributed to the proposal (keys of paper_trades.agents). */
  sources: string[];
  openedAt: number;
  closedAt: number;
  notional: number;
  grossUsd: number;
  netUsd: number;
  /** Net USD of the SAME trade taken in the opposite direction with mirrored
   *  brackets, when a candle replay can compute it exactly. When present, the
   *  direction placebo uses it instead of the -gross approximation. */
  flippedNetUsd?: number;
}

export interface Hypothesis {
  id: string;
  claim: string;
  select: (t: CourtTrade) => boolean;
}

export interface CourtRules {
  minTrades: number;
  episodeHours: number;
  discoveryFrac: number;
  alphaDiscovery: number;
  alphaHoldout: number;
  minDsr: number;
  folds: number;
  minPositiveFolds: number;
  trimTopFrac: number;
  minProfitFactor: number;
  draws: number;
  /** Dispersion of trial t-stats used for the luck bar. "null" assumes pure-noise
   *  dispersion (variance 1), which is right when the docket holds DIFFERENT
   *  strategies: their real differences are not luck. "observed" uses the
   *  docket's own spread, which is right for a parameter sweep of ONE idea. */
  trialDispersion: "null" | "observed";
}

export const DEFAULT_RULES: CourtRules = {
  minTrades: 30,
  episodeHours: 6,
  discoveryFrac: 0.6,
  alphaDiscovery: 0.01,
  alphaHoldout: 0.05,
  minDsr: 0.95,
  folds: 5,
  minPositiveFolds: 4,
  trimTopFrac: 0.05,
  minProfitFactor: 1.3,
  draws: 4000,
  trialDispersion: "null",
};

export interface Verdict {
  id: string;
  claim: string;
  verdict: "CONVICTED" | "NOT PROVEN";
  diagnosis: string;
  failed: string[];
  n: number;
  nEpisodes: number;
  nDiscovery: number;
  nHoldout: number;
  grossBps: number;
  costBps: number;
  netBps: number;
  netCi95: [number, number];
  /** Smallest net edge (bps) this sample could detect with 80% power. */
  mdeBps: number;
  pPlaceboDiscovery: number;
  pPlaceboHoldout: number;
  netBpsHoldout: number;
  t: number;
  t0: number;
  dsr: number;
  positiveFolds: number;
  trimmedBps: number;
  profitFactor: number;
  winRate: number;
}

// ── deterministic RNG ────────────────────────────────────────────────────
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── small stats helpers ──────────────────────────────────────────────────
const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
function sd(x: number[]): number {
  if (x.length < 2) return 0;
  const m = mean(x);
  return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1));
}
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function skew(x: number[]): number {
  const m = mean(x);
  const s = sd(x);
  if (!(s > 0)) return 0;
  return x.reduce((a, b) => a + ((b - m) / s) ** 3, 0) / x.length;
}
function kurt(x: number[]): number {
  const m = mean(x);
  const s = sd(x);
  if (!(s > 0)) return 3;
  return x.reduce((a, b) => a + ((b - m) / s) ** 4, 0) / x.length;
}
/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf). */
export function normCdf(z: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
/** Inverse standard normal CDF (Acklam's rational approximation). */
export function normInv(p: number): number {
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > 1 - pl) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

// ── trade → per-trade bps, grouped into episodes ─────────────────────────
interface Row {
  net: number;
  gross: number;
  flippedNet?: number;
  episode: number;
  closedAt: number;
}

function toRows(trades: CourtTrade[], rules: CourtRules): Row[] {
  const block = rules.episodeHours * 3600_000;
  return trades
    .filter((t) => t.notional > 0 && Number.isFinite(t.netUsd) && Number.isFinite(t.grossUsd))
    .map((t) => ({
      net: (t.netUsd / t.notional) * 1e4,
      gross: (t.grossUsd / t.notional) * 1e4,
      flippedNet:
        t.flippedNetUsd !== undefined && Number.isFinite(t.flippedNetUsd)
          ? (t.flippedNetUsd / t.notional) * 1e4
          : undefined,
      episode: Math.floor(t.openedAt / block),
      closedAt: t.closedAt,
    }))
    .sort((a, b) => a.closedAt - b.closedAt);
}

function groupEpisodes(rows: Row[]): Row[][] {
  const m = new Map<number, Row[]>();
  for (const r of rows) {
    const g = m.get(r.episode);
    if (g) g.push(r);
    else m.set(r.episode, [r]);
  }
  return [...m.values()];
}

/** Episode-clustered bootstrap of the trade-weighted mean net bps. */
/** Per-episode totals: resampling cost scales with episodes, not trades. */
interface EpisodeAgg {
  n: number;
  net: number;
  flipped: number;
}
function aggregate(
  rows: Array<{ net: number; episode: number; gross?: number; flippedNet?: number }>,
): EpisodeAgg[] {
  const m = new Map<number, EpisodeAgg>();
  for (const r of rows) {
    let g = m.get(r.episode);
    if (!g) m.set(r.episode, (g = { n: 0, net: 0, flipped: 0 }));
    g.n += 1;
    g.net += r.net;
    // exact mirrored outcome when a replay provides it; otherwise the
    // approximation: direction reversed, costs unchanged
    const gross = r.gross ?? r.net;
    g.flipped += r.flippedNet !== undefined ? r.flippedNet : -gross - (gross - r.net);
  }
  return [...m.values()];
}

export function clusteredBootstrap(
  rows: { net: number; episode: number }[],
  draws: number,
  rng: () => number,
): number[] {
  const eps = aggregate(rows);
  const k = eps.length;
  const out: number[] = [];
  if (!k) return out;
  for (let d = 0; d < draws; d++) {
    let s = 0;
    let n = 0;
    for (let i = 0; i < k; i++) {
      const g = eps[Math.floor(rng() * k)];
      s += g.net;
      n += g.n;
    }
    out.push(s / n);
  }
  return out.sort((a, b) => a - b);
}

export function signFlipP(rows: Row[], draws: number, rng: () => number): number {
  if (!rows.length) return 1;
  const eps = aggregate(rows);
  const n = rows.length;
  const obs = mean(rows.map((r) => r.net));
  let ge = 0;
  for (let d = 0; d < draws; d++) {
    let s = 0;
    for (const g of eps) s += rng() < 0.5 ? g.flipped : g.net;
    if (s / n >= obs - 1e-12) ge++;
  }
  return (1 + ge) / (1 + draws);
}

/** Deflated Sharpe in t units (Bailey & López de Prado 2014). */
export function deflatedT(
  t: number,
  sr: number,
  x: number[],
  nTrials: number,
  varTrialT: number,
): { t0: number; dsr: number } {
  const EULER = 0.5772156649;
  const t0 =
    nTrials <= 1
      ? 0
      : Math.sqrt(Math.max(varTrialT, 1)) *
        ((1 - EULER) * normInv(1 - 1 / nTrials) + EULER * normInv(1 - 1 / (nTrials * Math.E)));
  const denom = Math.sqrt(Math.max(1 - skew(x) * sr + ((kurt(x) - 1) / 4) * sr * sr, 1e-12));
  return { t0, dsr: normCdf((t - t0) / denom) };
}

/** Clustered t-stat of mean net (uses the episode bootstrap's spread). */
function clusteredT(
  rows: Row[],
  draws: number,
  rng: () => number,
): { t: number; se: number; ci: [number, number] } {
  const boots = clusteredBootstrap(rows, draws, rng);
  const m = mean(rows.map((r) => r.net));
  const se = sd(boots);
  return { t: se > 0 ? m / se : 0, se, ci: [quantile(boots, 0.025), quantile(boots, 0.975)] };
}

// ── the court ────────────────────────────────────────────────────────────
export function judgeAll(
  trades: CourtTrade[],
  docket: Hypothesis[],
  rules: CourtRules = DEFAULT_RULES,
  seed = 7,
): Verdict[] {
  const rowsBy = docket.map((h) => toRows(trades.filter(h.select), rules));

  // First pass: every trial's discovery t, for the deflation dispersion.
  const trialT = rowsBy.map((rows, i) => {
    const disc = rows.slice(0, Math.floor(rows.length * rules.discoveryFrac));
    return disc.length >= 3 ? clusteredT(disc, 1000, mulberry32(seed + i)).t : 0;
  });
  const mt = mean(trialT);
  const observed =
    trialT.length > 1 ? trialT.reduce((a, b) => a + (b - mt) ** 2, 0) / (trialT.length - 1) : 1;
  const varT = rules.trialDispersion === "observed" ? observed : 1;

  return docket.map((h, i) =>
    judgeOne(h, rowsBy[i], rules, docket.length, varT, seed + 1000 * (i + 1)),
  );
}

function judgeOne(
  h: Hypothesis,
  rows: Row[],
  rules: CourtRules,
  nTrials: number,
  varT: number,
  seed: number,
): Verdict {
  const rng = mulberry32(seed);
  const n = rows.length;
  const nets = rows.map((r) => r.net);
  const cut = Math.floor(n * rules.discoveryFrac);
  const disc = rows.slice(0, cut);
  const hold = rows.slice(cut);

  const all =
    n >= 3
      ? clusteredT(rows, rules.draws, rng)
      : { t: 0, se: 0, ci: [NaN, NaN] as [number, number] };
  const d =
    disc.length >= 3
      ? clusteredT(disc, rules.draws, rng)
      : { t: 0, se: 0, ci: [NaN, NaN] as [number, number] };
  const discNets = disc.map((r) => r.net);
  const sr = sd(discNets) > 0 ? mean(discNets) / sd(discNets) : 0;
  const { t0, dsr } =
    disc.length >= 3 ? deflatedT(d.t, sr, discNets, nTrials, varT) : { t0: 0, dsr: 0 };

  const pDisc = signFlipP(disc, rules.draws, rng);
  const pHold = signFlipP(hold, rules.draws, rng);

  let positiveFolds = 0;
  for (let f = 0; f < rules.folds; f++) {
    const seg = rows.slice(
      Math.floor((f * n) / rules.folds),
      Math.floor(((f + 1) * n) / rules.folds),
    );
    if (seg.length && mean(seg.map((r) => r.net)) > 0) positiveFolds++;
  }

  const sorted = [...nets].sort((a, b) => a - b);
  const k = Math.ceil(rules.trimTopFrac * n);
  const trimmed = n > k ? mean(sorted.slice(0, n - k)) : NaN;

  const wins = nets.filter((x) => x > 0);
  const losses = nets.filter((x) => x < 0);
  const lossSum = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor =
    lossSum > 0 ? wins.reduce((a, b) => a + b, 0) / lossSum : wins.length ? Infinity : 0;

  const grossBps = mean(rows.map((r) => r.gross));
  const netBps = mean(nets);
  const mdeBps = (normInv(0.975) + normInv(0.8)) * all.se;

  const failed: string[] = [];
  if (n < rules.minTrades) failed.push(`evidence: ${n} trades < ${rules.minTrades}`);
  if (!(all.ci[0] > 0))
    failed.push(`profitable: net 95% lower bound ${all.ci[0]?.toFixed(1)} bps ≤ 0`);
  if (pDisc > rules.alphaDiscovery)
    failed.push(
      `direction: sign-flip placebo p=${pDisc.toFixed(3)} > ${rules.alphaDiscovery} (discovery)`,
    );
  if (dsr < rules.minDsr)
    failed.push(`deflation: DSR ${dsr.toFixed(2)} < ${rules.minDsr} after ${nTrials} hypotheses`);
  if (!(hold.length && mean(hold.map((r) => r.net)) > 0) || pHold > rules.alphaHoldout)
    failed.push(
      `holdout: net ${mean(hold.map((r) => r.net)).toFixed(1)} bps, placebo p=${pHold.toFixed(3)}`,
    );
  if (positiveFolds < rules.minPositiveFolds)
    failed.push(`stability: net positive in ${positiveFolds}/${rules.folds} folds`);
  if (!(trimmed > 0))
    failed.push(
      `breadth: ${trimmed.toFixed(1)} bps after dropping best ${rules.trimTopFrac * 100}%`,
    );
  if (!(profitFactor >= rules.minProfitFactor))
    failed.push(`gate: profit factor ${profitFactor.toFixed(2)} < ${rules.minProfitFactor}`);

  let diagnosis: string;
  if (!failed.length) diagnosis = "edge proven after costs";
  else if (n < rules.minTrades) diagnosis = "too few trades to judge";
  else if (grossBps > 0 && netBps <= 0)
    diagnosis = `gross edge ${grossBps.toFixed(1)} bps eaten by ${(grossBps - netBps).toFixed(1)} bps of costs`;
  else if (grossBps <= 0) diagnosis = "no gross edge: loses before costs";
  else if (pDisc > 0.1)
    diagnosis = "direction no better than a coin flip per episode; returns came with the market";
  else if (pDisc <= rules.alphaDiscovery && pHold > rules.alphaHoldout)
    diagnosis = "looked real in discovery, faded in holdout";
  else if (dsr < rules.minDsr && pDisc <= 0.05)
    diagnosis = "significant alone, not after counting hypotheses";
  else diagnosis = `positive but unproven; sample can only detect edges ≥ ${mdeBps.toFixed(1)} bps`;

  return {
    id: h.id,
    claim: h.claim,
    verdict: failed.length ? "NOT PROVEN" : "CONVICTED",
    diagnosis,
    failed,
    n,
    nEpisodes: groupEpisodes(rows).length,
    nDiscovery: disc.length,
    nHoldout: hold.length,
    grossBps,
    costBps: grossBps - netBps,
    netBps,
    netCi95: all.ci,
    mdeBps,
    pPlaceboDiscovery: pDisc,
    pPlaceboHoldout: pHold,
    netBpsHoldout: mean(hold.map((r) => r.net)),
    t: d.t,
    t0,
    dsr,
    positiveFolds,
    trimmedBps: trimmed,
    profitFactor,
    winRate: n ? wins.length / n : NaN,
  };
}

/** Epoch tag for counterfactual shadow-book trades (see loadShadowTrades). */
export const SHADOW_EPOCH = "shadow";

/** Fixed confidence buckets for shadow trades, on the post-v2 0.5–1.0 scale.
 *  Declared up front; never derived from outcomes. */
export const CONF_BUCKETS: Array<{ id: string; lo: number; hi: number }> = [
  { id: "<0.60", lo: -Infinity, hi: 0.6 },
  { id: "0.60-0.70", lo: 0.6, hi: 0.7 },
  { id: "0.70-0.80", lo: 0.7, hi: 0.8 },
  { id: ">=0.80", lo: 0.8, hi: Infinity },
];
export const confBucket = (c: number) =>
  CONF_BUCKETS.find((b) => c >= b.lo && c < b.hi)?.id ?? "unknown";

const SHADOW_REASON_CLAIM: Record<string, string> = {
  confidence: "below the confidence gate",
  suppressed: "on a suppressed symbol",
  blocked: "blocked by the broker (risk halt, no free slot, thin book)",
  observer: "made in observer mode",
};

/**
 * The docket: declared from which epochs, sources, shadow reasons and fixed
 * confidence buckets exist, never from outcomes. Paper trades and shadow
 * trades share one docket, so the deflation counts every hypothesis tested.
 */
export function buildDocket(trades: CourtTrade[]): Hypothesis[] {
  const paper = trades.filter((t) => t.epoch !== SHADOW_EPOCH);
  const shadow = trades.filter((t) => t.epoch === SHADOW_EPOCH);
  const isPaper = (t: CourtTrade) => t.epoch !== SHADOW_EPOCH;
  const docket: Hypothesis[] = [];

  if (paper.length) {
    for (const e of [...new Set(paper.map((t) => t.epoch))].sort()) {
      docket.push({
        id: `epoch:${e}`,
        claim: `Trades under strategy epoch ${e} have a net edge`,
        select: (t) => t.epoch === e,
      });
    }
    if (paper.some((t) => t.sources.includes("sigmalui"))) {
      docket.push({
        id: "source:sigmalui",
        claim: "SigmaLui-sourced trades have a net edge",
        select: (t) => isPaper(t) && t.sources.includes("sigmalui"),
      });
      docket.push({
        id: "source:internal",
        claim: "Internal-swarm trades (no SigmaLui vote) have a net edge",
        select: (t) => isPaper(t) && !t.sources.includes("sigmalui"),
      });
    }
    docket.push({
      id: "all",
      claim: "All closed trades together have a net edge",
      select: isPaper,
    });
  }

  if (shadow.length) {
    docket.push({
      id: "shadow:all",
      claim: "Every swarm proposal the broker did not trade, traded virtually, has a net edge",
      select: (t) => t.epoch === SHADOW_EPOCH,
    });
    const reasons = [
      ...new Set(shadow.flatMap((t) => t.sources.filter((x) => x.startsWith("reason:")))),
    ].sort();
    for (const r of reasons) {
      const name = r.slice("reason:".length);
      docket.push({
        id: `shadow:${r}`,
        claim: `Untraded proposals ${SHADOW_REASON_CLAIM[name] ?? `with reason "${name}"`} have a net edge`,
        select: (t) => t.epoch === SHADOW_EPOCH && t.sources.includes(r),
      });
    }
    for (const b of CONF_BUCKETS) {
      if (!shadow.some((t) => t.sources.includes(`conf:${b.id}`))) continue;
      docket.push({
        id: `shadow:conf:${b.id}`,
        claim: `Untraded proposals with swarm confidence ${b.id} have a net edge`,
        select: (t) => t.epoch === SHADOW_EPOCH && t.sources.includes(`conf:${b.id}`),
      });
    }
  }
  return docket;
}
