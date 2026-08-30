#!/usr/bin/env node
// Entry-threshold / suppression optimizer, with honest out-of-sample accounting.
//
//   node scripts/optimize-threshold.mjs
//   node scripts/optimize-threshold.mjs --folds 5 --min-bucket 12
//   node scripts/optimize-threshold.mjs --epochs v1,v3 --json report.json
//
// Reads closed paper trades straight from Neon (DATABASE_URL) — Neon is the
// canonical store, so there is no JSON export step to go stale. Never prints
// the connection string or any other credential.
//
// ── Why this is not a plain grid search ───────────────────────────────────
//
// Grid-searching `minConf` and reporting the best score produces a
// good-looking number even on pure noise: 35 grid points is 35 draws, and you
// keep the maximum. Two things here prevent that:
//
//  1. SELECTION HAPPENS ON TRAIN ONLY. Each fold picks its rule from data
//     strictly before its test window, then scores it on the untouched window.
//     A rule is never chosen using the data it is graded on. (Selecting on the
//     test set is the most common bug in scripts like this, and it silently
//     inverts the meaning of the output.)
//
//  2. THE WHOLE PIPELINE IS PERMUTATION-TESTED. The same select-then-score
//     procedure is re-run with PnL shuffled across trades, destroying any real
//     relationship while preserving sample sizes and the search space. If the
//     real improvement is not clearly outside that noise distribution, the
//     script says so rather than recommending a change.
//
// A tool that always returns a recommendation is a noise generator. This one
// can — and on small samples usually should — return "insufficient evidence".
import { neon } from "@neondatabase/serverless";
import dns from "node:dns";
import net from "node:net";

// Neon's endpoints publish AAAA records, but plenty of hosts (WSL among them)
// have no IPv6 route, and the driver's connector then dies on ENETUNREACH
// instead of falling back. Ordering v4 first is not enough on its own — happy
// eyeballs still races the v6 addresses — so autoselect is disabled too, which
// makes connect() use exactly the first (now v4) address.
// Set OPTIMIZE_FORCE_IPV4=0 on a v6-only host.
if (process.env.OPTIMIZE_FORCE_IPV4 !== "0") {
  dns.setDefaultResultOrder("ipv4first");
  net.setDefaultAutoSelectFamily(false);
}

// ── args ───────────────────────────────────────────────────────────────────

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const FOLDS = Number(arg("folds", 4));
const STEP = Number(arg("step", 0.01));
const MIN_CONF = Number(arg("min-conf", 0.6));
const MAX_CONF = Number(arg("max-conf", 0.95));
const BASELINE_CONF = Number(arg("baseline", 0.62));
/** Trades a regime/hour bucket needs before it may be suppressed. */
const MIN_BUCKET = Number(arg("min-bucket", 10));
/** Out-of-sample trades per fold needed before a verdict is trusted. */
const MIN_TEST = Number(arg("min-test", 8));
const PERMUTATIONS = Number(arg("permutations", 400));
const EPOCHS = arg("epochs", "v1,v3")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const JSON_OUT = arg("json", "");
const USER_ID = arg("user", "");

