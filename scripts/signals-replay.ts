#!/usr/bin/env -S npx tsx
// Judge the swarm's own signals by candle replay, using weeks of logged data.
//
//   DATABASE_URL=... npx tsx scripts/signals-replay.ts                  # last 28 days
//   DATABASE_URL=... npx tsx scripts/signals-replay.ts --days 35 --hold-hours 48
//   DATABASE_URL=... npx tsx scripts/signals-replay.ts --max-events 5000 --export ev.json
//   npx tsx scripts/signals-replay.ts --json ev.json                    # offline
//
// 1. Reads the signals table, keeping the FIRST signal per (symbol, side) in
//    each 2-hour block (a proposal repeats every tick; repeats are one bet).
// 2. Replays each event against public Bybit 1m candles under v1r rules:
//    taker entry at the next 1m open, 2% stop, 4% target, stop-first on an
//    ambiguous candle, time exit after --hold-hours, taker fee + slippage on
//    both legs. The mirrored trade is replayed too (exact direction placebo).
// 3. Puts the results before the Signal Court: all signals, never-traded
//    signals, and each fixed confidence bucket.
//
// Read-only. Credentials never printed. Reports land in court-reports/.
import dns from "node:dns";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { neon } from "@neondatabase/serverless";
import { DEFAULT_RULES } from "../src/lib/court/court";
import { DEFAULT_REPLAY, type ReplayOptions } from "../src/lib/court/replay";
import { runReplay, fetchCandles } from "../src/lib/court/replay-run.server";
import {
  buildSignalDocket,
  signalEvents,
  type SignalRow,
  SIGNAL_BLOCK_MS,
  toReplaySignals,
} from "../src/lib/court/signals";

if (process.env.COURT_FORCE_IPV4 !== "0") {
  dns.setDefaultResultOrder("ipv4first");
  net.setDefaultAutoSelectFamily(false);
}

const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 ? argv[i + 1] : undefined;
};
const DAYS = Number(arg("days") ?? 28);
const HOLD_H = Number(arg("hold-hours") ?? 48);
const MAX_EVENTS = Number(arg("max-events") ?? 20000);

