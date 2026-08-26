// Supabase fallback store. Used only when DATABASE_URL (Neon) is absent —
// Neon stays canonical when configured. Without this, boot reads threw and
// every write became a silent no-op, so each session restarted from trade #1
// even though history existed in the cloud database.
import { EMPTY_EDGE_REPORT, type EdgeReport } from "@/lib/edge-model";
import type {
  StoredTrade,
  SignalInput,
  OpenTradeInput,
  CloseTradeInput,
  EngineBootState,
} from "./types";
import { STRATEGY_EPOCH, EDGE_EPOCH_FILTER } from "@/lib/strategy-epoch";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapSupabaseTradeRow(row: any): StoredTrade {
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

export async function sbEdgeReport(supabase: Sb): Promise<EdgeReport> {
  // Scope learning to the current strategy generation.
  const { data, error } = await supabase.rpc("edge_report", { p_epoch: EDGE_EPOCH_FILTER });
  if (error) {
    console.error("[supabase-store] edge_report failed:", error.message);
    return EMPTY_EDGE_REPORT;
  }
  return (data as EdgeReport | null) ?? EMPTY_EDGE_REPORT;
}

export async function sbLoadBootState(
  supabase: Sb,
  userId: string,
): Promise<{ boot: EngineBootState; report: EdgeReport; signalCount: number }> {
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
      .maybeSingle();
    account = inserted.data;
  }

  const [openRes, closedRes, signalRes] = await Promise.all([
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
    supabase
      .from("signals")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId),
  ]);

  const report = await sbEdgeReport(supabase);

  return {
    boot: {
      account: {
        startingBalance: Number(account?.starting_balance ?? 10000),
        realizedPnl: Number(account?.realized_pnl ?? 0),
        halted: Boolean(account?.halted),
      },
      open: (openRes.data ?? []).map(mapSupabaseTradeRow),
      closed: (closedRes.data ?? []).map(mapSupabaseTradeRow),
    },
    report,
    signalCount: signalRes.count ?? 0,
  };
}

export async function sbIngestSignals(
  supabase: Sb,
  userId: string,
  signals: SignalInput[],
): Promise<{ inserted: number }> {
  const rows = signals.slice(0, 1000);
  if (rows.length === 0) return { inserted: 0 };
  const { error } = await supabase.from("signals").insert(
    rows.map((s) => ({
      user_id: userId,
      symbol: s.symbol,
      side: s.side,
      price: s.price,
      confidence: s.confidence,
      conf_bucket: s.confBucket,
      regime: s.regime,
      hour_utc: s.hourUtc,
      agents: s.agents,
      executed: s.executed,
    })),
  );
  if (error) throw new Error(error.message);
  return { inserted: rows.length };
}

export async function sbPersistOpenTrade(
  supabase: Sb,
  userId: string,
  d: OpenTradeInput,
): Promise<{ ok: true }> {
  const { error } = await supabase.from("paper_trades").upsert(
    {
      user_id: userId,
      client_id: d.clientId,
      symbol: d.symbol,
      side: d.side,
      entry_price: d.entryPrice,
      size: d.size,
      notional: d.notional,
      stop_loss: d.stopLoss,
      take_profit: d.takeProfit,
      confidence: d.confidence,
      conf_bucket: d.confBucket,
      regime: d.regime,
      hour_utc: d.hourUtc,
      agents: d.agents,
      status: "open",
      opened_at: new Date(d.openedAt).toISOString(),
      signal_price: d.signalPrice ?? d.entryPrice,
      entry_slip_bps: d.entrySlipBps ?? 0,
      spread_entry_bps: d.spreadEntryBps ?? 0,
      latency_ms: d.latencyMs ?? 0,
      leverage: d.leverage ?? null,
      liq_price: d.liqPrice ?? null,
      book_priced: d.bookPriced ?? false,
      strategy_epoch: STRATEGY_EPOCH,
    },
    { onConflict: "user_id,client_id" },
  );
  if (error) throw new Error(error.message);
  return { ok: true };
}

export async function sbPersistCloseTrade(
  supabase: Sb,
  userId: string,
  d: CloseTradeInput,
): Promise<{ report: EdgeReport }> {
  const { data, error } = await supabase
    .from("paper_trades")
    .update({
      exit_price: d.exitPrice,
      pnl: d.pnl,
      pnl_pct: d.pnlPct,
      reason: d.reason,
      status: "closed",
      closed_at: new Date(d.closedAt).toISOString(),
      trigger_price: d.triggerPrice ?? d.exitPrice,
      exit_slip_bps: d.exitSlipBps ?? 0,
      spread_exit_bps: d.spreadExitBps ?? 0,
      slip_cost_usd: d.slipCostUsd ?? 0,
      gross_pnl: d.grossPnl ?? d.pnl,
      fees: d.fees ?? 0,
      funding: d.funding ?? 0,
    })
    .eq("user_id", userId)
    .eq("client_id", d.clientId)
    .select("client_id");

  if (error) throw new Error(error.message);
  if (Array.isArray(data) && data.length === 0) {
    console.error(
      `[persist] close matched 0 rows for client_id=${d.clientId} — ` +
        `realized_pnl will include $${d.pnl.toFixed(2)} with no trade row behind it`,
    );
  }

  await supabase
    .from("paper_accounts")
    .upsert(
      {
        user_id: userId,
        realized_pnl: d.realizedPnl,
        halted: d.halted,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );

  return { report: await sbEdgeReport(supabase) };
}

export async function sbResetPaperAccount(
  supabase: Sb,
  userId: string,
  wipeHistory: boolean,
): Promise<{ report: EdgeReport }> {
  if (wipeHistory) {
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
  return { report: await sbEdgeReport(supabase) };
}