// Same cleaning as src/lib/db/neon.ts getDatabaseUrl(): .env files written on
// Windows carry a trailing CR, and the value is sometimes quoted or prefixed.
function cleanDatabaseUrl(raw) {
  if (!raw) return "";
  let v = raw.trim().replace(/[​-‍﻿\r\n]/g, "");
  if (v.startsWith("DATABASE_URL=")) v = v.slice("DATABASE_URL=".length).trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'")) ||
    (v.startsWith("`") && v.endsWith("`"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

const url = cleanDatabaseUrl(process.env.DATABASE_URL);
if (!url) {
  console.error("optimize-threshold: DATABASE_URL is not set (Neon is the canonical store).");
  process.exit(1);
}

// ── data ───────────────────────────────────────────────────────────────────

const sql = neon(url);

// Real column names: paper_trades / hour_utc / agents(jsonb). There is no
// `closed_trades` table and no scalar `agent` column in this schema.
const rows = await sql`
  SELECT user_id, confidence, pnl, gross_pnl, fees, funding, regime, hour_utc,
         symbol, reason, conf_bucket, strategy_epoch, closed_at
    FROM paper_trades
   WHERE status = 'closed'
     AND pnl IS NOT NULL
     AND closed_at IS NOT NULL
     AND strategy_epoch = ANY(${EPOCHS}::text[])
   ORDER BY closed_at ASC`;

const trades = rows
  .filter((r) => !USER_ID || String(r.user_id) === USER_ID)
  .map((r) => ({
    confidence: Number(r.confidence),
    pnl: Number(r.pnl),
    regime: r.regime ?? "unknown",
    hour: Number(r.hour_utc),
    symbol: r.symbol,
    reason: r.reason,
    epoch: r.strategy_epoch,
    closedAt: new Date(r.closed_at).getTime(),
  }));

if (trades.length === 0) {
  console.error(`optimize-threshold: no closed trades for epochs ${EPOCHS.join(",")}.`);
  process.exit(1);
}

// ── metrics ────────────────────────────────────────────────────────────────

function evaluate(set) {
  if (!set.length) return { count: 0, pnl: 0, winRate: 0, expectancy: 0 };
  let pnl = 0;
  let wins = 0;
  for (const t of set) {
    pnl += t.pnl;
    if (t.pnl > 0) wins += 1;
  }
  return { count: set.length, pnl, winRate: wins / set.length, expectancy: pnl / set.length };
}

/** Sample standard deviation of per-trade PnL. */
function stdev(set) {
  if (set.length < 2) return 0;
  const m = set.reduce((a, t) => a + t.pnl, 0) / set.length;
  return Math.sqrt(set.reduce((a, t) => a + (t.pnl - m) ** 2, 0) / (set.length - 1));
}

const passes = (t, rule) =>
  t.confidence >= rule.minConf &&
  !rule.suppressRegimes.includes(t.regime) &&
  !rule.suppressHours.includes(t.hour);

// ── selection (TRAIN ONLY) ─────────────────────────────────────────────────

/**
 * Choose a rule using nothing but `train`.
 *
 * Suppression candidates must clear MIN_BUCKET trades: a regime seen 3 times
 * at -$5 is noise, and suppressing it is how a backtest quietly memorises its
 * own sample. The threshold is grid-searched on top of the surviving set.
 */
function selectRule(train) {
  const bucketsOf = (key) => {
    const m = new Map();
    for (const t of train) {
      if (!m.has(t[key])) m.set(t[key], []);
      m.get(t[key]).push(t);
    }
    return m;
  };
  const losing = (key) =>
    [...bucketsOf(key)]
      .filter(([, set]) => set.length >= MIN_BUCKET && evaluate(set).expectancy < 0)
      .map(([k]) => k);

  const suppressRegimes = losing("regime");
  const suppressHours = losing("hour");

  let best = null;
  const steps = Math.round((MAX_CONF - MIN_CONF) / STEP);
  for (let i = 0; i <= steps; i++) {
    const minConf = Number((MIN_CONF + i * STEP).toFixed(4));
    for (const withSuppression of [false, true]) {
      const rule = {
        minConf,
        suppressRegimes: withSuppression ? suppressRegimes : [],
        suppressHours: withSuppression ? suppressHours : [],
      };
      const kept = train.filter((t) => passes(t, rule));
      // A rule that keeps almost nothing scores well by accident.
      if (kept.length < Math.max(MIN_BUCKET, train.length * 0.1)) continue;
      const score = evaluate(kept).expectancy;
      if (!best || score > best.score) best = { rule, score };
    }
  }
  // Fall back to the live default rather than inventing one.
  return best?.rule ?? { minConf: BASELINE_CONF, suppressRegimes: [], suppressHours: [] };
}

// ── walk-forward ───────────────────────────────────────────────────────────

/**
 * Expanding-window walk-forward. Fold k trains on everything before its test
 * window and is scored only on that window, so every scored trade was out of
 * sample at the moment its rule was chosen.
 */
function walkForward(data) {
  const n = data.length;
  const start = Math.floor(n * 0.5);
  const width = Math.max(1, Math.floor((n - start) / FOLDS));
  const folds = [];
  let optIn = [];
  let baseIn = [];

  for (let f = 0; f < FOLDS; f++) {
    const a = start + f * width;
    const b = f === FOLDS - 1 ? n : a + width;
    if (a >= n) break;
    const train = data.slice(0, a);
    const test = data.slice(a, b);
    if (train.length < MIN_BUCKET * 2 || test.length < 1) continue;

    const rule = selectRule(train);
    const keptOpt = test.filter((t) => passes(t, rule));
    const keptBase = test.filter((t) => t.confidence >= BASELINE_CONF);
    optIn = optIn.concat(keptOpt);
    baseIn = baseIn.concat(keptBase);
    folds.push({
      fold: f + 1,
      trainCount: train.length,
      testCount: test.length,
      rule,
      optimized: evaluate(keptOpt),
      baseline: evaluate(keptBase),
    });
  }
  return { folds, optimized: evaluate(optIn), baseline: evaluate(baseIn), optIn, baseIn };
}

// ── permutation test ───────────────────────────────────────────────────────

let seed = 20260829;
function rand() {
  // Deterministic xorshift, so a run is reproducible.
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) % 1e9) / 1e9;
}
function shufflePnl(data) {
  const pnls = data.map((t) => t.pnl);
  for (let i = pnls.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pnls[i], pnls[j]] = [pnls[j], pnls[i]];
  }
  return data.map((t, i) => ({ ...t, pnl: pnls[i] }));
}

