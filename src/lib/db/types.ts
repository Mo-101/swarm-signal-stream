// Shape of persisted trade/signal data — shared between the Supabase-backed
// server functions (edge.functions.ts) and the Neon-backed store
// (edge-store.server.ts) so both sides agree on one contract regardless of
// which database actually answers a given call.

export interface StoredTrade {
  clientId: string;
  symbol: string;
  side: "BUY" | "SELL";
  entryPrice: number;
  exitPrice: number | null;
  size: number;
  notional: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  regime: string;
  agents: Record<string, { direction: string; confidence: number }>;
  status: "open" | "closed";
  pnl: number | null;
  pnlPct: number | null;
  reason: string | null;
  openedAt: number;
  closedAt: number | null;
}

export interface SignalInput {
  symbol: string;
  side: "BUY" | "SELL";
  price: number;
  confidence: number;
  confBucket: string;
  regime: string;
  hourUtc: number;
  agents: Record<string, { direction: string; confidence: number }>;
  executed: boolean;
}

export interface OpenTradeInput {
  clientId: string;
  symbol: string;
  side: "BUY" | "SELL";
  entryPrice: number;
  size: number;
  notional: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  confBucket: string;
  regime: string;
  hourUtc: number;
  agents: Record<string, { direction: string; confidence: number }>;
  openedAt: number;
  signalPrice?: number;
  entrySlipBps?: number;
  spreadEntryBps?: number;
  latencyMs?: number;
  leverage?: number;
  liqPrice?: number;
  bookPriced?: boolean;
  /** Entry filled as a resting post-only limit and earned the maker rate. */
  makerEntry?: boolean;
}

export interface CloseTradeInput {
  clientId: string;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  reason: string;
  closedAt: number;
  realizedPnl: number;
  halted: boolean;
  triggerPrice?: number;
  exitSlipBps?: number;
  spreadExitBps?: number;
  slipCostUsd?: number;
  grossPnl?: number;
  fees?: number;
  funding?: number;
  /**
   * Exit rested as a reduce-only limit and earned the maker rate. Stops and
   * liquidations must cross, so they are always taker. Persisted so a
   * strategy's true fee floor is measured rather than inferred.
   */
  makerExit?: boolean;
}

/**
 * One funding settlement, as durably stored. `at` is the EXCHANGE's settlement
 * timestamp — Bybit's nextFundingTime, later confirmed as
 * fundingRateTimestamp — never a locally computed 8h grid point.
 */
export interface FundingEventInput {
  clientId: string;
  symbol: string;
  side: "BUY" | "SELL";
  at: number;
  /** Position quantity AT settlement, not averaged over the interval. */
  quantity: number;
  markPrice: number;
  rate: number;
  intervalMs: number;
  notional: number;
  /** Positive = the position PAID. */
  amount: number;
  /** "settled" is final; "live"/"default" are provisional. */
  rateSource: string;
}

/** A settlement charged at a provisional rate, awaiting its confirmed rate. */
export interface StoredFundingEvent extends FundingEventInput {
  id: string;
}

export interface EngineBootState {
  account: { startingBalance: number; realizedPnl: number; halted: boolean };
  open: StoredTrade[];
  closed: StoredTrade[];
  /**
   * Settlements already charged, so a restart cannot charge them twice. Only
   * recent history is loaded: anything older than the oldest open position
   * can no longer be replayed anyway.
   */
  fundingEvents?: StoredFundingEvent[];
}
