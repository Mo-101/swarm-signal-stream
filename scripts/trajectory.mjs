#!/usr/bin/env node
// Does a signal's TRAJECTORY predict the trade's outcome?
//
//   DATABASE_URL=... node scripts/trajectory.mjs
//   DATABASE_URL=... node scripts/trajectory.mjs --epoch v3 --window 30
//
// Read-only. Credentials never printed.
//
// ── Why ───────────────────────────────────────────────────────────────────
//
// The entry SNAPSHOT carries no predictive information (discriminate.mjs:
// p = 0.41 pooled). But the engine stores 3M signals and uses only the one at
// emit time, discarding whether the score was rising or falling. So
// `confidence 0.85 rising from 0.52` and `confidence 0.85 falling from 1.00`
// are currently the same trade. This tests whether they behave differently.
//
// ── Design, frozen before looking at any outcome ──────────────────────────
//
// PREDECLARED HYPOTHESES — three, not a search:
//   H1  positive score slope       -> better R
//   H2  same-side persistence      -> better R
//   H3  fewer recent side flips    -> better R
//
// H4 (within-scan rank persistence) is NOT TESTABLE: the signals table stores
// no rank or scan ordering, and nothing recorded can reconstruct it. Reported
// as untestable rather than silently dropped or proxied by something else.
//
// CONTINUOUS FIRST. Spearman rank correlation between each feature and net R,
// so no cutoff is searched. Threshold hunting is what produced the last false
// positive; it is not repeated here.
//
// ONE GLOBAL MAX STATISTIC across all predeclared features, permutation-tested
// by shuffling outcomes — so the reported p answers "how impressive is the
// best of these, given that I looked at all of them".
//
// CHRONOLOGICAL HOLDOUT preserved: the sample is still ~119 realized trades.
// 3M signals give richer covariates, NOT more independent bets.
import { neon } from "@neondatabase/serverless";
import dns from "node:dns";
import net from "node:net";

