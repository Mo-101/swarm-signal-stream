// Neon-only data layer. Reads and writes go through Neon (DATABASE_URL).
//
// Server-only (imports the Neon client, which reads process.env.DATABASE_URL)
// — dynamically import this from edge.functions.ts handlers, same convention
// as integrations/supabase/client.server.ts. The runner imports it directly
// since it's a plain Node process with no client bundle to worry about.
import { getNeonSql, getNeonSqlOrNoop, neonEnabled } from "./neon";
import { EMPTY_EDGE_REPORT, type EdgeReport } from "@/lib/edge-model";
import type { ShadowBookSnapshot, ShadowStats, ShadowTrade } from "@/lib/shadow-book";
import type { FuturesGridConfig, GridRuntimeState } from "@/lib/futures-grid";
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

// ── Shadow book (write) ─────────────────────────────────────────────────

// Both writes are upserts on (user_id, shadow_id) rather than insert-then-
// update: the open write is best-effort and fire-and-forget, so a close must
// still land a complete row even when the open never made it to the database.
// Losing a closed shadow trade loses the evidence the book exists to collect.

export async function persistShadowOpen(userId: string, t: ShadowTrade): Promise<void> {
  const sql = getNeonSqlOrNoop();
  await sql`
    INSERT INTO shadow_trades (
      user_id, shadow_id, symbol, side, reason, confidence, regime, notional,
      entry_price, stop_loss, take_profit, status, last_price, last_marked_at,
      max_favourable_bps, max_adverse_bps, opened_at
    ) VALUES (
      ${userId}, ${t.id}, ${t.symbol}, ${t.side}, ${t.reason}, ${t.confidence},
      ${t.regime}, ${t.notional}, ${t.entryPrice}, ${t.stopLoss}, ${t.takeProfit},
      'open', ${t.lastPrice}, ${new Date(t.lastMarkedAt).toISOString()},
      ${t.maxFavourableBps}, ${t.maxAdverseBps}, ${new Date(t.openedAt).toISOString()}
    )
    ON CONFLICT (user_id, shadow_id) DO UPDATE SET
      last_price = EXCLUDED.last_price,
      last_marked_at = EXCLUDED.last_marked_at,
      max_favourable_bps = EXCLUDED.max_favourable_bps,
      max_adverse_bps = EXCLUDED.max_adverse_bps`;
}

export async function persistShadowClose(userId: string, t: ShadowTrade): Promise<void> {
  const sql = getNeonSqlOrNoop();
  await sql`
    INSERT INTO shadow_trades (
      user_id, shadow_id, symbol, side, reason, confidence, regime, notional,
      entry_price, stop_loss, take_profit, status, last_price, last_marked_at,
      max_favourable_bps, max_adverse_bps, exit_price, exit_reason,
      gross_bps, net_bps, net_usd, fee_usd, funding_usd, opened_at, closed_at
    ) VALUES (
      ${userId}, ${t.id}, ${t.symbol}, ${t.side}, ${t.reason}, ${t.confidence},
      ${t.regime}, ${t.notional}, ${t.entryPrice}, ${t.stopLoss}, ${t.takeProfit},
      'closed', ${t.lastPrice}, ${new Date(t.lastMarkedAt).toISOString()},
      ${t.maxFavourableBps}, ${t.maxAdverseBps}, ${t.exitPrice}, ${t.exitReason},
      ${t.grossBps}, ${t.netBps}, ${t.netUsd}, ${t.feeUsd}, ${t.fundingUsd},
      ${new Date(t.openedAt).toISOString()},
      ${t.closedAt === null ? null : new Date(t.closedAt).toISOString()}
    )
    ON CONFLICT (user_id, shadow_id) DO UPDATE SET
      status = 'closed',
      last_price = EXCLUDED.last_price,
      last_marked_at = EXCLUDED.last_marked_at,
      max_favourable_bps = EXCLUDED.max_favourable_bps,
      max_adverse_bps = EXCLUDED.max_adverse_bps,
      exit_price = EXCLUDED.exit_price,
      exit_reason = EXCLUDED.exit_reason,
      gross_bps = EXCLUDED.gross_bps,
      net_bps = EXCLUDED.net_bps,
      net_usd = EXCLUDED.net_usd,
      fee_usd = EXCLUDED.fee_usd,
      funding_usd = EXCLUDED.funding_usd,
      closed_at = EXCLUDED.closed_at`;
}

