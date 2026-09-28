#!/usr/bin/env -S npx tsx
// Maker-entry replay: the one execution test left (builder brief, step 1).
//
//   DATABASE_URL=... npx tsx scripts/maker-replay.ts                    # last 28 days
//   DATABASE_URL=... npx tsx scripts/maker-replay.ts --write            # also store verdicts
//   npx tsx scripts/maker-replay.ts --json ev.json                      # offline
//   DATABASE_URL=... npx tsx scripts/maker-replay.ts --export-only ev.json.gz
//       # just write the signal events (no credentials inside) and stop
//   COURT_CANDLE_SOURCE=archive ...   # build candles from public.bybit.com ticks
//
// Same signal events, same candles, judged in ONE court session:
//   taker: next-1m-open entry, 5.5 bps fee + 2 bps slip per leg (as before)
//   maker: post-only limit at the signal price, 5 min to fill, fills only on a
//          trade-THROUGH (touch is not a fill); stop checked on the fill candle;
//          TP rests (maker 2 bps, needs trade-through); stop/time exits cross
//          (taker 5.5 + 2 slip). No rebates. Mirror uses the same fill rule.
//
// Decision rule, fixed before the run: if `signals:maker:conf:>=0.80` is not
// CONVICTED, the halt stands and there is nothing left to build.
//
// Prior header kept below for the shared mechanics:
//
// 1. Reads the signals table, keeping the FIRST signal per (symbol, side) in
//    each 2-hour block (a proposal repeats every tick; repeats are one bet).
// 2. Replays each event against public Bybit 1m candles under v1r rules:
//    taker entry at the next 1m open, 2% stop, 4% target, stop-first on an
//    ambiguous candle, time exit after --hold-hours, taker fee + slippage on
//    both legs. The mirrored trade is replayed too (exact direction placebo).
// 3. Puts the results before the Signal Court: all signals, never-traded
//    signals, each fixed confidence bucket, and each agent's votes.
//
// Candles are cached per closed UTC day (COURT_CANDLE_CACHE, default
// .court-cache/candles), so a re-run only downloads what is new.
//
// Read-only unless --write (appends to court_verdicts only). Credentials never printed. Reports land in court-reports/.
import dns from "node:dns";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import net from "node:net";
import { DEFAULT_RULES } from "../src/lib/court/court";
import { candleStats, runMakerComparison } from "../src/lib/court/replay-run.server";
import { loadSignalEvents, recordVerdicts } from "../src/lib/court/store.server";
import { signalEvents, type SignalRow } from "../src/lib/court/signals";

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
const MAX_EVENTS = Number(arg("max-events") ?? 1_000_000); // judge every event by default

