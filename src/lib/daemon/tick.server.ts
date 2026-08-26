// Cloud safety-net daemon.
//
// The real 24/7 engine is the VPS runner (runner/index.ts) — it holds the
// WebSocket, votes the agents and opens trades. This module is the fallback
// that runs on a one-minute pg_cron schedule inside the app itself: whenever
// no runner heartbeat is fresh AND no dashboard tab is driving the book, it
// pulls REST marks from Bybit and settles any open paper position whose stop,
// target or liquidation level has been crossed.
//
// It deliberately does NOT open new positions: entries need the streaming
// microstructure the runner has and a minute-resolution cron does not. Its
// job is that an unattended book never sits through a stop.
//
// Server-only: imports the service-role client. Never reachable from the
// client bundle.
import { grossPnl, roiPct, takerFee, fundingIntervalsBetween, fundingPayment } from "@/lib/math/perp";
import { DEFAULT_PAPER_CONFIG } from "@/lib/paper-broker";

/** How stale a runner/dashboard heartbeat must be before we take over (ms). */
const TAKEOVER_AFTER_MS = 120_000;
/** Work bounds per invocation — a cron job must always terminate. */
const MAX_USERS = 10;
const MAX_POSITIONS = 100;
/** Lease length for the single-flight lock. */
const LOCK_MS = 55_000;

const LOCK_ID = "paper-watchdog";

export interface DaemonTickResult {
  ran: boolean;
  reason: string;
  scannedUsers: number;
  scannedPositions: number;
  closed: { symbol: string; side: string; reason: string; pnl: number }[];
  errors: string[];
}

type Sb = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

interface TickerMap {
  [symbol: string]: number;
}

async function fetchMarks(): Promise<TickerMap> {
  const res = await fetch("https://api.bybit.com/v5/market/tickers?category=linear");
  if (!res.ok) throw new Error(`Bybit tickers HTTP ${res.status}`);
  const body = (await res.json()) as {
    result?: { list?: { symbol: string; lastPrice: string; markPrice?: string }[] };
  };
  const map: TickerMap = {};
  for (const t of body.result?.list ?? []) {
    const px = Number(t.markPrice ?? t.lastPrice);
    if (Number.isFinite(px) && px > 0) map[t.symbol] = px;
  }
  return map;
}

