// Periodic court session, run by the runner: re-judge closed trades and the
// SigmaLui replay, and append the verdicts to court_verdicts. The history is
// what lets the dashboard show evidence accumulating (the detectable edge
// shrinking) instead of a single snapshot.
//
// Writes only to the court's own append-only tables. Never touches trading
// state. Server/runner only.
import { REPLAY_DOCKET, runReplay, runSignalReplay } from "./replay-run.server";
import { judgeTrades, loadSignalEvents, loadSigmaLuiSignals, recordVerdicts } from "./store.server";

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
  const t = await judgeTrades(userId);
  const tw = await recordVerdicts(t.verdicts, t.docket);
  const result: SnapshotResult = {
    trades: { judged: t.trades.length, written: tw.written, refused: tw.refused },
    replay: null,
    swarmSignals: null,
  };

  // Swarm signals: the first signal per symbol/side per 2h over the last N
  // days, replayed under v1r rules. Candles for closed days come from the disk
  // cache, so each session only downloads what is new.
  const signalDays = opts.signalDays ?? 14;
  if (signalDays > 0) {
    try {
      const events = await loadSignalEvents(userId, signalDays);
      if (events.length) {
        const run = await runSignalReplay(events, opts.holdHours ?? 48);
        const sw = await recordVerdicts(run.verdicts, run.docket);
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
    const run = await runReplay(signals);
    const rw = await recordVerdicts(run.verdicts, REPLAY_DOCKET);
    result.replay = {
      signals: signals.length,
      replayed: run.replayed,
      written: rw.written,
      refused: rw.refused,
    };
  }
  return result;
}
