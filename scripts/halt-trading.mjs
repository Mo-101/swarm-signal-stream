#!/usr/bin/env node
// Halt or resume new paper-trade entries.
//
//   DATABASE_URL=... node scripts/halt-trading.mjs --status
//   DATABASE_URL=... node scripts/halt-trading.mjs --halt   "v3 retired: edge below cost floor"
//   DATABASE_URL=... node scripts/halt-trading.mjs --resume "v4 promoted"
//
// What a halt does, precisely:
//   * BLOCKS new entries — PaperBroker.submit rejects with the dedicated,
//     non-terminal reason "halted". It is its own bucket in rejectsByReason,
//     so it cannot contaminate any other reject category.
//   * DOES NOT touch open positions — manageOpen and closePosition contain no
//     halt checks, so existing positions still trail, stop, take profit and
//     time out normally. Halting is not the same as flattening.
//   * Signals keep ingesting with executed = false, which stays accurate.
//
// IMPORTANT: the broker reads `halted` from paper_accounts at BOOT (hydrate).
// Setting the flag does not stop a running process — the runner must be
// restarted for it to take effect.
//
// Credentials are never printed.
import { neon } from "@neondatabase/serverless";
import dns from "node:dns";
import net from "node:net";

if (process.env.HALT_FORCE_IPV4 !== "0") {
  dns.setDefaultResultOrder("ipv4first");
  net.setDefaultAutoSelectFamily(false);
}

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
  console.error("halt-trading: DATABASE_URL is not set.");
  process.exit(1);
}
const scrub = (s) => String(s).split(url).join("<DATABASE_URL>");
try {
  const p = new URL(url);
  if (p.protocol !== "postgres:" && p.protocol !== "postgresql:") throw new Error("bad scheme");
} catch (e) {
  console.error(`halt-trading: DATABASE_URL unusable (${scrub(e.message)}).`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const mode = argv.includes("--halt") ? "halt" : argv.includes("--resume") ? "resume" : "status";
const note = argv.find((a) => !a.startsWith("--")) ?? "";

const sql = neon(url);

const rows = await sql`
  SELECT a.user_id, a.halted, a.realized_pnl::float8 AS realized,
         coalesce(o.n, 0)::int AS open_n
    FROM paper_accounts a
    LEFT JOIN (
      SELECT user_id, count(*)::int AS n FROM paper_trades WHERE status = 'open'
       GROUP BY user_id
    ) o ON o.user_id = a.user_id
   ORDER BY a.updated_at DESC`;

if (rows.length === 0) {
  console.error("halt-trading: no paper_accounts rows.");
  process.exit(1);
}

console.log("");
for (const r of rows) {
  console.log(
    `  ${String(r.user_id).slice(0, 8)}  halted=${r.halted}  ` +
      `open=${r.open_n}  realized=$${r.realized.toFixed(2)}`,
  );
}

if (mode === "status") {
  console.log("\nNo change made. Pass --halt or --resume to act.\n");
  process.exit(0);
}

const target = mode === "halt";

// An unscoped UPDATE would halt or resume EVERY account. That is harmless
// while exactly one exists and a silent disaster the moment a second does:
// "stop the v3 engine" would also stop an unrelated account, with no warning.
// Require an explicit target rather than relying on "there is only one" to
// stay true.
const accountArg = argv.find((a) => a.startsWith("--account="))?.slice("--account=".length);
if (!accountArg && rows.length !== 1) {
  console.error(
    `\nhalt-trading: ${rows.length} accounts exist — refusing an unscoped ${mode}.\n` +
      `  Re-run with --account=<user_id> naming exactly which one to ${mode}.\n`,
  );
  process.exit(1);
}
const targetUser = accountArg ?? rows[0].user_id;
if (!rows.some((r) => String(r.user_id) === String(targetUser))) {
  console.error(`\nhalt-trading: no account matches the id given to --account.\n`);
  process.exit(1);
}

await sql`
  UPDATE paper_accounts SET halted = ${target}, updated_at = now()
   WHERE user_id = ${targetUser}`;

const after = await sql`SELECT user_id, halted FROM paper_accounts WHERE user_id = ${targetUser}`;
const ok = after.length === 1 && after.every((r) => r.halted === target);

console.log(`\n${mode === "halt" ? "HALTED" : "RESUMED"}${note ? ` — ${note}` : ""}`);
console.log(`  rows updated : ${after.length}`);
console.log(`  verified     : ${ok ? "yes" : "NO — flag did not stick"}`);
console.log(
  mode === "halt"
    ? "\n  Open positions are NOT closed; they continue to manage to their exits.\n" +
        "  The running process keeps its in-memory state — RESTART THE RUNNER for\n" +
        "  this to take effect:\n" +
        "    cd /docker/alpha-swarm && docker compose -f docker-compose.prod.yml restart\n"
    : "\n  Restart the runner for this to take effect.\n",
);
process.exit(ok ? 0 : 1);
