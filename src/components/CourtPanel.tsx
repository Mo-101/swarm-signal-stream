// Signal Court tab: every strategy epoch and signal source is on trial, and is
// NOT PROVEN until it clears all eight charges. Read-only.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  getCourtOverview,
  runSigmaLuiReplay,
  type CourtOverview,
  type HistoryPoint,
  type ReplaySummary,
} from "@/lib/court.functions";
import type { Verdict } from "@/lib/court/court";

const CHARGES: Array<{ key: string; label: string; what: string }> = [
  { key: "evidence", label: "Evidence", what: "enough trades to judge" },
  {
    key: "profitable",
    label: "Profitable",
    what: "net 95% lower bound above zero, after fees + funding",
  },
  { key: "direction", label: "Direction", what: "beats the same trades with direction randomised" },
  {
    key: "deflation",
    label: "Deflation",
    what: "still significant after counting every hypothesis",
  },
  { key: "holdout", label: "Holdout", what: "the most recent 40% passes again" },
  { key: "stability", label: "Stability", what: "net positive in 4 of 5 time folds" },
  { key: "breadth", label: "Breadth", what: "survives dropping the best 5% of trades" },
  { key: "gate", label: "Gate", what: "profit factor ≥ 1.30" },
];

const n1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "—");
const n2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "—");
const ago = (iso: string) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return `${Math.max(0, Math.round(s))}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

/** Display order for stored verdicts: headline first, then the split, then
 *  confidence buckets low to high, then agents. */
const CONF_ORDER = ["<0.60", "0.60-0.70", "0.70-0.80", ">=0.80"];
const rank = (id: string) => {
  if (id.endsWith(":all")) return 0;
  if (id.includes("not-") || id.includes("admitted")) return 1;
  const c = CONF_ORDER.findIndex((b) => id.endsWith(`:conf:${b}`));
  if (c >= 0) return 2 + c / 10;
  return 3;
};

/** Net edge with its 95% interval against zero. The shaded band is the
 *  smallest edge this sample could detect: anything inside it is invisible. */
function CiBar({ v }: { v: Verdict }) {
  const [lo, hi] = v.netCi95;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    return <p className="text-[11px] text-muted-foreground">No interval: too few trades.</p>;
  }
  const span = Math.max(Math.abs(lo), Math.abs(hi), Math.abs(v.netBps), v.mdeBps || 0, 1) * 1.15;
  const W = 560;
  const x = (b: number) => ((b + span) / (2 * span)) * W;
  const clears = lo > 0;
  const far = (b: number) => Math.abs(x(b) - x(0)) > 60;
  return (
    <svg
      viewBox={`0 0 ${W} 40`}
      className="h-9 w-full"
      role="img"
      aria-label={`Net ${n1(v.netBps)} bps, 95% CI ${n1(lo)} to ${n1(hi)}`}
    >
      <rect
        x={x(0)}
        y={6}
        width={Math.max(0, x(Math.min(v.mdeBps || 0, span)) - x(0))}
        height={14}
        className="fill-muted-foreground/10"
      />
      <line
        x1={x(0)}
        x2={x(0)}
        y1={2}
        y2={24}
        className="stroke-muted-foreground"
        strokeWidth={1}
        strokeDasharray="2 2"
      />
      <g className={clears ? "text-bull" : "text-muted-foreground"}>
        <line
          x1={x(lo)}
          x2={x(hi)}
          y1={13}
          y2={13}
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
        />
        <circle cx={x(v.netBps)} cy={13} r={4.5} fill="currentColor" />
      </g>
      <text x={x(0)} y={38} textAnchor="middle" className="fill-muted-foreground text-[16px]">
        0
      </text>
      {far(lo) && (
        <text x={x(lo)} y={38} textAnchor="middle" className="fill-muted-foreground text-[16px]">
          {n1(lo)}
        </text>
      )}
      {far(hi) && (
        <text x={x(hi)} y={38} textAnchor="middle" className="fill-muted-foreground text-[16px]">
          {n1(hi)}
        </text>
      )}
    </svg>
  );
}

/** How this hypothesis's evidence has moved across court sessions: the 95%
 *  band against zero, and the detectable-edge line shrinking as trades accrue. */
function HistoryLine({ points }: { points: HistoryPoint[] }) {
  const pts = points.filter((p) => p.lo !== null && p.hi !== null && p.net !== null);
  if (pts.length < 2) return null;
  const W = 560;
  const Ht = 56;
  const vals = pts.flatMap((p) => [p.lo!, p.hi!, p.mde ?? 0, 0]);
  const top = Math.max(...vals);
  const bot = Math.min(...vals);
  const pad = (top - bot) * 0.08 || 1;
  const y = (b: number) => 4 + ((top + pad - b) / (top - bot + 2 * pad)) * (Ht - 8);
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const band =
    pts.map((p, i) => `${x(i)},${y(p.hi!)}`).join(" ") +
    " " +
    [...pts]
      .reverse()
      .map((p, i) => `${x(pts.length - 1 - i)},${y(p.lo!)}`)
      .join(" ");
  const line = (f: (p: HistoryPoint) => number | null) =>
    pts.map((p, i) => (f(p) === null ? "" : `${i ? "L" : "M"}${x(i)},${y(f(p)!)}`)).join(" ");
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${Ht}`}
        className="h-14 w-full"
        role="img"
        aria-label="Evidence over time"
      >
        <polygon points={band} className="fill-muted-foreground/15" />
        <line
          x1={0}
          x2={W}
          y1={y(0)}
          y2={y(0)}
          className="stroke-muted-foreground"
          strokeDasharray="2 2"
        />
        <path d={line((p) => p.net)} className="stroke-foreground" fill="none" strokeWidth={1.5} />
        <path
          d={line((p) => p.mde)}
          className="stroke-amber-400"
          fill="none"
          strokeWidth={1}
          strokeDasharray="4 3"
        />
      </svg>
      <p className="text-[10px] text-muted-foreground">
        {pts.length} sessions since {new Date(pts[0].t).toLocaleDateString()} · band = 95% interval
        · dashed = detectable edge ({n1(pts[0].mde ?? NaN)} → {n1(pts[pts.length - 1].mde ?? NaN)}{" "}
        bps) · trades {pts[0].n} → {pts[pts.length - 1].n}
      </p>
    </div>
  );
}

