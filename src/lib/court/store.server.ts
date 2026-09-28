// Shared data access for the Signal Court. Read-only except recordVerdicts,
// which appends to the court's own append-only tables (never to trading data).
//
// Server/runner only: imports the Neon client and node:crypto.
import { createHash } from "node:crypto";
import { getNeonSql } from "@/lib/db/neon";
import {
  buildDocket,
  confBucket,
  type CourtRules,
  type CourtTrade,
  DEFAULT_RULES,
  type Hypothesis,
  judgeAll,
  SHADOW_EPOCH,
  type Verdict,
} from "./court";
import type { ReplaySignal } from "./replay";
import { agreeingAgents, dayWindows, SIGNAL_BLOCK_MS, type SignalRow } from "./signals";

/** Closed paper trades as court evidence. userId null = every account. */
export async function loadClosedTrades(
  userId: string | null,
): Promise<{ trades: CourtTrade[]; costUnrecorded: number }> {
  const sql = getNeonSql();
  const rows = (
    userId
      ? await sql`
          SELECT id::text, symbol, side, strategy_epoch, agents, opened_at, closed_at,
                 notional::float8 AS notional, gross_pnl::float8 AS gross, pnl::float8 AS net,
                 coalesce(fees, 0)::float8 AS fees, coalesce(funding, 0)::float8 AS funding
            FROM paper_trades
           WHERE user_id = ${userId} AND status = 'closed'
             AND pnl IS NOT NULL AND closed_at IS NOT NULL
           ORDER BY closed_at ASC`
      : await sql`
          SELECT id::text, symbol, side, strategy_epoch, agents, opened_at, closed_at,
                 notional::float8 AS notional, gross_pnl::float8 AS gross, pnl::float8 AS net,
                 coalesce(fees, 0)::float8 AS fees, coalesce(funding, 0)::float8 AS funding
            FROM paper_trades
           WHERE status = 'closed' AND pnl IS NOT NULL AND closed_at IS NOT NULL
           ORDER BY closed_at ASC`
  ) as Record<string, unknown>[];
  let costUnrecorded = 0;
  const trades = rows.map((r) => {
    if (Number(r.fees) === 0 && Number(r.funding) === 0) costUnrecorded++;
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
    } satisfies CourtTrade;
  });
  return { trades, costUnrecorded };
}

/**
 * Closed counterfactual shadow-book trades: every proposal the broker refused,
 * traded virtually on a fixed notional against live marks, with fees, slippage
 * and funding already charged by the shadow book. Tagged epoch "shadow" with
 * sources ["reason:<why>", "conf:<bucket>"] for the docket.
 */
export async function loadShadowTrades(userId: string | null): Promise<CourtTrade[]> {
  const sql = getNeonSql();
  const rows = (
    userId
      ? await sql`
          SELECT shadow_id, symbol, side, reason, confidence::float8 AS confidence,
                 notional::float8 AS notional, gross_bps::float8 AS gross_bps,
                 net_bps::float8 AS net_bps, net_usd::float8 AS net_usd, opened_at, closed_at
            FROM shadow_trades
           WHERE user_id = ${userId} AND status = 'closed'
             AND closed_at IS NOT NULL AND net_bps IS NOT NULL
           ORDER BY closed_at ASC`
      : await sql`
          SELECT shadow_id, symbol, side, reason, confidence::float8 AS confidence,
                 notional::float8 AS notional, gross_bps::float8 AS gross_bps,
                 net_bps::float8 AS net_bps, net_usd::float8 AS net_usd, opened_at, closed_at
            FROM shadow_trades
           WHERE status = 'closed' AND closed_at IS NOT NULL AND net_bps IS NOT NULL
           ORDER BY closed_at ASC`
  ) as Record<string, unknown>[];
  return rows.map((r) => {
    const notional = Number(r.notional);
    const netBps = Number(r.net_bps);
    const grossBps = r.gross_bps == null ? netBps : Number(r.gross_bps);
    return {
      id: `shadow-${String(r.shadow_id)}`,
      symbol: String(r.symbol),
      side: String(r.side),
      epoch: SHADOW_EPOCH,
      sources: [`reason:${String(r.reason)}`, `conf:${confBucket(Number(r.confidence))}`],
      openedAt: new Date(r.opened_at as string).getTime(),
      closedAt: new Date(r.closed_at as string).getTime(),
      notional,
      grossUsd: (grossBps / 1e4) * notional,
      netUsd: r.net_usd == null ? (netBps / 1e4) * notional : Number(r.net_usd),
    } satisfies CourtTrade;
  });
}