/**
 * Re-run the ENTIRE select-then-score pipeline on data whose PnL has been
 * shuffled. Sample sizes, the confidence distribution and the search space are
 * preserved; only the link between a trade's features and its outcome is
 * destroyed. The spread of "improvements" this yields is what the procedure
 * manufactures from nothing.
 */
function permutationNull(data, observedDelta) {
  const deltas = [];
  for (let i = 0; i < PERMUTATIONS; i++) {
    const r = walkForward(shufflePnl(data));
    if (r.optimized.count === 0 || r.baseline.count === 0) continue;
    deltas.push(r.optimized.expectancy - r.baseline.expectancy);
  }
  deltas.sort((a, b) => a - b);
  const atLeast = deltas.filter((d) => d >= observedDelta).length;
  return {
    samples: deltas.length,
    // Add-one correction: never claim p = 0 from a finite number of draws.
    p: deltas.length ? (atLeast + 1) / (deltas.length + 1) : 1,
    median: deltas.length ? deltas[Math.floor(deltas.length * 0.5)] : 0,
    p95: deltas.length ? deltas[Math.floor(deltas.length * 0.95)] : 0,
  };
}

// ── run ────────────────────────────────────────────────────────────────────

const usd = (v) => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

console.log(`\nClosed trades: ${trades.length}  (epochs ${EPOCHS.join(",")})`);
console.log(`Span: ${day(trades[0].closedAt)} → ${day(trades[trades.length - 1].closedAt)}`);
console.log(`All-trade expectancy: ${usd(evaluate(trades).expectancy)}/trade`);

const byEpoch = new Map();
for (const t of trades) {
  if (!byEpoch.has(t.epoch)) byEpoch.set(t.epoch, []);
  byEpoch.get(t.epoch).push(t);
}
for (const [e, set] of byEpoch) {
  const m = evaluate(set);
  console.log(
    `  ${e}: n=${m.count}, ${usd(m.expectancy)}/trade, win ${(m.winRate * 100).toFixed(0)}%`,
  );
}

// Confidence buckets per epoch. The pooled view hides the thing that usually
// matters most: whether the epoch actually running is the one carrying the edge.
const bucketOf = (c) =>
  c < 0.6 ? "0.5-0.6" : c < 0.7 ? "0.6-0.7" : c < 0.8 ? "0.7-0.8" : c < 0.9 ? "0.8-0.9" : "0.9-1.0";

console.log("\n── Confidence buckets by epoch ──");
console.log("  epoch  bucket     n   exp/trade      total   win%");
for (const [e, set] of byEpoch) {
  const buckets = new Map();
  for (const t of set) {
    const b = bucketOf(t.confidence);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(t);
  }
  for (const b of [...buckets.keys()].sort()) {
    const m = evaluate(buckets.get(b));
    console.log(
      `  ${e.padEnd(6)} ${b.padEnd(9)} ${String(m.count).padStart(3)} ` +
        `${usd(m.expectancy).padStart(10)} ${usd(m.pnl).padStart(10)} ` +
        `${(m.winRate * 100).toFixed(0).padStart(4)}%`,
    );
  }
}

const result = walkForward(trades);
if (result.folds.length === 0) {
  console.log("\nNot enough history to form a single out-of-sample fold.");
  process.exit(0);
}

console.log("\n── Walk-forward folds (rule chosen on train, scored on test) ──");
for (const f of result.folds) {
  const s = f.rule.suppressRegimes.length + f.rule.suppressHours.length;
  console.log(
    `  fold ${f.fold}: train ${String(f.trainCount).padStart(3)} → test ${String(f.testCount).padStart(3)}` +
      ` | minConf ${f.rule.minConf.toFixed(2)}${s ? ` +${s} suppressed` : ""}` +
      ` | opt ${String(f.optimized.count).padStart(3)} @ ${usd(f.optimized.expectancy)}` +
      ` | base ${String(f.baseline.count).padStart(3)} @ ${usd(f.baseline.expectancy)}`,
  );
}

