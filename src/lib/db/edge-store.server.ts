// Neon-primary, Supabase-mirror data layer. Neon is authoritative: a write
// that fails on Neon fails the whole call. The Supabase write is a
// best-effort mirror — its failure is logged but never fails the caller.
// Reads try Neon first and fall back to Supabase if Neon is unreachable.
//
// Server-only (imports the Neon client, which reads process.env.DATABASE_URL)
// — dynamically import this from edge.functions.ts handlers, same convention
// as integrations/supabase/client.server.ts. The runner imports it directly
// since it's a plain Node process with no client bundle to worry about.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getNeonSql, getNeonSqlOrNoop, neonEnabled } from "./neon";
import { EMPTY_EDGE_REPORT, type EdgeReport } from "@/lib/edge-model";
import type {
  StoredTrade,
  SignalInput,
  OpenTradeInput,
  CloseTradeInput,
  EngineBootState,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapTradeRow(row: any): StoredTrade {
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

function logMirrorError(op: string, e: unknown) {
  console.error(`[edge-store] Supabase mirror ${op} failed:`, e instanceof Error ? e.message : e);
}

// ── One-time reconciliation ─────────────────────────────────────────────
// Dual-write only covers trades made *after* Neon was wired up — anything
// that existed only in Supabase before that point never got copied over, so
// a Neon read would silently show an incomplete history (and an
// undercounted edge_report) for any account with pre-migration trades. This
// closes that gap using the caller's own already-authenticated Supabase
// session — no service-role key needed. Idempotent (ON CONFLICT DO NOTHING),
// and the count check makes every call after the first one a single cheap
// query instead of a full re-copy.
async function reconcileFromSupabaseIfBehind(supabase: SupabaseClient, userId: string) {
  const sql = getNeonSql();
  const neonCountRows = await sql`SELECT count(*)::int AS n FROM paper_trades WHERE user_id = ${userId}`;
  const neonCount = (neonCountRows[0]?.n as number | undefined) ?? 0;
  const { count: supabaseCount } = await supabase
    .from("paper_trades")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if ((supabaseCount ?? 0) <= neonCount) return;

  console.log(
    `[edge-store] Neon behind for user ${userId} (${neonCount} < ${supabaseCount}) — backfilling from Supabase`,
  );
  const { data: rows } = await supabase.from("paper_trades").select("*").eq("user_id", userId);
  for (const r of rows ?? []) {
    await sql`
      INSERT INTO paper_trades (
        user_id, client_id, symbol, side, entry_price, exit_price, size, notional,
        stop_loss, take_profit, confidence, conf_bucket, agents, regime, hour_utc, status,
        pnl, pnl_pct, reason, opened_at, closed_at,
        signal_price, entry_slip_bps, exit_slip_bps, trigger_price, spread_entry_bps, spread_exit_bps,
        latency_ms, slip_cost_usd, gross_pnl, fees, funding, leverage, liq_price, book_priced
      ) VALUES (
        ${userId}, ${r.client_id}, ${r.symbol}, ${r.side}, ${r.entry_price}, ${r.exit_price}, ${r.size}, ${r.notional},
        ${r.stop_loss}, ${r.take_profit}, ${r.confidence}, ${r.conf_bucket}, ${JSON.stringify(r.agents ?? {})}::jsonb,
        ${r.regime}, ${r.hour_utc}, ${r.status},
        ${r.pnl}, ${r.pnl_pct}, ${r.reason}, ${r.opened_at}, ${r.closed_at},
        ${r.signal_price}, ${r.entry_slip_bps}, ${r.exit_slip_bps}, ${r.trigger_price}, ${r.spread_entry_bps}, ${r.spread_exit_bps},
        ${r.latency_ms}, ${r.slip_cost_usd}, ${r.gross_pnl}, ${r.fees}, ${r.funding}, ${r.leverage}, ${r.liq_price}, ${r.book_priced}
      )
      ON CONFLICT (user_id, client_id) DO NOTHING`;
  }

  const { data: acct } = await supabase
    .from("paper_accounts")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (acct) {
    await sql`
      INSERT INTO paper_accounts (user_id, starting_balance, realized_pnl, halted)
      VALUES (${userId}, ${acct.starting_balance}, ${acct.realized_pnl}, ${acct.halted})
      ON CONFLICT (user_id) DO UPDATE SET
        realized_pnl = EXCLUDED.realized_pnl, halted = EXCLUDED.halted`;
  }
  console.log(`[edge-store] backfill complete for user ${userId}: ${rows?.length ?? 0} trades copied`);
}

// ── Boot state (read) ───────────────────────────────────────────────────

export async function loadBootState(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ boot: EngineBootState; report: EdgeReport; signalCount: number }> {
  if (!neonEnabled()) return loadBootStateFromSupabase(supabase, userId);
  try {
    await reconcileFromSupabaseIfBehind(supabase, userId);
    const sql = getNeonSql();
    let account = (
      await sql`SELECT * FROM paper_accounts WHERE user_id = ${userId}`
    )[0] as Record<string, unknown> | undefined;
    if (!account) {
      account = (
        await sql`INSERT INTO paper_accounts (user_id) VALUES (${userId}) RETURNING *`
      )[0] as Record<string, unknown>;
    }
    const open = await sql`
      SELECT * FROM paper_trades WHERE user_id = ${userId} AND status = 'open'
      ORDER BY opened_at DESC`;
    const closed = await sql`
      SELECT * FROM paper_trades WHERE user_id = ${userId} AND status = 'closed'
      ORDER BY closed_at DESC LIMIT 200`;
    const reportRows = await sql`SELECT edge_report(${userId}) AS report`;
    const signalCountRows =
      await sql`SELECT count(*)::int AS count FROM signals WHERE user_id = ${userId}`;

    return {
      boot: {
        account: {
          startingBalance: Number(account.starting_balance ?? 10000),
          realizedPnl: Number(account.realized_pnl ?? 0),
          halted: Boolean(account.halted),
        },
        open: open.map(mapTradeRow),
        closed: closed.map(mapTradeRow),
      },
      report: (reportRows[0]?.report as EdgeReport | undefined) ?? EMPTY_EDGE_REPORT,
      signalCount: (signalCountRows[0]?.count as number | undefined) ?? 0,
    };
  } catch (e) {
    console.error("[edge-store] Neon loadBootState failed, falling back to Supabase:", e);
    return loadBootStateFromSupabase(supabase, userId);
  }
}

async function loadBootStateFromSupabase(supabase: SupabaseClient, userId: string) {
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
      open: (open ?? []).map(mapTradeRow),
      closed: (closed ?? []).map(mapTradeRow),
    },
    report: (report as EdgeReport | null) ?? EMPTY_EDGE_REPORT,
    signalCount: signalCount ?? 0,
  };
}

