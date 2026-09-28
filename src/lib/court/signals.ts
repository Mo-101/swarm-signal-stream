// Swarm signals as court evidence.
//
// The signals table logs every swarm proposal, traded or not: millions of rows,
// because a proposal persists across many ticks. To turn that into independent
// bets, each (symbol, side) keeps only its FIRST signal in each 2-hour block.
// Each such signal event is then replayed against candles under v1r's own
// rules (2% stop, 4% target, taker entry at the next 1m open), and the court
// asks whether the swarm's direction call has an edge after costs, overall,
// by confidence bucket, and per agent (signals that agent voted for).
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
  /** Agents whose own vote pointed the same way as the signal. */
  agrees?: string[];
}

/** Agents that voted in the signal's direction, from signals.agents jsonb. */
export function agreeingAgents(agents: unknown, side: string): string[] {
  if (!agents || typeof agents !== "object") return [];
  return Object.entries(agents as Record<string, { direction?: string }>)
    .filter(([, v]) => v && typeof v === "object" && v.direction === side)
    .map(([k]) => k)
    .sort();
}

/** UTC day windows covering the last `days` days, oldest first. Each is a
 *  multiple of the 2h block, so per-day DISTINCT ON equals the global one. */
export function dayWindows(days: number, now: number): Array<[number, number]> {
  const DAY = 86_400_000;
  const end = Math.ceil(now / DAY) * DAY;
  const out: Array<[number, number]> = [];
  for (let d = end - days * DAY; d < end; d += DAY) out.push([d, d + DAY]);
  return out;
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
      sources: [
        `conf:${confBucket(r.confidence)}`,
        r.executed ? "executed" : "not-executed",
        ...(r.agrees ?? []).map((a) => `agent:${a}`),
      ],
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
  const agents = [
    ...new Set(trades.flatMap((t) => t.sources.filter((x) => x.startsWith("agent:")))),
  ].sort();
  for (const a of agents) {
    d.push({
      id: `signals:${a}`,
      claim: `Swarm signals the ${a.slice("agent:".length)} agent voted for have a net edge`,
      select: (t) => t.sources.includes(a),
    });
  }
  return d;
}

/** The signal docket for a set of replay inputs, before any outcome exists. */
export function docketForSignals(signals: ReplaySignal[]): Hypothesis[] {
  return buildSignalDocket(
    signals.map((s) => ({
      id: s.signalId,
      symbol: s.symbol,
      side: s.side,
      epoch: SIGNAL_EPOCH,
      sources: s.sources ?? [],
      openedAt: 0,
      closedAt: 0,
      notional: 1,
      grossUsd: 0,
      netUsd: 0,
    })),
  );
}
