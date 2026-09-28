#!/usr/bin/env -S npx tsx
// Judge the SigmaLui feed by candle replay, without waiting for trades.
//
//   DATABASE_URL=... npx tsx scripts/sigmalui-replay.ts              # read-only verdicts
//   DATABASE_URL=... npx tsx scripts/sigmalui-replay.ts --since 2026-09-28
//   npx tsx scripts/sigmalui-replay.ts --json signals.json           # offline, exported signals
//
// Reads sigmalui_signals (written by the runner for every distinct feed signal),
// fetches public Bybit 1-minute candles, replays each signal under the fixed
// rules in src/lib/court/replay.ts, and puts the results before the Signal
// Court. Read-only: nothing is written to the database. Credentials never printed.
import dns from "node:dns";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { neon } from "@neondatabase/serverless";
import { type CourtTrade, DEFAULT_RULES, type Hypothesis, judgeAll } from "../src/lib/court/court";
import {
  type Candle,
  DEFAULT_REPLAY,
  replaySignal,
  type ReplaySignal,
} from "../src/lib/court/replay";

if (process.env.COURT_FORCE_IPV4 !== "0") {
  dns.setDefaultResultOrder("ipv4first");
  net.setDefaultAutoSelectFamily(false);
}

const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 ? argv[i + 1] : undefined;
};
const M = 60_000;

