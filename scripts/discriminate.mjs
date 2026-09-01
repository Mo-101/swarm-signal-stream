#!/usr/bin/env node
// Does ANY recorded feature separate winning trades from losing ones?
//
//   DATABASE_URL=... node scripts/discriminate.mjs
//   DATABASE_URL=... node scripts/discriminate.mjs --epoch v3 --min-group 12
//
// Read-only. Credentials never printed.
//
// ── The question ──────────────────────────────────────────────────────────
//
// v1 and v3 each produced exactly 18 winners; v1 needed 45 trades, v3 needed
// 74. So the lever is not predicting winners, it is REJECTING the trades that
// were never going to work. That is only possible if something recorded at
// ENTRY time separates the two groups. This measures whether anything does.
//
// ── Two rules that make the answer trustworthy ────────────────────────────
//
// 1. ENTRY-TIME FEATURES ONLY. reason, exit_price, exit_slip_bps,
//    spread_exit_bps and slip_cost_usd are all known only after the outcome —
//    reason='TP' *is* the label. Including any of them would manufacture a
//    perfect classifier that cannot be used to decide anything.
//
// 2. ONE GLOBAL PERMUTATION TEST over the WHOLE search. Testing ~40 splits and
//    reporting the best one is guaranteed to find "signal" in noise. So the
//    test statistic is the MAXIMUM separation found anywhere in the search,
//    compared against the distribution of that same maximum under shuffled
//    outcomes. That corrects for every split tried, not just the winner.
//
// Confidence is tested WITHIN epoch only: the scale changed at v2, so v1 sits
// at 0.7-1.0 and v3 at 0.6-0.8 and a pooled split would separate epochs rather
// than outcomes.
import { neon } from "@neondatabase/serverless";
import dns from "node:dns";
import net from "node:net";

if (process.env.DISC_FORCE_IPV4 !== "0") {
  dns.setDefaultResultOrder("ipv4first");
  net.setDefaultAutoSelectFamily(false);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const EPOCH = arg("epoch", "");
const MIN_GROUP = Number(arg("min-group", 15));
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
  console.error("discriminate: DATABASE_URL is not set.");
  process.exit(1);
}
const scrub = (s) => String(s).split(url).join("<DATABASE_URL>");
try {
  const p = new URL(url);
  if (p.protocol !== "postgres:" && p.protocol !== "postgresql:") throw new Error("bad scheme");
} catch (e) {
  console.error(`discriminate: DATABASE_URL unusable (${scrub(e.message)}).`);
  process.exit(1);
}

const sql = neon(url);

// Entry-time columns only. Nothing here is knowable after the fact.
const rows = await sql`
  SELECT strategy_epoch, side, confidence, regime, hour_utc, agents,
         entry_slip_bps, spread_entry_bps, latency_ms, notional, leverage,
         book_priced, symbol, closed_at, pnl::float8 AS pnl
    FROM paper_trades
   WHERE status = 'closed' AND pnl IS NOT NULL AND closed_at IS NOT NULL
   ORDER BY closed_at ASC`;

const trades = rows
  .filter((r) => !EPOCH || r.strategy_epoch === EPOCH)
  .map((r) => {
    const agents = r.agents ?? {};
    const names = Object.keys(agents);
    const agree = names.filter((n) => agents[n]?.direction === r.side);
    return {
      epoch: r.strategy_epoch,
      side: r.side,
      confidence: Number(r.confidence),
      regime: r.regime ?? "unknown",
      hour: Number(r.hour_utc),
      symbol: r.symbol,
      entrySlip: Number(r.entry_slip_bps ?? 0),
      spread: Number(r.spread_entry_bps ?? 0),
      latency: Number(r.latency_ms ?? 0),
      notional: Number(r.notional ?? 0),
      leverage: Number(r.leverage ?? 0),
      bookPriced: Boolean(r.book_priced),
      agreeCount: agree.length,
      dissentCount: names.length - agree.length,
      agrees: new Set(agree),
      pnl: Number(r.pnl),
      win: Number(r.pnl) > 0,
      at: new Date(r.closed_at).getTime(),
    };
  });

