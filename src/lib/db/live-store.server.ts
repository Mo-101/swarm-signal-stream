// Live (real-money) trading persistence — Neon-primary, Supabase-mirror,
// same convention as edge-store.server.ts but deliberately separate tables
// (live_accounts/live_trades) so paper simulation and real positions can
// never bleed into each other through a shared query.
//
// Server-only — dynamically import from *.functions.ts handlers.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getNeonSql } from "./neon";

export type LiveProvider = "binance" | "bybit";

export interface LiveTradeRow {
  clientId: string;
  provider: LiveProvider;
  symbol: string;
  side: "BUY" | "SELL";
  entryPrice: number;
  exitPrice: number | null;
  size: number;
  notional: number;
  stopLoss: number | null;
  takeProfit: number | null;
  leverage: number | null;
  /** Trailing-stop exit, not a fixed TP — where the trail arms and how far it can retrace. */
  trailingActivePrice: number | null;
  trailingDistance: number | null;
  status: "open" | "closed";
  pnl: number | null;
  pnlPct: number | null;
  reason: string | null;
  entryOrderId: string | null;
  slOrderId: string | null;
  tpOrderId: string | null;
  exitOrderId: string | null;
  openedAt: number;
  closedAt: number | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRow(row: any): LiveTradeRow {
  return {
    clientId: row.client_id,
    provider: row.provider,
    symbol: row.symbol,
    side: row.side,
    entryPrice: Number(row.entry_price),
    exitPrice: row.exit_price === null ? null : Number(row.exit_price),
    size: Number(row.size),
    notional: Number(row.notional),
    stopLoss: row.stop_loss === null ? null : Number(row.stop_loss),
    takeProfit: row.take_profit === null ? null : Number(row.take_profit),
    leverage: row.leverage === null ? null : Number(row.leverage),
    trailingActivePrice: row.trailing_active_price === null ? null : Number(row.trailing_active_price),
    trailingDistance: row.trailing_distance === null ? null : Number(row.trailing_distance),
    status: row.status,
    pnl: row.pnl === null ? null : Number(row.pnl),
    pnlPct: row.pnl_pct === null ? null : Number(row.pnl_pct),
    reason: row.reason,
    entryOrderId: row.entry_order_id,
    slOrderId: row.sl_order_id,
    tpOrderId: row.tp_order_id,
    exitOrderId: row.exit_order_id,
    openedAt: new Date(row.opened_at).getTime(),
    closedAt: row.closed_at ? new Date(row.closed_at).getTime() : null,
  };
}

function logMirrorError(op: string, e: unknown) {
  console.error(`[live-store] Supabase mirror ${op} failed:`, e instanceof Error ? e.message : e);
}

export interface OpenLiveTradeInput {
  provider: LiveProvider;
  symbol: string;
  side: "BUY" | "SELL";
  entryPrice: number;
  size: number;
  notional: number;
  stopLoss?: number;
  takeProfit?: number;
  leverage?: number;
  trailingActivePrice?: number;
  trailingDistance?: number;
  entryOrderId?: string;
  slOrderId?: string;
  tpOrderId?: string;
}

/** Generates the client_id — callers don't have a stable exchange id up front for entries. */
export async function persistLiveOpenTrade(
  supabase: SupabaseClient,
  userId: string,
  data: OpenLiveTradeInput,
): Promise<{ clientId: string }> {
  const clientId = crypto.randomUUID();
  const openedAt = Date.now();
  const sql = getNeonSql();

  await sql`
    INSERT INTO live_accounts (user_id, provider)
    VALUES (${userId}, ${data.provider})
    ON CONFLICT (user_id, provider) DO NOTHING`;

  await sql`
    INSERT INTO live_trades (
      user_id, provider, client_id, symbol, side, entry_price, size, notional,
      stop_loss, take_profit, leverage, trailing_active_price, trailing_distance,
      status, entry_order_id, sl_order_id, tp_order_id, opened_at
    ) VALUES (
      ${userId}, ${data.provider}, ${clientId}, ${data.symbol}, ${data.side}, ${data.entryPrice},
      ${data.size}, ${data.notional}, ${data.stopLoss ?? null}, ${data.takeProfit ?? null},
      ${data.leverage ?? null}, ${data.trailingActivePrice ?? null}, ${data.trailingDistance ?? null},
      'open', ${data.entryOrderId ?? null}, ${data.slOrderId ?? null},
      ${data.tpOrderId ?? null}, to_timestamp(${openedAt / 1000})
    )`;

  void (async () => {
    const { error: acctErr } = await supabase
      .from("live_accounts")
      .upsert({ user_id: userId, provider: data.provider }, { onConflict: "user_id,provider", ignoreDuplicates: true });
    if (acctErr) logMirrorError("persistLiveOpenTrade (account)", acctErr);

    const { error } = await supabase.from("live_trades").insert({
      user_id: userId,
      provider: data.provider,
      client_id: clientId,
      symbol: data.symbol,
      side: data.side,
      entry_price: data.entryPrice,
      size: data.size,
      notional: data.notional,
      stop_loss: data.stopLoss ?? null,
      take_profit: data.takeProfit ?? null,
      leverage: data.leverage ?? null,
      trailing_active_price: data.trailingActivePrice ?? null,
      trailing_distance: data.trailingDistance ?? null,
      status: "open",
      entry_order_id: data.entryOrderId ?? null,
      sl_order_id: data.slOrderId ?? null,
      tp_order_id: data.tpOrderId ?? null,
      opened_at: new Date(openedAt).toISOString(),
    });
    if (error) logMirrorError("persistLiveOpenTrade (trade)", error);
  })();

  return { clientId };
}

export interface CloseLiveTradeInput {
  provider: LiveProvider;
  symbol: string;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  reason: string;
  exitOrderId?: string;
}

/** Closes the caller's currently-open trade for (provider, symbol) — at most one, by design. */
export async function persistLiveCloseTrade(
  supabase: SupabaseClient,
  userId: string,
  data: CloseLiveTradeInput,
): Promise<{ closed: boolean }> {
  const sql = getNeonSql();
  const closedAt = Date.now();

  const openRows = await sql`
    SELECT client_id FROM live_trades
    WHERE user_id = ${userId} AND provider = ${data.provider} AND symbol = ${data.symbol} AND status = 'open'
    ORDER BY opened_at DESC LIMIT 1`;
  const clientId = (openRows[0] as { client_id: string } | undefined)?.client_id;
  if (!clientId) return { closed: false };

  await sql`
    UPDATE live_trades SET
      exit_price = ${data.exitPrice}, pnl = ${data.pnl}, pnl_pct = ${data.pnlPct},
      reason = ${data.reason}, status = 'closed', closed_at = to_timestamp(${closedAt / 1000}),
      exit_order_id = ${data.exitOrderId ?? null}
    WHERE user_id = ${userId} AND provider = ${data.provider} AND client_id = ${clientId}`;

  await sql`
    UPDATE live_accounts SET realized_pnl = realized_pnl + ${data.pnl}, updated_at = now()
    WHERE user_id = ${userId} AND provider = ${data.provider}`;

  void (async () => {
    const { error } = await supabase
      .from("live_trades")
      .update({
        exit_price: data.exitPrice,
        pnl: data.pnl,
        pnl_pct: data.pnlPct,
        reason: data.reason,
        status: "closed",
        closed_at: new Date(closedAt).toISOString(),
        exit_order_id: data.exitOrderId ?? null,
      })
      .eq("user_id", userId)
      .eq("provider", data.provider)
      .eq("client_id", clientId);
    if (error) logMirrorError("persistLiveCloseTrade (trade)", error);

    const { data: acct } = await supabase
      .from("live_accounts")
      .select("realized_pnl")
      .eq("user_id", userId)
      .eq("provider", data.provider)
      .maybeSingle();
    const { error: acctErr } = await supabase
      .from("live_accounts")
      .update({ realized_pnl: (Number(acct?.realized_pnl) || 0) + data.pnl, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("provider", data.provider);
    if (acctErr) logMirrorError("persistLiveCloseTrade (account)", acctErr);
  })();

  return { closed: true };
}

export async function loadLiveTrades(
  supabase: SupabaseClient,
  userId: string,
  provider: LiveProvider,
): Promise<{ open: LiveTradeRow[]; closed: LiveTradeRow[]; realizedPnl: number }> {
  try {
    const sql = getNeonSql();
    const account = (
      await sql`SELECT realized_pnl FROM live_accounts WHERE user_id = ${userId} AND provider = ${provider}`
    )[0] as { realized_pnl: string } | undefined;
    const open = await sql`
      SELECT * FROM live_trades WHERE user_id = ${userId} AND provider = ${provider} AND status = 'open'
      ORDER BY opened_at DESC`;
    const closed = await sql`
      SELECT * FROM live_trades WHERE user_id = ${userId} AND provider = ${provider} AND status = 'closed'
      ORDER BY closed_at DESC LIMIT 200`;
    return {
      open: open.map(mapRow),
      closed: closed.map(mapRow),
      realizedPnl: Number(account?.realized_pnl ?? 0),
    };
  } catch (e) {
    console.error("[live-store] Neon loadLiveTrades failed, falling back to Supabase:", e);
    const [{ data: account }, { data: open }, { data: closed }] = await Promise.all([
      supabase
        .from("live_accounts")
        .select("realized_pnl")
        .eq("user_id", userId)
        .eq("provider", provider)
        .maybeSingle(),
      supabase
        .from("live_trades")
        .select("*")
        .eq("user_id", userId)
        .eq("provider", provider)
        .eq("status", "open")
        .order("opened_at", { ascending: false }),
      supabase
        .from("live_trades")
        .select("*")
        .eq("user_id", userId)
        .eq("provider", provider)
        .eq("status", "closed")
        .order("closed_at", { ascending: false })
        .limit(200),
    ]);
    return {
      open: (open ?? []).map(mapRow),
      closed: (closed ?? []).map(mapRow),
      realizedPnl: Number(account?.realized_pnl ?? 0),
    };
  }
}
