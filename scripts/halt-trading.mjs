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
// IMPORTANT — the engine must be STOPPED while the flag is set.
//
// The broker reads `halted` at BOOT (hydrate), and persistCloseTrade writes its
// in-memory `halted` back on EVERY close:
//
//   INSERT INTO paper_accounts (..., halted, ...) ON CONFLICT DO UPDATE
//     SET ... halted = EXCLUDED.halted
//
// So setting the flag against a RUNNING engine is silently reverted by the next
// close — the value is overwritten with the in-memory `false` before any
// restart can read it. A plain `docker compose restart` therefore does NOT
// work: the flag is usually already gone by the time the process comes back.
//
// The correct sequence is stop, set, start:
//
//   docker compose -f docker-compose.prod.yml stop
//   DATABASE_URL=... node scripts/halt-trading.mjs --halt "reason"
//   docker compose -f docker-compose.prod.yml start
//
// Verified in production: with the engine stopped the flag holds, and on start
// every entry logs "[risk] halted blocked ... Risk halt active". The same
// applies in reverse for --resume.
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

// Compare-and-set against the value we read a moment ago. paper_accounts has
// more than one writer — the runner, and the dashboard's own engine whenever
// the runner heartbeat is >60s stale — so a blind UPDATE can race with a trade
// close and lose. Guarding on the observed value means a concurrent change
// fails LOUDLY here instead of silently winning and leaving a flag that reads
// correct but is about to be overwritten.
const observed = rows.find((r) => String(r.user_id) === String(targetUser))?.halted;
const updated = await sql`
  UPDATE paper_accounts SET halted = ${target}, updated_at = now()
   WHERE user_id = ${targetUser} AND halted = ${observed}
   RETURNING user_id, halted`;

if (updated.length === 0) {
  // Either it already holds the target value, or something moved underneath us.
  const now = await sql`SELECT halted FROM paper_accounts WHERE user_id = ${targetUser}`;
  const current = now[0]?.halted;
  if (current === target) {
    console.log(`\nAlready ${mode === "halt" ? "halted" : "resumed"} — no change needed.\n`);
    process.exit(0);
  }
  console.error(
    `\nhalt-trading: CONCURRENT WRITE — the flag changed while this ran.\n` +
      `  expected ${observed}, found ${current}. Nothing was written.\n` +
      `  Stop the engine (and close any dashboard tab, which trades when the\n` +
      `  runner heartbeat is stale) before retrying.\n`,
  );
  process.exit(1);
}

const after = await sql`SELECT user_id, halted FROM paper_accounts WHERE user_id = ${targetUser}`;
const ok = after.length === 1 && after.every((r) => r.halted === target);

console.log(`\n${mode === "halt" ? "HALTED" : "RESUMED"}${note ? ` — ${note}` : ""}`);
console.log(`  rows updated : ${after.length}`);
console.log(`  verified     : ${ok ? "yes" : "NO — flag did not stick"}`);
console.log(
  mode === "halt"
    ? "\n  Open positions are NOT closed; they continue to manage to their exits.\n\n" +
        "  This flag only sticks if the engine was ALREADY STOPPED. A running\n" +
        "  engine rewrites halted on every close, so a plain `restart` loses it.\n" +
        "  If the engine is running right now, do:\n" +
        "    docker compose stop  ->  re-run this --halt  ->  docker compose start\n\n" +
        "  Confirm with: [risk] halted blocked ... Risk halt active   in the logs.\n"
    : "\n  Same rule in reverse: set this with the engine STOPPED, then start it,\n" +
        "  or the next close will revert the flag before boot can read it.\n",
);
process.exit(ok ? 0 : 1);