const delta = result.optimized.expectancy - result.baseline.expectancy;
console.log("\n── Pooled out-of-sample ──");
console.log(
  `  baseline (minConf ${BASELINE_CONF}): ${result.baseline.count} trades, ` +
    `${usd(result.baseline.expectancy)}/trade, total ${usd(result.baseline.pnl)}`,
);
console.log(
  `  optimized              : ${result.optimized.count} trades, ` +
    `${usd(result.optimized.expectancy)}/trade, total ${usd(result.optimized.pnl)}`,
);
console.log(`  difference             : ${usd(delta)}/trade`);

const sd = stdev(result.optIn);
const se = result.optIn.length ? sd / Math.sqrt(result.optIn.length) : 0;
console.log(
  `  noise floor            : ±${usd(1.96 * se)}/trade ` +
    `(95% CI half-width on ${result.optIn.length} trades, per-trade sd ${usd(sd)})`,
);

console.log("\n── Permutation test (is this signal, or mined noise?) ──");
const nul = permutationNull(trades, delta);
console.log(`  shuffled-PnL runs   : ${nul.samples}`);
console.log(`  median noise gain   : ${usd(nul.median)}/trade`);
console.log(`  95th pct noise gain : ${usd(nul.p95)}/trade`);
console.log(`  p(noise ≥ observed) : ${nul.p.toFixed(3)}`);

// ── verdict ────────────────────────────────────────────────────────────────

const reasons = [];
if (result.optimized.count < MIN_TEST * result.folds.length) {
  reasons.push(
    `only ${result.optimized.count} out-of-sample trades survive the rule ` +
      `(want ≥ ${MIN_TEST * result.folds.length})`,
  );
}
if (delta <= 0) reasons.push("the rule does not beat the current threshold out of sample");
if (nul.p > 0.05) {
  reasons.push(`shuffled data reproduces this gain ${(nul.p * 100).toFixed(0)}% of the time`);
}
if (delta > 0 && delta < 1.96 * se) {
  reasons.push("the gain is inside the noise floor of its own sample");
}

const fullFit = selectRule(trades);
console.log("\n=== VERDICT ===");
if (reasons.length === 0) {
  console.log(`ACT — set minConfidence to ${fullFit.minConf.toFixed(2)}.`);
  if (fullFit.suppressRegimes.length) {
    console.log(`  Suppress regimes: ${fullFit.suppressRegimes.join(", ")}`);
  }
  if (fullFit.suppressHours.length) {
    console.log(`  Suppress hours (UTC): ${fullFit.suppressHours.join(", ")}`);
  }
  console.log(`  Measured out-of-sample gain: ${usd(delta)}/trade.`);
} else {
  console.log("INSUFFICIENT EVIDENCE — do not change parameters on this data.");
  for (const r of reasons) console.log(`  · ${r}`);
  console.log(
    `\n  For reference only, a full-sample fit would say minConf ${fullFit.minConf.toFixed(2)}` +
      `${fullFit.suppressRegimes.length ? `, suppress ${fullFit.suppressRegimes.join("/")}` : ""}` +
      `${fullFit.suppressHours.length ? `, hours ${fullFit.suppressHours.join("/")}` : ""}.`,
  );
  console.log(
    `  That number is in-sample and is NOT evidence. It is printed so you can see\n` +
      `  what this optimizer would have claimed had it skipped validation.`,
  );
}

console.log(
  `\nNote: deriveEdge() already raises minConfidence on its own at 100 closed\n` +
    `trades with >=20 per confidence bucket (src/lib/edge-model.ts). Currently\n` +
    `${trades.length}. This script is a diagnostic for that gate, not a bypass.`,
);

if (JSON_OUT) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    JSON_OUT,
    JSON.stringify(
      {
        trades: trades.length,
        epochs: EPOCHS,
        folds: result.folds,
        pooled: { baseline: result.baseline, optimized: result.optimized, delta },
        noiseFloor: 1.96 * se,
        permutation: nul,
        fullSampleFit: fullFit,
        verdict: reasons.length === 0 ? "act" : "insufficient-evidence",
        reasons,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${JSON_OUT}`);
}
