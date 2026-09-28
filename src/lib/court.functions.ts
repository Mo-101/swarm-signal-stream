// Dashboard read plane for the Signal Court. Read-only: nothing here writes to
// the database or places an order.
//
// Server modules (Neon client, candle fetcher) are imported dynamically inside
// the handlers, same convention as edge.functions.ts, so they never ship in the
// client bundle.
import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth/auth-middleware";
import type { CourtTrade, Verdict } from "@/lib/court/court";
import type { HistoryPoint } from "@/lib/court/store.server";

export type { HistoryPoint };

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
    shadowCount: number;
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
  /** Verdict snapshots per hypothesis (written by the runner's court sessions). */
  history: Record<string, HistoryPoint[]>;
  /** Latest stored verdict per hypothesis: how the Court tab shows the heavy
   *  replays (swarm signals, SigmaLui) without recomputing them per request. */
  latest: Record<string, Verdict & { judgedAt: string }>;
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
      trades: { count: 0, shadowCount: 0, costUnrecorded: 0, epochs: [], verdicts: [] },
      evidence: { tableReady: false, total: 0, admitted: 0, last24h: 0, firstAt: null, recent: [] },
      history: {},
      latest: {},
      error: null,
    };
    try {
      const { getNeonSql } = await import("@/lib/db/neon");
      const { judgeTrades, loadLatestVerdicts, loadVerdictHistory } =
        await import("@/lib/court/store.server");
      const sql = getNeonSql();

      const t = await judgeTrades(context.userId);
      out.trades = {
        count: t.paperCount,
        shadowCount: t.shadowCount,
        costUnrecorded: t.costUnrecorded,
        epochs: [...new Set(t.trades.map((x) => x.epoch))].filter((e) => e !== "shadow").sort(),
        verdicts: t.verdicts,
      };
      try {
        out.history = await loadVerdictHistory(60);
        out.latest = await loadLatestVerdicts();
      } catch {
        // court_verdicts not created yet: history stays empty until schema.sql is applied.
      }

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
    const { runReplay } = await import("@/lib/court/replay-run.server");
    const { loadSigmaLuiSignals } = await import("@/lib/court/store.server");
    const signals = await loadSigmaLuiSignals();
    const key = `${signals.length}:${signals.length ? signals[signals.length - 1].signalId : ""}`;
    if (replayCache && replayCache.key === key && Date.now() - replayCache.at < REPLAY_TTL_MS) {
      return { ...replayCache.value, cached: true };
    }
    const run = await runReplay(signals);
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
