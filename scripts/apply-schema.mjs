#!/usr/bin/env node
// Idempotent Neon schema apply.
//
//   node scripts/apply-schema.mjs src/lib/db/schema.sql
//
// Safe to run on every deploy: every statement in schema.sql is written with
// IF NOT EXISTS / CREATE OR REPLACE. Never prints DATABASE_URL or any other
// credential — only statement counts and object names.
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const file = process.argv[2] ?? "src/lib/db/schema.sql";

// Clean and validate BEFORE the driver sees it. neon() embeds the whole
// connection string in its "not a valid URL" error, so handing it a quoted or
// CR-terminated value — exactly what a .env written on Windows produces —
// prints the password to the terminal and into any CI log or pasted traceback.
// Same normalisation as src/lib/db/neon.ts getDatabaseUrl().
function cleanDatabaseUrl(raw) {
  if (!raw) return "";
  let v = String(raw).trim().replace(/[​-‍﻿\r\n]/g, "");
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
if (url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error("scheme must be postgres:// or postgresql://");
    }
  } catch (e) {
    // Never interpolate the URL itself into this message.
    console.error(`apply-schema: DATABASE_URL is not a usable connection string (${e.message}).`);
    process.exit(1);
  }
}

if (!url || !url.trim()) {
  console.log("apply-schema: skipped — DATABASE_URL not set (Neon not configured).");
  process.exit(0);
}

/**
 * Split a Postgres script into statements. Semicolons only terminate a
 * statement when outside single quotes, double quotes, line/block comments
 * and dollar-quoted bodies ($$ ... $$ or $tag$ ... $tag$).
 */
function splitStatements(src) {
  const out = [];
  let cur = "";
  let i = 0;
  let dollarTag = null;

  while (i < src.length) {
    const ch = src[i];
    const two = src.slice(i, i + 2);

    if (dollarTag) {
      if (src.startsWith(dollarTag, i)) {
        cur += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }

    // line comment
    if (two === "--") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl + 1;
      cur += "\n";
      continue;
    }
    // block comment
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      cur += " ";
      continue;
    }
    // dollar quote open
    if (ch === "$") {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(src.slice(i));
      if (m) {
        dollarTag = m[0];
        cur += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    // string / quoted identifier
    if (ch === "'" || ch === '"') {
      const quote = ch;
      cur += ch;
      i++;
      while (i < src.length) {
        if (src[i] === quote && src[i + 1] === quote) {
          cur += quote + quote;
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          cur += quote;
          i++;
          break;
        }
        cur += src[i];
        i++;
      }
      continue;
    }

    if (ch === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      i++;
      continue;
    }

    cur += ch;
    i++;
  }

  if (cur.trim()) out.push(cur.trim());
  return out;
}

const statements = splitStatements(readFileSync(file, "utf8")).filter(
  (s) => s.replace(/\s+/g, " ").trim().length > 0,
);

if (process.env.DRY_RUN === "1") {
  console.log(`apply-schema: parsed ${statements.length} statements from ${file} (dry run).`);
  process.exit(0);
}

const sql = neon(url, { fullResults: true });

let applied = 0;
let failed = 0;
for (const stmt of statements) {
  const label = stmt.replace(/\s+/g, " ").slice(0, 70);
  try {
    await sql(stmt);
    applied++;
  } catch (e) {
    failed++;
    // Message text only; never the connection string.
    console.error(`apply-schema: FAILED [${label}] — ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(`apply-schema: applied ${applied}/${statements.length} statements from ${file}.`);

// Hard requirement: the dashboard's edge report depends on this function.
const check = await sql(
  `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'edge_report'`,
);
if (!check.rows.length) {
  console.error("apply-schema: FATAL — public.edge_report(uuid, text) is missing after apply.");
  process.exit(1);
}
console.log("apply-schema: verified public.edge_report is present.");

if (failed) {
  console.error(`apply-schema: ${failed} statement(s) failed — review the messages above.`);
  process.exit(1);
}
