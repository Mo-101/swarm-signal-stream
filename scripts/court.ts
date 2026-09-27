#!/usr/bin/env -S npx tsx
// Signal Court: does any strategy epoch or signal source have a proven edge?
//
//   DATABASE_URL=... npx tsx scripts/court.ts                 # read-only verdicts
//   DATABASE_URL=... npx tsx scripts/court.ts --export t.json # also dump the trades judged
//   npx tsx scripts/court.ts --json t.json                    # judge an exported file offline
//   DATABASE_URL=... npx tsx scripts/court.ts --write         # persist registry + verdicts to Neon
//
// Read-only unless --write. Credentials never printed.
//
// Every hypothesis on the docket is presumed to have NO edge until it answers
// every charge in src/lib/court/court.ts. Reports land in court-reports/.
import { createHash } from "node:crypto";
import dns from "node:dns";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { neon } from "@neondatabase/serverless";
import {
  buildDocket,
  type CourtTrade,
  DEFAULT_RULES,
  judgeAll,
  type Verdict,
} from "../src/lib/court/court";

if (process.env.COURT_FORCE_IPV4 !== "0") {
  dns.setDefaultResultOrder("ipv4first");
  net.setDefaultAutoSelectFamily(false);
}

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 ? argv[i + 1] : undefined;
};