function cleanUrl(raw?: string): string {
  if (!raw) return "";
  let v = raw.trim().replace(/[\u200B-\u200D\uFEFF\r\n]/g, "");
  if (v.startsWith("DATABASE_URL=")) v = v.slice(13).trim();
  if (/^(["'`]).*\1$/.test(v)) v = v.slice(1, -1).trim();
  return v;
}

async function load(): Promise<SignalRow[]> {
  const file = arg("json");
  if (file) return signalEvents(JSON.parse(readFileSync(file, "utf8")) as SignalRow[]);
  const url = cleanUrl(process.env.DATABASE_URL);
  if (!url) {
    console.error("signals-replay: DATABASE_URL is not set (or pass --json <file>).");
    process.exit(1);
  }
  const sql = neon(url);
  const since = new Date(Date.now() - DAYS * 864e5).toISOString();
  const blockSec = SIGNAL_BLOCK_MS / 1000;
  try {
    // One row per (symbol, side, 2h block): the first signal in it.
    const rows = (await sql`
      SELECT DISTINCT ON (symbol, side, floor(extract(epoch FROM created_at) / ${blockSec}))
             id::text, symbol, side, confidence::float8 AS confidence, executed, created_at
        FROM signals
       WHERE created_at >= ${since}
       ORDER BY symbol, side, floor(extract(epoch FROM created_at) / ${blockSec}), created_at ASC`) as Record<
      string,
      unknown
    >[];
    return rows
      .map((r) => ({
        id: String(r.id),
        symbol: String(r.symbol),
        side: String(r.side),
        confidence: Number(r.confidence),
        executed: Boolean(r.executed),
        createdAt: new Date(r.created_at as string).getTime(),
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  } catch (e) {
    console.error(
      `signals-replay: query failed (${String((e as Error).message)
        .split(url)
        .join("<DATABASE_URL>")}).`,
    );
    process.exit(1);
  }
}

let events = await load();
if (!events.length) {
  console.log(`signals-replay: no signals in the last ${DAYS} days.`);
  process.exit(0);
}
if (events.length > MAX_EVENTS) {
  console.log(
    `signals-replay: ${events.length} events; keeping the most recent ${MAX_EVENTS} (--max-events).`,
  );
  events = events.slice(-MAX_EVENTS);
}
if (arg("export")) writeFileSync(arg("export")!, JSON.stringify(events));

const symbols = new Set(events.map((e) => e.symbol)).size;
console.log(
  `signals-replay: ${events.length} signal events on ${symbols} symbols over ${DAYS} days. ` +
    `Fetching candles (≈${Math.ceil(((DAYS * 1440) / 1000) * symbols)} requests)…`,
);

const opt: ReplayOptions = { ...DEFAULT_REPLAY, maxHoldMs: HOLD_H * 3600_000 };
const signals = toReplaySignals(events);
const run = await runReplay(
  signals,
  fetchCandles,
  Date.now(),
  opt,
  // docket depends only on which buckets exist in the input, not outcomes
  buildSignalDocket(
    signals.map((s) => ({
      id: s.signalId,
      symbol: s.symbol,
      side: s.side,
      epoch: "signals",
      sources: s.sources ?? [],
      openedAt: 0,
      closedAt: 0,
      notional: 1,
      grossUsd: 0,
      netUsd: 0,
    })),
  ),
  (done, total, sym) => {
    if (done % 10 === 0) process.stdout.write(`  candles ${done}/${total} (${sym})\n`);
  },
);

const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const L: string[] = [
  "# Signal Court: swarm signals, candle replay",
  "",
  `${run.recorded} signal events (first per symbol/side per 2h, last ${DAYS} days); ${run.replayed} replayed to a result. Exits: ${JSON.stringify(run.exits)}. Not judged: ${JSON.stringify(run.skipped)}.`,
  `Rules: v1r 2% stop / 4% target, taker entry at the next 1m open after the signal, stop-first on ambiguous candles, ${HOLD_H}h time exit, ${(opt.feePerSide * 1e4).toFixed(1)} bps fee + ${(opt.slipPerSide * 1e4).toFixed(1)} bps slippage per leg, funding not modelled. Direction placebo: exact mirrored replay.`,
  "",
  "| hypothesis | verdict | events (episodes) | gross | net | net 95% CI | placebo p disc/hold | PF | win % | detectable edge |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...run.verdicts.map(
    (v) =>
      `| \`${v.id}\` | **${v.verdict}** | ${v.n} (${v.nEpisodes}) | ${f(v.grossBps)} | ${f(v.netBps)} | [${f(v.netCi95[0])}, ${f(v.netCi95[1])}] | ${f(v.pPlaceboDiscovery, 3)} / ${f(v.pPlaceboHoldout, 3)} | ${f(v.profitFactor, 2)} | ${f(100 * v.winRate, 0)} | ${f(v.mdeBps)} bps |`,
  ),
  "",
  ...run.verdicts.flatMap((v) => [
    `**\`${v.id}\`**: ${v.verdict}, ${v.diagnosis}.`,
    ...v.failed.map((x) => `- ${x}`),
    "",
  ]),
  "NOT PROVEN means the evidence doesn't clear the bar, not that there is no edge.",
];
const md = L.join("\n");
mkdirSync("court-reports", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(`court-reports/signals-replay-${stamp}.md`, md);
writeFileSync(
  `court-reports/signals-replay-${stamp}.json`,
  JSON.stringify({ replay: opt, rules: DEFAULT_RULES, ...run, trades: undefined }, null, 2),
);
console.log(md);
console.log(`\nreport: court-reports/signals-replay-${stamp}.md`);