if (trades.length < MIN_GROUP * 2) {
  console.error(`discriminate: only ${trades.length} trades — not enough to split.`);
  process.exit(1);
}

// ── the search space, declared up front ───────────────────────────────────
//
// Predeclaring these matters: the global permutation test is only honest if
// the search it corrects for is the search actually run. No adding splits
// after seeing results.
function buildSplits(set) {
  const splits = [];
  const add = (feature, label, pred) => splits.push({ feature, label, pred });

  // Categorical / boolean
  add("side", "side = BUY", (t) => t.side === "BUY");
  add("bookPriced", "priced off real L2 book", (t) => t.bookPriced);
  for (const r of new Set(set.map((t) => t.regime))) {
    add("regime", `regime = ${r}`, (t) => t.regime === r);
  }
  for (const a of ["Trend", "MeanRev", "Breakout", "Meme"]) {
    add("agent", `${a} agreed with the trade`, (t) => t.agrees.has(a));
  }

  // Agent consensus shape
  for (const k of [1, 2, 3]) {
    add("agreeCount", `>= ${k + 1} agents agreed`, (t) => t.agreeCount >= k + 1);
  }
  add("dissent", "no agent dissented", (t) => t.dissentCount === 0);
  add("dissent", "at least one agent dissented", (t) => t.dissentCount > 0);

  // Numeric — median and tercile cuts
  const numeric = [
    ["confidence", (t) => t.confidence],
    ["entrySlip", (t) => t.entrySlip],
    ["spread", (t) => t.spread],
    ["latency", (t) => t.latency],
    ["notional", (t) => t.notional],
    ["hour", (t) => t.hour],
  ];
  for (const [name, get] of numeric) {
    const vals = set.map(get).sort((a, b) => a - b);
    const cuts = [
      ["median", vals[Math.floor(vals.length * 0.5)]],
      ["upper tercile", vals[Math.floor(vals.length * 0.667)]],
      ["lower tercile", vals[Math.floor(vals.length * 0.333)]],
    ];
    for (const [cutName, cut] of cuts) {
      add(name, `${name} >= ${Number(cut).toFixed(4)} (${cutName})`, (t) => get(t) >= cut);
    }
  }
  return splits;
}

const evaluate = (set) => {
  if (!set.length) return { n: 0, exp: 0, win: 0 };
  const pnl = set.reduce((a, t) => a + t.pnl, 0);
  return {
    n: set.length,
    exp: pnl / set.length,
    win: set.filter((t) => t.win).length / set.length,
  };
};

/** Largest expectancy gap any predeclared split achieves on `set`. */
function bestSeparation(set, splits, pnls) {
  let best = null;
  for (let i = 0; i < splits.length; i++) {
    const inGroup = [];
    const outGroup = [];
    for (let j = 0; j < set.length; j++) {
      // pnls is passed separately so permutation can relabel without
      // rebuilding the feature side of the split.
      const t = { ...set[j], pnl: pnls[j], win: pnls[j] > 0 };
      (splits[i].pred(set[j]) ? inGroup : outGroup).push(t);
    }
    if (inGroup.length < MIN_GROUP || outGroup.length < MIN_GROUP) continue;
    const a = evaluate(inGroup);
    const b = evaluate(outGroup);
    const gap = a.exp - b.exp;
    if (!best || Math.abs(gap) > Math.abs(best.gap)) {
      best = { ...splits[i], gap, inside: a, outside: b };
    }
  }
  return best;
}

let seed = 987654321;
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

const usd = (v) => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
const pct = (v) => `${(v * 100).toFixed(1)}%`;

