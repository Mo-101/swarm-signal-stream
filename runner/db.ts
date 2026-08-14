// Direct-supabase persistence for the headless runner. Mirrors the queries
// in src/lib/edge.functions.ts exactly, but runs against a plain, signed-in
// @supabase/supabase-js client instead of a TanStack server-function context
// (which only exists inside an HTTP request handled by the framework).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { EMPTY_EDGE_REPORT, type EdgeReport } from "../src/lib/edge-model";
import type {
  StoredTrade,
  OpenTradeInput,
  CloseTradeInput,
  SignalInput,
} from "../src/lib/edge.functions";
import type { EnginePersistence, EngineBootState } from "../src/lib/engine-runtime";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

export function createRunnerSupabaseClient(url: string, publishableKey: string): SupabaseClient {
  return createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: true },
  });
}

export async function signInBotUser(
  supabase: SupabaseClient,
  email: string,
  password: string,
): Promise<string> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`Runner sign-in failed: ${error?.message ?? "no user"}`);
  return data.user.id;
}

export async function loadBootState(
  supabase: SupabaseClient,
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
      supabase.from("signals").select("id", { count: "exact", head: true }).eq("user_id", userId),
    ]);

  return {
    boot: {
      account: {
        startingBalance: Number(account?.starting_balance ?? 10000),
        realizedPnl: Number(account?.realized_pnl ?? 0),
        halted: Boolean(account?.halted),
      },
      open: (open ?? []).map(mapTrade),
      closed: (closed ?? []).map(mapTrade),
    },
    report: (report as EdgeReport | null) ?? EMPTY_EDGE_REPORT,
    signalCount: signalCount ?? 0,
  };
}

export function createSupabasePersistence(
  supabase: SupabaseClient,
  userId: string,
  onError: (message: string) => void,
): EnginePersistence {
  return {
    async saveOpenTrade(data: OpenTradeInput) {
      const { error } = await supabase.from("paper_trades").upsert(
        {
          user_id: userId,
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
    },
    async saveCloseTrade(data: CloseTradeInput) {
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

      await supabase.from("paper_accounts").upsert(
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
    },
    async sendSignals(signals: SignalInput[]) {
      const rows = signals.slice(0, 1000).map((s) => ({
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
      }));
      if (rows.length === 0) return;
      const { error } = await supabase.from("signals").insert(rows);
      if (error) throw new Error(error.message);
    },
    onPersistError: onError,
  };
}

export interface HeartbeatFields {
  status: string;
  equity: number;
  closedTrades: number;
  ticksPerSec: number;
}

export async function upsertHeartbeat(
  supabase: SupabaseClient,
  userId: string,
  startedAt: Date,
  fields: HeartbeatFields,
) {
  await supabase.from("runner_state").upsert(
    {
      user_id: userId,
      status: fields.status,
      equity: fields.equity,
      closed_trades: fields.closedTrades,
      ticks_per_sec: fields.ticksPerSec,
      started_at: startedAt.toISOString(),
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
}
