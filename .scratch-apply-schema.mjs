import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = neon(url, { fullResults: true });

const text = readFileSync(process.argv[2], "utf8");

// Split on statement-terminating semicolons that are NOT inside a $$ ... $$
// dollar-quoted body (the edge_report function contains its own semicolons).
function splitStatements(src) {
  const statements = [];
  let cur = "";
  let inDollar = false;
  for (let i = 0; i < src.length; i++) {
    const two = src.slice(i, i + 2);
    if (two === "$$") {
      inDollar = !inDollar;
      cur += two;
      i++;
      continue;
    }
    const ch = src[i];
    cur += ch;
    if (ch === ";" && !inDollar) {
      const trimmed = cur.trim();
      if (trimmed) statements.push(trimmed);
      cur = "";
    }
  }
  const rest = cur.trim();
  if (rest) statements.push(rest);
  return statements;
}

const statements = splitStatements(text).filter(
  (s) => !s.startsWith("--") && s.replace(/--.*$/gm, "").trim().length > 0,
);

for (const stmt of statements) {
  const label = stmt.slice(0, 60).replace(/\n/g, " ");
  process.stdout.write(`Running: ${label}...`);
  await sql(stmt);
  console.log(" OK");
}

const res = await sql(
  "select table_name from information_schema.tables where table_schema='public' order by 1",
);
console.log("Tables:", res.rows.map((r) => r.table_name).join(", "));
