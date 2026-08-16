// Neon-only data layer. Reads and writes go through Neon (DATABASE_URL).
//
// Server-only (imports the Neon client, which reads process.env.DATABASE_URL)
// — dynamically import this from edge.functions.ts handlers, same convention
// as integrations/supabase/client.server.ts. The runner imports it directly
// since it's a plain Node process with no client bundle to worry about.
import { getNeonSql, getNeonSqlOrNoop, neonEnabled } from "./neon";
import { EMPTY_EDGE_REPORT, type EdgeReport } from "@/lib/edge-model";
import type { ShadowStats } from "@/lib/shadow-book";
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

// ── Boot state (read) ───────────────────────────────────────────────────

export async function loadBootState(
  _supabase: unknown,
  userId: string,
): Promise<{ boot: EngineBootState; report: EdgeReport; signalCount: number }> {
  const sql = getNeonSql();
  let account = (await sql`SELECT * FROM paper_accounts WHERE user_id = ${userId}`)[0] as
    Record<string, unknown> | undefined;
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
}

// ── Signals (write) ─────────────────────────────────────────────────────

export async function ingestSignals(
  _supabase: unknown,
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

  return { inserted: rows.length };
}

// ── Open trade (write) ──────────────────────────────────────────────────

export async function persistOpenTrade(
  _supabase: unknown,
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

  return { ok: true };
}

// ── Close trade (write) ─────────────────────────────────────────────────

export async function persistCloseTrade(
  _supabase: unknown,
  userId: string,
  data: CloseTradeInput,
): Promise<{ report: EdgeReport }> {
  const sql = getNeonSqlOrNoop();
  const updated = await sql`
    UPDATE paper_trades SET
      exit_price = ${data.exitPrice}, pnl = ${data.pnl}, pnl_pct = ${data.pnlPct},
      reason = ${data.reason}, status = 'closed', closed_at = to_timestamp(${data.closedAt / 1000}),
      trigger_price = ${data.triggerPrice ?? data.exitPrice}, exit_slip_bps = ${data.exitSlipBps ?? 0},
      spread_exit_bps = ${data.spreadExitBps ?? 0}, slip_cost_usd = ${data.slipCostUsd ?? 0},
      gross_pnl = ${data.grossPnl ?? data.pnl}, fees = ${data.fees ?? 0}, funding = ${data.funding ?? 0}
    WHERE user_id = ${userId} AND client_id = ${data.clientId}
    RETURNING client_id`;

  // A close that matches no row means the open-row write never landed (a
  // swallowed persist error). realized_pnl below still advances, so the
  // account total silently outruns the trade table — the same signature as
  // the pre-Neon carried history, which makes the two indistinguishable
  // later. Log it loudly; never throw, the engine must keep running.
  if (neonEnabled() && Array.isArray(updated) && updated.length === 0) {
    console.error(
      `[persist] close matched 0 rows for client_id=${data.clientId} — ` +
        `realized_pnl will include $${data.pnl.toFixed(2)} with no trade row behind it`,
    );
  }

  await sql`
    INSERT INTO paper_accounts (user_id, realized_pnl, halted, updated_at)
    VALUES (${userId}, ${data.realizedPnl}, ${data.halted}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      realized_pnl = EXCLUDED.realized_pnl, halted = EXCLUDED.halted, updated_at = now()`;

  const reportRows = await sql`SELECT edge_report(${userId}) AS report`;
  const report = (reportRows[0]?.report as EdgeReport | undefined) ?? EMPTY_EDGE_REPORT;

  return { report };
}

// ── Reset account (write) ───────────────────────────────────────────────

export async function resetPaperAccount(
  _supabase: unknown,
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
  const report = (reportRows[0]?.report as EdgeReport | undefined) ?? EMPTY_EDGE_REPORT;

  return { report };
}

// ── Runner heartbeat (write) ────────────────────────────────────────────

export interface HeartbeatFields {
  status: string;
  equity: number;
  closedTrades: number;
  ticksPerSec: number;
  shadow: ShadowStats;
}

export async function upsertHeartbeat(
  _supabase: unknown,
  userId: string,
  startedAt: Date,
  fields: HeartbeatFields,
): Promise<void> {
  const sql = getNeonSqlOrNoop();
  await sql`
    INSERT INTO runner_state (user_id, status, equity, closed_trades, ticks_per_sec, shadow, started_at, last_seen_at)
    VALUES (${userId}, ${fields.status}, ${fields.equity}, ${fields.closedTrades}, ${fields.ticksPerSec}, ${JSON.stringify(fields.shadow)}::jsonb, ${startedAt.toISOString()}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      status = EXCLUDED.status, equity = EXCLUDED.equity, closed_trades = EXCLUDED.closed_trades,
      ticks_per_sec = EXCLUDED.ticks_per_sec, shadow = EXCLUDED.shadow, last_seen_at = now()`;
}

// ── Runner heartbeat (read) ─────────────────────────────────────────────

export interface RunnerHeartbeatRow {
  status: string;
  equity: number;
  closedTrades: number;
  ticksPerSec: number;
  startedAt: number;
  lastSeenAt: number;
  shadow: ShadowStats | null;
}

export async function getRunnerHeartbeat(userId: string): Promise<RunnerHeartbeatRow | null> {
  const sql = getNeonSqlOrNoop();
  const rows = await sql`
    SELECT status, equity, closed_trades, ticks_per_sec, shadow, started_at, last_seen_at
    FROM runner_state WHERE user_id = ${userId}`;
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const parsedShadow =
    row.shadow === null || row.shadow === undefined
      ? null
      : typeof row.shadow === "string"
        ? (JSON.parse(row.shadow) as ShadowStats)
        : (row.shadow as ShadowStats);
  return {
    status: row.status as string,
    equity: Number(row.equity),
    closedTrades: Number(row.closed_trades),
    ticksPerSec: Number(row.ticks_per_sec),
    startedAt: new Date(row.started_at as string).getTime(),
    lastSeenAt: new Date(row.last_seen_at as string).getTime(),
    shadow: parsedShadow,
  };
}