// ── Shadow book (read) ──────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapShadowRow(row: any): ShadowTrade {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    id: row.shadow_id,
    symbol: row.symbol,
    side: row.side,
    reason: row.reason,
    confidence: Number(row.confidence),
    regime: row.regime,
    notional: Number(row.notional),
    entryPrice: Number(row.entry_price),
    stopLoss: Number(row.stop_loss),
    takeProfit: Number(row.take_profit),
    openedAt: new Date(row.opened_at).getTime(),
    lastPrice: Number(row.last_price),
    lastMarkedAt: new Date(row.last_marked_at).getTime(),
    maxFavourableBps: Number(row.max_favourable_bps),
    maxAdverseBps: Number(row.max_adverse_bps),
    exitPrice: num(row.exit_price),
    closedAt: row.closed_at ? new Date(row.closed_at).getTime() : null,
    exitReason: row.exit_reason,
    netBps: num(row.net_bps),
    netUsd: num(row.net_usd),
    grossBps: num(row.gross_bps),
    feeUsd: num(row.fee_usd),
    fundingUsd: num(row.funding_usd),
  };
}

/**
 * Rebuild a shadow book snapshot from persisted rows.
 *
 * `notional` is the one economics field stored per row, so it is the guard
 * used here: rows opened under a different shadow notional are dropped rather
 * than mixed into stats they are not comparable with. The caller supplies the
 * remaining economics from its live config, and ShadowBook.restore() applies
 * its own per-row structural validation on top.
 */
export async function loadShadowBook(
  userId: string,
  economics: ShadowBookSnapshot["economics"],
  limits: { maxOpen: number; maxClosed: number },
): Promise<ShadowBookSnapshot> {
  if (!neonEnabled()) {
    return { version: 1, seq: 0, economics, open: [], closed: [] };
  }

  const sql = getNeonSql();
  const openRows = await sql`
    SELECT * FROM shadow_trades
    WHERE user_id = ${userId} AND status = 'open' AND notional = ${economics.notional}
    ORDER BY opened_at DESC LIMIT ${limits.maxOpen}`;
  const closedRows = await sql`
    SELECT * FROM shadow_trades
    WHERE user_id = ${userId} AND status = 'closed' AND notional = ${economics.notional}
    ORDER BY closed_at DESC LIMIT ${limits.maxClosed}`;

  const open = openRows.map(mapShadowRow);
  // Query takes the newest maxClosed; reverse back to chronological order so
  // the in-memory book keeps trimming its oldest entries first.
  const closed = closedRows.map(mapShadowRow).reverse();

  // Trade ids are `shadow-<openedAt>-<seq>`. Resuming past the highest seq
  // already issued keeps ids unique across restarts.
  const seq = [...open, ...closed].reduce((max, t) => {
    const parsed = Number(t.id.split("-").pop());
    return Number.isSafeInteger(parsed) && parsed > max ? parsed : max;
  }, 0);

  return { version: 1, seq, economics, open, closed };
}

// ── Futures grid control plane ──────────────────────────────────────────

// Desired state (what the user asked for) is kept separate from runtime state
// (what the runner is doing). The web process only ever writes intent and bumps
// config_version; the runner claims the row, applies it, and sets
// applied_version. config_version > applied_version means unapplied work, which
// is what makes the reconcile loop idempotent.

export type GridDesiredState = "stopped" | "running";

export type GridRuntimeStatus = "idle" | "starting" | "running" | "halted" | "stopping" | "error";

