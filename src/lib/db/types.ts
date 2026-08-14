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
}

export interface EngineBootState {
  account: { startingBalance: number; realizedPnl: number; halted: boolean };
  open: StoredTrade[];
  closed: StoredTrade[];
}
