// Shared replay runner: public Bybit candles + the fixed replay rules in
// ./replay, judged by the Signal Court. Used by the replay scripts, the
// runner's court sessions and the dashboard, so all run the same code.
//
// Server/runner only (network I/O). Never writes to the database.
import { type CourtTrade, DEFAULT_RULES, type Hypothesis, judgeAll, type Verdict } from "./court";
import { candleSource } from "./candles.server";
import { DEFAULT_MAKER, type MakerOptions, replayMaker } from "./maker";
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
  adjustDocket: (d: Hypothesis[]) => Hypothesis[] = (d) => d,
): Promise<ReplayRun & { docket: Hypothesis[]; opt: ReplayOptions }> {
  const opt: ReplayOptions = { ...DEFAULT_REPLAY, maxHoldMs: holdHours * 3600_000 };
  const signals = toReplaySignals(events);
  const docket = adjustDocket(docketForSignals(signals));
  const run = await runReplay(signals, getCandles, now, opt, docket, onProgress);
  return { ...run, docket, opt };
}

export interface MakerComparison {
  events: number;
  verdicts: Verdict[];
  docket: Hypothesis[];
  /** Per maker hypothesis: signals tried, filled, fill rate. */
  fills: Record<string, { tried: number; filled: number; rate: number }>;
  /** Per hypothesis: average fee and slippage paid, bps of notional. */
  costs: Record<string, { feeBps: number; slipBps: number; exits: Record<string, number> }>;
  unavailableSymbols: string[];
  ranAt: string;
}

/** The maker docket, declared before any outcome. */
export const MAKER_DOCKET: Hypothesis[] = [
  {
    id: "signals:maker:all",
    claim: "Swarm signals entered as post-only limits (conservative fills) have a net edge",
    select: (t) => t.epoch === "signals-maker",
  },
  {
    id: "signals:maker:conf:>=0.80",
    claim: "Swarm signals with confidence >=0.80, entered as post-only limits, have a net edge",
    select: (t) => t.epoch === "signals-maker" && t.sources.includes("maker:conf:>=0.80"),
  },
  {
    id: "signals:maker:conf:0.70-0.80",
    claim: "Swarm signals with confidence 0.70-0.80, entered as post-only limits, have a net edge",
    select: (t) => t.epoch === "signals-maker" && t.sources.includes("maker:conf:0.70-0.80"),
  },
];

/**
 * The execution hypothesis: replay the same signal events as taker entries
 * (the existing v1r replay) and as conservative maker entries, and judge ALL
 * of it in ONE court session so the deflation counts every hypothesis tested.
 */
export async function runMakerComparison(
  events: SignalRow[],
  holdHours = 48,
  getCandles: (symbol: string, from: number, to: number) => Promise<Candle[]> = fetchCandles,
  now = Date.now(),
  onProgress?: (done: number, total: number, symbol: string) => void,
  maker: MakerOptions = DEFAULT_MAKER,
): Promise<MakerComparison> {
  const takerOpt: ReplayOptions = { ...DEFAULT_REPLAY, maxHoldMs: holdHours * 3600_000 };
  const makerOpt: MakerOptions = { ...maker, maxHoldMs: holdHours * 3600_000 };
  const signals = toReplaySignals(events);
  const takerDocket = docketForSignals(signals).map((h) => ({
    ...h,
    select: (t: CourtTrade) => t.epoch === "signals" && h.select(t),
  }));
  const docket = [...takerDocket, ...MAKER_DOCKET];

  const bySymbol = new Map<string, ReplaySignal[]>();
  for (const s of signals) {
    const l = bySymbol.get(s.symbol);
    if (l) l.push(s);
    else bySymbol.set(s.symbol, [s]);
  }
  const trades: CourtTrade[] = [];
  const tried: Record<string, number> = {};
  const filled: Record<string, number> = {};
  const unavailableSymbols: string[] = [];
  const makerMeta = new Map<string, { feeBps: number; slipBps: number; exit: string }>();
  const takerExit = new Map<string, string>();
  let done = 0;
  for (const [symbol, list] of bySymbol) {
    onProgress?.(done++, bySymbol.size, symbol);
    const from = Math.min(...list.map((s) => s.firstSeenAt));
    const to = Math.min(
      now,
      Math.max(...list.map((s) => s.firstSeenAt)) + takerOpt.maxHoldMs + 10 * M,
    );
    let ks: Candle[];
    try {
      ks = await getCandles(symbol, from, to);
    } catch {
      unavailableSymbols.push(symbol);
      continue;
    }
    for (const s of list) {
      const t = replaySignal(s, ks, takerOpt);
      if (t.ok) {
        trades.push(t.trade);
        takerExit.set(t.trade.id, t.reason);
      }
      const m = replayMaker(s, ks, makerOpt);
      if (m.ok || m.why === "unfilled") {
        for (const h of MAKER_DOCKET) {
          const probe = {
            epoch: "signals-maker",
            sources: (s.sources ?? []).map((x) => `maker:${x}`),
          } as CourtTrade;
          if (h.select(probe)) {
            tried[h.id] = (tried[h.id] ?? 0) + 1;
            if (m.ok) filled[h.id] = (filled[h.id] ?? 0) + 1;
          }
        }
      }
      if (m.ok) {
        trades.push(m.trade);
        makerMeta.set(m.trade.id, { feeBps: m.feeBps, slipBps: m.slipBps, exit: m.exit });
      }
    }
  }

  const verdicts = judgeAll(trades, docket, DEFAULT_RULES);
  const fills: MakerComparison["fills"] = {};
  for (const h of MAKER_DOCKET) {
    const n = tried[h.id] ?? 0;
    fills[h.id] = { tried: n, filled: filled[h.id] ?? 0, rate: n ? (filled[h.id] ?? 0) / n : 0 };
  }
  const costs: MakerComparison["costs"] = {};
  const takerFeeBps = 2 * takerOpt.feePerSide * 1e4;
  const takerSlipBps = 2 * takerOpt.slipPerSide * 1e4;
  for (const h of docket) {
    const mine = trades.filter(h.select);
    if (!mine.length) continue;
    const exits: Record<string, number> = {};
    let fee = 0;
    let slip = 0;
    for (const t of mine) {
      const mm = makerMeta.get(t.id);
      const exit = mm?.exit ?? takerExit.get(t.id) ?? "?";
      exits[exit] = (exits[exit] ?? 0) + 1;
      fee += mm ? mm.feeBps : takerFeeBps;
      slip += mm ? mm.slipBps : takerSlipBps;
    }
    costs[h.id] = { feeBps: fee / mine.length, slipBps: slip / mine.length, exits };
  }
  return {
    events: events.length,
    verdicts,
    docket,
    fills,
    costs,
    unavailableSymbols: unavailableSymbols.sort(),
    ranAt: new Date(now).toISOString(),
  };
}