if (process.env.TRAJ_FORCE_IPV4 !== "0") {
  dns.setDefaultResultOrder("ipv4first");
  net.setDefaultAutoSelectFamily(false);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const EPOCH = arg("epoch", "");
const WINDOW_MIN = Number(arg("window", 30));
const MIN_OBS = Number(arg("min-obs", 5));
const PERMUTATIONS = Number(arg("permutations", 2000));

function cleanDatabaseUrl(raw) {
  if (!raw) return "";
  let v = String(raw)
    .trim()
    .replace(/[​-‍﻿\r\n]/g, "");
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
  console.error("trajectory: DATABASE_URL is not set.");
  process.exit(1);
}
const scrub = (s) => String(s).split(url).join("<DATABASE_URL>");
try {
  const p = new URL(url);
  if (p.protocol !== "postgres:" && p.protocol !== "postgresql:") throw new Error("bad scheme");
} catch (e) {
  console.error(`trajectory: DATABASE_URL unusable (${scrub(e.message)}).`);
  process.exit(1);
}
const sql = neon(url);

// Lookback aggregates, computed server-side. The time predicate leads so the
// (user_id, created_at) index drives the scan and the symbol filter is applied
// to the few thousand rows inside each window — rather than joining on symbol,
// which has no index and would seq-scan 3M rows per trade against a live DB.
//
// Everything here is strictly BEFORE opened_at: no post-decision information.
const rows = await sql`
  SELECT t.client_id, t.symbol, t.side, t.strategy_epoch AS epoch,
         t.latency_ms::float8 AS latency, t.pnl::float8 AS pnl,
         t.notional::float8 AS notional, t.confidence::float8 AS conf,
         t.opened_at, t.closed_at,
         w.n_obs, w.same_side, w.flips,
         w.slope_30, w.slope_15, w.slope_5,
         w.mean_conf, w.last_conf
    FROM paper_trades t
    CROSS JOIN LATERAL (
      SELECT
        count(*)::int AS n_obs,
        count(*) FILTER (WHERE s.side = t.side)::int AS same_side,
        regr_slope(s.confidence, extract(epoch from s.created_at)) AS slope_30,
        regr_slope(s.confidence, extract(epoch from s.created_at))
          FILTER (WHERE s.created_at >= t.opened_at - make_interval(mins => 15)) AS slope_15,
        regr_slope(s.confidence, extract(epoch from s.created_at))
          FILTER (WHERE s.created_at >= t.opened_at - make_interval(mins => 5)) AS slope_5,
        avg(s.confidence)::float8 AS mean_conf,
        (array_agg(s.confidence ORDER BY s.created_at DESC))[1]::float8 AS last_conf,
        (
          SELECT count(*)::int FROM (
            SELECT s2.side, lag(s2.side) OVER (ORDER BY s2.created_at) AS prev
              FROM signals s2
             WHERE s2.user_id = t.user_id
               AND s2.created_at >= t.opened_at - make_interval(mins => ${WINDOW_MIN})
               AND s2.created_at < t.opened_at
               AND s2.symbol = t.symbol
          ) f WHERE f.prev IS NOT NULL AND f.side <> f.prev
        ) AS flips
      FROM signals s
      WHERE s.user_id = t.user_id
        AND s.created_at >= t.opened_at - make_interval(mins => ${WINDOW_MIN})
        AND s.created_at < t.opened_at
        AND s.symbol = t.symbol
    ) w
   WHERE t.status = 'closed' AND t.pnl IS NOT NULL AND t.closed_at IS NOT NULL
   ORDER BY t.closed_at ASC`;

const all = rows
  .filter((r) => !EPOCH || r.epoch === EPOCH)
  .map((r) => ({
    epoch: r.epoch,
    symbol: r.symbol,
    pnl: Number(r.pnl),
    win: Number(r.pnl) > 0,
    latency: Number(r.latency ?? 0),
    nObs: Number(r.n_obs ?? 0),
    // H1 — score slope (confidence per second) over three lookbacks.
    slope30: r.slope_30 === null ? null : Number(r.slope_30),
    slope15: r.slope_15 === null ? null : Number(r.slope_15),
    slope5: r.slope_5 === null ? null : Number(r.slope_5),
    // H2 — same-side persistence.
    sameSideFrac: r.n_obs > 0 ? Number(r.same_side) / Number(r.n_obs) : null,
    // H3 — side instability.
    flips: Number(r.flips ?? 0),
    flipRate: r.n_obs > 1 ? Number(r.flips) / (Number(r.n_obs) - 1) : null,
    meanConf: r.mean_conf === null ? null : Number(r.mean_conf),
    lastConf: r.last_conf === null ? null : Number(r.last_conf),
  }));

const usable = all.filter((t) => t.nObs >= MIN_OBS);

const usd = (v) => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
const pct = (v) => `${(v * 100).toFixed(1)}%`;

// ── Spearman rank correlation ─────────────────────────────────────────────
function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}
function spearman(xs, ys) {
  if (xs.length < 3) return 0;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

// PREDECLARED. Nothing is added to this list after seeing results.
const FEATURES = [
  ["H1 slope 30m", (t) => t.slope30],
  ["H1 slope 15m", (t) => t.slope15],
  ["H1 slope 5m", (t) => t.slope5],
  ["H2 same-side fraction", (t) => t.sameSideFrac],
  ["H3 side flips", (t) => t.flips],
  ["H3 flip rate", (t) => t.flipRate],
];

let seed = 424242;
function rand() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) % 1e9) / 1e9;
}
function shuffled(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function analyse(label, set) {
  console.log(`\n── ${label} ──`);
  if (set.length < 20) {
    console.log(`  ${set.length} usable trades — too few, skipped`);
    return;
  }
  const wins = set.filter((t) => t.win).length;
  console.log(
    `  ${set.length} trades with >= ${MIN_OBS} prior signals · ` +
      `${pct(wins / set.length)} win · ${usd(set.reduce((a, t) => a + t.pnl, 0) / set.length)}/trade`,
  );

  const pnls = set.map((t) => t.pnl);
  const results = [];
  for (const [name, get] of FEATURES) {
    const pairs = set.map((t) => [get(t), t.pnl]).filter(([v]) => v !== null && Number.isFinite(v));
    if (pairs.length < 20) {
      results.push({ name, rho: null, n: pairs.length });
      continue;
    }
    results.push({
      name,
      n: pairs.length,
      rho: spearman(
        pairs.map((p) => p[0]),
        pairs.map((p) => p[1]),
      ),
    });
  }

  console.log("  Spearman rho (feature vs net PnL):");
  for (const r of results) {
    console.log(
      r.rho === null
        ? `    ${r.name.padEnd(24)} n=${r.n} — too few`
        : `    ${r.name.padEnd(24)} n=${String(r.n).padStart(3)}  rho = ${r.rho >= 0 ? "+" : ""}${r.rho.toFixed(3)}`,
    );
  }

  const observed = Math.max(...results.filter((r) => r.rho !== null).map((r) => Math.abs(r.rho)));
  const nulls = [];
  for (let i = 0; i < PERMUTATIONS; i++) {
    const shuf = shuffled(pnls);
    let best = 0;
    for (const [, get] of FEATURES) {
      const pairs = set
        .map((t, k) => [get(t), shuf[k]])
        .filter(([v]) => v !== null && Number.isFinite(v));
      if (pairs.length < 20) continue;
      const rho = Math.abs(
        spearman(
          pairs.map((p) => p[0]),
          pairs.map((p) => p[1]),
        ),
      );
      if (rho > best) best = rho;
    }
    nulls.push(best);
  }
  nulls.sort((a, b) => a - b);
  const p = (nulls.filter((v) => v >= observed).length + 1) / (nulls.length + 1);
  console.log(
    `  global max|rho| = ${observed.toFixed(3)} · noise median ${nulls[Math.floor(nulls.length * 0.5)].toFixed(3)} · ` +
      `95th ${nulls[Math.floor(nulls.length * 0.95)].toFixed(3)} · p = ${p.toFixed(4)}`,
  );
  console.log(
    p <= 0.05
      ? "  => TRAJECTORY CARRIES INFORMATION."
      : "  => NULL. Trajectory adds nothing beyond noise for this generator.",
  );

  // ── trajectory x latency interaction ────────────────────────────────────
  // Two filters' lifts do not necessarily add: they may be selecting the same
  // trades. The 2x2 shows whether they are independent.
  const withBoth = set.filter((t) => t.slope30 !== null && Number.isFinite(t.slope30));
  if (withBoth.length >= 24) {
    const slopes = withBoth.map((t) => t.slope30).sort((a, b) => a - b);
    const lats = withBoth.map((t) => t.latency).sort((a, b) => a - b);
    const slopeCut = slopes[Math.floor(slopes.length / 2)];
    const latCut = lats[Math.floor(lats.length / 2)];
    console.log(
      `  trajectory x latency (slope >= ${slopeCut.toExponential(2)}, latency < ${latCut.toFixed(0)}ms):`,
    );
    console.log("    trajectory  latency    n   win%     avg");
    for (const [tLabel, tPred] of [
      ["rising", (t) => t.slope30 >= slopeCut],
      ["falling", (t) => t.slope30 < slopeCut],
    ]) {
      for (const [lLabel, lPred] of [
        ["fast", (t) => t.latency < latCut],
        ["slow", (t) => t.latency >= latCut],
      ]) {
        const cell = withBoth.filter((t) => tPred(t) && lPred(t));
        const w = cell.filter((t) => t.win).length;
        console.log(
          `    ${tLabel.padEnd(11)} ${lLabel.padEnd(7)} ${String(cell.length).padStart(3)}  ` +
            `${cell.length ? pct(w / cell.length).padStart(6) : "     —"}  ` +
            `${cell.length ? usd(cell.reduce((a, t) => a + t.pnl, 0) / cell.length).padStart(8) : "       —"}`,
        );
      }
    }
  }
}

console.log("\nTRAJECTORY ANALYSIS — does the path into a signal predict its outcome?");
console.log(
  `lookback ${WINDOW_MIN}m · min ${MIN_OBS} prior signals · ${PERMUTATIONS} permutations`,
);
console.log(`H4 (within-scan rank persistence): NOT TESTABLE — signals stores no rank.`);
console.log(
  `\ncoverage: ${usable.length}/${all.length} trades have >= ${MIN_OBS} prior signals in the window`,
);

analyse("all epochs pooled", usable);
for (const e of [...new Set(usable.map((t) => t.epoch))].sort()) {
  analyse(
    `epoch ${e}`,
    usable.filter((t) => t.epoch === e),
  );
}
console.log("");
