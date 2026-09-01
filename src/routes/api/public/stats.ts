// Public, read-only performance summary of the paper book, aggregated by
// strategy epoch. No account identifiers, no per-trade rows, no credentials —
// only counts, win rates and USD aggregates that the dashboard already shows.
//
// Exists so the strategy can be graded from outside the authenticated
// dashboard (VPS box, CI, a quick curl) without handing out a DB URL.
import { createFileRoute } from "@tanstack/react-router";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

interface EpochRow {
  epoch: string;
  trades: number;
  wins: number;
  winRate: number;
  netUsd: number;
  expectancyUsd: number;
  /** 95% CI on expectancy — the only honest read at these sample sizes. */
  expectancyCi95: { low: number; high: number };
  avgWinUsd: number;
  avgLossUsd: number;
  firstClosedAt: string | null;
  lastClosedAt: string | null;
}

function summarise(epoch: string, pnls: number[]): EpochRow & { _t: number } {
  const n = pnls.length;
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const net = pnls.reduce((a, b) => a + b, 0);
  const mean = n ? net / n : 0;
  let m2 = 0;
  for (const p of pnls) m2 += (p - mean) ** 2;
  const sd = n > 1 ? Math.sqrt(m2 / (n - 1)) : 0;
  const stderr = n ? sd / Math.sqrt(n) : 0;
  return {
    epoch,
    trades: n,
    wins: wins.length,
    winRate: n ? wins.length / n : 0,
    netUsd: net,
    expectancyUsd: mean,
    expectancyCi95: { low: mean - 1.96 * stderr, high: mean + 1.96 * stderr },
    avgWinUsd: wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0,
    avgLossUsd: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0,
    firstClosedAt: null,
    lastClosedAt: null,
    _t: stderr > 0 ? mean / stderr : 0,
  };
}

export const Route = createFileRoute("/api/public/stats")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      GET: async () => {
        const { neonEnabled, getNeonSql } = await import("@/lib/db/neon");
        if (!neonEnabled()) {
          return Response.json(
            { configured: false, detail: "Neon is not configured on this instance." },
            { status: 200, headers: { ...CORS, "Cache-Control": "no-store" } },
          );
        }
        try {
          const sql = getNeonSql();
          const rows = (await sql`
            SELECT strategy_epoch, reason, pnl::float8 AS pnl, closed_at
              FROM paper_trades
             WHERE status = 'closed' AND pnl IS NOT NULL
             ORDER BY closed_at ASC`) as Array<{
            strategy_epoch: string | null;
            reason: string | null;
            pnl: number;
            closed_at: string | null;
          }>;

          const byEpoch = new Map<string, number[]>();
          const times = new Map<string, [string | null, string | null]>();
          const byReason = new Map<string, { n: number; net: number }>();
          for (const r of rows) {
            const e = r.strategy_epoch ?? "unknown";
            if (!byEpoch.has(e)) byEpoch.set(e, []);
            byEpoch.get(e)!.push(Number(r.pnl));
            const t = times.get(e) ?? [null, null];
            times.set(e, [t[0] ?? r.closed_at, r.closed_at]);
            const k = r.reason ?? "unknown";
            const agg = byReason.get(k) ?? { n: 0, net: 0 };
            agg.n += 1;
            agg.net += Number(r.pnl);
            byReason.set(k, agg);
          }

          const epochs = [...byEpoch.entries()]
            .map(([e, pnls]) => {
              const s = summarise(e, pnls);
              const t = times.get(e)!;
              s.firstClosedAt = t[0];
              s.lastClosedAt = t[1];
              return s;
            })
            .sort((a, b) => a.epoch.localeCompare(b.epoch));

          const all = summarise("all", rows.map((r) => Number(r.pnl)));

          return Response.json(
            {
              configured: true,
              generatedAt: Date.now(),
              total: all,
              epochs,
              exitReasons: [...byReason.entries()]
                .map(([reason, v]) => ({ reason, trades: v.n, netUsd: v.net }))
                .sort((a, b) => b.trades - a.trades),
            },
            { status: 200, headers: { ...CORS, "Cache-Control": "no-store" } },
          );
        } catch (err) {
          return Response.json(
            { configured: true, error: (err as Error).message ?? "query failed" },
            { status: 200, headers: { ...CORS, "Cache-Control": "no-store" } },
          );
        }
      },
    },
  },
});