async function loadSignals(): Promise<ReplaySignal[]> {
  const file = arg("json");
  if (file) return JSON.parse(readFileSync(file, "utf8")) as ReplaySignal[];
  let url = (process.env.DATABASE_URL ?? "").trim().replace(/[\u200B-\u200D\uFEFF\r\n]/g, "");
  if (url.startsWith("DATABASE_URL=")) url = url.slice(13).trim();
  if (/^(["'`]).*\1$/.test(url)) url = url.slice(1, -1).trim();
  if (!url) {
    console.error("replay: DATABASE_URL is not set (or pass --json <file>).");
    process.exit(1);
  }
  const since = arg("since") ? new Date(arg("since")!).toISOString() : "1970-01-01T00:00:00Z";
  try {
    const rows = (await neon(url)`
      SELECT signal_id, symbol, side, score::float8 AS score, entry_price::float8 AS entry,
             stop_loss::float8 AS sl, take_profit::float8 AS tp, first_seen_at, admitted
        FROM sigmalui_signals
       WHERE first_seen_at >= ${since}
       ORDER BY first_seen_at ASC`) as Record<string, unknown>[];
    return rows.map((r) => ({
      signalId: String(r.signal_id),
      symbol: String(r.symbol),
      side: r.side === "SELL" ? "SELL" : "BUY",
      score: r.score == null ? null : Number(r.score),
      entry: r.entry == null ? null : Number(r.entry),
      stopLoss: r.sl == null ? null : Number(r.sl),
      takeProfit: r.tp == null ? null : Number(r.tp),
      firstSeenAt: new Date(r.first_seen_at as string).getTime(),
      admitted: Boolean(r.admitted),
    }));
  } catch (e) {
    console.error(
      `replay: query failed (${String((e as Error).message)
        .split(url)
        .join("<DATABASE_URL>")}).`,
    );
    process.exit(1);
  }
}

/** Public Bybit linear 1m candles over [from, to), paged 1000 at a time. */
async function candles(symbol: string, from: number, to: number): Promise<Candle[]> {
  const out = new Map<number, Candle>();
  for (let start = Math.floor(from / M) * M; start < to; start += 1000 * M) {
    const end = Math.min(start + 1000 * M - 1, to);
    const u = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=1&start=${start}&end=${end}&limit=1000`;
    const res = await fetch(u, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`kline HTTP ${res.status} for ${symbol}`);
    const body = (await res.json()) as {
      retCode: number;
      retMsg: string;
      result?: { list?: string[][] };
    };
    if (body.retCode !== 0) throw new Error(`kline ${symbol}: ${body.retMsg}`);
    for (const k of body.result?.list ?? []) {
      const t = Number(k[0]);
      out.set(t, { t, o: +k[1], h: +k[2], l: +k[3], c: +k[4] });
    }
    await new Promise((r) => setTimeout(r, 120)); // stay well under public rate limits
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

const signals = await loadSignals();
if (!signals.length) {
  console.log(
    "replay: no SigmaLui signals recorded yet. The runner writes them as the feed emits; check back later.",
  );
  process.exit(0);
}

const now = Date.now();
const bySymbol = new Map<string, ReplaySignal[]>();
for (const s of signals)
  (bySymbol.get(s.symbol) ?? bySymbol.set(s.symbol, []).get(s.symbol)!).push(s);

const trades: CourtTrade[] = [];
const skipped: Record<string, number> = {};
let defaults = 0;
const reasons: Record<string, number> = {};
for (const [symbol, list] of bySymbol) {
  const from = Math.min(...list.map((s) => s.firstSeenAt));
  const to = Math.min(
    now,
    Math.max(...list.map((s) => s.firstSeenAt)) + DEFAULT_REPLAY.maxHoldMs + 2 * M,
  );
  let ks: Candle[];
  try {
    ks = await candles(symbol, from, to);
  } catch (e) {
    skipped[`candles unavailable (${symbol})`] = list.length;
    console.warn(`replay: ${(e as Error).message}`);
    continue;
  }
  for (const s of list) {
    const r = replaySignal(s, ks);
    if (!r.ok) {
      skipped[r.why] = (skipped[r.why] ?? 0) + 1;
      continue;
    }
    trades.push(r.trade);
    reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
    if (r.defaultBrackets) defaults++;
  }
}

const docket: Hypothesis[] = [
  {
    id: "sigmalui:all",
    claim: "Every SigmaLui signal, replayed, has a net edge",
    select: () => true,
  },
  {
    id: "sigmalui:admitted",
    claim:
      "SigmaLui signals our ingester admits (score ≥ 0.94, tracked, off cooldown) have a net edge",
    select: (t) => t.sources.includes("admitted"),
  },
  {
    id: "sigmalui:not-admitted",
    claim: "SigmaLui signals our ingester rejects have a net edge",
    select: (t) => t.sources.includes("not-admitted"),
  },
];
const verdicts = judgeAll(trades, docket, DEFAULT_RULES);

const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const L: string[] = [
  "# Signal Court: SigmaLui candle replay",
  "",
  `${signals.length} recorded signals; ${trades.length} replayed to a result. Exits: ${JSON.stringify(reasons)}.`,
  `Not judged: ${JSON.stringify(skipped)}. Default 2%/4% brackets used for ${defaults} signals missing a stop or target.`,
  `Entry at the next 1m open after first sight; ${(DEFAULT_REPLAY.feePerSide * 1e4).toFixed(1)} bps taker + ${(DEFAULT_REPLAY.slipPerSide * 1e4).toFixed(1)} bps slippage per leg; funding not modelled; max hold ${DEFAULT_REPLAY.maxHoldMs / 3600_000}h. Direction placebo uses the exact mirrored replay.`,
  "",
  "| hypothesis | verdict | signals (episodes) | gross | net | net 95% CI | placebo p disc/hold | PF | win % | detectable edge |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...verdicts.map(
    (v) =>
      `| \`${v.id}\` | **${v.verdict}** | ${v.n} (${v.nEpisodes}) | ${f(v.grossBps)} | ${f(v.netBps)} | [${f(v.netCi95[0])}, ${f(v.netCi95[1])}] | ${f(v.pPlaceboDiscovery, 3)} / ${f(v.pPlaceboHoldout, 3)} | ${f(v.profitFactor, 2)} | ${f(100 * v.winRate, 0)} | ${f(v.mdeBps)} bps |`,
  ),
  "",
  ...verdicts.flatMap((v) => [
    `**\`${v.id}\`**: ${v.verdict}, ${v.diagnosis}.`,
    ...v.failed.map((x) => `- ${x}`),
    "",
  ]),
  "NOT PROVEN means the evidence doesn't clear the bar yet, not that there is no edge.",
];
const md = L.join("\n");
mkdirSync("court-reports", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(`court-reports/sigmalui-replay-${stamp}.md`, md);
writeFileSync(
  `court-reports/sigmalui-replay-${stamp}.json`,
  JSON.stringify(
    { replay: DEFAULT_REPLAY, rules: DEFAULT_RULES, skipped, reasons, verdicts, trades },
    null,
    2,
  ),
);
console.log(md);
console.log(`\nreport: court-reports/sigmalui-replay-${stamp}.md`);