// ── Signals (write) ─────────────────────────────────────────────────────

export async function ingestSignals(
  supabase: SupabaseClient,
  userId: string,
  signals: SignalInput[],
): Promise<{ inserted: number }> {
  const rows = signals.slice(0, 1000);
  if (rows.length === 0) return { inserted: 0 };

  const sql = getNeonSqlOrNoop();
  await sql`
    INSERT INTO signals (user_id, symbol, side, price, confidence, conf_bucket, regime, hour_utc, agents, executed)
    SELECT * FROM UNNEST(
      ${rows.map(() => userId)}::uuid[],
      ${rows.map((s) => s.symbol)}::text[],
      ${rows.map((s) => s.side)}::text[],
      ${rows.map((s) => s.price)}::numeric[],
      ${rows.map((s) => s.confidence)}::numeric[],
      ${rows.map((s) => s.confBucket)}::text[],
      ${rows.map((s) => s.regime)}::text[],
      ${rows.map((s) => s.hourUtc)}::smallint[],
      ${rows.map((s) => JSON.stringify(s.agents))}::jsonb[],
      ${rows.map((s) => s.executed)}::boolean[]
    )`;

  await supabase
    .from("signals")
    .insert(
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
    )
    .then(({ error }) => {
      if (error) logMirrorError("ingestSignals", error);
    });

  return { inserted: rows.length };
}

// ── Open trade (write) ──────────────────────────────────────────────────

export async function persistOpenTrade(
  supabase: SupabaseClient,
  userId: string,
  data: OpenTradeInput,
): Promise<{ ok: true }> {
  const sql = getNeonSqlOrNoop();
  await sql`
    INSERT INTO paper_trades (
      user_id, client_id, symbol, side, entry_price, size, notional, stop_loss, take_profit,
      confidence, conf_bucket, regime, hour_utc, agents, status, opened_at,
      signal_price, entry_slip_bps, spread_entry_bps, latency_ms, leverage, liq_price, book_priced
    ) VALUES (
      ${userId}, ${data.clientId}, ${data.symbol}, ${data.side}, ${data.entryPrice}, ${data.size},
      ${data.notional}, ${data.stopLoss}, ${data.takeProfit}, ${data.confidence}, ${data.confBucket},
      ${data.regime}, ${data.hourUtc}, ${JSON.stringify(data.agents)}::jsonb, 'open',
      to_timestamp(${data.openedAt / 1000}),
      ${data.signalPrice ?? data.entryPrice}, ${data.entrySlipBps ?? 0}, ${data.spreadEntryBps ?? 0},
      ${data.latencyMs ?? 0}, ${data.leverage ?? null}, ${data.liqPrice ?? null}, ${data.bookPriced ?? false}
    )
    ON CONFLICT (user_id, client_id) DO UPDATE SET
      entry_price = EXCLUDED.entry_price, size = EXCLUDED.size, notional = EXCLUDED.notional,
      stop_loss = EXCLUDED.stop_loss, take_profit = EXCLUDED.take_profit, status = 'open'`;

  await supabase
    .from("paper_trades")
    .upsert(
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
    )
    .then(({ error }) => {
      if (error) logMirrorError("persistOpenTrade", error);
    });

  return { ok: true };
}

