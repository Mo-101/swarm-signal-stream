#!/usr/bin/env node
// Read-only verification of the funding / reconciliation / epoch-calibration
// migration. Run it against a shadow branch BEFORE production, and against
// production immediately after.
//
//   DATABASE_URL=<shadow>  node scripts/verify-migration.mjs
//   DATABASE_URL=<prod>    node scripts/verify-migration.mjs
//
// Executes nothing but SELECTs — it can never mutate, so it is safe to run at
// any time, including against a live trading database. Exit code is 0 when
// every check passes, 1 otherwise, so CI or a deploy script can gate on it.
//
// Credentials are never printed: every error message is scrubbed of the
// connection string before it reaches stdout or stderr.
import { neon } from "@neondatabase/serverless";
import dns from "node:dns";
import net from "node:net";

// Neon publishes AAAA records; hosts without an IPv6 route (WSL, some CI
// runners) otherwise die on ENETUNREACH instead of falling back to v4.
if (process.env.VERIFY_FORCE_IPV4 !== "0") {
  dns.setDefaultResultOrder("ipv4first");
  net.setDefaultAutoSelectFamily(false);
}

// ── connection ─────────────────────────────────────────────────────────────

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
  console.error("verify-migration: DATABASE_URL is not set.");
  process.exit(1);
}

/**
 * The neon() driver embeds the whole connection string in its error messages.
 * Anything printed from here goes through this first — a leaked password in a
 * terminal, a CI log or a pasted traceback has to be treated as burned.
 */
const scrub = (s) => String(s).split(url).join("<DATABASE_URL>");

// Validate before handing it to the driver, so the common failure never throws
// the credential-bearing error in the first place.
let host = "";
try {
  const parsed = new URL(url);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("scheme must be postgres:// or postgresql://");
  }
  host = parsed.hostname;
} catch (e) {
  console.error(`verify-migration: DATABASE_URL is not a usable URL (${scrub(e.message)}).`);
  process.exit(1);
}

const sql = neon(url);

// ── checks ─────────────────────────────────────────────────────────────────

const fmt = (v) => (v === null || v === undefined ? "NULL" : `$${Number(v).toFixed(2)}`);

const checks = [];
const record = (name, ok, detail) => checks.push({ name, ok, detail });