/** Acquire the single-flight lease. Returns false when another run holds it. */
async function acquireLock(sb: Sb): Promise<{ ok: boolean; paused: boolean }> {
  const now = new Date();
  const { data: row } = await sb
    .from("daemon_state")
    .select("locked_until, paused")
    .eq("id", LOCK_ID)
    .maybeSingle();

  if (row?.paused) return { ok: false, paused: true };
  if (row?.locked_until && new Date(row.locked_until as string) > now) {
    return { ok: false, paused: false };
  }
  const { error } = await sb.from("daemon_state").upsert(
    {
      id: LOCK_ID,
      locked_until: new Date(now.getTime() + LOCK_MS).toISOString(),
      last_run_at: now.toISOString(),
      updated_at: now.toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) throw new Error(`lock upsert failed: ${error.message}`);
  return { ok: true, paused: false };
}

async function releaseLock(sb: Sb, result: DaemonTickResult): Promise<void> {
  await sb.from("daemon_state").upsert(
    {
      id: LOCK_ID,
      locked_until: null,
      last_status: result.errors.length ? "error" : result.ran ? "ok" : "idle",
      last_result: JSON.parse(JSON.stringify(result)),
      consecutive_errors: result.errors.length ? 1 : 0,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
}

export async function runDaemonTick(): Promise<DaemonTickResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const sb = supabaseAdmin;
  const result: DaemonTickResult = {
    ran: false,
    reason: "",
    scannedUsers: 0,
    scannedPositions: 0,
    closed: [],
    errors: [],
  };

  const lock = await acquireLock(sb);
  if (!lock.ok) {
    result.reason = lock.paused ? "daemon paused" : "another run holds the lease";
    return result;
  }

  try {
    const { data: open } = await sb
      .from("paper_trades")
      .select(
        "user_id, client_id, symbol, side, entry_price, size, notional, stop_loss, take_profit, liq_price, opened_at",
      )
      .eq("status", "open")
      .order("opened_at", { ascending: true })
      .limit(MAX_POSITIONS);

    const positions = open ?? [];
    if (positions.length === 0) {
      result.ran = true;
      result.reason = "no open positions";
      return result;
    }

    // Only take over for users whose live driver (runner or dashboard tab)
    // has gone quiet — otherwise the engine owns these positions.
    const userIds = [...new Set(positions.map((p) => p.user_id as string))].slice(0, MAX_USERS);
    const { data: beats } = await sb
      .from("runner_state")
      .select("user_id, last_seen_at, status")
      .in("user_id", userIds);
    const fresh = new Set(
      (beats ?? [])
        .filter(
          (b) =>
            b.status === "running" &&
            Date.now() - new Date(b.last_seen_at as string).getTime() < TAKEOVER_AFTER_MS,
        )
        .map((b) => b.user_id as string),
    );
    const orphaned = userIds.filter((u) => !fresh.has(u));
    result.scannedUsers = orphaned.length;
    if (orphaned.length === 0) {
      result.ran = true;
      result.reason = "live driver active for every account";
      return result;
    }

    const marks = await fetchMarks();
    const now = Date.now();
    const cfg = DEFAULT_PAPER_CONFIG;

    // Realized PnL is accumulated per user and written once at the end.
    const realizedDelta: Record<string, number> = {};

    for (const p of positions) {
      const userId = p.user_id as string;
      if (!orphaned.includes(userId)) continue;
      const mark = marks[p.symbol as string];
      if (!mark) continue;
      result.scannedPositions += 1;

      const side = p.side as "BUY" | "SELL";
      const entry = Number(p.entry_price);
      const size = Number(p.size);
      const sl = Number(p.stop_loss);
      const tp = Number(p.take_profit);
      const liq = p.liq_price === null ? null : Number(p.liq_price);

      let reason: "SL" | "TP" | "LIQ" | null = null;
      let exit = mark;
      if (liq !== null && ((side === "BUY" && mark <= liq) || (side === "SELL" && mark >= liq))) {
        reason = "LIQ";
        exit = liq;
      } else if ((side === "BUY" && mark <= sl) || (side === "SELL" && mark >= sl)) {
        reason = "SL";
        exit = sl;
      } else if ((side === "BUY" && mark >= tp) || (side === "SELL" && mark <= tp)) {
        reason = "TP";
        exit = tp;
      }
      if (!reason) continue;

      const entryNotional = entry * size;
      const exitNotional = exit * size;
      const gross = grossPnl(entry, exit, size, side);
      const fees =
        takerFee(entryNotional, cfg.takerFeeRate) + takerFee(exitNotional, cfg.takerFeeRate);
      const intervals = fundingIntervalsBetween(new Date(p.opened_at as string).getTime(), now);
      const funding =
        intervals * fundingPayment(entryNotional, cfg.defaultFundingRate, side);
      const pnl = gross - fees - funding;

      const { error: upErr } = await sb
        .from("paper_trades")
        .update({
          status: "closed",
          exit_price: exit,
          trigger_price: exit,
          pnl,
          pnl_pct: roiPct(pnl, entryNotional),
          gross_pnl: gross,
          fees,
          funding,
          reason,
          closed_at: new Date(now).toISOString(),
        })
        .eq("user_id", userId)
        .eq("client_id", p.client_id as string)
        .eq("status", "open");

      if (upErr) {
        result.errors.push(`${p.symbol}: ${upErr.message}`);
        continue;
      }
      realizedDelta[userId] = (realizedDelta[userId] ?? 0) + pnl;
      result.closed.push({ symbol: p.symbol as string, side, reason, pnl });
    }

    for (const [userId, delta] of Object.entries(realizedDelta)) {
      const { data: acct } = await sb
        .from("paper_accounts")
        .select("realized_pnl")
        .eq("user_id", userId)
        .maybeSingle();
      const next = Number(acct?.realized_pnl ?? 0) + delta;
      const { error } = await sb
        .from("paper_accounts")
        .upsert({ user_id: userId, realized_pnl: next, updated_at: new Date().toISOString() }, {
          onConflict: "user_id",
        });
      if (error) result.errors.push(`account ${userId}: ${error.message}`);
    }

    result.ran = true;
    result.reason = result.closed.length
      ? `settled ${result.closed.length} position(s) for ${result.scannedUsers} unattended account(s)`
      : `watched ${result.scannedPositions} position(s), nothing triggered`;
    return result;
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e));
    result.reason = "tick failed";
    return result;
  } finally {
    await releaseLock(sb, result).catch(() => {});
  }
}
