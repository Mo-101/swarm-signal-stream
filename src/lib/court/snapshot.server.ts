// Periodic court session, run by the runner: re-judge closed trades and the
// SigmaLui replay, and append the verdicts to court_verdicts. The history is
// what lets the dashboard show evidence accumulating (the detectable edge
// shrinking) instead of a single snapshot.
//
// Writes only to the court's own append-only tables. Never touches trading
// state. Server/runner only.
import { REPLAY_DOCKET, runReplay } from "./replay-run.server";
import { judgeTrades, loadSigmaLuiSignals, recordVerdicts } from "./store.server";

export interface SnapshotResult {
  trades: { judged: number; written: number; refused: string[] };
  replay: { signals: number; replayed: number; written: number; refused: string[] } | null;
}

export async function runCourtSnapshot(userId: string | null): Promise<SnapshotResult> {
  const t = await judgeTrades(userId);
  const tw = await recordVerdicts(t.verdicts, t.docket);
  const result: SnapshotResult = {
    trades: { judged: t.trades.length, written: tw.written, refused: tw.refused },
    replay: null,
  };

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
