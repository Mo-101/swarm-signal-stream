// Swarm signals as court evidence.
//
// The signals table logs every swarm proposal, traded or not: millions of rows,
// because a proposal persists across many ticks. To turn that into independent
// bets, each (symbol, side) keeps only its FIRST signal in each 2-hour block.
// Each such signal event is then replayed against candles under v1r's own
// rules (2% stop, 4% target, taker entry at the next 1m open), and the court
// asks whether the swarm's direction call has an edge after costs.
//
// Pure: no I/O.
import { confBucket, CONF_BUCKETS, type CourtTrade, type Hypothesis } from "./court";
import type { ReplaySignal } from "./replay";

export const SIGNAL_EPOCH = "signals";
export const SIGNAL_BLOCK_MS = 2 * 3600_000;

export interface SignalRow {
  id: string;
  symbol: string;
  side: string;
  confidence: number;
  executed: boolean;
  createdAt: number;
}

/** First signal per (symbol, side, 2h block), oldest first. The SQL loader
 *  already does this; it is repeated here so offline files get the same rule. */
export function signalEvents(rows: SignalRow[]): SignalRow[] {
  const seen = new Set<string>();
  const out: SignalRow[] = [];
  for (const r of [...rows].sort((a, b) => a.createdAt - b.createdAt)) {
    const key = `${r.symbol}|${r.side}|${Math.floor(r.createdAt / SIGNAL_BLOCK_MS)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export function toReplaySignals(rows: SignalRow[]): ReplaySignal[] {
  return rows
    .filter((r) => r.side === "BUY" || r.side === "SELL")
    .map((r) => ({
      signalId: r.id,
      symbol: r.symbol,
      side: r.side as "BUY" | "SELL",
      score: r.confidence,
      entry: null, // no quoted brackets: the replay applies v1r's 2% / 4%
      stopLoss: null,
      takeProfit: null,
      firstSeenAt: r.createdAt,
      admitted: r.executed,
      epoch: SIGNAL_EPOCH,
      sources: [`conf:${confBucket(r.confidence)}`, r.executed ? "executed" : "not-executed"],
    }));
}

/** Declared from which buckets exist, never from outcomes. */
export function buildSignalDocket(trades: CourtTrade[]): Hypothesis[] {
  const d: Hypothesis[] = [
    {
      id: "signals:all",
      claim: "The swarm's signal direction, replayed under v1r rules, has a net edge",
      select: () => true,
    },
  ];
  if (trades.some((t) => t.sources.includes("not-executed")))
    d.push({
      id: "signals:not-executed",
      claim: "Swarm signals that were never traded have a net edge",
      select: (t) => t.sources.includes("not-executed"),
    });
  for (const b of CONF_BUCKETS) {
    if (!trades.some((t) => t.sources.includes(`conf:${b.id}`))) continue;
    d.push({
      id: `signals:conf:${b.id}`,
      claim: `Swarm signals with confidence ${b.id} have a net edge`,
      select: (t) => t.sources.includes(`conf:${b.id}`),
    });
  }
  return d;
}