export function VerdictCard({ v, history }: { v: Verdict; history?: HistoryPoint[] }) {
  const convicted = v.verdict === "CONVICTED";
  const failedBy = (key: string) => v.failed.find((f) => f.startsWith(`${key}:`));
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-background/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-xs text-foreground">{v.id}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{v.claim}</p>
        </div>
        <span
          className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold tracking-wide ${
            convicted ? "bg-bull/15 text-bull" : "bg-muted text-muted-foreground"
          }`}
        >
          {v.verdict}
        </span>
      </div>

      <CiBar v={v} />
      {history && <HistoryLine points={history} />}

      <div className="grid grid-cols-5 gap-2 text-[10px]">
        {[
          ["trades", `${v.n}`, `${v.nEpisodes} episodes`],
          ["net bps", n1(v.netBps), `gross ${n1(v.grossBps)}`],
          ["PF", n2(v.profitFactor), "gate 1.30"],
          ["win", Number.isFinite(v.winRate) ? `${Math.round(v.winRate * 100)}%` : "—", ""],
          ["detectable", `${n1(v.mdeBps)}`, "bps edge"],
        ].map(([k, val, sub]) => (
          <div key={k}>
            <p className="uppercase tracking-wide text-muted-foreground">{k}</p>
            <p className="text-xs font-medium tabular-nums text-foreground">{val}</p>
            <p className="text-muted-foreground">{sub}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-1">
        {CHARGES.map((c) => {
          const f = failedBy(c.key);
          return (
            <span
              key={c.key}
              title={f ?? `${c.label}: ${c.what} (passed)`}
              className={`rounded border px-1.5 py-0.5 text-[10px] ${
                f ? "border-bear/40 text-bear" : "border-bull/40 text-bull"
              }`}
            >
              {f ? "✕" : "✓"} {c.label}
            </span>
          );
        })}
      </div>

      <p className="text-[11px] leading-snug text-foreground/90">{v.diagnosis}.</p>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium tabular-nums text-foreground">{value}</p>
      {hint && <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function CourtPanel() {
  const fetchOverview = useServerFn(getCourtOverview);
  const replay = useServerFn(runSigmaLuiReplay);
  const [data, setData] = useState<CourtOverview | null>(null);
  const [run, setRun] = useState<ReplaySummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await fetchOverview());
    } catch (e) {
      setData((d) => ({
        ...(d ?? {
          judgedAt: new Date().toISOString(),
          trades: { count: 0, shadowCount: 0, costUnrecorded: 0, epochs: [], verdicts: [] },
          evidence: {
            tableReady: false,
            total: 0,
            admitted: 0,
            last24h: 0,
            firstAt: null,
            recent: [],
          },
          history: {},
          latest: {},
        }),
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  }, [fetchOverview]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(id);
  }, [refresh]);

  const doReplay = async () => {
    setBusy(true);
    setReplayError(null);
    try {
      setRun(await replay());
    } catch (e) {
      setReplayError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <p className="p-4 text-xs text-muted-foreground">Convening the court…</p>;
  return (
    <CourtView
      data={data}
      run={run}
      busy={busy}
      replayError={replayError}
      onRefresh={() => void refresh()}
      onReplay={() => void doReplay()}
    />
  );
}

/** Presentational half of the Court tab: renders whatever the server judged. */
export function CourtView({
  data,
  run,
  busy,
  replayError,
  onRefresh,
  onReplay,
}: {
  data: CourtOverview;
  run: ReplaySummary | null;
  busy: boolean;
  replayError: string | null;
  onRefresh: () => void;
  onReplay: () => void;
}) {
  const ev = data.evidence;
  const paper = data.trades.verdicts.filter((v) => !v.id.startsWith("shadow:"));
  const shadow = data.trades.verdicts.filter((v) => v.id.startsWith("shadow:"));
  const stored = (prefix: string) =>
    Object.values(data.latest)
      .filter((v) => v.id.startsWith(prefix))
      .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  const swarm = stored("signals:");
  const sigmaStored = stored("sigmalui:");
  const anyConvicted = data.trades.verdicts.some((v) => v.verdict === "CONVICTED");

  return (
    <div className="space-y-5 p-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Signal Court</h2>
          <p className="text-[11px] text-muted-foreground">
            Every strategy and signal source is NOT PROVEN until it clears all eight charges. Units:
            bps of entry notional, net of fees and funding. Judged {ago(data.judgedAt)}.
          </p>
        </div>
        <button
          onClick={onRefresh}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          Re-judge
        </button>
      </div>

      {data.error && (
        <p className="rounded-md border border-bear/40 bg-bear/10 p-2 text-xs text-bear">
          {data.error}
        </p>
      )}

      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Closed paper trades · {data.trades.count} trades · epochs{" "}
            {data.trades.epochs.join(", ") || "—"}
          </h3>
          <p className={`text-[11px] ${anyConvicted ? "text-bull" : "text-muted-foreground"}`}>
            {anyConvicted ? "At least one hypothesis is convicted." : "Nothing proven yet."}
          </p>
        </div>
        {data.trades.costUnrecorded > 0 && (
          <p className="text-[11px] text-amber-400">
            {data.trades.costUnrecorded} legacy trades have no recorded fees or funding, which
            flatters their cost figures.
          </p>
        )}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {paper.map((v) => (
            <VerdictCard key={v.id} v={v} history={data.history[v.id]} />
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Shadow book · {data.trades.shadowCount} untraded proposals, traded virtually
        </h3>
        <p className="text-[11px] text-muted-foreground">
          Every proposal the broker refused (below the confidence gate, suppressed, blocked, or
          halted) is traded on a fixed $1,000 notional against live marks with v1r brackets, fees
          and funding. While trading is halted this is where the running strategy's evidence
          accumulates. Direction test here is approximate (reversed gross, costs unchanged).
        </p>
        {shadow.length ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {shadow.map((v) => (
              <VerdictCard key={v.id} v={v} history={data.history[v.id]} />
            ))}
          </div>
        ) : (
          <p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
            No closed shadow trades found for this account.
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Swarm signals · replayed under v1r rules
          {swarm.length > 0 && ` · last session ${ago(swarm[0].judgedAt)}`}
        </h3>
        <p className="text-[11px] text-muted-foreground">
          The first signal per symbol and side in each 2-hour block from the signals table, replayed
          against Bybit candles: taker entry at the next 1m open, 2% stop, 4% target, 48h time exit,
          fees and slippage on both legs, and the exact mirrored trade as the direction test. Split
          by confidence bucket and by which agent voted for the direction.
        </p>
        {swarm.length ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {swarm.map((v) => (
              <VerdictCard key={v.id} v={v} history={data.history[v.id]} />
            ))}
          </div>
        ) : (
          <p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
            No session has judged the swarm's signals yet. The runner does it every{" "}
            <code className="font-mono">COURT_SNAPSHOT_HOURS</code> (first session 2 minutes after
            start), or run <code className="font-mono">scripts/signals-replay.ts --write</code>.
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          SigmaLui evidence stream
        </h3>
        {!ev.tableReady ? (
          <p className="rounded-md border border-border p-3 text-xs text-muted-foreground">
            Not recording yet. Apply the schema (
            <code className="font-mono">node scripts/apply-schema.mjs src/lib/db/schema.sql</code>)
            and restart the runner; every feed signal is then recorded, admitted or not, even while
            trading is halted.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                label="Signals recorded"
                value={`${ev.total}`}
                hint="every distinct feed signal"
              />
              <Stat
                label="Admitted by ingester"
                value={`${ev.admitted}`}
                hint={
                  ev.total
                    ? `${Math.round((ev.admitted / ev.total) * 100)}% pass our filters`
                    : undefined
                }
              />
              <Stat label="Last 24h" value={`${ev.last24h}`} />
              <Stat label="Recording since" value={ev.firstAt ? ago(ev.firstAt) : "—"} />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={onReplay}
                disabled={busy || ev.total === 0}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {busy ? "Replaying against candles…" : "Replay against candles"}
              </button>
              <p className="text-[11px] text-muted-foreground">
                Entry at the next 1m open after we saw the signal · signal's own brackets ·
                stop-first on ambiguous candles · 48h time exit · taker fees + slippage both legs ·
                exact mirrored trade as the direction placebo.
              </p>
            </div>
            {replayError && <p className="text-xs text-bear">{replayError}</p>}

            {!run && sigmaStored.length > 0 && (
              <div className="space-y-2">
                <p className="text-[11px] text-muted-foreground">
                  Last court session {ago(sigmaStored[0].judgedAt)}. Replay now for a fresh verdict.
                </p>
                <div className="grid gap-3 md:grid-cols-3">
                  {sigmaStored.map((v) => (
                    <VerdictCard key={v.id} v={v} history={data.history[v.id]} />
                  ))}
                </div>
              </div>
            )}

            {run && (
              <div className="space-y-2">
                <p className="text-[11px] text-muted-foreground">
                  {run.replayed} of {run.recorded} signals resolved · exits{" "}
                  {Object.entries(run.exits)
                    .map(([k, c]) => `${k} ${c}`)
                    .join(", ") || "—"}
                  {Object.keys(run.skipped).length > 0 &&
                    ` · not judged: ${Object.entries(run.skipped)
                      .map(([k, c]) => `${k} ${c}`)
                      .join(", ")}`}
                  {run.defaultBrackets > 0 &&
                    ` · ${run.defaultBrackets} used default 2%/4% brackets`}
                  {` · ran ${ago(run.ranAt)}${run.cached ? " (cached)" : ""}`}
                </p>
                <div className="grid gap-3 md:grid-cols-3">
                  {run.verdicts.map((v) => (
                    <VerdictCard key={v.id} v={v} history={data.history[v.id]} />
                  ))}
                </div>
              </div>
            )}

            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-[11px]">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="px-2 py-1.5 font-medium">seen</th>
                    <th className="px-2 py-1.5 font-medium">symbol</th>
                    <th className="px-2 py-1.5 font-medium">side</th>
                    <th className="px-2 py-1.5 text-right font-medium">score</th>
                    <th className="px-2 py-1.5 font-medium">ingester</th>
                  </tr>
                </thead>
                <tbody>
                  {ev.recent.map((r) => (
                    <tr key={r.signalId} className="border-b border-border/50 last:border-0">
                      <td className="px-2 py-1 tabular-nums text-muted-foreground">
                        {ago(r.firstSeenAt)}
                      </td>
                      <td className="px-2 py-1 font-mono">{r.symbol}</td>
                      <td className={`px-2 py-1 ${r.side === "BUY" ? "text-bull" : "text-bear"}`}>
                        {r.side}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {r.score === null ? "—" : r.score.toFixed(3)}
                      </td>
                      <td className="px-2 py-1 text-muted-foreground">
                        {r.admitted ? "admitted" : `rejected · ${r.rejectReason ?? "?"}`}
                      </td>
                    </tr>
                  ))}
                  {ev.recent.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-2 py-3 text-center text-muted-foreground">
                        Waiting for the feed's first signal.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
