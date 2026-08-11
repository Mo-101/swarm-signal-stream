import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { EMPTY_EDGE_REPORT, type EdgeReport } from "@/lib/edge-model";

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

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapTrade(row: any): StoredTrade {
  return {
    clientId: row.client_id,
    symbol: row.symbol,
    side: row.side,
    entryPrice: Number(row.entry_price),
    exitPrice: row.exit_price === null ? null : Number(row.exit_price),
    size: Number(row.size),
    notional: Number(row.notional),
    stopLoss: Number(row.stop_loss),
    takeProfit: Number(row.take_profit),
    confidence: Number(row.confidence),
    regime: row.regime,
    agents: row.agents ?? {},
    status: row.status,
    pnl: row.pnl === null ? null : Number(row.pnl),
    pnlPct: row.pnl_pct === null ? null : Number(row.pnl_pct),
    reason: row.reason,
    openedAt: new Date(row.opened_at).getTime(),
    closedAt: row.closed_at ? new Date(row.closed_at).getTime() : null,
  };
}

export const loadEngineState = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    let { data: account } = await supabase
      .from("paper_accounts")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (!account) {
      const inserted = await supabase
        .from("paper_accounts")
        .insert({ user_id: userId })
        .select("*")
        .single();
      account = inserted.data;
    }

    const [{ data: open }, { data: closed }, { data: report }, { count: signalCount }] =
      await Promise.all([
        supabase
          .from("paper_trades")
          .select("*")
          .eq("user_id", userId)
          .eq("status", "open")
          .order("opened_at", { ascending: false }),
        supabase
          .from("paper_trades")
          .select("*")
          .eq("user_id", userId)
          .eq("status", "closed")
          .order("closed_at", { ascending: false })
          .limit(200),
        supabase.rpc("edge_report"),
        supabase
          .from("signals")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId),
      ]);

    return {
      account: {
        startingBalance: Number(account?.starting_balance ?? 10000),
        realizedPnl: Number(account?.realized_pnl ?? 0),
        halted: Boolean(account?.halted),
      },
      open: (open ?? []).map(mapTrade),
      closed: (closed ?? []).map(mapTrade),
      report: (report as EdgeReport | null) ?? EMPTY_EDGE_REPORT,
      signalCount: signalCount ?? 0,
    };
  });

export const getEdgeReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.rpc("edge_report");
    return (data as EdgeReport | null) ?? EMPTY_EDGE_REPORT;
  });

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

export const ingestSignals = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { signals: SignalInput[] }) => input)
  .handler(async ({ data, context }) => {
    const rows = data.signals.slice(0, 200).map((s) => ({
      user_id: context.userId,
      symbol: s.symbol,
      side: s.side,
      price: s.price,
      confidence: s.confidence,
      conf_bucket: s.confBucket,
      regime: s.regime,
      hour_utc: s.hourUtc,
      agents: s.agents,
      executed: s.executed,
    }));
    if (rows.length === 0) return { inserted: 0 };
    const { error } = await context.supabase.from("signals").insert(rows);
    if (error) throw new Error(error.message);
    return { inserted: rows.length };
  });

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

export const persistOpenTrade = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: OpenTradeInput) => input)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("paper_trades").upsert(
      {
        user_id: context.userId,
        client_id: data.clientId,
        symbol: data.symbol,
        side: data.side,
        entry_price: data.entryPrice,
        size: data.size,
        notional: data.notional,
        stop_loss: data.stopLoss,
        take_profit: data.takeProfit,
        confidence: data.confidence,
        conf_bucket: data.confBucket,
        regime: data.regime,
        hour_utc: data.hourUtc,
        agents: data.agents,
        status: "open",
        opened_at: new Date(data.openedAt).toISOString(),
        signal_price: data.signalPrice ?? data.entryPrice,
        entry_slip_bps: data.entrySlipBps ?? 0,
        spread_entry_bps: data.spreadEntryBps ?? 0,
        latency_ms: data.latencyMs ?? 0,
        leverage: data.leverage ?? null,
        liq_price: data.liqPrice ?? null,
        book_priced: data.bookPriced ?? false,
      },
      { onConflict: "user_id,client_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

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

export const persistCloseTrade = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: CloseTradeInput) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("paper_trades")
      .update({
        exit_price: data.exitPrice,
        pnl: data.pnl,
        pnl_pct: data.pnlPct,
        reason: data.reason,
        status: "closed",
        closed_at: new Date(data.closedAt).toISOString(),
        trigger_price: data.triggerPrice ?? data.exitPrice,
        exit_slip_bps: data.exitSlipBps ?? 0,
        spread_exit_bps: data.spreadExitBps ?? 0,
        slip_cost_usd: data.slipCostUsd ?? 0,
        gross_pnl: data.grossPnl ?? data.pnl,
        fees: data.fees ?? 0,
        funding: data.funding ?? 0,
      })
      .eq("user_id", userId)
      .eq("client_id", data.clientId);
    if (error) throw new Error(error.message);


    await supabase
      .from("paper_accounts")
      .upsert(
        {
          user_id: userId,
          realized_pnl: data.realizedPnl,
          halted: data.halted,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );

    const { data: report } = await supabase.rpc("edge_report");
    return { report: (report as EdgeReport | null) ?? EMPTY_EDGE_REPORT };
  });

export const resetPaperAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { wipeHistory: boolean }) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    if (data.wipeHistory) {
      await supabase.from("paper_trades").delete().eq("user_id", userId);
      await supabase.from("signals").delete().eq("user_id", userId);
    } else {
      await supabase.from("paper_trades").delete().eq("user_id", userId).eq("status", "open");
    }
    await supabase.from("paper_accounts").upsert(
      {
        user_id: userId,
        realized_pnl: 0,
        halted: false,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    const { data: report } = await supabase.rpc("edge_report");
    return { report: (report as EdgeReport | null) ?? EMPTY_EDGE_REPORT };
  });