/**
 * Swarm signal events for the last `days` days: the first signal per
 * (symbol, side) in each 2h block. Queried one UTC day at a time so a table
 * with millions of rows never has to come back in one response.
 */
export async function loadSignalEvents(
  userId: string | null,
  days: number,
  now = Date.now(),
  onDay?: (i: number, total: number, rows: number) => void,
): Promise<SignalRow[]> {
  const sql = getNeonSql();
  const blockSec = SIGNAL_BLOCK_MS / 1000;
  const out: SignalRow[] = [];
  const windows = dayWindows(days, now);
  for (let i = 0; i < windows.length; i++) {
    const from = new Date(windows[i][0]).toISOString();
    const to = new Date(windows[i][1]).toISOString();
    // The block is computed once in the subquery: Postgres requires DISTINCT ON
    // and ORDER BY to use the identical expression, and two bound parameters
    // with the same value do not count as identical.
    const rows = (
      userId
        ? await sql`
            SELECT DISTINCT ON (symbol, side, blk)
                   id, symbol, side, confidence, executed, agents, created_at
              FROM (SELECT id::text AS id, symbol, side, confidence::float8 AS confidence,
                           executed, agents, created_at,
                           floor(extract(epoch FROM created_at) / ${blockSec}) AS blk
                      FROM signals
                     WHERE user_id = ${userId} AND created_at >= ${from} AND created_at < ${to}) s
             ORDER BY symbol, side, blk, created_at ASC`
        : await sql`
            SELECT DISTINCT ON (symbol, side, blk)
                   id, symbol, side, confidence, executed, agents, created_at
              FROM (SELECT id::text AS id, symbol, side, confidence::float8 AS confidence,
                           executed, agents, created_at,
                           floor(extract(epoch FROM created_at) / ${blockSec}) AS blk
                      FROM signals
                     WHERE created_at >= ${from} AND created_at < ${to}) s
             ORDER BY symbol, side, blk, created_at ASC`
    ) as Record<string, unknown>[];
    for (const r of rows) {
      out.push({
        id: String(r.id),
        symbol: String(r.symbol),
        side: String(r.side),
        confidence: Number(r.confidence),
        executed: Boolean(r.executed),
        createdAt: new Date(r.created_at as string).getTime(),
        agrees: agreeingAgents(r.agents, String(r.side)),
      });
    }
    onDay?.(i + 1, windows.length, rows.length);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** Every recorded SigmaLui signal, oldest first. */
export async function loadSigmaLuiSignals(): Promise<ReplaySignal[]> {
  const rows = (await getNeonSql()`
    SELECT signal_id, symbol, side, score::float8 AS score, entry_price::float8 AS entry,
           stop_loss::float8 AS sl, take_profit::float8 AS tp, first_seen_at, admitted
      FROM sigmalui_signals ORDER BY first_seen_at ASC`) as Record<string, unknown>[];
  return rows.map((r) => ({
    signalId: String(r.signal_id),
    symbol: String(r.symbol),
    side: r.side === "SELL" ? "SELL" : "BUY",
    score: r.score == null ? null : Number(r.score),
    entry: r.entry == null ? null : Number(r.entry),
    stopLoss: r.sl == null ? null : Number(r.sl),
    takeProfit: r.tp == null ? null : Number(r.tp),
    firstSeenAt: new Date(r.first_seen_at as string).getTime(),
    admitted: Boolean(r.admitted),
  }));
}

/** Binds a hypothesis to its claim AND the court rules in force. */
export function hypothesisDigest(h: Hypothesis, rules: CourtRules = DEFAULT_RULES): string {
  return createHash("sha256")
    .update(JSON.stringify({ id: h.id, claim: h.claim, rules }))
    .digest("hex")
    .slice(0, 16);
}

export interface RecordResult {
  written: number;
  refused: string[];
}

/**
 * Append verdicts to court_verdicts. A hypothesis is registered on first sight;
 * if its registered digest differs (the claim or the rules changed after
 * registration), its verdict is refused rather than written under the old id.
 */
export async function recordVerdicts(
  verdicts: Verdict[],
  docket: Hypothesis[],
  rules: CourtRules = DEFAULT_RULES,
): Promise<RecordResult> {
  const sql = getNeonSql();
  const out: RecordResult = { written: 0, refused: [] };
  for (const v of verdicts) {
    const h = docket.find((d) => d.id === v.id);
    if (!h) continue;
    const digest = hypothesisDigest(h, rules);
    await sql`INSERT INTO court_registry (id, claim, digest) VALUES (${h.id}, ${h.claim}, ${digest})
              ON CONFLICT (id) DO NOTHING`;
    const [row] = (await sql`SELECT digest FROM court_registry WHERE id = ${h.id}`) as {
      digest: string;
    }[];
    if (row?.digest !== digest) {
      out.refused.push(h.id);
      continue;
    }
    await sql`
      INSERT INTO court_verdicts
        (hypothesis_id, digest, verdict, diagnosis, n_trades, net_bps, net_ci_low, net_ci_high, dsr, detail)
      VALUES
        (${v.id}, ${digest}, ${v.verdict}, ${v.diagnosis}, ${v.n}, ${fin(v.netBps)},
         ${fin(v.netCi95[0])}, ${fin(v.netCi95[1])}, ${fin(v.dsr)}, ${JSON.stringify(v)}::jsonb)`;
    out.written++;
  }
  return out;
}
const fin = (x: number) => (Number.isFinite(x) ? x : null);

export interface HistoryPoint {
  t: string;
  verdict: string;
  n: number;
  net: number | null;
  lo: number | null;
  hi: number | null;
  mde: number | null;
}

/** Verdict snapshots per hypothesis over the last `days`, oldest first. */
export async function loadVerdictHistory(days = 60): Promise<Record<string, HistoryPoint[]>> {
  const rows = (await getNeonSql()`
    SELECT hypothesis_id, judged_at, verdict, n_trades,
           net_bps::float8 AS net, net_ci_low::float8 AS lo, net_ci_high::float8 AS hi,
           (detail->>'mdeBps')::float8 AS mde
      FROM court_verdicts
     WHERE judged_at > now() - make_interval(days => ${days})
     ORDER BY judged_at ASC`) as Record<string, unknown>[];
  const out: Record<string, HistoryPoint[]> = {};
  for (const r of rows) {
    const id = String(r.hypothesis_id);
    (out[id] ??= []).push({
      t: new Date(r.judged_at as string).toISOString(),
      verdict: String(r.verdict),
      n: Number(r.n_trades),
      net: r.net == null ? null : Number(r.net),
      lo: r.lo == null ? null : Number(r.lo),
      hi: r.hi == null ? null : Number(r.hi),
      mde: r.mde == null ? null : Number(r.mde),
    });
  }
  return out;
}

/** The most recent stored verdict for every hypothesis (from court sessions). */
export async function loadLatestVerdicts(): Promise<
  Record<string, Verdict & { judgedAt: string }>
> {
  const rows = (await getNeonSql()`
    SELECT DISTINCT ON (hypothesis_id) hypothesis_id, detail, judged_at
      FROM court_verdicts
     ORDER BY hypothesis_id, judged_at DESC`) as Record<string, unknown>[];
  const out: Record<string, Verdict & { judgedAt: string }> = {};
  for (const r of rows) {
    out[String(r.hypothesis_id)] = {
      ...(r.detail as Verdict),
      judgedAt: new Date(r.judged_at as string).toISOString(),
    };
  }
  return out;
}

/**
 * Judge closed paper trades AND closed shadow-book trades for one account, in
 * one session so the deflation counts every hypothesis on the docket.
 */
export async function judgeTrades(userId: string | null) {
  const { trades: paper, costUnrecorded } = await loadClosedTrades(userId);
  let shadow: CourtTrade[] = [];
  try {
    shadow = await loadShadowTrades(userId);
  } catch {
    // shadow_trades not present on this database: judge paper trades alone.
  }
  const trades = [...paper, ...shadow];
  const docket = buildDocket(trades);
  return {
    trades,
    paperCount: paper.length,
    shadowCount: shadow.length,
    costUnrecorded,
    docket,
    verdicts: trades.length ? judgeAll(trades, docket) : [],
  };
}