function analyse(label, set) {
  if (set.length < MIN_GROUP * 2) {
    console.log(`\n── ${label} ──\n  only ${set.length} trades, skipped`);
    return;
  }
  const splits = buildSplits(set);
  const pnls = set.map((t) => t.pnl);
  const base = evaluate(set);

  console.log(`\n── ${label} ──`);
  console.log(
    `  ${base.n} trades · ${pct(base.win)} win · ${usd(base.exp)}/trade · ` +
      `${splits.length} predeclared splits`,
  );

  // Rank every usable split by |expectancy gap|, for display.
  const ranked = [];
  for (const s of splits) {
    const inG = set.filter(s.pred);
    const outG = set.filter((t) => !s.pred(t));
    if (inG.length < MIN_GROUP || outG.length < MIN_GROUP) continue;
    const a = evaluate(inG);
    const b = evaluate(outG);
    ranked.push({ ...s, gap: a.exp - b.exp, a, b });
  }
  ranked.sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap));

  if (ranked.length === 0) {
    console.log(`  no split leaves >= ${MIN_GROUP} trades on both sides`);
    return;
  }

  console.log("  strongest separations (expectancy gap):");
  for (const r of ranked.slice(0, 6)) {
    console.log(
      `    ${usd(r.gap).padStart(9)}  ${r.label.padEnd(42)} ` +
        `in ${String(r.a.n).padStart(3)} @ ${usd(r.a.exp).padStart(8)} (${pct(r.a.win)})  ` +
        `out ${String(r.b.n).padStart(3)} @ ${usd(r.b.exp).padStart(8)} (${pct(r.b.win)})`,
    );
  }

  // Global permutation: how big a gap does this SAME search find in noise?
  const observed = Math.abs(ranked[0].gap);
  const nullGaps = [];
  for (let i = 0; i < PERMUTATIONS; i++) {
    const best = bestSeparation(set, splits, shuffled(pnls));
    if (best) nullGaps.push(Math.abs(best.gap));
  }
  nullGaps.sort((a, b) => a - b);
  const atLeast = nullGaps.filter((g) => g >= observed).length;
  const p = (atLeast + 1) / (nullGaps.length + 1);

  console.log(
    `  permutation (max-gap over all ${splits.length} splits, ${nullGaps.length} shuffles):`,
  );
  console.log(
    `    median noise gap ${usd(nullGaps[Math.floor(nullGaps.length * 0.5)])} · ` +
      `95th pct ${usd(nullGaps[Math.floor(nullGaps.length * 0.95)])} · ` +
      `observed ${usd(observed)} · p = ${p.toFixed(4)}`,
  );
  console.log(
    p <= 0.05
      ? `  => SEPARATION SURVIVES multiple-testing correction. Candidate v4 filter.`
      : `  => NO SEPARATION. The best cut is within what this search finds in noise.`,
  );

  // Chronological holdout: pick the split on the first 70%, score on the last 30%.
  const cut = Math.floor(set.length * 0.7);
  const train = set.slice(0, cut);
  const test = set.slice(cut);
  if (train.length >= MIN_GROUP * 2 && test.length >= MIN_GROUP) {
    const trainRanked = [];
    for (const s of buildSplits(train)) {
      const inG = train.filter(s.pred);
      const outG = train.filter((t) => !s.pred(t));
      if (inG.length < MIN_GROUP || outG.length < MIN_GROUP) continue;
      trainRanked.push({ ...s, gap: evaluate(inG).exp - evaluate(outG).exp });
    }
    trainRanked.sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap));
    if (trainRanked.length) {
      const pick = trainRanked[0];
      const keep = pick.gap > 0 ? test.filter(pick.pred) : test.filter((t) => !pick.pred(t));
      const t0 = evaluate(test);
      const t1 = evaluate(keep);
      console.log(`  chronological holdout (train ${train.length} / test ${test.length}):`);
      console.log(`    rule chosen on train: ${pick.label}${pick.gap > 0 ? "" : "  (inverted)"}`);
      console.log(
        `    test all ${String(t0.n).padStart(3)} @ ${usd(t0.exp)} → ` +
          `filtered ${String(t1.n).padStart(3)} @ ${usd(t1.exp)}  ` +
          `(${t1.n ? usd(t1.exp - t0.exp) : "n/a"} vs unfiltered)`,
      );
    }
  }
}

console.log(`\nDISCRIMINATION ANALYSIS — can anything recorded at ENTRY predict the outcome?`);
console.log(`min group ${MIN_GROUP} · ${PERMUTATIONS} permutations · entry-time features only`);

analyse("all epochs pooled", trades);
for (const e of [...new Set(trades.map((t) => t.epoch))].sort()) {
  analyse(
    `epoch ${e}`,
    trades.filter((t) => t.epoch === e),
  );
}
console.log("");