function cleanUrl(raw?: string): string {
  if (!raw) return "";
  let v = raw.trim().replace(/[\u200B-\u200D\uFEFF\r\n]/g, "");
  if (v.startsWith("DATABASE_URL=")) v = v.slice(13).trim();
  if (/^(["'`]).*\1$/.test(v)) v = v.slice(1, -1).trim();
  return v;
}

interface Loaded {
  trades: CourtTrade[];
  costUnrecorded: number;
  source: string;
}

async function load(): Promise<Loaded> {
  const file = arg("json");
  if (file) {
    const trades = JSON.parse(readFileSync(file, "utf8")) as CourtTrade[];
    return { trades, costUnrecorded: -1, source: file };
  }
  const url = cleanUrl(process.env.DATABASE_URL);
  if (!url) {
    console.error("court: DATABASE_URL is not set (or pass --json <file>).");
    process.exit(1);
  }
  const scrub = (s: string) => s.split(url).join("<DATABASE_URL>");
  try {
    const sql = neon(url);
    const rows = (await sql`
      SELECT id::text, symbol, side, strategy_epoch, agents, opened_at, closed_at,
             notional::float8 AS notional, gross_pnl::float8 AS gross, pnl::float8 AS net,
             coalesce(fees, 0)::float8 AS fees, coalesce(funding, 0)::float8 AS funding
        FROM paper_trades
       WHERE status = 'closed' AND pnl IS NOT NULL AND closed_at IS NOT NULL
       ORDER BY closed_at ASC`) as Record<string, unknown>[];
    let costUnrecorded = 0;
    const trades = rows.map((r) => {
      const gross = r.gross == null ? Number(r.net) : Number(r.gross);
      if (Number(r.fees) === 0 && Number(r.funding) === 0) costUnrecorded++;
      return {
        id: String(r.id),
        symbol: String(r.symbol),
        side: String(r.side),
        epoch: String(r.strategy_epoch ?? "v1"),
        sources: Object.keys((r.agents as Record<string, unknown>) ?? {}),
        openedAt: new Date(r.opened_at as string).getTime(),
        closedAt: new Date(r.closed_at as string).getTime(),
        notional: Number(r.notional),
        grossUsd: gross,
        netUsd: Number(r.net),
      } satisfies CourtTrade;
    });
    return { trades, costUnrecorded, source: "neon:paper_trades" };
  } catch (e) {
    console.error(`court: query failed (${scrub(String((e as Error).message))}).`);
    process.exit(1);
  }
}

const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");

function report(
  v: Verdict[],
  meta: { n: number; source: string; costUnrecorded: number; digests: Record<string, string> },
): string {
  const L: string[] = [];
  L.push(`# Signal Court: alpha-swarm verdicts`, "");
  L.push(`Judged ${meta.n} closed trades from \`${meta.source}\` on ${new Date().toISOString()}.`);
  L.push(
    `Docket: ${v.length} hypotheses (each counts as a trial). Units: bps of entry notional, net of fees and funding.`,
  );
  if (meta.costUnrecorded > 0)
    L.push(
      `Warning: ${meta.costUnrecorded} trades have no recorded fees or funding (legacy rows). Their gross equals net, which flatters cost analysis for those trades.`,
    );
  L.push("");
  L.push(
    "| hypothesis | verdict | trades (episodes) | gross | costs | net | net 95% CI | holdout net | placebo p disc/hold | t / luck bar | DSR | folds + | PF | win % |",
  );
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const x of v)
    L.push(
      `| \`${x.id}\` | **${x.verdict}** | ${x.n} (${x.nEpisodes}) | ${fmt(x.grossBps)} | ${fmt(x.costBps)} | ${fmt(x.netBps)} | [${fmt(x.netCi95[0])}, ${fmt(x.netCi95[1])}] | ${fmt(x.netBpsHoldout)} | ${fmt(x.pPlaceboDiscovery, 3)} / ${fmt(x.pPlaceboHoldout, 3)} | ${fmt(x.t, 2)} / ${fmt(x.t0, 2)} | ${fmt(x.dsr, 2)} | ${x.positiveFolds}/5 | ${fmt(x.profitFactor, 2)} | ${fmt(100 * x.winRate, 0)} |`,
    );
  L.push("", "## Readings", "");
  for (const x of v) {
    L.push(`**\`${x.id}\`** (${x.claim}): ${x.verdict}, ${x.diagnosis}.`);
    L.push(
      `Smallest edge this sample could detect: ${fmt(x.mdeBps)} bps. Registry digest \`${meta.digests[x.id]}\`.`,
    );
    for (const f of x.failed) L.push(`- ${f}`);
    L.push("");
  }
  L.push(
    "NOT PROVEN means the evidence doesn't clear the bar. It doesn't mean there is no edge; see the detectable-edge figure.",
  );
  return L.join("\n");
}

const { trades, costUnrecorded, source } = await load();
if (arg("export")) writeFileSync(arg("export")!, JSON.stringify(trades));

const docket = buildDocket(trades);
const digests = Object.fromEntries(
  docket.map((h) => [
    h.id,
    createHash("sha256")
      .update(JSON.stringify({ id: h.id, claim: h.claim, rules: DEFAULT_RULES }))
      .digest("hex")
      .slice(0, 16),
  ]),
);
const verdicts = judgeAll(trades, docket, DEFAULT_RULES);
const md = report(verdicts, { n: trades.length, source, costUnrecorded, digests });

mkdirSync("court-reports", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(`court-reports/court-${stamp}.md`, md);
writeFileSync(
  `court-reports/court-${stamp}.json`,
  JSON.stringify({ source, rules: DEFAULT_RULES, digests, verdicts }, null, 2),
);
console.log(md);
console.log(`\nreport: court-reports/court-${stamp}.md`);

if (flag("write")) {
  const url = cleanUrl(process.env.DATABASE_URL);
  if (!url) {
    console.error("court: --write needs DATABASE_URL.");
    process.exit(1);
  }
  const sql = neon(url);
  for (const h of docket) {
    await sql`INSERT INTO court_registry (id, claim, digest) VALUES (${h.id}, ${h.claim}, ${digests[h.id]})
              ON CONFLICT (id) DO NOTHING`;
    const [row] = (await sql`SELECT digest FROM court_registry WHERE id = ${h.id}`) as {
      digest: string;
    }[];
    if (row.digest !== digests[h.id]) {
      console.error(
        `court: '${h.id}' is registered as ${row.digest}, now ${digests[h.id]}. The rules changed after registration; refusing to write.`,
      );
      process.exit(2);
    }
  }
  for (const x of verdicts) {
    await sql`INSERT INTO court_verdicts (hypothesis_id, digest, verdict, diagnosis, n_trades, net_bps, net_ci_low, net_ci_high, dsr, detail)
              VALUES (${x.id}, ${digests[x.id]}, ${x.verdict}, ${x.diagnosis}, ${x.n}, ${x.netBps}, ${x.netCi95[0]}, ${x.netCi95[1]}, ${x.dsr}, ${JSON.stringify(x)}::jsonb)`;
  }
  console.log(`court: wrote ${verdicts.length} verdicts to Neon.`);
}