// ── Close trade (write) ─────────────────────────────────────────────────

export async function persistCloseTrade(
  supabase: SupabaseClient,
  userId: string,
  data: CloseTradeInput,
): Promise<{ report: EdgeReport }> {
  const sql = getNeonSqlOrNoop();
  await sql`
    UPDATE paper_trades SET
      exit_price = ${data.exitPrice}, pnl = ${data.pnl}, pnl_pct = ${data.pnlPct},
      reason = ${data.reason}, status = 'closed', closed_at = to_timestamp(${data.closedAt / 1000}),
      trigger_price = ${data.triggerPrice ?? data.exitPrice}, exit_slip_bps = ${data.exitSlipBps ?? 0},
      spread_exit_bps = ${data.spreadExitBps ?? 0}, slip_cost_usd = ${data.slipCostUsd ?? 0},
      gross_pnl = ${data.grossPnl ?? data.pnl}, fees = ${data.fees ?? 0}, funding = ${data.funding ?? 0}
    WHERE user_id = ${userId} AND client_id = ${data.clientId}`;

  await sql`
    INSERT INTO paper_accounts (user_id, realized_pnl, halted, updated_at)
    VALUES (${userId}, ${data.realizedPnl}, ${data.halted}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      realized_pnl = EXCLUDED.realized_pnl, halted = EXCLUDED.halted, updated_at = now()`;

  const reportRows = await sql`SELECT edge_report(${userId}) AS report`;
  const report =
    (reportRows[0]?.report as EdgeReport | undefined) ??
    ((await supabase.rpc("edge_report")).data as EdgeReport | null) ??
    EMPTY_EDGE_REPORT;

  await (async () => {
    const { error: updateErr } = await supabase
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
    if (updateErr) logMirrorError("persistCloseTrade (trade update)", updateErr);

    const { error: acctErr } = await supabase.from("paper_accounts").upsert(
      {
        user_id: userId,
        realized_pnl: data.realizedPnl,
        halted: data.halted,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (acctErr) logMirrorError("persistCloseTrade (account upsert)", acctErr);
  })();

  return { report };
}

// ── Reset account (write) ───────────────────────────────────────────────

export async function resetPaperAccount(
  supabase: SupabaseClient,
  userId: string,
  wipeHistory: boolean,
): Promise<{ report: EdgeReport }> {
  const sql = getNeonSqlOrNoop();
  if (wipeHistory) {
    await sql`DELETE FROM paper_trades WHERE user_id = ${userId}`;
    await sql`DELETE FROM signals WHERE user_id = ${userId}`;
  } else {
    await sql`DELETE FROM paper_trades WHERE user_id = ${userId} AND status = 'open'`;
  }
  await sql`
    INSERT INTO paper_accounts (user_id, realized_pnl, halted, updated_at)
    VALUES (${userId}, 0, false, now())
    ON CONFLICT (user_id) DO UPDATE SET realized_pnl = 0, halted = false, updated_at = now()`;
  const reportRows = await sql`SELECT edge_report(${userId}) AS report`;
  const report =
    (reportRows[0]?.report as EdgeReport | undefined) ??
    ((await supabase.rpc("edge_report")).data as EdgeReport | null) ??
    EMPTY_EDGE_REPORT;

  await (async () => {
    if (wipeHistory) {
      await supabase.from("paper_trades").delete().eq("user_id", userId);
      await supabase.from("signals").delete().eq("user_id", userId);
    } else {
      await supabase.from("paper_trades").delete().eq("user_id", userId).eq("status", "open");
    }
    const { error } = await supabase.from("paper_accounts").upsert(
      { user_id: userId, realized_pnl: 0, halted: false, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    if (error) logMirrorError("resetPaperAccount", error);
  })();

  return { report };
}

// ── Runner heartbeat (write) ────────────────────────────────────────────

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
): Promise<void> {
  const sql = getNeonSqlOrNoop();
  await sql`
    INSERT INTO runner_state (user_id, status, equity, closed_trades, ticks_per_sec, started_at, last_seen_at)
    VALUES (${userId}, ${fields.status}, ${fields.equity}, ${fields.closedTrades}, ${fields.ticksPerSec}, ${startedAt.toISOString()}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      status = EXCLUDED.status, equity = EXCLUDED.equity, closed_trades = EXCLUDED.closed_trades,
      ticks_per_sec = EXCLUDED.ticks_per_sec, last_seen_at = now()`;

  await supabase
    .from("runner_state")
    .upsert(
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
    )
    .then(({ error }) => {
      if (error) logMirrorError("upsertHeartbeat", error);
    });
}

// Note: the dashboard reads runner_state directly from Supabase in the
// browser (it can't reach Neon — no server round-trip for that poll today).
// upsertHeartbeat above mirrors every write to Supabase, so that read stays
// fresh without needing a Neon-aware server function for it.
