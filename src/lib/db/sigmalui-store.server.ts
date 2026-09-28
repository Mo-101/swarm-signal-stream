// Evidence store for the SigmaLui feed. Every distinct signal the feed emits is
// recorded once, admitted or not, with its bracket geometry, so the Signal
// Court can replay it against candles (scripts/sigmalui-replay.ts) without the
// broker ever taking the trade. Insert-only: a signal's record is never edited.
//
// Server/runner only (reads DATABASE_URL through the Neon client).
import { getNeonSqlOrNoop } from "./neon";
import type { ObservedSigmaLuiSignal } from "@/lib/sigmalui-ingester";

export async function persistSigmaLuiSignal(s: ObservedSigmaLuiSignal): Promise<void> {
  const sql = getNeonSqlOrNoop();
  await sql`
    INSERT INTO sigmalui_signals
      (signal_id, symbol, side, score, entry_price, stop_loss, take_profit,
       feed_time, first_seen_at, admitted, reject_reason, raw)
    VALUES
      (${s.signalId}, ${s.symbol}, ${s.side}, ${s.score}, ${s.entry}, ${s.stopLoss}, ${s.takeProfit},
       ${s.feedTime === null ? null : new Date(s.feedTime).toISOString()},
       ${new Date(s.firstSeenAt).toISOString()}, ${s.admitted}, ${s.rejectReason},
       ${JSON.stringify(s.raw)}::jsonb)
    ON CONFLICT (signal_id) DO NOTHING`;
}
