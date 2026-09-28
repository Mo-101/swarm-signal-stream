// Dashboard read plane for the Signal Court. Read-only: nothing here writes to
// the database or places an order.
//
// Server modules (Neon client, candle fetcher) are imported dynamically inside
// the handlers, same convention as edge.functions.ts, so they never ship in the
// client bundle.
import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth/auth-middleware";
import type { CourtTrade, Verdict } from "@/lib/court/court";

export interface EvidenceRow {
  signalId: string;
  symbol: string;
  side: string;
  score: number | null;
  admitted: boolean;
  rejectReason: string | null;
  firstSeenAt: string;
}

export interface CourtOverview {
  judgedAt: string;
  trades: {
    count: number;
    costUnrecorded: number;
    epochs: string[];
    verdicts: Verdict[];
  };
  evidence: {
    tableReady: boolean;
    total: number;
    admitted: number;
    last24h: number;
    firstAt: string | null;
    recent: EvidenceRow[];
  };
  error: string | null;
}

export interface ReplaySummary {
  ranAt: string;
  recorded: number;
  replayed: number;
  exits: Record<string, number>;
  skipped: Record<string, number>;
  defaultBrackets: number;
  verdicts: Verdict[];
  recentTrades: CourtTrade[];
  cached: boolean;
}

/** Trade-level verdicts for every epoch/source, plus the SigmaLui evidence stream. */
export const getCourtOverview = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }): Promise<CourtOverview> => {
    const out: CourtOverview = {
      judgedAt: new Date().toISOString(),
      trades: { count: 0, costUnrecorded: 0, epochs: [], verdicts: [] },
      evidence: { tableReady: false, total: 0, admitted: 0, last24h: 0, firstAt: null, recent: [] },
      error: null,
    };
    try {
      const { getNeonSql } = await import("@/lib/db/neon");
      const { buildDocket, judgeAll } = await import("@/lib/court/court");
      const sql = getNeonSql();

      const rows = (await sql`
        SELECT id::text, symbol, side, strategy_epoch, agents, opened_at, closed_at,
               notional::float8 AS notional, gross_pnl::float8 AS gross, pnl::float8 AS net,
               coalesce(fees, 0)::float8 AS fees, coalesce(funding, 0)::float8 AS funding
          FROM paper_trades
         WHERE user_id = ${context.userId} AND status = 'closed'
           AND pnl IS NOT NULL AND closed_at IS NOT NULL
         ORDER BY closed_at ASC`) as Record<string, unknown>[];
      const trades: CourtTrade[] = rows.map((r) => {
        if (Number(r.fees) === 0 && Number(r.funding) === 0) out.trades.costUnrecorded++;
        return {
          id: String(r.id),
          symbol: String(r.symbol),
          side: String(r.side),
          epoch: String(r.strategy_epoch ?? "v1"),
          sources: Object.keys((r.agents as Record<string, unknown>) ?? {}),
          openedAt: new Date(r.opened_at as string).getTime(),
          closedAt: new Date(r.closed_at as string).getTime(),
          notional: Number(r.notional),
          grossUsd: r.gross == null ? Number(r.net) : Number(r.gross),
          netUsd: Number(r.net),
        };
      });
      out.trades.count = trades.length;
      out.trades.epochs = [...new Set(trades.map((t) => t.epoch))].sort();
      out.trades.verdicts = trades.length ? judgeAll(trades, buildDocket(trades)) : [];

      try {
        const [agg] = (await sql`
          SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE admitted)::int AS admitted,
                 count(*) FILTER (WHERE first_seen_at > now() - interval '24 hours')::int AS last24h,
                 min(first_seen_at) AS first_at
            FROM sigmalui_signals`) as Record<string, unknown>[];
        const recent = (await sql`
          SELECT signal_id, symbol, side, score::float8 AS score, admitted, reject_reason, first_seen_at
            FROM sigmalui_signals ORDER BY first_seen_at DESC LIMIT 25`) as Record<
          string,
          unknown
        >[];
        out.evidence = {
          tableReady: true,
          total: Number(agg.total),
          admitted: Number(agg.admitted),
          last24h: Number(agg.last24h),
          firstAt: agg.first_at ? new Date(agg.first_at as string).toISOString() : null,
          recent: recent.map((r) => ({
            signalId: String(r.signal_id),
            symbol: String(r.symbol),
            side: String(r.side),
            score: r.score == null ? null : Number(r.score),
            admitted: Boolean(r.admitted),
            rejectReason: r.reject_reason == null ? null : String(r.reject_reason),
            firstSeenAt: new Date(r.first_seen_at as string).toISOString(),
          })),
        };
      } catch {
        // sigmalui_signals not created yet: apply schema.sql. Reported, not fatal.
        out.evidence.tableReady = false;
      }
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e);
    }
    return out;
  });

let replayCache: { key: string; at: number; value: ReplaySummary } | null = null;
const REPLAY_TTL_MS = 10 * 60_000;

/** Replay every recorded SigmaLui signal against Bybit candles and judge it.
 *  Heavy (one candle fetch per symbol), so results are cached for 10 minutes. */
export const runSigmaLuiReplay = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async (): Promise<ReplaySummary> => {
    const { getNeonSql } = await import("@/lib/db/neon");
    const { runReplay } = await import("@/lib/court/replay-run.server");
    const sql = getNeonSql();
    const rows = (await sql`
      SELECT signal_id, symbol, side, score::float8 AS score, entry_price::float8 AS entry,
             stop_loss::float8 AS sl, take_profit::float8 AS tp, first_seen_at, admitted
        FROM sigmalui_signals ORDER BY first_seen_at ASC`) as Record<string, unknown>[];
    const key = `${rows.length}:${rows.length ? String(rows[rows.length - 1].signal_id) : ""}`;
    if (replayCache && replayCache.key === key && Date.now() - replayCache.at < REPLAY_TTL_MS) {
      return { ...replayCache.value, cached: true };
    }
    const run = await runReplay(
      rows.map((r) => ({
        signalId: String(r.signal_id),
        symbol: String(r.symbol),
        side: r.side === "SELL" ? "SELL" : "BUY",
        score: r.score == null ? null : Number(r.score),
        entry: r.entry == null ? null : Number(r.entry),
        stopLoss: r.sl == null ? null : Number(r.sl),
        takeProfit: r.tp == null ? null : Number(r.tp),
        firstSeenAt: new Date(r.first_seen_at as string).getTime(),
        admitted: Boolean(r.admitted),
      })),
    );
    const value: ReplaySummary = {
      ranAt: run.ranAt,
      recorded: run.recorded,
      replayed: run.replayed,
      exits: run.exits,
      skipped: run.skipped,
      defaultBrackets: run.defaultBrackets,
      verdicts: run.verdicts,
      recentTrades: [...run.trades].sort((a, b) => b.closedAt - a.closedAt).slice(0, 25),
      cached: false,
    };
    replayCache = { key, at: Date.now(), value };
    return value;
  });
