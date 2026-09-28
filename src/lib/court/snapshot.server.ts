// Periodic court session, run by the runner: re-judge closed trades and the
// SigmaLui replay, and append the verdicts to court_verdicts. The history is
// what lets the dashboard show evidence accumulating (the detectable edge
// shrinking) instead of a single snapshot.
//
// Writes only to the court's own append-only tables. Never touches trading
// state. Server/runner only.
import { DEFAULT_SHADOW_CONFIG } from "@/lib/shadow-book";
import { fetchCandles, REPLAY_DOCKET, runReplay, runSignalReplay } from "./replay-run.server";
import type { CourtTrade, Hypothesis, Verdict } from "./court";
import { DEFAULT_REPLAY } from "./replay";
import { parole, type ParoleOutcome, restartAfterRetirement, retirementVerdict } from "./parole";
import { mirrorGrossBps } from "./shadow-mirror";
import {
  judgeTrades,
  loadCourtState,
  loadShadowNeedingMirror,
  loadSignalEvents,
  loadSigmaLuiSignals,
  recordVerdicts,
  saveShadowMirrors,
} from "./store.server";

/**
 * Replay the mirror of every closed shadow trade not yet mirrored and store
 * it, so the direction placebo for the shadow book is exact. Incremental:
 * each trade is mirrored once. Needs an account id (rows are per account).
 */
export async function mirrorShadowTrades(
  userId: string,
  getCandles = fetchCandles,
  limit = 5000,
): Promise<{ mirrored: number; uncovered: number }> {
  const todo = await loadShadowNeedingMirror(userId, limit);
  const bySymbol = new Map<string, typeof todo>();
  for (const t of todo) {
    const l = bySymbol.get(t.symbol);
    if (l) l.push(t);
    else bySymbol.set(t.symbol, [t]);
  }
  const hold = DEFAULT_SHADOW_CONFIG.maxHoldMs;
  let mirrored = 0;
  let uncovered = 0;
  for (const [symbol, list] of bySymbol) {
    const from = Math.min(...list.map((t) => t.openedAt));
    const to = Math.min(Date.now(), Math.max(...list.map((t) => t.openedAt)) + hold + 120_000);
    let rows: Array<{ shadowId: string; flippedGrossBps: number | null; note: string | null }>;
    try {
      const ks = await getCandles(symbol, from, to);
      rows = list.map((t) => {
        const bps = mirrorGrossBps(t, ks, hold);
        return {
          shadowId: t.shadowId,
          flippedGrossBps: bps,
          note: bps === null ? "not covered by candles" : null,
        };
      });
    } catch (e) {
      rows = list.map((t) => ({
        shadowId: t.shadowId,
        flippedGrossBps: null,
        note: `candles unavailable: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
      }));
    }
    // Only store rows the candles could decide, plus permanent failures; a
    // trade whose holding window hasn't fully passed in the candles is retried.
    const decided = rows.filter(
      (r) => r.flippedGrossBps !== null || r.note?.startsWith("candles unavailable"),
    );
    await saveShadowMirrors(userId, decided);
    mirrored += decided.filter((r) => r.flippedGrossBps !== null).length;
    uncovered += decided.filter((r) => r.flippedGrossBps === null).length;
  }
  return { mirrored, uncovered };
}

export interface SnapshotResult {
  trades: { judged: number; written: number; refused: string[] };
  replay: { signals: number; replayed: number; written: number; refused: string[] } | null;
  swarmSignals: {
    events: number;
    replayed: number;
    unavailableSymbols: number;
    written: number;
    refused: string[];
  } | null;
  /** Why the swarm-signal replay did not run this session, if it failed. */
  swarmSignalsError?: string;
  shadowMirror?: { mirrored: number; uncovered: number };
  shadowMirrorError?: string;
  /** Decay-watch outcome for every hypothesis on parole this session. */
  parole: ParoleOutcome[];
  /** Hypotheses retired this session. */
  retired: string[];
}

export interface SnapshotOptions {
  /** Days of swarm signals to replay each session; 0 disables. */
  signalDays?: number;
  holdHours?: number;
}

export async function runCourtSnapshot(
  userId: string | null,
  opts: SnapshotOptions = {},
): Promise<SnapshotResult> {
  // Mirror new shadow trades first, so this session's verdicts use the exact test.
  let shadowMirror: SnapshotResult["shadowMirror"];
  let shadowMirrorError: string | undefined;
  if (userId) {
    try {
      shadowMirror = await mirrorShadowTrades(userId);
    } catch (e) {
      shadowMirrorError = e instanceof Error ? e.message : String(e);
    }
  }

  const state = await loadCourtState();
  const paroleOutcomes: ParoleOutcome[] = [];
  const retired: string[] = [];
  // Record fresh verdicts, then run parole; a retirement is written AFTER the
  // fresh verdict so it becomes the latest word on that hypothesis.
  const judgeAndParole = async (
    trades: CourtTrade[],
    docket: Hypothesis[],
    verdicts: Verdict[],
  ) => {
    const w = await recordVerdicts(verdicts, docket);
    const outcomes = parole(trades, docket, state);
    paroleOutcomes.push(...outcomes);
    const retiring = outcomes
      .filter((o) => o.status === "RETIRED")
      .map((o) => ({ o, fresh: verdicts.find((v) => v.id === o.id) }))
      .filter((x): x is { o: ParoleOutcome; fresh: Verdict } => Boolean(x.fresh));
    if (retiring.length) {
      await recordVerdicts(
        retiring.map((x) => retirementVerdict(x.fresh, x.o)),
        docket,
      );
      retired.push(...retiring.map((x) => x.o.id));
    }
    return w;
  };

  const t = await judgeTrades(userId, state);
  const tw = await judgeAndParole(t.trades, t.docket, t.verdicts);
  const result: SnapshotResult = {
    trades: { judged: t.trades.length, written: tw.written, refused: tw.refused },
    replay: null,
    swarmSignals: null,
    shadowMirror,
    shadowMirrorError,
    parole: paroleOutcomes,
    retired,
  };

  // Swarm signals: the first signal per symbol/side per 2h over the last N
  // days, replayed under v1r rules. Candles for closed days come from the disk
  // cache, so each session only downloads what is new.
  const signalDays = opts.signalDays ?? 14;
  if (signalDays > 0) {
    try {
      const events = await loadSignalEvents(userId, signalDays);
      if (events.length) {
        const run = await runSignalReplay(
          events,
          opts.holdHours ?? 48,
          undefined,
          undefined,
          undefined,
          (d) => restartAfterRetirement(d, state),
        );
        const sw = await judgeAndParole(run.trades, run.docket, run.verdicts);
        result.swarmSignals = {
          events: events.length,
          replayed: run.replayed,
          unavailableSymbols: run.unavailableSymbols.length,
          written: sw.written,
          refused: sw.refused,
        };
      }
    } catch (e) {
      // reported, not fatal: the next session retries
      result.swarmSignalsError = e instanceof Error ? e.message : String(e);
    }
  }

  let signals;
  try {
    signals = await loadSigmaLuiSignals();
  } catch {
    return result; // sigmalui_signals not created yet
  }
  if (signals.length) {
    const docket = restartAfterRetirement(REPLAY_DOCKET, state);
    const run = await runReplay(signals, fetchCandles, Date.now(), DEFAULT_REPLAY, docket);
    const rw = await judgeAndParole(run.trades, docket, run.verdicts);
    result.replay = {
      signals: signals.length,
      replayed: run.replayed,
      written: rw.written,
      refused: rw.refused,
    };
  }
  return result;
}