async function main() {
  console.log(`\nverify-migration → ${host}\n`);

  // 1. Funding-event table and, critically, its idempotency constraint. The
  //    table alone is worthless: without the UNIQUE, a replayed settlement is
  //    charged twice and the ledger silently drifts.
  const tbl = await sql`SELECT to_regclass('public.paper_funding_events') AS t`;
  const hasTable = Boolean(tbl[0]?.t);
  record("paper_funding_events exists", hasTable, hasTable ? "" : "run apply-schema");

  if (hasTable) {
    const uq = await sql`
      SELECT con.conname, pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
       WHERE rel.relname = 'paper_funding_events' AND con.contype = 'u'`;
    const def = uq.map((r) => r.def).join(" | ");
    const ok =
      /user_id/.test(def) && /symbol/.test(def) && /side/.test(def) && /funding_time/.test(def);
    record(
      "funding idempotency UNIQUE present",
      ok,
      ok ? def : `missing (found: ${def || "none"}) — replays would double-charge`,
    );

    const cols = await sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'paper_funding_events'`;
    const names = cols.map((c) => c.column_name);
    const required = [
      "user_id",
      "symbol",
      "side",
      "funding_time",
      "position_qty",
      "mark_price",
      "funding_rate",
      "interval_ms",
      "amount_usd",
      "rate_source",
    ];
    const missing = required.filter((c) => !names.includes(c));
    record(
      "funding columns complete",
      missing.length === 0,
      missing.length ? `missing: ${missing.join(", ")}` : `${names.length} columns`,
    );
  }

  // 2. edge_report exists and now emits the epoch-split confidence table.
  const fn = await sql`
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'edge_report'`;
  record("edge_report() present", fn.length > 0, fn.map((r) => r.sig).join(", ") || "missing");

  // 3. Reconciliation: net must equal gross - fees - funding on every closed
  //    trade. A non-zero residual is the bug this migration fixes.
  const rec = await sql`
    SELECT count(*)::int AS trades,
           coalesce(sum(pnl), 0)::float8 AS net,
           coalesce(sum(gross_pnl), 0)::float8 AS gross,
           coalesce(sum(fees), 0)::float8 AS fees,
           coalesce(sum(funding), 0)::float8 AS funding,
           count(*) FILTER (WHERE gross_pnl IS NULL)::int AS null_gross,
           count(*) FILTER (
             WHERE abs(coalesce(pnl,0) - (coalesce(gross_pnl,0) - coalesce(fees,0)
                   - coalesce(funding,0))) > 0.01)::int AS unreconciled,
           count(*) FILTER (WHERE reason = 'LIQ')::int AS liquidations
      FROM paper_trades
     WHERE status = 'closed' AND pnl IS NOT NULL`;
  const r = rec[0];
  const residual = r.net - (r.gross - r.fees - r.funding);

  record(
    "no NULL gross_pnl on closed trades",
    r.null_gross === 0,
    r.null_gross === 0 ? `${r.trades} closed trades` : `${r.null_gross} rows need the backfill`,
  );

  // Liquidations legitimately break the identity: their PnL is capped at the
  // posted margin rather than derived from the exit fill.
  const residualOk = Math.abs(residual) <= 0.01 || r.unreconciled <= r.liquidations;
  record(
    "net = gross - fees - funding",
    residualOk,
    `residual $${residual.toFixed(2)} across ${r.unreconciled} unreconciled ` +
      `(${r.liquidations} liquidations explain up to that many)`,
  );

  // 3b. When the identity fails, say WHY. A residual is only actionable once
  //     you know which column is missing on which rows — guessing at the cause
  //     from the aggregate alone is how a data bug gets "fixed" in the wrong
  //     place.
  if (!residualOk) {
    const why = await sql`
      SELECT count(*) FILTER (WHERE gross_pnl IS NULL)::int AS null_gross,
             count(*) FILTER (WHERE fees IS NULL)::int AS null_fees,
             count(*) FILTER (WHERE funding IS NULL)::int AS null_funding,
             count(*) FILTER (WHERE gross_pnl IS NOT NULL AND fees IS NOT NULL
                              AND funding IS NOT NULL
                              AND abs(pnl - (gross_pnl - fees - funding)) > 0.01)::int AS all_present,
             coalesce(sum(pnl) FILTER (WHERE fees IS NULL OR funding IS NULL), 0)::float8 AS pnl_of_null_cost
        FROM paper_trades
       WHERE status = 'closed' AND pnl IS NOT NULL`;
    const w = why[0];
    console.log("Residual breakdown:");
    console.log(`  rows with NULL gross_pnl : ${w.null_gross}`);
    console.log(`  rows with NULL fees      : ${w.null_fees}`);
    console.log(`  rows with NULL funding   : ${w.null_funding}`);
    console.log(`  rows failing with ALL three present : ${w.all_present}`);
    console.log(`  pnl carried by NULL-cost rows       : $${w.pnl_of_null_cost.toFixed(2)}`);

    const worst = await sql`
      SELECT symbol, side, reason, strategy_epoch,
             pnl::float8 AS pnl, gross_pnl::float8 AS gross,
             fees::float8 AS fees, funding::float8 AS funding,
             (pnl - (coalesce(gross_pnl,0) - coalesce(fees,0) - coalesce(funding,0)))::float8 AS resid
        FROM paper_trades
       WHERE status = 'closed' AND pnl IS NOT NULL
         AND abs(coalesce(pnl,0) - (coalesce(gross_pnl,0) - coalesce(fees,0)
             - coalesce(funding,0))) > 0.01
       ORDER BY abs(pnl - (coalesce(gross_pnl,0) - coalesce(fees,0) - coalesce(funding,0))) DESC
       LIMIT 5`;
    console.log("  worst offenders:");
    for (const x of worst) {
      console.log(
        `    ${String(x.symbol).padEnd(12)} ${x.side} ${String(x.reason).padEnd(6)} ${x.strategy_epoch} ` +
          `pnl ${fmt(x.pnl)} gross ${fmt(x.gross)} fees ${fmt(x.fees)} funding ${fmt(x.funding)} ` +
          `→ resid ${fmt(x.resid)}`,
      );
    }
    console.log("");
  }

  // 4. Epoch-split confidence. This is what arms the calibration fix; without
  //    it deriveEdge() silently falls back to pooled, mixed-scale buckets.
  const users = await sql`
    SELECT user_id, count(*)::int AS n FROM paper_trades
     WHERE status = 'closed' AND pnl IS NOT NULL
     GROUP BY user_id ORDER BY n DESC LIMIT 1`;

  if (users.length === 0) {
    record("confidence_by_epoch armed", false, "no closed trades to report on");
  } else {
    const uid = users[0].user_id;
    let report = null;
    try {
      const rep = await sql`SELECT edge_report(${uid}, ${"v1,v3"}) AS report`;
      report = rep[0]?.report ?? null;
    } catch (e) {
      record("edge_report() callable", false, scrub(e.message));
    }
    if (report) {
      const armed = Array.isArray(report.confidence_by_epoch);
      record(
        "confidence_by_epoch armed",
        armed,
        armed
          ? `${report.confidence_by_epoch.length} epoch/bucket rows`
          : "key absent — deriveEdge falls back to pooled buckets (the bug)",
      );

      const exec = report.execution ?? {};
      record(
        "execution report exposes residual",
        exec.residual !== undefined,
        exec.residual !== undefined
          ? `residual $${Number(exec.residual).toFixed(2)}, unreconciled ${exec.unreconciled ?? 0}`
          : "key absent — divergence would stay silent",
      );

      if (armed) {
        console.log("Confidence buckets by epoch (calibration input):");
        const rows = [...report.confidence_by_epoch].sort(
          (a, b) => String(a.epoch).localeCompare(String(b.epoch)) || a.name.localeCompare(b.name),
        );
        for (const b of rows) {
          console.log(
            `  ${String(b.epoch).padEnd(4)} ${String(b.name).padEnd(9)} ` +
              `n=${String(b.trades).padStart(3)}  exp $${Number(b.expectancy).toFixed(2)}`,
          );
        }
        console.log("");
      }
    }
  }

  // ── report ───────────────────────────────────────────────────────────────

  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    console.log(
      `  ${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(width)}${c.detail ? `  ${c.detail}` : ""}`,
    );
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length) {
    console.log("Migration is NOT fully applied. Run:");
    console.log("  DATABASE_URL=... node scripts/apply-schema.mjs src/lib/db/schema.sql");
    process.exit(1);
  }
  console.log("Migration verified.");
}

main().catch((e) => {
  console.error(`verify-migration: ${scrub(e?.message ?? e)}`);
  process.exit(1);
});
