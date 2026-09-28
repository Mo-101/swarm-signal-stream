// Shared SigmaLui replay runner: public Bybit candles + the fixed replay rules
// in ./replay, judged by the Signal Court. Used by scripts/sigmalui-replay.ts
// and by the dashboard's Court tab, so both always run the same code.
//
// Server/runner only (network I/O). Never writes to the database.
import { type CourtTrade, DEFAULT_RULES, type Hypothesis, judgeAll, type Verdict } from "./court";
import {
  type Candle,
  DEFAULT_REPLAY,
  type ReplayOptions,
  replaySignal,
  type ReplaySignal,
} from "./replay";

const M = 60_000;

export interface ReplayRun {
  recorded: number;
  replayed: number;
  exits: Record<string, number>;
  skipped: Record<string, number>;
  defaultBrackets: number;
  verdicts: Verdict[];
  trades: CourtTrade[];
  ranAt: string;
}

export const REPLAY_DOCKET: Hypothesis[] = [
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

/** Public Bybit linear 1m candles over [from, to), paged 1000 at a time. */
export async function fetchCandles(symbol: string, from: number, to: number): Promise<Candle[]> {
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

export async function runReplay(
  signals: ReplaySignal[],
  getCandles: (symbol: string, from: number, to: number) => Promise<Candle[]> = fetchCandles,
  now = Date.now(),
  opt: ReplayOptions = DEFAULT_REPLAY,
  docket: Hypothesis[] = REPLAY_DOCKET,
  onProgress?: (done: number, total: number, symbol: string) => void,
): Promise<ReplayRun> {
  const bySymbol = new Map<string, ReplaySignal[]>();
  for (const s of signals) {
    const list = bySymbol.get(s.symbol);
    if (list) list.push(s);
    else bySymbol.set(s.symbol, [s]);
  }

  const trades: CourtTrade[] = [];
  const skipped: Record<string, number> = {};
  const exits: Record<string, number> = {};
  let defaultBrackets = 0;
  let done = 0;
  for (const [symbol, list] of bySymbol) {
    onProgress?.(done++, bySymbol.size, symbol);
    const from = Math.min(...list.map((s) => s.firstSeenAt));
    const to = Math.min(now, Math.max(...list.map((s) => s.firstSeenAt)) + opt.maxHoldMs + 2 * M);
    let ks: Candle[];
    try {
      ks = await getCandles(symbol, from, to);
    } catch {
      skipped["candles unavailable"] = (skipped["candles unavailable"] ?? 0) + list.length;
      continue;
    }
    for (const s of list) {
      const r = replaySignal(s, ks, opt);
      if (!r.ok) {
        skipped[r.why] = (skipped[r.why] ?? 0) + 1;
        continue;
      }
      trades.push(r.trade);
      exits[r.reason] = (exits[r.reason] ?? 0) + 1;
      if (r.defaultBrackets) defaultBrackets++;
    }
  }

  return {
    recorded: signals.length,
    replayed: trades.length,
    exits,
    skipped,
    defaultBrackets,
    verdicts: judgeAll(trades, docket, DEFAULT_RULES),
    trades,
    ranAt: new Date(now).toISOString(),
  };
}