function cleanUrl(raw?: string): string {
  if (!raw) return "";
  let v = raw.trim().replace(/[\u200B-\u200D\uFEFF\r\n]/g, "");
  if (v.startsWith("DATABASE_URL=")) v = v.slice(13).trim();
  if (/^(["'`]).*\1$/.test(v)) v = v.slice(1, -1).trim();
  return v;
}

async function load(): Promise<SignalRow[]> {
  const file = arg("json");
  if (file) {
    const raw = readFileSync(file);
    const text = file.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
    return signalEvents(JSON.parse(text) as SignalRow[]);
  }
  const url = cleanUrl(process.env.DATABASE_URL);
  if (!url) {
    console.error("maker-replay: DATABASE_URL is not set (or pass --json <file>).");
    process.exit(1);
  }
  process.env.DATABASE_URL = url;
  try {
    return await loadSignalEvents(null, DAYS, Date.now(), (i, total, n) => {
      if (i % 7 === 0 || i === total)
        process.stdout.write(`  signals day ${i}/${total}: ${n} events\n`);
    });
  } catch (e) {
    console.error(
      `maker-replay: query failed (${String((e as Error).message)
        .split(url)
        .join("<DATABASE_URL>")}).`,
    );
    process.exit(1);
  }
}

let events = await load();
const exportTo = arg("export-only");
if (exportTo) {
  const body = JSON.stringify(events);
  writeFileSync(exportTo, exportTo.endsWith(".gz") ? gzipSync(body) : body);
  console.log(
    `maker-replay: wrote ${events.length} signal events to ${exportTo}. Nothing else run.`,
  );
  process.exit(0);
}
if (!events.length) {
  console.log(`maker-replay: no signals in the last ${DAYS} days.`);
  process.exit(0);
}
if (events.length > MAX_EVENTS) {
  console.log(`maker-replay: ${events.length} events; keeping the most recent ${MAX_EVENTS}.`);
  events = events.slice(-MAX_EVENTS);
}
const priced = events.filter((e) => e.price && e.price > 0).length;
console.log(
  `maker-replay: ${events.length} signal events (${priced} with a signal price) on ${new Set(events.map((e) => e.symbol)).size} symbols. Fetching candles…`,
);

const run = await runMakerComparison(events, HOLD_H, undefined, Date.now(), (done, total, sym) => {
  if (done % 10 === 0) process.stdout.write(`  candles ${done}/${total} (${sym})\n`);
});
console.log(
  `  candle days: ${candleStats.fetchedDays} fetched, ${candleStats.cachedDays} from cache`,
);

const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const rows = run.verdicts.map((v) => {
  const c = run.costs[v.id];
  const fl = run.fills[v.id];
  return `| \`${v.id}\` | **${v.verdict}** | ${v.n} (${v.nEpisodes}) | ${fl ? `${f(100 * fl.rate, 0)}% of ${fl.tried}` : "taker"} | ${f(v.grossBps)} | ${c ? f(c.feeBps) : "n/a"} | ${c ? f(c.slipBps) : "n/a"} | ${f(v.netBps)} | [${f(v.netCi95[0])}, ${f(v.netCi95[1])}] | ${f(v.pPlaceboDiscovery, 3)} / ${f(v.pPlaceboHoldout, 3)} | ${f(v.profitFactor, 2)} | ${c ? JSON.stringify(c.exits) : ""} |`;
});
const key = run.verdicts.find((v) => v.id === "signals:maker:conf:>=0.80");
const answer = !key
  ? "ANSWER: `signals:maker:conf:>=0.80` could not be judged (no filled trades). The halt stands."
  : key.verdict === "CONVICTED"
    ? "ANSWER: `signals:maker:conf:>=0.80` is CONVICTED with conservative maker fills. A different story can be told; next is the random-direction control (brief step 2), still no money in until that is read."
    : `ANSWER: \`signals:maker:conf:>=0.80\` is ${key.verdict}. Maker entry does not clear the court. The halt is the correct outcome; stop here.`;
const L = [
  "# Signal Court: maker vs taker entry",
  "",
  answer,
  "",
  `${run.events} signal events, last ${DAYS} days, ${HOLD_H}h time exit, 2% stop / 4% target.${run.unavailableSymbols.length ? ` No candles: ${run.unavailableSymbols.join(", ")}.` : ""}`,
  "Costs are bps of notional per round trip, averaged over judged trades. Gross/net likewise.",
  "",
  "| hypothesis | verdict | trades (episodes) | fill rate | gross | fees | slippage | net | net 95% CI | placebo p disc/hold | PF | exits |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...rows,
  "",
  ...run.verdicts.flatMap((v) => [
    `**\`${v.id}\`**: ${v.verdict}, ${v.diagnosis}.`,
    ...v.failed.map((x) => `- ${x}`),
    "",
  ]),
  "Fill rate below ~100% means the maker set is a subset of the taker set: the signals price ran away from are missing, which is the adverse selection being measured.",
];
const md = L.join("\n");
mkdirSync("court-reports", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(`court-reports/maker-replay-${stamp}.md`, md);
writeFileSync(
  `court-reports/maker-replay-${stamp}.json`,
  JSON.stringify({ rules: DEFAULT_RULES, ...run }, null, 2),
);
console.log(md);
console.log(`\nreport: court-reports/maker-replay-${stamp}.md`);

if (argv.includes("--write")) {
  const url = cleanUrl(process.env.DATABASE_URL);
  if (!url) {
    console.error("maker-replay: --write needs DATABASE_URL.");
    process.exit(1);
  }
  process.env.DATABASE_URL = url;
  const r = await recordVerdicts(run.verdicts, run.docket);
  console.log(`maker-replay: wrote ${r.written} verdicts to Neon.`);
  if (r.refused.length) {
    console.error(
      `maker-replay: REFUSED ${r.refused.join(", ")} (registered under different rules).`,
    );
    process.exit(2);
  }
}
