#!/usr/bin/env node
// Read-only status snapshot of the live paper-trading account.
//
//   DATABASE_URL=... node scripts/app-stats.mjs
//
// SELECTs only — safe against production at any time. Credentials are scrubbed
// from every error path before anything is printed.
import { neon } from "@neondatabase/serverless";
import dns from "node:dns";
import net from "node:net";

if (process.env.STATS_FORCE_IPV4 !== "0") {
  dns.setDefaultResultOrder("ipv4first");
  net.setDefaultAutoSelectFamily(false);
}

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
  console.error("app-stats: DATABASE_URL is not set.");
  process.exit(1);
}
const scrub = (s) => String(s).split(url).join("<DATABASE_URL>");
try {
  const p = new URL(url);
  if (p.protocol !== "postgres:" && p.protocol !== "postgresql:") throw new Error("bad scheme");
} catch (e) {
  console.error(`app-stats: DATABASE_URL unusable (${scrub(e.message)}).`);
  process.exit(1);
}

const sql = neon(url);
const usd = (v) => `${v < 0 ? "-" : ""}$${Math.abs(Number(v ?? 0)).toFixed(2)}`;
const pct = (v) => `${(Number(v ?? 0) * 100).toFixed(1)}%`;

function ago(ts) {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

async function main() {
  // ── runner liveness ──
  const runner = await sql`
    SELECT status, equity::float8, closed_trades, ticks_per_sec::float8,
           started_at, last_seen_at
      FROM runner_state ORDER BY last_seen_at DESC LIMIT 1`;
  console.log("\n═══ RUNNER ═══");
  if (runner.length === 0) {
    console.log("  no runner_state row — the headless runner has never checked in");
  } else {
    const r = runner[0];
    const staleSec = (Date.now() - new Date(r.last_seen_at).getTime()) / 1000;
    console.log(`  status      ${r.status}${staleSec > 120 ? "  ⚠ STALE" : ""}`);
    console.log(`  last seen   ${ago(r.last_seen_at)}`);
    console.log(`  uptime      since ${new Date(r.started_at).toISOString().slice(0, 16)}Z`);
    console.log(`  equity      ${usd(r.equity)}`);
    console.log(`  tick rate   ${Number(r.ticks_per_sec).toFixed(1)}/s`);
  }

  // ── accounts ──
  //
  // Per user, and cross-checked against that user's own closed trades. The
  // account's realized_pnl and the sum of its trade rows are written by
  // different code paths, so a gap between them means trades were persisted
  // without the account advancing (or vice versa) — a real bookkeeping split,
  // not a rounding artefact. Reporting a single pooled total would hide it.
  const acct = await sql`
    SELECT a.user_id,
           a.starting_balance::float8 AS start,
           a.realized_pnl::float8 AS realized,
           a.halted,
           coalesce(c.n, 0)::int AS closed_n,
           coalesce(c.pnl, 0)::float8 AS closed_pnl,
           coalesce(o.n, 0)::int AS open_n
      FROM paper_accounts a
      LEFT JOIN (
        SELECT user_id, count(*)::int AS n, sum(pnl)::float8 AS pnl
          FROM paper_trades WHERE status = 'closed' AND pnl IS NOT NULL
         GROUP BY user_id
      ) c ON c.user_id = a.user_id
      LEFT JOIN (
        SELECT user_id, count(*)::int AS n FROM paper_trades WHERE status = 'open'
         GROUP BY user_id
      ) o ON o.user_id = a.user_id
     ORDER BY a.updated_at DESC`;
  console.log(`\n═══ ACCOUNTS (${acct.length}) ═══`);
  for (const a of acct) {
    const equity = a.start + a.realized;
    const gap = a.realized - a.closed_pnl;
    console.log(
      `  ${String(a.user_id).slice(0, 8)}  start ${usd(a.start)}  realized ${usd(a.realized)}  ` +
        `equity ${usd(equity)}  open ${a.open_n}  closed ${a.closed_n}${a.halted ? "  HALTED" : ""}`,
    );
    console.log(
      `             sum(closed pnl) ${usd(a.closed_pnl)}  vs realized ${usd(a.realized)}  ` +
        `→ gap ${usd(gap)}${Math.abs(gap) > 1 ? "  ⚠" : ""}`,
    );
  }

  // ── open book ──
  const open = await sql`
    SELECT symbol, side, entry_price::float8 AS entry, size::float8 AS size,
           notional::float8 AS notional, leverage::float8 AS lev, opened_at, strategy_epoch
      FROM paper_trades WHERE status = 'open' ORDER BY opened_at DESC`;
  console.log(`\n═══ OPEN POSITIONS (${open.length}) ═══`);
  for (const p of open) {
    console.log(
      `  ${String(p.symbol).padEnd(14)} ${String(p.side).padEnd(4)} ` +
        `${usd(p.notional).padStart(10)} @ ${p.entry}  ${p.lev ?? "?"}x  ` +
        `${ago(p.opened_at)}  ${p.strategy_epoch}`,
    );
  }
  if (open.length === 0) console.log("  (flat)");

  // ── closed performance ──
  const tot = await sql`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE pnl > 0)::int AS wins,
           coalesce(sum(pnl),0)::float8 AS pnl,
           coalesce(avg(pnl),0)::float8 AS exp,
           coalesce(sum(fees),0)::float8 AS fees,
           coalesce(sum(funding),0)::float8 AS funding,
           coalesce(sum(slip_cost_usd),0)::float8 AS slip,
           coalesce(sum(gross_pnl),0)::float8 AS gross,
           count(*) FILTER (WHERE reason = 'LIQ')::int AS liqs,
           max(closed_at) AS last_close
      FROM paper_trades WHERE status = 'closed' AND pnl IS NOT NULL`;
  const t = tot[0];
  console.log("\n═══ CLOSED TRADES ═══");
  console.log(`  trades      ${t.n}   last close ${ago(t.last_close)}`);
  console.log(`  win rate    ${pct(t.n ? t.wins / t.n : 0)}  (${t.wins}/${t.n})`);
  console.log(`  net PnL     ${usd(t.pnl)}   expectancy ${usd(t.exp)}/trade`);
  console.log(`  gross       ${usd(t.gross)}`);
  console.log(`  fees        ${usd(t.fees)}`);
  console.log(`  funding     ${usd(t.funding)}`);
  console.log(`  slippage    ${usd(t.slip)}  (already inside gross — attribution only)`);
  console.log(`  liquidations ${t.liqs}`);
  const residual = t.pnl - (t.gross - t.fees - t.funding);
  console.log(
    `  residual    ${usd(residual)}${Math.abs(residual) > 0.01 ? "  ⚠ net ≠ gross − fees − funding" : "  ✓"}`,
  );

  // ── by epoch ──
  const ep = await sql`
    SELECT strategy_epoch AS e, count(*)::int AS n,
           count(*) FILTER (WHERE pnl > 0)::int AS wins,
           coalesce(sum(pnl),0)::float8 AS pnl,
           coalesce(avg(pnl),0)::float8 AS exp,
           max(closed_at) AS last
      FROM paper_trades WHERE status = 'closed' AND pnl IS NOT NULL
     GROUP BY 1 ORDER BY 1`;
  console.log("\n═══ BY EPOCH ═══");
  for (const e of ep) {
    console.log(
      `  ${String(e.e).padEnd(4)} n=${String(e.n).padStart(3)}  ` +
        `${usd(e.exp).padStart(9)}/trade  total ${usd(e.pnl).padStart(10)}  ` +
        `win ${pct(e.wins / e.n).padStart(6)}  last ${ago(e.last)}`,
    );
  }

  // ── recent windows: is it working NOW? ──
  const recent = await sql`
    WITH r AS (
      SELECT pnl::float8 AS pnl, row_number() OVER (ORDER BY closed_at DESC) AS rn
        FROM paper_trades WHERE status = 'closed' AND pnl IS NOT NULL
    )
    SELECT 10 AS w, coalesce(sum(pnl),0)::float8 AS pnl, coalesce(avg(pnl),0)::float8 AS exp,
           count(*) FILTER (WHERE pnl > 0)::int AS wins, count(*)::int AS n FROM r WHERE rn <= 10
    UNION ALL
    SELECT 20, coalesce(sum(pnl),0)::float8, coalesce(avg(pnl),0)::float8,
           count(*) FILTER (WHERE pnl > 0)::int, count(*)::int FROM r WHERE rn <= 20
    UNION ALL
    SELECT 50, coalesce(sum(pnl),0)::float8, coalesce(avg(pnl),0)::float8,
           count(*) FILTER (WHERE pnl > 0)::int, count(*)::int FROM r WHERE rn <= 50`;
  console.log("\n═══ RECENT WINDOWS ═══");
  for (const w of recent) {
    console.log(
      `  last ${String(w.w).padStart(2)}   n=${String(w.n).padStart(3)}  ` +
        `${usd(w.exp).padStart(9)}/trade  total ${usd(w.pnl).padStart(10)}  ` +
        `win ${pct(w.n ? w.wins / w.n : 0)}`,
    );
  }

  // ── execution decomposition ──
  //
  // Separates signal quality from execution quality, which fill-based gross
  // alone cannot do. Slippage is INSIDE fill gross, so "fill gross is
  // negative" does not by itself convict the signal — favourable fills could
  // be masking a worse signal, or adverse fills could be sinking a good one.
  //
  //   signalGross = sign · qty · (trigger − signal)     intended, at reference prices
  //   fillGross   = sign · qty · (exit    − entry)      realised, at actual fills
  //   execEffect  = fillGross − signalGross
  //               = entryEffect + exitEffect            (positive = fills helped)
  //
  // The chain must close: signalGross + execEffect = fillGross = stored gross,
  // and fillGross − fees − funding = net.
  const dec = await sql`
    SELECT strategy_epoch AS e,
           count(*)::int AS n,
           count(*) FILTER (WHERE signal_price IS NULL OR trigger_price IS NULL)::int AS missing,
           coalesce(sum(CASE WHEN side = 'BUY' THEN 1 ELSE -1 END * size
                        * (trigger_price - signal_price)), 0)::float8 AS signal_gross,
           coalesce(sum(CASE WHEN side = 'BUY' THEN 1 ELSE -1 END * size
                        * (exit_price - entry_price)), 0)::float8 AS fill_gross,
           coalesce(sum(CASE WHEN side = 'BUY' THEN 1 ELSE -1 END * size
                        * (signal_price - entry_price)), 0)::float8 AS entry_effect,
           coalesce(sum(CASE WHEN side = 'BUY' THEN 1 ELSE -1 END * size
                        * (exit_price - trigger_price)), 0)::float8 AS exit_effect,
           coalesce(sum(gross_pnl), 0)::float8 AS stored_gross,
           coalesce(sum(pnl), 0)::float8 AS net,
           coalesce(sum(fees), 0)::float8 AS fees,
           coalesce(sum(funding), 0)::float8 AS funding
      FROM paper_trades
     WHERE status = 'closed' AND pnl IS NOT NULL
       AND signal_price IS NOT NULL AND trigger_price IS NOT NULL
     GROUP BY 1 ORDER BY 1`;
  console.log("\n═══ EXECUTION DECOMPOSITION ═══");
  console.log("  (signal gross) + (execution effect) = (fill gross) − fees − funding = net");
  for (const d of dec) {
    const execEffect = d.fill_gross - d.signal_gross;
    const legSum = d.entry_effect + d.exit_effect;
    const chainErr = d.fill_gross - (d.signal_gross + execEffect);
    const storedErr = d.fill_gross - d.stored_gross;
    const netErr = d.net - (d.fill_gross - d.fees - d.funding);
    console.log(`  ${d.e}  n=${d.n}${d.missing ? `  (${d.missing} missing prices)` : ""}`);
    console.log(`    signal gross     ${usd(d.signal_gross).padStart(11)}   ← the signal itself`);
    console.log(
      `    execution effect ${usd(execEffect).padStart(11)}   ` +
        `(entry ${usd(d.entry_effect)}, exit ${usd(d.exit_effect)})`,
    );
    console.log(`    fill gross       ${usd(d.fill_gross).padStart(11)}`);
    console.log(`    fees             ${usd(-d.fees).padStart(11)}`);
    console.log(`    funding          ${usd(-d.funding).padStart(11)}`);
    console.log(`    net              ${usd(d.net).padStart(11)}`);
    console.log(
      `    identity errors: legs ${usd(execEffect - legSum)}  chain ${usd(chainErr)}  ` +
        `vs stored gross ${usd(storedErr)}  net ${usd(netErr)}`,
    );
  }

  // ── fee decomposition, normalised to bps of entry notional ──
  //
  // Liquidity flags are NOT stored per trade (makerEntry is broker-memory
  // only), so the maker/taker split is INFERRED from the blended rate:
  //
  //   effective bps = fees / (entryNotional + exitNotional) · 10000
  //
  // Benchmarks: taker 5.5 bps, maker 2.0 bps. An effective rate below 5.5
  // proves maker fills are happening; how far below measures how much has
  // already been harvested. Assuming exits cross (stops and liquidations must),
  // the entry leg's implied rate is backed out to test that directly.
  //
  // Everything is expressed in bps of ENTRY notional so signal edge, execution
  // and fees are directly comparable, and position-size variation cannot hide
  // inside a dollars-per-trade average.
  const TAKER_BPS = 5.5;
  const MAKER_BPS = 2.0;
  const fee = await sql`
    SELECT strategy_epoch AS e, count(*)::int AS n,
           coalesce(sum(entry_price * size), 0)::float8 AS entry_notional,
           coalesce(sum(exit_price * size), 0)::float8 AS exit_notional,
           coalesce(sum(fees), 0)::float8 AS fees,
           coalesce(sum(funding), 0)::float8 AS funding,
           coalesce(sum(pnl), 0)::float8 AS net,
           coalesce(sum(CASE WHEN side = 'BUY' THEN 1 ELSE -1 END * size
                        * (trigger_price - signal_price)), 0)::float8 AS signal_gross,
           coalesce(sum(CASE WHEN side = 'BUY' THEN 1 ELSE -1 END * size
                        * (exit_price - entry_price)), 0)::float8 AS fill_gross
      FROM paper_trades
     WHERE status = 'closed' AND pnl IS NOT NULL
       AND signal_price IS NOT NULL AND trigger_price IS NOT NULL
     GROUP BY 1 ORDER BY 1`;

  console.log("\n═══ FEE / EDGE IN BPS OF ENTRY NOTIONAL ═══");
  console.log("  (liquidity flags not stored — maker share inferred from blended rate)");
  for (const f of fee) {
    const bps = (v) => (f.entry_notional > 0 ? (v / f.entry_notional) * 10_000 : 0);
    const effBps = ((f.fees / (f.entry_notional + f.exit_notional)) * 10_000) || 0;
    // If the exit leg crossed at taker, what did the entry leg actually pay?
    const impliedEntryFee = f.fees - f.exit_notional * (TAKER_BPS / 10_000);
    const impliedEntryBps = f.entry_notional > 0 ? (impliedEntryFee / f.entry_notional) * 10_000 : 0;
    const execEffect = f.fill_gross - f.signal_gross;
    // Round-trip floors, in bps of entry notional (both legs ~equal notional).
    const floorMakerTaker = MAKER_BPS + TAKER_BPS * (f.exit_notional / (f.entry_notional || 1));
    const floorMakerMaker = MAKER_BPS + MAKER_BPS * (f.exit_notional / (f.entry_notional || 1));
    const signalBps = bps(f.signal_gross);

    console.log(`  ${f.e}  n=${f.n}  entry notional ${usd(f.entry_notional)}`);
    console.log(`    signal edge        ${signalBps.toFixed(2).padStart(8)} bps`);
    console.log(`    execution effect   ${bps(execEffect).toFixed(2).padStart(8)} bps`);
    console.log(`    fees               ${bps(-f.fees).toFixed(2).padStart(8)} bps`);
    console.log(`    funding            ${bps(-f.funding).toFixed(2).padStart(8)} bps`);
    console.log(`    net                ${bps(f.net).toFixed(2).padStart(8)} bps`);
    console.log(
      `    blended fee rate   ${effBps.toFixed(2)} bps/leg  ` +
        `(taker ${TAKER_BPS}, maker ${MAKER_BPS}) → maker share ≈ ` +
        `${Math.max(0, Math.min(100, ((TAKER_BPS - effBps) / (TAKER_BPS - MAKER_BPS)) * 100)).toFixed(0)}%`,
    );
    console.log(`    implied entry leg  ${impliedEntryBps.toFixed(2)} bps (assuming exits cross)`);
    console.log(
      `    round-trip floor   maker/taker ${floorMakerTaker.toFixed(2)} bps, ` +
        `maker/maker ${floorMakerMaker.toFixed(2)} bps`,
    );
    console.log(
      `    → edge vs floor    perfect-exec at maker/taker: ` +
        `${(signalBps - floorMakerTaker).toFixed(2)} bps, ` +
        `at maker/maker: ${(signalBps - floorMakerMaker).toFixed(2)} bps`,
    );
  }

  // ── exit mix ──
  //
  // Where trades actually end. A TIME/CARRY exit pays full round-trip cost for
  // a position that never reached its thesis, so a large flat-exit bucket is
  // pure drag masquerading as risk control.
  const exits = await sql`
    SELECT strategy_epoch AS e, reason, count(*)::int AS n,
           coalesce(sum(pnl),0)::float8 AS pnl,
           coalesce(avg(pnl),0)::float8 AS exp,
           coalesce(avg(fees),0)::float8 AS avg_fee
      FROM paper_trades WHERE status = 'closed' AND pnl IS NOT NULL
     GROUP BY 1,2 ORDER BY 1, 4 DESC`;
  console.log("\n═══ EXIT MIX ═══");
  let curEpoch = null;
  for (const x of exits) {
    if (x.e !== curEpoch) {
      curEpoch = x.e;
      console.log(`  ${curEpoch}`);
    }
    console.log(
      `    ${String(x.reason).padEnd(7)} n=${String(x.n).padStart(3)}  ` +
        `${usd(x.exp).padStart(9)}/trade  total ${usd(x.pnl).padStart(10)}  ` +
        `avg fee ${usd(x.avg_fee)}`,
    );
  }

  // ── cost drag ──
  //
  // Ranked by what is actually recoverable. Slippage is the only cost here the
  // engine can influence at will (passive entries, cost gating, symbol
  // suppression); fees are contractual and funding is exchange-set.
  const drag = await sql`
    SELECT strategy_epoch AS e,
           coalesce(sum(gross_pnl),0)::float8 AS gross,
           coalesce(sum(fees),0)::float8 AS fees,
           coalesce(sum(funding),0)::float8 AS funding,
           coalesce(sum(slip_cost_usd),0)::float8 AS slip,
           coalesce(avg(entry_slip_bps),0)::float8 AS ent,
           coalesce(avg(exit_slip_bps),0)::float8 AS ext
      FROM paper_trades WHERE status = 'closed' AND pnl IS NOT NULL
     GROUP BY 1 ORDER BY 1`;
  console.log("\n═══ COST DRAG (share of gross) ═══");
  for (const d of drag) {
    const g = Math.abs(d.gross) || 1;
    console.log(
      `  ${String(d.e).padEnd(4)} gross ${usd(d.gross).padStart(10)}  ` +
        `fees ${((d.fees / g) * 100).toFixed(0)}%  funding ${((d.funding / g) * 100).toFixed(0)}%  ` +
        `slip ${((d.slip / g) * 100).toFixed(0)}%  (entry ${d.ent.toFixed(1)}bps / exit ${d.ext.toFixed(1)}bps)`,
    );
  }

  // Symbols bleeding the most to slippage — the direct cost-gate candidates.
  const worstSlip = await sql`
    SELECT symbol, count(*)::int AS n,
           coalesce(sum(slip_cost_usd),0)::float8 AS slip,
           coalesce(sum(pnl),0)::float8 AS pnl
      FROM paper_trades
     WHERE status = 'closed' AND pnl IS NOT NULL AND strategy_epoch = ${"v3"}
     GROUP BY 1 HAVING count(*) >= 2 ORDER BY 3 DESC LIMIT 6`;
  if (worstSlip.length) {
    console.log("  v3 symbols by slippage paid (n>=2):");
    for (const s of worstSlip) {
      console.log(
        `    ${String(s.symbol).padEnd(14)} n=${s.n}  slip ${usd(s.slip).padStart(9)}  ` +
          `net ${usd(s.pnl).padStart(9)}`,
      );
    }
  }

  // ── agent attribution ──
  //
  // edge_report credits an agent when agents->>'direction' matches the trade
  // side. If every trade carries all four agents pointing the same way, all
  // four get identical stats and the learner's per-agent weights are inert —
  // it cannot tell a good agent from a bad one. This measures that directly.
  const agents = await sql`
    SELECT a.key AS name,
           count(*)::int AS credited,
           count(*) FILTER (WHERE c.pnl > 0)::int AS wins,
           coalesce(sum(c.pnl),0)::float8 AS pnl,
           coalesce(avg(c.pnl),0)::float8 AS exp
      FROM paper_trades c, jsonb_each(c.agents) a
     WHERE c.status = 'closed' AND c.pnl IS NOT NULL
       AND (a.value->>'direction') = c.side
     GROUP BY a.key ORDER BY 1`;
  const shapes = await sql`
    SELECT (SELECT count(*) FROM jsonb_object_keys(agents))::int AS keys,
           count(*)::int AS trades
      FROM paper_trades
     WHERE status = 'closed' AND pnl IS NOT NULL
     GROUP BY 1 ORDER BY 1`;
  console.log("\n═══ AGENT ATTRIBUTION ═══");
  console.log(`  agent-keys per trade: ${shapes.map((s) => `${s.keys}→${s.trades} trades`).join(", ")}`);
  const sigs = new Set();
  for (const a of agents) {
    console.log(
      `  ${String(a.name).padEnd(10)} credited ${String(a.credited).padStart(3)}  ` +
        `${usd(a.exp).padStart(9)}/trade  total ${usd(a.pnl).padStart(10)}  win ${pct(a.wins / a.credited)}`,
    );
    sigs.add(`${a.credited}|${a.pnl.toFixed(2)}`);
  }
  if (agents.length > 1 && sigs.size === 1) {
    console.log("  ⚠ ALL AGENTS IDENTICAL — per-agent learning has no signal to work with");
  } else if (agents.length > 1) {
    console.log(`  ✓ ${sigs.size} distinct agent profiles — attribution is discriminating`);
  }

  // ── signals + shadow ──
  const sig = await sql`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE executed)::int AS executed,
           max(created_at) AS last FROM signals`;
  console.log("\n═══ SIGNALS ═══");
  console.log(
    `  ingested    ${sig[0].n}   executed ${sig[0].executed}   last ${ago(sig[0].last)}`,
  );

  const funding = await sql`SELECT to_regclass('public.paper_funding_events') AS t`;
  if (funding[0]?.t) {
    const fe = await sql`
      SELECT count(*)::int AS n, coalesce(sum(amount_usd),0)::float8 AS total,
             count(*) FILTER (WHERE rate_source <> 'settled')::int AS provisional,
             max(funding_time) AS last FROM paper_funding_events`;
    console.log("\n═══ FUNDING SETTLEMENTS ═══");
    console.log(
      `  events ${fe[0].n}  net ${usd(fe[0].total)}  provisional ${fe[0].provisional}  last ${ago(fe[0].last)}`,
    );
  } else {
    console.log("\n═══ FUNDING SETTLEMENTS ═══\n  table not created yet — run apply-schema");
  }
  console.log("");
}

main().catch((e) => {
  console.error(`app-stats: ${scrub(e?.message ?? e)}`);
  process.exit(1);
});