export interface PersistedGridState {
  id: string;
  userId: string;
  symbol: string;
  desiredState: GridDesiredState;
  runtimeStatus: GridRuntimeStatus;
  config: FuturesGridConfig;
  runtimeState: GridRuntimeState | null;
  configVersion: number;
  appliedVersion: number;
  claimedBy: string | null;
  claimedAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

function parseJsonColumn<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapGridRow(row: any): PersistedGridState {
  return {
    id: row.id,
    userId: row.user_id,
    symbol: row.symbol,
    desiredState: row.desired_state,
    runtimeStatus: row.runtime_status,
    config: parseJsonColumn<FuturesGridConfig>(row.config) as FuturesGridConfig,
    runtimeState: parseJsonColumn<GridRuntimeState>(row.runtime_state),
    configVersion: Number(row.config_version),
    appliedVersion: Number(row.applied_version),
    claimedBy: row.claimed_by ?? null,
    claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
    lastError: row.last_error ?? null,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * Write desired configuration and bump config_version so the runner picks it
 * up. The bump happens inside the UPSERT rather than as a read-then-write, so
 * two concurrent writers cannot both read version N and both write N+1.
 */
export async function upsertGridConfig(args: {
  userId: string;
  config: FuturesGridConfig;
  desiredState: GridDesiredState;
}): Promise<PersistedGridState> {
  const sql = getNeonSql();
  const rows = await sql`
    INSERT INTO futures_grid_state (user_id, symbol, config, desired_state, config_version, updated_at)
    VALUES (${args.userId}, ${args.config.symbol}, ${JSON.stringify(args.config)}::jsonb,
            ${args.desiredState}, 1, now())
    ON CONFLICT (user_id, symbol) DO UPDATE SET
      config = EXCLUDED.config,
      desired_state = EXCLUDED.desired_state,
      config_version = futures_grid_state.config_version + 1,
      last_error = NULL,
      updated_at = now()
    RETURNING *`;

  return mapGridRow(rows[0]);
}

export async function loadGridStatesForUser(userId: string): Promise<PersistedGridState[]> {
  if (!neonEnabled()) return [];
  const sql = getNeonSql();
  const rows = await sql`
    SELECT * FROM futures_grid_state WHERE user_id = ${userId} ORDER BY updated_at DESC`;
  return (rows as Record<string, unknown>[]).map(mapGridRow);
}

/**
 * Rows the runner must act on: anything the user wants running, plus anything
 * still reported as running/starting so a grid that was stopped mid-flight is
 * driven back to idle rather than stranded.
 *
 * Scoped to one user — this runner signs in as a single account, and a global
 * query would have it reconciling grids it has no business touching.
 */
export async function loadRunnableGridStates(userId: string): Promise<PersistedGridState[]> {
  if (!neonEnabled()) return [];
  const sql = getNeonSql();
  const rows = await sql`
    SELECT * FROM futures_grid_state
    WHERE user_id = ${userId}
      AND (desired_state = 'running' OR runtime_status IN ('running', 'starting'))
    ORDER BY symbol`;
  return (rows as Record<string, unknown>[]).map(mapGridRow);
}

export async function persistGridRuntime(args: {
  id: string;
  runtimeStatus: GridRuntimeStatus;
  runtimeState: GridRuntimeState | null;
  appliedVersion: number;
  claimedBy: string;
  lastError?: string | null;
}): Promise<void> {
  const sql = getNeonSqlOrNoop();
  await sql`
    UPDATE futures_grid_state SET
      runtime_status = ${args.runtimeStatus},
      runtime_state = ${args.runtimeState === null ? null : JSON.stringify(args.runtimeState)}::jsonb,
      applied_version = ${args.appliedVersion},
      claimed_by = ${args.claimedBy},
      claimed_at = now(),
      last_error = ${args.lastError ?? null},
      updated_at = now()
    WHERE id = ${args.id}`;
}

/**
 * Ongoing runtime marking, keyed by symbol so the engine never has to know a
 * database id.
 *
 * Writes runtime_state on every call but only ever *escalates* runtime_status,
 * and only to 'halted'. The lifecycle status belongs to the coordinator: a
 * freshly built grid is legitimately inactive, so letting this path derive
 * status from state.active would rewrite 'running' back to 'idle' on the next
 * tick, and the coordinator would answer that by rebuilding the grid — a
 * reconfigure loop. desired_state and the version columns are likewise
 * untouched here.
 */
export async function persistGridRuntimeBySymbol(args: {
  userId: string;
  symbol: string;
  runtimeState: GridRuntimeState;
  halted: boolean;
}): Promise<void> {
  const sql = getNeonSqlOrNoop();
  await sql`
    UPDATE futures_grid_state SET
      runtime_state = ${JSON.stringify(args.runtimeState)}::jsonb,
      runtime_status = CASE WHEN ${args.halted} THEN 'halted' ELSE runtime_status END,
      updated_at = now()
    WHERE user_id = ${args.userId} AND symbol = ${args.symbol}`;
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
