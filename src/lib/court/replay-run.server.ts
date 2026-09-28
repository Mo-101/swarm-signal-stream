// Shared replay runner: public Bybit candles + the fixed replay rules in
// ./replay, judged by the Signal Court. Used by the replay scripts, the
// runner's court sessions and the dashboard, so all run the same code.
//
// Server/runner only (network I/O). Never writes to the database.
import { type CourtTrade, DEFAULT_RULES, type Hypothesis, judgeAll, type Verdict } from "./court";
import { candleSource } from "./candles.server";
import { docketForSignals, type SignalRow, toReplaySignals } from "./signals";
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
  /** Symbols whose candles could not be fetched (delisted, renamed, not on Bybit). */
  unavailableSymbols: string[];
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

/** Default candle source: retries transient failures and caches closed days
 *  on disk (COURT_CANDLE_CACHE, default .court-cache/candles). */
const defaultSource = candleSource();
export const fetchCandles = (symbol: string, from: number, to: number): Promise<Candle[]> =>
  defaultSource.get(symbol, from, to);
export const candleStats = defaultSource.stats;

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
  const unavailableSymbols: string[] = [];
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
      unavailableSymbols.push(symbol);
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
    unavailableSymbols: unavailableSymbols.sort(),
    defaultBrackets,
    verdicts: judgeAll(trades, docket, DEFAULT_RULES),
    trades,
    ranAt: new Date(now).toISOString(),
  };
}

/**
 * Replay swarm signal events under v1r rules (2% stop, 4% target, taker entry
 * at the next 1m open, `holdHours` time exit) and judge them with the signal
 * docket: all, never-executed, per confidence bucket, per agent.
 */
export async function runSignalReplay(
  events: SignalRow[],
  holdHours = 48,
  onProgress?: (done: number, total: number, symbol: string) => void,
  getCandles: (symbol: string, from: number, to: number) => Promise<Candle[]> = fetchCandles,
  now = Date.now(),
): Promise<ReplayRun & { docket: Hypothesis[]; opt: ReplayOptions }> {
  const opt: ReplayOptions = { ...DEFAULT_REPLAY, maxHoldMs: holdHours * 3600_000 };
  const signals = toReplaySignals(events);
  const docket = docketForSignals(signals);
  const run = await runReplay(signals, getCandles, now, opt, docket, onProgress);
  return { ...run, docket, opt };
}
